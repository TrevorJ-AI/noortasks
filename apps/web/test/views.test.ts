import { describe, expect, it } from "vitest";
import type { Project, Tag, Task } from "../src/lib/core";
import { toServer } from "../src/lib/dates";
import { completedRange, compareTasks, groupByCompletionDay, groupTasks, nest, searchTasks, tasksInView, type ViewCtx } from "../src/model/views";

const NOW = new Date(2026, 10, 15, 10, 0, 0).getTime(); // Sunday 15 Nov 2026 10:00 local
const day = (offset: number, h?: number): string => {
  const d = new Date(2026, 10, 15 + offset, h ?? 0, 0, 0);
  return toServer(d.getTime());
};
let seq = 0;
const T = (p: Partial<Task>): Task => ({ id: `t${++seq}`.padEnd(24, "0"), projectId: "inbox1", title: `task ${seq}`, status: 0, sortOrder: seq * 1000, priority: 0, ...p }) as Task;

const projects: Project[] = [
  { id: "p1", name: "Work", sortOrder: 10, inAll: true } as Project,
  { id: "p2", name: "Hidden", sortOrder: 20, inAll: false } as Project,
  { id: "p3", name: "Home", sortOrder: 5, inAll: true, groupId: "g1" } as Project,
];
const tags: Tag[] = [{ name: "a", label: "A", sortOrder: 2 }, { name: "b", label: "B", sortOrder: 1 }, { name: "b-child", label: "kid", parent: "b", sortOrder: 3 }];
const ctx: ViewCtx = { now: NOW, inboxId: "inbox1", projects, tags };

describe("smart list membership", () => {
  const overdue = T({ title: "overdue", startDate: day(-2), isAllDay: true });
  const today = T({ title: "today", startDate: day(0), isAllDay: true });
  const todayTimedPast = T({ title: "today 08:00", startDate: day(0, 8), isAllDay: false });
  const tomorrow = T({ title: "tomorrow", startDate: day(1), isAllDay: true, projectId: "p1" });
  const in6 = T({ title: "in 6 days", startDate: day(6), isAllDay: true });
  const in7 = T({ title: "in 7 days", startDate: day(7), isAllDay: true });
  const undated = T({ title: "undated" });
  const hidden = T({ title: "hidden list", startDate: day(0), isAllDay: true, projectId: "p2" });
  const done = T({ title: "done", startDate: day(0), isAllDay: true, status: 2 });
  const trashed = T({ title: "trashed", startDate: day(0), isAllDay: true, deleted: 1 });
  const span = T({ title: "3-day span", startDate: day(-1), dueDate: day(2), isAllDay: true });
  const all = [overdue, today, todayTimedPast, tomorrow, in6, in7, undated, hidden, done, trashed, span];
  const titles = (name: "today" | "tomorrow" | "week" | "all") => tasksInView({ type: "smart", name }, all, ctx).map((t) => t.title).sort();

  it("Today holds today's tasks, overdue ones and spans covering today; not hidden lists, closed or trashed", () => {
    expect(titles("today")).toEqual(["3-day span", "overdue", "today", "today 08:00"].sort());
  });
  it("Tomorrow holds only tasks on tomorrow (an exclusive all-day end does not leak)", () => {
    expect(titles("tomorrow")).toEqual(["3-day span", "tomorrow"].sort());
  });
  it("Next 7 Days covers today .. today+6 plus overdue", () => {
    expect(titles("week")).toEqual(["3-day span", "in 6 days", "overdue", "today", "today 08:00", "tomorrow"].sort());
  });
  it("All has every open task of lists shown in All", () => {
    expect(titles("all")).toEqual(["3-day span", "in 6 days", "in 7 days", "overdue", "today", "today 08:00", "tomorrow", "undated"].sort());
  });
  it("project, folder and tag views (a parent tag includes its children)", () => {
    expect(tasksInView({ type: "project", id: "p2" }, all, ctx).map((t) => t.title)).toEqual(["hidden list"]);
    const f = T({ title: "in folder", projectId: "p3" });
    expect(tasksInView({ type: "group", id: "g1" }, [...all, f], ctx).map((t) => t.title)).toEqual(["in folder"]);
    const tb = T({ title: "kid tagged", tags: ["b-child"] });
    const ta = T({ title: "a tagged", tags: ["A"] });
    expect(tasksInView({ type: "tag", name: "b" }, [tb, ta], ctx).map((t) => t.title)).toEqual(["kid tagged"]);
    expect(tasksInView({ type: "tag", name: "a" }, [tb, ta], ctx).map((t) => t.title)).toEqual(["a tagged"]);
  });
});

