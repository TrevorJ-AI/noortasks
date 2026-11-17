import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { Api } from "../src/data/api";
import { NoorDb } from "../src/data/db";
import { Repo } from "../src/data/repo";
import { SyncEngine } from "../src/data/sync";
import { builderToRule, cond } from "../src/model/filters";

/** M5 data paths against the real server in-process: custom filters sync both ways (SYNC-034, FILT-014, FILT-016). */
let base = "";
let close: () => Promise<void>;
let dir = "";
let n = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nt-m5-"));
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

async function client() {
  const db = new NoorDb(`m5-${++n}-${Math.random()}`);
  const engine = new SyncEngine(db, new Api({ base }));
  const repo = new Repo(db, engine);
  await engine.sync();
  return { db, engine, repo };
}

describe("custom filters sync", () => {
  it("create, edit, duplicate and delete on one device show up on another", async () => {
    const a = await client();
    const b = await client();
    const rule = builderToRule({ kind: "group", op: "or", items: [cond("priority", [5]), cond("tag", ["weekend"])] });
    const f = await a.repo.createFilter("Hot or weekend", rule);
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.db.filters.get(f.id))?.rule).toBe(rule);
    await a.repo.updateFilter(f.id, { name: "Renamed", viewMode: "kanban" });
    const copy = await a.repo.duplicateFilter(f.id);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.db.filters.get(f.id)).toMatchObject({ name: "Renamed", viewMode: "kanban" });
    expect((await b.db.filters.get(copy!.id))?.name).toBe("Renamed copy");
    await a.repo.deleteFilter(f.id);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.db.filters.get(f.id)).toBeUndefined();
    expect(await b.db.filters.count()).toBe(1);
  });

  it("a filter deleted before it was pushed never reaches the server", async () => {
    const a = await client();
    const before = await a.db.filters.count();
    const f = await a.repo.createFilter("Short lived", builderToRule({ kind: "group", op: "and", items: [cond("priority", [1])] }));
    await a.repo.deleteFilter(f.id);
    expect(await a.db.outbox.count()).toBe(0);
    await a.engine.sync();
    expect(await a.db.filters.count()).toBe(before);
  });
});
