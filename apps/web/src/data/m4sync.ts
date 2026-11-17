import { stripLocal, withSyncBase } from "./fieldSync";
import type { BatchResponse } from "../lib/core";
import type { Table } from "dexie";
import { HttpError } from "./api";
import type { NoorDb, Op } from "./db";
import type { Checkin, FocusRecord } from "./m4types";

/**
 * M4 entities travel outside batch/check (M4-ASSUMPTIONS "Sync"): each has its own `{add, update, delete}` batch
 * endpoint and its own read. Habits, sections, check-ins, habit logs, timers and countdowns are read in full and
 * replace the local table (deletes are never reported by a delta); focus records use the `/pomodoro/record/{cp}`
 * delta with `deleted: 1` tombstones. Rows with a pending local op win until they are pushed.
 */
export type M4Entity = "habit" | "habitSection" | "checkin" | "habitRecord" | "pomodoro" | "timing" | "timer" | "countdown";

interface EntityConf {
  table: (db: NoorDb) => Table<{ id: string }, string>;
  path: string;
}

export const M4_ENTITIES: Record<M4Entity, EntityConf> = {
  habit: { table: (db) => db.habits, path: "/api/v2/habits/batch" },
  habitSection: { table: (db) => db.habitSections, path: "/api/v2/habitSections/batch" },
  checkin: { table: (db) => db.checkins, path: "/api/v2/habitCheckins/batch" },
  habitRecord: { table: (db) => db.habitRecords, path: "/api/v2/habitRecords" },
  pomodoro: { table: (db) => db.pomos, path: "/api/v2/batch/pomodoro" },
  timing: { table: (db) => db.pomos, path: "/api/v2/batch/pomodoro/timing" },
  timer: { table: (db) => db.timers, path: "/api/v2/timer" },
  countdown: { table: (db) => db.countdowns, path: "/api/v2/countdown/batch" },
};

export const m4PendingKey = (id: string): string => `m4:${id}`;

interface Poster {
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
}

/** counters are server owned (M4-ASSUMPTIONS "Habits") */
const HABIT_SERVER_FIELDS = ["totalCheckIns", "currentStreak", "maxStreak"];

/**
 * Push a run of m4 / m4Delete ops in outbox order: consecutive ops of one entity share a request, and a change of
 * entity starts a new one, so a habit added before its check-in reaches the server first. A check-in or log refused
 * with habit_not_exist while its habit is still known locally is queued again behind a fresh habit upsert.
 */
export async function sendM4(db: NoorDb, api: Poster, run: Op[], requeue?: (kind: "m4", key: string, payload: Record<string, unknown>) => Promise<void>): Promise<void> {
  const segments: Array<{ ent: M4Entity; ops: Op[] }> = [];
  for (const o of run) {
    const ent = o.payload.entity as M4Entity;
    if (!M4_ENTITIES[ent]) continue;
    const last = segments[segments.length - 1];
    if (last && last.ent === ent) last.ops.push(o);
    else segments.push({ ent, ops: [o] });
  }
  for (const seg of segments) await sendSegment(db, api, seg.ent, seg.ops, requeue);
}

