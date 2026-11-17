import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hex, task } from "./helpers.js";
import { mkMulti, type TestUser } from "./multi-helpers.js";

type M = Awaited<ReturnType<typeof mkMulti>>;
let m: M;
let A: TestUser;
let B: TestUser;
let C: TestUser;
let pid: string;
let t1: any;

const check = async (u: TestUser, cp = 0) => (await u.call("GET", `/api/v3/batch/check/${cp}`)).json;
const share = (u: TestUser, project: string, member: TestUser, permission = "write") => u.call("POST", `/api/v2/project/${project}/share`, { userId: member.id, permission });
const notes = async (u: TestUser) => (await u.call("GET", "/api/v2/notification")).json as any[];

beforeEach(async () => {
  m = await mkMulti();
  A = m.admin;
  B = m.addUser("bea@example.com", "Bea");
  C = m.addUser("cas@example.com", "Cas");
  pid = hex();
  await A.call("POST", "/api/v2/batch/project", { add: [{ id: pid, name: "Groceries", sortOrder: 0, kind: "TASK" }] });
  t1 = task({ projectId: pid, title: "milk" });
  await A.call("POST", "/api/v2/batch/task", { add: [t1] });
});
afterEach(async () => {
  await m.app.close();
});

describe("sharing a list", () => {
  test("a member sees the list and its tasks in a full delta, decorated as not owned", async () => {
    expect((await share(A, pid, B)).status).toBe(200);
    const c = await check(B);
    const p = c.projectProfiles.find((x: any) => x.id === pid);
    expect(p).toMatchObject({ name: "Groceries", isOwner: false, permission: "write", userCount: 2, ownerId: A.id });
    expect(c.syncTaskBean.update.map((t: any) => t.title)).toContain("milk");
    const own = (await check(A)).projectProfiles.find((x: any) => x.id === pid);
    expect(own).toMatchObject({ isOwner: true, userCount: 2 });
    expect(JSON.stringify(await check(C))).not.toContain("Groceries");
  });

  test("a share made after the member's checkpoint brings the old tasks in the next delta", async () => {
    const cp = (await check(B)).checkPoint;
    await share(A, pid, B);
    const d = await check(B, cp);
    expect(d.projectProfiles.map((p: any) => p.id)).toContain(pid);
    expect(d.syncTaskBean.add.map((t: any) => t.id)).toContain(t1.id);
  });

  test("edits flow both ways through the delta protocol", async () => {
    await share(A, pid, B);
    const cpB = (await check(B)).checkPoint;
    const cpA = (await check(A)).checkPoint;
    // B edits A's task and adds one to the shared list
    const u = await B.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "oat milk" }] });
    expect(u.json.id2etag[t1.id]).toBeTruthy();
    const t2 = task({ projectId: pid, title: "bread" });
    expect((await B.call("POST", "/api/v2/batch/task", { add: [t2] })).json.id2etag[t2.id]).toBeTruthy();
    // stored once, in the owner's account
    expect(m.tenants!.get(A.id).store.getTask(t2.id)?.title).toBe("bread");
    expect(m.tenants!.get(B.id).store.getTask(t2.id)).toBeUndefined();
    const dA = await check(A, cpA);
    expect([...dA.syncTaskBean.update, ...dA.syncTaskBean.add].map((t: any) => t.title).sort()).toEqual(["bread", "oat milk"]);
    // A completes; B's delta reports it
    await A.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "oat milk", status: 2, completedTime: "2026-11-16T10:00:00.000+0000" }] });
    const dB = await check(B, cpB);
    expect(dB.syncTaskBean.update.find((t: any) => t.id === t1.id)?.status).toBe(2);
    // B deletes; A's task goes to A's trash
    await B.call("POST", "/api/v2/batch/task", { delete: [{ taskId: t2.id, projectId: pid }] });
    expect(m.tenants!.get(A.id).store.getTask(t2.id)?.deleted).toBe(1);
    expect((await check(B, dB.checkPoint)).removedTasks).toContain(t2.id);
    // the activity entry names the member who acted
    const act = (await A.call("GET", `/api/v1/task/activity/${t1.id}`)).json;
    expect(JSON.stringify(act)).toContain(`"userId":${B.id}`);
  });

  test("batch details survive routing: string delete ids and attachment entries on own tasks", async () => {
    await share(A, pid, B);
    const t2 = task({ projectId: pid, title: "eggs" });
    await B.call("POST", "/api/v2/batch/task", { add: [t2] });
    expect((await B.call("POST", "/api/v2/batch/task", { delete: [t2.id] })).json.id2error).toEqual({});
    expect(m.tenants!.get(A.id).store.getTask(t2.id)?.deleted).toBe(1);
    // attachment metadata on someone else's shared task is refused; on an own task it reaches the service
    expect((await B.call("POST", "/api/v2/batch/task", { deleteAttachments: [{ id: t1.id, attachments: [{ id: "x" }] }] })).json.id2error[t1.id]).toBe("NO_PROJECT_PERMISSION");
    const own = task({ projectId: (await check(A)).inboxId });
    await A.call("POST", "/api/v2/batch/task", { add: [own] });
    const r = await A.call("POST", "/api/v2/batch/task", { deleteAttachments: [{ id: own.id, attachments: [{ id: "nope" }] }] });
    expect(r.status).toBe(200);
    expect(r.json.id2error[own.id]).not.toBe("NO_PROJECT_PERMISSION");
  });

  test("permissions: comment members comment but cannot edit; read members only read", async () => {
    await share(A, pid, B, "comment");
    await share(A, pid, C, "read");
    const e = await B.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "hacked" }], add: [task({ projectId: pid })] });
    expect(Object.values(e.json.id2error)).toEqual(["NO_PROJECT_PERMISSION", "NO_PROJECT_PERMISSION"]);
    expect((await B.call("POST", `/api/v2/project/${pid}/task/${t1.id}/comment`, { text: "need 2?" })).status).toBe(200);
    expect((await C.call("POST", `/api/v2/project/${pid}/task/${t1.id}/comment`, { text: "me too" })).status).toBe(403);
    expect((await C.call("GET", `/api/v2/project/${pid}/task/${t1.id}/comments`)).json.map((c: any) => c.text)).toEqual(["need 2?"]);
    expect((await C.call("POST", "/api/v2/batch/task", { delete: [{ taskId: t1.id, projectId: pid }] })).json.id2error[t1.id]).toBe("NO_PROJECT_PERMISSION");
    expect((await C.call("POST", "/api/v2/batch/taskProject", [{ taskId: t1.id, fromProjectId: pid, toProjectId: (await check(C)).inboxId }])).json.id2error[t1.id]).toBe("NO_PROJECT_PERMISSION");
    expect(m.tenants!.get(A.id).store.getTask(t1.id)?.title).toBe("milk");
    // a member cannot share, re-permission or transfer someone else's list
    expect((await share(B, pid, C)).status).toBe(403);
    expect((await B.call("POST", `/api/v2/project/${pid}/transfer?toUserCode=${C.id}`)).status).toBe(403);
    // the owner raises B to edit
    const rows = (await A.call("GET", `/api/v2/project/${pid}/shares`)).json;
    const rec = rows.find((r: any) => r.userId === B.id).id;
    await A.call("PUT", `/api/v2/project/${pid}/permission?permission=write&recordId=${rec}`);
    expect((await B.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "edited" }] })).json.id2etag[t1.id]).toBeTruthy();
  });

  test("the inbox cannot be shared and opted-out members cannot be added", async () => {
    expect((await share(A, (await check(A)).inboxId, B)).status).toBe(400);
    await C.call("PUT", "/api/auth/me", { collabOptOut: true });
    expect((await share(A, pid, C)).status).toBe(404);
    expect((await A.call("GET", "/api/v2/share/contacts")).json.map((c: any) => c.email)).toEqual(["bea@example.com"]);
  });

  test("remove and leave: the list disappears from the member's devices, nothing is deleted", async () => {
    await share(A, pid, B);
    await share(A, pid, C);
    const cpB = (await check(B)).checkPoint;
    const cpC = (await check(C)).checkPoint;
    const rows = (await A.call("GET", `/api/v2/project/${pid}/shares`)).json;
    await A.call("DELETE", `/api/v2/project/${pid}/share/${rows.find((r: any) => r.userId === B.id).id}`);
    expect((await check(B, cpB)).revokedProjects).toEqual([pid]);
    expect((await B.call("GET", `/api/v2/task/${t1.id}`)).status).toBe(404);
    expect((await B.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "late edit" }] })).json.id2error[t1.id]).toBe("NOT_EXISTED");
    // C leaves on their own
    const own = (await C.call("GET", `/api/v2/project/${pid}/shares`)).json.find((r: any) => r.userId === C.id);
    expect((await C.call("DELETE", `/api/v2/project/${pid}/share/${own.id}`)).status).toBe(200);
    expect((await check(C, cpC)).revokedProjects).toEqual([pid]);
    expect(m.tenants!.get(A.id).store.getTask(t1.id)?.title).toBe("milk");
    expect((await check(A)).projectProfiles.find((p: any) => p.id === pid).userCount).toBeUndefined();
  });

  test("a task moved out of the shared list is removed from members", async () => {
    await share(A, pid, B);
    const cp = (await check(B)).checkPoint;
    const priv = hex();
    await A.call("POST", "/api/v2/batch/project", { add: [{ id: priv, name: "Private", sortOrder: 1, kind: "TASK" }] });
    await A.call("POST", "/api/v2/batch/taskProject", [{ taskId: t1.id, fromProjectId: pid, toProjectId: priv }]);
    const d = await check(B, cp);
    expect(d.removedTasks).toEqual([t1.id]);
    expect(JSON.stringify(d)).not.toContain("Private");
  });

  test("a member moves a private task into the shared list (it changes account)", async () => {
    await share(A, pid, B);
    const inboxB = (await check(B)).inboxId;
    const mine = task({ projectId: inboxB, title: "for everyone" });
    await B.call("POST", "/api/v2/batch/task", { add: [mine] });
    const r = await B.call("POST", "/api/v2/batch/taskProject", [{ taskId: mine.id, fromProjectId: inboxB, toProjectId: pid }]);
    expect(r.json.id2etag[mine.id]).toBeTruthy();
    expect(m.tenants!.get(A.id).store.getTask(mine.id)?.projectId).toBe(pid);
    expect(m.tenants!.get(B.id).store.getTask(mine.id)).toBeUndefined();
    const full = await check(B);
    expect(full.syncTaskBean.update.find((t: any) => t.id === mine.id)?.projectId).toBe(pid);
  });

  test("ownership transfer moves the list and keeps the old owner as an editor", async () => {
    await share(A, pid, B);
    await share(A, pid, C, "read");
    await A.call("POST", `/api/v2/project/${pid}/task/${t1.id}/comment`, { text: "keep this" });
    const cpA = (await check(A)).checkPoint;
    const cpB = (await check(B)).checkPoint;
    expect((await A.call("POST", `/api/v2/project/${pid}/transfer?toUserCode=${B.id}`)).status).toBe(200);
    expect(m.tenants!.get(B.id).store.getTask(t1.id)?.title).toBe("milk");
    expect(m.tenants!.get(A.id).store.getTask(t1.id)).toBeUndefined();
    const dA = await check(A, cpA);
    expect(dA.projectProfiles.find((p: any) => p.id === pid)).toMatchObject({ isOwner: false, permission: "write", ownerId: B.id });
    expect(dA.syncTaskBean.add.map((t: any) => t.id)).toContain(t1.id);
    expect(dA.syncTaskBean.delete.map((d: any) => d.taskId)).not.toContain(t1.id);
    expect(dA.deletedProjects ?? []).not.toContain(pid);
    const dB = await check(B, cpB);
    expect(dB.projectProfiles.find((p: any) => p.id === pid)).toMatchObject({ isOwner: true });
    expect(dB.revokedProjects ?? []).not.toContain(pid);
    expect((await C.call("GET", `/api/v2/project/${pid}/shares`)).json.find((r: any) => r.isOwner).userId).toBe(B.id);
    expect((await B.call("GET", `/api/v2/project/${pid}/task/${t1.id}/comments`)).json.map((c: any) => c.text)).toEqual(["keep this"]);
  });
});

