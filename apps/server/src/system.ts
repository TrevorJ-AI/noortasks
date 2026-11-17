import { createHash, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { globalSeq } from "./store.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/**
 * The system database: accounts, sessions, the invite allowlist, instance settings and list shares.
 * Task data never lives here: every account has its own SQLite file (see tenants.ts).
 */
const SCHEMA = `
create table if not exists meta (k text primary key, v text not null);
create table if not exists users (
  id integer primary key, email text not null unique, name text not null default '', role text not null default 'member',
  status text not null default 'active', issuer text, subject text, passwordHash text, dbFile text not null,
  createdMs integer not null, lastLoginMs integer, collabOptOut integer not null default 0, picture text
);
create unique index if not exists users_identity on users(issuer, subject) where issuer is not null;
create table if not exists sessions (hash text primary key, userId integer not null, expires integer not null, createdMs integer not null);
create index if not exists sessions_user on sessions(userId);
create table if not exists allowlist (email text primary key, addedMs integer not null, addedBy integer, inviteHash text, inviteExpires integer);
create table if not exists settings (k text primary key, v text not null, seq integer not null);
create table if not exists shares (
  id text primary key, projectId text not null, ownerId integer not null, memberId integer not null,
  permission text not null, status text not null default 'active', createdMs integer not null, seq integer not null,
  unique(projectId, memberId)
);
create index if not exists shares_member on shares(memberId);
create index if not exists shares_owner on shares(ownerId, projectId);
create table if not exists native_login_codes (hash text primary key, userId integer not null, challenge text not null, expires integer not null);
create table if not exists oidc_states (state text primary key, verifier text not null, nonce text not null, returnTo text, createdMs integer not null);
create table if not exists pairing_tokens (hash text primary key, userId integer not null, expires integer not null, createdMs integer not null);
`;

export type Role = "admin" | "member";
export type UserStatus = "active" | "disabled" | "removed";
export type Permission = "read" | "comment" | "write";
export const PERMISSIONS: readonly Permission[] = ["read", "comment", "write"];
export const permRank = (p: Permission | "owner"): number => (p === "owner" ? 3 : PERMISSIONS.indexOf(p));

export interface UserRow {
  id: number;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  issuer: string | null;
  subject: string | null;
  passwordHash: string | null;
  dbFile: string;
  createdMs: number;
  lastLoginMs: number | null;
  collabOptOut: number;
  picture: string | null;
}

export interface ShareRow {
  id: string;
  projectId: string;
  ownerId: number;
  memberId: number;
  permission: Permission;
  /** active, or removed (revoked by the owner or left by the member); rows are kept so deltas can report the removal */
  status: "active" | "removed";
  createdMs: number;
  seq: number;
}

const SESSION_MS = 30 * 24 * 3600 * 1000;
const PAIRING_TTL_MS = 10 * 60_000;
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const normEmail = (e: string): string => e.trim().toLowerCase();

export class SystemStore {
  readonly db: DatabaseSyncType;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal;");
    this.db.exec(SCHEMA);
    globalSeq.observe(this.lastSeq());
  }
  close(): void {
    this.db.close();
  }

  all<T>(sql: string, ...a: Array<string | number | null>): T[] {
    return this.db.prepare(sql).all(...a) as T[];
  }
  get<T>(sql: string, ...a: Array<string | number | null>): T | undefined {
    return this.db.prepare(sql).get(...a) as T | undefined;
  }
  run(sql: string, ...a: Array<string | number | null>): void {
    this.db.prepare(sql).run(...a);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  getMeta(k: string): string | undefined {
    return this.get<{ v: string }>("select v from meta where k = ?", k)?.v;
  }
  setMeta(k: string, v: string): void {
    this.run("insert into meta(k, v) values (?, ?) on conflict(k) do update set v = excluded.v", k, v);
  }
  lastSeq(): number {
    return Number(this.getMeta("seq") ?? 0);
  }
  /** A change stamp from the process-wide counter (shares and settings changes are ordered with task changes). */
  seq(): number {
    const n = globalSeq.next(this.lastSeq());
    this.setMeta("seq", String(n));
    return n;
  }

  // ---- settings
  setting<T>(k: string, d: T): T {
    const r = this.get<{ v: string }>("select v from settings where k = ?", k);
    return r ? (JSON.parse(r.v) as T) : d;
  }
  settingSeq(k: string): number {
    return this.get<{ seq: number }>("select seq from settings where k = ?", k)?.seq ?? 0;
  }
  setSetting(k: string, v: unknown): void {
    this.run("insert into settings(k, v, seq) values (?,?,?) on conflict(k) do update set v = excluded.v, seq = excluded.seq", k, JSON.stringify(v), this.seq());
  }

  // ---- users
  user(id: number): UserRow | undefined {
    return this.get<UserRow>("select * from users where id = ?", id);
  }
  userByEmail(email: string): UserRow | undefined {
    return this.get<UserRow>("select * from users where email = ?", normEmail(email));
  }
  userByIdentity(issuer: string, subject: string): UserRow | undefined {
    return this.get<UserRow>("select * from users where issuer = ? and subject = ?", issuer, subject);
  }
  users(): UserRow[] {
    return this.all<UserRow>("select * from users order by createdMs, id");
  }
  /** Accounts that count against the member cap (removed accounts do not). */
  activeCount(): number {
    return this.get<{ n: number }>("select count(*) as n from users where status != 'removed'")!.n;
  }
  insertUser(u: Omit<UserRow, "lastLoginMs" | "collabOptOut" | "picture"> & { picture?: string | null }): UserRow {
    this.run(
      "insert into users(id, email, name, role, status, issuer, subject, passwordHash, dbFile, createdMs, picture) values (?,?,?,?,?,?,?,?,?,?,?)",
      u.id,
      normEmail(u.email),
      u.name,
      u.role,
      u.status,
      u.issuer,
      u.subject,
      u.passwordHash,
      u.dbFile,
      u.createdMs,
      u.picture ?? null,
    );
    return this.user(u.id)!;
  }
  updateUser(id: number, patch: Partial<Pick<UserRow, "name" | "role" | "status" | "issuer" | "subject" | "passwordHash" | "lastLoginMs" | "collabOptOut" | "picture">>): void {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      this.run(`update users set ${k} = ? where id = ?`, v as string | number | null, id);
    }
  }

  // ---- sessions (token hashed at rest, like the single-user store)
  createSession(userId: number): string {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    this.run("delete from sessions where expires < ?", now);
    this.run("insert into sessions(hash, userId, expires, createdMs) values (?,?,?,?)", sha256(token), userId, now + SESSION_MS, now);
    return token;
  }
  sessionUser(token: string | undefined): UserRow | undefined {
    if (!token) return undefined;
    const s = this.get<{ userId: number; expires: number }>("select userId, expires from sessions where hash = ?", sha256(token));
    if (!s || s.expires <= Date.now()) return undefined;
    const u = this.user(s.userId);
    // a disabled or removed member is signed out on the next request
    return u && u.status === "active" ? u : undefined;
  }
  destroySession(token: string | undefined): void {
    if (token) this.run("delete from sessions where hash = ?", sha256(token));
  }
  destroyUserSessions(userId: number): void {
    this.run("delete from sessions where userId = ?", userId);
    this.run("delete from pairing_tokens where userId = ?", userId);
    this.run("delete from native_login_codes where userId = ?", userId);
  }

  // ---- allowlist
  allowed(email: string): boolean {
    return !!this.get("select 1 from allowlist where email = ?", normEmail(email));
  }
  allowlist(): Array<{ email: string; addedMs: number; hasInvite: number }> {
    return this.all("select email, addedMs, (inviteHash is not null and inviteExpires > ?) as hasInvite from allowlist order by addedMs", Date.now());
  }
  allow(email: string, by: number | null): void {
    this.run("insert into allowlist(email, addedMs, addedBy) values (?,?,?) on conflict(email) do nothing", normEmail(email), Date.now(), by);
  }
  disallow(email: string): void {
    this.run("delete from allowlist where email = ?", normEmail(email));
  }
  /** One-time invite code for password sign-up (password mode only). Returns the plain code once. */
  issueInvite(email: string): string {
    const code = randomBytes(18).toString("base64url");
    this.run("update allowlist set inviteHash = ?, inviteExpires = ? where email = ?", sha256(code), Date.now() + 7 * 24 * 3600 * 1000, normEmail(email));
    return code;
  }
  validInvite(email: string, code: string): boolean {
    const r = this.get<{ inviteHash: string | null; inviteExpires: number | null }>("select inviteHash, inviteExpires from allowlist where email = ?", normEmail(email));
    if (!r?.inviteHash || !r.inviteExpires || r.inviteExpires < Date.now() || r.inviteHash !== sha256(code)) return false;
    return true;
  }
  consumeInvite(email: string, code: string): boolean {
    if (!this.validInvite(email, code)) return false;
    this.run("update allowlist set inviteHash = null, inviteExpires = null where email = ?", normEmail(email));
    return true;
  }

  // ---- shares
  share(id: string): ShareRow | undefined {
    return this.get<ShareRow>("select * from shares where id = ?", id);
  }
  shareFor(projectId: string, memberId: number): ShareRow | undefined {
    return this.get<ShareRow>("select * from shares where projectId = ? and memberId = ?", projectId, memberId);
  }
  sharesOfProject(projectId: string, includeRemoved = false): ShareRow[] {
    return this.all<ShareRow>(`select * from shares where projectId = ? ${includeRemoved ? "" : "and status = 'active'"} order by createdMs`, projectId);
  }
  sharesOfMember(memberId: number): ShareRow[] {
    return this.all<ShareRow>("select * from shares where memberId = ? order by createdMs", memberId);
  }
  sharesOfOwner(ownerId: number): ShareRow[] {
    return this.all<ShareRow>("select * from shares where ownerId = ? order by createdMs", ownerId);
  }
  putShare(s: Omit<ShareRow, "seq">): ShareRow {
    this.run(
      `insert into shares(id, projectId, ownerId, memberId, permission, status, createdMs, seq) values (?,?,?,?,?,?,?,?)
       on conflict(projectId, memberId) do update set ownerId=excluded.ownerId, permission=excluded.permission, status=excluded.status, seq=excluded.seq`,
      s.id,
      s.projectId,
      s.ownerId,
      s.memberId,
      s.permission,
      s.status,
      s.createdMs,
      this.seq(),
    );
    return this.shareFor(s.projectId, s.memberId)!;
  }
  touchShare(id: string, patch: Partial<Pick<ShareRow, "permission" | "status" | "ownerId">>): void {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) this.run(`update shares set ${k} = ? where id = ?`, v as string | number, id);
    this.run("update shares set seq = ? where id = ?", this.seq(), id);
  }

  // App handoff: only a hash is stored, expires after 60 seconds, consumed atomically.
  createNativeLoginCode(userId: number, challenge: string): string {
    const code = randomBytes(32).toString("base64url");
    this.run("delete from native_login_codes where expires <= ?", Date.now());
    this.run("insert into native_login_codes(hash, userId, challenge, expires) values (?,?,?,?)", sha256(code), userId, challenge, Date.now() + 60_000);
    return code;
  }
  takeNativeLoginCode(code: string, challenge: string): UserRow | undefined {
    const row = this.get<{ userId: number }>(
      "delete from native_login_codes where hash = ? and challenge = ? and expires > ? returning userId",
      sha256(code), challenge, Date.now(),
    );
    return row ? this.user(row.userId) : undefined;
  }

  // ---- OIDC login transactions (state -> PKCE verifier and nonce), ten minutes
  putOidcState(state: string, verifier: string, nonce: string, returnTo: string | null): void {
    const now = Date.now();
    this.run("delete from oidc_states where createdMs < ?", now - 10 * 60_000);
    this.run("insert into oidc_states(state, verifier, nonce, returnTo, createdMs) values (?,?,?,?,?)", state, verifier, nonce, returnTo, now);
  }
  takeOidcState(state: string): { verifier: string; nonce: string; returnTo: string | null } | undefined {
    const r = this.get<{ verifier: string; nonce: string; returnTo: string | null; createdMs: number }>("select * from oidc_states where state = ?", state);
    this.run("delete from oidc_states where state = ?", state);
    if (!r || r.createdMs < Date.now() - 10 * 60_000) return undefined;
    return r;
  }

  // ---- one-time pairing tokens (10 minutes, single-use, hashed at rest)
  createPairingToken(userId: number, now = Date.now()): { token: string; expiresMs: number } {
    const token = randomBytes(32).toString("base64url");
    const expiresMs = now + PAIRING_TTL_MS;
    this.run("delete from pairing_tokens where expires <= ?", now);
    this.run("insert into pairing_tokens(hash, userId, expires, createdMs) values (?,?,?,?)", sha256(token), userId, expiresMs, now);
    return { token, expiresMs };
  }
  takePairingToken(token: string, now = Date.now()): UserRow | undefined {
    if (!token) return undefined;
    this.run("delete from pairing_tokens where expires <= ?", now);
    const row = this.get<{ userId: number }>(
      "delete from pairing_tokens where hash = ? and expires > ? returning userId",
      sha256(token),
      now,
    );
    if (!row) return undefined;
    const u = this.user(row.userId);
    return u && u.status === "active" ? u : undefined;
  }
}
