import { randomBytes } from "node:crypto";
import {
  BatchError,
  NotificationCategory,
  formatServerDate,
  isPlainObject,
  type BatchCheckResponse,
  type BatchResponse,
  type Comment,
  type Loose,
  type Project,
  type Task,
} from "@noortasks/core";
import type { TenantHooks } from "./app.js";
import { currentActor } from "./actor.js";
import { ApiError, type Service } from "./service.js";
import { globalSeq, type Store } from "./store.js";
import { buildCheck } from "./sync.js";
import type { Tenants } from "./tenants.js";
import { PERMISSIONS, permRank, type Permission, type ShareRow, type SystemStore, type UserRow } from "./system.js";

/**
 * Shared lists across per-account stores.
 *
 * A shared list and its tasks live only in the owner's store. Members read them through their own delta
 * (`check` merges the owner's rows for every list shared with them) and write them through `batchTask` and
 * friends, which route each task to the store that owns it after a permission check. Every change stamp
 * comes from one process-wide counter, so a single checkpoint covers all stores.
 *
 * Collaboration switched off by the admin: existing shares become read-only (nothing is deleted, nothing is
 * hidden from members who already had the list); new shares and assignments are refused. Turning it back on
 * restores the stored permissions.
 */

type Access = { ownerId: number; perm: Permission | "owner" };
type Located = Access & { projectId: string };

const emptyResult = (): BatchResponse => ({ id2etag: {}, id2error: {} });
const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const COLLAB_KEY = "collaboration";

export class Collab {
  constructor(
    private sys: SystemStore,
    private tenants: Tenants,
  ) {}

  enabled(): boolean {
    return this.sys.setting<boolean>(COLLAB_KEY, true);
  }
  setEnabled(on: boolean): void {
    this.sys.setSetting(COLLAB_KEY, on);
  }

  private svcOf(userId: number): Service {
    return this.tenants.get(userId).svc;
  }
  private storeOf(userId: number): Store {
    return this.tenants.get(userId).store;
  }

  private ownerActive(ownerId: number): boolean {
    return this.sys.user(ownerId)?.status === "active";
  }

  /** The permission a member really has: read-only while collaboration is off or the owner is not active. */
  effective(s: ShareRow): Permission {
    if (!this.enabled() || !this.ownerActive(s.ownerId)) return "read";
    return s.permission;
  }

  private ownsProject(userId: number, projectId: string): boolean {
    const svc = this.svcOf(userId);
    return projectId === svc.inboxId || svc.store.collGet("projects", projectId) !== undefined;
  }

  /** Who stores list `projectId` for `userId`, and what `userId` may do there. */
  access(userId: number, projectId: string): Access | undefined {
    if (this.ownsProject(userId, projectId)) return { ownerId: userId, perm: "owner" };
    const s = this.sys.shareFor(projectId, userId);
    if (!s || s.status !== "active" || !this.sys.user(s.ownerId)) return undefined;
    if (!this.storeOf(s.ownerId).collGet("projects", projectId)) return undefined;
    return { ownerId: s.ownerId, perm: this.effective(s) };
  }

  /** Finds a task id in the user's own store or in a list shared with the user. */
  locate(userId: number, taskId: string): Located | undefined {
    const own = this.storeOf(userId).getTaskRow(taskId);
    if (own) return { ownerId: userId, perm: "owner", projectId: own.projectId };
    for (const s of this.sys.sharesOfMember(userId)) {
      if (s.status !== "active" || !this.sys.user(s.ownerId)) continue;
      const row = this.storeOf(s.ownerId).getTaskRow(taskId);
      if (row && row.projectId === s.projectId) return { ownerId: s.ownerId, perm: this.effective(s), projectId: s.projectId };
    }
    return undefined;
  }

  /** Finds an attachment id in the user's own store or in a list shared with the user. */
  locateAttachment(userId: number, attachmentId: string): Located | undefined {
    const own = this.storeOf(userId).get<{ taskId: string; projectId: string; taskSet: string | null }>(
      "select taskId, projectId, taskSet from attachments where id = ?",
      attachmentId,
    );
    if (own) return { ownerId: userId, perm: "owner", projectId: own.projectId };
    for (const s of this.sys.sharesOfMember(userId)) {
      if (s.status !== "active" || !this.ownerActive(s.ownerId)) continue;
      const ost = this.storeOf(s.ownerId);
      const row = ost.get<{ taskId: string; projectId: string; taskSet: string | null }>(
        "select taskId, projectId, taskSet from attachments where id = ?",
        attachmentId,
      );
      if (!row || row.taskSet === "countdown") continue;
      const taskRow = ost.getTaskRow(row.taskId);
      if (!taskRow || taskRow.deleted || taskRow.projectId !== s.projectId) continue;
      if (!ost.collGet("projects", s.projectId)) continue;
      return { ownerId: s.ownerId, perm: this.effective(s), projectId: s.projectId };
    }
    return undefined;
  }

