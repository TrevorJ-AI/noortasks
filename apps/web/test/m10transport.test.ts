import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { Store } from "../../server/src/store";
import { Service } from "../../server/src/service";
import { buildCheck } from "../../server/src/sync";
import { Api, OfflineError } from "../src/data/api";
import { NoorDb, type Op } from "../src/data/db";
import { Repo } from "../src/data/repo";
import { SyncEngine, type SyncTransport } from "../src/data/sync";

/** Actual server storage/merge semantics in memory, without an HTTP server or network. */
class MemoryTransport implements SyncTransport {
  offline = false;
  constructor(readonly svc: Service) {}
  async sendRun(run: Op[]): Promise<void> {
    if (this.offline) throw new OfflineError();
    const add = run.filter((o) => o.kind === "task" && o.payload.add).map((o) => o.payload.wire);
    const update = run.filter((o) => o.kind === "task" && !o.payload.add).map((o) => o.payload.wire);
    const del = run.filter((o) => o.kind === "taskDelete").map((o) => o.key);
    this.svc.batchTask({ add, update, delete: del });
  }
  async pullDelta(cp: number) {
    if (this.offline) throw new OfflineError();
    return buildCheck(this.svc, cp);
  }
}

describe("in-memory sync transport", () => {
  it("runs push, offline retry, checkpoint pull and two-client merge without HTTP", async () => {
    const store = new Store(":memory:");
    const svc = new Service(store);
    const dbs: NoorDb[] = [];
    const device = () => {
      const db = new NoorDb(`memory-${Math.random()}`); dbs.push(db);
      const transport = new MemoryTransport(svc);
      const api = new Api({ fetch: async () => { throw new Error("HTTP must not be used"); } });
      const engine = new SyncEngine(db, api, transport);
      return { db, engine, transport, repo: new Repo(db, engine) };
    };
    try {
      const a = device(), b = device();
      await a.engine.sync();
      const task = await a.repo.createTask({ title: "Original" });
      await a.engine.sync(); await b.engine.sync();
      a.transport.offline = true;
      await a.repo.updateTask(task.id, { title: "Changed" });
      await b.repo.updateTask(task.id, { priority: 5 });
      await a.engine.sync();
      expect(a.engine.status.state).toBe("offline");
      expect(await a.db.outbox.count()).toBe(1);
      await b.engine.sync();
      a.transport.offline = false;
      await a.engine.sync(); await b.engine.sync();
      for (const db of dbs) expect(await db.tasks.get(task.id)).toMatchObject({ title: "Changed", priority: 5 });
      expect(svc.store.getTask(task.id)).toMatchObject({ title: "Changed", priority: 5 });
      expect(await a.db.getKV("checkPoint", 0)).toBeGreaterThan(0);
    } finally {
      for (const db of dbs) { db.close(); await db.delete(); }
      store.close();
    }
  });

  it("a pending storage permission request does not block synchronization", async () => {
    const db = new NoorDb(`storage-prompt-${Math.random()}`);
    const persist = vi.fn(() => new Promise<boolean>(() => {}));
    vi.stubGlobal("navigator", { storage: { persist } });
    try {
      const engine = new SyncEngine(db, new Api({ isOffline: () => true }));
      await engine.sync();
      expect(persist).toHaveBeenCalledOnce();
      expect(engine.status.state).toBe("offline");
    } finally { vi.unstubAllGlobals(); db.close(); await db.delete(); }
  });

  it("gives legacy queued operations an age that survives the next reload", async () => {
    const db = new NoorDb(`legacy-age-${Math.random()}`);
    try {
      const lastSync = Date.now() - 25 * 60 * 60 * 1000;
      await db.setKV("lastSync", lastSync);
      await db.outbox.add({ kind: "settings", key: "settings", payload: {} });
      for (let i = 0; i < 2; i++) {
        const engine = new SyncEngine(db, new Api({ isOffline: () => true }));
        await engine.sync();
        expect(engine.status.oldestPending).toBe(lastSync);
        expect((await db.outbox.toArray())[0]?.createdAt).toBe(lastSync);
      }
    } finally { db.close(); await db.delete(); }
  });

  it("restores last-sync and the original outbox age after reloading offline", async () => {
    const db = new NoorDb(`durability-${Math.random()}`);
    try {
      const old = Date.now() - 25 * 60 * 60 * 1000;
      await db.setKV("lastSync", old - 1000);
      await db.outbox.add({ kind: "settings", key: "settings", payload: {}, createdAt: old });
      const engine = new SyncEngine(db, new Api({ isOffline: () => true }));
      await engine.sync();
      expect(engine.status).toMatchObject({ state: "offline", lastSync: old - 1000, pending: 1, oldestPending: old });
    } finally { db.close(); await db.delete(); }
  });
});