async function sendSegment(db: NoorDb, api: Poster, ent: M4Entity, ops: Op[], requeue?: (kind: "m4", key: string, payload: Record<string, unknown>) => Promise<void>): Promise<void> {
  const conf = M4_ENTITIES[ent];
  const b = { add: [] as Record<string, unknown>[], update: [] as Record<string, unknown>[], del: [] as string[] };
  for (const o of ops) {
    if (o.kind === "m4Delete") {
      b.del.push(o.key);
      continue;
    }
    const row = await conf.table(db).get(o.key);
    if (!row) continue;
    const out = { ...(o.payload.wire ?? stripLocal(row)) } as Record<string, unknown>;
    if (ent === "habit" && !o.payload.add) for (const k of HABIT_SERVER_FIELDS) delete out[k];
    (o.payload.add ? b.add : b.update).push(out);
  }
  if (!b.add.length && !b.update.length && !b.del.length) return;
  const res = await api.post<BatchResponse>(conf.path, { add: b.add, update: b.update, delete: b.del });
  const err = res?.id2error ?? {};
  const retryUpd = b.add.filter((r) => err[r.id as string] === "EXISTED");
  const retryAdd = b.update.filter((r) => !r._sync && err[r.id as string] === "NOT_EXISTED");
  if (retryUpd.length || retryAdd.length) {
    const r2 = await api.post<BatchResponse>(conf.path, { add: retryAdd, update: retryUpd, delete: [] });
    await applyEtags(conf.table(db), r2);
  }
  // a check-in for a day that already has one on the server (another device): adopt the server id, then update
  if (ent === "checkin") {
    for (const r of [...b.add, ...b.update]) {
      if (err[r.id as string] !== "DuplicateCheckinException") continue;
      const c = r as unknown as Checkin;
      const q = await api.post<{ checkins: Record<string, Checkin[]> }>("/api/v2/habitCheckins/query", { habitIds: [c.habitId], afterStamp: c.checkinStamp });
      const theirs = (q?.checkins?.[c.habitId] ?? []).find((x) => x.checkinStamp === c.checkinStamp);
      if (!theirs) continue;
      const merged = { ...c, id: theirs.id };
      await db.checkins.delete(c.id);
      await db.checkins.put(merged);
      const r3 = await api.post<BatchResponse>(conf.path, { add: [], update: [merged], delete: [] });
      await applyEtags(db.checkins as never, r3);
    }
  }
  if ((ent === "checkin" || ent === "habitRecord") && requeue) {
    for (const r of [...b.add, ...b.update]) {
      if (err[r.id as string] !== "habit_not_exist") continue;
      const habitId = String(r.habitId);
      if (!(await db.habits.get(habitId))) continue; // the habit is gone here too: let the row go
      await requeue("m4", habitId, { entity: "habit", add: true });
      await requeue("m4", String(r.id), { entity: ent, add: true });
    }
  }
  await applyEtags(conf.table(db), res);
}

async function applyEtags(table: Table<{ id: string }, string>, res: BatchResponse | undefined): Promise<void> {
  for (const [id, etag] of Object.entries(res?.id2etag ?? {})) await table.update(id, { etag } as never);
}

/** Push coalesced preference objects (pomodoro, habit). */
export async function sendPrefs(api: Poster, run: Op[]): Promise<void> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const o of run) merged.set(o.key, { ...(merged.get(o.key) ?? {}), ...o.payload });
  for (const [name, body] of merged) await api.put(`/api/v2/user/preferences/${name}${name === "habit" ? "?platform=web" : ""}`, body);
}

interface Plan<T> {
  table: Table<T, string>;
  put: T[];
  del: string[];
}
/**
 * Diff a server list against the local table outside any transaction: only changed rows are written later, so the
 * write transaction (which also holds the outbox) stays short and local edits are not kept waiting.
 */
async function planReplace<T extends { id: string }>(table: Table<T, string>, rows: T[]): Promise<Plan<T>> {
  const local = new Map((await table.toArray()).map((r) => [r.id, (r as Record<string, unknown>)._syncBase ? JSON.stringify(stripLocal(r)) : null]));
  const keep = new Set(rows.map((r) => r.id));
  return { table, put: rows.filter((r) => local.get(r.id) !== JSON.stringify(r)), del: [...local.keys()].filter((id) => !keep.has(id)) };
}
async function applyPlan<T extends { id: string }>(p: Plan<T>, pending: Set<string>): Promise<void> {
  const put = p.put.filter((r) => !pending.has(m4PendingKey(r.id)));
  if (put.length) await p.table.bulkPut(put.map(withSyncBase));
  const del = p.del.filter((id) => !pending.has(m4PendingKey(id)));
  if (del.length) await p.table.bulkDelete(del);
}

