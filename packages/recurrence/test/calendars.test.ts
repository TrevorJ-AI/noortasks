import { describe, expect, it } from "vitest";
import {
  InvalidRepeatRuleError,
  UnsupportedCalendarError,
  nextOccurrence,
  occurrences,
  occurrencesBetween,
  parseRepeatFlag,
  serializeRepeatFlag,
} from "../src/index";
import { AMS, at, day, obj, seq } from "./helpers";

function parts(cal: string, d: Date) {
  const f = new Intl.DateTimeFormat(`en-u-ca-${cal}-nu-latn`, { timeZone: AMS, year: "numeric", month: "numeric", day: "numeric" });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return o;
}
const ctx = { deviceZone: AMS };

describe("alternate calendars: parse + round trip for every prefix", () => {
  it.each(["LUNAR", "KOREAN", "HEBCAL", "SHAKA", "PERSIAN", "VIETNAM", "HIJRI", "KUWAITI", "SAUDI"])("%s", (p) => {
    const s = `${p}:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15;COUNT=3`;
    expect(serializeRepeatFlag(parseRepeatFlag(s)!)).toBe(s);
  });
});

describe("unsupported calendars never return a wrong date", () => {
  it.each(["KOREAN", "HEBCAL", "SHAKA", "PERSIAN", "VIETNAM", "KUWAITI"])("%s throws UnsupportedCalendarError", (p) => {
    const o = obj(`${p}:FREQ=YEARLY;INTERVAL=1;BYMONTH=1;BYMONTHDAY=1`, "2026-11-16 09:00");
    expect(() => nextOccurrence(o)).toThrow(UnsupportedCalendarError);
    expect(() => occurrences(o, 3)).toThrow(UnsupportedCalendarError);
    expect(() => occurrencesBetween(o, 0, 1e13)).toThrow(UnsupportedCalendarError);
  });
  it("the error carries the calendar name", () => {
    try {
      nextOccurrence(obj("PERSIAN:FREQ=YEARLY", "2026-11-16 09:00"));
      expect.unreachable();
    } catch (e) {
      expect((e as UnsupportedCalendarError).calendar).toBe("PERSIAN");
    }
  });
});

describe("LUNAR (Intl chinese calendar)", () => {
  const cny = "LUNAR:FREQ=YEARLY;INTERVAL=1;BYMONTH=1;BYMONTHDAY=1";
  it("Chinese New Year 2023 -> 2024 -> 2025 -> 2026", () => {
    expect(seq(cny, "2023-01-22 09:00", 3, {}, ctx)).toEqual(["2024-02-10", "2025-01-29", "2026-02-17"]);
  });
  it("KNOWN ICU DEFECT (see OPEN-QUESTIONS): Node's ICU puts CNY 2027 on Feb 7 and CNY 2030 on Feb 2, published tables say Feb 6 and Feb 3", () => {
    const r = seq(cny, "2026-02-17 09:00", 4, {}, ctx);
    expect(r[1]).toBe("2028-01-26");
    expect(r[2]).toBe("2029-02-13");
    expect(["2027-02-06", "2027-02-07"]).toContain(r[0]); // documents the platform value, not the truth
  });
  it("lunar yearly via implicit date", () => {
    expect(seq("LUNAR:FREQ=YEARLY;INTERVAL=1", "2023-01-22 09:00", 2, {}, ctx)).toEqual(["2024-02-10", "2025-01-29"]);
  });
  it("every 2 lunar years", () => {
    expect(seq("LUNAR:FREQ=YEARLY;INTERVAL=2;BYMONTH=1;BYMONTHDAY=1", "2020-01-25 09:00", 2, {}, ctx)).toEqual(["2022-02-01", "2024-02-10"]);
  });
  it("leap month: BYMONTH=2 fires in 2/1 and in leap 2/1 by default (2023 has a leap 2nd month)", () => {
    expect(seq("LUNAR:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1", "2022-03-03 09:00", 3, {}, ctx)).toEqual(["2023-02-20", "2023-03-22", "2024-03-10"]);
  });
  it("leap month repeat switched off", () => {
    expect(seq("LUNAR:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=1", "2022-03-03 09:00", 2, {}, { ...ctx, lunarLeapMonthRepeat: false })).toEqual(["2023-02-20", "2024-03-10"]);
  });
  it("monthly on the 1st of every lunar month, leap months included", () => {
    expect(seq("LUNAR:FREQ=MONTHLY;BYMONTHDAY=1", "2023-02-20 09:00", 3, {}, ctx)).toEqual(["2023-03-22", "2023-04-20", "2023-05-19"]);
  });
  it("lunar last day (BYMONTHDAY=-1) is the day before the next new moon", () => {
    const r = occurrences(obj("LUNAR:FREQ=MONTHLY;BYMONTHDAY=-1", "2026-11-01 09:00"), 6, ctx);
    for (const d of r) {
      const next = new Date(d.getTime() + 86400000 * 1.0);
      expect(parts("chinese", next).day).toBe("1");
    }
  });
  it("every date produced is on the requested lunar day", () => {
    const r = occurrences(obj("LUNAR:FREQ=MONTHLY;BYMONTHDAY=15", "2026-11-16 09:00"), 15, ctx);
    for (const d of r) expect(parts("chinese", d).day).toBe("15");
    expect(r).toHaveLength(15);
  });
  it("day 30 clamps to the last day of 29-day lunar months", () => {
    const r = occurrences(obj("LUNAR:FREQ=MONTHLY;BYMONTHDAY=30", "2026-11-16 09:00"), 12, ctx);
    for (const d of r) {
      const next = new Date(d.getTime() + 86400000);
      expect(parts("chinese", next).day).toBe("1");
    }
  });
  it("daily rule inside the lunar calendar with BYMONTHDAY filter", () => {
    const r = occurrences(obj("LUNAR:FREQ=DAILY;BYMONTHDAY=1", "2026-11-16 09:00"), 3, ctx);
    for (const d of r) expect(parts("chinese", d).day).toBe("1");
  });
  it("lunar day 31 is rejected", () => {
    expect(() => nextOccurrence(obj("LUNAR:FREQ=MONTHLY;BYMONTHDAY=31", "2026-11-16 09:00"), ctx)).toThrow(InvalidRepeatRuleError);
  });
  it("lunar weekly is the same as gregorian weekly", () => {
    expect(seq("LUNAR:FREQ=WEEKLY;BYDAY=MO", "2026-11-16 09:00", 2, {}, ctx)).toEqual(["2026-11-23", "2026-11-30"]);
  });
  it("COUNT works in alt calendars", () => {
    expect(seq(cny + ";COUNT=2", "2023-01-22 09:00", 5, {}, ctx)).toEqual(["2024-02-10"]);
  });
  it("window query", () => {
    const o = obj(cny, "2020-01-25 09:00");
    expect(occurrencesBetween(o, at(AMS, "2023-01-01 00:00"), at(AMS, "2025-12-31 00:00"), ctx).map((d) => day(AMS, d))).toEqual(["2023-01-22", "2024-02-10", "2025-01-29"]);
  });
});

