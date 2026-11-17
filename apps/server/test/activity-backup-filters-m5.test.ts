import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { ActivityAction, ORDER_MAX, Priority, TaskStatus, evaluateRule, type RuleTask } from "@noortasks/core";
import { afterAll, describe, expect, test } from "vitest";
import { hashPassphrase } from "../src/auth.js";
import { BACKUP_CSV_HEADER, buildXlsx, parseCsv, serializeCsv } from "../src/backup.js";
import { exportBackup, importBackup } from "../src/importExport.js";
import { hex, mk, seedProject, task } from "./helpers.js";

const cleanDirs: string[] = [];
afterAll(() => {
  for (const d of cleanDirs) rmSync(d, { recursive: true, force: true });
});

function freshDir() {
  const d = mkdtempSync(join(tmpdir(), "nt-m5-abf-"));
  cleanDirs.push(d);
  return d;
}

function unzipEntries(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos + 30 <= buf.length && buf.readUInt32LE(pos) === 0x04034b50) {
    const sum = buf.readUInt32LE(pos + 14);
    const compSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const nameStart = pos + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const name = buf.subarray(nameStart, nameStart + nameLen).toString("utf8");
    const data = buf.subarray(dataStart, dataStart + compSize);
    expect(crc32(data) >>> 0).toBe(sum);
    out[name] = data.toString("utf8");
    pos = dataStart + compSize;
  }
  return out;
}

function makeEnv() {
  const env = mk();
  const addTasks = async (rows: Array<Record<string, unknown>>) => {
    const res = await env.call("POST", "/api/v2/batch/task", {
      add: rows.map((r) => task({ projectId: env.svc.inboxId, ...r })),
    });
    expect(res.status).toBe(200);
    expect(res.json.id2error).toEqual({});
    return res;
  };
  return { ...env, addTasks };
}

