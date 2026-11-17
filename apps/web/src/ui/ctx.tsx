import { useLiveQuery } from "dexie-react-hooks";
import type { Me } from "../data/accounts";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Api, HttpError } from "../data/api";
import { DEFAULT_AI_STATUS, fetchAiStatus } from "../data/aiApi";
import { hasConfirmedServerUrl } from "../lib/capacitor";
import { peekLaunchPairingParams, scrubLaunchPairingParams } from "../lib/pairing";
import { NoorDb } from "../data/db";
import { Repo } from "../data/repo";
import { SyncEngine, type SyncStatus } from "../data/sync";
import { defaultPreferences, type AiStatusResponse, type Column, type Filter, type Preferences, type Project, type ProjectGroup, type Tag, type Task } from "../lib/core";
import type { ImportSourceId } from "../model/importers";
import { DEFAULT_PATH, parseHash, setModeResolver, type Route, type ViewMode } from "../model/router";
import type { ViewRef } from "../model/views";

// ------------------------------------------------------------------ local (device-only) preferences

export interface LocalPrefs {
  isLeftListHide: boolean;
  taskDetailLayout: "side" | "popup";
  dateFormat: "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY/MM/DD";
  sidebarCountStyle: "all" | "hideNote" | "hide";
  isRenderProjectColor: boolean;
  completedTaskStyle: "strike" | "plain";
  interfaceStyle: "flat" | "card" | "classic";
  fontSize: "normal" | "large" | "xlarge";
  zoom: number;
  customShortcuts: Record<string, string>;
  projectGroupOpenStatus: Record<string, boolean>;
  parentTagOpenStatus: Record<string, boolean>;
  sidebarCollapse: Record<string, boolean>;
  completedSectionStatus: Record<string, boolean>;
  collapsedGroups: Record<string, boolean>;
  collapsedTasks: Record<string, boolean>;
  smartSortOptions: Record<string, { groupBy?: string; orderBy?: string; order?: string | null }>;
  searchHistory: string[];
  quickAddStyle: 0 | 1;
  showDateBy: "taskTime" | "dueDate";
  viewModeSync: boolean;
  urlParseEnabled: boolean;
  syncIntervalMs: number;
  /** view modes kept on this device when Sync View Across Devices is off */
  localViewModes: Record<string, string>;
  // calendar and schedule (SET-274..278: compatibility localStorage key names, device only)
  selectedCalendarViewType: "day" | "multiDay" | "week" | "multiWeek" | "month" | "year" | "agenda";
  multiCalendarCount: number;
  multiWeekCount: number;
  calendarHideWeekend: boolean;
  showCalendarRepeat: boolean;
  timelineHourHeight: number;
  calScrollTop: number;
  allDayViewHeight: number;
  allDayCollapse: boolean;
  calHideRangeStatus: Record<string, boolean>;
  isTaskCalendarMode: boolean;
  calendarTaskListCurrentProjectId: string;
  showMiniCalendar: boolean;
  calendarStatus: boolean;
  // kanban (KANB-012)
  kanbanColumnSize: "small" | "medium" | "large";
  kanbanCollapsed: Record<string, boolean>;
  kanbanQuickAddDefaultVisible: boolean;
  kanbanSectionColor: boolean;
  // timeline (TIME-008, TIME-011, TIME-013)
  timelineViewRangeTypeKey: "day" | "week" | "month";
  timelineScheduleSectionCollapse: Record<string, boolean>;
  timelineSectionViewWidth: number;
  isReadTimelineGuide: boolean;
  // matrix (SET-290)
  matrixActiveViewId: string;
}

