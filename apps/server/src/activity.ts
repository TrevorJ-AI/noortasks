import {
  ActivityAction,
  TaskStatus,
  formatServerDate,
  isPlainObject,
  newId,
  type ActivityEntry,
  type Loose,
  type Task,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import { numOr } from "./m4util.js";
import { currentActor } from "./actor.js";
import { ApiError, type Service } from "./service.js";

export interface ActivityInput {
  taskId?: string | null;
  projectId: string;
  action: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  summary?: string;
  taskTitle?: string;
}

const PRIORITY_NAMES: Record<number, string> = { 0: "None", 1: "Low", 3: "Medium", 5: "High" };

const IGNORED_ON_UPDATE = new Set([
  "etag", "modifiedTime", "createdTime", "creator", "attachments", "parentId",
  "childIds", "commentCount", "focusSummaries", "deleted", "deletedTime", "deletedBy", "projectId",
]);

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return a === b;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Records and serves per-task and per-list activity history. */
export class ActivityService {
  constructor(private svc: Service) {}

  private get store() {
    return this.svc.store;
  }

  record(input: ActivityInput): ActivityEntry {
    const when = this.svc.now();
    const createdTime = formatServerDate(when);
    const id = newId(when);
    const entry: ActivityEntry = {
      id,
      taskId: input.taskId ?? null,
      projectId: input.projectId,
      action: input.action,
      ...(input.field !== undefined ? { field: input.field } : {}),
      ...(input.oldValue !== undefined ? { oldValue: input.oldValue } : {}),
      ...(input.newValue !== undefined ? { newValue: input.newValue } : {}),
      ...(input.summary !== undefined ? { summary: input.summary } : {}),
      ...(input.taskTitle !== undefined ? { taskTitle: input.taskTitle } : {}),
      userId: currentActor()?.userId ?? this.svc.userId,
      ...(currentActor() ? { userName: currentActor()!.name } : {}),
      createdTime,
      when,
    };
    this.store.run(
      "insert into activities(id, taskId, projectId, action, whenMs, json) values (?,?,?,?,?,?)",
      id,
      entry.taskId ?? null,
      entry.projectId,
      entry.action,
      when,
      JSON.stringify(entry),
    );
    return entry;
  }

  recordTaskCreated(task: Task): void {
    this.record({
      taskId: task.id,
      projectId: task.projectId,
      action: ActivityAction.Create,
      summary: `Created task "${task.title ?? ""}"`,
      taskTitle: task.title ?? "",
    });
  }

  recordTaskUpdate(oldTask: Task, nextTask: Task): void {
    const base = { taskId: nextTask.id, projectId: nextTask.projectId, taskTitle: nextTask.title ?? "" };
    let recorded = 0;
    const emit = (action: string, field: string, oldValue: unknown, newValue: unknown, summary: string): void => {
      this.record({ ...base, action, field, oldValue, newValue, summary });
      recorded++;
    };

    const oldStatus = oldTask.status ?? TaskStatus.Open;
    const newStatus = nextTask.status ?? TaskStatus.Open;
    if (oldStatus !== newStatus) {
      if (newStatus === TaskStatus.Completed) emit(ActivityAction.Complete, "status", oldStatus, newStatus, "Completed task");
      else if (newStatus === TaskStatus.WontDo) emit(ActivityAction.WontDo, "status", oldStatus, newStatus, "Marked task Won't Do");
      else emit(ActivityAction.Reopen, "status", oldStatus, newStatus, "Reopened task");
    }

    if ((oldTask.title ?? "") !== (nextTask.title ?? "")) {
      emit(ActivityAction.Title, "title", oldTask.title ?? "", nextTask.title ?? "", "Updated title");
    }

    if ((oldTask.content ?? "") !== (nextTask.content ?? "") || (oldTask.desc ?? "") !== (nextTask.desc ?? "")) {
      emit(
        ActivityAction.Content,
        "content",
        oldTask.content ?? oldTask.desc ?? "",
        nextTask.content ?? nextTask.desc ?? "",
        "Updated description",
      );
    }

    if (
      !sameJson(oldTask.startDate ?? null, nextTask.startDate ?? null) ||
      !sameJson(oldTask.dueDate ?? null, nextTask.dueDate ?? null) ||
      (oldTask.isAllDay ?? null) !== (nextTask.isAllDay ?? null) ||
      (oldTask.timeZone ?? null) !== (nextTask.timeZone ?? null)
    ) {
      emit(
        ActivityAction.Due,
        "dueDate",
        { startDate: oldTask.startDate ?? null, dueDate: oldTask.dueDate ?? null },
        { startDate: nextTask.startDate ?? null, dueDate: nextTask.dueDate ?? null },
        "Updated date",
      );
    }

    const oldP = oldTask.priority ?? 0;
    const newP = nextTask.priority ?? 0;
    if (oldP !== newP) {
      emit(
        ActivityAction.Priority,
        "priority",
        oldP,
        newP,
        `Changed priority from ${PRIORITY_NAMES[oldP] ?? oldP} to ${PRIORITY_NAMES[newP] ?? newP}`,
      );
    }

    if (!sameJson(oldTask.tags ?? [], nextTask.tags ?? [])) {
      emit(ActivityAction.Tag, "tags", oldTask.tags ?? [], nextTask.tags ?? [], "Updated tags");
    }

    if (
      !sameJson(oldTask.reminders ?? [], nextTask.reminders ?? []) ||
      (oldTask.snoozeReminderTime ?? null) !== (nextTask.snoozeReminderTime ?? null) ||
      (oldTask.annoyingAlert ?? null) !== (nextTask.annoyingAlert ?? null)
    ) {
      emit(ActivityAction.Reminder, "reminders", oldTask.reminders ?? [], nextTask.reminders ?? [], "Updated reminders");
    }

    if ((oldTask.repeatFlag ?? null) !== (nextTask.repeatFlag ?? null) || (oldTask.repeatFrom ?? null) !== (nextTask.repeatFrom ?? null)) {
      emit(ActivityAction.Repeat, "repeatFlag", oldTask.repeatFlag ?? null, nextTask.repeatFlag ?? null, "Updated repeat rule");
    }

    if (!sameJson(oldTask.items ?? [], nextTask.items ?? [])) {
      emit(ActivityAction.Items, "items", oldTask.items ?? [], nextTask.items ?? [], "Updated checklist");
    }

    if ((oldTask.columnId ?? null) !== (nextTask.columnId ?? null)) {
      emit(ActivityAction.Column, "columnId", oldTask.columnId ?? null, nextTask.columnId ?? null, "Moved to column");
    }

    if ((oldTask.assignee ?? null) !== (nextTask.assignee ?? null)) {
      emit(ActivityAction.Assign, "assignee", oldTask.assignee ?? null, nextTask.assignee ?? null, "Updated assignee");
    }

    if ((oldTask.pinnedTime ?? null) !== (nextTask.pinnedTime ?? null)) {
      emit(ActivityAction.Pin, "pinnedTime", oldTask.pinnedTime ?? null, nextTask.pinnedTime ?? null, nextTask.pinnedTime ? "Pinned task" : "Unpinned task");
    }

    if (recorded === 0) {
      const keys = new Set([...Object.keys(oldTask), ...Object.keys(nextTask)]);
      for (const k of keys) {
        if (IGNORED_ON_UPDATE.has(k)) continue;
        if (!sameJson((oldTask as Loose)[k], (nextTask as Loose)[k])) {
          this.record({ ...base, action: ActivityAction.Update, field: k, summary: `Updated ${k}` });
          break;
        }
      }
    }
  }

  taskActivities(taskId: string, limit = 100, offset = 0): ActivityEntry[] {
    if (!this.store.getTaskRow(taskId)) throw new ApiError(404, "task_not_found");
    const lim = Math.max(1, Math.min(limit || 100, 1000));
    const off = Math.max(0, offset || 0);
    return this.store
      .all<{ json: string }>("select json from activities where taskId = ? order by whenMs desc, rowid desc limit ? offset ?", taskId, lim, off)
      .map((r) => JSON.parse(r.json) as ActivityEntry);
  }

  projectActivities(projectId: string, limit = 100, offset = 0): ActivityEntry[] {
    const exists = projectId === this.svc.inboxId || this.store.collGet("projects", projectId) !== undefined;
    const hasRows = this.store.get<{ n: number }>("select count(*) as n from activities where projectId = ?", projectId)!.n > 0;
    if (!exists && !hasRows) throw new ApiError(404, "project_not_found");
    const lim = Math.max(1, Math.min(limit || 100, 1000));
    const off = Math.max(0, offset || 0);
    return this.store
      .all<{ json: string }>("select json from activities where projectId = ? order by whenMs desc, rowid desc limit ? offset ?", projectId, lim, off)
      .map((r) => JSON.parse(r.json) as ActivityEntry);
  }

  countActivities(body: unknown): { count: number; counts?: Record<string, number> } {
    if (body !== undefined && !isPlainObject(body)) throw new ApiError(400, "invalid_body");
    const b = isPlainObject(body) ? body : {};
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (typeof b.action === "string" && b.action) {
      where.push("action = ?");
      args.push(b.action);
    }
    if (typeof b.taskId === "string" && b.taskId) {
      where.push("taskId = ?");
      args.push(b.taskId);
    }
    if (typeof b.projectId === "string" && b.projectId) {
      where.push("projectId = ?");
      args.push(b.projectId);
    }
    const clause = where.length ? `where ${where.join(" and ")}` : "";
    const total = this.store.get<{ n: number }>(`select count(*) as n from activities ${clause}`, ...args)!.n;
    if (Array.isArray(b.taskIds)) {
      const ids = b.taskIds.filter((x): x is string => typeof x === "string" && x.length > 0);
      const counts: Record<string, number> = {};
      for (const id of ids) {
        const subWhere = [...where, "taskId = ?"];
        const subArgs = [...args, id];
        counts[id] = this.store.get<{ n: number }>(`select count(*) as n from activities where ${subWhere.join(" and ")}`, ...subArgs)!.n;
      }
      return { count: total, counts };
    }
    return { count: total };
  }
}

export function registerActivityRoutes(app: FastifyInstance, act: ActivityService): void {
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>("/api/v1/task/activity/:id", async (req) =>
    act.taskActivities(req.params.id, numOr(req.query.limit, 100), numOr(req.query.offset, 0)),
  );
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>("/api/v1/project/:id/activity", async (req) =>
    act.projectActivities(req.params.id, numOr(req.query.limit, 100), numOr(req.query.offset, 0)),
  );
  app.post("/api/v2/task/activity/count/all", async (req) => act.countActivities(req.body));
}
