/**
 * Own rule expander. Works on epoch days of the rule's calendar, never on instants, so DST cannot affect the
 * date arithmetic. The time of day is applied afterwards with wallToInstant().
 * Sequence contract: element 0 is always the start day (RFC 5545: DTSTART is the first instance); the following
 * elements are the pattern days after it, in ascending order, after UNTIL, exDate, skip and COUNT handling.
 */
import { WEEKDAYS, compactDate, dayOfWeek } from "./civil";
import type { Calendar, MonthInfo } from "./calendar";
import type { RepeatModel } from "./model";
import type { Wall } from "./zone";

export const CANDIDATE_CAP = 3000;
const EMPTY_PERIOD_GUARD = 60000;

export interface ScanSpec {
  model: RepeatModel;
  cal: Calendar;
  startDay: number;
  startSec: number;
  untilWall?: Wall | undefined;
  /** number of sequence elements allowed (including element 0); Infinity when unbounded */
  remaining: number;
  exDates: Set<string>;
  drop: (day: number) => boolean;
  leapRepeat: boolean;
  /** 0 = Sunday */
  weekStart: number;
  /** if set (only valid when remaining is Infinity) whole periods ending before this day are skipped */
  fastFrom?: number | undefined;
  cap?: number;
  /** isWorkday(day) for TT_WORKDAY */
  isWorkday: (day: number) => boolean;
}

export interface ScanState {
  truncated: boolean;
}

export interface SeqItem {
  day: number;
  /** position in the series; the start (current instance) is 0 and always counts, even if a filter hides it */
  index: number;
  isStart: boolean;
}

const wdIndex = (d: string) => WEEKDAYS.indexOf(d as (typeof WEEKDAYS)[number]);
const uniqSorted = (a: number[]) => [...new Set(a)].sort((x, y) => x - y);

function applySetPos(sorted: number[], pos: number[]): number[] {
  if (!pos.length) return sorted;
  const out: number[] = [];
  for (const p of pos) {
    const i = p > 0 ? p - 1 : sorted.length + p;
    const v = sorted[i];
    if (i >= 0 && v !== undefined) out.push(v);
  }
  return uniqSorted(out);
}

function monthMatches(m: MonthInfo, byMonth: number[], leapRepeat: boolean): boolean {
  return byMonth.includes(m.key) && (!m.leap || leapRepeat);
}

/** Days of one calendar month selected by BYMONTHDAY / BYDAY, or the implicit start day. */
function monthDays(m: MonthInfo, model: RepeatModel, implicitDay: number): number[] {
  const hasMD = model.byMonthDay.length > 0;
  const hasBD = model.byDay.length > 0;
  let byMd: number[] | null = null;
  if (hasMD || !hasBD) {
    const list = hasMD ? model.byMonthDay : [implicitDay];
    byMd = [];
    for (let d of list) {
      // month-end fallback: day 29..31 beyond the month length lands on the last day
      if (d > m.len && d >= 29) d = m.len;
      const pos = d > 0 ? d : m.len + 1 + d;
      if (pos >= 1 && pos <= m.len) byMd.push(m.start + pos - 1);
    }
  }
  let byBd: number[] | null = null;
  if (hasBD) {
    byBd = [];
    for (const bd of model.byDay) {
      const wd = wdIndex(bd.day);
      const all: number[] = [];
      for (let i = 0; i < m.len; i++) if (dayOfWeek(m.start + i) === wd) all.push(m.start + i);
      if (bd.n === undefined || bd.n === 0) byBd.push(...all);
      else {
        const v = bd.n > 0 ? all[bd.n - 1] : all[all.length + bd.n];
        if (v !== undefined) byBd.push(v);
      }
    }
  }
  if (byMd && byBd) {
    const s = new Set(byBd);
    return uniqSorted(byMd.filter((d) => s.has(d)));
  }
  return uniqSorted((byMd ?? byBd)!);
}