export const LOCAL_DEFAULTS: LocalPrefs = {
  isLeftListHide: false,
  taskDetailLayout: "side",
  dateFormat: "MM/DD/YYYY",
  sidebarCountStyle: "all",
  isRenderProjectColor: true,
  completedTaskStyle: "plain",
  interfaceStyle: "flat",
  fontSize: "normal",
  zoom: 1,
  customShortcuts: {},
  projectGroupOpenStatus: {},
  parentTagOpenStatus: {},
  sidebarCollapse: {},
  completedSectionStatus: {},
  collapsedGroups: {},
  collapsedTasks: {},
  smartSortOptions: {},
  searchHistory: [],
  quickAddStyle: 0,
  showDateBy: "taskTime",
  viewModeSync: true,
  urlParseEnabled: true,
  syncIntervalMs: 15000,
  localViewModes: {},
  selectedCalendarViewType: "month",
  multiCalendarCount: 3,
  multiWeekCount: 2,
  calendarHideWeekend: false,
  showCalendarRepeat: false,
  timelineHourHeight: 48,
  calScrollTop: -1,
  allDayViewHeight: 76,
  allDayCollapse: false,
  calHideRangeStatus: {},
  isTaskCalendarMode: false,
  calendarTaskListCurrentProjectId: "",
  showMiniCalendar: false,
  calendarStatus: false,
  kanbanColumnSize: "medium",
  kanbanCollapsed: {},
  kanbanQuickAddDefaultVisible: true,
  kanbanSectionColor: false,
  timelineViewRangeTypeKey: "week",
  timelineScheduleSectionCollapse: {},
  timelineSectionViewWidth: 220,
  isReadTimelineGuide: false,
  matrixActiveViewId: "",
};

function readLocal(): LocalPrefs {
  const out: Record<string, unknown> = { ...LOCAL_DEFAULTS };
  for (const k of Object.keys(LOCAL_DEFAULTS)) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = JSON.parse(v);
    } catch {
      /* keep default */
    }
  }
  return out as unknown as LocalPrefs;
}

// ------------------------------------------------------------------ toasts

export interface Toast {
  id: number;
  text: string;
  undo?: () => void;
  /** label of the action button (default Undo) */
  action?: string;
}

// ------------------------------------------------------------------ app context

export interface App {
  db: NoorDb;
  repo: Repo;
  engine: SyncEngine;
  tasks: Task[];
  projects: Project[];
  groups: ProjectGroup[];
  tags: Tag[];
  columns: Column[];
  /** custom filters (M5), sorted by sortOrder */
  filters: Filter[];
  /** extended preferences (user/preferences/ext): matrix, timeline, calendarConfig, smartProjectsOption... */
  ext: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  settings: Preferences;
  inboxId: string;
  ready: boolean;
  route: Route;
  local: LocalPrefs;
  setLocal: <K extends keyof LocalPrefs>(k: K, v: LocalPrefs[K]) => void;
  now: number;
  sync: SyncStatus;
  toast: (text: string, undo?: () => void, action?: string) => void;
  toasts: Toast[];
  dismissToast: (id: number) => void;
  /** focused task row in the list (keyboard shortcuts act on it) */
  focusedId: string | null;
  setFocusedId: (id: string | null) => void;
  selected: Set<string>;
  setSelected: (s: Set<string>) => void;
  modal: ModalState | null;
  setModal: (m: ModalState | null) => void;
  /** project id -> name, inbox included */
  projectName: (id: string) => string;
  /** persist a container's layout (list viewMode, tag/folder viewMode, smart-list option) */
  setViewMode: (v: ViewRef, mode: ViewMode) => Promise<void>;
  /** the signed-in account (null until known; `single` on servers without accounts) */
  me: Me | null;
  refreshMe: () => Promise<void>;
  /** server-side AI audio transcription and summarization status */
  ai: AiStatusResponse;
  /** collaboration features are available to this account (multi-user, switch on, not opted out) */
  collab: boolean;
  /** initial `#pair=<token>` captured from the launch URL before hash routing */
  initialPairToken: string | null;
  clearInitialPairToken: () => void;
  /** true when redirected back from first-run OIDC setup to show the pairing QR step */
  initialSetupPaired: boolean;
  clearInitialSetupPaired: () => void;
}

