import { LEGACY_FIELDS, mergeUpdate } from "./fieldSync.js";
import { rmSync } from "node:fs";
import {
  ActivityAction,
  BatchError,
  CLOSED_PAGE_SIZE,
  MAX_TASK_DEPTH,
  TRASH_PAGE_SIZE,
  TaskStatus,
  WEEKDAY_CODES,
  WEEK_START_BY_NAME,
  clampOrder,
  evaluateRule,
  formatServerDate,
  inboxIdFor,
  isPlainObject,
  isValidTimeZone,
  newEtag,
  newId,
  type BatchResponse,
  type FocusSummary,
  type Loose,
  type Project,
  type RuleTask,
  type Task,
} from "@noortasks/core";
import { completeRecurringTask } from "@noortasks/recurrence";
import type { ActivityService } from "./activity.js";
import { applyOrderBatch } from "./orders.js";
import type { CollName, Store, TaskRow } from "./store.js";

/** Fields the server owns on a task: kept from the stored copy when an update omits them. */
const SERVER_MANAGED = ["attachments", "parentId", "childIds", "commentCount", "createdTime", "creator", "deleted", "deletedTime", "deletedBy"] as const;

function nonNegNum(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Merge task focusSummaries: client supplies estimate fields; server retains counted focus stats. */
function mergeFocusSummaries(incoming: unknown, existing: FocusSummary[] | undefined, userId: number): FocusSummary[] | undefined {
  if (incoming === undefined) return existing;
  const prev0 = Array.isArray(existing) && isPlainObject(existing[0]) ? (existing[0] as Loose) : {};
  const pomoCount = nonNegNum(prev0.pomoCount);
  const pomoDuration = nonNegNum(prev0.pomoDuration);
  const stopwatchDuration = nonNegNum(prev0.stopwatchDuration);
  const focuses = Array.isArray(prev0.focuses) ? prev0.focuses : [];
  const hasCounted = pomoCount > 0 || pomoDuration > 0 || stopwatchDuration > 0 || focuses.length > 0;

  if (incoming === null) {
    if (!hasCounted) return undefined;
    return [{ ...prev0, userId, estimatedDuration: 0, estimatedPomo: 0, pomoCount, pomoDuration, stopwatchDuration, focuses }];
  }
  if (!Array.isArray(incoming)) return existing;
  if (incoming.length === 0) {
    if (!hasCounted) return [];
    return [{ ...prev0, userId, estimatedDuration: 0, estimatedPomo: 0, pomoCount, pomoDuration, stopwatchDuration, focuses }];
  }
  const in0 = isPlainObject(incoming[0]) ? incoming[0] : {};
  const estimatedDuration = nonNegNum(in0.estimatedDuration);
  const estimatedPomo = nonNegNum(in0.estimatedPomo);
  return [{ ...prev0, ...in0, userId, estimatedDuration, estimatedPomo, pomoCount, pomoDuration, stopwatchDuration, focuses }];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string,
    message?: string,
  ) {
    super(message ?? errorCode);
  }
}

