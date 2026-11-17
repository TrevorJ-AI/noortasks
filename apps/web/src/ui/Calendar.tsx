import { withSyncBase } from "../data/fieldSync";
import { ChevronDown, ChevronLeft, ChevronRight, Columns2, MoreHorizontal, PanelLeft, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatQueryDate, type Task } from "../lib/core";
import { DAY, MONTHS_LONG, MONTHS_SHORT, WEEKDAYS_LONG, WEEKDAYS_SHORT, addDays, addMonths, dayKey, formatTime, startOfDay, startOfWeek, weekStartIndex } from "../lib/dates";
import { altCalendarLabel, calendarItems, completionsByDay, heatLevel, isoWeek, layoutSpans, monthGridDays, spanFields, type CalItem } from "../model/calendar";
import { calendarPath, go, type CalType } from "../model/router";
import { inAllSet } from "../model/views";
import { TimeGrid, ItemIcons, type GridDrop } from "./CalGrid";
import { useApp, type App, type LocalPrefs } from "./ctx";
import { Menu, Modal, Popover, PRIORITY_COLOR, anchorOf, type Anchor } from "./primitives";
import { AddAt } from "./Timeline";
import { DayMarks, useCalOverlay, type Overlay } from "./calOverlay";
import { setShown, useCalSources, useExtEvents } from "../data/calApi";
import { eventDays, type ExtEvent } from "../model/extCal";
import { ExtEventPopover } from "./CalEvent";
import { inkOn } from "./theme";

type Sel = LocalPrefs["selectedCalendarViewType"];
/** View dropdown option order (CAL-007). */
const VIEWS: Array<{ sel: Sel; code: CalType; label: string }> = [
  { sel: "year", code: "y", label: "Year" },
  { sel: "month", code: "m", label: "Month" },
  { sel: "week", code: "w", label: "Week" },
  { sel: "day", code: "d", label: "Day" },
  { sel: "agenda", code: "a", label: "Agenda" },
  { sel: "multiDay", code: "d", label: "Multi-Day" },
  { sel: "multiWeek", code: "w", label: "Multi-Week" },
];

export interface ViewConf {
  showDetail: boolean;
  showCompleted: boolean;
  showChecklist: boolean;
  showFutureTask: boolean;
  showFocusRecord: boolean;
  showHabit: boolean;
  cellColorType: string;
  showCountdown: boolean;
  showDeclinedEvents?: boolean;
}

/** Selected sub-view from the route code plus the device's multi-day / multi-week choice (CAL-004, CAL-005). */
function currentSel(code: CalType, local: LocalPrefs): Sel {
  if (code === "d") return local.selectedCalendarViewType === "multiDay" ? "multiDay" : "day";
  if (code === "w") return local.selectedCalendarViewType === "multiWeek" ? "multiWeek" : "week";
  return code === "y" ? "year" : code === "a" ? "agenda" : "month";
}

export function useViewConf(app: App): [ViewConf, (p: Partial<ViewConf>) => void] {
  const conf = { showDetail: false, showCompleted: true, showChecklist: false, showFutureTask: true, showFocusRecord: false, showHabit: false, cellColorType: "list", showCountdown: true, ...((app.settings.calendarViewConf as Partial<ViewConf>) ?? {}) };
  return [conf, (p) => void app.repo.setSettings({ calendarViewConf: { ...conf, ...p } } as never)];
}

