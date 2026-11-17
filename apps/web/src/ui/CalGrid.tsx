import { Bell, FileText, Paperclip, Repeat } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DAY, WEEKDAYS_SHORT, addDays, formatTime, startOfDay } from "../lib/dates";
import { isoWeek, layoutDayEvents, layoutSpans, type CalItem } from "../model/calendar";
import { useApp } from "./ctx";
import { DayMarks, type Overlay } from "./calOverlay";
import { inkOn } from "./theme";

/**
 * Time grid for Day, Multi-Day and Week (CAL-014, CAL-015, CAL-021): an all-day row on top (CAL-045), hour rows
 * with the hours outside collapsedTime folded into thin bands (CAL-040), overlap layout, and pointer drag to
 * move, copy (Ctrl), resize, re-day and schedule (CAL-051..054).
 */

const BAND = 22;
const SNAP = 15;

export interface GridDrop {
  item: CalItem;
  /** new span; allDay true means it was dropped on the all-day row */
  start: number;
  end: number;
  allDay: boolean;
  copy: boolean;
}

export interface GridProps {
  days: number[];
  items: CalItem[];
  colorOf: (i: CalItem) => string;
  selected: Set<string>;
  onOpen: (i: CalItem, e: React.MouseEvent | React.PointerEvent) => void;
  onToggle: (i: CalItem) => void;
  onDrop: (d: GridDrop) => void;
  onCreate: (start: number, end: number, allDay: boolean, at: { x: number; y: number }) => void;
  onExternalDrop: (taskId: string, start: number, allDay: boolean) => void;
  showDetail: boolean;
  showIcons: boolean;
  classic: boolean;
  weekNumbers: boolean;
  altLabel: (ms: number) => string;
  overlay?: Overlay;
}

interface Geo {
  y: (min: number) => number;
  min: (y: number) => number;
  height: number;
}

function geometry(hh: number, cs: number, ce: number, expanded: boolean): Geo {
  if (expanded || (cs <= 0 && ce >= 24)) return { y: (m) => (m / 60) * hh, min: (y) => (y / hh) * 60, height: 24 * hh };
  const top = cs > 0 ? BAND : 0;
  const mid = (ce - cs) * hh;
  const bot = ce < 24 ? BAND : 0;
  return {
    y: (m) => (m < cs * 60 ? (m / (cs * 60)) * top : m <= ce * 60 ? top + ((m - cs * 60) / 60) * hh : top + mid + ((m - ce * 60) / ((24 - ce) * 60)) * bot),
    min: (y) => (y < top ? (y / top) * cs * 60 : y <= top + mid ? cs * 60 + ((y - top) / hh) * 60 : ce * 60 + ((y - top - mid) / bot) * (24 - ce) * 60),
    height: top + mid + bot,
  };
}

const minutesOf = (ms: number, day: number): number => Math.max(0, Math.min(1440, (ms - day) / 60_000 - (new Date(ms).getTimezoneOffset() - new Date(day).getTimezoneOffset())));
const atMinutes = (day: number, min: number): number => {
  const d = new Date(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, Math.round(min)).getTime();
};

interface Drag {
  item: CalItem;
  mode: "move" | "top" | "bottom";
  x0: number;
  y0: number;
  grab: number; // minutes between the block start and the pointer
  moved: boolean;
  preview?: { start: number; end: number; allDay: boolean };
  copy: boolean;
}

