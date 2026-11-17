import { LEGACY_FIELDS, mergeUpdate } from "./fieldSync.js";
import {
  BatchError,
  CheckinStatus,
  DEFAULT_HABIT_RULE,
  HabitStatus,
  HabitType,
  addDays,
  diffDays,
  formatServerDate,
  habitStreaks,
  isPlainObject,
  isScheduled,
  isValidStamp,
  newEtag,
  parseHabitRule,
  stampOf,
  stampRange,
  type BatchResponse,
  type Loose,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import { ApiError, type Service } from "./service.js";
import { asList, batchSimple, emptyResult, numOr } from "./m4util.js";

export const NO_SECTION = "-1";

function habitAnchor(h: Loose, createdMs: number, tz: string): number {
  const t = h.targetStartDate;
  if (typeof t === "number" && isValidStamp(t)) return t;
  const c = typeof h.createdTime === "string" ? Date.parse(h.createdTime.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : NaN;
  return stampOf(Number.isNaN(c) ? createdMs : c, tz);
}

export class HabitService {
  constructor(private svc: Service) {}
  private get store() {
    return this.svc.store;
  }

  today(): number {
    return stampOf(this.svc.now(), this.svc.userCtx().tz);
  }

  listHabits(): Loose[] {
    return this.store.collAll<Loose>("habits");
  }
  listSections(): Loose[] {
    return this.store.collAll<Loose>("habit_sections");
  }

  private normalizeHabit(o: Loose, ctx: { now: string }, isNew: boolean): string | void {
    if (typeof o.name !== "string") o.name = typeof o.name === "number" ? String(o.name) : "";
    if (isNew) {
      o.iconRes ??= "habit_daily_check_in";
      o.type ??= HabitType.Boolean;
      o.unit ??= "Count";
      o.repeatRule ??= DEFAULT_HABIT_RULE;
      o.sectionId ??= NO_SECTION;
      o.style ??= 1;
      o.status ??= HabitStatus.Normal;
      o.step ??= 1;
      o.reminders ??= [];
      o.encouragement ??= "";
      o.recordEnable ??= false;
      o.targetDays ??= 0;
      o.completedCycles ??= 0;
      o.exDates ??= [];
      o.userId ??= this.svc.userId;
      o.totalCheckIns ??= 0;
      o.currentStreak ??= 0;
      o.maxStreak ??= 0;
      if (o.sortOrder === undefined) o.sortOrder = (this.store.get<{ m: number | null }>("select max(pos) as m from habits")?.m ?? 0) + 1;
    }
    if (typeof o.status === "number" && o.status !== HabitStatus.Normal && o.status !== HabitStatus.Archived) return BatchError.Unknown;
    if (o.type === HabitType.Boolean || o.type === undefined) o.goal = 1;
    else if (typeof o.goal !== "number" || !(o.goal > 0)) o.goal = 1;
    if (typeof o.repeatRule === "string" && o.repeatRule) {
      const r = parseHabitRule(o.repeatRule);
      void r; // unparsable legacy rules fall back to daily at read time; the raw string is preserved as sent
    }
    void ctx;
  }

  batchHabits(body: unknown): BatchResponse {
    const touched = new Set<string>();
    const res = batchSimple(this.svc, "habits", body, {
      keep: ["totalCheckIns", "currentStreak", "maxStreak"],
      add: (o, ctx) => {
        const err = this.normalizeHabit(o, ctx, true);
        if (err) return err;
        if (o.status === HabitStatus.Archived) o.archivedTime ??= ctx.now;
        touched.add(o.id as string);
      },
      update: (o, old, ctx) => {
        const err = this.normalizeHabit(o, ctx, false);
        if (err) return err;
        if (o.status === HabitStatus.Archived && old.status !== HabitStatus.Archived) o.archivedTime = ctx.now;
        if (o.status === HabitStatus.Normal && old.status === HabitStatus.Archived) o.archivedTime = null;
        touched.add(o.id as string);
      },
      del: (id) => {
        this.store.run("delete from habit_checkins where habitId = ?", id);
        this.store.run("delete from habit_records where habitId = ?", id);
      },
      after: (ctx) => {
        for (const id of touched) this.recompute(id, ctx.seq);
      },
    });
    return res;
  }

  private counters(h: Loose): { totalCheckIns: number; currentStreak: number; maxStreak: number } {
    const { tz, weekStart } = this.svc.userCtx();
    const done = this.store
      .all<{ stamp: number; json: string }>("select stamp, json from habit_checkins where habitId = ?", h.id as string)
      .filter((r) => (JSON.parse(r.json) as Loose).status === CheckinStatus.Done)
      .map((r) => r.stamp);
    const anchor = Math.min(habitAnchor(h, this.svc.now(), tz), ...(done.length ? [Math.min(...done)] : []));
    if (diffDays(anchor, stampOf(this.svc.now(), tz)) > 36_600) throw new ApiError(400, "habit_history_too_large");
    return habitStreaks({
      rule: parseHabitRule(h.repeatRule),
      anchor,
      exDates: h.exDates,
      done,
      today: stampOf(this.svc.now(), tz),
      weekStart,
    });
  }

  /** Recompute the stored counters of a habit from its check-ins. Does not touch etag or modifiedTime. */
  recompute(habitId: string, seq: number): void {
    const h = this.store.collGet<Loose>("habits", habitId);
    if (!h) return;
    const r = this.counters(h);
    if (h.totalCheckIns === r.totalCheckIns && h.currentStreak === r.currentStreak && h.maxStreak === r.maxStreak) return;
    this.store.collPut("habits", habitId, { ...h, ...r }, { seq });
  }

  /** Streaks depend on "today": a read refreshes counters that moved with the calendar (writes only when something changed). */
  refreshAll(): void {
    const stale = this.listHabits().filter((h) => {
      const r = this.counters(h);
      return h.totalCheckIns !== r.totalCheckIns || h.currentStreak !== r.currentStreak || h.maxStreak !== r.maxStreak;
    });
    if (stale.length === 0) return;
    this.store.tx(() => {
      const seq = this.store.seq();
      for (const h of stale) this.recompute(h.id as string, seq);
    });
  }

  // ---------------------------------------------------------------- sections
  batchSections(body: unknown): BatchResponse {
    return batchSimple(this.svc, "habit_sections", body, {
      add: (o) => {
        if (typeof o.name !== "string") o.name = "";
        if (o.sortOrder === undefined) o.sortOrder = (this.store.get<{ m: number | null }>("select max(pos) as m from habit_sections")?.m ?? 0) + 1;
      },
      del: (id, _old, ctx) => {
        for (const h of this.listHabits().filter((x) => x.sectionId === id)) this.store.collPut("habits", h.id as string, { ...h, sectionId: NO_SECTION, etag: newEtag(), modifiedTime: ctx.now }, { seq: ctx.seq });
      },
    });
  }

  // ---------------------------------------------------------------- check-ins
  checkinsOf(habitId: string, afterStamp = 0): Loose[] {
    return this.store
      .all<{ json: string }>("select json from habit_checkins where habitId = ? and stamp >= ? order by stamp", habitId, afterStamp)
      .map((r) => JSON.parse(r.json) as Loose);
  }

  queryCheckins(body: unknown): { checkins: Record<string, Loose[]> } {
    const b = isPlainObject(body) ? body : {};
    const after = numOr(b.afterStamp, 0);
    const ids = Array.isArray(b.habitIds) ? b.habitIds.filter((x): x is string => typeof x === "string") : this.listHabits().map((h) => h.id as string);
    const out: Record<string, Loose[]> = {};
    for (const id of ids) out[id] = this.checkinsOf(id, after);
    return { checkins: out };
  }

  batchCheckins(body: unknown): BatchResponse {
    const res = emptyResult();
    const b = isPlainObject(body) ? body : {};
    const store = this.store;
    const touched = new Set<string>();
    store.tx(() => {
      const seq = store.seq();
      const nowMs = this.svc.now();
      const now = formatServerDate(nowMs);
      const { tz } = this.svc.userCtx();
      const latest = addDays(stampOf(nowMs, tz), 1);
      const normalize = (o: Loose, habit: Loose): void => {
        const goal = typeof habit.goal === "number" ? habit.goal : 1;
        if (typeof o.goal !== "number") o.goal = goal;
        if (typeof o.value !== "number") o.value = habit.type === HabitType.Real ? 0 : o.status === CheckinStatus.Done ? 1 : 0;
        if (habit.type === HabitType.Real) {
          // complete when value reaches the goal (HAB-014); a lower value is a partial day
          o.status = (o.value as number) >= (o.goal as number) ? CheckinStatus.Done : o.status === CheckinStatus.Undone ? CheckinStatus.Undone : CheckinStatus.Unlabeled;
        } else if (o.status === undefined) o.status = CheckinStatus.Done;
        if (o.checkinTime === undefined) o.checkinTime = now;
        o.opTime = now;
      };
      for (const raw of asList(b.add)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        const id = raw.id;
        const habit = typeof raw.habitId === "string" ? store.collGet<Loose>("habits", raw.habitId) : undefined;
        if (!habit) {
          res.id2error[id] = BatchError.HabitNotExist;
          continue;
        }
        if (store.get("select 1 from habit_checkins where id = ?", id)) {
          res.id2error[id] = BatchError.Existed;
          continue;
        }
        if (!isValidStamp(raw.checkinStamp) || raw.checkinStamp > latest) {
          res.id2error[id] = BatchError.Unknown;
          continue;
        }
        if (store.get("select 1 from habit_checkins where habitId = ? and stamp = ?", habit.id as string, raw.checkinStamp)) {
          res.id2error[id] = BatchError.DuplicateCheckin;
          continue;
        }
        const o: Loose = { ...raw };
        normalize(o, habit);
        o.etag = newEtag();
        store.run("insert into habit_checkins(id, habitId, stamp, seq, json) values (?,?,?,?,?)", id, habit.id as string, raw.checkinStamp, seq, JSON.stringify(o));
        res.id2etag[id] = o.etag as string;
        touched.add(habit.id as string);
      }
      for (const raw of asList(b.update)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        const id = raw.id;
        const row = store.get<{ habitId: string; stamp: number; json: string }>("select habitId, stamp, json from habit_checkins where id = ?", id);
        if (!row) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        const habit = store.collGet<Loose>("habits", row.habitId);
        if (!habit) {
          res.id2error[id] = BatchError.HabitNotExist;
          continue;
        }
        const old = JSON.parse(row.json) as Loose;
        const o: Loose = { ...mergeUpdate(old, raw, LEGACY_FIELDS.checkin), habitId: row.habitId };
        if (o.checkinStamp === undefined) o.checkinStamp = row.stamp;
        if (!isValidStamp(o.checkinStamp) || o.checkinStamp > latest) {
          res.id2error[id] = BatchError.Unknown;
          continue;
        }
        if (o.checkinStamp !== row.stamp && store.get("select 1 from habit_checkins where habitId = ? and stamp = ?", row.habitId, o.checkinStamp)) {
          res.id2error[id] = BatchError.DuplicateCheckin;
          continue;
        }
        if (o.checkinTime === undefined && old.checkinTime !== undefined) o.checkinTime = old.checkinTime;
        normalize(o, habit);
        o.etag = newEtag();
        store.run("update habit_checkins set stamp = ?, seq = ?, json = ? where id = ?", o.checkinStamp as number, seq, JSON.stringify(o), id);
        res.id2etag[id] = o.etag as string;
        touched.add(row.habitId);
      }
      for (const raw of asList(b.delete)) {
        const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
        if (!id) continue;
        const row = store.get<{ habitId: string }>("select habitId from habit_checkins where id = ?", id);
        if (!row) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        store.run("delete from habit_checkins where id = ?", id);
        touched.add(row.habitId);
      }
      for (const id of touched) this.recompute(id, seq);
    });
    return res;
  }

  // ---------------------------------------------------------------- records (per-day logs)
  recordsOf(habitId: string, afterStamp = 0): Loose[] {
    return this.store.all<{ json: string }>("select json from habit_records where habitId = ? and stamp >= ? order by stamp, id", habitId, afterStamp).map((r) => JSON.parse(r.json) as Loose);
  }
  queryRecords(body: unknown): { habitRecords: Record<string, Loose[]> } {
    const b = isPlainObject(body) ? body : {};
    const after = numOr(b.afterStamp, 0);
    const ids = Array.isArray(b.habitIds) ? b.habitIds.filter((x): x is string => typeof x === "string") : this.listHabits().map((h) => h.id as string);
    const out: Record<string, Loose[]> = {};
    for (const id of ids) out[id] = this.recordsOf(id, after);
    return { habitRecords: out };
  }
  batchRecords(body: unknown): BatchResponse {
    const res = emptyResult();
    const b = isPlainObject(body) ? body : {};
    const store = this.store;
    store.tx(() => {
      const seq = store.seq();
      const now = formatServerDate(this.svc.now());
      const stampOfRec = (o: Loose): number => (isValidStamp(o.checkinStamp) ? o.checkinStamp : isValidStamp(o.stamp) ? o.stamp : isValidStamp(o.recordStamp) ? o.recordStamp : 0);
      for (const raw of asList(b.add)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        if (typeof raw.habitId !== "string" || !store.collGet("habits", raw.habitId)) {
          res.id2error[raw.id] = BatchError.HabitNotExist;
          continue;
        }
        if (store.get("select 1 from habit_records where id = ?", raw.id)) {
          res.id2error[raw.id] = BatchError.Existed;
          continue;
        }
        const o: Loose = { ...raw, etag: newEtag(), createdTime: raw.createdTime ?? now, modifiedTime: now };
        store.run("insert into habit_records(id, habitId, stamp, seq, json) values (?,?,?,?,?)", raw.id, raw.habitId, stampOfRec(o), seq, JSON.stringify(o));
        res.id2etag[raw.id] = o.etag as string;
      }
      for (const raw of asList(b.update)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        const row = store.get<{ habitId: string; json: string }>("select habitId, json from habit_records where id = ?", raw.id);
        if (!row) {
          res.id2error[raw.id] = BatchError.NotExisted;
          continue;
        }
        const o: Loose = { ...mergeUpdate(JSON.parse(row.json) as Loose, raw, LEGACY_FIELDS.habitRecord), habitId: row.habitId, etag: newEtag(), modifiedTime: now };
        if (o.createdTime === undefined) o.createdTime = (JSON.parse(row.json) as Loose).createdTime;
        store.run("update habit_records set stamp = ?, seq = ?, json = ? where id = ?", stampOfRec(o), seq, JSON.stringify(o), raw.id);
        res.id2etag[raw.id] = o.etag as string;
      }
      for (const raw of asList(b.delete)) {
        const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
        if (!id) continue;
        if (!store.get("select 1 from habit_records where id = ?", id)) res.id2error[id] = BatchError.NotExisted;
        else store.run("delete from habit_records where id = ?", id);
      }
    });
    return res;
  }

  // ---------------------------------------------------------------- stats
  /** `GET /habits/statistics/week/current`: seven days from today, how many habits are due and how many are done. */
  weekCurrent(): Record<string, { totalHabitCount: number; completedHabitCount: number }> {
    const { tz } = this.svc.userCtx();
    const today = stampOf(this.svc.now(), tz);
    const habits = this.listHabits().filter((h) => h.status !== HabitStatus.Archived);
    const out: Record<string, { totalHabitCount: number; completedHabitCount: number }> = {};
    const days = stampRange(today, addDays(today, 6));
    const doneByHabit = new Map<string, Set<number>>();
    for (const h of habits) {
      doneByHabit.set(
        h.id as string,
        new Set(this.checkinsOf(h.id as string, today).filter((c) => c.status === CheckinStatus.Done).map((c) => c.checkinStamp as number)),
      );
    }
    for (const d of days) {
      let total = 0;
      let completed = 0;
      for (const h of habits) {
        const anchor = habitAnchor(h, this.svc.now(), tz);
        const done = doneByHabit.get(h.id as string)!.has(d);
        if (isScheduled(parseHabitRule(h.repeatRule), anchor, d, h.exDates) || done) {
          total++;
          if (done) completed++;
        }
      }
      out[String(d)] = { totalHabitCount: total, completedHabitCount: completed };
    }
    return out;
  }
}

export function registerHabitRoutes(app: FastifyInstance, svc: Service): HabitService {
  const hs = new HabitService(svc);
  app.get("/api/v2/habits", async () => {
    hs.refreshAll();
    return hs.listHabits();
  });
  app.post("/api/v2/habits/batch", async (req) => hs.batchHabits(req.body));
  app.get("/api/v2/habitSections", async () => hs.listSections());
  app.post("/api/v2/habitSections/batch", async (req) => hs.batchSections(req.body));
  app.post("/api/v2/habitCheckins/query", async (req) => {
    if (req.body !== undefined && !isPlainObject(req.body)) throw new ApiError(400, "invalid_body");
    return hs.queryCheckins(req.body);
  });
  app.post("/api/v2/habitCheckins/batch", async (req) => hs.batchCheckins(req.body));
  app.post("/api/v2/getHabitRecords", async (req) => hs.queryRecords(req.body));
  app.post("/api/v2/habitRecords", async (req) => hs.batchRecords(req.body));
  app.get("/api/v2/habits/statistics/week/current", async () => hs.weekCurrent());
  return hs;
}
