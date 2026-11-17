import { describe, expect, it } from "vitest";
import { CANDIDATE_CAP, nextOccurrence, occurrences, occurrencesBetween, UnsupportedRuleError } from "../src/index";
import { AMS, NY, at, day, iso, obj, seq, wall } from "./helpers";

type Row = [name: string, flag: string, start: string, n: number, expected: string[]];

describe("daily / weekly / monthly / yearly (mode 0)", () => {
  const rows: Row[] = [
    ["daily", "RRULE:FREQ=DAILY;INTERVAL=1", "2026-11-16 09:00", 3, ["2026-11-17", "2026-11-18", "2026-11-19"]],
    ["daily interval 3", "RRULE:FREQ=DAILY;INTERVAL=3", "2026-11-16 09:00", 3, ["2026-11-19", "2026-11-22", "2026-11-25"]],
    ["daily crossing month end", "RRULE:FREQ=DAILY;INTERVAL=1", "2026-11-29 09:00", 3, ["2026-11-30", "2026-12-01", "2026-12-02"]],
    ["daily crossing year end", "RRULE:FREQ=DAILY;INTERVAL=1", "2026-12-30 09:00", 3, ["2026-12-31", "2027-01-01", "2027-01-02"]],
    ["daily across leap day", "RRULE:FREQ=DAILY;INTERVAL=1", "2028-02-28 09:00", 3, ["2028-02-29", "2028-03-01", "2028-03-02"]],
    ["daily weekdays by BYDAY", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", "2026-11-20 09:00", 3, ["2026-11-23", "2026-11-24", "2026-11-25"]],
    ["daily BYMONTH", "RRULE:FREQ=DAILY;BYMONTH=12", "2026-11-30 09:00", 2, ["2026-12-01", "2026-12-02"]],
    ["weekly implicit weekday", "RRULE:FREQ=WEEKLY;INTERVAL=1", "2026-11-16 09:00", 3, ["2026-11-23", "2026-11-30", "2026-12-07"]],
    ["weekly MO,WE", "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE", "2026-11-16 09:00", 4, ["2026-11-18", "2026-11-23", "2026-11-25", "2026-11-30"]],
    ["weekly every 2 weeks MO,WE", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "2026-11-16 09:00", 3, ["2026-11-18", "2026-11-30", "2026-12-02"]],
    ["weekly WKST=MO SU,MO biweekly", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=MO", "2026-11-15 09:00", 4, ["2026-11-23", "2026-11-29", "2026-12-07", "2026-12-13"]],
    ["weekly WKST=SU SU,MO biweekly", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO;WKST=SU", "2026-11-15 09:00", 4, ["2026-11-16", "2026-11-29", "2026-11-30", "2026-12-13"]],
    ["weekly weekend", "RRULE:FREQ=WEEKLY;BYDAY=SA,SU", "2026-11-14 09:00", 3, ["2026-11-15", "2026-11-21", "2026-11-22"]],
    ["weekly start not on BYDAY", "RRULE:FREQ=WEEKLY;BYDAY=MO", "2026-11-18 09:00", 2, ["2026-11-23", "2026-11-30"]],
    ["monthly BYMONTHDAY=15", "RRULE:FREQ=MONTHLY;BYMONTHDAY=15", "2026-11-15 09:00", 3, ["2026-12-15", "2027-01-15", "2027-02-15"]],
    ["monthly implicit day", "RRULE:FREQ=MONTHLY;INTERVAL=1", "2026-11-10 09:00", 3, ["2026-12-10", "2027-01-10", "2027-02-10"]],
    ["monthly 1st and 15th", "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15", "2026-11-15 09:00", 3, ["2026-12-01", "2026-12-15", "2027-01-01"]],
    ["monthly every 3 months", "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10", "2026-11-10 09:00", 3, ["2027-02-10", "2027-05-10", "2027-08-10"]],
    ["monthly last day", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1", "2027-01-31 09:00", 4, ["2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]],
    ["monthly second to last day", "RRULE:FREQ=MONTHLY;BYMONTHDAY=-2", "2027-01-30 09:00", 2, ["2027-02-27", "2027-03-30"]],
    ["monthly 2nd Sunday", "RRULE:FREQ=MONTHLY;BYDAY=2SU", "2026-11-08 09:00", 3, ["2026-12-13", "2027-01-10", "2027-02-14"]],
    ["monthly last Friday", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "2026-11-27 09:00", 3, ["2026-12-25", "2027-01-29", "2027-02-26"]],
    ["monthly first Monday", "RRULE:FREQ=MONTHLY;BYDAY=1MO", "2026-11-02 09:00", 3, ["2026-12-07", "2027-01-04", "2027-02-01"]],
    ["monthly every Tuesday of the month", "RRULE:FREQ=MONTHLY;BYDAY=TU", "2026-11-24 09:00", 3, ["2026-12-01", "2026-12-08", "2026-12-15"]],
    ["monthly last weekday (BYSETPOS=-1)", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "2026-11-30 09:00", 3, ["2026-12-31", "2027-01-29", "2027-02-26"]],
    ["monthly first weekday (BYSETPOS=1)", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1", "2026-12-01 09:00", 3, ["2027-01-01", "2027-02-01", "2027-03-01"]],
    ["monthly 2nd-last weekday (BYSETPOS=-2)", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2", "2026-11-27 09:00", 2, ["2026-12-30", "2027-01-28"]],
    ["monthly BYMONTHDAY with BYDAY intersect (Friday 13th)", "RRULE:FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR", "2026-11-13 09:00", 2, ["2027-08-13", "2028-10-13"]],
    ["yearly implicit", "RRULE:FREQ=YEARLY;INTERVAL=1", "2026-11-15 09:00", 3, ["2027-11-15", "2028-11-15", "2029-11-15"]],
    ["yearly every 2 years", "RRULE:FREQ=YEARLY;INTERVAL=2", "2026-11-15 09:00", 2, ["2028-11-15", "2030-11-15"]],
    ["yearly March 4", "RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=4", "2026-03-04 09:00", 2, ["2027-03-04", "2028-03-04"]],
    ["yearly Mother's Day (2nd Sunday of May)", "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=5;BYDAY=2SU", "2026-05-10 09:00", 2, ["2027-05-09", "2028-05-14"]],
    ["yearly Thanksgiving (4th Thursday of Nov)", "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYDAY=4TH", "2026-11-26 09:00", 2, ["2027-11-25", "2028-11-23"]],
    ["yearly two months", "RRULE:FREQ=YEARLY;BYMONTH=1,7;BYMONTHDAY=1", "2026-07-01 09:00", 3, ["2027-01-01", "2027-07-01", "2028-01-01"]],
    ["yearly BYYEARDAY", "RRULE:FREQ=YEARLY;BYYEARDAY=1,100", "2027-01-01 09:00", 3, ["2027-04-10", "2028-01-01", "2028-04-09"]],
    ["yearly Nth weekday of the year", "RRULE:FREQ=YEARLY;BYDAY=20MO", "2026-05-18 09:00", 2, ["2027-05-17", "2028-05-15"]],
    ["yearly BYWEEKNO", "RRULE:FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO", "2026-05-11 09:00", 2, ["2027-05-17", "2028-05-15"]],
    ["yearly BYMONTHDAY every month", "RRULE:FREQ=YEARLY;BYMONTHDAY=1", "2026-11-01 09:00", 3, ["2026-12-01", "2027-01-01", "2027-02-01"]],
  ];
  it.each(rows)("%s", (_n, flag, start, n, expected) => {
    expect(seq(flag, start, n)).toEqual(expected);
  });
});

describe("month-end fallback and Feb 29 (parity traps)", () => {
  const rows: Row[] = [
    ["BYMONTHDAY=31", "RRULE:FREQ=MONTHLY;BYMONTHDAY=31", "2026-12-31 09:00", 5, ["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]],
    ["BYMONTHDAY=30", "RRULE:FREQ=MONTHLY;BYMONTHDAY=30", "2027-01-30 09:00", 3, ["2027-02-28", "2027-03-30", "2027-04-30"]],
    ["BYMONTHDAY=29", "RRULE:FREQ=MONTHLY;BYMONTHDAY=29", "2027-01-29 09:00", 3, ["2027-02-28", "2027-03-29", "2027-04-29"]],
    ["BYMONTHDAY=29 in a leap year", "RRULE:FREQ=MONTHLY;BYMONTHDAY=29", "2028-01-29 09:00", 3, ["2028-02-29", "2028-03-29", "2028-04-29"]],
    ["BYMONTHDAY=31 never lands on 29 or 30 of a long month", "RRULE:FREQ=MONTHLY;BYMONTHDAY=29", "2027-03-29 09:00", 2, ["2027-04-29", "2027-05-29"]],
    ["implicit day 31", "RRULE:FREQ=MONTHLY;INTERVAL=1", "2027-01-31 09:00", 4, ["2027-02-28", "2027-03-31", "2027-04-30", "2027-05-31"]],
    ["implicit day 30", "RRULE:FREQ=MONTHLY;INTERVAL=1", "2027-01-30 09:00", 3, ["2027-02-28", "2027-03-30", "2027-04-30"]],
    ["BYMONTHDAY=30,31 dedupes in short months", "RRULE:FREQ=MONTHLY;BYMONTHDAY=30,31", "2027-01-30 09:00", 4, ["2027-01-31", "2027-02-28", "2027-03-30", "2027-03-31"]],
    ["Feb 29 yearly", "RRULE:FREQ=YEARLY;INTERVAL=1", "2028-02-29 09:00", 5, ["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29", "2033-02-28"]],
    ["Feb 29 yearly explicit", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29", "2028-02-29 09:00", 4, ["2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]],
    ["Feb 29 every 4 years", "RRULE:FREQ=YEARLY;INTERVAL=4", "2028-02-29 09:00", 2, ["2032-02-29", "2036-02-29"]],
    ["last day of Feb yearly", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1", "2027-02-28 09:00", 2, ["2028-02-29", "2029-02-28"]],
    ["Feb 30 explicit also falls back", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30", "2027-02-28 09:00", 2, ["2028-02-29", "2029-02-28"]],
    ["day 28 never falls back", "RRULE:FREQ=MONTHLY;BYMONTHDAY=28", "2027-01-28 09:00", 2, ["2027-02-28", "2027-03-28"]],
    ["every 2 months from Dec 31", "RRULE:FREQ=MONTHLY;INTERVAL=2", "2026-12-31 09:00", 3, ["2027-02-28", "2027-04-30", "2027-06-30"]],
  ];
  it.each(rows)("%s", (_n, flag, start, n, expected) => {
    expect(seq(flag, start, n)).toEqual(expected);
  });
});

describe("COUNT, UNTIL, exDate", () => {
  it("COUNT includes the current start", () => {
    expect(seq("RRULE:FREQ=DAILY;COUNT=3", "2026-11-16 09:00", 10)).toEqual(["2026-11-17", "2026-11-18"]);
  });
  it("COUNT=1 yields no further occurrences", () => {
    expect(seq("RRULE:FREQ=DAILY;COUNT=1", "2026-11-16 09:00", 10)).toEqual([]);
    expect(nextOccurrence(obj("RRULE:FREQ=DAILY;COUNT=1", "2026-11-16 09:00"))).toBeNull();
  });
  it("COUNT=2", () => {
    expect(seq("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2", "2026-11-16 09:00", 10)).toEqual(["2026-11-23"]);
  });
  it("TK_COMPLETEDCOUNT reduces the remaining count", () => {
    expect(seq("RRULE:FREQ=DAILY;COUNT=5;TK_COMPLETEDCOUNT=3", "2026-11-16 09:00", 10)).toEqual(["2026-11-17"]);
    expect(seq("RRULE:FREQ=DAILY;COUNT=5;TK_COMPLETEDCOUNT=4", "2026-11-16 09:00", 10)).toEqual([]);
    expect(seq("RRULE:FREQ=DAILY;COUNT=5;TK_COMPLETEDCOUNT=0", "2026-11-16 09:00", 10)).toHaveLength(4);
  });
  it("count handling inside windows: occurrences before the window still consume COUNT", () => {
    const o = obj("RRULE:FREQ=DAILY;COUNT=5", "2026-11-16 09:00");
    const r = occurrencesBetween(o, at(AMS, "2026-11-18 00:00"), at(AMS, "2026-12-31 00:00")).map((d) => day(AMS, d));
    expect(r).toEqual(["2026-11-18", "2026-11-19", "2026-11-20"]);
  });
  it("count inside a window that starts after the series is over is empty", () => {
    const o = obj("RRULE:FREQ=DAILY;COUNT=5", "2026-11-16 09:00");
    expect(occurrencesBetween(o, at(AMS, "2026-12-01 00:00"), at(AMS, "2026-12-31 00:00"))).toEqual([]);
  });
  it("windowed result equals the prefix of the unbounded one (monthly COUNT=6)", () => {
    const o = obj("RRULE:FREQ=MONTHLY;BYMONTHDAY=15;COUNT=6", "2026-11-15 09:00");
    const all = occurrencesBetween(o, at(AMS, "2026-01-01 00:00"), at(AMS, "2030-01-01 00:00")).map((d) => day(AMS, d));
    const win = occurrencesBetween(o, at(AMS, "2027-01-01 00:00"), at(AMS, "2027-03-31 00:00")).map((d) => day(AMS, d));
    expect(all).toEqual(["2026-11-15", "2026-12-15", "2027-01-15", "2027-02-15", "2027-03-15", "2027-04-15"]);
    expect(win).toEqual(["2027-01-15", "2027-02-15", "2027-03-15"]);
  });
  it("UNTIL date is end of that day (inclusive)", () => {
    expect(seq("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261130", "2026-11-16 09:00", 10)).toEqual(["2026-11-23", "2026-11-30"]);
  });
  it("UNTIL the day before excludes it", () => {
    expect(seq("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261129", "2026-11-16 09:00", 10)).toEqual(["2026-11-23"]);
  });
  it("UNTIL is end of day in the TASK zone (late-evening occurrence still inside)", () => {
    expect(seq("RRULE:FREQ=DAILY;UNTIL=20261118", "2026-11-16 23:30", 10)).toEqual(["2026-11-17", "2026-11-18"]);
    expect(seq("RRULE:FREQ=DAILY;UNTIL=20261118", "2026-11-16 23:30", 10, { zone: NY })).toEqual(["2026-11-17", "2026-11-18"]);
  });
  it("UNTIL with a datetime and hour != 0 means start of that day minus 1s", () => {
    // 2026-11-17T23:00Z is 00:00 on 11-18 in Amsterdam: that day is excluded
    expect(seq("RRULE:FREQ=DAILY;UNTIL=20261117T230000Z", "2026-11-16 09:00", 10)).toEqual(["2026-11-17"]);
  });
  it("UNTIL with a datetime at hour 0 behaves like a date", () => {
    expect(seq("RRULE:FREQ=DAILY;UNTIL=20261118T000000Z", "2026-11-16 09:00", 10)).toEqual(["2026-11-17", "2026-11-18"]);
  });
  it("UNTIL before the start yields nothing", () => {
    expect(seq("RRULE:FREQ=DAILY;UNTIL=20261101", "2026-11-16 09:00", 10)).toEqual([]);
  });
  it("exDate removes an occurrence", () => {
    expect(seq("RRULE:FREQ=DAILY", "2026-11-16 09:00", 3, { exDates: ["20261117"] })).toEqual(["2026-11-18", "2026-11-19", "2026-11-20"]);
  });
  it("exDate accepts a Set-like iterable and dashed dates", () => {
    expect(seq("RRULE:FREQ=DAILY", "2026-11-16 09:00", 2, { exDates: new Set(["2026-11-17"]) })).toEqual(["2026-11-18", "2026-11-19"]);
  });
  it("exDates do not consume COUNT", () => {
    expect(seq("RRULE:FREQ=DAILY;COUNT=3", "2026-11-16 09:00", 10, { exDates: ["20261117"] })).toEqual(["2026-11-18", "2026-11-19"]);
  });
  it("exDate compares by calendar day, not instant", () => {
    expect(seq("RRULE:FREQ=DAILY", "2026-11-16 23:30", 2, { exDates: ["20261117"] })).toEqual(["2026-11-18", "2026-11-19"]);
  });
  it("exDate in window queries", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-16 09:00", { exDates: ["20261118"] });
    expect(occurrencesBetween(o, at(AMS, "2026-11-16 00:00"), at(AMS, "2026-11-19 23:00")).map((d) => day(AMS, d))).toEqual(["2026-11-16", "2026-11-17", "2026-11-19"]);
  });
});

describe("candidate cap and fast forward", () => {
  it("hard cap of 3000 candidates per call", () => {
    expect(CANDIDATE_CAP).toBe(3000);
    const o = obj("RRULE:FREQ=DAILY;COUNT=9000", "2010-01-01 09:00");
    expect(occurrencesBetween(o, at(AMS, "2010-01-01 00:00"), at(AMS, "2100-01-01 00:00"))).toHaveLength(3000);
  });
  it("a very old daily series without COUNT jumps straight to the window (no cap hit)", () => {
    const o = obj("RRULE:FREQ=DAILY", "2000-01-01 09:00");
    const r = occurrencesBetween(o, at(AMS, "2026-11-16 00:00"), at(AMS, "2026-11-18 23:00")).map((d) => day(AMS, d));
    expect(r).toEqual(["2026-11-16", "2026-11-17", "2026-11-18"]);
  });
  it("fast forward keeps the INTERVAL phase", () => {
    const o = obj("RRULE:FREQ=DAILY;INTERVAL=7", "2000-01-01 09:00");
    const r = occurrencesBetween(o, at(AMS, "2026-11-01 00:00"), at(AMS, "2026-11-30 00:00")).map((d) => day(AMS, d));
    // 2000-01-01 + 7k: 9830 days apart is divisible by 7? compute from the phase directly
    const startDay = Date.UTC(2000, 0, 1) / 86400000;
    for (const d of r) expect((Date.parse(d + "T00:00:00Z") / 86400000 - startDay) % 7).toBe(0);
    expect(r.length).toBeGreaterThanOrEqual(4);
  });
  it("fast forward keeps the biweekly phase", () => {
    const o = obj("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2020-01-06 09:00");
    const r = occurrencesBetween(o, at(AMS, "2026-11-01 00:00"), at(AMS, "2026-12-31 00:00")).map((d) => day(AMS, d));
    for (const d of r) expect(((Date.parse(d + "T00:00:00Z") - Date.parse("2020-01-06T00:00:00Z")) / 86400000) % 14).toBe(0);
    expect(r.length).toBeGreaterThanOrEqual(3);
  });
  it("monthly fast forward gives the same as walking", () => {
    const o = obj("RRULE:FREQ=MONTHLY;INTERVAL=5;BYMONTHDAY=31", "2010-01-31 09:00");
    const r = occurrencesBetween(o, at(AMS, "2026-01-01 00:00"), at(AMS, "2027-12-31 00:00")).map((d) => day(AMS, d));
    const walk = occurrencesBetween(o, at(AMS, "2010-01-01 00:00"), at(AMS, "2027-12-31 00:00")).map((d) => day(AMS, d)).filter((d) => d >= "2026-01-01");
    expect(r).toEqual(walk);
    expect(r.length).toBeGreaterThan(2);
  });
});

describe("window queries", () => {
  it("includes the start when inside the window", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-16 09:00");
    expect(occurrencesBetween(o, at(AMS, "2026-11-16 00:00"), at(AMS, "2026-11-17 23:00"))).toHaveLength(2);
  });
  it("bounds are inclusive", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-16 09:00");
    expect(occurrencesBetween(o, at(AMS, "2026-11-17 09:00"), at(AMS, "2026-11-18 09:00"))).toHaveLength(2);
  });
  it("empty window", () => {
    const o = obj("RRULE:FREQ=WEEKLY;BYDAY=MO", "2026-11-16 09:00");
    expect(occurrencesBetween(o, at(AMS, "2026-11-24 00:00"), at(AMS, "2026-11-29 00:00"))).toEqual([]);
  });
  it("accepts wire ISO date strings", () => {
    const o = { ...obj("RRULE:FREQ=DAILY", "2026-11-16 09:00"), startDate: "2026-11-16T08:00:00.000+0000" };
    expect(occurrencesBetween(o, "2026-11-17T00:00:00.000+0000", "2026-11-18T23:59:00.000+0000")).toHaveLength(2);
  });
  it("no repeat flag gives nothing", () => {
    expect(occurrencesBetween({ repeatFlag: null, startDate: new Date(0) }, 0, 1e12)).toEqual([]);
    expect(occurrences({ repeatFlag: "", startDate: new Date(0) }, 3)).toEqual([]);
    expect(nextOccurrence({ repeatFlag: undefined, startDate: new Date(0) })).toBeNull();
  });
});

describe("unsupported", () => {
  it("sub-daily frequencies", () => {
    expect(() => nextOccurrence(obj("RRULE:FREQ=HOURLY;INTERVAL=2", "2026-11-16 09:00"))).toThrow(UnsupportedRuleError);
  });
  it("BYHOUR", () => {
    expect(() => nextOccurrence(obj("RRULE:FREQ=DAILY;BYHOUR=9,17", "2026-11-16 09:00"))).toThrow(UnsupportedRuleError);
  });
});

describe("time zones and DST", () => {
  it("keeps the wall time in the task zone across the spring-forward day (Amsterdam)", () => {
    const o = obj("RRULE:FREQ=DAILY", "2027-03-26 09:00");
    const r = occurrences(o, 4).map((d) => wall(AMS, d));
    expect(r).toEqual(["2027-03-27 09:00", "2027-03-28 09:00", "2027-03-29 09:00", "2027-03-30 09:00"]);
    expect(iso(occurrences(o, 2)[1]!)).toBe("2027-03-28T07:00:00.000Z"); // CEST = UTC+2
    expect(iso(occurrences(o, 1)[0]!)).toBe("2027-03-27T08:00:00.000Z"); // CET = UTC+1
  });
  it("a nonexistent local time moves forward by the gap (02:30 -> 03:30)", () => {
    const o = obj("RRULE:FREQ=DAILY", "2027-03-26 02:30");
    const r = occurrences(o, 3);
    expect(r.map((d) => wall(AMS, d))).toEqual(["2027-03-27 02:30", "2027-03-28 03:30", "2027-03-29 02:30"]);
    expect(iso(r[1]!)).toBe("2027-03-28T01:30:00.000Z");
  });
  it("an ambiguous local time takes the first occurrence on the fall-back day", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-10-24 02:30");
    const r = occurrences(o, 3);
    expect(iso(r[0]!)).toBe("2026-10-25T00:30:00.000Z"); // CEST, first 02:30
    expect(iso(r[1]!)).toBe("2026-10-26T01:30:00.000Z"); // CET
  });
  it("New York spring forward", () => {
    const o = obj("RRULE:FREQ=DAILY", "2027-03-13 09:00", { zone: NY });
    const r = occurrences(o, 2, {});
    expect(iso(r[0]!)).toBe("2027-03-14T13:00:00.000Z"); // EDT
    expect(iso(obj("RRULE:FREQ=DAILY", "2027-03-12 09:00", { zone: NY }) && occurrences(obj("RRULE:FREQ=DAILY", "2027-03-12 09:00", { zone: NY }), 1)[0]!)).toBe("2027-03-13T14:00:00.000Z"); // EST
  });
  it("New York fall back keeps 09:00 local", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-10-30 09:00", { zone: NY });
    const r = occurrences(o, 4);
    expect(r.map((d) => wall(NY, d))).toEqual(["2026-10-31 09:00", "2026-11-01 09:00", "2026-11-02 09:00", "2026-11-03 09:00"]);
    expect(iso(r[0]!)).toBe("2026-10-31T13:00:00.000Z");
    expect(iso(r[1]!)).toBe("2026-11-01T14:00:00.000Z");
  });
  it("New York 01:30 on the fall-back day is the first (EDT) one", () => {
    const r = occurrences(obj("RRULE:FREQ=DAILY", "2026-10-31 01:30", { zone: NY }), 1);
    expect(iso(r[0]!)).toBe("2026-11-01T05:30:00.000Z");
  });
  it("New York 02:30 on the spring-forward day moves to 03:30", () => {
    const r = occurrences(obj("RRULE:FREQ=DAILY", "2027-03-13 02:30", { zone: NY }), 1);
    expect(wall(NY, r[0]!)).toBe("2027-03-14 03:30");
  });
  it("weekly across DST keeps wall time", () => {
    const r = occurrences(obj("RRULE:FREQ=WEEKLY;BYDAY=SA", "2027-03-20 20:00"), 3);
    expect(r.map((d) => wall(AMS, d))).toEqual(["2027-03-27 20:00", "2027-04-03 20:00", "2027-04-10 20:00"]);
  });
  it("monthly across DST keeps wall time", () => {
    const r = occurrences(obj("RRULE:FREQ=MONTHLY;BYMONTHDAY=15", "2027-02-15 08:15"), 3);
    expect(r.map((d) => wall(AMS, d))).toEqual(["2027-03-15 08:15", "2027-04-15 08:15", "2027-05-15 08:15"]);
  });
  it("the same instant is a different day in another zone: Auckland start late evening NY", () => {
    // 2026-11-16 23:30 in New York is already 11-17 in Amsterdam; the rule follows the task zone
    const r = seq("RRULE:FREQ=WEEKLY;BYDAY=MO", "2026-11-16 23:30", 2, { zone: NY });
    expect(r).toEqual(["2026-11-23", "2026-11-30"]);
  });
  it("floating / all-day tasks use the device zone", () => {
    const o = { repeatFlag: "RRULE:FREQ=DAILY", repeatFrom: "0", startDate: at(AMS, "2026-10-24 00:00") };
    const r = occurrences(o, 3, { deviceZone: AMS });
    expect(r.map((d) => iso(d))).toEqual(["2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z", "2026-10-26T23:00:00.000Z"]);
  });
  it("machine TZ does not leak in (process TZ is Pacific/Auckland in tests)", () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).not.toBe(0);
    const r = occurrences(obj("RRULE:FREQ=DAILY", "2026-11-16 09:00", { zone: "UTC" }), 1);
    expect(iso(r[0]!)).toBe("2026-11-17T09:00:00.000Z");
  });
  it("UTC zone", () => {
    expect(seq("RRULE:FREQ=WEEKLY;BYDAY=MO", "2026-11-16 09:00", 2, { zone: "UTC" })).toEqual(["2026-11-23", "2026-11-30"]);
  });
  it("far-east zone with a half-hour offset", () => {
    const r = occurrences(obj("RRULE:FREQ=DAILY", "2026-11-16 09:00", { zone: "Asia/Kolkata" }), 1);
    expect(iso(r[0]!)).toBe("2026-11-17T03:30:00.000Z");
  });
});
