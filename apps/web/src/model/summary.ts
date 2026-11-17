import type { Task } from "../lib/core";
import { addDays, addMonths, dayKey, parseDate, startOfDay, startOfWeek } from "../lib/dates";

/**
 * Summary report (NOTE-019..027, NOTE-801, NOTE-802): period presets, filters, grouping, sorting and the text
 * renderings used by the export menu. Pure; the screen feeds it tasks (server completed rows plus local open ones).
 */
export type RangePreset = "today" | "thisWeek" | "lastWeek" | "thisMonth" | "lastMonth" | "next7" | "custom";
export const RANGE_LABEL: Record<RangePreset, string> = { today: "Today", thisWeek: "This Week", lastWeek: "Last Week", thisMonth: "This Month", lastMonth: "Last Month", next7: "Next 7 Days", custom: "Custom" };

export type StatusFilter = "completed" | "uncompleted" | "all";
export interface SummaryFilter {
  range: RangePreset;
  /** yyyy-mm-dd, custom range only */
  from?: string;
  to?: string;
  /** project ids; empty = every list */
  lists: string[];
  status: StatusFilter;
  /** priorities to keep (0, 1, 3, 5); empty = all */
  priorities: number[];
}
export type GroupBy = "status" | "list" | "none";
export type SortBy = "completedTime" | "taskDate" | "status";
export interface SummaryFields {
  status: boolean;
  date: boolean;
  list: boolean;
  tags: boolean;
  parent: boolean;
  progress: boolean;
  focus: boolean;
}
export interface SummaryDisplay {
  groupBy: GroupBy;
  fields: SummaryFields;
}

export const DEFAULT_FILTER: SummaryFilter = { range: "next7", lists: [], status: "completed", priorities: [] };
export const DEFAULT_DISPLAY: SummaryDisplay = { groupBy: "status", fields: { status: true, date: true, list: true, tags: true, parent: true, progress: true, focus: true } };

const ymd = (s: string | undefined): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
};

/** [first day 00:00:00, last day 23:59:59] in device time. The default period is today plus six days (SMART-046). */
export function rangeOf(f: Pick<SummaryFilter, "range" | "from" | "to">, now: number, weekStart: number): { from: number; to: number } {
  const today = startOfDay(now);
  let a = today;
  let b = today;
  switch (f.range) {
    case "today":
      break;
    case "thisWeek":
      a = startOfWeek(today, weekStart);
      b = addDays(a, 6);
      break;
    case "lastWeek":
      a = addDays(startOfWeek(today, weekStart), -7);
      b = addDays(a, 6);
      break;
    case "thisMonth": {
      const d = new Date(today);
      a = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      b = addDays(addMonths(a, 1), -1);
      break;
    }
    case "lastMonth": {
      const d = new Date(today);
      a = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
      b = addDays(addMonths(a, 1), -1);
      break;
    }
    case "next7":
      b = addDays(today, 6);
      break;
    case "custom": {
      a = ymd(f.from) ?? today;
      b = ymd(f.to) ?? a;
      if (b < a) [a, b] = [b, a];
      break;
    }
  }
  return { from: a, to: addDays(b, 1) - 1000 };
}

export const taskDate = (t: Task): number => {
  const v = parseDate(t.dueDate ?? t.startDate ?? null);
  return Number.isNaN(v) ? NaN : v;
};
export const completedAt = (t: Task): number => parseDate(t.completedTime ?? null);

/**
 * NOTE-021: completed tasks finished inside the period, uncompleted (open) tasks dated inside it, or both.
 * Notes, won't do and trashed rows never count; lists and priorities narrow further.
 */
