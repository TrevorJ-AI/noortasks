import type { SmartName, ViewRef } from "./views";

/**
 * Hash routes without a slash after the hash (createHashHistory noslash grammar):
 * q/{all|today|tomorrow|week}/tasks[/taskId], q/all/{assignedme|summary|completed|abandoned|trash}[/taskId],
 * p/{listId}/{tasks|kanban|timeline}[/taskId], g/..., t/{base64 tag}/..., s/[taskId], d/{YYYY-MM-DD}/tasks[/taskId],
 * c/all/calendar/{m|w|d|y|a}[/taskId], m/all/matrix[/{profile}[/taskId]],
 * plus an optional query ?modalType=settings&tabs=<key>.
 */
export type ViewMode = "tasks" | "kanban" | "timeline";
export type CalType = "m" | "w" | "d" | "y" | "a";

export interface Route {
  view: ViewRef;
  taskId?: string;
  query: URLSearchParams;
  path: string;
  /** list layout from the URL suffix (tasks = list view) */
  mode: ViewMode;
  /** full-screen modules outside the task lists */
  screen?: "calendar" | "matrix" | "habit" | "focus" | "countdown" | "statistics" | "notify";
  calType?: CalType;
  matrixId?: string;
  /** selected habit, timer or countdown id; statistics tab (overview | task | pomo) */
  itemId?: string;
  /** q/{sourceId}/subscribe-calendar | subscribe-account-calendar | subscribe-cal-dav: one subscribed calendar as a list (CAL-078) */
  subcal?: string;
}

const MODES = new Set(["tasks", "kanban", "timeline"]);
const CAL_TYPES = new Set(["m", "w", "d", "y", "a"]);

/** The saved view mode of a container (list viewMode, tag viewMode, smart-list option); set by the app. */
let modeResolver: (v: ViewRef) => ViewMode = () => "tasks";
export function setModeResolver(fn: (v: ViewRef) => ViewMode): void {
  modeResolver = fn;
}
export const modeOf = (v: ViewRef): ViewMode => modeResolver(v);
/** Timeline is not offered on Today, Tomorrow and Next 7 Days (VIEW-022, TIME-003); search and day lists are list only. */
export function allowedModes(v: ViewRef): ViewMode[] {
  if (v.type === "search" || v.type === "day") return ["tasks"];
  if (v.type === "smart") {
    if (v.name === "today" || v.name === "tomorrow" || v.name === "week") return ["tasks", "kanban"];
    if (v.name === "all") return ["tasks", "kanban", "timeline"];
    return ["tasks"];
  }
  return ["tasks", "kanban", "timeline"];
}

const SUBCAL_TYPES = new Set(["subscribe-calendar", "subscribe-account-calendar", "subscribe-cal-dav"]);
const SCREEN_TYPES = new Set(["assignedme", "summary", "completed", "abandoned", "trash"]);

export const b64tag = (name: string): string => btoa(unescape(encodeURIComponent(name)));
export const unb64tag = (s: string): string => {
  try {
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return decodeURIComponent(s);
  }
};

export const DEFAULT_PATH = "q/all/tasks";

