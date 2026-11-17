import { describe, expect, test } from "vitest";
import {
  QUADRANT_IDS, complexMatrixRules, defaultMatrixPrefs, evaluateRule, matchDateToken, parseRule, patchForRule, quadrantIndexOf, ruleFromConditions,
  simpleMatrixRules, type RuleTask,
} from "../src/index.js";

process.env.TZ = "Europe/Amsterdam";

const NOW = new Date(2026, 10, 18, 10, 0, 0).getTime(); // Wed 18 Nov 2026, 10:00 local
const day = (offset: number): string => {
  const d = new Date(NOW);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.toISOString().replace("Z", "+0000");
};
const task = (p: Partial<RuleTask>): RuleTask => ({ projectId: "p1", title: "t", status: 0, priority: 0, tags: [], ...p });
const dated = (offset: number, priority: number): RuleTask => task({ startDate: day(offset), dueDate: day(offset), isAllDay: true, priority });
const ctx = { now: NOW, weekStart: 1 };

describe("filter rule parsing", () => {
  test("JSON and legacy text forms", () => {
    expect(parseRule('{"and":[{"or":[5],"conditionName":"priority","conditionType":1}],"type":0,"version":1}')?.and?.length).toBe(1);
    const legacy = parseRule("list:p1,p2 AND tag:home");
    expect(legacy?.and).toEqual([
      { conditionName: "list", conditionType: 1, or: ["p1", "p2"] },
      { conditionName: "tag", conditionType: 1, or: ["home"] },
    ]);
    expect(evaluateRule("list:p1,p2 AND tag:home", task({ tags: ["Home"] }), ctx)).toBe(true);
    expect(evaluateRule("list:p3", task({}), ctx)).toBe(false);
    expect(evaluateRule("", task({}), ctx)).toBe(true);
  });
  test("nested and / or / not", () => {
    const rule = { and: [{ or: [{ conditionName: "priority", conditionType: 1 as const, or: [5] }, { conditionName: "tag", conditionType: 1 as const, or: ["x"] }] }, { not: [{ conditionName: "list", conditionType: 1 as const, or: ["p2"] }] }] };
    expect(evaluateRule(rule, task({ priority: 5 }), ctx)).toBe(true);
    expect(evaluateRule(rule, task({ tags: ["x"] }), ctx)).toBe(true);
    expect(evaluateRule(rule, task({ tags: ["x"], projectId: "p2" }), ctx)).toBe(false);
    expect(evaluateRule(rule, task({}), ctx)).toBe(false);
  });
  test("group, keywords, taskType, assignee, no-tag", () => {
    const c = { ...ctx, projectGroup: { p1: "g1" }, userId: 7 };
    expect(evaluateRule(ruleFromConditions([{ conditionName: "group", conditionType: 1, or: ["g1"] }]), task({}), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "keywords", conditionType: 1, or: ["milk"] }]), task({ content: "buy MILK" }), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "taskType", conditionType: 1, or: ["note"] }]), task({ kind: "TEXT" }), c)).toBe(false);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "assignee", conditionType: 1, or: ["me"] }]), task({ assignee: 7 }), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "tag", conditionType: 1, or: ["!tag"] }]), task({ tags: [] }), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "team", conditionType: 1, or: ["personal"] }]), task({}), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "team", conditionType: 1, or: ["team1"] }]), task({ teamId: "team1" }), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "calendar", conditionType: 1, or: ["cal1"] }]), task({ calendarId: "cal1" }), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "account", conditionType: 1, or: ["acc1"] }]), task({ accountId: "acc1" }), c)).toBe(true);
    expect(evaluateRule(ruleFromConditions([{ conditionName: "unknownField", conditionType: 1, or: ["x"] }]), task({}), c)).toBe(false);
  });
});

