import { beforeAll, describe, expect, test } from "vitest";
import { hex } from "./helpers.js";
import { T0, id, isoWire, mk4, type M } from "./m4helpers.js";

/**
 * A synthetic 90-day account. Day index i counts back from today (i = 0 is Sunday 2026-11-15, UTC).
 * Every day: one undated task in Inbox, created 09:00, completed 10:00.
 * i % 3 == 0: a task in Work (tag "deep"), created 09:00, due 18:00, completed 15:00 (on time).
 * i % 5 == 0: a task in Home, created 07:00, due 08:00, completed 11:00 (overdue).
 * i in {2, 10, 30}: an open task in Home, created 09:00, due 12:00 (never completed).
 * Focus: i even: a pomodoro 09:00-09:25; i % 10 == 0: a stopwatch 20:30-21:30 (unbound).
 */
const day = (i: number, h = 0, min = 0): number => Date.UTC(2026, 10, 15 - i, h, min);
const tid = (p: string, i: number): string => `${p}${String(i).padStart(2, "0")}`.padEnd(24, "0");
const DAYS = 90;

async function fixture(): Promise<{ m: M; work: string; home: string }> {
  const m = await mk4();
  const work = hex();
  const home = hex();
  await m.call("POST", "/api/v2/batch/project", { add: [{ id: work, name: "Work", sortOrder: 0, kind: "TASK" }, { id: home, name: "Home", sortOrder: 1, kind: "TASK" }] });
  const tasks: any[] = [];
  const mkT = (idv: string, projectId: string, i: number, o: Record<string, unknown>) => ({ id: idv, projectId, title: idv, priority: 0, sortOrder: 0, kind: "TEXT", timeZone: "UTC", isAllDay: false, ...o, i });
  for (let i = 0; i < DAYS; i++) {
    tasks.push(mkT(tid("ib", i), m.svc.inboxId, i, { status: 2, createdTime: isoWire(day(i, 9)), completedTime: isoWire(day(i, 10)) }));
    if (i % 3 === 0) tasks.push(mkT(tid("wk", i), work, i, { status: 2, tags: ["deep"], createdTime: isoWire(day(i, 9)), dueDate: isoWire(day(i, 18)), completedTime: isoWire(day(i, 15)) }));
    if (i % 5 === 0) tasks.push(mkT(tid("od", i), home, i, { status: 2, createdTime: isoWire(day(i, 7)), dueDate: isoWire(day(i, 8)), completedTime: isoWire(day(i, 11)) }));
    if ([2, 10, 30].includes(i)) tasks.push(mkT(tid("op", i), home, i, { status: 0, createdTime: isoWire(day(i, 9)), dueDate: isoWire(day(i, 12)) }));
  }
  for (const t of tasks) delete t.i;
  const r = await m.call("POST", "/api/v2/batch/task", { add: tasks });
  expect(r.json.id2error).toEqual({});
  const binds: Record<number, any[]> = {
    0: [{ taskId: tid("ib", 0), title: "a" }, { taskId: tid("wk", 0), title: "b" }],
    2: [{ taskId: tid("ib", 2) }],
    4: [{ taskId: tid("ib", 4) }],
    6: [{ taskId: tid("wk", 6) }],
  };
  const pomos: any[] = [];
  const sw: any[] = [];
  for (let i = 0; i < DAYS; i++) {
    if (i % 2 === 0) pomos.push({ id: id("p"), startTime: day(i, 9), endTime: day(i, 9, 25), pauseDuration: 0, tasks: binds[i] ?? [] });
    if (i % 10 === 0) sw.push({ id: id("w"), startTime: day(i, 20, 30), endTime: day(i, 21, 30), pauseDuration: 0, tasks: [] });
  }
  await m.call("POST", "/api/v2/batch/pomodoro", { add: pomos });
  await m.call("POST", "/api/v2/batch/pomodoro/timing", { add: sw });
  return { m, work, home };
}

