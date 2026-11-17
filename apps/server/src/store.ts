import { chmodSync } from "node:fs";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType, StatementSync } from "node:sqlite";
import type { Loose, Task } from "@noortasks/core";

// node:sqlite is loaded at runtime: vite (vitest) strips the "node:" prefix of static imports and fails.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSyncType;

const SCHEMA = `
create table if not exists meta (k text primary key, v text not null);
create table if not exists docs (name text primary key, file text, json text not null);
create table if not exists blobs (relpath text primary key, json text not null);
create table if not exists tasks (
  id text primary key, projectId text not null, status integer not null, deleted integer not null default 0,
  completedTime text, modifiedTime text, etag text, parentId text, pos integer not null,
  seq integer not null, createSeq integer not null, json text not null
);
create index if not exists tasks_project on tasks(projectId);
create index if not exists tasks_state on tasks(deleted, status);
create index if not exists tasks_seq on tasks(seq);
create index if not exists tasks_parent on tasks(parentId);
create table if not exists projects (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists project_groups (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists filters (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists tags (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists columns (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists templates (id text primary key, kind text not null, pos integer not null, json text not null);
create table if not exists tombstones (kind text not null, id text not null, extra text, seq integer not null, primary key (kind, id));
create index if not exists tombstones_seq on tombstones(seq);
create table if not exists order_scopes (family text not null, typeKey text not null, scope text not null, pos integer not null, primary key (family, typeKey, scope));
create table if not exists orders (
  family text not null, typeKey text not null, scope text not null, bucket text not null,
  pos integer not null, itemId text not null, seq integer not null, json text not null,
  primary key (family, typeKey, scope, bucket, pos)
);
create index if not exists orders_item on orders(family, typeKey, scope, bucket, itemId);
create index if not exists orders_seq on orders(seq);
create table if not exists attachments (
  id text primary key, taskId text not null, projectId text not null, taskSet text, fileName text, size integer,
  type text, path text, refId text, state text not null, file text, json text
);
create index if not exists attachments_task on attachments(taskId);
create index if not exists attachments_path on attachments(path);
create table if not exists sessions (hash text primary key, expires integer not null);
create table if not exists habits (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists habit_sections (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists countdowns (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists timers (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists habit_checkins (id text primary key, habitId text not null, stamp integer not null, seq integer not null, json text not null);
create unique index if not exists habit_checkins_day on habit_checkins(habitId, stamp);
create table if not exists habit_records (id text primary key, habitId text not null, stamp integer not null, seq integer not null, json text not null);
create index if not exists habit_records_habit on habit_records(habitId, stamp);
create table if not exists pomodoros (id text primary key, type integer not null, startMs integer not null, endMs integer not null, seq integer not null, createSeq integer not null, json text not null);
create index if not exists pomodoros_start on pomodoros(startMs);
create index if not exists pomodoros_seq on pomodoros(seq);
create table if not exists focus_ops (n integer primary key autoincrement, id text not null unique, deviceId text, sessionId text not null, opTime integer not null, seq integer not null, json text not null);
create table if not exists comments (id text primary key, taskId text not null, projectId text not null, createdTime text not null, json text not null);
create index if not exists comments_task on comments(taskId, createdTime);
create table if not exists activities (id text primary key, taskId text, projectId text not null, action text not null, whenMs integer not null, json text not null);
create index if not exists activities_task on activities(taskId, whenMs);
create index if not exists activities_project on activities(projectId, whenMs);
create index if not exists activities_action on activities(action);
create table if not exists notifications (id text primary key, category text, unread integer not null default 1, whenMs integer not null, json text not null);
create index if not exists notifications_unread on notifications(unread, category, whenMs);
create table if not exists push_subscriptions (id text primary key, pushToken text not null unique, osType integer not null default 0, version integer not null default 1, updatedMs integer not null, json text not null);
create table if not exists reminder_acks (key text primary key, ackMs integer not null);
create table if not exists reminder_deliveries (key text primary key, sentMs integer not null);
create table if not exists project_templates (id text primary key, pos integer not null, seq integer not null, deleted integer not null default 0, json text not null);
create table if not exists matrix_profiles (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists calendar_subscriptions (id text primary key, pos integer not null, seq integer not null, createSeq integer not null, json text not null);
create table if not exists calendar_feed_cache (
  subId text primary key, url text not null, etag text, lastModified text, body text,
  fetchedAtMs integer not null, lastStatus integer, lastError text
);
create table if not exists calendar_accounts (id text primary key, provider text not null, pos integer not null, seq integer not null, json text not null);
create table if not exists calendar_oauth_states (state text primary key, provider text not null, codeVerifier text, redirectUri text, redirectAfter text, createdAtMs integer not null);
create table if not exists calendar_project_bindings (id text primary key, accountId text not null, calendarId text not null, json text not null);
create index if not exists calendar_bindings_account on calendar_project_bindings(accountId);
create table if not exists calendar_event_task_links (
  id text primary key, bindingId text not null, accountId text not null, calendarId text not null,
  externalEventId text not null, taskId text not null, externalEtag text, taskEtag text, lastSyncedMs integer not null,
  unique(accountId, calendarId, externalEventId), unique(taskId)
);
create table if not exists calendar_account_cache (
  cacheKey text primary key, accountId text not null, calendarId text not null,
  windowFromMs integer not null, windowToMs integer not null, fetchedAtMs integer not null, lastError text, json text not null
);
create table if not exists calendar_archived_events (id text primary key, json text not null);
`;

