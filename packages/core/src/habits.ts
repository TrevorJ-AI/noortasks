import { DEFAULT_HABIT_RULE } from "./constants.js";
import { WEEKDAY_CODES, addDays, daysInMonth, dayNum, diffDays, isValidStamp, parseStamp, stampOfDayNum, stampRange, weekStartOf, weekdayOf } from "./dates.js";

/** A habit `repeatRule`: a bare iCal rule (no `RRULE:` prefix) plus the `TT_TIMES=n` extension (kept for import compatibility). */
export interface HabitRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  /** Weekdays, 0 = Sunday. Empty = every day. */
  byDay: number[];
  byMonthDay: number[];
  /** `TT_TIMES`: n check-ins per week (weekly quota habit). */
  times: number | null;
}

export function parseHabitRule(rule: unknown): HabitRule {
  const fallback: HabitRule = { freq: "DAILY", interval: 1, byDay: [], byMonthDay: [], times: null };
  if (typeof rule !== "string" || !rule.trim()) return parseHabitRule(DEFAULT_HABIT_RULE);
  const body = rule.trim().replace(/^(RRULE|LUNAR):/i, "");
  const parts = new Map<string, string>();
  for (const seg of body.split(";")) {
    const i = seg.indexOf("=");
    if (i > 0) parts.set(seg.slice(0, i).trim().toUpperCase(), seg.slice(i + 1).trim());
  }
  const freq = parts.get("FREQ")?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return fallback;
  const interval = Math.max(1, Number.parseInt(parts.get("INTERVAL") ?? "1", 10) || 1);
  const byDay = (parts.get("BYDAY") ?? "")
    .split(",")
    .map((s) => WEEKDAY_CODES.indexOf(s.trim().slice(-2).toUpperCase() as (typeof WEEKDAY_CODES)[number]))
    .filter((n) => n >= 0);
  const byMonthDay = (parts.get("BYMONTHDAY") ?? "").split(",").map((s) => Number.parseInt(s, 10)).filter((n) => Number.isFinite(n) && n !== 0);
  const t = Number.parseInt(parts.get("TT_TIMES") ?? "", 10);
  const times = freq === "WEEKLY" && Number.isFinite(t) && t > 0 ? t : null;
  return { freq, interval, byDay: [...new Set(byDay)].sort(), byMonthDay, times };
}

export function formatHabitRule(r: HabitRule): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byDay.length) parts.push(`BYDAY=${r.byDay.map((d) => WEEKDAY_CODES[d]).join(",")}`);
  if (r.byMonthDay.length) parts.push(`BYMONTHDAY=${r.byMonthDay.join(",")}`);
  if (r.times) parts.push(`TT_TIMES=${r.times}`);
  return parts.join(";");
}

export const isWeekNDays = (r: HabitRule): boolean => r.freq === "WEEKLY" && r.times !== null;

function toStampSet(list: unknown): Set<number> {
  const out = new Set<number>();
  if (!Array.isArray(list)) return out;
  for (const v of list) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/-/g, "")) : NaN;
    if (isValidStamp(n)) out.add(n);
  }
  return out;
}

/**
 * Is the habit due on `stamp`? `anchor` is the first day of the habit (start of an every-n-days
 * cadence). Weekly quota habits (TT_TIMES) are due every day: any day can fill the quota.
 */
export function isScheduled(rule: HabitRule, anchor: number, stamp: number, exDates?: unknown): boolean {
  if (stamp < anchor) return false;
  if (toStampSet(exDates).has(stamp)) return false;
  switch (rule.freq) {
    case "DAILY":
      return diffDays(anchor, stamp) % rule.interval === 0;
    case "WEEKLY": {
      if (rule.times !== null) return true;
      if (rule.byDay.length && !rule.byDay.includes(weekdayOf(stamp))) return false;
      if (!rule.byDay.length && weekdayOf(stamp) !== weekdayOf(anchor)) return false;
      const weeks = Math.floor(diffDays(weekStartOf(anchor, 0), weekStartOf(stamp, 0)) / 7);
      return weeks % rule.interval === 0;
    }
    case "MONTHLY": {
      const a = parseStamp(anchor);
      const s = parseStamp(stamp);
      const months = (s.y - a.y) * 12 + (s.m - a.m);
      if (months % rule.interval !== 0) return false;
      const dim = daysInMonth(s.y, s.m);
      const wanted = rule.byMonthDay.length ? rule.byMonthDay : [a.d];
      return wanted.some((d) => (d > 0 ? Math.min(d, dim) : dim + 1 + d) === s.d);
    }
    case "YEARLY": {
      const a = parseStamp(anchor);
      const s = parseStamp(stamp);
      if ((s.y - a.y) % rule.interval !== 0 || s.m !== a.m) return false;
      return s.d === Math.min(a.d, daysInMonth(s.y, s.m));
    }
  }
}

export interface StreakInput {
  rule: HabitRule;
  /** First day of the habit. */
  anchor: number;
  exDates?: unknown;
  /** Days with a done check-in. */
  done: Iterable<number>;
  /** Today in the user's zone. Days after today never count and never break a streak. */
  today: number;
  /** Week start for quota habits, 0 = Sunday. */
  weekStart?: number;
}
export interface StreakResult {
  totalCheckIns: number;
  currentStreak: number;
  maxStreak: number;
}

/**
 * Streak rule (assumption, see M4-ASSUMPTIONS.md): a done day extends the run; a due day with no
 * check-in breaks it, except today (still open); days that are not due neither extend nor break.
 * Weekly quota habits count whole weeks: a week that met its quota extends the run by its done
 * days, a past week that missed it resets the run, the running week never breaks it.
 */
export function habitStreaks(inp: StreakInput): StreakResult {
  const done = new Set<number>();
  for (const d of inp.done) if (isValidStamp(d)) done.add(d);
  const total = done.size;
  const counted = [...done].filter((d) => d <= inp.today).sort((a, b) => a - b);
  if (counted.length === 0 && inp.today < inp.anchor) return { totalCheckIns: total, currentStreak: 0, maxStreak: 0 };
  const start = Math.min(inp.anchor, counted[0] ?? inp.anchor);
  let run = 0;
  let max = 0;
  if (inp.rule.times !== null) {
    const ws = inp.weekStart ?? 0;
    const need = inp.rule.times;
    const thisWeek = weekStartOf(inp.today, ws);
    for (let w = weekStartOf(start, ws); w <= thisWeek; w = addDays(w, 7)) {
      const n = counted.filter((d) => d >= w && d < addDays(w, 7)).length;
      if (n >= need) {
        run += n;
        if (run > max) max = run;
      } else if (w < thisWeek) run = 0;
    }
    return { totalCheckIns: total, currentStreak: run, maxStreak: max };
  }
  for (const d of stampRange(start, inp.today)) {
    if (done.has(d)) {
      run++;
      if (run > max) max = run;
    } else if (isScheduled(inp.rule, inp.anchor, d, inp.exDates) && d !== inp.today) run = 0;
  }
  return { totalCheckIns: total, currentStreak: run, maxStreak: max };
}

/** Anchor day of a habit: its start date, else the creation day. */
export function habitAnchor(h: { targetStartDate?: unknown; createdStamp?: number }, fallback: number): number {
  const t = h.targetStartDate;
  if (typeof t === "number" && isValidStamp(t)) return t;
  return h.createdStamp ?? fallback;
}

export { dayNum, stampOfDayNum };
