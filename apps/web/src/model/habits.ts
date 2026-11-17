import type { Checkin, Habit } from "../data/m4types";
import { CheckinStatus, HabitStatus, HabitType } from "../lib/core";
import { addStampDays, daysInMonth, formatHabitRule, habitStreaks, isScheduled, makeStamp, parseHabitRule, parseStamp, stampOf, stampWeekStart, type HabitRule } from "../lib/m4core";

/** Habit display math. Streaks use core's habitStreaks, the same rule the server stores (M4-ASSUMPTIONS "Habits"). */

export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ------------------------------------------------------------------ frequency form (HAB-013)

export type Cadence = { kind: "daily"; days: number[] } | { kind: "weekly"; times: number } | { kind: "interval"; every: number };

export function cadenceOf(rule: string | undefined): Cadence {
  const r = parseHabitRule(rule);
  if (r.times !== null) return { kind: "weekly", times: r.times };
  if (r.freq === "DAILY") return r.interval > 1 ? { kind: "interval", every: r.interval } : { kind: "daily", days: [0, 1, 2, 3, 4, 5, 6] };
  if (r.freq === "WEEKLY") return { kind: "daily", days: r.byDay.length ? r.byDay : [0, 1, 2, 3, 4, 5, 6] };
  return { kind: "daily", days: [0, 1, 2, 3, 4, 5, 6] };
}

export function ruleOf(c: Cadence): string {
  const base: HabitRule = { freq: "WEEKLY", interval: 1, byDay: [], byMonthDay: [], times: null };
  if (c.kind === "weekly") return formatHabitRule({ ...base, byDay: [0, 1, 2, 3, 4, 5, 6], times: Math.max(1, Math.min(7, c.times)) });
  if (c.kind === "interval") return formatHabitRule({ ...base, freq: "DAILY", interval: Math.max(1, c.every) });
  const days = [...new Set(c.days)].sort();
  return formatHabitRule({ ...base, byDay: days.length ? days : [0, 1, 2, 3, 4, 5, 6] });
}

export function cadenceLabel(rule: string | undefined): string {
  const c = cadenceOf(rule);
  if (c.kind === "weekly") return `${c.times} day${c.times === 1 ? "" : "s"} per week`;
  if (c.kind === "interval") return c.every === 1 ? "Every day" : `Every ${c.every} days`;
  if (c.days.length === 7) return "Every day";
  if (c.days.length === 5 && [1, 2, 3, 4, 5].every((d) => c.days.includes(d))) return "Weekdays";
  return c.days.map((d) => WEEKDAY_SHORT[d]).join(", ");
}

// ------------------------------------------------------------------ check-in state

export const isDone = (c: Checkin | undefined): boolean => c?.status === CheckinStatus.Done;
export const isReal = (h: Habit): boolean => h.type === HabitType.Real;

/** Creation day of a habit in the user's zone (anchor when no start date is set). */
export function anchorOf(h: Habit, tz: string, fallbackMs: number): number {
  if (typeof h.targetStartDate === "number" && h.targetStartDate > 19000000) return h.targetStartDate;
  const c = typeof h.createdTime === "string" ? Date.parse(h.createdTime.replace(/([+-]\d\d)(\d\d)$/, "$1:$2")) : NaN;
  return stampOf(Number.isNaN(c) ? fallbackMs : c, tz);
}

export type DayState = "done" | "partial" | "undone" | "skipped" | "due" | "rest" | "future" | "before";

export function dayState(h: Habit, c: Checkin | undefined, stamp: number, today: number, anchor: number): DayState {
  if (isDone(c)) return "done";
  if ((h.exDates ?? []).includes(String(stamp))) return "skipped";
  if (stamp > today) return "future";
  if (c && c.status === CheckinStatus.Undone) return "undone";
  if (c && (c.value ?? 0) > 0) return "partial";
  const rule = parseHabitRule(h.repeatRule);
  const first = Math.min(anchor, c?.checkinStamp ?? anchor);
  if (stamp < first) return "before";
  return isScheduled(rule, anchor, stamp, h.exDates) ? "due" : "rest";
}

export interface HabitStats {
  totalCheckIns: number;
  currentStreak: number;
  maxStreak: number;
  monthCheckIns: number;
  /** done days over due days in the month so far (today included), 0..1; null when nothing was due */
  monthRate: number | null;
}