describe("assigning, comments, mentions and notifications", () => {
  test("assigning a member notifies them; assigning a non-member is refused", async () => {
    await share(A, pid, B);
    const r = await A.call("POST", "/api/v2/task/assign", { taskId: t1.id, assignee: B.id });
    expect(r.status).toBe(200);
    expect(m.tenants!.get(A.id).store.getTask(t1.id)?.assignee).toBe(B.id);
    const n = await notes(B);
    expect(n.find((x) => x.type === "assign")).toMatchObject({ title: 'Admin assigned you "milk"'.replace("Admin", "admin") });
    // the task in B's delta carries B as assignee (Assigned to me)
    expect((await check(B)).syncTaskBean.update.find((t: any) => t.id === t1.id).assignee).toBe(B.id);
    expect((await A.call("POST", "/api/v2/task/assign", { taskId: t1.id, assignee: C.id })).status).toBe(400);
    // batch updates go through the same check
    expect((await A.call("POST", "/api/v2/batch/task", { update: [{ ...t1, assignee: C.id }] })).json.id2error[t1.id]).toBe("INVALID_ASSIGNEE");
    // a member with edit rights can assign too, and can unassign
    expect((await B.call("POST", "/api/v2/task/assign", { taskId: t1.id, assignee: null })).status).toBe(200);
    expect(m.tenants!.get(A.id).store.getTask(t1.id)?.assignee).toBeNull();
  });

  test("comments notify the other members; @mentions raise a mention", async () => {
    await share(A, pid, B);
    await share(A, pid, C, "comment");
    const r = await C.call("POST", `/api/v2/project/${pid}/task/${t1.id}/comment`, { text: "@Bea can you get it?" });
    expect(r.json.userProfile).toMatchObject({ userId: String(C.id), name: "Cas" });
    expect((await notes(B)).find((x) => x.type === "mention")?.title).toBe('Cas mentioned you on "milk"');
    expect((await notes(A)).find((x) => x.type === "comment")?.title).toBe('Cas commented on "milk"');
    expect((await notes(C)).filter((x) => x.type === "comment" || x.type === "mention")).toEqual([]);
    // a member cannot edit or delete another member's comment; the owner may delete it
    const cid = r.json.id;
    expect((await B.call("PUT", `/api/v2/project/${pid}/task/${t1.id}/comment/${cid}`, { text: "changed" })).status).toBe(403);
    expect((await B.call("DELETE", `/api/v2/project/${pid}/task/${t1.id}/comment/${cid}`)).status).toBe(403);
    expect((await A.call("DELETE", `/api/v2/project/${pid}/task/${t1.id}/comment/${cid}`)).status).toBe(200);
    // an author cannot claim another identity
    const fake = await B.call("POST", `/api/v2/project/${pid}/task/${t1.id}/comment`, { text: "x", userProfile: { userId: String(A.id), name: "Admin" } });
    expect(fake.json.userProfile.userId).toBe(String(B.id));
  });

  test("changes by one member reach the others as an activity notification", async () => {
    await share(A, pid, B);
    await B.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "2 milk" }] });
    const n = (await notes(A)).find((x) => x.type === "change");
    expect(n).toMatchObject({ category: "activity", title: 'Bea changed 1 task in "Groceries"' });
    expect((await notes(B)).find((x) => x.type === "change")).toBeUndefined();
  });
});

