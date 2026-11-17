import type { Filter, Project, SortOption, Tag, Task } from "../lib/core";
import { filterMatches } from "./filters";
import { DAY, addDays, dayDiff, isOverdue, parseDate, startOfDay, taskEnd, taskStart, WEEKDAYS_LONG, MONTHS_SHORT } from "../lib/dates";

export type SmartName = "all" | "today" | "tomorrow" | "week" | "assignedme" | "summary" | "completed" | "abandoned" | "trash";

export type ViewRef =
  | { type: "smart"; name: SmartName }
  | { type: "project"; id: string }
  | { type: "group"; id: string }
  | { type: "tag"; name: string }
  | { type: "day"; date: string }
  | { type: "filter"; id: string }
  | { type: "search" };

export interface ViewCtx {
  now: number;
  inboxId: string;
  projects: Project[];
  tags?: Tag[];
  posOfOverdue?: number;
  /** custom filters (M5) */
  filters?: Filter[];
  groups?: Array<{ id: string }>;
  weekStart?: number;
  /** the signed-in account (multi-user): Assigned to Me shows tasks assigned to this id */
  userId?: number;
}

export const GROUP_BY_TASK = ["sortOrder", "dueDate", "createdTime", "tag", "priority", "none"] as const;
export const SORT_BY_TASK = ["sortOrder", "dueDate", "createdTime", "modifiedTime", "title", "tag", "priority"] as const;
export const GROUP_BY_NOTE = ["sortOrder", "createdTime", "tag", "none"] as const;
export const SORT_BY_NOTE = ["sortOrder", "createdTime", "modifiedTime", "title", "tag"] as const;
/** Smart lists, folders and tags also group by list (VIEW-014) and cannot use custom sections (SMART-012). */
export const GROUP_BY_SMART = ["project", "dueDate", "createdTime", "tag", "priority", "none"] as const;

export const OPTION_LABEL: Record<string, string> = {
  sortOrder: "Custom",
  dueDate: "Date",
  createdTime: "Created Time",
  modifiedTime: "Modified Time",
  title: "Title",
  tag: "Tag",
  priority: "Priority",
  project: "List",
  none: "None",
};

export function defaultDirection(orderBy: string): "asc" | "desc" {
  return orderBy === "createdTime" || orderBy === "modifiedTime" || orderBy === "priority" ? "desc" : "asc";
}

export function defaultSortOption(view: ViewRef, inboxId: string): SortOption {
  if (view.type === "project") return view.id === inboxId ? { groupBy: "sortOrder", orderBy: "sortOrder", order: "asc" } : { groupBy: "sortOrder", orderBy: "sortOrder", order: "asc" };
  if (view.type === "group" || view.type === "tag" || view.type === "filter") return { groupBy: "project", orderBy: "dueDate", order: "asc" };
  return { groupBy: "dueDate", orderBy: "dueDate", order: "asc" };
}

const isOpen = (t: Task): boolean => !t.deleted && t.status === 0;

export function inAllSet(projects: Project[], inboxId: string): Set<string> {
  const s = new Set<string>([inboxId]);
  for (const p of projects) if (p.inAll !== false && !p.closed) s.add(p.id);
  return s;
}

/** Does an open task belong to a date smart list. Overdue tasks appear in Today and Next 7 Days. */
export function inDateWindow(t: Task, name: "today" | "tomorrow" | "week", now: number): boolean {
  const s = taskStart(t);
  if (Number.isNaN(s)) return false;
  const today = startOfDay(now);
  const first = startOfDay(s);
  const e = taskEnd(t);
  // last calendar day the task covers (all-day end is exclusive)
  let last = startOfDay(e);
  if (t.isAllDay !== false && e > s && last === e) last = addDays(last, -1);
  if (last < first) last = first;
  const overdue = isOverdue(t, now);
  const covers = (from: number, to: number): boolean => first <= to && last >= from;
  if (name === "today") return overdue || covers(today, today);
  if (name === "tomorrow") {
    const tm = addDays(today, 1);
    return covers(tm, tm);
  }
  return overdue || covers(today, addDays(today, 6));
}

/** Does a task's date span cover a local calendar day (all-day end exclusive). */
export function coversDay(t: Task, dayMs: number): boolean {
  const s = taskStart(t);
  if (Number.isNaN(s)) return false;
  const e = taskEnd(t);
  const first = startOfDay(s);
  let last = startOfDay(e);
  if (t.isAllDay !== false && e > s && last === e) last = addDays(last, -1);
  if (last < first) last = first;
  const d = startOfDay(dayMs);
  return first <= d && last >= d;
}

