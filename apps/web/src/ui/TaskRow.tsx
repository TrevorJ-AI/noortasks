import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlarmClock, ChevronDown, ChevronRight, FileText, GripVertical, MoreHorizontal, Paperclip, Pin, Repeat } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { Task } from "../lib/core";
import { chipLabel, formatTime, isOverdue, parseDate, taskStart } from "../lib/dates";
import { taskPath } from "../model/router";
import type { ViewRef } from "../model/views";
import { canEditProject } from "../data/accounts";
import { useApp } from "./ctx";
import { Checkbox, Popover, Menu, anchorOf, type Anchor } from "./primitives";
import { taskMenuItems } from "./taskMenu";

let altHeld = false;
const altListeners = new Set<(v: boolean) => void>();
if (typeof window !== "undefined") {
  const set = (v: boolean): void => {
    if (altHeld === v) return;
    altHeld = v;
    altListeners.forEach((l) => l(v));
  };
  window.addEventListener("keydown", (e) => (e.key === "Alt" ? set(true) : !e.altKey && set(false)));
  window.addEventListener("keyup", (e) => e.key === "Alt" && set(false));
  window.addEventListener("blur", () => set(false));
  document.addEventListener("visibilitychange", () => set(false));
  // a missed keyup (Alt+Tab, screenshot shortcuts) must not leave the timestamps stuck on
  for (const ev of ["pointermove", "pointerdown", "wheel"] as const) window.addEventListener(ev, (e) => !(e as MouseEvent).altKey && set(false), { passive: true });
}
/** Holding Alt reveals full timestamps in rows (TASK-115). */
function useAlt(): boolean {
  const [v, setV] = useState(altHeld);
  useEffect(() => {
    altListeners.add(setV);
    return () => void altListeners.delete(setV);
  }, []);
  return v;
}

export interface RowProps {
  task: Task;
  view: ViewRef;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  sortable?: boolean;
  showList?: boolean;
  onRowClick?: (e: React.MouseEvent, t: Task) => void;
  readOnly?: boolean;
  trash?: boolean;
}

export function TaskRow(props: RowProps): JSX.Element {
  const { task: t, view, depth = 0, sortable } = props;
  const app = useApp();
  const { repo, now, settings, tags, route, focusedId, selected, local, tasks } = app;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, disabled: !sortable, data: { type: "task", task: t } });
  const [menu, setMenu] = useState<Anchor | null>(null);
  const alt = useAlt();
  const open = route.taskId === t.id;
  const done = t.status !== 0;
  const kids = tasks.filter((k) => k.parentId === t.id && !k.deleted);
  const items = t.items ?? [];
  const checkDone = items.filter((i) => i.status !== 0).length;
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, paddingLeft: 8 + depth * 22, opacity: isDragging ? 0.4 : undefined };
  const overdue = isOverdue(t, now);
  const s = taskStart(t);
  const tagObjs = (t.tags ?? []).map((n) => tags.find((x) => x.name === n.toLowerCase()) ?? { name: n, label: n, color: null });
  const strike = done && local.completedTaskStyle === "strike";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`task-row${open ? " open" : ""}${focusedId === t.id ? " focused" : ""}${selected.has(t.id) ? " selected" : ""}${done ? " done" : ""}${strike ? " strike" : ""}`}
      data-testid="task-row"
      data-task-id={t.id}
      data-title={t.title}
      tabIndex={-1}
      onClick={(e) => props.onRowClick?.(e, t)}
      onContextMenu={(e) => {
        if (props.readOnly) return;
        e.preventDefault();
        setMenu({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 });
      }}
    >
      {sortable ? (
        <span className="drag-handle" {...attributes} {...listeners} data-testid="drag-handle" onClick={(e) => e.stopPropagation()}>
          <GripVertical size={14} />
        </span>
      ) : (
        <span className="drag-handle placeholder" />
      )}
      {props.hasChildren ? (
        <button className="icon-btn xs collapse-btn" aria-label={props.collapsed ? "Expand" : "Collapse"} onClick={(e) => (e.stopPropagation(), props.onToggleCollapse?.())}>
          {props.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : (
        <span className="collapse-spacer" />
      )}
      <Checkbox
        checked={done}
        wontDo={t.status === -1}
        priority={t.priority ?? 0}
        kind={t.kind}
        testId="task-check"
        onChange={() => {
          if (props.trash || props.readOnly) return;
          if (!canEditProject(app.projects.find((p) => p.id === t.projectId))) return app.toast("This shared list is view only for you");
          void (async () => {
            const res = await repo.toggleComplete(t.id);
            if (t.status === 0) app.toast(res.next ? "Task completed, next one scheduled" : "Task completed", () => void repo.undo());
          })();
        }}
      />
      <div className="task-main">
        <div className="task-title-line">
          <span className="task-title">{t.title || <span className="muted">No title</span>}</span>
          {alt && (
            <span className="alt-times muted">
              created {t.createdTime ? new Date(parseDate(t.createdTime)).toLocaleString() : "-"} · modified {t.modifiedTime ? new Date(parseDate(t.modifiedTime)).toLocaleString() : "-"}
            </span>
          )}
        </div>
        {!!settings.showDetail && (t.content || t.desc || items.length > 0) && (
          <div className="task-detail-line muted">{(t.content || t.desc || items.map((i) => i.title).join(" · ")).replace(/[#*>`_~=-]+/g, " ").slice(0, 140)}</div>
        )}
      </div>
      <div className="task-meta">
        {t.pinnedTime && <Pin size={12} className="muted" />}
        {kids.length > 0 && (
          <span className="meta-count" title="Subtasks">
            {kids.filter((k) => k.status !== 0).length}/{kids.length}
          </span>
        )}
        {items.length > 0 && (
          <span className="meta-count" title="Checklist">
            {checkDone}/{items.length}
          </span>
        )}
        {(t.content || t.desc) && t.kind !== "CHECKLIST" && <FileText size={13} className="muted" aria-label="Has notes" />}
        {(t.attachments?.length ?? 0) > 0 && <Paperclip size={13} className="muted" aria-label="Attachment" />}
        {(t.reminders?.length ?? 0) > 0 && <AlarmClock size={13} className="muted" aria-label="Reminder" />}
        {t.repeatFlag && <Repeat size={13} className="muted" aria-label="Repeats" />}
        {tagObjs.map((tg) => (
          <span key={tg.name} className="tag-pill" style={tg.color ? { background: `${tg.color}33`, color: tg.color } : undefined}>
            {tg.label ?? tg.name}
          </span>
        ))}
        {props.showList && <span className="list-chip">{app.projectName(t.projectId)}</span>}
        {!Number.isNaN(s) && (
          <span className={`date-chip${overdue ? " overdue" : done ? "" : " future"}`} data-testid="date-chip">
            {props.trash || done ? chipLabel(t, now, settings.showMeridiem) : chipLabel(t, now, settings.showMeridiem)}
          </span>
        )}
        {done && t.completedTime && view.type === "smart" && (view.name === "completed" || view.name === "abandoned") && (
          <span className="muted small">{formatTime(parseDate(t.completedTime), settings.showMeridiem)}</span>
        )}
      </div>
      {!props.readOnly && (
        <button
          className="icon-btn xs row-more"
          aria-label="Task menu"
          onClick={(e) => {
            e.stopPropagation();
            setMenu(anchorOf(e.currentTarget));
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      )}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} testId="task-context-menu">
          <Menu items={taskMenuItems(app, t, { context: true, openTask: () => (location.hash = taskPath(view, t.id)) })} onClose={() => setMenu(null)} />
        </Popover>
      )}
    </div>
  );
}
