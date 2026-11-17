import { describe, expect, test } from "vitest";
import {
  COUNT_LIMIT_KEYS, LENGTH_LIMIT_KEYS, ORDER_MAX, ORDER_MIN, ORDER_STEP, PREFERENCE_KEYS, SIZE_LIMIT_KEYS, UNLIMITED_COUNT,
  checklistOrder, clampOrder, defaultPreferences, formatQueryDate, formatServerDate, idTimestamp, inboxIdFor, isInboxId,
  isObjectId, isPlainObject, looseEqual, mergeLoose, needsRebalance, newEtag, newId, orderBetween, orderForBottom,
  orderForTop, ordersForTopBatch, parseWireDate, rebalance, unknownFields, unlimitedLimits, TaskStatus, Priority,
  TaskKind, BatchError, Deleted,
} from "../src/index.js";

describe("ids", () => {
  test("24 lowercase hex characters", () => {
    for (let i = 0; i < 50; i++) expect(newId()).toMatch(/^[0-9a-f]{24}$/);
  });
  test("10000 ids are unique", () => {
    expect(new Set(Array.from({ length: 10000 }, () => newId())).size).toBe(10000);
  });
  test("timestamp is embedded in seconds", () => {
    const t = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(idTimestamp(newId(t))).toBe(t);
  });
  test("ids minted in one process share the machine bytes", () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_000);
    expect(a.slice(8, 18)).toBe(b.slice(8, 18));
    expect(a).not.toBe(b);
  });
  test("counter increases by one", () => {
    const a = parseInt(newId().slice(18), 16);
    const b = parseInt(newId().slice(18), 16);
    expect((b - a + 0x1000000) % 0x1000000).toBe(1);
  });
  test.each([["5f1d7f3b8e1b4c0012345678", true], ["5F1D7F3B8E1B4C0012345678", false], ["short", false], [12, false], [null, false]])(
    "isObjectId(%s)", (v, ok) => expect(isObjectId(v)).toBe(ok),
  );
  test("etag is 8 short chars and varies", () => {
    expect(newEtag()).toMatch(/^[a-z0-9]{8}$/);
    expect(new Set(Array.from({ length: 200 }, newEtag)).size).toBeGreaterThan(190);
  });
  test("inbox id", () => {
    expect(inboxIdFor(123)).toBe("inbox123");
    expect(isInboxId("inbox123")).toBe(true);
    expect(isInboxId("inbox")).toBe(false);
    expect(isInboxId("5f1d7f3b8e1b4c0012345678")).toBe(false);
  });
});