export type CollName = "projects" | "project_groups" | "filters" | "tags" | "columns" | "habits" | "habit_sections" | "countdowns" | "timers" | "matrix_profiles" | "calendar_subscriptions";

export interface TaskRow {
  id: string;
  projectId: string;
  status: number;
  deleted: number;
  completedTime: string | null;
  modifiedTime: string | null;
  etag: string | null;
  parentId: string | null;
  pos: number;
  seq: number;
  createSeq: number;
  json: string;
}

/**
 * Process-wide change stamp. Every store (one per account, plus the system store) allocates from it, so one
 * checkpoint orders changes across stores: a member's delta can merge the owner's shared lists with its own.
 */
export const globalSeq = {
  last: 0,
  observe(v: number): void {
    if (v > this.last) this.last = v;
  },
  next(floor = 0): number {
    const n = Math.max(Date.now(), this.last + 1, floor + 1);
    this.last = n;
    return n;
  },
};

export class Store {
  readonly db: Db;
  private depth = 0;
  private curSeq: number | undefined;
  private stmts = new Map<string, StatementSync>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma foreign_keys = off;");
    this.db.exec(SCHEMA);
    globalSeq.observe(this.lastSeq());
  }

  close(): void {
    this.db.close();
  }

  prep(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  all<T = Loose>(sql: string, ...args: Array<string | number | null>): T[] {
    return this.prep(sql).all(...args) as T[];
  }
  get<T = Loose>(sql: string, ...args: Array<string | number | null>): T | undefined {
    return this.prep(sql).get(...args) as T | undefined;
  }
  run(sql: string, ...args: Array<string | number | null>): void {
    this.prep(sql).run(...args);
  }

  /** One transaction; rolls back on throw. Re-entrant. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("begin immediate");
    this.depth = 1;
    this.curSeq = undefined;
    try {
      const out = fn();
      this.db.exec("commit");
      return out;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    } finally {
      this.depth = 0;
      this.curSeq = undefined;
    }
  }

  // ---- meta ----
  getMeta(k: string): string | undefined {
    return this.get<{ v: string }>("select v from meta where k = ?", k)?.v;
  }
  setMeta(k: string, v: string): void {
    this.run("insert into meta(k, v) values (?, ?) on conflict(k) do update set v = excluded.v", k, v);
  }
  getMetaJson<T>(k: string): T | undefined {
    const v = this.getMeta(k);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  setMetaJson(k: string, v: unknown): void {
    this.setMeta(k, JSON.stringify(v));
  }

  // ---- change counter (checkPoint is epoch ms, strictly increasing) ----
  lastSeq(): number {
    return Number(this.getMeta("seq") ?? 0);
  }
  /** The stamp of the current transaction; allocated lazily on first write. */
  seq(): number {
    if (this.curSeq === undefined) {
      const next = globalSeq.next(this.lastSeq());
      this.setMeta("seq", String(next));
      this.curSeq = next;
    }
    return this.curSeq;
  }

  // ---- docs (singleton documents: preferences, profile, status ...) ----
  getDoc<T = unknown>(name: string): { file: string | null; json: T } | undefined {
    const r = this.get<{ file: string | null; json: string }>("select file, json from docs where name = ?", name);
    return r ? { file: r.file, json: JSON.parse(r.json) as T } : undefined;
  }
  putDoc(name: string, json: unknown, file?: string | null): void {
    const prev = this.get<{ file: string | null }>("select file from docs where name = ?", name);
    this.run(
      "insert into docs(name, file, json) values (?, ?, ?) on conflict(name) do update set file = excluded.file, json = excluded.json",
      name,
      file === undefined ? (prev?.file ?? null) : file,
      JSON.stringify(json),
    );
  }

  // ---- tasks ----
  nextPos(table: string): number {
    return (this.get<{ m: number | null }>(`select max(pos) as m from ${table}`)?.m ?? 0) + 1;
  }

  getTaskRow(id: string): TaskRow | undefined {
    return this.get<TaskRow>("select * from tasks where id = ?", id);
  }
  getTask(id: string): Task | undefined {
    const r = this.getTaskRow(id);
    return r ? (JSON.parse(r.json) as Task) : undefined;
  }

  /** Insert or replace a task. Derived columns are copies of the object; the JSON is the truth. */
  putTask(task: Task, opts: { seq: number; pos?: number; createSeq?: number } = { seq: this.seq() }): void {
    const prev = this.getTaskRow(task.id);
    const pos = opts.pos ?? prev?.pos ?? this.nextPos("tasks");
    const createSeq = prev?.createSeq ?? opts.createSeq ?? opts.seq;
    this.run(
      `insert into tasks(id, projectId, status, deleted, completedTime, modifiedTime, etag, parentId, pos, seq, createSeq, json)
       values (?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set projectId=excluded.projectId, status=excluded.status, deleted=excluded.deleted,
         completedTime=excluded.completedTime, modifiedTime=excluded.modifiedTime, etag=excluded.etag,
         parentId=excluded.parentId, pos=excluded.pos, seq=excluded.seq, createSeq=excluded.createSeq, json=excluded.json`,
      task.id,
      task.projectId,
      typeof task.status === "number" ? task.status : 0,
      typeof task.deleted === "number" ? task.deleted : 0,
      typeof task.completedTime === "string" ? task.completedTime : null,
      typeof task.modifiedTime === "string" ? task.modifiedTime : null,
      typeof task.etag === "string" ? task.etag : null,
      typeof task.parentId === "string" ? task.parentId : null,
      pos,
      opts.seq,
      createSeq,
      JSON.stringify(task),
    );
  }

  deleteTaskRow(id: string): void {
    this.run("delete from tasks where id = ?", id);
  }

  tasksOfProject(projectId: string, deleted = 0): Task[] {
    return this.all<{ json: string }>("select json from tasks where projectId = ? and deleted = ? order by pos", projectId, deleted).map(
      (r) => JSON.parse(r.json) as Task,
    );
  }
  childrenOf(parentId: string): TaskRow[] {
    return this.all<TaskRow>("select * from tasks where parentId = ? order by pos", parentId);
  }

  // ---- generic id-keyed collections ----
  collGet<T = Loose>(table: CollName, id: string): T | undefined {
    const r = this.get<{ json: string }>(`select json from ${table} where id = ?`, id);
    return r ? (JSON.parse(r.json) as T) : undefined;
  }
  collAll<T = Loose>(table: CollName): T[] {
    return this.all<{ json: string }>(`select json from ${table} order by pos`).map((r) => JSON.parse(r.json) as T);
  }
  collChanged<T = Loose>(table: CollName, since: number): T[] {
    return this.all<{ json: string }>(`select json from ${table} where seq > ? order by pos`, since).map((r) => JSON.parse(r.json) as T);
  }
  collCount(table: CollName): number {
    return this.get<{ n: number }>(`select count(*) as n from ${table}`)!.n;
  }
  collCreatedSince(table: CollName, id: string): number | undefined {
    return this.get<{ createSeq: number }>(`select createSeq from ${table} where id = ?`, id)?.createSeq;
  }
  collPut(table: CollName, id: string, obj: Loose, opts: { seq: number; pos?: number } = { seq: this.seq() }): void {
    const prev = this.get<{ pos: number; createSeq: number }>(`select pos, createSeq from ${table} where id = ?`, id);
    this.run(
      `insert into ${table}(id, pos, seq, createSeq, json) values (?,?,?,?,?)
       on conflict(id) do update set pos=excluded.pos, seq=excluded.seq, createSeq=excluded.createSeq, json=excluded.json`,
      id,
      opts.pos ?? prev?.pos ?? this.nextPos(table),
      opts.seq,
      prev?.createSeq ?? opts.seq,
      JSON.stringify(obj),
    );
  }
  collDelete(table: CollName, id: string): void {
    this.run(`delete from ${table} where id = ?`, id);
  }

  // ---- tombstones ----
  addTombstone(kind: string, id: string, extra?: unknown): void {
    this.run(
      "insert into tombstones(kind, id, extra, seq) values (?,?,?,?) on conflict(kind, id) do update set extra=excluded.extra, seq=excluded.seq",
      kind,
      id,
      extra === undefined ? null : JSON.stringify(extra),
      this.seq(),
    );
  }
  clearTombstone(kind: string, id: string): void {
    this.run("delete from tombstones where kind = ? and id = ?", kind, id);
  }
  tombstonesSince(kind: string, since: number): Array<{ id: string; extra: Loose | null }> {
    return this.all<{ id: string; extra: string | null }>("select id, extra from tombstones where kind = ? and seq > ? order by seq", kind, since).map(
      (r) => ({ id: r.id, extra: r.extra ? (JSON.parse(r.extra) as Loose) : null }),
    );
  }
}
