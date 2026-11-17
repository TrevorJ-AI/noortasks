import { ORDER_STEP, orderBetween, type Column, type Task } from "../lib/core";

/** Pseudo column for tasks without a (known) column ("Not Sectioned"). */
export const UNSECTIONED = "__none__";

export interface Lane {
  /** column id, UNSECTIONED, or a group key for attribute lanes (priority_5, today, p_<id>, tag_x) */
  key: string;
  name: string;
  column?: Column;
  tasks: Task[];
}

/** Columns in board order: sortOrder, then creation time, then id (stable across clients). */
export function sortColumns(cols: readonly Column[]): Column[] {
  return [...cols].sort((a, b) => a.sortOrder - b.sortOrder || (a.createdTime ?? "").localeCompare(b.createdTime ?? "") || a.id.localeCompare(b.id));
}

/**
 * Lanes of a list board. Root tasks only (subtasks ride on their parent card). Tasks whose columnId is absent
 * or points at a deleted column go to "Not Sectioned", which shows when it has tasks or the list has no columns.
 */
export function listLanes(projectId: string, columns: readonly Column[], tasks: readonly Task[]): Lane[] {
  const cols = sortColumns(columns.filter((c) => c.projectId === projectId));
  const ids = new Set(cols.map((c) => c.id));
  const inList = tasks.filter((t) => t.projectId === projectId);
  const present = new Set(inList.map((t) => t.id));
  const roots = inList.filter((t) => !t.parentId || !present.has(t.parentId));
  const by = new Map<string, Task[]>();
  for (const t of roots) {
    const k = t.columnId && ids.has(t.columnId) ? t.columnId : UNSECTIONED;
    (by.get(k) ?? by.set(k, []).get(k)!).push(t);
  }
  const sortTasks = (l: Task[]): Task[] => l.sort((a, b) => a.sortOrder - b.sortOrder || (a.createdTime ?? "").localeCompare(b.createdTime ?? ""));
  const lanes: Lane[] = [];
  const none = by.get(UNSECTIONED) ?? [];
  if (none.length || cols.length === 0) lanes.push({ key: UNSECTIONED, name: "Not Sectioned", tasks: sortTasks(none) });
  for (const c of cols) lanes.push({ key: c.id, name: c.name, column: c, tasks: sortTasks(by.get(c.id) ?? []) });
  return lanes;
}

/** sortOrder for a card dropped at `index` in a lane (other cards in their current order); null = renumber needed. */
export function orderAt(laneOrders: readonly number[], index: number): number | null {
  const before = index > 0 ? laneOrders[index - 1] : undefined;
  const after = index < laneOrders.length ? laneOrders[index] : undefined;
  const r = orderBetween(before, after);
  return r.needsRebalance ? null : r.order;
}

/** Renumbered orders for a lane, keeping its sequence. */
export function renumbered(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i * ORDER_STEP);
}

/** What dropping a card on an attribute lane changes (KANB-010). Date keys are day offsets from today. */
export type LanePatch = { priority: number } | { dayOffset: number | null } | { projectId: string } | { tag: string | null } | null;

export function lanePatch(laneKey: string): LanePatch {
  let m = /^priority_(\d)$/.exec(laneKey);
  if (m) return { priority: Number(m[1]) };
  if (laneKey === "today" || laneKey === "overdue") return { dayOffset: 0 };
  if (laneKey === "tomorrow") return { dayOffset: 1 };
  if (laneKey === "list_week") return { dayOffset: 2 };
  if (laneKey === "Later") return { dayOffset: 7 };
  if (laneKey === "nodate") return { dayOffset: null };
  m = /^p_(.+)$/.exec(laneKey);
  if (m) return { projectId: m[1]! };
  m = /^tag_(.+)$/.exec(laneKey);
  if (m) return { tag: m[1]! };
  if (laneKey === "no-tag") return { tag: null };
  return null;
}

/** Tags after moving a card to a tag lane: the card's lane tag (its first tag) is replaced. */
export function swapFirstTag(tags: readonly string[], firstTag: string | undefined, to: string | null): string[] {
  const rest = tags.filter((t) => t.toLowerCase() !== (firstTag ?? "").toLowerCase());
  return to === null ? [] : [to, ...rest.filter((t) => t.toLowerCase() !== to.toLowerCase())];
}
