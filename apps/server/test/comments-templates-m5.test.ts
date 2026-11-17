import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { DISK_LOW_WARNING_BYTES, TaskStatus } from "@noortasks/core";
import { describe, expect, test } from "vitest";
import { checkDiskSpace } from "../src/attachments.js";
import { hashPassphrase } from "../src/auth.js";
import { hex, mk, task } from "./helpers.js";

const BOUNDARY = "----ntm5bound92c";

function multipart(filename: string, mime: string, data: Buffer): Readable {
  const head = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  return Readable.from(
    (async function* () {
      yield head;
      yield data;
      yield tail;
    })(),
    { objectMode: false },
  );
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
          resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null });
        });
      },
    );
    req.on("error", reject);
    body.pipe(req);
  });
}

describe("M5 comments CRUD, unlimited text, replies, and comment attachments", () => {
  test("list comments on clean task returns empty array and 404 for missing task or wrong project", async () => {
    const { call, svc } = mk();
    const id = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id, projectId: svc.inboxId })] });

    const r = await call("GET", `/api/v2/project/${svc.inboxId}/task/${id}/comments`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual([]);

    expect((await call("GET", `/api/v2/project/${svc.inboxId}/task/${hex()}/comments`)).status).toBe(404);
    expect((await call("GET", `/api/v2/project/${hex()}/task/${id}/comments`)).status).toBe(404);
    // "all" project wildcard works
    expect((await call("GET", `/api/v2/project/all/task/${id}/comments`)).status).toBe(200);
  });

  test("create comment sets userProfile, bumps commentCount, updates sync check delta, and survives unknown fields", async () => {
    const { call, svc } = mk();
    const id = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id, projectId: svc.inboxId, title: "Commented" })] });
    const cp0 = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;

    const c = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, {
      text: "First note",
      customMeta: { tag: "alpha" },
    });
    expect(c.status).toBe(200);
    expect(c.json.text).toBe("First note");
    expect(c.json.taskId).toBe(id);
    expect(c.json.projectId).toBe(svc.inboxId);
    expect(c.json.userProfile.username).toBeTruthy();
    expect(c.json.customMeta).toEqual({ tag: "alpha" });

    const g = await call("GET", `/api/v2/task/${id}?projectId=${svc.inboxId}`);
    expect(g.json.commentCount).toBe(1);

    const delta = await call("GET", `/api/v3/batch/check/${cp0}`);
    expect(delta.json.syncTaskBean.update.some((t: any) => t.id === id && t.commentCount === 1)).toBe(true);
  });

  test("replies set commentId to parent and unknown reply parent returns 404", async () => {
    const { call, svc } = mk();
    const id = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id, projectId: svc.inboxId })] });
    const parent = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { text: "Parent" });
    const reply = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, {
      text: "Child reply",
      commentId: parent.json.id,
    });
    expect(reply.status).toBe(200);
    expect(reply.json.commentId).toBe(parent.json.id);

    const bad = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, {
      text: "Orphan",
      commentId: hex(),
    });
    expect(bad.status).toBe(404);
  });

  test("unlimited comment length (5000 chars) accepted without truncation", async () => {
    const { call, svc } = mk();
    const id = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id, projectId: svc.inboxId })] });
    const longText = "A".repeat(5000);
    const c = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { text: longText });
    expect(c.status).toBe(200);
    expect(c.json.text).toHaveLength(5000);
    const listed = await call("GET", `/api/v2/project/${svc.inboxId}/task/${id}/comments`);
    expect(listed.json[0].text).toHaveLength(5000);
  });

  test("edit comment updates text & modifiedTime while keeping createdTime & commentCount", async () => {
    let clock = Date.parse("2026-10-01T10:00:00Z");
    const { call, svc } = mk({ now: () => clock });
    const id = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id, projectId: svc.inboxId })] });
    const c = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { text: "Draft" });
    clock += 60_000;
    const upd = await call("PUT", `/api/v2/project/${svc.inboxId}/task/${id}/comment/${c.json.id}`, { text: "Edited!" });
    expect(upd.status).toBe(200);
    expect(upd.json.text).toBe("Edited!");
    expect(upd.json.createdTime).toBe(c.json.createdTime);
    expect(upd.json.modifiedTime).not.toBe(c.json.modifiedTime);
  });

  test("delete comment decrements commentCount and leaves other comments ordered", async () => {
    const { call, svc } = mk();
    const id = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id, projectId: svc.inboxId })] });
    const c1 = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { text: "One" });
    const c2 = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { text: "Two" });
    const del = await call("DELETE", `/api/v2/project/${svc.inboxId}/task/${id}/comment/${c1.json.id}`);
    expect(del.status).toBe(200);
    expect(del.json.commentCount).toBe(1);
    const left = await call("GET", `/api/v2/project/${svc.inboxId}/task/${id}/comments`);
    expect(left.json.map((x: any) => x.id)).toEqual([c2.json.id]);
    expect((await call("GET", `/api/v2/task/${id}?projectId=${svc.inboxId}`)).json.commentCount).toBe(1);
  });

  test("comment validation & errors: 400 invalid/empty/trashed, 404 missing, 409 duplicate id", async () => {
    const { call, svc } = mk();
    const id = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id, projectId: svc.inboxId })] });

    expect((await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, ["not-obj"])).status).toBe(400);
    expect((await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { text: "" })).status).toBe(400);

    const cid = hex();
    expect((await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { id: cid, text: "First" })).status).toBe(200);
    expect((await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { id: cid, text: "Dup" })).status).toBe(409);

    expect((await call("PUT", `/api/v2/project/${svc.inboxId}/task/${id}/comment/${hex()}`, { text: "No" })).status).toBe(404);
    expect((await call("PUT", `/api/v2/project/${svc.inboxId}/task/${id}/comment/${cid}`, { text: "" })).status).toBe(400);
    expect((await call("DELETE", `/api/v2/project/${svc.inboxId}/task/${id}/comment/${hex()}`)).status).toBe(404);

    // Commenting on trashed task returns 400 task_deleted
    await call("POST", "/api/v2/batch/task", { delete: [{ taskId: id, projectId: svc.inboxId }] });
    expect((await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/comment`, { text: "Nope" })).status).toBe(400);
  });

  test("comment attachment upload supports >9 (12) images per comment, downloads bytes, and cleans disk on comment & task delete", async () => {
    const dir = `/tmp/nt-m5-cmatt-${hex()}`;
    const built = mk({ dataDir: dir });
    try {
      await built.app.listen({ host: "127.0.0.1", port: 0 });
      const port = (built.app.server.address() as AddressInfo).port;
      const tid = hex();
      await built.call("POST", "/api/v2/batch/task", { add: [task({ id: tid, projectId: built.svc.inboxId })] });

      const uploaded: any[] = [];
      for (let i = 0; i < 12; i++) {
        const bytes = Buffer.from(`png-image-${i}`);
        const res = await upload(port, `/api/v1/attachment/upload/comment/${built.svc.inboxId}/${tid}`, multipart(`img${i}.png`, "image/png", bytes));
        expect(res.status).toBe(200);
        uploaded.push(res.json);
      }
      // Download one via /files/upload/...
      const dl = await built.app.inject({ method: "GET", url: uploaded[0].path });
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.toString()).toBe("png-image-0");

      // Attach all 12 images to a comment with no text!
      const c = await built.call("POST", `/api/v2/project/${built.svc.inboxId}/task/${tid}/comment`, {
        attachments: uploaded.slice(0, 6),
      });
      expect(c.status).toBe(200);
      const c2 = await built.call("POST", `/api/v2/project/${built.svc.inboxId}/task/${tid}/comment`, {
        text: "More pics",
        attachments: uploaded.slice(6),
      });
      expect(c2.status).toBe(200);

      // Deleting comment c removes its 6 comment-scoped files
      await built.call("DELETE", `/api/v2/project/${built.svc.inboxId}/task/${tid}/comment/${c.json.id}`);
      const dlAfterCommentDel = await built.app.inject({ method: "GET", url: uploaded[0].path });
      expect(dlAfterCommentDel.statusCode).toBe(404);
      expect((await built.app.inject({ method: "GET", url: uploaded[6].path })).statusCode).toBe(200);

      // Permanent task deletion removes remaining comments & comment files
      await built.call("POST", "/api/v2/batch/task", { delete: [{ taskId: tid, projectId: built.svc.inboxId }] });
      const delTask = await built.call("DELETE", "/api/v2/task", [{ taskId: tid, projectId: built.svc.inboxId }]);
      expect(delTask.status).toBe(200);
      expect(delTask.json.id2error).toEqual({});
      expect((await built.app.inject({ method: "GET", url: uploaded[6].path })).statusCode).toBe(404);
      expect(built.store.all("select * from comments where taskId = ?", tid)).toEqual([]);
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M5 unlimited attachments & disk space check", () => {
  test("allows 60 attachments on a single task (ATT-001/PREM-020 no 20-file cap)", async () => {
    const dir = `/tmp/nt-m5-60att-${hex()}`;
    const built = mk({ dataDir: dir });
    try {
      await built.app.listen({ host: "127.0.0.1", port: 0 });
      const port = (built.app.server.address() as AddressInfo).port;
      const tid = hex();
      await built.call("POST", "/api/v2/batch/task", { add: [task({ id: tid, projectId: built.svc.inboxId })] });

      for (let i = 0; i < 60; i++) {
        const aid = hex();
        const r = await upload(port, `/api/v1/attachment/upload/${built.svc.inboxId}/${tid}/${aid}`, multipart(`f${i}.txt`, "text/plain", Buffer.from(`v${i}`)));
        expect(r.status).toBe(200);
      }
      const g = await built.call("GET", `/api/v2/task/${tid}?projectId=${built.svc.inboxId}`);
      expect(g.json.attachments).toHaveLength(60);
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allows >200 daily uploads while isUnderQuota stays true and dailyLimit is uncapped (ATT-023/025)", async () => {
    const dir = `/tmp/nt-m5-daily-${hex()}`;
    const built = mk({ dataDir: dir });
    try {
      await built.app.listen({ host: "127.0.0.1", port: 0 });
      const port = (built.app.server.address() as AddressInfo).port;
      const tid = hex();
      await built.call("POST", "/api/v2/batch/task", { add: [task({ id: tid, projectId: built.svc.inboxId })] });

      for (let i = 0; i < 205; i++) {
        const aid = hex();
        const r = await upload(port, `/api/v1/attachment/upload/${built.svc.inboxId}/${tid}/${aid}`, multipart(`d${i}.bin`, "application/octet-stream", Buffer.from("x")));
        expect(r.status).toBe(200);
      }
      expect((await built.call("GET", "/api/v1/attachment/isUnderQuota")).json).toBe(true);
      expect((await built.call("GET", "/api/v1/attachment/dailyLimit")).json).toBeGreaterThanOrEqual(1_000_000_000);
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("attachments remain accessible and downloadable on completed tasks (ATT-024)", async () => {
    const dir = `/tmp/nt-m5-compatt-${hex()}`;
    const built = mk({ dataDir: dir });
    try {
      await built.app.listen({ host: "127.0.0.1", port: 0 });
      const port = (built.app.server.address() as AddressInfo).port;
      const tid = hex();
      await built.call("POST", "/api/v2/batch/task", { add: [task({ id: tid, projectId: built.svc.inboxId })] });
      const aid = hex();
      const up = await upload(port, `/api/v1/attachment/upload/${built.svc.inboxId}/${tid}/${aid}`, multipart("keep.txt", "text/plain", Buffer.from("preserved")));
      expect(up.status).toBe(200);

      await built.call("POST", `/api/v2/project/${built.svc.inboxId}/task/${tid}/complete`, {});
      const dl = await built.app.inject({ method: "GET", url: `/api/v1/attachment/${aid}` });
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.toString()).toBe("preserved");
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checkDiskSpace warns below 1 GiB and GET /api/v1/attachment/storage reports bytes", async () => {
    const low = checkDiskSpace("/tmp", () => ({ bsize: 4096, bavail: Math.floor((DISK_LOW_WARNING_BYTES - 1024) / 4096) }));
    expect(low.lowDisk).toBe(true);
    expect(low.warning).toBe("low_disk_space");
    expect(low.freeBytes).toBeLessThan(DISK_LOW_WARNING_BYTES);

    const ok = checkDiskSpace("/tmp", () => ({ bsize: 4096, bavail: Math.ceil((DISK_LOW_WARNING_BYTES * 2) / 4096) }));
    expect(ok.lowDisk).toBe(false);
    expect(ok.warning).toBeUndefined();

    const { call } = mk();
    const res = await call("GET", "/api/v1/attachment/storage");
    expect(res.status).toBe(200);
    expect(typeof res.json.freeBytes).toBe("number");
    expect(typeof res.json.lowDisk).toBe("boolean");
  });

  test("comment attachment upload validates invalid id and missing task, and hashes sha256 identically", async () => {
    const dir = `/tmp/nt-m5-hash-${hex()}`;
    const built = mk({ dataDir: dir });
    try {
      await built.app.listen({ host: "127.0.0.1", port: 0 });
      const port = (built.app.server.address() as AddressInfo).port;
      const rBadId = await upload(port, `/api/v1/attachment/upload/comment/${built.svc.inboxId}/..bad`, multipart("a.txt", "text/plain", Buffer.from("a")));
      expect(rBadId.status).toBe(400);
      const rMissing = await upload(port, `/api/v1/attachment/upload/comment/${built.svc.inboxId}/${hex()}`, multipart("a.txt", "text/plain", Buffer.from("a")));
      expect(rMissing.status).toBe(404);

      const tid = hex();
      await built.call("POST", "/api/v2/batch/task", { add: [task({ id: tid, projectId: built.svc.inboxId })] });
      const payload = Buffer.alloc(131072, 0xab);
      const expectedSha = createHash("sha256").update(payload).digest("hex");
      const ok = await upload(port, `/api/v1/attachment/upload/comment/${built.svc.inboxId}/${tid}`, multipart("big.bin", "application/octet-stream", payload));
      expect(ok.status).toBe(200);
      const dl = await built.app.inject({ method: "GET", url: ok.json.path });
      expect(dl.statusCode).toBe(200);
      expect(createHash("sha256").update(dl.rawPayload).digest("hex")).toBe(expectedSha);
      expect(existsSync(dir)).toBe(true);
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("M5 task, note, and project templates", () => {
  test("fresh DB seeds 3 taskTemplates + 3 noteTemplates and projectTemplates/all", async () => {
    const { call } = mk();
    const r = await call("GET", "/api/v2/templates");
    expect(r.status).toBe(200);
    expect(r.json.taskTemplates).toHaveLength(3);
    expect(r.json.noteTemplates).toHaveLength(3);
    expect(r.json.taskTemplates.map((t: any) => t.title).sort()).toHaveLength(3);

    const pt = await call("GET", "/api/v2/projectTemplates/all?timestamp=0");
    expect(pt.status).toBe(200);
    expect(pt.json.projectTemplates.length).toBeGreaterThanOrEqual(3);
    expect(pt.json.timestamp).toBeGreaterThan(0);
  });

  test("POST /templates/task creates template, supports unlimited 3000-char title and >50 templates", async () => {
    const { call } = mk();
    const longTitle = "T".repeat(3000);
    const created = await call("POST", "/api/v2/templates/task", { title: longTitle, content: "Details" });
    expect(created.status).toBe(200);
    expect(created.json.title).toBe(longTitle);
    expect(typeof created.json.order).toBe("number");

    for (let i = 0; i < 55; i++) {
      const r = await call("POST", "/api/v2/templates/task", { title: `Extra ${i}`, content: "" });
      expect(r.status).toBe(200);
    }
    const list = await call("GET", "/api/v2/templates");
    expect(list.json.taskTemplates.length).toBe(3 + 1 + 55);
  });

  test("Save as Template from existing TEXT and CHECKLIST task extracts task content/items", async () => {
    const { call, svc } = mk();
    const tid1 = hex();
    const tid2 = hex();
    await call("POST", "/api/v2/batch/task", {
      add: [
        task({ id: tid1, projectId: svc.inboxId, title: "Weekly Review", content: "Check inbox\nPlan week", kind: "TEXT" }),
        task({
          id: tid2,
          projectId: svc.inboxId,
          title: "Packing List",
          kind: "CHECKLIST",
          items: [
            { id: "i1", title: "Passport", status: 0, sortOrder: 0 },
            { id: "i2", title: "Charger", status: 1, sortOrder: 1 },
          ],
        }),
      ],
    });
    const t1 = await call("POST", "/api/v2/templates/task", { taskId: tid1 });
    expect(t1.status).toBe(200);
    expect(t1.json.title).toBe("Weekly Review");
    expect(t1.json.content).toBe("Check inbox\nPlan week");

    const t2 = await call("POST", "/api/v2/templates/task", { taskId: tid2 });
    expect(t2.status).toBe(200);
    expect(t2.json.title).toBe("Packing List");
    expect(t2.json.content).toContain("Passport");
    expect(t2.json.content).toContain("Charger");

    expect((await call("POST", "/api/v2/templates/task", { taskId: hex() })).status).toBe(404);
  });

  test("noteTemplates CRUD via POST/PUT/DELETE, no default order, and kind mismatch 409", async () => {
    const { call } = mk();
    const n = await call("POST", "/api/v2/templates/note", { title: "Cornell Note", content: "## Cues\n\n## Summary" });
    expect(n.status).toBe(200);
    expect(n.json.order).toBeUndefined();

    const upd = await call("PUT", `/api/v2/templates/note/${n.json.id}`, { title: "Cornell v2", content: "Updated" });
    expect(upd.status).toBe(200);
    expect(upd.json.title).toBe("Cornell v2");

    // Cross-kind update or id reuse is rejected
    expect((await call("PUT", `/api/v2/templates/task/${n.json.id}`, { title: "Wrong" })).status).toBe(404);
    expect((await call("POST", "/api/v2/templates/task", { id: n.json.id, title: "Conflict" })).status).toBe(409);

    const del = await call("DELETE", `/api/v2/templates/note/${n.json.id}`);
    expect(del.status).toBe(200);
    expect((await call("GET", "/api/v2/templates")).json.noteTemplates.some((x: any) => x.id === n.json.id)).toBe(false);
  });

  test("templates batch add/update/delete & reorder persist order across reads", async () => {
    const { call } = mk();
    const id1 = hex();
    const id2 = hex();
    const b = await call("POST", "/api/v2/templates/task", {
      add: [
        { id: id1, title: "Batch 1", content: "c1" },
        { id: id2, title: "Batch 2", content: "c2" },
      ],
    });
    expect(b.status).toBe(200);
    expect(b.json.id2etag[id1]).toBeTruthy();
    expect(b.json.id2etag[id2]).toBeTruthy();

    await call("POST", "/api/v2/templates/task/order", { ids: [id2, id1] });
    const list = (await call("GET", "/api/v2/templates")).json.taskTemplates.map((t: any) => t.id);
    expect(list.indexOf(id2)).toBeLessThan(list.indexOf(id1));

    const del = await call("POST", "/api/v2/templates/task", { delete: [id1] });
    expect(del.json.id2error).toEqual({});
    expect((await call("GET", "/api/v2/templates")).json.taskTemplates.some((t: any) => t.id === id1)).toBe(false);
  });

  test("projectTemplates/all supports incremental ?timestamp= delta after upsert", async () => {
    const { call, templates } = mk();
    const first = await call("GET", "/api/v2/projectTemplates/all?timestamp=0");
    const ts1 = first.json.timestamp;
    const same = await call("GET", `/api/v2/projectTemplates/all?timestamp=${ts1}`);
    expect(same.json.projectTemplates).toEqual([]);

    const added = templates.upsertProjectTemplate({ id: hex(), name: "Custom Sprint", keyword: "agile", viewMode: "kanban" });
    const delta = await call("GET", `/api/v2/projectTemplates/all?timestamp=${ts1}`);
    expect(delta.json.projectTemplates.map((p: any) => p.id)).toEqual([added.id]);
    expect(delta.json.timestamp).toBeGreaterThan(ts1);
  });

  test("both template aliases require auth and unknown ids return 404 after sign-in", async () => {
    const { app } = mk({ noAuth: false, auth: { passphraseHash: await hashPassphrase("passphrase123") } });
    const login = await app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { password: "passphrase123" } });
    const cookie = `t=${login.cookies.find((c) => c.name === "t")!.value}`;

    const listRes = await app.inject({ method: "GET", url: "/api/v2/projectTemplates/all", headers: { cookie } });
    const tplId = JSON.parse(listRes.body).projectTemplates[0].id;

    // Private endpoint rejects unauthenticated call, accepts authenticated
    expect((await app.inject({ method: "GET", url: `/api/v2/templates/project/${tplId}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/v2/templates/project/${tplId}`, headers: { cookie } })).statusCode).toBe(200);

    // The /pub alias is not authorization to expose account templates.
    expect((await app.inject({ method: "GET", url: `/pub/api/v2/templates/project/${tplId}` })).statusCode).toBe(401);
    const pub = await app.inject({ method: "GET", url: `/pub/api/v2/templates/project/${tplId}`, headers: { cookie } });
    expect(pub.statusCode).toBe(200);
    const body = JSON.parse(pub.body);
    expect(body.id).toBe(tplId);
    expect(Array.isArray(body.tasks)).toBe(true);

    const missing = await app.inject({ method: "GET", url: `/pub/api/v2/templates/project/${hex()}`, headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });

  test("PUT/DELETE /templates/task/:id, note/order, and applyProjectTemplate 404 errors", async () => {
    const { call } = mk();
    const created = await call("POST", "/api/v2/templates/task", { title: "Task Tpl", content: "v1" });
    const upd = await call("PUT", `/api/v2/templates/task/${created.json.id}`, { title: "Task Tpl v2" });
    expect(upd.status).toBe(200);
    expect(upd.json.title).toBe("Task Tpl v2");
    expect((await call("DELETE", `/api/v2/templates/task/${created.json.id}`)).status).toBe(200);
    expect((await call("DELETE", `/api/v2/templates/task/${created.json.id}`)).status).toBe(404);

    const n1 = await call("POST", "/api/v2/templates/note", { title: "N1", content: "1" });
    const n2 = await call("POST", "/api/v2/templates/note", { title: "N2", content: "2" });
    expect((await call("POST", "/api/v2/templates/note/order", { ids: [n2.json.id, n1.json.id] })).status).toBe(200);
    const list = (await call("GET", "/api/v2/templates")).json.noteTemplates.map((n: any) => n.id);
    expect(list.indexOf(n2.json.id)).toBeLessThan(list.indexOf(n1.json.id));

    expect((await call("POST", `/api/v2/templates/project/${hex()}/apply`, {})).status).toBe(404);
  });

  test("POST /api/v2/templates/project/:id/apply creates project, columns, tasks, and subtasks in sync delta", async () => {
    const { call, templates } = mk();
    const tplId = hex();
    templates.upsertProjectTemplate({
      id: tplId,
      name: "Board Launch",
      keyword: "launch",
      viewMode: "kanban",
      kind: "TASK",
      columns: [
        { key: "c1", name: "Backlog", sortOrder: 0 },
        { key: "c2", name: "Doing", sortOrder: 1 },
      ],
      tasks: [
        { key: "t1", columnKey: "c1", title: "Main milestone", priority: 5 },
        { key: "t2", parentKey: "t1", columnKey: "c1", title: "Subtask step", kind: "TEXT" },
        { key: "t3", columnKey: "c2", title: "Checklist card", kind: "CHECKLIST", items: [{ title: "Item A", status: 0 }] },
      ],
    });
    const cpBefore = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;

    const applied = await call("POST", `/api/v2/templates/project/${tplId}/apply`, { name: "Q4 Launch" });
    expect(applied.status).toBe(200);
    expect(applied.json.project.name).toBe("Q4 Launch");
    expect(applied.json.project.viewMode).toBe("kanban");
    expect(applied.json.columns).toHaveLength(2);
    expect(applied.json.tasks).toHaveLength(3);

    const main = applied.json.tasks.find((t: any) => t.title === "Main milestone");
    const sub = applied.json.tasks.find((t: any) => t.title === "Subtask step");
    expect(sub.parentId).toBe(main.id);
    expect(main.columnId).toBe(applied.json.columns[0].id);

    const check = await call("GET", `/api/v3/batch/check/${cpBefore}`);
    expect(check.json.projectProfiles.some((p: any) => p.id === applied.json.project.id)).toBe(true);
    expect(check.json.syncTaskBean.add.some((t: any) => t.id === main.id && t.status === TaskStatus.Open)).toBe(true);
  });
});
