import { describe, expect, it } from "vitest";
import type { Countdown } from "../src/data/m4types";
import { TYPE_LABEL, ageOn, counterOf, countdownStampsInRange, daysBetween, inUnit, nextFixedDate, nextOccurrence, nextUnit, repeatOf, sortCountdowns, typeLabel } from "../src/model/countdown";

const cd = (p: Partial<Countdown>): Countdown => ({ id: p.id ?? "x", name: p.name ?? "x", type: 4, date: 20261116, ...p });

describe("countdown math (CNT-009..016)", () => {
  it("days between calendar dates are DST safe", () => {
    expect(daysBetween(20260328, 20260330)).toBe(2); // EU DST start
    expect(daysBetween(20261024, 20261026)).toBe(2); // EU DST end
    expect(daysBetween(20261231, 20270101)).toBe(1);
    expect(daysBetween(20240228, 20240301)).toBe(2);
  });
  it("type values map to the four dialog types (CNT-009)", () => {
    expect(TYPE_LABEL).toEqual({ 1: "Holiday", 2: "Birthday", 3: "Anniversary", 4: "Countdown" });
    expect(typeLabel(9)).toBe("Countdown");
  });
  it("counts down to a future date and up from a past one (CNT-010)", () => {
    expect(counterOf(cd({ date: 20261120 }), 20261116)).toEqual({ days: 4, dir: "left", target: 20261120 });
    expect(counterOf(cd({ date: 20261110, timerMode: 1 }), 20261116)).toMatchObject({ days: 6, dir: "since" });
    expect(counterOf(cd({ date: 20261110 }), 20261116)).toMatchObject({ days: 6, dir: "since" });
    expect(counterOf(cd({ date: 20261116 }), 20261116).dir).toBe("today");
  });
  it("started yesterday: 1 under Standard, 2 under Start from Day 1 (CNT-011)", () => {
    expect(counterOf(cd({ date: 20261115, timerMode: 1, daysOption: 0 }), 20261116).days).toBe(1);
    expect(counterOf(cd({ date: 20261115, timerMode: 1, daysOption: 1 }), 20261116).days).toBe(2);
  });
  it("unit cycles Days, Weeks, Years and converts (CNT-012)", () => {
    expect(nextUnit("day")).toBe("week");
    expect(nextUnit("week")).toBe("year");
    expect(nextUnit("year")).toBe("day");
    expect(nextUnit(undefined)).toBe("week");
    expect(inUnit(17, "day")).toEqual({ value: "17", label: "Days" });
    expect(inUnit(17, "week")).toEqual({ value: "2", label: "Weeks", rest: "3 days" });
    expect(inUnit(14, "week").rest).toBeUndefined();
    expect(inUnit(730, "year")).toEqual({ value: "1.9", label: "Years" });
    expect(inUnit(1096, "year").value).toBe("3");
  });
  it("age of a 1990-05-10 birthday (CNT-013)", () => {
    expect(ageOn(19900510, 20261116)).toBe(36);
    expect(ageOn(19900510, 20260509)).toBe(35);
    expect(ageOn(19900510, 20260510)).toBe(36);
  });
  it("birthdays repeat yearly; Feb 29 falls on Feb 28 in other years", () => {
    expect(repeatOf({ type: 2, repeatFlag: null })).toEqual({ freq: "YEARLY", interval: 1 });
    expect(nextOccurrence(cd({ type: 2, date: 19900510 }), 20261116)).toBe(20270510);
    expect(nextOccurrence(cd({ type: 2, date: 20000229 }), 20260301)).toBe(20270228);
    expect(nextOccurrence(cd({ type: 2, date: 20000229 }), 20280101)).toBe(20280229);
  });
  it("every 2 months rolls forward after the date passes (CNT-016)", () => {
    const c = cd({ date: 20260131, repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=2" });
    expect(nextOccurrence(c, 20260131)).toBe(20260131);
    expect(nextOccurrence(c, 20260201)).toBe(20260331);
    expect(nextOccurrence(c, 20260401)).toBe(20260531);
    expect(nextOccurrence(cd({ date: 20260101, repeatFlag: "FREQ=WEEKLY;INTERVAL=2" }), 20260110)).toBe(20260115);
    expect(nextOccurrence(cd({ date: 20260101, repeatFlag: "FREQ=DAILY;INTERVAL=3" }), 20260105)).toBe(20260107);
    expect(nextOccurrence(cd({ date: 20200101, repeatFlag: "FREQ=YEARLY;INTERVAL=4" }), 20210101)).toBe(20240101);
    expect(repeatOf({ type: 4, repeatFlag: "FREQ=HOURLY" })).toBeNull();
  });
  it("pinned first, then by next date, passed dates last (CNT-019)", () => {
    const list = [cd({ id: "a", name: "a", date: 20261201 }), cd({ id: "b", name: "b", date: 20261120 }), cd({ id: "c", name: "c", date: 20261230, pinnedTime: "2026-11-01T00:00:00.000+0000" }), cd({ id: "d", name: "d", date: 20260101 })];
    expect(sortCountdowns(list, 20261116).map((c) => c.id)).toEqual(["c", "b", "a", "d"]);
  });
  it("stamps in a range for the calendar overlay (CAL-034)", () => {
    expect(countdownStampsInRange(cd({ date: 20261120 }), 20261101, 20261130)).toEqual([20261120]);
    expect(countdownStampsInRange(cd({ date: 20261220 }), 20261101, 20261130)).toEqual([]);
    expect(countdownStampsInRange(cd({ date: 20261120, status: 1 }), 20261101, 20261130)).toEqual([]);
    expect(countdownStampsInRange(cd({ date: 20250105, repeatFlag: "FREQ=WEEKLY" }), 20261101, 20261130)).toEqual([20261101, 20261108, 20261115, 20261122, 20261129]);
    expect(countdownStampsInRange(cd({ type: 2, date: 19901112 }), 20261101, 20261130)).toEqual([20261112]);
  });
  it("fixed holidays prefill the next date (CNT-023)", () => {
    expect(nextFixedDate(12, 25, 20261116)).toBe(20261225);
    expect(nextFixedDate(1, 1, 20261116)).toBe(20270101);
  });
});
