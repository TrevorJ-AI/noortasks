import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import fastifyCookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { isPlainObject, type Loose } from "@noortasks/core";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { installHttpSecurity, JSON_LIMIT, requestLogPath } from "./http-security.js";
import { Actor, actorAls } from "./actor.js";
import { AiRateLimiter, resolveAiConfig, validateAiConfig, type AiConfig } from "./ai.js";
import { buildApp, type AppOptions, type BuiltApp } from "./app.js";
import { Throttle, hashPassphrase, safeEqual, verifyPassphrase } from "./auth.js";
import { Collab } from "./collab.js";
import { startDailyBackup, type DailyBackupResult } from "./dailyBackup.js";
import { OidcClient, OidcError, type OidcConfig } from "./oidc.js";
import { ApiError } from "./service.js";
import { Store } from "./store.js";
import { SystemStore, normEmail, type UserRow } from "./system.js";
import { Tenants } from "./tenants.js";

/**
 * The HTTP front of a NoorTasks server.
 *
 * Multi-user mode (a config file is given): signs people in (OpenID Connect, optional local password), keeps
 * the account list, allowlist and shares in a system database, and hands every data request to the signed-in
 * account's own app (one SQLite file per account, see tenants.ts). Requests that address a list shared with
 * the caller (comments, list activity, list task pages) go to the owner's app after a permission check.
 *
 * Single-user mode (`noAuth`): one app, no sign-in (local development and the end-to-end suite).
 *
 * Both modes serve `/healthz` and, with `staticDir`, the built web app with an index.html fallback.
 * Authentication is deny-by-default: only the paths in PUBLIC and static files skip the session check.
 */

export interface ServerConfig {
  /** Legacy single-user passphrase: becomes the bootstrap admin's password. */
  passphraseHash?: string;
  oidc?: OidcConfig;
  /** Emails that become admins on first sign-in (the first one owns the migrated single-user data). */
  admins?: string[];
  /** Default cap on accounts (admins can change it in Settings > Members). */
  maxUsers?: number;
  /** Local password sign-in; default on without OIDC, off with OIDC. */
  passwordLogin?: boolean | undefined;
  /** Global collaboration default before an admin touches the switch. */
  collaboration?: boolean;
  /** Provider-agnostic AI transcription & summarization settings. */
  ai?: AiConfig;
}

export function loadServerConfig(path: string): ServerConfig {
  const c = JSON.parse(readFileSync(path, "utf8")) as ServerConfig;
  if (c.passphraseHash !== undefined && (typeof c.passphraseHash !== "string" || !c.passphraseHash.startsWith("scrypt$"))) {
    throw new Error("config: passphraseHash must be an scrypt hash (use the hash-passphrase command)");
  }
  if (c.oidc) {
    const o = c.oidc;
    if (process.env.NOORTASKS_OIDC_CLIENT_SECRET) o.clientSecret = process.env.NOORTASKS_OIDC_CLIENT_SECRET;
    for (const k of ["issuer", "clientId", "clientSecret", "redirectUri"] as const) {
      if (typeof o[k] !== "string" || !o[k]) throw new Error(`config: oidc.${k} is required`);
    }
    if (o.allowInsecure !== undefined && typeof o.allowInsecure !== "boolean") throw new Error("config: oidc.allowInsecure must be boolean");
    const r = new URL(o.redirectUri);
    if (r.protocol !== "https:" && !o.allowInsecure && r.hostname !== "localhost" && r.hostname !== "127.0.0.1") {
      throw new Error("config: oidc.redirectUri must be https (or set oidc.allowInsecure for local testing)");
    }
  }
  if (!c.oidc && !c.passphraseHash) throw new Error("config: set oidc (recommended) or passphraseHash");
  if (c.admins !== undefined && (!Array.isArray(c.admins) || c.admins.some((a) => typeof a !== "string"))) throw new Error("config: admins must be a list of emails");
  if (c.ai !== undefined) c.ai = validateAiConfig(c.ai);
  return c;
}

export interface ServerOptions {
  dbPath: string;
  dataDir: string;
  /** System database (accounts, sessions, shares). Default: next to dbPath. */
  systemDbPath?: string;
  /** Where new accounts' databases and files go. Default: next to dbPath. */
  usersDir?: string;
  config?: ServerConfig;
  /** First-run admin claim requires this operator-held secret (at least 32 characters). */
  setupToken?: string;
  noAuth?: boolean;
  staticDir?: string;
  secureCookies?: boolean;
  trustProxy?: boolean;
  logger?: boolean;
  /** Optional server-scheduled daily backup export inside the data volume. */
  dailyBackup?: {
    enabled: boolean;
    backupDir?: string;
    retention?: number;
    intervalMs?: number;
  };
  /** Options shared by every account's app. */
  common?: Omit<AppOptions, "store" | "dbPath" | "dataDir" | "noAuth" | "auth" | "tenant">;
}

export interface BuiltServer {
  app: FastifyInstance;
  sys?: SystemStore;
  tenants?: Tenants;
  collab?: Collab;
  single?: BuiltApp;
  /** Every open account app (reminder dispatch). */
  apps(): BuiltApp[];
  /** The front's own routes (the isolation suite walks them). */
  routes: Array<{ method: string; url: string }>;
  /** Triggers a scheduled daily backup tick when dailyBackup is enabled. */
  runDailyBackup?: () => DailyBackupResult | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
  }
}