let F: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  F = await fixture();
});
const get = async (url: string) => (await F.m.call("GET", url)).json;

describe("statistics/general on the 90-day dataset", () => {
  test("headline numbers", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(g).toMatchObject({ todayCompleted: 3, yesterdayCompleted: 1, totalCompleted: 138, score: 612, level: 3 });
  });
  test("has the expected summary key set", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(Object.keys(g).sort()).toEqual(["level", "pomoByDay", "pomoByMonth", "pomoByWeek", "pomoDurationGoal", "pomoGoal", "score", "scoreByDay", "taskByDay", "taskByMonth", "taskByWeek", "todayCompleted", "todayPomoCount", "todayPomoDuration", "totalCompleted", "totalPomoCount", "totalPomoDuration", "yesterdayCompleted", "yesterdayPomoCount", "yesterdayPomoDuration"].sort());
  });
  test("taskByDay: seven days ending today, complete and not-complete counts", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(g.taskByDay).toEqual({
      "20261109": { completeCount: 2, notCompleteCount: 0 },
      "20261110": { completeCount: 2, notCompleteCount: 0 },
      "20261111": { completeCount: 1, notCompleteCount: 0 },
      "20261112": { completeCount: 2, notCompleteCount: 0 },
      "20261113": { completeCount: 1, notCompleteCount: 1 },
      "20261114": { completeCount: 1, notCompleteCount: 0 },
      "20261115": { completeCount: 3, notCompleteCount: 0 },
    });
  });
  test("taskByWeek: seven Sunday-start weeks", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(Object.keys(g.taskByWeek)).toEqual(["20261004", "20261011", "20261018", "20261025", "20261101", "20261108", "20261115"]);
    expect(g.taskByWeek["20261115"]).toEqual({ completeCount: 3, notCompleteCount: 0 });
    expect(g.taskByWeek["20261108"]).toEqual({ completeCount: 10, notCompleteCount: 1 });
  });
  test("taskByMonth: seven months keyed by the 1st", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(Object.keys(g.taskByMonth)).toEqual(["20260501", "20260601", "20260701", "20260801", "20260901", "20261001", "20261101"]);
    expect(g.taskByMonth["20261101"]).toEqual({ completeCount: 23, notCompleteCount: 2 });
    expect(g.taskByMonth["20261001"]).toEqual({ completeCount: 49, notCompleteCount: 1 });
    expect(g.taskByMonth["20260901"]).toEqual({ completeCount: 46, notCompleteCount: 0 });
    expect(g.taskByMonth["20260801"]).toEqual({ completeCount: 20, notCompleteCount: 0 });
    expect(g.taskByMonth["20260701"]).toEqual({ completeCount: 0, notCompleteCount: 0 });
  });
  test("the four months with data add up to the total", async () => {
    const g = await get("/api/v2/statistics/general");
    const sum = Object.values(g.taskByMonth).reduce((n: number, v: any) => n + v.completeCount, 0);
    expect(sum).toBe(138);
  });
  test("scoreByDay is a running total", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(g.scoreByDay).toEqual({ "20261109": 568, "20261110": 576, "20261111": 580, "20261112": 590, "20261113": 595, "20261114": 598, "20261115": 612 });
    expect(g.scoreByDay["20261115"]).toBe(g.score);
  });
  test("focus numbers: counts and minutes", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(g).toMatchObject({ todayPomoCount: 1, todayPomoDuration: 85, yesterdayPomoCount: 0, yesterdayPomoDuration: 0, totalPomoCount: 45, totalPomoDuration: 1665, pomoGoal: 4, pomoDurationGoal: 0 });
  });
  test("pomoByDay only lists days with focus", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(g.pomoByDay).toEqual({ "20261109": { count: 1, duration: 25 }, "20261111": { count: 1, duration: 25 }, "20261113": { count: 1, duration: 25 }, "20261115": { count: 1, duration: 85 } });
  });
  test("pomoByWeek and pomoByMonth", async () => {
    const g = await get("/api/v2/statistics/general");
    expect(g.pomoByWeek["20261115"]).toEqual({ count: 1, duration: 85 });
    expect(g.pomoByWeek["20261108"]).toEqual({ count: 3, duration: 75 });
    expect(g.pomoByWeek["20261101"]).toEqual({ count: 4, duration: 160 });
    expect(g.pomoByWeek["20261025"]).toEqual({ count: 3, duration: 135 });
    expect(g.pomoByMonth["20261101"]).toEqual({ count: 8, duration: 320 });
    expect(g.pomoByMonth["20261001"]).toEqual({ count: 15, duration: 555 });
  });
  test("the daily goal comes from the pomodoro preferences", async () => {
    await F.m.call("PUT", "/api/v2/user/preferences/pomodoro", { pomoGoal: 6, focusDuration: 120 });
    const g = await get("/api/v2/statistics/general");
    expect(g).toMatchObject({ pomoGoal: 6, pomoDurationGoal: 120 });
    await F.m.call("PUT", "/api/v2/user/preferences/pomodoro", { pomoGoal: 4, focusDuration: null });
  });
});

