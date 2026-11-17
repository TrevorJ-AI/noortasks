import { describe, expect, it } from "vitest";
import { nextOccurrence, occurrences, willRepeatAgain } from "../src/index";
import { AMS, at, day, holidays, iso, obj, seq, wall } from "./helpers";

const now = (s: string) => at(AMS, s);

describe('repeatFrom "0" (due date)', () => {
  it("never jumps to today: an old task gets the very next date", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-01-01 09:00", { repeatFrom: "0" });
    expect(day(AMS, nextOccurrence(o, { now: now("2026-11-15 14:00") })!)).toBe("2026-01-02");
  });
  it("missed occurrences are not skipped", () => {
    expect(seq("RRULE:FREQ=WEEKLY;BYDAY=MO", "2026-10-05 09:00", 2, { repeatFrom: "0" }, { now: now("2026-11-15 10:00") })).toEqual(["2026-10-12", "2026-10-19"]);
  });
  it("next date is strictly after the current start", () => {
    expect(day(AMS, nextOccurrence(obj("RRULE:FREQ=DAILY", "2026-11-16 09:00"))!)).toBe("2026-11-17");
  });
  it("ignores completedTime", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-16 09:00", { completedTime: now("2026-12-31 10:00") });
    expect(day(AMS, nextOccurrence(o)!)).toBe("2026-11-17");
  });
  it('repeatFrom "3" (specific dates UI value) behaves like "0"', () => {
    expect(seq("RRULE:FREQ=DAILY", "2026-11-16 09:00", 1, { repeatFrom: "3" })).toEqual(["2026-11-17"]);
  });
});

describe('repeatFrom "2" (default, advanced to today)', () => {
  const ctx = { now: now("2026-11-15 14:00") };
  it("default mode jumping to today: old daily task lands on today", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-01-01 09:00", { repeatFrom: "2" });
    expect(wall(AMS, nextOccurrence(o, ctx)!)).toBe("2026-11-15 09:00");
  });
  it("today counts even if its time already passed", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-10 07:00", { repeatFrom: "2" });
    expect(wall(AMS, nextOccurrence(o, { now: now("2026-11-15 23:00") })!)).toBe("2026-11-15 07:00");
  });
  it("a future start is not pulled back: next after the start", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-20 09:00", { repeatFrom: "2" });
    expect(day(AMS, nextOccurrence(o, ctx)!)).toBe("2026-11-21");
  });
  it("start today: next is tomorrow", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-15 09:00", { repeatFrom: "2" });
    expect(day(AMS, nextOccurrence(o, ctx)!)).toBe("2026-11-16");
  });
  it("weekly keeps its BYDAY pattern when advancing", () => {
    const o = obj("RRULE:FREQ=WEEKLY;BYDAY=MO,FR", "2026-01-05 09:00", { repeatFrom: "2" });
    expect(day(AMS, nextOccurrence(o, ctx)!)).toBe("2026-11-16");
    expect(occurrences(o, 3, ctx).map((d) => day(AMS, d))).toEqual(["2026-11-16", "2026-11-20", "2026-11-23"]);
  });
  it("interval phase is preserved when advancing", () => {
    const o = obj("RRULE:FREQ=DAILY;INTERVAL=3", "2026-11-01 09:00", { repeatFrom: "2" });
    // 11-01, 04, 07, 10, 13, 16 -> first on/after 11-15 is 11-16
    expect(day(AMS, nextOccurrence(o, ctx)!)).toBe("2026-11-16");
  });
  it("monthly advance", () => {
    const o = obj("RRULE:FREQ=MONTHLY;BYMONTHDAY=10", "2026-01-10 09:00", { repeatFrom: "2" });
    expect(day(AMS, nextOccurrence(o, ctx)!)).toBe("2026-12-10");
  });
  it("is the default when repeatFrom is missing", () => {
    const o = { ...obj("RRULE:FREQ=DAILY", "2026-01-01 09:00"), repeatFrom: undefined };
    expect(day(AMS, nextOccurrence(o, ctx)!)).toBe("2026-11-15");
  });
  it("needs a notion of today", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-01-01 09:00", { repeatFrom: "2" });
    expect(() => nextOccurrence(o)).toThrow(RangeError);
  });
  it("today is taken in the task zone", () => {
    // 2026-11-15 23:30 UTC is already 11-16 in Amsterdam
    const o = obj("RRULE:FREQ=DAILY", "2026-01-01 09:00", { repeatFrom: "2" });
    expect(day(AMS, nextOccurrence(o, { now: new Date("2026-11-15T23:30:00Z") })!)).toBe("2026-11-16");
  });
  it("skipped overdue occurrences still consume COUNT", () => {
    const o = obj("RRULE:FREQ=DAILY;COUNT=10", "2026-11-10 09:00", { repeatFrom: "2" });
    // 11-10 .. 11-19 are the ten; today 11-15 is allowed
    expect(occurrences(o, 20, ctx).map((d) => day(AMS, d))).toEqual(["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
  });
  it("skipped overdue occurrences can exhaust COUNT", () => {
    const o = obj("RRULE:FREQ=DAILY;COUNT=3", "2026-11-01 09:00", { repeatFrom: "2" });
    expect(nextOccurrence(o, ctx)).toBeNull();
  });
  it("UNTIL still ends it", () => {
    const o = obj("RRULE:FREQ=DAILY;UNTIL=20261110", "2026-11-01 09:00", { repeatFrom: "2" });
    expect(nextOccurrence(o, ctx)).toBeNull();
  });
  it("official workday repeat advances to the next workday on or after today", () => {
    const o = obj("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY,WEEKEND", "2026-12-10 09:00", { repeatFrom: "2" });
    expect(day(AMS, nextOccurrence(o, { now: now("2026-12-25 20:00"), holidays })!)).toBe("2026-12-28");
  });
});

