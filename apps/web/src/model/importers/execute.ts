import {
  MAX_TASK_DEPTH,
  ORDER_STEP,
  TaskKind,
  TaskStatus,
  clampOrder,
  formatServerDate,
  orderForBottom,
  type ChecklistItem,
  type Column,
  type Project,
  type ProjectGroup,
  type Tag,
  type Task,
} from "../../lib/core";
import { newEtag, newId } from "../../lib/ids";
import { cleanTagName } from "../../data/repo";
import type { NoorDb } from "../../data/db";
import type { SyncEngine } from "../../data/sync";
import { deterministicId } from "./ids";
import type { ImportBundle, ImportResult, ImportTask } from "./types";

function uniqueId(preferred: string, used: Set<string>): string {
  if (!used.has(preferred)) {
    used.add(preferred);
    return preferred;
  }
  const fallback = newId();
  used.add(fallback);
  return fallback;
}

/**
 * Execute an ImportBundle locally inside Dexie and queue standard sync outbox ops.
 * Re-importing the same bundle skips existing tasks by deterministic ID without duplicating rows.
 */
export async function executeImportBundle(
  db: NoorDb,
  engine: SyncEngine,
  bundle: ImportBundle,
  opts: { now?: number } = {},
): Promise<ImportResult> {
  const nowMs = opts.now ?? Date.now();
  const nowWire = formatServerDate(nowMs);
  const inboxId = await db.getKV<string>("inboxId", "inbox0");

  const res: ImportResult = {
    imported: 0,
    skipped: 0,
    createdProjects: 0,
    createdFolders: 0,
    createdTags: 0,
    createdColumns: 0,
    losses: [...bundle.losses],
  };

  await db.transaction("rw", [db.groups, db.projects, db.columns, db.tags, db.tasks, db.outbox], async () => {
    const existingGroups = await db.groups.toArray();
    const existingProjects = await db.projects.toArray();
    const existingColumns = await db.columns.toArray();
    const existingTags = await db.tags.toArray();
    const existingTasks = await db.tasks.toArray();

    const groupByName = new Map(existingGroups.map((g) => [g.name, g]));
    const usedGroupIds = new Set(existingGroups.map((g) => g.id));

    const projectByName = new Map(existingProjects.map((p) => [p.name, p]));
    const usedProjectIds = new Set([inboxId, ...existingProjects.map((p) => p.id)]);

    const colByProjName = new Map<string, Column>();
    const usedColumnIds = new Set<string>();
    for (const c of existingColumns) {
      colByProjName.set(`${c.projectId}\0${c.name}`, c);
      usedColumnIds.add(c.id);
    }

    const tagByName = new Map(existingTags.map((t) => [t.name.toLowerCase(), t]));
    const existingTaskById = new Map(existingTasks.map((t) => [t.id, t]));

    // 1. Folders
    const folderKeyToId = new Map<string, string>();
    let nextGroupOrder = orderForBottom([...existingGroups.map((g) => g.sortOrder), ...existingProjects.map((p) => p.sortOrder)]);
    for (const f of bundle.folders) {
      const cleanName = f.name.trim();
      if (!cleanName) continue;
      let grp = groupByName.get(cleanName);
      if (!grp) {
        const id = uniqueId(deterministicId(`${bundle.source}:folder`, f.sourceKey), usedGroupIds);
        grp = {
          id,
          name: cleanName,
          sortOrder: f.sortOrder ?? nextGroupOrder,
          sortType: "project",
          sortOption: { groupBy: "project", orderBy: "sortOrder", order: "asc" },
          teamId: null,
          etag: newEtag(),
        };
        nextGroupOrder += ORDER_STEP;
        await db.groups.add(grp);
        await engine.enqueue("group", grp.id, { add: true });
        groupByName.set(cleanName, grp);
        res.createdFolders++;
      }
      folderKeyToId.set(f.sourceKey, grp.id);
    }

    // 2. Lists / Projects
    const listKeyToId = new Map<string, string>();
    let nextProjOrder = existingProjects.length > 0
      ? Math.min(...existingProjects.map((p) => p.sortOrder)) - ORDER_STEP
      : -ORDER_STEP;

    const ensureProject = async (
      listKey: string,
      name: string,
      optsProj?: { folderKey?: string; viewMode?: "list" | "kanban" | "timeline"; color?: string | null; kind?: "TASK" | "NOTE" },
    ): Promise<string> => {
      const cached = listKeyToId.get(listKey);
      if (cached) return cached;

      const cleanName = name.trim();
      if (!cleanName || cleanName.toLowerCase() === "inbox" || listKey.toLowerCase() === "inbox") {
        listKeyToId.set(listKey, inboxId);
        return inboxId;
      }

      let proj = projectByName.get(cleanName);
      if (!proj) {
        const id = uniqueId(deterministicId(`${bundle.source}:list`, listKey), usedProjectIds);
        const groupId = optsProj?.folderKey ? (folderKeyToId.get(optsProj.folderKey) ?? null) : null;
        proj = {
          id,
          name: cleanName,
          color: optsProj?.color ?? null,
          sortOrder: nextProjOrder,
          viewMode: optsProj?.viewMode ?? "list",
          kind: optsProj?.kind ?? "TASK",
          inAll: true,
          isOwner: true,
          userCount: 1,
          muted: false,
          closed: null,
          groupId,
          sortOption: { groupBy: "sortOrder", orderBy: "sortOrder", order: "asc" },
          sortType: "sortOrder",
          etag: newEtag(),
          modifiedTime: nowWire,
        };
        nextProjOrder -= ORDER_STEP;
        await db.projects.add(proj);
        await engine.enqueue("project", proj.id, { add: true });
        projectByName.set(cleanName, proj);
        res.createdProjects++;
      }
      listKeyToId.set(listKey, proj.id);
      return proj.id;
    };

    for (const l of bundle.lists) {
      await ensureProject(l.sourceKey, l.name, {
        ...(l.folderKey !== undefined ? { folderKey: l.folderKey } : {}),
        ...(l.viewMode !== undefined ? { viewMode: l.viewMode } : {}),
        ...(l.color !== undefined ? { color: l.color } : {}),
        ...(l.kind !== undefined ? { kind: l.kind } : {}),
      });
    }
    for (const t of bundle.tasks) {
      if (!listKeyToId.has(t.listKey)) {
        await ensureProject(t.listKey, t.listKey);
      }
    }

    // 3. Kanban Sections / Columns
    const sectionKeyToId = new Map<string, string>();
    for (const s of bundle.sections) {
      const projectId = listKeyToId.get(s.listKey) ?? inboxId;
      if (projectId === inboxId) continue;
      const cleanName = s.name.trim();
      if (!cleanName) continue;
      const ck = `${projectId}\0${cleanName}`;
      let col = colByProjName.get(ck);
      if (!col) {
        const id = uniqueId(deterministicId(`${bundle.source}:section`, s.sourceKey), usedColumnIds);
        const projColsCount = [...colByProjName.values()].filter((c) => c.projectId === projectId).length;
        col = {
          id,
          projectId,
          name: cleanName,
          sortOrder: s.sortOrder ?? projColsCount * ORDER_STEP,
          etag: newEtag(),
          createdTime: nowWire,
          modifiedTime: nowWire,
        };
        await db.columns.add(col);
        await engine.enqueue("column", col.id, { add: true });
        colByProjName.set(ck, col);
        res.createdColumns++;
      }
      sectionKeyToId.set(s.sourceKey, col.id);
    }

    // 4. Tags
    const ensureTag = async (rawLabel: string, color?: string | null): Promise<string | null> => {
      const clean = cleanTagName(rawLabel);
      if (!clean) return null;
      const low = clean.toLowerCase();
      if (!tagByName.has(low)) {
        const tag: Tag = {
          name: low,
          rawName: clean,
          label: clean,
          color: color ?? null,
          sortOrder: orderForBottom([...tagByName.values()].map((t) => t.sortOrder ?? 0)),
          sortType: "project",
          parent: null,
          etag: newEtag(),
        };
        await db.tags.add(tag);
        await engine.enqueue("tag", low, { add: true });
        tagByName.set(low, tag);
        res.createdTags++;
      }
      return low;
    };

    for (const t of bundle.tags) {
      await ensureTag(t.label || t.name, t.color);
    }

    // 5. Tasks: deterministic IDs, skip existing, resolve hierarchy topologically
    const sourceToResolvedId = new Map<string, string>();
    const pendingById = new Map<string, { src: ImportTask; task: Task }>();

    for (const src of bundle.tasks) {
      const id = src.explicitId?.trim() || deterministicId(bundle.source, src.sourceId);
      if (!sourceToResolvedId.has(src.sourceId)) {
        sourceToResolvedId.set(src.sourceId, id);
      }
      if (existingTaskById.has(id) || pendingById.has(id)) {
        res.skipped++;
        continue;
      }

      const projectId = listKeyToId.get(src.listKey) ?? inboxId;
      const columnId = src.sectionKey && projectId !== inboxId ? sectionKeyToId.get(src.sectionKey) : undefined;
      const taskTags: string[] = [];
      for (const rawTag of src.tags) {
        const norm = await ensureTag(rawTag);
        if (norm && !taskTags.includes(norm)) taskTags.push(norm);
      }

      const items: ChecklistItem[] | undefined = src.items?.map((it, idx) => ({
        id: deterministicId(bundle.source, `${src.sourceId}:item:${it.sourceId ?? idx}`),
        title: it.title,
        status: it.status,
        sortOrder: it.sortOrder ?? idx * ORDER_STEP,
      }));

      const reminders = src.reminders?.map((r, idx) => ({
        id: deterministicId(bundle.source, `${src.sourceId}:rem:${idx}`),
        trigger: r.trigger,
      }));

      const closed = src.status === TaskStatus.Completed || src.status === TaskStatus.WontDo;
      const completedTime = src.completedTime ?? (closed ? nowWire : undefined);
      const sortOrder = src.sortOrder !== undefined ? clampOrder(src.sortOrder) : 0;

      const task: Task = {
        id,
        projectId,
        title: src.title,
        kind: src.kind ?? TaskKind.Text,
        status: src.status,
        priority: src.priority,
        sortOrder,
        createdTime: src.createdTime ?? nowWire,
        modifiedTime: nowWire,
        etag: newEtag(),
        deleted: 0,
        ...(src.content ? { content: src.content } : {}),
        ...(src.desc ? { desc: src.desc } : {}),
        ...(items ? { items } : {}),
        ...(taskTags.length ? { tags: taskTags } : {}),
        ...(src.startDate ? { startDate: src.startDate } : {}),
        ...(src.dueDate ? { dueDate: src.dueDate } : {}),
        ...(src.isAllDay !== undefined ? { isAllDay: src.isAllDay } : {}),
        ...(src.isFloating !== undefined ? { isFloating: src.isFloating } : {}),
        ...(src.timeZone ? { timeZone: src.timeZone } : {}),
        ...(reminders && reminders.length ? { reminders } : {}),
        ...(src.repeatFlag ? { repeatFlag: src.repeatFlag } : {}),
        ...(src.repeatFrom ? { repeatFrom: src.repeatFrom } : {}),
        ...(src.exDate && src.exDate.length ? { exDate: src.exDate } : {}),
        ...(completedTime ? { completedTime } : {}),
        ...(columnId ? { columnId } : {}),
      };

      pendingById.set(id, { src, task });
    }

    // Link parents with cycle, cross-list, and max-depth protection
    const taskForLookup = (id: string): Task | undefined => pendingById.get(id)?.task ?? existingTaskById.get(id);
    const parentLinks: Array<{ childId: string; parentId: string }> = [];

    for (const [id, entry] of pendingById) {
      const rawParent = entry.src.parentSourceId?.trim();
      if (!rawParent) continue;
      const parentId = sourceToResolvedId.get(rawParent) ?? rawParent;
      if (parentId === id) {
        res.losses.push({ category: "subtask_depth", sourceItem: entry.task.title, reason: "Self-referential subtask link dropped" });
        continue;
      }
      const parent = taskForLookup(parentId);
      if (!parent || parent.deleted) {
        res.losses.push({ category: "subtask_cross_list", sourceItem: entry.task.title, reason: "Parent task missing or deleted; imported as top-level task" });
        continue;
      }
      if (parent.projectId !== entry.task.projectId) {
        res.losses.push({ category: "subtask_cross_list", sourceItem: entry.task.title, reason: "Subtask belonged to a different list than parent; imported as top-level task" });
        continue;
      }
      let cur: Task | undefined = parent;
      let depth = 1;
      let cycle = false;
      while (cur && depth <= MAX_TASK_DEPTH + 2) {
        if (cur.id === id) {
          cycle = true;
          break;
        }
        cur = cur.parentId ? taskForLookup(cur.parentId) : undefined;
        depth++;
      }
      if (cycle) {
        res.losses.push({ category: "subtask_depth", sourceItem: entry.task.title, reason: "Cyclic subtask link dropped" });
        continue;
      }
      if (depth > MAX_TASK_DEPTH) {
        res.losses.push({ category: "subtask_depth", sourceItem: entry.task.title, reason: `Subtask nesting exceeded ${MAX_TASK_DEPTH} levels; promoted to top-level task` });
        continue;
      }
      entry.task.parentId = parentId;
      parentLinks.push({ childId: id, parentId });
    }

    // Populate childIds on new parents before persisting and enqueuing; update existing parents locally
    const existingParentUpdates = new Map<string, string[]>();
    for (const { childId, parentId } of parentLinks) {
      const pendingParent = pendingById.get(parentId)?.task;
      if (pendingParent) {
        pendingParent.childIds = [...new Set([...(pendingParent.childIds ?? []), childId])];
      } else {
        const existingParent = existingTaskById.get(parentId);
        if (existingParent) {
          const nextIds = [...new Set([...(existingParentUpdates.get(parentId) ?? existingParent.childIds ?? []), childId])];
          existingParentUpdates.set(parentId, nextIds);
        }
      }
    }
    for (const [pid, childIds] of existingParentUpdates) {
      await db.tasks.update(pid, { childIds });
    }

    // Topological sort: parents before children so server batchTask add links parents cleanly in one pass
    const ordered: Task[] = [];
    const emitted = new Set<string>();
    const visit = (id: string): void => {
      if (emitted.has(id)) return;
      const entry = pendingById.get(id);
      if (!entry) return;
      if (entry.task.parentId && pendingById.has(entry.task.parentId)) {
        visit(entry.task.parentId);
      }
      emitted.add(id);
      ordered.push(entry.task);
    };
    for (const id of pendingById.keys()) visit(id);

    for (const task of ordered) {
      await db.tasks.add(task);
      await engine.enqueue("task", task.id, { add: true });
      res.imported++;
    }
  });

  return res;
}
