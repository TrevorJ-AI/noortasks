import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, type BuiltServer } from "../../server/src/server";
import { Api } from "../src/data/api";
import { NoorDb } from "../src/data/db";
import { Repo } from "../src/data/repo";
import { SyncEngine } from "../src/data/sync";

let srv: BuiltServer;
let base = "";
let dir = "";
let n = 0;
let adminId = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nt-m8sync-"));
  srv = await buildServer({ dbPath: join(dir, "db.sqlite"), dataDir: join(dir, "files"), config: { admins: ["admin@example.com"], passwordLogin: true } });
  await srv.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = srv.app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  adminId = Number(srv.sys!.getMeta("legacyAdminId"));
});
afterAll(async () => {
  await srv.app.close();
  rmSync(dir, { recursive: true, force: true });
});

function addUser(email: string): number {
  const id = 5000 + ++n;
  const p = srv.tenants!.newPaths(id);
  srv.tenants!.initStore(id, p.dbFile);
  srv.sys!.insertUser({ id, email, name: email.split("@")[0]!, role: "member", status: "active", issuer: null, subject: null, passwordHash: null, dbFile: p.dbFile, createdMs: Date.now() });
  return id;
}

/** A device: one local database, signed in as whoever `session.userId` points at. */
function device(session: { userId: number }) {
  const db = new NoorDb(`m8-${++n}-${Math.random()}`);
  const tokens = new Map<number, string>();
  const api = new Api({
    base,
    fetch: (input, init) => {
      let t = tokens.get(session.userId);
      if (!t) tokens.set(session.userId, (t = srv.sys!.createSession(session.userId)));
      const headers = { ...((init?.headers as Record<string, string>) ?? {}), cookie: `t=${t}; _csrf_token=x`, "X-Csrftoken": "x" };
      return fetch(input, { ...init, headers });
    },
  });
  const engine = new SyncEngine(db, api);
  return { db, api, engine, repo: new Repo(db, engine) };
}

describe("M8 client: accounts on one device", () => {
  it("another account signing in wipes the local data before anything is pushed", async () => {
    const bId = addUser("b1@example.com");
    const session = { userId: adminId };
    const d = device(session);
    await d.engine.sync();
    expect(await d.db.getKV("accountId", null)).toBe(adminId);
    // A queues an edit while offline-ish (not yet pushed), then the session changes to B on this device
    const t = await d.repo.createTask({ title: "A's unsent task" });
    session.userId = bId;
    // a fresh page load: the engine checks who is signed in first
    const d2 = new SyncEngine(d.db, d.api);
    await d2.sync();
    expect(await d.db.getKV("accountId", null)).toBe(bId);
    expect(await d.db.tasks.get(t.id)).toBeUndefined();
    expect(await d.db.outbox.count()).toBe(0);
    // nothing of A's reached B's account
    expect(srv.tenants!.get(bId).store.getTask(t.id)).toBeUndefined();
  });

  it("a revoked shared list vanishes from the member's device (not into the trash)", async () => {
    const cId = addUser("c1@example.com");
    const a = device({ userId: adminId });
    const c = device({ userId: cId });
    await a.engine.sync();
    const p = await a.repo.createProject({ name: "Shared groceries" });
    const t = await a.repo.createTask({ title: "milk", projectId: p.id });
    await a.engine.sync();
    const share = await a.api.post<Array<{ id: string; userId: number }>>(`/api/v2/project/${p.id}/share`, { userId: cId, permission: "write" });
    await c.engine.sync();
    expect((await c.db.projects.get(p.id))?.isOwner).toBe(false);
    expect((await c.db.tasks.get(t.id))?.title).toBe("milk");
    // Member and owner edit different fields offline, through the normal outboxes.
    await c.repo.updateTask(t.id, { title: "oat milk" });
    await a.repo.updateTask(t.id, { dueDate: "2026-11-20T10:00:00+0000" });
    await a.engine.sync();
    await c.engine.sync();
    await a.engine.sync();
    expect(await a.db.tasks.get(t.id)).toMatchObject({ title: "oat milk", dueDate: "2026-11-20T10:00:00+0000" });
    expect(await c.db.tasks.get(t.id)).toMatchObject({ title: "oat milk", dueDate: "2026-11-20T10:00:00+0000" });
    // A removes C
    const row = share.find((r) => r.userId === cId)!;
    await a.api.del(`/api/v2/project/${p.id}/share/${row.id}`);
    await c.engine.sync();
    expect(await c.db.projects.get(p.id)).toBeUndefined();
    expect(await c.db.tasks.get(t.id)).toBeUndefined();
  });
});