describe('repeatFrom "1" (completion)', () => {
  const done = now("2026-11-18 20:00"); // Wednesday evening
  it("restarts from the completion day, keeping the due time of day", () => {
    const o = obj("RRULE:FREQ=WEEKLY;INTERVAL=1", "2026-11-09 09:00", { repeatFrom: "1", completedTime: done });
    expect(wall(AMS, nextOccurrence(o)!)).toBe("2026-11-25 09:00");
  });
  it("completion mode ignoring BYDAY", () => {
    const o = obj("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", "2026-11-09 09:00", { repeatFrom: "1", completedTime: done });
    expect(day(AMS, nextOccurrence(o)!)).toBe("2026-11-25");
  });
  it("completion mode ignoring BYMONTHDAY", () => {
    const o = obj("RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1", "2026-11-01 09:00", { repeatFrom: "1", completedTime: done });
    expect(day(AMS, nextOccurrence(o)!)).toBe("2026-12-18");
  });
  it("completion mode ignoring BYMONTH and BYSETPOS", () => {
    const o = obj("RRULE:FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=4", "2026-03-04 09:00", { repeatFrom: "1", completedTime: done });
    expect(day(AMS, nextOccurrence(o)!)).toBe("2027-11-18");
  });
  it("INTERVAL still applies", () => {
    const o = obj("RRULE:FREQ=DAILY;INTERVAL=3", "2026-11-09 09:00", { repeatFrom: "1", completedTime: done });
    expect(day(AMS, nextOccurrence(o)!)).toBe("2026-11-21");
  });
  it("monthly from Jan 31 completion falls back to Feb 28", () => {
    const o = obj("RRULE:FREQ=MONTHLY;INTERVAL=1", "2027-01-20 09:00", { repeatFrom: "1", completedTime: now("2027-01-31 08:00") });
    expect(day(AMS, nextOccurrence(o)!)).toBe("2027-02-28");
  });
  it("no completedTime: no occurrence", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-09 09:00", { repeatFrom: "1" });
    expect(nextOccurrence(o)).toBeNull();
    expect(occurrences(o, 3)).toEqual([]);
  });
  it("subsequent occurrences continue from the anchor", () => {
    const o = obj("RRULE:FREQ=DAILY;INTERVAL=2", "2026-11-09 09:00", { repeatFrom: "1", completedTime: done });
    expect(occurrences(o, 3).map((d) => day(AMS, d))).toEqual(["2026-11-20", "2026-11-22", "2026-11-24"]);
  });
  it("completion day is taken in the task zone", () => {
    const o = obj("RRULE:FREQ=DAILY", "2026-11-09 09:00", { repeatFrom: "1", completedTime: new Date("2026-11-18T23:30:00Z") });
    expect(day(AMS, nextOccurrence(o)!)).toBe("2026-11-20"); // 23:30Z is 11-19 in Amsterdam
  });
  it("COUNT: current plus one more", () => {
    const o = obj("RRULE:FREQ=DAILY;COUNT=2", "2026-11-09 09:00", { repeatFrom: "1", completedTime: done });
    expect(occurrences(o, 5)).toHaveLength(1);
    const last = obj("RRULE:FREQ=DAILY;COUNT=1", "2026-11-09 09:00", { repeatFrom: "1", completedTime: done });
    expect(nextOccurrence(last)).toBeNull();
  });
  it("UNTIL in the past of the anchor ends the series", () => {
    const o = obj("RRULE:FREQ=DAILY;UNTIL=20261118", "2026-11-09 09:00", { repeatFrom: "1", completedTime: done });
    expect(nextOccurrence(o)).toBeNull();
  });
});

describe("willRepeatAgain", () => {
  it("true for an endless rule", () => expect(willRepeatAgain(obj("RRULE:FREQ=DAILY", "2026-11-16 09:00"))).toBe(true));
  it("false for COUNT=1", () => expect(willRepeatAgain(obj("RRULE:FREQ=DAILY;COUNT=1", "2026-11-16 09:00"))).toBe(false));
  it("false after UNTIL", () => expect(willRepeatAgain(obj("RRULE:FREQ=DAILY;UNTIL=20261116", "2026-11-16 09:00"))).toBe(false));
  it("iso sanity", () => expect(iso(nextOccurrence(obj("RRULE:FREQ=DAILY", "2026-11-16 09:00")))).toBe("2026-11-17T08:00:00.000Z"));
});