/** Read every M4 collection. `pending` = keys of rows with a local op. */
export async function pullM4(db: NoorDb, api: Poster, pendingNow: () => Promise<Set<string>>, force = false): Promise<void> {
  const safe = async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError) return undefined;
      throw e;
    }
  };
  // only the switched-on features are read (Settings > Features): with all three off a sync costs nothing extra
  const st = await db.getKV<{ tabBars?: Array<{ name: string; enabled?: boolean }>; enableCountdown?: boolean } | null>("settings", null);
  const on = (n: string): boolean => !!st?.tabBars?.some((b) => b.name === n && b.enabled);
  const H = on("HABIT") || force;
  const F = on("POMO") || force;
  const C = !!st?.enableCountdown || force;
  const skip = async (): Promise<undefined> => undefined;
  const [habits, sections, checkins, records, timers, countdowns, pomoPrefs, habitPrefs] = await Promise.all([
    H ? safe(() => api.get<unknown[]>("/api/v2/habits")) : skip(),
    H ? safe(() => api.get<unknown[]>("/api/v2/habitSections")) : skip(),
    H ? safe(() => api.post<{ checkins: Record<string, Checkin[]> }>("/api/v2/habitCheckins/query", { afterStamp: 0 })) : skip(),
    H ? safe(() => api.post<{ habitRecords: Record<string, unknown[]> }>("/api/v2/getHabitRecords", { afterStamp: 0 })) : skip(),
    F ? safe(() => api.get<unknown[]>("/api/v2/timer")) : skip(),
    C ? safe(() => api.get<unknown[]>("/api/v2/countdown/list")) : skip(),
    F ? safe(() => api.get<Record<string, unknown>>("/api/v2/user/preferences/pomodoro")) : skip(),
    H ? safe(() => api.get<Record<string, unknown>>("/api/v2/user/preferences/habit?platform=web")) : skip(),
  ]);
  const cp = await db.getKV<number>("pomoCheckPoint", 0);
  const delta = F ? await safe(() => api.get<{ checkPoint: number; pomodoroRecords: Array<FocusRecord & { deleted?: number }> | null }>(`/api/v2/pomodoro/record/${cp}`)) : undefined;
  // a first read learns which records are stopwatch records when an imported record carries no type
  const timingIds = F && cp === 0 ? new Set(((await safe(() => api.get<Array<{ id: string }>>("/api/v2/pomodoros/timing"))) ?? []).map((r) => r.id)) : null;

  const plans: Array<Plan<{ id: string }>> = [];
  const plan = async <T extends { id: string }>(table: Table<T, string>, rows: unknown): Promise<void> => {
    if (Array.isArray(rows)) plans.push((await planReplace(table, rows as T[])) as unknown as Plan<{ id: string }>);
  };
  await plan(db.habits, habits);
  await plan(db.habitSections, sections);
  if (checkins?.checkins) await plan(db.checkins, Object.values(checkins.checkins).flat());
  if (records?.habitRecords) await plan(db.habitRecords, Object.values(records.habitRecords).flat());
  await plan(db.timers, timers);
  await plan(db.countdowns, countdowns);
  const prefsNow = { pomo: await db.getKV("pomoPrefs", null), habit: await db.getKV("habitPrefs", null) };
  const nothing = plans.every((p) => !p.put.length && !p.del.length) && !delta?.pomodoroRecords?.length && JSON.stringify(prefsNow.pomo) === JSON.stringify(pomoPrefs ?? prefsNow.pomo) && JSON.stringify(prefsNow.habit) === JSON.stringify(habitPrefs ?? prefsNow.habit);
  if (nothing) {
    if (delta && delta.checkPoint !== cp) await db.setKV("pomoCheckPoint", delta.checkPoint);
    return;
  }

  await db.transaction("rw", [db.habits, db.habitSections, db.checkins, db.habitRecords, db.pomos, db.timers, db.countdowns, db.kv, db.outbox], async () => {
    const pending = await pendingNow();
    for (const p of plans) await applyPlan(p, pending);
    if (pomoPrefs && !pending.has("pref:pomodoro") && JSON.stringify(prefsNow.pomo) !== JSON.stringify(pomoPrefs)) await db.setKV("pomoPrefs", pomoPrefs);
    if (habitPrefs && !pending.has("pref:habit") && JSON.stringify(prefsNow.habit) !== JSON.stringify(habitPrefs)) await db.setKV("habitPrefs", habitPrefs);
    if (delta) {
      for (const r of delta.pomodoroRecords ?? []) {
        if (pending.has(m4PendingKey(r.id))) continue;
        if (r.deleted) await db.pomos.delete(r.id);
        else await db.pomos.put(withSyncBase({ ...r, type: typeof r.type === "number" ? r.type : timingIds?.has(r.id) ? 1 : 0 }));
      }
      await db.setKV("pomoCheckPoint", delta.checkPoint);
    }
  });
}