/** Streak display math (HAB-023, HAB-024): computed from the local check-ins so it moves the moment you tap. */
export function habitStats(h: Habit, checkins: Checkin[], today: number, anchor: number, weekStart: number, month = Math.floor(today / 100)): HabitStats {
  const done = checkins.filter((c) => c.habitId === h.id && isDone(c)).map((c) => c.checkinStamp);
  const rule = parseHabitRule(h.repeatRule);
  const firstDone = done.length ? Math.min(...done) : anchor;
  const s = habitStreaks({ rule, anchor: Math.min(anchor, firstDone), exDates: h.exDates, done, today, weekStart });
  const y = Math.floor(month / 100);
  const m = month % 100;
  const first = makeStamp(y, m, 1);
  const last = Math.min(makeStamp(y, m, daysInMonth(y, m)), today);
  const doneSet = new Set(done);
  const monthDone = done.filter((d) => d >= first && d <= makeStamp(y, m, 31)).length;
  let due = 0;
  let hit = 0;
  if (rule.times !== null) {
    // n days per week: the month's quota is n per started week, capped at the days so far
    for (let w = stampWeekStart(first, weekStart); w <= last; w = addStampDays(w, 7)) {
      const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addStampDays(w, i)).filter((d) => d >= Math.max(first, anchor) && d <= last);
      if (!days.length) continue;
      due += Math.min(rule.times, days.length);
      hit += Math.min(rule.times, days.filter((d) => doneSet.has(d)).length);
    }
  } else {
    for (let d = first; d <= last; d = addStampDays(d, 1)) {
      if (!isScheduled(rule, Math.min(anchor, firstDone), d, h.exDates)) {
        if (doneSet.has(d)) hit++, due++;
        continue;
      }
      due++;
      if (doneSet.has(d)) hit++;
    }
  }
  return { totalCheckIns: s.totalCheckIns, currentStreak: s.currentStreak, maxStreak: s.maxStreak, monthCheckIns: monthDone, monthRate: due ? hit / due : null };
}

/** Is the habit due today (Today list, HAB-005)? Weekly-quota habits show until the quota is met. */
export function dueToday(h: Habit, checkins: Checkin[], today: number, anchor: number, weekStart: number): boolean {
  if (h.status === HabitStatus.Archived) return false;
  const rule = parseHabitRule(h.repeatRule);
  if (rule.times !== null) {
    const w = stampWeekStart(today, weekStart);
    const n = checkins.filter((c) => c.habitId === h.id && isDone(c) && c.checkinStamp >= w && c.checkinStamp <= today).length;
    return n < rule.times || checkins.some((c) => c.habitId === h.id && c.checkinStamp === today);
  }
  return isScheduled(rule, anchor, today, h.exDates) || checkins.some((c) => c.habitId === h.id && c.checkinStamp === today);
}