describe("the collaboration switch", () => {
  test("off: shares turn read-only and new shares are refused; on: rights come back; nothing is deleted", async () => {
    await share(A, pid, B);
    const cp = (await check(B)).checkPoint;
    expect((await A.call("PUT", "/api/admin/settings", { collaboration: false })).json.settings.collaboration).toBe(false);
    const d = await check(B, cp);
    expect(d.projectProfiles.find((p: any) => p.id === pid)).toMatchObject({ permission: "read", sharedPermission: "write", collaborationPaused: true });
    expect((await B.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "nope" }] })).json.id2error[t1.id]).toBe("NO_PROJECT_PERMISSION");
    expect((await B.call("POST", `/api/v2/project/${pid}/task/${t1.id}/comment`, { text: "x" })).status).toBe(403);
    expect((await share(A, pid, C)).status).toBe(403);
    expect((await A.call("POST", "/api/v2/task/assign", { taskId: t1.id, assignee: B.id })).status).toBe(400);
    expect((await B.call("GET", "/api/v2/share/contacts")).json).toEqual([]);
    expect((await B.call("GET", `/api/v2/task/${t1.id}`)).json.title).toBe("milk");
    // the owner keeps full control of their own list
    expect((await A.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "owner edit" }] })).json.id2etag[t1.id]).toBeTruthy();
    await A.call("PUT", "/api/admin/settings", { collaboration: true });
    expect((await B.call("POST", "/api/v2/batch/task", { update: [{ ...t1, title: "back" }] })).json.id2etag[t1.id]).toBeTruthy();
    expect((await check(B)).projectProfiles.find((p: any) => p.id === pid).permission).toBe("write");
  });

  test("only an admin can flip the switch or change the member cap", async () => {
    expect((await B.call("PUT", "/api/admin/settings", { collaboration: false })).status).toBe(403);
    expect((await A.call("PUT", "/api/admin/settings", { maxUsers: 0 })).status).toBe(400);
  });
});