describe("ranking and colours", () => {
  test("user/ranking counts", async () => {
    expect(await get("/api/v3/user/ranking")).toEqual({ ranking: 0.99, taskCount: 141, projectCount: 3, dayCount: 90, completedCount: 138, score: 612, level: 3 });
  });
  test("statistics/color keys are list and tag names", async () => {
    await F.m.call("POST", "/api/v2/batch/tag", { add: [{ name: "deep", rawName: "deep", label: "deep", color: "#112233", sortOrder: 0, type: 1 }, { name: "plain", rawName: "plain", label: "plain", sortOrder: 1, type: 1 }] });
    await F.m.call("POST", "/api/v2/batch/project", { update: [{ id: F.work, name: "Work", sortOrder: 0, kind: "TASK", color: "#abcdef" }] });
    const c = await get("/api/v2/statistics/color");
    expect(c.project2color).toEqual({ Work: "#abcdef", Home: null });
    expect(c.tag2color).toEqual({ deep: "#112233", plain: null });
  });
});

describe("task/statistics ranges", () => {
  test("seven daily rows with the four counts and the maps", async () => {
    const rows = await get("/api/v2/task/statistics/20261109/20261115");
    expect(rows).toHaveLength(7);
    expect(rows.map((r: any) => r.day)).toEqual(["20261109", "20261110", "20261111", "20261112", "20261113", "20261114", "20261115"]);
    expect(rows[6]).toEqual({
      overdueCompleteCount: 1, onTimeCompleteCount: 1, noTimeCompleteCount: 1, notCompleteCount: 0,
      projectCompleteCounts: { Inbox: 1, Work: 1, Home: 1 }, tagCompleteCounts: { UNKNOWN_CATEGORY: 2, deep: 1 }, day: "20261115", timezone: "UTC",
    });
    expect(rows[0]).toMatchObject({ onTimeCompleteCount: 1, noTimeCompleteCount: 1, overdueCompleteCount: 0 });
    expect(rows[1]).toMatchObject({ overdueCompleteCount: 1, noTimeCompleteCount: 1, onTimeCompleteCount: 0 });
    expect(rows[4]).toMatchObject({ noTimeCompleteCount: 1, notCompleteCount: 1 });
  });
  test("rate: completeCount over completeCount plus notCompleteCount", async () => {
    const rows = await get("/api/v2/task/statistics/20261113/20261113");
    const done = rows[0].overdueCompleteCount + rows[0].onTimeCompleteCount + rows[0].noTimeCompleteCount;
    expect(done / (done + rows[0].notCompleteCount)).toBe(0.5);
  });
  test("a single day", async () => {
    const rows = await get("/api/v2/task/statistics/20261115");
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("20261115");
  });
  test("week and month forms", async () => {
    const weeks = await get("/api/v2/task/statistics/week/20261115/2");
    expect(weeks.map((r: any) => r.day)).toEqual(["20261108", "20261115"]);
    expect(weeks[0]).toMatchObject({ noTimeCompleteCount: 7, onTimeCompleteCount: 2, overdueCompleteCount: 1, notCompleteCount: 1 });
    const months = await get("/api/v2/task/statistics/month/20261115/2");
    expect(months.map((r: any) => r.day)).toEqual(["20261001", "20261101"]);
    expect(months[1]).toMatchObject({ noTimeCompleteCount: 15, onTimeCompleteCount: 5, overdueCompleteCount: 3, notCompleteCount: 2 });
    expect(months[1].projectCompleteCounts).toEqual({ Inbox: 15, Work: 5, Home: 3 });
  });
  test("class counts of a month match the general taskByMonth", async () => {
    const [oct] = await get("/api/v2/task/statistics/month/20261015/1");
    expect(oct.noTimeCompleteCount + oct.onTimeCompleteCount + oct.overdueCompleteCount).toBe(49);
    expect(oct.notCompleteCount).toBe(1);
  });
  test("bad ranges are 400", async () => {
    for (const u of ["/api/v2/task/statistics/20261115/20261101", "/api/v2/task/statistics/2026/2027", "/api/v2/task/statistics/20260230/20260301", "/api/v2/task/statistics/20000101/20261115", "/api/v2/task/statistics/week/20261115/0", "/api/v2/task/statistics/month/20261115/x"]) {
      expect((await F.m.call("GET", u)).status).toBe(400);
    }
  });
});