export function filterTasks(tasks: readonly Task[], f: SummaryFilter, r: { from: number; to: number }): Task[] {
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const t of tasks) {
    if (seen.has(t.id) || t.deleted || t.kind === "NOTE") continue;
    if (f.lists.length && !f.lists.includes(t.projectId)) continue;
    if (f.priorities.length && !f.priorities.includes(t.priority ?? 0)) continue;
    let ok = false;
    if (t.status === 2 && f.status !== "uncompleted") {
      const c = completedAt(t);
      ok = c >= r.from && c <= r.to;
    } else if (t.status === 0 && f.status !== "completed") {
      const d = taskDate(t);
      ok = d >= r.from && d <= r.to;
    }
    if (ok) {
      seen.add(t.id);
      out.push(t);
    }
  }
  return out;
}

/** NOTE-802: completion date (newest first), task date (earliest first, undated last), completion status (done first). */
export function sortTasks(tasks: readonly Task[], by: SortBy): Task[] {
  const key = (t: Task): number => (by === "completedTime" ? -(completedAt(t) || 0) : by === "taskDate" ? (Number.isNaN(taskDate(t)) ? Infinity : taskDate(t)) : t.status === 2 ? 0 : 1);
  return [...tasks].sort((a, b) => {
    const d = key(a) - key(b);
    if (d !== 0 && !Number.isNaN(d)) return d;
    if (by === "status") return (completedAt(b) || 0) - (completedAt(a) || 0) || a.title.localeCompare(b.title);
    return a.title.localeCompare(b.title);
  });
}

export interface Group {
  key: string;
  label: string;
  tasks: Task[];
}
/** NOTE-023: by completion status (Completed, Uncompleted), by list (list order by name), or one group. */
export function groupTasks(tasks: readonly Task[], by: GroupBy, listName: (id: string) => string): Group[] {
  if (by === "none") return tasks.length ? [{ key: "all", label: "", tasks: [...tasks] }] : [];
  const map = new Map<string, Group>();
  for (const t of tasks) {
    const key = by === "status" ? (t.status === 2 ? "done" : "open") : t.projectId;
    const label = by === "status" ? (t.status === 2 ? "Completed" : "Uncompleted") : listName(t.projectId) || "Unknown list";
    const g = map.get(key) ?? { key, label, tasks: [] };
    g.tasks.push(t);
    map.set(key, g);
  }
  const groups = [...map.values()];
  if (by === "status") groups.sort((a, b) => (a.key === "done" ? -1 : 1) - (b.key === "done" ? -1 : 1));
  else groups.sort((a, b) => a.label.localeCompare(b.label));
  return groups;
}

/** Parent before child when both are in the set (multilevel hierarchy, NOTE-023); depth 0 otherwise. */
export function withDepth(tasks: readonly Task[], hierarchy: boolean): Array<{ task: Task; depth: number }> {
  if (!hierarchy) return tasks.map((task) => ({ task, depth: 0 }));
  const ids = new Set(tasks.map((t) => t.id));
  const kids = new Map<string, Task[]>();
  const roots: Task[] = [];
  for (const t of tasks) {
    if (t.parentId && ids.has(t.parentId)) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
    else roots.push(t);
  }
  const out: Array<{ task: Task; depth: number }> = [];
  const walk = (t: Task, depth: number, guard: Set<string>): void => {
    if (guard.has(t.id)) return;
    guard.add(t.id);
    out.push({ task: t, depth });
    for (const k of kids.get(t.id) ?? []) walk(k, depth + 1, guard);
  };
  const guard = new Set<string>();
  for (const r of roots) walk(r, 0, guard);
  return out;
}

/** Checklist progress "done/total", or null for a plain task. */
export function progressOf(t: Task): { done: number; total: number } | null {
  const items = t.items ?? [];
  if (!items.length) return null;
  return { done: items.filter((i) => i.status !== 0).length, total: items.length };
}

/** Focus on a task from its focusSummaries: minutes (pomodoro plus stopwatch) and pomodoro count. */
export function focusOf(t: Task): { minutes: number; pomos: number } {
  let minutes = 0;
  let pomos = 0;
  for (const s of (t.focusSummaries ?? []) as Array<Record<string, unknown>>) {
    minutes += (Number(s.pomoDuration) || 0) + (Number(s.stopwatchDuration) || 0);
    pomos += Number(s.pomoCount) || 0;
  }
  return { minutes: Math.round(minutes), pomos };
}
export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export interface RenderCtx {
  listName: (id: string) => string;
  tagLabel?: (name: string) => string;
  meridiem?: boolean;
}

