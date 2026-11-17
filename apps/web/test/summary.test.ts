import { describe, expect, it } from "vitest";
import type { Task } from "../src/lib/core";
import { DEFAULT_DISPLAY, filterTasks, groupTasks, progressOf, focusOf, rangeOf, sortTasks, toMarkdown, toPlainText, withDepth } from "../src/model/summary";

const iso = (y: number, m: number, d: number, h = 12): string => new Date(y, m - 1, d, h).toISOString().replace("Z", "+0000");
const T = (p: Partial<Task> & { id: string; title: string }): Task => ({ projectId: "p1", status: 0, sortOrder: 0, priority: 0, ...p }) as Task;
const now = new Date(2026, 10, 18, 10).getTime(); // Wed 18 Nov 2026
const day = (y: number, m: number, d: number): number => new Date(y, m - 1, d).getTime();

const tasks: Task[] = [
  T({ id: "a", title: "Ship report", status: 2, completedTime: iso(2026, 11, 17, 9), projectId: "p1", priority: 5, tags: ["work"] }),
  T({ id: "b", title: "Water plants", status: 2, completedTime: iso(2026, 11, 18, 8), projectId: "p2" }),
  T({ id: "c", title: "Old thing", status: 2, completedTime: iso(2026, 11, 1), projectId: "p1" }),
  T({ id: "d", title: "Plan trip", status: 0, dueDate: iso(2026, 11, 20, 0), projectId: "p2", priority: 3, items: [{ id: "i1", title: "x", status: 2, sortOrder: 0 }, { id: "i2", title: "y", status: 0, sortOrder: 1 }] }),
  T({ id: "e", title: "Sub of a", status: 2, completedTime: iso(2026, 11, 17, 10), parentId: "a", projectId: "p1" }),
  T({ id: "f", title: "Note", status: 0, kind: "NOTE", dueDate: iso(2026, 11, 19) }),
  T({ id: "g", title: "Trashed", status: 2, completedTime: iso(2026, 11, 18), deleted: 1 }),
];

describe("summary ranges (SMART-046, NOTE-021)", () => {
  it("default next 7 days is today 00:00 to +6 days 23:59:59", () => {
    const r = rangeOf({ range: "next7" }, now, 1);
    expect(r.from).toBe(day(2026, 11, 18));
    expect(r.to).toBe(day(2026, 11, 25) - 1000);
  });
  it("this week and last week follow the week start", () => {
    expect(rangeOf({ range: "thisWeek" }, now, 1).from).toBe(day(2026, 11, 16));
    expect(rangeOf({ range: "thisWeek" }, now, 0).from).toBe(day(2026, 11, 15));
    expect(rangeOf({ range: "lastWeek" }, now, 1)).toEqual({ from: day(2026, 11, 9), to: day(2026, 11, 16) - 1000 });
  });
  it("months and custom", () => {
    expect(rangeOf({ range: "thisMonth" }, now, 1)).toEqual({ from: day(2026, 11, 1), to: day(2026, 12, 1) - 1000 });
    expect(rangeOf({ range: "lastMonth" }, now, 1)).toEqual({ from: day(2026, 10, 1), to: day(2026, 11, 1) - 1000 });
    expect(rangeOf({ range: "custom", from: "2026-11-20", to: "2026-11-10" }, now, 1)).toEqual({ from: day(2026, 11, 10), to: day(2026, 11, 21) - 1000 });
    expect(rangeOf({ range: "today" }, now, 1)).toEqual({ from: day(2026, 11, 18), to: day(2026, 11, 19) - 1000 });
  });
});

