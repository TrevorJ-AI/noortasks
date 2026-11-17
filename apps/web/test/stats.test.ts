import { describe, expect, it } from "vitest";
import { recordActiveMs } from "../src/lib/m4core";
import {
  BADGE_TRACKS,
  badgeProgress,
  cappedTotal,
  completionRate,
  completionSeries,
  focusRange,
  formatMinutes,
  heatLevelMinutes,
  levelProgress,
  pct,
  peakHour,
  periodRange,
  recordOpenDay,
  scorePoints,
  shiftFocusRange,
  shiftPeriod,
  sumBuckets,
  sumTaskRows,
  topEntries,
  trendBuckets,
  yearGrid,
  type TaskStatRow,
} from "../src/model/stats";

const track = (id: string) => BADGE_TRACKS.find((t) => t.id === id)!;

describe("completion rate (STAT-026, STAT-010)", () => {
  it("3 done and 1 open is 75 percent", () => {
    expect(completionRate(3, 1)).toBe(0.75);
    expect(pct(completionRate(3, 1))).toBe("75%");
  });
  it("nothing scheduled and nothing done has no rate", () => {
    expect(completionRate(0, 0)).toBeNull();
    expect(pct(null)).toBe("-");
  });
  it("rate series keeps a null for an empty day and the count line its zero", () => {
    const s = completionSeries({ "20261116": { completeCount: 2, notCompleteCount: 2 }, "20261115": { completeCount: 0, notCompleteCount: 0 } }, "day");
    expect(s.counts.map((p) => p.value)).toEqual([0, 2]);
    expect(s.rates.map((p) => p.value)).toEqual([null, 0.5]);
    expect(s.counts[0]!.label).toBe("Sun");
  });
});

describe("periods (STAT-011, STAT-019)", () => {
  it("daily, weekly with each week start, monthly", () => {
    // 2026-11-18 is a Wednesday
    expect(periodRange("day", 20261118, 0)).toEqual({ from: 20261118, to: 20261118 });
    expect(periodRange("week", 20261118, 0)).toEqual({ from: 20261115, to: 20261121 });
    expect(periodRange("week", 20261118, 1)).toEqual({ from: 20261116, to: 20261122 });
    expect(periodRange("week", 20261118, 6)).toEqual({ from: 20261114, to: 20261120 });
    expect(periodRange("month", 20260215, 0)).toEqual({ from: 20260201, to: 20260228 });
  });
  it("prev and next cross month and year ends; month shift clamps the day", () => {
    expect(shiftPeriod("day", 20261231, 1)).toBe(20270101);
    expect(shiftPeriod("week", 20260103, -1)).toBe(20251227);
    expect(shiftPeriod("month", 20260131, 1)).toBe(20260228);
    expect(shiftPeriod("month", 20260115, -1)).toBe(20251215);
  });
  it("focus ranges reach years back with no limit (PREM-098)", () => {
    expect(focusRange("year", 20241010, 0)).toEqual({ from: 20240101, to: 20241231 });
    expect(shiftFocusRange("year", shiftFocusRange("year", 20260301, -1), -1)).toBe(20240301);
    expect(shiftFocusRange("year", 20240229, 1)).toBe(20250228);
  });
});

describe("task statistics rows (STAT-013, STAT-014)", () => {
  const rows: TaskStatRow[] = [
    { day: "20261101", overdueCompleteCount: 1, onTimeCompleteCount: 2, noTimeCompleteCount: 1, notCompleteCount: 1, projectCompleteCounts: { Inbox: 2, Home: 2 }, tagCompleteCounts: { errands: 1, UNKNOWN_CATEGORY: 3 } },
    { day: "20261102", overdueCompleteCount: 0, onTimeCompleteCount: 1, noTimeCompleteCount: 0, notCompleteCount: 3, projectCompleteCounts: { Home: 1 }, tagCompleteCounts: { errands: 1 } },
  ];
  it("sums the four slices and the classified maps; slices add up to the row totals", () => {
    const t = sumTaskRows(rows);
    expect([t.overdue, t.onTime, t.undated, t.uncompleted]).toEqual([1, 3, 1, 4]);
    expect(t.completed).toBe(5);
    expect(t.rate).toBeCloseTo(5 / 9);
    expect(t.byList).toEqual({ Inbox: 2, Home: 3 });
    expect(t.byTag).toEqual({ errands: 2, UNKNOWN_CATEGORY: 3 });
    expect(sumTaskRows(null).rate).toBeNull();
  });
  it("top entries sort by value and fold the tail into Other", () => {
    expect(topEntries({ a: 1, b: 5, c: 3 })).toEqual([{ key: "b", value: 5 }, { key: "c", value: 3 }, { key: "a", value: 1 }]);
    const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 10 - i]));
    const top = topEntries(many, 4);
    expect(top.map((e) => e.key)).toEqual(["k0", "k1", "k2", "Other"]);
    expect(top[3]!.value).toBe(7 + 6 + 5 + 4 + 3 + 2 + 1);
  });
});

