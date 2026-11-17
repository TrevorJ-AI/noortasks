import { describe, expect, test } from "vitest";
import { hex, mk, seedProject, task } from "./helpers.js";

const B = "/api/v2/batch/task";

describe("batch/task", () => {
  test("add returns id2etag and stores the task", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    const r = await call("POST", B, { add: [t] });
    expect(r.status).toBe(200);
    expect(r.json.id2etag[t.id]).toMatch(/^[a-z0-9]{8}$/);
    expect(r.json.id2error).toEqual({});
    const g = await call("GET", `/api/v2/task/${t.id}?projectId=${svc.inboxId}`);
    expect(g.json.title).toBe("t");
    expect(g.json.etag).toBe(r.json.id2etag[t.id]);
    expect(g.json.modifiedTime).toMatch(/\+0000$/);
  });
  test("add twice gives EXISTED", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [t] });
    expect((await call("POST", B, { add: [t] })).json.id2error[t.id]).toBe("EXISTED");
  });
  test("add into a missing list gives NOT_EXISTED", async () => {
    const { call } = mk();
    const t = task({ projectId: hex() });
    expect((await call("POST", B, { add: [t] })).json.id2error[t.id]).toBe("NOT_EXISTED");
  });
  test("update changes fields and etag", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    const a = await call("POST", B, { add: [t] });
    const r = await call("POST", B, { update: [{ ...t, title: "new" }] });
    expect(r.json.id2etag[t.id]).not.toBe(a.json.id2etag[t.id]);
    expect((await call("GET", `/api/v2/task/${t.id}`)).json.title).toBe("new");
  });
  test("update of an unknown id gives NOT_EXISTED", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    expect((await call("POST", B, { update: [t] })).json.id2error[t.id]).toBe("NOT_EXISTED");
  });
  test("update of a trashed task gives DELETED", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [t] });
    await call("POST", B, { delete: [{ taskId: t.id, projectId: t.projectId }] });
    expect((await call("POST", B, { update: [t] })).json.id2error[t.id]).toBe("DELETED");
  });
  test("update that changes projectId gives PROJECT_MOVE_ERROR", async () => {
    const { call, svc } = mk();
    const p = await seedProject(call);
    const t = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [t] });
    expect((await call("POST", B, { update: [{ ...t, projectId: p }] })).json.id2error[t.id]).toBe("PROJECT_MOVE_ERROR");
  });
  test("delete trashes the task", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [t] });
    const r = await call("POST", B, { delete: [{ taskId: t.id, projectId: t.projectId }] });
    expect(r.json.id2error).toEqual({});
    const tr = await call("GET", "/api/v2/project/all/trash/page?limit=50&type=1");
    expect(tr.json.tasks.map((x: any) => x.id)).toEqual([t.id]);
    expect(tr.json.tasks[0].deleted).toBe(1);
    expect(tr.json.tasks[0].deletedTime).toBeTypeOf("number");
  });
  test("delete of unknown gives NOT_EXISTED, second delete gives DELETED", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    expect((await call("POST", B, { delete: [{ taskId: t.id, projectId: t.projectId }] })).json.id2error[t.id]).toBe("NOT_EXISTED");
    await call("POST", B, { add: [t] });
    await call("POST", B, { delete: [{ taskId: t.id, projectId: t.projectId }] });
    expect((await call("POST", B, { delete: [{ taskId: t.id, projectId: t.projectId }] })).json.id2error[t.id]).toBe("DELETED");
  });
  test("unknown fields survive add and update", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId, futureField: { a: [1, 2] }, other: null });
    await call("POST", B, { add: [t] });
    let g = (await call("GET", `/api/v2/task/${t.id}`)).json;
    expect(g.futureField).toEqual({ a: [1, 2] });
    expect(g.other).toBeNull();
    await call("POST", B, { update: [{ ...t, futureField: "x", another: 3 }] });
    g = (await call("GET", `/api/v2/task/${t.id}`)).json;
    expect(g.futureField).toBe("x");
    expect(g.another).toBe(3);
  });
  test("an update that omits a field clears it (the client sends whole objects)", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId, dueDate: "2026-01-01T00:00:00.000+0000" });
    await call("POST", B, { add: [t] });
    const { dueDate, ...rest } = t;
    void dueDate;
    await call("POST", B, { update: [rest] });
    expect((await call("GET", `/api/v2/task/${t.id}`)).json).not.toHaveProperty("dueDate");
  });
  test("server-managed fields survive an update", async () => {
    const { call, svc } = mk();
    const parent = task({ projectId: svc.inboxId });
    const child = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [parent, child] });
    await call("POST", "/api/v2/batch/taskParent", [{ taskId: child.id, projectId: child.projectId, parentId: parent.id }]);
    await call("POST", B, { update: [{ ...parent, title: "p2" }] });
    expect((await call("GET", `/api/v2/task/${parent.id}`)).json.childIds).toEqual([child.id]);
  });
  test("completing fills completedTime", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [t] });
    await call("POST", B, { update: [{ ...t, status: 2 }] });
    expect((await call("GET", `/api/v2/task/${t.id}`)).json.completedTime).toMatch(/\+0000$/);
  });
  test("sortOrder is clamped", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId, sortOrder: 1e30 });
    await call("POST", B, { add: [t] });
    expect((await call("GET", `/api/v2/task/${t.id}`)).json.sortOrder).toBe(0x7ffffffffffffc00);
  });
  test("single task: 404 for unknown id and for a wrong projectId", async () => {
    const { call, svc } = mk();
    const t = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [t] });
    expect((await call("GET", `/api/v2/task/${hex()}`)).status).toBe(404);
    expect((await call("GET", `/api/v2/task/${t.id}?projectId=${hex()}`)).status).toBe(404);
  });
  test("project tasks lists open tasks only", async () => {
    const { call } = mk();
    const p = await seedProject(call);
    const a = task({ projectId: p });
    const b = task({ projectId: p, status: 2 });
    await call("POST", B, { add: [a, b] });
    expect((await call("GET", `/api/v2/project/${p}/tasks`)).json.map((x: any) => x.id)).toEqual([a.id]);
  });
});

