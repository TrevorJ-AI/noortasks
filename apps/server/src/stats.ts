import {
  FocusType,
  TaskStatus,
  UNKNOWN_CATEGORY,
  addDays,
  addMonths,
  dayNum,
  dayStartMs,
  diffDays,
  effectiveSlices,
  isPlainObject,
  isValidStamp,
  monthStartOf,
  parseWireDate,
  recordBindings,
  stampOf,
  stampOfDayNum,
  stampRange,
  weekStartOf,
  zonedParts,
  isValidTimeZone,
  type FocusSlice,
  type Loose,
  type Task,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import type { FocusService } from "./focus.js";
import { ApiError, type Service } from "./service.js";
import { numOr } from "./m4util.js";

/** Score thresholds of the twelve levels (assumption, see M4-ASSUMPTIONS.md). */
export const LEVEL_THRESHOLDS = [0, 100, 500, 1000, 2500, 5000, 10000, 20000, 50000, 100000, 200000, 500000] as const;
export const SCORE = { created: 1, completed: 3, onTimeBonus: 2, expired: -1 } as const;
export const MAX_RANGE_DAYS = 3660;

export function levelOf(score: number): number {
  let lvl = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) if (score >= LEVEL_THRESHOLDS[i]!) lvl = i + 1;
  return lvl;
}

interface TaskFact {
  id: string;
  projectId: string;
  projectName: string;
  tags: string[];
  status: number;
  createdStamp: number | undefined;
  completedStamp: number | undefined;
  dueStamp: number | undefined;
  /** completed: before or at the due moment (all-day tasks: on or before the due day) */
  onTime: boolean;
}

interface Counts {
  overdueCompleteCount: number;
  onTimeCompleteCount: number;
  noTimeCompleteCount: number;
  notCompleteCount: number;
  projectCompleteCounts: Record<string, number>;
  tagCompleteCounts: Record<string, number>;
}
const emptyCounts = (): Counts => ({ overdueCompleteCount: 0, onTimeCompleteCount: 0, noTimeCompleteCount: 0, notCompleteCount: 0, projectCompleteCounts: {}, tagCompleteCounts: {} });
const completeOf = (c: Counts): number => c.overdueCompleteCount + c.onTimeCompleteCount + c.noTimeCompleteCount;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const mins = (ms: number): number => ms / 60000;

export class StatsService {
  constructor(
    private svc: Service,
    private focus: FocusService,
  ) {}
  private get store() {
    return this.svc.store;
  }

  private ctx(): { tz: string; weekStart: number; nowMs: number; today: number } {
    const { tz, weekStart } = this.svc.userCtx();
    const nowMs = this.svc.now();
    return { tz, weekStart, nowMs, today: stampOf(nowMs, tz) };
  }

  private projectName(id: string): string {
    if (id === this.svc.inboxId) return "Inbox";
    const p = this.store.collGet<Loose>("projects", id);
    return typeof p?.name === "string" ? p.name : id;
  }

  private facts(tz: string): TaskFact[] {
    const out: TaskFact[] = [];
    const names = new Map<string, string>();
    for (const r of this.store.all<{ json: string }>("select json from tasks where deleted = 0")) {
      const t = JSON.parse(r.json) as Task;
      if (t.kind === "NOTE") continue;
      const ms = (v: unknown): number => (typeof v === "string" ? parseWireDate(v) : NaN);
      const created = ms(t.createdTime);
      const completed = ms(t.completedTime);
      const dueRaw = ms(t.dueDate ?? t.startDate);
      const allDay = t.isAllDay === true;
      const taskTz = allDay && !t.isFloating && isValidTimeZone(t.timeZone) ? t.timeZone : tz;
      const dueStamp = Number.isNaN(dueRaw) ? undefined : stampOf(dueRaw, allDay ? taskTz : tz);
      const completedStamp = t.status === TaskStatus.Completed && !Number.isNaN(completed) ? stampOf(completed, tz) : undefined;
      let onTime = false;
      if (completedStamp !== undefined && dueStamp !== undefined) onTime = allDay ? completedStamp <= dueStamp : completed <= dueRaw;
      let pname = names.get(t.projectId);
      if (pname === undefined) names.set(t.projectId, (pname = this.projectName(t.projectId)));
      out.push({
        id: t.id,
        projectId: t.projectId,
        projectName: pname,
        tags: Array.isArray(t.tags) ? t.tags.filter((x): x is string => typeof x === "string") : [],
        status: typeof t.status === "number" ? t.status : 0,
        createdStamp: Number.isNaN(created) ? undefined : stampOf(created, tz),
        completedStamp,
        dueStamp,
        onTime,
      });
    }
    return out;
  }