/** Open tasks of a view, before nesting and grouping. */
export function tasksInView(view: ViewRef, tasks: Task[], ctx: ViewCtx): Task[] {
  const open = tasks.filter(isOpen);
  switch (view.type) {
    case "project":
      return open.filter((t) => t.projectId === view.id);
    case "group": {
      const ids = new Set(ctx.projects.filter((p) => p.groupId === view.id).map((p) => p.id));
      return open.filter((t) => ids.has(t.projectId));
    }
    case "tag": {
      const names = new Set([view.name, ...(ctx.tags ?? []).filter((x) => x.parent === view.name).map((x) => x.name)]);
      return open.filter((t) => (t.tags ?? []).some((x) => names.has(x.toLowerCase())));
    }
    case "day": {
      // tasks of one date (mini calendar, VIEW-039): open tasks whose span covers that day
      const [y, m, d] = view.date.split("-").map(Number);
      const dayMs = new Date(y!, m! - 1, d!).getTime();
      const allowed = inAllSet(ctx.projects, ctx.inboxId);
      return open.filter((t) => allowed.has(t.projectId) && coversDay(t, dayMs));
    }
    case "filter": {
      const f = ctx.filters?.find((x) => x.id === view.id);
      if (!f) return [];
      const projectGroup: Record<string, string | null | undefined> = {};
      for (const p of ctx.projects) projectGroup[p.id] = p.groupId;
      return filterMatches(f.rule, open, { now: ctx.now, projectGroup, weekStart: ctx.weekStart ?? 0 });
    }
    case "smart": {
      const allowed = inAllSet(ctx.projects, ctx.inboxId);
      const pool = open.filter((t) => allowed.has(t.projectId));
      if (view.name === "all") return pool;
      if (view.name === "today" || view.name === "tomorrow" || view.name === "week") return pool.filter((t) => inDateWindow(t, view.name as "today", ctx.now));
      if (view.name === "assignedme") {
        // shared lists are in the pool even when hidden from All
        const mine = (t: Task): boolean => t.assignee !== undefined && t.assignee !== null && Number(t.assignee) > 0 && (ctx.userId === undefined || Number(t.assignee) === ctx.userId);
        return open.filter((t) => mine(t) && (allowed.has(t.projectId) || ctx.projects.some((p) => p.id === t.projectId)));
      }
      return [];
    }
    default:
      return [];
  }
}

export interface TaskGroup {
  key: string;
  label: string;
  tasks: Task[];
  /** extra link on the heading (Overdue: Postpone) */
  action?: "postpone";
}

const PRIORITY_LABEL: Record<number, string> = { 5: "High", 3: "Medium", 1: "Low", 0: "None" };

function firstTag(t: Task, tagOrder: Map<string, number>): string | undefined {
  const tags = (t.tags ?? []).map((x) => x.toLowerCase());
  if (!tags.length) return undefined;
  return [...tags].sort((a, b) => (tagOrder.get(a) ?? 1e18) - (tagOrder.get(b) ?? 1e18) || a.localeCompare(b))[0];
}

export function compareTasks(orderBy: string, order: "asc" | "desc", ctx: ViewCtx): (a: Task, b: Task) => number {
  const dir = order === "desc" ? -1 : 1;
  const tagOrder = new Map((ctx.tags ?? []).map((t) => [t.name, t.sortOrder ?? 0]));
  const projOrder = new Map(ctx.projects.map((p) => [p.id, p.sortOrder]));
  const byOrder = (a: Task, b: Task): number => a.sortOrder - b.sortOrder || (a.createdTime ?? "").localeCompare(b.createdTime ?? "");
  const cmp = (a: Task, b: Task): number => {
    switch (orderBy) {
      case "dueDate": {
        const sa = taskStart(a);
        const sb = taskStart(b);
        const na = Number.isNaN(sa);
        const nb = Number.isNaN(sb);
        if (na !== nb) return na ? 1 : -1; // undated last, regardless of direction
        if (!na && sa !== sb) {
          // same day: all-day before timed
          if (startOfDay(sa) === startOfDay(sb) && (a.isAllDay !== false) !== (b.isAllDay !== false)) return a.isAllDay !== false ? -1 : 1;
          return (sa - sb) * dir;
        }
        return (b.priority ?? 0) - (a.priority ?? 0) || byOrder(a, b);
      }
      case "createdTime":
        return ((parseDate(a.createdTime) || 0) - (parseDate(b.createdTime) || 0)) * dir || byOrder(a, b);
      case "modifiedTime":
        return ((parseDate(a.modifiedTime) || 0) - (parseDate(b.modifiedTime) || 0)) * dir || byOrder(a, b);
      case "title":
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true }) * dir || byOrder(a, b);
      case "priority":
        return ((a.priority ?? 0) - (b.priority ?? 0)) * dir || byOrder(a, b);
      case "tag": {
        const ta = firstTag(a, tagOrder);
        const tb = firstTag(b, tagOrder);
        if (!ta !== !tb) return ta ? -1 : 1;
        if (ta && tb && ta !== tb) return ((tagOrder.get(ta) ?? 0) - (tagOrder.get(tb) ?? 0) || ta.localeCompare(tb)) * dir;
        return byOrder(a, b);
      }
      case "project": {
        const pa = a.projectId === ctx.inboxId ? -Infinity : (projOrder.get(a.projectId) ?? 0);
        const pb = b.projectId === ctx.inboxId ? -Infinity : (projOrder.get(b.projectId) ?? 0);
        return pa === pb ? byOrder(a, b) : (pa < pb ? -1 : 1) * dir;
      }
      default:
        return byOrder(a, b) * dir;
    }
  };
  return cmp;
}