describe("taskParent", () => {
  const setup = async () => {
    const m = mk();
    const [a, b, c] = [0, 1, 2].map(() => task({ projectId: m.svc.inboxId }));
    await m.call("POST", B, { add: [a, b, c] });
    const par = (t: any, p?: string) => m.call("POST", "/api/v2/batch/taskParent", [{ taskId: t.id, projectId: t.projectId, ...(p ? { parentId: p } : {}) }]);
    return { ...m, a, b, c, par };
  };
  test("set parent updates both sides", async () => {
    const { a, b, par, call } = await setup();
    expect((await par(b, a.id)).json.id2error).toEqual({});
    expect((await call("GET", `/api/v2/task/${b.id}`)).json.parentId).toBe(a.id);
    expect((await call("GET", `/api/v2/task/${a.id}`)).json.childIds).toEqual([b.id]);
  });
  test("unset parent", async () => {
    const { a, b, par, call } = await setup();
    await par(b, a.id);
    await par(b);
    expect((await call("GET", `/api/v2/task/${b.id}`)).json).not.toHaveProperty("parentId");
    expect((await call("GET", `/api/v2/task/${a.id}`)).json).not.toHaveProperty("childIds");
  });
  test("reparent moves the child between parents", async () => {
    const { a, b, c, par, call } = await setup();
    await par(c, a.id);
    await par(c, b.id);
    expect((await call("GET", `/api/v2/task/${a.id}`)).json).not.toHaveProperty("childIds");
    expect((await call("GET", `/api/v2/task/${b.id}`)).json.childIds).toEqual([c.id]);
  });
  test("unknown task and unknown parent give NOT_EXISTED", async () => {
    const { a, par } = await setup();
    const ghost = task();
    expect((await par(ghost, a.id)).json.id2error[ghost.id]).toBe("NOT_EXISTED");
    const r = await par(a, hex());
    expect(r.json.id2error[a.id]).toBe("NOT_EXISTED");
  });
  test("parent in another list gives PROJECT_MOVE_ERROR", async () => {
    const { a, call, par } = await setup();
    const p = await seedProject(call);
    const x = task({ projectId: p });
    await call("POST", B, { add: [x] });
    expect((await par(x, a.id)).json.id2error[x.id]).toBe("PROJECT_MOVE_ERROR");
  });
  test("cycles give UNKNOWN", async () => {
    const { a, b, par } = await setup();
    await par(b, a.id);
    expect((await par(a, b.id)).json.id2error[a.id]).toBe("UNKNOWN");
    expect((await par(a, a.id)).json.id2error[a.id]).toBe("UNKNOWN");
  });
  test("depth beyond five levels gives UNKNOWN", async () => {
    const m = mk();
    const ts = Array.from({ length: 6 }, () => task({ projectId: m.svc.inboxId }));
    await m.call("POST", B, { add: ts });
    for (let i = 1; i < 5; i++) expect((await m.call("POST", "/api/v2/batch/taskParent", [{ taskId: ts[i]!.id, parentId: ts[i - 1]!.id }])).json.id2error).toEqual({});
    expect((await m.call("POST", "/api/v2/batch/taskParent", [{ taskId: ts[5]!.id, parentId: ts[4]!.id }])).json.id2error[ts[5]!.id]).toBe("UNKNOWN");
  });
  test("deleting a parent trashes its children", async () => {
    const { a, b, par, call } = await setup();
    await par(b, a.id);
    await call("POST", B, { delete: [{ taskId: a.id, projectId: a.projectId }] });
    const ids = (await call("GET", "/api/v2/project/all/trash/page?limit=50")).json.tasks.map((x: any) => x.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });
});

describe("taskProject", () => {
  test("moves a task and its children", async () => {
    const m = mk();
    const p = await seedProject(m.call);
    const a = task({ projectId: m.svc.inboxId });
    const b = task({ projectId: m.svc.inboxId });
    await m.call("POST", B, { add: [a, b] });
    await m.call("POST", "/api/v2/batch/taskParent", [{ taskId: b.id, parentId: a.id }]);
    const r = await m.call("POST", "/api/v2/batch/taskProject", [{ taskId: a.id, fromProjectId: a.projectId, toProjectId: p }]);
    expect(r.json.id2error).toEqual({});
    expect((await m.call("GET", `/api/v2/task/${b.id}`)).json.projectId).toBe(p);
  });
  test("errors: unknown task, wrong source, missing target", async () => {
    const m = mk();
    const p = await seedProject(m.call);
    const a = task({ projectId: m.svc.inboxId });
    await m.call("POST", B, { add: [a] });
    const run = async (it: object) => (await m.call("POST", "/api/v2/batch/taskProject", [it])).json.id2error;
    expect((await run({ taskId: hex(), fromProjectId: a.projectId, toProjectId: p }))).toMatchObject({});
    const unk = hex();
    expect((await run({ taskId: unk, fromProjectId: a.projectId, toProjectId: p }))[unk]).toBe("NOT_EXISTED");
    expect((await run({ taskId: a.id, fromProjectId: p, toProjectId: p }))[a.id]).toBe("PROJECT_MOVE_ERROR");
    expect((await run({ taskId: a.id, fromProjectId: a.projectId, toProjectId: hex() }))[a.id]).toBe("NOT_EXISTED");
  });
  test("a moved subtask leaves its parent", async () => {
    const m = mk();
    const p = await seedProject(m.call);
    const a = task({ projectId: m.svc.inboxId });
    const b = task({ projectId: m.svc.inboxId });
    await m.call("POST", B, { add: [a, b] });
    await m.call("POST", "/api/v2/batch/taskParent", [{ taskId: b.id, parentId: a.id }]);
    await m.call("POST", "/api/v2/batch/taskProject", [{ taskId: b.id, fromProjectId: b.projectId, toProjectId: p }]);
    expect((await m.call("GET", `/api/v2/task/${b.id}`)).json).not.toHaveProperty("parentId");
    expect((await m.call("GET", `/api/v2/task/${a.id}`)).json).not.toHaveProperty("childIds");
  });
});

describe("trash", () => {
  const trashed = async (n: number) => {
    const m = mk();
    const ts = Array.from({ length: n }, (_, i) => task({ projectId: m.svc.inboxId, sortOrder: i }));
    await m.call("POST", B, { add: ts });
    await m.call("POST", B, { delete: ts.map((t) => ({ taskId: t.id, projectId: t.projectId })) });
    return { ...m, ts };
  };
  test("paging: 50 per page, next is the running offset, last next is the total", async () => {
    const { call } = await trashed(120);
    const p1 = (await call("GET", "/api/v2/project/all/trash/page?limit=50&type=1")).json;
    const p2 = (await call("GET", "/api/v2/project/all/trash/page?limit=50&type=1&next=50")).json;
    const p3 = (await call("GET", "/api/v2/project/all/trash/page?limit=50&type=1&next=100")).json;
    expect([p1.tasks.length, p1.next, p2.tasks.length, p2.next, p3.tasks.length, p3.next]).toEqual([50, 50, 50, 100, 20, 120]);
    expect(new Set([...p1.tasks, ...p2.tasks, ...p3.tasks].map((t: any) => t.id)).size).toBe(120);
  });
  test("restore brings tasks back", async () => {
    const { call, ts } = await trashed(2);
    const r = await call("POST", "/api/v2/trash/restore", [{ taskId: ts[0]!.id, projectId: ts[0]!.projectId }]);
    expect(r.json.id2etag[ts[0]!.id]).toBeTruthy();
    const g = (await call("GET", `/api/v2/task/${ts[0]!.id}`)).json;
    expect(g.deleted).toBe(0);
    expect(g).not.toHaveProperty("deletedTime");
    expect((await call("GET", "/api/v2/project/all/trash/page?limit=50")).json.tasks).toHaveLength(1);
  });
  test("restore errors: unknown NOT_EXISTED, live EXISTED", async () => {
    const { call, ts, svc } = await trashed(1);
    const live = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [live] });
    const r = (await call("POST", "/api/v2/trash/restore", { tasks: [{ taskId: hex() }, { taskId: live.id }] })).json;
    expect(Object.values(r.id2error).sort()).toEqual(["EXISTED", "NOT_EXISTED"]);
    void ts;
  });
  test("restore into a deleted list lands in the inbox", async () => {
    const m = mk();
    const p = await seedProject(m.call);
    const t = task({ projectId: p });
    await m.call("POST", B, { add: [t] });
    await m.call("POST", "/api/v2/batch/project", { delete: [p] });
    await m.call("POST", "/api/v2/trash/restore", [{ taskId: t.id }]);
    expect((await m.call("GET", `/api/v2/task/${t.id}`)).json.projectId).toBe(m.svc.inboxId);
  });
  test("cleanUp deletes everything in the trash for good", async () => {
    const { call, ts } = await trashed(3);
    expect((await call("DELETE", "/api/v2/trash/cleanUp")).json.deleted).toBe(3);
    expect((await call("GET", `/api/v2/task/${ts[0]!.id}`)).status).toBe(404);
  });
  test("delete forever removes specific tasks", async () => {
    const { call, ts } = await trashed(2);
    const r = await call("DELETE", "/api/v2/task?deleteforever=true", [{ taskId: ts[0]!.id, projectId: ts[0]!.projectId }, { taskId: hex() }]);
    expect(Object.values(r.json.id2error)).toEqual(["NOT_EXISTED"]);
    expect((await call("GET", `/api/v2/task/${ts[0]!.id}`)).status).toBe(404);
    expect((await call("GET", `/api/v2/task/${ts[1]!.id}`)).status).toBe(200);
  });
});