describe("summary filters, grouping, sorting (NOTE-021, NOTE-023, NOTE-802)", () => {
  const week = rangeOf({ range: "thisWeek" }, now, 1);
  it("completed inside the period; notes and trash never count", () => {
    expect(filterTasks(tasks, { range: "thisWeek", lists: [], status: "completed", priorities: [] }, week).map((t) => t.id).sort()).toEqual(["a", "b", "e"]);
  });
  it("uncompleted are open tasks dated in the period; all is both", () => {
    expect(filterTasks(tasks, { range: "thisWeek", lists: [], status: "uncompleted", priorities: [] }, week).map((t) => t.id)).toEqual(["d"]);
    expect(filterTasks(tasks, { range: "thisWeek", lists: [], status: "all", priorities: [] }, week).length).toBe(4);
  });
  it("lists and priority narrow further", () => {
    const f = { range: "thisWeek" as const, lists: ["p1"], status: "all" as const, priorities: [] };
    expect(filterTasks(tasks, f, week).map((t) => t.id).sort()).toEqual(["a", "e"]);
    expect(filterTasks(tasks, { ...f, priorities: [5] }, week).map((t) => t.id)).toEqual(["a"]);
  });
  it("groups by status and by list", () => {
    const pick = filterTasks(tasks, { range: "thisWeek", lists: [], status: "all", priorities: [] }, week);
    expect(groupTasks(pick, "status", () => "").map((g) => [g.label, g.tasks.length])).toEqual([["Completed", 3], ["Uncompleted", 1]]);
    expect(groupTasks(pick, "list", (id) => (id === "p1" ? "Work" : "Home")).map((g) => g.label)).toEqual(["Home", "Work"]);
    expect(groupTasks(pick, "none", () => "")).toHaveLength(1);
  });
  it("sorts by completion date, task date and status", () => {
    const pick = filterTasks(tasks, { range: "thisWeek", lists: [], status: "all", priorities: [] }, week);
    expect(sortTasks(pick, "completedTime").map((t) => t.id)).toEqual(["b", "e", "a", "d"]);
    expect(sortTasks(pick, "taskDate").map((t) => t.id)[0]).toBe("d");
    expect(sortTasks(pick, "status").map((t) => t.id)).toEqual(["b", "e", "a", "d"]);
  });
  it("hierarchy puts a subtask under its parent", () => {
    const rows = withDepth(sortTasks([tasks[4]!, tasks[0]!], "completedTime"), true);
    expect(rows.map((r) => [r.task.id, r.depth])).toEqual([["a", 0], ["e", 1]]);
    expect(withDepth([tasks[4]!, tasks[0]!], false).every((r) => r.depth === 0)).toBe(true);
  });
  it("progress and focus fields", () => {
    expect(progressOf(tasks[3]!)).toEqual({ done: 1, total: 2 });
    expect(progressOf(tasks[0]!)).toBeNull();
    expect(focusOf(T({ id: "z", title: "z", focusSummaries: [{ pomoCount: 2, pomoDuration: 50, stopwatchDuration: 12 }] }))).toEqual({ minutes: 62, pomos: 2 });
  });
});

describe("summary text renderings (NOTE-801)", () => {
  const groups = groupTasks([tasks[0]!, tasks[4]!, tasks[3]!], "status", () => "");
  it("markdown is the plain list with checkboxes and no detail fields", () => {
    expect(toMarkdown("Week 47", groups, DEFAULT_DISPLAY)).toBe("# Week 47\n\n## Completed\n\n- [x] Ship report\n  - [x] Sub of a\n\n## Uncompleted\n\n- [ ] Plan trip\n");
  });
  it("plain text carries the chosen fields", () => {
    const txt = toPlainText("Week 47", groups, { ...DEFAULT_DISPLAY, fields: { ...DEFAULT_DISPLAY.fields, date: false } }, { listName: (id) => (id === "p1" ? "Work" : "Home") });
    expect(txt.split("\n")).toEqual(["Week 47", "=======", "", "Completed", "---------", "- [done] Ship report (Work, #work)", "  - [done] Sub of a (Work)", "", "Uncompleted", "-----------", "- [open] Plan trip (Home, 1/2)", ""]);
  });
});
