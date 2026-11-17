import type { Countdown } from "../data/m4types";
import { addStampDays, addStampMonths, daysInMonth, diffDays, isValidStamp, makeStamp, parseStamp } from "../lib/m4core";

/**
 * Countdown math on calendar dates (YYYYMMDD stamps, never ms arithmetic, so DST cannot shift a day).
 * CNT-009 type values, CNT-010 direction, CNT-011 day calculation, CNT-012 units, CNT-013 age, CNT-016 repeats.
 */
export const CountdownTypes = { Holiday: 1, Birthday: 2, Anniversary: 3, Countdown: 4 } as const;

/** CNT-009: type value -> dialog label. */
export const TYPE_LABEL: Record<number, string> = { 1: "Holiday", 2: "Birthday", 3: "Anniversary", 4: "Countdown" };
/** CNT-006: group headers (order unverified in the source; ours: Countdowns, Anniversaries, Birthdays, Holidays). */
export const GROUPS: Array<{ type: number; label: string }> = [
  { type: 4, label: "Countdowns" },
  { type: 3, label: "Anniversaries" },
  { type: 2, label: "Birthdays" },
  { type: 1, label: "Holidays" },
];
export const typeLabel = (t: number): string => TYPE_LABEL[t] ?? "Countdown";

/** Days from a to b (b - a) on calendar dates. */
export const daysBetween = (a: number, b: number): number => diffDays(a, b);

export interface RepeatRule {
  freq: "YEARLY" | "MONTHLY" | "WEEKLY" | "DAILY";
  interval: number;
}

/** repeatFlag ("RRULE:FREQ=MONTHLY;INTERVAL=2" or bare) -> rule. Birthdays repeat yearly when no rule is set. */
export function repeatOf(c: Pick<Countdown, "repeatFlag" | "type">): RepeatRule | null {
  const raw = (c.repeatFlag ?? "").trim().replace(/^RRULE:/i, "");
  if (!raw) return c.type === CountdownTypes.Birthday ? { freq: "YEARLY", interval: 1 } : null;
  const parts = new Map<string, string>();
  for (const seg of raw.split(";")) {
    const i = seg.indexOf("=");
    if (i > 0) parts.set(seg.slice(0, i).trim().toUpperCase(), seg.slice(i + 1).trim());
  }
  const f = parts.get("FREQ")?.toUpperCase();
  if (f !== "YEARLY" && f !== "MONTHLY" && f !== "WEEKLY" && f !== "DAILY") return null;
  return { freq: f, interval: Math.max(1, Number.parseInt(parts.get("INTERVAL") ?? "1", 10) || 1) };
}

/** The k-th occurrence of the rule from `start` (k = 0 is the start itself). Month ends clamp (Feb 29 -> Feb 28). */
export function occurrence(start: number, r: RepeatRule, k: number): number {
  const { y, m, d } = parseStamp(start);
  switch (r.freq) {
    case "YEARLY": {
      const yy = y + k * r.interval;
      return makeStamp(yy, m, Math.min(d, daysInMonth(yy, m)));
    }
    case "MONTHLY": {
      const first = addStampMonths(makeStamp(y, m, 1), k * r.interval);
      const p = parseStamp(first);
      return makeStamp(p.y, p.m, Math.min(d, daysInMonth(p.y, p.m)));
    }
    case "WEEKLY":
      return addStampDays(start, 7 * r.interval * k);
    case "DAILY":
      return addStampDays(start, r.interval * k);
  }
}

/** Index k of the first occurrence on or after `day`. */
function firstIndexFrom(start: number, r: RepeatRule, day: number): number {
  if (start >= day) return 0;
  const span = diffDays(start, day);
  const approx = r.freq === "YEARLY" ? 366 * r.interval : r.freq === "MONTHLY" ? 31 * r.interval : r.freq === "WEEKLY" ? 7 * r.interval : r.interval;
  let k = Math.max(0, Math.floor(span / approx) - 1);
  while (occurrence(start, r, k) < day) k++;
  return k;
}

