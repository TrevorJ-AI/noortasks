import { civilFromDays, compactDate, dayOfWeek, isoDate, WEEKDAYS } from "./civil";
import { getCalendar } from "./calendar";
import { toMs } from "./dates";
import { InvalidRepeatRuleError, UnsupportedRuleError } from "./errors";
import { scan, type ScanSpec, type ScanState } from "./expand";
import { parseRepeatFlag, validateRepeatModel } from "./flag";
import type { HolidayProvider, RecurrenceContext, RecurringObject, RepeatFrom, RepeatModel } from "./model";
import { instantToWall, wallToInstant, type Wall } from "./zone";

export const weekendOnlyProvider: HolidayProvider = {
  isHoliday: () => false,
  isWorkday: (date) => {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return dow !== 0 && dow !== 6;
  },
};

export interface Resolved {
  model: RepeatModel;
  zone: string;
  mode: RepeatFrom;
  spec: ScanSpec;
  /** start as given */
  start: Wall;
  startMs: number;
}

export function effectiveMode(repeatFrom: string | null | undefined): RepeatFrom {
  if (repeatFrom === "0" || repeatFrom === "1" || repeatFrom === "2") return repeatFrom;
  if (repeatFrom === "3") return "0";
  return "2";
}

/** Mode "1": only FREQ + INTERVAL apply (BYDAY, BYMONTHDAY and every other BY* part are ignored). */
export function clearForCompletionMode(m: RepeatModel): RepeatModel {
  return { ...m, byDay: [], byMonthDay: [], byMonth: [], byYearDay: [], byWeekNo: [], bySetPos: [] };
}

function untilToWall(until: string, zone: string): Wall {
  const y = +until.slice(0, 4), mo = +until.slice(4, 6), d = +until.slice(6, 8);
  const day = Date.UTC(y, mo - 1, d) / 86400000;
  if (until.length === 8) return { day, sec: 86399 };
  const hour = +until.slice(9, 11);
  const sec = +until.slice(11, 13) * 60 + +until.slice(13, 15);
  let w: Wall = { day, sec: hour * 3600 + sec };
  if (until.endsWith("Z")) w = instantToWall(zone, Date.UTC(y, mo - 1, d, hour, +until.slice(11, 13), +until.slice(13, 15)));
  // hour != 0: "start of that day minus 1 s"; hour == 0: the whole day counts
  return hour !== 0 ? { day: w.day - 1, sec: 86399 } : { day: w.day, sec: 86399 };
}

function dayToIso(day: number) {
  return isoDate(day);
}

/** Skip predicate for TT_SKIP (see holiday/weekend skip rules). */
export function skipPredicate(model: RepeatModel, provider: HolidayProvider): (day: number) => boolean {
  const skip = model.skip;
  if (!skip.length) return () => false;
  const hol = skip.includes("HOLIDAY");
  const wk = skip.includes("WEEKEND");
  const ow = skip.includes("OFFICIAL_WORKDAY");
  return (day) => {
    const iso = dayToIso(day);
    const dow = dayOfWeek(day);
    const weekend = dow === 0 || dow === 6;
    if (ow && provider.isWorkday(iso)) return true;
    if (hol && wk) return !provider.isWorkday(iso);
    if (hol && provider.isHoliday(iso)) return true;
    if (wk && weekend) return true;
    return false;
  };
}

export function dayOfInstant(zone: string, ms: number): number {
  return instantToWall(zone, ms).day;
}

export interface ResolveOpts {
  /** anchor mode "1" at the completion day (next/occurrences). Windows pass false. */
  anchorCompletion: boolean;
  fastFrom?: number | undefined;
}

