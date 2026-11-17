import { describe, expect, test } from "vitest";
import {
  addDays, addMonths, applyFocusOp, dayStartMs, diffDays, effectiveSlices, formatHabitRule, habitStreaks, isScheduled, isValidStamp,
  monthStartOf, parseHabitRule, recordActiveMs, recordBindings, stampOf, stampRange, toMs, tzOffsetMs, weekStartOf, weekdayOf,
  type FocusOp, type FocusState,
} from "../src/index.js";

const done = (...s: number[]) => s;

describe("calendar dates", () => {
  test("addDays crosses month ends, year ends and leap days", () => {
    expect(addDays(20260131, 1)).toBe(20260201);
    expect(addDays(20261231, 1)).toBe(20270101);
    expect(addDays(20280228, 1)).toBe(20280229);
    expect(addDays(20270228, 1)).toBe(20270301);
    expect(addDays(20260301, -1)).toBe(20260228);
  });
  test("weekday and week start", () => {
    expect(weekdayOf(20261115)).toBe(0); // Sunday
    expect(weekdayOf(20261109)).toBe(1);
    expect(weekStartOf(20261115, 0)).toBe(20261115);
    expect(weekStartOf(20261115, 1)).toBe(20261109);
    expect(weekStartOf(20261111, 0)).toBe(20261108);
  });
  test("months", () => {
    expect(monthStartOf(20261115)).toBe(20261101);
    expect(addMonths(20261101, -11)).toBe(20251201);
    expect(addMonths(20261201, 1)).toBe(20270101);
  });
  test("stamp validity", () => {
    expect(isValidStamp(20260229)).toBe(false);
    expect(isValidStamp(20280229)).toBe(true);
    expect(isValidStamp(20261301)).toBe(false);
    expect(isValidStamp("20261101")).toBe(false);
  });
  test("range and diff", () => {
    expect(stampRange(20260130, 20260202)).toEqual([20260130, 20260131, 20260201, 20260202]);
    expect(diffDays(20260101, 20261231)).toBe(364);
  });
  test("stampOf follows the zone across a DST change", () => {
    // Europe/Amsterdam springs forward on 2026-03-29 (02:00 -> 03:00)
    expect(stampOf(Date.UTC(2026, 2, 28, 22, 59), "Europe/Amsterdam")).toBe(20260328);
    expect(stampOf(Date.UTC(2026, 2, 28, 23, 0), "Europe/Amsterdam")).toBe(20260329);
    expect(stampOf(Date.UTC(2026, 2, 29, 21, 59), "Europe/Amsterdam")).toBe(20260329);
    expect(stampOf(Date.UTC(2026, 2, 29, 22, 0), "Europe/Amsterdam")).toBe(20260330);
    // America/Los_Angeles falls back on 2026-11-01
    expect(stampOf(Date.UTC(2026, 10, 2, 7, 59), "America/Los_Angeles")).toBe(20261101);
    expect(stampOf(Date.UTC(2026, 10, 2, 8, 0), "America/Los_Angeles")).toBe(20261102);
  });
  test("day start is DST aware (23 and 25 hour days)", () => {
    const a = dayStartMs(20260329, "Europe/Amsterdam");
    const b = dayStartMs(20260330, "Europe/Amsterdam");
    expect((b - a) / 3600000).toBe(23);
    const c = dayStartMs(20261101, "America/Los_Angeles");
    const d = dayStartMs(20261102, "America/Los_Angeles");
    expect((d - c) / 3600000).toBe(25);
    expect(tzOffsetMs(Date.UTC(2026, 6, 1), "Europe/Amsterdam")).toBe(2 * 3600000);
  });
});

