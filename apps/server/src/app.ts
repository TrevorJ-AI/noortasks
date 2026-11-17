import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Agent as HttpsAgent } from "node:https";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import {
  CLOSED_PAGE_SIZE,
  COMPLETED_STATUS_PARAM,
  TRASH_PAGE_SIZE,
  TaskStatus,
  defaultPreferences,
  formatServerDate,
  isPlainObject,
  toMs,
  unlimitedLimits,
  type BatchCheckResponse,
  type BatchResponse,
  type Comment,
  type Loose,
  type Task,
} from "@noortasks/core";
import Fastify, { type FastifyInstance } from "fastify";
import { installHttpSecurity, JSON_LIMIT, UPLOAD_LIMIT } from "./http-security.js";
import { actorAls, type Actor } from "./actor.js";
import { Sessions, Throttle, safeEqual, verifyPassphrase, type AuthConfig } from "./auth.js";
import { ActivityService, registerActivityRoutes } from "./activity.js";
import { AiService, registerAiRoutes, type AiConfig, type AiDeps } from "./ai.js";
import { registerAttachmentRoutes } from "./attachments.js";
import { BackupService, registerBackupRoutes } from "./backup.js";
import { CalendarService, registerCalendarRoutes } from "./calendar.js";
import { loadCalendarOAuthConfig, type CalendarOAuthConfig, type FetchLike } from "./calendar-adapters.js";
import { CommentService, registerCommentRoutes } from "./comments.js";
import { registerCountdownRoutes } from "./countdown.js";
import { registerFocusRoutes } from "./focus.js";
import { registerHabitRoutes } from "./habits.js";
import { registerMatrixRoutes } from "./matrix.js";
import { ReminderService, loadVapidKeys, registerReminderRoutes, type VapidConfig } from "./reminders.js";
import { registerStatsRoutes } from "./stats.js";
import { ApiError, Service } from "./service.js";
import { Store } from "./store.js";
import { buildCheck } from "./sync.js";
import { TemplateService, registerTemplateRoutes } from "./templates.js";

export interface AppOptions {
  /** Open store (tests) or path to the database file. */
  store?: Store;
  dbPath?: string;
  dataDir: string;
  /** Skip sign-in and the CSRF check (tests, local dev). */
  noAuth?: boolean;
  auth?: AuthConfig;
  logger?: boolean;
  /** Mark the session cookies `Secure` (set when served over https). */
  secureCookies?: boolean;
  /** Injected clock (tests); epoch ms. */
  now?: () => number;
  /** Path to JSON file containing { publicKey, privateKey, subject? } for Web Push VAPID. */
  vapidFile?: string;
  /** In-memory VAPID keys (tests). */
  vapid?: VapidConfig;
  /** Optional HTTPS agent for Web Push delivery (tests using a self-signed CA). */
  pushAgent?: HttpsAgent;
  /** Path to JSON file containing Google/Outlook OAuth client credentials. */
  calendarOAuthFile?: string;
  /** In-memory OAuth config (tests). */
  calendarOAuth?: CalendarOAuthConfig;
  /** Injectable fetch implementation for calendar feeds / OAuth / CalDAV (tests). */
  calendarFetch?: FetchLike;
  /** Multi-user mode: this app serves one account; shared lists are merged and routed through these hooks. */
  tenant?: TenantHooks;
  /** AI transcription/summarization configuration. */
  ai?: AiConfig;
  /** Injectable AI dependencies (tests). */
  aiDeps?: AiDeps;
}

/** Collaboration hooks for one account's app (implemented by collab.ts). */
export interface TenantHooks {
  check(svc: Service, cp: number): BatchCheckResponse;
  batchTask(svc: Service, body: unknown): BatchResponse;
  batchTaskProject(svc: Service, body: unknown): BatchResponse;
  batchTaskParent(svc: Service, body: unknown): BatchResponse;
  /** A task of this account or of a list shared with it (read permission is enough). */
  getTask(svc: Service, id: string): Task | undefined;
  batchProject(svc: Service, body: unknown): BatchResponse;
  batchColumn(svc: Service, body: unknown): BatchResponse;
  onComment?(svc: Service, task: Task, comment: Comment): void;
  verifyPassword?(password: string): Promise<boolean>;
}