  /** Per-day completion counts for [from, to] (inclusive). */
  private dayCounts(facts: TaskFact[], from: number, to: number, today: number): Map<number, Counts> {
    const days = new Map<number, Counts>();
    for (const d of stampRange(from, to)) days.set(d, emptyCounts());
    for (const f of facts) {
      if (f.completedStamp !== undefined) {
        const c = days.get(f.completedStamp);
        if (c) {
          if (f.dueStamp === undefined) c.noTimeCompleteCount++;
          else if (f.onTime) c.onTimeCompleteCount++;
          else c.overdueCompleteCount++;
          c.projectCompleteCounts[f.projectName] = (c.projectCompleteCounts[f.projectName] ?? 0) + 1;
          for (const tag of f.tags.length ? f.tags : [UNKNOWN_CATEGORY]) c.tagCompleteCounts[tag] = (c.tagCompleteCounts[tag] ?? 0) + 1;
        }
      } else if (f.status === TaskStatus.Open && f.dueStamp !== undefined && f.dueStamp <= today) {
        const c = days.get(f.dueStamp);
        if (c) c.notCompleteCount++;
      }
    }
    return days;
  }

  private merge(into: Counts, c: Counts): void {
    into.overdueCompleteCount += c.overdueCompleteCount;
    into.onTimeCompleteCount += c.onTimeCompleteCount;
    into.noTimeCompleteCount += c.noTimeCompleteCount;
    into.notCompleteCount += c.notCompleteCount;
    for (const [k, v] of Object.entries(c.projectCompleteCounts)) into.projectCompleteCounts[k] = (into.projectCompleteCounts[k] ?? 0) + v;
    for (const [k, v] of Object.entries(c.tagCompleteCounts)) into.tagCompleteCounts[k] = (into.tagCompleteCounts[k] ?? 0) + v;
  }

  // ---------------------------------------------------------------- task statistics endpoints
  private row(day: number, c: Counts, tz: string): Loose {
    return { ...c, day: String(day), timezone: tz };
  }

  /** `GET /task/statistics/{from}/{to}`: one row per day. */
  taskRange(from: number, to: number): Loose[] {
    if (!isValidStamp(from) || !isValidStamp(to) || to < from || diffDays(from, to) > MAX_RANGE_DAYS) throw new ApiError(400, "invalid_date_range");
    const { tz, today } = this.ctx();
    const days = this.dayCounts(this.facts(tz), from, to, today);
    return [...days.entries()].map(([d, c]) => this.row(d, c, tz));
  }

  /** `week/{t}/{n}` and `month/{t}/{n}`: n periods ending with the one that contains t, one row per period (`day` = period start). */
  taskPeriods(unit: "week" | "month", t: number, n: number): Loose[] {
    if (!isValidStamp(t) || !Number.isInteger(n) || n < 1 || n > 520) throw new ApiError(400, "invalid_date_range");
    const { tz, today, weekStart } = this.ctx();
    const starts: number[] = [];
    for (let i = n - 1; i >= 0; i--) starts.push(unit === "week" ? addDays(weekStartOf(t, weekStart), -7 * i) : addMonths(monthStartOf(t), -i));
    const endOf = (s: number): number => (unit === "week" ? addDays(s, 6) : addDays(addMonths(s, 1), -1));
    const days = this.dayCounts(this.facts(tz), starts[0]!, endOf(starts[n - 1]!), today);
    return starts.map((s) => {
      const c = emptyCounts();
      for (const d of stampRange(s, endOf(s))) {
        const x = days.get(d);
        if (x) this.merge(c, x);
      }
      return this.row(s, c, tz);
    });
  }