  /** True if another active account owns this attachment id (non-members get 403 rather than 404). */
  attachmentExistsElsewhere(userId: number, attachmentId: string): boolean {
    for (const u of this.sys.users()) {
      if (u.id === userId || u.status !== "active") continue;
      const hit = this.storeOf(u.id).get("select 1 from attachments where id = ?", attachmentId);
      if (hit) return true;
    }
    return false;
  }

  /** Owner plus active members of a list (user ids). */
  membersOf(ownerId: number, projectId: string): number[] {
    return [ownerId, ...this.sys.sharesOfProject(projectId).filter((s) => s.ownerId === ownerId).map((s) => s.memberId)];
  }
  isShared(ownerId: number, projectId: string): boolean {
    return this.sys.sharesOfProject(projectId).some((s) => s.ownerId === ownerId);
  }

  // ------------------------------------------------------------------ notifications

  notify(to: number, n: { title: string; type: string; data?: Loose; activity?: boolean }): void {
    const u = this.sys.user(to);
    if (!u || u.status !== "active") return;
    const actor = currentActor();
    this.tenants.get(to).reminders.addNotification({
      title: n.title,
      type: n.type,
      data: { ...(n.data ?? {}), ...(actor ? { userDisplayName: actor.name, userCode: String(actor.userId) } : {}) },
      category: n.activity ? NotificationCategory.Activity : NotificationCategory.Notification,
    });
  }

  // ------------------------------------------------------------------ delta

  private decorateOwn(p: Project, ownerId: number): Project {
    const n = this.sys.sharesOfProject(p.id).filter((s) => s.ownerId === ownerId).length;
    return n > 0 ? { ...p, isOwner: true, userCount: n + 1, permission: "write", collaborationPaused: !this.enabled() } : p;
  }
  private decorateShared(p: Project, s: ShareRow): Project {
    const owner = this.sys.user(s.ownerId);
    const n = this.sys.sharesOfProject(p.id).filter((x) => x.ownerId === s.ownerId).length;
    // a member files the shared list in their own sidebar: the owner's folder id means nothing to them
    return {
      ...p,
      groupId: null,
      isOwner: false,
      userCount: n + 1,
      permission: this.effective(s),
      sharedPermission: s.permission,
      collaborationPaused: !this.enabled(),
      ownerId: s.ownerId,
      ownerName: owner?.name || owner?.email || "",
    };
  }