describe("HIJRI (islamic-civil) and SAUDI (umalqura)", () => {
  it("1 Ramadan lands on month 9 day 1 each year", () => {
    const flag = "HIJRI:FREQ=YEARLY;INTERVAL=1;BYMONTH=9;BYMONTHDAY=1";
    const r = occurrences(obj(flag, "2023-03-23 09:00"), 5, ctx);
    expect(r).toHaveLength(5);
    for (const d of r) {
      const p = parts("islamic-civil", d);
      expect(p.month).toBe("9");
      expect(p.day).toBe("1");
    }
    const years = r.map((d) => Number(parts("islamic-civil", d).year));
    expect(years).toEqual([1445, 1446, 1447, 1448, 1449]);
  });
  it("start in the civil calendar: 2023-03-23 is 1 Ramadan 1444", () => {
    expect(parts("islamic-civil", at(AMS, "2023-03-23 09:00")).month).toBe("9");
    expect(parts("islamic-civil", at(AMS, "2023-03-23 09:00")).day).toBe("1");
  });
  it("Hijri monthly 15th", () => {
    const r = occurrences(obj("HIJRI:FREQ=MONTHLY;BYMONTHDAY=15", "2026-11-16 09:00"), 14, ctx);
    for (const d of r) expect(parts("islamic-civil", d).day).toBe("15");
    expect(r).toHaveLength(14);
  });
  it("consecutive Hijri months are about 29.5 days apart", () => {
    const r = occurrences(obj("HIJRI:FREQ=MONTHLY;BYMONTHDAY=1", "2026-11-16 09:00"), 6, ctx);
    for (let i = 1; i < r.length; i++) {
      const gap = Math.round((r[i]!.getTime() - r[i - 1]!.getTime()) / 86400000);
      expect([29, 30]).toContain(gap);
    }
  });
  it("Hijri last day of month", () => {
    const r = occurrences(obj("HIJRI:FREQ=MONTHLY;BYMONTHDAY=-1", "2026-11-16 09:00"), 6, ctx);
    for (const d of r) expect(parts("islamic-civil", new Date(d.getTime() + 86400000)).day).toBe("1");
  });
  it("Hijri implicit date, every 2 years", () => {
    const r = occurrences(obj("HIJRI:FREQ=YEARLY;INTERVAL=2", "2026-11-16 09:00"), 2, ctx);
    const p0 = parts("islamic-civil", at(AMS, "2026-11-16 09:00"));
    for (const d of r) {
      expect(parts("islamic-civil", d).month).toBe(p0.month);
      expect(parts("islamic-civil", d).day).toBe(p0.day);
    }
    expect(Number(parts("islamic-civil", r[1]!).year) - Number(parts("islamic-civil", r[0]!).year)).toBe(2);
  });
  it("SAUDI uses umalqura", () => {
    const r = occurrences(obj("SAUDI:FREQ=YEARLY;BYMONTH=9;BYMONTHDAY=1", "2023-03-24 09:00"), 3, ctx);
    for (const d of r) {
      const p = parts("islamic-umalqura", d);
      expect(p.month).toBe("9");
      expect(p.day).toBe("1");
    }
  });
  it("HIJRI day 30 falls back to the last day of 29-day months", () => {
    const r = occurrences(obj("HIJRI:FREQ=MONTHLY;BYMONTHDAY=30", "2026-11-16 09:00"), 12, ctx);
    for (const d of r) {
      const p = parts("islamic-civil", new Date(d.getTime() + 86400000));
      expect(p.day).toBe("1");
    }
  });
  it("Hijri window", () => {
    const o = obj("HIJRI:FREQ=MONTHLY;BYMONTHDAY=1", "2026-11-16 09:00");
    const r = occurrencesBetween(o, at(AMS, "2027-01-01 00:00"), at(AMS, "2027-12-31 00:00"), ctx);
    expect(r.length).toBeGreaterThanOrEqual(12);
  });
});