export function parseHash(hash: string): Route | null {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const query = new URLSearchParams(queryPart ?? "");
  const seg = (pathPart ?? "").split("/").filter((s, i) => s !== "" || i === 1);
  const id = (s: string | undefined): string | undefined => (s ? s.slice(0, 24) : undefined);
  const path = pathPart ?? "";
  const mode = (t: string | undefined): ViewMode => (t && MODES.has(t) ? (t as ViewMode) : "tasks");
  const okType = (t: string | undefined): boolean => !t || MODES.has(t);
  const all = { type: "smart", name: "all" } as const;
  switch (seg[0]) {
    // M4 modules (HAB-002, FOC-002, CNT-002, STAT-001); bare hashes kept as aliases
    case "habit":
      return { view: all, query, path: `q/all/habit${seg[1] ? `/${id(seg[1])}` : ""}`, mode: "tasks", screen: "habit", itemId: id(seg[1]) };
    case "focus":
    case "pomodoro":
      return { view: all, query, path: `focus${seg[1] ? `/${id(seg[1])}` : ""}`, mode: "tasks", screen: "focus", itemId: id(seg[1]) };
    case "countdown":
      return { view: all, query, path: `countdown${seg[1] ? `/${id(seg[1])}` : ""}`, mode: "tasks", screen: "countdown", itemId: id(seg[1]) };
    case "statistics": {
      const t = seg[1] === "task" || seg[1] === "pomo" ? seg[1] : "overview";
      return { view: all, query, path: seg[1] ? `statistics/${t}` : "statistics", mode: "tasks", screen: "statistics", itemId: t };
    }
    case "c": {
      // c/all/calendar/{m|w|d|y|a}[/taskId]
      const type = (seg[3] && CAL_TYPES.has(seg[3]) ? seg[3] : "m") as CalType;
      return { view: { type: "smart", name: "all" }, taskId: id(seg[4]), query, path: `c/all/calendar/${type}${seg[4] ? `/${id(seg[4])}` : ""}`, mode: "tasks", screen: "calendar", calType: type };
    }
    case "m": {
      // m/all/matrix[/{profile}[/taskId]]
      const prof = seg[3] || undefined;
      return { view: { type: "smart", name: "all" }, taskId: id(seg[4]), query, path, mode: "tasks", screen: "matrix", matrixId: prof };
    }
    case "d":
      return seg[1] && /^\d{4}-\d{2}-\d{2}$/.test(seg[1]) ? { view: { type: "day", date: seg[1] }, taskId: id(seg[3]), query, path, mode: "tasks" } : null;
    case "q": {
      const name = seg[1];
      const type = seg[2];
      // q/all/today, q/all/tomorrow, q/all/week are aliases of the date smart lists
      if (name === "all" && type === "habit") return { view: all, query, path: `q/all/habit${seg[3] ? `/${id(seg[3])}` : ""}`, mode: "tasks", screen: "habit", itemId: id(seg[3]) };
      if (name === "all" && (type === "today" || type === "tomorrow" || type === "week")) return { view: { type: "smart", name: type }, taskId: id(seg[3]), query, path: `q/${type}/tasks`, mode: "tasks" };
      if (name && type && SUBCAL_TYPES.has(type)) return { view: all, query, path: `q/${name}/${type}`, mode: "tasks", subcal: name };
      if (type && SCREEN_TYPES.has(type)) return { view: { type: "smart", name: type as SmartName }, taskId: id(seg[3]), query, path, mode: "tasks" };
      if ((name === "all" || name === "today" || name === "tomorrow" || name === "week") && okType(type)) return { view: { type: "smart", name }, taskId: id(seg[3]), query, path, mode: mode(type) };
      return null;
    }
    case "p":
      return seg[1] && okType(seg[2]) ? { view: { type: "project", id: seg[1] }, taskId: id(seg[3]), query, path, mode: mode(seg[2]) } : null;
    case "g":
      return seg[1] && okType(seg[2]) ? { view: { type: "group", id: seg[1] }, taskId: id(seg[3]), query, path, mode: mode(seg[2]) } : null;
    case "f":
      // f/{filterId}/{tasks|kanban|timeline}[/taskId] (FILT-013)
      return seg[1] && okType(seg[2]) ? { view: { type: "filter", id: seg[1] }, taskId: id(seg[3]), query, path, mode: mode(seg[2]) } : null;
    case "n": {
      // n/{name}/{type}: opens the notification centre, then falls back to the default path (NTF-009)
      return { view: all, query, path: `n/${seg[1] ?? "notification"}/${seg[2] ?? "all"}`, mode: "tasks", screen: "notify", itemId: seg[1] ?? "notification" };
    }
    case "t":
      return seg[1] && okType(seg[2]) ? { view: { type: "tag", name: unb64tag(seg[1]).toLowerCase() }, taskId: id(seg[3]), query, path, mode: mode(seg[2]) } : null;
    case "s":
      return { view: { type: "search" }, taskId: id(seg[1]), query, path, mode: "tasks" };
    default:
      return null;
  }
}

export function viewPath(v: ViewRef, m?: ViewMode): string {
  const want = m ?? modeResolver(v);
  const suffix = allowedModes(v).includes(want) ? want : "tasks";
  switch (v.type) {
    case "smart":
      return SCREEN_TYPES.has(v.name) ? `q/all/${v.name}` : `q/${v.name}/${suffix}`;
    case "project":
      return `p/${v.id}/${suffix}`;
    case "group":
      return `g/${v.id}/${suffix}`;
    case "tag":
      return `t/${b64tag(v.name)}/${suffix}`;
    case "filter":
      return `f/${v.id}/${suffix}`;
    case "day":
      return `d/${v.date}/tasks`;
    case "search":
      return "s/";
  }
}

export const habitPath = (id?: string): string => `q/all/habit${id ? `/${id}` : ""}`;
export const focusPath = (id?: string): string => `focus${id ? `/${id}` : ""}`;
export const countdownPath = (id?: string): string => `countdown${id ? `/${id}` : ""}`;
export const statisticsPath = (type?: "overview" | "task" | "pomo"): string => `statistics${type ? `/${type}` : ""}`;
export const calendarPath = (type: CalType, taskId?: string): string => `c/all/calendar/${type}${taskId ? `/${taskId}` : ""}`;
export const matrixPath = (profileId?: string, taskId?: string): string => `m/all/matrix${profileId || taskId ? `/${profileId || "default"}` : ""}${taskId ? `/${taskId}` : ""}`;

/** Path of the current screen with (or without) an open task: lists keep their mode, calendar and matrix keep their screen. */
export function routeTaskPath(r: Route, taskId?: string): string {
  if (r.screen === "calendar") return calendarPath(r.calType ?? "m", taskId);
  if (r.screen === "matrix") return matrixPath(r.matrixId, taskId);
  if (r.screen) return r.path;
  return taskPath(r.view, taskId, r.mode);
}

export function taskPath(v: ViewRef, taskId?: string, m?: ViewMode): string {
  const base = viewPath(v, m);
  if (!taskId) return base;
  return v.type === "search" ? `s/${taskId}` : `${base}/${taskId}`;
}

export function go(path: string, query?: Record<string, string> | null): void {
  const q = query ? `?${new URLSearchParams(query).toString()}` : "";
  const next = `#${path}${q}`;
  if (location.hash !== next) location.hash = next;
}

export function setQuery(route: Route, query: Record<string, string> | null): void {
  go(route.path, query);
}

export const sameView = (a: ViewRef, b: ViewRef): boolean => JSON.stringify(a) === JSON.stringify(b);