describe("grouping", () => {
  it("date grouping: Overdue, Today, Tomorrow, Next 7 Days, Later, No Date; Overdue at the bottom when set", () => {
    const list = [T({ startDate: day(-1), isAllDay: true }), T({ startDate: day(0), isAllDay: true }), T({ startDate: day(1), isAllDay: true }), T({ startDate: day(3), isAllDay: true }), T({ startDate: day(30), isAllDay: true }), T({})];
    const g = groupTasks(list, { groupBy: "dueDate", orderBy: "dueDate" }, ctx);
    expect(g.map((x) => x.label)).toEqual(["Overdue", "Today", "Tomorrow", "Next 7 Days", "Later", "No Date"]);
    expect(g[0]!.action).toBe("postpone");
    const g2 = groupTasks(list, { groupBy: "dueDate", orderBy: "dueDate" }, { ...ctx, posOfOverdue: 1 });
    expect(g2.map((x) => x.label)).toEqual(["Today", "Tomorrow", "Next 7 Days", "Later", "Overdue", "No Date"]);
  });
  it("priority grouping High, Medium, Low, None and pinned tasks lead", () => {
    const list = [T({ priority: 0 }), T({ priority: 5 }), T({ priority: 1 }), T({ priority: 3 }), T({ priority: 1, pinnedTime: day(0) })];
    const g = groupTasks(list, { groupBy: "priority", orderBy: "sortOrder" }, ctx);
    expect(g.map((x) => x.label)).toEqual(["Pinned", "High", "Medium", "Low", "None"]);
  });
  it("tag grouping uses the first tag in tag order, untagged last", () => {
    const list = [T({ tags: ["a", "b"] }), T({ tags: ["a"] }), T({})];
    const g = groupTasks(list, { groupBy: "tag", orderBy: "sortOrder" }, ctx);
    expect(g.map((x) => [x.label, x.tasks.length])).toEqual([["B", 1], ["A", 1], ["No Tags", 1]]);
  });
  it("created-time grouping and list grouping (Inbox first, then list order)", () => {
    const list = [T({ createdTime: day(0, 9) }), T({ createdTime: day(-1, 9) }), T({ createdTime: day(-5) }), T({ createdTime: day(-20) }), T({ createdTime: day(-90) })];
    expect(groupTasks(list, { groupBy: "createdTime", orderBy: "createdTime" }, ctx).map((x) => x.label)).toEqual(["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Earlier"]);
    const l2 = [T({ projectId: "p1" }), T({ projectId: "p3" }), T({ projectId: "inbox1" })];
    expect(groupTasks(l2, { groupBy: "project", orderBy: "sortOrder" }, ctx).map((x) => x.label)).toEqual(["Inbox", "Home", "Work"]);
  });
});

describe("sorting", () => {
  const cmp = (orderBy: string, order: "asc" | "desc") => compareTasks(orderBy, order, ctx);
  it("custom order is sortOrder ascending", () => {
    const a = T({ sortOrder: 5 }), b = T({ sortOrder: -3 }), c = T({ sortOrder: 0 });
    expect([a, b, c].sort(cmp("sortOrder", "asc")).map((t) => t.sortOrder)).toEqual([-3, 0, 5]);
  });
  it("date sort puts undated last in both directions and all-day before timed on the same day", () => {
    const u = T({ title: "u" }), t1 = T({ title: "t1", startDate: day(0, 9), isAllDay: false }), ad = T({ title: "ad", startDate: day(0), isAllDay: true }), t2 = T({ title: "t2", startDate: day(2), isAllDay: true });
    expect([u, t2, t1, ad].sort(cmp("dueDate", "asc")).map((t) => t.title)).toEqual(["ad", "t1", "t2", "u"]);
    expect([u, t2, t1, ad].sort(cmp("dueDate", "desc")).map((t) => t.title)[3]).toBe("u");
  });
  it("title sort is natural and case-insensitive; priority sort defaults high first", () => {
    const x = [T({ title: "item 10" }), T({ title: "Item 2" }), T({ title: "apple" })];
    expect(x.sort(cmp("title", "asc")).map((t) => t.title)).toEqual(["apple", "Item 2", "item 10"]);
    const p = [T({ priority: 1 }), T({ priority: 5 }), T({ priority: 0 })];
    expect(p.sort(cmp("priority", "desc")).map((t) => t.priority)).toEqual([5, 1, 0]);
  });
  it("created and modified time", () => {
    const a = T({ createdTime: day(-3), modifiedTime: day(0, 9) }), b = T({ createdTime: day(-1), modifiedTime: day(-2) });
    expect([a, b].sort(cmp("createdTime", "desc"))[0]).toBe(b);
    expect([a, b].sort(cmp("modifiedTime", "desc"))[0]).toBe(a);
  });
});

describe("nesting, completed grouping, ranges, search", () => {
  it("nests children under present parents only", () => {
    const p = T({ title: "p" }), c = T({ title: "c", parentId: p.id }), orphan = T({ title: "o", parentId: "zzz" });
    const tree = nest([c, p, orphan]);
    expect(tree.map((n) => n.task.title)).toEqual(["c", "p", "o"].filter((x) => x !== "c"));
    expect(tree[0]!.children[0]!.task.title).toBe("c");
    expect(tree[0]!.children[0]!.depth).toBe(1);
  });
  it("completed tasks group by completion day newest first with weekday headings", () => {
    const g = groupByCompletionDay([T({ completedTime: day(-1, 12) }), T({ completedTime: day(0, 8) })], NOW);
    expect(g.map((x) => x.label)).toEqual(["Sunday, Today", "Saturday, Yesterday"]);
  });
  it("This Week / Last Week follow the week start", () => {
    const sun = completedRange("thisWeek", NOW, 0)!;
    expect(new Date(sun.from).getDate()).toBe(15);
    const mon = completedRange("thisWeek", NOW, 1)!;
    expect(new Date(mon.from).getDate()).toBe(9);
    const last = completedRange("lastWeek", NOW, 0)!;
    expect(new Date(last.from).getDate()).toBe(8);
  });
  it("search is local over title, notes, checklist items and tags", () => {
    const list = [T({ title: "Call bank" }), T({ title: "x", content: "the BANK form" }), T({ title: "y", items: [{ id: "i", title: "bank pin", status: 0, sortOrder: 0 }] }), T({ title: "z", tags: ["banking"] }), T({ title: "bank", deleted: 1 })];
    expect(searchTasks(list, "bank")).toHaveLength(4);
  });
});