describe("sortOrder", () => {
  test("step is 2^40", () => expect(ORDER_STEP).toBe(1099511627776));
  test.each([[0, 0], [5, 5], [Number.NaN, 0], [Infinity, ORDER_MAX], [-Infinity, ORDER_MIN], [1e30, ORDER_MAX], [-1e30, ORDER_MIN]])(
    "clampOrder(%s) = %s", (v, out) => expect(clampOrder(v)).toBe(out),
  );
  test("top of empty list is 0, then min minus step", () => {
    expect(orderForTop([])).toBe(0);
    expect(orderForTop([0])).toBe(-ORDER_STEP);
    expect(orderForTop([-5 * ORDER_STEP, 7])).toBe(-6 * ORDER_STEP);
  });
  test("bottom of empty list is 0, then max plus step", () => {
    expect(orderForBottom([])).toBe(0);
    expect(orderForBottom([0])).toBe(ORDER_STEP);
    expect(orderForBottom([-ORDER_STEP])).toBe(ORDER_STEP);
  });
  test("NaN neighbours are ignored", () => {
    expect(orderForTop([Number.NaN, 10])).toBe(10 - ORDER_STEP);
  });
  test("batch at the top is topmost first and ends one step above the old top", () => {
    const r = ordersForTopBatch([0], 3);
    expect(r).toEqual([-3 * ORDER_STEP, -2 * ORDER_STEP, -ORDER_STEP]);
    expect(ordersForTopBatch([], 2)).toEqual([-ORDER_STEP, 0]);
  });
  test("between two neighbours is the floored midpoint", () => {
    expect(orderBetween(0, 10)).toEqual({ order: 5, needsRebalance: false });
    expect(orderBetween(-3, 0)).toEqual({ order: -2, needsRebalance: false });
  });
  test("between with a gap of 1 or 0 asks for a rebalance", () => {
    expect(orderBetween(4, 5).needsRebalance).toBe(true);
    expect(orderBetween(4, 4).needsRebalance).toBe(true);
    expect(orderBetween(4, 6).needsRebalance).toBe(false);
  });
  test("one open end uses a step", () => {
    expect(orderBetween(undefined, 100)).toEqual({ order: 100 - ORDER_STEP, needsRebalance: false });
    expect(orderBetween(100, undefined)).toEqual({ order: 100 + ORDER_STEP, needsRebalance: false });
    expect(orderBetween(undefined, undefined)).toEqual({ order: 0, needsRebalance: false });
  });
  test("repeated insertion at the same spot eventually needs a rebalance after about 40 halvings", () => {
    let hi = ORDER_STEP;
    let n = 0;
    for (;;) {
      const r = orderBetween(0, hi);
      if (r.needsRebalance) break;
      hi = r.order;
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(39);
    expect(n).toBeLessThanOrEqual(41);
  });
  test("needsRebalance on sorted lists", () => {
    expect(needsRebalance([0, 2, 4])).toBe(false);
    expect(needsRebalance([0, 1, 4])).toBe(true);
    expect(needsRebalance([])).toBe(false);
  });
  test("rebalance spaces items evenly in the given sequence", () => {
    const r = rebalance(["a", "b", "c"]);
    expect(r.map((x) => x.item)).toEqual(["a", "b", "c"]);
    expect(r.map((x) => x.order)).toEqual([0, ORDER_STEP, 2 * ORDER_STEP]);
  });
  test("checklist order is index times step", () => {
    expect(checklistOrder(0)).toBe(0);
    expect(checklistOrder(3)).toBe(3 * ORDER_STEP);
  });
});

describe("dates and enums", () => {
  test("server date format", () => {
    expect(formatServerDate(Date.UTC(2026, 10, 15, 8, 5, 3, 7))).toBe("2026-11-15T08:05:03.007+0000");
  });
  test("query date format", () => {
    expect(formatQueryDate(Date.UTC(2026, 10, 15, 8, 5, 3))).toBe("2026-11-15 08:05:03");
  });
  test.each([
    ["2026-11-15T08:05:03.007+0000", Date.UTC(2026, 10, 15, 8, 5, 3, 7)],
    ["2026-11-15 08:05:03", Date.UTC(2026, 10, 15, 8, 5, 3)],
    ["2026-11-15T10:05:03.000+0200", Date.UTC(2026, 10, 15, 8, 5, 3)],
    ["2026-11-15T08:05:03Z", Date.UTC(2026, 10, 15, 8, 5, 3)],
  ])("parseWireDate(%s)", (s, ms) => expect(parseWireDate(s)).toBe(ms));
  test.each(["", "nope", "2026-11-15"])("parseWireDate(%j) is NaN", (s) => expect(parseWireDate(s)).toBeNaN());
  test("wire enum values", () => {
    expect(TaskStatus).toEqual({ WontDo: -1, Open: 0, Completed: 2 });
    expect(Priority).toEqual({ None: 0, Low: 1, Medium: 3, High: 5 });
    expect(Object.values(TaskKind)).toEqual(["TEXT", "NOTE", "CHECKLIST"]);
    expect(Deleted).toEqual({ Live: 0, Trashed: 1 });
    expect(BatchError.Existed).toBe("EXISTED");
    expect(BatchError.NotExisted).toBe("NOT_EXISTED");
  });
});

describe("preferences and limits", () => {
  test("51 distinct settings keys", () => {
    expect(PREFERENCE_KEYS.length).toBe(51);
    expect(new Set(PREFERENCE_KEYS).size).toBe(51);
  });
  test("defaults carry exactly the known keys", () => {
    expect(Object.keys(defaultPreferences()).sort()).toEqual([...PREFERENCE_KEYS].sort());
  });
  test("defaults: tab bar order and 16 smart lists", () => {
    const p = defaultPreferences(7);
    expect(p.id).toBe(7);
    expect(p.tabBars.map((t) => t.name)).toEqual(["TASK", "CALENDAR", "POMO", "HABIT", "SEARCH", "SETTING"]);
    expect(p.smartProjects).toHaveLength(16);
    expect(p.nlpEnabled).toBe(p.nlpenabled);
  });
  test("every tier has the same keys and they are huge", () => {
    const l = unlimitedLimits();
    expect(Object.keys(l.free).sort()).toEqual(Object.keys(l.pro).sort());
    expect(Object.keys(l.pro).sort()).toEqual(Object.keys(l.team).sort());
    for (const k of COUNT_LIMIT_KEYS) expect(l.free[k]).toBe(UNLIMITED_COUNT);
    for (const k of LENGTH_LIMIT_KEYS) expect(l.pro[k]).toBeGreaterThan(1_000_000);
    for (const k of SIZE_LIMIT_KEYS) expect(l.team[k]).toBeGreaterThan(2 ** 40);
    expect(l.free.type).toBe("free");
  });
  test("limits include standard resource keys", () => {
    const l = unlimitedLimits().free;
    for (const k of ["projectNumber", "projectTaskNumber", "subtaskNumber", "taskAttachmentNumber", "reminderNumber", "attachmentSize", "kanbanNumber", "habitNumber"]) expect(l).toHaveProperty(k);
  });
});

describe("tolerant objects", () => {
  test("isPlainObject", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
  });
  test("looseEqual ignores key order only", () => {
    expect(looseEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    expect(looseEqual([1, 2], [2, 1])).toBe(false);
    expect(looseEqual({ a: null }, {})).toBe(false);
    expect(looseEqual({ a: undefined }, {})).toBe(false);
  });
  test("mergeLoose keeps unknown fields from both sides", () => {
    expect(mergeLoose({ a: 1, x: 9 }, { a: 2, y: 8 })).toEqual({ a: 2, x: 9, y: 8 });
  });
  test("unknownFields", () => {
    expect(unknownFields({ id: 1, zz: 2 }, ["id"])).toEqual(["zz"]);
    expect(unknownFields({ id: 1 }, new Set(["id"]))).toEqual([]);
  });
});