/** First occurrence on or after `today`; a non-repeating countdown keeps its date (which may be in the past). */
export function nextOccurrence(c: Pick<Countdown, "date" | "repeatFlag" | "type">, today: number): number {
  if (!isValidStamp(c.date)) return today;
  const r = repeatOf(c);
  if (!r || c.date >= today) return c.date;
  return occurrence(c.date, r, firstIndexFrom(c.date, r, today));
}

export interface Counter {
  /** whole days (always >= 0) */
  days: number;
  /** "left": counting down to a future day; "since": counting up from a past day; "today" */
  dir: "left" | "since" | "today";
  /** the day being counted to or from */
  target: number;
}

/**
 * CNT-010: timerMode 0 counts down to the next occurrence, 1 counts up from the date. A countdown whose single date
 * passed shows days since. CNT-011: daysOption 1 (Start from Day 1) counts the start day as day 1 when counting up;
 * applied to counting up only (our reading: "day 1" has no meaning for days left).
 */
export function counterOf(c: Pick<Countdown, "date" | "repeatFlag" | "type" | "timerMode" | "daysOption">, today: number): Counter {
  if (c.timerMode === 1) {
    const days = Math.max(0, diffDays(c.date, today)) + (c.daysOption === 1 ? 1 : 0);
    return { days, dir: diffDays(c.date, today) === 0 && c.daysOption !== 1 ? "today" : "since", target: c.date };
  }
  const t = nextOccurrence(c, today);
  const d = diffDays(today, t);
  if (d === 0) return { days: 0, dir: "today", target: t };
  if (d < 0) return { days: -d + (c.daysOption === 1 ? 1 : 0), dir: "since", target: t };
  return { days: d, dir: "left", target: t };
}

export type Unit = "day" | "week" | "year";
export const UNIT_ORDER: Unit[] = ["day", "week", "year"];
/** CNT-012: tapping the counter cycles Days, Weeks, Years. */
export const nextUnit = (u: Unit | undefined): Unit => UNIT_ORDER[(UNIT_ORDER.indexOf(u ?? "day") + 1) % 3]!;

/** Value in a unit: days as is; weeks whole weeks plus the remaining days; years with one decimal (365.2425 days). */
export function inUnit(days: number, unit: Unit | undefined): { value: string; label: string; rest?: string } {
  if (unit === "week") {
    const w = Math.floor(days / 7);
    const r = days % 7;
    return { value: String(w), label: w === 1 ? "Week" : "Weeks", rest: r ? `${r} ${r === 1 ? "day" : "days"}` : undefined };
  }
  if (unit === "year") {
    const y = Math.floor((days / 365.2425) * 10) / 10;
    return { value: y.toFixed(1).replace(/\.0$/, ""), label: y === 1 ? "Year" : "Years" };
  }
  return { value: String(days), label: days === 1 ? "Day" : "Days" };
}

/** CNT-013: age in whole years on `today` for a birth date. */
export function ageOn(birth: number, today: number): number {
  const b = parseStamp(birth);
  const t = parseStamp(today);
  let age = t.y - b.y;
  if (t.m < b.m || (t.m === b.m && t.d < b.d)) age--;
  return Math.max(0, age);
}

/** CNT-019: the pinned one first, then by the next date, then by name. */
export function sortCountdowns<T extends Pick<Countdown, "date" | "repeatFlag" | "type" | "pinnedTime" | "name">>(list: T[], today: number): T[] {
  return [...list].sort((a, b) => {
    if (!!a.pinnedTime !== !!b.pinnedTime) return a.pinnedTime ? -1 : 1;
    const na = nextOccurrence(a, today);
    const nb = nextOccurrence(b, today);
    // dates still ahead before passed ones
    const fa = na >= today ? 0 : 1;
    const fb = nb >= today ? 0 : 1;
    if (fa !== fb) return fa - fb;
    if (na !== nb) return fa === 0 ? na - nb : nb - na;
    return a.name.localeCompare(b.name);
  });
}

