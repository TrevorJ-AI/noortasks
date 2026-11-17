import { describe, expect, it } from "vitest";
import { evaluateRule, type Task } from "../src/lib/core";
import { builderToRule, cond, filterDefaults, filterMatches, isNormal, previewSort, ruleToBuilder, type BGroup } from "../src/model/filters";

/** Custom filter rule builder (FILT-003, FILT-006, FILT-011, FILT-012, FILT-015): wire round trip and evaluation. */

const P1 = "aaaaaaaaaaaaaaaaaaaaaaa1";
const P2 = "aaaaaaaaaaaaaaaaaaaaaaa2";
const day = (offset: number): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().replace("Z", "+0000");
};
let n = 0;
const T = (p: Partial<Task>): Task => ({ id: `t${++n}`, projectId: P1, title: "x", status: 0, priority: 0, sortOrder: n, kind: "TEXT", tags: [], ...p }) as Task;
const tasks: Task[] = [
  T({ title: "high today errand", priority: 5, tags: ["errands"], startDate: day(0), dueDate: day(0), isAllDay: true }),
  T({ title: "medium tomorrow", priority: 3, startDate: day(1), dueDate: day(1), isAllDay: true }),
  T({ title: "low no date in P2", priority: 1, projectId: P2 }),
  T({ title: "note in P2", kind: "NOTE", projectId: P2, tags: ["weekend"] }),
  T({ title: "high overdue", priority: 5, startDate: day(-3), dueDate: day(-3), isAllDay: true, tags: ["weekend"] }),
  T({ title: "done high", priority: 5, status: 2 }),
];
const ctx = { now: Date.now(), weekStart: 1 };

describe("rule builder serialisation", () => {
  it("normal mode: a flat AND of conditions round-trips exactly, type 0", () => {
    const g: BGroup = { kind: "group", op: "and", items: [cond("listOrGroup", [P1]), cond("priority", [5, 3])] };
    const rule = builderToRule(g);
    expect(JSON.parse(rule)).toEqual({ and: [{ conditionName: "listOrGroup", conditionType: 1, or: [P1] }, { conditionName: "priority", conditionType: 1, or: [5, 3] }], type: 0, version: 1 });
    expect(ruleToBuilder(rule)).toEqual(g);
    expect(isNormal(ruleToBuilder(rule))).toBe(true);
  });

  it("conditions without values are dropped on save", () => {
    const rule = builderToRule({ kind: "group", op: "and", items: [cond("tag"), cond("priority", [1])] });
    expect(JSON.parse(rule).and).toHaveLength(1);
  });

  const trees: BGroup[] = [
    { kind: "group", op: "or", items: [cond("priority", [5]), cond("tag", ["weekend"])] },
    { kind: "group", op: "and", items: [cond("priority", [5]), { kind: "group", op: "or", items: [cond("tag", ["errands"]), cond("dueDate", ["overdue"])] }] },
    { kind: "group", op: "and", items: [cond("listOrGroup", [P1]), { kind: "group", op: "and", not: true, items: [cond("priority", [5]), cond("tag", ["weekend"])] }] },
    { kind: "group", op: "and", items: [{ kind: "group", op: "or", not: true, items: [cond("taskType", ["note"]), cond("priority", [1])] }] },
    { kind: "group", op: "or", items: [{ kind: "group", op: "and", items: [cond("priority", [3]), cond("dueDate", ["tomorrow"])] }, { kind: "group", op: "and", items: [cond("listOrGroup", [P2]), cond("keywords", ["low"])] }] },
  ];

  it.each(trees.map((t, i) => [i, t] as const))("advanced tree %i: builder -> rule -> builder is identical and type 1", (_i, g) => {
    const rule = builderToRule(g);
    expect(JSON.parse(rule).type).toBe(1);
    expect(ruleToBuilder(rule)).toEqual(g);
    expect(builderToRule(ruleToBuilder(rule))).toBe(rule);
  });

  it("the built rule means the same as the tree (checked against the shared evaluator)", () => {
    const hits = (g: BGroup) => filterMatches(builderToRule(g), tasks, ctx).map((t) => t.title);
    expect(hits(trees[0]!)).toEqual(["high today errand", "note in P2", "high overdue"]);
    expect(hits(trees[1]!)).toEqual(["high today errand", "high overdue"]);
    expect(hits(trees[2]!)).toEqual(["high today errand", "medium tomorrow"]);
    expect(hits(trees[3]!)).toEqual(["high today errand", "medium tomorrow", "high overdue"]);
    expect(hits(trees[4]!)).toEqual(["medium tomorrow", "low no date in P2"]);
  });

  it("reads rules written elsewhere: legacy text and nested not", () => {
    expect(ruleToBuilder("list:a,b AND tag:x")).toEqual({ kind: "group", op: "and", items: [cond("list", ["a", "b"]), cond("tag", ["x"])] });
    const wire = JSON.stringify({ and: [{ conditionName: "priority", conditionType: 1, or: [5] }, { not: [{ conditionName: "tag", conditionType: 1, or: ["weekend"] }] }], type: 1, version: 1 });
    const g = ruleToBuilder(wire);
    expect(g.items[1]).toEqual({ kind: "group", op: "or", not: true, items: [cond("tag", ["weekend"])] });
    for (const t of tasks) expect(evaluateRule(builderToRule(g), t, ctx)).toBe(evaluateRule(wire, t, ctx));
  });

  it("a filter shows open tasks only; preview sorts by list, notes by created time", () => {
    expect(filterMatches(builderToRule({ kind: "group", op: "and", items: [cond("priority", [5])] }), tasks, ctx).map((t) => t.title)).toEqual(["high today errand", "high overdue"]);
    const order = new Map([[P2, 0], [P1, 1]]);
    expect(previewSort([tasks[0]!, tasks[2]!], (id) => order.get(id)!).map((t) => t.projectId)).toEqual([P2, P1]);
  });

  it("FILT-015: defaults for a new task come from single-valued conditions", () => {
    const rule = builderToRule({ kind: "group", op: "and", items: [cond("priority", [5]), cond("tag", ["errands", "!tag"]), cond("listOrGroup", [P2])] });
    expect(filterDefaults(rule, new Set([P1, P2]))).toEqual({ priority: 5, tags: ["errands"], projectId: P2 });
    expect(filterDefaults(builderToRule(trees[0]!), new Set([P1]))).toEqual({});
  });
});
