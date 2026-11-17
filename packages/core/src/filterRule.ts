/**
 * Filter rule engine (custom smart lists and Eisenhower matrix quadrants).
 *
 * Rule JSON: `{"and":[<cond>...],"type":0,"version":1}`; a condition is
 * `{"or":[values],"conditionName":"<name>","conditionType":1}`; nodes keyed `and`, `or` or `not` may nest.
 * The legacy text form `list:a,b AND tag:x` is parsed too. Pure functions; dates use the runtime time zone.
 */
import { parseWireDate } from "./constants.js";

export interface RuleTask {
  projectId: string;
  title?: string;
  content?: string;
  desc?: string;
  kind?: string;
  status?: number;
  priority?: number;
  tags?: string[];
  startDate?: string | null;
  dueDate?: string | null;
  isAllDay?: boolean | null;
  repeatFlag?: string | null;
  assignee?: number | string | null;
  completedTime?: string | null;
  createdTime?: string;
  teamId?: string | null;
  calendarId?: string | null;
  accountId?: string | null;
}

export interface RuleCtx {
  now: number;
  /** project id -> folder id, for `group` and `listOrGroup` */
  projectGroup?: Record<string, string | null | undefined>;
  /** project id -> team id, for `team` */
  projectTeam?: Record<string, string | null | undefined>;
  userId?: number | string;
  /** 0 = Sunday */
  weekStart?: number;
}

export interface RuleCond {
  conditionName: string;
  conditionType: 1;
  or: Array<string | number>;
}
export interface RuleNode {
  and?: Array<RuleNode | RuleCond>;
  or?: Array<RuleNode | RuleCond>;
  not?: Array<RuleNode | RuleCond>;
  type?: number;
  version?: number;
}

const DAY = 86_400_000;

// ------------------------------------------------------------------ local date helpers (runtime zone)

const sod = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const addDays = (ms: number, n: number): number => {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
};
const dayDiff = (a: number, b: number): number => Math.round((sod(b) - sod(a)) / DAY);
const parse = (s: string | null | undefined): number => {
  if (!s) return NaN;
  const w = parseWireDate(s);
  return Number.isNaN(w) ? Date.parse(s) : w;
};

/** First and last local calendar day a task covers (all-day end is exclusive), or null when undated. */
export function taskDaySpan(t: RuleTask): { first: number; last: number } | null {
  let s = parse(t.startDate);
  let e = parse(t.dueDate);
  if (Number.isNaN(s)) s = e;
  if (Number.isNaN(s)) return null;
  if (Number.isNaN(e) || e < s) e = s;
  const first = sod(s);
  let last = sod(e);
  if (t.isAllDay !== false && e > s && last === e) last = addDays(last, -1);
  if (last < first) last = first;
  return { first, last };
}

export function ruleTaskOverdue(t: RuleTask, now: number): boolean {
  if (t.status !== undefined && t.status !== 0) return false;
  const span = taskDaySpan(t);
  if (!span) return false;
  if (t.isAllDay === false) {
    const e = parse(t.dueDate);
    return (Number.isNaN(e) ? parse(t.startDate) : e) < now;
  }
  return span.last < sod(now);
}

// ------------------------------------------------------------------ parsing

export function parseRule(rule: string | RuleNode | null | undefined): RuleNode | null {
  if (!rule) return null;
  if (typeof rule !== "string") return rule;
  const s = rule.trim();
  if (!s) return null;
  if (s.startsWith("{")) {
    try {
      return JSON.parse(s) as RuleNode;
    } catch {
      return null;
    }
  }
  // legacy text: "list:a,b AND tag:x"
  const parts = s.split(/\s+AND\s+/i);
  const and: RuleCond[] = [];
  for (const p of parts) {
    const i = p.indexOf(":");
    if (i < 0) continue;
    and.push({ conditionName: p.slice(0, i).trim(), conditionType: 1, or: p.slice(i + 1).split(",").map((x) => x.trim()).filter(Boolean) });
  }
  return { and, type: 0, version: 1 };
}

export function stringifyRule(rule: RuleNode): string {
  return JSON.stringify(rule);
}

const isCond = (x: RuleNode | RuleCond): x is RuleCond => (x as RuleCond).conditionType === 1 || typeof (x as RuleCond).conditionName === "string";

// ------------------------------------------------------------------ date tokens

