import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { diffExports, exportBackup, importBackup } from "../src/importExport.js";
import { hex, makeExport, mk, seedProject, task, tmp, w } from "./helpers.js";
import { T0, addHabit, checkIn, id, isoWire, mk4 } from "./m4helpers.js";

const cleanupDirs: string[] = [];
const freshDir = (): string => {
  const d = tmp();
  cleanupDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of cleanupDirs) rmSync(d, { recursive: true, force: true });
});

const BOUNDARY = "----followup7e91";

function multipartBody(filename: string, mime: string, data: Readable | Buffer): Readable {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  async function* gen() {
    yield head;
    if (Buffer.isBuffer(data)) yield data;
    else for await (const c of data) yield c as Buffer;
    yield tail;
  }
  return Readable.from(gen(), { objectMode: false });
}

function generated(total: number): { stream: Readable; sha: () => string } {
  const h = createHash("sha256");
  let sent = 0;
  const chunk = Buffer.alloc(65536);
  const stream = new Readable({
    read() {
      if (sent >= total) return this.push(null);
      const n = Math.min(chunk.length, total - sent);
      for (let i = 0; i < n; i += 4) chunk.writeUInt32LE(((sent + i) * 2654435761) >>> 0, i);
      const out = Buffer.from(chunk.subarray(0, n));
      sent += n;
      h.update(out);
      this.push(out);
    },
  });
  return { stream, sha: () => h.digest("hex") };
}