  check(userId: number, svc: Service, cp: number): BatchCheckResponse {
    const out = buildCheck(svc, cp) as BatchCheckResponse & Loose;
    const full = cp <= 0;
    const switchSeq = this.sys.settingSeq(COLLAB_KEY);
    const store = svc.store;

    // owner side: decorate own shared lists; re-send a list whose share set or the switch changed
    const ownShares = this.sys.sharesOfOwner(userId);
    const changedOwn = new Set(ownShares.filter((s) => full || s.seq > cp || switchSeq > cp).map((s) => s.projectId));
    const profiles: Project[] = (out.projectProfiles ?? []).map((p) => this.decorateOwn(p, userId));
    const listed = new Set(profiles.map((p) => p.id));
    for (const pid of changedOwn) {
      if (listed.has(pid)) continue;
      const p = store.collGet<Project>("projects", pid);
      if (p) {
        profiles.push(this.decorateOwn(p, userId));
        listed.add(pid);
      }
    }

    // member side
    const add: Task[] = [];
    const update: Task[] = [];
    const removedTasks = new Set<string>();
    const revoked = new Set<string>();
    for (const s of this.sys.sharesOfMember(userId)) {
      const pid = s.projectId;
      if (s.ownerId === userId) continue;
      if (s.status !== "active" || !this.sys.user(s.ownerId)) {
        if (!full && s.seq > cp) revoked.add(pid);
        continue;
      }
      const ost = this.storeOf(s.ownerId);
      const proj = ost.collGet<Project>("projects", pid);
      if (!proj) {
        if (!full) revoked.add(pid);
        continue;
      }
      const fresh = full || s.seq > cp || switchSeq > cp;
      const projSeq = ost.get<{ seq: number }>("select seq from projects where id = ?", pid)?.seq ?? 0;
      if (fresh || projSeq > cp) {
        profiles.push(this.decorateShared(proj, s));
        listed.add(pid);
      }
      if (fresh) {
        for (const r of ost.all<{ json: string }>("select json from tasks where projectId = ? and deleted = 0 and status = 0 order by pos", pid)) {
          (full ? update : add).push(JSON.parse(r.json) as Task);
        }
        // a re-sent list also carries its recently closed tasks so a member's open copies do not linger
        if (!full) {
          for (const r of ost.all<{ json: string }>("select json from tasks where projectId = ? and deleted = 0 and status != 0 and seq > ?", pid, cp)) {
            update.push(JSON.parse(r.json) as Task);
          }
        }
        continue;
      }
      for (const r of ost.all<{ id: string; deleted: number; createSeq: number; json: string }>(
        "select id, deleted, createSeq, json from tasks where projectId = ? and seq > ? order by pos",
        pid,
        cp,
      )) {
        if (r.deleted) removedTasks.add(r.id);
        else (r.createSeq > cp ? add : update).push(JSON.parse(r.json) as Task);
      }
      for (const t of ost.tombstonesSince("task", cp)) if (t.extra?.projectId === pid) removedTasks.add(t.id);
      for (const t of ost.tombstonesSince("taskMove", cp)) {
        if (t.extra?.from !== pid) continue;
        const now = ost.getTaskRow(t.id);
        if (!now || now.projectId === pid) continue;
        if (this.access(userId, now.projectId)) continue;
        removedTasks.add(t.id);
      }
    }

    // never revoke or delete what the same delta (re)sends: ownership transfers produce both
    for (const pid of listed) revoked.delete(pid);
    for (const pid of [...revoked]) if (this.ownsProject(userId, pid)) revoked.delete(pid);
    const sent = new Set([...add, ...update].map((t) => t.id));
    for (const id of sent) removedTasks.delete(id);

    const bean = out.syncTaskBean!;
    bean.add = [...(bean.add ?? []), ...add];
    bean.update = [...(bean.update ?? []), ...update];
    bean.delete = (bean.delete ?? []).filter((d) => !sent.has(d.taskId));
    bean.empty = bean.add.length + bean.update.length + bean.delete.length === 0 && removedTasks.size === 0;
    out.projectProfiles = profiles.length || full ? profiles : null;
    if (Array.isArray(out.deletedProjects)) {
      out.deletedProjects = (out.deletedProjects as string[]).filter((id) => !listed.has(id));
      if (!(out.deletedProjects as string[]).length) delete out.deletedProjects;
    }
    if (revoked.size) out.revokedProjects = [...revoked];
    if (removedTasks.size) out.removedTasks = [...removedTasks];
    // every store allocates from one counter: anything written after this read gets a larger stamp
    out.checkPoint = Math.max(globalSeq.last, cp);
    return out;
  }

  // ------------------------------------------------------------------ writes

  private checkAssignee(ownerId: number, projectId: string, t: Loose): boolean {
    if (!("assignee" in t)) return true;
    const a = t.assignee;
    if (a === null || a === undefined || a === "" || Number(a) <= 0) return true;
    if (!this.isShared(ownerId, projectId)) return Number(a) === ownerId;
    if (!this.enabled()) return false;
    const target = this.sys.user(Number(a));
    if (!target || target.status !== "active" || target.collabOptOut) return false;
    return this.membersOf(ownerId, projectId).includes(Number(a));
  }

  private mergeRes(into: BatchResponse, r: BatchResponse): void {
    Object.assign(into.id2etag, r.id2etag ?? {});
    Object.assign(into.id2error, r.id2error ?? {});
  }

