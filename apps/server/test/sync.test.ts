import { describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { hex, mk, seedProject, task, tmp } from "./helpers.js";

const B = "/api/v2/batch/task";

describe("batch/check", () => {
  test("full sync of an empty server has the expected envelope keys", async () => {
    const { call, svc } = mk();
    const r = (await call("GET", "/api/v3/batch/check/0")).json;
    expect(Object.keys(r).sort()).toEqual(["checkPoint", "checks", "filters", "inboxId", "projectGroups", "projectProfiles", "remindChanges", "syncOrderBean", "syncOrderBeanV3", "syncTaskBean", "syncTaskOrderBean", "tags"]);
    expect(r.inboxId).toBe(svc.inboxId);
    expect(r.filters).toBeNull();
    expect(r.projectGroups).toEqual([]);
    expect(r.syncTaskBean).toEqual({ update: [], tagUpdate: [], delete: [], add: [], empty: false });
    expect(r.syncTaskOrderBean).toEqual({ taskOrderByDate: {}, taskOrderByPriority: {}, taskOrderByProject: {} });
  });
  test("checkPoint looks like epoch ms and never goes backwards", async () => {
    const { call, svc } = mk();
    let last = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    expect(last).toBeGreaterThan(1.7e12);
    for (let i = 0; i < 20; i++) {
      await call("POST", B, { add: [task({ projectId: svc.inboxId })] });
      const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
      expect(cp).toBeGreaterThan(last);
      last = cp;
    }
  });
  test("full sync carries open tasks only", async () => {
    const { call, svc } = mk();
    const open = task({ projectId: svc.inboxId });
    const done = task({ projectId: svc.inboxId, status: 2 });
    const gone = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [open, done, gone] });
    await call("POST", B, { delete: [{ taskId: gone.id, projectId: gone.projectId }] });
    expect((await call("GET", "/api/v3/batch/check/0")).json.syncTaskBean.update.map((t: any) => t.id)).toEqual([open.id]);
  });
  test("an empty delta is mostly null", async () => {
    const { call } = mk();
    const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    const d = (await call("GET", `/api/v3/batch/check/${cp}`)).json;
    expect(d.projectProfiles).toBeNull();
    expect(d.projectGroups).toBeNull();
    expect(d.filters).toBeNull();
    expect(d.tags).toBeNull();
    expect(d.inboxId).toBeNull();
    expect(d.syncTaskBean.empty).toBe(true);
    expect(d.syncOrderBeanV3).toEqual({ orderByType: {} });
    expect(d.checkPoint).toBe(cp);
  });
  test("bad checkpoints are 400", async () => {
    const { call } = mk();
    expect((await call("GET", "/api/v3/batch/check/abc")).status).toBe(400);
    expect((await call("GET", "/api/v3/batch/check/-5")).status).toBe(400);
  });
  test("new tasks arrive in add, edits in update, trash and hard deletes in delete", async () => {
    const { call, svc } = mk();
    const a = task({ projectId: svc.inboxId });
    const b = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [a, b] });
    const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    const c = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [c] });
    await call("POST", B, { update: [{ ...a, title: "edited" }] });
    await call("POST", B, { delete: [{ taskId: b.id, projectId: b.projectId }] });
    const d = (await call("GET", `/api/v3/batch/check/${cp}`)).json.syncTaskBean;
    expect(d.add.map((t: any) => t.id)).toEqual([c.id]);
    expect(d.update.map((t: any) => t.id)).toEqual([a.id]);
    expect(d.delete).toEqual([{ taskId: b.id, projectId: b.projectId }]);
    expect(d.empty).toBe(false);
    await call("DELETE", "/api/v2/task?deleteforever=true", [{ taskId: b.id }]);
    expect((await call("GET", `/api/v3/batch/check/${cp}`)).json.syncTaskBean.delete.map((x: any) => x.taskId)).toEqual([b.id]);
  });
  test("a task that became completed reaches the other client through update", async () => {
    const { call, svc } = mk();
    const a = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [a] });
    const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    await call("POST", B, { update: [{ ...a, status: 2 }] });
    const d = (await call("GET", `/api/v3/batch/check/${cp}`)).json.syncTaskBean;
    expect(d.update[0]).toMatchObject({ id: a.id, status: 2 });
    expect((await call("GET", "/api/v3/batch/check/0")).json.syncTaskBean.update).toEqual([]);
  });
  test("a restored task comes back in a delta", async () => {
    const { call, svc } = mk();
    const a = task({ projectId: svc.inboxId });
    await call("POST", B, { add: [a] });
    await call("POST", B, { delete: [{ taskId: a.id }] });
    const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    await call("POST", "/api/v2/trash/restore", [{ taskId: a.id }]);
    const d = (await call("GET", `/api/v3/batch/check/${cp}`)).json.syncTaskBean;
    expect([...d.update, ...d.add].map((t: any) => t.id)).toEqual([a.id]);
    expect(d.delete).toEqual([]);
  });
  test("list, folder, filter and tag changes show in a delta; deletions in the extra keys", async () => {
    const { call } = mk();
    const p = await seedProject(call);
    const g = hex();
    const f = hex();
    await call("POST", "/api/v2/batch/projectGroup", { add: [{ id: g, name: "g" }] });
    await call("POST", "/api/v2/batch/filter", { add: [{ id: f, name: "f", rule: "{}" }] });
    await call("POST", "/api/v2/batch/tag", { add: [{ name: "t" }] });
    const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    await call("POST", "/api/v2/batch/project", { update: [{ id: p, name: "p2" }] });
    await call("POST", "/api/v2/batch/projectGroup", { delete: [g] });
    await call("POST", "/api/v2/batch/filter", { delete: [f] });
    await call("DELETE", "/api/v2/tag/delete", { name: "t" });
    const d = (await call("GET", `/api/v3/batch/check/${cp}`)).json;
    expect(d.projectProfiles.map((x: any) => x.id)).toEqual([p]);
    expect(d.deletedProjectGroups).toEqual([g]);
    expect(d.deletedFilters).toEqual([f]);
    expect(d.deletedTags).toEqual(["t"]);
    expect(d).not.toHaveProperty("deletedProjects");
    await call("POST", "/api/v2/batch/project", { delete: [p] });
    expect((await call("GET", `/api/v3/batch/check/${cp}`)).json.deletedProjects).toEqual([p]);
  });
  test("order changes appear in a delta, only those after the checkpoint", async () => {
    const { call } = mk();
    const key = "taskBy#sortOrder|none_dueDate";
    const send = (id: string) => call("POST", "/api/v3/batch/order", { orderByType: { [key]: { L: { changed: [{ id, order: 1, type: 1 }], deleted: [] } } } });
    await send("a");
    const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    await send("b");
    const d = (await call("GET", `/api/v3/batch/check/${cp}`)).json.syncOrderBeanV3.orderByType[key].L;
    expect(d.changed.map((r: any) => r.id)).toEqual(["b"]);
  });
  test("tag rename shows up as changed tasks and a tag tombstone", async () => {
    const { call, svc } = mk();
    await call("POST", "/api/v2/batch/tag", { add: [{ name: "old", rawName: "old", label: "old" }] });
    const t = task({ projectId: svc.inboxId, tags: ["old"] });
    await call("POST", B, { add: [t] });
    const cp = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;
    await call("PUT", "/api/v2/tag/rename", { name: "old", newName: "new" });
    const d = (await call("GET", `/api/v3/batch/check/${cp}`)).json;
    expect(d.syncTaskBean.update[0].tags).toEqual(["new"]);
    expect(d.tags.map((x: any) => x.name)).toEqual(["new"]);
    expect(d.deletedTags).toEqual(["old"]);
  });
});