/** Stamps of the countdown's date and its repeats inside [from, to] (calendar overlay, CAL-034). Archived: none. */
export function countdownStampsInRange(c: Countdown, fromStamp: number, toStamp: number): number[] {
  if (c.status === 1 || !isValidStamp(c.date)) return [];
  const r = repeatOf(c);
  if (!r) return c.date >= fromStamp && c.date <= toStamp ? [c.date] : [];
  const out: number[] = [];
  for (let k = firstIndexFrom(c.date, r, fromStamp), guard = 0; guard < 1000; k++, guard++) {
    const o = occurrence(c.date, r, k);
    if (o > toStamp) break;
    out.push(o);
  }
  return out;
}

/** CNT-023: own list of fixed-date holidays for the Recommend picker. */
export const HOLIDAYS: Array<{ name: string; m: number; d: number; icon: string }> = [
  { name: "New Year's Day", m: 1, d: 1, icon: "🎆" },
  { name: "Valentine's Day", m: 2, d: 14, icon: "💌" },
  { name: "International Women's Day", m: 3, d: 8, icon: "🌷" },
  { name: "Earth Day", m: 4, d: 22, icon: "🌍" },
  { name: "King's Day", m: 4, d: 27, icon: "👑" },
  { name: "Liberation Day", m: 5, d: 5, icon: "🕊️" },
  { name: "Halloween", m: 10, d: 31, icon: "🎃" },
  { name: "Sinterklaas", m: 12, d: 5, icon: "🎁" },
  { name: "Christmas Day", m: 12, d: 25, icon: "🎄" },
  { name: "New Year's Eve", m: 12, d: 31, icon: "🥂" },
];
/** Next date (on or after today) of a fixed month/day. */
export function nextFixedDate(m: number, d: number, today: number): number {
  const t = parseStamp(today);
  const thisYear = makeStamp(t.y, m, Math.min(d, daysInMonth(t.y, m)));
  return thisYear >= today ? thisYear : makeStamp(t.y + 1, m, Math.min(d, daysInMonth(t.y + 1, m)));
}

/** Reminder presets (TRIGGER strings, the server default format). */
export const REMINDER_PRESETS: Array<{ value: string; label: string }> = [
  { value: "TRIGGER:P0DT9H0M0S", label: "On the day, 9:00" },
  { value: "TRIGGER:-P0DT15H0M0S", label: "1 day before, 9:00" },
  { value: "TRIGGER:-P2DT15H0M0S", label: "3 days before, 9:00" },
  { value: "TRIGGER:-P6DT15H0M0S", label: "1 week before, 9:00" },
];

export const STYLES: Array<{ value: string; label: string }> = [
  { value: "normal", label: "Plain" },
  { value: "calendar", label: "Calendar" },
  { value: "fullscreen_image", label: "Full image" },
  { value: "polaroid", label: "Polaroid" },
  { value: "perpetual", label: "Desk calendar" },
  { value: "dopamine", label: "Bold" },
  { value: "two_color_card", label: "Two tone" },
  { value: "cartoon", label: "Sketch" },
];

/** Own icon presets (emoji are plain Unicode; text badges are any 1-2 letters). */
export const ICON_PRESETS = ["🎂", "💍", "✈️", "🎓", "🏠", "💼", "🎉", "❤️", "🌱", "⭐", "📅", "🏃"];

export function stampToInput(s: number): string {
  if (!isValidStamp(s)) return "";
  const { y, m, d } = parseStamp(s);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
export function inputToStamp(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const s = makeStamp(Number(m[1]), Number(m[2]), Number(m[3]));
  return isValidStamp(s) ? s : null;
}
export function formatStamp(s: number, withWeekday = false): string {
  if (!isValidStamp(s)) return "";
  const { y, m, d } = parseStamp(s);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { ...(withWeekday ? { weekday: "short" } : {}), year: "numeric", month: "short", day: "numeric" });
}
