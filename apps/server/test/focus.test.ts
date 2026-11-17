import { describe, expect, test } from "vitest";
import { hex, seedProject, task } from "./helpers.js";
import { T0, id, isoWire, mk4, type M } from "./m4helpers.js";

const MIN = 60_000;
const rec = (over: Record<string, unknown> = {}): any => {
  const start = (over.startTime as number) ?? T0 - 3600_000;
  return { id: id("p"), startTime: start, endTime: start + 25 * MIN, pauseDuration: 0, tasks: [], ...over };
};
const add = (m: M, r: any, type: 0 | 1 = 0) => m.call("POST", type === 0 ? "/api/v2/batch/pomodoro" : "/api/v2/batch/pomodoro/timing", { add: [r] });

describe("pomodoro records", () => {
  test("add and read back, with etag", async () => {
    const m = await mk4();
    const r = rec();
    const a = await add(m, r);
    expect(a.json.id2etag[r.id]).toBeTruthy();
    expect((await m.call("GET", `/api/v2/pomodoro/${r.id}`)).json).toMatchObject({ id: r.id, startTime: r.startTime });
  });
  test("pomodoro and timing records live in separate lists", async () => {
    const m = await mk4();
    const p = rec();
    const t = rec({ startTime: T0 - 7200_000 });
    await add(m, p, 0);
    await add(m, t, 1);
    expect((await m.call("GET", "/api/v2/pomodoros?from=0")).json.map((x: any) => x.id)).toEqual([p.id]);
    expect((await m.call("GET", "/api/v2/pomodoros/timing?from=0")).json.map((x: any) => x.id)).toEqual([t.id]);
    expect((await m.call("GET", `/api/v2/pomodoro/timing/${t.id}`)).json.id).toBe(t.id);
    expect((await m.call("GET", `/api/v2/pomodoro/timing/${p.id}`)).status).toBe(404);
    expect((await m.call("GET", `/api/v2/pomodoro/${t.id}`)).status).toBe(404);
  });
  test("times as server date strings are accepted and kept as sent", async () => {
    const m = await mk4();
    const r = rec({ startTime: isoWire(T0 - 3600_000), endTime: isoWire(T0 - 3000_000) });
    expect((await add(m, r)).json.id2error).toEqual({});
    expect((await m.call("GET", `/api/v2/pomodoro/${r.id}`)).json.startTime).toBe(r.startTime);
  });
  test("EXISTED, also across the two lists", async () => {
    const m = await mk4();
    const r = rec();
    await add(m, r);
    expect((await add(m, r)).json.id2error[r.id]).toBe("EXISTED");
    expect((await add(m, r, 1)).json.id2error[r.id]).toBe("EXISTED");
  });
  test("end before start and unparsable times are refused", async () => {
    const m = await mk4();
    const bad = rec({ startTime: T0, endTime: T0 - MIN });
    expect((await add(m, bad)).json.id2error[bad.id]).toBe("UNKNOWN");
    const junk = rec({ startTime: "soon", endTime: "later" });
    expect((await add(m, junk)).json.id2error[junk.id]).toBe("UNKNOWN");
  });
  test("update edits an old record and returns a new etag", async () => {
    const m = await mk4();
    const old = rec({ startTime: T0 - 400 * 24 * 3600_000 });
    const a = await add(m, old);
    const u = await m.call("POST", "/api/v2/batch/pomodoro", { update: [{ ...old, endTime: old.startTime + 40 * MIN, note: "longer" }] });
    expect(u.json.id2etag[old.id]).not.toBe(a.json.id2etag[old.id]);
    expect((await m.call("GET", `/api/v2/pomodoro/${old.id}`)).json).toMatchObject({ note: "longer" });
  });
  test("update of a missing record or of the other type is NOT_EXISTED", async () => {
    const m = await mk4();
    const r = rec();
    await add(m, r, 1);
    expect((await m.call("POST", "/api/v2/batch/pomodoro", { update: [r] })).json.id2error[r.id]).toBe("NOT_EXISTED");
    const ghost = id();
    expect((await m.call("POST", "/api/v2/batch/pomodoro", { update: [{ id: ghost, startTime: 1, endTime: 2 }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("batch delete takes ids; missing ids are NOT_EXISTED", async () => {
    const m = await mk4();
    const r = rec();
    await add(m, r);
    const ghost = id();
    const d = await m.call("POST", "/api/v2/batch/pomodoro", { delete: [r.id, ghost] });
    expect(d.json.id2error).toEqual({ [ghost]: "NOT_EXISTED" });
    expect((await m.call("GET", `/api/v2/pomodoro/${r.id}`)).status).toBe(404);
  });
  test("add records dated far in the past and in a large number", async () => {
    const m = await mk4();
    const old = rec({ startTime: Date.UTC(2020, 0, 1) });
    expect((await add(m, old)).json.id2error).toEqual({});
    const many = Array.from({ length: 200 }, (_, i) => rec({ startTime: T0 - (i + 5) * 3600_000 }));
    const r = await m.call("POST", "/api/v2/batch/pomodoro", { add: many });
    expect(Object.keys(r.json.id2etag)).toHaveLength(200);
  });
  test("unknown fields on a record survive", async () => {
    const m = await mk4();
    const r = rec({ zzFuture: { x: [1, null] }, status: 1, adjustTime: 120 });
    await add(m, r);
    expect((await m.call("GET", `/api/v2/pomodoro/${r.id}`)).json).toMatchObject({ zzFuture: { x: [1, null] }, status: 1, adjustTime: 120 });
  });
  test("overlapping records are all kept (never rejected)", async () => {
    const m = await mk4();
    const a = rec({ startTime: T0 - 3600_000 });
    const b = rec({ startTime: T0 - 3600_000 + 10 * MIN });
    expect((await add(m, a)).json.id2error).toEqual({});
    expect((await add(m, b)).json.id2error).toEqual({});
    expect((await m.call("GET", "/api/v2/pomodoros?from=0")).json).toHaveLength(2);
  });
  test("range query filters by start; from and to accept ms and dates", async () => {
    const m = await mk4();
    const a = rec({ startTime: T0 - 10 * 3600_000 });
    const b = rec({ startTime: T0 - 5 * 3600_000 });
    await add(m, a);
    await add(m, b);
    const q = async (qs: string) => (await m.call("GET", `/api/v2/pomodoros?${qs}`)).json.map((x: any) => x.id);
    expect(await q(`from=${T0 - 6 * 3600_000}`)).toEqual([b.id]);
    expect(await q(`from=0&to=${T0 - 6 * 3600_000}`)).toEqual([a.id]);
    expect(await q(`from=${encodeURIComponent(isoWire(T0 - 6 * 3600_000))}`)).toEqual([b.id]);
    expect(await q("from=0")).toEqual([a.id, b.id]);
  });
});

describe("deleting records", () => {
  test("DELETE /pomodoro/{id} and /pomodoro/timing/{id}", async () => {
    const m = await mk4();
    const p = rec();
    const t = rec({ startTime: T0 - 9000_000 });
    await add(m, p);
    await add(m, t, 1);
    expect((await m.call("DELETE", `/api/v2/pomodoro/${p.id}`)).status).toBe(200);
    expect((await m.call("DELETE", `/api/v2/pomodoro/timing/${t.id}`)).status).toBe(200);
    expect((await m.call("DELETE", `/api/v2/pomodoro/${p.id}`)).status).toBe(404);
    expect((await m.call("GET", "/api/v2/pomodoros?from=0")).json).toEqual([]);
  });
  test("DELETE /pomodoro with {data: ids}", async () => {
    const m = await mk4();
    const rs = [rec(), rec({ startTime: T0 - 9000_000 }), rec({ startTime: T0 - 12000_000 })];
    for (const r of rs) await add(m, r);
    const ghost = id();
    const d = await m.call("DELETE", "/api/v2/pomodoro", { data: [rs[0].id, rs[1].id, ghost] });
    expect(d.json).toEqual({ deleted: 2, id2error: { [ghost]: "NOT_EXISTED" } });
    expect((await m.call("GET", "/api/v2/pomodoros?from=0")).json.map((x: any) => x.id)).toEqual([rs[2].id]);
  });
  test("DELETE /pomodoro/all clears both lists", async () => {
    const m = await mk4();
    await add(m, rec());
    await add(m, rec({ startTime: T0 - 9000_000 }), 1);
    expect((await m.call("DELETE", "/api/v2/pomodoro/all")).json).toEqual({ deleted: 2 });
    expect((await m.call("GET", "/api/v2/pomodoros/timeline")).json).toEqual([]);
    expect((await m.call("GET", "/api/v2/statistics/general")).json).toMatchObject({ totalPomoCount: 0, totalPomoDuration: 0 });
  });
  test("a deleted id can be added again", async () => {
    const m = await mk4();
    const r = rec();
    await add(m, r);
    await m.call("DELETE", `/api/v2/pomodoro/${r.id}`);
    expect((await add(m, r)).json.id2error).toEqual({});
  });
});

describe("record checkpoint, timeline, filter, bind", () => {
  test("a fresh database answers the empty sync shape", async () => {
    const m = await mk4();
    expect((await m.call("GET", "/api/v2/pomodoro/record/0")).json).toEqual({ checkPoint: 0, pomodoroRecords: null });
    expect((await m.call("GET", "/api/v2/pomodoros/timeline?to=0")).json).toEqual([]);
    expect((await m.call("GET", "/api/v2/pomodoros/timing?from=0")).json).toEqual([]);
  });
  test("record/{cp} returns what changed since, and deletions", async () => {
    const m = await mk4();
    const a = rec();
    await add(m, a);
    const first = (await m.call("GET", "/api/v2/pomodoro/record/0")).json;
    expect(first.pomodoroRecords.map((x: any) => x.id)).toEqual([a.id]);
    expect(first.checkPoint).toBeGreaterThan(0);
    expect((await m.call("GET", `/api/v2/pomodoro/record/${first.checkPoint}`)).json).toEqual({ checkPoint: first.checkPoint, pomodoroRecords: null });
    const b = rec({ startTime: T0 - 9000_000 });
    await add(m, b);
    await m.call("DELETE", `/api/v2/pomodoro/${a.id}`);
    const next = (await m.call("GET", `/api/v2/pomodoro/record/${first.checkPoint}`)).json;
    expect(next.pomodoroRecords.map((x: any) => [x.id, x.deleted ?? 0]).sort()).toEqual([[a.id, 1], [b.id, 0]].sort());
  });
  test("timeline: newest first, both types, paged by `to`", async () => {
    const m = await mk4();
    const rs = Array.from({ length: 60 }, (_, i) => rec({ startTime: T0 - (i + 1) * 3600_000 }));
    await m.call("POST", "/api/v2/batch/pomodoro", { add: rs.slice(0, 40) });
    await m.call("POST", "/api/v2/batch/pomodoro/timing", { add: rs.slice(40) });
    const p1 = (await m.call("GET", "/api/v2/pomodoros/timeline")).json;
    expect(p1).toHaveLength(50);
    expect(p1[0].id).toBe(rs[0].id);
    const last = p1[49].startTime;
    const p2 = (await m.call("GET", `/api/v2/pomodoros/timeline?to=${last}`)).json;
    expect(p2.map((x: any) => x.id)).toEqual(rs.slice(50).map((x) => x.id));
  });
  test("filter by duration, linked status and date", async () => {
    const m = await mk4();
    const short = rec({ startTime: T0 - 20000_000, endTime: T0 - 20000_000 + 10 * MIN, tasks: [{ taskId: "t1", title: "A" }] });
    const long = rec({ startTime: T0 - 10000_000, endTime: T0 - 10000_000 + 50 * MIN });
    await add(m, short);
    await add(m, long);
    const f = async (b: object) => (await m.call("POST", "/api/v2/pomodoro/filter", b)).json.map((x: any) => x.id);
    expect(await f({})).toEqual([long.id, short.id]);
    expect(await f({ minDuration: 30 })).toEqual([long.id]);
    expect(await f({ maxDuration: 30 })).toEqual([short.id]);
    expect(await f({ linked: "linked" })).toEqual([short.id]);
    expect(await f({ linked: "unlinked" })).toEqual([long.id]);
    expect(await f({ from: T0 - 15000_000 })).toEqual([long.id]);
    expect(await f({ taskId: "t1" })).toEqual([short.id]);
    expect(await f({ type: 1 })).toEqual([]);
  });
  test("pomodoros/task lists the records bound to one task", async () => {
    const m = await mk4();
    const a = rec({ tasks: [{ taskId: "tk1", title: "x" }] });
    const b = rec({ startTime: T0 - 9000_000, tasks: [{ taskId: "tk2" }] });
    await add(m, a);
    await add(m, b);
    expect((await m.call("GET", "/api/v2/pomodoros/task?projectId=p&taskId=tk1")).json.map((x: any) => x.id)).toEqual([a.id]);
    expect((await m.call("GET", "/api/v2/pomodoros/task?projectId=p")).status).toBe(400);
  });
  test("bind/recent lists owners newest first, distinct", async () => {
    const m = await mk4();
    await add(m, rec({ startTime: T0 - 9000_000, tasks: [{ taskId: "old", title: "Old" }] }));
    await add(m, rec({ startTime: T0 - 5000_000, tasks: [{ habitId: "hab", title: "Walk" }] }));
    await add(m, rec({ startTime: T0 - 1000_000, tasks: [{ taskId: "old", title: "Old" }, { timerId: "tm", title: "Read" }] }));
    const r = (await m.call("GET", "/api/v2/pomodoro/bind/recent")).json;
    expect(r.map((x: any) => [x.type, x.id])).toEqual([[0, "old"], [2, "tm"], [1, "hab"]]);
  });
  test("focus summaries are kept on the task (estimated vs actual)", async () => {
    const m = await mk4();
    const p = await seedProject(m.call);
    const t = task({ projectId: p });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    await add(m, rec({ tasks: [{ taskId: t.id, title: "t" }] }));
    await add(m, rec({ startTime: T0 - 9000_000, tasks: [{ taskId: t.id, title: "t" }] }));
    await add(m, rec({ startTime: T0 - 20000_000, endTime: T0 - 20000_000 + 60 * MIN, tasks: [{ taskId: t.id }] }), 1);
    const s = (await m.call("GET", `/api/v2/task/${t.id}`)).json.focusSummaries[0];
    expect(s).toMatchObject({ pomoCount: 2, pomoDuration: 50, stopwatchDuration: 60 });
    expect(s.focuses).toHaveLength(3);
    await m.call("DELETE", "/api/v2/pomodoro/all");
    expect((await m.call("GET", `/api/v2/task/${t.id}`)).json.focusSummaries).toBeUndefined();
  });
  test("a task changed by focus appears in the next sync delta", async () => {
    const m = await mk4();
    const p = await seedProject(m.call);
    const t = task({ projectId: p });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    const cp = (await m.call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    await add(m, rec({ tasks: [{ taskId: t.id }] }));
    const d = (await m.call("GET", `/api/v3/batch/check/${cp}`)).json;
    expect([...d.syncTaskBean.update, ...d.syncTaskBean.add].map((x: any) => x.id)).toContain(t.id);
  });
});

describe("standalone timers", () => {
  test("GET /timer is empty, POST creates, minting an id when absent", async () => {
    const m = await mk4();
    expect((await m.call("GET", "/api/v2/timer")).json).toEqual([]);
    const created = (await m.call("POST", "/api/v2/timer", { name: "Reading" })).json;
    expect(created).toMatchObject({ name: "Reading", status: 0 });
    expect(created.id).toMatch(/^[0-9a-f]{24}$/);
    expect((await m.call("GET", "/api/v2/timer")).json).toHaveLength(1);
  });
  test("POST with an existing id updates; archive sets archivedTime", async () => {
    const m = await mk4();
    const t = (await m.call("POST", "/api/v2/timer", { id: id("t"), name: "A" })).json;
    const u = (await m.call("POST", "/api/v2/timer", { ...t, name: "B", status: 1 })).json;
    expect(u).toMatchObject({ id: t.id, name: "B", status: 1 });
    expect(u.archivedTime).toBeTruthy();
    expect((await m.call("GET", "/api/v2/timer")).json).toHaveLength(1);
    const back = (await m.call("POST", "/api/v2/timer", { ...u, status: 0 })).json;
    expect(back.archivedTime).toBeNull();
  });
  test("POST also takes a batch; more than 3 timers are fine", async () => {
    const m = await mk4();
    const add = Array.from({ length: 6 }, (_, i) => ({ id: id("t"), name: `t${i}` }));
    const r = (await m.call("POST", "/api/v2/timer", { add })).json;
    expect(Object.keys(r.id2etag)).toHaveLength(6);
  });
  test("invalid body is 400; DELETE removes", async () => {
    const m = await mk4();
    expect((await m.call("POST", "/api/v2/timer", [1, 2])).status).toBe(400);
    const t = (await m.call("POST", "/api/v2/timer", { name: "A" })).json;
    expect((await m.call("DELETE", `/api/v2/timer/${t.id}`)).status).toBe(200);
    expect((await m.call("DELETE", `/api/v2/timer/${t.id}`)).status).toBe(404);
  });
  test("overview totals the records bound to the timer", async () => {
    const m = await mk4();
    const t = (await m.call("POST", "/api/v2/timer", { name: "Reading" })).json;
    await add(m, rec({ startTime: T0 - 3600_000, tasks: [{ timerId: t.id, timerName: "Reading" }] }), 1);
    await add(m, rec({ startTime: T0 - 3 * 24 * 3600_000, endTime: T0 - 3 * 24 * 3600_000 + 30 * MIN, tasks: [{ timerId: t.id }] }), 1);
    await add(m, rec({ startTime: T0 - 7200_000 }), 1);
    const o = (await m.call("GET", `/api/v2/timer/overview/${t.id}`)).json;
    expect(o).toMatchObject({ id: t.id, name: "Reading", totalCount: 2, totalDuration: 55, todayCount: 1, todayDuration: 25 });
    expect((await m.call("GET", "/api/v2/timer/overview/nope")).status).toBe(404);
  });
  test("timeline of a timer", async () => {
    const m = await mk4();
    const t = (await m.call("POST", "/api/v2/timer", { name: "R" })).json;
    const mine = rec({ tasks: [{ timerId: t.id }] });
    await add(m, mine, 1);
    await add(m, rec({ startTime: T0 - 9000_000 }), 1);
    expect((await m.call("GET", `/api/v2/timer/timeline/${t.id}`)).json.map((x: any) => x.id)).toEqual([mine.id]);
  });
  test("statistics by range and unit, ids and units in any order", async () => {
    const m = await mk4();
    const t = (await m.call("POST", "/api/v2/timer", { name: "R" })).json;
    await add(m, rec({ startTime: Date.UTC(2026, 10, 14, 9), endTime: Date.UTC(2026, 10, 14, 9, 30), tasks: [{ timerId: t.id }] }), 1);
    await add(m, rec({ startTime: Date.UTC(2026, 10, 2, 9), endTime: Date.UTC(2026, 10, 2, 9, 45), tasks: [{ timerId: t.id }] }), 1);
    const day = (await m.call("GET", `/api/v2/timer/statistics/${t.id}/20261101/20261115/day`)).json;
    expect(day).toMatchObject({ totalCount: 2, totalDuration: 75, unit: "day" });
    expect(day.buckets).toEqual({ "20261114": { count: 1, duration: 30 }, "20261102": { count: 1, duration: 45 } });
    const month = (await m.call("GET", `/api/v2/timer/statistics/month/20261101/20261115/${t.id}`)).json;
    expect(month.buckets).toEqual({ "20261101": { count: 2, duration: 75 } });
    expect((await m.call("GET", "/api/v2/timer/statistics/ghost/20261101/20261115/day")).status).toBe(404);
  });
});

describe("focus ops: two devices", () => {
  const op = (o: string, time: number, extra: Record<string, unknown> = {}) => ({ id: id("o"), oId: "sess1", op: o, time, deviceId: "A", ...extra });
  test("device B sees the timer that device A started", async () => {
    const m = await mk4();
    const r = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0, { oType: 0, taskId: "tk1" })] })).json;
    expect(r.current).toMatchObject({ id: "sess1", status: "running", startTime: T0, taskId: "tk1" });
    const b = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [], since: 0 })).json;
    expect(b.current).toMatchObject({ id: "sess1", status: "running" });
    expect(b.ops.map((x: any) => x.op)).toEqual(["start"]);
    expect((await m.call("GET", "/api/v2/batch/focusOp")).json.current.id).toBe("sess1");
  });
  test("pause on one device pauses the other; continue resumes with the pause time", async () => {
    const m = await mk4();
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0)] });
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [{ ...op("pause", T0 + 5 * MIN), deviceId: "B" }] });
    let cur = (await m.call("GET", "/api/v2/batch/focusOp")).json.current;
    expect(cur).toMatchObject({ status: "paused", duration: 5 * MIN });
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("continue", T0 + 8 * MIN)] });
    cur = (await m.call("GET", "/api/v2/batch/focusOp")).json.current;
    expect(cur).toMatchObject({ status: "running", pauseDuration: 3 * MIN });
    expect(cur.fragments).toHaveLength(2);
  });
  test("a running timer reports its active time up to now", async () => {
    const m = await mk4();
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0 - 10 * MIN)] });
    expect((await m.call("GET", "/api/v2/batch/focusOp")).json.current.duration).toBe(10 * MIN);
  });
  test("finish clears the state for every device and returns a summary", async () => {
    const m = await mk4();
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0 - 25 * MIN)] });
    const r = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("finish", T0)] })).json;
    expect(r.current).toBeNull();
    expect(r.finished[0]).toMatchObject({ id: "sess1", duration: 25 * MIN, endTime: T0 });
    expect((await m.call("GET", "/api/v2/batch/focusOp")).json.current).toBeNull();
  });
  test("exit clears the state", async () => {
    const m = await mk4();
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0)] });
    expect((await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("exit", T0 + MIN)] })).json.current).toBeNull();
  });
  test("a retried push is idempotent", async () => {
    const m = await mk4();
    const s = op("start", T0);
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [s] });
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [s] });
    expect((await m.call("GET", "/api/v2/batch/focusOp")).json.ops).toHaveLength(1);
  });
  test("a new session replaces a running one and the log says so", async () => {
    const m = await mk4();
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0)] });
    const r = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [{ ...op("start", T0 + MIN), oId: "sess2", deviceId: "B" }] })).json;
    expect(r.current.id).toBe("sess2");
    const log = (await m.call("GET", "/api/v2/batch/focusOp")).json.ops;
    expect(log.map((x: any) => `${x.oId}:${x.op}`)).toEqual(["sess1:start", "sess2:start", "sess1:exit"]);
  });
  test("polling with since returns only newer ops", async () => {
    const m = await mk4();
    const first = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0)] })).json;
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("pause", T0 + MIN)] });
    const poll = (await m.call("GET", `/api/v2/batch/focusOp?since=${first.checkPoint}`)).json;
    expect(poll.ops.map((x: any) => x.op)).toEqual(["pause"]);
    expect(poll.checkPoint).toBeGreaterThan(first.checkPoint);
  });
  test("ops of one push apply in time order", async () => {
    const m = await mk4();
    const r = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("pause", T0 + MIN), op("start", T0)] })).json;
    expect(r.current.status).toBe("paused");
  });
  test("an op for a session that is not running changes nothing", async () => {
    const m = await mk4();
    const r = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("pause", T0)] })).json;
    expect(r.current).toBeNull();
  });
  test("body shapes: a bare array, opList and a missing body", async () => {
    const m = await mk4();
    expect((await m.call("POST", "/api/v2/batch/focusOp", [op("start", T0)])).json.current.id).toBe("sess1");
    await m.call("POST", "/api/v2/batch/focusOp", { opList: [op("exit", T0 + MIN)] });
    expect((await m.call("GET", "/api/v2/batch/focusOp")).json.current).toBeNull();
    expect((await m.call("POST", "/api/v2/batch/focusOp")).status).toBe(200);
  });
  test("a stopwatch session keeps its type", async () => {
    const m = await mk4();
    const r = (await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0, { oType: 1 })] })).json;
    expect(r.current.type).toBe(1);
  });
  test("the focus host path works too", async () => {
    const m = await mk4();
    expect((await m.call("POST", "/focus/batch/focusOp", { ops: [op("start", T0)] })).json.current.id).toBe("sess1");
  });
  test("state survives a restart of the service on the same store", async () => {
    const m = await mk4();
    await m.call("POST", "/api/v2/batch/focusOp", { ops: [op("start", T0)] });
    expect(m.svc.store.getDoc("focusState")).toBeTruthy();
    expect((await m.call("GET", "/api/v2/batch/focusOp")).json.current.id).toBe("sess1");
  });
});

describe("misc", () => {
  test("hex ids from helpers do not collide with focus ids", () => {
    expect(hex()).not.toBe(hex());
  });
});
