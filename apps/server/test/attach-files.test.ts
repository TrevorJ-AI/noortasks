import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { attachFiles } from "../src/attachments.js";
import { buildApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { hex, task, tmp } from "./helpers.js";

const toClean: string[] = [];
afterAll(() => toClean.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup(content: Buffer, indexSize: number) {
  const work = tmp();
  toClean.push(work);
  const db = join(work, "db.sqlite");
  const dataDir = join(work, "data");
  const filesDir = join(work, "atts");
  const t = task();
  const first = buildApp({ dbPath: db, dataDir, noAuth: true });
  const inbox = first.svc.inboxId;
  t.projectId = inbox;
  await first.app.inject({ method: "POST", url: "/api/v2/batch/task", payload: { add: [t] } });
  await first.app.close();
  const id = hex();
  const s = new Store(db);
  s.run(
    "insert into attachments(id, taskId, projectId, taskSet, fileName, size, type, path, refId, state, file, json) values (?,?,?,?,?,?,?,?,?,?,?,?)",
    id, t.id, inbox, null, "doc.txt", indexSize, "OTHER", `/files/upload/u/202611/${id}.txt`, id, "pending", null, "{}",
  );
  s.close();
  mkdirSync(join(filesDir, id), { recursive: true });
  writeFileSync(join(filesDir, id, "doc.txt"), content);
  writeFileSync(
    join(work, "attachments-downloaded.json"),
    JSON.stringify([{ id, bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") }]),
  );
  return { db, dataDir, filesDir, id };
}

describe("attach-files", () => {
  test("pending record plus file becomes downloadable; second run is a no-op", async () => {
    const data = Buffer.from("synthetic bytes é");
    const s = await setup(data, data.length);
    expect(attachFiles(s.filesDir, s.db, s.dataDir)).toEqual({ pending: 1, attached: 1, missing: 0, failed: 0 });
    const m = buildApp({ dbPath: s.db, dataDir: s.dataDir, noAuth: true });
    for (const url of [`/api/v1/attachment/${s.id}`, `/files/upload/u/202611/${s.id}.txt`]) {
      const r = await m.app.inject({ method: "GET", url });
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload.equals(data)).toBe(true);
    }
    await m.app.close();
    expect(attachFiles(s.filesDir, s.db, s.dataDir)).toEqual({ pending: 0, attached: 0, missing: 0, failed: 0 });
  });
  test("size mismatch stays pending and is reported as failed", async () => {
    const data = Buffer.from("abc");
    const s = await setup(data, data.length + 5);
    expect(attachFiles(s.filesDir, s.db, s.dataDir)).toEqual({ pending: 1, attached: 0, missing: 0, failed: 1 });
    const m = buildApp({ dbPath: s.db, dataDir: s.dataDir, noAuth: true });
    expect((await m.app.inject({ method: "GET", url: `/api/v1/attachment/${s.id}` })).statusCode).toBe(404);
    await m.app.close();
  });
  test("hash mismatch against the manifest stays pending", async () => {
    const data = Buffer.from("abc");
    const s = await setup(data, data.length);
    writeFileSync(join(s.filesDir, s.id, "doc.txt"), Buffer.from("abd"));
    expect(attachFiles(s.filesDir, s.db, s.dataDir).failed).toBe(1);
  });
  test("pending record with no downloaded file counts as missing", async () => {
    const s = await setup(Buffer.from("x"), 1);
    rmSync(join(s.filesDir, s.id), { recursive: true });
    expect(attachFiles(s.filesDir, s.db, s.dataDir)).toEqual({ pending: 1, attached: 0, missing: 1, failed: 0 });
  });
});