describe("habit rules", () => {
  test("default and fallbacks", () => {
    expect(parseHabitRule(undefined)).toMatchObject({ freq: "WEEKLY", byDay: [0, 1, 2, 3, 4, 5, 6], times: null });
    expect(parseHabitRule("garbage")).toMatchObject({ freq: "DAILY", interval: 1 });
    expect(parseHabitRule("RRULE:FREQ=DAILY;INTERVAL=3")).toMatchObject({ freq: "DAILY", interval: 3 });
  });
  test("every n days, weekdays and n per week", () => {
    expect(parseHabitRule("FREQ=DAILY;INTERVAL=2")).toMatchObject({ freq: "DAILY", interval: 2 });
    expect(parseHabitRule("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toMatchObject({ byDay: [1, 3, 5] });
    expect(parseHabitRule("FREQ=WEEKLY;TT_TIMES=3")).toMatchObject({ freq: "WEEKLY", times: 3 });
    expect(parseHabitRule("FREQ=DAILY;TT_TIMES=3").times).toBeNull();
  });
  test("format round trip", () => {
    for (const r of ["FREQ=WEEKLY;BYDAY=MO,WE,FR", "FREQ=DAILY;INTERVAL=2", "FREQ=WEEKLY;TT_TIMES=3", "FREQ=MONTHLY;BYMONTHDAY=31"]) expect(formatHabitRule(parseHabitRule(r))).toBe(r);
  });
  test("scheduling: weekdays, intervals, month ends, exDates, before the anchor", () => {
    const mwf = parseHabitRule("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(isScheduled(mwf, 20261102, 20261109)).toBe(true); // Monday
    expect(isScheduled(mwf, 20261102, 20261110)).toBe(false);
    expect(isScheduled(mwf, 20261102, 20261030)).toBe(false); // before the anchor
    const every2 = parseHabitRule("FREQ=DAILY;INTERVAL=2");
    expect(isScheduled(every2, 20260130, 20260201)).toBe(true);
    expect(isScheduled(every2, 20260130, 20260131)).toBe(false);
    const m31 = parseHabitRule("FREQ=MONTHLY;BYMONTHDAY=31");
    expect(isScheduled(m31, 20260101, 20260228)).toBe(true); // short month: last day
    expect(isScheduled(m31, 20260101, 20260227)).toBe(false);
    expect(isScheduled(parseHabitRule("FREQ=DAILY"), 20261101, 20261105, [20261105])).toBe(false);
    expect(isScheduled(parseHabitRule("FREQ=WEEKLY;TT_TIMES=2"), 20261101, 20261104)).toBe(true);
  });
});

describe("habit streaks", () => {
  const daily = parseHabitRule("FREQ=DAILY");
  test("a run across a month end", () => {
    const r = habitStreaks({ rule: daily, anchor: 20260125, done: done(20260129, 20260130, 20260131, 20260201, 20260202), today: 20260202 });
    expect(r).toEqual({ totalCheckIns: 5, currentStreak: 5, maxStreak: 5 });
  });
  test("a gap on the 1st breaks it", () => {
    const r = habitStreaks({ rule: daily, anchor: 20260125, done: done(20260129, 20260130, 20260131, 20260202), today: 20260202 });
    expect(r).toEqual({ totalCheckIns: 4, currentStreak: 1, maxStreak: 3 });
  });
  test("a run across the leap day", () => {
    const r = habitStreaks({ rule: daily, anchor: 20280227, done: done(20280227, 20280228, 20280229, 20280301), today: 20280301 });
    expect(r.currentStreak).toBe(4);
    const noLeap = habitStreaks({ rule: daily, anchor: 20270227, done: done(20270227, 20270228, 20270301), today: 20270301 });
    expect(noLeap.currentStreak).toBe(3);
  });
  test("a run across a year end", () => {
    expect(habitStreaks({ rule: daily, anchor: 20261230, done: done(20261230, 20261231, 20270101), today: 20270101 }).currentStreak).toBe(3);
  });
  test("today still open does not break the streak", () => {
    const r = habitStreaks({ rule: daily, anchor: 20261101, done: done(20261101, 20261102, 20261103), today: 20261104 });
    expect(r.currentStreak).toBe(3);
  });
  test("a missed yesterday zeroes the current streak but keeps the max", () => {
    const r = habitStreaks({ rule: daily, anchor: 20261101, done: done(20261101, 20261102, 20261103), today: 20261105 });
    expect(r).toEqual({ totalCheckIns: 3, currentStreak: 0, maxStreak: 3 });
  });
  test("Mon Wed Fri: not-due days do not break", () => {
    const rule = parseHabitRule("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(habitStreaks({ rule, anchor: 20261109, done: done(20261109, 20261111), today: 20261112 })).toEqual({ totalCheckIns: 2, currentStreak: 2, maxStreak: 2 });
    // Friday missed, now Saturday
    expect(habitStreaks({ rule, anchor: 20261109, done: done(20261109, 20261111), today: 20261114 })).toEqual({ totalCheckIns: 2, currentStreak: 0, maxStreak: 2 });
    // all three done, Saturday
    expect(habitStreaks({ rule, anchor: 20261109, done: done(20261109, 20261111, 20261113), today: 20261114 }).currentStreak).toBe(3);
  });
  test("every 2 days", () => {
    const rule = parseHabitRule("FREQ=DAILY;INTERVAL=2");
    expect(habitStreaks({ rule, anchor: 20261101, done: done(20261101, 20261103, 20261105), today: 20261106 }).currentStreak).toBe(3);
    expect(habitStreaks({ rule, anchor: 20261101, done: done(20261101, 20261103), today: 20261106 })).toEqual({ totalCheckIns: 2, currentStreak: 0, maxStreak: 2 });
  });
  test("a check-in on a day that is not due still extends the run", () => {
    const rule = parseHabitRule("FREQ=WEEKLY;BYDAY=MO");
    expect(habitStreaks({ rule, anchor: 20261102, done: done(20261102, 20261103, 20261109), today: 20261110 }).currentStreak).toBe(3);
  });
  test("exDates skip a day", () => {
    const r = habitStreaks({ rule: daily, anchor: 20261110, exDates: [20261111], done: done(20261110, 20261112), today: 20261112 });
    expect(r.currentStreak).toBe(2);
    const noSkip = habitStreaks({ rule: daily, anchor: 20261110, done: done(20261110, 20261112), today: 20261112 });
    expect(noSkip.currentStreak).toBe(1);
  });
  test("future check-ins are counted in the total only", () => {
    const r = habitStreaks({ rule: daily, anchor: 20261101, done: done(20261101, 20261120), today: 20261102 });
    expect(r).toEqual({ totalCheckIns: 2, currentStreak: 1, maxStreak: 1 });
  });
  test("no check-ins", () => {
    expect(habitStreaks({ rule: daily, anchor: 20261101, done: [], today: 20261110 })).toEqual({ totalCheckIns: 0, currentStreak: 0, maxStreak: 0 });
  });
  test("n per week counts whole weeks", () => {
    const rule = parseHabitRule("FREQ=WEEKLY;TT_TIMES=3");
    // week of Nov 1 met (3), week of Nov 8 met (3), the running week has 1 day so far
    const d = done(20261102, 20261104, 20261106, 20261109, 20261110, 20261111, 20261115);
    expect(habitStreaks({ rule, anchor: 20261101, done: d, today: 20261115 })).toEqual({ totalCheckIns: 7, currentStreak: 6, maxStreak: 6 });
    // week of Nov 8 missed: run resets
    expect(habitStreaks({ rule, anchor: 20261101, done: done(20261102, 20261104, 20261106, 20261109, 20261110), today: 20261115 })).toEqual({ totalCheckIns: 5, currentStreak: 0, maxStreak: 3 });
    // running week already met
    expect(habitStreaks({ rule, anchor: 20261101, done: done(20261102, 20261103, 20261104), today: 20261107 }).currentStreak).toBe(3);
  });
});

describe("focus records", () => {
  const rec = (id: string, s: number, e: number, extra: Record<string, unknown> = {}) => ({ id, type: 0, rec: { id, startTime: s, endTime: e, ...extra } });
  test("toMs accepts ms and server dates", () => {
    expect(toMs(1790000000000)).toBe(1790000000000);
    expect(toMs("2026-11-15T10:00:00.000+0000")).toBe(Date.UTC(2026, 10, 15, 10));
    expect(toMs("nope")).toBeNaN();
  });
  test("active time subtracts pauses (seconds) and adds the adjustment", () => {
    expect(recordActiveMs({ startTime: 0, endTime: 1500000, pauseDuration: 60 })).toBe(1440000);
    expect(recordActiveMs({ startTime: 0, endTime: 1500000, adjustTime: 300 })).toBe(1800000);
    expect(recordActiveMs({ startTime: 10, endTime: 5 })).toBe(0);
  });
  test("bindings read taskId, habitId and timerId", () => {
    const b = recordBindings({ tasks: [{ taskId: "a", title: "A" }, { habitId: "h" }, { timerId: "t" }, { title: "none" }] });
    expect(b.map((x) => [x.owner, x.id])).toEqual([[0, "a"], [1, "h"], [2, "t"]]);
  });
  test("overlap: the second record only counts its new part", () => {
    const m = 60000;
    const s = effectiveSlices([rec("a", 0, 30 * m), rec("b", 20 * m, 50 * m)]);
    expect(s.map((x) => x.activeMs / m)).toEqual([30, 20]);
  });
  test("overlap: a record inside another adds nothing; order does not matter", () => {
    const m = 60000;
    const s = effectiveSlices([rec("b", 5 * m, 10 * m), rec("a", 0, 30 * m)]);
    expect(Object.fromEntries(s.map((x) => [x.id, x.activeMs / m]))).toEqual({ a: 30, b: 0 });
  });
  test("overlap: touching records are both counted whole", () => {
    const m = 60000;
    expect(effectiveSlices([rec("a", 0, 25 * m), rec("b", 25 * m, 50 * m)]).map((x) => x.activeMs / m)).toEqual([25, 25]);
  });
});

describe("focus op reducer", () => {
  const op = (o: string, time: number, extra: Record<string, unknown> = {}): FocusOp => ({ id: `${o}${time}`, oId: "s1", op: o, time, ...extra });
  const run = (...ops: FocusOp[]): FocusState | null => ops.reduce<FocusState | null>((st, o) => applyFocusOp(st, o).state, null);
  test("start opens a fragment", () => {
    const s = run(op("start", 1000))!;
    expect(s).toMatchObject({ id: "s1", status: "running", startTime: 1000, pauseDuration: 0, fragments: [{ startTime: 1000, endTime: null }] });
  });
  test("pause closes the fragment, continue adds a new one and the pause time", () => {
    const s = run(op("start", 0), op("pause", 60000), op("continue", 90000))!;
    expect(s.status).toBe("running");
    expect(s.pauseDuration).toBe(30000);
    expect(s.fragments).toEqual([{ startTime: 0, endTime: 60000 }, { startTime: 90000, endTime: null }]);
    expect(run(op("start", 0), op("pause", 60000))!.duration).toBe(60000);
  });
  test("finish and exit clear the state", () => {
    expect(run(op("start", 0), op("finish", 5000))).toBeNull();
    expect(run(op("start", 0), op("exit", 5000))).toBeNull();
  });
  test("ops of another session are ignored", () => {
    const s = run(op("start", 0), { ...op("pause", 5000), oId: "other" })!;
    expect(s.status).toBe("running");
  });
  test("a second start replaces the running session", () => {
    const first = applyFocusOp(null, op("start", 0)).state;
    const out = applyFocusOp(first, { ...op("start", 10), oId: "s2" });
    expect(out.replaced?.id).toBe("s1");
    expect(out.state?.id).toBe("s2");
  });
  test("a repeated start of the same session is a no-op", () => {
    const first = applyFocusOp(null, op("start", 0)).state;
    expect(applyFocusOp(first, op("start", 50)).state).toBe(first);
  });
  test("pause on a paused timer and continue on a running one do nothing", () => {
    const paused = run(op("start", 0), op("pause", 10))!;
    expect(applyFocusOp(paused, op("pause", 20)).state).toBe(paused);
    const running = run(op("start", 0))!;
    expect(applyFocusOp(running, op("continue", 20)).state).toBe(running);
  });
  test("pomodoro count with workFinish", () => {
    const s = run(op("start", 0), op("workFinish", 1500000))!;
    expect(s.sumOfPomo).toBe(1);
    expect(s.lastPomoCompletedTime).toBe(1500000);
  });
});