describe("focus statistics endpoints", () => {
  test("generalForDesktop", async () => {
    expect(await get("/api/v2/pomodoros/statistics/generalForDesktop")).toEqual({
      todayPomoCount: 1, yesterdayPomoCount: 0, totalPomoCount: 45, todayPomoDuration: 85, yesterdayPomoDuration: 0, totalPomoDuration: 1665,
      todayTimingCount: 1, totalTimingCount: 9, pomoGoal: 4, pomoDurationGoal: 0,
    });
  });
  test("dist by list, tag, task and unbound", async () => {
    const d = await get("/api/v2/pomodoros/statistics/dist/20261109/20261115");
    expect(d).toMatchObject({ from: "20261109", to: "20261115", totalDuration: 160, unboundDuration: 60, projectDurations: { Inbox: 62.5, Work: 37.5 }, tagDurations: { deep: 37.5 } });
    expect(d.taskDurations[tid("ib", 0)].duration).toBe(12.5);
    expect(d.taskDurations[tid("wk", 0)].duration).toBe(12.5);
    expect(d.taskDurations[tid("wk", 6)].duration).toBe(25);
    expect(d.taskDurations[tid("ib", 2)].duration).toBe(25);
  });
  test("dist of a day with only unbound focus", async () => {
    const d = await get("/api/v2/pomodoros/statistics/dist/20260819/20260819");
    expect(d.totalDuration).toBe(25);
    expect(d.projectDurations).toEqual({});
  });
  test("dist/clock: minutes per hour of day over the whole range", async () => {
    const c = await get("/api/v2/pomodoros/statistics/dist/clock/20260818/20261115");
    expect(Object.keys(c)).toHaveLength(24);
    expect(c["9"]).toBe(1125);
    expect(c["20"]).toBe(270);
    expect(c["21"]).toBe(270);
    expect(c["0"]).toBe(0);
  });
  test("dist/clockByDay", async () => {
    const c = await get("/api/v2/pomodoros/statistics/dist/clockByDay/20261109/20261115");
    expect(Object.keys(c)).toEqual(["20261109", "20261111", "20261113", "20261115"]);
    expect(c["20261115"]["9"]).toBe(25);
    expect(c["20261115"]["20"]).toBe(30);
    expect(c["20261115"]["21"]).toBe(30);
    expect(c["20261113"]["9"]).toBe(25);
  });
  test("heatmap: minutes per day", async () => {
    expect(await get("/api/v2/pomodoros/statistics/heatmap/20261109/20261115")).toEqual({ "20261109": 25, "20261111": 25, "20261113": 25, "20261115": 85 });
  });
  test("heatmap over the full range adds up to the total", async () => {
    const h = await get("/api/v2/pomodoros/statistics/heatmap/20260818/20261115");
    expect(Object.values(h).reduce((n: number, v) => n + (v as number), 0)).toBe(1665);
  });
  test("bad focus ranges are 400", async () => {
    for (const u of ["/api/v2/pomodoros/statistics/dist/x/y", "/api/v2/pomodoros/statistics/heatmap/20261115/20261101", "/api/v2/pomodoros/statistics/dist/clock/20000101/20261115"]) {
      expect((await F.m.call("GET", u)).status).toBe(400);
    }
  });
});