const toWire = (m: ViewMode): string => (m === "tasks" ? "list" : m);
const fromWire = (m: unknown): ViewMode => (m === "kanban" || m === "timeline" ? m : "tasks");
export const smartOptionName = (v: ViewRef, inboxId: string): string | null =>
  v.type === "smart" && (v.name === "all" || v.name === "today" || v.name === "tomorrow" || v.name === "week") ? v.name : v.type === "project" && v.id === inboxId ? "inbox" : null;
const modeKey = (v: ViewRef): string => (v.type === "smart" ? v.name : v.type === "project" ? `p:${v.id}` : v.type === "group" ? `g:${v.id}` : v.type === "tag" ? `t:${v.name}` : v.type === "filter" ? `f:${v.id}` : "-");

export type ModalState =
  | { kind: "search" }
  | { kind: "command" }
  | { kind: "shortcuts" }
  | { kind: "list"; projectId?: string; groupId?: string }
  | { kind: "folder"; groupId?: string; projectIds?: string[] }
  | { kind: "tag"; name?: string; parent?: string }
  | { kind: "confirm"; title: string; body?: string; ok: string; danger?: boolean; onOk: () => void; alt?: { label: string; onClick: () => void } }
  | { kind: "duplicateList"; projectId: string }
  | { kind: "batchAdd"; lines: string[]; onOk: () => void }
  | { kind: "quickAddStyle" }
  | { kind: "viewOptions" }
  | { kind: "linkParent"; taskIds: string[] }
  | { kind: "print"; taskIds: string[]; title: string }
  | { kind: "addSection"; projectId: string }
  | { kind: "matrixRules"; profileId: string; quadrant?: number }
  | { kind: "matrixViews" }
  | { kind: "gotoDate" }
  | { kind: "filter"; filterId?: string; rule?: string; name?: string }
  | { kind: "activity"; taskId?: string; projectId?: string; title: string }
  | { kind: "templates"; mode: "gallery" }
  | { kind: "importBackup"; source?: ImportSourceId }
  | { kind: "share"; projectId: string }
  | { kind: "preview"; taskId: string; attachmentId: string; source?: "task" | "comment"; url?: string; fileName?: string; fileType?: string };

const Ctx = createContext<App | null>(null);
export const useApp = (): App => {
  const c = useContext(Ctx);
  if (!c) throw new Error("no app context");
  return c;
};

function currentRoute(): Route {
  return parseHash(location.hash) ?? parseHash(`#${DEFAULT_PATH}`)!;
}

let toastSeq = 0;

