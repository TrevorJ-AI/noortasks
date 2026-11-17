import { describe, expect, test } from "vitest";
import type { Column, Task } from "../src/lib/core";
import { parseDate } from "../src/lib/dates";
import { ItemKind, calendarItems, isoWeek, layoutDayEvents, layoutSpans, monthGridDays, spanFields, taskSpan } from "../src/model/calendar";
import { UNSECTIONED, lanePatch, listLanes, orderAt, sortColumns, swapFirstTag } from "../src/model/kanban";
import { allowedModes, parseHash, taskPath, viewPath, routeTaskPath } from "../src/model/router";
import { PX_PER_DAY, barFields, barOf, moveBar, resizeBar, timeAt, xOf } from "../src/model/timeline";

// a zone with DST, as in Playwright; the assertions below check the offset really changes
process.env.TZ = "Europe/Amsterdam";

const local = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
const wire = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
const T = (p: Partial<Task>): Task => ({ id: Math.random().toString(16).slice(2), projectId: "p1", title: "t", status: 0, sortOrder: 0, ...p }) as Task;

describe("time zone guard", () => {
  test("the test zone has DST on 2026-03-29 and 2026-10-25", () => {
    expect(new Date(local(2026, 3, 28, 12)).getTimezoneOffset()).toBe(-60);
    expect(new Date(local(2026, 3, 30, 12)).getTimezoneOffset()).toBe(-120);
    expect(new Date(local(2026, 10, 26, 12)).getTimezoneOffset()).toBe(-60);
  });
});

describe("kanban columns (KANB-004..007)", () => {
  const col = (id: string, sortOrder: number, createdTime = ""): Column => ({ id, name: id, projectId: "p1", sortOrder, createdTime });
  test("columns order by sortOrder, then created time, then id", () => {
    const cols = [col("c", 2), col("a", 1, "2026-01-02"), col("b", 1, "2026-01-01"), col("z", 0)];
    expect(sortColumns(cols).map((c) => c.id)).toEqual(["z", "b", "a", "c"]);
  });
  test("lanes: unknown or missing columnId goes to Not Sectioned; subtasks ride on their parent", () => {
    const cols = [col("c1", 2 ** 40), col("c2", 0)];
    const parent = T({ id: "par", columnId: "c1", sortOrder: 5 });
    const tasks = [T({ id: "a", columnId: "c2", sortOrder: 2 }), T({ id: "b", columnId: "c2", sortOrder: 1 }), parent, T({ id: "kid", parentId: "par", columnId: "c2" }), T({ id: "lost", columnId: "deleted" }), T({ id: "other", projectId: "p2" })];
    const lanes = listLanes("p1", cols, tasks);
    expect(lanes.map((l) => l.key)).toEqual([UNSECTIONED, "c2", "c1"]);
    expect(lanes[0]!.tasks.map((t) => t.id)).toEqual(["lost"]);
    expect(lanes[1]!.tasks.map((t) => t.id)).toEqual(["b", "a"]);
    expect(lanes[2]!.tasks.map((t) => t.id)).toEqual(["par"]);
  });
  test("a list without columns shows one Not Sectioned lane; 100 columns are fine (KANB-006)", () => {
    expect(listLanes("p1", [], []).map((l) => l.name)).toEqual(["Not Sectioned"]);
    const many = Array.from({ length: 100 }, (_, i) => col(`c${i}`, i));
    expect(listLanes("p1", many, []).length).toBe(100);
  });
  test("drop order between neighbours and at the ends", () => {
    expect(orderAt([0, 100], 1)).toBe(50);
    expect(orderAt([0, 100], 0)! < 0).toBe(true);
    expect(orderAt([0, 100], 2)! > 100).toBe(true);
    expect(orderAt([5, 6], 1)).toBeNull();
  });
  test("attribute lanes map to the field they change (KANB-010)", () => {
    expect(lanePatch("priority_5")).toEqual({ priority: 5 });
    expect(lanePatch("tomorrow")).toEqual({ dayOffset: 1 });
    expect(lanePatch("nodate")).toEqual({ dayOffset: null });
    expect(lanePatch("p_abc")).toEqual({ projectId: "abc" });
    expect(lanePatch("tag_home")).toEqual({ tag: "home" });
    expect(swapFirstTag(["Work", "x"], "work", "home")).toEqual(["home", "x"]);
  });
});