describe("summary data endpoint (completed tasks of a period)", () => {
  test("project/all/completed with from, to and limit=1000", async () => {
    const r = await get("/api/v2/project/all/completed/?from=2026-11-09%2000:00:00&to=2026-11-15%2023:59:59&limit=1000");
    expect(r).toHaveLength(12);
    expect(r.every((t: any) => t.status === 2)).toBe(true);
  });
  test("limit 1000 is not capped below the data", async () => {
    const r = await get("/api/v2/project/all/completed/?from=2026-01-01%2000:00:00&to=2026-12-31%2023:59:59&limit=1000");
    expect(r).toHaveLength(138);
  });
  test("a smaller limit is honoured, newest first", async () => {
    const r = await get("/api/v2/project/all/completed/?from=2026-01-01%2000:00:00&to=2026-12-31%2023:59:59&limit=5");
    expect(r).toHaveLength(5);
    expect(r[0].completedTime >= r[4].completedTime).toBe(true);
  });
  test("recentProjectUsers is the empty list the summary screen asks for", async () => {
    expect(await get("/api/v2/project/share/recentProjectUsers")).toEqual([]);
  });
});

describe("time zones and week start", () => {
  test("the same data in Amsterdam moves late-evening focus to the next local day", async () => {
    const m = await mk4("Europe/Amsterdam", Date.UTC(2026, 10, 15, 12));
    await m.call("POST", "/api/v2/batch/pomodoro", { add: [{ id: id("p"), startTime: Date.UTC(2026, 10, 14, 23, 30), endTime: Date.UTC(2026, 10, 14, 23, 55), tasks: [] }] });
    const heat = (await m.call("GET", "/api/v2/pomodoros/statistics/heatmap/20261114/20261116")).json;
    expect(heat).toEqual({ "20261115": 25 });
    const clock = (await m.call("GET", "/api/v2/pomodoros/statistics/dist/clock/20261114/20261116")).json;
    expect(clock["0"]).toBe(25);
    expect((await m.call("GET", "/api/v2/statistics/general")).json.todayPomoCount).toBe(1);
  });
  test("a task completed at 23:30 UTC counts on the local next day in Amsterdam", async () => {
    const m = await mk4("Europe/Amsterdam", Date.UTC(2026, 10, 15, 12));
    await m.call("POST", "/api/v2/batch/task", { add: [{ id: hex(), projectId: m.svc.inboxId, title: "t", status: 2, createdTime: isoWire(Date.UTC(2026, 10, 14, 8)), completedTime: isoWire(Date.UTC(2026, 10, 14, 23, 30)) }] });
    const g = (await m.call("GET", "/api/v2/statistics/general")).json;
    expect(g.todayCompleted).toBe(1);
    expect(g.yesterdayCompleted).toBe(0);
    expect((await m.call("GET", "/api/v2/task/statistics/20261115/20261115")).json[0].timezone).toBe("Europe/Amsterdam");
  });
  test("a Monday week start moves the week keys", async () => {
    const m = await mk4();
    await m.call("PUT", "/api/v2/user/preferences/settings", { startDayOfWeek: "MON" });
    const g = (await m.call("GET", "/api/v2/statistics/general")).json;
    expect(Object.keys(g.taskByWeek)[6]).toBe("20261109");
  });
  test("an invalid stored zone falls back to UTC", async () => {
    const m = await mk4();
    await m.call("PUT", "/api/v2/user/preferences/settings", { timeZone: "Not/AZone" });
    expect((await m.call("GET", "/api/v2/task/statistics/20261115/20261115")).json[0].timezone).toBe("UTC");
  });
});