  // ---------------------------------------------------------------- score
  private scoreSeries(facts: TaskFact[], today: number): { byDay: Map<number, number>; total: number; first: number | undefined } {
    const delta = new Map<number, number>();
    const add = (d: number | undefined, v: number): void => {
      if (d !== undefined && d <= today) delta.set(d, (delta.get(d) ?? 0) + v);
    };
    for (const f of facts) {
      add(f.createdStamp, SCORE.created);
      if (f.completedStamp !== undefined) {
        add(f.completedStamp, SCORE.completed);
        if (f.dueStamp !== undefined && f.onTime) add(f.completedStamp, SCORE.onTimeBonus);
      }
      if (f.dueStamp !== undefined) {
        const lateOrOpen = f.status === TaskStatus.Open || (f.completedStamp !== undefined && f.completedStamp > f.dueStamp);
        if (lateOrOpen) add(addDays(f.dueStamp, 1), SCORE.expired);
      }
    }
    const byDay = new Map<number, number>();
    if (delta.size === 0) return { byDay, total: 0, first: undefined };
    const first = Math.min(...delta.keys());
    const windowStart = Math.max(first, addDays(today, -MAX_RANGE_DAYS));
    let run = 0;
    // Carry older scores forward without allocating one entry per historical day.
    for (const d of [...delta.keys()].filter((d) => d < windowStart).sort((a, b) => a - b)) run = Math.max(0, run + delta.get(d)!);
    for (const d of stampRange(windowStart, today)) {
      run = Math.max(0, run + (delta.get(d) ?? 0));
      byDay.set(d, run);
    }
    return { byDay, total: run, first };
  }

  // ---------------------------------------------------------------- focus aggregates
  private slices(): FocusSlice[] {
    return effectiveSlices(this.focus.all());
  }

  private focusBuckets(slices: FocusSlice[], tz: string, weekStart: number, today: number) {
    const byDay = new Map<number, { count: number; ms: number }>();
    const byWeek = new Map<number, { count: number; ms: number }>();
    const byMonth = new Map<number, { count: number; ms: number }>();
    const bump = (m: Map<number, { count: number; ms: number }>, k: number, s: FocusSlice): void => {
      const e = m.get(k) ?? { count: 0, ms: 0 };
      if (s.type === FocusType.Pomodoro) e.count++;
      e.ms += s.activeMs;
      m.set(k, e);
    };
    for (const s of slices) {
      const d = stampOf(s.startMs, tz);
      bump(byDay, d, s);
      bump(byWeek, weekStartOf(d, weekStart), s);
      bump(byMonth, monthStartOf(d), s);
    }
    void today;
    return { byDay, byWeek, byMonth };
  }

