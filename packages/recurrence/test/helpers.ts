import { isoDate } from "../src/civil";
import type { HolidayProvider, RecurrenceContext, RecurringObject } from "../src/model";
import { occurrences } from "../src/recurrence";
import { instantToWall, wallToInstant } from "../src/zone";

export const AMS = "Europe/Amsterdam";
export const NY = "America/New_York";

/** at("Europe/Amsterdam", "2026-11-16 09:00") -> instant */
export function at(zone: string, s: string): Date {
  const [d, t = "00:00"] = s.split(" ") as [string, string?];
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  const [h, mi] = t.split(":").map(Number) as [number, number];
  return new Date(wallToInstant(zone, { day: Date.UTC(y, m - 1, dd) / 86400000, sec: h * 3600 + mi * 60 }));
}

/** instant -> "YYYY-MM-DD HH:mm" in zone */
export function wall(zone: string, d: Date): string {
  const w = instantToWall(zone, d.getTime());
  const h = Math.floor(w.sec / 3600), mi = Math.floor((w.sec % 3600) / 60);
  return `${isoDate(w.day)} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}
export const day = (zone: string, d: Date) => wall(zone, d).slice(0, 10);
export const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Holidays: 25 and 26 Dec 2026 and 1 Jan 2027 are days off, Sat 19 Dec 2026 is a make-up workday. */
export const holidays: HolidayProvider = {
  isHoliday: (d) => ["2026-12-25", "2026-12-26", "2027-01-01"].includes(d),
  isWorkday: (d) => {
    if (d === "2026-12-19") return true;
    if (["2026-12-25", "2026-12-26", "2027-01-01"].includes(d)) return false;
    const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
    const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    return dow !== 0 && dow !== 6;
  },
};

export function obj(flag: string, start: string, o: Partial<RecurringObject> & { zone?: string } = {}): RecurringObject {
  const zone = o.zone ?? AMS;
  const { zone: _z, ...rest } = o;
  return { repeatFlag: flag, repeatFrom: "0", startDate: at(zone, start), timeZoneId: zone, ...rest };
}

/** next n occurrences as "YYYY-MM-DD" (zone default Amsterdam, mode "0") */
export function seq(flag: string, start: string, n: number, o: Partial<RecurringObject> & { zone?: string } = {}, ctx: RecurrenceContext = {}): string[] {
  const zone = o.zone ?? AMS;
  return occurrences(obj(flag, start, o), n, ctx).map((d) => day(zone, d));
}