  batchTask(userId: number, svc: Service, body: unknown): BatchResponse {
    const b = isPlainObject(body) ? body : {};
    const res = emptyResult();
    type Group = { add: Loose[]; update: Loose[]; delete: Array<Loose | string>; addAttachments: Loose[]; updateAttachments: Loose[]; deleteAttachments: Loose[] };
    const groups = new Map<number, Group>();
    const group = (owner: number): Group => {
      let g = groups.get(owner);
      if (!g) groups.set(owner, (g = { add: [], update: [], delete: [], addAttachments: [], updateAttachments: [], deleteAttachments: [] }));
      return g;
    };
    const canWrite = (a: Access | undefined): boolean => !!a && (a.perm === "owner" || a.perm === "write");

    for (const t of asList(b.add)) {
      if (!isPlainObject(t) || typeof t.id !== "string") continue;
      const a = typeof t.projectId === "string" ? this.access(userId, t.projectId) : undefined;
      if (!a) {
        group(userId).add.push(t);
        continue;
      }
      if (!canWrite(a)) res.id2error[t.id] = BatchError.NoProjectPermission;
      else if (!this.checkAssignee(a.ownerId, t.projectId as string, t)) res.id2error[t.id] = "INVALID_ASSIGNEE";
      else if (a.ownerId !== userId && typeof t.parentId === "string" && t.parentId && this.storeOf(a.ownerId).getTaskRow(t.parentId)?.projectId !== t.projectId) {
        // a member may only nest under a task of the same shared list, never under the owner's private tasks
        res.id2error[t.id] = BatchError.NoProjectPermission;
      } else if (a.ownerId !== userId && this.storeOf(a.ownerId).getTaskRow(t.id)) res.id2error[t.id] = BatchError.Existed;
      else group(a.ownerId).add.push(t);
    }
    for (const t of asList(b.update)) {
      if (!isPlainObject(t) || typeof t.id !== "string") continue;
      const loc = this.locate(userId, t.id);
      if (!loc) {
        group(userId).update.push(t);
        continue;
      }
      if (!canWrite(loc)) res.id2error[t.id] = BatchError.NoProjectPermission;
      else if (!this.checkAssignee(loc.ownerId, loc.projectId, t)) res.id2error[t.id] = "INVALID_ASSIGNEE";
      else group(loc.ownerId).update.push(t);
    }
    for (const d of asList(b.delete)) {
      const id = typeof d === "string" ? d : isPlainObject(d) && typeof d.taskId === "string" ? d.taskId : undefined;
      if (!id) continue;
      const loc = this.locate(userId, id);
      if (!loc) {
        group(userId).delete.push(d as Loose | string);
        continue;
      }
      if (!canWrite(loc)) res.id2error[id] = BatchError.NoProjectPermission;
      else group(loc.ownerId).delete.push(d as Loose | string);
    }
    // attachment metadata: only on the caller's own tasks (attachments in shared lists are not supported yet)
    for (const key of ["addAttachments", "updateAttachments", "deleteAttachments"] as const) {
      for (const raw of asList(b[key])) {
        if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
        const loc = this.locate(userId, raw.id);
        if (loc && loc.ownerId !== userId) res.id2error[raw.id] = BatchError.NoProjectPermission;
        else group(userId)[key].push(raw);
      }
    }

    for (const [ownerId, g] of groups) {
      const ost = ownerId === userId ? svc.store : this.storeOf(ownerId);
      const before = new Map<string, Task>();
      for (const t of g.update) {
        const old = ost.getTask(String(t.id));
        if (old) before.set(old.id, old);
      }
      const r = (ownerId === userId ? svc : this.svcOf(ownerId)).batchTask(g);
      this.mergeRes(res, r);
      this.afterWrite(ownerId, ost, g, before, r);
    }
    return res;
  }

  /** Assignment notifications, and one activity notification per list for the other members. */
  private afterWrite(ownerId: number, ost: Store, g: { add: Loose[]; update: Loose[]; delete: Array<Loose | string> }, before: Map<string, Task>, r: BatchResponse): void {
    const actor = currentActor();
    const actorId = actor?.userId ?? ownerId;
    const touched = new Map<string, number>();
    const done = (id: string): boolean => !(id in (r.id2error ?? {}));
    for (const t of [...g.add, ...g.update]) {
      const id = String(t.id);
      if (!done(id)) continue;
      const cur = ost.getTask(id);
      if (!cur || !this.isShared(ownerId, cur.projectId)) continue;
      touched.set(cur.projectId, (touched.get(cur.projectId) ?? 0) + 1);
      const was = before.get(id)?.assignee;
      const now = cur.assignee;
      if (now !== undefined && now !== null && Number(now) > 0 && String(now) !== String(was ?? "") && Number(now) !== actorId) {
        this.notify(Number(now), {
          type: "assign",
          title: `${actor?.name ?? "Someone"} assigned you "${cur.title ?? ""}"`,
          data: { taskId: id, projectId: cur.projectId, entityType: "task", entityId: id, title: cur.title ?? "" },
        });
      }
    }
    for (const d of g.delete) {
      const id = typeof d === "string" ? d : String(d.taskId);
      const pid = ost.getTaskRow(id)?.projectId;
      if (pid && done(id) && this.isShared(ownerId, pid)) touched.set(pid, (touched.get(pid) ?? 0) + 1);
    }
    for (const [pid, n] of touched) {
      const name = ost.collGet<Project>("projects", pid)?.name ?? "";
      for (const m of this.membersOf(ownerId, pid)) {
        if (m === actorId) continue;
        this.notify(m, {
          type: "change",
          activity: true,
          title: `${actor?.name ?? "Someone"} changed ${n} task${n === 1 ? "" : "s"} in "${name}"`,
          data: { projectId: pid, entityType: "project", entityId: pid, entityName: name },
        });
      }
    }
  }

