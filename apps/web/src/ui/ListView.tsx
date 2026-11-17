import { withSyncBase } from "../data/fieldSync";
import { weekStartIndex } from "../lib/dates";
import { filterDefaults } from "../model/filters";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ArrowDownUp, ChevronDown, ChevronRight, Eye, ListPlus, MoreHorizontal, PanelLeft, Printer, Settings2, Share2, History, CircleCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { TaskStatus, formatQueryDate, type SortOption, type Task } from "../lib/core";
import { parseDate, startOfDay, taskStart } from "../lib/dates";
import { taskPath, unb64tag } from "../model/router";
import { type TaskGroup, GROUP_BY_NOTE, GROUP_BY_SMART, GROUP_BY_TASK, OPTION_LABEL, SORT_BY_NOTE, SORT_BY_TASK, defaultDirection, defaultSortOption, flattenTree, groupTasks, inDateWindow, nest, tasksInView, type ViewRef } from "../model/views";
import { useApp, type App } from "./ctx";
import { dragModel } from "./dnd";
import { Menu, Popover, anchorOf, type Anchor } from "./primitives";
import { QuickAdd } from "./QuickAdd";
import { TodayHabits } from "./Habits";
import { TaskRow } from "./TaskRow";
import { UNSECTIONED, listLanes } from "../model/kanban";
import { ViewModeButtons } from "./ViewSwitch";
import { moveToDay } from "./taskutil";

export function viewTitle(app: App, v: ViewRef): string {
  switch (v.type) {
    case "smart":
      return { all: "All", today: "Today", tomorrow: "Tomorrow", week: "Next 7 Days", assignedme: "Assigned to Me", summary: "Summary", completed: "Completed", abandoned: "Won't Do", trash: "Trash" }[v.name];
    case "project":
      return app.projectName(v.id) || "List";
    case "group":
      return app.groups.find((g) => g.id === v.id)?.name ?? "Folder";
    case "tag":
      return app.tags.find((t) => t.name === v.name)?.label ?? unb64tag(v.name);
    case "filter":
      return app.filters.find((f) => f.id === v.id)?.name ?? "Filter";
    case "day": {
      const [y, m, d] = v.date.split("-").map(Number);
      return new Date(y!, m! - 1, d!).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    }
    default:
      return "Search";
  }
}

export function viewKey(v: ViewRef): string {
  return v.type === "smart" ? v.name : v.type === "project" ? `p:${v.id}` : v.type === "group" ? `g:${v.id}` : v.type === "tag" ? `t:${v.name}` : v.type === "day" ? `d:${v.date}` : v.type === "filter" ? `f:${v.id}` : "search";
}

/** Saved sort option: lists and tags store it on the object (synced), smart lists and folders on the device. */
export function useSortOption(v: ViewRef): [SortOption, (o: SortOption) => void] {
  const app = useApp();
  const { projects, tags, local, setLocal, repo, inboxId } = app;
  let cur: SortOption | null | undefined;
  if (v.type === "project" && v.id !== inboxId) cur = projects.find((p) => p.id === v.id)?.sortOption;
  else if (v.type === "tag") cur = tags.find((t) => t.name === v.name)?.sortOption;
  else if (v.type === "filter") cur = app.filters.find((f) => f.id === v.id)?.sortOption; // FILT-018
  else cur = local.smartSortOptions[viewKey(v)];
  const value = { ...defaultSortOption(v, inboxId), ...(cur ?? {}) };
  const set = (o: SortOption): void => {
    if (v.type === "project" && v.id !== inboxId) void repo.updateProject(v.id, { sortOption: o, sortType: o.orderBy });
    else if (v.type === "tag") void repo.updateTag(v.name, { sortOption: o, sortType: o.orderBy });
    else if (v.type === "filter") void repo.updateFilter(v.id, { sortOption: o, sortType: o.orderBy });
    else {
      setLocal("smartSortOptions", { ...local.smartSortOptions, [viewKey(v)]: o });
      const key = v.type === "smart" ? ({ all: "sortTypeOfAllProject", today: "sortTypeOfToday", tomorrow: "sortTypeOfTomorrow", week: "sortTypeOfWeek" } as Record<string, string>)[v.name] : v.type === "project" ? "sortTypeOfInbox" : undefined;
      if (key) void repo.setSettings({ [key]: o.orderBy } as never);
    }
  };
  return [value, set];
}

