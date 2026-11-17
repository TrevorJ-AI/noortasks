import {
  addDays,
  addMonths,
  daysInMonth,
  isValidTimeZone,
  makeStamp,
  parseStamp,
  wallToInstant,
  zonedParts,
} from "./dates.js";

export type TriggerRelated = "START" | "END";

export interface ParsedTrigger {
  raw: string;
  related: TriggerRelated;
  negative: boolean;
  years: number;
  months: number;
  weeks: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

const TRIGGER_RE =
  /^(?:TRIGGER(?:;RELATED=(START|END))?):(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/**
 * Parse an iCalendar-style reminder trigger string (RMD-002).
 * Returns null if the syntax is invalid or has no duration components.
 */
export function parseTrigger(trigger: string): ParsedTrigger | null {
  if (typeof trigger !== "string") return null;
  const s = trigger.trim();
  const m = TRIGGER_RE.exec(s);
  if (!m) return null;
  const [, rel, neg, y, mo, w, d, h, mi, sec] = m;
  if (!y && !mo && !w && !d && !h && !mi && !sec) return null;
  return {
    raw: s,
    related: rel === "END" ? "END" : "START",
    negative: neg === "-",
    years: Number(y ?? 0),
    months: Number(mo ?? 0),
    weeks: Number(w ?? 0),
    days: Number(d ?? 0),
    hours: Number(h ?? 0),
    minutes: Number(mi ?? 0),
    seconds: Number(sec ?? 0),
  };
}

function shiftCalendarYearsMonths(stamp: number, years: number, months: number): number {
  const { d } = parseStamp(stamp);
  const movedFirst = addMonths(stamp, years * 12 + months);
  const { y: ny, m: nm } = parseStamp(movedFirst);
  return makeStamp(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/**
 * Compute the UTC instant (epoch ms) when `parsed` fires relative to `anchorMs` in `tz`.
 * - For all-day anchors, `anchorMs` is local midnight of the task date in `tz`, and time components
 *   operate in wall-clock day+time (e.g., `P0DT9H0M0S` -> 09:00 on that day, `-P0DT15H0M0S` -> 09:00 the previous day).
 * - For timed tasks, date components (`Y/M/W/D`) shift calendar dates preserving local wall clock across DST,
 *   and time components (`H/M/S`) shift exact elapsed milliseconds.
 */
export function computeTriggerInstant(anchorMs: number, parsed: ParsedTrigger, tz: string, isAllDay: boolean): number {
  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const sign = parsed.negative ? -1 : 1;
  const p = zonedParts(anchorMs, zone);

  if (isAllDay) {
    let stamp = makeStamp(p.y, p.m, p.d);
    if (parsed.years || parsed.months) {
      stamp = shiftCalendarYearsMonths(stamp, sign * parsed.years, sign * parsed.months);
    }
    const dayShift = sign * (parsed.weeks * 7 + parsed.days);
    const totalSecOffset = sign * (parsed.hours * 3600 + parsed.minutes * 60 + parsed.seconds);
    const extraDays = Math.floor(totalSecOffset / 86_400);
    const remSec = ((totalSecOffset % 86_400) + 86_400) % 86_400;
    const targetStamp = addDays(stamp, dayShift + extraDays);
    const tp = parseStamp(targetStamp);
    const hh = Math.floor(remSec / 3600);
    const mm = Math.floor((remSec % 3600) / 60);
    const ss = remSec % 60;
    return wallToInstant(tp.y, tp.m, tp.d, hh, mm, ss, zone);
  }

  let baseMs = anchorMs;
  if (parsed.years || parsed.months || parsed.weeks || parsed.days) {
    let stamp = makeStamp(p.y, p.m, p.d);
    if (parsed.years || parsed.months) {
      stamp = shiftCalendarYearsMonths(stamp, sign * parsed.years, sign * parsed.months);
    }
    stamp = addDays(stamp, sign * (parsed.weeks * 7 + parsed.days));
    const tp = parseStamp(stamp);
    const subSec = ((anchorMs % 1000) + 1000) % 1000;
    baseMs = wallToInstant(tp.y, tp.m, tp.d, p.h, p.min, p.s, zone) + subSec;
  }

  const timeMs = sign * ((parsed.hours * 3600 + parsed.minutes * 60 + parsed.seconds) * 1000);
  return baseMs + timeMs;
}

/**
 * Canonicalise timed trigger strings (RMD-004): converts negative hour/minute-only offsets into
 * `-P<d>D`, `-PT<m>M`, or `PT0S` when exact, and drops duplicates keeping order.
 */
export function canonicalizeTriggers(triggers: readonly string[], isAllDay: boolean): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of triggers) {
    const parsed = parseTrigger(raw);
    if (!parsed) continue;
    let canon = parsed.raw;
    if (!isAllDay && parsed.related === "START" && parsed.years === 0 && parsed.months === 0) {
      const totalSec = (parsed.weeks * 7 + parsed.days) * 86_400 + parsed.hours * 3600 + parsed.minutes * 60 + parsed.seconds;
      if (totalSec === 0) {
        canon = "TRIGGER:PT0S";
      } else if (parsed.negative) {
        if (totalSec % 86_400 === 0) canon = `TRIGGER:-P${totalSec / 86_400}D`;
        else if (totalSec % 60 === 0) canon = `TRIGGER:-PT${totalSec / 60}M`;
      }
    }
    if (!seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

export interface ReminderInstance {
  kind: "task" | "checklist" | "habit" | "countdown" | "dailySummary";
  targetId: string;
  taskId?: string;
  itemId?: string;
  projectId?: string;
  title: string;
  reminderId?: string;
  trigger?: string;
  occurrenceMs?: number;
  fireAtMs: number;
  fireAt: string;
  isSnooze?: boolean;
  constant?: boolean;
  todayCount?: number;
  overdueCount?: number;
}