/** Detail line of one task (the fields switched on), used by the screen and the plain-text export. */
export function detailParts(t: Task, f: SummaryFields, ctx: RenderCtx): string[] {
  const out: string[] = [];
  if (f.date) {
    const c = completedAt(t);
    const d = taskDate(t);
    if (t.status === 2 && !Number.isNaN(c)) out.push(`Completed ${shortDate(c)}`);
    else if (!Number.isNaN(d)) out.push(`Due ${shortDate(d)}`);
  }
  if (f.list) out.push(ctx.listName(t.projectId) || "");
  if (f.tags && t.tags?.length) out.push(t.tags.map((n) => `#${ctx.tagLabel ? ctx.tagLabel(n) : n}`).join(" "));
  if (f.progress) {
    const p = progressOf(t);
    if (p) out.push(`${p.done}/${p.total}`);
  }
  if (f.focus) {
    const fo = focusOf(t);
    if (fo.minutes || fo.pomos) out.push(fo.pomos ? `${fo.pomos} pomo, ${formatMinutes(fo.minutes)}` : formatMinutes(fo.minutes));
  }
  return out.filter(Boolean);
}
const shortDate = (ms: number): string => {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

/** NOTE-801: Markdown is the plain list: a heading per group and a checkbox line per task, no detail style. */
export function toMarkdown(title: string, groups: Group[], display: SummaryDisplay): string {
  const lines = [`# ${title}`, ""];
  for (const g of groups) {
    if (g.label) lines.push(`## ${g.label}`, "");
    for (const { task, depth } of withDepth(g.tasks, display.fields.parent)) lines.push(`${"  ".repeat(depth)}- [${task.status === 2 ? "x" : " "}] ${task.title}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Plain text with the chosen detail fields. */
export function toPlainText(title: string, groups: Group[], display: SummaryDisplay, ctx: RenderCtx): string {
  const lines = [title, "=".repeat(Math.max(3, title.length)), ""];
  for (const g of groups) {
    if (g.label) lines.push(g.label, "-".repeat(g.label.length));
    for (const { task, depth } of withDepth(g.tasks, display.fields.parent)) {
      const mark = display.fields.status ? (task.status === 2 ? "[done] " : "[open] ") : "";
      const parts = detailParts(task, display.fields, ctx);
      lines.push(`${"  ".repeat(depth)}- ${mark}${task.title}${parts.length ? ` (${parts.join(", ")})` : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Rich text (HTML) for the clipboard. */
export function toHtml(title: string, groups: Group[], display: SummaryDisplay, ctx: RenderCtx): string {
  const parts = [`<h1>${esc(title)}</h1>`];
  for (const g of groups) {
    if (g.label) parts.push(`<h2>${esc(g.label)}</h2>`);
    parts.push("<ul>");
    for (const { task, depth } of withDepth(g.tasks, display.fields.parent)) {
      const d = detailParts(task, display.fields, ctx);
      parts.push(`<li style="margin-left:${depth * 18}px">${display.fields.status ? (task.status === 2 ? "&#9745; " : "&#9744; ") : ""}${esc(task.title)}${d.length ? ` <span style="color:#777">(${esc(d.join(", "))})</span>` : ""}</li>`);
    }
    parts.push("</ul>");
  }
  return parts.join("");
}

/** Default report title: "Summary, Nov 16 - Nov 22". */
export function defaultTitle(r: { from: number; to: number }): string {
  const a = new Date(r.from).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const b = new Date(r.to).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return dayKey(r.from) === dayKey(r.to) ? `Summary, ${a}` : `Summary, ${a} - ${b}`;
}

export interface SummaryTemplate {
  id: string;
  name: string;
  filter: SummaryFilter;
  display: SummaryDisplay;
  sort: SortBy;
}