export function SortMenu({ view, isNote }: { view: ViewRef; isNote: boolean }): JSX.Element {
  const [opt, setOpt] = useSortOption(view);
  const [a, setA] = useState<Anchor | null>(null);
  const smartLike = view.type !== "project";
  const groupOpts = isNote ? GROUP_BY_NOTE : smartLike ? GROUP_BY_SMART : GROUP_BY_TASK;
  const sortOpts = isNote ? SORT_BY_NOTE : smartLike ? [...SORT_BY_TASK.filter((s) => s !== "sortOrder"), "project"] : SORT_BY_TASK;
  const g = opt.groupBy ?? "sortOrder";
  const o = opt.orderBy ?? "sortOrder";
  const dir = (opt.order as "asc" | "desc" | null) ?? defaultDirection(o);
  return (
    <>
      <button className="icon-btn" aria-label="Sort and group" title="Sort and group" data-testid="sort-menu" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <ArrowDownUp size={17} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="sort-popover">
          <Menu
            onClose={() => setA(null)}
            items={[
              {
                label: "Group by",
                hint: OPTION_LABEL[g],
                testId: "group-by",
                submenu: () => <Menu onClose={() => setA(null)} items={groupOpts.map((x) => ({ label: OPTION_LABEL[x]!, checked: g === x, testId: `group-${x}`, onClick: () => setOpt({ ...opt, groupBy: x }) }))} />,
              },
              {
                label: "Sort by",
                hint: OPTION_LABEL[o],
                testId: "sort-by",
                submenu: () => (
                  <Menu
                    onClose={() => setA(null)}
                    items={[
                      ...sortOpts.map((x) => ({ label: OPTION_LABEL[x]!, checked: o === x, testId: `sort-${x}`, onClick: () => setOpt({ ...opt, orderBy: x, order: defaultDirection(x) }) })),
                      { divider: true, label: "" },
                      { label: dir === "desc" ? "Descending" : "Ascending", onClick: () => setOpt({ ...opt, order: dir === "desc" ? "asc" : "desc" }) },
                    ]}
                  />
                ),
              },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

export function ListMoreMenu({ view }: { view: ViewRef }): JSX.Element {
  const app = useApp();
  const { settings, repo, toast } = app;
  const [a, setA] = useState<Anchor | null>(null);
  const showCompleted = settings.showCompleted !== false;
  const showDetail = !!settings.showDetail;
  return (
    <>
      <button className="icon-btn" aria-label="List menu" title="More" data-testid="list-more" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <MoreHorizontal size={18} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="list-more-menu">
          <div className="menu">
            <div className="menu-viewrow" data-testid="view-row">
              <span className="muted">View</span>
              <ViewModeButtons view={view} onPick={() => setA(null)} />
            </div>
            <Menu
              onClose={() => setA(null)}
              items={[
                { label: showCompleted ? "Hide Completed" : "Show Completed", icon: <CircleCheck size={15} />, testId: "toggle-completed", onClick: () => void repo.setSettings({ showCompleted: !showCompleted }) },
                { label: showDetail ? "Hide Details" : "Show Details", icon: <Eye size={15} />, testId: "toggle-details", onClick: () => void repo.setSettings({ showDetail: !showDetail } as never) },
                { label: "View Options", icon: <Settings2 size={15} />, onClick: () => app.setModal({ kind: "viewOptions" }) },
                { label: "Add Section", icon: <ListPlus size={15} />, testId: "add-section", disabled: view.type !== "project" || view.id === app.inboxId, onClick: () => app.setModal({ kind: "addSection", projectId: (view as { id: string }).id }) },
                // COLL-001/002: only user-made lists; members of a shared list see the member variant
                {
                  label: "Share",
                  icon: <Share2 size={15} />,
                  testId: "list-share",
                  disabled: view.type !== "project" || view.id === app.inboxId || (!app.collab && app.projects.find((p) => p.id === (view as { id: string }).id)?.isOwner !== false),
                  onClick: () => (app.me?.single || !app.me ? toast("Sharing needs accounts: see docs/multi-user.md") : app.setModal({ kind: "share", projectId: (view as { id: string }).id })),
                },
                { label: "List Activities", icon: <History size={15} />, testId: "list-activities", disabled: view.type !== "project", onClick: () => view.type === "project" && app.setModal({ kind: "activity", projectId: view.id, title: viewTitle(app, view) }) },
                {
                  label: "Print",
                  icon: <Printer size={15} />,
                  submenu: () => (
                    <Menu
                      onClose={() => setA(null)}
                      items={[
                        { label: "Title only", onClick: () => app.setModal({ kind: "print", taskIds: dragModel.ids, title: viewTitle(app, view) }) },
                        { label: "Title and details", onClick: () => app.setModal({ kind: "print", taskIds: dragModel.ids, title: `${viewTitle(app, view)}|details` }) },
                      ]}
                    />
                  ),
                },
              ]}
            />
          </div>
        </Popover>
      )}
    </>
  );
}

export function ViewHeader({ title, children }: { title: string; children?: React.ReactNode }): JSX.Element {
  const { local, setLocal } = useApp();
  return (
    <div className="view-header">
      <button className="icon-btn" aria-label="Toggle sidebar" title="Toggle sidebar" data-testid="toggle-sidebar" onClick={() => setLocal("isLeftListHide", !local.isLeftListHide)}>
        <PanelLeft size={18} />
      </button>
      <h1 className="view-title" data-testid="view-title">{title}</h1>
      <div className="view-actions">{children}</div>
    </div>
  );
}

export function EmptyState({ title, sub }: { title: string; sub: string }): JSX.Element {
  return (
    <div className="empty-state" data-testid="empty-state">
      <svg width="120" height="90" viewBox="0 0 120 90" aria-hidden>
        <rect x="18" y="14" width="84" height="62" rx="8" fill="none" stroke="currentColor" strokeWidth="2" opacity=".35" />
        <path d="M34 36h40M34 48h52M34 60h28" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".35" />
        <circle cx="92" cy="22" r="10" fill="var(--accent)" opacity=".7" />
        <path d="M88 22l3 3 5-6" stroke="var(--on-accent)" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
      <div className="empty-title">{title}</div>
      <div className="empty-sub">{sub}</div>
    </div>
  );
}

function emptySub(now: number): string {
  const h = new Date(now).getHours();
  const dow = new Date(now).getDay();
  if (dow === 0 || dow === 6) return "Enjoy your weekend.";
  if (h < 12) return "A fresh morning. Add what matters today.";
  if (h < 18) return "All clear for now.";
  return "Nothing left for tonight.";
}

/** One click opens, Ctrl/Cmd click toggles selection, Shift click selects a range (TASK-109). */
export function useRowClick(view: ViewRef, ordered: Task[]): (e: React.MouseEvent, t: Task) => void {
  const app = useApp();
  const [anchorId, setAnchorId] = useState<string | null>(null);
  return (e, t) => {
    if (e.metaKey || e.ctrlKey) {
      const n = new Set(app.selected);
      if (n.has(t.id)) n.delete(t.id);
      else n.add(t.id);
      if (app.route.taskId && !n.has(app.route.taskId) && n.size) n.add(app.route.taskId);
      app.setSelected(n);
      setAnchorId(t.id);
      return;
    }
    if (e.shiftKey && (anchorId ?? app.route.taskId)) {
      const a = ordered.findIndex((x) => x.id === (anchorId ?? app.route.taskId));
      const b = ordered.findIndex((x) => x.id === t.id);
      if (a >= 0 && b >= 0) {
        app.setSelected(new Set(ordered.slice(Math.min(a, b), Math.max(a, b) + 1).map((x) => x.id)));
        return;
      }
    }
    app.setSelected(new Set());
    setAnchorId(t.id);
    app.setFocusedId(t.id);
    location.hash = taskPath(view, t.id);
  };
}

export function ListView({ view }: { view: ViewRef }): JSX.Element {
  const app = useApp();
  const { tasks, projects, tags, inboxId, now, settings, local, setLocal, repo, db } = app;
  const [opt] = useSortOption(view);
  const project = view.type === "project" ? projects.find((p) => p.id === view.id) : undefined;
  const isNote = project?.kind === "NOTE";
  const ctx = useMemo(() => ({ userId: app.me && !app.me.single ? app.me.userId : undefined, now, inboxId, projects, tags, posOfOverdue: settings.posOfOverdue, filters: app.filters, weekStart: weekStartIndex(settings.startDayOfWeek) }), [app.me, now, inboxId, projects, tags, settings.posOfOverdue, app.filters, settings.startDayOfWeek]);
  const open = useMemo(() => tasksInView(view, tasks, ctx), [view, tasks, ctx]);
  const sections = useMemo(() => (view.type === "project" ? app.columns.filter((c) => c.projectId === view.id) : []), [app.columns, view]);
  const groups = useMemo(() => {
    const g = groupTasks(open, opt, ctx);
    // a list with sections (kanban columns) shows them as headings when grouped by Custom (LIST-037)
    if (!sections.length || (opt.groupBy ?? "sortOrder") !== "sortOrder") return g;
    const pinned = g.filter((x) => x.key === "pinned");
    const rest = open.filter((t) => !t.pinnedTime);
    const byId = new Map(open.map((t) => [t.id, t]));
    const rootOf = (t: Task): Task => (t.parentId && byId.has(t.parentId) ? rootOf(byId.get(t.parentId)!) : t);
    return [...pinned, ...listLanes(view.type === "project" ? view.id : "", sections, rest).map((l): TaskGroup => ({ key: `sec_${l.key}`, label: l.name, tasks: rest.filter((t) => l.tasks.some((r) => r.id === rootOf(t).id)) }))].filter((x) => x.tasks.length || x.key !== `sec_${UNSECTIONED}`);
  }, [open, opt, ctx, sections, view]);
  const sortable = view.type === "project" && (opt.orderBy ?? "sortOrder") === "sortOrder" && (opt.groupBy === "sortOrder" || opt.groupBy === "none" || !opt.groupBy);
  const collapsedTasks = useMemo(() => new Set(Object.keys(local.collapsedTasks).filter((k) => local.collapsedTasks[k])), [local.collapsedTasks]);
  const vk = viewKey(view);

  const rendered = groups.map((g) => ({ g, rows: flattenTree(nest(g.tasks, (a, b) => a.sortOrder - b.sortOrder), collapsedTasks) }));
  const ordered = rendered.flatMap((r) => r.rows.map((n) => n.task));
  dragModel.ids = ordered.map((t) => t.id);
  dragModel.view = view;
  dragModel.onDrop = undefined;
  const onRowClick = useRowClick(view, ordered);

  const completed = useMemo(
    () =>
      view.type === "project" || view.type === "tag" || view.type === "group"
        ? tasks
            .filter((t) => !t.deleted && t.status === TaskStatus.Completed && tasksInView(view, [{ ...t, status: 0 }], ctx).length > 0)
            .sort((a, b) => (b.completedTime ?? "").localeCompare(a.completedTime ?? ""))
        : view.type === "smart" && (view.name === "today" || view.name === "tomorrow" || view.name === "week")
          ? tasks.filter((t) => {
              if (t.deleted || t.status !== TaskStatus.Completed) return false;
              if (view.name === "today") return startOfDay(parseDate(t.completedTime)) === startOfDay(now);
              const s = taskStart(t);
              return !Number.isNaN(s) && inDateWindow({ ...t, status: 0 }, view.name as "tomorrow" | "week", now) && !(view.name === "week" && s < startOfDay(now));
            })
          : [],
    [tasks, view, ctx, now],
  );
  const [completedLimit, setCompletedLimit] = useState(5);
  const completedOpen = !local.completedSectionStatus[vk];

  // completed rows are not part of the full check: fetch them when a list opens
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        let rows: Task[] = [];
        if (view.type === "project") rows = await app.engine.api.get<Task[]>(`/api/v2/project/${view.id}/completed/?limit=50`);
        else if (view.type === "tag") rows = (await app.engine.api.post<{ tasks: Task[] }>("/api/v2/tag/completedTask", { tags: [view.name], token: "", limit: 50 })).tasks;
        else if (view.type === "smart" && (view.name === "today" || view.name === "tomorrow" || view.name === "week")) {
          const from = formatQueryDate(startOfDay(now));
          rows = await app.engine.api.get<Task[]>(`/api/v2/project/all/completedInAll/?from=${encodeURIComponent(from)}&limit=100`);
        }
        if (!alive || !rows?.length) return;
        const pending = await app.engine.pendingKeys();
        for (const r of rows) if (!pending.has(`task:${r.id}`)) await db.tasks.put(withSyncBase(r));
      } catch {
        /* offline: local rows only */
      }
    })();
    return () => {
      alive = false;
    };
  }, [JSON.stringify(view)]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async (): Promise<void> => {
    setCompletedLimit((n) => n + 50);
    if (view.type !== "project" && view.type !== "tag") return;
    try {
      const rows =
        view.type === "project"
          ? await app.engine.api.get<Task[]>(`/api/v2/project/${view.id}/completed/?limit=100`)
          : (await app.engine.api.post<{ tasks: Task[] }>("/api/v2/tag/completedTask", { tags: [view.name], token: "", limit: 100 })).tasks;
      const pending = await app.engine.pendingKeys();
      for (const r of rows ?? []) if (!pending.has(`task:${r.id}`)) await db.tasks.put(withSyncBase(r));
    } catch {
      /* offline: local rows only */
    }
  };

  const title = viewTitle(app, view);
  // lists read "Add task"; smart lists, folders name the target list; tags read "#tag" (TAG-022)
  const fd = view.type === "filter" ? filterDefaults(app.filters.find((f) => f.id === view.id)?.rule, new Set([inboxId, ...projects.map((p) => p.id)])) : null;
  const target = fd?.projectId ? app.projectName(fd.projectId) : view.type === "smart" || view.type === "filter" ? app.projectName(settings.defaultProjectId && projects.some((p) => p.id === settings.defaultProjectId) ? (settings.defaultProjectId as string) : inboxId) || "Inbox" : "";
  const placeholder = view.type === "tag" ? `#${title}` : view.type === "project" ? "Add task" : view.type === "group" ? `Add task to "${projects.find((p) => p.groupId === view.id)?.name ?? title}"` : `Add task to "${target}"`;
  const showList = view.type !== "project";

  return (
    <div className="list-view" data-testid="list-view">
      <ViewHeader title={title}>
        <SortMenu view={view} isNote={!!isNote} />
        <ListMoreMenu view={view} />
      </ViewHeader>
      <QuickAdd view={view} placeholder={placeholder} />
      <div className="task-scroll">
        {view.type === "smart" && (view.name === "today" || view.name === "week") && <TodayHabits />}
        {open.length === 0 && completed.length === 0 && (
          <EmptyState title={view.type === "tag" ? "No tasks" : view.type === "smart" && view.name === "today" ? "No tasks for today" : "No tasks"} sub={view.type === "tag" ? "Take it easy" : emptySub(now)} />
        )}
        <SortableContext items={sortable ? ordered.map((t) => t.id) : []} strategy={verticalListSortingStrategy}>
          {rendered.map(({ g, rows }) => {
            const gk = `${vk}|${g.key}`;
            const collapsed = !!local.collapsedGroups[gk];
            return (
              <section key={g.key} className="task-group" data-testid={`group-${g.key}`}>
                {g.label && (
                  <div className="group-head">
                    <button className="group-toggle" onClick={() => setLocal("collapsedGroups", { ...local.collapsedGroups, [gk]: !collapsed })}>
                      {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                      <span className="group-label">{g.label}</span>
                      <span className="group-count">{g.tasks.length}</span>
                    </button>
                    {g.action === "postpone" && (
                      <button
                        className="link-btn"
                        data-testid="postpone"
                        onClick={() => void repo.updateEach(g.tasks.map((t) => t.id), (t) => moveToDay(t, now), "Postponed").then(() => app.toast("Overdue tasks moved to today", () => void repo.undo()))}
                      >
                        Postpone
                      </button>
                    )}
                  </div>
                )}
                {!collapsed &&
                  rows.map((n) => (
                    <TaskRow
                      key={n.task.id}
                      task={n.task}
                      view={view}
                      depth={n.depth}
                      hasChildren={n.children.length > 0}
                      collapsed={collapsedTasks.has(n.task.id)}
                      onToggleCollapse={() => setLocal("collapsedTasks", { ...local.collapsedTasks, [n.task.id]: !collapsedTasks.has(n.task.id) })}
                      sortable={sortable}
                      showList={showList}
                      onRowClick={onRowClick}
                    />
                  ))}
              </section>
            );
          })}
        </SortableContext>
        {settings.showCompleted !== false && completed.length > 0 && (
          <section className="task-group completed-group" data-testid="completed-group">
            <div className="group-head">
              <button className="group-toggle" onClick={() => setLocal("completedSectionStatus", { ...local.completedSectionStatus, [vk]: completedOpen })}>
                {completedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="group-label">Completed</span>
                <span className="group-count">{completed.length}</span>
              </button>
            </div>
            {completedOpen && completed.slice(0, completedLimit).map((t) => <TaskRow key={t.id} task={t} view={view} showList={showList} onRowClick={onRowClick} />)}
            {completedOpen && (view.type === "project" || view.type === "tag") && (
              <button className="link-btn view-more" onClick={() => void loadMore()} data-testid="completed-view-more">
                View more
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