/** Month grid: rows of 7 stamps (0 = padding), starting on the week start. */
export function monthGrid(month: number, weekStart: number): number[][] {
  const y = Math.floor(month / 100);
  const m = month % 100;
  const first = makeStamp(y, m, 1);
  const n = daysInMonth(y, m);
  const lead = (new Date(y, m - 1, 1).getDay() - weekStart + 7) % 7;
  const cells: number[] = [...Array(lead).fill(0), ...Array.from({ length: n }, (_, i) => first + i)];
  while (cells.length % 7) cells.push(0);
  const rows: number[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}
export function shiftMonth(month: number, n: number): number {
  const y = Math.floor(month / 100);
  const t = y * 12 + (month % 100) - 1 + n;
  return Math.floor(t / 12) * 100 + (t % 12) + 1;
}
export const monthLabel = (month: number): string => new Date(Math.floor(month / 100), (month % 100) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
export const stampLabel = (stamp: number): string => {
  const { y, m, d } = parseStamp(stamp);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
};

/** Weekly review (HAB-031): completion rate of the last `weeks` weeks, oldest first. */
export function weeklyReview(h: Habit, checkins: Checkin[], today: number, anchor: number, weekStart: number, weeks = 8): Array<{ week: number; done: number; due: number }> {
  const rule = parseHabitRule(h.repeatRule);
  const doneSet = new Set(checkins.filter((c) => c.habitId === h.id && isDone(c)).map((c) => c.checkinStamp));
  const out: Array<{ week: number; done: number; due: number }> = [];
  const cur = stampWeekStart(today, weekStart);
  for (let i = weeks - 1; i >= 0; i--) {
    const w = addStampDays(cur, -7 * i);
    const days = [0, 1, 2, 3, 4, 5, 6].map((k) => addStampDays(w, k)).filter((d) => d <= today && d >= anchor);
    const done = days.filter((d) => doneSet.has(d)).length;
    const due = rule.times !== null ? (days.length ? Math.min(rule.times, days.length) : 0) : days.filter((d) => isScheduled(rule, anchor, d, h.exDates) || doneSet.has(d)).length;
    out.push({ week: w, done: Math.min(done, Math.max(due, done)), due });
  }
  return out;
}

/** HAB-004 / SET-226: sort by check-in status puts the habits still open today first. */
export function sortHabits(list: Habit[], byStatus: boolean, doneToday: (h: Habit) => boolean): Habit[] {
  const base = [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));
  return byStatus ? base.sort((a, b) => Number(doneToday(a)) - Number(doneToday(b))) : base;
}

// ------------------------------------------------------------------ icons and gallery (NoorTasks' own content)

/** iconRes values: "habit_daily_check_in" (default) and "nt_<key>" presets map to drawn icons; "emoji:x" and "text:Ab" are user badges. */
export const ICON_KEYS = ["check", "water", "run", "book", "meditate", "sleep", "food", "dumbbell", "pen", "music", "code", "sun", "moon", "heart", "leaf", "bike", "language", "pray", "money", "phone"] as const;
export type IconKey = (typeof ICON_KEYS)[number];
export function iconKeyOf(iconRes: string | undefined): IconKey | null {
  if (!iconRes || iconRes === "habit_daily_check_in") return "check";
  if (iconRes.startsWith("nt_")) return (ICON_KEYS as readonly string[]).includes(iconRes.slice(3)) ? (iconRes.slice(3) as IconKey) : "check";
  return null;
}
export function badgeText(iconRes: string | undefined): string | null {
  if (!iconRes) return null;
  if (iconRes.startsWith("emoji:")) return iconRes.slice(6);
  if (iconRes.startsWith("text:")) return iconRes.slice(5).slice(0, 2);
  return null;
}

export interface Preset {
  name: string;
  icon: IconKey;
  color: string;
  quote: string;
  rule: string;
  type?: "Boolean" | "Real";
  goal?: number;
  unit?: string;
}
const EVERY = "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA";
/** HAB-020: four categories of habit presets (`TT_TIMES` kept in preset rules for sync/wire compatibility). */
export const GALLERY: Array<{ category: string; items: Preset[] }> = [
  {
    category: "Health",
    items: [
      { name: "Drink water", icon: "water", color: "#2f8fbf", quote: "A glass at a time.", rule: EVERY, type: "Real", goal: 8, unit: "glasses" },
      { name: "Eat fruit", icon: "food", color: "#3fa66b", quote: "Colour on the plate.", rule: EVERY },
      { name: "Sleep before 23:00", icon: "sleep", color: "#5b6ee1", quote: "Tomorrow starts tonight.", rule: EVERY },
      { name: "Take vitamins", icon: "heart", color: "#e5484d", quote: "Small and steady.", rule: EVERY },
      { name: "No sugary drinks", icon: "leaf", color: "#3fa66b", quote: "Water wins.", rule: EVERY },
      { name: "Walk 8000 steps", icon: "run", color: "#f08c2e", quote: "Every step counts.", rule: EVERY, type: "Real", goal: 8000, unit: "steps" },
    ],
  },
  {
    category: "Fitness",
    items: [
      { name: "Morning run", icon: "run", color: "#f08c2e", quote: "Out the door first.", rule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" },
      { name: "Strength training", icon: "dumbbell", color: "#a35bd6", quote: "Show up, lift, rest.", rule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=3" },
      { name: "Stretch", icon: "leaf", color: "#3fa66b", quote: "Loose body, clear head.", rule: EVERY },
      { name: "Cycle to work", icon: "bike", color: "#2f8fbf", quote: "Wind in the face.", rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
      { name: "Push-ups", icon: "dumbbell", color: "#e5484d", quote: "One more than yesterday.", rule: EVERY, type: "Real", goal: 30, unit: "reps" },
      { name: "Yoga", icon: "meditate", color: "#5b6ee1", quote: "Breathe into it.", rule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=2" },
    ],
  },
  {
    category: "Mind",
    items: [
      { name: "Read", icon: "book", color: "#e2b714", quote: "Ten pages a day.", rule: EVERY, type: "Real", goal: 10, unit: "pages" },
      { name: "Meditate", icon: "meditate", color: "#5b6ee1", quote: "Sit for a moment.", rule: EVERY },
      { name: "Journal", icon: "pen", color: "#a35bd6", quote: "Write it down.", rule: EVERY },
      { name: "Learn a language", icon: "language", color: "#2f8fbf", quote: "A few words more.", rule: EVERY },
      { name: "Practise an instrument", icon: "music", color: "#f08c2e", quote: "Slow is smooth.", rule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=4" },
      { name: "Pray on time", icon: "pray", color: "#3fa66b", quote: "First things first.", rule: EVERY, type: "Real", goal: 5, unit: "times" },
    ],
  },
  {
    category: "Life",
    items: [
      { name: "Wake up early", icon: "sun", color: "#e2b714", quote: "Own the morning.", rule: EVERY },
      { name: "Plan tomorrow", icon: "moon", color: "#5b6ee1", quote: "Five minutes tonight.", rule: EVERY },
      { name: "Save money", icon: "money", color: "#3fa66b", quote: "Pay yourself first.", rule: EVERY },
      { name: "Screen-free hour", icon: "phone", color: "#e5484d", quote: "Look up.", rule: EVERY },
      { name: "Code something", icon: "code", color: "#2f8fbf", quote: "Ship a little.", rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
      { name: "Call family", icon: "heart", color: "#f08c2e", quote: "Stay close.", rule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=1" },
    ],
  },
];
