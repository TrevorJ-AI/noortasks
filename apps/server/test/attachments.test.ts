import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterAll, describe, expect, test } from "vitest";
import { hex, mk, task } from "./helpers.js";

const BOUNDARY = "----ntboundary7d3a";

function multipartBody(filename: string, mime: string, data: Readable | Buffer): Readable {
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  async function* gen() {
    yield head;
    if (Buffer.isBuffer(data)) yield data;
    else for await (const c of data) yield c as Buffer;
    yield tail;
  }
  return Readable.from(gen(), { objectMode: false });
}

/** 64 KB chunks of pseudo-random data, never held in memory; returns a sha256 of what it emitted. */
function generated(total: number): { stream: Readable; sha: () => string } {
  const h = createHash("sha256");
  let sent = 0;
  const chunk = Buffer.alloc(65536);
  const stream = new Readable({
    read() {
      if (sent >= total) return this.push(null);
      const n = Math.min(chunk.length, total - sent);
      for (let i = 0; i < n; i += 4) chunk.writeUInt32LE((sent + i) * 2654435761 >>> 0, i);
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
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => {
        const text = Buffer.concat(parts).toString();
        resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    body.pipe(req);
  });
}

function downloadHash(port: number, path: string): Promise<{ status: number; sha: string; bytes: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path }, (res) => {
      const h = createHash("sha256");
      let bytes = 0;
      res.on("data", (c: Buffer) => { h.update(c); bytes += c.length; });
      res.on("end", () => resolve({ status: res.statusCode!, sha: h.digest("hex"), bytes, headers: res.headers }));
    }).on("error", reject);
  });
}

async function listening() {
  const m = mk();
  await m.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (m.app.server.address() as AddressInfo).port;
  const t = task({ projectId: m.svc.inboxId });
  await m.call("POST", "/api/v2/batch/task", { add: [t] });
  return { ...m, port, t, dir: m.svc.opts.dataDir! };
}

