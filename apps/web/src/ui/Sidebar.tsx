import { weekStartIndex } from "../lib/dates";
import { ChevronUp, Filter, Users } from "lucide-react";
import { Archive, Bell, CalendarDays, CalendarRange, ChevronDown, ChevronRight, CircleCheck, CircleHelp, CircleSlash, Copy, Folder, FolderInput, Hash, Inbox, Layers, List as ListIcon, MoreHorizontal, NotebookText, Pencil, Pin, Plus, RefreshCw, Search, Settings, Sun, Sunrise, LayoutGrid, SquareCheckBig, Trash2, Eye, EyeOff, UserCheck, ChartColumn, LogOut, Timer, Hourglass, Sprout } from "lucide-react";
import { countdownOn, habitOn, pomoOn, useTimer } from "./m4ctx";
import { formatClock, displayMs } from "../model/timer";
import { useEffect, useMemo, useRef, useState } from "react";
import { useM5 } from "./m5ctx";
import { NotificationCentre } from "./Notify";
import type { Project } from "../lib/core";
import { calendarPath, countdownPath, focusPath, go, habitPath, matrixPath, sameView, statisticsPath, viewPath, type CalType } from "../model/router";
import { countFor, type ViewRef } from "../model/views";
import { isSharedProject } from "../data/accounts";
import { useApp } from "./ctx";
import { MiniMonth } from "./Calendar";
import { dayKey } from "../lib/dates";
import { useDropTarget } from "./dnd";
import { useCalSources } from "../data/calApi";
import { sourceRoute } from "../model/extCal";
import { Menu, MenuButton, Popover, anchorOf, type Anchor, type MenuItem } from "./primitives";

export const SMART_DEFAULT_VIS: Record<string, string> = { all: "hide", today: "show", tomorrow: "hide", n7ds: "show", assignee: "auto", inbox: "show", summary: "hide", tag: "show", filter: "show", completed: "show", abandoned: "auto", trash: "show", calendar: "show", stats: "hide", project: "show", subscribedCalendar: "show" };

export function useSmartVisibility(): (name: string) => string {
  const { settings } = useApp();
  return (name) => settings.smartProjects?.find((s) => s.name === name)?.visibility ?? SMART_DEFAULT_VIS[name] ?? "show";
}

function emojiIcon(name: string): { emoji: string | null; rest: string } {
  const m = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s*(.*)$/u.exec(name);
  return m ? { emoji: m[1]!, rest: m[2]! } : { emoji: null, rest: name };
}

function Row({ view, icon, label, count, color, dropId, menu, testId, indent }: { view: ViewRef; icon: React.ReactNode; label: string; count?: number; color?: string | null; dropId?: string; menu?: () => MenuItem[]; testId?: string; indent?: boolean }): JSX.Element {
  const { route, local } = useApp();
  const drop = useDropTarget(dropId ?? `nodrop:${testId ?? label}`, !dropId);
  const active = sameView(route.view, view);
  const { emoji, rest } = emojiIcon(label);
  return (
    <div ref={dropId ? drop.setNodeRef : undefined} className={`side-row${active ? " active" : ""}${drop.isOver && dropId ? " drop-over" : ""}${indent ? " indent" : ""}`} data-testid={testId}>
      <button className="side-main" onClick={() => go(viewPath(view))}>
        <span className="side-icon">{emoji ?? icon}</span>
        <span className="side-label">{emoji ? rest : label}</span>
      </button>
      {color && local.isRenderProjectColor && <span className="color-dot" style={{ background: color }} />}
      {count !== undefined && count > 0 && local.sidebarCountStyle !== "hide" && <span className="side-count">{count}</span>}
      {menu && (
        <MenuButton className="icon-btn xs side-more" title="More" items={menu} placement="bottom-start">
          <MoreHorizontal size={14} />
        </MenuButton>
      )}
    </div>
  );
}