/** A tiny client: keeps a local copy of open tasks and pulls deltas the way the web app does. */
class Client {
  tasks = new Map<string, any>();
  projects = new Map<string, any>();
  cp = 0;
  constructor(private call: ReturnType<typeof mk>["call"]) {}
  async pull() {
    const d = (await this.call("GET", `/api/v3/batch/check/${this.cp}`)).json;
    if (this.cp === 0) { this.tasks.clear(); this.projects.clear(); }
    for (const t of [...d.syncTaskBean.add, ...d.syncTaskBean.update]) {
      if (t.status === 0 && !t.deleted) this.tasks.set(t.id, t);
      else this.tasks.delete(t.id);
    }
    for (const x of d.syncTaskBean.delete) this.tasks.delete(x.taskId);
    for (const p of d.projectProfiles ?? []) this.projects.set(p.id, p);
    for (const id of d.deletedProjects ?? []) this.projects.delete(id);
    this.cp = d.checkPoint;
  }
}

describe("two clients converge", () => {
  test("A creates, edits, moves and deletes; B pulls deltas from its checkpoint", async () => {
    const m = mk();
    const A = new Client(m.call);
    const Bc = new Client(m.call);
    await A.pull();
    await Bc.pull();
    const p1 = await seedProject(m.call, { name: "one" });
    const p2 = await seedProject(m.call, { name: "two" });
    const ts = Array.from({ length: 5 }, (_, i) => task({ projectId: p1, title: `t${i}`, sortOrder: i }));
    await m.call("POST", B, { add: ts });
    await Bc.pull();
    expect(Bc.tasks.size).toBe(5);
    expect([...Bc.projects.keys()].sort()).toEqual([p1, p2].sort());

    await m.call("POST", B, { update: [{ ...ts[0], title: "edited" }] });
    await m.call("POST", "/api/v2/batch/taskProject", [{ taskId: ts[1]!.id, fromProjectId: p1, toProjectId: p2 }]);
    await m.call("POST", B, { update: [{ ...ts[2], status: 2 }] });
    await m.call("POST", B, { delete: [{ taskId: ts[3]!.id, projectId: p1 }] });
    await m.call("POST", "/api/v2/batch/project", { delete: [p2] });
    await Bc.pull();
    await A.pull();
    expect(Bc.tasks.get(ts[0]!.id).title).toBe("edited");
    expect([...Bc.tasks.keys()]).toEqual([ts[0]!.id, ts[4]!.id]);
    expect([...Bc.projects.keys()]).toEqual([p1]);

    // a fresh client doing a full sync sees the same world as the one that followed deltas
    const C = new Client(m.call);
    await C.pull();
    expect([...C.tasks.keys()].sort()).toEqual([...Bc.tasks.keys()].sort());
    expect(C.tasks.get(ts[0]!.id)).toEqual(Bc.tasks.get(ts[0]!.id));
    expect([...C.projects.keys()]).toEqual([...Bc.projects.keys()]);
  });
  test("B pushes while A is behind: A's next delta contains B's work", async () => {
    const m = mk();
    const A = new Client(m.call);
    await A.pull();
    const t = task({ projectId: m.svc.inboxId });
    await m.call("POST", B, { add: [t] });
    await A.pull();
    expect(A.tasks.has(t.id)).toBe(true);
    await m.call("POST", B, { update: [{ ...t, title: "from B" }] });
    await A.pull();
    expect(A.tasks.get(t.id).title).toBe("from B");
  });
});