export function CalendarScreen(): JSX.Element {
  const app = useApp();
  const { route, local, setLocal, settings, tasks, projects, inboxId, now, repo, tags } = app;
  const code = route.calType ?? "m";
  const sel = currentSel(code, local);
  const [anchor, setAnchor] = useState(() => startOfDay(now));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adder, setAdder] = useState<{ anchor: Anchor; start: number; end: number; allDay: boolean } | null>(null);
  const [dayPop, setDayPop] = useState<{ anchor: Anchor; day: number } | null>(null);
  const [evPop, setEvPop] = useState<{ anchor: Anchor; ev: ExtEvent } | null>(null);
  const [conf] = useViewConf(app);
  const cfg = (app.ext.calendarConfig ?? {}) as { itemStyle?: string; heatmap?: boolean; showItemIcon?: boolean };
  const ws = weekStartIndex(settings.startDayOfWeek);
  const alt = ((app.ext.alternativeCalendar ?? {}) as { calendar?: string }).calendar ?? "";
  const filter = ((settings as Record<string, unknown>).webCalendarViewFilter ?? {}) as { hiddenProjects?: string[] };

  // remember the chosen view (webCalendarViewType, synced) when the route changes it
  useEffect(() => {
    if (settings.webCalendarViewType !== code) void repo.setSettings({ webCalendarViewType: code });
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  // the visible days
  const days = useMemo((): number[] => {
    if (sel === "day") return [anchor];
    if (sel === "multiDay") return Array.from({ length: Math.max(1, Math.min(14, local.multiCalendarCount)) }, (_, i) => addDays(anchor, i));
    if (sel === "week") {
      const s = startOfWeek(anchor, ws);
      return Array.from({ length: 7 }, (_, i) => addDays(s, i)).filter((d) => !local.calendarHideWeekend || (new Date(d).getDay() !== 0 && new Date(d).getDay() !== 6));
    }
    if (sel === "multiWeek") return monthGridDays(startOfWeek(anchor, ws), ws, Math.max(1, Math.min(6, local.multiWeekCount)));
    if (sel === "month") return monthGridDays(anchor, ws);
    if (sel === "agenda") return Array.from({ length: 75 }, (_, i) => addDays(startOfDay(now), i - 14));
    const y = new Date(anchor).getFullYear();
    return [new Date(y, 0, 1).getTime(), new Date(y + 1, 0, 1).getTime() - DAY];
  }, [sel, anchor, local.multiCalendarCount, local.multiWeekCount, local.calendarHideWeekend, ws, now]);
  const from = days[0]!;
  const to = addDays(days[days.length - 1]!, 1);

  // completed rows and focus records are fetched for the calendar (CAL-058)
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await app.engine.api.get<Task[]>(`/api/v2/project/all/completedInAll/?from=${encodeURIComponent(formatQueryDate(from))}&to=${encodeURIComponent(formatQueryDate(to))}&limit=${sel === "year" ? 1000 : 500}`);
        void app.engine.api.get(`/api/v2/pomodoro/record/0`).catch(() => {});
        if (!alive || !rows?.length) return;
        const pending = await app.engine.pendingKeys();
        for (const r of rows) if (!pending.has(`task:${r.id}`)) await app.db.tasks.put(withSyncBase(r));
      } catch {
        /* offline: local rows only */
      }
    })();
    return () => {
      alive = false;
    };
  }, [from, to, sel]); // eslint-disable-line react-hooks/exhaustive-deps

  // subscribed and account events in the visible range (CAL-064..079), coloured and filtered by their calendar
  const ext = useExtEvents(app.engine.api, from, to, { holidayEnabled: settings.holidayEnabled !== false, showDeclined: !!conf.showDeclinedEvents });
  const allowed = useMemo(() => inAllSet(projects, inboxId), [projects, inboxId]);
  const pool = useMemo(() => tasks.filter((t) => !t.deleted && (allowed.has(t.projectId) || t.status !== 0) && !(filter.hiddenProjects ?? []).includes(t.projectId)), [tasks, allowed, filter.hiddenProjects]);
  const items = useMemo(
    () => calendarItems(pool, { from, to, showCompleted: conf.showCompleted, showChecklist: conf.showChecklist, showFutureTask: conf.showFutureTask, showRepeat: local.showCalendarRepeat, now, weekStart: settings.startDayOfWeek === "MON" ? "MO" : settings.startDayOfWeek === "SAT" ? "SA" : "SU" }, ext),
    [pool, from, to, conf.showCompleted, conf.showChecklist, conf.showFutureTask, local.showCalendarRepeat, now, settings.startDayOfWeek, ext],
  );

  const colorOf = (i: CalItem): string => {
    if (i.ext) return i.ext.color;
    if (conf.cellColorType === "priority") return PRIORITY_COLOR[i.task.priority ?? 0] ?? "var(--accent)";
    if (conf.cellColorType === "tag") {
      const tg = (i.task.tags ?? [])[0];
      return (tg && tags.find((x) => x.name === tg.toLowerCase())?.color) || "var(--text-3)";
    }
    const c = i.task.projectId === inboxId ? settings.inboxColor : projects.find((p) => p.id === i.task.projectId)?.color;
    return c || "var(--accent)";
  };

  const pick = (s: Sel): void => {
    setLocal("selectedCalendarViewType", s);
    go(calendarPath(VIEWS.find((v) => v.sel === s)!.code, route.taskId));
  };
  const step = (dir: -1 | 1): void => {
    if (sel === "day") setAnchor(addDays(anchor, dir));
    else if (sel === "multiDay") setAnchor(addDays(anchor, dir * local.multiCalendarCount));
    else if (sel === "week") setAnchor(addDays(anchor, 7 * dir));
    else if (sel === "multiWeek") setAnchor(addDays(anchor, 7 * dir * local.multiWeekCount));
    else if (sel === "month") setAnchor(addMonths(new Date(new Date(anchor).getFullYear(), new Date(anchor).getMonth(), 1).getTime(), dir));
    else if (sel === "year") setAnchor(new Date(new Date(anchor).getFullYear() + dir, 0, 1).getTime());
    else setAnchor(addDays(anchor, 7 * dir));
  };
  const today = (): void => {
    setAnchor(startOfDay(now));
    if (sel === "agenda") setTimeout(() => document.querySelector("[data-testid=agenda-today]")?.scrollIntoView({ block: "start" }), 30);
  };

  // calendar shortcuts (CAL-010, CAL-011, KEYS-046..052): the global handler forwards them while the calendar is open
  const keyRef = useRef<(id: string) => void>(() => {});
  keyRef.current = (id) => {
    if (id === "cal_day") pick("day");
    else if (id === "cal_week") pick("week");
    else if (id === "cal_month") pick("month");
    else if (id === "cal_year") pick("year");
    else if (id === "cal_agenda") pick("agenda");
    else if (id === "cal_today") today();
    else if (id === "cal_prev") step(-1);
    else if (id === "cal_next") step(1);
    else if (id === "cal_goto") app.setModal({ kind: "gotoDate" });
  };
  useEffect(() => {
    const on = (e: Event): void => keyRef.current((e as CustomEvent<string>).detail);
    const go2 = (e: Event): void => setAnchor(startOfDay((e as CustomEvent<number>).detail));
    window.addEventListener("noor-cal", on);
    window.addEventListener("noor-cal-goto", go2);
    return () => {
      window.removeEventListener("noor-cal", on);
      window.removeEventListener("noor-cal-goto", go2);
    };
  }, []);

  const title = ((): string => {
    const a = new Date(anchor);
    if (sel === "year") return String(a.getFullYear());
    if (sel === "month") return `${MONTHS_LONG[a.getMonth()]} ${a.getFullYear()}`;
    if (sel === "day") return `${WEEKDAYS_LONG[a.getDay()]}, ${MONTHS_SHORT[a.getMonth()]} ${a.getDate()}, ${a.getFullYear()}`;
    if (sel === "agenda") return "Agenda";
    const f = new Date(days[0]!);
    const l = new Date(days[days.length - 1]!);
    return f.getMonth() === l.getMonth() ? `${MONTHS_SHORT[f.getMonth()]} ${f.getDate()} - ${l.getDate()}, ${l.getFullYear()}` : `${MONTHS_SHORT[f.getMonth()]} ${f.getDate()} - ${MONTHS_SHORT[l.getMonth()]} ${l.getDate()}, ${l.getFullYear()}`;
  })();

  // ---------------------------------------------------------------- writes
  const openItem = (i: CalItem, e: React.MouseEvent | React.PointerEvent): void => {
    if (i.ext) {
      // external events open a read-only (or two-way editable) detail popover instead of the task pane
      setEvPop({ anchor: { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }, ev: i.ext });
      return;
    }
    if (!i.taskId) return;
    if (e.ctrlKey || e.metaKey) {
      const n = new Set(selected);
      if (n.has(i.taskId)) n.delete(i.taskId);
      else n.add(i.taskId);
      setSelected(n);
      return;
    }
    setSelected(new Set());
    location.hash = calendarPath(code, i.taskId);
  };
  const toggleItem = async (i: CalItem): Promise<void> => {
    if (i.kind === 2 && i.itemId) {
      const t = tasks.find((x) => x.id === i.taskId);
      if (t) await repo.updateTask(t.id, { items: (t.items ?? []).map((it) => (it.id === i.itemId ? { ...it, status: it.status ? 0 : 1 } : it)) });
      return;
    }
    await repo.toggleComplete(i.taskId);
    app.toast(i.completed ? "Task reopened" : "Task completed", () => void repo.undo());
  };
  const applyDrop = async (d: GridDrop): Promise<void> => {
    const t = tasks.find((x) => x.id === d.item.taskId);
    if (!t) return;
    const fields = spanFields(d.start, d.end, d.allDay);
    if (d.item.kind === 2 && d.item.itemId) {
      await repo.updateTask(t.id, { items: (t.items ?? []).map((it) => (it.id === d.item.itemId ? { ...it, startDate: fields.startDate, isAllDay: fields.isAllDay } : it)) }, { undo: "Date changed" });
      return;
    }
    if (d.copy) {
      // Ctrl / Option drag duplicates (CAL-054, TASK-080)
      const c = await repo.duplicateTask(t.id, false);
      if (c) await repo.updateTask(c.id, { ...fields, repeatFlag: d.item.kind === 4 ? undefined : c.repeatFlag });
      app.toast("Task copied", () => void repo.undo());
      return;
    }
    if (t.repeatFlag && d.item.kind === 4) {
      // a later cycle cannot move while an earlier one is overdue (RPT-097)
      const base = calendarItems([t], { from: 0, to: Infinity, showCompleted: false, showChecklist: false, showFutureTask: true, showRepeat: false, now })[0];
      if (base && base.end <= startOfDay(now)) {
        app.toast("You can't drag this recurring task until you complete the previous one.");
        return;
      }
      app.setModal({
        kind: "confirm",
        title: "Change recurring task",
        body: "Apply the change to this recurrence only, or to all recurrences?",
        ok: "All recurrences",
        onOk: () => void shiftSeries(t, d),
        alt: { label: "Only this recurrence", onClick: () => void onlyThis(t, d) },
      });
      return;
    }
    await repo.updateTask(t.id, fields, { undo: "Date changed" });
    app.toast("Date changed", () => void repo.undo());
  };
  const onlyThis = async (t: Task, d: GridDrop): Promise<void> => {
    // RPT-102: exclude the occurrence and add a one-off task at the new time
    const occ = d.item.occurrence ?? d.item.start;
    await repo.updateTask(t.id, { exDate: [...new Set([...(t.exDate ?? []), dayKey(occ).replace(/-/g, "")])] });
    const c = await repo.duplicateTask(t.id, false);
    if (c) await repo.updateTask(c.id, { ...spanFields(d.start, d.end, d.allDay), repeatFlag: undefined, repeatFrom: undefined, repeatFirstDate: undefined, exDate: [] });
  };
  const shiftSeries = async (t: Task, d: GridDrop): Promise<void> => {
    const delta = d.start - d.item.start;
    const days = Math.round((startOfDay(d.start) - startOfDay(d.item.start)) / DAY);
    const base = calendarItems([t], { from: 0, to: Infinity, showCompleted: true, showChecklist: false, showFutureTask: true, showRepeat: false, now })[0];
    if (!base) return;
    const s = d.allDay || base.allDay ? addDays(base.start, days) : base.start + delta;
    const len = d.end - d.start;
    await repo.updateTask(t.id, spanFields(s, s + len, d.allDay), { undo: "Date changed" });
  };
  const externalDrop = async (taskId: string, start: number, allDay: boolean): Promise<void> => {
    const dur = Number(settings.defaultTimeDuration) > 0 ? Number(settings.defaultTimeDuration) : 60;
    await repo.updateTask(taskId, spanFields(start, allDay ? addDays(start, 1) : start + dur * 60_000, allDay), { undo: "Date changed" });
    app.toast("Task scheduled", () => void repo.undo());
  };
  const create = (start: number, end: number, allDay: boolean, at: { x: number; y: number }): void => setAdder({ anchor: { left: at.x, top: at.y, bottom: at.y, right: at.x, width: 0, height: 0 }, start, end, allDay });

  const postpone = async (): Promise<void> => {
    const ids = [...selected];
    await repo.updateEach(ids, (t) => {
      const it = calendarItems([t], { from: 0, to: Infinity, showCompleted: true, showChecklist: false, showFutureTask: true, showRepeat: false, now })[0];
      if (!it) return {};
      return it.allDay ? spanFields(addDays(it.start, 1), addDays(it.end, 1), true) : spanFields(it.start + 3600_000, it.end + 3600_000, false);
    }, "Postponed");
    app.toast(`${ids.length} task(s) postponed`, () => void repo.undo());
  };

  const altLabel = (ms: number): string => (alt ? altCalendarLabel(ms, alt) : "");
  const overlay = useCalOverlay(from, to, conf);
  const gridProps = {
    overlay,
    items,
    colorOf,
    selected,
    onOpen: openItem,
    onToggle: (i: CalItem) => void toggleItem(i),
    onDrop: (d: GridDrop) => void applyDrop(d),
    onCreate: create,
    onExternalDrop: (id: string, s: number, a: boolean) => void externalDrop(id, s, a),
    showDetail: conf.showDetail,
    showIcons: !!cfg.showItemIcon,
    classic: cfg.itemStyle === "classic",
    weekNumbers: !!settings.weekNumbersEnabled,
    altLabel,
  };

  return (
    <div className={`cal-screen${local.isTaskCalendarMode ? " split" : ""}`} data-testid="calendar" data-view={sel}>
      {local.calendarStatus && <CalSide anchor={anchor} setAnchor={setAnchor} />}
      <div className="cal-main">
        <div className="view-header cal-header">
          <button className="icon-btn" aria-label="Toggle sidebar" title="Toggle sidebar" data-testid="cal-toggle-side" onClick={() => setLocal("calendarStatus", !local.calendarStatus)}>
            <PanelLeft size={18} />
          </button>
          <h1 className="view-title" data-testid="cal-title">{title}</h1>
          <div className="view-actions">
            <button className="icon-btn bordered" aria-label="Add task" title="Add task" data-testid="cal-add" onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const s = sel === "week" || sel === "day" || sel === "multiDay" ? new Date(new Date(Math.max(anchor, startOfDay(now))).setHours(new Date(now).getHours() + 1, 0, 0, 0)).getTime() : Math.max(anchor, startOfDay(now));
              const allDay = !(sel === "week" || sel === "day" || sel === "multiDay");
              create(allDay ? startOfDay(s) : s, allDay ? addDays(startOfDay(s), 1) : s + 3600_000, allDay, { x: r.left, y: r.bottom });
            }}>
              <Plus size={17} />
            </button>
            <ViewDropdown sel={sel} onPick={pick} />
            <div className="btn-group">
              <button className="btn sm" aria-label="Previous" data-testid="cal-prev" onClick={() => step(-1)}><ChevronLeft size={15} /></button>
              <button className="btn sm" data-testid="cal-today" onClick={today}>Today</button>
              <button className="btn sm" aria-label="Next" data-testid="cal-next" onClick={() => step(1)}><ChevronRight size={15} /></button>
            </div>
            <button className={`icon-btn${local.isTaskCalendarMode ? " on" : ""}`} title="Arrange Tasks" aria-label="Arrange Tasks" data-testid="cal-split" onClick={() => setLocal("isTaskCalendarMode", !local.isTaskCalendarMode)}>
              <Columns2 size={17} />
            </button>
            <CalOptions sel={sel} />
          </div>
        </div>
        {selected.size > 0 && (
          <div className="batch-bar cal-batch" data-testid="cal-batch">
            <span className="strong">{selected.size} selected</span>
            <button className="btn" data-testid="cal-postpone" onClick={() => void postpone().then(() => setSelected(new Set()))}>Postpone</button>
            <button className="btn danger" onClick={() => void repo.trashIds([...selected]).then(() => (setSelected(new Set()), app.toast("Deleted", () => void repo.undo())))}>Delete</button>
            <button className="btn" onClick={() => setSelected(new Set())}>Cancel</button>
          </div>
        )}
        <div className="cal-content">
          {(sel === "day" || sel === "multiDay" || sel === "week") && <TimeGrid key={`${sel}-${days[0]}-${days.length}`} days={days} {...gridProps} />}
          {(sel === "month" || sel === "multiWeek") && <MonthGrid days={days} month={sel === "month" ? new Date(anchor).getMonth() : -1} {...gridProps} hideWeekend={local.calendarHideWeekend} onMore={(day, a) => setDayPop({ anchor: a, day })} />}
          {sel === "year" && <YearGrid year={new Date(anchor).getFullYear()} heat={cfg.heatmap !== false} onDay={(day, a) => setDayPop({ anchor: a, day })} weekStart={ws} ext={ext} />}
          {sel === "agenda" && <Agenda days={days} items={items} colorOf={colorOf} onOpen={openItem} onToggle={(i) => void toggleItem(i)} />}
        </div>
      </div>
      {local.isTaskCalendarMode && <ArrangePanel />}
      {adder && (
        <Popover anchor={adder.anchor} onClose={() => setAdder(null)} testId="cal-adder">
          <AddAt
            label={adder.allDay ? (adder.end - adder.start > DAY * 1.5 ? `${new Date(adder.start).toDateString()} - ${new Date(adder.end - DAY).toDateString()}` : new Date(adder.start).toDateString()) : `${new Date(adder.start).toDateString()}, ${formatTime(adder.start, settings.showMeridiem !== false)} - ${formatTime(adder.end, settings.showMeridiem !== false)}`}
            onAdd={async (title) => {
              await repo.createTask({ title, ...spanFields(adder.start, adder.end, adder.allDay) });
              setAdder(null);
            }}
          />
        </Popover>
      )}
      {dayPop && (
        <Popover anchor={dayPop.anchor} onClose={() => setDayPop(null)} testId="cal-day-pop">
          <div className="cal-day-pop">
            <div className="row between">
              <b>{new Date(dayPop.day).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</b>
              <button className="link-btn" onClick={() => (setDayPop(null), setAnchor(dayPop.day), pick("day"))}>Open day</button>
            </div>
            {calendarItems(pool, { from: dayPop.day, to: addDays(dayPop.day, 1), showCompleted: true, showChecklist: conf.showChecklist, showFutureTask: true, showRepeat: local.showCalendarRepeat, now }, ext).map((i) => (
              <button key={i.key} className={`cal-pop-item${i.completed ? " done" : ""}${i.ext ? " ext" : ""}`} data-testid={i.ext ? "cal-pop-event" : undefined} onClick={(e) => (setDayPop(null), openItem(i, e))}>
                <span className="tl-dot" style={{ background: colorOf(i) }} /> {i.title} {!i.allDay && <span className="muted small">{formatTime(i.start, settings.showMeridiem !== false)}</span>}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {evPop && <ExtEventPopover anchor={evPop.anchor} ev={evPop.ev} onClose={() => setEvPop(null)} />}
    </div>
  );
}

function ViewDropdown({ sel, onPick }: { sel: Sel; onPick: (s: Sel) => void }): JSX.Element {
  const { local } = useApp();
  const [a, setA] = useState<Anchor | null>(null);
  const label = sel === "multiDay" ? `${local.multiCalendarCount} Days` : sel === "multiWeek" ? `${local.multiWeekCount} Weeks` : VIEWS.find((v) => v.sel === sel)!.label;
  return (
    <>
      <button className="btn sm cal-view-btn" data-testid="cal-view" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        {label} <ChevronDown size={13} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="cal-view-menu">
          <Menu onClose={() => setA(null)} items={VIEWS.map((v) => ({ label: v.label, checked: v.sel === sel, testId: `cal-view-${v.sel}`, onClick: () => onPick(v.sel) }))} />
        </Popover>
      )}
    </>
  );
}

/** Calendar display options, the "..." menu (CAL-026..044, RPT-106, HAB-006, FOC-030, CNT-022). */
function CalOptions({ sel }: { sel: Sel }): JSX.Element {
  const app = useApp();
  const { local, setLocal, settings, repo } = app;
  const [conf, setConf] = useViewConf(app);
  const [a, setA] = useState<Anchor | null>(null);
  const cfg = { itemStyle: "modern", checkbox: "detailed", heatmap: true, showItemIcon: false, event: true, note: true, habit: true, focus: true, countdown: true, course: true, ...((app.ext.calendarConfig ?? {}) as Record<string, unknown>) };
  const setCfg = (p: Record<string, unknown>): void => void repo.setExt("calendarConfig", { ...cfg, ...p });
  const color = (v: string): void => {
    setConf({ cellColorType: v });
    void repo.setExt("calendarColorConfig", { ...((app.ext.calendarColorConfig ?? {}) as Record<string, unknown>), colorType: v });
  };
  const [cs, ce] = (settings.collapsedTime as number[] | undefined) ?? [7, 21];
  return (
    <>
      <button className="icon-btn" aria-label="Calendar options" data-testid="cal-options" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <MoreHorizontal size={18} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="cal-options-menu">
          <Menu
            onClose={() => setA(null)}
            items={[
              { label: "Show Completed", checked: conf.showCompleted, testId: "opt-completed", onClick: () => setConf({ showCompleted: !conf.showCompleted }) },
              { label: "Show Checklist", checked: conf.showChecklist, testId: "opt-checklist", onClick: () => setConf({ showChecklist: !conf.showChecklist }) },
              { label: "Show Details", checked: conf.showDetail, testId: "opt-detail", onClick: () => setConf({ showDetail: !conf.showDetail }) },
              { label: "Show Future Tasks", checked: conf.showFutureTask, testId: "opt-future", onClick: () => setConf({ showFutureTask: !conf.showFutureTask }) },
              { label: "Show All Repeat Cycles", checked: local.showCalendarRepeat, testId: "opt-repeat", onClick: () => setLocal("showCalendarRepeat", !local.showCalendarRepeat) },
              { label: "Show Habits", checked: conf.showHabit, testId: "opt-habit", onClick: () => setConf({ showHabit: !conf.showHabit }) },
              { label: "Show Focus Records", checked: conf.showFocusRecord, testId: "opt-focus", onClick: () => setConf({ showFocusRecord: !conf.showFocusRecord }) },
              { label: "Show Countdown", checked: conf.showCountdown, testId: "opt-countdown", onClick: () => setConf({ showCountdown: !conf.showCountdown }) },
              { label: "Show Item Icons", checked: !!cfg.showItemIcon, testId: "opt-icons", onClick: () => setCfg({ showItemIcon: !cfg.showItemIcon }) },
              { label: "Show Week Numbers", checked: !!settings.weekNumbersEnabled, testId: "opt-weeknum", onClick: () => void repo.setSettings({ weekNumbersEnabled: !settings.weekNumbersEnabled }) },
              { label: "Hide Weekends", checked: local.calendarHideWeekend, testId: "opt-weekend", onClick: () => setLocal("calendarHideWeekend", !local.calendarHideWeekend) },
              { divider: true, label: "" },
              { label: "Color by", hint: conf.cellColorType === "tag" ? "Tag" : conf.cellColorType === "priority" ? "Priority" : "List", testId: "opt-color", submenu: () => <Menu onClose={() => setA(null)} items={[["list", "List"], ["tag", "Tag"], ["priority", "Priority"]].map(([v, l]) => ({ label: l!, checked: conf.cellColorType === v, testId: `opt-color-${v}`, onClick: () => color(v!) }))} /> },
              { label: "Style", hint: cfg.itemStyle === "classic" ? "Classic" : "Modern", testId: "opt-style", submenu: () => <Menu onClose={() => setA(null)} items={[["modern", "Modern"], ["classic", "Classic"]].map(([v, l]) => ({ label: l!, checked: cfg.itemStyle === v, testId: `opt-style-${v}`, onClick: () => setCfg({ itemStyle: v }) }))} /> },
              { label: "Heatmap (Year)", checked: cfg.heatmap !== false, testId: "opt-heatmap", onClick: () => setCfg({ heatmap: cfg.heatmap === false }) },
              ...(sel === "multiDay" ? [{ label: "Days", hint: String(local.multiCalendarCount), testId: "opt-days", submenu: () => <Menu onClose={() => setA(null)} items={Array.from({ length: 14 }, (_, i) => i + 1).map((n) => ({ label: `${n} ${n === 1 ? "Day" : "Days"}`, checked: local.multiCalendarCount === n, testId: `opt-days-${n}`, onClick: () => setLocal("multiCalendarCount", n) }))} /> }] : []),
              ...(sel === "multiWeek" ? [{ label: "Weeks", hint: String(local.multiWeekCount), testId: "opt-weeks", submenu: () => <Menu onClose={() => setA(null)} items={Array.from({ length: 6 }, (_, i) => i + 1).map((n) => ({ label: `${n} ${n === 1 ? "Week" : "Weeks"}`, checked: local.multiWeekCount === n, testId: `opt-weeks-${n}`, onClick: () => setLocal("multiWeekCount", n) }))} /> }] : []),
              {
                label: "Collapsed Hours",
                hint: `${cs}:00 - ${ce}:00`,
                testId: "opt-hours",
                submenu: () => (
                  <Menu
                    onClose={() => setA(null)}
                    items={[[0, 24], [6, 22], [7, 21], [8, 20], [9, 18]].map(([s, e]) => ({ label: s === 0 ? "Show all hours" : `${s}:00 - ${e}:00`, checked: cs === s && ce === e, testId: `opt-hours-${s}`, onClick: () => void repo.setSettings({ collapsedTime: [s!, e!] } as never) }))}
                  />
                ),
              },
              { label: "Go to Date", testId: "opt-goto", onClick: () => app.setModal({ kind: "gotoDate" }) },
              { label: "Print", onClick: () => setTimeout(() => window.print(), 50) },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

/** Month and Multi-Week grid (CAL-013, CAL-022) with spanning bars, overflow and drag to re-day or to create a span. */
function MonthGrid(p: { days: number[]; month: number; items: CalItem[]; colorOf: (i: CalItem) => string; selected: Set<string>; onOpen: (i: CalItem, e: React.MouseEvent | React.PointerEvent) => void; onToggle: (i: CalItem) => void; onDrop: (d: GridDrop) => void; onCreate: (s: number, e: number, a: boolean, at: { x: number; y: number }) => void; onExternalDrop: (id: string, s: number, a: boolean) => void; weekNumbers: boolean; altLabel: (ms: number) => string; showIcons: boolean; hideWeekend: boolean; onMore: (day: number, a: Anchor) => void; showDetail: boolean; classic: boolean; overlay?: Overlay }): JSX.Element {
  const { now, settings } = useApp();
  const weeks: number[][] = [];
  for (let i = 0; i < p.days.length; i += 7) weeks.push(p.days.slice(i, i + 7));
  const [drag, setDrag] = useState<{ item?: CalItem; from: number; to: number; x0: number; y0: number; moved: boolean; copy: boolean } | null>(null);
  const dayAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-day]");
    return el ? Number(el.dataset.day) : null;
  };
  // as many bar lanes as the row height allows (one lane is 21px under a 24px day number)
  const bodyRef = useRef<HTMLDivElement>(null);
  const [bodyH, setBodyH] = useState(600);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBodyH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const MAX = Math.max(1, Math.floor((Math.max(74, bodyH / weeks.length) - 62) / 21));
  const show = (d: number): boolean => !p.hideWeekend || (new Date(d).getDay() !== 0 && new Date(d).getDay() !== 6);
  const cols = weeks[0]!.filter(show).length;
  const onUp = (e: React.PointerEvent): void => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const target = dayAt(e.clientX, e.clientY) ?? d.to;
    if (d.item) {
      if (!d.moved) return p.onOpen(d.item, e);
      if (d.item.kind === 3) return;
      const dd = Math.round((startOfDay(target) - startOfDay(d.from)) / DAY);
      if (!dd) return;
      const it = d.item;
      const s = it.allDay ? addDays(it.start, dd) : new Date(new Date(it.start).setDate(new Date(it.start).getDate() + dd)).getTime();
      const en = it.allDay ? addDays(it.end, dd) : s + (it.end - it.start);
      p.onDrop({ item: it, start: s, end: en, allDay: it.allDay, copy: d.copy || e.ctrlKey || e.metaKey });
      return;
    }
    // empty-area press or drag across days: a new (multi-day) task (CAL-013)
    const a = Math.min(d.from, target);
    const b = Math.max(d.from, target);
    p.onCreate(a, addDays(b, 1), true, { x: e.clientX, y: e.clientY });
  };
  return (
    <div
      className="cal-month"
      data-testid="cal-month"
      onPointerMove={(e) => drag && setDrag({ ...drag, to: dayAt(e.clientX, e.clientY) ?? drag.to, moved: drag.moved || Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4 })}
      onPointerUp={onUp}
    >
      <div className="cal-month-head" style={{ gridTemplateColumns: `${p.weekNumbers ? "34px " : ""}repeat(${cols}, 1fr)` }}>
        {p.weekNumbers && <span />}
        {weeks[0]!.filter(show).map((d) => (
          <span key={d}>{WEEKDAYS_SHORT[new Date(d).getDay()]}</span>
        ))}
      </div>
      <div className="cal-month-body" ref={bodyRef} style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((w) => {
          const wd = w.filter(show);
          const rowStart = wd[0]!;
          const rowItems = p.items.filter((i) => i.start < addDays(w[6]!, 1) && i.end > w[0]!);
          // spans are laid out over the visible columns: map each item to the visible day range
          const vis = rowItems.map((i) => {
            const firstVis = wd.find((d) => coversRange(i, d)) ?? null;
            const lastVis = [...wd].reverse().find((d) => coversRange(i, d)) ?? null;
            return firstVis === null ? null : { key: i.key, start: firstVis, end: addDays(lastVis!, 1) };
          }).filter((x): x is { key: string; start: number; end: number } => !!x);
          const idx = new Map(wd.map((d, i) => [startOfDay(d), i]));
          const spans = layoutSpans(vis.map((v) => ({ ...v, start: rowStart + (idx.get(startOfDay(v.start))! * DAY), end: rowStart + ((idx.get(startOfDay(addDays(v.end, -1)))! + 1) * DAY) })), rowStart, wd.length);
          return (
            <div key={w[0]} className="cal-week-row" style={{ gridTemplateColumns: `${p.weekNumbers ? "34px " : ""}repeat(${cols}, 1fr)` }}>
              {p.weekNumbers && <span className="cal-weeknum" data-testid="cal-weeknum">W{isoWeek(w[0]!)}</span>}
              {wd.map((d, ci) => {
                const hidden = spans.filter((s) => s.lane >= MAX && s.startCol <= ci && s.endCol >= ci).length;
                const inDrag = drag && !drag.item && d >= Math.min(drag.from, drag.to) && d <= Math.max(drag.from, drag.to);
                return (
                  <div
                    key={d}
                    className={`cal-cell${p.month >= 0 && new Date(d).getMonth() !== p.month ? " other" : ""}${startOfDay(now) === d ? " today" : ""}${inDrag || (drag?.item && drag.moved && drag.to === d) ? " drop" : ""}`}
                    data-day={d}
                    data-testid="cal-cell"
                    data-date={dayKey(d)}
                    style={{ gridColumn: ci + (p.weekNumbers ? 2 : 1), gridRow: 1 }}
                    onPointerDown={(e) => e.button === 0 && e.target === e.currentTarget && setDrag({ from: d, to: d, x0: e.clientX, y0: e.clientY, moved: false, copy: false })}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      const id = e.dataTransfer.getData("text/x-task");
                      if (id) p.onExternalDrop(id, d, true);
                    }}
                  >
                    <span className="cal-cell-num">{new Date(d).getDate() === 1 ? `${MONTHS_SHORT[new Date(d).getMonth()]} 1` : new Date(d).getDate()}</span>
                    <span className="cal-alt">{p.altLabel(d)}</span>
                    {p.overlay && <DayMarks marks={p.overlay.marks(d)} max={2} />}
                    {hidden > 0 && (
                      <button className="cal-more" data-testid="cal-more" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => p.onMore(d, anchorOf(e.currentTarget))}>
                        +{hidden} more
                      </button>
                    )}
                  </div>
                );
              })}
              {spans
                .filter((s) => s.lane < MAX)
                .map((s) => {
                  const i = rowItems.find((x) => x.key === s.key)!;
                  const c = p.colorOf(i);
                  const timedOne = !i.allDay && i.end - i.start < DAY;
                  return (
                    <div
                      key={s.key}
                      className={`cal-chip${timedOne ? " timed" : " span"}${i.completed ? " done" : ""}${p.selected.has(i.taskId) ? " selected" : ""}${s.clipStart ? " clip-start" : ""}${s.clipEnd ? " clip-end" : ""}${drag?.item?.key === i.key && drag.moved ? " dragging" : ""}`}
                      style={{ gridColumn: `${s.startCol + (p.weekNumbers ? 2 : 1)} / ${s.endCol + (p.weekNumbers ? 3 : 2)}`, gridRow: 1, marginTop: 24 + s.lane * 21, background: timedOne ? undefined : p.classic ? c : `color-mix(in srgb, ${c} 24%, var(--surface))`, borderLeftColor: c, ...(p.classic && !timedOne ? { color: inkOn(c) } : {}) }}
                      data-testid="cal-chip"
                      data-title={i.title}
                      data-source={i.ext?.source.key}
                      data-color={i.ext ? c : undefined}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.stopPropagation();
                        const day = dayAt(e.clientX, e.clientY) ?? i.start;
                        setDrag({ item: i, from: day, to: day, x0: e.clientX, y0: e.clientY, moved: false, copy: e.ctrlKey || e.metaKey });
                      }}
                    >
                      {timedOne && <span className="tl-dot" style={{ background: c }} />}
                      {timedOne && <span className="muted">{formatTime(i.start, settings.showMeridiem !== false)}</span>}
                      <span className="cal-chip-title">{i.title}</span>
                      {p.showIcons && <ItemIcons i={i} />}
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
const coversRange = (i: CalItem, d: number): boolean => i.start < addDays(d, 1) && i.end > d;

/** Year view (CAL-017, CAL-018): twelve months, days shaded by completions when Heatmap is on, a dot for scheduled days. */
function YearGrid({ year, heat, onDay, weekStart, ext }: { year: number; heat: boolean; onDay: (d: number, a: Anchor) => void; weekStart: number; ext: ExtEvent[] }): JSX.Element {
  const { tasks, now } = useApp();
  const done = useMemo(() => completionsByDay(tasks), [tasks]);
  const evDays = useMemo(() => eventDays(ext, new Date(year, 0, 1).getTime(), new Date(year + 1, 0, 1).getTime()), [ext, year]);
  const scheduled = useMemo(() => {
    const s = new Set<number>();
    for (const t of tasks) {
      if (t.deleted || t.status !== 0 || !(t.startDate || t.dueDate)) continue;
      const it = calendarItems([t], { from: new Date(year, 0, 1).getTime(), to: new Date(year + 1, 0, 1).getTime(), showCompleted: false, showChecklist: false, showFutureTask: true, showRepeat: false, now })[0];
      if (it) for (let d = startOfDay(it.start); d < it.end; d = addDays(d, 1)) s.add(d);
    }
    return s;
  }, [tasks, year, now]);
  return (
    <div className="cal-year" data-testid="cal-year">
      {Array.from({ length: 12 }, (_, m) => {
        const days = monthGridDays(new Date(year, m, 1).getTime(), weekStart);
        return (
          <div key={m} className="cal-ym">
            <div className="cal-ym-title">{MONTHS_LONG[m]}</div>
            <div className="cal-ym-grid">
              {days.slice(0, 7).map((d) => (
                <span key={`h${d}`} className="cal-ym-wd">{WEEKDAYS_SHORT[new Date(d).getDay()]![0]}</span>
              ))}
              {days.map((d) => {
                const inMonth = new Date(d).getMonth() === m;
                const lvl = heat && inMonth ? heatLevel(done.get(d) ?? 0) : 0;
                const ev = inMonth ? evDays.get(d) : undefined;
                return (
                  <button
                    key={d}
                    className={`cal-ym-day${inMonth ? "" : " other"}${startOfDay(now) === d ? " today" : ""} heat-${lvl}${inMonth && scheduled.has(d) ? " has" : ""}`}
                    data-testid={inMonth ? "cal-year-day" : undefined}
                    data-date={dayKey(d)}
                    data-heat={lvl}
                    data-event={ev ? "1" : undefined}
                    onClick={(e) => inMonth && onDay(d, anchorOf(e.currentTarget))}
                  >
                    {new Date(d).getDate()}
                    {ev && <i className="cal-ev-dot" style={{ background: ev }} />}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Agenda (CAL-019, CAL-020): days with items from two weeks back to two months ahead, today scrolled into view. */
function Agenda({ days, items, colorOf, onOpen, onToggle }: { days: number[]; items: CalItem[]; colorOf: (i: CalItem) => string; onOpen: (i: CalItem, e: React.MouseEvent) => void; onToggle: (i: CalItem) => void }): JSX.Element {
  const { now, settings } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector("[data-testid=agenda-today]")?.scrollIntoView({ block: "start" });
  }, []);
  const today = startOfDay(now);
  return (
    <div className="cal-agenda" ref={ref} data-testid="cal-agenda">
      {days.map((d) => {
        const mine = items.filter((i) => i.start < addDays(d, 1) && i.end > d).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start - b.start);
        if (!mine.length && d !== today) return null;
        return (
          <section key={d} className="cal-agenda-day" data-testid={d === today ? "agenda-today" : "agenda-day"}>
            <h3 className={d === today ? "today" : ""}>
              {d === today ? "Today" : WEEKDAYS_LONG[new Date(d).getDay()]}, {MONTHS_SHORT[new Date(d).getMonth()]} {new Date(d).getDate()}
            </h3>
            {mine.length === 0 && <div className="muted small">Nothing scheduled</div>}
            {mine.map((i) => (
              <div key={i.key} className={`cal-agenda-item${i.completed ? " done" : ""}${i.ext ? " ext" : ""}`} onClick={(e) => onOpen(i, e)} data-testid="agenda-item" data-title={i.title} data-source={i.ext?.source.key}>
                {i.ext ? <span className="cal-check-spacer" aria-hidden /> : <button className={`cal-check${i.completed ? " on" : ""}`} aria-label="Complete" onClick={(e) => (e.stopPropagation(), onToggle(i))} />}
                <span className="tl-dot" style={{ background: colorOf(i) }} />
                <span className="grow">{i.title}{i.ext && <span className="muted small cal-src-name"> · {i.ext.source.name}</span>}</span>
                <span className="muted small">{i.allDay ? "All day" : `${formatTime(i.start, settings.showMeridiem !== false)} - ${formatTime(i.end, settings.showMeridiem !== false)}`}</span>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** Calendar side panel: month navigator and list filter (webCalendarViewFilter). */
function CalSide({ anchor, setAnchor }: { anchor: number; setAnchor: (d: number) => void }): JSX.Element {
  const app = useApp();
  const { projects, inboxId, settings, repo } = app;
  const filter = ((settings as Record<string, unknown>).webCalendarViewFilter ?? {}) as { hiddenProjects?: string[] };
  const hidden = new Set(filter.hiddenProjects ?? []);
  const lists = [{ id: inboxId, name: "Inbox", color: settings.inboxColor }, ...projects.filter((p) => !p.closed).sort((a, b) => a.sortOrder - b.sortOrder)];
  return (
    <aside className="cal-side" data-testid="cal-side">
      <MiniMonth value={anchor} onPick={setAnchor} />
      <div className="side-section-head"><span className="side-section-toggle">Lists</span></div>
      {lists.map((l) => (
        <label key={l.id} className="cal-filter-row">
          <input
            type="checkbox"
            checked={!hidden.has(l.id)}
            onChange={() => {
              const n = new Set(hidden);
              if (n.has(l.id)) n.delete(l.id);
              else n.add(l.id);
              void repo.setSettings({ webCalendarViewFilter: { ...filter, hiddenProjects: [...n] } } as never);
            }}
          />
          <span className="tl-dot" style={{ background: l.color || "var(--text-3)" }} />
          {l.name}
        </label>
      ))}
      <CalSources />
    </aside>
  );
}

/** Subscribed calendars in the calendar side panel: show / hide per calendar, colour dot, link to settings (CAL-064). */
function CalSources(): JSX.Element | null {
  const app = useApp();
  const { sources } = useCalSources(app.engine.api);
  if (!sources.length) return null;
  return (
    <div data-testid="cal-side-sources">
      <div className="side-section-head">
        <span className="side-section-toggle">Subscribed Calendars</span>
        <button className="link-btn small" onClick={() => go(app.route.path, { modalType: "settings", tabs: "calendar" })}>Manage</button>
      </div>
      {sources.map((s) => (
        <label key={s.key} className="cal-filter-row" data-testid="cal-side-source" data-source={s.key}>
          <input type="checkbox" checked={s.show} onChange={() => void setShown(app.engine.api, s, !s.show)} aria-label={`Show ${s.name}`} />
          <span className="tl-dot" style={{ background: s.color }} />
          <span className="grow ellipsis">{s.name}</span>
        </label>
      ))}
    </div>
  );
}

/** Small month navigator used in the calendar side panel and the sidebar mini calendar (CAL-046). */
export function MiniMonth({ value, onPick, testId = "mini-month" }: { value: number; onPick: (d: number) => void; testId?: string }): JSX.Element {
  const app = useApp();
  const { settings, now } = app;
  const [month, setMonth] = useState(() => new Date(new Date(value).getFullYear(), new Date(value).getMonth(), 1).getTime());
  const ws = weekStartIndex(settings.startDayOfWeek);
  const days = monthGridDays(month, ws);
  // a dot under days with subscribed or account events (CAL-046 with external calendars)
  const ext = useExtEvents(app.engine.api, days[0]!, addDays(days[days.length - 1]!, 1), { holidayEnabled: settings.holidayEnabled !== false });
  const evDays = useMemo(() => eventDays(ext, days[0]!, addDays(days[days.length - 1]!, 1)), [ext]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mini-month" data-testid={testId}>
      <div className="row between mini-head">
        <b>{MONTHS_SHORT[new Date(month).getMonth()]} {new Date(month).getFullYear()}</b>
        <span>
          <button className="icon-btn xs" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={13} /></button>
          <button className="icon-btn xs" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={13} /></button>
        </span>
      </div>
      <div className="mini-grid">
        {days.slice(0, 7).map((d) => (
          <span key={`h${d}`} className="mini-wd">{WEEKDAYS_SHORT[new Date(d).getDay()]!.slice(0, 2)}</span>
        ))}
        {days.map((d) => (
          <button key={d} className={`mini-day${new Date(d).getMonth() !== new Date(month).getMonth() ? " other" : ""}${startOfDay(now) === d ? " today" : ""}${startOfDay(value) === d ? " on" : ""}`} data-date={dayKey(d)} data-event={evDays.has(d) ? "1" : undefined} onClick={() => onPick(d)}>
            {new Date(d).getDate()}
            {evDays.has(d) && <i className="mini-ev-dot" style={{ background: evDays.get(d) }} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Split view / Arrange Tasks (CAL-057, VIEW-031): unscheduled tasks (or a list) beside the calendar, drag onto a slot. */
function ArrangePanel(): JSX.Element {
  const app = useApp();
  const { tasks, projects, inboxId, local, setLocal } = app;
  const pid = local.calendarTaskListCurrentProjectId;
  const allowed = inAllSet(projects, inboxId);
  const rows = tasks.filter((t) => !t.deleted && t.status === 0 && (pid ? t.projectId === pid : allowed.has(t.projectId) && !t.startDate && !t.dueDate));
  return (
    <aside className="cal-arrange" data-testid="cal-arrange">
      <div className="cal-arrange-head">
        <select className="field" value={pid} onChange={(e) => setLocal("calendarTaskListCurrentProjectId", e.target.value)} data-testid="arrange-list">
          <option value="">Unscheduled</option>
          <option value={inboxId}>Inbox</option>
          {projects.filter((p) => !p.closed).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {rows.length === 0 && <div className="empty-note">Nothing to arrange</div>}
      {rows.map((t) => (
        <div key={t.id} className="tl-drawer-item" draggable onDragStart={(e) => e.dataTransfer.setData("text/x-task", t.id)} data-testid="arrange-item" data-title={t.title} onClick={() => (location.hash = calendarPath(app.route.calType ?? "m", t.id))}>
          {t.title || "No title"}
        </div>
      ))}
    </aside>
  );
}

export function GotoDateDialog(): JSX.Element {
  const app = useApp();
  const [v, setV] = useState(dayKey(app.now));
  return (
    <Modal onClose={() => app.setModal(null)} testId="goto-date">
      <h3>Go to Date</h3>
      <input className="field full" type="date" value={v} onChange={(e) => setV(e.target.value)} autoFocus data-testid="goto-input" />
      <div className="row end">
        <button className="btn" onClick={() => app.setModal(null)}>Cancel</button>
        <button
          className="btn primary"
          onClick={() => {
            const [y, m, d] = v.split("-").map(Number);
            window.dispatchEvent(new CustomEvent("noor-cal-goto", { detail: new Date(y!, m! - 1, d!).getTime() }));
            app.setModal(null);
          }}
        >
          Go
        </button>
      </div>
    </Modal>
  );
}

