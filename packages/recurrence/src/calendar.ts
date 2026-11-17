import { civilFromDays, daysFromCivil, daysInGregorianMonth } from "./civil";
import { UnsupportedCalendarError } from "./errors";
import type { CalendarPrefix } from "./model";

export interface MonthInfo {
  y: number;
  /** month number as the calendar names it (1..12); a leap month shares the key of the month it follows */
  key: number;
  leap: boolean;
  /** 1-based position in the year */
  ord: number;
  len: number;
  /** epoch day of the first day */
  start: number;
}

export interface Calendar {
  id: string;
  monthsOfYear(y: number): MonthInfo[];
  yearOf(day: number): number;
  /** month + day-of-month of an epoch day */
  locate(day: number): { month: MonthInfo; d: number };
}

class GregorianCalendar implements Calendar {
  id = "gregory";
  private cache = new Map<number, MonthInfo[]>();
  monthsOfYear(y: number): MonthInfo[] {
    let r = this.cache.get(y);
    if (!r) {
      r = [];
      for (let m = 1; m <= 12; m++) r.push({ y, key: m, leap: false, ord: m, len: daysInGregorianMonth(y, m), start: daysFromCivil(y, m, 1) });
      this.cache.set(y, r);
    }
    return r;
  }
  yearOf(day: number): number {
    return civilFromDays(day).y;
  }
  locate(day: number) {
    const { y, m, d } = civilFromDays(day);
    return { month: this.monthsOfYear(y)[m - 1]!, d };
  }
}

interface Fields {
  y: number;
  key: number;
  leap: boolean;
  d: number;
}

class IntlCalendar implements Calendar {
  private fieldCache = new Map<number, Fields>();
  private yearCache = new Map<number, MonthInfo[]>();
  private f: Intl.DateTimeFormat;
  constructor(
    public id: string,
    private icu: string,
    private yearType: "year" | "relatedYear",
    private estimateStart: (y: number) => number,
  ) {
    this.f = new Intl.DateTimeFormat(`en-u-ca-${icu}-nu-latn`, { timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric" });
  }
  private fields(day: number): Fields {
    let r = this.fieldCache.get(day);
    if (!r) {
      let y = NaN, key = NaN, d = NaN, leap = false;
      for (const p of this.f.formatToParts(new Date(day * 86400000 + 43200000))) {
        if (p.type === this.yearType) y = Number(p.value);
        else if (p.type === "month") {
          const mm = /^(\d+)(bis)?$/.exec(p.value);
          if (!mm) throw new UnsupportedCalendarError(this.id, `unexpected month field "${p.value}" from Intl`);
          key = Number(mm[1]);
          leap = mm[2] === "bis";
        } else if (p.type === "day") d = Number(p.value);
      }
      if (Number.isNaN(y) || Number.isNaN(key) || Number.isNaN(d)) throw new UnsupportedCalendarError(this.id, "Intl returned no usable fields");
      r = { y, key, leap, d };
      this.fieldCache.set(day, r);
    }
    return r;
  }
  yearOf(day: number): number {
    return this.fields(day).y;
  }
  monthsOfYear(y: number): MonthInfo[] {
    let r = this.yearCache.get(y);
    if (r) return r;
    let d = this.estimateStart(y);
    while (this.yearOf(d) >= y) d -= 25;
    while (this.yearOf(d) < y) d++;
    r = [];
    let cur: MonthInfo | null = null;
    while (this.yearOf(d) === y) {
      const f = this.fields(d);
      if (!cur || cur.key !== f.key || cur.leap !== f.leap) {
        cur = { y, key: f.key, leap: f.leap, ord: r.length + 1, len: 0, start: d };
        r.push(cur);
      }
      cur.len++;
      d++;
    }
    this.yearCache.set(y, r);
    return r;
  }
  locate(day: number) {
    const f = this.fields(day);
    const month = this.monthsOfYear(f.y).find((m) => m.key === f.key && m.leap === f.leap);
    if (!month) throw new UnsupportedCalendarError(this.id, "month lookup failed");
    return { month, d: f.d };
  }
}

const ISLAMIC_EPOCH = daysFromCivil(622, 7, 16);
const islamicEstimate = (y: number) => Math.floor(ISLAMIC_EPOCH + (y - 1) * 354.36667);
const chineseEstimate = (y: number) => daysFromCivil(y, 2, 1);

const cals = new Map<string, Calendar>();
export function getCalendar(prefix: CalendarPrefix): Calendar {
  const cached = cals.get(prefix);
  if (cached) return cached;
  let c: Calendar;
  switch (prefix) {
    case "RRULE":
      c = new GregorianCalendar();
      break;
    case "LUNAR":
      c = new IntlCalendar("chinese", "chinese", "relatedYear", chineseEstimate);
      break;
    case "HIJRI":
      c = new IntlCalendar("islamic-civil", "islamic-civil", "year", islamicEstimate);
      break;
    case "SAUDI":
      c = new IntlCalendar("islamic-umalqura", "islamic-umalqura", "year", islamicEstimate);
      break;
    default:
      // KOREAN, HEBCAL, SHAKA, PERSIAN, VIETNAM, KUWAITI: no verified mapping, never guess a date.
      throw new UnsupportedCalendarError(prefix);
  }
  cals.set(prefix, c);
  return c;
}