const toClean: string[] = [];
afterAll(() => toClean.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("attachments", () => {
  test("small round trip: upload, task shows it, download is byte-identical", async () => {
    const s = await listening();
    toClean.push(s.dir);
    const data = Buffer.from("hello attachment é");
    const id = hex();
    const r = await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${id}`, multipartBody("note.txt", "text/plain", data));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, refId: id, fileName: "note.txt", fileType: "OTHER", size: data.length, status: 0 });
    const task = (await s.call("GET", `/api/v2/task/${s.t.id}`)).json;
    expect(task.attachments).toHaveLength(1);
    expect(task.attachments[0].path).toMatch(/^\/files\/upload\//);
    const d = await downloadHash(s.port, `/api/v1/attachment/${id}?action=download`);
    expect(d.status).toBe(200);
    expect(d.sha).toBe(createHash("sha256").update(data).digest("hex"));
    expect(d.headers["content-disposition"]).toContain("note.txt");
    const byPath = await downloadHash(s.port, task.attachments[0].path);
    expect(byPath.sha).toBe(d.sha);
    await s.app.close();
  });
  test("images are typed IMAGE", async () => {
    const s = await listening();
    toClean.push(s.dir);
    const id = hex();
    const r = await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${id}`, multipartBody("pic.png", "image/png", Buffer.from([1, 2, 3])));
    expect(r.json.fileType).toBe("IMAGE");
    await s.app.close();
  });
  test("upload bumps the task etag so other clients pull it", async () => {
    const s = await listening();
    toClean.push(s.dir);
    const before = (await s.call("GET", "/api/v3/batch/check/0")).json;
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${hex()}`, multipartBody("a.bin", "application/octet-stream", Buffer.from("x")));
    const d = (await s.call("GET", `/api/v3/batch/check/${before.checkPoint}`)).json.syncTaskBean;
    expect(d.update.map((t: any) => t.id)).toEqual([s.t.id]);
    await s.app.close();
  });
  test("upload to an unknown task is 404; unsafe ids are 400", async () => {
    const s = await listening();
    toClean.push(s.dir);
    expect((await upload(s.port, `/api/v1/attachment/upload/p/${hex()}/${hex()}`, multipartBody("a", "text/plain", Buffer.from("x")))).status).toBe(404);
    expect((await upload(s.port, `/api/v1/attachment/upload/p/${s.t.id}/..%2F..%2Fevil`, multipartBody("a", "text/plain", Buffer.from("x")))).status).toBe(400);
    await s.app.close();
  });
  test("download of an unknown id is 404", async () => {
    const m = mk();
    expect((await m.call("GET", "/api/v1/attachment/nope?action=download")).status).toBe(404);
  });
  test("delete removes the row, the task entry and the file", async () => {
    const s = await listening();
    toClean.push(s.dir);
    const id = hex();
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${id}`, multipartBody("a.txt", "text/plain", Buffer.from("bye")));
    const file = s.store.get<{ file: string }>("select file from attachments where id = ?", id)!.file;
    expect(existsSync(file)).toBe(true);
    expect((await s.call("DELETE", `/api/v1/attachment/${id}`)).status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await s.call("GET", `/api/v2/task/${s.t.id}`)).json.attachments).toEqual([]);
    expect((await s.call("DELETE", `/api/v1/attachment/${id}`)).status).toBe(404);
    await s.app.close();
  });
  test("metadata through batch/task: add, update, delete; bytes stay pending until uploaded", async () => {
    const m = mk();
    const t = task({ projectId: m.svc.inboxId });
    await m.call("POST", "/api/v2/batch/task", { add: [t] });
    const att = { id: hex(), fileName: "x.pdf", fileType: "OTHER", size: 5, path: "/files/upload/1/202611/x.pdf" };
    const a = await m.call("POST", "/api/v2/batch/task", { addAttachments: [{ ...t, attachments: [att] }] });
    expect(a.json.id2etag[t.id]).toBeTruthy();
    expect((await m.call("GET", `/api/v2/task/${t.id}`)).json.attachments[0]).toMatchObject({ id: att.id, refId: att.id, status: 0 });
    expect((await m.call("GET", `/api/v1/attachment/${att.id}?action=download`)).json.errorCode).toBe("attachment_not_uploaded");
    await m.call("POST", "/api/v2/batch/task", { updateAttachments: [{ ...t, attachments: [{ ...att, fileName: "y.pdf" }] }] });
    expect((await m.call("GET", `/api/v2/task/${t.id}`)).json.attachments[0].fileName).toBe("y.pdf");
    await m.call("POST", "/api/v2/batch/task", { deleteAttachments: [{ ...t, attachments: [att] }] });
    expect((await m.call("GET", `/api/v2/task/${t.id}`)).json.attachments).toEqual([]);
    const ghost = hex();
    expect((await m.call("POST", "/api/v2/batch/task", { addAttachments: [{ id: ghost, attachments: [att] }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("deleting a task for good removes its attachment files", async () => {
    const s = await listening();
    toClean.push(s.dir);
    const id = hex();
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${id}`, multipartBody("a.txt", "text/plain", Buffer.from("zzz")));
    const file = s.store.get<{ file: string }>("select file from attachments where id = ?", id)!.file;
    await s.call("DELETE", "/api/v2/task?deleteforever=true", [{ taskId: s.t.id }]);
    expect(existsSync(file)).toBe(false);
    await s.app.close();
  });

  test("50 MB streams through without buffering: RSS growth stays under 80 MB, bytes identical", async () => {
    const s = await listening();
    toClean.push(s.dir);
    const SIZE = 50 * 1024 * 1024;
    const id = hex();
    // warm the upload path, then settle the heap so the baseline is honest
    await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${hex()}`, multipartBody("warm.bin", "application/octet-stream", Buffer.alloc(1024)));
    global.gc?.();
    await new Promise((r) => setTimeout(r, 200));
    const base = process.memoryUsage().rss;
    let peak = base;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    const gen = generated(SIZE);
    const up = await upload(s.port, `/api/v1/attachment/upload/${s.t.projectId}/${s.t.id}/${id}`, multipartBody("big.bin", "application/octet-stream", gen.stream));
    const upPeak = peak - base;
    expect(up.status).toBe(200);
    expect(up.json.size).toBe(SIZE);
    const d = await downloadHash(s.port, `/api/v1/attachment/${id}?action=download`);
    clearInterval(timer);
    const growth = peak - base;
    expect(d.status).toBe(200);
    expect(d.bytes).toBe(SIZE);
    expect(d.sha).toBe(gen.sha());
    expect(Number(d.headers["content-length"])).toBe(SIZE);
    console.log(`50MB round trip: upload RSS growth ${(upPeak / 1048576).toFixed(1)} MB, whole round trip ${(growth / 1048576).toFixed(1)} MB`);
    expect(growth).toBeLessThan(80 * 1048576);
    const file = s.store.get<{ file: string }>("select file from attachments where id = ?", id)!.file;
    expect(statSync(file).size).toBe(SIZE);
    await s.app.close();
    rmSync(s.dir, { recursive: true, force: true });
    expect(existsSync(file)).toBe(false);
    void readdirSync;
  }, 120_000);
});