function emptyResult(): BatchResponse {
  return { id2etag: {}, id2error: {} };
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export class Service {
  activity?: ActivityService;

  constructor(
    readonly store: Store,
    readonly opts: { dataDir?: string; now?: () => number } = {},
  ) {
    store.tx(() => {
      if (!store.getMeta("userId")) store.setMeta("userId", String(1 + Math.floor(Math.random() * 900_000_000)));
      if (!store.getMeta("inboxId")) store.setMeta("inboxId", inboxIdFor(store.getMeta("userId")!));
    });
  }

  attachActivity(act: ActivityService): void {
    this.activity = act;
  }

  /** Injected clock (tests); epoch ms. */
  now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
  /** Time zone and week start of the user, from the stored settings. */
  userCtx(): { tz: string; weekStart: number } {
    const s = (this.store.getDoc<Loose>("settings")?.json ?? {}) as Loose;
    const tz = isValidTimeZone(s.timeZone) ? s.timeZone : "UTC";
    const ws = typeof s.startDayOfWeek === "string" ? WEEK_START_BY_NAME[s.startDayOfWeek.toUpperCase()] : undefined;
    return { tz, weekStart: ws ?? 0 };
  }

  get userId(): number {
    return Number(this.store.getMeta("userId"));
  }
  get inboxId(): string {
    return this.store.getMeta("inboxId")!;
  }

  private projectExists(id: string): boolean {
    return id === this.inboxId || this.store.collGet("projects", id) !== undefined;
  }

  private touch(task: Task, now: string): void {
    task.etag = newEtag();
    task.modifiedTime = now;
  }

  // ------------------------------------------------------------------ tasks

  batchTask(body: unknown): BatchResponse {
    const res = emptyResult();
    const b = isPlainObject(body) ? body : {};
    this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.now());
      for (const raw of asList(b.add)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || typeof raw.projectId !== "string") continue;
        const id = raw.id;
        if (this.store.getTaskRow(id)) {
          res.id2error[id] = BatchError.Existed;
          continue;
        }
        if (!this.projectExists(raw.projectId)) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        const task = { ...raw } as Task;
        delete task.deleted;
        delete task.deletedTime;
        delete task.deletedBy;
        if (typeof task.status !== "number") task.status = TaskStatus.Open;
        if (typeof task.sortOrder !== "number") task.sortOrder = 0;
        else task.sortOrder = clampOrder(task.sortOrder);
        if (!task.createdTime) task.createdTime = now;
        if (task.creator === undefined) task.creator = this.userId;
        const addSummaries = mergeFocusSummaries((raw as Loose).focusSummaries, undefined, this.userId);
        if (addSummaries !== undefined) task.focusSummaries = addSummaries;
        else delete task.focusSummaries;
        this.fillCompleted(task, undefined, now);
        const parentId = typeof task.parentId === "string" ? task.parentId : undefined;
        delete task.parentId;
        this.touch(task, now);
        this.store.putTask(task, { seq });
        if (parentId) this.linkParent(task.id, parentId, seq, now);
        const saved = this.store.getTask(id)!;
        res.id2etag[id] = saved.etag!;
        this.activity?.recordTaskCreated(saved);
      }
      for (const raw of asList(b.update)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
        const id = raw.id;
        const row = this.store.getTaskRow(id);
        if (!row) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        if (row.deleted) {
          res.id2error[id] = BatchError.Deleted;
          continue;
        }
        if (typeof raw.projectId === "string" && raw.projectId !== row.projectId) {
          res.id2error[id] = BatchError.ProjectMoveError;
          continue;
        }
        const old = JSON.parse(row.json) as Task;
        const next = mergeUpdate(old, raw, LEGACY_FIELDS.task) as Task;
        for (const k of SERVER_MANAGED) {
          if (k in old) (next as Loose)[k] = old[k];
          else delete (next as Loose)[k];
        }
        const nextSummaries = mergeFocusSummaries((raw as Loose).focusSummaries, old.focusSummaries, this.userId);
        if (nextSummaries !== undefined) next.focusSummaries = nextSummaries;
        else delete next.focusSummaries;
        next.projectId = old.projectId;
        if (typeof next.sortOrder === "number") next.sortOrder = clampOrder(next.sortOrder);
        this.fillCompleted(next, old, now);
        this.touch(next, now);
        this.store.putTask(next, { seq });
        res.id2etag[id] = next.etag!;
        this.activity?.recordTaskUpdate(old, next);
      }
      for (const raw of asList(b.delete)) {
        const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.taskId === "string" ? raw.taskId : undefined;
        if (!id) continue;
        const row = this.store.getTaskRow(id);
        if (!row) res.id2error[id] = BatchError.NotExisted;
        else if (row.deleted) res.id2error[id] = BatchError.Deleted;
        else this.trashTree(id, seq);
      }
      for (const [key, op] of [["addAttachments", "add"], ["updateAttachments", "update"], ["deleteAttachments", "delete"]] as const) {
        for (const raw of asList(b[key])) {
          if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
          this.applyAttachmentBatch(raw, op, res, seq, now);
        }
      }
    });
    return res;
  }

  private fillCompleted(task: Task, old: Task | undefined, now: string): void {
    const closing = task.status === TaskStatus.Completed || task.status === TaskStatus.WontDo;
    if (closing && !task.completedTime && old?.status !== task.status) {
      task.completedTime = now;
      if (task.completedUserId === undefined) task.completedUserId = this.userId;
    }
  }

  private applyAttachmentBatch(entry: Loose, op: "add" | "update" | "delete", res: BatchResponse, seq: number, now: string): void {
    const id = entry.id as string;
    const task = this.store.getTask(id);
    if (!task) {
      res.id2error[id] = BatchError.NotExisted;
      return;
    }
    const list = [...(task.attachments ?? [])];
    for (const a of asList(entry.attachments)) {
      if (!isPlainObject(a) || typeof a.id !== "string") continue;
      const i = list.findIndex((x) => x.id === a.id);
      if (op === "delete") {
        if (i >= 0) list.splice(i, 1);
        this.removeAttachmentRow(a.id);
        this.activity?.record({
          taskId: task.id,
          projectId: task.projectId,
          action: ActivityAction.AttachDel,
          summary: `Removed attachment ${String(a.fileName ?? a.id)}`,
          taskTitle: task.title ?? "",
        });
        continue;
      }
      const merged = { ...(i >= 0 ? list[i] : {}), ...a, refId: (a.refId as string) ?? a.id, status: typeof a.status === "number" ? a.status : 0, createdTime: (a.createdTime as string) ?? now };
      if (i >= 0) list[i] = merged as never;
      else list.push(merged as never);
      this.upsertAttachmentRow(task, merged as Loose);
      if (op === "add") {
        this.activity?.record({
          taskId: task.id,
          projectId: task.projectId,
          action: ActivityAction.AttachAdd,
          summary: `Added attachment ${String(merged.fileName ?? merged.id)}`,
          taskTitle: task.title ?? "",
        });
      }
    }
    task.attachments = list;
    this.touch(task, now);
    this.store.putTask(task, { seq });
    res.id2etag[id] = task.etag!;
  }

  upsertAttachmentRow(task: Task, a: Loose, extra: { state?: string; file?: string | null; taskSet?: string } = {}): void {
    const prev = this.store.get<{ state: string; file: string | null; taskSet: string | null; size: number | null }>("select state, file, taskSet, size from attachments where id = ?", String(a.id));
    this.store.run(
      `insert into attachments(id, taskId, projectId, taskSet, fileName, size, type, path, refId, state, file, json)
       values (?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set taskId=excluded.taskId, projectId=excluded.projectId, taskSet=excluded.taskSet, fileName=excluded.fileName, size=excluded.size,
         type=excluded.type, path=excluded.path, refId=excluded.refId, state=excluded.state, file=excluded.file, json=excluded.json`,
      String(a.id),
      task.id,
      task.projectId,
      extra.taskSet ?? prev?.taskSet ?? null,
      typeof a.fileName === "string" ? a.fileName : null,
      prev?.state === "stored" && extra.file === undefined ? prev.size : typeof a.size === "number" ? a.size : null,
      typeof a.fileType === "string" ? a.fileType : null,
      typeof a.path === "string" ? a.path : null,
      typeof a.refId === "string" ? a.refId : String(a.id),
      extra.state ?? prev?.state ?? "pending",
      extra.file === undefined ? (prev?.file ?? null) : extra.file,
      JSON.stringify(a),
    );
  }

  removeAttachmentRow(id: string): void {
    const r = this.store.get<{ file: string | null }>("select file from attachments where id = ?", id);
    if (r?.file) rmSync(r.file, { force: true });
    this.store.run("delete from attachments where id = ?", id);
  }

  // ---- hierarchy
  private linkParent(childId: string, parentId: string, seq: number, now: string): void {
    const parent = this.store.getTask(parentId);
    const child = this.store.getTask(childId);
    if (!parent || !child || parent.projectId !== child.projectId || childId === parentId || this.isDescendant(parentId, childId) || this.level(parentId) >= MAX_TASK_DEPTH) return;
    child.parentId = parentId;
    const ids = new Set(parent.childIds ?? []);
    ids.add(childId);
    parent.childIds = [...ids];
    this.touch(child, now);
    this.touch(parent, now);
    this.store.putTask(child, { seq });
    this.store.putTask(parent, { seq });
  }

  private unlinkParent(childId: string, seq: number, now: string): string | undefined {
    const child = this.store.getTask(childId);
    if (!child || typeof child.parentId !== "string") return undefined;
    const pid = child.parentId;
    delete child.parentId;
    this.touch(child, now);
    this.store.putTask(child, { seq });
    const parent = this.store.getTask(pid);
    if (parent) {
      parent.childIds = (parent.childIds ?? []).filter((c) => c !== childId);
      if (parent.childIds.length === 0) delete parent.childIds;
      this.touch(parent, now);
      this.store.putTask(parent, { seq });
    }
    return pid;
  }

  private level(id: string): number {
    let n = 0;
    let cur = this.store.getTaskRow(id);
    while (cur && n < 100) {
      n++;
      cur = cur.parentId ? this.store.getTaskRow(cur.parentId) : undefined;
    }
    return n;
  }
  private height(id: string): number {
    const kids = this.store.childrenOf(id);
    return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => this.height(k.id)));
  }
  private isDescendant(id: string, ancestor: string): boolean {
    let cur = this.store.getTaskRow(id);
    for (let i = 0; cur && i < 100; i++) {
      if (cur.parentId === ancestor) return true;
      cur = cur.parentId ? this.store.getTaskRow(cur.parentId) : undefined;
    }
    return false;
  }

  batchTaskParent(body: unknown): BatchResponse {
    const res = emptyResult();
    const items = Array.isArray(body) ? body : isPlainObject(body) ? asList(body.items ?? body.tasks ?? body.add) : [];
    this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.now());
      for (const it of items) {
        if (!isPlainObject(it) || typeof it.taskId !== "string") continue;
        const id = it.taskId;
        const row = this.store.getTaskRow(id);
        if (!row) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        if (row.deleted) {
          res.id2error[id] = BatchError.Deleted;
          continue;
        }
        if (typeof it.projectId === "string" && it.projectId !== row.projectId) {
          res.id2error[id] = BatchError.ProjectMoveError;
          continue;
        }
        const newParent = typeof it.parentId === "string" && it.parentId ? it.parentId : undefined;
        if (newParent) {
          const prow = this.store.getTaskRow(newParent);
          if (!prow || prow.deleted) {
            res.id2error[id] = BatchError.NotExisted;
            continue;
          }
          if (prow.projectId !== row.projectId) {
            res.id2error[id] = BatchError.ProjectMoveError;
            continue;
          }
          if (newParent === id || this.isDescendant(newParent, id) || this.level(newParent) + 1 + this.height(id) > MAX_TASK_DEPTH) {
            res.id2error[id] = BatchError.Unknown;
            continue;
          }
        }
        const oldParent = this.unlinkParent(id, seq, now);
        if (oldParent) res.id2etag[oldParent] = this.store.getTask(oldParent)?.etag ?? "";
        if (newParent) {
          this.linkParent(id, newParent, seq, now);
          res.id2etag[newParent] = this.store.getTask(newParent)!.etag!;
        }
        const updated = this.store.getTask(id)!;
        res.id2etag[id] = updated.etag!;
        this.activity?.record({
          taskId: id,
          projectId: updated.projectId,
          action: ActivityAction.Parent,
          oldValue: oldParent ?? null,
          newValue: newParent ?? null,
          summary: newParent ? "Linked parent task" : "Unlinked parent task",
          taskTitle: updated.title ?? "",
        });
      }
    });
    for (const [k, v] of Object.entries(res.id2etag)) if (!v) delete res.id2etag[k];
    return res;
  }

  batchTaskProject(body: unknown): BatchResponse {
    const res = emptyResult();
    const items = Array.isArray(body) ? body : isPlainObject(body) ? asList(body.items ?? body.tasks) : [];
    this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.now());
      for (const it of items) {
        if (!isPlainObject(it) || typeof it.taskId !== "string") continue;
        const id = it.taskId;
        const row = this.store.getTaskRow(id);
        if (!row) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        if (row.deleted) {
          res.id2error[id] = BatchError.Deleted;
          continue;
        }
        if (typeof it.fromProjectId === "string" && it.fromProjectId !== row.projectId) {
          res.id2error[id] = BatchError.ProjectMoveError;
          continue;
        }
        const to = it.toProjectId;
        if (typeof to !== "string" || !this.projectExists(to)) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        if (to === row.projectId) {
          res.id2etag[id] = this.store.getTask(id)!.etag!;
          continue;
        }
        if (row.parentId) this.unlinkParent(id, seq, now);
        const moveTree = (tid: string): void => {
          const t = this.store.getTask(tid)!;
          // members of a shared list must drop a task that moved out of it (multi-user delta)
          this.store.addTombstone("taskMove", tid, { from: t.projectId });
          t.projectId = to;
          delete t.columnId;
          this.touch(t, now);
          this.store.putTask(t, { seq });
          for (const c of this.store.childrenOf(tid)) moveTree(c.id);
        };
        moveTree(id);
        const moved = this.store.getTask(id)!;
        res.id2etag[id] = moved.etag!;
        this.activity?.record({
          taskId: id,
          projectId: to,
          action: ActivityAction.Move,
          oldValue: row.projectId,
          newValue: to,
          summary: "Moved task to list",
          taskTitle: moved.title ?? "",
        });
      }
    });
    return res;
  }

  // ---- trash
  private trashTree(id: string, seq: number): void {
    const now = formatServerDate(this.now());
    const t = this.store.getTask(id);
    if (!t || t.deleted) return;
    t.deleted = 1;
    t.deletedTime = this.now();
    t.deletedBy = this.userId;
    this.touch(t, now);
    this.store.putTask(t, { seq });
    this.activity?.record({
      taskId: t.id,
      projectId: t.projectId,
      action: ActivityAction.Trash,
      summary: "Moved task to trash",
      taskTitle: t.title ?? "",
    });
    for (const c of this.store.childrenOf(id)) this.trashTree(c.id, seq);
  }

  trashTasks(ids: string[]): void {
    this.store.tx(() => {
      const seq = this.store.seq();
      for (const id of ids) this.trashTree(id, seq);
    });
  }

  private restoreTree(id: string, seq: number, now: string): void {
    const t = this.store.getTask(id);
    if (!t || !t.deleted) return;
    t.deleted = 0;
    delete t.deletedTime;
    delete t.deletedBy;
    if (!this.projectExists(t.projectId)) t.projectId = this.inboxId;
    if (typeof t.parentId === "string") {
      const p = this.store.getTaskRow(t.parentId);
      if (!p || p.deleted) {
        delete t.parentId;
      }
    }
    this.touch(t, now);
    this.store.putTask(t, { seq });
    this.activity?.record({
      taskId: t.id,
      projectId: t.projectId,
      action: ActivityAction.Restore,
      summary: "Restored task from trash",
      taskTitle: t.title ?? "",
    });
    for (const c of this.store.childrenOf(id)) {
      const ct = this.store.getTask(c.id)!;
      if (ct.deleted) {
        ct.projectId = t.projectId;
        this.store.putTask(ct, { seq });
        this.restoreTree(c.id, seq, now);
      }
    }
  }

  trashRestore(body: unknown): BatchResponse {
    const res = emptyResult();
    const ids = extractTaskIds(body);
    this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.now());
      for (const id of ids) {
        const row = this.store.getTaskRow(id);
        if (!row) res.id2error[id] = BatchError.NotExisted;
        else if (!row.deleted) res.id2error[id] = BatchError.Existed;
        else {
          this.restoreTree(id, seq, now);
          res.id2etag[id] = this.store.getTask(id)!.etag!;
        }
      }
    });
    return res;
  }

  private hardDeleteTree(id: string): void {
    const row = this.store.getTaskRow(id);
    if (!row) return;
    for (const c of this.store.childrenOf(id)) this.hardDeleteTree(c.id);
    const t = JSON.parse(row.json) as Task;
    for (const a of t.attachments ?? []) this.removeAttachmentRow(a.id);
    for (const ca of this.store.all<{ id: string }>("select id from attachments where taskId = ?", id)) this.removeAttachmentRow(ca.id);
    this.store.run("delete from comments where taskId = ?", id);
    if (row.parentId) {
      const p = this.store.getTask(row.parentId);
      if (p) {
        p.childIds = (p.childIds ?? []).filter((c) => c !== id);
        if (p.childIds.length === 0) delete p.childIds;
        this.store.putTask(p, { seq: this.store.seq() });
      }
    }
    this.store.deleteTaskRow(id);
    this.store.addTombstone("task", id, { projectId: row.projectId });
    this.activity?.record({
      taskId: id,
      projectId: row.projectId,
      action: ActivityAction.Delete,
      summary: "Permanently deleted task",
      taskTitle: t.title ?? "",
    });
  }

  /** `DELETE /task?deleteforever=true`: permanent delete. */
  deleteForever(body: unknown): BatchResponse {
    const res = emptyResult();
    const ids = extractTaskIds(body);
    this.store.tx(() => {
      for (const id of ids) {
        if (!this.store.getTaskRow(id)) res.id2error[id] = BatchError.NotExisted;
        else this.hardDeleteTree(id);
      }
    });
    return res;
  }

  /** `DELETE /trash/cleanUp`: empty the trash. */
  cleanUpTrash(): { deleted: number } {
    return this.store.tx(() => {
      const rows = this.store.all<{ id: string }>("select id from tasks where deleted = 1 and parentId is null");
      const rest = this.store.all<{ id: string }>("select id from tasks where deleted = 1");
      for (const r of rows) this.hardDeleteTree(r.id);
      for (const r of rest) if (this.store.getTaskRow(r.id)) this.hardDeleteTree(r.id);
      return { deleted: rest.length };
    });
  }

  trashPage(limit: number, next: number): { tasks: Task[]; next: number } {
    const lim = Math.max(1, Math.min(limit || TRASH_PAGE_SIZE, 1000));
    const off = Math.max(0, next || 0);
    const rows = this.store.all<{ json: string }>(
      "select json from tasks where deleted = 1 order by coalesce(json_extract(json, '$.deletedTime'), 0) desc, pos desc limit ? offset ?",
      lim,
      off,
    );
    return { tasks: rows.map((r) => JSON.parse(r.json) as Task), next: off + rows.length };
  }

  closedTasks(opts: { projectIds?: string[]; status: number; from?: string; to?: string; limit?: number }): Task[] {
    const lim = Math.max(1, Math.min(opts.limit ?? CLOSED_PAGE_SIZE, 5000));
    const where = ["deleted = 0", "status = ?"];
    const args: Array<string | number> = [opts.status];
    if (opts.projectIds && opts.projectIds.length) {
      where.push(`projectId in (${opts.projectIds.map(() => "?").join(",")})`);
      args.push(...opts.projectIds);
    }
    const toSrv = (q: string): string => q.replace(" ", "T");
    if (opts.from) {
      where.push("completedTime >= ?");
      args.push(toSrv(opts.from));
    }
    if (opts.to) {
      // query dates have no millis or zone: compare on the first 19 chars
      where.push("substr(completedTime, 1, 19) <= ?");
      args.push(toSrv(opts.to).slice(0, 19));
    }
    args.push(lim);
    return this.store
      .all<{ json: string }>(`select json from tasks where ${where.join(" and ")} order by completedTime desc, pos desc limit ?`, ...args)
      .map((r) => JSON.parse(r.json) as Task);
  }

  completedByTag(tags: string[], offset: number, limit: number): { tasks: Task[]; nextToken: string | null } {
    const wanted = new Set(tags.map((t) => t.toLowerCase()));
    const all = this.store
      .all<{ json: string }>("select json from tasks where deleted = 0 and status = 2 order by completedTime desc, pos desc")
      .map((r) => JSON.parse(r.json) as Task)
      .filter((t) => (t.tags ?? []).some((x) => wanted.has(x.toLowerCase())));
    const page = all.slice(offset, offset + limit);
    return { tasks: page, nextToken: offset + limit < all.length ? String(offset + limit) : null };
  }

  // ------------------------------------------------------------------ simple collections

  private batchColl(
    table: CollName,
    body: unknown,
    opts: {
      keyOf: (o: Loose) => string | undefined;
      stampTime: boolean;
      onAdd?: (o: Loose) => void;
      onUpdate?: (o: Loose, old: Loose) => void;
      onDelete?: (id: string, raw: unknown, old: Loose) => string | undefined;
      deleteKey?: (raw: unknown) => string | undefined;
    },
  ): BatchResponse {
    const res = emptyResult();
    const b = isPlainObject(body) ? body : {};
    this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.now());
      const stamp = (o: Loose): void => {
        o.etag = newEtag();
        if (opts.stampTime) o.modifiedTime = now;
      };
      for (const raw of asList(b.add)) {
        if (!isPlainObject(raw)) continue;
        const id = opts.keyOf(raw);
        if (!id) continue;
        if (this.store.collGet(table, id)) {
          res.id2error[id] = BatchError.Existed;
          continue;
        }
        const o = { ...raw };
        stamp(o);
        this.store.collPut(table, id, o, { seq });
        this.store.clearTombstone(tombKind(table), id);
        res.id2etag[id] = o.etag as string;
        opts.onAdd?.(o);
      }
      for (const raw of asList(b.update)) {
        if (!isPlainObject(raw)) continue;
        const id = opts.keyOf(raw);
        if (!id) continue;
        const old = this.store.collGet<Loose>(table, id);
        if (!old) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        const o = mergeUpdate(old, raw, LEGACY_FIELDS[table]);
        stamp(o);
        this.store.collPut(table, id, o, { seq });
        res.id2etag[id] = o.etag as string;
        opts.onUpdate?.(o, old);
      }
      for (const raw of asList(b.delete)) {
        const id = opts.deleteKey ? opts.deleteKey(raw) : typeof raw === "string" ? raw : undefined;
        if (!id) continue;
        const old = this.store.collGet<Loose>(table, id);
        if (!old) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        const err = opts.onDelete?.(id, raw, old);
        if (err) {
          res.id2error[id] = err;
          continue;
        }
        this.store.collDelete(table, id);
        this.store.addTombstone(
          tombKind(table),
          id,
          table === "columns"
            ? { projectId: isPlainObject(raw) && typeof raw.projectId === "string" && raw.projectId ? raw.projectId : old.projectId }
            : undefined,
        );
      }
    });
    return res;
  }

  batchProject(body: unknown): BatchResponse {
    return this.batchColl("projects", body, {
      keyOf: (o) => (typeof o.id === "string" ? o.id : undefined),
      stampTime: true,
      onAdd: (o) => {
        this.activity?.record({ projectId: String(o.id), action: ActivityAction.ProjectCreate, summary: `Created list "${String(o.name ?? "")}"` });
      },
      onUpdate: (o, old) => {
        this.activity?.record({
          projectId: String(o.id),
          action: ActivityAction.ProjectUpdate,
          field: "name",
          oldValue: old.name,
          newValue: o.name,
          summary: `Updated list "${String(o.name ?? "")}"`,
        });
      },
      onDelete: (id, _raw, old) => {
        if (id === this.inboxId) return BatchError.Unknown;
        const seq = this.store.seq();
        for (const t of this.store.tasksOfProject(id)) this.trashTree(t.id, seq);
        for (const c of this.store.collAll<Loose>("columns").filter((c) => c.projectId === id)) {
          this.store.collDelete("columns", c.id as string);
          this.store.addTombstone("column", c.id as string, { projectId: id });
        }
        this.activity?.record({ projectId: id, action: ActivityAction.ProjectDelete, summary: `Deleted list "${String(old.name ?? id)}"` });
        return undefined;
      },
    });
  }

  batchProjectGroup(body: unknown): BatchResponse {
    return this.batchColl("project_groups", body, {
      keyOf: (o) => (typeof o.id === "string" ? o.id : undefined),
      stampTime: false,
      onDelete: (id) => {
        const seq = this.store.seq();
        const now = formatServerDate(this.now());
        for (const p of this.store.collAll<Project>("projects")) {
          if (p.groupId === id) {
            p.groupId = null;
            p.etag = newEtag();
            p.modifiedTime = now;
            this.store.collPut("projects", p.id, p, { seq });
          }
        }
        return undefined;
      },
    });
  }

  batchFilter(body: unknown): BatchResponse {
    return this.batchColl("filters", body, { keyOf: (o) => (typeof o.id === "string" ? o.id : undefined), stampTime: false });
  }

  batchColumn(body: unknown): BatchResponse {
    const b = isPlainObject(body) ? body : {};
    const missing: string[] = [];
    for (const raw of asList(b.add)) {
      if (isPlainObject(raw) && typeof raw.id === "string" && typeof raw.projectId === "string" && !this.projectExists(raw.projectId)) missing.push(raw.id);
    }
    const clean = { ...b, add: asList(b.add).filter((r) => !(isPlainObject(r) && missing.includes(r.id as string))) };
    const res = this.batchColl("columns", clean, {
      keyOf: (o) => (typeof o.id === "string" ? o.id : undefined),
      stampTime: true,
      deleteKey: (raw) =>
        isPlainObject(raw)
          ? typeof raw.columnId === "string"
            ? raw.columnId
            : typeof raw.id === "string"
              ? raw.id
              : undefined
          : typeof raw === "string"
            ? raw
            : undefined,
      onAdd: (o) => {
        this.activity?.record({ projectId: String(o.projectId), action: ActivityAction.ColumnCreate, summary: `Created section "${String(o.name ?? "")}"` });
      },
      onUpdate: (o) => {
        this.activity?.record({ projectId: String(o.projectId), action: ActivityAction.ColumnUpdate, summary: `Updated section "${String(o.name ?? "")}"` });
      },
      onDelete: (_id, _raw, old) => {
        this.activity?.record({ projectId: String(old.projectId), action: ActivityAction.ColumnDelete, summary: `Deleted section "${String(old.name ?? "")}"` });
        return undefined;
      },
    });
    for (const id of missing) res.id2error[id] = BatchError.NotExisted;
    return res;
  }

  columnsOf(projectId: string): Loose[] {
    return this.store.collAll<Loose>("columns").filter((c) => c.projectId === projectId);
  }

  columnsFrom(from: number): Record<string, Loose[]> {
    const out: Record<string, Loose[]> = {};
    const rows = from > 0 ? this.store.collChanged<Loose>("columns", from) : this.store.collAll<Loose>("columns");
    const activeIds = new Set<string>();
    for (const c of rows) {
      activeIds.add(String(c.id));
      (out[c.projectId as string] ??= []).push(c);
    }
    if (from > 0) {
      for (const t of this.store.tombstonesSince("column", from)) {
        if (activeIds.has(t.id) || this.store.collGet("columns", t.id)) continue;
        const pid = typeof t.extra?.projectId === "string" ? t.extra.projectId : undefined;
        if (!pid) continue;
        (out[pid] ??= []).push({ id: t.id, projectId: pid, deleted: 1 });
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ tags

  batchTag(body: unknown): BatchResponse {
    const id2error: Record<string, string> = {};
    const id2etag: Record<string, string> = {};
    const b = isPlainObject(body) ? body : {};
    this.store.tx(() => {
      const seq = this.store.seq();
      for (const raw of [...asList(b.add), ...asList(b.update)]) {
        if (!isPlainObject(raw) || typeof raw.name !== "string" || !raw.name) continue;
        const old = this.store.collGet<Loose>("tags", raw.name);
        if (raw._sync && !old) { id2error[raw.name] = BatchError.NotExisted; continue; }
        const o = mergeUpdate(old ?? {}, raw, LEGACY_FIELDS.tags);
        o.etag = newEtag();
        this.store.collPut("tags", raw.name, o, { seq });
        this.store.clearTombstone("tag", raw.name);
        id2etag[raw.name] = o.etag as string;
      }
    });
    return { id2etag, id2error };
  }

  private retag(map: (tags: string[]) => string[] | undefined): number {
    const seq = this.store.seq();
    const now = formatServerDate(this.now());
    let n = 0;
    for (const r of this.store.all<{ id: string }>("select id from tasks where json_extract(json, '$.tags') is not null")) {
      const t = this.store.getTask(r.id)!;
      const prevTags = [...(t.tags ?? [])];
      const next = map(t.tags ?? []);
      if (!next) continue;
      t.tags = next;
      if (next.length === 0) delete t.tags;
      this.touch(t, now);
      this.store.putTask(t, { seq });
      this.activity?.record({
        taskId: t.id,
        projectId: t.projectId,
        action: ActivityAction.Tag,
        field: "tags",
        oldValue: prevTags,
        newValue: next,
        summary: "Updated tags",
        taskTitle: t.title ?? "",
      });
      n++;
    }
    return n;
  }

  renameTag(name: string, newName: string, merge = false): { tasksChanged: number } {
    return this.store.tx(() => {
      const seq = this.store.seq();
      const from = name.toLowerCase();
      const toKey = newName.toLowerCase();
      const src = this.store.collGet<Loose>("tags", from) ?? this.store.collGet<Loose>("tags", name);
      const srcKey = src ? (src.name as string) : from;
      const dst = this.store.collGet<Loose>("tags", toKey);
      if (!merge && dst && toKey !== srcKey) throw new ApiError(400, "tag_exist", "tag already exists");
      if (!src && !merge) throw new ApiError(404, "tag_not_exist", "tag does not exist");
      const changed = this.retag((tags) => {
        if (!tags.some((t) => t.toLowerCase() === srcKey.toLowerCase())) return undefined;
        const mapped = tags.map((t) => (t.toLowerCase() === srcKey.toLowerCase() ? toKey : t));
        return [...new Set(mapped)];
      });
      if (src) {
        this.store.collDelete("tags", srcKey);
        this.store.addTombstone("tag", srcKey);
        if (!dst) {
          const o: Loose = { ...src, name: toKey, rawName: newName, label: newName, etag: newEtag() };
          this.store.collPut("tags", toKey, o, { seq });
          this.store.clearTombstone("tag", toKey);
        }
        for (const t of this.store.collAll<Loose>("tags")) {
          if (typeof t.parent === "string" && t.parent.toLowerCase() === srcKey.toLowerCase()) {
            this.store.collPut("tags", t.name as string, { ...t, parent: toKey, etag: newEtag() }, { seq });
          }
        }
      } else if (!dst) {
        this.store.collPut("tags", toKey, { name: toKey, rawName: newName, label: newName, etag: newEtag() }, { seq });
      }
      return { tasksChanged: changed };
    });
  }

  deleteTag(name: string): { tasksChanged: number } {
    return this.store.tx(() => {
      const key = name.toLowerCase();
      const src = this.store.collGet<Loose>("tags", key) ?? this.store.collGet<Loose>("tags", name);
      if (!src) throw new ApiError(404, "tag_not_exist", "tag does not exist");
      const srcKey = src.name as string;
      const changed = this.retag((tags) => {
        if (!tags.some((t) => t.toLowerCase() === srcKey.toLowerCase())) return undefined;
        return tags.filter((t) => t.toLowerCase() !== srcKey.toLowerCase());
      });
      this.store.collDelete("tags", srcKey);
      this.store.addTombstone("tag", srcKey);
      return { tasksChanged: changed };
    });
  }

  // ------------------------------------------------------------------ order

  batchOrder(family: "v2" | "v3", body: unknown): Record<string, never> {
    this.store.tx(() => {
      applyOrderBatch(this.store, family, body);
    });
    return {};
  }

  // ------------------------------------------------------------------ complete & search

  completeTask(projectId: string, taskId: string): { task: Task; completedCopy?: Task } {
    return this.store.tx(() => {
      const task = this.store.getTask(taskId);
      if (!task || (projectId !== "all" && task.projectId !== projectId)) throw new ApiError(404, "task_not_found");
      if (task.deleted) throw new ApiError(400, "task_deleted");
      const seq = this.store.seq();
      const nowMs = this.now();
      const now = formatServerDate(nowMs);
      const { tz, weekStart } = this.userCtx();

      if (task.repeatFlag && (task.startDate || task.dueDate)) {
        const res = completeRecurringTask(task as never, now, {
          deviceZone: tz,
          defaultWeekStart: WEEKDAY_CODES[weekStart] ?? "SU",
        });
        if (!res.ended && res.completedCopy) {
          const copy: Task = {
            ...structuredClone(task),
            ...(res.completedCopy as Partial<Task>),
            id: newId(nowMs),
            status: TaskStatus.Completed,
            completedTime: now,
            completedUserId: this.userId,
            createdTime: now,
            modifiedTime: now,
            etag: newEtag(),
          } as Task;
          delete copy.childIds;
          delete copy.parentId;
          delete copy.remindTime;
          delete copy.snoozeReminderTime;
          this.store.putTask(copy, { seq });

          const updated: Task = { ...task };
          for (const [k, v] of Object.entries(res.updates)) {
            if (v === null) delete (updated as Loose)[k];
            else (updated as Loose)[k] = v;
          }
          // RMD-027: relative reminders stay unchanged; remindTime and snoozeReminderTime are cleared
          updated.etag = newEtag();
          updated.modifiedTime = now;
          this.store.putTask(updated, { seq });
          this.activity?.record({
            taskId: updated.id,
            projectId: updated.projectId,
            action: ActivityAction.Complete,
            summary: "Completed repeating task",
            taskTitle: updated.title ?? "",
          });
          return { task: updated, completedCopy: copy };
        }
      }

      task.status = TaskStatus.Completed;
      task.completedTime = now;
      task.completedUserId = this.userId;
      delete task.remindTime;
      delete task.snoozeReminderTime;
      this.touch(task, now);
      this.store.putTask(task, { seq });
      this.activity?.record({
        taskId: task.id,
        projectId: task.projectId,
        action: ActivityAction.Complete,
        summary: "Completed task",
        taskTitle: task.title ?? "",
      });
      return { task };
    });
  }

  searchTasks(q: { keywords?: string; projectId?: string; tag?: string; priority?: string; date?: string; status?: string }): Task[] {
    const conds: Array<{ conditionName: string; conditionType: 1; or: Array<string | number> }> = [];
    if (q.keywords) conds.push({ conditionName: "keywords", conditionType: 1, or: [q.keywords] });
    if (q.projectId) conds.push({ conditionName: "list", conditionType: 1, or: q.projectId.split(",").filter(Boolean) });
    if (q.tag) conds.push({ conditionName: "tag", conditionType: 1, or: q.tag.split(",").filter(Boolean) });
    if (q.priority !== undefined && q.priority !== "") {
      conds.push({ conditionName: "priority", conditionType: 1, or: q.priority.split(",").map(Number).filter(Number.isFinite) });
    }
    if (q.date) conds.push({ conditionName: "dueDate", conditionType: 1, or: q.date.split(",").filter(Boolean) });
    if (q.status !== undefined && q.status !== "") {
      conds.push({ conditionName: "status", conditionType: 1, or: q.status.split(",").map(Number).filter(Number.isFinite) });
    }

    const { weekStart } = this.userCtx();
    const projectGroup: Record<string, string | null | undefined> = {};
    const projectTeam: Record<string, string | null | undefined> = {};
    for (const p of this.store.collAll<Project>("projects")) {
      projectGroup[p.id] = p.groupId ?? null;
      projectTeam[p.id] = p.teamId ?? null;
    }
    const rule = conds.length > 0 ? { and: conds, type: 0, version: 1 } : null;
    const ctx = { now: this.now(), weekStart, userId: this.userId, projectGroup, projectTeam };
    return this.store
      .all<{ json: string }>("select json from tasks where deleted = 0 order by pos")
      .map((r) => JSON.parse(r.json) as Task)
      .filter((t) => evaluateRule(rule, t as RuleTask, ctx));
  }

  // ------------------------------------------------------------------ misc

  taskRowToJson(row: TaskRow): Task {
    return JSON.parse(row.json) as Task;
  }
}

function tombKind(table: CollName): string {
  return {
    projects: "project",
    project_groups: "projectGroup",
    filters: "filter",
    tags: "tag",
    columns: "column",
    habits: "habit",
    habit_sections: "habitSection",
    countdowns: "countdown",
    timers: "timer",
    matrix_profiles: "matrixProfile",
    calendar_subscriptions: "calendarSubscription",
  }[table];
}

/** Accept the several shapes a trash/delete body may take. */
export function extractTaskIds(body: unknown): string[] {
  const list: unknown[] = Array.isArray(body) ? body : isPlainObject(body) ? asList(body.tasks ?? body.taskIds ?? body.ids ?? body.data) : [];
  const ids: string[] = [];
  for (const it of list) {
    if (typeof it === "string") ids.push(it);
    else if (isPlainObject(it)) {
      const id = typeof it.taskId === "string" ? it.taskId : typeof it.id === "string" ? it.id : undefined;
      if (id) ids.push(id);
    }
  }
  return ids;
}