function dateBucket(t: Task, now: number): { key: string; label: string; rank: number } {
  const s = taskStart(t);
  if (Number.isNaN(s)) return { key: "nodate", label: "No Date", rank: 6 };
  if (isOverdue(t, now)) return { key: "overdue", label: "Overdue", rank: 0 };
  const d = dayDiff(now, s);
  if (d <= 0) return { key: "today", label: "Today", rank: 1 };
  if (d === 1) return { key: "tomorrow", label: "Tomorrow", rank: 2 };
  if (d < 7) return { key: "list_week", label: "Next 7 Days", rank: 3 };
  return { key: "Later", label: "Later", rank: 4 };
}

function createdBucket(t: Task, now: number): { key: string; label: string; rank: number } {
  const c = parseDate(t.createdTime);
  const d = Number.isNaN(c) ? 9999 : dayDiff(c, now);
  if (d <= 0) return { key: "created_today", label: "Today", rank: 0 };
  if (d === 1) return { key: "created_yesterday", label: "Yesterday", rank: 1 };
  if (d <= 7) return { key: "created_previous_7", label: "Previous 7 Days", rank: 2 };
  if (d <= 30) return { key: "created_previous_30", label: "Previous 30 Days", rank: 3 };
  return { key: "created_earlier", label: "Earlier", rank: 4 };
}

/**
 * Group and sort. Pinned tasks always lead in their own group. Group by Custom (sortOrder) and None give
 * one unlabeled group. Date grouping follows the Overdue position setting.
 */
export function groupTasks(tasks: Task[], opt: SortOption, ctx: ViewCtx): TaskGroup[] {
  const groupBy = opt.groupBy ?? "sortOrder";
  const orderBy = opt.orderBy ?? "sortOrder";
  const order = (opt.order as "asc" | "desc" | null) ?? defaultDirection(orderBy);
  const cmp = compareTasks(orderBy, order, ctx);
  const pinned = tasks.filter((t) => t.pinnedTime);
  const rest = tasks.filter((t) => !t.pinnedTime);
  const out: TaskGroup[] = [];
  if (pinned.length) out.push({ key: "pinned", label: "Pinned", tasks: [...pinned].sort((a, b) => (b.pinnedTime ?? "").localeCompare(a.pinnedTime ?? "")) });

  const buckets = new Map<string, { label: string; rank: number; tasks: Task[]; action?: "postpone" }>();
  const put = (key: string, label: string, rank: number, t: Task, action?: "postpone"): void => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { label, rank, tasks: [], action }));
    b.tasks.push(t);
  };
  const tagOrder = new Map((ctx.tags ?? []).map((t) => [t.name, t.sortOrder ?? 0]));
  const tagLabel = new Map((ctx.tags ?? []).map((t) => [t.name, t.label ?? t.name]));
  const projIndex = new Map(ctx.projects.map((p, i) => [p.id, { p, i }]));

  for (const t of rest) {
    switch (groupBy) {
      case "dueDate": {
        const b = dateBucket(t, ctx.now);
        const rank = b.key === "overdue" && ctx.posOfOverdue === 1 ? 5 : b.rank;
        put(b.key, b.label, rank, t, b.key === "overdue" ? "postpone" : undefined);
        break;
      }
      case "createdTime": {
        const b = createdBucket(t, ctx.now);
        put(b.key, b.label, b.rank, t);
        break;
      }
      case "priority": {
        const p = t.priority ?? 0;
        put(`priority_${p}`, PRIORITY_LABEL[p] ?? "None", 5 - p, t);
        break;
      }
      case "tag": {
        const ft = firstTag(t, tagOrder);
        if (!ft) put("no-tag", "No Tags", 1e18, t);
        else put(`tag_${ft}`, tagLabel.get(ft) ?? ft, tagOrder.get(ft) ?? 0, t);
        break;
      }
      case "project": {
        if (t.projectId === ctx.inboxId) put(`p_${t.projectId}`, "Inbox", -1e18, t);
        else {
          const pi = projIndex.get(t.projectId);
          put(`p_${t.projectId}`, pi?.p.name ?? "List", pi?.p.sortOrder ?? 0, t);
        }
        break;
      }
      default:
        put("all", "", 0, t);
    }
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[1].rank - b[1].rank);
  for (const [key, b] of sorted) out.push({ key, label: b.label, tasks: b.tasks.sort(cmp), action: b.action });
  return out;
}

