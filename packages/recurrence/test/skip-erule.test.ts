import { describe, expect, it } from "vitest";
import { nextOccurrence, occurrences, occurrencesBetween, weekendOnlyProvider } from "../src/index";
import { AMS, at, day, holidays, obj, seq, wall } from "./helpers";

const H = { holidays };

describe("skip rules", () => {
  it("TT_SKIP=WEEKEND", () => {
    expect(seq("RRULE:FREQ=DAILY;TT_SKIP=WEEKEND", "2026-12-18 09:00", 3, {}, H)).toEqual(["2026-12-21", "2026-12-22", "2026-12-23"]);
  });
  it("TT_SKIP=HOLIDAY drops statutory holidays only", () => {
    expect(seq("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY", "2026-12-24 09:00", 3, {}, H)).toEqual(["2026-12-27", "2026-12-28", "2026-12-29"]);
  });
  it("TT_SKIP=HOLIDAY does not drop weekends", () => {
    expect(seq("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY", "2026-12-18 09:00", 2, {}, H)).toEqual(["2026-12-19", "2026-12-20"]);
  });
  it("HOLIDAY,WEEKEND = official workdays, including a make-up Saturday", () => {
    expect(seq("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY,WEEKEND", "2026-12-18 09:00", 3, {}, H)).toEqual(["2026-12-19", "2026-12-21", "2026-12-22"]);
  });
  it("HOLIDAY,WEEKEND skips the Christmas block", () => {
    expect(seq("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY,WEEKEND", "2026-12-24 09:00", 3, {}, H)).toEqual(["2026-12-28", "2026-12-29", "2026-12-30"]);
  });
  it("TT_SKIP=OFFICIAL_WORKDAY keeps rest days only", () => {
    expect(seq("RRULE:FREQ=DAILY;TT_SKIP=OFFICIAL_WORKDAY", "2026-12-18 09:00", 3, {}, H)).toEqual(["2026-12-20", "2026-12-25", "2026-12-26"]);
  });
  it("without holiday data only Sat/Sun are rest days", () => {
    expect(seq("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY,WEEKEND", "2026-12-24 09:00", 3)).toEqual(["2026-12-25", "2026-12-28", "2026-12-29"]);
    expect(weekendOnlyProvider.isHoliday("2026-12-25")).toBe(false);
  });
  it("legacy TK_SKIP=HOLIDAY acts as holiday + weekend", () => {
    expect(seq("RRULE:FREQ=DAILY;TK_SKIP=HOLIDAY", "2026-12-24 09:00", 2, {}, H)).toEqual(["2026-12-28", "2026-12-29"]);
  });
  it("skipped dates do not consume COUNT", () => {
    expect(seq("RRULE:FREQ=DAILY;COUNT=3;TT_SKIP=WEEKEND", "2026-12-18 09:00", 10, {}, H)).toEqual(["2026-12-21", "2026-12-22"]);
  });
  it("skip applies on top of weekly rules (BYDAY=FR,SA)", () => {
    expect(seq("RRULE:FREQ=WEEKLY;BYDAY=FR,SA;TT_SKIP=WEEKEND", "2026-12-11 09:00", 3, {}, H)).toEqual(["2026-12-18", "2026-12-25", "2027-01-01"]);
  });
  it("skip with a holiday on a weekly BYDAY", () => {
    expect(seq("RRULE:FREQ=WEEKLY;BYDAY=FR;TT_SKIP=HOLIDAY", "2026-12-18 09:00", 2, {}, H)).toEqual(["2027-01-08", "2027-01-15"]);
  });
  it("skip in window queries", () => {
    const o = obj("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY,WEEKEND", "2026-12-21 09:00");
    const r = occurrencesBetween(o, at(AMS, "2026-12-21 00:00"), at(AMS, "2026-12-31 23:00"), H).map((d) => day(AMS, d));
    expect(r).toEqual(["2026-12-21", "2026-12-22", "2026-12-23", "2026-12-24", "2026-12-28", "2026-12-29", "2026-12-30", "2026-12-31"]);
  });
});

describe("TT_WORKDAY (first / last workday of the month)", () => {
  it("last workday", () => {
    expect(seq("RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=-1", "2026-11-30 09:00", 3, {}, H)).toEqual(["2026-12-31", "2027-01-29", "2027-02-26"]);
  });
  it("first workday", () => {
    expect(seq("RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=1", "2026-11-02 09:00", 3, {}, H)).toEqual(["2026-12-01", "2027-01-04", "2027-02-01"]);
  });
  it("first workday respects a holiday on Jan 1 (provider) but not without one", () => {
    expect(seq("RRULE:FREQ=MONTHLY;TT_WORKDAY=1", "2026-12-01 09:00", 1, {}, H)).toEqual(["2027-01-04"]);
    expect(seq("RRULE:FREQ=MONTHLY;TT_WORKDAY=1", "2026-12-01 09:00", 1)).toEqual(["2027-01-01"]);
  });
  it("interval 2", () => {
    expect(seq("RRULE:FREQ=MONTHLY;INTERVAL=2;TT_WORKDAY=-1", "2026-11-30 09:00", 2, {}, H)).toEqual(["2027-01-29", "2027-03-31"]);
  });
  it("a start that is the first workday goes on to next month", () => {
    expect(seq("RRULE:FREQ=MONTHLY;TT_WORKDAY=1", "2026-12-01 09:00", 1, {}, H)).toEqual(["2027-01-04"]);
  });
  it("COUNT applies", () => {
    expect(seq("RRULE:FREQ=MONTHLY;TT_WORKDAY=-1;COUNT=2", "2026-11-30 09:00", 5, {}, H)).toEqual(["2026-12-31"]);
  });
  it("keeps the time of day", () => {
    const o = obj("RRULE:FREQ=MONTHLY;TT_WORKDAY=-1", "2026-11-30 17:45");
    expect(wall(AMS, occurrences(o, 1, H)[0]!)).toBe("2026-12-31 17:45");
  });
});