  batchTaskParent(userId: number, svc: Service, body: unknown): BatchResponse {
    const res = emptyResult();
    const groups = new Map<number, unknown[]>();
    for (const it of asList(body)) {
      if (!isPlainObject(it) || typeof it.taskId !== "string") continue;
      const loc = this.locate(userId, it.taskId);
      const owner = loc?.ownerId ?? userId;
      if (loc && loc.perm !== "owner" && loc.perm !== "write") {
        res.id2error[it.taskId] = BatchError.NoProjectPermission;
        continue;
      }
      if (typeof it.parentId === "string" && it.parentId) {
        const p = this.locate(userId, it.parentId);
        if (!p || p.ownerId !== owner || (p.ownerId !== userId && p.perm !== "write")) {
          res.id2error[it.taskId] = p ? BatchError.ProjectMoveError : BatchError.NotExisted;
          continue;
        }
      }
      (groups.get(owner) ?? groups.set(owner, []).get(owner)!).push(it);
    }
    for (const [owner, items] of groups) this.mergeRes(res, (owner === userId ? svc : this.svcOf(owner)).batchTaskParent(items));
    return res;
  }

  batchTaskProject(userId: number, svc: Service, body: unknown): BatchResponse {
    const res = emptyResult();
    const items = Array.isArray(body) ? body : isPlainObject(body) ? asList(body.items ?? body.tasks) : [];
    const groups = new Map<number, unknown[]>();
    for (const it of items) {
      if (!isPlainObject(it) || typeof it.taskId !== "string" || typeof it.toProjectId !== "string") continue;
      const src = this.locate(userId, it.taskId);
      const dst = this.access(userId, it.toProjectId);
      if (!src || !dst) {
        (groups.get(userId) ?? groups.set(userId, []).get(userId)!).push(it);
        continue;
      }
      const w = (a: Access): boolean => a.perm === "owner" || a.perm === "write";
      if (!w(src) || !w(dst)) {
        res.id2error[it.taskId] = BatchError.NoProjectPermission;
        continue;
      }
      if (src.ownerId === dst.ownerId) {
        (groups.get(src.ownerId) ?? groups.set(src.ownerId, []).get(src.ownerId)!).push(it);
        continue;
      }
      const etag = this.moveAcross(src.ownerId, dst.ownerId, it.taskId, it.toProjectId);
      if (etag) res.id2etag[it.taskId] = etag;
      else res.id2error[it.taskId] = BatchError.Existed;
    }
    for (const [owner, list] of groups) this.mergeRes(res, (owner === userId ? svc : this.svcOf(owner)).batchTaskProject(list));
    return res;
  }

  /**
   * Moves a task (with its subtasks and comments) between two stores, e.g. from a private list into a list
   * shared by someone else. Attachment files stay where they were uploaded (documented gap).
   */
  private moveAcross(fromOwner: number, toOwner: number, taskId: string, toProjectId: string): string {
    const src = this.storeOf(fromOwner);
    const dst = this.storeOf(toOwner);
    const tree: Task[] = [];
    const walk = (id: string): void => {
      const t = src.getTask(id);
      if (!t) return;
      tree.push(t);
      for (const c of src.childrenOf(id)) walk(c.id);
    };
    walk(taskId);
    const root = tree[0];
    if (!root) throw new ApiError(404, "task_not_found");
    // never overwrite a row of the other account that happens to carry the same id
    if (tree.some((t) => dst.getTaskRow(t.id))) return "";
    const comments = tree.flatMap((t) => src.all<{ id: string; taskId: string; createdTime: string; json: string }>("select * from comments where taskId = ?", t.id));
    const now = formatServerDate();
    let etag = "";
    dst.tx(() => {
      const seq = dst.seq();
      for (const t of tree) {
        const copy: Task = { ...t, projectId: toProjectId, modifiedTime: now, etag: randomBytes(4).toString("hex") };
        delete copy.columnId;
        if (t.id === taskId) {
          delete copy.parentId;
          etag = copy.etag!;
        }
        dst.clearTombstone("task", t.id);
        dst.putTask(copy, { seq, createSeq: seq });
      }
      for (const c of comments) {
        if (dst.get("select 1 from comments where id = ?", c.id)) continue;
        const j = { ...(JSON.parse(c.json) as Loose), projectId: toProjectId };
        dst.run("insert into comments(id, taskId, projectId, createdTime, json) values (?,?,?,?,?)", c.id, c.taskId, toProjectId, c.createdTime, JSON.stringify(j));
      }
    });
    src.tx(() => {
      const seq = src.seq();
      if (root.parentId) {
        const p = src.getTask(root.parentId);
        if (p) {
          p.childIds = (p.childIds ?? []).filter((c) => c !== taskId);
          src.putTask(p, { seq });
        }
      }
      for (const t of tree) {
        src.run("delete from comments where taskId = ?", t.id);
        src.deleteTaskRow(t.id);
        src.addTombstone("task", t.id, { projectId: t.projectId });
      }
    });
    return etag;
  }