  // ---------------------------------------------------------------- general
  general(): Loose {
    const { tz, weekStart, today } = this.ctx();
    const facts = this.facts(tz);
    const yesterday = addDays(today, -1);
    const completed = facts.filter((f) => f.completedStamp !== undefined);
    const score = this.scoreSeries(facts, today);

    const days7 = stampRange(addDays(today, -6), today);
    const dayC = this.dayCounts(facts, days7[0]!, today, today);
    const rate = (c: Counts): { completeCount: number; notCompleteCount: number } => ({ completeCount: completeOf(c), notCompleteCount: c.notCompleteCount });
    const taskByDay: Record<string, Loose> = {};
    const scoreByDay: Record<string, number> = {};
    for (const d of days7) {
      taskByDay[String(d)] = rate(dayC.get(d)!);
      scoreByDay[String(d)] = score.byDay.get(d) ?? (d < (score.first ?? today) ? 0 : (score.byDay.get(addDays(d, -1)) ?? 0));
    }
    const periodBuckets = (unit: "week" | "month"): Record<string, Loose> => {
      const out: Record<string, Loose> = {};
      const starts = Array.from({ length: 7 }, (_, i) => (unit === "week" ? addDays(weekStartOf(today, weekStart), -7 * (6 - i)) : addMonths(monthStartOf(today), -(6 - i))));
      const end = (s: number): number => (unit === "week" ? addDays(s, 6) : addDays(addMonths(s, 1), -1));
      const days = this.dayCounts(facts, starts[0]!, end(starts[6]!), today);
      for (const s of starts) {
        const c = emptyCounts();
        for (const d of stampRange(s, end(s))) {
          const x = days.get(d);
          if (x) this.merge(c, x);
        }
        out[String(s)] = rate(c);
      }
      return out;
    };

    const slices = this.slices();
    const { byDay, byWeek, byMonth } = this.focusBuckets(slices, tz, weekStart, today);
    const pomoMap = (m: Map<number, { count: number; ms: number }>, keys: number[]): Record<string, Loose> => {
      const out: Record<string, Loose> = {};
      for (const k of keys) {
        const e = m.get(k);
        if (e) out[String(k)] = { count: e.count, duration: Math.round(mins(e.ms)) };
      }
      return out;
    };
    const weekKeys = Array.from({ length: 7 }, (_, i) => addDays(weekStartOf(today, weekStart), -7 * (6 - i)));
    const monthKeys = Array.from({ length: 7 }, (_, i) => addMonths(monthStartOf(today), -(6 - i)));
    const sum = (f: (s: FocusSlice) => boolean): { count: number; ms: number } => {
      let count = 0;
      let ms = 0;
      for (const s of slices) if (f(s)) {
        if (s.type === FocusType.Pomodoro) count++;
        ms += s.activeMs;
      }
      return { count, ms };
    };
    const t = sum((s) => stampOf(s.startMs, tz) === today);
    const y = sum((s) => stampOf(s.startMs, tz) === yesterday);
    const all = sum(() => true);
    const prefs = (this.store.getDoc<Loose>("pomodoro")?.json ?? {}) as Loose;

    return {
      score: score.total,
      level: levelOf(score.total),
      yesterdayCompleted: completed.filter((f) => f.completedStamp === yesterday).length,
      todayCompleted: completed.filter((f) => f.completedStamp === today).length,
      totalCompleted: completed.length,
      todayPomoCount: t.count,
      yesterdayPomoCount: y.count,
      totalPomoCount: all.count,
      todayPomoDuration: Math.round(mins(t.ms)),
      yesterdayPomoDuration: Math.round(mins(y.ms)),
      totalPomoDuration: Math.round(mins(all.ms)),
      pomoGoal: typeof prefs.pomoGoal === "number" ? prefs.pomoGoal : 4,
      pomoDurationGoal: typeof prefs.focusDuration === "number" ? prefs.focusDuration : 0,
      scoreByDay,
      taskByDay,
      taskByWeek: periodBuckets("week"),
      taskByMonth: periodBuckets("month"),
      pomoByDay: pomoMap(byDay, days7),
      pomoByWeek: pomoMap(byWeek, weekKeys),
      pomoByMonth: pomoMap(byMonth, monthKeys),
    };
  }

  ranking(): Loose {
    const { tz, today } = this.ctx();
    const facts = this.facts(tz);
    const score = this.scoreSeries(facts, today);
    const first = facts.reduce<number | undefined>((m, f) => (f.createdStamp !== undefined && (m === undefined || f.createdStamp < m) ? f.createdStamp : m), undefined);
    return {
      ranking: 0.99,
      taskCount: facts.length,
      projectCount: this.store.collCount("projects") + 1,
      dayCount: first === undefined ? 0 : diffDays(first, today) + 1,
      completedCount: facts.filter((f) => f.completedStamp !== undefined).length,
      score: score.total,
      level: levelOf(score.total),
    };
  }

  colors(): Loose {
    const project2color: Record<string, string | null> = {};
    for (const p of this.store.collAll<Loose>("projects")) if (typeof p.name === "string") project2color[p.name] = typeof p.color === "string" ? p.color : null;
    const tag2color: Record<string, string | null> = {};
    for (const t of this.store.collAll<Loose>("tags")) if (typeof t.name === "string") tag2color[t.name] = typeof t.color === "string" ? t.color : null;
    return { project2color, tag2color };
  }

  // ---------------------------------------------------------------- focus statistics endpoints
  generalForDesktop(): Loose {
    const g = this.general();
    const { tz, today } = this.ctx();
    const slices = this.slices();
    const timing = slices.filter((s) => s.type === FocusType.Timing);
    const todayTiming = timing.filter((s) => stampOf(s.startMs, tz) === today);
    return {
      todayPomoCount: g.todayPomoCount,
      yesterdayPomoCount: g.yesterdayPomoCount,
      totalPomoCount: g.totalPomoCount,
      todayPomoDuration: g.todayPomoDuration,
      yesterdayPomoDuration: g.yesterdayPomoDuration,
      totalPomoDuration: g.totalPomoDuration,
      todayTimingCount: todayTiming.length,
      totalTimingCount: timing.length,
      pomoGoal: g.pomoGoal,
      pomoDurationGoal: g.pomoDurationGoal,
    };
  }

