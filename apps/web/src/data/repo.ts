import { completeRecurringTask } from "@noortasks/recurrence";
import { triggerHaptic } from "../lib/capacitor";
import {
  ORDER_STEP,
  TaskStatus,
  defaultPreferences,
  newId,
  orderForBottom,
  orderForTop,
  type Attachment,
  type ChecklistItem,
  type Column,
  type Filter,
  type Preferences,
  type Project,
  type ProjectGroup,
  type Tag,
  type Task,
} from "../lib/core";
import { deviceZone, toServer } from "../lib/dates";
import type { NoorDb } from "./db";
import type { SyncEngine } from "./sync";

function orderBetweenSafe(before: number | undefined, after: number | undefined): number | null {
  if (before === undefined && after === undefined) return 0;
  if (before === undefined) return after! - ORDER_STEP;
  if (after === undefined) return before + ORDER_STEP;
  if (after - before < 2) return null;
  return Math.floor((before + after) / 2);
}

/** Characters stripped from list, folder and tag names (LIST-010, TAG-003). No length cap in NoorTasks. */
export const cleanListName = (s: string): string => s.replace(/[\\/":?<>|*]/g, "").trim();
export const cleanTagName = (s: string): string => s.replace(/[\\/":?<>|*#\s]/g, "");

export interface UndoEntry {
  label: string;
  undo: () => Promise<void>;
}

/**
 * All local mutations. Each writes IndexedDB first, appends outbox ops and asks the engine to sync soon.
 * Returns an undo entry for actions the UI offers to undo.
 */
export class Repo {
  onChange: () => void = () => {};
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  constructor(
    readonly db: NoorDb,
    readonly engine: SyncEngine,
  ) {}

  private kick(): void {
    this.onChange();
  }

  async inboxId(): Promise<string> {
    return this.db.getKV<string>("inboxId", "inbox0");
  }
  async settings(): Promise<Preferences> {
    const s = await this.db.getKV<Partial<Preferences> | null>("settings", null);
    return { ...defaultPreferences(), ...(s ?? {}) } as Preferences;
  }

  // ---------------------------------------------------------------- undo

  pushUndo(e: UndoEntry): UndoEntry {
    this.undoStack.push(e);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    return e;
  }
  async undo(): Promise<string | null> {
    const e = this.undoStack.pop();
    if (!e) return null;
    await e.undo();
    return e.label;
  }

  /** Snapshot tasks so a later undo can restore them exactly. */
  private async snapshot(ids: string[]): Promise<Task[]> {
    return (await this.db.tasks.bulkGet(ids)).filter((t): t is Task => !!t).map((t) => structuredClone(t));
  }
  private async restoreSnapshot(snap: Task[]): Promise<void> {
    for (const t of snap) {
      const cur = await this.db.tasks.get(t.id);
      if (cur?.deleted && !t.deleted) {
        await this.db.tasks.put({ ...t, deleted: 0 });
        await this.engine.enqueue("trashRestore", t.id, { taskId: t.id, projectId: t.projectId });
        await this.engine.enqueue("task", t.id, {});
      } else if (cur && cur.projectId !== t.projectId) {
        await this.db.tasks.put(t);
        await this.engine.enqueue("taskProject", t.id, { taskId: t.id, toProjectId: t.projectId });
        await this.engine.enqueue("task", t.id, {});
      } else {
        await this.db.tasks.put(t);
        await this.engine.enqueue("task", t.id, {});
      }
    }
    this.kick();
  }

  // ---------------------------------------------------------------- tasks

  async createTask(fields: Partial<Task> & { title: string }, opts: { position?: "top" | "bottom"; after?: Task } = {}): Promise<Task> {
    const prefs = await this.settings();
    const projectId = fields.projectId ?? (await this.inboxId());
    const siblings = await this.db.tasks.where("projectId").equals(projectId).filter((t) => !t.deleted && t.status === 0 && (t.parentId ?? null) === (fields.parentId ?? null)).toArray();
    const orders = siblings.map((t) => t.sortOrder);
    let sortOrder: number;
    if (fields.sortOrder !== undefined) sortOrder = fields.sortOrder;
    else if (opts.after) {
      const sorted = siblings.map((t) => t.sortOrder).sort((a, b) => a - b);
      const next = sorted.find((o) => o > opts.after!.sortOrder);
      sortOrder = next === undefined ? opts.after.sortOrder + ORDER_STEP : Math.floor((opts.after.sortOrder + next) / 2);
    } else sortOrder = (opts.position ?? (prefs.defaultToAdd === 1 ? "bottom" : "top")) === "bottom" ? orderForBottom(orders) : orderForTop(orders);
    const now = toServer(Date.now());
    const task: Task = {
      id: newId(),
      projectId,
      content: "",
      kind: "TEXT",
      status: TaskStatus.Open,
      priority: prefs.defaultPriority ?? 0,
      sortOrder,
      timeZone: deviceZone(),
      isFloating: false,
      isAllDay: undefined,
      tags: [...(prefs.defaultTags ?? [])],
      items: [],
      reminders: [],
      exDate: [],
      createdTime: now,
      modifiedTime: now,
      progress: 0,
      ...fields,
    };
    if (task.startDate && task.isAllDay === undefined) task.isAllDay = true;
    if (!task.startDate) {
      delete task.startDate;
      delete task.dueDate;
      delete task.isAllDay;
    }
    if (task.tags && task.tags.length) await this.ensureTags(task.tags);
    // row and outbox op in one transaction: a pull can never land between them
    await this.db.transaction("rw", this.db.tasks, this.db.outbox, async () => {
      await this.db.tasks.add(task);
      if (task.parentId) {
        const p = await this.db.tasks.get(task.parentId);
        if (p) await this.db.tasks.update(p.id, { childIds: [...new Set([...(p.childIds ?? []), task.id])] });
      }
      await this.engine.enqueue("task", task.id, { add: true });
    });
    this.kick();
    return task;
  }

  /** Merge a patch into the task and queue the changed fields. */
  async updateTask(id: string, patch: Partial<Task>, opts: { undo?: string } = {}): Promise<void> {
    const snap = opts.undo ? await this.snapshot([id]) : [];
    if (patch.tags) await this.ensureTags(patch.tags);
    const found = await this.db.transaction("rw", this.db.tasks, this.db.outbox, async () => {
      const t = await this.db.tasks.get(id);
      if (!t) return false;
      const next: Task = { ...t, ...patch, modifiedTime: toServer(Date.now()) };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as Record<string, unknown>)[k];
      await this.db.tasks.put(next);
      await this.engine.enqueue("task", id, {});
      return true;
    });
    if (!found) return;
    if (opts.undo) this.pushUndo({ label: opts.undo, undo: () => this.restoreSnapshot(snap) });
    this.kick();
  }

  async updateMany(ids: string[], patch: Partial<Task>, label?: string): Promise<void> {
    const snap = await this.snapshot(ids);
    for (const id of ids) await this.updateTask(id, patch);
    if (label) this.pushUndo({ label, undo: () => this.restoreSnapshot(snap) });
  }

  /** Per-task patches with one undo entry (Postpone, batch date changes). */
  async updateEach(ids: string[], fn: (t: Task) => Partial<Task>, label?: string): Promise<void> {
    const snap = await this.snapshot(ids);
    for (const t of snap) await this.updateTask(t.id, fn(t));
    if (label) this.pushUndo({ label, undo: () => this.restoreSnapshot(snap) });
  }

  /** Complete or reopen. A repeating task rolls to its next occurrence and leaves a completed copy. */
  async toggleComplete(id: string): Promise<{ next?: Task; copy?: Task }> {
    const t = await this.db.tasks.get(id);
    if (!t) return {};
    const snap = await this.snapshot([id]);
    if (t.status !== TaskStatus.Open) {
      await this.updateTask(id, { status: TaskStatus.Open, completedTime: undefined, completedUserId: undefined });
      this.pushUndo({ label: "Task reopened", undo: () => this.restoreSnapshot(snap) });
      return {};
    }
    const nowIso = toServer(Date.now());
    triggerHaptic("LIGHT");
    if (t.repeatFlag && (t.startDate || t.dueDate)) {
      const prefs = await this.settings();
      const r = completeRecurringTask(t as never, nowIso, { deviceZone: deviceZone(), defaultWeekStart: prefs.startDayOfWeek === "MON" ? "MO" : prefs.startDayOfWeek === "SAT" ? "SA" : "SU" });
      if (!r.ended && r.completedCopy) {
        const copy: Task = { ...structuredClone(t), ...(r.completedCopy as Partial<Task>), id: newId(), completedTime: nowIso, status: TaskStatus.Completed } as Task;
        delete copy.childIds;
        delete copy.etag;
        delete copy.parentId;
        await this.db.tasks.add(copy);
        await this.engine.enqueue("task", copy.id, { add: true });
        const patch: Partial<Task> = {};
        for (const [k, v] of Object.entries(r.updates)) (patch as Record<string, unknown>)[k] = v === null ? undefined : v;
        await this.updateTask(id, patch);
        this.pushUndo({
          label: "Task completed",
          undo: async () => {
            await this.trashIds([copy.id], false, true);
            await this.restoreSnapshot(snap);
          },
        });
        return { next: await this.db.tasks.get(id), copy };
      }
    }
    await this.updateTask(id, { status: TaskStatus.Completed, completedTime: nowIso });
    this.pushUndo({ label: "Task completed", undo: () => this.restoreSnapshot(snap) });
    return {};
  }

  async setWontDo(id: string): Promise<void> {
    const snap = await this.snapshot([id]);
    await this.updateTask(id, { status: TaskStatus.WontDo, completedTime: toServer(Date.now()) });
    this.pushUndo({ label: "Marked as Won't Do", undo: () => this.restoreSnapshot(snap) });
  }

  private async subtree(id: string): Promise<string[]> {
    const out = [id];
    const kids = await this.db.tasks.where("parentId").equals(id).toArray();
    for (const k of kids) out.push(...(await this.subtree(k.id)));
    return out;
  }

  async trashIds(ids: string[], undoable = true, silent = false): Promise<void> {
    const all = new Set<string>();
    for (const id of ids) for (const x of await this.subtree(id)) all.add(x);
    const snap = await this.snapshot([...all]);
    const now = Date.now();
    for (const id of all) await this.db.tasks.update(id, { deleted: 1, deletedTime: now });
    for (const id of ids) {
      const t = snap.find((s) => s.id === id);
      await this.engine.enqueue("taskDelete", id, { taskId: id, projectId: t?.projectId ?? "" });
    }
    if (undoable && !silent) this.pushUndo({ label: ids.length > 1 ? `${ids.length} tasks deleted` : "Task deleted", undo: () => this.restoreSnapshot(snap) });
    this.kick();
  }

  async restoreFromTrash(ids: string[]): Promise<void> {
    for (const id of ids) {
      const t = await this.db.tasks.get(id);
      if (!t) continue;
      for (const x of await this.subtree(id)) await this.db.tasks.update(x, { deleted: 0 });
      const proj = t.projectId === (await this.inboxId()) || (await this.db.projects.get(t.projectId));
      if (!proj) await this.db.tasks.update(id, { projectId: await this.inboxId() });
      await this.engine.enqueue("trashRestore", id, { taskId: id, projectId: t.projectId });
    }
    this.kick();
  }

  async deleteForever(ids: string[]): Promise<void> {
    for (const id of ids) {
      const t = await this.db.tasks.get(id);
      for (const x of await this.subtree(id)) await this.db.tasks.delete(x);
      await this.engine.enqueue("deleteForever", id, { taskId: id, projectId: t?.projectId ?? "" });
    }
    this.kick();
  }

  async emptyTrash(): Promise<void> {
    const trashed = await this.db.tasks.where("deleted").equals(1).toArray();
    await this.db.tasks.bulkDelete(trashed.map((t) => t.id));
    await this.engine.enqueue("cleanTrash", "all", {});
    this.kick();
  }

  async moveTasks(ids: string[], toProjectId: string): Promise<void> {
    const snap = await this.snapshot(ids);
    for (const id of ids) {
      const t = await this.db.tasks.get(id);
      if (!t || t.projectId === toProjectId) continue;
      if (t.parentId) {
        const p = await this.db.tasks.get(t.parentId);
        if (p) await this.db.tasks.update(p.id, { childIds: (p.childIds ?? []).filter((c) => c !== id) });
      }
      const tree = await this.subtree(id);
      for (const x of tree) {
        const xt = await this.db.tasks.get(x);
        if (!xt) continue;
        const nt: Task = { ...xt, projectId: toProjectId, modifiedTime: toServer(Date.now()) };
        delete nt.columnId;
        if (x === id) delete nt.parentId;
        await this.db.tasks.put(nt);
      }
      await this.engine.enqueue("taskProject", id, { taskId: id, toProjectId });
    }
    this.pushUndo({ label: "Task moved", undo: () => this.restoreSnapshot(snap) });
    this.kick();
  }

  async setParent(id: string, parentId: string | null): Promise<string | null> {
    const t = await this.db.tasks.get(id);
    if (!t) return "missing";
    const oldParentId = t.parentId ?? null;
    if (parentId) {
      const p = await this.db.tasks.get(parentId);
      if (!p) return "missing";
      if (p.projectId !== t.projectId) return "Subtasks must be in the same list";
      if ((await this.subtree(id)).includes(parentId)) return "A task cannot be its own subtask";
      let depth = 1;
      let cur: Task | undefined = p;
      while (cur?.parentId) {
        depth++;
        cur = await this.db.tasks.get(cur.parentId);
      }
      if (depth + (await this.height(id)) > 5) return "Up to 5 levels of subtasks";
      await this.db.tasks.update(parentId, { childIds: [...new Set([...(p.childIds ?? []), id])] });
    }
    if (oldParentId) {
      const op = await this.db.tasks.get(oldParentId);
      if (op) await this.db.tasks.update(oldParentId, { childIds: (op.childIds ?? []).filter((c) => c !== id) });
    }
    const nt = { ...t };
    if (parentId) nt.parentId = parentId;
    else delete nt.parentId;
    await this.db.tasks.put(nt);
    await this.engine.enqueue("taskParent", id, { taskId: id, parentId: parentId ?? "", oldParentId, projectId: t.projectId });
    this.kick();
    return null;
  }

  private async height(id: string): Promise<number> {
    const kids = await this.db.tasks.where("parentId").equals(id).filter((k) => !k.deleted).toArray();
    let h = 1;
    for (const k of kids) h = Math.max(h, 1 + (await this.height(k.id)));
    return h;
  }

  async duplicateTask(id: string, withSubtasks = true): Promise<Task | undefined> {
    const t = await this.db.tasks.get(id);
    if (!t) return;
    const copy = async (src: Task, parentId?: string, order?: number): Promise<Task> => {
      const c: Task = { ...structuredClone(src), id: newId(), createdTime: toServer(Date.now()), modifiedTime: toServer(Date.now()) };
      delete c.etag;
      delete c.completedTime;
      delete c.commentCount;
      delete c.childIds;
      delete c.attachments;
      c.status = TaskStatus.Open;
      if (parentId) c.parentId = parentId;
      else delete c.parentId;
      if (order !== undefined) c.sortOrder = order;
      c.items = (c.items ?? []).map((it) => ({ ...it, id: newId() }));
      await this.db.tasks.add(c);
      await this.engine.enqueue("task", c.id, { add: true });
      if (parentId) {
        const p = await this.db.tasks.get(parentId);
        if (p) await this.db.tasks.update(parentId, { childIds: [...(p.childIds ?? []), c.id] });
      }
      if (withSubtasks) {
        const kids = await this.db.tasks.where("parentId").equals(src.id).filter((k) => !k.deleted).toArray();
        for (const k of kids) await copy(k, c.id);
      }
      return c;
    };
    const c = await copy(t, t.parentId ?? undefined, t.sortOrder + 1);
    this.kick();
    return c;
  }

  async reorder(id: string, sortOrder: number): Promise<void> {
    await this.updateTask(id, { sortOrder });
  }

  /** Renumber a whole sequence (gap exhausted). */
  async renumber(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i++) await this.updateTask(ids[i]!, { sortOrder: i * ORDER_STEP });
  }

  async convertKind(id: string, kind: "TEXT" | "NOTE" | "CHECKLIST"): Promise<string | null> {
    const t = await this.db.tasks.get(id);
    if (!t) return null;
    if (kind === "NOTE") {
      const kids = await this.db.tasks.where("parentId").equals(id).filter((k) => !k.deleted).count();
      if (kids > 0) return "Tasks with subtasks cannot be converted to notes";
      await this.updateTask(id, { kind: "NOTE", priority: 0, progress: undefined }, { undo: "Converted to note" });
      return null;
    }
    if (kind === "CHECKLIST" && t.kind !== "CHECKLIST") {
      // TASK-163: each non-empty body line becomes a checklist item; markdown list markers are stripped.
      const lines = (t.content ?? "").split(/\r?\n/).map((l) => l.replace(/^\s*([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?/, "").trim()).filter(Boolean);
      const items: ChecklistItem[] = lines.map((title, i) => ({ id: newId(), title, status: 0, sortOrder: i * ORDER_STEP }));
      await this.updateTask(id, { kind: "CHECKLIST", desc: "", content: "", items: [...(t.items ?? []), ...items] }, { undo: "Converted to checklist" });
      return null;
    }
    if (kind === "TEXT" && t.kind === "CHECKLIST") {
      const body = (t.items ?? []).map((it) => `- [${it.status ? "x" : " "}] ${it.title}`).join("\n");
      await this.updateTask(id, { kind: "TEXT", content: [t.desc ?? "", body].filter(Boolean).join("\n"), desc: "", items: [] }, { undo: "Converted to task" });
      return null;
    }
    await this.updateTask(id, { kind });
    return null;
  }

  async removeAttachment(taskId: string, attachmentId: string): Promise<void> {
    const t = await this.db.tasks.get(taskId);
    if (!t) return;
    const a = (t.attachments ?? []).find((x) => x.id === attachmentId);
    await this.db.tasks.update(taskId, { attachments: (t.attachments ?? []).filter((x) => x.id !== attachmentId) });
    if (a?.localBlob) {
      // never uploaded: cancel the upload instead
      await this.db.blobs.delete(a.localBlob as string);
      const ops = await this.db.outbox.where("[kind+key]").equals(["upload", attachmentId]).toArray();
      await this.db.outbox.bulkDelete(ops.map((o) => o.seq!));
    } else await this.engine.enqueue("attachmentDelete", attachmentId, { taskId, attachmentId });
    this.kick();
  }

  async addAttachment(taskId: string, file: File | Blob, fileName: string): Promise<void> {
    const t = await this.db.tasks.get(taskId);
    if (!t) return;
    const attachmentId = newId();
    const blobKey = attachmentId;
    await this.db.blobs.put({ id: blobKey, blob: file, name: fileName, type: file.type });
    const local: Attachment = {
      id: attachmentId,
      refId: attachmentId,
      path: "",
      fileName,
      fileType: file.type.startsWith("image/") ? "IMAGE" : "OTHER",
      size: file.size,
      status: 0,
      createdTime: toServer(Date.now()),
      localBlob: blobKey,
    };
    await this.db.tasks.update(taskId, { attachments: [...(t.attachments ?? []), local] });
    // the task must exist on the server before its file: push pending task ops first
    await this.engine.enqueue("upload", attachmentId, { taskId, projectId: t.projectId, attachmentId, blobKey, fileName });
    this.kick();
  }

  // ---------------------------------------------------------------- lists and folders

  async createProject(p: Partial<Project> & { name: string }): Promise<Project> {
    const all = await this.db.projects.toArray();
    const proj: Project = {
      id: newId(),
      sortOrder: orderForBottom(all.map((x) => x.sortOrder)),
      color: null,
      viewMode: "list",
      kind: "TASK",
      inAll: true,
      closed: null,
      groupId: null,
      sortOption: { groupBy: "sortOrder", orderBy: "sortOrder", order: "asc" },
      sortType: "sortOrder",
      modifiedTime: toServer(Date.now()),
      isOwner: true,
      userCount: 1,
      ...p,
      name: cleanListName(p.name),
    };
    await this.db.projects.add(proj);
    await this.engine.enqueue("project", proj.id, { add: true });
    this.kick();
    return proj;
  }
  async updateProject(id: string, patch: Partial<Project>): Promise<void> {
    const p = await this.db.projects.get(id);
    if (!p) return;
    const next = { ...p, ...patch };
    if (patch.name !== undefined) next.name = cleanListName(patch.name);
    await this.db.projects.put(next);
    await this.engine.enqueue("project", id, {});
    this.kick();
  }
  async deleteProject(id: string): Promise<void> {
    const tasks = await this.db.tasks.where("projectId").equals(id).toArray();
    for (const t of tasks) await this.db.tasks.update(t.id, { deleted: 1, deletedTime: Date.now() });
    await this.db.projects.delete(id);
    await this.engine.enqueue("projectDelete", id, {});
    this.kick();
  }
  async duplicateProject(id: string, mode: "open" | "all" | "allReset"): Promise<Project | undefined> {
    const p = await this.db.projects.get(id);
    if (!p) return;
    const np = await this.createProject({ ...structuredClone(p), id: undefined as never, etag: undefined, name: `${p.name} copy`, sortOrder: p.sortOrder + 1 });
    const tasks = await this.db.tasks.where("projectId").equals(id).filter((t) => !t.deleted && !t.parentId && (mode !== "open" || t.status === 0)).toArray();
    for (const t of tasks) {
      const c = await this.duplicateTask(t.id, true);
      if (c) {
        await this.moveTasks([c.id], np.id);
        if (mode === "all" && t.status !== 0) await this.updateTask(c.id, { status: t.status, completedTime: t.completedTime });
      }
    }
    return np;
  }
  async createGroup(name: string): Promise<ProjectGroup> {
    const all = await this.db.groups.toArray();
    const projs = await this.db.projects.toArray();
    const g: ProjectGroup = { id: newId(), name: cleanListName(name), sortOrder: orderForBottom([...all.map((x) => x.sortOrder), ...projs.map((x) => x.sortOrder)]), sortType: "project", sortOption: { groupBy: "project", orderBy: "sortOrder", order: "asc" }, teamId: null };
    await this.db.groups.add(g);
    await this.engine.enqueue("group", g.id, { add: true });
    this.kick();
    return g;
  }
  async updateGroup(id: string, patch: Partial<ProjectGroup>): Promise<void> {
    const g = await this.db.groups.get(id);
    if (!g) return;
    await this.db.groups.put({ ...g, ...patch });
    await this.engine.enqueue("group", id, {});
    this.kick();
  }
  /** Ungroup: the folder goes, its lists stay (server clears their groupId too). */
  async deleteGroup(id: string): Promise<void> {
    for (const p of await this.db.projects.filter((p) => p.groupId === id).toArray()) await this.db.projects.update(p.id, { groupId: null });
    await this.db.groups.delete(id);
    await this.engine.enqueue("groupDelete", id, {});
    this.kick();
  }

  // ---------------------------------------------------------------- tags

  async ensureTags(names: string[]): Promise<void> {
    for (const raw of names) {
      const name = raw.toLowerCase();
      if (!name || (await this.db.tags.get(name))) continue;
      const all = await this.db.tags.toArray();
      const tag: Tag = { name, rawName: raw, label: raw, color: null, sortOrder: orderForBottom(all.map((t) => t.sortOrder ?? 0)), sortType: "project", parent: null };
      await this.db.tags.add(tag);
      await this.engine.enqueue("tag", name, { add: true });
    }
  }
  async createTag(label: string, patch: Partial<Tag> = {}): Promise<Tag | null> {
    const clean = cleanTagName(label);
    if (!clean) return null;
    await this.ensureTags([clean]);
    if (Object.keys(patch).length) await this.updateTag(clean.toLowerCase(), patch);
    this.kick();
    return (await this.db.tags.get(clean.toLowerCase())) ?? null;
  }
  async updateTag(name: string, patch: Partial<Tag>): Promise<void> {
    const t = await this.db.tags.get(name);
    if (!t) return;
    await this.db.tags.put({ ...t, ...patch, name });
    await this.engine.enqueue("tag", name, {});
    this.kick();
  }
  /** Rename or merge: rewrites the tag on every local task (the server does the same on its side). */
  async renameTag(name: string, newLabel: string, merge = false): Promise<void> {
    const clean = cleanTagName(newLabel);
    const key = clean.toLowerCase();
    if (!clean || key === name) {
      if (clean) await this.updateTag(name, { label: clean, rawName: clean });
      return;
    }
    const exists = await this.db.tags.get(key);
    const doMerge = merge || !!exists;
    const old = await this.db.tags.get(name);
    await this.db.transaction("rw", this.db.tasks, this.db.tags, async () => {
      const tasks = await this.db.tasks.filter((t) => (t.tags ?? []).some((x) => x.toLowerCase() === name)).toArray();
      for (const t of tasks) await this.db.tasks.update(t.id, { tags: [...new Set((t.tags ?? []).map((x) => (x.toLowerCase() === name ? key : x)))] });
      await this.db.tags.delete(name);
      if (!exists) await this.db.tags.put({ ...(old ?? {}), name: key, rawName: clean, label: clean } as Tag);
      for (const child of await this.db.tags.filter((t) => t.parent === name).toArray()) await this.db.tags.update(child.name, { parent: key });
    });
    await this.engine.enqueue(doMerge ? "tagMerge" : "tagRename", name, { name, newName: clean });
    this.kick();
  }
  async deleteTag(name: string): Promise<void> {
    await this.db.transaction("rw", this.db.tasks, this.db.tags, async () => {
      const tasks = await this.db.tasks.filter((t) => (t.tags ?? []).some((x) => x.toLowerCase() === name)).toArray();
      for (const t of tasks) await this.db.tasks.update(t.id, { tags: (t.tags ?? []).filter((x) => x.toLowerCase() !== name) });
      await this.db.tags.delete(name);
    });
    await this.engine.enqueue("tagDelete", name, { name });
    this.kick();
  }

  // ---------------------------------------------------------------- kanban columns (sections)

  async columnsOf(projectId: string): Promise<Column[]> {
    return (await this.db.columns.where("projectId").equals(projectId).toArray()).sort((a, b) => a.sortOrder - b.sortOrder);
  }
  /** Add a column at the end (or at a given sortOrder). Names must be unique within the list (KANB-802); no count limit. */
  async createColumn(projectId: string, name: string, sortOrder?: number): Promise<Column | string> {
    const clean = name.trim();
    if (!clean) return "Name required";
    const cols = await this.columnsOf(projectId);
    if (cols.some((c) => c.name.toLowerCase() === clean.toLowerCase())) return "A section with this name already exists";
    const now = toServer(Date.now());
    const col: Column = { id: newId(), projectId, name: clean, sortOrder: sortOrder ?? orderForBottom(cols.map((c) => c.sortOrder)), createdTime: now, modifiedTime: now };
    await this.db.transaction("rw", this.db.columns, this.db.outbox, async () => {
      await this.db.columns.add(col);
      await this.engine.enqueue("column", col.id, { add: true });
    });
    this.kick();
    return col;
  }
  async updateColumn(id: string, patch: Partial<Column>): Promise<string | null> {
    const c = await this.db.columns.get(id);
    if (!c) return "missing";
    if (patch.name !== undefined) {
      const clean = patch.name.trim();
      if (!clean) return "Name required";
      const cols = await this.columnsOf(c.projectId);
      if (cols.some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) return "A section with this name already exists";
      patch = { ...patch, name: clean };
    }
    await this.db.transaction("rw", this.db.columns, this.db.outbox, async () => {
      await this.db.columns.put({ ...c, ...patch, modifiedTime: toServer(Date.now()) });
      await this.engine.enqueue("column", id, {});
    });
    this.kick();
    return null;
  }
  /**
   * Delete a column (KANB-005). NoorTasks keeps its tasks and
   * moves them to the list's first remaining column, or leaves them unsectioned when none remains.
   */
  async deleteColumn(id: string): Promise<void> {
    const c = await this.db.columns.get(id);
    if (!c) return;
    const rest = (await this.columnsOf(c.projectId)).filter((x) => x.id !== id);
    const tasks = await this.db.tasks.where("projectId").equals(c.projectId).filter((t) => t.columnId === id).toArray();
    await this.db.columns.delete(id);
    await this.engine.enqueue("columnDelete", id, { columnId: id, projectId: c.projectId });
    for (const t of tasks) await this.updateTask(t.id, { columnId: rest[0]?.id ?? undefined });
    this.kick();
  }
  /** Move a column between two neighbours (drag reorder). */
  async moveColumn(id: string, before: number | undefined, after: number | undefined): Promise<void> {
    const c = await this.db.columns.get(id);
    if (!c) return;
    const r = orderBetweenSafe(before, after);
    if (r === null) {
      const cols = await this.columnsOf(c.projectId);
      for (let i = 0; i < cols.length; i++) await this.updateColumn(cols[i]!.id, { sortOrder: i * ORDER_STEP });
      return;
    }
    await this.updateColumn(id, { sortOrder: r });
  }
  /**
   * Put a task into a column at a sortOrder; a column of another list moves the task there first
   * (KANB-008: list move plus column set). The column write is queued after the move.
   */
  async moveToColumn(taskId: string, column: { id: string | null; projectId: string }, sortOrder?: number): Promise<void> {
    const t = await this.db.tasks.get(taskId);
    if (!t) return;
    const snap = await this.snapshot([taskId]);
    if (t.projectId !== column.projectId) await this.moveTasks([taskId], column.projectId);
    const patch: Partial<Task> = { columnId: column.id ?? undefined };
    if (sortOrder !== undefined) patch.sortOrder = sortOrder;
    await this.updateTask(taskId, patch);
    this.pushUndo({ label: "Task moved", undo: () => this.restoreSnapshot(snap) });
  }

  // ---------------------------------------------------------------- extended preferences (matrix, timeline, calendar...)

  async ext(): Promise<Record<string, unknown>> {
    return this.db.getKV<Record<string, unknown>>("ext", {});
  }
  /** Replace one ext section (the server merges per section, so the whole section travels), stamping its mtime. */
  async setExt(section: string, value: unknown): Promise<void> {
    const cur = await this.ext();
    const v = value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>), mtime: Date.now() } : value;
    await this.db.setKV("ext", { ...cur, [section]: v });
    await this.engine.enqueue("ext", "ext", { [section]: v });
    this.kick();
  }

  /** Manual order of a task inside a matrix quadrant (MTRX-018): local map plus a batch/order record. */
  async setMatrixOrder(scope: string, taskId: string, order: number): Promise<void> {
    const cur = await this.db.getKV<Record<string, Record<string, number>>>("matrixOrders", {});
    await this.db.setKV("matrixOrders", { ...cur, [scope]: { ...(cur[scope] ?? {}), [taskId]: order } });
    await this.engine.enqueue("order", scope, { typeKey: "matrix", records: [{ id: taskId, order, type: 1 }] });
    this.kick();
  }

  // ---------------------------------------------------------------- custom filters (M5)

  async createFilter(name: string, rule: string): Promise<Filter> {
    const all = await this.db.filters.toArray();
    const sortOrder = all.length ? Math.max(...all.map((f) => f.sortOrder ?? 0)) + ORDER_STEP : 0;
    const f: Filter = { id: newId(), name: cleanListName(name) || "Filter", rule, sortOrder, sortType: "project", viewMode: "list", sortOption: { groupBy: "project", orderBy: "dueDate", order: "asc" } };
    await this.db.transaction("rw", this.db.filters, this.db.outbox, async () => {
      await this.db.filters.add(f);
      await this.engine.enqueue("filter", f.id, { add: true });
    });
    this.kick();
    return f;
  }
  async updateFilter(id: string, patch: Partial<Filter>): Promise<void> {
    await this.db.transaction("rw", this.db.filters, this.db.outbox, async () => {
      const f = await this.db.filters.get(id);
      if (!f) return;
      await this.db.filters.put({ ...f, ...patch, id });
      await this.engine.enqueue("filter", id, {});
    });
    this.kick();
  }
  async deleteFilter(id: string): Promise<void> {
    await this.db.transaction("rw", this.db.filters, this.db.outbox, async () => {
      await this.db.filters.delete(id);
      await this.engine.enqueue("filterDelete", id, {});
    });
    this.kick();
  }
  async duplicateFilter(id: string): Promise<Filter | undefined> {
    const f = await this.db.filters.get(id);
    if (!f) return undefined;
    return this.createFilter(`${f.name} copy`, f.rule ?? "");
  }

  /** Apply a server-side change to a task row without queueing an op (snooze, close reminder). */
  async patchFromServer(id: string, patch: Partial<Task>): Promise<void> {
    await this.db.tasks.update(id, patch as never);
  }

  // ---------------------------------------------------------------- settings

  async setSettings(patch: Partial<Preferences>): Promise<void> {
    const cur = await this.settings();
    await this.db.setKV("settings", { ...cur, ...patch });
    await this.engine.enqueue("settings", "settings", patch as Record<string, unknown>);
    this.kick();
  }
}