describe("empty account", () => {
  test("every statistic answers with zeros and the expected shape", async () => {
    const m = await mk4();
    const g = (await m.call("GET", "/api/v2/statistics/general")).json;
    expect(g).toMatchObject({ score: 0, level: 1, totalCompleted: 0, todayCompleted: 0, pomoByDay: {}, pomoByWeek: {}, pomoByMonth: {} });
    expect(Object.keys(g.taskByDay)).toHaveLength(7);
    expect(Object.keys(g.scoreByDay)).toHaveLength(7);
    expect(Object.values(g.scoreByDay).every((v) => v === 0)).toBe(true);
    expect((await m.call("GET", "/api/v3/user/ranking")).json).toEqual({ ranking: 0.99, taskCount: 0, projectCount: 1, dayCount: 0, completedCount: 0, score: 0, level: 1 });
    expect((await m.call("GET", "/api/v2/statistics/color")).json).toEqual({ project2color: {}, tag2color: {} });
    expect((await m.call("GET", "/api/v2/pomodoros/statistics/heatmap/20261101/20261115")).json).toEqual({});
  });
});

describe("overlapping focus records", () => {
  test("durations count the overlap once, counts count every record", async () => {
    const m = await mk4();
    const base = Date.UTC(2026, 10, 15, 9);
    await m.call("POST", "/api/v2/batch/pomodoro", { add: [
      { id: id("p"), startTime: base, endTime: base + 30 * 60000, tasks: [] },
      { id: id("p"), startTime: base + 20 * 60000, endTime: base + 50 * 60000, tasks: [] },
    ] });
    const g = (await m.call("GET", "/api/v2/statistics/general")).json;
    expect(g).toMatchObject({ todayPomoCount: 2, todayPomoDuration: 50 });
    expect((await m.call("GET", "/api/v2/pomodoros/statistics/heatmap/20261115/20261115")).json).toEqual({ "20261115": 50 });
    expect((await m.call("GET", "/api/v2/pomodoros?from=0")).json).toHaveLength(2);
  });
  test("a second device's identical record changes the count but not the minutes", async () => {
    const m = await mk4();
    const base = Date.UTC(2026, 10, 15, 9);
    const mk = () => ({ id: id("p"), startTime: base, endTime: base + 25 * 60000, tasks: [] });
    await m.call("POST", "/api/v2/batch/pomodoro", { add: [mk(), mk()] });
    expect((await m.call("GET", "/api/v2/statistics/general")).json).toMatchObject({ todayPomoCount: 2, todayPomoDuration: 25 });
  });
  test("pauses are not focus time; the adjustment is", async () => {
    const m = await mk4();
    const base = Date.UTC(2026, 10, 15, 9);
    await m.call("POST", "/api/v2/batch/pomodoro", { add: [{ id: id("p"), startTime: base, endTime: base + 30 * 60000, pauseDuration: 300, tasks: [] }, { id: id("p"), startTime: base + 3 * 3600_000, endTime: base + 3 * 3600_000 + 25 * 60000, adjustTime: 300, tasks: [] }] });
    expect((await m.call("GET", "/api/v2/statistics/general")).json.todayPomoDuration).toBe(25 + 30);
  });
  test("a record that crosses midnight is split by hour for the heatmap", async () => {
    const m = await mk4();
    await m.call("POST", "/api/v2/batch/pomodoro/timing", { add: [{ id: id("w"), startTime: Date.UTC(2026, 10, 14, 23, 30), endTime: Date.UTC(2026, 10, 15, 0, 30), tasks: [] }] });
    expect((await m.call("GET", "/api/v2/pomodoros/statistics/heatmap/20261114/20261115")).json).toEqual({ "20261114": 30, "20261115": 30 });
  });
});