  private inRange(slices: FocusSlice[], from: number, to: number, tz: string): FocusSlice[] {
    if (!isValidStamp(from) || !isValidStamp(to) || to < from || diffDays(from, to) > MAX_RANGE_DAYS) throw new ApiError(400, "invalid_date_range");
    return slices.filter((s) => {
      const d = stampOf(s.startMs, tz);
      return d >= from && d <= to;
    });
  }

  /** Focus time by list, tag, task, habit and timer. A record with k bindings gives each an equal share. */
  dist(from: number, to: number): Loose {
    const { tz } = this.ctx();
    const rows = this.inRange(this.slices(), from, to, tz);
    const projectDurations: Record<string, number> = {};
    const tagDurations: Record<string, number> = {};
    const taskDurations: Record<string, Loose> = {};
    const habitDurations: Record<string, Loose> = {};
    const timerDurations: Record<string, Loose> = {};
    let unbound = 0;
    let total = 0;
    const acc = (m: Record<string, number>, k: string, v: number): void => void (m[k] = r2((m[k] ?? 0) + v));
    for (const s of rows) {
      const m = mins(s.activeMs);
      total += m;
      const binds = recordBindings(s.rec);
      if (binds.length === 0) {
        unbound += m;
        continue;
      }
      const share = m / binds.length;
      for (const b of binds) {
        const into = b.owner === 0 ? taskDurations : b.owner === 1 ? habitDurations : timerDurations;
        const cur = into[b.id] ?? { ...(b.title !== undefined ? { title: b.title } : {}), duration: 0 };
        cur.duration = r2((cur.duration as number) + share);
        into[b.id] = cur;
        if (b.owner === 0) {
          const task = this.store.getTask(b.id);
          const pid = task?.projectId ?? b.projectId;
          if (pid) acc(projectDurations, this.projectName(pid), share);
          if (task) {
            if (cur.title === undefined && typeof task.title === "string") cur.title = task.title;
            cur.projectId = task.projectId;
            for (const tag of Array.isArray(task.tags) ? task.tags : []) if (typeof tag === "string") acc(tagDurations, tag, share);
          }
        }
      }
    }
    return { from: String(from), to: String(to), timezone: tz, totalDuration: r2(total), unboundDuration: r2(unbound), projectDurations, tagDurations, taskDurations, habitDurations, timerDurations };
  }

  /** Split each record at local hour boundaries; active time is spread over the span in proportion. */
  private hourParts(s: FocusSlice, tz: string): Array<{ day: number; hour: number; minutes: number }> {
    const out: Array<{ day: number; hour: number; minutes: number }> = [];
    const span = s.endMs - s.startMs;
    if (!Number.isFinite(span) || span > 7 * 86_400_000) return out;
    const total = mins(s.activeMs);
    if (span <= 0) {
      const p = zonedParts(s.startMs, tz);
      return total > 0 ? [{ day: p.y * 10000 + p.m * 100 + p.d, hour: p.h, minutes: total }] : [];
    }
    let t = s.startMs;
    while (t < s.endMs) {
      const p = zonedParts(t, tz);
      const next = Math.min(s.endMs, t + (3600 - p.min * 60 - p.s) * 1000);
      out.push({ day: p.y * 10000 + p.m * 100 + p.d, hour: p.h, minutes: (total * (next - t)) / span });
      t = next;
    }
    return out;
  }

