import { ChevronDown, ChevronRight, PanelRight, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../lib/core";
import { MONTHS_SHORT, WEEKDAYS_SHORT, addDays, formatTime, startOfDay, startOfWeek, weekStartIndex } from "../lib/dates";
import { isoWeek } from "../model/calendar";
import { listLanes } from "../model/kanban";
import { routeTaskPath } from "../model/router";
import { PX_PER_DAY, SNAP_MIN, barFields, barOf, moveBar, resizeBar, ticks, timeAt, xOf, type Bar, type Zoom } from "../model/timeline";
import { tasksInView, type ViewRef } from "../model/views";
import { smartOptionName, useApp, type App } from "./ctx";
import { ListMoreMenu, ViewHeader, viewTitle } from "./ListView";
import { Menu, Popover, PRIORITY_COLOR, anchorOf, type Anchor } from "./primitives";

const ROW_H = 36;
const RANGE_DAYS: Record<Zoom, number> = { day: 7, week: 56, month: 180 };
const BEFORE_DAYS: Record<Zoom, number> = { day: 1, week: 14, month: 45 };

type GroupBy = "none" | "priority" | "section";

/** Timeline group-by preference: list.timeline.sortOption (synced), smart lists in ext.smartProjectsOption (TIME-009, TIME-015). */
function useTimelineGroup(app: App, view: ViewRef): [GroupBy, (g: GroupBy) => void] {
  const sn = smartOptionName(view, app.inboxId);
  let cur: string | undefined;
  if (sn) cur = (app.ext.smartProjectsOption?.smartProjects ?? []).find((x: { name: string }) => x.name === sn)?.timeline?.sortOption?.groupBy;
  else if (view.type === "project") cur = (app.projects.find((p) => p.id === view.id)?.timeline as { sortOption?: { groupBy?: string } } | null)?.sortOption?.groupBy;
  else if (view.type === "group") cur = (app.groups.find((g) => g.id === view.id)?.timeline as { sortOption?: { groupBy?: string } } | null)?.sortOption?.groupBy;
  const g: GroupBy = cur === "priority" ? "priority" : cur === "sortOrder" || cur === "section" ? "section" : "none";
  const set = (v: GroupBy): void => {
    const sortOption = { groupBy: v === "section" ? "sortOrder" : v, orderBy: "sortOrder" };
    if (sn) {
      const opt = app.ext.smartProjectsOption ?? {};
      const list = [...(opt.smartProjects ?? [])];
      const i = list.findIndex((x: { name: string }) => x.name === sn);
      const row = { ...(i >= 0 ? list[i] : { name: sn }), timeline: { sortOption } };
      if (i >= 0) list[i] = row;
      else list.push(row);
      void app.repo.setExt("smartProjectsOption", { ...opt, smartProjects: list });
    } else if (view.type === "project") void app.repo.updateProject(view.id, { timeline: { range: null, sortType: sortOption.groupBy, sortOption } });
    else if (view.type === "group") void app.repo.updateGroup(view.id, { timeline: { range: null, sortType: sortOption.groupBy, sortOption } } as never);
  };
  return [g, set];
}

interface DragState {
  id: string;
  mode: "move" | "start" | "end";
  x0: number;
  bar: Bar;
  preview: Bar;
}

export function TimelineView({ view }: { view: ViewRef }): JSX.Element {
  const app = useApp();
  const { tasks, projects, tags, inboxId, now, settings, local, setLocal, repo, columns } = app;
  const zoom = local.timelineViewRangeTypeKey;
  const px = PX_PER_DAY[zoom];
  const [origin, setOrigin] = useState(() => (zoom === "day" ? addDays(startOfDay(now), -BEFORE_DAYS.day) : addDays(startOfWeek(now, weekStartIndex(settings.startDayOfWeek)), -BEFORE_DAYS[zoom])));
  const days = RANGE_DAYS[zoom];
  const [groupBy, setGroupBy] = useTimelineGroup(app, view);
  const [drawer, setDrawer] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [adder, setAdder] = useState<{ anchor: Anchor; start: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => ({ userId: app.me && !app.me.single ? app.me.userId : undefined, now, inboxId, projects, tags, filters: app.filters, weekStart: weekStartIndex(app.settings.startDayOfWeek) }), [app.me, now, inboxId, projects, tags, app.filters, app.settings.startDayOfWeek]);
  const open = useMemo(() => tasksInView(view, tasks, ctx), [view, tasks, ctx]);
  const tlExt = (app.ext.timeline ?? {}) as { color?: string; showGuide?: boolean; showWeek?: boolean };
  const tz = (app.ext.timelineTimeZones ?? {}) as { enabled?: boolean; additional?: string[] };
  const project = view.type === "project" ? projects.find((p) => p.id === view.id) : undefined;

  useEffect(() => {
    // zoom change: re-anchor around today and scroll today into view
    setOrigin(zoom === "day" ? addDays(startOfDay(now), -BEFORE_DAYS.day) : addDays(startOfWeek(now, weekStartIndex(settings.startDayOfWeek)), -BEFORE_DAYS[zoom]));
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scroller.current;
    // today sits near the left edge with a little of the past visible
    if (el) el.scrollLeft = Math.max(0, xOf(zoom === "day" ? now - 2 * 3600_000 : startOfDay(now), origin, px) - Math.min(el.clientWidth * 0.15, px));
  }, [origin]); // eslint-disable-line react-hooks/exhaustive-deps

  const dated = open.filter((t) => barOf(t));
  const undated = open.filter((t) => !barOf(t));
  const sortRows = (l: Task[]): Task[] => [...l].sort((a, b) => (barOf(a)!.start - barOf(b)!.start) || a.sortOrder - b.sortOrder);
  const groups = useMemo((): Array<{ key: string; label: string; rows: Task[] }> => {
    if (groupBy === "priority") return [5, 3, 1, 0].map((p) => ({ key: `p${p}`, label: ({ 5: "High", 3: "Medium", 1: "Low", 0: "None" } as Record<number, string>)[p]!, rows: sortRows(dated.filter((t) => (t.priority ?? 0) === p)) }));
    if (groupBy === "section" && view.type === "project") return listLanes(view.id, columns, dated).map((l) => ({ key: l.key, label: l.name, rows: sortRows(dated.filter((t) => l.tasks.some((x) => x.id === t.id) || (t.parentId && l.tasks.some((x) => x.id === t.parentId)))) }));
    return [{ key: "all", label: "", rows: sortRows(dated) }];
  }, [groupBy, dated, columns, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const colorOf = (t: Task): string => {
    if (tlExt.color === "priority") return PRIORITY_COLOR[t.priority ?? 0] ?? "var(--accent)";
    const c = t.projectId === inboxId ? settings.inboxColor : projects.find((p) => p.id === t.projectId)?.color;
    return c || "var(--accent)";
  };

  const pxPerMin = px / 1440;
  const onPointerDown = (e: React.PointerEvent, t: Task, mode: DragState["mode"]): void => {
    const bar = barOf(t);
    if (!bar || e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDrag({ id: t.id, mode, x0: e.clientX, bar, preview: bar });
  };
  const compute = (d: DragState, clientX: number): Bar => {
    const dx = clientX - d.x0;
    if (zoom === "day") {
      const minutes = Math.round(dx / pxPerMin / SNAP_MIN.day) * SNAP_MIN.day;
      if (d.mode === "move") return moveBar(d.bar, 0, minutes);
      const edge = d.mode === "start" ? d.bar.start : d.bar.end;
      return resizeBar(d.bar, d.mode, new Date(edge + minutes * 60_000).getTime());
    }
    const dd = Math.round(dx / px);
    if (d.mode === "move") return moveBar(d.bar, dd);
    const edge = d.mode === "start" ? d.bar.start : d.bar.end;
    if (d.bar.allDay) return resizeBar(d.bar, d.mode, addDays(edge, dd));
    return resizeBar(d.bar, d.mode, addDays(edge, dd));
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag) return;
    setDrag({ ...drag, preview: compute(drag, e.clientX) });
  };
  const onPointerUp = async (e: React.PointerEvent): Promise<void> => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const next = compute(d, e.clientX);
    if (Math.abs(e.clientX - d.x0) < 3) {
      location.hash = routeTaskPath(app.route, d.id);
      return;
    }
    if (next.start === d.bar.start && next.end === d.bar.end) return;
    await repo.updateTask(d.id, barFields(next), { undo: "Date changed" });
    app.toast("Date changed", () => void repo.undo());
  };

  const gridX = (clientX: number): number => {
    const el = scroller.current!;
    return clientX - el.getBoundingClientRect().left + el.scrollLeft;
  };
  const snapStart = (clientX: number): number => timeAt(gridX(clientX), origin, px, zoom === "day" ? 60 : 1440);
  const onGridClick = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest(".tl-bar")) return;
    setAdder({ anchor: { left: e.clientX, top: e.clientY, bottom: e.clientY, right: e.clientX, width: 0, height: 0 }, start: snapStart(e.clientX) });
  };
  const onDropUnscheduled = async (e: React.DragEvent): Promise<void> => {
    const id = e.dataTransfer.getData("text/x-task");
    if (!id) return;
    e.preventDefault();
    const s = snapStart(e.clientX);
    const bar: Bar = zoom === "day" ? { start: s, end: s + 3600_000, allDay: false } : { start: startOfDay(s), end: addDays(startOfDay(s), 1), allDay: true };
    await repo.updateTask(id, barFields(bar), { undo: "Date changed" });
  };

  const tk = ticks(origin, days, zoom);
  const width = days * px;
  const todayX = xOf(now, origin, px);
  const sectionW = local.timelineSectionViewWidth;
  const shift = (dir: -1 | 1): void => setOrigin(addDays(origin, dir * (zoom === "day" ? 1 : zoom === "week" ? 7 : 30)));
  const goToday = (): void => {
    const el = scroller.current;
    if (el) el.scrollLeft = Math.max(0, todayX - el.clientWidth / 3);
  };
  // top axis labels: every day (day zoom), every week start (week zoom), every month (month zoom)
  const months = tk.filter((t, i) => (zoom === "day" ? new Date(t.ms).getHours() === 0 : zoom === "week" ? t.major || i === 0 : i === 0 || new Date(t.ms).getDate() === 1));

  return (
    <div className="board-view tl-view" data-testid="timeline-view">
      <ViewHeader title={viewTitle(app, view)}>
        <div className="seg small tl-zoom" data-testid="tl-zoom">
          {(["day", "week", "month"] as const).map((z) => (
            <button key={z} className={zoom === z ? "on" : ""} data-testid={`tl-zoom-${z}`} onClick={() => setLocal("timelineViewRangeTypeKey", z)}>
              {z[0]!.toUpperCase() + z.slice(1)}
            </button>
          ))}
        </div>
        <button className="btn sm" onClick={() => shift(-1)} aria-label="Earlier">‹</button>
        <button className="btn sm" onClick={goToday} data-testid="tl-today">Today</button>
        <button className="btn sm" onClick={() => shift(1)} aria-label="Later">›</button>
        <TimelineOptions groupBy={groupBy} setGroupBy={setGroupBy} canSection={view.type === "project"} />
        <button className={`icon-btn${drawer ? " on" : ""}`} title="Arrange Tasks" aria-label="Arrange Tasks" data-testid="tl-arrange" onClick={() => setDrawer(!drawer)}>
          <PanelRight size={17} />
        </button>
        <ListMoreMenu view={view} />
      </ViewHeader>
      {tlExt.showGuide !== false && !local.isReadTimelineGuide && (
        <div className="tl-guide" data-testid="tl-guide">
          Drag a bar to reschedule it, drag its edges to change the duration, click an empty spot to add a task.
          <button className="icon-btn xs" aria-label="Dismiss" onClick={() => setLocal("isReadTimelineGuide", true)}>
            <X size={13} />
          </button>
        </div>
      )}
      <div className="tl-body">
        <div className="tl-sections" style={{ width: sectionW }}>
          <div className="tl-head-spacer" style={{ height: 52 + (tz.enabled ? (tz.additional?.length ?? 0) * 20 : 0) }} />
          {groups.map((g) => {
            const ck = `${project?.id ?? JSON.stringify(view)}|${g.key}`;
            const col = !!local.timelineScheduleSectionCollapse[ck];
            return (
              <div key={g.key}>
                {g.label && (
                  <button className="tl-group-head" data-testid={`tl-group-${g.label}`} onClick={() => setLocal("timelineScheduleSectionCollapse", { ...local.timelineScheduleSectionCollapse, [ck]: !col })}>
                    {col ? <ChevronRight size={13} /> : <ChevronDown size={13} />} {g.label} <span className="group-count">{g.rows.length}</span>
                  </button>
                )}
                {!col &&
                  g.rows.map((t) => (
                    <button key={t.id} className={`tl-row-label${app.route.taskId === t.id ? " open" : ""}`} style={{ height: ROW_H }} onClick={() => (location.hash = routeTaskPath(app.route, t.id))}>
                      <span className="tl-dot" style={{ background: colorOf(t) }} />
                      <span className="tl-label-text">{t.title || "No title"}</span>
                    </button>
                  ))}
              </div>
            );
          })}
          <div
            className="tl-resize"
            onPointerDown={(e) => {
              const x0 = e.clientX;
              const w0 = sectionW;
              const move = (ev: PointerEvent): void => setLocal("timelineSectionViewWidth", Math.max(140, Math.min(480, w0 + ev.clientX - x0)));
              const up = (): void => {
                window.removeEventListener("pointermove", move);
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointermove", move);
              window.addEventListener("pointerup", up);
            }}
          />
        </div>
        <div className="tl-scroll" ref={scroller} data-testid="tl-scroll" onPointerMove={onPointerMove} onPointerUp={(e) => void onPointerUp(e)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => void onDropUnscheduled(e)}>
          <div className="tl-canvas" style={{ width }}>
            <div className="tl-axis">
              <div className="tl-axis-top">
                {months.map((m) => (
                  <span key={m.ms} style={{ left: m.x }}>
                    {zoom === "day" ? `${WEEKDAYS_SHORT[new Date(m.ms).getDay()]} ${MONTHS_SHORT[new Date(m.ms).getMonth()]} ${new Date(m.ms).getDate()}` : zoom === "week" ? `${MONTHS_SHORT[new Date(m.ms).getMonth()]} ${new Date(m.ms).getDate()}, ${new Date(m.ms).getFullYear()}` : `${MONTHS_SHORT[new Date(m.ms).getMonth()]} ${new Date(m.ms).getFullYear()}`}
                    {tlExt.showWeek && zoom !== "day" ? ` · W${isoWeek(m.ms)}` : ""}
                  </span>
                ))}
              </div>
              <div className="tl-axis-ticks">
                {tk.map((t) => (
                  <span key={t.ms} className={`${t.major ? "major" : ""}${zoom !== "day" && startOfDay(t.ms) === startOfDay(now) ? " today" : ""}`} style={{ left: t.x, width: zoom === "day" ? px / 24 : px }}>
                    {zoom === "day" ? formatTime(t.ms, settings.showMeridiem !== false).replace(":00", "") : zoom === "week" ? `${WEEKDAYS_SHORT[new Date(t.ms).getDay()]!.slice(0, 2)} ${new Date(t.ms).getDate()}` : new Date(t.ms).getDate()}
                  </span>
                ))}
              </div>
              {tz.enabled &&
                (tz.additional ?? []).map((zone) => (
                  <div key={zone} className="tl-axis-tz" data-testid="tl-tz-row">
                    <b>{zone.split("/").pop()?.replace(/_/g, " ")}</b>
                    {tk
                      .filter((_, i) => zoom === "day" || i % 1 === 0)
                      .map((t) => (
                        <span key={t.ms} style={{ left: t.x }}>
                          {new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", ...(zoom === "day" ? {} : { day: "numeric" }) }).format(new Date(t.ms))}
                        </span>
                      ))}
                  </div>
                ))}
            </div>
            <div className="tl-grid" onClick={onGridClick} data-testid="tl-grid">
              {tk.map((t) => (
                <span key={t.ms} className={`tl-vline${t.major ? " major" : ""}`} style={{ left: t.x }} />
              ))}
              {todayX >= 0 && todayX <= width && <span className="tl-today" style={{ left: todayX }} />}
              {groups.map((g) => {
                const ck = `${project?.id ?? JSON.stringify(view)}|${g.key}`;
                const col = !!local.timelineScheduleSectionCollapse[ck];
                return (
                  <div key={g.key}>
                    {g.label && <div className="tl-group-gap" />}
                    {!col &&
                      g.rows.map((t) => {
                        const bar = drag?.id === t.id ? drag.preview : barOf(t)!;
                        const x = xOf(bar.start, origin, px);
                        const w = Math.max(8, xOf(bar.end, origin, px) - x);
                        return (
                          <div key={t.id} className="tl-row" style={{ height: ROW_H }}>
                            <div
                              className={`tl-bar${t.status !== 0 ? " done" : ""}${drag?.id === t.id ? " dragging" : ""}`}
                              style={{ left: x, width: w, background: `color-mix(in srgb, ${colorOf(t)} 22%, var(--surface))`, borderColor: colorOf(t) }}
                              data-testid="tl-bar"
                              data-title={t.title}
                              onPointerDown={(e) => onPointerDown(e, t, "move")}
                            >
                              <span className="tl-handle start" data-testid="tl-handle-start" onPointerDown={(e) => onPointerDown(e, t, "start")} />
                              <span className="tl-bar-text">{t.title}</span>
                              <span className="tl-handle end" data-testid="tl-handle-end" onPointerDown={(e) => onPointerDown(e, t, "end")} />
                            </div>
                            {w < 70 && <span className="tl-side-text" style={{ left: x + w + 6 }}>{t.title}</span>}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
              <div className="tl-row tl-add-row" style={{ height: ROW_H * 3 }} />
            </div>
          </div>
        </div>
        {drawer && (
          <aside className="tl-drawer" data-testid="tl-drawer">
            <div className="tl-drawer-head">Arrange Tasks <span className="group-count">{undated.length}</span></div>
            {undated.length === 0 && <div className="empty-note">No unscheduled tasks</div>}
            {undated.map((t) => (
              <div key={t.id} className="tl-drawer-item" draggable onDragStart={(e) => e.dataTransfer.setData("text/x-task", t.id)} data-testid="tl-unscheduled" data-title={t.title}>
                {t.title || "No title"}
              </div>
            ))}
          </aside>
        )}
      </div>
      {adder && (
        <Popover anchor={adder.anchor} onClose={() => setAdder(null)} testId="tl-adder">
          <AddAt
            label={zoom === "day" ? `${new Date(adder.start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : new Date(adder.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
            onAdd={async (title) => {
              const bar: Bar = zoom === "day" ? { start: adder.start, end: adder.start + 3600_000, allDay: false } : { start: startOfDay(adder.start), end: addDays(startOfDay(adder.start), 1), allDay: true };
              const projectId = view.type === "project" ? view.id : view.type === "group" ? projects.find((p) => p.groupId === view.id)?.id : undefined;
              await repo.createTask({ title, projectId, tags: view.type === "tag" ? [view.name] : undefined, ...barFields(bar) });
              setAdder(null);
            }}
          />
        </Popover>
      )}
    </div>
  );
}

/** Small title input used by the timeline and calendar to create a task at a picked time. */
export function AddAt({ label, onAdd }: { label: string; onAdd: (title: string) => Promise<void> }): JSX.Element {
  const [title, setTitle] = useState("");
  return (
    <div className="add-at">
      <div className="muted small">{label}</div>
      <input className="field full" autoFocus placeholder="What would you like to do?" value={title} data-testid="add-at-input" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && void onAdd(title.trim())} />
    </div>
  );
}

function TimelineOptions({ groupBy, setGroupBy, canSection }: { groupBy: GroupBy; setGroupBy: (g: GroupBy) => void; canSection: boolean }): JSX.Element {
  const app = useApp();
  const [a, setA] = useState<Anchor | null>(null);
  const tl = (app.ext.timeline ?? {}) as { color?: string; showGuide?: boolean; showWeek?: boolean };
  const tz = (app.ext.timelineTimeZones ?? { enabled: false, current: [], additional: [] }) as { enabled?: boolean; current?: string[]; additional?: string[] };
  const setTl = (patch: Record<string, unknown>): void => void app.repo.setExt("timeline", { color: "list", showGuide: true, showWeek: false, ...tl, ...patch });
  return (
    <>
      <button className="btn sm" data-testid="tl-options" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        View Options
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="tl-options-menu">
          <Menu
            onClose={() => setA(null)}
            items={[
              {
                label: "Group by",
                hint: groupBy === "none" ? "None" : groupBy === "priority" ? "Priority" : "Section",
                testId: "tl-group-by",
                submenu: () => (
                  <Menu
                    onClose={() => setA(null)}
                    items={[
                      { label: "None", checked: groupBy === "none", onClick: () => setGroupBy("none") },
                      { label: "Priority", checked: groupBy === "priority", testId: "tl-group-priority", onClick: () => setGroupBy("priority") },
                      ...(canSection ? [{ label: "Section", checked: groupBy === "section", testId: "tl-group-section", onClick: () => setGroupBy("section") }] : []),
                    ]}
                  />
                ),
              },
              {
                label: "Color",
                hint: tl.color === "priority" ? "Priority" : "List",
                submenu: () => (
                  <Menu
                    onClose={() => setA(null)}
                    items={[
                      { label: "List", checked: tl.color !== "priority", onClick: () => setTl({ color: "list" }) },
                      { label: "Priority", checked: tl.color === "priority", onClick: () => setTl({ color: "priority" }) },
                    ]}
                  />
                ),
              },
              { label: "Show Week Numbers", checked: !!tl.showWeek, testId: "tl-show-week", onClick: () => setTl({ showWeek: !tl.showWeek }) },
              {
                label: "Time Zones",
                hint: tz.enabled ? `${tz.additional?.length ?? 0}` : "Off",
                testId: "tl-timezones",
                onClick: () => {
                  const zone = window.prompt("Add a time zone (IANA name, e.g. Asia/Tokyo). Leave empty to turn extra zones off.", tz.additional?.[0] ?? "");
                  if (zone === null) return;
                  const z = zone.trim();
                  if (z) {
                    try {
                      new Intl.DateTimeFormat("en", { timeZone: z });
                    } catch {
                      app.toast("Unknown time zone");
                      return;
                    }
                  }
                  void app.repo.setExt("timelineTimeZones", { ...tz, enabled: !!z, current: tz.current ?? [], additional: z ? [...new Set([z, ...(tz.additional ?? [])])].slice(0, 3) : [] });
                },
              },
            ]}
          />
        </Popover>
      )}
    </>
  );
}