/** Does a date-ish field (task dates, or a single instant) match one token. */
export function matchDateToken(token: string, t: RuleTask, ctx: RuleCtx, field: "due" | "completed" | "created" = "due"): boolean {
  const now = ctx.now;
  const today = sod(now);
  let span: { first: number; last: number } | null;
  if (field === "due") span = taskDaySpan(t);
  else {
    const v = parse(field === "completed" ? t.completedTime : t.createdTime);
    span = Number.isNaN(v) ? null : { first: sod(v), last: sod(v) };
  }
  const tok = String(token).trim().toLowerCase();
  if (tok === "nodue" || tok === "nodate") return span === null;
  if (tok === "recurring") return !!t.repeatFlag;
  if (!span) return false;
  const covers = (from: number, to: number): boolean => span!.first <= to && span!.last >= from;
  const ws = ctx.weekStart ?? 0;
  const weekStartOf = (ms: number): number => addDays(sod(ms), -((new Date(sod(ms)).getDay() - ws + 7) % 7));
  switch (tok) {
    case "overdue":
      return field === "due" ? ruleTaskOverdue(t, now) : span.last < today;
    case "today":
      return covers(today, today);
    case "tomorrow":
      return covers(addDays(today, 1), addDays(today, 1));
    case "yesterday":
      return covers(addDays(today, -1), addDays(today, -1));
    case "thisweek": {
      const a = weekStartOf(now);
      return covers(a, addDays(a, 6));
    }
    case "nextweek": {
      const a = addDays(weekStartOf(now), 7);
      return covers(a, addDays(a, 6));
    }
    case "lastweek": {
      const a = addDays(weekStartOf(now), -7);
      return covers(a, addDays(a, 6));
    }
    case "thismonth": {
      const d = new Date(today);
      const a = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
      const b = addDays(new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime(), -1);
      return covers(a, b);
    }
    case "nextmonth": {
      const d = new Date(today);
      const a = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      const b = addDays(new Date(d.getFullYear(), d.getMonth() + 2, 1).getTime(), -1);
      return covers(a, b);
    }
    case "2dayslater":
      return span.first >= addDays(today, 2);
    case "futurefromtoday":
      return span.last >= today;
    case "pastfromtoday":
      return span.first <= today;
  }
  let m = /^(\d+)days$/.exec(tok); // within the next N days, today included
  if (m) return covers(today, addDays(today, Number(m[1]) - 1));
  m = /^(\d+)dayslater$/.exec(tok); // N days from today and beyond
  if (m) return span.first >= addDays(today, Number(m[1]));
  m = /^offset\((-?\d+)([dwm])\)$/.exec(tok);
  if (m) {
    const n = Number(m[1]);
    if (m[2] === "d") return covers(addDays(today, n), addDays(today, n));
    if (m[2] === "w") {
      const a = addDays(weekStartOf(now), 7 * n);
      return covers(a, addDays(a, 6));
    }
    const d = new Date(today);
    const a = new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
    const b = addDays(new Date(d.getFullYear(), d.getMonth() + n + 1, 1).getTime(), -1);
    return covers(a, b);
  }
  m = /^(?:span|custom)\((.*)~(.*)\)$/.exec(tok);
  if (m) {
    const end = (x: string, isEnd: boolean): number => {
      if (x === "") return isEnd ? Infinity : -Infinity;
      if (/^-?\d+$/.test(x)) return addDays(today, Number(x));
      const v = Date.parse(`${x}T00:00:00`);
      return Number.isNaN(v) ? (isEnd ? Infinity : -Infinity) : sod(v);
    };
    return covers(end(m[1]!, false), end(m[2]!, true));
  }
  return false;
}

// ------------------------------------------------------------------ evaluation