export function resolve(obj: RecurringObject, ctx: RecurrenceContext, opts: ResolveOpts): Resolved | null {
  const parsed = parseRepeatFlag(obj.repeatFlag);
  if (!parsed) return null;
  const problems = validateRepeatModel(parsed);
  if (problems.length) throw new InvalidRepeatRuleError(problems.join("; "));
  if (parsed.prefix !== "ERULE") {
    if (parsed.freq !== "DAILY" && parsed.freq !== "WEEKLY" && parsed.freq !== "MONTHLY" && parsed.freq !== "YEARLY")
      throw new UnsupportedRuleError(`FREQ=${parsed.freq} is not supported (the editor only produces DAILY, WEEKLY, MONTHLY, YEARLY)`);
    if (parsed.byHour.length || parsed.byMinute.length || parsed.bySecond.length)
      throw new UnsupportedRuleError("BYHOUR / BYMINUTE / BYSECOND are not supported for generation");
    if ("BYEASTER" in parsed.extras) throw new UnsupportedRuleError("BYEASTER is not supported");
  }
  const cal = getCalendar(parsed.prefix === "ERULE" || parsed.prefix === null ? "RRULE" : parsed.prefix);
  const zone = obj.timeZoneId || ctx.deviceZone || "UTC";
  const mode = effectiveMode(obj.repeatFrom);
  const startMs = toMs(obj.startDate);
  const start = instantToWall(zone, startMs);
  let model = parsed;
  let anchor = start;
  if (mode === "1") {
    model = clearForCompletionMode(parsed);
    if (opts.anchorCompletion) {
      if (obj.completedTime == null) return null;
      anchor = { day: instantToWall(zone, toMs(obj.completedTime)).day, sec: start.sec };
    }
  }
  const provider = ctx.holidays ?? weekendOnlyProvider;
  const ex = new Set<string>();
  if (obj.exDates) for (const e of obj.exDates) ex.add(e.replace(/-/g, "").slice(0, 8));
  const remaining = parsed.count !== undefined ? Math.max(0, parsed.count - Math.max(0, parsed.completedCount)) : Infinity;
  const wk = ctx.defaultWeekStart ?? "MO";
  const spec: ScanSpec = {
    model,
    cal,
    startDay: anchor.day,
    startSec: anchor.sec,
    untilWall: parsed.until ? untilToWall(parsed.until, zone) : undefined,
    remaining,
    exDates: ex,
    drop: skipPredicate(parsed, provider),
    leapRepeat: ctx.lunarLeapMonthRepeat ?? true,
    weekStart: WEEKDAYS.indexOf(parsed.wkst ?? wk),
    fastFrom: remaining === Infinity ? opts.fastFrom : undefined,
    isWorkday: (d) => provider.isWorkday(isoDate(d)),
  };
  return { model: parsed, zone, mode, spec, start, startMs };
}

export interface Occurrence {
  date: Date;
  /** position in the series counted from the anchor (0 = the anchor itself) */
  index: number;
}

function toDate(r: Resolved, day: number): number {
  return wallToInstant(r.zone, { day, sec: r.spec.startSec });
}

function todayDayFor(obj: RecurringObject, ctx: RecurrenceContext, zone: string): number {
  const ref = ctx.now ?? obj.completedTime;
  if (ref == null) throw new RangeError('repeatFrom "2" needs ctx.now (or completedTime) to know today');
  return instantToWall(zone, toMs(ref)).day;
}

/** Internal: the next `limit` occurrences strictly after the current start, with series positions. */
export function followingOccurrences(obj: RecurringObject, limit: number, ctx: RecurrenceContext = {}): { items: Occurrence[]; truncated: boolean } {
  const zoneGuess = obj.timeZoneId || ctx.deviceZone || "UTC";
  const mode = effectiveMode(obj.repeatFrom);
  const today = mode === "2" && obj.repeatFlag ? todayDayFor(obj, ctx, zoneGuess) : undefined;
  const r = resolve(obj, ctx, { anchorCompletion: true, fastFrom: today });
  if (!r || limit <= 0) return { items: [], truncated: false };
  const state: ScanState = { truncated: false };
  const items: Occurrence[] = [];
  for (const it of scan(r.spec, state)) {
    if (it.isStart) continue; // element 0 is the current instance
    if (today !== undefined && it.day < today) continue;
    items.push({ date: new Date(toDate(r, it.day)), index: it.index });
    if (items.length >= limit) break;
  }
  return { items, truncated: state.truncated };
}

/** The next occurrence after the current start (mode "2": and on/after today), or null. */
export function nextOccurrence(obj: RecurringObject, ctx: RecurrenceContext = {}): Date | null {
  return followingOccurrences(obj, 1, ctx).items[0]?.date ?? null;
}

/** The next `limit` occurrences (default 3). */
export function occurrences(obj: RecurringObject, limit = 3, ctx: RecurrenceContext = {}): Date[] {
  return followingOccurrences(obj, limit, ctx).items.map((i) => i.date);
}

/**
 * All occurrences with from <= instant <= to, including the start itself when it falls in the window.
 * No "advance to today", no completion anchor: this is the calendar projection. COUNT consumed before `from`
 * stays consumed.
 */
export function occurrencesBetween(obj: RecurringObject, from: Date | number | string, to: Date | number | string, ctx: RecurrenceContext = {}): Date[] {
  const fromMs = toMs(from);
  const toMsV = toMs(to);
  const zone = obj.timeZoneId || ctx.deviceZone || "UTC";
  const r = resolve(obj, ctx, { anchorCompletion: false, fastFrom: instantToWall(zone, fromMs).day - 1 });
  if (!r) return [];
  const out: Date[] = [];
  const state: ScanState = { truncated: false };
  for (const it of scan(r.spec, state)) {
    const ms = toDate(r, it.day);
    if (ms > toMsV) break;
    if (ms >= fromMs) out.push(new Date(ms));
  }
  return out;
}

/** True when the series continues after the current instance ("will it repeat again"). */
export function willRepeatAgain(obj: RecurringObject, ctx: RecurrenceContext = {}): boolean {
  return nextOccurrence(obj, ctx) !== null;
}

export { civilFromDays, compactDate };