describe("M5 activity log: mutation recording and query routes", () => {
  test("task creation records T_CREATE", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    await addTasks([{ id: tid, title: "Brand new" }]);
    const acts = await call("GET", `/api/v1/task/activity/${tid}`);
    expect(acts.status).toBe(200);
    expect(acts.json.map((a: any) => a.action)).toEqual([ActivityAction.Create]);
    expect(acts.json[0].projectId).toBe(svc.inboxId);
  });

  test("status transitions record T_COMPLETE, T_WONTDO, and T_REOPEN", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    const base = { id: tid, projectId: svc.inboxId, title: "Status flow" };
    await addTasks([base]);
    await call("POST", "/api/v2/batch/task", { update: [{ ...base, status: TaskStatus.Completed }] });
    await call("POST", "/api/v2/batch/task", { update: [{ ...base, status: TaskStatus.WontDo }] });
    await call("POST", "/api/v2/batch/task", { update: [{ ...base, status: TaskStatus.Open }] });
    const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.map((a: any) => a.action);
    expect(acts).toEqual([ActivityAction.Reopen, ActivityAction.WontDo, ActivityAction.Complete, ActivityAction.Create]);
  });

  test("title and content changes record T_TITLE and T_CONTENT", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    const base = { id: tid, projectId: svc.inboxId, title: "Old title", content: "Old body" };
    await addTasks([base]);
    await call("POST", "/api/v2/batch/task", { update: [{ ...base, title: "New title", content: "New body" }] });
    const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.map((a: any) => a.action);
    expect(acts).toContain(ActivityAction.Title);
    expect(acts).toContain(ActivityAction.Content);
  });

  test("dueDate and priority changes record T_DUE and T_PRIORITY", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    const base = { id: tid, projectId: svc.inboxId, title: "Sched", priority: 0 };
    await addTasks([base]);
    await call("POST", "/api/v2/batch/task", {
      update: [{ ...base, dueDate: "2026-12-01T10:00:00.000+0000", priority: Priority.High }],
    });
    const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.map((a: any) => a.action);
    expect(acts).toContain(ActivityAction.Due);
    expect(acts).toContain(ActivityAction.Priority);
  });

  test("tag changes and tag rename record T_TAG", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    const base = { id: tid, projectId: svc.inboxId, title: "Tagged", tags: [] as string[] };
    await addTasks([base]);
    await call("POST", "/api/v2/batch/tag", { add: [{ name: "work", label: "work" }] });
    await call("POST", "/api/v2/batch/task", { update: [{ ...base, tags: ["work"] }] });
    await call("PUT", "/api/v2/tag/rename", { name: "work", newName: "office" });
    const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.filter((a: any) => a.action === ActivityAction.Tag);
    expect(acts).toHaveLength(2);
  });

  test("reminders, snooze delay, and repeatFlag changes record T_REMINDER and T_REPEAT", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    const base = { id: tid, projectId: svc.inboxId, title: "Nag", startDate: "2026-12-01T10:00:00.000+0000" };
    await addTasks([base]);
    await call("POST", "/api/v2/batch/task", {
      update: [{ ...base, reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }], repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1" }],
    });
    await call("POST", "/api/v2/reminder/delay", { taskId: tid, delayMinutes: 10 });
    const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.map((a: any) => a.action);
    expect(acts.filter((x: string) => x === ActivityAction.Reminder)).toHaveLength(2);
    expect(acts).toContain(ActivityAction.Repeat);
  });

  test("checklist items, column, assignee, and pin changes record T_ITEMS, T_COLUMN, T_ASSIGN, T_PIN", async () => {
    const { call, addTasks } = makeEnv();
    const pid = await seedProject(call, { viewMode: "kanban" });
    const cid = hex();
    await call("POST", "/api/v2/batch/columnProject", { add: [{ id: cid, projectId: pid, name: "ColA", sortOrder: 0 }] });
    const tid = hex();
    const base = { id: tid, projectId: pid, title: "Board card", kind: "CHECKLIST", items: [] as any[] };
    await addTasks([base]);
    await call("POST", "/api/v2/batch/task", {
      update: [
        {
          ...base,
          items: [{ id: "i1", title: "Step 1", status: 0, sortOrder: 0 }],
          columnId: cid,
          assignee: 42,
          pinnedTime: "2026-12-01T10:00:00.000+0000",
        },
      ],
    });
    const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.map((a: any) => a.action);
    expect(acts).toEqual(expect.arrayContaining([ActivityAction.Items, ActivityAction.Column, ActivityAction.Assign, ActivityAction.Pin]));
  });

  test("move, reparent, trash, and restore record T_MOVE, T_PARENT, T_TRASH, T_RESTORE", async () => {
    const { call, svc, addTasks } = makeEnv();
    const p2 = await seedProject(call, { name: "Dest" });
    const parentId = hex();
    const childId = hex();
    await addTasks([{ id: parentId, title: "Parent" }, { id: childId, title: "Child" }]);

    await call("POST", "/api/v2/batch/taskParent", [{ taskId: childId, projectId: svc.inboxId, parentId }]);
    await call("POST", "/api/v2/batch/taskProject", [{ taskId: parentId, fromProjectId: svc.inboxId, toProjectId: p2 }]);
    await call("POST", "/api/v2/batch/task", { delete: [{ taskId: childId, projectId: svc.inboxId }] });
    await call("POST", "/api/v2/trash/restore", [{ taskId: childId, projectId: svc.inboxId }]);

    const childActs = (await call("GET", `/api/v1/task/activity/${childId}`)).json.map((a: any) => a.action);
    expect(childActs).toEqual(expect.arrayContaining([ActivityAction.Parent, ActivityAction.Trash, ActivityAction.Restore]));

    const parentActs = (await call("GET", `/api/v1/task/activity/${parentId}`)).json.map((a: any) => a.action);
    expect(parentActs).toContain(ActivityAction.Move);
  });

  test("attachment add and delete record T_ATTACH_ADD and T_ATTACH_DEL", async () => {
    const { app, call, svc, addTasks } = makeEnv();
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const port = (app.server.address() as AddressInfo).port;
      const tid = hex();
      await addTasks([{ id: tid, title: "With file" }]);
      const aid = hex();
      const boundary = "----actatt7b";
      const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="doc.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`);
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port, path: `/api/v1/attachment/upload/${svc.inboxId}/${tid}/${aid}`, method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` } },
          (res) => { res.resume(); res.on("end", () => resolve()); },
        );
        req.on("error", reject);
        req.end(payload);
      });
      await call("DELETE", `/api/v1/attachment/${aid}`);
      const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.map((a: any) => a.action);
      expect(acts).toContain(ActivityAction.AttachAdd);
      expect(acts).toContain(ActivityAction.AttachDel);
    } finally {
      await app.close();
    }
  });

  test("comment add/edit/delete record T_COMMENT_ADD, T_COMMENT_EDIT, T_COMMENT_DEL", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    await addTasks([{ id: tid, title: "Chat" }]);
    const c = await call("POST", `/api/v2/project/${svc.inboxId}/task/${tid}/comment`, { text: "Hello" });
    await call("PUT", `/api/v2/project/${svc.inboxId}/task/${tid}/comment/${c.json.id}`, { text: "Updated" });
    await call("DELETE", `/api/v2/project/${svc.inboxId}/task/${tid}/comment/${c.json.id}`);
    const acts = (await call("GET", `/api/v1/task/activity/${tid}`)).json.map((a: any) => a.action);
    expect(acts).toEqual([ActivityAction.CommentDel, ActivityAction.CommentEdit, ActivityAction.CommentAdd, ActivityAction.Create]);
  });

  test("project and column mutations record P_CREATE/UPDATE/DELETE and COL_CREATE/UPDATE/DELETE", async () => {
    const { call } = makeEnv();
    const pid = hex();
    const cid = hex();
    await call("POST", "/api/v2/batch/project", { add: [{ id: pid, name: "Alpha" }] });
    await call("POST", "/api/v2/batch/project", { update: [{ id: pid, name: "Alpha 2" }] });
    await call("POST", "/api/v2/batch/columnProject", { add: [{ id: cid, projectId: pid, name: "Col", sortOrder: 0 }] });
    await call("POST", "/api/v2/batch/columnProject", { update: [{ id: cid, projectId: pid, name: "Col 2", sortOrder: 0 }] });
    await call("POST", "/api/v2/batch/columnProject", { delete: [{ projectId: pid, columnId: cid }] });
    await call("POST", "/api/v2/batch/project", { delete: [pid] });

    const acts = (await call("GET", `/api/v1/project/${pid}/activity`)).json.map((a: any) => a.action);
    expect(acts).toEqual([
      ActivityAction.ProjectDelete,
      ActivityAction.ColumnDelete,
      ActivityAction.ColumnUpdate,
      ActivityAction.ColumnCreate,
      ActivityAction.ProjectUpdate,
      ActivityAction.ProjectCreate,
    ]);
  });

  test("task/project activity endpoints paginate newest-first with limit and offset", async () => {
    let clock = Date.parse("2026-12-01T10:00:00Z");
    const { call, svc } = mk({ now: () => clock });
    const tid = hex();
    await call("POST", "/api/v2/batch/task", { add: [task({ id: tid, projectId: svc.inboxId, title: "A" })] });
    for (let i = 1; i <= 4; i++) {
      clock += 10_000;
      await call("POST", "/api/v2/batch/task", { update: [task({ id: tid, projectId: svc.inboxId, title: `T${i}` })] });
    }
    const page1 = await call("GET", `/api/v1/task/activity/${tid}?limit=2&offset=0`);
    const page2 = await call("GET", `/api/v1/task/activity/${tid}?limit=2&offset=2`);
    expect(page1.json).toHaveLength(2);
    expect(page2.json).toHaveLength(2);
    expect(page1.json[0].newValue).toBe("T4");
    expect(page2.json[0].newValue).toBe("T2");
  });

  test("POST /api/v2/task/activity/count/all supports global count, action filter, and per-task counts", async () => {
    const { call, svc, addTasks } = makeEnv();
    const t1 = hex();
    const t2 = hex();
    await addTasks([{ id: t1, title: "One" }, { id: t2, title: "Two" }]);
    await call("POST", "/api/v2/batch/task", { update: [task({ id: t1, projectId: svc.inboxId, title: "One-B" })] });

    const c = await call("POST", "/api/v2/task/activity/count/all", { projectId: svc.inboxId, taskIds: [t1, t2] });
    expect(c.status).toBe(200);
    expect(c.json.count).toBe(3);
    expect(c.json.counts).toEqual({ [t1]: 2, [t2]: 1 });

    const onlyTitle = await call("POST", "/api/v2/task/activity/count/all", { action: ActivityAction.Title });
    expect(onlyTitle.json.count).toBe(1);
  });

  test("activity routes return 404/400 on unknown task, unknown project, or invalid count body", async () => {
    const { call } = makeEnv();
    expect((await call("GET", `/api/v1/task/activity/${hex()}`)).status).toBe(404);
    expect((await call("GET", `/api/v1/project/${hex()}/activity`)).status).toBe(404);
    expect((await call("POST", "/api/v2/task/activity/count/all", [1, 2])).status).toBe(400);
  });
});

describe("M5 custom filters, filterRule extensions, and /api/v2/search/all", () => {
  test("batch/filter allows >30 unlimited custom filters (PREM-094) and returns them on check/0", async () => {
    const { call } = makeEnv();
    const add = Array.from({ length: 35 }, (_, i) => ({
      id: hex(),
      name: `Filter ${i}`,
      rule: JSON.stringify({ and: [{ conditionName: "priority", conditionType: 1, or: [5] }], type: 0, version: 1 }),
      sortOrder: i,
    }));
    const r = await call("POST", "/api/v2/batch/filter", { add });
    expect(r.status).toBe(200);
    expect(r.json.id2error).toEqual({});
    const chk = await call("GET", "/api/v3/batch/check/0");
    expect(chk.json.filters).toHaveLength(35);
  });

  test("batch/filter incremental check/cp returns updates and deletedFilters tombstones", async () => {
    const { call } = makeEnv();
    const fid = hex();
    await call("POST", "/api/v2/batch/filter", { add: [{ id: fid, name: "High", rule: "priority:5" }] });
    const cp1 = (await call("GET", "/api/v3/batch/check/0")).json.checkPoint;

    await call("POST", "/api/v2/batch/filter", { update: [{ id: fid, name: "High Updated", rule: "priority:3,5" }] });
    const d1 = await call("GET", `/api/v3/batch/check/${cp1}`);
    expect(d1.json.filters).toHaveLength(1);
    expect(d1.json.filters[0].name).toBe("High Updated");
    const cp2 = d1.json.checkPoint;

    await call("POST", "/api/v2/batch/filter", { delete: [fid] });
    const d2 = await call("GET", `/api/v3/batch/check/${cp2}`);
    expect(d2.json.deletedFilters).toContain(fid);
  });

  test("batch/filter handles duplicate add (EXISTED) and missing update (NOT_EXISTED)", async () => {
    const { call } = makeEnv();
    const fid = hex();
    await call("POST", "/api/v2/batch/filter", { add: [{ id: fid, name: "One", rule: "" }] });
    const dup = await call("POST", "/api/v2/batch/filter", { add: [{ id: fid, name: "Dup", rule: "" }] });
    expect(dup.json.id2error[fid]).toBe("EXISTED");
    const miss = await call("POST", "/api/v2/batch/filter", { update: [{ id: hex(), name: "Miss", rule: "" }] });
    expect(Object.values(miss.json.id2error)).toContain("NOT_EXISTED");
  });

  test("evaluateRule handles team, calendar, and account conditions", () => {
    const ctx = { now: Date.now(), projectTeam: { pTeam: "team-1", pPers: null } };
    const tTeam: RuleTask = { projectId: "pTeam", calendarId: "cal-a", accountId: "acc-1" };
    const tPers: RuleTask = { projectId: "pPers" };

    expect(evaluateRule({ and: [{ conditionName: "team", conditionType: 1, or: ["team-1"] }] }, tTeam, ctx)).toBe(true);
    expect(evaluateRule({ and: [{ conditionName: "team", conditionType: 1, or: ["personal"] }] }, tPers, ctx)).toBe(true);
    expect(evaluateRule({ and: [{ conditionName: "team", conditionType: 1, or: ["personal"] }] }, tTeam, ctx)).toBe(false);
    expect(evaluateRule({ and: [{ conditionName: "calendar", conditionType: 1, or: ["cal-a"] }] }, tTeam, ctx)).toBe(true);
    expect(evaluateRule({ and: [{ conditionName: "account", conditionType: 1, or: ["acc-1"] }] }, tTeam, ctx)).toBe(true);
  });

  test("evaluateRule supports custom(start~end) date ranges via dueDate", () => {
    const base = new Date(2026, 10, 10, 12, 0, 0).getTime();
    const tIn: RuleTask = { projectId: "p", dueDate: "2026-11-12T10:00:00.000+0000" };
    const tOut: RuleTask = { projectId: "p", dueDate: "2026-11-20T10:00:00.000+0000" };
    const rule = { and: [{ conditionName: "dueDate", conditionType: 1 as const, or: ["custom(2026-11-10~2026-11-15)"] }] };
    expect(evaluateRule(rule, tIn, { now: base })).toBe(true);
    expect(evaluateRule(rule, tOut, { now: base })).toBe(false);
  });

  test("evaluateRule returns false on unknown future condition name (FILT-008)", () => {
    expect(
      evaluateRule({ and: [{ conditionName: "futureQuantumField", conditionType: 1, or: ["x"] }] }, { projectId: "p" }, { now: Date.now() }),
    ).toBe(false);
  });

  test("GET /api/v2/search/all searches title and content case-insensitively", async () => {
    const { call, addTasks } = makeEnv();
    await addTasks([
      { id: hex(), title: "Prepare Budget", content: "Include Q4 travel" },
      { id: hex(), title: "Grocery", content: "Buy Q4 coffee" },
      { id: hex(), title: "Unrelated", content: "Nothing here" },
    ]);
    const r = await call("GET", "/api/v2/search/all?keywords=q4");
    expect(r.status).toBe(200);
    expect(r.json.map((t: any) => t.title).sort()).toEqual(["Grocery", "Prepare Budget"]);
  });

  test("GET /api/v2/search/all filters by projectId, tag, priority, status, and excludes trashed", async () => {
    const { call, svc, addTasks } = makeEnv();
    const p2 = await seedProject(call, { name: "Work" });
    const trashedId = hex();
    await addTasks([
      { id: hex(), projectId: p2, title: "Target", tags: ["urgent"], priority: 5, status: TaskStatus.Open },
      { id: hex(), projectId: p2, title: "Done one", tags: ["urgent"], priority: 5, status: TaskStatus.Completed },
      { id: hex(), projectId: svc.inboxId, title: "Other list", tags: ["urgent"], priority: 5, status: TaskStatus.Open },
      { id: trashedId, projectId: p2, title: "Target trashed", tags: ["urgent"], priority: 5, status: TaskStatus.Open },
    ]);
    await call("POST", "/api/v2/batch/task", { delete: [{ taskId: trashedId, projectId: p2 }] });

    const r = await call("GET", `/api/v2/search/all?projectId=${p2}&tag=urgent&priority=5&status=0`);
    expect(r.json.map((t: any) => t.title)).toEqual(["Target"]);
  });

  test("GET /api/v2/search/all supports date=overdue and q=/keyword= query aliases", async () => {
    const clock = new Date(2026, 10, 15, 12, 0, 0).getTime();
    const { call, svc } = mk({ now: () => clock });
    await call("POST", "/api/v2/batch/task", {
      add: [
        task({ id: hex(), projectId: svc.inboxId, title: "Overdue invoice", dueDate: "2026-11-10T10:00:00.000+0000" }),
        task({ id: hex(), projectId: svc.inboxId, title: "Future invoice", dueDate: "2026-11-20T10:00:00.000+0000" }),
      ],
    });
    const r1 = await call("GET", "/api/v2/search/all?q=invoice&date=overdue");
    expect(r1.json.map((t: any) => t.title)).toEqual(["Overdue invoice"]);
    const r2 = await call("GET", "/api/v2/search/all?keyword=nomatch");
    expect(r2.json).toEqual([]);
  });

  test("evaluateRule covers status=WontDo and Completed via /api/v2/search/all", async () => {
    const { call, addTasks } = makeEnv();
    await addTasks([
      { id: hex(), title: "OpenA", status: TaskStatus.Open },
      { id: hex(), title: "DoneA", status: TaskStatus.Completed },
      { id: hex(), title: "SkipA", status: TaskStatus.WontDo },
    ]);
    const r = await call("GET", `/api/v2/search/all?status=${TaskStatus.WontDo}`);
    expect(r.json.map((t: any) => t.title)).toEqual(["SkipA"]);
  });
});

describe("M5 import, export, backup CSV, single-task MD, and XLSX", () => {
  test("data/export and data/export/auto require x-verify-id (--no-auth verifies after user/verify)", async () => {
    const { app, call } = makeEnv();
    expect((await app.inject({ method: "GET", url: "/api/v2/data/export" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v2/data/export/auto" })).statusCode).toBe(403);

    const v = await call("POST", "/api/v2/user/verify", {});
    expect(v.status).toBe(200);
    expect(v.json.verifyId).toBeTruthy();

    const ok1 = await app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": v.json.verifyId } });
    expect(ok1.statusCode).toBe(200);
    const ok2 = await app.inject({ method: "GET", url: "/api/v2/data/export/auto", headers: { "x-verify-id": v.json.verifyId } });
    expect(ok2.statusCode).toBe(200);
  });

  test("full auth mode: user/verify checks password (401 on bad) and rejects forged x-verify-id (403)", async () => {
    const { app } = mk({ noAuth: false, auth: { passphraseHash: await hashPassphrase("super-secret-pw") } });
    const login = await app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { password: "super-secret-pw" } });
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrf = login.cookies.find((c) => c.name === "_csrf_token")!.value;

    const badVerify = await app.inject({
      method: "POST",
      url: "/api/v2/user/verify",
      headers: { cookie, "x-csrftoken": csrf },
      payload: { password: "wrong" },
    });
    expect(badVerify.statusCode).toBe(401);

    const forged = await app.inject({ method: "GET", url: "/api/v2/data/export", headers: { cookie, "x-verify-id": "forged123" } });
    expect(forged.statusCode).toBe(403);

    const goodVerify = await app.inject({
      method: "POST",
      url: "/api/v2/user/verify",
      headers: { cookie, "x-csrftoken": csrf },
      payload: { password: "super-secret-pw" },
    });
    expect(goodVerify.statusCode).toBe(200);
    const { verifyId } = JSON.parse(goodVerify.body);
    const exp = await app.inject({ method: "GET", url: "/api/v2/data/export", headers: { cookie, "x-verify-id": verifyId } });
    expect(exp.statusCode).toBe(200);
  });

  test("backup export has no cooldown/throttling (10 rapid calls succeed) (PREM-124)", async () => {
    const { app, call } = makeEnv();
    const { verifyId } = (await call("POST", "/api/v2/user/verify", {})).json;
    for (let i = 0; i < 10; i++) {
      const r = await app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } });
      expect(r.statusCode).toBe(200);
    }
  });

  test("GET /api/v2/data/export/link/:id/check returns ready status", async () => {
    const { call } = makeEnv();
    const r = await call("GET", "/api/v2/data/export/link/exp42/check");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ready: true, status: "ready", id: "exp42", downloadUrl: "/api/v2/data/export" });
  });

  test("exported CSV matches exact 23-column TickTick BACKUP_CSV_HEADER", async () => {
    const { app, call } = makeEnv();
    const { verifyId } = (await call("POST", "/api/v2/user/verify", {})).json;
    const res = await app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } });
    expect(res.headers["content-type"]).toContain("text/csv");
    const rows = parseCsv(res.body);
    expect(rows[0]).toEqual([...BACKUP_CSV_HEADER]);
    expect(BACKUP_CSV_HEADER).toHaveLength(23);
  });

  test("exported CSV contains open, completed, and wont-do tasks while excluding trashed", async () => {
    const { app, call, svc, addTasks } = makeEnv();
    const trashId = hex();
    await addTasks([
      { id: hex(), title: "ActiveRow", status: TaskStatus.Open },
      { id: hex(), title: "DoneRow", status: TaskStatus.Completed },
      { id: hex(), title: "SkipRow", status: TaskStatus.WontDo },
      { id: trashId, title: "TrashHidden", status: TaskStatus.Open },
    ]);
    await call("POST", "/api/v2/batch/task", { delete: [{ taskId: trashId, projectId: svc.inboxId }] });

    const { verifyId } = (await call("POST", "/api/v2/user/verify", {})).json;
    const csv = (await app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } })).body;
    expect(csv).toContain("ActiveRow");
    expect(csv).toContain("DoneRow");
    expect(csv).toContain("SkipRow");
    expect(csv).not.toContain("TrashHidden");
  });

  test("RFC 4180 CSV serialize/parse round-trips quotes, commas, newlines, and CR/LF", () => {
    const headers = ["A", "B", "C"];
    const rows = [
      ['He said "hello, world"', "line1\nline2", "plain"],
      ["", 'multi\r\n"quoted"', "123"],
    ];
    const text = serializeCsv(headers, rows);
    const back = parseCsv(text);
    expect(back).toEqual([headers, ...rows]);
  });

  test("parseCsv throws 400 on unterminated quote and import rejects CSV without backup header", async () => {
    expect(() => parseCsv('Title,Status\n"unclosed')).toThrow(/unterminated/);
    const { call } = makeEnv();
    const r = await call("POST", "/api/v1/import/restore", { csv: "Foo,Bar\n1,2" });
    expect(r.status).toBe(400);
  });

  test("synthetic full-feature CSV export -> fresh server restore preserves folders, lists, viewMode, columns, and tags", async () => {
    const src = makeEnv();
    const grpId = hex();
    const projId = hex();
    const colId = hex();
    await src.call("POST", "/api/v2/batch/projectGroup", { add: [{ id: grpId, name: "Work Folder" }] });
    await src.call("POST", "/api/v2/batch/project", { add: [{ id: projId, name: "Roadmap", groupId: grpId, viewMode: "kanban" }] });
    await src.call("POST", "/api/v2/batch/columnProject", { add: [{ id: colId, projectId: projId, name: "Doing", sortOrder: 0 }] });
    await src.call("POST", "/api/v2/batch/tag", { add: [{ name: "backend", label: "backend" }] });
    await src.call("POST", "/api/v2/batch/task", {
      add: [task({ id: hex(), projectId: projId, columnId: colId, title: "Ship M5", tags: ["backend"] })],
    });

    const { verifyId } = (await src.call("POST", "/api/v2/user/verify", {})).json;
    const csv = (await src.app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } })).body;

    const dst = makeEnv();
    const imp = await dst.call("POST", "/api/v1/import/restore", { csv });
    expect(imp.status).toBe(200);
    expect(imp.json).toMatchObject({ imported: 1, skipped: 0, createdProjects: 1, createdFolders: 1, createdColumns: 1, createdTags: 1 });

    const chk = (await dst.call("GET", "/api/v3/batch/check/0")).json;
    expect(chk.projectGroups[0].name).toBe("Work Folder");
    const rProj = chk.projectProfiles.find((p: any) => p.name === "Roadmap");
    expect(rProj.viewMode).toBe("kanban");
    expect(rProj.groupId).toBe(chk.projectGroups[0].id);
    const cols = (await dst.call("GET", `/api/v2/column/project/${rProj.id}`)).json;
    expect(cols[0].name).toBe("Doing");
    expect(chk.syncTaskBean.update[0].columnId).toBe(cols[0].id);
    expect(chk.syncTaskBean.update[0].tags).toContain("backend");
  });

  test("CSV round-trip preserves task statuses, priorities, dates, timezone, isAllDay, and isFloating", async () => {
    const src = makeEnv();
    const tid = hex();
    await src.addTasks([
      {
        id: tid,
        title: "Roundtrip fields",
        content: 'Line 1, with "quotes"\nLine 2',
        status: TaskStatus.Completed,
        priority: Priority.Medium,
        startDate: "2026-10-15T09:00:00.000+0000",
        dueDate: "2026-10-16T09:00:00.000+0000",
        completedTime: "2026-10-16T11:00:00.000+0000",
        timeZone: "Europe/Berlin",
        isAllDay: false,
        isFloating: true,
      },
    ]);
    const { verifyId } = (await src.call("POST", "/api/v2/user/verify", {})).json;
    const csv = (await src.app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } })).body;

    const dst = makeEnv();
    await dst.call("POST", "/api/v1/import/restore", { csv });
    const back = (await dst.call("GET", `/api/v2/task/${tid}`)).json;
    expect(back).toMatchObject({
      title: "Roundtrip fields",
      content: 'Line 1, with "quotes"\nLine 2',
      status: TaskStatus.Completed,
      priority: Priority.Medium,
      startDate: "2026-10-15T09:00:00.000+0000",
      dueDate: "2026-10-16T09:00:00.000+0000",
      timeZone: "Europe/Berlin",
      isAllDay: false,
      isFloating: true,
    });
  });

  test("CSV round-trip preserves checklists, notes (Kind=NOTE), reminders, and repeatFlag", async () => {
    const src = makeEnv();
    const clId = hex();
    const noteId = hex();
    await src.addTasks([
      {
        id: clId,
        title: "Checklist",
        kind: "CHECKLIST",
        reminders: [{ id: "r1", trigger: "TRIGGER:-PT15M" }],
        repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1",
        items: [
          { id: "a", title: "Buy bread", status: 1, sortOrder: 0 },
          { id: "b", title: "Buy milk", status: 0, sortOrder: 1 },
        ],
      },
      { id: noteId, title: "Note item", kind: "NOTE", content: "Paragraph" },
    ]);
    const { verifyId } = (await src.call("POST", "/api/v2/user/verify", {})).json;
    const csv = (await src.app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } })).body;

    const dst = makeEnv();
    await dst.call("POST", "/api/v1/import/restore", { csv });
    const cl = (await dst.call("GET", `/api/v2/task/${clId}`)).json;
    expect(cl.kind).toBe("CHECKLIST");
    expect(cl.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1");
    expect(cl.reminders[0].trigger).toBe("TRIGGER:-PT15M");
    expect(cl.items.map((x: any) => [x.title, x.status])).toEqual([
      ["Buy bread", 1],
      ["Buy milk", 0],
    ]);

    const note = (await dst.call("GET", `/api/v2/task/${noteId}`)).json;
    // Standard 23-column TickTick backup CSV omits Kind (optional Kind column tested below)
    expect(note.title).toBe("Note item");
    expect(note.content).toBe("Paragraph");
  });

  test("CSV restore links subtasks via ParentId in same project", async () => {
    const src = makeEnv();
    const parentId = hex();
    const childId = hex();
    await src.addTasks([
      { id: parentId, title: "Parent" },
      { id: childId, title: "Child", parentId },
    ]);
    const { verifyId } = (await src.call("POST", "/api/v2/user/verify", {})).json;
    const csv = (await src.app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } })).body;

    const dst = makeEnv();
    await dst.call("POST", "/api/v1/import/restore", { csv });
    const child = (await dst.call("GET", `/api/v2/task/${childId}`)).json;
    const parent = (await dst.call("GET", `/api/v2/task/${parentId}`)).json;
    expect(child.parentId).toBe(parentId);
    expect(parent.childIds).toContain(childId);
  });

  test("CSV restore ignores cyclic or self-referential ParentId safely", async () => {
    const a = hex();
    const b = hex();
    const csv = serializeCsv(
      ["Folder Name", "List Name", "Title", "taskId", "parentId"],
      [
        ["", "Inbox", "Task A", a, b],
        ["", "Inbox", "Task B", b, a],
      ],
    );
    const { call } = makeEnv();
    const imp = await call("POST", "/api/v1/import/restore", { csv });
    expect(imp.status).toBe(200);
    expect(imp.json.imported).toBe(2);
    const ta = (await call("GET", `/api/v2/task/${a}`)).json;
    const tb = (await call("GET", `/api/v2/task/${b}`)).json;
    // Either acyclic (one root + one child) or neither forms a cycle
    expect(!(ta.parentId === b && tb.parentId === a)).toBe(true);
  });

  test("CSV restore accepts raw TickTick preamble, UTF-8 BOM, Kind column, and legend status 2 => WontDo", async () => {
    const id1 = hex();
    const id2 = hex();
    const rawTickTickCsv =
      "\uFEFF" +
      [
        '"Date: 2026-10-01+0000"',
        '"Status: 0 Normal, 1 Completed, 2 Archived"',
        '"Folder Name","List Name","Title","Kind","Status","Priority","taskId"',
        `,"Inbox","First task","TEXT",0,"High","${id1}"`,
        `,"Inbox","Archived wontdo","NOTE",2,"Low","${id2}"`,
      ].join("\n");

    const { app, call } = makeEnv();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/import/restore",
      headers: { "content-type": "text/csv" },
      payload: rawTickTickCsv,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).imported).toBe(2);
    const t1 = (await call("GET", `/api/v2/task/${id1}`)).json;
    const t2 = (await call("GET", `/api/v2/task/${id2}`)).json;
    expect(t1.priority).toBe(Priority.High);
    expect(t1.status).toBe(TaskStatus.Open);
    expect(t2.kind).toBe("NOTE");
    expect(t2.priority).toBe(Priority.Low);
    expect(t2.status).toBe(TaskStatus.WontDo);
  });

  test("CSV restore conflict rule: existing taskId is skipped (first wins / idempotent re-import) (IMP-015)", async () => {
    const { call, svc, addTasks } = makeEnv();
    const tid = hex();
    await addTasks([{ id: tid, title: "Original local title" }]);

    const csv = serializeCsv(
      ["List Name", "Title", "taskId", "Status"],
      [["Inbox", "Incoming overwrite attempt", tid, "0"]],
    );
    const imp = await call("POST", "/api/v1/import/restore", { csv });
    expect(imp.status).toBe(200);
    expect(imp.json).toMatchObject({ imported: 0, skipped: 1 });
    expect((await call("GET", `/api/v2/task/${tid}?projectId=${svc.inboxId}`)).json.title).toBe("Original local title");
  });

  test("CSV restore multipart upload works and rejects invalid non-CSV payloads with 400", async () => {
    const { app, call } = makeEnv();
    expect((await call("POST", "/api/v1/import/restore", { wrongKey: 123 })).status).toBe(400);

    const tid = hex();
    const csv = serializeCsv(["List Name", "Title", "taskId"], [["Inbox", "Multipart row", tid]]);
    const b = "----csvbound12";
    const body = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="backup.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${b}--\r\n`;
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/import/restore",
      headers: { "content-type": `multipart/form-data; boundary=${b}` },
      payload: body,
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).imported).toBe(1);
    expect((await call("GET", `/api/v2/task/${tid}`)).json.title).toBe("Multipart row");
  });

  test("single-task Markdown export formats title, metadata, checklist items, and returns 404 for unknown id", async () => {
    const { app, call, svc, addTasks } = makeEnv();
    const tid = hex();
    await addTasks([
      {
        id: tid,
        projectId: svc.inboxId,
        title: "Write report",
        kind: "CHECKLIST",
        priority: Priority.High,
        tags: ["ops", "q4"],
        startDate: "2026-11-01T09:00:00.000+0000",
        status: TaskStatus.Completed,
        items: [{ id: "1", title: "Draft outline", status: 1, sortOrder: 0 }],
      },
    ]);
    const r = await app.inject({ method: "GET", url: `/api/v2/task/${tid}/export` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/markdown");
    expect(r.body).toContain("# Write report");
    expect(r.body).toContain("- Priority: 5");
    expect(r.body).toContain("#ops #q4");
    expect(r.body).toContain("- Status: Completed");
    expect(r.body).toContain("- [x] Draft outline");

    expect((await app.inject({ method: "GET", url: `/api/v2/task/${hex()}/export` })).statusCode).toBe(404);
  });

  test("habit CSV export returns 11 columns including check-ins and habit records", async () => {
    const { app, call } = makeEnv();
    const hid = hex();
    await call("POST", "/api/v2/habits/batch", { add: [{ id: hid, name: "Meditate", type: "Real", goal: 20, unit: "Min" }] });
    await call("POST", "/api/v2/habitCheckins/batch", {
      add: [{ id: hex(), habitId: hid, checkinStamp: 20261110, status: 2, value: 20, checkinTime: "2026-11-10T07:00:00.000+0000" }],
    });
    await call("POST", "/api/v2/habitRecords", { add: [{ id: hex(), habitId: hid, stamp: 20261110, content: "Felt calm", mood: 4 }] });

    const r = await app.inject({ method: "GET", url: "/api/v2/data/export/habits?format=csv" });
    expect(r.statusCode).toBe(200);
    const rows = parseCsv(r.body);
    expect(rows[0]).toHaveLength(11);
    expect(rows[1]).toEqual([hid, "Meditate", "Real", "20", "Min", "20261110", "2", "20", "Felt calm", "4", "2026-11-10T07:00:00.000+0000"]);
  });

  test("habit XLSX export produces valid ZIP with OOXML sheets and habit content", async () => {
    const { app, call } = makeEnv();
    const hid = hex();
    await call("POST", "/api/v2/habits/batch", { add: [{ id: hid, name: "Read & Learn", type: "Boolean", goal: 1 }] });
    await call("POST", "/api/v2/habitCheckins/batch", { add: [{ id: hex(), habitId: hid, checkinStamp: 20261111, status: 2, value: 1 }] });

    const r = await app.inject({ method: "GET", url: "/api/v2/data/export/habits" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(r.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

    const files = unzipEntries(r.rawPayload);
    expect(Object.keys(files)).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/worksheets/sheet1.xml"]);
    expect(files["xl/workbook.xml"]).toContain('name="Habits"');
    expect(files["xl/worksheets/sheet1.xml"]).toContain("Read &amp; Learn");
  });

  test("focus CSV and XLSX exports calculate active duration, bindings, and notes", async () => {
    const { app, call, svc, addTasks } = makeEnv();
    const tid = hex();
    await addTasks([{ id: tid, title: "Deep Code" }]);
    const pid = hex();
    const pomoRes = await call("POST", "/api/v2/batch/pomodoro", {
      add: [
        {
          id: pid,
          type: 0,
          startTime: "2026-11-12T10:00:00.000+0000",
          endTime: "2026-11-12T10:30:00.000+0000",
          pauseDuration: 300, // -5m pause
          adjustTime: 0,
          tasks: [{ taskId: tid, projectId: svc.inboxId, title: "Deep Code" }],
          note: "Flow state",
        },
      ],
    });
    expect(pomoRes.status).toBe(200);

    const csvRes = await app.inject({ method: "GET", url: "/api/v2/data/export/pomodoro?format=csv" });
    expect(csvRes.statusCode).toBe(200);
    const rows = parseCsv(csvRes.body);
    expect(rows[1]![1]).toBe("Pomodoro");
    expect(rows[1]![4]).toBe("25");
    expect(rows[1]![7]).toBe("Deep Code");
    expect(rows[1]![8]).toBe("Flow state");

    const xlsxRes = await app.inject({ method: "GET", url: "/api/v2/data/export/pomodoro?format=xlsx" });
    expect(xlsxRes.statusCode).toBe(200);
    expect(xlsxRes.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const files = unzipEntries(xlsxRes.rawPayload);
    expect(files["xl/worksheets/sheet1.xml"]).toContain("Flow state");
  });

  test("buildXlsx escapes XML special characters (& < > \" ') and validates ZIP CRCs", () => {
    const buf = buildXlsx('A&B"C<D>', ["Col<1>", 'Col"2"'], [['5 < 6 & "7" > \'4\'', 42]]);
    const files = unzipEntries(buf);
    expect(files["xl/workbook.xml"]).toContain('name="A&amp;B&quot;C&lt;D&gt;"');
    expect(files["xl/worksheets/sheet1.xml"]).toContain("5 &lt; 6 &amp; &quot;7&quot; &gt; &apos;4&apos;");
  });

  test("large synthetic CSV backup (250 tasks across lists/columns) exports & restores cleanly", async () => {
    const src = makeEnv();
    const pid = await seedProject(src.call, { name: "ScaleList", viewMode: "kanban" });
    const cid = hex();
    await src.call("POST", "/api/v2/batch/columnProject", { add: [{ id: cid, projectId: pid, name: "Queue", sortOrder: 0 }] });
    const bulk = Array.from({ length: 250 }, (_, i) => task({ id: hex(), projectId: pid, columnId: cid, title: `Item #${i}`, priority: i % 2 ? 5 : 0 }));
    await src.call("POST", "/api/v2/batch/task", { add: bulk });

    const { verifyId } = (await src.call("POST", "/api/v2/user/verify", {})).json;
    const csv = (await src.app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": verifyId } })).body;

    const dst = makeEnv();
    const imp = await dst.call("POST", "/api/v1/import/restore", { csv });
    expect(imp.status).toBe(200);
    expect(imp.json.imported).toBe(250);
    expect((await dst.call("GET", "/api/v2/search/all?keywords=Item")).json).toHaveLength(250);
  });

  test("exportBackup and importBackup round-trip M5 comments, activities, and notifications", async () => {
    const d1 = freshDir();
    const d2 = freshDir();
    const out1 = freshDir();
    const db1 = join(d1, "s1.sqlite");
    const db2 = join(d2, "s2.sqlite");

    const built = mk({ dbPath: db1 });
    const tid = hex();
    await built.call("POST", "/api/v2/batch/task", { add: [task({ id: tid, projectId: built.svc.inboxId, title: "Tracked" })] });
    await built.call("POST", `/api/v2/project/${built.svc.inboxId}/task/${tid}/comment`, { text: "Persisted comment" });
    built.reminders.addNotification({ title: "Saved alert" });
    built.store.close();

    const counts = exportBackup(db1, out1);
    expect(counts.comments).toBe(1);
    expect(counts.activities).toBeGreaterThanOrEqual(2);
    expect(counts.notifications).toBe(1);

    const imp = importBackup(out1, db2);
    expect(imp.counts.comments).toBe(1);
    expect(imp.counts.activities).toBe(counts.activities);
    expect(imp.counts.notifications).toBe(1);

    const reopened = mk({ dbPath: db2 });
    const cmts = await reopened.call("GET", `/api/v2/project/${reopened.svc.inboxId}/task/${tid}/comments`);
    expect(cmts.json.map((c: any) => c.text)).toEqual(["Persisted comment"]);
    const acts = await reopened.call("GET", `/api/v1/task/activity/${tid}`);
    expect(acts.json.length).toBeGreaterThanOrEqual(2);
    const notifs = await reopened.call("GET", "/api/v2/notification");
    expect(notifs.json.map((n: any) => n.title)).toContain("Saved alert");
    reopened.store.close();
  });

  test("parseCsv handles CRLF, skips blank lines, and keeps ragged rows safely", () => {
    const rows = parseCsv("A,B,C\r\n1,2\r\n\r\n3,4,5\r\n");
    expect(rows).toEqual([
      ["A", "B", "C"],
      ["1", "2"],
      ["3", "4", "5"],
    ]);
  });

  test("CSV restore clamps extreme sortOrder values to ORDER_MAX", async () => {
    const tid = hex();
    const csv = serializeCsv(["List Name", "Title", "Order", "taskId"], [["Inbox", "Clamped", "99999999999999999999", tid]]);
    const { call } = makeEnv();
    const imp = await call("POST", "/api/v1/import/restore", { csv });
    expect(imp.status).toBe(200);
    const back = (await call("GET", `/api/v2/task/${tid}`)).json;
    expect(back.sortOrder).toBe(ORDER_MAX);
  });

  test("/api/v2/search/all supports untagged filter (withoutTag)", async () => {
    const { call, addTasks } = makeEnv();
    await addTasks([
      { id: hex(), title: "TaggedOne", tags: ["a"] },
      { id: hex(), title: "CleanOne", tags: [] },
    ]);
    const r = await call("GET", "/api/v2/search/all?tag=withoutTag");
    expect(r.json.map((t: any) => t.title)).toEqual(["CleanOne"]);
  });
});