describe("score and level (STAT-006, STAT-007)", () => {
  it("score line has the last 7 days, oldest first", () => {
    const m = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [String(20261110 + i), i * 3]));
    const p = scorePoints(m);
    expect(p).toHaveLength(7);
    expect(p[0]!.key).toBe("20261110");
    expect(p[6]!.value).toBe(18);
  });
  it("level progress follows the server thresholds", () => {
    expect(levelProgress(0)).toMatchObject({ level: 1, from: 0, to: 100, share: 0 });
    expect(levelProgress(750)).toMatchObject({ level: 3, from: 500, to: 1000, share: 0.5 });
    expect(levelProgress(600000)).toMatchObject({ level: 12, to: null, share: 1 });
  });
});

describe("focus display (STAT-021..023)", () => {
  it("formats minutes", () => {
    expect(formatMinutes(85)).toBe("1h 25m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h");
    expect(formatMinutes(0)).toBe("0m");
  });
  it("heatmap levels and a year grid of whole weeks", () => {
    expect([0, 10, 30, 90, 200, 300].map(heatLevelMinutes)).toEqual([0, 1, 2, 3, 4, 5]);
    const g = yearGrid(2026, 0);
    expect(g.every((c) => c.length === 7)).toBe(true);
    expect(g.flat().filter((x) => x !== null)).toHaveLength(365);
    expect(g[0]![4]).toBe(20260101); // 2026-01-01 is a Thursday
  });
  it("peak hour and bucket sums", () => {
    expect(peakHour({ "9": 30, "14": 50, "20": 10 })).toBe(14);
    expect(peakHour({})).toBeNull();
    const b = trendBuckets("year", { from: 20260101, to: 20261231 });
    expect(b).toHaveLength(12);
    expect(sumBuckets({ "20260105": 30, "20260120": 15, "20260301": 60 }, b).slice(0, 3).map((p) => p.value)).toEqual([45, 0, 60]);
    expect(trendBuckets("week", { from: 20261115, to: 20261121 }).map((x) => x.label)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
  });
});

describe("badge tracks (STAT-029..033)", () => {
  it("perseverance: 3 distinct open days unlock medal 1, the 7th day medal 2 (STAT-029)", () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const day = (n: number) => new Date(2026, 10, n, 10).getTime();
    let days: string[] = [];
    for (const n of [1, 1, 2, 3]) days = recordOpenDay(day(n), store);
    expect(days).toHaveLength(3);
    expect(badgeProgress(track("perseverance"), days.length).level).toBe(1);
    for (const n of [4, 5, 6]) days = recordOpenDay(day(n), store);
    expect(badgeProgress(track("perseverance"), days.length).level).toBe(1);
    days = recordOpenDay(day(7), store);
    expect(badgeProgress(track("perseverance"), days.length)).toEqual({ value: 7, level: 2, next: 21 });
  });
  it("get things done: 60 completions in one day count 50 (STAT-030)", () => {
    const perDay = new Map([["20261101", 60], ["20261102", 4]]);
    expect(cappedTotal(perDay, track("gtd").dailyCap)).toBe(54);
    expect(badgeProgress(track("gtd"), 54).level).toBe(3);
  });
  it("mindfulness: 25 minutes unlock medal 1 and pomodoro plus stopwatch minutes add (STAT-031)", () => {
    const pomo = { startTime: "2026-11-01T09:00:00.000+0000", endTime: "2026-11-01T09:15:00.000+0000" };
    const watch = { startTime: "2026-11-01T10:00:00.000+0000", endTime: "2026-11-01T10:10:00.000+0000" };
    const minutes = (recordActiveMs(pomo) + recordActiveMs(watch)) / 60000;
    expect(minutes).toBe(25);
    expect(badgeProgress(track("mindfulness"), minutes).level).toBe(1);
    expect(badgeProgress(track("mindfulness"), 24).level).toBe(0);
  });
  it("self-discipline: 12 check-ins in one day count 10 (STAT-033)", () => {
    expect(cappedTotal({ "20261101": 12 }, track("discipline").dailyCap)).toBe(10);
    expect(badgeProgress(track("discipline"), 10).level).toBe(2);
  });
});
