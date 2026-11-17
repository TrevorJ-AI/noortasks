import { evaluateRule, parseRule, type Filter, type RuleCond, type RuleCtx, type RuleNode, type Task } from "../lib/core";

/**
 * Custom filter rule builder (FILT-003, FILT-006, FILT-009, FILT-011, FILT-012).
 *
 * The editor works on a tree of groups. A group joins its children with AND or OR and can be negated
 * (NOT). A leaf is one condition: a condition name plus the values it accepts (values are OR-ed, as on
 * the wire). The wire form is the filter rule JSON: `{"and":[...],"type":0,"version":1}`, where a
 * condition is `{"conditionName":"priority","conditionType":1,"or":[5]}` and `not` holds a list whose
 * members must all be false. Normal mode is a flat AND of conditions (type 0); anything else is
 * Advanced (type 1; custom multi-group filter rule).
 */

export type CondName = "listOrGroup" | "list" | "group" | "tag" | "dueDate" | "priority" | "assignee" | "keywords" | "taskType" | "createdTime" | "completedTime" | "status" | "title";

export interface BCond {
  kind: "cond";
  name: string;
  values: Array<string | number>;
}
export interface BGroup {
  kind: "group";
  op: "and" | "or";
  not?: boolean;
  items: Array<BCond | BGroup>;
}

export const COND_LABEL: Record<string, string> = {
  listOrGroup: "List or Folder",
  list: "List only",
  group: "Folder",
  tag: "Tag",
  dueDate: "Date",
  priority: "Priority",
  assignee: "Assignee",
  keywords: "Keywords",
  title: "Title",
  taskType: "Type",
  createdTime: "Created",
  completedTime: "Completed",
  status: "Status",
};

/** Conditions offered in the Normal tab, in order (FILT-009); Advanced adds the rest. */
export const NORMAL_CONDS: CondName[] = ["listOrGroup", "tag", "dueDate", "priority", "assignee", "keywords", "taskType"];
export const ADVANCED_CONDS: CondName[] = [...NORMAL_CONDS, "list", "group", "title", "createdTime"];

export const DATE_TOKENS: Array<{ value: string; label: string }> = [
  { value: "nodue", label: "No Date" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Today" },
  { value: "tomorrow", label: "Tomorrow" },
  { value: "thisweek", label: "This Week" },
  { value: "nextweek", label: "Next Week" },
  { value: "thismonth", label: "This Month" },
  { value: "nextmonth", label: "Next Month" },
  { value: "7days", label: "Next 7 Days" },
  { value: "recurring", label: "Repeating" },
];
export const PAST_TOKENS: Array<{ value: string; label: string }> = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "thisweek", label: "This Week" },
  { value: "lastweek", label: "Last Week" },
  { value: "thismonth", label: "This Month" },
];
export const PRIORITY_VALUES: Array<{ value: number; label: string }> = [
  { value: 5, label: "High" },
  { value: 3, label: "Medium" },
  { value: 1, label: "Low" },
  { value: 0, label: "None" },
];
export const TYPE_VALUES = [
  { value: "task", label: "Tasks" },
  { value: "note", label: "Notes" },
];
export const ASSIGNEE_VALUES = [
  { value: "me", label: "Me" },
  { value: "noassignee", label: "Not assigned" },
  { value: "other", label: "Others" },
];
export const STATUS_VALUES = [
  { value: 0, label: "Open" },
  { value: 2, label: "Completed" },
  { value: -1, label: "Won't Do" },
];

const isCondNode = (n: RuleNode | RuleCond): n is RuleCond => typeof (n as RuleCond).conditionName === "string";

export const emptyGroup = (op: "and" | "or" = "and"): BGroup => ({ kind: "group", op, items: [] });
export const cond = (name: string, values: Array<string | number> = []): BCond => ({ kind: "cond", name, values });

function nodeToGroup(n: RuleNode): BGroup {
  const key = n.and ? "and" : n.or ? "or" : n.not ? "not" : "and";
  const list = (n.and ?? n.or ?? n.not ?? []) as Array<RuleNode | RuleCond>;
  const items = list.map((c) => (isCondNode(c) ? cond(c.conditionName, [...(c.or ?? [])]) : nodeToGroup(c)));
  if (key === "not") {
    // not:[{and:[a, b]}] is NOT (a AND b); not:[a, b] is true when every member is false: NOT (a OR b)
    const only = items.length === 1 ? items[0]! : null;
    if (only && only.kind === "group" && !only.not) return { ...only, not: true };
    return { kind: "group", op: "or", not: true, items };
  }
  return { kind: "group", op: key, items };
}

