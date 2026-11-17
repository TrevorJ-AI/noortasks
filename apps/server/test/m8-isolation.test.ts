import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { hex, task } from "./helpers.js";
import { mkMulti, type TestUser } from "./multi-helpers.js";

/**
 * Data isolation: user B calls every route of the account app and of the front with user A's ids, and must
 * get none of A's data back and change nothing in A's database. The route list is read from the apps, so a
 * route added later is covered automatically (or fails the coverage check below).
 */

const CANARY = "CANARYa7f3";
type M = Awaited<ReturnType<typeof mkMulti>>;

let m: M;
let A: TestUser;
let B: TestUser;
const ids: Record<string, string> = {};

/** Every table of an account's database, hashed (meta.seq excluded: it is the process-wide counter). */
function fingerprint(userId: number): Record<string, string> {
  const st = m.tenants!.get(userId).store;
  const out: Record<string, string> = {};
  for (const { name } of st.all<{ name: string }>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")) {
    const rows = st.all(`select * from ${name}`).filter((r) => !(name === "meta" && (r as { k: string }).k === "seq"));
    out[name] = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  return out;
}

beforeAll(async () => {
  m = await mkMulti({ opts: { common: { calendarFetch: async () => { throw new Error("offline in tests"); } } } });
  A = m.admin;
  B = m.addUser("b@example.com", "Bea");
  const inbox = (await A.call("GET", "/api/v3/batch/check/0")).json.inboxId as string;
  ids.inbox = inbox;
  ids.project = hex();
  await A.call("POST", "/api/v2/batch/project", { add: [{ id: ids.project, name: `${CANARY} list`, sortOrder: 0, kind: "TASK" }] });
  const t = task({ projectId: ids.project, title: `${CANARY} task`, content: `${CANARY} body`, tags: [`${CANARY.toLowerCase()}tag`] });
  ids.task = t.id;
  await A.call("POST", "/api/v2/batch/task", { add: [t, task({ projectId: inbox, title: `${CANARY} inbox` })] });
  await A.call("POST", "/api/v2/batch/tag", { add: [{ name: `${CANARY.toLowerCase()}tag`, label: `${CANARY} tag` }] });
  ids.comment = (await A.call("POST", `/api/v2/project/${ids.project}/task/${ids.task}/comment`, { text: `${CANARY} comment` })).json.id;
  ids.habit = hex();
  await A.call("POST", "/api/v2/habits/batch", { add: [{ id: ids.habit, name: `${CANARY} habit`, type: "Boolean", goal: 1 }] });
  ids.countdown = hex();
  await A.call("POST", "/api/v2/countdown/batch", { add: [{ id: ids.countdown, name: `${CANARY} trip`, date: "2026-12-24T00:00:00.000+0000" }] });
  ids.filter = hex();
  await A.call("POST", "/api/v2/batch/filter", { add: [{ id: ids.filter, name: `${CANARY} filter`, rule: "" }] });
  ids.template = (await A.call("POST", "/api/v2/templates/task", { title: `${CANARY} template`, content: "x" })).json.id;
  ids.feed = (await A.call("POST", "/api/v2/calendar/feeds/code/new/default")).json.code;
  const start = Date.UTC(2026, 10, 1, 9);
  ids.pomo = hex();
  await A.call("POST", "/api/v2/batch/pomodoro", { add: [{ id: ids.pomo, startTime: start, endTime: start + 25 * 60_000, status: 1, note: `${CANARY} focus`, tasks: [{ taskId: ids.task, title: `${CANARY} task`, startTime: start, endTime: start + 25 * 60_000 }] }] });
  await A.call("PUT", "/api/v2/user/preferences/settings", { zzCanary: CANARY });
  m.tenants!.get(A.id).reminders.addNotification({ title: `${CANARY} note`, type: "system" });
});
afterAll(async () => {
  await m.app.close();
});

/** Fills route params with A's ids: the attack is "B names A's objects". */
function fill(url: string): string {
  return url
    .replace(/:projectId|:pid/g, ids.project!)
    .replace(/:ids/g, ids.project!)
    .replace(/:taskId|:tid/g, ids.task!)
    .replace(/:commentId|:cid/g, ids.comment!)
    .replace(/:habitId/g, ids.habit!)
    .replace(/:tokenFile/g, `${hex()}.ics`)
    .replace(/:id/g, ids.task!)
    .replace(/:[a-zA-Z]+/g, ids.task!)
    .replace(/\*/g, `upload/${A.id}/x.png`);
}

function body(): unknown {
  const ref = { id: ids.task, taskId: ids.task, projectId: ids.project, habitId: ids.habit, commentId: ids.comment };
  return {
    ...ref,
    add: [],
    update: [{ id: ids.task, projectId: ids.project, title: "pwned by B" }, { id: ids.habit, name: "pwned" }, { id: ids.countdown, name: "pwned" }, { id: ids.filter, name: "pwned" }],
    delete: [{ taskId: ids.task, projectId: ids.project }, ids.habit, ids.countdown, ids.filter, ids.pomo],
    items: [{ taskId: ids.task, fromProjectId: ids.project, toProjectId: ids.inbox, parentId: ids.task }],
    ids: [ids.task],
    taskIds: [ids.task],
    name: `${CANARY.toLowerCase()}tag`,
    text: "x",
  };
}

describe("data isolation: B against A's ids", () => {
  test("every account-app route leaks nothing and changes nothing in A's database", async () => {
    const routes = m.tenants!.get(A.id).routes;
    expect(routes.length).toBeGreaterThan(150);
    const before = fingerprint(A.id);
    const leaks: string[] = [];
    const refused: string[] = [];
    for (const r of routes) {
      // signing out would end B's session and turn the rest of the walk into 401s
      if (r.url === "/api/v2/user/signout") continue;
      const url = fill(r.url);
      const res = await B.call(r.method, url, r.method === "GET" || r.method === "DELETE" ? undefined : body());
      if (JSON.stringify(res.json ?? "").includes(CANARY)) leaks.push(`${r.method} ${r.url}`);
      if (res.status === 401 && r.url !== "/api/v2/user/signon") refused.push(`${r.method} ${r.url}`);
      // the batch routes again with a bodyless DELETE and an array body
      if (r.method !== "GET") {
        const res2 = await B.call(r.method, url, [{ taskId: ids.task, projectId: ids.project, toProjectId: ids.inbox }]);
        if (JSON.stringify(res2.json ?? "").includes(CANARY)) leaks.push(`${r.method} ${r.url} (array body)`);
      }
    }
    expect(leaks).toEqual([]);
    // B stayed signed in for the whole walk, so every route really ran as B
    expect(refused).toEqual([]);
    expect(fingerprint(A.id)).toEqual(before);
  }, 120_000);

  test("every front route leaks nothing to B and B cannot act on A's lists", async () => {
    const before = fingerprint(A.id);
    const leaks: string[] = [];
    const refused: string[] = [];
    for (const r of m.routes) {
      if (r.url === "/*" || r.url === "/api/v2/user/signout") continue;
      const res = await B.call(r.method, fill(r.url), r.method === "GET" ? undefined : { ...(body() as object), permission: "write", userId: B.id, email: B.email, confirm: A.email });
      if (JSON.stringify(res.json ?? "").includes(CANARY)) leaks.push(`${r.method} ${r.url}`);
      if (r.url.startsWith("/api/admin/")) expect(res.status, r.url).toBe(403);
      if (res.status === 401 && r.url !== "/api/v2/user/signon") refused.push(r.url);
    }
    expect(refused).toEqual([]);
    expect(leaks).toEqual([]);
    expect(fingerprint(A.id)).toEqual(before);
    expect(m.sys!.sharesOfProject(ids.project!)).toEqual([]);
  });

  test("shared-list paths with A's list id fall back to B's own data (no share)", async () => {
    for (const url of [
      `/api/v2/project/${ids.project}/task/${ids.task}/comments`,
      `/api/v1/project/${ids.project}/activity`,
      `/api/v2/project/${ids.project}/tasks`,
      `/api/v2/project/${ids.project}/closed`,
      `/api/v2/column/project/${ids.project}`,
      `/api/v1/task/activity/${ids.task}`,
      `/api/v2/task/${ids.task}`,
      `/api/v2/project/${ids.project}/shares`,
    ]) {
      const r = await B.call("GET", url);
      expect(JSON.stringify(r.json), url).not.toContain(CANARY);
    }
    const c = await B.call("POST", `/api/v2/project/${ids.project}/task/${ids.task}/comment`, { text: "hi" });
    expect(c.status).toBe(404);
  });

  test("B's full delta and search contain only B's data", async () => {
    const r = await B.call("GET", "/api/v3/batch/check/0");
    expect(JSON.stringify(r.json)).not.toContain(CANARY);
    expect(r.json.inboxId).not.toBe(ids.inbox);
    const s = await B.call("GET", `/api/v2/search/all?keywords=${CANARY}`);
    expect(s.json).toEqual([]);
  });

  test("id collisions: B creating objects with A's ids stays in B's account", async () => {
    const before = fingerprint(A.id);
    const r = await B.call("POST", "/api/v2/batch/task", { add: [{ ...task({ id: ids.task, projectId: (await B.call("GET", "/api/v3/batch/check/0")).json.inboxId }), title: "B's own" }] });
    expect(r.json.id2etag[ids.task!]).toBeTruthy();
    await B.call("POST", "/api/v2/batch/project", { add: [{ id: ids.project, name: "B list", sortOrder: 0, kind: "TASK" }] });
    await B.call("POST", "/api/v2/batch/tag", { add: [{ name: `${CANARY.toLowerCase()}tag`, label: "B tag" }] });
    expect(fingerprint(A.id)).toEqual(before);
    const a = await A.call("GET", `/api/v2/task/${ids.task}`);
    expect(a.json.title).toBe(`${CANARY} task`);
    // A's delta never shows B's object either
    expect(JSON.stringify((await A.call("GET", "/api/v3/batch/check/0")).json)).not.toContain("B's own");
  });

  test("the calendar feed answers only to its own token; unknown paths are refused without a session", async () => {
    expect((await m.anon("GET", `/feed/${hex()}.ics`)).status).toBe(404);
    const ok = await m.anon("GET", `/feed/${ids.feed}.ics`);
    expect(ok.status).toBe(200);
    for (const u of ["/api/v2/user/status", "/api/v3/batch/check/0", "/files/upload/x", "/pub/api/v2/templates/project/x", "/api/nope", "/api/admin/members"]) {
      expect((await m.anon("GET", u)).status, u).toBe(401);
    }
  });

  test("CSRF: a write without the matching header is refused", async () => {
    const st = m.sys!.createSession(B.id);
    const r = await m.app.inject({ method: "POST", url: "/api/v2/batch/task", payload: { add: [] }, headers: { cookie: `t=${st}; _csrf_token=abc` } });
    expect(r.statusCode).toBe(403);
  });

  test("a disabled member is signed out at once", async () => {
    const C = m.addUser("c@example.com");
    expect((await C.call("GET", "/api/v2/user/status")).status).toBe(200);
    expect((await A.call("POST", `/api/admin/members/${C.id}/disable`)).status).toBe(200);
    expect((await C.call("GET", "/api/v2/user/status")).status).toBe(401);
    expect((await m.as(C.id).call("GET", "/api/v2/user/status")).status).toBe(401);
  });
});

describe("data isolation while B holds edit rights on one of A's lists", () => {
  let m2: M;
  let A2: TestUser;
  let B2: TestUser;
  const S = {} as { inbox: string; shared: string; private: string; sharedTask: string; privateTask: string; privateComment: string };
  const PRIVATE = "PRIVCANARYq9";

  /** A's rows outside the shared list (the rows B must never read or change). */
  function privateFingerprint(): Record<string, string> {
    const st = m2.tenants!.get(A2.id).store;
    const h = (rows: unknown[]): string => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    const out: Record<string, string> = {
      tasks: h(st.all("select * from tasks where projectId != ? order by id", S.shared!)),
      comments: h(st.all("select * from comments where projectId != ? order by id", S.shared!)),
      projects: h(st.all("select * from projects where id != ? order by id", S.shared!)),
    };
    const skip = new Set(["meta", "tasks", "comments", "projects", "activities", "notifications", "tombstones", "columns"]);
    for (const { name } of st.all<{ name: string }>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")) {
      if (!skip.has(name)) out[name] = h(st.all(`select * from ${name}`));
    }
    return out;
  }

  beforeAll(async () => {
    m2 = await mkMulti({ opts: { common: { calendarFetch: async () => { throw new Error("offline in tests"); } } } });
    A2 = m2.admin;
    B2 = m2.addUser("b2@example.com", "Bo");
    S.inbox = (await A2.call("GET", "/api/v3/batch/check/0")).json.inboxId;
    S.shared = hex();
    S.private = hex();
    await A2.call("POST", "/api/v2/batch/project", { add: [{ id: S.shared, name: "Shared", sortOrder: 0, kind: "TASK" }, { id: S.private, name: `${PRIVATE} list`, sortOrder: 1, kind: "TASK" }] });
    const st = task({ projectId: S.shared, title: "shared task" });
    const pt = task({ projectId: S.private, title: `${PRIVATE} task` });
    S.sharedTask = st.id;
    S.privateTask = pt.id;
    await A2.call("POST", "/api/v2/batch/task", { add: [st, pt, task({ projectId: S.inbox, title: `${PRIVATE} inbox` })] });
    S.privateComment = (await A2.call("POST", `/api/v2/project/${S.private}/task/${S.privateTask}/comment`, { text: `${PRIVATE} comment` })).json.id;
    await A2.call("POST", "/api/v2/habits/batch", { add: [{ id: hex(), name: `${PRIVATE} habit`, type: "Boolean", goal: 1 }] });
    expect((await A2.call("POST", `/api/v2/project/${S.shared}/share`, { userId: B2.id, permission: "write" })).status).toBe(200);
  });
  afterAll(async () => {
    await m2.app.close();
  });

  const fillS = (url: string): string =>
    url
      .replace(/:projectId|:pid|:ids/g, S.shared!)
      .replace(/:taskId|:tid/g, S.privateTask!)
      .replace(/:commentId|:cid/g, S.privateComment!)
      .replace(/:id/g, S.privateTask!)
      .replace(/:[a-zA-Z]+/g, S.privateTask!)
      .replace(/\*/g, `upload/${A2.id}/x.png`);
  const attack = (): unknown => ({
    id: S.privateTask,
    taskId: S.privateTask,
    projectId: S.shared,
    add: [task({ projectId: S.shared, parentId: S.privateTask, title: "nest under private" }), task({ id: S.privateTask, projectId: S.shared, title: "overwrite private" })],
    update: [{ id: S.sharedTask, projectId: S.private, title: "move by update" }, { id: S.privateTask, title: "pwned" }],
    delete: [{ taskId: S.privateTask, projectId: S.private }, S.privateTask],
    items: [{ taskId: S.sharedTask, fromProjectId: S.shared, toProjectId: S.private, parentId: S.privateTask }],
    deleteAttachments: [{ id: S.privateTask, attachments: [{ id: "x" }] }],
  });

  test("every account-app route, aimed at A's private ids through the shared list, leaks and changes nothing private", async () => {
    const before = privateFingerprint();
    const leaks: string[] = [];
    for (const r of m2.tenants!.get(A2.id).routes) {
      if (r.url === "/api/v2/user/signout") continue;
      const url = fillS(r.url);
      const res = await B2.call(r.method, url, r.method === "GET" || r.method === "DELETE" ? undefined : attack());
      if (JSON.stringify(res.json ?? "").includes(PRIVATE)) leaks.push(`${r.method} ${r.url}`);
      if (r.method !== "GET") {
        const res2 = await B2.call(r.method, url, [{ taskId: S.sharedTask, projectId: S.shared, parentId: S.privateTask, toProjectId: S.private }]);
        if (JSON.stringify(res2.json ?? "").includes(PRIVATE)) leaks.push(`${r.method} ${r.url} (array)`);
      }
    }
    expect(leaks).toEqual([]);
    expect(privateFingerprint()).toEqual(before);
    // B still holds the share (the walk did not sign B out or leave the list by accident... it may have; check data only)
    expect(JSON.stringify((await B2.call("GET", "/api/v3/batch/check/0")).json)).not.toContain(PRIVATE);
  }, 120_000);

  test("targeted: parent links, moves and completes cannot reach A's private tasks", async () => {
    await A2.call("POST", `/api/v2/project/${S.shared}/share`, { userId: B2.id, permission: "write" });
    const before = privateFingerprint();
    expect((await B2.call("POST", "/api/v2/batch/taskParent", [{ taskId: S.sharedTask, parentId: S.privateTask }])).json.id2error[S.sharedTask]).toBe("NOT_EXISTED");
    const nest = task({ projectId: S.shared, parentId: S.privateTask });
    expect((await B2.call("POST", "/api/v2/batch/task", { add: [nest] })).json.id2error[nest.id]).toBe("NO_PROJECT_PERMISSION");
    expect((await B2.call("POST", "/api/v2/batch/task", { update: [{ id: S.sharedTask, projectId: S.private, title: "x" }] })).json.id2error[S.sharedTask]).toBe("PROJECT_MOVE_ERROR");
    expect((await B2.call("POST", "/api/v2/batch/taskProject", [{ taskId: S.sharedTask, fromProjectId: S.shared, toProjectId: S.private }])).json.id2error[S.sharedTask]).toBeTruthy();
    expect((await B2.call("POST", `/api/v2/project/${S.shared}/task/${S.privateTask}/complete`)).status).toBe(404);
    // B creates an own task with the id of A's private task and moves it into the shared list: refused, no overwrite
    const inboxB = (await B2.call("GET", "/api/v3/batch/check/0")).json.inboxId;
    await B2.call("POST", "/api/v2/batch/task", { add: [task({ id: S.privateTask, projectId: inboxB, title: "B's twin" })] });
    const mv = await B2.call("POST", "/api/v2/batch/taskProject", [{ taskId: S.privateTask, fromProjectId: inboxB, toProjectId: S.shared }]);
    expect(mv.json.id2error[S.privateTask]).toBe("EXISTED");
    expect(privateFingerprint()).toEqual(before);
    expect(m2.tenants!.get(A2.id).store.getTask(S.privateTask)?.title).toBe(`${PRIVATE} task`);
  });

  test("a member's project or section write for a shared list makes no own copy; their tasks still reach the owner", async () => {
    const upd = await B2.call("POST", "/api/v2/batch/project", { update: [{ id: S.shared, name: "Shared", viewMode: "kanban", sortOrder: 0 }] });
    expect(upd.json.id2error[S.shared]).toBe("NO_PROJECT_PERMISSION");
    const add = await B2.call("POST", "/api/v2/batch/project", { add: [{ id: S.shared, name: "Shadow", sortOrder: 0, kind: "TASK" }] });
    expect(add.json.id2error[S.shared]).toBe("NO_PROJECT_PERMISSION");
    expect(m2.tenants!.get(B2.id).store.collGet("projects", S.shared!)).toBeUndefined();
    const col = await B2.call("POST", "/api/v2/batch/columnProject", { add: [{ id: hex(), projectId: S.shared, name: "Doing" }] });
    expect(Object.values(col.json.id2error)).toEqual(["NO_PROJECT_PERMISSION"]);
    const t = task({ projectId: S.shared, title: "after shadow attempt" });
    await B2.call("POST", "/api/v2/batch/task", { add: [t] });
    expect(m2.tenants!.get(A2.id).store.getTask(t.id)?.title).toBe("after shadow attempt");
    expect(m2.tenants!.get(B2.id).store.getTask(t.id)).toBeUndefined();
  });
});

describe("the acting member over a real socket", () => {
  test("a comment whose body arrives after the headers is still authored by the member; others' comments stay protected", async () => {
    const { request } = await import("node:http");
    const m3 = await mkMulti();
    const A3 = m3.admin;
    const C3 = m3.addUser("c3@example.com", "Cy");
    const D3 = m3.addUser("d3@example.com", "Di");
    const pid = hex();
    await A3.call("POST", "/api/v2/batch/project", { add: [{ id: pid, name: "L", sortOrder: 0, kind: "TASK" }] });
    const t = task({ projectId: pid });
    await A3.call("POST", "/api/v2/batch/task", { add: [t] });
    await A3.call("POST", `/api/v2/project/${pid}/share`, { userId: C3.id, permission: "comment" });
    await A3.call("POST", `/api/v2/project/${pid}/share`, { userId: D3.id, permission: "comment" });
    const dComment = (await D3.call("POST", `/api/v2/project/${pid}/task/${t.id}/comment`, { text: "from Di" })).json.id;
    await m3.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (m3.app.server.address() as { port: number }).port;
    const token = m3.sys!.createSession(C3.id);
    const slow = (method: string, path: string, body: unknown): Promise<{ status: number; json: any }> =>
      new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = request({ host: "127.0.0.1", port, method, path, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), cookie: `t=${token}; _csrf_token=k`, "x-csrftoken": "k" } }, (res) => {
          let raw = "";
          res.on("data", (c: Buffer) => (raw += c.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw || "null") }));
        });
        req.on("error", reject);
        req.flushHeaders();
        setTimeout(() => req.end(data), 60);
      });
    const r = await slow("POST", `/api/v2/project/${pid}/task/${t.id}/comment`, { text: "slow body", userProfile: { userId: String(A3.id), name: "Admin" } });
    expect(r.status).toBe(200);
    expect(r.json.userProfile.userId).toBe(String(C3.id));
    expect((await slow("PUT", `/api/v2/project/${pid}/task/${t.id}/comment/${dComment}`, { text: "hijack" })).status).toBe(403);
    expect((await slow("POST", `/api/v2/project/${pid}/task/${t.id}/comment`, { text: "x".repeat(1100) })).status).toBe(400);
    await m3.app.close();
  });
});