describe("ERULE CUSTOM", () => {
  const f = "ERULE:NAME=CUSTOM;BYDATE=20261201,20261215,20270105";
  it("lists the dates after the start at the start's time of day", () => {
    const o = obj(f, "2026-11-16 09:30");
    expect(occurrences(o, 5).map((d) => wall(AMS, d))).toEqual(["2026-12-01 09:30", "2026-12-15 09:30", "2027-01-05 09:30"]);
  });
  it("dates are sorted even if listed out of order", () => {
    expect(seq("ERULE:NAME=CUSTOM;BYDATE=20270105,20261201", "2026-11-16 09:00", 5)).toEqual(["2026-12-01", "2027-01-05"]);
  });
  it("dates on or before the start are not repeated", () => {
    expect(seq(f, "2026-12-15 09:00", 5)).toEqual(["2027-01-05"]);
  });
  it("COUNT includes the current start", () => {
    expect(seq(f + ";COUNT=2", "2026-11-16 09:00", 5)).toEqual(["2026-12-01"]);
  });
  it("UNTIL is inclusive", () => {
    expect(seq(f + ";UNTIL=20261215", "2026-11-16 09:00", 5)).toEqual(["2026-12-01", "2026-12-15"]);
  });
  it("TT_SKIP=WEEKEND drops weekend dates", () => {
    expect(seq("ERULE:NAME=CUSTOM;BYDATE=20261205,20261207;TT_SKIP=WEEKEND", "2026-11-16 09:00", 5)).toEqual(["2026-12-07"]);
  });
  it('mode "2" jumps to today', () => {
    expect(seq(f, "2026-11-16 09:00", 5, { repeatFrom: "2" }, { now: at(AMS, "2026-12-10 10:00") })).toEqual(["2026-12-15", "2027-01-05"]);
  });
  it("junk dates are ignored", () => {
    expect(seq("ERULE:NAME=CUSTOM;BYDATE=abc,20261201", "2026-11-16 09:00", 5)).toEqual(["2026-12-01"]);
  });
  it("no dates: nothing", () => {
    expect(nextOccurrence(obj("ERULE:NAME=CUSTOM;BYDATE=", "2026-11-16 09:00"))).toBeNull();
  });
  it("window query", () => {
    const o = obj(f, "2026-12-01 09:00");
    expect(occurrencesBetween(o, at(AMS, "2026-12-02 00:00"), at(AMS, "2027-12-31 00:00"))).toHaveLength(2);
  });
});

describe("ERULE FORGETTINGCURVE", () => {
  it("gaps 1,1,2,3,8 then 15 repeated", () => {
    expect(seq("ERULE:NAME=FORGETTINGCURVE;CYCLE=0", "2026-11-16 09:00", 7)).toEqual([
      "2026-11-17", "2026-11-18", "2026-11-20", "2026-11-23", "2026-12-01", "2026-12-16", "2026-12-31",
    ]);
  });
  it("CYCLE selects where in the curve the current date sits", () => {
    expect(seq("ERULE:NAME=FORGETTINGCURVE;CYCLE=2", "2026-11-16 09:00", 4)).toEqual(["2026-11-18", "2026-11-21", "2026-11-29", "2026-12-14"]);
  });
  it("CYCLE past the table keeps 15", () => {
    expect(seq("ERULE:NAME=FORGETTINGCURVE;CYCLE=9", "2026-11-16 09:00", 2)).toEqual(["2026-12-01", "2026-12-16"]);
  });
  it("COUNT includes the current date", () => {
    expect(seq("ERULE:NAME=FORGETTINGCURVE;CYCLE=0;COUNT=3", "2026-11-16 09:00", 9)).toEqual(["2026-11-17", "2026-11-18"]);
  });
  it("UNTIL", () => {
    expect(seq("ERULE:NAME=FORGETTINGCURVE;CYCLE=0;UNTIL=20261123", "2026-11-16 09:00", 9)).toEqual(["2026-11-17", "2026-11-18", "2026-11-20", "2026-11-23"]);
  });
  it("keeps the time of day", () => {
    expect(wall(AMS, occurrences(obj("ERULE:NAME=FORGETTINGCURVE;CYCLE=0", "2026-11-16 19:15"), 1)[0]!)).toBe("2026-11-17 19:15");
  });
});