/** Nest children under parents that are present in the same list; the rest stay top level. */
export interface TreeNode {
  task: Task;
  children: TreeNode[];
  depth: number;
}
export function nest(tasks: Task[], cmp?: (a: Task, b: Task) => number): TreeNode[] {
  const ids = new Set(tasks.map((t) => t.id));
  const byParent = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of tasks) {
    if (t.parentId && ids.has(t.parentId)) {
      const l = byParent.get(t.parentId) ?? [];
      l.push(t);
      byParent.set(t.parentId, l);
    } else roots.push(t);
  }
  const build = (t: Task, depth: number): TreeNode => ({
    task: t,
    depth,
    children: (byParent.get(t.id) ?? []).sort(cmp ?? ((a, b) => a.sortOrder - b.sortOrder)).map((c) => build(c, depth + 1)),
  });
  return roots.map((t) => build(t, 0));
}

export function flattenTree(nodes: TreeNode[], collapsed: Set<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode): void => {
    out.push(n);
    if (!collapsed.has(n.task.id)) n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

/** Completed screen grouping: by completion day, newest first, heading "Sunday, Today" / "Friday, Nov 13". */
export function groupByCompletionDay(tasks: Task[], now: number): TaskGroup[] {
  const sorted = [...tasks].sort((a, b) => (parseDate(b.completedTime) || 0) - (parseDate(a.completedTime) || 0));
  const groups = new Map<string, TaskGroup>();
  for (const t of sorted) {
    const c = parseDate(t.completedTime);
    const day = Number.isNaN(c) ? 0 : startOfDay(c);
    const key = String(day);
    if (!groups.has(key)) {
      const d = new Date(day);
      const diff = dayDiff(day, now);
      const rel = diff === 0 ? "Today" : diff === 1 ? "Yesterday" : `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date(now).getFullYear() ? `, ${d.getFullYear()}` : ""}`;
      groups.set(key, { key, label: day ? `${WEEKDAYS_LONG[d.getDay()]}, ${rel}` : "Unknown", tasks: [] });
    }
    groups.get(key)!.tasks.push(t);
  }
  return [...groups.values()];
}

export type CompletedRange = "all" | "thisWeek" | "lastWeek" | "thisMonth" | "custom";
export function completedRange(range: CompletedRange, now: number, weekStart: number, custom?: { from: number; to: number }): { from: number; to: number } | null {
  const today = startOfDay(now);
  const dow = new Date(today).getDay();
  const ws = addDays(today, -((dow - weekStart + 7) % 7));
  switch (range) {
    case "thisWeek":
      return { from: ws, to: addDays(ws, 7) - 1 };
    case "lastWeek":
      return { from: addDays(ws, -7), to: ws - 1 };
    case "thisMonth": {
      const d = new Date(today);
      const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const to = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
      return { from, to };
    }
    case "custom":
      return custom ? { from: startOfDay(custom.from), to: startOfDay(custom.to) + DAY - 1 } : null;
    default:
      return null;
  }
}

/** Sidebar counts per view (open tasks; notes excluded when the count style hides notes). */
export function countFor(view: ViewRef, tasks: Task[], ctx: ViewCtx, hideNotes = false): number {
  return tasksInView(view, tasks, ctx).filter((t) => !hideNotes || t.kind !== "NOTE").length;
}

/** Client-side search over title, content, checklist items and tags (SRCH-006). */
export function searchTasks(tasks: Task[], q: string): Task[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return tasks.filter((t) => {
    if (t.deleted) return false;
    if (t.title.toLowerCase().includes(needle)) return true;
    if ((t.content ?? "").toLowerCase().includes(needle) || (t.desc ?? "").toLowerCase().includes(needle)) return true;
    if ((t.items ?? []).some((i) => i.title.toLowerCase().includes(needle))) return true;
    return (t.tags ?? []).some((x) => x.toLowerCase().includes(needle));
  });
}