function* rruleDays(spec: ScanSpec): Generator<number> {
  const { model, cal, startDay, weekStart } = spec;
  const interval = Math.max(1, model.interval ?? 1);
  const freq = model.freq;
  const startLoc = cal.locate(startDay);
  const fast = spec.fastFrom;
  let empty = 0;
  const pass = function* (arr: number[]) {
    const res = applySetPos(uniqSorted(arr), model.bySetPos);
    if (res.length === 0 && ++empty > EMPTY_PERIOD_GUARD) throw new StopScan();
    if (res.length) empty = 0;
    for (const d of res) if (d > startDay) yield d;
  };
  const bydayPlain = model.byDay.length ? [...new Set(model.byDay.map((b) => wdIndex(b.day)))] : [dayOfWeek(startDay)];

  try {
    if (freq === "DAILY") {
      let k = fast !== undefined ? Math.max(0, Math.floor((fast - startDay) / interval) - 1) : 0;
      for (;; k++) {
        const day = startDay + k * interval;
        const loc = cal.locate(day);
        let ok = true;
        if (model.byMonth.length && !monthMatches(loc.month, model.byMonth, spec.leapRepeat)) ok = false;
        if (ok && model.byMonthDay.length) {
          ok = model.byMonthDay.some((d) => {
            const dd = d > 0 ? d : loc.month.len + 1 + d;
            return dd === loc.d;
          });
        }
        if (ok && model.byDay.length) ok = model.byDay.some((b) => wdIndex(b.day) === dayOfWeek(day));
        yield* pass(ok ? [day] : []);
      }
    } else if (freq === "WEEKLY") {
      const ws0 = startDay - ((dayOfWeek(startDay) - weekStart + 7) % 7);
      let k = fast !== undefined ? Math.max(0, Math.floor((fast - ws0) / (7 * interval)) - 1) : 0;
      for (;; k++) {
        const base = ws0 + 7 * interval * k;
        const days: number[] = [];
        for (const wd of bydayPlain) {
          const day = base + ((wd - weekStart + 7) % 7);
          const loc = cal.locate(day);
          if (model.byMonth.length && !monthMatches(loc.month, model.byMonth, spec.leapRepeat)) continue;
          if (model.byMonthDay.length && !model.byMonthDay.some((d) => (d > 0 ? d : loc.month.len + 1 + d) === loc.d)) continue;
          days.push(day);
        }
        yield* pass(days);
      }
    } else if (freq === "MONTHLY") {
      let y = startLoc.month.y;
      let idx = startLoc.month.ord - 1;
      for (let j = 0; ; j++) {
        const months = cal.monthsOfYear(y);
        const m = months[idx]!;
        if (j % interval === 0) {
          if (fast !== undefined && m.start + m.len - 1 < fast) {
            /* skipped period */
          } else {
            const ok = !model.byMonth.length || monthMatches(m, model.byMonth, spec.leapRepeat);
            yield* pass(ok ? monthDays(m, model, startLoc.d) : []);
          }
        }
        idx++;
        if (idx >= months.length) {
          y++;
          idx = 0;
        }
      }
    } else if (freq === "YEARLY") {
      const y0 = startLoc.month.y;
      for (let k = 0; ; k++) {
        const y = y0 + k * interval;
        const months = cal.monthsOfYear(y);
        const first = months[0]!;
        const last = months[months.length - 1]!;
        const yStart = first.start;
        const yEnd = last.start + last.len - 1;
        if (fast !== undefined && yEnd < fast) continue;
        const days: number[] = [];
        const hasMonth = model.byMonth.length > 0;
        if (model.byYearDay.length) {
          for (const n of model.byYearDay) {
            const d = n > 0 ? yStart + n - 1 : yEnd + n + 1;
            if (d >= yStart && d <= yEnd) days.push(d);
          }
        } else if (model.byWeekNo.length) {
          const ws = (d: number) => d - ((dayOfWeek(d) - weekStart + 7) % 7);
          const w1of = (start: number) => {
            const s = ws(start);
            return start - s <= 3 ? s : s + 7;
          };
          const w1 = w1of(yStart);
          const nWeeks = Math.round((w1of(yEnd + 1) - w1) / 7);
          for (const wn of model.byWeekNo) {
            const w = wn > 0 ? wn : nWeeks + wn + 1;
            if (w < 1 || w > nWeeks) continue;
            for (const wd of bydayPlain) {
              const d = w1 + 7 * (w - 1) + ((wd - weekStart + 7) % 7);
              if (hasMonth && !monthMatches(cal.locate(d).month, model.byMonth, spec.leapRepeat)) continue;
              days.push(d);
            }
          }
        } else if (!hasMonth && !model.byMonthDay.length && model.byDay.some((b) => b.n !== undefined && b.n !== 0)) {
          for (const bd of model.byDay) {
            const wd = wdIndex(bd.day);
            const all: number[] = [];
            for (let d = yStart; d <= yEnd; d++) if (dayOfWeek(d) === wd) all.push(d);
            if (bd.n === undefined || bd.n === 0) days.push(...all);
            else {
              const v = bd.n > 0 ? all[bd.n - 1] : all[all.length + bd.n];
              if (v !== undefined) days.push(v);
            }
          }
        } else {
          const anyBy = model.byMonthDay.length > 0 || model.byDay.length > 0;
          const chosen = hasMonth
            ? months.filter((m) => monthMatches(m, model.byMonth, spec.leapRepeat))
            : anyBy
              ? months
              : months.filter((m) => monthMatches(m, [startLoc.month.key], spec.leapRepeat));
          for (const m of chosen) days.push(...monthDays(m, model, startLoc.d));
        }
        yield* pass(days);
      }
    }
  } catch (e) {
    if (!(e instanceof StopScan)) throw e;
  }
}