describe("store", () => {
  test("seq is strictly increasing across transactions and survives reopen", () => {
    const dir = tmp();
    const path = `${dir}/s.sqlite`;
    const s = new Store(path);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) s.tx(() => seen.push(s.seq()));
    expect(seen.every((v, i) => i === 0 || v > seen[i - 1]!)).toBe(true);
    s.close();
    const s2 = new Store(path);
    expect(s2.lastSeq()).toBe(seen[4]);
    s2.close();
  });
  test("a throw rolls the whole transaction back", () => {
    const s = new Store(":memory:");
    expect(() => s.tx(() => { s.setMeta("x", "1"); throw new Error("boom"); })).toThrow("boom");
    expect(s.getMeta("x")).toBeUndefined();
  });
  test("one stamp per transaction", () => {
    const s = new Store(":memory:");
    s.tx(() => expect(s.seq()).toBe(s.seq()));
  });
  test("app survives a reopen of the same database", async () => {
    const dir = tmp();
    const a = buildApp({ dbPath: `${dir}/a.sqlite`, dataDir: dir, noAuth: true });
    const inbox = a.svc.inboxId;
    const t = task({ projectId: inbox });
    await a.app.inject({ method: "POST", url: B, payload: { add: [t] } });
    await a.app.close();
    a.store.close();
    const b = buildApp({ dbPath: `${dir}/a.sqlite`, dataDir: dir, noAuth: true });
    const r = await b.app.inject({ method: "GET", url: `/api/v2/task/${t.id}` });
    expect(r.statusCode).toBe(200);
    expect(b.svc.inboxId).toBe(inbox);
  });
});