describe("members admin", () => {
  test("remove keeps the data, delete-data needs remove first and a typed confirm", async () => {
    await share(A, pid, B);
    const fileB = m.sys!.user(B.id)!.dbFile;
    expect((await A.call("POST", `/api/admin/members/${B.id}/remove`, {})).status).toBe(400);
    expect((await A.call("POST", `/api/admin/members/${B.id}/delete-data`, { confirm: "bea@example.com" })).status).toBe(400);
    const r = await A.call("POST", `/api/admin/members/${B.id}/remove`, { confirm: "bea@example.com" });
    expect(r.json.users.find((u: any) => u.userId === B.id).status).toBe("removed");
    expect(existsSync(fileB)).toBe(true);
    expect(m.sys!.sharesOfProject(pid)).toEqual([]);
    expect((await A.call("POST", `/api/admin/members/${B.id}/delete-data`, { confirm: "wrong@example.com" })).status).toBe(400);
    expect((await A.call("POST", `/api/admin/members/${B.id}/delete-data`, { confirm: "bea@example.com" })).status).toBe(200);
    expect(existsSync(fileB)).toBe(false);
    expect(m.sys!.user(B.id)).toBeUndefined();
    expect((await A.call("POST", `/api/admin/members/${A.id}/disable`)).status).toBe(400);
  });

  test("allowlist and password invites", async () => {
    const r = await A.call("POST", "/api/admin/allowlist", { email: "New@Example.com" });
    expect(r.json.allowlist.map((a: any) => a.email)).toContain("new@example.com");
    expect(r.json.inviteCode).toMatch(/^[\w-]{20,}$/);
    expect((await m.anon("POST", "/api/auth/password/join", { email: "new@example.com", code: "wrong", password: "longenough" })).status).toBe(403);
    const j = await m.anon("POST", "/api/auth/password/join", { email: "new@example.com", code: r.json.inviteCode, password: "longenough", name: "Newt" });
    expect(j.status).toBe(200);
    expect(j.json).toMatchObject({ email: "new@example.com", role: "member" });
    // the code works once
    expect((await m.anon("POST", "/api/auth/password/join", { email: "new@example.com", code: r.json.inviteCode, password: "longenough" })).status).toBe(403);
    const s = await m.anon("POST", "/api/v2/user/signon", { username: "new@example.com", password: "longenough" });
    expect(s.status).toBe(200);
    expect((await A.call("DELETE", "/api/admin/allowlist/new%40example.com")).json.allowlist.map((a: any) => a.email)).not.toContain("new@example.com");
    expect((await A.call("POST", "/api/admin/allowlist", { email: "not an email" })).status).toBe(400);
  });
});