  /** A list id the caller only has through a share (they must not make an own copy of it). */
  private sharedToMe(userId: number, projectId: unknown): boolean {
    return typeof projectId === "string" && !!this.sys.shareFor(projectId, userId) && !this.ownsProject(userId, projectId);
  }

  /** `batch/project`: list settings of a shared list belong to its owner; a member's own store never gets a copy. */
  batchProject(userId: number, svc: Service, body: unknown): BatchResponse {
    const b = isPlainObject(body) ? body : {};
    const res = emptyResult();
    const keep = (raw: unknown): boolean => {
      const id = typeof raw === "string" ? raw : isPlainObject(raw) ? raw.id : undefined;
      if (!this.sharedToMe(userId, id)) return true;
      res.id2error[String(id)] = BatchError.NoProjectPermission;
      return false;
    };
    this.mergeRes(res, svc.batchProject({ ...b, add: asList(b.add).filter(keep), update: asList(b.update).filter(keep), delete: asList(b.delete).filter(keep) }));
    return res;
  }

  /** `batch/columnProject`: sections of someone else's list cannot be created in the member's own store. */
  batchColumn(userId: number, svc: Service, body: unknown): BatchResponse {
    const b = isPlainObject(body) ? body : {};
    const res = emptyResult();
    const keep = (raw: unknown): boolean => {
      if (!isPlainObject(raw) || !this.sharedToMe(userId, raw.projectId)) return true;
      res.id2error[String(raw.id ?? raw.columnId ?? "")] = BatchError.NoProjectPermission;
      return false;
    };
    this.mergeRes(res, svc.batchColumn({ ...b, add: asList(b.add).filter(keep), update: asList(b.update).filter(keep), delete: asList(b.delete).filter(keep) }));
    return res;
  }

  getTask(userId: number, svc: Service, id: string): Task | undefined {
    const own = svc.store.getTask(id);
    if (own) return own;
    const loc = this.locate(userId, id);
    return loc ? this.storeOf(loc.ownerId).getTask(id) : undefined;
  }

  onComment(ownerSvc: Service, task: Task, comment: Comment): void {
    const ownerId = ownerSvc.userId;
    if (!this.isShared(ownerId, task.projectId)) return;
    const actor = currentActor();
    const actorId = actor?.userId ?? ownerId;
    const members = this.membersOf(ownerId, task.projectId);
    const text = String(comment.text ?? "").toLowerCase();
    const explicit = new Set(asList((comment as Loose).mentions).map((x) => Number(x)));
    for (const m of members) {
      if (m === actorId) continue;
      const u = this.sys.user(m);
      if (!u) continue;
      const handles = [u.name, u.email, u.email.split("@")[0]!].filter(Boolean).map((h) => `@${h.toLowerCase()}`);
      const mentioned = explicit.has(m) || handles.some((h) => text.includes(h));
      this.notify(m, {
        type: mentioned ? "mention" : "comment",
        title: mentioned ? `${actor?.name ?? "Someone"} mentioned you on "${task.title ?? ""}"` : `${actor?.name ?? "Someone"} commented on "${task.title ?? ""}"`,
        data: { taskId: task.id, projectId: task.projectId, entityType: "task", entityId: task.id, title: task.title ?? "", commentId: comment.id },
      });
    }
  }

  hooksFor(userId: number, verifyPassword: (pw: string) => Promise<boolean>): TenantHooks {
    return {
      check: (svc, cp) => this.check(userId, svc, cp),
      batchTask: (svc, body) => this.batchTask(userId, svc, body),
      batchTaskProject: (svc, body) => this.batchTaskProject(userId, svc, body),
      batchTaskParent: (svc, body) => this.batchTaskParent(userId, svc, body),
      getTask: (svc, id) => this.getTask(userId, svc, id),
      batchProject: (svc, body) => this.batchProject(userId, svc, body),
      batchColumn: (svc, body) => this.batchColumn(userId, svc, body),
      onComment: (svc, task, comment) => this.onComment(svc, task, comment),
      verifyPassword,
    };
  }

  // ------------------------------------------------------------------ share management (owner and members)

  private requireOn(): void {
    if (!this.enabled()) throw new ApiError(403, "collaboration_off");
  }