const PUBLIC = new Set([
  "/healthz",
  "/api/auth/config",
  "/api/auth/oidc/start",
  "/api/auth/oidc/callback",
  "/api/auth/oidc/native/redeem",
  "/api/auth/password/join",
  "/api/auth/pair",
  "/api/setup/status",
  "/api/setup",
  "/api/setup/oidc/start",
  "/setup",
  "/setup/*",
  "/api/v2/user/signon",
  "/pub/api/v1/app/config",
  "/pub/api/v2/subscribe/subscribe_spec",
  "/pub/api/v1/calendar/holiday/cn/recent",
]);
/** Always handled by an account app (or refused): never served as static files. */
const APP_PREFIXES = ["/api/", "/files/", "/pub/", "/feed/"];
const SESSION_DAYS = 30;

function errorBody(code: string, message?: string): Loose {
  return { errorId: randomBytes(8).toString("hex"), errorCode: code, errorMessage: message ?? code, data: null };
}

/** Paths addressed to one list or task; when it belongs to someone else's shared list, the owner's app answers. */
const SHARED_ROUTES: Array<{ re: RegExp; kind: "project" | "task"; need: (method: string) => "read" | "comment" | "write" }> = [
  { re: /^\/api\/v2\/project\/([^/,]+)\/task\/[^/]+\/comments?(?:\/[^/]+)?$/, kind: "project", need: (m) => (m === "GET" ? "read" : "comment") },
  { re: /^\/api\/v2\/project\/([^/,]+)\/task\/[^/]+\/complete$/, kind: "project", need: () => "write" },
  { re: /^\/api\/v1\/project\/([^/,]+)\/activity$/, kind: "project", need: () => "read" },
  { re: /^\/api\/v2\/project\/([^/,]+)\/(?:tasks|closed|completed)$/, kind: "project", need: () => "read" },
  { re: /^\/api\/v2\/column\/project\/([^/,]+)$/, kind: "project", need: () => "read" },
  { re: /^\/api\/v1\/task\/activity\/([^/]+)$/, kind: "task", need: () => "read" },
];