export function Sidebar(): JSX.Element {
  const app = useApp();
  const { tasks, projects, groups, tags, inboxId, now, settings, local, setLocal, repo } = app;
  const vis = useSmartVisibility();
  const ctx = useMemo(() => ({ userId: app.me && !app.me.single ? app.me.userId : undefined, now, inboxId, projects, tags, filters: app.filters, weekStart: weekStartIndex(settings.startDayOfWeek) }), [app.me, now, inboxId, projects, tags, app.filters, settings.startDayOfWeek]);
  const hideNotes = local.sidebarCountStyle === "hideNote";
  const count = (v: ViewRef): number => countFor(v, tasks, ctx, hideNotes);
  const shown = (name: string, c: number): boolean => {
    const v = vis(name);
    return v === "show" || (v === "auto" && c > 0);
  };
  const setVis = (name: string, visibility: string): void => {
    const list = [...(settings.smartProjects ?? [])];
    const i = list.findIndex((s) => s.name === name);
    if (i >= 0) list[i] = { ...list[i]!, visibility };
    else list.push({ name, visibility, order: null });
    void repo.setSettings({ smartProjects: list });
  };
  const smartMenu = (name: string): (() => MenuItem[]) => () => [
    { label: "Pin", icon: <Pin size={15} />, onClick: () => app.toast("Pinned to the top") },
    { label: "Hide", icon: <EyeOff size={15} />, onClick: () => setVis(name, "hide") },
  ];

  const open = projects.filter((p) => !p.closed);
  const sortedGroups = [...groups].sort((a, b) => a.sortOrder - b.sortOrder);
  const loose = open.filter((p) => !p.groupId || !groups.some((g) => g.id === p.groupId));
  // folders sit among lists by sortOrder
  const top: Array<{ kind: "group"; id: string; order: number } | { kind: "project"; p: Project; order: number }> = [
    ...sortedGroups.map((g) => ({ kind: "group" as const, id: g.id, order: g.sortOrder })),
    ...loose.map((p) => ({ kind: "project" as const, p, order: p.sortOrder })),
  ].sort((a, b) => a.order - b.order);

  const listMenu = (p: Project): (() => MenuItem[]) => () => [
    { label: "Edit", icon: <Pencil size={15} />, onClick: () => app.setModal({ kind: "list", projectId: p.id }) },
    { label: "Duplicate", icon: <Copy size={15} />, onClick: () => app.setModal({ kind: "duplicateList", projectId: p.id }) },
    {
      label: "Move to folder",
      icon: <FolderInput size={15} />,
      submenu: () => (
        <Menu
          onClose={() => {}}
          items={[
            { label: "None", checked: !p.groupId, onClick: () => void repo.updateProject(p.id, { groupId: null }) },
            ...sortedGroups.map((g) => ({ label: g.name, checked: p.groupId === g.id, onClick: () => void repo.updateProject(p.id, { groupId: g.id }) })),
            { label: "New Folder", icon: <Plus size={14} />, onClick: () => app.setModal({ kind: "folder", projectIds: [p.id] }) },
          ]}
        />
      ),
    },
    { label: p.inAll === false ? "Show in All" : "Hide from All", icon: p.inAll === false ? <Eye size={15} /> : <EyeOff size={15} />, onClick: () => void repo.updateProject(p.id, { inAll: p.inAll === false }) },
    { label: "Archive", icon: <Archive size={15} />, onClick: () => void repo.updateProject(p.id, { closed: true }).then(() => app.toast("List archived")) },
    {
      label: "Delete",
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: () =>
        app.setModal({
          kind: "confirm",
          title: "Delete list",
          body: `"${p.name}" will be deleted for good. Its tasks go to the Trash.`,
          ok: "Delete",
          danger: true,
          onOk: () => {
            void repo.deleteProject(p.id);
            if (app.route.view.type === "project" && app.route.view.id === p.id) go("q/today/tasks");
          },
        }),
    },
  ];

  const projectRow = (p: Project, indent = false): JSX.Element => (
    <Row
      key={p.id}
      view={{ type: "project", id: p.id }}
      icon={isSharedProject(p) ? <Users size={17} /> : p.kind === "NOTE" ? <NotebookText size={17} /> : <ListIcon size={17} />}
      label={p.name}
      color={p.color}
      count={count({ type: "project", id: p.id })}
      dropId={`drop:project:${p.id}`}
      // a member's copy of someone else's list: only sharing details and leaving, never edit or delete
      menu={p.isOwner === false ? () => [{ label: "Members", icon: <Users size={15} />, testId: "side-list-members", onClick: () => app.setModal({ kind: "share", projectId: p.id }) }] : listMenu(p)}
      testId={`side-list-${p.name}`}
      indent={indent}
    />
  );

  const sectionOpen = (k: string): boolean => !local.sidebarCollapse[k];
  const toggleSection = (k: string): void => setLocal("sidebarCollapse", { ...local.sidebarCollapse, [k]: sectionOpen(k) });

  const rootTags = tags.filter((t) => !t.parent || !tags.some((x) => x.name === t.parent)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const tagMenu = (name: string): (() => MenuItem[]) => () => [
    { label: "Edit", icon: <Pencil size={15} />, onClick: () => app.setModal({ kind: "tag", name }) },
    { label: "Add subtag", icon: <Plus size={15} />, onClick: () => app.setModal({ kind: "tag", parent: name }) },
    {
      label: "Delete",
      icon: <Trash2 size={15} />,
      danger: true,
      onClick: () => app.setModal({ kind: "confirm", title: "Delete tag", body: "The tag is removed from every task. The tasks stay.", ok: "Delete", danger: true, onOk: () => void repo.deleteTag(name) }),
    },
  ];
  const tagRow = (name: string, indent = false): JSX.Element | null => {
    const t = tags.find((x) => x.name === name);
    if (!t) return null;
    const kids = tags.filter((x) => x.parent === t.name);
    // Smart List > Tags "Show(Omit Empty Tags)": a tag with no open tasks (and no subtag with any) is left out
    if (vis("tag") === "auto" && count({ type: "tag", name: t.name }) === 0 && !kids.some((k) => count({ type: "tag", name: k.name }) > 0)) return null;
    const openTag = local.parentTagOpenStatus[t.name] !== false;
    return (
      <div key={t.name}>
        <div className={`tag-row-wrap${kids.length > 0 ? " has-fold" : ""}`}>
          {kids.length > 0 && (
            <button className="icon-btn xs fold" aria-label="Toggle subtags" onClick={() => setLocal("parentTagOpenStatus", { ...local.parentTagOpenStatus, [t.name]: !openTag })}>
              {openTag ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
          <Row view={{ type: "tag", name: t.name }} icon={<Hash size={16} />} label={t.label ?? t.name} color={t.color ?? "var(--text-3)"} count={count({ type: "tag", name: t.name })} dropId={`drop:tag:${t.name}`} menu={tagMenu(t.name)} testId={`side-tag-${t.name}`} indent={indent} />
        </div>
        {openTag && kids.map((k) => tagRow(k.name, true))}
      </div>
    );
  };

  const completedCount = tasks.filter((t) => !t.deleted && t.status === 2).length;
  const wontDoCount = tasks.filter((t) => !t.deleted && t.status === -1).length;
  const trashCount = tasks.filter((t) => t.deleted).length;

  return (
    <nav className="sidebar" data-testid="sidebar">
      <ModuleStrip />
      <div className="side-scroll">
        {shown("all", 1) && <Row view={{ type: "smart", name: "all" }} icon={<Layers size={17} />} label="All" count={count({ type: "smart", name: "all" })} testId="side-all" />}
        {shown("today", 1) && <Row view={{ type: "smart", name: "today" }} icon={<Sun size={17} />} label="Today" count={count({ type: "smart", name: "today" })} dropId="drop:smart:today" testId="side-today" />}
        {shown("tomorrow", 1) && <Row view={{ type: "smart", name: "tomorrow" }} icon={<Sunrise size={17} />} label="Tomorrow" count={count({ type: "smart", name: "tomorrow" })} dropId="drop:smart:tomorrow" testId="side-tomorrow" />}
        {shown("n7ds", 1) && <Row view={{ type: "smart", name: "week" }} icon={<CalendarRange size={17} />} label="Next 7 Days" count={count({ type: "smart", name: "week" })} dropId="drop:smart:week" testId="side-week" />}
        {shown("assignee", count({ type: "smart", name: "assignedme" })) && <Row view={{ type: "smart", name: "assignedme" }} icon={<UserCheck size={17} />} label="Assigned to Me" count={count({ type: "smart", name: "assignedme" })} testId="side-assigned" />}
        {shown("inbox", count({ type: "project", id: inboxId })) && <Row view={{ type: "project", id: inboxId }} icon={<Inbox size={17} />} label="Inbox" color={settings.inboxColor || null} count={count({ type: "project", id: inboxId })} dropId={`drop:project:${inboxId}`} testId="side-inbox" />}
        {shown("summary", 1) && <Row view={{ type: "smart", name: "summary" }} icon={<NotebookText size={17} />} label="Summary" testId="side-summary" />}

        <div className="side-sep" />
        <div className="side-section-head">
          <button className="side-section-toggle" onClick={() => toggleSection("lists")}>Lists</button>
          <button className="icon-btn xs" aria-label="Add list" title="Add list" data-testid="add-list" onClick={() => app.setModal({ kind: "list" })}>
            <Plus size={15} />
          </button>
        </div>
        {sectionOpen("lists") &&
          top.map((item) => {
            if (item.kind === "project") return projectRow(item.p);
            const g = groups.find((x) => x.id === item.id)!;
            const kids = open.filter((p) => p.groupId === g.id).sort((a, b) => a.sortOrder - b.sortOrder);
            const openG = local.projectGroupOpenStatus[g.id] !== false;
            return (
              <div key={g.id} className="folder" data-testid={`side-folder-${g.name}`}>
                <div className="tag-row-wrap has-fold">
                  <button className="icon-btn xs fold" aria-label="Toggle folder" onClick={() => setLocal("projectGroupOpenStatus", { ...local.projectGroupOpenStatus, [g.id]: !openG })}>
                    {openG ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <Row
                    view={{ type: "group", id: g.id }}
                    icon={<Folder size={17} />}
                    label={g.name}
                    count={openG ? undefined : count({ type: "group", id: g.id })}
                    menu={() => [
                      { label: "Rename", icon: <Pencil size={15} />, onClick: () => app.setModal({ kind: "folder", groupId: g.id }) },
                      { label: "Ungroup", icon: <FolderInput size={15} />, onClick: () => void repo.deleteGroup(g.id) },
                      {
                        label: "Delete",
                        icon: <Trash2 size={15} />,
                        danger: true,
                        onClick: () => app.setModal({ kind: "confirm", title: "Delete folder", body: "The folder is removed. Its lists and tasks stay.", ok: "Delete", danger: true, onOk: () => void repo.deleteGroup(g.id) }),
                      },
                    ]}
                  />
                </div>
                {openG && kids.map((p) => projectRow(p, true))}
              </div>
            );
          })}

        {shown("filter", 1) && (
          <>
            <div className="side-section-head" data-testid="filters-head">
              <button className="side-section-toggle" onClick={() => toggleSection("filters")}>Filters</button>
              <MenuButton className="icon-btn xs side-head-more" title="Filters options" items={() => [{ label: "Add Filter", icon: <Plus size={15} />, onClick: () => app.setModal({ kind: "filter" }) }, { label: "Hide", icon: <EyeOff size={15} />, onClick: () => setVis("filter", "hide") }]}>
                <MoreHorizontal size={14} />
              </MenuButton>
              <button className="icon-btn xs" aria-label="Add filter" title="Add filter" data-testid="add-filter" onClick={() => app.setModal({ kind: "filter" })}>
                <Plus size={15} />
              </button>
            </div>
            {sectionOpen("filters") && app.filters.length === 0 && (
              <button className="side-card" data-testid="filters-empty" onClick={() => app.setModal({ kind: "filter" })}>Display tasks filtered by list, date, priority, tag, and more</button>
            )}
            {sectionOpen("filters") &&
              app.filters.map((f, i) => (
                <Row
                  key={f.id}
                  view={{ type: "filter", id: f.id }}
                  icon={<Filter size={16} />}
                  label={f.name}
                  count={count({ type: "filter", id: f.id })}
                  testId={`side-filter-${f.name}`}
                  menu={() => [
                    { label: "Edit", icon: <Pencil size={15} />, testId: "filter-menu-edit", onClick: () => app.setModal({ kind: "filter", filterId: f.id }) },
                    { label: "Duplicate", icon: <Copy size={15} />, testId: "filter-menu-duplicate", onClick: () => void repo.duplicateFilter(f.id).then(() => app.toast("Filter duplicated")) },
                    { label: "Move Up", icon: <ChevronUp size={15} />, disabled: i === 0, onClick: () => void repo.updateFilter(f.id, { sortOrder: (app.filters[i - 1]!.sortOrder ?? 0) - 1 }) },
                    { label: "Move Down", icon: <ChevronDown size={15} />, disabled: i === app.filters.length - 1, onClick: () => void repo.updateFilter(f.id, { sortOrder: (app.filters[i + 1]!.sortOrder ?? 0) + 1 }) },
                    {
                      label: "Delete",
                      icon: <Trash2 size={15} />,
                      danger: true,
                      testId: "filter-menu-delete",
                      onClick: () =>
                        app.setModal({
                          kind: "confirm",
                          title: "Delete filter",
                          body: `"${f.name}" will be deleted. Its tasks stay where they are.`,
                          ok: "Delete",
                          danger: true,
                          onOk: () => {
                            void repo.deleteFilter(f.id);
                            if (app.route.view.type === "filter" && app.route.view.id === f.id) go("q/today/tasks");
                          },
                        }),
                    },
                  ]}
                />
              ))}
          </>
        )}

        {shown("tag", tags.length) && (
          <>
            <div className="side-section-head">
              <button className="side-section-toggle" onClick={() => toggleSection("tags")}>Tags</button>
              <button className="icon-btn xs" aria-label="Add tag" title="Add tag" data-testid="add-tag" onClick={() => app.setModal({ kind: "tag" })}>
                <Plus size={15} />
              </button>
            </div>
            {sectionOpen("tags") && rootTags.map((t) => tagRow(t.name))}
          </>
        )}

        {vis("subscribedCalendar") !== "hide" && <SubscribedSection open={sectionOpen("subscribed")} onToggle={() => toggleSection("subscribed")} />}

      </div>
      {local.showMiniCalendar && (
        <div className="side-mini" data-testid="side-mini-calendar">
          <MiniMonth value={app.route.view.type === "day" ? new Date(app.route.view.date + "T00:00:00").getTime() : now} onPick={(d) => go(`d/${dayKey(d)}/tasks`)} testId="sidebar-mini-month" />
        </div>
      )}
      <div className="side-footer">
        {shown("completed", completedCount) && <Row view={{ type: "smart", name: "completed" }} icon={<CircleCheck size={17} />} label="Completed" menu={smartMenu("completed")} testId="side-completed" />}
        {shown("abandoned", wontDoCount) && <Row view={{ type: "smart", name: "abandoned" }} icon={<CircleSlash size={17} />} label="Won't Do" menu={smartMenu("abandoned")} testId="side-wontdo" />}
        {shown("trash", trashCount) && <Row view={{ type: "smart", name: "trash" }} icon={<Trash2 size={17} />} label="Trash" menu={smartMenu("trash")} testId="side-trash" />}
      </div>
    </nav>
  );
}

/** Settings > Features > Calendar: tabBars CALENDAR (SET-119, CAL-003). */
/** Subscribed Calendars in the sidebar (CAL-064, smart list subscribedCalendar): one row per feed or account, opening its event list (CAL-078). */
function SubscribedSection({ open, onToggle }: { open: boolean; onToggle: () => void }): JSX.Element | null {
  const app = useApp();
  const { sources } = useCalSources(app.engine.api);
  if (!sources.length) return null;
  // feeds one row each; an account one row with its first calendar colour
  const rows: Array<{ key: string; path: string; name: string; color: string; hidden: boolean }> = [];
  for (const s of sources) {
    if (s.kind === "account" && rows.some((r) => r.key === s.id)) continue;
    const accCals = sources.filter((x) => x.kind === "account" && x.id === s.id);
    rows.push({ key: s.kind === "account" ? s.id : s.key, path: sourceRoute(s), name: s.kind === "account" ? (s.group ?? s.name) : s.name, color: s.color, hidden: s.kind === "account" ? accCals.every((c) => !c.show) : !s.show });
  }
  return (
    <>
      <div className="side-section-head" data-testid="side-subscribed-head">
        <button className="side-section-toggle" onClick={onToggle}>Subscribed Calendars</button>
      </div>
      {open &&
        rows.map((r) => (
          <div key={r.key} className={`side-row${app.route.subcal === r.key ? " active" : ""}${r.hidden ? " dim" : ""}`} data-testid="side-subscribed" data-source={r.key}>
            <button className="side-main" onClick={() => go(r.path)}>
              <span className="side-icon"><CalendarRange size={17} /></span>
              <span className="side-label">{r.name}</span>
            </button>
            <span className="color-dot" style={{ background: r.color }} />
          </div>
        ))}
    </>
  );
}

export function calendarEnabled(app: { settings: { tabBars?: Array<{ name: string; enabled?: boolean }> } }): boolean {
  return (app.settings.tabBars ?? []).find((t) => t.name === "CALENDAR")?.enabled !== false;
}
/** Settings > Features > Eisenhower Matrix: ext.desktopTabBars MATRIX, off by default (SET-120, MTRX-001). */
export function matrixEnabled(app: { ext: Record<string, unknown> }): boolean {
  const bars = ((app.ext.desktopTabBars as { tabBars?: Array<{ name: string; active?: boolean }> } | undefined)?.tabBars ?? []);
  return bars.find((t) => t.name === "MATRIX")?.active === true;
}

export function Rail(): JSX.Element {
  const app = useApp();
  const { sync, engine } = app;
  const [pop, setPop] = useState<{ kind: "avatar" | "help" | "bell"; anchor: Anchor } | null>(null);
  const m5 = useM5();
  const bellRef = useRef<HTMLButtonElement>(null);
  // the n/:name/:type route and the phone drawer open the centre through the shared flag
  useEffect(() => {
    if (!m5.bellOpen) return;
    m5.setBellOpen(false);
    const el = bellRef.current;
    const r = el && el.offsetParent !== null ? anchorOf(el) : { left: 8, right: 8, top: 56, bottom: 56, width: 0, height: 0 };
    setPop({ kind: "bell", anchor: r });
  }, [m5.bellOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const openSettings = (tab = "profile"): void => go(app.route.path, { modalType: "settings", tabs: tab });
  const calendarOn = calendarEnabled(app);
  const matrixOn = matrixEnabled(app);
  return (
    <aside className="rail" data-testid="rail">
      <button className="avatar avatar-logo" aria-label="Account menu" data-testid="avatar" onClick={(e) => setPop({ kind: "avatar", anchor: anchorOf(e.currentTarget) })}>
        <img src="/icon.svg" alt="" draggable={false} />
      </button>
      <button className={`rail-btn${!app.route.screen ? " active" : ""}`} title="Tasks" aria-label="Tasks" data-testid="rail-tasks" onClick={() => go(localStorage.getItem("lastTaskPath") || "q/today/tasks")}>
        <SquareCheckBig size={20} />
      </button>
      {calendarOn && (
        <button className={`rail-btn${app.route.screen === "calendar" ? " active" : ""}`} title="Calendar" aria-label="Calendar" data-testid="rail-calendar" onClick={() => go(calendarPath(((app.settings.webCalendarViewType as CalType) || "m")))}>
          <CalendarDays size={20} />
        </button>
      )}
      {matrixOn && (
        <button className={`rail-btn${app.route.screen === "matrix" ? " active" : ""}`} title="Eisenhower Matrix" aria-label="Eisenhower Matrix" data-testid="rail-matrix" onClick={() => go(matrixPath(app.local.matrixActiveViewId || undefined))}>
          <LayoutGrid size={20} />
        </button>
      )}
      {habitOn(app) && (
        <button className={`rail-btn${app.route.screen === "habit" ? " active" : ""}`} title="Habit" aria-label="Habit" data-testid="rail-habit" onClick={() => go(habitPath())}>
          <Sprout size={20} />
        </button>
      )}
      {pomoOn(app) && <RailFocus />}
      {countdownOn(app) && (
        <button className={`rail-btn${app.route.screen === "countdown" ? " active" : ""}`} title="Countdown" aria-label="Countdown" data-testid="rail-countdown" onClick={() => go(countdownPath())}>
          <Hourglass size={20} />
        </button>
      )}
      <button className="rail-btn" title="Search (/)" aria-label="Search" data-testid="rail-search" onClick={() => app.setModal({ kind: "search" })}>
        <Search size={20} />
      </button>
      <span className="grow" />
      <button className={`rail-btn${sync.state === "syncing" ? " spinning" : ""}${sync.state === "offline" ? " warn" : ""}`} title={sync.state === "offline" ? `Offline, ${sync.pending} change(s) waiting` : `Sync (.)${sync.lastSync ? `, last ${new Date(sync.lastSync).toLocaleTimeString()}` : ""}`} aria-label="Sync" data-testid="rail-sync" data-sync-state={sync.state} onClick={() => void engine.sync()}>
        <RefreshCw size={19} />
        {sync.pending > 0 && <span className="badge">{sync.pending}</span>}
      </button>
      <button className="rail-btn" title="Notifications" aria-label="Notifications" data-testid="rail-bell" ref={bellRef} onClick={(e) => setPop({ kind: "bell", anchor: anchorOf(e.currentTarget) })}>
        <Bell size={19} />
        {m5.unread > 0 && <span className="badge" data-testid="bell-badge">{m5.unread}</span>}
      </button>
      <button className="rail-btn" title="Help" aria-label="Help" onClick={(e) => setPop({ kind: "help", anchor: anchorOf(e.currentTarget) })}>
        <CircleHelp size={19} />
      </button>
      {pop?.kind === "avatar" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} placement="right-start" testId="avatar-menu">
          <Menu
            onClose={() => setPop(null)}
            items={[
              { label: "Settings", icon: <Settings size={15} />, onClick: () => openSettings() },
              { label: "Statistics", icon: <ChartColumn size={15} />, onClick: () => go(statisticsPath()) },
              {
                label: "Sign Out",
                icon: <LogOut size={15} />,
                onClick: () =>
                  void engine.api.post("/api/v2/user/signout").finally(async () => {
                    await engine.db.delete();
                    location.reload();
                  }),
              },
            ]}
          />
        </Popover>
      )}
      {pop?.kind === "help" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} placement="right-start" testId="help-menu">
          <Menu
            onClose={() => setPop(null)}
            items={[
              { label: "Home", onClick: () => go("q/today/tasks") },
              { label: "Shortcuts", hint: "?", onClick: () => app.setModal({ kind: "shortcuts" }) },
              { label: "Help Center", onClick: () => openSettings("about") },
              { label: "Feedback", onClick: () => app.toast("NoorTasks is single-user: write it in the task board") },
              { label: "View Changelog", onClick: () => openSettings("about") },
            ]}
          />
        </Popover>
      )}
      {pop?.kind === "bell" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} placement="right-start" className="bell-pop">
          <NotificationCentre onClose={() => setPop(null)} />
        </Popover>
      )}
    </aside>
  );
}

export { Inbox };

/** Focus rail icon; shows the running time under the icon when focus time on the tab is on (FOC-029). */
function RailFocus(): JSX.Element {
  const app = useApp();
  const { state, now } = useTimer();
  const live = state && state.status !== "idle";
  return (
    <button className={`rail-btn${app.route.screen === "focus" ? " active" : ""}${live ? " live" : ""}`} title="Focus" aria-label="Focus" data-testid="rail-focus" onClick={() => go(focusPath())}>
      <Timer size={20} />
      {live && ((app.ext.focusConf as { showTabFocusTime?: boolean } | undefined)?.showTabFocusTime ?? true) && <span className="rail-time">{formatClock(displayMs(state, now)).replace(/^(\d+:\d\d):\d\d$/, "$1")}</span>}
    </button>
  );
}

/** Phone only: the rail is hidden, so the drawer carries the module switches. */
function ModuleStrip(): JSX.Element {
  const app = useApp();
  const m5 = useM5();
  const items: Array<[string, JSX.Element, string, boolean]> = [
    ["Tasks", <SquareCheckBig key="t" size={18} />, localStorage.getItem("lastTaskPath") || "q/today/tasks", !app.route.screen],
    ...(calendarEnabled(app) ? [["Calendar", <CalendarDays key="c" size={18} />, calendarPath(((app.settings.webCalendarViewType as CalType) || "m")), app.route.screen === "calendar"] as [string, JSX.Element, string, boolean]] : []),
    ...(matrixEnabled(app) ? [["Matrix", <LayoutGrid key="m" size={18} />, matrixPath(), app.route.screen === "matrix"] as [string, JSX.Element, string, boolean]] : []),
    ...(habitOn(app) ? [["Habit", <Sprout key="h" size={18} />, habitPath(), app.route.screen === "habit"] as [string, JSX.Element, string, boolean]] : []),
    ...(pomoOn(app) ? [["Focus", <Timer key="f" size={18} />, focusPath(), app.route.screen === "focus"] as [string, JSX.Element, string, boolean]] : []),
    ...(countdownOn(app) ? [["Countdown", <Hourglass key="d" size={18} />, countdownPath(), app.route.screen === "countdown"] as [string, JSX.Element, string, boolean]] : []),
    ["Statistics", <ChartColumn key="s" size={18} />, statisticsPath(), app.route.screen === "statistics"],
  ];
  return (
    <div className="module-strip" data-testid="module-strip">
      {items.map(([label, icon, path, on]) => (
        <button key={label} className={`module-btn${on ? " on" : ""}`} title={label} aria-label={label} onClick={() => go(path)}>
          {icon}
          <span>{label}</span>
        </button>
      ))}
      <button className="module-btn" title="Notifications" aria-label="Notifications" data-testid="drawer-bell" onClick={() => m5.setBellOpen(true)}>
        <Bell size={18} />
        <span>Alerts{m5.unread ? ` (${m5.unread})` : ""}</span>
      </button>
    </div>
  );
}