  /** Members visible to `me` for sharing and assigning: active, not opted out, not me. */
  contacts(me: UserRow): Array<{ userId: number; name: string; email: string; picture: string | null }> {
    if (!this.enabled() || me.collabOptOut) return [];
    return this.sys
      .users()
      .filter((u) => u.id !== me.id && u.status === "active" && !u.collabOptOut)
      .map((u) => ({ userId: u.id, name: u.name || u.email, email: u.email, picture: u.picture }));
  }

  /** Owner row first, then members; visible to the owner and to members of the list. */
  listShares(me: UserRow, projectId: string): Loose[] {
    const a = this.access(me.id, projectId);
    if (!a) throw new ApiError(404, "project_not_found");
    const owner = this.sys.user(a.ownerId)!;
    const rows: Loose[] = [{ id: `owner-${owner.id}`, userId: owner.id, name: owner.name || owner.email, email: owner.email, picture: owner.picture, permission: "owner", isOwner: true }];
    for (const s of this.sys.sharesOfProject(projectId)) {
      if (s.ownerId !== a.ownerId) continue;
      const u = this.sys.user(s.memberId);
      if (!u) continue;
      rows.push({ id: s.id, userId: u.id, name: u.name || u.email, email: u.email, picture: u.picture, permission: s.permission, effectivePermission: this.effective(s), isOwner: false });
    }
    return rows;
  }

  private requireOwner(me: UserRow, projectId: string): void {
    const svc = this.svcOf(me.id);
    if (projectId === svc.inboxId) throw new ApiError(400, "inbox_not_shareable");
    if (!svc.store.collGet("projects", projectId)) throw new ApiError(403, "not_owner");
  }

  shareProject(me: UserRow, projectId: string, body: unknown): Loose[] {
    this.requireOn();
    if (me.collabOptOut) throw new ApiError(403, "collaboration_opted_out");
    this.requireOwner(me, projectId);
    const b = isPlainObject(body) ? body : {};
    const perm = (typeof b.permission === "string" ? b.permission : "write") as Permission;
    if (!PERMISSIONS.includes(perm)) throw new ApiError(400, "invalid_permission");
    const target =
      typeof b.userId === "number" || typeof b.userId === "string" ? this.sys.user(Number(b.userId)) : typeof b.email === "string" ? this.sys.userByEmail(b.email) : undefined;
    if (!target || target.id === me.id || target.status !== "active" || target.collabOptOut) throw new ApiError(404, "member_not_found");
    const p = this.storeOf(me.id).collGet<Project>("projects", projectId)!;
    const existing = this.sys.shareFor(projectId, target.id);
    this.sys.putShare({ id: existing?.id ?? randomBytes(12).toString("hex"), projectId, ownerId: me.id, memberId: target.id, permission: perm, status: "active", createdMs: existing?.createdMs ?? Date.now() });
    this.touchProject(me.id, projectId);
    this.notify(target.id, {
      type: "share",
      title: `${me.name || me.email} shared "${p.name}" with you`,
      data: { projectId, entityType: "project", entityId: projectId, entityName: p.name, permission: perm },
    });
    return this.listShares(me, projectId);
  }

  setPermission(me: UserRow, projectId: string, shareId: string, permission: string): Loose[] {
    this.requireOn();
    this.requireOwner(me, projectId);
    if (!PERMISSIONS.includes(permission as Permission)) throw new ApiError(400, "invalid_permission");
    const s = this.sys.share(shareId);
    if (!s || s.projectId !== projectId || s.ownerId !== me.id || s.status !== "active") throw new ApiError(404, "share_not_found");
    this.sys.touchShare(s.id, { permission: permission as Permission });
    return this.listShares(me, projectId);
  }

  /** The owner removes a member, or a member leaves. Nothing in the list is deleted. */
  removeShare(me: UserRow, projectId: string, shareId: string): { ok: true } {
    const s = this.sys.share(shareId);
    if (!s || s.projectId !== projectId || s.status !== "active") throw new ApiError(404, "share_not_found");
    if (s.ownerId !== me.id && s.memberId !== me.id) throw new ApiError(403, "no_permission");
    this.sys.touchShare(s.id, { status: "removed" });
    this.touchProject(s.ownerId, projectId);
    return { ok: true };
  }