describe("timeline date math with DST (TIME-007)", () => {
  const px = PX_PER_DAY.week;
  test("each local day is one day wide across the spring DST change", () => {
    const origin = local(2026, 3, 28);
    expect(xOf(local(2026, 3, 29), origin, px)).toBe(px);
    expect(xOf(local(2026, 3, 30), origin, px)).toBe(2 * px);
    expect(xOf(local(2026, 3, 30, 12), origin, px)).toBe(2.5 * px);
  });
  test("timeAt inverts xOf on DST days and snaps", () => {
    const origin = local(2026, 10, 24);
    expect(timeAt(xOf(local(2026, 10, 25, 9), origin, PX_PER_DAY.day), origin, PX_PER_DAY.day, 15)).toBe(local(2026, 10, 25, 9));
    expect(timeAt(1.4 * px, origin, px, 1440)).toBe(local(2026, 10, 25));
  });
  test("moving a timed bar by a day keeps the wall clock across DST", () => {
    const b = barOf({ startDate: wire(local(2026, 3, 28, 9)), dueDate: wire(local(2026, 3, 28, 10, 30)), isAllDay: false })!;
    const m = moveBar(b, 1);
    expect(new Date(m.start).getHours()).toBe(9);
    expect(m.start - b.start).toBe(23 * 3600_000); // 23 hour day
    expect(m.end - m.start).toBe(90 * 60_000);
  });
  test("moving and resizing all-day bars keeps local midnights", () => {
    const b = barOf({ startDate: wire(local(2026, 10, 24)), dueDate: wire(local(2026, 10, 24)), isAllDay: true })!;
    expect(b.end).toBe(local(2026, 10, 25));
    const m = moveBar(b, 1);
    expect(m.start).toBe(local(2026, 10, 25));
    expect(m.end).toBe(local(2026, 10, 26));
    const r = resizeBar(m, "end", local(2026, 10, 27, 20));
    expect(r.end).toBe(local(2026, 10, 28));
    const f = barFields(r);
    expect(parseDate(f.startDate)).toBe(local(2026, 10, 25));
    expect(parseDate(f.dueDate)).toBe(local(2026, 10, 28)); // exclusive end of a 3 day span
    expect(barFields(m).dueDate).toBe(barFields(m).startDate); // one day: start = due
  });
});