export interface BuiltApp {
  app: FastifyInstance;
  svc: Service;
  store: Store;
  activity: ActivityService;
  comments: CommentService;
  templates: TemplateService;
  reminders: ReminderService;
  backup: BackupService;
  calendar: CalendarService;
  ai: AiService;
  /** Every route this app registered (the isolation suite walks them all). */
  routes: Array<{ method: string; url: string }>;
}

const PUBLIC_PATHS = new Set(["/pub/api/v1/app/config", "/pub/api/v2/subscribe/subscribe_spec", "/pub/api/v1/calendar/holiday/cn/recent", "/api/v2/user/signon"]);

function errorBody(code: string, message?: string): Loose {
  return { errorId: randomBytes(8).toString("hex"), errorCode: code, errorMessage: message ?? code, data: null };
}

const num = (v: unknown, d: number): number => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : d;
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const PREF_DEFAULTS: Record<string, () => unknown> = {
  pomodoro: () => ({ id: 0, shortBreakDuration: 5, longBreakDuration: 15, longBreakInterval: 4, pomoGoal: 4, focusDuration: null, mindfulnessEnabled: false, autoPomo: false, autoBreak: false, lightsOn: false, focused: false, soundsOn: true, pomoDuration: 25 }),
  habit: () => ({ showInCalendar: true, showInToday: true, defaultSection: { order: 0 }, enabled: true }),
  dailyReminder: () => ({ enable: false, dailyReminders: [], notifyOptions: [], weekDays: [], holidayNotify: false }),
  featurePrompt: () => ({ today: false, inbox: false, webPomoTask: false, level: 0, modifiedTime: formatServerDate() }),
  ext: () => ({}),
  pluginSettings: () => [],
  apps: () => [],
};