function upload(port: number, path: string, body: Readable): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` } },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c) => parts.push(c));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString();
          try {
            resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null });
          } catch {
            resolve({ status: res.statusCode!, json: text });
          }
        });
      },
    );
    req.on("error", reject);
    body.pipe(req);
  });
}

function downloadHash(port: number, path: string): Promise<{ status: number; sha: string; bytes: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        const h = createHash("sha256");
        let bytes = 0;
        res.on("data", (c: Buffer) => {
          h.update(c);
          bytes += c.length;
        });
        res.on("end", () => resolve({ status: res.statusCode!, sha: h.digest("hex"), bytes, headers: res.headers }));
      })
      .on("error", reject);
  });
}

async function listening() {
  const dataDir = freshDir();
  const m = mk({ dataDir });
  await m.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (m.app.server.address() as AddressInfo).port;
  return { ...m, port, dir: dataDir };
}

// ===================================================================== 1. matrixProfiles
describe("follow-up 1: matrixProfiles routes & storage", () => {
  test("GET /api/v2/matrixProfiles returns [] on fresh DB", async () => {
    const m = await mk4();
    const res = await m.call("GET", "/api/v2/matrixProfiles");
    expect(res.status).toBe(200);
    expect(res.json).toEqual([]);
  });

  test("POST /api/v2/matrixProfiles single object mints id, fills defaults, keeps unknown fields", async () => {
    const m = await mk4();
    const created = await m.call("POST", "/api/v2/matrixProfiles", {
      name: "Work Focus",
      zzCustom: { badge: "red" },
    });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({
      name: "Work Focus",
      status: 0,
      zzCustom: { badge: "red" },
    });
    expect(typeof created.json.id).toBe("string");
    expect(typeof created.json.sortOrder).toBe("number");
    expect(Array.isArray(created.json.quadrants)).toBe(true);
    expect(created.json.quadrants).toHaveLength(4);
  });

  test("POST /api/v2/matrixProfiles single object with existing id updates instead of duplicating", async () => {
    const m = await mk4();
    const pid = id("m");
    await m.call("POST", "/api/v2/matrixProfiles", { id: pid, name: "V1", sortOrder: 2 });
    const updated = await m.call("POST", "/api/v2/matrixProfiles", { id: pid, name: "V2", sortOrder: 5 });
    expect(updated.status).toBe(200);
    expect(updated.json.name).toBe("V2");
    const list = await m.call("GET", "/api/v2/matrixProfiles");
    expect(list.json).toHaveLength(1);
    expect(list.json[0].name).toBe("V2");
  });

  test("POST /api/v2/matrixProfiles accepts an array of profiles and validates array items", async () => {
    const m = await mk4();
    const p1 = id("m");
    const res = await m.call("POST", "/api/v2/matrixProfiles", [
      { id: p1, name: "First", sortOrder: 10 },
      { name: "Second", sortOrder: 20 },
    ]);
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(2);
    expect(res.json.map((x: any) => x.name)).toEqual(["First", "Second"]);

    const bad = await m.call("POST", "/api/v2/matrixProfiles", ["not-an-object"]);
    expect(bad.status).toBe(400);
    const badBody = await m.call("POST", "/api/v2/matrixProfiles", 123);
    expect(badBody.status).toBe(400);
  });

  test("POST /api/v2/matrixProfiles/batch and /matrixProfiles/batch perform add/update/delete", async () => {
    const m = await mk4();
    const a = id("m");
    const b = id("m");
    const r1 = await m.call("POST", "/api/v2/matrixProfiles/batch", {
      add: [
        { id: a, name: "Alpha", sortOrder: 1 },
        { id: b, name: "Beta", sortOrder: 2 },
      ],
    });
    expect(r1.status).toBe(200);
    expect(Object.keys(r1.json.id2etag)).toEqual([a, b]);
    expect(r1.json.id2error).toEqual({});

    const r2 = await m.call("POST", "/matrixProfiles/batch", {
      update: [{ id: a, name: "Alpha Renamed", sortOrder: 9 }],
      delete: [b],
    });
    expect(r2.status).toBe(200);
    expect(r2.json.id2etag[a]).toBeTruthy();
    expect(r2.json.id2error).toEqual({});

    const list = await m.call("GET", "/api/v2/matrixProfiles");
    expect(list.json.map((x: any) => ({ id: x.id, name: x.name }))).toEqual([{ id: a, name: "Alpha Renamed" }]);
  });

  test("POST /api/v2/matrixProfiles delegates {add,update,delete} objects cleanly", async () => {
    const m = await mk4();
    const a = id("m");
    const r = await m.call("POST", "/api/v2/matrixProfiles", {
      add: [{ id: a, name: "Via Root", sortOrder: 3 }],
    });
    expect(r.status).toBe(200);
    expect(r.json.id2etag[a]).toBeTruthy();
    expect((await m.call("GET", "/api/v2/matrixProfiles")).json).toHaveLength(1);
  });

  test("GET /api/v2/matrixProfiles sorts ascending by sortOrder across updates", async () => {
    const m = await mk4();
    const p1 = id("m");
    const p2 = id("m");
    const p3 = id("m");
    await m.call("POST", "/api/v2/matrixProfiles/batch", {
      add: [
        { id: p1, name: "Three", sortOrder: 30 },
        { id: p2, name: "One", sortOrder: 10 },
        { id: p3, name: "Two", sortOrder: 20 },
      ],
    });
    expect((await m.call("GET", "/api/v2/matrixProfiles")).json.map((x: any) => x.name)).toEqual(["One", "Two", "Three"]);

    await m.call("POST", "/api/v2/matrixProfiles/batch", {
      update: [{ id: p1, name: "NowFirst", sortOrder: 1 }],
    });
    expect((await m.call("GET", "/api/v2/matrixProfiles")).json.map((x: any) => x.name)).toEqual(["NowFirst", "One", "Two"]);
  });

  test("batch error semantics (EXISTED / NOT_EXISTED) and re-adding deleted id work", async () => {
    const m = await mk4();
    const p = id("m");
    await m.call("POST", "/api/v2/matrixProfiles/batch", { add: [{ id: p, name: "P1" }] });
    const dup = await m.call("POST", "/api/v2/matrixProfiles/batch", { add: [{ id: p, name: "Dup" }] });
    expect(dup.json.id2error[p]).toBe("EXISTED");

    const ghost = id("m");
    const missing = await m.call("POST", "/api/v2/matrixProfiles/batch", { update: [{ id: ghost, name: "X" }], delete: [ghost] });
    expect(missing.json.id2error[ghost]).toBe("NOT_EXISTED");

    await m.call("POST", "/api/v2/matrixProfiles/batch", { delete: [p] });
    const readd = await m.call("POST", "/api/v2/matrixProfiles/batch", { add: [{ id: p, name: "Readded" }] });
    expect(readd.json.id2error).toEqual({});
    expect((await m.call("GET", "/api/v2/matrixProfiles")).json[0].name).toBe("Readded");
  });

  test("unlimited named matrix profiles (>15) and deep unknown fields survive reload", async () => {
    const dir = freshDir();
    const dbPath = join(dir, "db.sqlite");
    const app1 = buildApp({ dbPath, dataDir: dir, noAuth: true });
    const items = Array.from({ length: 18 }, (_, i) => ({
      id: id("m"),
      name: `Matrix ${i}`,
      sortOrder: i,
      zzExtra: { flag: i % 2 === 0 },
      quadrants: [
        { id: "q1", title: `Q1-${i}`, customQField: i * 10 },
        { id: "q2", title: "Q2" },
        { id: "q3", title: "Q3" },
        { id: "q4", title: "Q4" },
      ],
    }));
    const r = await app1.app.inject({ method: "POST", url: "/api/v2/matrixProfiles/batch", payload: { add: items } });
    expect(r.statusCode).toBe(200);
    expect(r.json().id2error).toEqual({});
    await app1.app.close();

    const app2 = buildApp({ dbPath, dataDir: dir, noAuth: true });
    const listed = (await app2.app.inject({ method: "GET", url: "/api/v2/matrixProfiles" })).json();
    expect(listed).toHaveLength(18);
    expect(listed[5].zzExtra).toEqual({ flag: false });
    expect(listed[5].quadrants[0].customQField).toBe(50);
    await app2.app.close();
  });

  test("importBackup/exportBackup round-trips matrixProfiles cleanly via matrix-profiles.json", () => {
    const src = freshDir();
    const work = freshDir();
    const out = freshDir();
    makeExport(src);
    w(src, "matrix-profiles.json", [
      { id: id("m"), name: "Imported View", status: 0, sortOrder: 1, quadrants: [], zzKeep: true },
    ]);
    const db = join(work, "backup.sqlite");
    const imp = importBackup(src, db);
    expect(imp.counts.matrixProfiles).toBe(1);
    const exp = exportBackup(db, out);
    expect(exp.matrixProfiles).toBe(1);
    const diff = diffExports(src, out);
    expect(diff.mismatches).toBe(0);
    expect(diff.filesOnlyA).toEqual([]);
    expect(diff.filesOnlyB).toEqual([]);
    expect(diff.rows.find((r) => r.entity === "matrixProfiles")).toMatchObject({ a: 1, b: 1, fieldMismatches: [] });
  });
});

// ===================================================================== 2. column tombstones
describe("follow-up 2: column pull reports deleted tombstones", () => {
  test("GET /api/v2/column?from=0 returns full snapshot without deletion markers", async () => {
    const m = await mk4();
    expect((await m.call("GET", "/api/v2/column?from=0")).json).toEqual({});
    const pid = await seedProject(m.call, { viewMode: "kanban" });
    const c1 = hex();
    const c2 = hex();
    await m.call("POST", "/api/v2/batch/columnProject", {
      add: [
        { id: c1, projectId: pid, name: "Todo", sortOrder: 1 },
        { id: c2, projectId: pid, name: "Done", sortOrder: 2 },
      ],
    });
    await m.call("POST", "/api/v2/batch/columnProject", { delete: [{ id: c2, projectId: pid }] });
    const snap = (await m.call("GET", "/api/v2/column?from=0")).json;
    expect(Object.keys(snap)).toEqual([pid]);
    expect(snap[pid].map((c: any) => c.id)).toEqual([c1]);
    expect(snap[pid].every((c: any) => c.deleted === undefined)).toBe(true);
  });

  test("GET /api/v2/column?from=<ts> emits {id, projectId, deleted: 1} for both {columnId, projectId} and {id, projectId} deletes", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call, { viewMode: "kanban" });
    const c1 = hex();
    const c2 = hex();
    const c3 = hex();
    await m.call("POST", "/api/v2/batch/columnProject", {
      add: [
        { id: c1, projectId: pid, name: "Todo", sortOrder: 1 },
        { id: c2, projectId: pid, name: "Doing", sortOrder: 2 },
        { id: c3, projectId: pid, name: "Done", sortOrder: 3 },
      ],
    });
    const cp = m.store.lastSeq();
    await m.call("POST", "/api/v2/batch/columnProject", { delete: [{ columnId: c2, projectId: pid }, { id: c3, projectId: pid }] });
    const delta = (await m.call("GET", `/api/v2/column?from=${cp}`)).json;
    expect(delta[pid]).toEqual([
      { id: c2, projectId: pid, deleted: 1 },
      { id: c3, projectId: pid, deleted: 1 },
    ]);
  });

  test("column delete omitting projectId (string id or {id}) still reports deleted tombstone under old.projectId", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call, { viewMode: "kanban" });
    const c1 = hex();
    const c2 = hex();
    await m.call("POST", "/api/v2/batch/columnProject", {
      add: [
        { id: c1, projectId: pid, name: "A", sortOrder: 1 },
        { id: c2, projectId: pid, name: "B", sortOrder: 2 },
      ],
    });
    const cp = m.store.lastSeq();
    await m.call("POST", "/api/v2/batch/columnProject", { delete: [c1, { id: c2 }] });
    const delta = (await m.call("GET", `/api/v2/column?from=${cp}`)).json;
    expect(delta[pid]).toEqual([
      { id: c1, projectId: pid, deleted: 1 },
      { id: c2, projectId: pid, deleted: 1 },
    ]);
  });

  test("GET /api/v2/column?from=<ts> combines updated live columns and deleted tombstones", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call, { viewMode: "kanban" });
    const c1 = hex();
    const c2 = hex();
    await m.call("POST", "/api/v2/batch/columnProject", {
      add: [
        { id: c1, projectId: pid, name: "Backlog", sortOrder: 1 },
        { id: c2, projectId: pid, name: "Obsolete", sortOrder: 2 },
      ],
    });
    const cp = m.store.lastSeq();
    await m.call("POST", "/api/v2/batch/columnProject", {
      update: [{ id: c1, projectId: pid, name: "Next", sortOrder: 1 }],
      delete: [{ id: c2, projectId: pid }],
    });
    const delta = (await m.call("GET", `/api/v2/column?from=${cp}`)).json;
    expect(delta[pid]).toHaveLength(2);
    expect(delta[pid][0]).toMatchObject({ id: c1, name: "Next" });
    expect(delta[pid][1]).toEqual({ id: c2, projectId: pid, deleted: 1 });
  });

  test("deleting a project records column tombstones returned by GET /api/v2/column?from=<ts>", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call, { viewMode: "kanban" });
    const colId = hex();
    await m.call("POST", "/api/v2/batch/columnProject", { add: [{ id: colId, projectId: pid, name: "Stage", sortOrder: 1 }] });
    const cp = m.store.lastSeq();
    await m.call("POST", "/api/v2/batch/project", { delete: [pid] });
    const delta = (await m.call("GET", `/api/v2/column?from=${cp}`)).json;
    expect(delta[pid]).toEqual([{ id: colId, projectId: pid, deleted: 1 }]);
  });

  test("subsequent poll at latest seq returns {} and wire ISO timestamp works for from", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call, { viewMode: "kanban" });
    const colId = hex();
    await m.call("POST", "/api/v2/batch/columnProject", { add: [{ id: colId, projectId: pid, name: "Temp", sortOrder: 1 }] });
    const beforeDeleteMs = m.store.lastSeq();
    await m.call("POST", "/api/v2/batch/columnProject", { delete: [{ id: colId, projectId: pid }] });
    const afterDeleteSeq = m.store.lastSeq();

    const isoDelta = (await m.call("GET", `/api/v2/column?from=${encodeURIComponent(isoWire(beforeDeleteMs))}`)).json;
    expect(isoDelta[pid]).toEqual([{ id: colId, projectId: pid, deleted: 1 }]);

    const emptyDelta = (await m.call("GET", `/api/v2/column?from=${afterDeleteSeq}`)).json;
    expect(emptyDelta).toEqual({});
  });

  test("re-creating a deleted column id yields only the live column without a stale deleted entry", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call, { viewMode: "kanban" });
    const colId = hex();
    await m.call("POST", "/api/v2/batch/columnProject", { add: [{ id: colId, projectId: pid, name: "First", sortOrder: 1 }] });
    const cp = m.store.lastSeq();
    await m.call("POST", "/api/v2/batch/columnProject", { delete: [{ id: colId, projectId: pid }] });
    await m.call("POST", "/api/v2/batch/columnProject", { add: [{ id: colId, projectId: pid, name: "Recreated", sortOrder: 1 }] });

    const delta = (await m.call("GET", `/api/v2/column?from=${cp}`)).json;
    expect(delta[pid]).toHaveLength(1);
    expect(delta[pid][0]).toMatchObject({ id: colId, projectId: pid, name: "Recreated" });
    expect(delta[pid][0].deleted).toBeUndefined();
  });
});

// ===================================================================== 3. countdown image upload (ATT-902)
describe("follow-up 3: countdown image upload ATT-902", () => {
  test("POST /api/v1/attachment/upload/countdown?attachmentId=<id> stores image without any task", async () => {
    const { app, port } = await listening();
    try {
      const payload = Buffer.from("fake-png-bytes-for-countdown");
      const sha = createHash("sha256").update(payload).digest("hex");
      const attId = "cdimg001";
      const up = await upload(port, `/api/v1/attachment/upload/countdown?attachmentId=${attId}`, multipartBody("cover.png", "image/png", payload));
      expect(up.status).toBe(200);
      expect(up.json).toMatchObject({
        id: attId,
        refId: attId,
        fileName: "cover.png",
        fileType: "IMAGE",
        size: payload.length,
        status: 0,
      });
      expect(up.json.path).toMatch(new RegExp(`/files/upload/.+/${attId}\\.png$`));

      const dl = await downloadHash(port, `/api/v1/attachment/${attId}`);
      expect(dl.status).toBe(200);
      expect(dl.sha).toBe(sha);
      expect(dl.headers["content-type"]).toBe("image/png");
    } finally {
      await app.close();
    }
  });

  test("omitting or passing empty ?attachmentId mints an id automatically", async () => {
    const { app, port } = await listening();
    try {
      const payload = Buffer.from("hello-webp");
      const r1 = await upload(port, "/api/v1/attachment/upload/countdown", multipartBody("bg.webp", "image/webp", payload));
      expect(r1.status).toBe(200);
      expect(typeof r1.json.id).toBe("string");
      expect(r1.json.id.length).toBeGreaterThan(0);

      const r2 = await upload(port, "/api/v1/attachment/upload/countdown?attachmentId=", multipartBody("bg2.webp", "image/webp", payload));
      expect(r2.status).toBe(200);
      expect(typeof r2.json.id).toBe("string");
      expect(r2.json.id).not.toBe(r1.json.id);

      const dl = await downloadHash(port, r1.json.path);
      expect(dl.status).toBe(200);
      expect(dl.bytes).toBe(payload.length);
    } finally {
      await app.close();
    }
  });

  test("rejects invalid attachmentId (400) and missing multipart file (400)", async () => {
    const { app, port, call } = await listening();
    try {
      const bad = await upload(port, "/api/v1/attachment/upload/countdown?attachmentId=../escape", multipartBody("x.png", "image/png", Buffer.from("a")));
      expect(bad.status).toBe(400);

      const noFile = await upload(
        port,
        "/api/v1/attachment/upload/countdown?attachmentId=valid1",
        Readable.from([Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${BOUNDARY}--\r\n`)]),
      );
      expect(noFile.status).toBe(400);

      const nonMultipart = await call("POST", "/api/v1/attachment/upload/countdown?attachmentId=valid1", {});
      expect(nonMultipart.status).toBe(406);
    } finally {
      await app.close();
    }
  });

  test("streams >12 MB countdown image with exact SHA-256 verification", async () => {
    const { app, port } = await listening();
    try {
      const size = 12 * 1024 * 1024 + 777;
      const g = generated(size);
      const up = await upload(port, "/api/v1/attachment/upload/countdown?attachmentId=largecd1", multipartBody("big.jpg", "image/jpeg", g.stream));
      expect(up.status).toBe(200);
      expect(up.json.size).toBe(size);

      const dl = await downloadHash(port, "/api/v1/attachment/largecd1");
      expect(dl.status).toBe(200);
      expect(dl.bytes).toBe(size);
      expect(dl.sha).toBe(g.sha());
    } finally {
      await app.close();
    }
  });

  test("overwriting same attachmentId replaces stored bytes cleanly", async () => {
    const { app, port } = await listening();
    try {
      await upload(port, "/api/v1/attachment/upload/countdown?attachmentId=sameid1", multipartBody("v1.png", "image/png", Buffer.from("first")));
      const second = Buffer.from("second-image-content");
      const sha2 = createHash("sha256").update(second).digest("hex");
      const r2 = await upload(port, "/api/v1/attachment/upload/countdown?attachmentId=sameid1", multipartBody("v2.png", "image/png", second));
      expect(r2.status).toBe(200);
      expect(r2.json.size).toBe(second.length);

      const dl = await downloadHash(port, "/api/v1/attachment/sameid1");
      expect(dl.status).toBe(200);
      expect(dl.sha).toBe(sha2);
    } finally {
      await app.close();
    }
  });

  test("DELETE /api/v1/attachment/:id removes countdown attachment cleanly", async () => {
    const { app, port, call } = await listening();
    try {
      const up = await upload(port, "/api/v1/attachment/upload/countdown?attachmentId=delcd1", multipartBody("rm.png", "image/png", Buffer.from("bye")));
      expect(up.status).toBe(200);

      const del = await call("DELETE", "/api/v1/attachment/delcd1");
      expect(del.status).toBe(200);
      const after = await downloadHash(port, "/api/v1/attachment/delcd1");
      expect(after.status).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ===================================================================== 4. habit & focus CSV exports (IMP-022/023)
describe("follow-up 4: habit and focus CSV export routes", () => {
  test("empty database returns valid CSV headers for habits and pomodoro exports", async () => {
    const m = await mk4();
    const hRes = await m.app.inject({ method: "GET", url: "/api/v2/data/export/habits?format=csv" });
    expect(hRes.statusCode).toBe(200);
    expect(hRes.headers["content-type"]).toContain("text/csv");
    expect(hRes.headers["content-disposition"]).toContain("habits.csv");
    expect(hRes.body.trim()).toBe("Habit Id,Habit Name,Type,Goal,Unit,Date,Status,Value,Note,Mood,Checkin Time");

    const pRes = await m.app.inject({ method: "GET", url: "/api/v2/data/export/pomodoro" });
    expect(pRes.statusCode).toBe(200);
    expect(pRes.headers["content-type"]).toContain("text/csv");
    expect(pRes.headers["content-disposition"]).toContain("pomodoro.csv");
    expect(pRes.body.trim()).toBe("Id,Type,Start Time,End Time,Duration (min),Pause Duration (sec),Adjust Time (sec),Bindings,Note");
  });

  test("habits export honors case-insensitive ?format=CSV and Accept: text/csv while defaulting to xlsx", async () => {
    const m = await mk4();
    const xlsxRes = await m.app.inject({ method: "GET", url: "/api/v2/data/export/habits" });
    expect(xlsxRes.statusCode).toBe(200);
    expect(xlsxRes.headers["content-type"]).toContain("spreadsheetml");

    const upper = await m.app.inject({ method: "GET", url: "/api/v2/data/export/habits?format=CSV" });
    expect(upper.statusCode).toBe(200);
    expect(upper.headers["content-type"]).toContain("text/csv");

    const accept = await m.app.inject({ method: "GET", url: "/api/v2/data/export/habits", headers: { accept: "text/csv, */*" } });
    expect(accept.statusCode).toBe(200);
    expect(accept.headers["content-type"]).toContain("text/csv");
  });

  test("habits CSV escapes commas/quotes properly and supports emoji fallback when mood is absent", async () => {
    const m = await mk4();
    const h = await addHabit(m, { name: 'Read, "Focus"', type: "Real", goal: 30, unit: "Min" });
    await checkIn(m, h.id, 20261115, { status: 2, value: 25, checkinTime: "2026-11-15T09:00:00.000+0000" });
    const recRes = await m.call("POST", "/api/v2/habitRecords", {
      add: [{ id: id("r"), habitId: h.id, checkinStamp: 20261115, content: 'Felt "great", steady', emoji: "smile" }],
    });
    expect(recRes.json.id2error).toEqual({});

    const csv = (await m.app.inject({ method: "GET", url: "/api/v2/data/export/habits?format=csv" })).body;
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"Read, ""Focus"""');
    expect(lines[1]).toContain('"Felt ""great"", steady",smile,');
  });

  test("pomodoro CSV exports both Pomodoro and Timing rows with active duration and joined bindings", async () => {
    const m = await mk4();
    const start1 = T0 - 3600_000;
    const start2 = T0 - 7200_000;
    await m.call("POST", "/api/v2/batch/pomodoro", {
      add: [{ id: id("p"), startTime: start1, endTime: start1 + 30 * 60_000, pauseDuration: 300, adjustTime: 60, tasks: [{ taskId: "t1", title: "Write spec" }], note: "sprint" }],
    });
    await m.call("POST", "/api/v2/batch/pomodoro/timing", {
      add: [{ id: id("p"), startTime: start2, endTime: start2 + 45 * 60_000, pauseDuration: 0, tasks: [{ timerId: "tm1", timerName: "Reading" }, { taskId: "t2", title: "Review" }], note: "deep" }],
    });

    const csv = (await m.app.inject({ method: "GET", url: "/api/v2/data/export/pomodoro?format=CSV" })).body;
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",Timing,");
    expect(lines[1]).toContain(",45,0,0,Reading; Review,deep");
    expect(lines[2]).toContain(",Pomodoro,");
    // 30 min - 300s (5m) + 60s (1m) = 26 min
    expect(lines[2]).toContain(",26,300,60,Write spec,sprint");
  });
});

// ===================================================================== 5. focusSummaries estimates (FOC-017)
describe("follow-up 5: task focusSummaries client estimates vs server counted parts", () => {
  test("creating task with estimates persists estimates while setting server counted parts to 0", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({
      projectId: pid,
      focusSummaries: [{ estimatedPomo: 4, estimatedDuration: 100 }],
    });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });

    const saved = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(saved.focusSummaries).toEqual([
      {
        userId: m.svc.userId,
        estimatedPomo: 4,
        estimatedDuration: 100,
        pomoCount: 0,
        pomoDuration: 0,
        stopwatchDuration: 0,
        focuses: [],
      },
    ]);
  });

  test("forged counted fields and forged userId on task add are stripped/zeroed by server", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({
      projectId: pid,
      focusSummaries: [
        {
          userId: "attacker",
          estimatedPomo: 2,
          estimatedDuration: 50,
          pomoCount: 99,
          pomoDuration: 999,
          stopwatchDuration: 888,
          focuses: [["fake", 1, 25]],
        },
      ],
    });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    const saved = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(saved.focusSummaries[0]).toEqual({
      userId: m.svc.userId,
      estimatedPomo: 2,
      estimatedDuration: 50,
      pomoCount: 0,
      pomoDuration: 0,
      stopwatchDuration: 0,
      focuses: [],
    });
  });

  test("ordinary task update omitting focusSummaries keeps both estimates and server counted parts", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({ projectId: pid, focusSummaries: [{ estimatedPomo: 3, estimatedDuration: 75 }] });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    await m.call("POST", "/api/v2/batch/pomodoro", {
      add: [{ id: id("p"), startTime: T0 - 3600_000, endTime: T0 - 3600_000 + 25 * 60_000, pauseDuration: 0, tasks: [{ taskId: t.id, title: t.title }] }],
    });

    await m.call("POST", "/api/v2/batch/task", { update: [{ id: t.id, projectId: pid, title: "Updated Title" }] });
    const saved = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(saved.title).toBe("Updated Title");
    expect(saved.focusSummaries[0]).toMatchObject({
      estimatedPomo: 3,
      estimatedDuration: 75,
      pomoCount: 1,
      pomoDuration: 25,
      stopwatchDuration: 0,
    });
    expect(saved.focusSummaries[0].focuses).toHaveLength(1);
  });

  test("updating estimates on task overwrites estimates while keeping server counted parts and rejecting forged counts", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({ projectId: pid, focusSummaries: [{ estimatedPomo: 1, estimatedDuration: 25 }] });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    await m.call("POST", "/api/v2/batch/pomodoro", {
      add: [{ id: id("p"), startTime: T0 - 3600_000, endTime: T0 - 3600_000 + 25 * 60_000, pauseDuration: 0, tasks: [{ taskId: t.id }] }],
    });
    await m.call("POST", "/api/v2/batch/pomodoro/timing", {
      add: [{ id: id("p"), startTime: T0 - 7200_000, endTime: T0 - 7200_000 + 40 * 60_000, pauseDuration: 0, tasks: [{ taskId: t.id }] }],
    });

    await m.call("POST", "/api/v2/batch/task", {
      update: [
        {
          id: t.id,
          projectId: pid,
          title: t.title,
          focusSummaries: [{ estimatedPomo: 5, estimatedDuration: 150, pomoCount: 999, pomoDuration: 0, stopwatchDuration: 0, focuses: [] }],
        },
      ],
    });
    const saved = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(saved.focusSummaries[0]).toMatchObject({
      userId: m.svc.userId,
      estimatedPomo: 5,
      estimatedDuration: 150,
      pomoCount: 1,
      pomoDuration: 25,
      stopwatchDuration: 40,
    });
    expect(saved.focusSummaries[0].focuses).toHaveLength(2);
  });

  test("recording focus sessions after setting estimates merges counted stats with preserved estimates", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({ projectId: pid });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    await m.call("POST", "/api/v2/batch/task", {
      update: [{ id: t.id, projectId: pid, title: t.title, focusSummaries: [{ estimatedPomo: 2, estimatedDuration: 50 }] }],
    });
    await m.call("POST", "/api/v2/batch/pomodoro", {
      add: [{ id: id("p"), startTime: T0 - 3600_000, endTime: T0 - 3600_000 + 25 * 60_000, pauseDuration: 0, tasks: [{ taskId: t.id }] }],
    });

    const saved = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(saved.focusSummaries[0]).toMatchObject({
      estimatedPomo: 2,
      estimatedDuration: 50,
      pomoCount: 1,
      pomoDuration: 25,
    });
  });

  test("deleting all focus records preserves focusSummaries when estimates remain non-zero, and removes when estimates are zero", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({ projectId: pid, focusSummaries: [{ estimatedPomo: 3, estimatedDuration: 75 }] });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    const pidRec = id("p");
    await m.call("POST", "/api/v2/batch/pomodoro", {
      add: [{ id: pidRec, startTime: T0 - 3600_000, endTime: T0 - 3600_000 + 25 * 60_000, pauseDuration: 0, tasks: [{ taskId: t.id }] }],
    });

    await m.call("POST", "/api/v2/batch/pomodoro", { delete: [pidRec] });
    const afterDelete = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(afterDelete.focusSummaries[0]).toEqual({
      userId: m.svc.userId,
      estimatedPomo: 3,
      estimatedDuration: 75,
      pomoCount: 0,
      pomoDuration: 0,
      stopwatchDuration: 0,
      focuses: [],
    });

    // Zero estimates, then re-record and delete -> focusSummaries is cleanly omitted
    await m.call("POST", "/api/v2/batch/task", {
      update: [{ id: t.id, projectId: pid, title: t.title, focusSummaries: [{ estimatedPomo: 0, estimatedDuration: 0 }] }],
    });
    const pidRec2 = id("p");
    await m.call("POST", "/api/v2/batch/pomodoro", {
      add: [{ id: pidRec2, startTime: T0 - 1800_000, endTime: T0 - 1800_000 + 15 * 60_000, pauseDuration: 0, tasks: [{ taskId: t.id }] }],
    });
    await m.call("POST", "/api/v2/batch/pomodoro", { delete: [pidRec2] });
    expect((await m.call("GET", `/api/v2/task/${t.id}`)).json.focusSummaries).toBeUndefined();
  });

  test("clearing estimates via [] or null preserves entry when counted parts exist, and clears otherwise", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({ projectId: pid, focusSummaries: [{ estimatedPomo: 2, estimatedDuration: 50 }] });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    await m.call("POST", "/api/v2/batch/pomodoro", {
      add: [{ id: id("p"), startTime: T0 - 3600_000, endTime: T0 - 3600_000 + 20 * 60_000, pauseDuration: 0, tasks: [{ taskId: t.id }] }],
    });

    await m.call("POST", "/api/v2/batch/task", { update: [{ id: t.id, projectId: pid, title: t.title, focusSummaries: [] }] });
    const kept = (await m.call("GET", `/api/v2/task/${t.id}`)).json.focusSummaries[0];
    expect(kept).toMatchObject({ estimatedPomo: 0, estimatedDuration: 0, pomoCount: 1, pomoDuration: 20 });

    const tNoFocus = task({ projectId: pid, focusSummaries: [{ estimatedPomo: 2, estimatedDuration: 50 }] });
    await m.call("POST", "/api/v2/batch/task", { add: [tNoFocus] });
    await m.call("POST", "/api/v2/batch/task", { update: [{ id: tNoFocus.id, projectId: pid, title: tNoFocus.title, focusSummaries: null }] });
    expect((await m.call("GET", `/api/v2/task/${tNoFocus.id}`)).json.focusSummaries).toBeUndefined();
  });

  test("sanitizes negative/invalid estimates to 0 and retains unknown fields on focusSummaries[0]", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({
      projectId: pid,
      focusSummaries: [{ estimatedPomo: -3, estimatedDuration: "bad", zzNote: "keep-me" }],
    });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    const saved = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(saved.focusSummaries[0]).toMatchObject({
      estimatedPomo: 0,
      estimatedDuration: 0,
      zzNote: "keep-me",
    });

    await m.call("POST", "/api/v2/batch/task", {
      update: [{ id: t.id, projectId: pid, title: t.title, focusSummaries: [{ estimatedPomo: 2, estimatedDuration: 60 }] }],
    });
    const updated = (await m.call("GET", `/api/v2/task/${t.id}`)).json;
    expect(updated.focusSummaries[0]).toMatchObject({
      estimatedPomo: 2,
      estimatedDuration: 60,
      zzNote: "keep-me",
    });
  });
});

// ===================================================================== 6. user/ranking (ACC-019)
describe("follow-up 6: GET /api/v3/user/ranking returns 0.99", () => {
  test("empty database returns ranking: 0.99", async () => {
    const m = await mk4();
    const r = await m.call("GET", "/api/v3/user/ranking");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ranking: 0.99,
      taskCount: 0,
      projectCount: 1,
      dayCount: 0,
      completedCount: 0,
      score: 0,
      level: 1,
    });
  });

  test("populated database continues returning ranking: 0.99 alongside computed score", async () => {
    const m = await mk4();
    const pid = await seedProject(m.call);
    const t = task({ projectId: pid, status: 2, createdTime: isoWire(T0 - 86_400_000), completedTime: isoWire(T0) });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });

    const r = await m.call("GET", "/api/v3/user/ranking");
    expect(r.status).toBe(200);
    expect(r.json.ranking).toBe(0.99);
    expect(r.json.taskCount).toBe(1);
    expect(r.json.completedCount).toBe(1);
    expect(r.json.score).toBeGreaterThan(0);
  });
});