describe("calendar layout (CAL-013, CAL-014, CAL-045)", () => {
  test("overlapping blocks share the column width, separate clusters do not", () => {
    const h = (x: number): number => local(2026, 11, 18, x);
    const placed = layoutDayEvents([
      { key: "a", start: h(9), end: h(11) },
      { key: "b", start: h(10), end: h(12) },
      { key: "c", start: h(10.5), end: h(10.75) },
      { key: "d", start: h(11), end: h(13) },
      { key: "e", start: h(14), end: h(15) },
    ]);
    expect(placed.get("a")).toMatchObject({ col: 0, cols: 3 });
    expect(placed.get("b")).toMatchObject({ col: 1, cols: 3 });
    expect(placed.get("c")).toMatchObject({ col: 2, cols: 3 });
    expect(placed.get("d")).toMatchObject({ col: 0, cols: 3 }); // reuses a's column inside the same cluster
    expect(placed.get("e")).toMatchObject({ col: 0, cols: 1 });
  });
  test("spanning bars take the lowest free lane and clip to the row", () => {
    const row = local(2026, 11, 16);
    const out = layoutSpans(
      [
        { key: "long", start: local(2026, 11, 14), end: local(2026, 11, 19) },
        { key: "one", start: local(2026, 11, 17), end: local(2026, 11, 18) },
        { key: "late", start: local(2026, 11, 20), end: local(2026, 11, 24) },
      ],
      row,
      7,
    );
    const by = new Map(out.map((o) => [o.key, o]));
    expect(by.get("long")).toMatchObject({ lane: 0, startCol: 0, endCol: 2, clipStart: true, clipEnd: false });
    expect(by.get("one")).toMatchObject({ lane: 1, startCol: 1, endCol: 1 });
    expect(by.get("late")).toMatchObject({ lane: 0, startCol: 4, endCol: 6, clipEnd: true });
  });
  test("month grid covers whole weeks from the week start", () => {
    const days = monthGridDays(local(2026, 11, 18), 1);
    expect(days.length % 7).toBe(0);
    expect(new Date(days[0]!).getDay()).toBe(1);
    expect(days).toContain(local(2026, 11, 1));
    expect(days).toContain(local(2026, 11, 30));
    expect(monthGridDays(local(2026, 11, 18), 0, 2).length).toBe(14);
  });
  test("ISO week numbers (CAL-038)", () => {
    expect(isoWeek(local(2026, 1, 1))).toBe(1);
    expect(isoWeek(local(2027, 1, 1))).toBe(53);
    expect(isoWeek(local(2026, 11, 18))).toBe(47);
  });
  test("all-day spans use an exclusive end; a single day stores start = due", () => {
    const f = spanFields(local(2026, 11, 18), local(2026, 11, 21), true);
    expect(parseDate(f.dueDate)).toBe(local(2026, 11, 21));
    expect(taskSpan(f)).toEqual({ start: local(2026, 11, 18), end: local(2026, 11, 21), allDay: true });
    const one = spanFields(local(2026, 11, 18), local(2026, 11, 19), true);
    expect(one.dueDate).toBe(one.startDate);
  });
  test("item kinds: task 1, dated checklist item 2, subscribed event 3, repeat occurrence 4 (CAL-059)", () => {
    const from = local(2026, 11, 16);
    const to = local(2026, 11, 30);
    const tasks = [
      T({ id: "plain", startDate: wire(local(2026, 11, 17, 9)), dueDate: wire(local(2026, 11, 17, 10)), isAllDay: false }),
      T({ id: "rep", startDate: wire(local(2026, 11, 16)), dueDate: wire(local(2026, 11, 16)), isAllDay: true, repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1" }),
      T({ id: "chk", kind: "CHECKLIST", items: [{ id: "i1", title: "step", status: 0, sortOrder: 0, startDate: wire(local(2026, 11, 19)), isAllDay: true }] as never }),
    ];
    const items = calendarItems(tasks, { from, to, showCompleted: true, showChecklist: true, showFutureTask: true, showRepeat: true, now: local(2026, 11, 16, 8) }, [{ id: "ev", title: "event", start: local(2026, 11, 20, 12), end: local(2026, 11, 20, 13), allDay: false }]);
    const kinds = new Map(items.map((i) => [i.key, i.kind]));
    expect(kinds.get("plain")).toBe(ItemKind.Task);
    expect(kinds.get("rep")).toBe(ItemKind.Task);
    expect(kinds.get(`rep@${local(2026, 11, 23)}`)).toBe(ItemKind.Repeat);
    expect(kinds.get("chk/i1")).toBe(ItemKind.Subtask);
    expect(kinds.get("sub:ev")).toBe(ItemKind.Subscribe);
    // repeat cycles off: only the live instance
    const off = calendarItems(tasks, { from, to, showCompleted: true, showChecklist: false, showFutureTask: true, showRepeat: false, now: local(2026, 11, 16, 8) });
    expect(off.filter((i) => i.taskId === "rep").length).toBe(1);
    // future tasks off: nothing after today
    const past = calendarItems(tasks, { from, to, showCompleted: true, showChecklist: false, showFutureTask: false, showRepeat: false, now: local(2026, 11, 16, 8) });
    expect(past.map((i) => i.key)).toEqual(["rep"]);
  });
});

describe("routes for views and screens (VIEW-020, TIME-004, CAL-004, VIEW-039)", () => {
  test("view suffixes parse and build", () => {
    expect(parseHash("#p/abc/kanban")).toMatchObject({ view: { type: "project", id: "abc" }, mode: "kanban" });
    expect(parseHash("#g/f1/timeline/0123456789abcdef01234567")).toMatchObject({ mode: "timeline", taskId: "0123456789abcdef01234567" });
    expect(parseHash("#q/today/kanban")).toMatchObject({ view: { type: "smart", name: "today" }, mode: "kanban" });
    expect(parseHash("#p/abc/bogus")).toBeNull();
    expect(viewPath({ type: "project", id: "abc" }, "timeline")).toBe("p/abc/timeline");
    expect(viewPath({ type: "smart", name: "today" }, "timeline")).toBe("q/today/tasks"); // not offered on Today
    expect(allowedModes({ type: "smart", name: "week" })).toEqual(["tasks", "kanban"]);
    expect(taskPath({ type: "project", id: "abc" }, "0123456789abcdef01234567", "kanban")).toBe("p/abc/kanban/0123456789abcdef01234567");
  });
  test("calendar, matrix and day routes", () => {
    const c = parseHash("#c/all/calendar/w")!;
    expect(c).toMatchObject({ screen: "calendar", calType: "w" });
    expect(routeTaskPath(c, "0123456789abcdef01234567")).toBe("c/all/calendar/w/0123456789abcdef01234567");
    expect(parseHash("#c/all/calendar/y")!.calType).toBe("y");
    expect(parseHash("#m/all/matrix")).toMatchObject({ screen: "matrix" });
    expect(parseHash("#d/2026-12-12/tasks")).toMatchObject({ view: { type: "day", date: "2026-12-12" } });
  });
});