export function buildApp(opts: AppOptions): BuiltApp {
  const store = opts.store ?? new Store(opts.dbPath ?? ":memory:");
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  const svc = new Service(store, { dataDir: opts.dataDir, ...(opts.now ? { now: opts.now } : {}) });
  const activity = new ActivityService(svc);
  svc.attachActivity(activity);
  store.tx(() => {
    if (!store.getMeta("seq")) store.setMeta("seq", String(Date.now()));
  });
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: JSON_LIMIT, requestTimeout: 30_000, ignoreTrailingSlash: true });
  installHttpSecurity(app);
  const routes: BuiltApp["routes"] = [];
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD") routes.push({ method: m, url: r.url });
  });
  const sessions = new Sessions(store);
  const throttle = new Throttle();

  app.register(fastifyCookie);
  app.register(fastifyMultipart, { limits: { fileSize: UPLOAD_LIMIT, files: 1, fields: 20, parts: 40 } });

  // JSON bodies may be empty (DELETE with a content-type and no body).
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try {
      done(null, body === "" ? undefined : JSON.parse(body as string));
    } catch {
      done(new ApiError(400, "invalid_json"), undefined);
    }
  });
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => {
    done(null, body as string);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(errorBody(err.errorCode, err.message));
    const e = err as { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send(errorBody(e.code ?? "bad_request"));
    app.log.error({ code: e.code }, "request failed");
    return reply.status(500).send(errorBody("internal_error"));
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(errorBody("not_found")));

  // ---------------------------------------------------------------- acting member (multi-user)
  // The front puts the signed-in member on the raw request. The body of a request can arrive after its headers,
  // in another async context, so the member is re-entered right before every handler; without one, refuse.
  if (opts.tenant) {
    app.addHook("preHandler", (req, reply, done) => {
      const actor = (req.raw as { ntActor?: Actor }).ntActor;
      if (!actor) {
        void reply.status(401).send(errorBody("unauthorized"));
        return;
      }
      actorAls.run(actor, done);
    });
  }

  // ---------------------------------------------------------------- auth + csrf
  app.addHook("onRequest", async (req, reply) => {
    if (opts.noAuth) return;
    const path = req.url.split("?")[0]!;
    if (PUBLIC_PATHS.has(path) || req.routeOptions.url === "/feed/:tokenFile") return;
    if (!sessions.valid(req.cookies.t)) return reply.status(401).send(errorBody("unauthorized"));
    const marksRead = /^\/api\/v2\/notification\/?$/.test(path) && ["true", "1"].includes(String((req.query as Record<string, unknown>).autoMarkRead));
    if (marksRead || req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
      const header = req.headers["x-csrftoken"];
      const cookie = req.cookies._csrf_token;
      if (typeof header !== "string" || !cookie || !safeEqual(header, cookie)) return reply.status(403).send(errorBody("csrf_failed"));
    }
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/v2/user/signon", async (req, reply) => {
    if (opts.noAuth) return { username: "noortasks" };
    const key = req.ip;
    if (!throttle.take(key)) throw new ApiError(429, "too_many_attempts");
    const pw = isPlainObject(req.body) && typeof req.body.password === "string" ? req.body.password : "";
    if (!opts.auth || !pw || !(await verifyPassphrase(pw, opts.auth.passphraseHash))) {
      throw new ApiError(401, "incorrect_password");
    }
    throttle.clear(key);
    sessions.destroy(req.cookies.t);
    const token = sessions.create();
    const csrf = randomBytes(24).toString("hex");
    const cookie = { path: "/", sameSite: "lax" as const, secure: (opts.secureCookies ?? false) || req.protocol === "https", maxAge: 30 * 24 * 3600 };
    reply.setCookie("t", token, { ...cookie, httpOnly: true });
    reply.setCookie("_csrf_token", csrf, { ...cookie, httpOnly: false });
    return { userId: store.getMeta("userId"), username: "noortasks", inboxId: svc.inboxId, pro: true };
  });

  app.post("/api/v2/user/signout", async (req, reply) => {
    sessions.destroy(req.cookies.t);
    reply.clearCookie("t", { path: "/" });
    reply.clearCookie("_csrf_token", { path: "/" });
    return {};
  });

  // ---------------------------------------------------------------- sync
  app.get<{ Params: { cp: string } }>("/api/v3/batch/check/:cp", async (req) => {
    const cp = Number(req.params.cp);
    if (!Number.isFinite(cp) || cp < 0) throw new ApiError(400, "invalid_checkpoint");
    return opts.tenant ? opts.tenant.check(svc, cp) : buildCheck(svc, cp);
  });

  const tenant = opts.tenant;
  app.post("/api/v2/batch/task", async (req) => (tenant ? tenant.batchTask(svc, req.body) : svc.batchTask(req.body)));
  app.post("/api/v2/batch/taskParent", async (req) => (tenant ? tenant.batchTaskParent(svc, req.body) : svc.batchTaskParent(req.body)));
  app.post("/api/v2/batch/taskProject", async (req) => (tenant ? tenant.batchTaskProject(svc, req.body) : svc.batchTaskProject(req.body)));
  app.post("/api/v2/batch/project", async (req) => (tenant ? tenant.batchProject(svc, req.body) : svc.batchProject(req.body)));
  app.post("/api/v2/batch/projectGroup", async (req) => svc.batchProjectGroup(req.body));
  app.post("/api/v2/batch/columnProject", async (req) => (tenant ? tenant.batchColumn(svc, req.body) : svc.batchColumn(req.body)));
  app.post("/api/v2/batch/filter", async (req) => svc.batchFilter(req.body));
  app.post("/api/v2/batch/tag", async (req) => svc.batchTag(req.body));
  app.post("/api/v2/batch/order", async (req) => svc.batchOrder("v2", req.body));
  app.post("/api/v3/batch/order", async (req) => svc.batchOrder("v3", req.body));

  const parseColFrom = (v: unknown): number => {
    const n = num(v, NaN);
    if (Number.isFinite(n)) return n;
    const ms = toMs(v);
    return Number.isFinite(ms) ? ms : 0;
  };
  app.get<{ Querystring: { from?: string } }>("/api/v2/column", async (req) => svc.columnsFrom(parseColFrom(req.query.from)));
  app.get<{ Params: { id: string } }>("/api/v2/column/project/:id", async (req) => svc.columnsOf(req.params.id));

  // ---------------------------------------------------------------- tags
  const tagArgs = (req: { body: unknown; query: unknown }): { name: string; newName: string } => {
    const b = isPlainObject(req.body) ? req.body : {};
    const q = isPlainObject(req.query) ? req.query : {};
    const name = str(b.name) ?? str(q.name);
    const newName = str(b.newName) ?? str(b.newname) ?? str(q.newName);
    if (!name) throw new ApiError(400, "invalid_tag");
    return { name, newName: newName ?? "" };
  };
  app.put("/api/v2/tag/rename", async (req) => {
    const { name, newName } = tagArgs(req);
    if (!newName) throw new ApiError(400, "invalid_tag");
    return svc.renameTag(name, newName, false);
  });
  app.put("/api/v2/tag/merge", async (req) => {
    const { name, newName } = tagArgs(req);
    if (!newName) throw new ApiError(400, "invalid_tag");
    return svc.renameTag(name, newName, true);
  });
  app.delete("/api/v2/tag/delete", async (req) => svc.deleteTag(tagArgs(req).name));
  app.post("/api/v2/tag/completedTask", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const tags = Array.isArray(b.tags) ? b.tags.filter((t): t is string => typeof t === "string") : [];
    return svc.completedByTag(tags, num(b.token, 0), num(b.limit, 100));
  });

  // ---------------------------------------------------------------- tasks, completed, trash
  app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>("/api/v2/task/:id", async (req) => {
    const t = tenant ? tenant.getTask(svc, req.params.id) : store.getTask(req.params.id);
    if (!t || (req.query.projectId && t.projectId !== req.query.projectId)) throw new ApiError(404, "task_not_found");
    return t;
  });
  app.post<{ Params: { projectId: string; taskId: string } }>("/api/v2/project/:projectId/task/:taskId/complete", async (req) =>
    svc.completeTask(req.params.projectId, req.params.taskId),
  );
  app.get<{ Querystring: { keywords?: string; keyword?: string; q?: string; projectId?: string; tag?: string; priority?: string; date?: string; status?: string } }>(
    "/api/v2/search/all",
    async (req) => {
      const q = req.query;
      const keywords = q.keywords ?? q.keyword ?? q.q;
      return svc.searchTasks({
        ...(keywords ? { keywords } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.tag ? { tag: q.tag } : {}),
        ...(q.priority !== undefined ? { priority: q.priority } : {}),
        ...(q.date ? { date: q.date } : {}),
        ...(q.status !== undefined ? { status: q.status } : {}),
      });
    },
  );
  app.delete("/api/v2/task", async (req) => svc.deleteForever(req.body));
  app.get<{ Params: { id: string } }>("/api/v2/project/:id/tasks", async (req) =>
    store.tasksOfProject(req.params.id).filter((t) => t.status === TaskStatus.Open),
  );

  type ClosedQ = { from?: string; to?: string; status?: string; limit?: string };
  const closedRoute = (defaultLimit: number, fixedStatus?: number) => async (req: { params: unknown; query: unknown }) => {
    const p = req.params as { ids?: string };
    const q = req.query as ClosedQ;
    const ids = p.ids && p.ids !== "all" ? p.ids.split(",").filter(Boolean) : undefined;
    const s = q.status;
    const status =
      fixedStatus ??
      (s === "Abandoned" || s === String(TaskStatus.WontDo) ? COMPLETED_STATUS_PARAM.Abandoned : COMPLETED_STATUS_PARAM.Completed);
    return svc.closedTasks({ ...(ids ? { projectIds: ids } : {}), status, ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), limit: num(q.limit, defaultLimit) });
  };
  app.get("/api/v2/project/:ids/closed", closedRoute(CLOSED_PAGE_SIZE));
  app.get("/api/v2/project/:ids/completed", closedRoute(100, TaskStatus.Completed));
  app.get("/api/v2/project/all/completedInAll", closedRoute(100, TaskStatus.Completed));

  app.get<{ Querystring: { limit?: string; next?: string; type?: string } }>("/api/v2/project/all/trash/page", async (req) =>
    svc.trashPage(num(req.query.limit, TRASH_PAGE_SIZE), num(req.query.next, 0)),
  );
  app.post("/api/v2/trash/restore", async (req) => svc.trashRestore(req.body));
  app.delete("/api/v2/trash/cleanUp", async () => svc.cleanUpTrash());

  // ---------------------------------------------------------------- user
  const status = (): Loose => {
    const base = (store.getDoc<Loose>("status")?.json ?? {}) as Loose;
    return {
      ...base,
      userId: base.userId ?? store.getMeta("userId"),
      inboxId: svc.inboxId,
      teamPro: base.teamPro ?? false,
      teamUser: base.teamUser ?? false,
      activeTeamUser: base.activeTeamUser ?? false,
      ds: base.ds ?? false,
      // always pro: the stored values are kept for export, the served ones are overlaid here
      pro: true,
      needSubscribe: false,
      freeTrial: false,
      proEndDate: "2099-12-31T00:00:00.000+0000",
      timeStamp: Date.now(),
    };
  };
  app.get("/api/v2/user/status", async () => status());
  app.get("/api/v2/user/profile", async () => {
    const stored = store.getDoc<Loose>("profile")?.json;
    return stored ?? { username: "noortasks", name: "NoorTasks", displayName: "NoorTasks", userCode: store.getMeta("userId"), verifiedEmail: false, filledPassword: true, fakedEmail: true };
  });
  app.get("/api/v2/user/mfa", async () => false);
  app.get("/api/v2/user/userBindingInfo", async () => ({ thirdSiteBinds: [], fakedEmail: true, email: "" }));

  const settings = (): Loose => (store.getDoc<Loose>("settings")?.json ?? (defaultPreferences(Number(store.getMeta("userId"))) as Loose));
  app.get("/api/v2/user/preferences/settings", async () => settings());
  app.put("/api/v2/user/preferences/settings", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const next = { ...settings(), ...b };
    store.tx(() => {
      store.putDoc("settings", next);
      if (isPlainObject(b.dailyRemindTimeConfig)) {
        const curDr = (store.getDoc<Loose>("dailyReminder")?.json ?? PREF_DEFAULTS.dailyReminder!()) as Loose;
        store.putDoc("dailyReminder", { ...curDr, ...b.dailyRemindTimeConfig });
      }
    });
    return next;
  });
  for (const name of Object.keys(PREF_DEFAULTS)) {
    const get = (): unknown => {
      const stored = store.getDoc(name)?.json;
      if (stored !== undefined) return stored;
      if (name === "dailyReminder") {
        const fromSet = settings().dailyRemindTimeConfig;
        if (isPlainObject(fromSet)) return fromSet;
      }
      return PREF_DEFAULTS[name]!();
    };
    app.get<{ Querystring: { mtime?: string } }>(`/api/v2/user/preferences/${name}`, async (req) => {
      const cur = get();
      if (name === "ext" && isPlainObject(cur) && req.query.mtime !== undefined) {
        const since = Number(req.query.mtime);
        if (Number.isFinite(since) && since > 0) {
          const filtered: Loose = {};
          for (const [k, v] of Object.entries(cur)) {
            if (isPlainObject(v) && typeof v.mtime === "number" && v.mtime > since) filtered[k] = v;
          }
          return filtered;
        }
      }
      return cur;
    });
    const write = async (req: { body: unknown }): Promise<unknown> => {
      const cur = get();
      const b = req.body;
      let next: unknown;
      if (name === "ext" && isPlainObject(b) && isPlainObject(cur)) {
        const merged: Loose = { ...cur };
        for (const [k, v] of Object.entries(b)) {
          const prev = cur[k];
          if (isPlainObject(v) && isPlainObject(prev) && typeof v.mtime === "number" && typeof prev.mtime === "number" && v.mtime < prev.mtime) {
            continue;
          }
          merged[k] = v;
        }
        next = merged;
      } else {
        next = isPlainObject(b) && isPlainObject(cur) ? { ...cur, ...b } : (b ?? cur);
      }
      store.tx(() => {
        store.putDoc(name, next);
        if (name === "dailyReminder" && isPlainObject(next)) {
          const s = store.getDoc<Loose>("settings")?.json;
          if (s && "dailyRemindTimeConfig" in s) {
            store.putDoc("settings", { ...s, dailyRemindTimeConfig: next });
          }
        }
      });
      return next;
    };
    app.put(`/api/v2/user/preferences/${name}`, write);
    app.post(`/api/v2/user/preferences/${name}`, write);
  }

  app.get("/api/v2/holidays", async () => store.getDoc("holidays")?.json ?? { restDays: [], workDays: [] });
  app.put("/api/v2/holidays", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const doc = {
      restDays: Array.isArray(b.restDays) ? b.restDays.filter((x): x is string => typeof x === "string") : [],
      workDays: Array.isArray(b.workDays) ? b.workDays.filter((x): x is string => typeof x === "string") : [],
    };
    store.tx(() => store.putDoc("holidays", doc));
    return doc;
  });

  app.get("/api/v2/configs/limits", async () => unlimitedLimits());

  // ---------------------------------------------------------------- stubs: later milestones, empty shapes so a client boots
  const emptyArr = async (): Promise<unknown[]> => [];
  app.get("/api/v2/chatmind/bind/check", async () => false);
  app.get("/api/v2/project/share/recentProjectUsers", emptyArr);
  app.get("/pub/api/v1/app/config", async () => ({ etag: "0", interval: 3600 }));
  app.get("/pub/api/v2/subscribe/subscribe_spec", emptyArr);

  const vapid = opts.vapid ?? (opts.vapidFile ? loadVapidKeys(opts.vapidFile) : undefined);
  const calendarOAuth = opts.calendarOAuth ?? (opts.calendarOAuthFile ? loadCalendarOAuthConfig(opts.calendarOAuthFile) : undefined);

  registerHabitRoutes(app, svc);
  const focus = registerFocusRoutes(app, svc);
  registerCountdownRoutes(app, svc);
  registerMatrixRoutes(app, svc);
  registerStatsRoutes(app, svc, focus);
  registerAttachmentRoutes(app, svc, opts.dataDir, activity);
  const ai = registerAiRoutes(app, svc, opts.ai, opts.aiDeps);
  const comments = registerCommentRoutes(app, svc, activity, tenant?.onComment ? { onCreate: (t, c) => tenant.onComment!(svc, t, c) } : {});
  const templates = registerTemplateRoutes(app, svc, activity);
  registerActivityRoutes(app, activity);
  const reminders = registerReminderRoutes(app, svc, activity, vapid, opts.pushAgent);
  const backup = registerBackupRoutes(app, svc, activity, {
    ...(opts.noAuth !== undefined ? { noAuth: opts.noAuth } : {}),
    ...(opts.auth !== undefined ? { auth: opts.auth } : {}),
    ...(tenant?.verifyPassword ? { noAuth: false, verify: (pw: string) => tenant.verifyPassword!(pw) } : {}),
  });
  const calendar = registerCalendarRoutes(app, svc, {
    ...(calendarOAuth ? { oauth: calendarOAuth } : {}),
    ...(opts.calendarFetch ? { fetch: opts.calendarFetch } : {}),
  });
  return { app, svc, store, activity, comments, templates, reminders, backup, calendar, ai, routes };
}
