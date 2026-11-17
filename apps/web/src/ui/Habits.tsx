import { Archive, ArchiveRestore, ChevronLeft, ChevronRight, LayoutGrid, List as ListIcon, MoreHorizontal, Pencil, Plus, Settings2, Timer, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { newHabit } from "../data/m4repo";
import type { Checkin, Habit, HabitRecord } from "../data/m4types";
import { CheckinStatus, HabitMood, HabitStatus, HabitType, newId } from "../lib/core";
import { weekStartIndex } from "../lib/dates";
import { addStampDays, makeStamp, parseStamp, todayStamp } from "../lib/m4core";
import { dueToday, GALLERY, ICON_KEYS, WEEKDAY_SHORT, anchorOf as habitAnchorOf, cadenceLabel, cadenceOf, dayState, habitStats, isDone, isReal, monthGrid, monthLabel, ruleOf, shiftMonth, sortHabits, stampLabel, weeklyReview, type Cadence, type Preset } from "../model/habits";
import { go, habitPath } from "../model/router";
import { useApp } from "./ctx";
import { CheckButton, HabitIcon, IconGlyph, useCheck } from "./habitParts";
import { habitOn, pomoOn, useM4 } from "./m4ctx";
import { ColorSwatches, Menu, MenuButton, Modal, Popover, Select, Switch, anchorOf, type Anchor } from "./primitives";
import { inkOn } from "./theme";

export const MOODS: Array<{ value: number; label: string; face: string }> = [
  { value: HabitMood.Smiley, label: "Great", face: "M7 13c1.5 2.5 8.5 2.5 10 0" },
  { value: HabitMood.Smile, label: "Good", face: "M8 14c1.5 1.4 6.5 1.4 8 0" },
  { value: HabitMood.General, label: "Okay", face: "M8 14.5h8" },
  { value: HabitMood.Sad, label: "Low", face: "M8 16c1.5-1.4 6.5-1.4 8 0" },
  { value: HabitMood.Cry, label: "Bad", face: "M7 17c1.5-2.5 8.5-2.5 10 0" },
];
export function MoodFace({ value, size = 22 }: { value: number; size?: number }): JSX.Element {
  const m = MOODS.find((x) => x.value === value) ?? MOODS[2]!;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={m.label} className={`mood mood-${m.value}`}>
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="9.5" r="1.1" fill="currentColor" />
      <circle cx="15.5" cy="9.5" r="1.1" fill="currentColor" />
      <path d={m.face} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function useHabitEnv() {
  const app = useApp();
  const m = useM4();
  const today = todayStamp(app.now, m.tz);
  const ws = weekStartIndex(app.settings.startDayOfWeek);
  const anchor = (h: Habit): number => habitAnchorOf(h, m.tz, app.now);
  return { app, m, today, ws, anchor };
}

// ------------------------------------------------------------------ screen

export function HabitScreen(): JSX.Element {
  const { app, m, today, ws, anchor } = useHabitEnv();
  const { route, ext, repo } = app;
  const [archived, setArchived] = useState(false);
  const [dialog, setDialog] = useState<{ habit?: Habit } | null>(null);
  const [sections, setSections] = useState(false);
  const style = ((ext.habitConf ?? {}) as { style?: string }).style === "card" ? "card" : "list";
  const byStatus = m.habitPrefs.sortType === "status";
  const selected = m.habits.find((h) => h.id === route.itemId);
  const list = m.habits.filter((h) => (archived ? h.status === HabitStatus.Archived : h.status !== HabitStatus.Archived));
  const doneToday = (h: Habit): boolean => m.checkins.some((c) => c.habitId === h.id && c.checkinStamp === today && isDone(c));
  const groups = useMemo(() => {
    const secs = [...m.sections].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const out: Array<{ id: string; name: string; habits: Habit[] }> = [];
    for (const s of secs) out.push({ id: s.id, name: sectionLabel(s.name), habits: sortHabits(list.filter((h) => h.sectionId === s.id), byStatus, doneToday) });
    const rest = list.filter((h) => !secs.some((s) => s.id === h.sectionId));
    out.push({ id: "-1", name: secs.length ? "Others" : "", habits: sortHabits(rest, byStatus, doneToday) });
    return out.filter((g) => g.habits.length > 0);
  }, [m.sections, list, byStatus, m.checkins, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const setStyle = (s: "list" | "card"): void => void repo.setExt("habitConf", { ...((ext.habitConf ?? {}) as object), style: s });
  return (
    <div className={`m4-screen habit-screen${selected ? " has-item" : ""}`} data-testid="habit-screen">
      <section className={`m4-list${style === "card" ? " wide" : ""}`}>
        <div className="m4-head">
          <h1 className="view-title" data-testid="habit-title">{archived ? "Archived Habits" : "Habit"}</h1>
          <div className="seg icons small" role="tablist" aria-label="Layout">
            <button className={style === "list" ? "on" : ""} aria-label="List layout" title="List" data-testid="habit-style-list" onClick={() => setStyle("list")}><ListIcon size={15} /></button>
            <button className={style === "card" ? "on" : ""} aria-label="Card layout" title="Card" data-testid="habit-style-card" onClick={() => setStyle("card")}><LayoutGrid size={15} /></button>
          </div>
          <button className="icon-btn" aria-label="New habit" title="New habit" data-testid="habit-add" onClick={() => setDialog({})}><Plus size={18} /></button>
          <MenuButton
            title="More"
            testId="habit-more"
            placement="bottom-end"
            items={() => [
              { label: archived ? "Active Habits" : "Archived Habits", icon: <Archive size={15} />, onClick: () => setArchived(!archived), testId: "habit-show-archived" },
              { label: "Sort by Check-in Status", checked: byStatus, onClick: () => void m.m4.setHabitPrefs({ sortType: byStatus ? "" : "status" }) },
              { label: "Manage Sections", onClick: () => setSections(true), testId: "habit-manage-sections" },
              { label: "Export (CSV)", onClick: () => exportHabitsCsv(m.habits, m.checkins, m.records) },
              { label: "Habit Settings", icon: <Settings2 size={15} />, onClick: () => go(route.path, { modalType: "settings", tabs: "habit" }) },
            ]}
          >
            <MoreHorizontal size={18} />
          </MenuButton>
        </div>
        <div className="m4-scroll">
          {list.length === 0 && (
            <div className="m4-empty" data-testid="habit-empty">
              <span className="empty-title">{archived ? "No archived habits" : "Build a habit, one day at a time"}</span>
              {!archived && <button className="btn primary" onClick={() => setDialog({})}>New Habit</button>}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.id} className="habit-group" data-testid="habit-group" data-name={g.name}>
              {g.name && <div className="m4-section-head">{g.name}<span className="grow" /><span>{g.habits.length}</span></div>}
              <div className={style === "card" ? "habit-cards" : "habit-rows"}>
                {g.habits.map((h) =>
                  style === "card" ? <HabitCard key={h.id} h={h} on={h.id === selected?.id} /> : <HabitRow key={h.id} h={h} on={h.id === selected?.id} today={today} ws={ws} anchor={anchor(h)} />,
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="m4-detail">{selected ? <HabitDetail key={selected.id} h={selected} onEdit={() => setDialog({ habit: selected })} /> : <div className="m4-detail-empty"><div className="m4-empty"><span className="empty-title">Select a habit</span><span className="small">Its monthly calendar, streaks and log show here.</span></div></div>}</section>
      {dialog && <HabitDialog habit={dialog.habit} onClose={() => setDialog(null)} />}
      {sections && <SectionsDialog onClose={() => setSections(false)} />}
    </div>
  );
}

export const sectionLabel = (n: string): string => (n === "_morning" ? "Morning" : n === "_afternoon" ? "Afternoon" : n === "_night" ? "Night" : n);

function streakText(h: Habit, s: { currentStreak: number; totalCheckIns: number }, total: boolean): string {
  void h;
  return total ? `${s.totalCheckIns} day${s.totalCheckIns === 1 ? "" : "s"} total` : `${s.currentStreak} day${s.currentStreak === 1 ? "" : "s"} streak`;
}

function HabitRow({ h, on, today, ws, anchor }: { h: Habit; on: boolean; today: number; ws: number; anchor: number }): JSX.Element {
  const { m, app } = useHabitEnv();
  const stats = habitStats(h, m.checkins, today, anchor, ws);
  const totalMode = !!(app.settings as { habitDisplayType?: boolean }).habitDisplayType;
  const days = Array.from({ length: 7 }, (_, i) => addStampDays(today, i - 6));
  const c = m.checkins.find((x) => x.habitId === h.id && x.checkinStamp === today);
  return (
    <div className={`habit-row${on ? " on" : ""}`} data-testid="habit-row" data-name={h.name} onClick={() => go(habitPath(h.id))}>
      <HabitIcon habit={h} />
      <div className="habit-row-main">
        <div className="habit-name">{h.name}</div>
        <div className="habit-sub">
          <span>{streakText(h, stats, totalMode)}</span>
          {isReal(h) && <span>{c?.value ?? 0}/{h.goal}</span>}
        </div>
      </div>
      <div className="habit-week" aria-hidden>
        {days.map((d) => {
          const st = dayState(h, m.checkins.find((x) => x.habitId === h.id && x.checkinStamp === d), d, today, anchor);
          return <span key={d} className={`wk-dot ${st}`} style={st === "done" ? { background: h.color || "var(--accent)" } : undefined} title={stampLabel(d)} />;
        })}
      </div>
      {h.status !== HabitStatus.Archived && <CheckButton habit={h} />}
    </div>
  );
}

/** Card layout (HAB-029): tap the icon to check in. */
function HabitCard({ h, on }: { h: Habit; on: boolean }): JSX.Element {
  const { m, today, ws, anchor } = useHabitEnv();
  const check = useCheck();
  const c = m.checkins.find((x) => x.habitId === h.id && x.checkinStamp === today);
  const stats = habitStats(h, m.checkins, today, anchor(h), ws);
  const done = isDone(c);
  return (
    <div className={`habit-card${on ? " on" : ""}${done ? " done" : ""}`} data-testid="habit-card" data-name={h.name} onClick={() => go(habitPath(h.id))}>
      <HabitIcon habit={h} size="lg" testId="habit-card-icon" onClick={(e) => (e.stopPropagation(), void check.tap(h, today))} />
      <div className="habit-name">{h.name}</div>
      <div className="habit-sub">{isReal(h) ? `${c?.value ?? 0}/${h.goal} ${h.unit}` : done ? "Done today" : `${stats.currentStreak} day streak`}</div>
    </div>
  );
}

// ------------------------------------------------------------------ detail

function HabitDetail({ h, onEdit }: { h: Habit; onEdit: () => void }): JSX.Element {
  const { app, m, today, ws, anchor } = useHabitEnv();
  const [month, setMonth] = useState(Math.floor(today / 100));
  const [dayMenu, setDayMenu] = useState<{ stamp: number; anchor: Anchor } | null>(null);
  const [edit, setEdit] = useState<number | null>(null);
  const a = anchor(h);
  const stats = habitStats(h, m.checkins, today, a, ws, month);
  const totalMode = !!(app.settings as { habitDisplayType?: boolean }).habitDisplayType;
  const check = useCheck();
  const mine = m.checkins.filter((c) => c.habitId === h.id);
  const logs = m.records.filter((r) => r.habitId === h.id).sort((x, y) => (y.checkinStamp ?? y.stamp ?? 0) - (x.checkinStamp ?? x.stamp ?? 0));
  const review = weeklyReview(h, m.checkins, today, a, ws);
  const archivedNow = h.status === HabitStatus.Archived;
  // HAB-024: tapping the streak card flips Current Streak / Total Days; synced setting plus the local key
  const flip = (): void => {
    localStorage.setItem("habitDetailStreakViewType", JSON.stringify(totalMode ? "streak" : "total"));
    void app.repo.setSettings({ habitDisplayType: !totalMode } as never);
  };
  const tapDay = (stamp: number, e: React.MouseEvent): void => {
    if (stamp > addStampDays(today, 0)) return;
    if (isReal(h)) setEdit(stamp);
    else void check.tap(h, stamp);
    void e;
  };
  return (
    <div className="habit-detail" data-testid="habit-detail">
      <div className="m4-head">
        <button className="icon-btn m4-back" aria-label="Back" onClick={() => go(habitPath())}><ChevronLeft size={18} /></button>
        <HabitIcon habit={h} size="sm" />
        <h2 className="view-title habit-detail-title" data-testid="habit-detail-name">{h.name}</h2>
        {pomoOn(app) && (
          <button className="icon-btn" title="Start focus" aria-label="Start focus" onClick={() => go("focus", { habit: h.id })}>
            <Timer size={17} />
          </button>
        )}
        <button className="icon-btn" title="Edit" aria-label="Edit habit" data-testid="habit-edit" onClick={onEdit}><Pencil size={16} /></button>
        <MenuButton
          title="Habit actions"
          testId="habit-detail-more"
          placement="bottom-end"
          items={() => [
            archivedNow
              ? { label: "Restore", icon: <ArchiveRestore size={15} />, onClick: () => void m.m4.archiveHabit(h.id, false), testId: "habit-unarchive" }
              : { label: "Archive", icon: <Archive size={15} />, onClick: () => void m.m4.archiveHabit(h.id, true), testId: "habit-archive" },
            {
              label: "Delete",
              icon: <Trash2 size={15} />,
              danger: true,
              testId: "habit-delete",
              onClick: () =>
                app.setModal({ kind: "confirm", title: "Delete habit", body: "The habit and all its check-ins and logs are deleted for good. Archive keeps the history.", ok: "Delete", danger: true, onOk: () => void m.m4.deleteHabit(h.id).then(() => go(habitPath())) }),
            },
          ]}
        >
          <MoreHorizontal size={18} />
        </MenuButton>
      </div>
      {h.encouragement && <p className="habit-quote">{h.encouragement}</p>}
      <div className="m4-kpis habit-kpis">
        <div className="m4-kpi"><div className="k-label">Monthly check-ins</div><div className="k-value" data-testid="habit-month-count">{stats.monthCheckIns}<span className="k-unit">days</span></div></div>
        <div className="m4-kpi"><div className="k-label">Total check-ins</div><div className="k-value" data-testid="habit-total">{stats.totalCheckIns}<span className="k-unit">days</span></div></div>
        <div className="m4-kpi"><div className="k-label">Monthly rate</div><div className="k-value">{stats.monthRate === null ? "-" : `${Math.round(stats.monthRate * 100)}`}<span className="k-unit">{stats.monthRate === null ? "" : "%"}</span></div></div>
        <button className="m4-kpi streak-kpi" onClick={flip} data-testid="habit-streak" title="Switch between current streak and total days">
          <div className="k-label" data-testid="habit-streak-label">{totalMode ? "Total Days" : "Current Streak"}</div>
          <div className="k-value">{totalMode ? stats.totalCheckIns : stats.currentStreak}<span className="k-unit">days</span></div>
        </button>
      </div>

      <div className="m4-card habit-month">
        <div className="m4-card-title">
          <span data-testid="habit-month-label">{monthLabel(month)}</span>
          <span className="grow" />
          <button className="icon-btn sm" aria-label="Previous month" data-testid="habit-month-prev" onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={16} /></button>
          <button className="btn sm" onClick={() => setMonth(Math.floor(today / 100))}>Today</button>
          <button className="icon-btn sm" aria-label="Next month" data-testid="habit-month-next" onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={16} /></button>
        </div>
        <div className="hm-grid">
          {Array.from({ length: 7 }, (_, i) => <span key={i} className="hm-wd">{WEEKDAY_SHORT[(i + ws) % 7]}</span>)}
          {monthGrid(month, ws).flat().map((d, i) => {
            if (!d) return <span key={`p${i}`} />;
            const c = mine.find((x) => x.checkinStamp === d);
            const st = dayState(h, c, d, today, a);
            const real = isReal(h);
            const frac = real && c ? Math.min(1, (c.value ?? 0) / Math.max(1, h.goal ?? 1)) : 0;
            return (
              <button
                key={d}
                className={`hm-day ${st}${d === today ? " today" : ""}`}
                style={{ "--hc": h.color || "var(--accent)", "--ink": inkOn(h.color), "--frac": frac } as React.CSSProperties}
                disabled={d > today || archivedNow}
                data-testid="habit-day"
                data-stamp={d}
                data-state={st}
                title={`${stampLabel(d)}${c && real ? `: ${c.value ?? 0}/${h.goal} ${h.unit}` : ""}`}
                onClick={(e) => tapDay(d, e)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (d <= today) setDayMenu({ stamp: d, anchor: anchorOf(e.currentTarget) });
                }}
              >
                <span>{parseStamp(d).d}</span>
              </button>
            );
          })}
        </div>
        <div className="hm-legend small muted">Click a day to check in or undo. Right-click or long-press a day to edit it, skip it or write a log.</div>
      </div>

      <div className="m4-cards habit-lower">
        <div className="m4-card">
          <div className="m4-card-title">Weekly review</div>
          <WeekBars data={review} color={h.color || "var(--accent)"} />
        </div>
        <div className="m4-card">
          <div className="m4-card-title">Details</div>
          <dl className="habit-facts">
            <dt>Frequency</dt><dd>{cadenceLabel(h.repeatRule)}</dd>
            <dt>Goal</dt><dd>{isReal(h) ? `${h.goal} ${h.unit} a day, ${h.step || 1} per tap` : "Check in once"}</dd>
            <dt>Best streak</dt><dd>{stats.maxStreak} days</dd>
            {h.targetDays ? <><dt>Goal days</dt><dd>{Math.min(stats.totalCheckIns, h.targetDays)} of {h.targetDays}</dd></> : null}
            {h.targetStartDate ? <><dt>Started</dt><dd>{stampLabel(h.targetStartDate)}</dd></> : null}
            {(h.reminders ?? []).length > 0 && <><dt>Reminders</dt><dd>{(h.reminders ?? []).join(", ")}</dd></>}
          </dl>
        </div>
      </div>

      <div className="m4-card habit-logs">
        <div className="m4-card-title">Habit log<span className="grow" /><button className="btn sm" data-testid="habit-add-log" onClick={() => window.dispatchEvent(new CustomEvent("noor-habit-log", { detail: { habitId: h.id, stamp: today, force: true } }))}>Add log</button></div>
        {logs.length === 0 && <div className="empty-note">No logs yet. A log keeps a note and a mood for a day.</div>}
        {logs.map((r) => (
          <div key={r.id} className="habit-log" data-testid="habit-log">
            {typeof r.emoji === "number" && <MoodFace value={r.emoji} size={20} />}
            <div className="grow">
              <div className="small muted">{stampLabel(r.checkinStamp ?? r.stamp ?? today)}</div>
              <div className="habit-log-text">{r.content}</div>
            </div>
            <button className="icon-btn sm" aria-label="Delete log" data-testid="habit-log-delete" onClick={() => void m.m4.deleteRecord(r.id)}><X size={14} /></button>
          </div>
        ))}
      </div>

      {dayMenu && (
        <Popover anchor={dayMenu.anchor} onClose={() => setDayMenu(null)} testId="habit-day-menu">
          <Menu
            onClose={() => setDayMenu(null)}
            items={[
              { label: "Edit check-in", onClick: () => setEdit(dayMenu.stamp), testId: "habit-day-edit" },
              { label: "Achieve it all", onClick: () => void check.achieve(h, dayMenu.stamp) },
              { label: (h.exDates ?? []).includes(String(dayMenu.stamp)) ? "Unskip this day" : "Skip this day", onClick: () => void m.m4.toggleSkip(h.id, dayMenu.stamp), testId: "habit-day-skip" },
              { label: "Clear", onClick: () => void check.clear(h, dayMenu.stamp), testId: "habit-day-clear" },
            ]}
          />
        </Popover>
      )}
      {edit !== null && <CheckinEditor h={h} stamp={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function WeekBars({ data, color }: { data: Array<{ week: number; done: number; due: number }>; color: string }): JSX.Element {
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const W = 320;
  const H = 120;
  const bw = W / data.length;
  return (
    <div className="week-bars">
      <svg className="chart" viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Completion per week">
        {[0, 0.5, 1].map((g) => <line key={g} className="grid" x1="0" x2={W} y1={H - g * H} y2={H - g * H} />)}
        {data.map((d, i) => {
          const rate = d.due ? d.done / d.due : 0;
          const h = Math.max(rate > 0 ? 3 : 0, rate * (H - 6));
          const { m, d: dd } = parseStamp(d.week);
          return (
            <g key={d.week}>
              <rect x={i * bw + bw * 0.25} y={H - h} width={bw * 0.5} height={h} rx="4" fill={color} />
              <text className="axis-label" x={i * bw + bw / 2} y={H + 14} textAnchor="middle">{`${m}/${dd}`}</text>
              <rect className="hit" x={i * bw} y={0} width={bw} height={H} onMouseMove={(e) => setTip({ x: e.clientX + 12, y: e.clientY + 12, text: `Week of ${stampLabel(d.week)}: ${d.done} of ${d.due} days` })} onMouseLeave={() => setTip(null)} />
            </g>
          );
        })}
      </svg>
      {tip && <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>{tip.text}</div>}
    </div>
  );
}

/** Edit a day after the fact (HAB-025): value, status, note and mood. Any past day, no 90 day cap. */
function CheckinEditor({ h, stamp, onClose }: { h: Habit; stamp: number; onClose: () => void }): JSX.Element {
  const m = useM4();
  const c = m.checkins.find((x) => x.habitId === h.id && x.checkinStamp === stamp);
  const rec = m.records.find((r) => r.habitId === h.id && (r.checkinStamp ?? r.stamp) === stamp);
  const [value, setValue] = useState(String(c?.value ?? 0));
  const [status, setStatus] = useState<number>(c?.status ?? CheckinStatus.Unlabeled);
  const [note, setNote] = useState(rec?.content ?? "");
  const [mood, setMood] = useState<number | undefined>(rec?.emoji);
  const real = isReal(h);
  const save = async (): Promise<void> => {
    if (real) await m.m4.setCheckin(h, stamp, { value: Math.max(0, Number(value) || 0) });
    else if (status === CheckinStatus.Unlabeled && c) await m.m4.deleteCheckin(c.id);
    else if (status !== CheckinStatus.Unlabeled) await m.m4.setCheckin(h, stamp, { status });
    if (note.trim() || mood !== undefined) await m.m4.saveRecord(h.id, stamp, note, mood);
    else if (rec) await m.m4.deleteRecord(rec.id);
    onClose();
  };
  return (
    <Modal onClose={onClose} className="m4-dialog" testId="checkin-editor">
      <h3>{h.name}, {stampLabel(stamp)}</h3>
      {real ? (
        <div className="m4-field">
          <label>Amount ({h.unit}), goal {h.goal}</label>
          <input className="field full" type="number" min={0} value={value} data-testid="checkin-value" onChange={(e) => setValue(e.target.value)} />
        </div>
      ) : (
        <div className="m4-field">
          <label>Status</label>
          <div className="seg" data-testid="checkin-status">
            {[
              [CheckinStatus.Done, "Done"],
              [CheckinStatus.Undone, "Not done"],
              [CheckinStatus.Unlabeled, "No record"],
            ].map(([v, l]) => (
              <button key={v} className={status === v ? "on" : ""} onClick={() => setStatus(v as number)}>{l}</button>
            ))}
          </div>
        </div>
      )}
      <LogFields note={note} setNote={setNote} mood={mood} setMood={setMood} />
      <div className="row end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" data-testid="checkin-save" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

function LogFields({ note, setNote, mood, setMood }: { note: string; setNote: (s: string) => void; mood: number | undefined; setMood: (m: number | undefined) => void }): JSX.Element {
  return (
    <>
      <div className="m4-field">
        <label>Mood</label>
        <div className="mood-pick" data-testid="mood-pick">
          {MOODS.map((x) => (
            <button key={x.value} className={mood === x.value ? "on" : ""} title={x.label} aria-label={x.label} onClick={() => setMood(mood === x.value ? undefined : x.value)}>
              <MoodFace value={x.value} />
            </button>
          ))}
        </div>
      </div>
      <div className="m4-field">
        <label>Note</label>
        {/* HAB-009 / PREM-043: no 1024 cap in NoorTasks */}
        <textarea className="field" rows={4} value={note} placeholder="How did it go?" data-testid="log-note" onChange={(e) => setNote(e.target.value)} />
        <span className="small muted">{note.length} characters</span>
      </div>
    </>
  );
}

/** HAB-801: after a check-in the log popup asks for a note; Don't show again turns the habit's popup off. */
export function HabitLogHost(): JSX.Element | null {
  const { m4, habits, records } = useM4();
  const [open, setOpen] = useState<{ habitId: string; stamp: number } | null>(null);
  const [note, setNote] = useState("");
  const [mood, setMood] = useState<number | undefined>(undefined);
  const [never, setNever] = useState(false);
  useEffect(() => {
    const on = (e: Event): void => {
      const d = (e as CustomEvent<{ habitId: string; stamp: number; force?: boolean }>).detail;
      setOpen({ habitId: d.habitId, stamp: d.stamp });
      setNever(false);
    };
    window.addEventListener("noor-habit-log", on);
    return () => window.removeEventListener("noor-habit-log", on);
  }, []);
  const h = open ? habits.find((x) => x.id === open.habitId) : undefined;
  const rec: HabitRecord | undefined = open ? records.find((r) => r.habitId === open.habitId && (r.checkinStamp ?? r.stamp) === open.stamp) : undefined;
  useEffect(() => {
    setNote(rec?.content ?? "");
    setMood(rec?.emoji);
  }, [open?.habitId, open?.stamp]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!open || !h) return null;
  const close = async (): Promise<void> => {
    if (never && h.recordEnable) await m4.saveHabit({ ...h, recordEnable: false });
    setOpen(null);
  };
  return (
    <Modal onClose={() => void close()} className="m4-dialog" testId="habit-log-popup">
      <h3>Log for {h.name}</h3>
      <div className="small muted" style={{ marginTop: -8, marginBottom: 12 }}>{stampLabel(open.stamp)}</div>
      <LogFields note={note} setNote={setNote} mood={mood} setMood={setMood} />
      <label className="check-row" style={{ paddingLeft: 0 }}>
        <input type="checkbox" checked={never} data-testid="log-never" onChange={(e) => setNever(e.target.checked)} /> Don't show again for this habit
      </label>
      <div className="row end">
        {rec && <button className="btn danger" data-testid="log-delete" onClick={() => void m4.deleteRecord(rec.id).then(close)}>Delete log</button>}
        <span className="grow" />
        <button className="btn" data-testid="log-skip" onClick={() => void close()}>Skip</button>
        <button className="btn primary" data-testid="log-save" onClick={() => void (note.trim() || mood !== undefined ? m4.saveRecord(h.id, open.stamp, note, mood) : Promise.resolve()).then(close)}>Save</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ add and edit

const GOAL_DAYS = [0, 7, 21, 30, 100, 365];

export function HabitDialog({ habit, onClose }: { habit?: Habit; onClose: () => void }): JSX.Element {
  const { app, m, today } = useHabitEnv();
  const [h, setH] = useState<Habit>(() => habit ?? newHabit({ sectionId: "-1" }));
  const [gallery, setGallery] = useState(!habit);
  const [cat, setCat] = useState(0);
  const [cad, setCad] = useState<Cadence>(() => cadenceOf(h.repeatRule));
  const [iconMode, setIconMode] = useState<"icon" | "emoji" | "text">(h.iconRes?.startsWith("emoji:") ? "emoji" : h.iconRes?.startsWith("text:") ? "text" : "icon");
  const [newReminder, setNewReminder] = useState("09:00");
  const set = (p: Partial<Habit>): void => setH((x) => ({ ...x, ...p }));
  const pick = (p: Preset): void => {
    setH((x) => ({ ...x, name: p.name, iconRes: `nt_${p.icon}`, color: p.color, encouragement: p.quote, repeatRule: p.rule, type: p.type ?? HabitType.Boolean, goal: p.goal ?? 1, unit: p.unit ?? "Count", step: 1 }));
    setCad(cadenceOf(p.rule));
    setIconMode("icon");
    setGallery(false);
  };
  const save = async (): Promise<void> => {
    if (!h.name.trim()) return;
    const row = await m.m4.saveHabit({ ...h, name: h.name.trim(), repeatRule: ruleOf(cad) });
    onClose();
    if (!habit) go(habitPath(row.id));
  };
  const stampToInput = (s: number | null | undefined): string => {
    if (!s) return "";
    const { y, m: mo, d } = parseStamp(s);
    return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  };
  void app;
  if (gallery)
    return (
      <Modal onClose={onClose} className="m4-dialog habit-gallery" testId="habit-gallery">
        <h3>New Habit</h3>
        <div className="m4-tabs" role="tablist">
          {GALLERY.map((g, i) => (
            <button key={g.category} className={cat === i ? "on" : ""} data-testid="gallery-tab" onClick={() => setCat(i)}>{g.category}</button>
          ))}
        </div>
        <div className="gallery-grid">
          {GALLERY[cat]!.items.map((p) => (
            <button key={p.name} className="gallery-item" data-testid="gallery-item" data-name={p.name} onClick={() => pick(p)}>
              <span className="m4-icon-badge sm" style={{ background: p.color }}><IconGlyph k={p.icon} size={15} /></span>
              <span className="gallery-name">{p.name}</span>
              <span className="small muted">{cadenceLabel(p.rule)}</span>
            </button>
          ))}
        </div>
        <div className="row end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" data-testid="habit-custom" onClick={() => setGallery(false)}>Create my own</button>
        </div>
      </Modal>
    );
  return (
    <Modal onClose={onClose} className="m4-dialog habit-dialog" testId="habit-dialog">
      <h3>{habit ? "Edit Habit" : "New Habit"}</h3>
      <div className="habit-dialog-top">
        <HabitIcon habit={h} size="lg" />
        <input className="field full" autoFocus placeholder="Habit name, e.g. Read" value={h.name} data-testid="habit-name" onChange={(e) => set({ name: e.target.value })} />
      </div>
      <div className="m4-field">
        <label>Icon</label>
        <div className="seg small" style={{ width: 240 }}>
          {(["icon", "emoji", "text"] as const).map((k) => (
            <button key={k} className={iconMode === k ? "on" : ""} onClick={() => setIconMode(k)}>{k === "icon" ? "Icon" : k === "emoji" ? "Emoji" : "Text"}</button>
          ))}
        </div>
        {iconMode === "icon" && (
          <div className="icon-grid">
            {ICON_KEYS.map((k) => (
              <button key={k} className={`icon-cell${h.iconRes === `nt_${k}` || (k === "check" && (h.iconRes === "habit_daily_check_in" || !h.iconRes)) ? " on" : ""}`} aria-label={k} onClick={() => set({ iconRes: k === "check" ? "habit_daily_check_in" : `nt_${k}` })}>
                <IconGlyph k={k} size={17} />
              </button>
            ))}
          </div>
        )}
        {iconMode === "emoji" && <input className="field" style={{ width: 120 }} maxLength={4} placeholder="Paste an emoji" value={h.iconRes?.startsWith("emoji:") ? h.iconRes.slice(6) : ""} data-testid="habit-emoji" onChange={(e) => set({ iconRes: `emoji:${e.target.value}` })} />}
        {iconMode === "text" && <input className="field" style={{ width: 120 }} maxLength={2} placeholder="Ab" value={h.iconRes?.startsWith("text:") ? h.iconRes.slice(5) : ""} onChange={(e) => set({ iconRes: `text:${e.target.value}` })} />}
      </div>
      <div className="m4-field">
        <label>Colour</label>
        <ColorSwatches value={h.color} onChange={(c) => set({ color: c ?? "#3fa66b" })} />
      </div>
      <div className="m4-field">
        <label>Quote</label>
        <input className="field full" placeholder="A line that keeps you going" value={h.encouragement ?? ""} data-testid="habit-quote" onChange={(e) => set({ encouragement: e.target.value })} />
      </div>
      <div className="m4-field">
        <label>Frequency</label>
        <div className="seg small" data-testid="habit-freq">
          <button className={cad.kind === "daily" ? "on" : ""} onClick={() => setCad({ kind: "daily", days: [0, 1, 2, 3, 4, 5, 6] })}>Daily</button>
          <button className={cad.kind === "weekly" ? "on" : ""} data-testid="freq-weekly" onClick={() => setCad({ kind: "weekly", times: 3 })}>Weekly</button>
          <button className={cad.kind === "interval" ? "on" : ""} data-testid="freq-interval" onClick={() => setCad({ kind: "interval", every: 2 })}>Interval</button>
        </div>
        {cad.kind === "daily" && (
          <div className="wd-pick" data-testid="habit-weekdays">
            {WEEKDAY_SHORT.map((w, i) => (
              <button key={w} className={cad.days.includes(i) ? "on" : ""} aria-pressed={cad.days.includes(i)} onClick={() => setCad({ kind: "daily", days: cad.days.includes(i) ? cad.days.filter((x) => x !== i) : [...cad.days, i] })}>{w}</button>
            ))}
          </div>
        )}
        {cad.kind === "weekly" && (
          <div className="m4-inline">
            <input className="field num" type="number" min={1} max={7} value={cad.times} data-testid="freq-times" onChange={(e) => setCad({ kind: "weekly", times: Math.max(1, Math.min(7, Number(e.target.value) || 1)) })} />
            <span>days per week</span>
          </div>
        )}
        {cad.kind === "interval" && (
          <div className="m4-inline">
            <span>Every</span>
            <input className="field num" type="number" min={1} max={365} value={cad.every} data-testid="freq-every" onChange={(e) => setCad({ kind: "interval", every: Math.max(1, Number(e.target.value) || 1) })} />
            <span>days</span>
          </div>
        )}
      </div>
      <div className="m4-field">
        <label>Goal</label>
        <div className="seg small" data-testid="habit-goal-type">
          <button className={h.type !== HabitType.Real ? "on" : ""} onClick={() => set({ type: HabitType.Boolean, goal: 1 })}>Achieve it all</button>
          <button className={h.type === HabitType.Real ? "on" : ""} data-testid="goal-amount" onClick={() => set({ type: HabitType.Real, goal: Math.max(2, h.goal ?? 1) })}>Reach an amount</button>
        </div>
        {h.type === HabitType.Real && (
          <div className="m4-inline">
            <span>Daily</span>
            <input className="field num" type="number" min={1} value={h.goal ?? 1} data-testid="habit-goal" onChange={(e) => set({ goal: Math.max(1, Number(e.target.value) || 1) })} />
            <input className="field" style={{ width: 90 }} value={h.unit ?? ""} placeholder="Count" data-testid="habit-unit" onChange={(e) => set({ unit: e.target.value })} />
            <span>add</span>
            <input className="field num" type="number" min={1} value={h.step ?? 1} data-testid="habit-step" onChange={(e) => set({ step: Math.max(1, Number(e.target.value) || 1) })} />
            <span>per tap</span>
          </div>
        )}
      </div>
      <div className="habit-dialog-2col">
        <div className="m4-field">
          <label>Start date</label>
          <input className="field" type="date" value={stampToInput(h.targetStartDate)} max={stampToInput(addStampDays(today, 365))} data-testid="habit-start" onChange={(e) => set({ targetStartDate: e.target.value ? Number(e.target.value.replace(/-/g, "")) : null })} />
        </div>
        <div className="m4-field">
          <label>Goal days</label>
          <Select value={GOAL_DAYS.includes(h.targetDays ?? 0) ? (h.targetDays ?? 0) : -1} options={[...GOAL_DAYS.map((d) => ({ value: d, label: d ? `${d} days` : "Forever" })), { value: -1, label: "Custom" }]} onChange={(v) => set({ targetDays: v === -1 ? 50 : v })} />
          {!GOAL_DAYS.includes(h.targetDays ?? 0) && <input className="field num" type="number" min={1} value={h.targetDays ?? 1} onChange={(e) => set({ targetDays: Math.max(1, Number(e.target.value) || 1) })} />}
        </div>
        <div className="m4-field">
          <label>Section</label>
          <Select testId="habit-section" value={h.sectionId ?? "-1"} options={[{ value: "-1", label: "None" }, ...[...m.sections].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((s) => ({ value: s.id, label: sectionLabel(s.name) }))]} onChange={(v) => set({ sectionId: v })} />
        </div>
        <div className="m4-field">
          <label>Log after check-in</label>
          <Switch testId="habit-record-enable" checked={!!h.recordEnable} onChange={(v) => set({ recordEnable: v })} />
        </div>
      </div>
      <div className="m4-field">
        <label>Reminders</label>
        <div className="m4-inline">
          {(h.reminders ?? []).map((r) => (
            <span key={r} className="chip-btn on">{r}<button aria-label={`Remove ${r}`} onClick={() => set({ reminders: (h.reminders ?? []).filter((x) => x !== r) })}><X size={12} /></button></span>
          ))}
          <input className="field" type="time" value={newReminder} onChange={(e) => setNewReminder(e.target.value)} style={{ width: 110 }} />
          <button className="btn sm" onClick={() => newReminder && !(h.reminders ?? []).includes(newReminder) && set({ reminders: [...(h.reminders ?? []), newReminder].sort() })}>Add</button>
        </div>
        <span className="small muted">Reminder delivery arrives with notifications (M5); the times are saved now.</span>
      </div>
      <div className="row end">
        {!habit && <button className="btn" onClick={() => setGallery(true)}>Gallery</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!h.name.trim()} data-testid="habit-save" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

/** HAB-019 / SET-227: add, rename, reorder and delete sections; no cap (PREM-052). */
export function SectionsDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { m4, sections } = useM4();
  const [name, setName] = useState("");
  const list = [...sections].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const move = async (i: number, dir: -1 | 1): Promise<void> => {
    const a = list[i];
    const b = list[i + dir];
    if (!a || !b) return;
    await m4.saveSection({ ...a, sortOrder: b.sortOrder ?? 0 });
    await m4.saveSection({ ...b, sortOrder: a.sortOrder ?? 0 });
  };
  return (
    <Modal onClose={onClose} className="m4-dialog" testId="sections-dialog">
      <h3>Manage Sections</h3>
      <div className="section-list">
        {list.length === 0 && <div className="empty-note">No sections yet. Morning, Afternoon and Night are a good start.</div>}
        {list.map((s, i) => (
          <div key={s.id} className="section-item" data-testid="section-item" data-name={sectionLabel(s.name)}>
            <input className="field grow" defaultValue={sectionLabel(s.name)} onBlur={(e) => e.target.value.trim() && e.target.value !== sectionLabel(s.name) && void m4.saveSection({ ...s, name: e.target.value.trim() })} />
            <button className="icon-btn sm" aria-label="Move up" disabled={i === 0} onClick={() => void move(i, -1)}><ChevronLeft size={14} style={{ transform: "rotate(90deg)" }} /></button>
            <button className="icon-btn sm" aria-label="Move down" disabled={i === list.length - 1} onClick={() => void move(i, 1)}><ChevronRight size={14} style={{ transform: "rotate(90deg)" }} /></button>
            <button className="icon-btn sm" aria-label="Delete section" onClick={() => void m4.deleteSection(s.id)}><Trash2 size={14} /></button>
          </div>
        ))}
      </div>
      <form
        className="m4-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void m4.saveSection({ id: newId(), name: name.trim() });
          setName("");
        }}
      >
        <input className="field grow" placeholder="New section" value={name} data-testid="section-name" onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" data-testid="section-add">Add</button>
      </form>
      {list.length === 0 && (
        <button className="link-btn" style={{ marginTop: 10 }} onClick={() => void (async () => { for (const n of ["_morning", "_afternoon", "_night"]) await m4.saveSection({ id: newId(), name: n }); })()}>
          Add Morning, Afternoon and Night
        </button>
      )}
      <div className="row end"><button className="btn primary" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

/** Habit export (IMP-022): built in the browser from synced data; the server export route is a listed server change. */
function exportHabitsCsv(habits: Habit[], checkins: Checkin[], records: HabitRecord[]): void {
  const esc = (v: unknown): string => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Habit", "Date", "Status", "Value", "Goal", "Unit", "Log", "Mood"].join(",")];
  for (const c of [...checkins].sort((a, b) => a.checkinStamp - b.checkinStamp)) {
    const h = habits.find((x) => x.id === c.habitId);
    if (!h) continue;
    const r = records.find((x) => x.habitId === c.habitId && (x.checkinStamp ?? x.stamp) === c.checkinStamp);
    const { y, m, d } = parseStamp(c.checkinStamp);
    rows.push([h.name, `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, c.status === 2 ? "Done" : c.status === 1 ? "Not done" : "Partial", c.value ?? "", c.goal ?? "", h.unit ?? "", r?.content ?? "", r?.emoji ?? ""].map(esc).join(","));
  }
  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `noortasks-habits-${makeStamp(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** HAB-005: habits due today inside Today and Next 7 Days, with their check buttons (Habit Settings switch). */
export function TodayHabits(): JSX.Element | null {
  const { app, m, today, ws, anchor } = useHabitEnv();
  const [open, setOpen] = useState(true);
  if (!habitOn(app) || !m.habitPrefs.showInToday) return null;
  const list = sortHabits(m.habits.filter((h) => dueToday(h, m.checkins, today, anchor(h), ws)), true, (h) => m.checkins.some((c) => c.habitId === h.id && c.checkinStamp === today && isDone(c)));
  if (!list.length) return null;
  const done = list.filter((h) => m.checkins.some((c) => c.habitId === h.id && c.checkinStamp === today && isDone(c))).length;
  return (
    <section className="task-group today-habits" data-testid="today-habits">
      <button className="m4-section-head" style={{ width: "100%" }} onClick={() => setOpen(!open)}>
        {open ? <ChevronLeft size={12} style={{ transform: "rotate(-90deg)" }} /> : <ChevronRight size={12} />} Habit<span className="grow" />{done}/{list.length}
      </button>
      {open && list.map((h) => <HabitRow key={h.id} h={h} on={false} today={today} ws={ws} anchor={anchor(h)} />)}
    </section>
  );
}