  /** The owner hands the list to a member: the list, its tasks, sections, comments and history move stores. */
  transfer(me: UserRow, projectId: string, toUserId: number): { ok: true } {
    this.requireOn();
    this.requireOwner(me, projectId);
    const s = this.sys.shareFor(projectId, toUserId);
    if (!s || s.ownerId !== me.id || s.status !== "active") throw new ApiError(404, "member_not_found");
    const src = this.storeOf(me.id);
    const dst = this.storeOf(toUserId);
    const proj = src.collGet<Project>("projects", projectId)!;
    const tasks = src.all<{ id: string; json: string }>("select id, json from tasks where projectId = ?", projectId);
    const cols = src.collAll<Loose>("columns").filter((c) => c.projectId === projectId);
    const comments = src.all<{ id: string; taskId: string; createdTime: string; json: string }>("select * from comments where projectId = ?", projectId);
    const acts = src.all<{ id: string; taskId: string | null; action: string; whenMs: number; json: string }>("select * from activities where projectId = ?", projectId);
    // the new owner's own rows are never overwritten by an id that happens to match
    const clash =
      !!dst.collGet("projects", projectId) ||
      tasks.some((t) => dst.getTaskRow(t.id)) ||
      cols.some((c) => dst.collGet("columns", String(c.id))) ||
      comments.some((c) => dst.get("select 1 from comments where id = ?", c.id));
    if (clash) throw new ApiError(409, "id_conflict");
    dst.tx(() => {
      const seq = dst.seq();
      dst.clearTombstone("project", projectId);
      dst.collPut("projects", projectId, { ...proj, groupId: null }, { seq });
      for (const c of cols) dst.collPut("columns", String(c.id), c, { seq });
      for (const t of tasks) {
        dst.clearTombstone("task", t.id);
        dst.putTask(JSON.parse(t.json) as Task, { seq, createSeq: seq });
      }
      for (const c of comments) dst.run("insert or replace into comments(id, taskId, projectId, createdTime, json) values (?,?,?,?,?)", c.id, c.taskId, projectId, c.createdTime, c.json);
      for (const a of acts) dst.run("insert or replace into activities(id, taskId, projectId, action, whenMs, json) values (?,?,?,?,?,?)", a.id, a.taskId, projectId, a.action, a.whenMs, a.json);
    });
    src.tx(() => {
      for (const t of tasks) {
        src.deleteTaskRow(t.id);
        src.addTombstone("task", t.id, { projectId });
      }
      for (const c of cols) {
        src.collDelete("columns", String(c.id));
        src.addTombstone("column", String(c.id), { projectId });
      }
      src.run("delete from comments where projectId = ?", projectId);
      src.run("delete from activities where projectId = ?", projectId);
      src.collDelete("projects", projectId);
      src.addTombstone("project", projectId);
    });
    // the old owner keeps edit rights; every other member follows the list to its new owner
    for (const other of this.sys.sharesOfProject(projectId, true)) {
      if (other.ownerId !== me.id) continue;
      if (other.memberId === toUserId) this.sys.run("delete from shares where id = ?", other.id);
      else this.sys.touchShare(other.id, { ownerId: toUserId });
    }
    this.sys.putShare({ id: randomBytes(12).toString("hex"), projectId, ownerId: toUserId, memberId: me.id, permission: "write", status: "active", createdMs: Date.now() });
    this.notify(toUserId, { type: "share", title: `${me.name || me.email} made you the owner of "${proj.name}"`, data: { projectId, entityType: "project", entityId: projectId, entityName: proj.name } });
    return { ok: true };
  }

  /** `POST /api/v2/task/assign {taskId, assignee}`: goes through the same permission and member checks as a batch update. */
  assign(me: UserRow, body: unknown): BatchResponse {
    const b = isPlainObject(body) ? body : {};
    if (typeof b.taskId !== "string") throw new ApiError(400, "invalid_task");
    const loc = this.locate(me.id, b.taskId);
    if (!loc) throw new ApiError(404, "task_not_found");
    const t = this.storeOf(loc.ownerId).getTask(b.taskId)!;
    const assignee = b.assignee === null || b.assignee === undefined ? null : Number(b.assignee);
    const r = this.batchTask(me.id, this.svcOf(me.id), { update: [{ ...t, assignee }] });
    if (r.id2error[b.taskId]) throw new ApiError(r.id2error[b.taskId] === "INVALID_ASSIGNEE" ? 400 : 403, String(r.id2error[b.taskId]).toLowerCase());
    return r;
  }

  /** Bumps a list's change stamp so every member's next delta re-reads it. */
  private touchProject(ownerId: number, projectId: string): void {
    const st = this.storeOf(ownerId);
    const p = st.collGet<Loose>("projects", projectId);
    if (p) st.tx(() => st.collPut("projects", projectId, p, { seq: st.seq() }));
  }

  /** Admin removed or deleted an account: its shares stop (rows kept as removed so deltas report it). */
  dropUserShares(userId: number): void {
    for (const s of [...this.sys.sharesOfMember(userId), ...this.sys.sharesOfOwner(userId)]) if (s.status === "active") this.sys.touchShare(s.id, { status: "removed" });
  }

  rank = permRank;
}
