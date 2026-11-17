/**
 * Calendar-date helpers. Dates travel as `YYYYMMDD` integers (habit check-ins, statistics keys).
 * All day arithmetic is done on calendar day numbers, never by adding 86,400,000 ms, so DST and
 * month ends cannot shift a day.
 */

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface ZonedParts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
}

export function zonedParts(ms: number, tz: string): ZonedParts {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year!, m: o.month!, d: o.day!, h: o.hour! % 24, min: o.minute!, s: o.second! };
}

/** `YYYYMMDD` of an instant in a time zone. */
export function stampOf(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return p.y * 10000 + p.m * 100 + p.d;
}

export function parseStamp(stamp: number): { y: number; m: number; d: number } {
  return { y: Math.floor(stamp / 10000), m: Math.floor((stamp % 10000) / 100), d: stamp % 100 };
}
export function makeStamp(y: number, m: number, d: number): number {
  return y * 10000 + m * 100 + d;
}
export function isValidStamp(v: unknown): v is number {
  if (typeof v !== "number" || !Number.isInteger(v)) return false;
  const { y, m, d } = parseStamp(v);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m);
}
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** Days since 1970-01-01 of a calendar date. */
export function dayNum(stamp: number): number {
  const { y, m, d } = parseStamp(stamp);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}
export function stampOfDayNum(n: number): number {
  const dt = new Date(n * 86_400_000);
  return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
}
export function addDays(stamp: number, n: number): number {
  return stampOfDayNum(dayNum(stamp) + n);
}
/** 0 = Sunday. */
export function weekdayOf(stamp: number): number {
  return (((dayNum(stamp) + 4) % 7) + 7) % 7;
}
/** First day of the week containing `stamp`. `weekStart` 0 = Sunday ... 6 = Saturday. */
export function weekStartOf(stamp: number, weekStart = 0): number {
  const back = (weekdayOf(stamp) - weekStart + 7) % 7;
  return addDays(stamp, -back);
}
export function monthStartOf(stamp: number): number {
  return Math.floor(stamp / 100) * 100 + 1;
}
export function addMonths(stamp: number, n: number): number {
  const { y, m } = parseStamp(stamp);
  const t = y * 12 + (m - 1) + n;
  return makeStamp(Math.floor(t / 12), (t % 12) + 1, 1);
}
export function stampRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = dayNum(from); n <= dayNum(to); n++) out.push(stampOfDayNum(n));
  return out;
}
export function diffDays(a: number, b: number): number {
  return dayNum(b) - dayNum(a);
}

/** Offset (wall clock minus UTC) of a zone at an instant, in ms. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}
/** Instant of local midnight at the start of a calendar day in a zone (DST aware). */
export function dayStartMs(stamp: number, tz: string): number {
  const { y, m, d } = parseStamp(stamp);
  const wall = Date.UTC(y, m - 1, d);
  let t = wall - tzOffsetMs(wall, tz);
  t = wall - tzOffsetMs(t, tz);
  return t;
}
export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
export const WEEK_START_BY_NAME: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

/**
 * Convert a local wall-clock date/time in `tz` to UTC epoch ms.
 * Ambiguous fall-back times resolve to the earlier instant; nonexistent spring-forward times shift forward.
 */
export function wallToInstant(y: number, m: number, d: number, h: number, min: number, s: number, tz: string): number {
  const wallMs = Date.UTC(y, m - 1, d, h, min, s);
  if (tz === "UTC") return wallMs;
  const offA = tzOffsetMs(wallMs - 86_400_000, tz);
  const offB = tzOffsetMs(wallMs + 86_400_000, tz);
  const valid: number[] = [];
  for (const off of new Set([offA, offB])) {
    const t = wallMs - off;
    if (tzOffsetMs(t, tz) === off) valid.push(t);
  }
  if (valid.length) return Math.min(...valid);
  return wallMs - offA;
}