function matchCond(c: RuleCond, t: RuleTask, ctx: RuleCtx): boolean {
  const vals = (c.or ?? []).map((v) => String(v));
  if (!vals.length) return true;
  const name = c.conditionName;
  switch (name) {
    case "list":
      return vals.includes(t.projectId) || vals.includes("all");
    case "group":
      return vals.includes(String(ctx.projectGroup?.[t.projectId] ?? ""));
    case "team": {
      const tid = t.teamId ?? ctx.projectTeam?.[t.projectId] ?? null;
      return vals.some((v) => (v === "personal" ? !tid : tid === v));
    }
    case "calendar":
      return vals.includes("all") || (!!t.calendarId && vals.includes(t.calendarId));
    case "account":
      return vals.includes("all") || (!!t.accountId && vals.includes(t.accountId));
    case "listOrGroup":
      return vals.includes(t.projectId) || vals.includes(String(ctx.projectGroup?.[t.projectId] ?? "\0"));
    case "tag": {
      const tags = (t.tags ?? []).map((x) => x.toLowerCase());
      return vals.some((v) => (v === "!tag" || v === "notag" || v === "withoutTag" ? tags.length === 0 : v === "*withtags" ? tags.length > 0 : tags.includes(v.toLowerCase())));
    }
    case "priority":
      return vals.map(Number).includes(t.priority ?? 0);
    case "dueDate":
    case "date":
      return vals.some((v) => matchDateToken(v, t, ctx, "due"));
    case "completedTime":
      return vals.some((v) => matchDateToken(v, t, ctx, "completed"));
    case "createdTime":
      return vals.some((v) => matchDateToken(v, t, ctx, "created"));
    case "keywords":
    case "title": {
      const hay = name === "title" ? (t.title ?? "").toLowerCase() : `${t.title ?? ""}\n${t.content ?? ""}\n${t.desc ?? ""}`.toLowerCase();
      return vals.some((v) => hay.includes(v.toLowerCase()));
    }
    case "taskType":
      return vals.some((v) => (v === "note" ? t.kind === "NOTE" : v === "task" ? t.kind !== "NOTE" : v.toUpperCase() === (t.kind ?? "TEXT")));
    case "status":
      return vals.map(Number).includes(t.status ?? 0);
    case "assignee": {
      const a = t.assignee === undefined || t.assignee === null || Number(t.assignee) <= 0 ? null : String(t.assignee);
      return vals.some((v) => (v === "me" ? a !== null && a === String(ctx.userId ?? "") : v === "noassignee" ? a === null : v === "other" ? a !== null && a !== String(ctx.userId ?? "") : a === v));
    }
    default:
      return false;
  }
}

function evalNode(n: RuleNode | RuleCond, t: RuleTask, ctx: RuleCtx): boolean {
  if (isCond(n)) return matchCond(n, t, ctx);
  if (n.and) return n.and.every((c) => evalNode(c, t, ctx));
  if (n.or) return n.or.length === 0 || n.or.some((c) => evalNode(c, t, ctx));
  if (n.not) return !n.not.some((c) => evalNode(c, t, ctx));
  return true;
}

/** True when the task satisfies the rule. An empty or unparsable rule matches everything. */
export function evaluateRule(rule: string | RuleNode | null | undefined, t: RuleTask, ctx: RuleCtx): boolean {
  const r = parseRule(rule);
  if (!r) return true;
  return evalNode(r, t, ctx);
}

/** Top-level conditions of a rule (the editor works on `and` of simple conditions). */
export function ruleConditions(rule: string | RuleNode | null | undefined): RuleCond[] {
  const r = parseRule(rule);
  if (!r) return [];
  return (r.and ?? []).filter(isCond);
}
export function ruleFromConditions(conds: RuleCond[]): string {
  return stringifyRule({ and: conds.filter((c) => c.or.length > 0), type: 0, version: 1 });
}
const cond = (conditionName: string, or: Array<string | number>): RuleCond => ({ conditionName, conditionType: 1, or });

// ------------------------------------------------------------------ Eisenhower matrix

export const QUADRANT_IDS = ["quadrant1", "quadrant2", "quadrant3", "quadrant4"] as const;
export type QuadrantId = (typeof QUADRANT_IDS)[number];
export const QUADRANT_LABEL_KEYS = ["important_urgent", "important_not_urgent", "unimportant_urgent", "unimportant_not_urgent"] as const;
export const QUADRANT_LABELS = ["Urgent & Important", "Not Urgent & Important", "Urgent & Unimportant", "Not Urgent & Unimportant"] as const;

export interface Quadrant {
  id: string;
  rule: string;
  sortType: string;
  name?: string;
}
export interface MatrixPrefs {
  quadrants: Quadrant[];
  defaultViewId: string;
  version: number;
  show_completed: boolean;
  mtime: number;
}

