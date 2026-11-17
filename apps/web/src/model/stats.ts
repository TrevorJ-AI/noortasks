import { addStampDays, addStampMonths, daysInMonth, monthStartOf, parseStamp, stampWeekStart } from "../lib/m4core";

/**
 * Display math of the Statistics overlay (STAT rows). Pure: days are YYYYMMDD stamps in the account zone, the
 * caller passes "today". Server payloads (statistics/general, task/statistics rows, focus dist) go in, chart-ready
 * numbers come out.
 */

// ------------------------------------------------------------------ rates and formats

/** STAT-026 / STAT-010: completeCount / (completeCount + notCompleteCount); null when nothing was scheduled or done. */
export function completionRate(complete: number, notComplete: number): number | null {
  const total = complete + notComplete;
  return total > 0 ? complete / total : null;
}
export const pct = (r: number | null): string => (r === null ? "-" : `${Math.round(r * 100)}%`);

/** Minutes as "1h 25m", "45m", "0m". */
export function formatMinutes(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** Short day label of a stamp: "Nov 16". */
export function stampLabel(stamp: number, withYear = false): string {
  const { y, m, d } = parseStamp(stamp);
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return withYear ? `${mo} ${d}, ${y}` : `${mo} ${d}`;
}
export function stampWeekday(stamp: number): string {
  const { y, m, d } = parseStamp(stamp);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
}

// ------------------------------------------------------------------ periods

export type Period = "day" | "week" | "month";
export interface Range {
  from: number;
  to: number;
}

/**
 * Task tab periods (STAT-011: Daily is observed, Weekly and Monthly are our choice). The range containing `anchor`;
 * weeks start on the account's week start (0 Sunday, 1 Monday, 6 Saturday).
 */
export function periodRange(period: Period, anchor: number, weekStart: number): Range {
  if (period === "day") return { from: anchor, to: anchor };
  if (period === "week") {
    const from = stampWeekStart(anchor, weekStart);
    return { from, to: addStampDays(from, 6) };
  }
  const from = monthStartOf(anchor);
  const { y, m } = parseStamp(from);
  return { from, to: from + daysInMonth(y, m) - 1 };
}
/** The anchor of the previous (-1) or next (+1) period. */
export function shiftPeriod(period: Period, anchor: number, dir: -1 | 1): number {
  if (period === "day") return addStampDays(anchor, dir);
  if (period === "week") return addStampDays(anchor, 7 * dir);
  const { d } = parseStamp(anchor);
  const first = addStampMonths(monthStartOf(anchor), dir);
  const { y, m } = parseStamp(first);
  return first + Math.min(d, daysInMonth(y, m)) - 1;
}
export function rangeLabel(period: Period, r: Range, today: number): string {
  if (period === "day") return r.from === today ? "Today" : r.from === addStampDays(today, -1) ? "Yesterday" : stampLabel(r.from, true);
  if (period === "week") return `${stampLabel(r.from)} - ${stampLabel(r.to, Math.floor(r.to / 10000) !== Math.floor(today / 10000))}`;
  const { y, m } = parseStamp(r.from);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}

/** Focus tab ranges: the week, month or year containing the anchor. */
export type FocusRange = "week" | "month" | "year";
export function focusRange(kind: FocusRange, anchor: number, weekStart: number): Range {
  if (kind === "year") {
    const y = Math.floor(anchor / 10000);
    return { from: y * 10000 + 101, to: y * 10000 + 1231 };
  }
  return periodRange(kind, anchor, weekStart);
}
export function shiftFocusRange(kind: FocusRange, anchor: number, dir: -1 | 1): number {
  if (kind === "year") return anchor + dir * 10000 - (anchor % 10000 === 229 ? 1 : 0);
  return shiftPeriod(kind, anchor, dir);
}

// ------------------------------------------------------------------ task statistics rows

export interface TaskStatRow {
  day: string;
  overdueCompleteCount: number;
  onTimeCompleteCount: number;
  noTimeCompleteCount: number;
  notCompleteCount: number;
  projectCompleteCounts?: Record<string, number>;
  tagCompleteCounts?: Record<string, number>;
}
export interface TaskTotals {
  overdue: number;
  onTime: number;
  undated: number;
  uncompleted: number;
  completed: number;
  /** completed / (completed + uncompleted) */
  rate: number | null;
  byList: Record<string, number>;
  byTag: Record<string, number>;
}

/** STAT-013 / STAT-014: sum a task/statistics range into the distribution and the classified maps. */
export function sumTaskRows(rows: readonly TaskStatRow[] | null | undefined): TaskTotals {
  const t: TaskTotals = { overdue: 0, onTime: 0, undated: 0, uncompleted: 0, completed: 0, rate: null, byList: {}, byTag: {} };
  for (const r of rows ?? []) {
    t.overdue += r.overdueCompleteCount ?? 0;
    t.onTime += r.onTimeCompleteCount ?? 0;
    t.undated += r.noTimeCompleteCount ?? 0;
    t.uncompleted += r.notCompleteCount ?? 0;
    for (const [k, v] of Object.entries(r.projectCompleteCounts ?? {})) t.byList[k] = (t.byList[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.tagCompleteCounts ?? {})) t.byTag[k] = (t.byTag[k] ?? 0) + v;
  }
  t.completed = t.overdue + t.onTime + t.undated;
  t.rate = completionRate(t.completed, t.uncompleted);
  return t;
}

/** Map sorted by value, largest first; the tail past `max` folds into "Other". */
export function topEntries(m: Record<string, number>, max = 8): Array<{ key: string; value: number }> {
  const list = Object.entries(m)
    .filter(([, v]) => v > 0)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  if (list.length <= max) return list;
  const head = list.slice(0, max - 1);
  head.push({ key: "Other", value: list.slice(max - 1).reduce((n, e) => n + e.value, 0) });
  return head;
}

// ------------------------------------------------------------------ general payload series

export interface Point {
  key: string;
  label: string;
  value: number | null;
}

/** STAT-006: the 7 points of scoreByDay, oldest first. */
export function scorePoints(scoreByDay: Record<string, number> | null | undefined): Point[] {
  return Object.keys(scoreByDay ?? {})
    .sort()
    .slice(-7)
    .map((k) => ({ key: k, label: stampLabel(Number(k)), value: scoreByDay![k] ?? 0 }));
}

type Counts = { completeCount?: number; notCompleteCount?: number };
/** STAT-009 / STAT-010: taskByDay|Week|Month -> count line and rate bars. */
export function completionSeries(map: Record<string, Counts> | null | undefined, unit: Period): { counts: Point[]; rates: Point[] } {
  const keys = Object.keys(map ?? {}).sort();
  const label = (k: string): string => {
    const s = Number(k);
    if (unit === "month") return stampLabel(s).split(" ")[0]!;
    if (unit === "week") return stampLabel(s);
    return stampWeekday(s);
  };
  return {
    counts: keys.map((k) => ({ key: k, label: label(k), value: map![k]!.completeCount ?? 0 })),
    rates: keys.map((k) => ({ key: k, label: label(k), value: completionRate(map![k]!.completeCount ?? 0, map![k]!.notCompleteCount ?? 0) })),
  };
}

// ------------------------------------------------------------------ focus

/** Sequential level 0..5 of a day's focus minutes for the yearly heatmap (STAT-023). */
export function heatLevelMinutes(min: number): number {
  if (!(min > 0)) return 0;
  if (min < 25) return 1;
  if (min < 60) return 2;
  if (min < 120) return 3;
  if (min < 240) return 4;
  return 5;
}

/** Days of a year as heatmap columns (weeks) of 7 rows, starting on the week start; null = padding. */
export function yearGrid(year: number, weekStart: number): Array<Array<number | null>> {
  const first = year * 10000 + 101;
  const last = year * 10000 + 1231;
  const cols: Array<Array<number | null>> = [];
  let d = stampWeekStart(first, weekStart);
  while (d <= last) {
    const col: Array<number | null> = [];
    for (let i = 0; i < 7; i++) {
      col.push(d >= first && d <= last ? d : null);
      d = addStampDays(d, 1);
    }
    cols.push(col);
  }
  return cols;
}

/** Peak hour of a clock map ("0".."23" -> minutes); null when empty. */
export function peakHour(clock: Record<string, number> | null | undefined): number | null {
  let best: number | null = null;
  let bv = 0;
  for (let h = 0; h < 24; h++) {
    const v = clock?.[String(h)] ?? 0;
    if (v > bv) {
      bv = v;
      best = h;
    }
  }
  return best;
}
export const hourLabel = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/** Buckets of a range for focus trend bars: days of a week or month, months of a year. */
export function trendBuckets(kind: FocusRange, r: Range): Array<{ key: number; from: number; to: number; label: string }> {
  if (kind === "year") {
    const y = Math.floor(r.from / 10000);
    return Array.from({ length: 12 }, (_, i) => {
      const from = y * 10000 + (i + 1) * 100 + 1;
      return { key: from, from, to: from + daysInMonth(y, i + 1) - 1, label: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"][i]! };
    });
  }
  const out: Array<{ key: number; from: number; to: number; label: string }> = [];
  for (let d = r.from; d <= r.to; d = addStampDays(d, 1)) out.push({ key: d, from: d, to: d, label: kind === "week" ? stampWeekday(d) : String(d % 100) });
  return out;
}
/** Sum a day -> minutes map over each bucket. */
export function sumBuckets(byDay: Record<string, number> | null | undefined, buckets: ReadonlyArray<{ key: number; from: number; to: number; label: string }>): Point[] {
  return buckets.map((b) => {
    let v = 0;
    for (const [k, m] of Object.entries(byDay ?? {})) {
      const s = Number(k);
      if (s >= b.from && s <= b.to) v += m;
    }
    return { key: String(b.key), label: b.label, value: Math.round(v * 100) / 100 };
  });
}

// ------------------------------------------------------------------ badges (STAT-029..034)

export interface BadgeTrack {
  id: "perseverance" | "gtd" | "mindfulness" | "discipline";
  name: string;
  unit: string;
  thresholds: number[];
  /** daily cap counted toward the track, if any */
  dailyCap?: number;
}
export const BADGE_TRACKS: BadgeTrack[] = [
  { id: "perseverance", name: "Perseverance", unit: "days", thresholds: [3, 7, 21, 50, 200, 1000] },
  { id: "gtd", name: "Get Things Done", unit: "tasks", thresholds: [5, 10, 50, 200, 1000, 5000], dailyCap: 50 },
  { id: "mindfulness", name: "Mindfulness", unit: "minutes", thresholds: [25, 100, 500, 2000, 10000, 50000] },
  { id: "discipline", name: "Self-Discipline", unit: "check-ins", thresholds: [3, 7, 21, 100, 500, 2000], dailyCap: 10 },
];

/** Sum per-day counts with a daily cap (STAT-030: 60 in a day counts 50; STAT-033: 12 counts 10). */
export function cappedTotal(perDay: Map<string | number, number> | Record<string, number>, cap?: number): number {
  const vals = perDay instanceof Map ? [...perDay.values()] : Object.values(perDay);
  return vals.reduce((n, v) => n + (cap ? Math.min(cap, v) : v), 0);
}

export interface BadgeProgress {
  value: number;
  /** medals unlocked, 0..6 */
  level: number;
  /** next threshold, null when all six are unlocked */
  next: number | null;
}
export function badgeProgress(track: BadgeTrack, value: number): BadgeProgress {
  const level = track.thresholds.filter((t) => value >= t).length;
  return { value, level, next: track.thresholds[level] ?? null };
}

// ------------------------------------------------------------------ app-open days (perseverance)

const OPEN_KEY = "noorOpenDays";
const isoDay = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Keep the distinct calendar days on which the app was opened (device local, STAT-029). Returns the list. */
export function recordOpenDay(now: number, store: Pick<Storage, "getItem" | "setItem"> = localStorage): string[] {
  let list: string[] = [];
  try {
    const v = JSON.parse(store.getItem(OPEN_KEY) ?? "[]");
    if (Array.isArray(v)) list = v.filter((x): x is string => typeof x === "string");
  } catch {
    /* start over */
  }
  const day = isoDay(now);
  if (!list.includes(day)) {
    list = [...list, day].sort();
    store.setItem(OPEN_KEY, JSON.stringify(list));
  }
  return list;
}
export function openDays(store: Pick<Storage, "getItem"> = localStorage): string[] {
  try {
    const v = JSON.parse(store.getItem(OPEN_KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ achievement level

/** Level thresholds the server uses (M4-ASSUMPTIONS, guessed): progress inside the current level. */
export const LEVEL_THRESHOLDS = [0, 100, 500, 1000, 2500, 5000, 10000, 20000, 50000, 100000, 200000, 500000];
export function levelProgress(score: number): { level: number; from: number; to: number | null; share: number } {
  let level = 1;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) if (score >= LEVEL_THRESHOLDS[i]!) level = i + 1;
  const from = LEVEL_THRESHOLDS[level - 1]!;
  const to = LEVEL_THRESHOLDS[level] ?? null;
  return { level, from, to, share: to === null ? 1 : Math.min(1, (score - from) / (to - from)) };
}
