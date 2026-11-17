import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { parseQuickAdd } from "@noortasks/quickadd";
import { ChevronLeft, ChevronRight, ChevronsLeftRight, MoreHorizontal, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Task } from "../lib/core";
import { addDays, chipLabel, deviceZone, isOverdue, parseDate, startOfDay, toServer, weekStartIndex } from "../lib/dates";
import { UNSECTIONED, lanePatch, listLanes, orderAt, renumbered, swapFirstTag, type Lane } from "../model/kanban";
import { routeTaskPath } from "../model/router";
import { groupTasks, tasksInView, type ViewRef } from "../model/views";
import { useApp, type App } from "./ctx";
import { dragModel } from "./dnd";
import { ListMoreMenu, SortMenu, ViewHeader, useSortOption, viewTitle } from "./ListView";
import { Checkbox, Menu, Modal, Popover, PRIORITY_COLOR, anchorOf, type Anchor } from "./primitives";
import { moveToDay } from "./taskutil";

const SIZE_W: Record<string, number> = { small: 240, medium: 280, large: 340 };

/** Section colours for "Show Section Color" (KANB-011): cycles the list palette by column position. */
const SECTION_TINTS = ["#5b6ee1", "#3fa66b", "#e2b714", "#f08c2e", "#e5484d", "#a35bd6", "#2f8fbf"];

function useLanes(view: ViewRef): { lanes: Lane[]; dynamic: boolean; projectId?: string } {
  const app = useApp();
  const { tasks, projects, tags, inboxId, now, settings, columns } = app;
  const [opt] = useSortOption(view);
  const ctx = useMemo(() => ({ userId: app.me && !app.me.single ? app.me.userId : undefined, now, inboxId, projects, tags, posOfOverdue: settings.posOfOverdue, filters: app.filters, weekStart: weekStartIndex(settings.startDayOfWeek) }), [app.me, now, inboxId, projects, tags, settings.posOfOverdue, app.filters, settings.startDayOfWeek]);
  return useMemo(() => {
    const open = tasksInView(view, tasks, ctx);
    if (view.type === "project") return { lanes: listLanes(view.id, columns, open), dynamic: false, projectId: view.id };
    // smart lists, folders and tags: lanes are the groups of the chosen Group by (KANB-010)
    const groupBy = !opt.groupBy || opt.groupBy === "sortOrder" || opt.groupBy === "none" ? (view.type === "smart" ? "dueDate" : "project") : opt.groupBy;
    const present = new Set(open.map((t) => t.id));
    const roots = open.filter((t) => !t.parentId || !present.has(t.parentId));
    // pinned tasks stay in their attribute lane on a board
    const groups = groupTasks(roots.map((t) => (t.pinnedTime ? { ...t, pinnedTime: undefined } : t)), { ...opt, groupBy }, ctx);
    return { lanes: groups.map((g) => ({ key: g.key, name: g.label || "Tasks", tasks: g.tasks })), dynamic: true };
  }, [view, tasks, ctx, columns, opt]);
}