/** Preset Matrix -> Priority: Q1 high, Q2 medium, Q3 low, Q4 none. */
export function simpleMatrixRules(): string[] {
  return [[5], [3], [1], [0]].map((p) => ruleFromConditions([cond("priority", p)]));
}
/** Preset Matrix -> Time + Priority (the default). `withOverdue` false omits overdue tasks. */
export function complexMatrixRules(withOverdue = true): string[] {
  const urgent = withOverdue ? ["overdue", "today", "tomorrow"] : ["today", "tomorrow"];
  const later = ["nodue", "2dayslater"];
  return [
    ruleFromConditions([cond("dueDate", urgent), cond("priority", [5, 3])]),
    ruleFromConditions([cond("dueDate", later), cond("priority", [5, 3])]),
    ruleFromConditions([cond("dueDate", urgent), cond("priority", [1, 0])]),
    ruleFromConditions([cond("dueDate", later), cond("priority", [1, 0])]),
  ];
}
export function defaultMatrixPrefs(): MatrixPrefs {
  return { quadrants: complexMatrixRules().map((rule, i) => ({ id: QUADRANT_IDS[i]!, rule, sortType: "dueDate" })), defaultViewId: "", version: 1, show_completed: true, mtime: 0 };
}

/** Index (0..3) of the first quadrant whose rule matches, or -1. Each task shows in one quadrant only. */
export function quadrantIndexOf(t: RuleTask, rules: readonly string[], ctx: RuleCtx): number {
  for (let i = 0; i < rules.length; i++) if (evaluateRule(rules[i], t, ctx)) return i;
  return -1;
}

export interface QuadrantPatch {
  priority?: number;
  /** day offset from today to move the task to; null clears the date; absent keeps it */
  dayOffset?: number | null;
  projectId?: string;
  addTag?: string;
}

const TOKEN_OFFSET: Record<string, number> = { today: 0, tomorrow: 1, overdue: -1, yesterday: -1, "2dayslater": 2, thisweek: 0, futurefromtoday: 0, pastfromtoday: 0, thismonth: 0 };

/**
 * The smallest change that makes a task satisfy a quadrant rule (drag between quadrants, add inside a quadrant).
 * Priority: keep it when allowed, else the allowed value closest to the current one (ties go higher).
 * Date: keep it when allowed; an undated task stays undated when no-date is allowed; otherwise move to the
 * first allowed dated token (today before tomorrow; overdue maps to today, since an edit should not create overdue work).
 */
export function patchForRule(rule: string, t: RuleTask, ctx: RuleCtx): QuadrantPatch {
  const out: QuadrantPatch = {};
  for (const c of ruleConditions(rule)) {
    const vals = c.or.map(String);
    if (!vals.length) continue;
    if (c.conditionName === "priority") {
      const allowed = vals.map(Number);
      const cur = t.priority ?? 0;
      if (!allowed.includes(cur)) out.priority = [...allowed].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || b - a)[0]!;
    } else if (c.conditionName === "dueDate" || c.conditionName === "date") {
      if (vals.some((v) => matchDateToken(v, t, ctx))) continue;
      if (vals.includes("nodue") && !taskDaySpan(t)) continue;
      const dated = vals.filter((v) => v !== "nodue" && v !== "recurring");
      if (!dated.length) {
        out.dayOffset = null;
        continue;
      }
      const offs = dated.map((v) => {
        if (v in TOKEN_OFFSET) return v === "overdue" ? 0 : TOKEN_OFFSET[v]!;
        const m = /^(\d+)dayslater$/.exec(v) ?? /^offset\((-?\d+)d\)$/.exec(v);
        if (m) return Number(m[1]);
        if (/^\d+days$/.test(v) || v === "nextweek") return v === "nextweek" ? 7 : 0;
        return 0;
      });
      // prefer the soonest non-negative offset
      out.dayOffset = offs.filter((o) => o >= 0).sort((a, b) => a - b)[0] ?? 0;
      if (vals.includes("nextweek") && out.dayOffset === 7) {
        // land on the first day of next week
        const ws = ctx.weekStart ?? 0;
        const today = sod(ctx.now);
        const dow = new Date(today).getDay();
        out.dayOffset = 7 - ((dow - ws + 7) % 7);
      }
    } else if (c.conditionName === "list") {
      if (!vals.includes(t.projectId) && !vals.includes("all")) out.projectId = vals[0]!;
    } else if (c.conditionName === "tag") {
      const tags = (t.tags ?? []).map((x) => x.toLowerCase());
      const real = vals.filter((v) => !v.startsWith("!") && v !== "notag" && v !== "withoutTag");
      if (real.length && !real.some((v) => tags.includes(v.toLowerCase()))) out.addTag = real[0]!;
    }
  }
  return out;
}

/** Days between two instants in local calendar days (exported for callers that turn dayOffset into dates). */
export const localDayDiff = dayDiff;