export function TimeGrid(p: GridProps): JSX.Element {
  const app = useApp();
  const { local, setLocal, settings, now } = app;
  const hh = local.timelineHourHeight;
  const [cs, ce] = (settings.collapsedTime as number[] | undefined) ?? [7, 21];
  const expanded = !!local.calHideRangeStatus.expanded;
  const geo = geometry(hh, cs ?? 7, ce ?? 21, expanded);
  const meridiem = settings.showMeridiem !== false;
  const body = useRef<HTMLDivElement>(null);
  const allRow = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const zones = ((app.ext.timelineTimeZones ?? {}) as { enabled?: boolean; additional?: string[] }).enabled ? ((app.ext.timelineTimeZones as { additional?: string[] }).additional ?? []) : [];
  const n = p.days.length;
  const first = p.days[0]!;

  // restore and keep the scroll position of the hour grid (CAL-047)
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.scrollTop = local.calScrollTop >= 0 ? local.calScrollTop : Math.max(0, geo.y(8 * 60) - 20);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const allDayItems = p.items.filter((i) => i.allDay || i.end - i.start >= DAY);
  const timed = p.items.filter((i) => !i.allDay && i.end - i.start < DAY);
  const spans = layoutSpans(allDayItems, first, n);
  const lanes = spans.reduce((m, s) => Math.max(m, s.lane + 1), 0);
  const rowH = local.allDayCollapse ? 26 : Math.max(local.allDayViewHeight, Math.min(lanes, 2) * 22 + 8);
  const visibleLanes = Math.max(1, Math.floor((rowH - 6) / 22));

  /** day index and minutes under a client point, or null outside the grid */
  const locate = (cx: number, cy: number): { di: number; min: number; inAllDay: boolean } | null => {
    const b = body.current;
    const a = allRow.current;
    if (!b || !a) return null;
    const cols = b.querySelectorAll<HTMLElement>("[data-col]");
    let di = -1;
    cols.forEach((c, i) => {
      const r = c.getBoundingClientRect();
      if (cx >= r.left && cx < r.right) di = i;
    });
    if (di < 0) {
      const r0 = cols[0]?.getBoundingClientRect();
      if (!r0) return null;
      di = cx < r0.left ? 0 : n - 1;
    }
    const ar = a.getBoundingClientRect();
    if (cy >= ar.top && cy <= ar.bottom) return { di, min: 0, inAllDay: true };
    const col = cols[di]!.getBoundingClientRect();
    const min = Math.max(0, Math.min(1440 - SNAP, geo.min(cy - col.top)));
    return { di, min, inAllDay: false };
  };

  const startDrag = (e: React.PointerEvent, item: CalItem, mode: Drag["mode"]): void => {
    if (e.button !== 0 || item.kind === 3) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const loc = locate(e.clientX, e.clientY);
    const grab = loc && !loc.inAllDay && !item.allDay ? loc.min - minutesOf(item.start, startOfDay(item.start)) : 0;
    setDrag({ item, mode, x0: e.clientX, y0: e.clientY, grab, moved: false, copy: e.ctrlKey || e.metaKey });
  };
  const previewAt = (d: Drag, cx: number, cy: number): Drag["preview"] => {
    const loc = locate(cx, cy);
    if (!loc) return d.preview;
    const day = p.days[loc.di]!;
    const it = d.item;
    const len = it.end - it.start;
    if (d.mode === "move") {
      if (loc.inAllDay) {
        const span = it.allDay ? Math.max(1, Math.round(len / DAY)) : 1;
        return { start: day, end: addDays(day, span), allDay: true };
      }
      const startMin = Math.round((loc.min - d.grab) / SNAP) * SNAP;
      const s = atMinutes(day, Math.max(0, Math.min(1440 - SNAP, startMin)));
      return { start: s, end: s + (it.allDay ? 60 * 60_000 : len), allDay: false };
    }
    const m = Math.round(loc.min / SNAP) * SNAP;
    if (d.mode === "bottom") {
      const e2 = atMinutes(startOfDay(it.start), Math.max(minutesOf(it.start, startOfDay(it.start)) + SNAP, m));
      return { start: it.start, end: e2, allDay: false };
    }
    const s2 = atMinutes(startOfDay(it.start), Math.min(minutesOf(it.end, startOfDay(it.start)) - SNAP, m));
    return { start: s2, end: it.end, allDay: false };
  };
  const onMove = (e: React.PointerEvent): void => {
    if (!drag) return;
    const moved = drag.moved || Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4;
    setDrag({ ...drag, moved, preview: moved ? previewAt(drag, e.clientX, e.clientY) : undefined });
  };
  const onUp = (e: React.PointerEvent): void => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!d.moved) {
      p.onOpen(d.item, e);
      return;
    }
    const pv = previewAt(d, e.clientX, e.clientY);
    if (!pv || (pv.start === d.item.start && pv.end === d.item.end && pv.allDay === d.item.allDay)) return;
    p.onDrop({ item: d.item, ...pv, copy: d.copy || e.ctrlKey || e.metaKey });
  };

  const onEmptyClick = (e: React.MouseEvent, di: number): void => {
    if ((e.target as HTMLElement).closest(".cal-block")) return;
    const loc = locate(e.clientX, e.clientY);
    if (!loc) return;
    const s = atMinutes(p.days[di]!, Math.floor(loc.min / 30) * 30);
    const dur = Number(settings.defaultTimeDuration) > 0 ? Number(settings.defaultTimeDuration) : 60;
    p.onCreate(s, s + dur * 60_000, false, { x: e.clientX, y: e.clientY });
  };

  const block = (i: CalItem, day: number, col: number, cols: number, ghost = false): JSX.Element => {
    const ds = Math.max(i.start, day);
    const de = Math.min(i.end, addDays(day, 1));
    const top = geo.y(minutesOf(ds, day));
    const h = Math.max(18, geo.y(minutesOf(de, day)) - top);
    const c = p.colorOf(i);
    const sel = p.selected.has(i.taskId);
    return (
      <div
        key={ghost ? `ghost-${i.key}` : i.key}
        className={`cal-block${i.ext ? " ext" : ""}${i.completed ? " done" : ""}${ghost ? " ghost" : ""}${sel ? " selected" : ""}${p.classic ? " classic" : ""}`}
        style={{ top, height: h, left: `calc(${(col / cols) * 100}% + 1px)`, width: `calc(${100 / cols}% - 3px)`, background: p.classic ? c : `color-mix(in srgb, ${c} 26%, var(--surface))`, borderLeftColor: c, ...(p.classic ? { ["--ink" as string]: inkOn(c) } : {}) }}
        data-testid={ghost ? "cal-ghost" : "cal-block"}
        data-title={i.title}
        data-key={i.key}
        data-source={i.ext?.source.key}
        data-color={i.ext ? c : undefined}
        onPointerDown={ghost ? undefined : (e) => startDrag(e, i, "move")}
        onClick={i.ext && !ghost ? (e) => (e.stopPropagation(), p.onOpen(i, e)) : undefined}
      >
        {!ghost && !i.ext && <span className="cal-resize top" onPointerDown={(e) => startDrag(e, i, "top")} />}
        <div className="cal-block-line">
          {i.kind !== 3 && i.task.kind !== "NOTE" && (
            <button
              className={`cal-check${i.completed ? " on" : ""}`}
              aria-label="Complete"
              data-testid="cal-check"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                p.onToggle(i);
              }}
            />
          )}
          <span className="cal-block-title">{i.title}</span>
          {p.showIcons && <ItemIcons i={i} />}
        </div>
        {h > 30 && <div className="cal-block-time">{formatTime(i.start, meridiem)} - {formatTime(i.end, meridiem)}{p.showDetail && i.task.projectId ? ` · ${app.projectName(i.task.projectId)}` : ""}{p.showDetail && i.ext ? ` · ${i.ext.source.name}` : ""}</div>}
        {!ghost && !i.ext && <span className="cal-resize bottom" data-testid="cal-resize-bottom" onPointerDown={(e) => startDrag(e, i, "bottom")} />}
      </div>
    );
  };

  const hours = Array.from({ length: 25 }, (_, h) => h);
  const collapsedTop = !expanded && (cs ?? 7) > 0;
  const collapsedBot = !expanded && (ce ?? 21) < 24;
  const pvItem = drag?.preview && drag.moved ? { ...drag.item, ...drag.preview } : null;

  return (
    <div className="cal-grid" data-testid="cal-timegrid" onPointerMove={onMove} onPointerUp={onUp}>
      <div className="cal-days-head" style={{ gridTemplateColumns: `${56 + zones.length * 48}px repeat(${n}, 1fr)` }}>
        <div className="cal-gutter-head">{p.weekNumbers ? `W${isoWeek(first)}` : ""}</div>
        {p.days.map((d) => (
          <div key={d} className={`cal-day-head${startOfDay(now) === d ? " today" : ""}`} data-testid="cal-day-head">
            <span className="muted">{WEEKDAYS_SHORT[new Date(d).getDay()]}</span>
            <span className="cal-day-num">{new Date(d).getDate()}</span>
            <span className="cal-alt">{p.altLabel(d)}</span>
          </div>
        ))}
      </div>
      <div
        className="cal-allday"
        ref={allRow}
        style={{ height: rowH, gridTemplateColumns: `${56 + zones.length * 48}px repeat(${n}, 1fr)` }}
        data-testid="cal-allday"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const id = e.dataTransfer.getData("text/x-task");
          const loc = locate(e.clientX, e.clientY);
          if (id && loc) p.onExternalDrop(id, p.days[loc.di]!, true);
        }}
      >
        <button className="cal-gutter-head cal-allday-label" onClick={() => setLocal("allDayCollapse", !local.allDayCollapse)} title={local.allDayCollapse ? "Expand" : "Collapse"}>
          All day
        </button>
        {p.days.map((d, di) => (
          <div key={d} className="cal-allday-cell" style={{ gridColumn: di + 2 }} onClick={(e) => e.target === e.currentTarget && p.onCreate(d, addDays(d, 1), true, { x: e.clientX, y: e.clientY })}>
            {p.overlay && <DayMarks marks={p.overlay.marks(d).filter((x) => x.kind !== "focus")} max={2} />}
          </div>
        ))}
        {spans
          .filter((s) => s.lane < visibleLanes)
          .map((s) => {
            const i = allDayItems.find((x) => x.key === s.key)!;
            const c = p.colorOf(i);
            return (
              <div
                key={s.key}
                className={`cal-chip span${i.ext ? " ext" : ""}${i.completed ? " done" : ""}${p.selected.has(i.taskId) ? " selected" : ""}${s.clipStart ? " clip-start" : ""}${s.clipEnd ? " clip-end" : ""}`}
                style={{ gridColumn: `${s.startCol + 2} / ${s.endCol + 3}`, top: 3 + s.lane * 22, background: `color-mix(in srgb, ${c} 24%, var(--surface))`, borderLeftColor: c }}
                data-testid="cal-allday-chip"
                data-title={i.title}
                data-source={i.ext?.source.key}
                data-color={i.ext ? c : undefined}
                onPointerDown={(e) => startDrag(e, i, "move")}
                onClick={i.ext ? (e) => (e.stopPropagation(), p.onOpen(i, e)) : undefined}
              >
                {i.title}
              </div>
            );
          })}
        {spans.some((s) => s.lane >= visibleLanes) && <span className="cal-more-flag">+{spans.filter((s) => s.lane >= visibleLanes).length}</span>}
        <span
          className="cal-allday-resize"
          onPointerDown={(e) => {
            const y0 = e.clientY;
            const h0 = rowH;
            const move = (ev: PointerEvent): void => setLocal("allDayViewHeight", Math.max(30, Math.min(260, h0 + ev.clientY - y0)));
            const up = (): void => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", up);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", up);
          }}
        />
      </div>
      <div
        className="cal-body"
        ref={body}
        onScroll={(e) => setLocal("calScrollTop", Math.round((e.target as HTMLElement).scrollTop))}
        onWheel={(e) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          setLocal("timelineHourHeight", Math.max(28, Math.min(140, hh + (e.deltaY < 0 ? 6 : -6))));
        }}
      >
        <div className="cal-body-inner" style={{ height: geo.height, gridTemplateColumns: `${56 + zones.length * 48}px repeat(${n}, 1fr)` }}>
          <div className="cal-gutter">
            {zones.map((z, zi) => (
              <div key={z} className="cal-tz-col" style={{ left: zi * 48 }} data-testid="cal-tz-col">
                <span className="cal-tz-label">{z.split("/").pop()?.replace(/_/g, " ")}</span>
                {hours.slice(0, 24).filter((h) => expanded || (h >= (cs ?? 7) && h < (ce ?? 21))).map((h) => (
                  <span key={h} className="cal-hour" style={{ top: geo.y(h * 60) }}>
                    {new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", minute: "2-digit" }).format(new Date(atMinutes(first, h * 60)))}
                  </span>
                ))}
              </div>
            ))}
            {collapsedTop && (
              <button className="cal-band" style={{ top: 0, height: BAND, left: zones.length * 48 }} onClick={() => setLocal("calHideRangeStatus", { ...local.calHideRangeStatus, expanded: true })} data-testid="cal-band-top">
                00:00 - {String(cs).padStart(2, "0")}:00
              </button>
            )}
            {hours
              .filter((h) => h < 24 && (expanded || (h > (cs ?? 7) && h < (ce ?? 21)) || (h === 0 && expanded)))
              .map((h) => (
                <span key={h} className="cal-hour" style={{ top: geo.y(h * 60), left: zones.length * 48 }}>
                  {h === 12 && !meridiem ? "Noon" : formatTime(atMinutes(first, h * 60), meridiem).replace(":00 ", " ")}
                </span>
              ))}
            {collapsedBot && (
              <button className="cal-band" style={{ top: geo.height - BAND, height: BAND, left: zones.length * 48 }} onClick={() => setLocal("calHideRangeStatus", { ...local.calHideRangeStatus, expanded: true })} data-testid="cal-band-bottom">
                {String(ce).padStart(2, "0")}:00 - 00:00
              </button>
            )}
            {expanded && (
              <button className="cal-band collapse" style={{ top: 0, height: 18, left: zones.length * 48 }} onClick={() => setLocal("calHideRangeStatus", { ...local.calHideRangeStatus, expanded: false })}>
                Collapse
              </button>
            )}
          </div>
          {p.days.map((d, di) => {
            const dayEnd = addDays(d, 1);
            const mine = timed.filter((i) => i.start < dayEnd && i.end > d);
            const placed = layoutDayEvents(mine.map((i) => ({ key: i.key, start: Math.max(i.start, d), end: Math.min(i.end, dayEnd) })));
            const isToday = startOfDay(now) === d;
            return (
              <div
                key={d}
                className={`cal-col${isToday ? " today" : ""}`}
                data-col={di}
                data-day={d}
                onClick={(e) => onEmptyClick(e, di)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData("text/x-task");
                  const loc = locate(e.clientX, e.clientY);
                  if (id && loc) p.onExternalDrop(id, atMinutes(d, Math.round(loc.min / SNAP) * SNAP), false);
                }}
              >
                {hours.slice(1, 24).filter((h) => expanded || (h >= (cs ?? 7) && h <= (ce ?? 21))).map((h) => (
                  <span key={h} className="cal-hline" style={{ top: geo.y(h * 60) }} />
                ))}
                {mine.map((i) => {
                  const pl = placed.get(i.key) ?? { col: 0, cols: 1 };
                  return drag?.moved && drag.item.key === i.key && !drag.copy ? null : block(i, d, pl.col, pl.cols);
                })}
                {pvItem && !pvItem.allDay && pvItem.start < dayEnd && pvItem.end > d && block(pvItem, d, 0, 1, true)}
                {p.overlay?.blocks(d).map((b) => (
                  <div key={b.key} className="cal-focus-block" data-testid="cal-focus-block" title={`${b.label}: ${formatTime(b.start, settings.showMeridiem !== false)} - ${formatTime(b.end, settings.showMeridiem !== false)}`} style={{ top: geo.y(minutesOf(b.start, d)), height: Math.max(6, geo.y(minutesOf(Math.min(b.end, dayEnd), d)) - geo.y(minutesOf(b.start, d))) }}>
                    <span>{b.label}</span>
                  </div>
                ))}
                {isToday && <span className="cal-now" style={{ top: geo.y(minutesOf(now, d)) }} />}
              </div>
            );
          })}
        </div>
      </div>
      {pvItem?.allDay && <div className="cal-drop-hint">Drop on {new Date(pvItem.start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} (all day)</div>}
    </div>
  );
}

export function ItemIcons({ i }: { i: CalItem }): JSX.Element | null {
  const t = i.task;
  const has = [(t.reminders ?? []).length > 0 && <Bell key="r" size={10} />, !!t.repeatFlag && <Repeat key="p" size={10} />, !!(t.content || t.desc) && <FileText key="n" size={10} />, (t.attachments ?? []).length > 0 && <Paperclip key="a" size={10} />].filter(Boolean);
  if (!has.length) return null;
  return (
    <span className="cal-icons" data-testid="cal-icons">
      {has}
    </span>
  );
}