  clock(from: number, to: number): Record<string, number> {
    const { tz } = this.ctx();
    const out: Record<string, number> = {};
    for (let h = 0; h < 24; h++) out[String(h)] = 0;
    for (const s of this.inRange(this.slices(), from, to, tz)) for (const p of this.hourParts(s, tz)) out[String(p.hour)] = r2(out[String(p.hour)]! + p.minutes);
    return out;
  }
  clockByDay(from: number, to: number): Record<string, Record<string, number>> {
    const { tz } = this.ctx();
    const out: Record<string, Record<string, number>> = {};
    for (const s of this.inRange(this.slices(), from, to, tz)) {
      for (const p of this.hourParts(s, tz)) {
        const day = (out[String(p.day)] ??= Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), 0])));
        day[String(p.hour)] = r2(day[String(p.hour)]! + p.minutes);
      }
    }
    return out;
  }
  heatmap(from: number, to: number): Record<string, number> {
    const { tz } = this.ctx();
    const out: Record<string, number> = {};
    for (const s of this.inRange(this.slices(), from, to, tz)) for (const p of this.hourParts(s, tz)) out[String(p.day)] = r2((out[String(p.day)] ?? 0) + p.minutes);
    return out;
  }

  /** `GET /timer/statistics/{a}/{b}/{c}/{d}`: timer id, a date range and a unit in any order (assumption). */
  timerStats(segments: string[]): Loose {
    const stamps: number[] = [];
    let unit = "day";
    let id = "";
    for (const s of segments) {
      if (/^\d{8}$/.test(s)) stamps.push(Number(s));
      else if (/^(day|week|month|year)$/i.test(s)) unit = s.toLowerCase();
      else id = s;
    }
    if (!id || !this.store.collGet("timers", id)) throw new ApiError(404, "timer_not_found");
    const { tz, today, weekStart } = this.ctx();
    const to = stamps.length > 1 ? Math.max(...stamps.slice(0, 2)) : (stamps[0] ?? today);
    const from = stamps.length > 1 ? Math.min(...stamps.slice(0, 2)) : addDays(to, -6);
    const rows = this.inRange(this.slices(), from, to, tz).filter((s) => recordBindings(s.rec).some((b) => b.owner === 2 && b.id === id));
    const bucket = (d: number): number => (unit === "week" ? weekStartOf(d, weekStart) : unit === "month" ? monthStartOf(d) : unit === "year" ? Math.floor(d / 10000) * 10000 + 101 : d);
    const out: Record<string, { count: number; duration: number }> = {};
    for (const s of rows) {
      const k = String(bucket(stampOf(s.startMs, tz)));
      const e = (out[k] ??= { count: 0, duration: 0 });
      e.count++;
      e.duration = r2(e.duration + mins(s.activeMs));
    }
    return { id, unit, from: String(from), to: String(to), timezone: tz, buckets: out, totalCount: rows.length, totalDuration: r2(rows.reduce((n, s) => n + mins(s.activeMs), 0)) };
  }
}

export function registerStatsRoutes(app: FastifyInstance, svc: Service, focus: FocusService): StatsService {
  const st = new StatsService(svc, focus);
  const n = (s: string): number => (/^\d{8}$/.test(s) ? Number(s) : NaN);
  app.get("/api/v2/statistics/general", async () => st.general());
  app.get("/api/v2/statistics/color", async () => st.colors());
  app.get("/api/v3/user/ranking", async () => st.ranking());
  app.get<{ Params: { t: string } }>("/api/v2/task/statistics/:t", async (req) => st.taskRange(n(req.params.t), n(req.params.t)));
  app.get<{ Params: { a: string; b: string } }>("/api/v2/task/statistics/:a/:b", async (req) => st.taskRange(n(req.params.a), n(req.params.b)));
  app.get<{ Params: { t: string; n: string } }>("/api/v2/task/statistics/week/:t/:n", async (req) => st.taskPeriods("week", n(req.params.t), numOr(req.params.n, NaN)));
  app.get<{ Params: { t: string; n: string } }>("/api/v2/task/statistics/month/:t/:n", async (req) => st.taskPeriods("month", n(req.params.t), numOr(req.params.n, NaN)));
  app.get("/api/v2/pomodoros/statistics/generalForDesktop", async () => st.generalForDesktop());
  app.get<{ Params: { a: string; b: string } }>("/api/v2/pomodoros/statistics/dist/:a/:b", async (req) => st.dist(n(req.params.a), n(req.params.b)));
  app.get<{ Params: { a: string; b: string } }>("/api/v2/pomodoros/statistics/dist/clock/:a/:b", async (req) => st.clock(n(req.params.a), n(req.params.b)));
  app.get<{ Params: { a: string; b: string } }>("/api/v2/pomodoros/statistics/dist/clockByDay/:a/:b", async (req) => st.clockByDay(n(req.params.a), n(req.params.b)));
  app.get<{ Params: { a: string; b: string } }>("/api/v2/pomodoros/statistics/heatmap/:a/:b", async (req) => st.heatmap(n(req.params.a), n(req.params.b)));
  app.get<{ Params: { a: string; b: string; c: string; d: string } }>("/api/v2/timer/statistics/:a/:b/:c/:d", async (req) => st.timerStats([req.params.a, req.params.b, req.params.c, req.params.d]));
  void isPlainObject;
  void dayNum;
  void stampOfDayNum;
  void dayStartMs;
  return st;
}