/** Rule string (JSON or legacy text) to the editor tree. An empty rule gives an empty AND group. */
export function ruleToBuilder(rule: string | null | undefined): BGroup {
  const r = parseRule(rule ?? "");
  if (!r) return emptyGroup();
  return nodeToGroup(r);
}

function groupToNode(g: BGroup): RuleNode {
  const items: Array<RuleNode | RuleCond> = [];
  for (const it of g.items) {
    if (it.kind === "cond") {
      if (it.values.length === 0) continue;
      items.push({ conditionName: it.name, conditionType: 1, or: [...it.values] });
    } else {
      const sub = groupToNode(it);
      const list = sub.and ?? sub.or ?? sub.not ?? [];
      if (list.length === 0) continue;
      items.push(sub);
    }
  }
  if (g.not) {
    // NOT (a AND b) = not:[ {and:[a,b]} ]; NOT (a OR b) = not:[a, b]
    if (g.op === "and" && items.length > 1) return { not: [{ and: items }] };
    if (g.op === "or" && items.length > 1 && items.every((i) => !isCondNode(i))) return { not: [{ or: items }] };
    return { not: items };
  }
  return g.op === "or" ? { or: items } : { and: items };
}

/** True when the tree is a flat AND of conditions, the shape the Normal tab edits. */
export function isNormal(g: BGroup): boolean {
  return !g.not && g.op === "and" && g.items.every((i) => i.kind === "cond");
}

/** Editor tree to the wire rule string. */
export function builderToRule(g: BGroup): string {
  const node = groupToNode(g);
  const top: RuleNode = node.not ? { and: [node] } : node;
  return JSON.stringify({ ...top, type: isNormal(g) ? 0 : 1, version: 1 });
}

/** Tasks a filter shows: open, not deleted, matching the rule (FILT-013). */
export function filterMatches(rule: string | null | undefined, tasks: readonly Task[], ctx: RuleCtx): Task[] {
  return tasks.filter((t) => !t.deleted && t.status === 0 && evaluateRule(rule, t as never, ctx));
}

/** Preview order (FILT-012): by list, then created time when only notes match. */
export function previewSort(tasks: Task[], projectOrder: (id: string) => number): Task[] {
  const onlyNotes = tasks.length > 0 && tasks.every((t) => t.kind === "NOTE");
  return [...tasks].sort((a, b) =>
    onlyNotes ? (b.createdTime ?? "").localeCompare(a.createdTime ?? "") : projectOrder(a.projectId) - projectOrder(b.projectId) || a.sortOrder - b.sortOrder,
  );
}

/** Defaults a new task in a filter view takes from the rule (FILT-015): one priority, tags and one list. */
export function filterDefaults(rule: string | null | undefined, listIds: Set<string>): { priority?: number; tags?: string[]; projectId?: string } {
  const g = ruleToBuilder(rule);
  // only conditions every match must meet: the top level of an AND root
  if (g.not || g.op !== "and") return {};
  const out: { priority?: number; tags?: string[]; projectId?: string } = {};
  for (const it of g.items.filter((i): i is BCond => i.kind === "cond")) {
    if (it.name === "priority" && it.values.length === 1) out.priority = Number(it.values[0]);
    if (it.name === "tag") {
      const tags = it.values.map(String).filter((v) => !["!tag", "notag", "withoutTag", "*withtags"].includes(v));
      if (tags.length) out.tags = tags;
    }
    if ((it.name === "listOrGroup" || it.name === "list") && it.values.length === 1 && listIds.has(String(it.values[0]))) out.projectId = String(it.values[0]);
  }
  return out;
}

/** A short text summary of a rule for menus and the editor title. */
export function describeRule(g: BGroup, label: (name: string, v: string | number) => string): string {
  const part = (it: BCond | BGroup): string => {
    if (it.kind === "cond") return it.values.length ? `${COND_LABEL[it.name] ?? it.name}: ${it.values.map((v) => label(it.name, v)).join(" or ")}` : "";
    const inner = it.items.map(part).filter(Boolean).join(it.op === "and" ? " AND " : " OR ");
    if (!inner) return "";
    return it.not ? `NOT (${inner})` : `(${inner})`;
  };
  const inner = g.items.map(part).filter(Boolean).join(g.op === "and" ? " AND " : " OR ");
  return g.not ? `NOT (${inner})` : inner;
}

export function newFilter(id: string, name: string, rule: string, sortOrder: number): Filter {
  return { id, name, rule, sortOrder, sortType: "project", viewMode: "list", sortOption: { groupBy: "project", orderBy: "dueDate", order: "asc" } };
}