class StopScan extends Error {}

/** TT_WORKDAY: first (1) or last (-1) workday of every INTERVAL-th calendar month. */
function* workdayDays(spec: ScanSpec): Generator<number> {
  const { model, cal, startDay } = spec;
  const interval = Math.max(1, model.interval ?? 1);
  const startLoc = cal.locate(startDay);
  let y = startLoc.month.y;
  let idx = startLoc.month.ord - 1;
  let empty = 0;
  for (let j = 0; ; j++) {
    const months = cal.monthsOfYear(y);
    const m = months[idx]!;
    if (j % interval === 0) {
      let found: number | undefined;
      if (model.workday === 1) {
        for (let i = 0; i < m.len; i++) if (spec.isWorkday(m.start + i)) { found = m.start + i; break; }
      } else {
        for (let i = m.len - 1; i >= 0; i--) if (spec.isWorkday(m.start + i)) { found = m.start + i; break; }
      }
      if (found === undefined) {
        if (++empty > 1200) return;
      } else {
        empty = 0;
        if (found > startDay) yield found;
      }
    }
    idx++;
    if (idx >= months.length) { y++; idx = 0; }
  }
}

function* customDays(spec: ScanSpec): Generator<number> {
  if (spec.model.erule?.name !== "CUSTOM") return;
  const days = spec.model.erule.byDate
    .filter((s) => /^\d{8}$/.test(s))
    .map((s) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)) / 86400000);
  for (const d of uniqSorted(days)) if (d > spec.startDay) yield d;
}

const FC_GAPS = [1, 1, 2, 3, 8];
export const FORGETTING_CURVE_STEPS = [0, 1, 2, 4, 7, 15];
export function forgettingCurveGap(cycle: number): number {
  return FC_GAPS[Math.max(0, cycle)] ?? 15;
}
function* curveDays(spec: ScanSpec): Generator<number> {
  if (spec.model.erule?.name !== "FORGETTINGCURVE") return;
  let day = spec.startDay;
  for (let c = Math.max(0, spec.model.erule.cycle); ; c++) {
    day += forgettingCurveGap(c);
    yield day;
  }
}

function rawDays(spec: ScanSpec): Generator<number> {
  if (spec.model.prefix === "ERULE") return spec.model.erule?.name === "CUSTOM" ? customDays(spec) : curveDays(spec);
  if (spec.model.workday !== undefined && spec.model.freq === "MONTHLY") return workdayDays(spec);
  return rruleDays(spec);
}

function afterUntil(day: number, spec: ScanSpec): boolean {
  const u = spec.untilWall;
  if (!u) return false;
  return day > u.day || (day === u.day && spec.startSec > u.sec);
}

export function* scan(spec: ScanSpec, state: ScanState): Generator<SeqItem> {
  const cap = spec.cap ?? CANDIDATE_CAP;
  let counted = 0;
  let examined = 0;
  const gen = rawDays(spec);
  let first = true;
  for (;;) {
    let day: number;
    const isStart = first;
    if (first) {
      day = spec.startDay;
      first = false;
    } else {
      const n = gen.next();
      if (n.done) return;
      day = n.value;
    }
    if (++examined > cap) {
      state.truncated = true;
      return;
    }
    if (afterUntil(day, spec)) return;
    const hidden = spec.exDates.has(compactDate(day)) || spec.drop(day);
    if (hidden && !isStart) continue;
    if (counted >= spec.remaining) return;
    const index = counted;
    counted++;
    if (!hidden) yield { day, index, isStart };
  }
}