describe("achievement score rules", () => {
  const add = (m: M, o: Record<string, unknown>) => m.call("POST", "/api/v2/batch/task", { add: [{ id: hex(), projectId: m.svc.inboxId, title: "t", ...o }] });
  test("creating a task is 1 point", async () => {
    const m = await mk4();
    await add(m, { status: 0, createdTime: isoWire(T0 - 3600_000) });
    expect((await m.call("GET", "/api/v2/statistics/general")).json.score).toBe(1);
  });
  test("completing an undated task is 3 more", async () => {
    const m = await mk4();
    await add(m, { status: 2, createdTime: isoWire(T0 - 7200_000), completedTime: isoWire(T0 - 3600_000) });
    expect((await m.call("GET", "/api/v2/statistics/general")).json.score).toBe(4);
  });
  test("completing on time adds 2", async () => {
    const m = await mk4();
    await add(m, { status: 2, createdTime: isoWire(T0 - 7200_000), dueDate: isoWire(T0 + 3600_000), completedTime: isoWire(T0 - 3600_000) });
    expect((await m.call("GET", "/api/v2/statistics/general")).json.score).toBe(6);
  });
  test("an open task that expired costs 1 the day after its due day", async () => {
    const m = await mk4();
    await add(m, { status: 0, createdTime: isoWire(Date.UTC(2026, 10, 10, 8)), dueDate: isoWire(Date.UTC(2026, 10, 12, 8)) });
    const g = (await m.call("GET", "/api/v2/statistics/general")).json;
    expect(g.score).toBe(0); // +1 created, -1 expired, clamped at zero
    expect(g.scoreByDay["20261112"]).toBe(1);
    expect(g.scoreByDay["20261113"]).toBe(0);
  });
  test("completing late (a day after) is 3 minus the expiry", async () => {
    const m = await mk4();
    await add(m, { status: 2, createdTime: isoWire(Date.UTC(2026, 10, 9, 8)), dueDate: isoWire(Date.UTC(2026, 10, 10, 8)), completedTime: isoWire(Date.UTC(2026, 10, 12, 8)) });
    expect((await m.call("GET", "/api/v2/statistics/general")).json.score).toBe(1 + 3 - 1);
  });
  test("trashed tasks and notes do not score", async () => {
    const m = await mk4();
    await add(m, { status: 0, createdTime: isoWire(T0 - 3600_000), kind: "NOTE" });
    const t = hex();
    await m.call("POST", "/api/v2/batch/task", { add: [{ id: t, projectId: m.svc.inboxId, title: "x", status: 0, createdTime: isoWire(T0 - 3600_000) }] });
    await m.call("POST", "/api/v2/batch/task", { delete: [{ taskId: t, projectId: m.svc.inboxId }] });
    expect((await m.call("GET", "/api/v2/statistics/general")).json.score).toBe(0);
  });
  test("level thresholds", async () => {
    const { levelOf, LEVEL_THRESHOLDS } = await import("../src/stats.js");
    expect(LEVEL_THRESHOLDS).toHaveLength(12);
    expect([0, 99, 100, 499, 500, 5344, 5000, 499999, 500000].map(levelOf)).toEqual([1, 1, 2, 2, 3, 6, 6, 11, 12]);
  });
});