function KanbanCard({ t, lane, app }: { t: Task; lane: string; app: App }): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, data: { type: "task", lane } });
  const kids = app.tasks.filter((k) => k.parentId === t.id && !k.deleted);
  const items = t.items ?? [];
  const label = chipLabel(t, app.now, app.settings.showMeridiem !== false);
  const open = app.route.taskId === t.id;
  const done = t.status !== 0;
  return (
    <div
      ref={setNodeRef}
      className={`kb-card${open ? " open" : ""}${done ? " done" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined, transition, borderLeftColor: t.priority ? PRIORITY_COLOR[t.priority] : undefined }}
      data-testid="kb-card"
      data-title={t.title}
      data-task-id={t.id}
      {...attributes}
      {...listeners}
      onClick={() => (location.hash = routeTaskPath(app.route, t.id))}
    >
      <div className="kb-card-top">
        {t.kind !== "NOTE" && (
          <span onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <Checkbox checked={done} priority={t.priority ?? 0} onChange={() => void app.repo.toggleComplete(t.id).then(() => app.toast(done ? "Task reopened" : "Task completed", () => void app.repo.undo()))} />
          </span>
        )}
        <span className="kb-title">{t.title || <span className="muted">No title</span>}</span>
      </div>
      {(label || (t.tags ?? []).length > 0 || kids.length > 0 || items.length > 0) && (
        <div className="kb-meta">
          {label && <span className={`date-chip${isOverdue(t, app.now) ? " overdue" : ""}`}>{label}</span>}
          {(t.tags ?? []).map((g) => (
            <span key={g} className="tag-pill">{app.tags.find((x) => x.name === g.toLowerCase())?.label ?? g}</span>
          ))}
          {kids.length > 0 && <span className="meta-count">{kids.filter((k) => k.status !== 0).length}/{kids.length}</span>}
          {items.length > 0 && <span className="meta-count">{items.filter((i) => i.status).length}/{items.length}</span>}
        </div>
      )}
    </div>
  );
}

/** Column quick add. In date lanes the lane date is the preset and NLP only adds a time of day (QADD-019, kanbanDateTime). */
function LaneAdd({ view, lane, columnProject, onDone }: { view: ViewRef; lane: Lane; columnProject?: string; onDone: () => void }): JSX.Element {
  const app = useApp();
  const [text, setText] = useState("");
  const submit = async (): Promise<void> => {
    const raw = text.trim();
    if (!raw) return onDone();
    const settings = app.settings;
    let p: ReturnType<typeof parseQuickAdd>;
    try {
      p = parseQuickAdd(raw, { now: new Date(app.now), timeZone: deviceZone(), weekStart: weekStartIndex(settings.startDayOfWeek), dateParsing: settings.nlpEnabled !== false, tags: app.tags.map((t) => t.label ?? t.name) });
    } catch {
      p = { title: raw, tags: [], recognized: [] };
    }
    const fields: Partial<Task> & { title: string } = { title: p.title || raw, tags: p.tags ?? [] };
    if (p.priority !== undefined) fields.priority = p.priority;
    if (p.repeatFlag) fields.repeatFlag = p.repeatFlag;
    const lp = lanePatch(lane.key);
    const dateLane = lp && "dayOffset" in lp;
    if (dateLane) {
      if (lp.dayOffset !== null) {
        const day = addDays(startOfDay(app.now), lp.dayOffset);
        const s = parseDate(p.startDate);
        if (p.isAllDay === false && !Number.isNaN(s)) {
          const d = new Date(s);
          const at = new Date(day);
          at.setHours(d.getHours(), d.getMinutes(), 0, 0);
          Object.assign(fields, { startDate: toServer(at.getTime()), dueDate: toServer(at.getTime()), isAllDay: false });
        } else Object.assign(fields, { startDate: toServer(day), dueDate: toServer(day), isAllDay: true });
      }
    } else if (p.startDate) Object.assign(fields, { startDate: toServer(parseDate(p.startDate)), dueDate: toServer(parseDate(p.dueDate ?? p.startDate)), isAllDay: p.isAllDay !== false });
    if (lp && "priority" in lp) fields.priority = lp.priority;
    if (lp && "tag" in lp && lp.tag) fields.tags = [...new Set([lp.tag, ...(fields.tags ?? [])])];
    if (columnProject) {
      fields.projectId = columnProject;
      if (lane.key !== UNSECTIONED) fields.columnId = lane.key;
    } else if (lp && "projectId" in lp) fields.projectId = lp.projectId;
    else if (view.type === "group") fields.projectId = app.projects.find((x) => x.groupId === view.id)?.id;
    await app.repo.createTask(fields, { position: "bottom" });
    setText("");
  };
  return (
    <input
      className="field kb-add-input"
      autoFocus
      placeholder="Add task"
      data-testid="kb-add-input"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void submit();
        if (e.key === "Escape") onDone();
      }}
      onBlur={() => !text.trim() && onDone()}
    />
  );
}

function LaneView({ view, lane, index, projectId, dynamic }: { view: ViewRef; lane: Lane; index: number; projectId?: string; dynamic: boolean }): JSX.Element {
  const app = useApp();
  const { local, setLocal, repo, toast } = app;
  const { setNodeRef, isOver } = useDroppable({ id: `drop:lane:${lane.key}` });
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<Anchor | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(lane.name);
  const ck = `${projectId ?? JSON.stringify(view)}|${lane.key}`;
  const collapsed = !!local.kanbanCollapsed[ck];
  const col = lane.column;
  const tint = local.kanbanSectionColor ? SECTION_TINTS[index % SECTION_TINTS.length] : undefined;
  const completed = useMemo(
    () => (app.settings.showCompleted !== false && projectId ? app.tasks.filter((t) => !t.deleted && t.status === 2 && t.projectId === projectId && (lane.key === UNSECTIONED ? !t.columnId || !app.columns.some((c) => c.id === t.columnId) : t.columnId === lane.key)).slice(0, 20) : []),
    [app.tasks, app.columns, app.settings.showCompleted, projectId, lane.key],
  );
  const toggle = (): void => setLocal("kanbanCollapsed", { ...local.kanbanCollapsed, [ck]: !collapsed });
  const neighbours = app.columns.filter((c) => c.projectId === projectId).sort((a, b) => a.sortOrder - b.sortOrder);
  const move = async (dir: -1 | 1): Promise<void> => {
    if (!col) return;
    const i = neighbours.findIndex((c) => c.id === col.id);
    const j = i + dir;
    if (j < 0 || j >= neighbours.length) return;
    const others = neighbours.filter((c) => c.id !== col.id);
    const at = dir === -1 ? i - 1 : i + 1; // index in `others` where the column lands
    await repo.moveColumn(col.id, others[at - 1]?.sortOrder, others[at]?.sortOrder);
  };
  const rename = async (): Promise<void> => {
    setRenaming(false);
    if (!col || name.trim() === col.name) return;
    const err = await repo.updateColumn(col.id, { name });
    if (err) {
      toast(err);
      setName(col.name);
    }
  };
  if (collapsed)
    return (
      <div className="kb-lane collapsed" data-testid="kb-lane" data-lane={lane.name} ref={setNodeRef}>
        <button className="kb-collapsed-btn" onClick={toggle} title="Expand" data-testid="kb-expand">
          <ChevronsLeftRight size={14} />
          <span className="kb-vert">{lane.name}</span>
          <span className="group-count">{lane.tasks.length}</span>
        </button>
      </div>
    );
  return (
    <div
      className={`kb-lane${isOver ? " over" : ""}`}
      style={{ width: SIZE_W[local.kanbanColumnSize] }}
      data-testid="kb-lane"
      data-lane={lane.name}
      draggable={!!col && !renaming}
      onDragStart={(e) => {
        if (!col) return;
        e.dataTransfer.setData("text/x-column", col.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(e) => e.dataTransfer.types.includes("text/x-column") && e.preventDefault()}
      onDrop={(e) => {
        const id = e.dataTransfer.getData("text/x-column");
        if (!id || !col || id === col.id) return;
        e.preventDefault();
        const others = neighbours.filter((c) => c.id !== id);
        const at = others.findIndex((c) => c.id === col.id);
        void repo.moveColumn(id, others[at - 1]?.sortOrder, others[at]?.sortOrder);
      }}
    >
      <div className="kb-lane-head" style={tint ? { boxShadow: `inset 0 3px 0 ${tint}`, background: `color-mix(in srgb, ${tint} 10%, transparent)` } : undefined}>
        {renaming ? (
          <input className="field kb-rename" autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => e.key === "Enter" && void rename()} data-testid="kb-rename" />
        ) : (
          <button className="kb-lane-name" onClick={toggle} onDoubleClick={() => col && setRenaming(true)} title={col ? "Double-click to rename" : undefined}>
            {lane.name}
          </button>
        )}
        <span className="group-count">{lane.tasks.length}</span>
        <span className="grow" />
        {!dynamic && (
          <button className="icon-btn xs" aria-label="Section menu" data-testid="kb-lane-menu" onClick={(e) => setMenu(anchorOf(e.currentTarget))}>
            <MoreHorizontal size={15} />
          </button>
        )}
      </div>
      <div className="kb-cards" ref={setNodeRef}>
        <SortableContext items={lane.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {lane.tasks.map((t) => (
            <KanbanCard key={t.id} t={t} lane={lane.key} app={app} />
          ))}
        </SortableContext>
        {completed.map((t) => (
          <div key={t.id} className="kb-card done" data-testid="kb-card-done" onClick={() => (location.hash = routeTaskPath(app.route, t.id))}>
            <div className="kb-card-top">
              <Checkbox checked priority={t.priority ?? 0} onChange={() => void repo.toggleComplete(t.id)} />
              <span className="kb-title">{t.title}</span>
            </div>
          </div>
        ))}
        {adding ? (
          <LaneAdd view={view} lane={lane} columnProject={projectId} onDone={() => setAdding(false)} />
        ) : (
          <button className="kb-add" onClick={() => setAdding(true)} data-testid="kb-add">
            <Plus size={14} /> Add Task
          </button>
        )}
      </div>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} placement="bottom-end" testId="kb-lane-popover">
          <Menu
            onClose={() => setMenu(null)}
            items={[
              { label: "Rename", icon: <Pencil size={15} />, disabled: !col, testId: "kb-lane-rename", onClick: () => setRenaming(true) },
              { label: "Add Section", icon: <Plus size={15} />, onClick: () => projectId && app.setModal({ kind: "addSection", projectId }) },
              { label: "Move Left", icon: <ChevronLeft size={15} />, disabled: !col || neighbours[0]?.id === col.id, testId: "kb-move-left", onClick: () => void move(-1) },
              { label: "Move Right", icon: <ChevronRight size={15} />, disabled: !col || neighbours[neighbours.length - 1]?.id === col.id, testId: "kb-move-right", onClick: () => void move(1) },
              { label: collapsed ? "Expand" : "Collapse", icon: <ChevronsLeftRight size={15} />, onClick: toggle },
              {
                label: "Delete",
                icon: <Trash2 size={15} />,
                danger: true,
                disabled: !col,
                testId: "kb-lane-delete",
                onClick: () =>
                  col &&
                  app.setModal({
                    kind: "confirm",
                    title: "Delete section",
                    body: `"${col.name}" will be deleted. Its tasks stay in the list and move to ${neighbours.find((c) => c.id !== col.id)?.name ?? "Not Sectioned"}.`,
                    ok: "Delete",
                    danger: true,
                    onOk: () => void repo.deleteColumn(col.id),
                  }),
              },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

function NewLane({ projectId }: { projectId: string }): JSX.Element {
  const app = useApp();
  const [on, setOn] = useState(false);
  const [name, setName] = useState("");
  const add = async (): Promise<void> => {
    if (!name.trim()) return setOn(false);
    const r = await app.repo.createColumn(projectId, name);
    if (typeof r === "string") app.toast(r);
    else setName("");
  };
  return (
    <div className="kb-lane new" style={{ width: SIZE_W[app.local.kanbanColumnSize] }}>
      {on ? (
        <input className="field" autoFocus placeholder="Section name" value={name} data-testid="kb-new-lane-input" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void add() : e.key === "Escape" && setOn(false))} onBlur={() => !name.trim() && setOn(false)} />
      ) : (
        <button className="kb-add" onClick={() => setOn(true)} data-testid="kb-new-lane">
          <Plus size={14} /> Add Section
        </button>
      )}
    </div>
  );
}

export function AddSectionDialog({ projectId }: { projectId: string }): JSX.Element {
  const app = useApp();
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const ok = async (): Promise<void> => {
    const r = await app.repo.createColumn(projectId, name);
    if (typeof r === "string") return setErr(r);
    app.setModal(null);
  };
  return (
    <Modal onClose={() => app.setModal(null)} testId="add-section-dialog">
      <h3>Add Section</h3>
      <input className="field full" autoFocus placeholder="Section name" value={name} data-testid="section-name" onChange={(e) => (setName(e.target.value), setErr(""))} onKeyDown={(e) => e.key === "Enter" && void ok()} />
      {err && <div className="error">{err}</div>}
      <div className="row end">
        <button className="btn" onClick={() => app.setModal(null)}>Cancel</button>
        <button className="btn primary" disabled={!name.trim()} onClick={() => void ok()} data-testid="section-ok">Add</button>
      </div>
    </Modal>
  );
}

export function KanbanView({ view }: { view: ViewRef }): JSX.Element {
  const app = useApp();
  const { repo, tasks, now, toast } = app;
  const { lanes, dynamic, projectId } = useLanes(view);

  dragModel.ids = lanes.flatMap((l) => l.tasks.map((t) => t.id));
  dragModel.view = view;
  dragModel.onDrop = async (activeId, overId) => {
    const t = tasks.find((x) => x.id === activeId);
    if (!t) return;
    const target = overId.startsWith("drop:lane:") ? lanes.find((l) => `drop:lane:${l.key}` === overId) : lanes.find((l) => l.tasks.some((x) => x.id === overId));
    if (!target) return;
    const from = lanes.find((l) => l.tasks.some((x) => x.id === activeId));
    const rest = target.tasks.filter((x) => x.id !== activeId);
    const idx = overId.startsWith("drop:lane:") ? rest.length : Math.max(0, rest.findIndex((x) => x.id === overId) + (from?.key === target.key && target.tasks.findIndex((x) => x.id === activeId) < target.tasks.findIndex((x) => x.id === overId) ? 1 : 0));
    let order = orderAt(rest.map((x) => x.sortOrder), idx);
    if (order === null) {
      const nums = renumbered(rest.length + 1);
      const seq = [...rest];
      seq.splice(idx, 0, t);
      for (let i = 0; i < seq.length; i++) if (seq[i]!.id !== t.id) await repo.updateTask(seq[i]!.id, { sortOrder: nums[i]! });
      order = nums[idx]!;
    }
    if (!dynamic && projectId) {
      // list board: column set (and order) in one step (KANB-007)
      if (from?.key === target.key) await repo.reorder(activeId, order);
      else {
        await repo.moveToColumn(activeId, { id: target.key === UNSECTIONED ? null : target.key, projectId }, order);
        toast(`Moved to ${target.name}`, () => void repo.undo());
      }
      return;
    }
    if (from?.key === target.key) return;
    // attribute board: the lane attribute changes (KANB-010)
    const lp = lanePatch(target.key);
    if (!lp) return;
    if ("priority" in lp) await repo.updateTask(activeId, { priority: lp.priority }, { undo: "Priority changed" });
    else if ("dayOffset" in lp) await repo.updateTask(activeId, lp.dayOffset === null ? { startDate: undefined, dueDate: undefined, isAllDay: undefined, reminders: [] } : moveToDay(t, addDays(startOfDay(now), lp.dayOffset)), { undo: "Date changed" });
    else if ("projectId" in lp) await repo.moveTasks([activeId], lp.projectId);
    else if ("tag" in lp) {
      const first = from?.key.startsWith("tag_") ? from.key.slice(4) : undefined;
      await repo.updateTask(activeId, { tags: swapFirstTag(t.tags ?? [], first, lp.tag) }, { undo: "Tags changed" });
    }
    toast(`Moved to ${target.name}`, () => void repo.undo());
  };

  return (
    <div className="board-view" data-testid="kanban-view">
      <ViewHeader title={viewTitle(app, view)}>
        {dynamic && <SortMenu view={view} isNote={false} />}
        <KanbanOptions />
        <ListMoreMenu view={view} />
      </ViewHeader>
      <div className="kb-board" data-testid="kb-board">
        {lanes.map((l, i) => (
          <LaneView key={l.key} view={view} lane={l} index={i} projectId={projectId} dynamic={dynamic} />
        ))}
        {!dynamic && projectId && <NewLane projectId={projectId} />}
      </div>
    </div>
  );
}

/** Kanban View Options: column size, section colour, quick add (KANB-011, KANB-012, KANB-802). */
function KanbanOptions(): JSX.Element {
  const { local, setLocal } = useApp();
  const [a, setA] = useState<Anchor | null>(null);
  return (
    <>
      <button className="icon-btn" aria-label="Kanban options" title="View Options" data-testid="kb-options" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <SlidersHorizontal size={17} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="kb-options-menu">
          <Menu
            onClose={() => setA(null)}
            items={[
              { label: "Column Size", hint: local.kanbanColumnSize, submenu: () => <Menu onClose={() => setA(null)} items={(["small", "medium", "large"] as const).map((s) => ({ label: s[0]!.toUpperCase() + s.slice(1), checked: local.kanbanColumnSize === s, onClick: () => setLocal("kanbanColumnSize", s) }))} /> },
              { label: "Show Section Color", checked: local.kanbanSectionColor, testId: "kb-section-color", onClick: () => setLocal("kanbanSectionColor", !local.kanbanSectionColor) },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

