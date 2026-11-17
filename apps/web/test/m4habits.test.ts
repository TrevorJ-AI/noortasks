import { describe, expect, it } from "vitest";
import { newHabit } from "../src/data/m4repo";
import type { Checkin, Habit } from "../src/data/m4types";
import { parseHabitRule } from "../src/lib/m4core";
import { cadenceLabel, cadenceOf, dayState, dueToday, habitStats, monthGrid, ruleOf, sortHabits, weeklyReview } from "../src/model/habits";

/** Habit rules and the streak display math (RPT-073, HAB-011, HAB-013, HAB-017, HAB-023, HAB-024, HAB-031). */
const ck = (habitId: string, stamp: number, status = 2, value = 1): Checkin => ({ id: `${habitId}-${stamp}`, habitId, checkinStamp: stamp, status, value });

describe("habit rules (RPT-073, HAB-013)", () => {
  it("FREQ=WEEKLY;TT_TIMES=3 is 3 per week, FREQ=DAILY;INTERVAL=2 every 2 days, junk falls back to daily", () => {
    expect(parseHabitRule("FREQ=WEEKLY;TT_TIMES=3").times).toBe(3);
    expect(cadenceOf("FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=3")).toEqual({ kind: "weekly", times: 3 });
    expect(cadenceOf("FREQ=DAILY;INTERVAL=2")).toEqual({ kind: "interval", every: 2 });
    expect(parseHabitRule("nonsense")).toMatchObject({ freq: "DAILY", interval: 1 });
    expect(cadenceLabel("nonsense")).toBe("Every day");
  });
  it("the dialog cadences write bare rules without RRULE:", () => {
    expect(ruleOf({ kind: "daily", days: [1, 3, 5] })).toBe("FREQ=WEEKLY;BYDAY=MO,WE,FR");
    expect(ruleOf({ kind: "daily", days: [0, 1, 2, 3, 4, 5, 6] })).toBe("FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA");
    expect(ruleOf({ kind: "weekly", times: 4 })).toBe("FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=4");
    expect(ruleOf({ kind: "interval", every: 3 })).toBe("FREQ=DAILY;INTERVAL=3");
    expect(cadenceLabel("FREQ=WEEKLY;BYDAY=MO,WE,FR")).toBe("Mon, Wed, Fri");
  });
});

describe("new habit defaults (HAB-011)", () => {
  it("boolean, goal 1 Count, every day, no section, style 1, the default icon", () => {
    const h = newHabit();
    expect(h).toMatchObject({ iconRes: "habit_daily_check_in", type: "Boolean", unit: "Count", goal: 1, repeatRule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA", sectionId: "-1", style: 1, status: 0 });
    expect(h.id).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("streak display (HAB-023, HAB-024)", () => {
  // 2026-11-16 is a Monday
  const mwf: Habit = { ...newHabit({ id: "h1", name: "Run", repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR" }), targetStartDate: 20261102 };
  it("Mon Wed Fri: rest days neither extend nor break; a missed Friday breaks the run", () => {
    const done = [20261102, 20261104, 20261106, 20261109, 20261111].map((d) => ck("h1", d));
    const thu = habitStats(mwf, done, 20261112, 20261102, 1);
    expect(thu.currentStreak).toBe(5);
    expect(thu.totalCheckIns).toBe(5);
    const sat = habitStats(mwf, done, 20261114, 20261102, 1); // Friday 13th missed
    expect(sat.currentStreak).toBe(0);
    expect(sat.maxStreak).toBe(5);
  });
  it("today still open does not break the streak; the monthly rate counts due days so far", () => {
    const done = [20261111, 20261113].map((d) => ck("h1", d));
    const mon = habitStats(mwf, done, 20261116, 20261102, 1);
    expect(mon.currentStreak).toBe(2);
    // due in November up to the 16th: 2,4,6,9,11,13,16 = 7; done 2
    expect(mon.monthRate).toBeCloseTo(2 / 7);
    expect(mon.monthCheckIns).toBe(2);
  });
  it("3 days per week: a week that met the quota adds its days, the running week never breaks", () => {
    const q: Habit = { ...newHabit({ id: "q", repeatRule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=3" }), targetStartDate: 20261101 };
    const done = [20261102, 20261103, 20261105, 20261110].map((d) => ck("q", d));
    expect(habitStats(q, done, 20261111, 20261101, 0).currentStreak).toBe(3); // the running week adds once its quota is met
    expect(dueToday(q, done, 20261111, 20261101, 0)).toBe(true);
    const full = [...done, ck("q", 20261111), ck("q", 20261112)];
    expect(dueToday(q, full, 20261113, 20261101, 0)).toBe(false); // quota met this week
  });
  it("only done check-ins (status 2) count; undone rows show as undone (HAB-017)", () => {
    const rows = [ck("h1", 20261111, 1, 0)];
    expect(habitStats(mwf, rows, 20261112, 20261102, 1).totalCheckIns).toBe(0);
    expect(dayState(mwf, rows[0], 20261111, 20261112, 20261102)).toBe("undone");
    expect(dayState(mwf, undefined, 20261110, 20261112, 20261102)).toBe("rest");
    expect(dayState(mwf, undefined, 20261109, 20261112, 20261102)).toBe("due");
    expect(dayState({ ...mwf, exDates: ["20261109"] }, undefined, 20261109, 20261112, 20261102)).toBe("skipped");
    expect(dayState(mwf, ck("h1", 20261111, 0, 0.5), 20261111, 20261112, 20261102)).toBe("partial");
  });
  it("skipped days (exDates) do not break the streak (RPT-104)", () => {
    const done = [20261109, 20261113].map((d) => ck("h1", d));
    expect(habitStats(mwf, done, 20261114, 20261102, 1).currentStreak).toBe(1); // Wednesday the 11th missed
    expect(habitStats({ ...mwf, exDates: ["20261111"] }, done, 20261114, 20261102, 1).currentStreak).toBe(2);
  });
});

describe("grids and review", () => {
  it("November 2026 starting Monday has 5 rows, the 1st (a Sunday) in the last column", () => {
    const g = monthGrid(202611, 1);
    expect(g[0]).toEqual([0, 0, 0, 0, 0, 0, 20261101]);
    expect(g.length).toBe(6);
    expect(monthGrid(202611, 0)[0]![0]).toBe(20261101);
  });
  it("weekly review gives done over due per week (HAB-031)", () => {
    const daily: Habit = { ...newHabit({ id: "d" }), targetStartDate: 20261101 };
    const r = weeklyReview(daily, [ck("d", 20261109), ck("d", 20261110), ck("d", 20261116)], 20261116, 20261101, 1, 3);
    expect(r.map((w) => [w.week, w.done, w.due])).toEqual([
      [20261102, 0, 7],
      [20261109, 2, 7],
      [20261116, 1, 1],
    ]);
  });
  it("sort by check-in status puts habits still open today first (HAB-004)", () => {
    const a = newHabit({ id: "a", name: "A", sortOrder: 1 });
    const b = newHabit({ id: "b", name: "B", sortOrder: 2 });
    expect(sortHabits([a, b], true, (h) => h.id === "a").map((h) => h.id)).toEqual(["b", "a"]);
    expect(sortHabits([b, a], false, () => false).map((h) => h.id)).toEqual(["a", "b"]);
  });
});