export function AppProvider({ children, db: dbIn, api: apiIn }: { children: ReactNode; db?: NoorDb; api?: Api }): JSX.Element {
  const [{ db, repo, engine }] = useState(() => {
    const db = dbIn ?? new NoorDb();
    const engine = new SyncEngine(db, apiIn ?? new Api());
    const repo = new Repo(db, engine);
    return { db, repo, engine };
  });
  const [route, setRoute] = useState<Route>(currentRoute);
  const [local, setLocalState] = useState<LocalPrefs>(readLocal);
  const [now, setNow] = useState(Date.now());
  const [sync, setSync] = useState<SyncStatus>(engine.status);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<ModalState | null>(null);
  const [{ pairToken: initialPairTokenState, setupPaired: initialSetupPairedState }] = useState(() => peekLaunchPairingParams());
  const [initialPairToken, setInitialPairToken] = useState<string | null>(initialPairTokenState);
  const [initialSetupPaired, setInitialSetupPaired] = useState<boolean>(initialSetupPairedState);
  const clearInitialPairToken = useCallback(() => setInitialPairToken(null), []);
  const clearInitialSetupPaired = useCallback(() => setInitialSetupPaired(false), []);

  const tasks = useLiveQuery(() => db.tasks.toArray(), [], undefined);
  const projects = useLiveQuery(() => db.projects.toArray(), [], []);
  const groups = useLiveQuery(() => db.groups.toArray(), [], []);
  const tags = useLiveQuery(() => db.tags.toArray(), [], []);
  const columns = useLiveQuery(() => db.columns.toArray(), [], []);
  const filtersRaw = useLiveQuery(() => db.filters.toArray(), [], []);
  const filters = useMemo(() => [...filtersRaw].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)), [filtersRaw]);
  const ext = useLiveQuery(() => db.getKV<Record<string, unknown>>("ext", {}), [], {});
  const settingsRaw = useLiveQuery(() => db.getKV<Partial<Preferences> | null>("settings", null), [], null);
  const inboxId = useLiveQuery(() => db.getKV<string>("inboxId", ""), [], "");

  const settings = useMemo(() => ({ ...defaultPreferences(), ...(settingsRaw ?? {}) }) as Preferences, [settingsRaw]);

  // routing
  useEffect(() => {
    scrubLaunchPairingParams();
    const on = (): void => {
      const r = parseHash(location.hash);
      if (!r) {
        const stash = localStorage.getItem("stashWebAppPath");
        location.replace(`#${stash && parseHash(`#${stash}`) ? stash : DEFAULT_PATH}`);
        return;
      }
      const raw = location.hash.replace(/^#\/?/, "").split("?")[0];
      if (raw !== r.path) {
        // alias routes (q/all/week) settle on their canonical path
        location.replace(`#${r.path}${location.hash.includes("?") ? `?${location.hash.split("?")[1]}` : ""}`);
        return;
      }
      setRoute(r);
      if (r.view.type !== "search") localStorage.setItem("stashWebAppPath", r.path);
      if (!r.screen && r.view.type !== "search") localStorage.setItem("lastTaskPath", r.path);
    };
    window.addEventListener("hashchange", on);
    on();
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // clock: minute tick for relative dates and smart lists
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(i);
  }, []);

  // sync driver: on start, after local changes (debounced), on an interval, when back online or visible
  useEffect(() => {
    const off = engine.onStatus(setSync);
    void engine.initialize();
    let timer: ReturnType<typeof setTimeout> | undefined;
    repo.onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void engine.sync(), 250);
    };
    if (hasConfirmedServerUrl()) void engine.sync();
    const interval = setInterval(() => void engine.sync(), local.syncIntervalMs);
    const online = (): void => void engine.sync();
    const vis = (): void => {
      if (document.visibilityState === "visible") void engine.sync();
    };
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", vis);
    return () => {
      off();
      clearInterval(interval);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", vis);
    };
  }, [engine, repo, local.syncIntervalMs]);

  const setLocal = useCallback(<K extends keyof LocalPrefs>(k: K, v: LocalPrefs[K]) => {
    localStorage.setItem(k, JSON.stringify(v));
    setLocalState((s) => ({ ...s, [k]: v }));
  }, []);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (text: string, undo?: () => void, action?: string) => {
      const id = ++toastSeq;
      setToasts((t) => [...t.slice(-2), { id, text, undo, action }]);
      setTimeout(() => dismissToast(id), action ? 9000 : 5000);
    },
    [dismissToast],
  );

  const projectName = useCallback(
    (id: string) => (id === inboxId ? "Inbox" : (projects.find((p) => p.id === id)?.name ?? "")),
    [projects, inboxId],
  );

  // the URL suffix of a list follows its saved view mode (TIME-004)
  const resolveMode = useCallback(
    (v: ViewRef): ViewMode => {
      if (!local.viewModeSync) return fromWire(local.localViewModes[modeKey(v)]);
      const sn = smartOptionName(v, inboxId);
      if (sn) {
        const list = ((ext as Record<string, { smartProjects?: Array<{ name: string; viewMode?: string }> }>).smartProjectsOption?.smartProjects ?? []);
        return fromWire(list.find((x) => x.name === sn)?.viewMode);
      }
      if (v.type === "project") return fromWire(projects.find((p) => p.id === v.id)?.viewMode);
      if (v.type === "group") return fromWire(groups.find((g) => g.id === v.id)?.viewMode);
      if (v.type === "tag") return fromWire(tags.find((t) => t.name === v.name)?.viewMode);
      if (v.type === "filter") return fromWire(filters.find((f) => f.id === v.id)?.viewMode);
      return "tasks";
    },
    [local.viewModeSync, local.localViewModes, ext, projects, groups, tags, inboxId, filters],
  );
  setModeResolver(resolveMode);

  const setViewMode = useCallback(
    async (v: ViewRef, mode: ViewMode): Promise<void> => {
      if (!local.viewModeSync) {
        setLocal("localViewModes", { ...local.localViewModes, [modeKey(v)]: toWire(mode) });
        return;
      }
      const sn = smartOptionName(v, inboxId);
      if (sn) {
        const cur = ((await repo.ext()).smartProjectsOption ?? {}) as { smartProjects?: Array<Record<string, unknown>> };
        const list = [...(cur.smartProjects ?? [])];
        const i = list.findIndex((x) => x.name === sn);
        if (i >= 0) list[i] = { ...list[i], viewMode: toWire(mode) };
        else list.push({ name: sn, viewMode: toWire(mode) });
        await repo.setExt("smartProjectsOption", { ...cur, smartProjects: list });
      } else if (v.type === "project") await repo.updateProject(v.id, { viewMode: toWire(mode) });
      else if (v.type === "group") await repo.updateGroup(v.id, { viewMode: toWire(mode) } as never);
      else if (v.type === "tag") await repo.updateTag(v.name, { viewMode: toWire(mode) });
      else if (v.type === "filter") await repo.updateFilter(v.id, { viewMode: toWire(mode) });
    },
    [local.viewModeSync, local.localViewModes, inboxId, repo, setLocal],
  );

  const [me, setMe] = useState<Me | null>(null);
  const refreshMe = useCallback(async (): Promise<void> => {
    try {
      setMe(await engine.api.get<Me>("/api/auth/me"));
    } catch (e) {
      // an older server without accounts: behave as single-user; offline: keep what we had
      if (e instanceof HttpError && e.status === 404) setMe({ userId: 0, email: "", name: "", role: "admin", single: true, collaboration: { enabled: false, optedOut: false } });
    }
  }, [engine]);
  useEffect(() => {
    if (sync.state === "idle" && (!me || (engine.accountId !== null && me.userId !== engine.accountId))) void refreshMe();
  }, [sync.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const [ai, setAi] = useState<AiStatusResponse>(DEFAULT_AI_STATUS);
  const refreshAi = useCallback(async (): Promise<void> => {
    if (!hasConfirmedServerUrl()) return;
    const res = await fetchAiStatus(engine.api);
    if (res.ok && res.data && typeof res.data.configured === "boolean") setAi(res.data);
    else if (res.status === 401 || res.status === 404) setAi(DEFAULT_AI_STATUS);
  }, [engine]);
  const aiLoadedFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${me ? String(me.userId) : "anon"}|${engine.api.base}`;
    if (sync.state === "idle" && aiLoadedFor.current !== key) {
      aiLoadedFor.current = key;
      void refreshAi();
    }
  }, [sync.state, me, engine.api.base, refreshAi]);

  const value: App = {
    me,
    refreshMe,
    ai,
    collab: !!me && !me.single && me.collaboration.enabled && !me.collaboration.optedOut,
    initialPairToken,
    clearInitialPairToken,
    initialSetupPaired,
    clearInitialSetupPaired,
    db,
    repo,
    engine,
    tasks: tasks ?? [],
    projects,
    groups,
    tags,
    columns,
    filters,
    ext: ext as Record<string, never>,
    settings,
    inboxId,
    ready: tasks !== undefined && !!inboxId,
    route,
    local,
    setLocal,
    now,
    sync,
    toast,
    toasts,
    dismissToast,
    focusedId,
    setFocusedId,
    selected,
    setSelected,
    modal,
    setModal,
    projectName,
    setViewMode,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Run a repo action and show an undo toast for it. */
export function useUndoable(): (label: string, fn: () => Promise<unknown>) => Promise<void> {
  const { repo, toast } = useApp();
  return async (label, fn) => {
    await fn();
    toast(label, () => {
      void repo.undo();
    });
  };
}
