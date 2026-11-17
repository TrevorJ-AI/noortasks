import { describe, expect, test } from "vitest";
import { hex, mk, seedProject, task } from "./helpers.js";

const tag = (name: string, extra = {}) => ({ name, rawName: name, label: name, color: "#fff", sortOrder: 0, type: 1, ...extra });

describe("batch/project", () => {
  test("add, EXISTED, update, NOT_EXISTED", async () => {
    const { call } = mk();
    const id = hex();
    const a = await call("POST", "/api/v2/batch/project", { add: [{ id, name: "p", sortOrder: 1, brandNew: 1 }] });
    expect(a.json.id2etag[id]).toBeTruthy();
    expect((await call("POST", "/api/v2/batch/project", { add: [{ id, name: "p" }] })).json.id2error[id]).toBe("EXISTED");
    const u = await call("POST", "/api/v2/batch/project", { update: [{ id, name: "renamed", brandNew: 2 }] });
    expect(u.json.id2etag[id]).not.toBe(a.json.id2etag[id]);
    const ghost = hex();
    expect((await call("POST", "/api/v2/batch/project", { update: [{ id: ghost, name: "x" }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
    const sync = (await call("GET", "/api/v3/batch/check/0")).json;
    expect(sync.projectProfiles[0]).toMatchObject({ name: "renamed", brandNew: 2 });
    expect(sync.projectProfiles[0].modifiedTime).toBeTruthy();
  });
  test("delete trashes the tasks and removes the list; the inbox cannot be deleted", async () => {
    const { call, svc } = mk();
    const p = await seedProject(call);
    const t = task({ projectId: p });
    await call("POST", "/api/v2/batch/task", { add: [t] });
    expect((await call("POST", "/api/v2/batch/project", { delete: [p] })).json.id2error).toEqual({});
    expect((await call("GET", "/api/v3/batch/check/0")).json.projectProfiles).toEqual([]);
    expect((await call("GET", `/api/v2/task/${t.id}`)).json.deleted).toBe(1);
    expect((await call("POST", "/api/v2/batch/project", { delete: [svc.inboxId] })).json.id2error[svc.inboxId]).toBe("NOT_EXISTED");
    const ghost = hex();
    expect((await call("POST", "/api/v2/batch/project", { delete: [ghost] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
});

describe("batch/projectGroup", () => {
  test("add, update, delete unsets groupId on lists", async () => {
    const { call } = mk();
    const g = hex();
    expect((await call("POST", "/api/v2/batch/projectGroup", { add: [{ id: g, name: "f", sortOrder: 0 }] })).json.id2etag[g]).toBeTruthy();
    const p = await seedProject(call, { groupId: g });
    expect((await call("POST", "/api/v2/batch/projectGroup", { update: [{ id: g, name: "f2" }] })).json.id2error).toEqual({});
    expect((await call("POST", "/api/v2/batch/projectGroup", { add: [{ id: g, name: "f" }] })).json.id2error[g]).toBe("EXISTED");
    await call("POST", "/api/v2/batch/projectGroup", { delete: [g] });
    const s = (await call("GET", "/api/v3/batch/check/0")).json;
    expect(s.projectGroups).toEqual([]);
    expect(s.projectProfiles.find((x: any) => x.id === p).groupId).toBeNull();
  });
});

describe("batch/filter", () => {
  test("filters round trip and null when none", async () => {
    const { call } = mk();
    expect((await call("GET", "/api/v3/batch/check/0")).json.filters).toBeNull();
    const id = hex();
    await call("POST", "/api/v2/batch/filter", { add: [{ id, name: "f", rule: "{\"and\":[]}", sortOrder: 0 }] });
    expect((await call("GET", "/api/v3/batch/check/0")).json.filters[0]).toMatchObject({ id, rule: "{\"and\":[]}" });
    await call("POST", "/api/v2/batch/filter", { delete: [id] });
    expect((await call("GET", "/api/v3/batch/check/0")).json.filters).toBeNull();
  });
});

describe("batch/columnProject", () => {
  test("add, update, delete with projectId", async () => {
    const { call } = mk();
    const p = await seedProject(call);
    const c = hex();
    const a = await call("POST", "/api/v2/batch/columnProject", { add: [{ id: c, projectId: p, name: "todo", sortOrder: 0 }] });
    expect(a.json.id2etag[c]).toBeTruthy();
    expect((await call("GET", `/api/v2/column/project/${p}`)).json).toHaveLength(1);
    expect(Object.keys((await call("GET", "/api/v2/column?from=0")).json)).toEqual([p]);
    await call("POST", "/api/v2/batch/columnProject", { update: [{ id: c, projectId: p, name: "done" }] });
    expect((await call("GET", `/api/v2/column/project/${p}`)).json[0].name).toBe("done");
    expect((await call("POST", "/api/v2/batch/columnProject", { delete: [{ columnId: c, projectId: p }] })).json.id2error).toEqual({});
    expect((await call("GET", `/api/v2/column/project/${p}`)).json).toEqual([]);
  });
  test("column in a missing list gives NOT_EXISTED; duplicate gives EXISTED", async () => {
    const { call } = mk();
    const p = await seedProject(call);
    const c = hex();
    expect((await call("POST", "/api/v2/batch/columnProject", { add: [{ id: c, projectId: hex(), name: "x" }] })).json.id2error[c]).toBe("NOT_EXISTED");
    await call("POST", "/api/v2/batch/columnProject", { add: [{ id: c, projectId: p, name: "x" }] });
    expect((await call("POST", "/api/v2/batch/columnProject", { add: [{ id: c, projectId: p, name: "x" }] })).json.id2error[c]).toBe("EXISTED");
  });
});

describe("tags", () => {
  const withTasks = async () => {
    const m = mk();
    await m.call("POST", "/api/v2/batch/tag", { add: [tag("work"), tag("home")] });
    const a = task({ projectId: m.svc.inboxId, tags: ["work", "home"] });
    const b = task({ projectId: m.svc.inboxId, tags: ["work"] });
    const c = task({ projectId: m.svc.inboxId, tags: ["home"], status: 2, completedTime: "2026-01-01T00:00:00.000+0000" });
    await m.call("POST", "/api/v2/batch/task", { add: [a, b, c] });
    return { ...m, a, b, c };
  };
  test("batch/tag add and update return id2etag keyed by name", async () => {
    const { call } = mk();
    const r = await call("POST", "/api/v2/batch/tag", { add: [tag("x", { surprise: 1 })] });
    expect(r.json.id2etag.x).toBeTruthy();
    await call("POST", "/api/v2/batch/tag", { update: [tag("x", { color: "#000", surprise: 2 })] });
    expect((await call("GET", "/api/v3/batch/check/0")).json.tags[0]).toMatchObject({ color: "#000", surprise: 2 });
  });
  test("rename propagates to every task", async () => {
    const { call, a, b, c } = await withTasks();
    const r = await call("PUT", "/api/v2/tag/rename", { name: "work", newName: "Job" });
    expect(r.json.tasksChanged).toBe(2);
    expect((await call("GET", `/api/v2/task/${a.id}`)).json.tags).toEqual(["job", "home"]);
    expect((await call("GET", `/api/v2/task/${b.id}`)).json.tags).toEqual(["job"]);
    expect((await call("GET", `/api/v2/task/${c.id}`)).json.tags).toEqual(["home"]);
    const tags = (await call("GET", "/api/v3/batch/check/0")).json.tags;
    expect(tags.map((t: any) => t.name).sort()).toEqual(["home", "job"]);
    expect(tags.find((t: any) => t.name === "job")).toMatchObject({ rawName: "Job", label: "Job" });
  });
  test("rename to an existing tag is refused, unknown tag is 404", async () => {
    const { call } = await withTasks();
    expect((await call("PUT", "/api/v2/tag/rename", { name: "work", newName: "home" })).status).toBe(400);
    expect((await call("PUT", "/api/v2/tag/rename", { name: "nope", newName: "z" })).status).toBe(404);
    expect((await call("PUT", "/api/v2/tag/rename", { name: "work" })).status).toBe(400);
  });
  test("merge dedupes on tasks that had both", async () => {
    const { call, a, b } = await withTasks();
    await call("PUT", "/api/v2/tag/merge", { name: "work", newName: "home" });
    expect((await call("GET", `/api/v2/task/${a.id}`)).json.tags).toEqual(["home"]);
    expect((await call("GET", `/api/v2/task/${b.id}`)).json.tags).toEqual(["home"]);
    expect((await call("GET", "/api/v3/batch/check/0")).json.tags.map((t: any) => t.name)).toEqual(["home"]);
  });
  test("delete strips the tag from tasks (body or query)", async () => {
    const { call, a, b } = await withTasks();
    await call("DELETE", "/api/v2/tag/delete", { name: "work" });
    expect((await call("GET", `/api/v2/task/${a.id}`)).json.tags).toEqual(["home"]);
    expect((await call("GET", `/api/v2/task/${b.id}`)).json).not.toHaveProperty("tags");
    await call("DELETE", "/api/v2/tag/delete?name=home");
    expect((await call("GET", "/api/v3/batch/check/0")).json.tags).toEqual([]);
    expect((await call("DELETE", "/api/v2/tag/delete", { name: "home" })).status).toBe(404);
  });
  test("child tags follow a rename of their parent", async () => {
    const { call } = mk();
    await call("POST", "/api/v2/batch/tag", { add: [tag("p"), tag("c", { parent: "p" })] });
    await call("PUT", "/api/v2/tag/rename", { name: "p", newName: "q" });
    const tags = (await call("GET", "/api/v3/batch/check/0")).json.tags;
    expect(tags.find((t: any) => t.name === "c").parent).toBe("q");
  });
});

describe("batch/order", () => {
  const key = "taskBy#sortOrder|none_dueDate";
  test("v3 changed records upsert and show up in a full sync", async () => {
    const { call } = mk();
    const body = (order: number) => ({ orderByType: { [key]: { L1: { changed: [{ id: "a", order, type: 1 }], deleted: [] } } } });
    await call("POST", "/api/v3/batch/order", body(5));
    await call("POST", "/api/v3/batch/order", body(7));
    const bean = (await call("GET", "/api/v3/batch/check/0")).json.syncOrderBeanV3;
    expect(bean.orderByType[key].L1.changed).toEqual([{ id: "a", order: 7, type: 1 }]);
  });
  test("moving a record to deleted removes it from changed", async () => {
    const { call } = mk();
    await call("POST", "/api/v3/batch/order", { orderByType: { [key]: { L1: { changed: [{ id: "a", order: 1, type: 1 }], deleted: [] } } } });
    await call("POST", "/api/v3/batch/order", { orderByType: { [key]: { L1: { changed: [], deleted: [{ id: "a" }] } } } });
    const leaf = (await call("GET", "/api/v3/batch/check/0")).json.syncOrderBeanV3.orderByType[key].L1;
    expect(leaf.changed).toEqual([]);
    expect(leaf.deleted).toEqual([{ id: "a" }]);
  });
  test("v2 writes go to the legacy bean; orders are clamped", async () => {
    const { call } = mk();
    await call("POST", "/api/v2/batch/order", { orderByType: { projectPinned: { all: { changed: [{ id: "p", order: 1e30, type: 1 }], deleted: [] } } } });
    const s = (await call("GET", "/api/v3/batch/check/0")).json;
    expect(s.syncOrderBean.orderByType.projectPinned.all.changed[0].order).toBe(0x7ffffffffffffc00);
    expect(s.syncOrderBeanV3.orderByType).toEqual({});
  });
  test("garbage bodies are ignored", async () => {
    const { call } = mk();
    expect((await call("POST", "/api/v3/batch/order", { orderByType: { k: "x", j: { s: 5 } } })).status).toBe(200);
    expect((await call("POST", "/api/v3/batch/order", [1, 2])).status).toBe(200);
  });
});
