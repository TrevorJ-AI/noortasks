import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { Api } from "../src/data/api";
import { NoorDb } from "../src/data/db";
import { M4_ENTITIES, type M4Entity } from "../src/data/m4sync";
import { M4Repo, newHabit } from "../src/data/m4repo";
import { Repo } from "../src/data/repo";
import { SyncEngine } from "../src/data/sync";

let base = "";
let close: () => Promise<void>;
let dir = "";
let n = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nt-sync-"));
  const { app } = buildApp({ noAuth: true, dataDir: join(dir, "files"), dbPath: join(dir, "db.sqlite") });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  close = () => app.close();
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});

interface Client {
  db: NoorDb;
  engine: SyncEngine;
  repo: Repo;
  net: { offline: boolean };
  requests: string[];
}

async function client(): Promise<Client> {
  const db = new NoorDb(`test-${++n}-${Math.random()}`);
  const net = { offline: false };
  const requests: string[] = [];
  const api = new Api({
    base,
    isOffline: () => net.offline,
    fetch: (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input).replace(base, "")}`);
      return fetch(input, init);
    },
  });
  const engine = new SyncEngine(db, api);
  const repo = new Repo(db, engine);
  await engine.sync();
  return { db, engine, repo, net, requests };
}

const serverTask = async (id: string): Promise<Record<string, unknown> | null> => {
  const r = await fetch(`${base}/api/v2/task/${id}`);
  return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
};

describe("sync engine against the real server", () => {
  let A: Client;
  let B: Client;
  beforeEach(async () => {
    A = await client();
    B = await client();
  });

  it("full pull on a fresh client brings lists and tasks created elsewhere", async () => {
    const p = await A.repo.createProject({ name: "Errands" });
    const t = await A.repo.createTask({ title: "Buy stamps", projectId: p.id, tags: ["post"] });
    await A.engine.sync();
    expect(await A.db.outbox.count()).toBe(0);
    const C = await client();
    expect((await C.db.projects.get(p.id))?.name).toBe("Errands");
    expect((await C.db.tasks.get(t.id))?.title).toBe("Buy stamps");
    expect(await C.db.tags.get("post")).toBeTruthy();
    expect(await C.db.getKV("inboxId", "")).toMatch(/^inbox\d+$/);
  });

  it("offline edits stay in the outbox and reach the server after reconnect", async () => {
    const t = await A.repo.createTask({ title: "Draft" });
    await A.engine.sync();
    A.net.offline = true;
    await A.repo.updateTask(t.id, { title: "Draft v2", priority: 5 });
    const t2 = await A.repo.createTask({ title: "Made offline" });
    await A.engine.sync();
    expect(A.engine.status.state).toBe("offline");
    expect(await A.db.outbox.count()).toBe(2);
    expect((await serverTask(t.id))?.title).toBe("Draft");
    A.net.offline = false;
    await A.engine.sync();
    expect(A.engine.status.state).toBe("idle");
    expect(await A.db.outbox.count()).toBe(0);
    expect((await serverTask(t.id))?.title).toBe("Draft v2");
    expect((await serverTask(t.id))?.priority).toBe(5);
    expect((await serverTask(t2.id))?.title).toBe("Made offline");
    await B.engine.sync();
    expect((await B.db.tasks.get(t2.id))?.title).toBe("Made offline");
  });

  it("conflict: a pending local edit survives a pull, then the last push wins and both converge", async () => {
    const t = await A.repo.createTask({ title: "Shared" });
    await A.engine.sync();
    await B.engine.sync();
    // both edit offline
    A.net.offline = true;
    B.net.offline = true;
    await A.repo.updateTask(t.id, { title: "From A" });
    await B.repo.updateTask(t.id, { title: "From B" });
    A.net.offline = false;
    await A.engine.sync();
    expect((await serverTask(t.id))?.title).toBe("From A");
    // B pulls while its own edit is pending: local edit is kept (B pushes before it pulls)
    B.net.offline = false;
    await B.engine.pull();
    expect((await B.db.tasks.get(t.id))?.title).toBe("From B");
    await B.engine.sync();
    expect((await serverTask(t.id))?.title).toBe("From B");
    await A.engine.sync();
    expect((await A.db.tasks.get(t.id))?.title).toBe("From B");
    expect((await A.db.tasks.get(t.id))?.etag).toBe((await B.db.tasks.get(t.id))?.etag);
  });

  it("two clients edit title and due date of one task offline, both push", async () => {
    const t = await A.repo.createTask({ title: "Original", startDate: "2026-11-16T09:00:00+0000", dueDate: "2026-11-16T10:00:00+0000" });
    await A.engine.sync();
    await B.engine.sync();
    A.net.offline = B.net.offline = true;
    await A.repo.updateTask(t.id, { title: "Title from A" });
    await B.repo.updateTask(t.id, { dueDate: "2026-11-17T10:00:00+0000" });
    const op = await B.db.outbox.toArray();
    expect(op[0]!.payload.wire).toMatchObject({ id: t.id, dueDate: "2026-11-17T10:00:00+0000", _sync: { baseModifiedTime: expect.any(String) } });
    expect(op[0]!.payload.wire).not.toHaveProperty("title");
    A.net.offline = B.net.offline = false;
    await A.engine.sync();
    await B.engine.sync();
    await A.engine.sync();
    for (const row of [await serverTask(t.id), await A.db.tasks.get(t.id), await B.db.tasks.get(t.id)]) {
      expect(row).toMatchObject({ title: "Title from A", dueDate: "2026-11-17T10:00:00+0000" });
    }
  });

  it("same-field conflict keeps the later push and records its activity", async () => {
    const t = await A.repo.createTask({ title: "Original" });
    await A.engine.sync();
    await B.engine.sync();
    await A.repo.updateTask(t.id, { title: "A" });
    await B.repo.updateTask(t.id, { title: "B" });
    await A.engine.sync();
    await B.engine.sync();
    await A.engine.sync();
    expect((await A.db.tasks.get(t.id))?.title).toBe("B");
    expect((await B.db.tasks.get(t.id))?.title).toBe("B");
    const activity = await A.engine.api.get<Array<{ field?: string; oldValue?: unknown; newValue?: unknown }>>(`/api/v1/task/activity/${t.id}`);
    expect(activity).toContainEqual(expect.objectContaining({ field: "title", oldValue: "A", newValue: "B" }));
  });

  it("delete vs edit never resurrects a trashed or permanently deleted task", async () => {
    for (const permanent of [false, true]) {
      const t = await A.repo.createTask({ title: "Delete wins" });
      await A.engine.sync();
      await B.engine.sync();
      await B.repo.updateTask(t.id, { title: "Offline edit" });
      await A.repo.trashIds([t.id]);
      await A.engine.sync();
      if (permanent) { await A.repo.deleteForever([t.id]); await A.engine.sync(); }
      await B.engine.sync();
      expect(await B.db.outbox.count()).toBe(0);
      if (permanent) {
        expect(await serverTask(t.id)).toBeNull();
        expect(await B.db.tasks.get(t.id)).toBeUndefined();
      } else {
        expect(await serverTask(t.id)).toMatchObject({ deleted: 1, title: "Delete wins" });
        expect((await B.db.tasks.get(t.id))?.deleted).toBe(1);
      }
    }
  });

  it("an old-style whole-object push keeps unknown stored fields", async () => {
    const t = await A.repo.createTask({ title: "Legacy", futureField: { retained: true } });
    await A.engine.sync();
    const old = (await serverTask(t.id))!;
    const { futureField, ...legacy } = old;
    await A.engine.api.post("/api/v2/batch/task", { update: [{ ...legacy, title: "Legacy edit" }] });
    expect(await serverTask(t.id)).toMatchObject({ title: "Legacy edit", futureField });
  });

  it("explicit removals survive sync without clearing unrelated concurrent edits", async () => {
    const t = await A.repo.createTask({ title: "Dated", startDate: "2026-11-16T09:00:00+0000", dueDate: "2026-11-16T10:00:00+0000" });
    await A.engine.sync(); await B.engine.sync();
    await A.repo.updateTask(t.id, { title: "Renamed" });
    await B.repo.updateTask(t.id, { dueDate: undefined });
    await A.engine.sync(); await B.engine.sync(); await A.engine.sync();
    expect(await serverTask(t.id)).toMatchObject({ title: "Renamed" });
    expect(await serverTask(t.id)).not.toHaveProperty("dueDate");
    expect(await A.db.tasks.get(t.id)).not.toHaveProperty("dueDate");
  });

  it("merges different fields of lists, folders, tags, sections, filters and habits", async () => {
    A.engine.m4Always = B.engine.m4Always = true;
    const project = await A.repo.createProject({ name: "Original" });
    const group = await A.repo.createGroup("Original folder");
    const tag = (await A.repo.createTag("merge-tag", { color: "red" }))!;
    const column = await A.repo.createColumn(project.id, "Original section");
    if (typeof column === "string") throw new Error(column);
    const filter = await A.repo.createFilter("Original filter", "{}");
    const ma = new M4Repo(A.db, A.engine), mb = new M4Repo(B.db, B.engine);
    const habit = await ma.saveHabit(newHabit({ name: "Original habit" }));
    await A.engine.sync(); await B.engine.sync();
    await A.repo.updateProject(project.id, { name: "A list" });
    await B.repo.updateProject(project.id, { color: "blue" });
    await A.repo.updateGroup(group.id, { name: "A folder" });
    await B.repo.updateGroup(group.id, { sortOrder: 987 });
    await A.repo.updateTag(tag.name, { label: "A tag" });
    await B.repo.updateTag(tag.name, { color: "blue" });
    await A.repo.updateColumn(column.id, { name: "A section" });
    await B.repo.updateColumn(column.id, { sortOrder: 987 });
    await A.repo.updateFilter(filter.id, { name: "A filter" });
    await B.repo.updateFilter(filter.id, { sortOrder: 987 });
    await ma.saveHabit({ ...(await A.db.habits.get(habit.id))!, name: "A habit" });
    await mb.saveHabit({ ...(await B.db.habits.get(habit.id))!, encouragement: "B encouragement" });
    await A.engine.sync(); await B.engine.sync(); await A.engine.sync();
    for (const db of [A.db, B.db]) {
      expect(await db.projects.get(project.id)).toMatchObject({ name: "A list", color: "blue" });
      expect(await db.groups.get(group.id)).toMatchObject({ name: "A folder", sortOrder: 987 });
      expect(await db.tags.get(tag.name)).toMatchObject({ label: "A tag", color: "blue" });
      expect(await db.columns.get(column.id)).toMatchObject({ name: "A section", sortOrder: 987 });
      expect(await db.filters.get(filter.id)).toMatchObject({ name: "A filter", sortOrder: 987 });
      expect(await db.habits.get(habit.id)).toMatchObject({ name: "A habit", encouragement: "B encouragement" });
    }
  });

  it.each<Exclude<M4Entity, "habit">>(["habitSection", "checkin", "habitRecord", "pomodoro", "timing", "timer", "countdown"])("merges different fields of %s without dropping unknown fields", async (entity) => {
    A.engine.m4Always = B.engine.m4Always = true;
    const habit = await new M4Repo(A.db, A.engine).saveHabit(newHabit({ name: "Parent habit" }));
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
    const sample: Record<string, unknown> = {
      habitSection: { name: "Section", sortOrder: 1 },
      checkin: { habitId: habit.id, checkinStamp: 20261116, checkinTime: "2026-11-16T09:00:00+0000", goal: 1 },
      habitRecord: { habitId: habit.id, stamp: 20261116, content: "Original", emoji: 1 },
      pomodoro: { type: 0, startTime: "2026-11-15T12:00:00+0000", endTime: "2026-11-15T12:25:00+0000", tasks: [] },
      timing: { type: 1, startTime: "2026-11-15T12:00:00+0000", endTime: "2026-11-15T12:25:00+0000", tasks: [] },
      timer: { name: "Timer", sortOrder: 1 },
      countdown: { name: "Countdown", sortOrder: 1 },
    }[entity]!;
    const ta = M4_ENTITIES[entity].table(A.db), tb = M4_ENTITIES[entity].table(B.db);
    const initial = { id, ...sample, futureField: { keep: true } };
    await ta.put(initial);
    await A.engine.enqueue("m4", id, { entity, add: true });
    await A.engine.sync(); await B.engine.sync();
    expect(await tb.get(id)).toBeTruthy();
    const patches: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
      habitSection: [{ name: "Changed section" }, { sortOrder: 987 }],
      checkin: [{ checkinTime: "2026-11-16T10:00:00+0000" }, { goal: 3 }],
      habitRecord: [{ content: "Changed note" }, { emoji: 5 }],
      pomodoro: [{ endTime: "2026-11-15T12:30:00+0000" }, { note: "Changed note" }],
      timing: [{ endTime: "2026-11-15T12:30:00+0000" }, { note: "Changed note" }],
      timer: [{ name: "Changed timer" }, { sortOrder: 987 }],
      countdown: [{ name: "Changed countdown" }, { sortOrder: 987 }],
    };
    const [pa, pb] = patches[entity]!;
    await ta.put({ ...(await ta.get(id))!, ...pa }); await A.engine.enqueue("m4", id, { entity });
    await tb.put({ ...(await tb.get(id))!, ...pb }); await B.engine.enqueue("m4", id, { entity });
    await A.engine.sync(); await B.engine.sync(); await A.engine.sync();
    for (const table of [ta, tb]) expect(await table.get(id)).toMatchObject({ ...pa, ...pb, futureField: { keep: true } });
  });

  it("a skipped deletion is reconciled even when the client's checkpoint already advanced", async () => {
    const project = await A.repo.createProject({ name: "Delete this" });
    await A.engine.sync(); await B.engine.sync();
    await B.repo.updateProject(project.id, { name: "Offline rename" });
    await A.repo.deleteProject(project.id); await A.engine.sync();
    await B.engine.pull(); // pending rename skips the tombstone, but advances the checkpoint
    expect(await B.db.projects.get(project.id)).toBeTruthy();
    await B.engine.sync();
    expect(await B.db.projects.get(project.id)).toBeUndefined();
  });

  it("delta pull advances the checkpoint and carries updates, moves, trash and tag renames", async () => {
    const p = await A.repo.createProject({ name: "Work" });
    const t = await A.repo.createTask({ title: "Report", tags: ["Q4"] });
    const u = await A.repo.createTask({ title: "Old idea" });
    await A.engine.sync();
    await B.engine.sync();
    const cp1 = await B.db.getKV<number>("checkPoint", 0);
    expect(cp1).toBeGreaterThan(0);
    // nothing changed: the delta is empty
    const empty = await B.engine.pull();
    expect(empty.syncTaskBean.empty).toBe(true);

    await A.repo.moveTasks([t.id], p.id);
    await A.repo.trashIds([u.id]);
    await A.repo.renameTag("q4", "Quarter4");
    await A.engine.sync();
    await B.engine.sync();
    expect(B.requests.some((r) => r.startsWith(`GET /api/v3/batch/check/${cp1}`))).toBe(true);
    expect(await B.db.getKV<number>("checkPoint", 0)).toBeGreaterThan(cp1);
    const bt = await B.db.tasks.get(t.id);
    expect(bt?.projectId).toBe(p.id);
    expect(bt?.tags).toEqual(["quarter4"]);
    expect((await B.db.tasks.get(u.id))?.deleted).toBe(1);
    expect(await B.db.tags.get("quarter4")).toBeTruthy();
  });

  it("completing a repeating task writes the next occurrence plus a completed copy", async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const t = await A.repo.createTask({ title: "Water plants", startDate: new Date(today).toISOString().replace("Z", "+0000"), isAllDay: true, repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1", repeatFrom: "2" });
    await A.engine.sync();
    const res = await A.repo.toggleComplete(t.id);
    await A.engine.sync();
    const master = (await serverTask(t.id))!;
    expect(master.status).toBe(0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(Date.parse(String(master.startDate).replace("+0000", "Z"))).toBe(tomorrow.getTime());
    const copy = (await serverTask(res.copy!.id))!;
    expect(copy.status).toBe(2);
    expect(copy.repeatTaskId).toBe(t.id);
  });

  it("subtasks, parent links and won't do round-trip", async () => {
    const parent = await A.repo.createTask({ title: "Trip" });
    const child = await A.repo.createTask({ title: "Pack", parentId: parent.id });
    const loose = await A.repo.createTask({ title: "Book hotel" });
    await A.engine.sync();
    expect((await serverTask(child.id))?.parentId).toBe(parent.id);
    expect(await A.repo.setParent(loose.id, parent.id)).toBeNull();
    await A.repo.setWontDo(child.id);
    await A.engine.sync();
    expect((await serverTask(loose.id))?.parentId).toBe(parent.id);
    expect((await serverTask(parent.id))?.childIds).toEqual(expect.arrayContaining([child.id, loose.id]));
    expect((await serverTask(child.id))?.status).toBe(-1);
  });

  it("an add that never reached the server is cancelled by its delete (no request)", async () => {
    A.net.offline = true;
    const t = await A.repo.createTask({ title: "Typo" });
    await A.repo.trashIds([t.id]);
    expect(await A.db.outbox.count()).toBe(0);
    A.net.offline = false;
    A.requests.length = 0;
    await A.engine.sync();
    expect(A.requests.filter((r) => r.includes("batch/task"))).toHaveLength(0);
    expect(await serverTask(t.id)).toBeNull();
  });

  it("upserts of one row coalesce into a single op; settings push and pull", async () => {
    const t = await A.repo.createTask({ title: "a" });
    await A.repo.updateTask(t.id, { title: "ab" });
    await A.repo.updateTask(t.id, { title: "abc" });
    expect(await A.db.outbox.count()).toBe(1);
    await A.repo.setSettings({ showMeridiem: true, startDayOfWeek: "MON" });
    await A.engine.sync();
    expect((await serverTask(t.id))?.title).toBe("abc");
    await B.engine.sync();
    const s = await B.db.getKV<Record<string, unknown>>("settings", {});
    expect(s.showMeridiem).toBe(true);
    expect(s.startDayOfWeek).toBe("MON");
  });

  it("trash restore and delete forever", async () => {
    const t = await A.repo.createTask({ title: "Oops" });
    const u = await A.repo.createTask({ title: "Gone" });
    await A.engine.sync();
    await A.repo.trashIds([t.id, u.id]);
    await A.engine.sync();
    expect((await serverTask(t.id))?.deleted).toBe(1);
    await A.repo.restoreFromTrash([t.id]);
    await A.repo.deleteForever([u.id]);
    await A.engine.sync();
    expect((await serverTask(t.id))?.deleted).toBe(0);
    expect(await serverTask(u.id)).toBeNull();
  });
});

describe("push race", () => {
  it("reverting a field while its earlier value is in flight still sends the revert", async () => {
    const db = new NoorDb(`revert-${Math.random()}`);
    let hook: (() => Promise<void>) | undefined;
    const api = new Api({ base, fetch: async (input, init) => {
      const res = await fetch(input, init);
      if (hook && String(input).includes("/batch/task")) { const fn = hook; hook = undefined; await fn(); }
      return res;
    } });
    const engine = new SyncEngine(db, api), repo = new Repo(db, engine);
    await engine.sync();
    const t = await repo.createTask({ title: "Original" });
    await engine.sync();
    await repo.updateTask(t.id, { title: "Temporary" });
    hook = () => repo.updateTask(t.id, { title: "Original" });
    await engine.sync();
    expect(await db.tasks.get(t.id)).toMatchObject({ title: "Original" });
    expect(await serverTask(t.id)).toMatchObject({ title: "Original" });
  });

  it("acknowledged fields survive a reload after push succeeds but pull fails", async () => {
    const db = new NoorDb(`ack-${Math.random()}`);
    const api = new Api({ base });
    const engine = new SyncEngine(db, api), repo = new Repo(db, engine);
    await engine.sync();
    const t = await repo.createTask({ title: "Original" });
    await engine.sync();
    await repo.updateTask(t.id, { title: "Temporary" });
    await engine.push(); // no pull: reload immediately after the acknowledgement
    const next = new SyncEngine(db, api), nextRepo = new Repo(db, next);
    await nextRepo.updateTask(t.id, { title: "Original" });
    await next.sync();
    expect(await serverTask(t.id)).toMatchObject({ title: "Original" });
  });

  it("an edit made while its row is being pushed is not lost", async () => {
    const db = new NoorDb(`race-${Math.random()}`);
    let hook: (() => Promise<void>) | null = null;
    const api = new Api({
      base,
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        if (hook && String(input).includes("/batch/task")) {
          const h = hook;
          hook = null;
          await h();
        }
        return res;
      },
    });
    const engine = new SyncEngine(db, api);
    const repo = new Repo(db, engine);
    await engine.sync();
    const t = await repo.createTask({ title: "v1" });
    await engine.sync();
    await repo.updateTask(t.id, { title: "v2" });
    hook = () => repo.updateTask(t.id, { title: "v3" }); // lands while the v2 push is in flight
    await engine.sync();
    await engine.sync();
    expect((await db.tasks.get(t.id))?.title).toBe("v3");
    expect((await serverTask(t.id))?.title).toBe("v3");
  });
});

describe("no Premium limits (PREM, TASK-036/157/158, LIST-004/011/012, NOTE-013/014, TAG-020)", () => {
  it("long titles and bodies, many lists, many tasks per list and in Inbox, many checklist items, many tags all sync untouched", async () => {
    const c = await client();
    const longTitle = "t".repeat(5000);
    const longBody = "# h\n\n" + "b".repeat(500_000);
    const longName = "L".repeat(200);
    const lists: Array<{ id: string }> = [];
    for (let i = 0; i < 15; i++) lists.push(await c.repo.createProject({ name: i === 0 ? longName : `List ${i}`, kind: i === 1 ? "NOTE" : "TASK" }));
    for (let i = 0; i < 120; i++) await c.repo.createTask({ title: `bulk ${i}`, projectId: lists[2]!.id });
    for (let i = 0; i < 120; i++) await c.repo.createTask({ title: `inbox ${i}` });
    for (let i = 0; i < 120; i++) await c.repo.createTask({ title: `note ${i}`, projectId: lists[1]!.id, kind: "NOTE" });
    const big = await c.repo.createTask({ title: longTitle, content: longBody, items: Array.from({ length: 300 }, (_, i) => ({ id: `item${i}`.padEnd(24, "0"), title: "i".repeat(3000), status: 0, sortOrder: i })) });
    await c.repo.ensureTags(Array.from({ length: 60 }, (_, i) => `tag${i}`));
    await c.engine.sync();
    expect(c.engine.status.state).toBe("idle");
    const s = (await serverTask(big.id))!;
    expect((s.title as string).length).toBe(5000);
    expect(s.content).toBe(longBody);
    expect((s.items as Array<{ title: string }>).length).toBe(300);
    expect((s.items as Array<{ title: string }>)[299]!.title.length).toBe(3000);
    const check = await (await fetch(`${base}/api/v3/batch/check/0`)).json();
    expect(check.projectProfiles.find((p: { id: string }) => p.id === lists[0]!.id).name).toBe(longName);
    expect(check.projectProfiles.length).toBeGreaterThanOrEqual(15);
    expect(check.syncTaskBean.update.filter((t: { projectId: string }) => t.projectId === lists[2]!.id).length).toBe(120);
    expect(check.syncTaskBean.update.filter((t: { projectId: string }) => t.projectId === lists[1]!.id).length).toBe(120);
    expect(check.tags.length).toBeGreaterThanOrEqual(60);
  });

  it("subtask depth stays at five levels (TASK-065, PREM-083)", async () => {
    const c = await client();
    const chain = [await c.repo.createTask({ title: "L1" })];
    for (let i = 2; i <= 5; i++) chain.push(await c.repo.createTask({ title: `L${i}`, parentId: chain[chain.length - 1]!.id }));
    const sixth = await c.repo.createTask({ title: "L6" });
    expect(await c.repo.setParent(sixth.id, chain[4]!.id)).toBe("Up to 5 levels of subtasks");
    expect(await c.repo.setParent(sixth.id, chain[3]!.id)).toBeNull();
  });
});

describe("hard deletes converge", () => {
  it("delete forever on A removes the row from B's trash", async () => {
    const A = await client();
    const B = await client();
    const t = await A.repo.createTask({ title: "Purge me" });
    await A.engine.sync();
    await B.engine.sync();
    await A.repo.trashIds([t.id]);
    await A.engine.sync();
    await B.engine.sync();
    expect((await B.db.tasks.get(t.id))?.deleted).toBe(1);
    await A.repo.deleteForever([t.id]);
    await A.engine.sync();
    await B.engine.sync();
    expect(await B.db.tasks.get(t.id)).toBeUndefined();
  });

  it("restoring a row that was deleted for good elsewhere drops the ghost and does not resurrect it", async () => {
    const A = await client();
    const B = await client();
    const t = await A.repo.createTask({ title: "Gone elsewhere" });
    await A.engine.sync();
    await B.engine.sync();
    await A.repo.trashIds([t.id]);
    await A.repo.deleteForever([t.id]);
    await A.engine.sync();
    await B.engine.sync(); // one delete only: B shows it in its trash
    expect((await B.db.tasks.get(t.id))?.deleted).toBe(1);
    await B.repo.restoreFromTrash([t.id]);
    await B.engine.sync();
    expect(await B.db.tasks.get(t.id)).toBeUndefined();
    await B.engine.sync();
    expect(await serverTask(t.id)).toBeNull();
  });

  it("attachment upload and removal reach the server", async () => {
    const c = await client();
    const t = await c.repo.createTask({ title: "With file" });
    await c.repo.addAttachment(t.id, new Blob(["hello attachment"], { type: "text/plain" }), "note.txt");
    await c.engine.sync();
    const s = (await serverTask(t.id))!;
    const atts = s.attachments as Array<{ id: string; size: number; fileName: string }>;
    expect(atts).toHaveLength(1);
    expect(atts[0]!.size).toBe(16);
    expect(atts[0]!.fileName).toBe("note.txt");
    const local = await c.db.tasks.get(t.id);
    expect(local?.attachments?.[0]?.localBlob).toBeUndefined();
    await c.repo.removeAttachment(t.id, atts[0]!.id);
    await c.engine.sync();
    expect(((await serverTask(t.id))!.attachments as unknown[]) ?? []).toHaveLength(0);
  });
});