describe("date tokens", () => {
  test("overdue, today, tomorrow, nodue, 2dayslater", () => {
    expect(matchDateToken("overdue", dated(-1, 0), ctx)).toBe(true);
    expect(matchDateToken("overdue", dated(0, 0), ctx)).toBe(false);
    expect(matchDateToken("today", dated(0, 0), ctx)).toBe(true);
    expect(matchDateToken("tomorrow", dated(1, 0), ctx)).toBe(true);
    expect(matchDateToken("2dayslater", dated(1, 0), ctx)).toBe(false);
    expect(matchDateToken("2dayslater", dated(2, 0), ctx)).toBe(true);
    expect(matchDateToken("nodue", task({}), ctx)).toBe(true);
    expect(matchDateToken("nodue", dated(0, 0), ctx)).toBe(false);
  });
  test("a timed task earlier today is overdue, later today is not", () => {
    const at = (h: number): RuleTask => {
      const d = new Date(NOW);
      d.setHours(h, 0, 0, 0);
      const s = d.toISOString().replace("Z", "+0000");
      return task({ startDate: s, dueDate: s, isAllDay: false });
    };
    expect(matchDateToken("overdue", at(8), ctx)).toBe(true);
    expect(matchDateToken("overdue", at(15), ctx)).toBe(false);
    expect(matchDateToken("today", at(8), ctx)).toBe(true);
  });
  test("weeks, months, N days, offsets and spans", () => {
    // week starts Monday 16 Nov
    expect(matchDateToken("thisweek", dated(-2, 0), ctx)).toBe(true);
    expect(matchDateToken("thisweek", dated(5, 0), ctx)).toBe(false);
    expect(matchDateToken("nextweek", dated(5, 0), ctx)).toBe(true);
    expect(matchDateToken("thismonth", dated(12, 0), ctx)).toBe(true);
    expect(matchDateToken("thismonth", dated(13, 0), ctx)).toBe(false);
    expect(matchDateToken("7days", dated(6, 0), ctx)).toBe(true);
    expect(matchDateToken("7days", dated(7, 0), ctx)).toBe(false);
    expect(matchDateToken("offset(-1d)", dated(-1, 0), ctx)).toBe(true);
    expect(matchDateToken("span(2~7)", dated(3, 0), ctx)).toBe(true);
    expect(matchDateToken("span(2~7)", dated(8, 0), ctx)).toBe(false);
  });
  test("a multi-day all-day span covers each day but not its exclusive end", () => {
    const t = task({ startDate: day(-1), dueDate: day(2), isAllDay: true }); // yesterday..tomorrow
    expect(matchDateToken("today", t, ctx)).toBe(true);
    expect(matchDateToken("tomorrow", t, ctx)).toBe(true);
    expect(matchDateToken("2dayslater", t, ctx)).toBe(false);
    expect(matchDateToken("overdue", t, ctx)).toBe(false);
  });
});

describe("Eisenhower matrix rules (MTRX-003..006)", () => {
  test("quadrant ids and default prefs", () => {
    expect([...QUADRANT_IDS]).toEqual(["quadrant1", "quadrant2", "quadrant3", "quadrant4"]);
    const d = defaultMatrixPrefs();
    expect(d.quadrants.map((q) => q.sortType)).toEqual(["dueDate", "dueDate", "dueDate", "dueDate"]);
    expect(d).toMatchObject({ defaultViewId: "", version: 1, show_completed: true });
    for (const q of d.quadrants) expect(JSON.parse(q.rule)).toMatchObject({ type: 0, version: 1 });
  });
  test("simple preset: priorities 5,3,1,0 land in exactly one quadrant each", () => {
    const rules = simpleMatrixRules();
    [5, 3, 1, 0].forEach((p, i) => {
      const t = task({ priority: p });
      expect(rules.filter((r) => evaluateRule(r, t, ctx)).length).toBe(1);
      expect(quadrantIndexOf(t, rules, ctx)).toBe(i);
    });
  });
  test("complex preset: dates crossed with priority 5 and 0", () => {
    const rules = complexMatrixRules();
    const cases: Array<[number | null, number, number]> = [
      [-1, 5, 0], [0, 5, 0], [1, 5, 0], [3, 5, 1], [null, 5, 1],
      [-1, 0, 2], [0, 0, 2], [1, 0, 2], [3, 0, 3], [null, 0, 3],
    ];
    for (const [off, p, q] of cases) {
      const t = off === null ? task({ priority: p }) : dated(off, p);
      expect(rules.filter((r) => evaluateRule(r, t, ctx)).length).toBe(1);
      expect(quadrantIndexOf(t, rules, ctx)).toBe(q);
    }
  });
  test("variant without overdue leaves overdue tasks out of Q1 and Q3", () => {
    const rules = complexMatrixRules(false);
    expect(quadrantIndexOf(dated(-1, 5), rules, ctx)).toBe(-1);
    expect(quadrantIndexOf(dated(0, 5), rules, ctx)).toBe(0);
  });
  test("patchForRule: drag between quadrants changes the smallest set of fields", () => {
    const rules = complexMatrixRules();
    // today-high to Q4 (later, low/none): priority 5 -> 1 (closest allowed), date moves to two days out
    expect(patchForRule(rules[3]!, dated(0, 5), ctx)).toEqual({ priority: 1, dayOffset: 2 });
    // undated-none to Q1: priority -> 3 (closest of 5,3), date -> today
    expect(patchForRule(rules[0]!, task({ priority: 0 }), ctx)).toEqual({ priority: 3, dayOffset: 0 });
    // undated-high to Q2: already satisfies (nodue allowed, priority 5)
    expect(patchForRule(rules[1]!, task({ priority: 5 }), ctx)).toEqual({});
    // simple rules: only priority changes
    expect(patchForRule(simpleMatrixRules()[0]!, dated(4, 1), ctx)).toEqual({ priority: 5 });
    // list and tag conditions
    const r = ruleFromConditions([{ conditionName: "list", conditionType: 1, or: ["p9"] }, { conditionName: "tag", conditionType: 1, or: ["work"] }]);
    expect(patchForRule(r, task({}), ctx)).toEqual({ projectId: "p9", addTag: "work" });
  });
});