export async function buildServer(o: ServerOptions): Promise<BuiltServer> {
  const app = Fastify({
    // OAuth callback codes and app challenges must not enter request logs.
    logger: o.logger ? { serializers: { req: (req) => ({
      method: req.method, url: requestLogPath(req.url), hostname: req.hostname, remoteAddress: req.ip,
    }) } } : false,
    trustProxy: o.trustProxy ? "loopback" : false, ignoreTrailingSlash: true, bodyLimit: JSON_LIMIT, requestTimeout: 30_000,
  });
  installHttpSecurity(app);
  const routes: BuiltServer["routes"] = [];
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD") routes.push({ method: m, url: r.url });
  });
  await app.register(fastifyCookie);
  if (o.staticDir) await app.register(fastifyStatic, { root: resolve(o.staticDir), serve: false });
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body === "" ? undefined : JSON.parse(body as string));
    } catch {
      done(new ApiError(400, "invalid_json"), undefined);
    }
  });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(errorBody(err.errorCode, err.message));
    const e = err as { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send(errorBody(e.code ?? "bad_request"));
    app.log.error({ code: e.code }, "request failed");
    return reply.status(500).send(errorBody("internal_error"));
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(errorBody("not_found")));

  const serveStatic = (req: FastifyRequest, reply: FastifyReply): FastifyReply => {
    const path = decodeURIComponent(req.url.split("?")[0]!);
    if (!o.staticDir || (req.method !== "GET" && req.method !== "HEAD")) return reply.status(404).send(errorBody("not_found"));
    const root = resolve(o.staticDir);
    const rel = normalize(path).replace(/^([/\\])+/, "");
    const abs = resolve(root, rel);
    if (rel && (abs === root || abs.startsWith(root + sep)) && existsSync(abs) && statSync(abs).isFile()) {
      reply.header("cache-control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return reply.sendFile(rel, { cacheControl: false });
    }
    if (extname(rel)) return reply.status(404).send(errorBody("not_found"));
    reply.header("cache-control", "no-cache");
    return reply.sendFile("index.html", { cacheControl: false });
  };

  app.get("/pub/api/v1/app/config", async () => ({ etag: "0", interval: 3600 }));
  app.get("/pub/api/v2/subscribe/subscribe_spec", async () => []);
  app.get("/pub/api/v1/calendar/holiday/cn/recent", async () => []);

  const resolvedAi = o.common?.ai
    ? o.common.aiDeps
      ? o.common.ai
      : resolveAiConfig(o.common.ai, process.env)
    : resolveAiConfig(o.config?.ai, process.env);
  const aiRateLimiter = o.common?.aiDeps?.rateLimiter ?? new AiRateLimiter(resolveAiConfig(resolvedAi).rateLimitPerHour);
  const sharedCommon: NonNullable<ServerOptions["common"]> = {
    ...(o.common ?? {}),
    ai: resolvedAi,
    aiDeps: { ...(o.common?.aiDeps ?? {}), rateLimiter: aiRateLimiter },
  };

  // ------------------------------------------------------------------ single-user mode
  if (o.noAuth) {
    const single = buildApp({ ...sharedCommon, dbPath: o.dbPath, dataDir: o.dataDir, noAuth: true });
    await single.app.ready();
    const backupScheduler = o.dailyBackup?.enabled
      ? startDailyBackup({
          backupDir: o.dailyBackup.backupDir ?? join(dirname(o.dbPath), "backups"),
          single,
          ...(o.dailyBackup.retention !== undefined ? { retention: o.dailyBackup.retention } : {}),
          ...(o.dailyBackup.intervalMs !== undefined ? { intervalMs: o.dailyBackup.intervalMs } : {}),
          ...(o.common?.now ? { now: o.common.now } : {}),
          onError: (err) => app.log.error({ err }, "daily backup failed"),
        })
      : undefined;
    app.get("/healthz", async () => {
      single.store.get("select 1");
      return { ok: true };
    });
    app.get("/api/auth/config", async () => ({ mode: "single", oidc: null, password: false }));
    app.get("/api/auth/me", async () => ({ userId: single.svc.userId, email: "", name: "", role: "admin", single: true, collaboration: { enabled: false, optedOut: false } }));
    app.get("/setup", async (_req, reply) => reply.status(404).send(errorBody("not_found")));
    app.get("/setup/*", async (_req, reply) => reply.status(404).send(errorBody("not_found")));
    app.addHook("onRequest", async (req, reply) => {
      if (req.routeOptions.url !== "/*") return;
      const path = req.url.split("?")[0]!;
      if (!APP_PREFIXES.some((p) => path.startsWith(p))) return;
      reply.hijack();
      single.app.routing(req.raw, reply.raw);
    });
    app.all("/*", async (req, reply) => serveStatic(req, reply));
    app.addHook("onClose", async () => {
      backupScheduler?.stop();
      await single.app.close();
      single.store.close();
    });
    return {
      app,
      single,
      routes,
      apps: () => [single],
      ...(backupScheduler ? { runDailyBackup: () => backupScheduler.tick() } : {}),
    };
  }

  // ------------------------------------------------------------------ multi-user mode
  const cfg: ServerConfig = o.config ?? {};
  const now = o.common?.now ?? (() => Date.now());
  const sys = new SystemStore(o.systemDbPath ?? join(dirname(o.dbPath), "noortasks-system.sqlite"));
  const admins = (cfg.admins ?? []).map(normEmail);
  const oidc = cfg.oidc ? new OidcClient(cfg.oidc) : undefined;
  const passwordLogin = cfg.passwordLogin ?? !cfg.oidc;
  const throttle = new Throttle();
  const starts = new Throttle(20);
  let collab!: Collab;
  const verifyUserPassword = async (userId: number, pw: string): Promise<boolean> => {
    const u = sys.user(userId);
    // accounts without a password (OIDC) re-verify by holding a live session plus the CSRF token
    if (!u?.passwordHash) return true;
    return !!pw && verifyPassphrase(pw, u.passwordHash);
  };
  const tenants = new Tenants({
    sys,
    usersDir: o.usersDir ?? join(dirname(o.dbPath), "noortasks-users"),
    legacyDbPath: o.dbPath,
    legacyDataDir: o.dataDir,
    common: sharedCommon,
    hooksFor: (uid) => collab.hooksFor(uid, (pw) => verifyUserPassword(uid, pw)),
  });
  collab = new Collab(sys, tenants);
  if (cfg.collaboration === false && sys.settingSeq("collaboration") === 0) collab.setEnabled(false);

  // migration: the single-user database becomes the first admin's account, untouched and in place
  const newUserId = (): number => {
    for (;;) {
      const id = 1 + Math.floor(Math.random() * 900_000_000);
      if (!sys.user(id)) return id;
    }
  };
  if (sys.users().length === 0 && (admins.length > 0 || cfg.passphraseHash)) {
    const st = new Store(o.dbPath);
    let uid = Number(st.getMeta("userId"));
    if (!uid) {
      uid = newUserId();
      st.setMeta("userId", String(uid));
    }
    st.close();
    sys.insertUser({ id: uid, email: admins[0] ?? "admin@localhost", name: "", role: "admin", status: "active", issuer: null, subject: null, passwordHash: cfg.passphraseHash ?? null, dbFile: o.dbPath, createdMs: Date.now() });
    sys.setMeta("legacyAdminId", String(uid));
  }
  const legacyId = Number(sys.getMeta("legacyAdminId") ?? 0);
  if (legacyId) {
    const lu = sys.user(legacyId);
    // the placeholder address is replaced by the configured admin email once one is set
    if (lu && lu.email === "admin@localhost" && admins[0] && !sys.userByEmail(admins[0]) && !lu.issuer) sys.run("update users set email = ? where id = ?", admins[0], legacyId);
  }
  for (const u of sys.users()) if (admins.includes(u.email) && u.role !== "admin") sys.updateUser(u.id, { role: "admin" });

  const maxUsers = (): number => sys.setting<number>("maxUsers", cfg.maxUsers ?? 10);
  const needsSetup = (): boolean => sys.users().length === 0 && !sys.getMeta("setupDone");
  const requireSetupToken = (token: unknown): void => {
    if (!o.setupToken || o.setupToken.length < 32 || typeof token !== "string" || !safeEqual(token, o.setupToken)) throw new ApiError(403, "setup_token_required");
  };
  const getServerName = (): string => sys.setting<string>("serverName", "");
  const claimSetupAdmin = (params: {
    email: string;
    name: string;
    passwordHash: string | null;
    issuer: string | null;
    subject: string | null;
    picture?: string | null;
    serverName: string;
  }): UserRow =>
    sys.tx(() => {
      if (!needsSetup()) throw new ApiError(403, "setup_locked");
      const st = new Store(o.dbPath);
      let uid = Number(st.getMeta("userId"));
      if (!uid) {
        uid = newUserId();
        st.setMeta("userId", String(uid));
      }
      st.close();
      const user = sys.insertUser({
        id: uid,
        email: params.email,
        name: params.name,
        role: "admin",
        status: "active",
        issuer: params.issuer,
        subject: params.subject,
        passwordHash: params.passwordHash,
        dbFile: o.dbPath,
        createdMs: Date.now(),
        picture: params.picture ?? null,
      });
      sys.setSetting("serverName", params.serverName);
      sys.setMeta("setupDone", "1");
      return user;
    });
  const actorOf = (u: UserRow): Actor => ({ userId: u.id, name: u.name || u.email.split("@")[0]!, email: u.email, picture: u.picture });
  const cookieOpts = { path: "/", sameSite: "lax" as const, secure: o.secureCookies ?? false, maxAge: SESSION_DAYS * 24 * 3600 };
  const signIn = (req: FastifyRequest, reply: FastifyReply, u: UserRow): void => {
    sys.destroySession(req.cookies.t);
    const token = sys.createSession(u.id);
    reply.setCookie("t", token, { ...cookieOpts, secure: cookieOpts.secure || req.protocol === "https", httpOnly: true });
    reply.setCookie("_csrf_token", randomBytes(24).toString("hex"), { ...cookieOpts, secure: cookieOpts.secure || req.protocol === "https", httpOnly: false });
    sys.updateUser(u.id, { lastLoginMs: Date.now() });
  };
  const publicUser = (u: UserRow): Loose => ({
    userId: u.id,
    email: u.email,
    name: u.name || u.email.split("@")[0],
    role: u.role,
    status: u.status,
    picture: u.picture,
    createdMs: u.createdMs,
    lastLoginMs: u.lastLoginMs,
    signIn: u.issuer ? "oidc" : u.passwordHash ? "password" : "none",
    collabOptOut: !!u.collabOptOut,
  });

  const dispatch = async (req: FastifyRequest, reply: FastifyReply, userId: number, actor: Actor): Promise<void> => {
    const t = await tenants.ready(userId);
    reply.hijack();
    (req.raw as { ntActor?: Actor }).ntActor = actor;
    actorAls.run(actor, () => t.app.routing(req.raw, reply.raw));
  };

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    const catchAll = req.routeOptions.url === "/*";
    if (catchAll && !APP_PREFIXES.some((p) => path.startsWith(p))) return; // static files and the SPA shell
    if (catchAll && path.startsWith("/feed/")) {
      // private calendar feed: the token in the path is the credential; find the account that issued it
      const token = (path.slice("/feed/".length).split("/")[0] ?? "").replace(/\.ics$/, "");
      for (const u of sys.users()) {
        if (u.status !== "active" || !token) continue;
        const code = tenants.get(u.id).store.getDoc<{ code?: string }>("calendarFeed")?.json.code;
        if (code && safeEqual(code, token)) return dispatch(req, reply, u.id, actorOf(u));
      }
      return reply.status(404).send(errorBody("feed_not_found"));
    }
    if (!catchAll && PUBLIC.has(req.routeOptions.url ?? "")) return;
    const user = sys.sessionUser(req.cookies.t);
    if (!user) return reply.status(401).send(errorBody("unauthorized"));
    const marksRead = /^\/api\/v2\/notification\/?$/.test(path) && ["true", "1"].includes(String((req.query as Record<string, unknown>).autoMarkRead));
    if (marksRead || req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const header = req.headers["x-csrftoken"];
      const cookie = req.cookies._csrf_token;
      if (typeof header !== "string" || !cookie || !safeEqual(header, cookie)) return reply.status(403).send(errorBody("csrf_failed"));
    }
    req.user = user;
    if (!catchAll) return;
    // attachment AI actions: owner or members with access to that task only
    const cleanPath = path.replace(/\/+$/, "");
    const attAi = /^\/api\/v2\/attachment\/([^/]+)\/(transcribe|summarize)$/.exec(cleanPath);
    if (attAi && req.method === "POST") {
      const attId = decodeURIComponent(attAi[1]!);
      const loc = collab.locateAttachment(user.id, attId);
      if (loc) return dispatch(req, reply, loc.ownerId, actorOf(user));
      if (collab.attachmentExistsElsewhere(user.id, attId)) return reply.status(403).send(errorBody("no_permission"));
      return dispatch(req, reply, user.id, actorOf(user));
    }
    // a request addressed to someone else's shared list goes to the owner's app, as this member
    for (const r of SHARED_ROUTES) {
      const m = r.re.exec(path);
      if (!m) continue;
      const id = decodeURIComponent(m[1]!);
      const acc = r.kind === "project" ? (id === "all" ? undefined : collab.access(user.id, id)) : collab.locate(user.id, id);
      if (!acc || acc.ownerId === user.id) break;
      if (collab.rank(acc.perm) < collab.rank(r.need(req.method))) return reply.status(403).send(errorBody("no_permission"));
      return dispatch(req, reply, acc.ownerId, actorOf(user));
    }
    return dispatch(req, reply, user.id, actorOf(user));
  });

  app.get("/healthz", async () => {
    sys.get("select 1");
    return { ok: true };
  });

  // ------------------------------------------------------------------ sign-in & first-run setup
  app.get("/api/auth/config", async () => {
    const serverName = getServerName();
    return {
      mode: "multi",
      oidc: oidc ? { label: cfg.oidc!.label ?? "Google" } : null,
      password: passwordLogin,
      ...(needsSetup() ? { setupRequired: true } : {}),
      ...(serverName ? { serverName } : {}),
    };
  });

  app.get("/api/setup/status", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    if (!needsSetup()) throw new ApiError(404, "not_found");
    return {
      setupRequired: true,
      oidc: oidc ? { label: cfg.oidc!.label ?? "Google" } : null,
      password: passwordLogin,
    };
  });

  app.post<{ Body: { email?: string; password?: string; name?: string; serverName?: string; setupToken?: string } }>("/api/setup", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!needsSetup()) throw new ApiError(403, "setup_locked");
    requirePasswordLogin();
    const b = isPlainObject(req.body) ? req.body : {};
    requireSetupToken(b.setupToken);
    const serverName = typeof b.serverName === "string" ? b.serverName.trim() : "";
    if (!serverName || serverName.length > 80) throw new ApiError(400, "invalid_server_name");
    const email = typeof b.email === "string" ? normEmail(b.email) : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "invalid_email");
    const pw = typeof b.password === "string" ? b.password : "";
    if (pw.length < 8) throw new ApiError(400, "password_too_short");
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 80) : "";
    const passwordHash = await hashPassphrase(pw);
    const u = claimSetupAdmin({ email, name, passwordHash, issuer: null, subject: null, serverName });
    const pairing = sys.createPairingToken(u.id, now());
    signIn(req, reply, u);
    return {
      ok: true,
      serverName,
      user: publicUser(u),
      pairingToken: pairing.token,
      pairingExpiresMs: pairing.expiresMs,
    };
  });

  const authFail = (reply: FastifyReply, code: string): FastifyReply => reply.redirect(`/?auth_error=${encodeURIComponent(code)}`);

  app.get<{ Querystring: Record<string, string> }>("/api/setup/oidc/start", async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (!needsSetup()) throw new ApiError(403, "setup_locked");
    if (!oidc) throw new ApiError(404, "oidc_not_configured");
    requireSetupToken(req.query.setupToken);
    const rawName = typeof req.query.serverName === "string" ? req.query.serverName.trim() : "";
    if (rawName.length > 80) throw new ApiError(400, "invalid_server_name");
    const serverName = rawName || "NoorTasks";
    let s: Awaited<ReturnType<OidcClient["start"]>>;
    try {
      s = await oidc.start();
    } catch {
      return authFail(reply, "provider_unreachable");
    }
    sys.putOidcState(s.state, s.verifier, s.nonce, JSON.stringify({ setup: true, serverName }));
    reply.setCookie("oidc_state", s.state, { path: "/api/auth/oidc", httpOnly: true, sameSite: "lax", secure: (o.secureCookies ?? false) || req.protocol === "https", maxAge: 600 });
    return reply.redirect(s.url);
  });

  app.get<{ Querystring: Record<string, string> }>("/api/auth/oidc/start", async (req, reply) => {
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    if (!starts.take(req.ip)) throw new ApiError(429, "too_many_attempts");
    const q = req.query;
    let native: { challenge: string; state: string } | null = null;
    if (q.native_challenge !== undefined || q.native_state !== undefined) {
      if (typeof q.native_challenge !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(q.native_challenge) ||
          typeof q.native_state !== "string" || !/^[a-f0-9]{64}$/.test(q.native_state)) throw new ApiError(400, "invalid_native_request");
      native = { challenge: q.native_challenge, state: q.native_state };
    }
    const fail = (code: string): FastifyReply => native
      ? reply.redirect(`app.noortasks://auth?state=${native.state}&auth_error=${encodeURIComponent(code)}`)
      : authFail(reply, code);
    if (!oidc) throw new ApiError(404, "oidc_not_configured");
    let s: Awaited<ReturnType<OidcClient["start"]>>;
    try {
      s = await oidc.start();
    } catch {
      return fail("provider_unreachable");
    }
    sys.putOidcState(s.state, s.verifier, s.nonce, native ? JSON.stringify(native) : null);
    // binds the login to this browser (login CSRF): the callback must come back to the browser that started it
    reply.setCookie("oidc_state", s.state, { path: "/api/auth/oidc", httpOnly: true, sameSite: "lax", secure: (o.secureCookies ?? false) || req.protocol === "https", maxAge: 600 });
    return reply.redirect(s.url);
  });

  app.get<{ Querystring: Record<string, string> }>("/api/auth/oidc/callback", async (req, reply) => {
    if (!oidc) throw new ApiError(404, "oidc_not_configured");
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    reply.clearCookie("oidc_state", { path: "/api/auth/oidc" });
    const q = req.query;
    const state = typeof q.state === "string" ? q.state : "";
    const bound = req.cookies.oidc_state;
    const tx = state ? sys.takeOidcState(state) : undefined;
    if (!tx || !bound || !safeEqual(bound, state)) return authFail(reply, q.error === "access_denied" ? "access_denied" : "state_mismatch");
    // Only our start route writes this metadata; the return URL is fixed, never caller supplied.
    const meta = tx.returnTo ? (JSON.parse(tx.returnTo) as { challenge?: string; state?: string; setup?: boolean; serverName?: string }) : null;
    const native = meta && typeof meta.challenge === "string" && typeof meta.state === "string"
      ? { challenge: meta.challenge, state: meta.state }
      : null;
    const setupReq = meta?.setup === true ? { serverName: (meta.serverName ?? "").trim() || "NoorTasks" } : null;
    const fail = (code: string): FastifyReply => native
      ? reply.redirect(`app.noortasks://auth?state=${native.state}&auth_error=${encodeURIComponent(code)}`)
      : authFail(reply, code);
    if (q.error) return fail(q.error === "access_denied" ? "access_denied" : "provider_error");
    let id: Awaited<ReturnType<OidcClient["finish"]>>;
    try {
      id = await oidc.finish(req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "", { state, verifier: tx.verifier, nonce: tx.nonce });
    } catch (e) {
      return fail(e instanceof OidcError ? e.code : "token_rejected");
    }
    if (!id.emailVerified) return fail("email_not_verified");
    if (setupReq) {
      let adminUser: UserRow;
      try {
        adminUser = claimSetupAdmin({
          email: id.email,
          name: id.name,
          passwordHash: null,
          issuer: id.issuer,
          subject: id.subject,
          picture: id.picture,
          serverName: setupReq.serverName,
        });
      } catch {
        return authFail(reply, "setup_locked");
      }
      signIn(req, reply, adminUser);
      return reply.redirect("/?setup_paired=1");
    }
    const isAdmin = admins.includes(id.email);
    let u = sys.userByIdentity(id.issuer, id.subject);
    if (!u) {
      const byEmail = sys.userByEmail(id.email);
      if (byEmail) {
        if (byEmail.issuer && (byEmail.issuer !== id.issuer || byEmail.subject !== id.subject)) return fail("identity_mismatch");
        sys.updateUser(byEmail.id, { issuer: id.issuer, subject: id.subject });
        u = sys.user(byEmail.id)!;
      }
    }
    if (u) {
      if (u.status === "disabled") return fail("account_disabled");
      if (u.status === "removed") {
        if (!isAdmin && !sys.allowed(id.email)) return fail("not_invited");
        if (!isAdmin && sys.activeCount() >= maxUsers()) return fail("max_users");
        sys.updateUser(u.id, { status: "active" });
      }
      if (!u.name || u.picture !== id.picture) sys.updateUser(u.id, { name: u.name || id.name, picture: id.picture });
    } else {
      if (!isAdmin && !sys.allowed(id.email)) return fail(sys.users().length === 0 ? "setup_required" : "not_invited");
      if (!isAdmin && sys.activeCount() >= maxUsers()) return fail("max_users");
      const uid = newUserId();
      const paths = tenants.newPaths(uid);
      tenants.initStore(uid, paths.dbFile);
      u = sys.insertUser({ id: uid, email: id.email, name: id.name, role: isAdmin ? "admin" : "member", status: "active", issuer: id.issuer, subject: id.subject, passwordHash: null, dbFile: paths.dbFile, createdMs: Date.now(), picture: id.picture });
    }
    if (native) {
      const code = sys.createNativeLoginCode(u.id, native.challenge);
      return reply.redirect(`app.noortasks://auth?code=${code}&state=${native.state}`);
    }
    signIn(req, reply, sys.user(u.id)!);
    return reply.redirect("/");
  });

  // Login endpoint, like password signon: no existing session required. The app-held PKCE
  // secret and one-time code authorize session creation; all account writes still require CSRF.
  app.post("/api/auth/oidc/native/redeem", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!oidc) throw new ApiError(404, "oidc_not_configured");
    const key = `native:${req.ip}`;
    if (!throttle.take(key)) throw new ApiError(429, "too_many_attempts");
    const b = isPlainObject(req.body) ? req.body : {};
    if (typeof b.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(b.code) ||
        typeof b.verifier !== "string" || !/^[a-f0-9]{64}$/.test(b.verifier)) throw new ApiError(400, "invalid_native_request");
    const challenge = createHash("sha256").update(b.verifier).digest("base64url");
    const user = sys.takeNativeLoginCode(b.code, challenge);
    if (!user) {
      throw new ApiError(401, "invalid_native_code");
    }
    if (user.status !== "active") throw new ApiError(403, "account_disabled");
    throttle.clear(key);
    signIn(req, reply, user);
    return { ok: true };
  });

  const requirePasswordLogin = (): void => {
    if (!passwordLogin) throw new ApiError(403, "password_login_disabled");
  };

  app.post<{ Body: { username?: string; password?: string } }>("/api/v2/user/signon", async (req, reply) => {
    requirePasswordLogin();
    const key = req.ip;
    if (!throttle.take(key)) throw new ApiError(429, "too_many_attempts");
    const b = isPlainObject(req.body) ? req.body : {};
    const name = typeof b.username === "string" ? b.username.trim() : "";
    const pw = typeof b.password === "string" ? b.password : "";
    // a bare passphrase (the single-user sign-in form) signs in the migrated admin account
    const u = name.includes("@") ? sys.userByEmail(name) : legacyId ? sys.user(legacyId) : undefined;
    const ok = !!u && u.status === "active" && !!u.passwordHash && !!pw && (await verifyPassphrase(pw, u.passwordHash));
    if (!ok) {
      throw new ApiError(401, "incorrect_password");
    }
    throttle.clear(key);
    signIn(req, reply, u!);
    const svc = tenants.get(u!.id).svc;
    return { userId: String(u!.id), username: u!.email, inboxId: svc.inboxId, pro: true };
  });

  app.post<{ Body: { email?: string; code?: string; password?: string; name?: string } }>("/api/auth/password/join", async (req, reply) => {
    requirePasswordLogin();
    const key = req.ip;
    if (!throttle.take(key)) throw new ApiError(429, "too_many_attempts");
    const b = isPlainObject(req.body) ? req.body : {};
    const email = typeof b.email === "string" ? normEmail(b.email) : "";
    const pw = typeof b.password === "string" ? b.password : "";
    if (pw.length < 8) throw new ApiError(400, "password_too_short");
    if (!email || typeof b.code !== "string" || sys.userByEmail(email)) {
      throw new ApiError(403, "invalid_invite");
    }
    if (sys.activeCount() >= maxUsers()) throw new ApiError(403, "max_users");
    if (!sys.validInvite(email, b.code)) throw new ApiError(403, "invalid_invite");
    const passwordHash = await hashPassphrase(pw);
    const u = sys.tx(() => {
      if (sys.activeCount() >= maxUsers()) throw new ApiError(403, "max_users");
      if (sys.userByEmail(email) || !sys.consumeInvite(email, b.code as string)) throw new ApiError(403, "invalid_invite");
      const uid = newUserId();
      const paths = tenants.newPaths(uid);
      tenants.initStore(uid, paths.dbFile);
      return sys.insertUser({ id: uid, email, name: typeof b.name === "string" ? b.name.slice(0, 80) : "", role: admins.includes(email) ? "admin" : "member", status: "active", issuer: null, subject: null, passwordHash, dbFile: paths.dbFile, createdMs: Date.now() });
    });
    signIn(req, reply, u);
    return publicUser(u);
  });

  app.post("/api/auth/pairing-token", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const u = me(req);
    const { token, expiresMs } = sys.createPairingToken(u.id, now());
    return { token, expiresMs, serverName: getServerName() || "NoorTasks" };
  });

  app.post<{ Body: { token?: string } }>("/api/auth/pair", async (req, reply) => {
    reply.header("cache-control", "no-store");
    const key = `pair:${req.ip}`;
    const curNow = now();
    if (!throttle.take(key, curNow)) throw new ApiError(429, "too_many_attempts");
    const b = isPlainObject(req.body) ? req.body : {};
    const token = typeof b.token === "string" ? b.token.trim() : "";
    if (!token) throw new ApiError(400, "invalid_pairing_token");
    const u = sys.takePairingToken(token, curNow);
    if (!u) {
      throw new ApiError(403, "invalid_pairing_token");
    }
    throttle.clear(key);
    signIn(req, reply, u);
    return { ok: true, serverName: getServerName() || "NoorTasks", user: publicUser(u) };
  });

  app.post("/api/v2/user/signout", async (req, reply) => {
    sys.destroySession(req.cookies.t);
    reply.clearCookie("t", { path: "/" });
    reply.clearCookie("_csrf_token", { path: "/" });
    return {};
  });

  const me = (req: FastifyRequest): UserRow => req.user!;
  app.get("/api/auth/me", async (req) => {
    const u = me(req);
    const serverName = getServerName();
    return {
      ...publicUser(u),
      ...(serverName ? { serverName } : {}),
      collaboration: { enabled: collab.enabled(), optedOut: !!u.collabOptOut },
    };
  });
  app.put<{ Body: { collabOptOut?: boolean; name?: string } }>("/api/auth/me", async (req) => {
    const u = me(req);
    const b = isPlainObject(req.body) ? req.body : {};
    if (typeof b.collabOptOut === "boolean") sys.updateUser(u.id, { collabOptOut: b.collabOptOut ? 1 : 0 });
    if (typeof b.name === "string" && b.name.trim()) sys.updateUser(u.id, { name: b.name.trim().slice(0, 80) });
    const n = sys.user(u.id)!;
    return { ...publicUser(n), collaboration: { enabled: collab.enabled(), optedOut: !!n.collabOptOut } };
  });
  app.get("/api/v2/user/profile", async (req) => {
    const u = me(req);
    const name = u.name || u.email.split("@")[0]!;
    return { username: u.email, email: u.email, name, displayName: name, picture: u.picture ?? "", userCode: String(u.id), verifiedEmail: !!u.issuer, filledPassword: !!u.passwordHash, fakedEmail: false };
  });
  app.get("/api/v2/user/userBindingInfo", async (req) => {
    const u = me(req);
    return { thirdSiteBinds: u.issuer ? [{ siteId: 0, nickName: u.name, email: u.email }] : [], fakedEmail: false, email: u.email };
  });

  // ------------------------------------------------------------------ admin: members, allowlist, switches
  const admin = (req: FastifyRequest): UserRow => {
    const u = me(req);
    if (u.role !== "admin") throw new ApiError(403, "admin_only");
    return u;
  };
  const membersView = (): Loose => ({
    users: sys.users().map(publicUser),
    allowlist: sys.allowlist().map((a) => ({ email: a.email, addedMs: a.addedMs, joined: !!sys.userByEmail(a.email), hasInvite: !!a.hasInvite })),
    settings: { collaboration: collab.enabled(), maxUsers: maxUsers() },
    passwordLogin,
    oidc: !!oidc,
    activeCount: sys.activeCount(),
  });
  const confirmFor = (req: FastifyRequest, target: UserRow): void => {
    const b = isPlainObject(req.body) ? req.body : {};
    if (typeof b.confirm !== "string" || normEmail(b.confirm) !== target.email) throw new ApiError(400, "confirm_required");
  };
  const targetOf = (req: FastifyRequest<{ Params: { id: string } }>, self: UserRow): UserRow => {
    const t = sys.user(Number(req.params.id));
    if (!t) throw new ApiError(404, "member_not_found");
    if (t.id === self.id) throw new ApiError(400, "cannot_change_self");
    return t;
  };

  app.get("/api/admin/members", async (req) => {
    admin(req);
    return membersView();
  });
  app.post<{ Body: { email?: string } }>("/api/admin/allowlist", async (req) => {
    const a = admin(req);
    const email = isPlainObject(req.body) && typeof req.body.email === "string" ? normEmail(req.body.email) : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "invalid_email");
    sys.allow(email, a.id);
    const out = membersView();
    // password mode: a one-time invite code for this email (shown once; OIDC needs none)
    if (passwordLogin && !sys.userByEmail(email)) out.inviteCode = sys.issueInvite(email);
    return out;
  });
  app.delete<{ Params: { email: string } }>("/api/admin/allowlist/:email", async (req) => {
    admin(req);
    sys.disallow(decodeURIComponent(req.params.email));
    return membersView();
  });
  app.post<{ Params: { id: string } }>("/api/admin/members/:id/disable", async (req) => {
    const t = targetOf(req, admin(req));
    sys.updateUser(t.id, { status: "disabled" });
    sys.destroyUserSessions(t.id);
    return membersView();
  });
  app.post<{ Params: { id: string } }>("/api/admin/members/:id/enable", async (req) => {
    const t = targetOf(req, admin(req));
    if (t.status === "removed" && sys.activeCount() >= maxUsers()) throw new ApiError(403, "max_users");
    sys.updateUser(t.id, { status: "active" });
    return membersView();
  });
  /** Removes access (sessions, allowlist entry, shares); the data stays until "delete data". */
  app.post<{ Params: { id: string } }>("/api/admin/members/:id/remove", async (req) => {
    const t = targetOf(req, admin(req));
    confirmFor(req, t);
    sys.updateUser(t.id, { status: "removed" });
    sys.destroyUserSessions(t.id);
    sys.disallow(t.email);
    collab.dropUserShares(t.id);
    return membersView();
  });
  /** Deletes a removed member's database and files for good (second confirm step). */
  app.post<{ Params: { id: string } }>("/api/admin/members/:id/delete-data", async (req) => {
    const t = targetOf(req, admin(req));
    if (t.status !== "removed") throw new ApiError(400, "remove_first");
    if (t.id === legacyId || t.role === "admin") throw new ApiError(400, "cannot_delete_admin");
    confirmFor(req, t);
    collab.dropUserShares(t.id);
    await tenants.deleteData(t.id);
    sys.run("delete from users where id = ?", t.id);
    return membersView();
  });
  app.put<{ Body: { collaboration?: boolean; maxUsers?: number } }>("/api/admin/settings", async (req) => {
    admin(req);
    const b = isPlainObject(req.body) ? req.body : {};
    if (typeof b.collaboration === "boolean" && b.collaboration !== collab.enabled()) collab.setEnabled(b.collaboration);
    if (b.maxUsers !== undefined) {
      const n = Number(b.maxUsers);
      if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ApiError(400, "invalid_max_users");
      sys.setSetting("maxUsers", n);
    }
    return membersView();
  });

  // ------------------------------------------------------------------ sharing, assigning
  /** Runs a collaboration action as the signed-in member (activity and notifications name them). */
  const act = <T>(req: FastifyRequest, fn: (u: UserRow) => T): T => actorAls.run(actorOf(me(req)), () => fn(me(req)));
  const contacts = async (req: FastifyRequest) => collab.contacts(me(req));
  app.get("/api/v2/share/contacts", contacts);
  app.get("/api/v2/share/shareContacts", contacts);
  app.get("/api/v2/project/share/recentProjectUsers", contacts);
  app.get<{ Params: { id: string } }>("/api/v2/project/:id/shares", async (req) => collab.listShares(me(req), req.params.id));
  app.get<{ Params: { id: string } }>("/api/v2/project/:id/users", async (req) => collab.listShares(me(req), req.params.id));
  app.get<{ Params: { id: string } }>("/api/v2/project/:id/share/check-quota", async () => true);
  app.post<{ Params: { id: string } }>("/api/v2/project/:id/share", async (req) => act(req, (u) => collab.shareProject(u, req.params.id, req.body)));
  app.put<{ Params: { id: string }; Querystring: { permission?: string; recordId?: string } }>("/api/v2/project/:id/permission", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const perm = req.query.permission ?? (typeof b.permission === "string" ? b.permission : "");
    const rec = req.query.recordId ?? (typeof b.recordId === "string" ? b.recordId : "");
    return act(req, (u) => collab.setPermission(u, req.params.id, rec, perm));
  });
  app.delete<{ Params: { id: string; shareId: string } }>("/api/v2/project/:id/share/:shareId", async (req) => act(req, (u) => collab.removeShare(u, req.params.id, req.params.shareId)));
  app.post<{ Params: { id: string }; Querystring: { toUserCode?: string } }>("/api/v2/project/:id/transfer", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    return act(req, (u) => collab.transfer(u, req.params.id, Number(req.query.toUserCode ?? b.toUserId ?? b.toUserCode)));
  });
  app.post("/api/v2/task/assign", async (req) => act(req, (u) => collab.assign(u, req.body)));

  const serveSetupPage = async (req: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!needsSetup()) return reply.status(404).send(errorBody("not_found"));
    return serveStatic(req, reply);
  };
  app.get("/setup", serveSetupPage);
  app.get("/setup/*", serveSetupPage);

  app.all("/*", async (req, reply) => serveStatic(req, reply));

  const backupScheduler = o.dailyBackup?.enabled
    ? startDailyBackup({
        backupDir: o.dailyBackup.backupDir ?? join(dirname(o.dbPath), "backups"),
        sys,
        tenants,
        ...(o.dailyBackup.retention !== undefined ? { retention: o.dailyBackup.retention } : {}),
        ...(o.dailyBackup.intervalMs !== undefined ? { intervalMs: o.dailyBackup.intervalMs } : {}),
        now,
        serverName: () => getServerName() || undefined,
        isReady: () => !needsSetup(),
        onError: (err) => app.log.error({ err }, "daily backup failed"),
      })
    : undefined;

  app.addHook("onClose", async () => {
    backupScheduler?.stop();
    await tenants.closeAll();
    sys.close();
  });

  return {
    app,
    sys,
    tenants,
    collab,
    routes,
    apps: () =>
      sys
        .users()
        .filter((u) => u.status === "active")
        .map((u) => tenants.get(u.id)),
    ...(backupScheduler ? { runDailyBackup: () => backupScheduler.tick() } : {}),
  };
}