describe("completed history", () => {
  const seed = async () => {
    const m = mk();
    const ts = Array.from({ length: 120 }, (_, i) => task({ projectId: m.svc.inboxId, status: 2, completedTime: new Date(Date.UTC(2026, 5, 1) - i * 60000).toISOString().replace("Z", "+0000") }));
    const wd = task({ projectId: m.svc.inboxId, status: -1, completedTime: "2026-05-01T00:00:00.000+0000" });
    await m.call("POST", B, { add: [...ts, wd] });
    return { ...m, ts, wd };
  };
  test("closed: newest first, 50 per page", async () => {
    const { call, ts } = await seed();
    const r = (await call("GET", "/api/v2/project/all/closed?from=&to=&status=Completed")).json;
    expect(r).toHaveLength(50);
    expect(r[0].id).toBe(ts[0]!.id);
  });
  test("closed: paging by the last completedTime repeats the boundary row", async () => {
    const { call, ts } = await seed();
    const p1 = (await call("GET", "/api/v2/project/all/closed?status=Completed")).json;
    const to = p1[49].completedTime.slice(0, 19).replace("T", " ");
    const p2 = (await call("GET", `/api/v2/project/all/closed?status=Completed&to=${encodeURIComponent(to)}`)).json;
    expect(p2[0].id).toBe(p1[49].id);
    expect(p2[1].id).toBe(ts[50]!.id);
  });
  test("closed: Abandoned returns won't-do tasks", async () => {
    const { call, wd } = await seed();
    expect((await call("GET", "/api/v2/project/all/closed?status=Abandoned")).json.map((t: any) => t.id)).toEqual([wd.id]);
  });
  test("closed: from filter and project filter", async () => {
    const { call, svc } = await seed();
    const r = (await call("GET", `/api/v2/project/${svc.inboxId}/closed?status=Completed&from=${encodeURIComponent("2026-05-31 23:00:00")}&limit=500`)).json;
    expect(r.length).toBe(61);
    expect((await call("GET", `/api/v2/project/${hex()}/closed?status=Completed`)).json).toEqual([]);
  });
  test("completedInAll and per-list completed honour limit", async () => {
    const { call, svc } = await seed();
    expect((await call("GET", "/api/v2/project/all/completedInAll/?limit=7")).json).toHaveLength(7);
    expect((await call("GET", `/api/v2/project/${svc.inboxId}/completed/?limit=3`)).json).toHaveLength(3);
  });
  test("completed by tag pages with a token", async () => {
    const m = mk();
    const ts = [1, 2, 3].map((i) => task({ projectId: m.svc.inboxId, status: 2, tags: ["x"], completedTime: `2026-01-0${i}T00:00:00.000+0000` }));
    await m.call("POST", B, { add: ts });
    const a = (await m.call("POST", "/api/v2/tag/completedTask", { tags: ["x"], token: "", limit: 2 })).json;
    expect(a.tasks).toHaveLength(2);
    const b = (await m.call("POST", "/api/v2/tag/completedTask", { tags: ["x"], token: a.nextToken, limit: 2 })).json;
    expect([b.tasks.length, b.nextToken]).toEqual([1, null]);
  });
});
