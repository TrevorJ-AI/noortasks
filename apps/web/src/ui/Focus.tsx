import { Archive, ArchiveRestore, Check, ChevronLeft, Expand, Filter, Link2, MoreHorizontal, Music, Pause, Pencil, Play, Plus, Shield, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FocusRecord, FocusTimer } from "../data/m4types";
import { HabitStatus, newId, type Task } from "../lib/core";
import { formatTime, startOfDay, toServer } from "../lib/dates";
import { recordActiveMs, recordBindings, toMs } from "../lib/m4core";
import { NOISES, chime, playNoise, stopNoise } from "../lib/noise";
import { focusPath, go } from "../model/router";
import { displayMs, formatClock, remainingMs, activeMs, type Binding, type TimerMode, type TimerState } from "../model/timer";
import { useApp, type App } from "./ctx";
import { HabitIcon } from "./habitParts";
import { useM4, useTimer } from "./m4ctx";
import { ColorSwatches, Menu, MenuButton, Modal, Popover, Select, Switch, anchorOf, type Anchor } from "./primitives";
import { TimerStatsCard } from "./Statistics";

// ------------------------------------------------------------------ helpers

export const recMinutes = (r: FocusRecord): number => recordActiveMs(r) / 60000;
export function fmtMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}
const recStart = (r: FocusRecord): number => toMs(r.startTime);
const recEnd = (r: FocusRecord): number => toMs(r.endTime);
export function recTitle(r: FocusRecord): string {
  const b = (r.tasks ?? [])[0];
  return b?.title || b?.timerName || "";
}
const phaseLabel = (s: TimerState | null): string => (!s ? "Focus" : s.mode === "stopwatch" ? "Stopwatch" : s.phase === "work" ? "Focus" : s.phase === "long" ? "Long break" : "Short break");

/** KANB-801: focusing a task in a kanban list offers to move it into a Progress column (created when missing). */
export function offerProgress(app: App, taskId: string): void {
  const t = app.tasks.find((x) => x.id === taskId);
  if (!t) return;
  const p = app.projects.find((x) => x.id === t.projectId);
  if (!p || p.viewMode !== "kanban") return;
  const cols = app.columns.filter((c) => c.projectId === p.id);
  const prog = cols.find((c) => /progress/i.test(c.name));
  if (prog && t.columnId === prog.id) return;
  app.toast(`Move "${t.title}" to Progress?`, () => {
    void (async () => {
      let col = prog;
      if (!col) {
        const made = await app.repo.createColumn(p.id, "Progress");
        if (typeof made === "string") return;
        col = made;
      }
      await app.repo.moveToColumn(t.id, { id: col.id, projectId: p.id });
    })();
  }, "Move");
}

// ------------------------------------------------------------------ global pieces: tab title, sounds, full screen

/** Mounted once in App: tab title countdown (FOC-038), end chime, white noise while running, auto full screen. */
export function FocusGlobal(): JSX.Element | null {
  const app = useApp();
  const m = useM4();
  const { state, now } = useTimer();
  const [full, setFull] = useState(false);
  const base = useRef(document.title);
  const live = !!state && state.status !== "idle";
  const showTitle = m.focusConf.showTabFocusTime !== false;
  useEffect(() => {
    if (live && showTitle) document.title = `${formatClock(displayMs(state!, now))} ${phaseLabel(state)} - NoorTasks`;
    else document.title = base.current;
  });
  useEffect(() => {
    const on = (): void => {
      if (m.pomoPrefs.soundsOn) chime();
    };
    window.addEventListener("noor-focus-end", on);
    return () => window.removeEventListener("noor-focus-end", on);
  }, [m.pomoPrefs.soundsOn]);
  const running = state?.status === "running";
  useEffect(() => {
    if (running && m.focusConf.whiteNoise) playNoise(m.focusConf.whiteNoise);
    else stopNoise();
  }, [running, m.focusConf.whiteNoise]);
  // SET-219: full screen 5 seconds after a session starts
  const sid = state?.sessionId;
  useEffect(() => {
    if (!running || !m.focusConf.autoFullScreen) return;
    const t = setTimeout(() => setFull(true), 5000);
    return () => clearTimeout(t);
  }, [sid, running, m.focusConf.autoFullScreen]);
  useEffect(() => {
    const on = (): void => setFull(true);
    window.addEventListener("noor-focus-full", on);
    return () => window.removeEventListener("noor-focus-full", on);
  }, []);
  void app;
  return full && state ? <FullScreenClock onClose={() => setFull(false)} /> : null;
}

const CLOCK_STYLES = ["Simple Digital", "Page Flip", "Pixel"];
const PIXEL: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"], "1": ["010", "110", "010", "010", "111"], "2": ["111", "001", "111", "100", "111"], "3": ["111", "001", "111", "001", "111"], "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"], "6": ["111", "100", "111", "101", "111"], "7": ["111", "001", "010", "010", "010"], "8": ["111", "101", "111", "101", "111"], "9": ["111", "101", "111", "001", "111"], ":": ["0", "1", "0", "1", "0"],
};

/** FOC-033: three clock faces, switched with the arrows, the dots or a swipe; Anti Burn-in drifts the clock (SET-220). */
function FullScreenClock({ onClose }: { onClose: () => void }): JSX.Element {
  const m = useM4();
  const { state, now } = useTimer();
  const [styleIx, setStyleIx] = useState(() => Number(localStorage.getItem("focusClockStyle") ?? 0) || 0);
  const x0 = useRef<number | null>(null);
  const pick = (i: number): void => {
    const v = (i + CLOCK_STYLES.length) % CLOCK_STYLES.length;
    setStyleIx(v);
    localStorage.setItem("focusClockStyle", String(v));
  };
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") pick(styleIx + 1);
      if (e.key === "ArrowLeft") pick(styleIx - 1);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  });
  if (!state) return <></>;
  const text = formatClock(displayMs(state, now));
  const drift = m.focusConf.antiBurnIn ? { transform: `translate(${Math.sin(now / 60000) * 30}px, ${Math.cos(now / 47000) * 24}px)` } : undefined;
  return (
    <div
      className="focus-full"
      data-testid="focus-full"
      onPointerDown={(e) => (x0.current = e.clientX)}
      onPointerUp={(e) => {
        if (x0.current !== null && Math.abs(e.clientX - x0.current) > 60) pick(styleIx + (e.clientX < x0.current ? 1 : -1));
        x0.current = null;
      }}
    >
      <button className="icon-btn focus-full-close" aria-label="Exit full screen" onClick={onClose}><X size={20} /></button>
      <div className="focus-full-body" style={drift}>
        <div className="focus-full-phase">{phaseLabel(state)}{state.binding ? ` · ${state.binding.title}` : ""}</div>
        {styleIx === 0 && <div className="clock-digital" data-testid="clock-style" data-style="digital">{text}</div>}
        {styleIx === 1 && (
          <div className="clock-flip" data-testid="clock-style" data-style="flip">
            {text.split("").map((ch, i) => (ch === ":" ? <span key={i} className="flip-colon">:</span> : <span key={i} className="flip-card">{ch}</span>))}
          </div>
        )}
        {styleIx === 2 && (
          <div className="clock-pixel" data-testid="clock-style" data-style="pixel">
            {text.split("").map((ch, i) => (
              <span key={i} className="px-char" style={{ gridTemplateColumns: `repeat(${(PIXEL[ch]?.[0] ?? "0").length}, 1fr)` }}>
                {(PIXEL[ch] ?? []).join("").split("").map((b, j) => <i key={j} className={b === "1" ? "on" : ""} />)}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="focus-full-dots">
        <button className="icon-btn" aria-label="Previous style" data-testid="clock-prev" onClick={() => pick(styleIx - 1)}><ChevronLeft size={18} /></button>
        {CLOCK_STYLES.map((s, i) => <button key={s} className={`dot${i === styleIx ? " on" : ""}`} aria-label={s} title={s} onClick={() => pick(i)} />)}
        <button className="icon-btn" aria-label="Next style" data-testid="clock-next" onClick={() => pick(styleIx + 1)}><ChevronLeft size={18} style={{ transform: "rotate(180deg)" }} /></button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ screen

export function FocusScreen(): JSX.Element {
  const app = useApp();
  const m = useM4();
  const { route } = app;
  const timer = m.timers.find((t) => t.id === route.itemId);
  return (
    <div className={`m4-screen focus-screen${timer ? " has-item" : ""}`} data-testid="focus-screen">
      <section className="m4-list wide focus-left">
        <div className="m4-head">
          <h1 className="view-title">Focus</h1>
          <MenuButton title="Focus settings" placement="bottom-end" testId="focus-more" items={() => [{ label: "Focus Settings", onClick: () => go(route.path, { modalType: "settings", tabs: "focus" }) }, { label: "Statistics", onClick: () => go("statistics/pomo") }, { label: "Export records (CSV)", onClick: () => exportFocusCsv(m.pomos) }]}>
            <MoreHorizontal size={18} />
          </MenuButton>
        </div>
        <div className="m4-scroll">
          <TimerPanel />
          <TimersList />
        </div>
      </section>
      <section className="m4-detail">{timer ? <TimerDetail key={timer.id} t={timer} /> : <RecordsPane />}</section>
    </div>
  );
}

/** Pick what to focus on (FOC-014): a task, a habit or a timer card; recent bindings first (FOC-901). */
function BindPicker({ anchor, onPick, onClose }: { anchor: Anchor; onPick: (b: Binding | undefined) => void; onClose: () => void }): JSX.Element {
  const app = useApp();
  const m = useM4();
  const [q, setQ] = useState("");
  const [recent, setRecent] = useState<Array<{ type: number; id: string; title?: string }>>(() => {
    try {
      return JSON.parse(localStorage.getItem("recentFocusResData") ?? "[]") as never;
    } catch {
      return [];
    }
  });
  useEffect(() => {
    app.engine.api.get<Array<{ type: number; id: string; title?: string }>>("/api/v2/pomodoro/bind/recent").then((r) => {
      if (Array.isArray(r)) {
        setRecent(r);
        localStorage.setItem("recentFocusResData", JSON.stringify(r.slice(0, 10)));
      }
    }, () => {});
  }, [app.engine]);
  const ql = q.trim().toLowerCase();
  const tasks = app.tasks.filter((t) => !t.deleted && t.status === 0 && t.kind !== "NOTE" && (!ql || t.title.toLowerCase().includes(ql))).slice(0, ql ? 30 : 8);
  const habits = m.habits.filter((h) => h.status !== HabitStatus.Archived && (!ql || h.name.toLowerCase().includes(ql)));
  const timers = m.timers.filter((t) => t.status !== 1 && (!ql || t.name.toLowerCase().includes(ql)));
  const asBinding = (type: number, id: string): Binding | undefined => {
    if (type === 0) {
      const t = app.tasks.find((x) => x.id === id);
      return t ? { kind: "task", id, title: t.title, projectId: t.projectId } : undefined;
    }
    if (type === 1) {
      const h = m.habits.find((x) => x.id === id);
      return h ? { kind: "habit", id, title: h.name } : undefined;
    }
    const t = m.timers.find((x) => x.id === id);
    return t ? { kind: "timer", id, title: t.name } : undefined;
  };
  const choose = (b: Binding | undefined): void => {
    onPick(b);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} testId="bind-picker" className="bind-picker">
      <div className="search-field"><input autoFocus placeholder="Search tasks, habits, timers" value={q} data-testid="bind-search" onChange={(e) => setQ(e.target.value)} /></div>
      <div className="bind-list">
        <button className="menu-item" onClick={() => choose(undefined)}>No link</button>
        {!ql && recent.length > 0 && <div className="bind-head">Recent</div>}
        {!ql && recent.slice(0, 4).map((r) => {
          const b = asBinding(r.type, r.id);
          return b ? <button key={`r${r.id}`} className="menu-item" onClick={() => choose(b)}>{b.title}</button> : null;
        })}
        {tasks.length > 0 && <div className="bind-head">Tasks</div>}
        {tasks.map((t) => <button key={t.id} className="menu-item" data-testid="bind-task" data-title={t.title} onClick={() => choose({ kind: "task", id: t.id, title: t.title, projectId: t.projectId })}>{t.title || "Untitled"}<span className="menu-hint">{app.projectName(t.projectId)}</span></button>)}
        {habits.length > 0 && <div className="bind-head">Habits</div>}
        {habits.map((h) => <button key={h.id} className="menu-item" data-testid="bind-habit" data-title={h.name} onClick={() => choose({ kind: "habit", id: h.id, title: h.name })}>{h.name}</button>)}
        {timers.length > 0 && <div className="bind-head">Timers</div>}
        {timers.map((t) => <button key={t.id} className="menu-item" onClick={() => choose({ kind: "timer", id: t.id, title: t.name })}>{t.name}</button>)}
      </div>
    </Popover>
  );
}

function TimerPanel(): JSX.Element {
  const app = useApp();
  const m = useM4();
  const { state, now } = useTimer();
  const { route } = app;
  const [mode, setMode] = useState<TimerMode>(() => {
    try {
      return (JSON.parse(localStorage.getItem("focusTimerType") ?? '"pomo"') as TimerMode) === "stopwatch" ? "stopwatch" : "pomo";
    } catch {
      return "pomo";
    }
  });
  const [binding, setBinding] = useState<Binding | undefined>(undefined);
  const [bindAnchor, setBindAnchor] = useState<Anchor | null>(null);
  const [confirm, setConfirm] = useState<null | (() => void)>(null);
  const [finishing, setFinishing] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const strict = !!m.focusConf.strict;
  const live = !!state && state.status !== "idle";
  const shownMode = state ? state.mode : mode;
  const shownBinding = state ? state.binding : binding;

  // a task or habit handed over in the URL (task menu "Start Focus", habit detail): preset, and start when asked
  const qTask = route.query.get("task");
  const qHabit = route.query.get("habit");
  const qStart = route.query.get("start");
  useEffect(() => {
    let b: Binding | undefined;
    if (qTask) {
      const t = app.tasks.find((x) => x.id === qTask);
      if (t) b = { kind: "task", id: t.id, title: t.title, projectId: t.projectId };
    } else if (qHabit) {
      const h = m.habits.find((x) => x.id === qHabit);
      if (h) b = { kind: "habit", id: h.id, title: h.name };
    }
    if (!b) return;
    setBinding(b);
    if (qStart) begin("pomo", b);
    go(focusPath(route.itemId));
  }, [qTask, qHabit, qStart, app.tasks.length, m.habits.length]); // eslint-disable-line react-hooks/exhaustive-deps

  /** FOC-801: a running timer (here or on another device) is replaced only after a yes. */
  function begin(md: TimerMode, b = binding, minutes?: number): void {
    const go2 = (): void => {
      void m.focus.start(md, { binding: b, strict: md === "pomo" && strict, minutes });
      if (b?.kind === "task") offerProgress(app, b.id);
    };
    if (m.focus.busy()) setConfirm(() => go2);
    else go2();
  }
  // timer cards start through a window event so the list can sit outside this panel
  useEffect(() => {
    const on = (e: Event): void => {
      const t = (e as CustomEvent<FocusTimer>).detail;
      begin(t.type === "timing" ? "stopwatch" : "pomo", { kind: "timer", id: t.id, title: t.name }, t.type === "timing" ? undefined : t.pomodoroTime);
    };
    window.addEventListener("noor-timer-start", on);
    return () => window.removeEventListener("noor-timer-start", on);
  });

  const total = state ? (state.mode === "pomo" ? state.plannedMs : 0) : mode === "pomo" ? m.pomoPrefs.pomoDuration * 60000 : 0;
  const shown = state ? displayMs(state, now) : total;
  const frac = state && state.mode === "pomo" && state.plannedMs ? 1 - remainingMs(state, now) / state.plannedMs : state && state.mode === "stopwatch" ? (activeMs(state, now) % 3600000) / 3600000 : 0;
  const R = 108;
  const L = 2 * Math.PI * R;
  const remoteNote = m.focus.lastRemoteEvent && Date.now() - m.focus.lastRemoteEvent.at < 6000 ? (m.focus.lastRemoteEvent.kind === "adopt" ? "Following the timer from another device" : "The timer was ended on another device") : "";
  const todayRecs = m.pomos.filter((r) => recStart(r) >= startOfDay(now));
  return (
    <div className="timer-panel" data-testid="timer-panel">
      <div className="seg timer-mode" role="tablist">
        <button className={shownMode === "pomo" ? "on" : ""} disabled={live} data-testid="mode-pomo" onClick={() => (setMode("pomo"), localStorage.setItem("focusTimerType", JSON.stringify("pomo")))}>Pomo</button>
        <button className={shownMode === "stopwatch" ? "on" : ""} disabled={live} data-testid="mode-stopwatch" onClick={() => (setMode("stopwatch"), localStorage.setItem("focusTimerType", JSON.stringify("stopwatch")))}>Stopwatch</button>
      </div>
      <button className="bind-btn" data-testid="bind-btn" onClick={(e) => setBindAnchor(anchorOf(e.currentTarget))}>
        <Link2 size={14} />
        <span className="bind-title" data-testid="bind-title">{shownBinding ? shownBinding.title : "Focus on..."}</span>
      </button>
      <div className={`timer-ring phase-${state?.phase ?? "work"}${state?.status === "paused" ? " paused" : ""}`} data-testid="timer-ring">
        <svg viewBox="0 0 240 240" aria-hidden>
          <circle cx="120" cy="120" r={R} className="tr-bg" />
          {frac > 0 && <circle cx="120" cy="120" r={R} className="tr-fg" strokeDasharray={`${frac * L} ${L}`} transform="rotate(-90 120 120)" />}
        </svg>
        <div className="tr-center">
          <div className="tr-phase" data-testid="timer-phase">{state?.status === "idle" ? `${phaseLabel(state)} next` : phaseLabel(state)}{state?.status === "paused" ? " · paused" : ""}</div>
          <div className="tr-time" data-testid="timer-clock">{formatClock(shown)}</div>
          {state?.mode === "pomo" && <div className="tr-sub">{state.cycle} of {m.pomoPrefs.longBreakInterval} before the long break</div>}
        </div>
      </div>
      {remoteNote && <div className="remote-note" data-testid="remote-note">{remoteNote}</div>}
      <div className="timer-controls">
        {!state && <button className="btn primary big" data-testid="focus-start" onClick={() => begin(mode)}><Play size={16} /> Start</button>}
        {state?.status === "running" && (
          <>
            {!state.strict && <button className="btn big" data-testid="focus-pause" onClick={() => void m.focus.pause()}><Pause size={16} /> Pause</button>}
            {state.phase === "work" ? (
              state.strict ? (
                <button className="btn big" data-testid="focus-giveup" onClick={() => app.setModal({ kind: "confirm", title: "Give up this pomodoro?", body: "Strict mode is on. Giving up ends the session without a record.", ok: "Give up", danger: true, onOk: () => void m.focus.exit() })}><Shield size={16} /> Give up</button>
              ) : (
                <button className="btn big" data-testid="focus-end" onClick={() => setFinishing(true)}><Square size={14} /> End</button>
              )
            ) : (
              <button className="btn big" data-testid="focus-skip" onClick={() => void m.focus.skipBreak()}>Skip break</button>
            )}
          </>
        )}
        {state?.status === "paused" && (
          <>
            <button className="btn primary big" data-testid="focus-resume" onClick={() => void m.focus.resume()}><Play size={16} /> Continue</button>
            <button className="btn big" data-testid="focus-end" onClick={() => setFinishing(true)}><Square size={14} /> End</button>
          </>
        )}
        {state?.status === "idle" && (
          <>
            <button className="btn primary big" data-testid="focus-next" onClick={() => void m.focus.resume()}><Play size={16} /> {state.phase === "work" ? "Start Pomo" : "Start Break"}</button>
            <button className="btn big" onClick={() => (state.phase === "work" ? void m.focus.exit() : void m.focus.skipBreak())}>{state.phase === "work" ? "Stop" : "Skip"}</button>
          </>
        )}
      </div>
      <div className="timer-tools">
        <Select testId="noise-select" value={m.focusConf.whiteNoise ?? ""} options={NOISES.map((n) => ({ value: n.id, label: n.label }))} onChange={(v) => void app.repo.setExt("focusConf", { ...m.focusConf, whiteNoise: v })} />
        <button className={`icon-btn${strict ? " on" : ""}`} title={shownMode === "stopwatch" ? "Strict mode works with Pomo only" : "Strict mode: no pause, ending means giving up"} aria-label="Strict mode" data-testid="strict-toggle" disabled={shownMode === "stopwatch" || live} onClick={() => void app.repo.setExt("focusConf", { ...m.focusConf, strict: !strict })}><Shield size={16} /></button>
        <button className="icon-btn" title="Focus note" aria-label="Focus note" data-testid="note-toggle" disabled={!live} onClick={() => setNoteOpen(!noteOpen)}><Pencil size={16} /></button>
        <button className="icon-btn" title="Full screen" aria-label="Full screen" data-testid="full-btn" disabled={!state} onClick={() => window.dispatchEvent(new Event("noor-focus-full"))}><Expand size={16} /></button>
        <span className="noise-hint"><Music size={13} /> {NOISES.find((n) => n.id === (m.focusConf.whiteNoise ?? ""))?.label}</span>
      </div>
      {noteOpen && live && <textarea className="field focus-note" placeholder="Note for this session" value={state!.note} data-testid="focus-note" onChange={(e) => m.focus.setNote(e.target.value)} />}
      <div className="today-strip">
        <span>Today</span>
        <b data-testid="today-pomos">{todayRecs.filter((r) => r.type === 0).length}</b> {todayRecs.filter((r) => r.type === 0).length === 1 ? "pomo" : "pomos"}
        <b>{fmtMinutes(todayRecs.reduce((a, r) => a + recMinutes(r), 0))}</b> focused
        <span className="muted">goal {m.pomoPrefs.pomoGoal}</span>
      </div>
      {bindAnchor && <BindPicker anchor={bindAnchor} onClose={() => setBindAnchor(null)} onPick={(b) => (state ? m.focus.setBinding(b) : setBinding(b))} />}
      {confirm && (
        <Modal onClose={() => setConfirm(null)} testId="focus-replace">
          <h3>Another timer is running</h3>
          <p className="muted">Stop it and start the new one? The running session ends without being finished.</p>
          <div className="row end">
            <button className="btn" onClick={() => setConfirm(null)}>Keep it</button>
            <button className="btn primary" data-testid="focus-replace-ok" onClick={() => void (async () => {
              const f = confirm;
              setConfirm(null);
              await m.focus.exit();
              f();
            })()}>Stop and start</button>
          </div>
        </Modal>
      )}
      {finishing && state && <FinishDialog onClose={() => setFinishing(false)} />}
    </div>
  );
}

/** FOC-023: ending a session offers extra minutes and the note before the record is written. */
function FinishDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const m = useM4();
  const { state, now } = useTimer();
  const [extra, setExtra] = useState(0);
  const [note, setNote] = useState(state?.note ?? "");
  const mins = state ? activeMs(state, state.status === "paused" ? (state.pauseStart ?? now) : now) / 60000 : 0;
  return (
    <Modal onClose={onClose} className="m4-dialog" testId="focus-finish">
      <h3>End this session?</h3>
      <p className="muted" style={{ marginTop: -6 }}>{fmtMinutes(mins)} focused{state?.binding ? ` on ${state.binding.title}` : ""}.{mins < 1 && extra === 0 ? " Under a minute is not recorded." : ""}</p>
      <div className="m4-field">
        <label>Extra focus time</label>
        <div className="m4-inline">
          {[0, 5, 10, 15].map((x) => <button key={x} className={`chip-btn${extra === x ? " on" : ""}`} data-testid={`extra-${x}`} onClick={() => setExtra(x)}>{x ? `+${x} min` : "None"}</button>)}
          <input className="field num" type="number" min={0} value={extra} onChange={(e) => setExtra(Math.max(0, Number(e.target.value) || 0))} />
        </div>
      </div>
      <div className="m4-field">
        <label>Note</label>
        <textarea className="field" rows={3} value={note} data-testid="finish-note" onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="row end">
        <button className="btn" onClick={onClose}>Keep going</button>
        <button className="btn danger" onClick={() => void m.focus.exit().then(onClose)}>Discard</button>
        <button className="btn primary" data-testid="finish-save" onClick={() => {
          m.focus.setNote(note);
          void m.focus.finish(extra).then(onClose);
        }}><Check size={15} /> Save record</button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ timers (standalone cards, FOC-015)

function TimersList(): JSX.Element {
  const app = useApp();
  const m = useM4();
  const [arch, setArch] = useState(false);
  const [edit, setEdit] = useState<FocusTimer | null>(null);
  const [addFor, setAddFor] = useState<FocusTimer | null>(null);
  const list = m.timers.filter((t) => (arch ? t.status === 1 : t.status !== 1)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const today0 = startOfDay(app.now);
  const minsToday = (id: string): number => m.pomos.filter((r) => recStart(r) >= today0 && recordBindings(r).some((b) => b.owner === 2 && b.id === id)).reduce((a, r) => a + recMinutes(r), 0);
  return (
    <div className="timers" data-testid="timers">
      <div className="m4-section-head">
        {arch ? "Archived timers" : "Timers"}
        <span className="grow" />
        <button className="link-btn" onClick={() => setArch(!arch)}>{arch ? "Active" : "Archived"}</button>
        <button className="icon-btn xs" aria-label="New timer" title="New timer" data-testid="timer-add" onClick={() => setEdit({ id: newId(), name: "", type: "pomodoro", pomodoroTime: 25, color: "#2f8fbf", status: 0 })}><Plus size={15} /></button>
      </div>
      {list.length === 0 && <div className="empty-note">{arch ? "No archived timers." : "Save timers for things you do often, like Reading or Exercise."}</div>}
      {list.map((t) => (
        <div key={t.id} className={`timer-card${app.route.itemId === t.id ? " on" : ""}`} data-testid="timer-card" data-name={t.name} onClick={() => go(focusPath(t.id))}>
          <HabitIcon habit={{ iconRes: t.icon ? `text:${t.icon}` : `text:${t.name.slice(0, 1).toUpperCase()}`, color: t.color ?? "#2f8fbf", name: t.name }} size="sm" />
          <div className="grow">
            <div className="habit-name">{t.name}</div>
            <div className="habit-sub">{t.type === "timing" ? "Stopwatch" : `${t.pomodoroTime ?? 25} min`} · today {fmtMinutes(minsToday(t.id))}</div>
          </div>
          {t.status !== 1 && <button className="icon-btn sm" aria-label={`Start ${t.name}`} data-testid="timer-start" onClick={(e) => (e.stopPropagation(), window.dispatchEvent(new CustomEvent("noor-timer-start", { detail: t })))}><Play size={14} /></button>}
          <MenuButton className="icon-btn sm" title="Timer actions" items={() => [
            { label: "Edit", icon: <Pencil size={15} />, onClick: () => setEdit(t) },
            { label: "Add Record", icon: <Plus size={15} />, onClick: () => setAddFor(t) },
            t.status === 1 ? { label: "Restore", icon: <ArchiveRestore size={15} />, onClick: () => void m.m4.saveTimer({ ...t, status: 0, archivedTime: null }) } : { label: "Archive", icon: <Archive size={15} />, testId: "timer-archive", onClick: () => void m.m4.saveTimer({ ...t, status: 1, archivedTime: toServer(Date.now()) }) },
            { label: "Delete", icon: <Trash2 size={15} />, danger: true, onClick: () => app.setModal({ kind: "confirm", title: "Delete timer", body: "Its records stay in the focus history.", ok: "Delete", danger: true, onOk: () => void m.m4.deleteTimer(t.id) }) },
          ]}>
            <MoreHorizontal size={15} />
          </MenuButton>
        </div>
      ))}
      {edit && <TimerDialog t={edit} onClose={() => setEdit(null)} />}
      {addFor && <RecordDialog preset={{ kind: "timer", id: addFor.id, title: addFor.name }} type={addFor.type === "timing" ? 1 : 0} onClose={() => setAddFor(null)} />}
    </div>
  );
}

function TimerDialog({ t, onClose }: { t: FocusTimer; onClose: () => void }): JSX.Element {
  const { m4 } = useM4();
  const [x, setX] = useState(t);
  return (
    <Modal onClose={onClose} className="m4-dialog" testId="timer-dialog">
      <h3>{t.name ? "Edit Timer" : "New Timer"}</h3>
      <div className="m4-field"><label>Name</label><input className="field full" autoFocus value={x.name} data-testid="timer-name" onChange={(e) => setX({ ...x, name: e.target.value })} /></div>
      <div className="m4-field"><label>Badge</label><input className="field" style={{ width: 90 }} maxLength={2} placeholder={x.name.slice(0, 1).toUpperCase()} value={x.icon ?? ""} onChange={(e) => setX({ ...x, icon: e.target.value })} /></div>
      <div className="m4-field"><label>Colour</label><ColorSwatches value={x.color} onChange={(c) => setX({ ...x, color: c })} /></div>
      <div className="m4-field">
        <label>Mode</label>
        <div className="seg small" style={{ width: 240 }}>
          <button className={x.type !== "timing" ? "on" : ""} onClick={() => setX({ ...x, type: "pomodoro" })}>Pomo</button>
          <button className={x.type === "timing" ? "on" : ""} onClick={() => setX({ ...x, type: "timing" })}>Stopwatch</button>
        </div>
        {x.type !== "timing" && <div className="m4-inline"><input className="field num" type="number" min={5} value={x.pomodoroTime ?? 25} onChange={(e) => setX({ ...x, pomodoroTime: Math.max(5, Number(e.target.value) || 25) })} /> minutes</div>}
      </div>
      <div className="row end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!x.name.trim()} data-testid="timer-save" onClick={() => void m4.saveTimer({ ...x, name: x.name.trim() }).then(onClose)}>Save</button>
      </div>
    </Modal>
  );
}

function TimerDetail({ t }: { t: FocusTimer }): JSX.Element {
  const m = useM4();
  const recs = m.pomos.filter((r) => recordBindings(r).some((b) => b.owner === 2 && b.id === t.id)).sort((a, b) => recStart(b) - recStart(a));
  return (
    <div className="timer-detail" data-testid="timer-detail">
      <div className="m4-head">
        <button className="icon-btn m4-back" aria-label="Back" onClick={() => go(focusPath())}><ChevronLeft size={18} /></button>
        <h2 className="view-title">{t.name}</h2>
        <button className="btn sm" onClick={() => go(focusPath())}>All records</button>
      </div>
      <TimerStatsCard timerId={t.id} />
      <div className="m4-card" style={{ marginTop: 14 }}>
        <div className="m4-card-title">Records</div>
        <RecordList recs={recs} selectMode={false} selected={new Set()} onSelect={() => {}} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ records (FOC-019..022)

type DateF = "all" | "today" | "week" | "month";
type DurF = "any" | "short" | "mid" | "long";
type LinkF = "all" | "linked" | "unlinked";

function RecordsPane(): JSX.Element {
  const app = useApp();
  const m = useM4();
  const [dateF, setDateF] = useState<DateF>("all");
  const [durF, setDurF] = useState<DurF>("any");
  const [linkF, setLinkF] = useState<LinkF>("all");
  const [filterA, setFilterA] = useState<Anchor | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const now = app.now;
  const recs = useMemo(() => {
    const d0 = startOfDay(now);
    const from = dateF === "today" ? d0 : dateF === "week" ? d0 - 6 * 86400000 : dateF === "month" ? d0 - 29 * 86400000 : -Infinity;
    return m.pomos
      .filter((r) => recStart(r) >= from)
      .filter((r) => {
        const mins = recMinutes(r);
        return durF === "any" || (durF === "short" ? mins < 25 : durF === "mid" ? mins >= 25 && mins <= 60 : mins > 60);
      })
      .filter((r) => linkF === "all" || (linkF === "linked" ? recordBindings(r).length > 0 : recordBindings(r).length === 0))
      .sort((a, b) => recStart(b) - recStart(a));
  }, [m.pomos, dateF, durF, linkF, now]);
  const d0 = startOfDay(now);
  const today = m.pomos.filter((r) => recStart(r) >= d0);
  const kpi = {
    todayPomos: today.filter((r) => r.type === 0).length,
    todayMin: today.reduce((a, r) => a + recMinutes(r), 0),
    totalPomos: m.pomos.filter((r) => r.type === 0).length,
    totalMin: m.pomos.reduce((a, r) => a + recMinutes(r), 0),
  };
  const filtered = dateF !== "all" || durF !== "any" || linkF !== "all";
  return (
    <div className="records-pane" data-testid="records-pane">
      <div className="m4-head">
        <h2 className="view-title">Overview</h2>
      </div>
      <div className="m4-kpis">
        <div className="m4-kpi"><div className="k-label">Today's pomos</div><div className="k-value" data-testid="kpi-today-pomos">{kpi.todayPomos}</div></div>
        <div className="m4-kpi"><div className="k-label">Today's focus</div><div className="k-value" data-testid="kpi-today-focus">{fmtMinutes(kpi.todayMin)}</div></div>
        <div className="m4-kpi"><div className="k-label">Total pomos</div><div className="k-value" data-testid="kpi-total-pomos">{kpi.totalPomos}</div></div>
        <div className="m4-kpi"><div className="k-label">Total focus</div><div className="k-value" data-testid="kpi-total-focus">{fmtMinutes(kpi.totalMin)}</div></div>
      </div>
      <div className="m4-section-head records-head">
        <span>Focus Record</span>
        <span className="grow" />
        <button className={`icon-btn sm${filtered ? " on" : ""}`} aria-label="Filter records" title="Filter" data-testid="record-filter" onClick={(e) => setFilterA(anchorOf(e.currentTarget))}><Filter size={15} /></button>
        <button className="icon-btn sm" aria-label="Add record" title="Add record" data-testid="record-add" onClick={() => setAdding(true)}><Plus size={16} /></button>
        <MenuButton className="icon-btn sm" title="Record actions" testId="record-more" placement="bottom-end" items={() => [
          { label: selectMode ? "Cancel selection" : "Select", onClick: () => (setSelectMode(!selectMode), setSel(new Set())), testId: "record-select" },
          { label: "Delete All", danger: true, testId: "record-delete-all", onClick: () => app.setModal({ kind: "confirm", title: "Delete all focus records?", body: "Every pomodoro and stopwatch record is deleted for good. Statistics drop to zero.", ok: "Delete all", danger: true, onOk: () => void m.m4.deleteAllFocus().catch(() => app.toast("Delete All needs a connection")) }) },
        ]}>
          <MoreHorizontal size={15} />
        </MenuButton>
      </div>
      {selectMode && (
        <div className="select-bar">
          <span>{sel.size} selected</span>
          <button className="btn sm" onClick={() => setSel(new Set(recs.map((r) => r.id)))}>All</button>
          <button className="btn sm danger" data-testid="record-delete-selected" disabled={!sel.size} onClick={() => void m.m4.deleteFocus([...sel]).then(() => (setSel(new Set()), setSelectMode(false)))}>Delete</button>
        </div>
      )}
      <RecordList recs={recs} selectMode={selectMode} selected={sel} onSelect={(id) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; })} />
      {filterA && (
        <Popover anchor={filterA} onClose={() => setFilterA(null)} placement="bottom-end" testId="record-filter-menu">
          <div className="filter-pop">
            <div className="m4-label">Date</div>
            <div className="seg small">{(["all", "today", "week", "month"] as DateF[]).map((v) => <button key={v} className={dateF === v ? "on" : ""} onClick={() => setDateF(v)}>{v === "all" ? "All" : v === "today" ? "Today" : v === "week" ? "7 days" : "30 days"}</button>)}</div>
            <div className="m4-label">Duration</div>
            <div className="seg small">{(["any", "short", "mid", "long"] as DurF[]).map((v) => <button key={v} className={durF === v ? "on" : ""} onClick={() => setDurF(v)}>{v === "any" ? "Any" : v === "short" ? "< 25m" : v === "mid" ? "25-60m" : "> 1h"}</button>)}</div>
            <div className="m4-label">Linked status</div>
            <div className="seg small">{(["all", "linked", "unlinked"] as LinkF[]).map((v) => <button key={v} className={linkF === v ? "on" : ""} onClick={() => setLinkF(v)}>{v === "all" ? "All" : v === "linked" ? "Linked" : "Unlinked"}</button>)}</div>
          </div>
        </Popover>
      )}
      {adding && <RecordDialog type={0} onClose={() => setAdding(false)} />}
    </div>
  );
}

function RecordList({ recs, selectMode, selected, onSelect }: { recs: FocusRecord[]; selectMode: boolean; selected: Set<string>; onSelect: (id: string) => void }): JSX.Element {
  const app = useApp();
  const [edit, setEdit] = useState<FocusRecord | null>(null);
  const meridiem = app.settings.showMeridiem !== false;
  const days = new Map<number, FocusRecord[]>();
  for (const r of recs) {
    const d = startOfDay(recStart(r));
    days.set(d, [...(days.get(d) ?? []), r]);
  }
  if (!recs.length) return <div className="m4-empty small" data-testid="records-empty"><span className="empty-title">No focus records yet</span><span>Finish a session or add a record by hand.</span></div>;
  return (
    <div className="record-list" data-testid="record-list">
      {[...days.entries()].map(([d, list]) => (
        <div key={d} className="record-day">
          <div className="record-day-head">
            <span>{new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: new Date(d).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined })}</span>
            <span className="muted">{fmtMinutes(list.reduce((a, r) => a + recMinutes(r), 0))}</span>
          </div>
          {list.map((r) => (
            <div key={r.id} className={`record-row${selected.has(r.id) ? " on" : ""}`} data-testid="record-row" data-title={recTitle(r)} onClick={() => (selectMode ? onSelect(r.id) : setEdit(r))}>
              {selectMode && <input type="checkbox" checked={selected.has(r.id)} readOnly />}
              <span className={`rec-type t${r.type}`} title={r.type === 0 ? "Pomodoro" : "Stopwatch"} />
              <div className="grow">
                <div className="rec-time">{formatTime(recStart(r), meridiem)} - {formatTime(recEnd(r), meridiem)}</div>
                <div className="rec-title">{recTitle(r) || <span className="muted">Not linked</span>}</div>
                {r.note && <div className="rec-note small muted">{r.note}</div>}
              </div>
              <span className="rec-dur" data-testid="record-duration">{fmtMinutes(recMinutes(r))}</span>
            </div>
          ))}
        </div>
      ))}
      {edit && <RecordDialog rec={edit} type={edit.type} onClose={() => setEdit(null)} />}
    </div>
  );
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const dateInput = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const timeInput = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fromInputs = (date: string, time: string): number => {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return new Date(y!, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0).getTime();
};

/** Add (FOC-019) or edit (FOC-020) a record: any date, no window (FOC-802), not in the future. */
function RecordDialog({ rec, type, preset, onClose }: { rec?: FocusRecord; type: number; preset?: Binding; onClose: () => void }): JSX.Element {
  const m = useM4();
  const now = Date.now();
  const s0 = rec ? recStart(rec) : now - 25 * 60000;
  const e0 = rec ? recEnd(rec) : now;
  const [kind, setKind] = useState(type);
  const [date, setDate] = useState(dateInput(s0));
  const [start, setStart] = useState(timeInput(s0));
  const [end, setEnd] = useState(timeInput(e0));
  const [pause, setPause] = useState(String(Math.round((rec?.pauseDuration ?? 0) / 60)));
  const [adjust, setAdjust] = useState(String(Math.round((rec?.adjustTime ?? 0) / 60)));
  const [note, setNote] = useState(rec?.note ?? "");
  const b0 = rec ? recordBindings(rec)[0] : undefined;
  const [binding, setBinding] = useState<Binding | undefined>(preset ?? (b0 ? { kind: b0.owner === 0 ? "task" : b0.owner === 1 ? "habit" : "timer", id: b0.id, title: b0.title ?? recTitle(rec!), projectId: b0.projectId } : undefined));
  const [bindA, setBindA] = useState<Anchor | null>(null);
  const sMs = fromInputs(date, start);
  let eMs = fromInputs(date, end);
  if (eMs <= sMs) eMs += 86400000; // across midnight
  const err = eMs > now + 60000 ? "A record cannot end in the future" : eMs - sMs > 24 * 3600000 ? "A record is at most 24 hours" : "";
  const save = async (): Promise<void> => {
    if (err) return;
    const ref = binding
      ? [{ ...(binding.kind === "task" ? { taskId: binding.id, projectId: binding.projectId } : binding.kind === "habit" ? { habitId: binding.id } : { timerId: binding.id, timerName: binding.title }), title: binding.title, startTime: toServer(sMs), endTime: toServer(eMs) }]
      : [];
    await m.m4.saveFocus({ ...(rec ?? {}), id: rec?.id ?? newId(), type: kind, startTime: toServer(sMs), endTime: toServer(eMs), pauseDuration: Math.max(0, Number(pause) || 0) * 60, adjustTime: (Number(adjust) || 0) * 60, note, status: 1, tasks: ref });
    onClose();
  };
  return (
    <Modal onClose={onClose} className="m4-dialog" testId="record-dialog">
      <h3>{rec ? "Edit Record" : "Add Record"}</h3>
      <div className="m4-field">
        <label>Type</label>
        <div className="seg small" style={{ width: 240 }}>
          <button className={kind === 0 ? "on" : ""} onClick={() => setKind(0)}>Pomodoro</button>
          <button className={kind === 1 ? "on" : ""} onClick={() => setKind(1)}>Stopwatch</button>
        </div>
      </div>
      <div className="m4-field">
        <label>Linked to</label>
        <button className="bind-btn" data-testid="record-bind" onClick={(e) => setBindA(anchorOf(e.currentTarget))}><Link2 size={14} /> <span className="bind-title">{binding?.title ?? "Not linked"}</span></button>
      </div>
      <div className="record-times">
        <div className="m4-field"><label>Date</label><input className="field" type="date" value={date} max={dateInput(now)} data-testid="record-date" onChange={(e) => setDate(e.target.value)} /></div>
        <div className="m4-field"><label>Start</label><input className="field" type="time" value={start} data-testid="record-start" onChange={(e) => setStart(e.target.value)} /></div>
        <div className="m4-field"><label>End</label><input className="field" type="time" value={end} data-testid="record-end" onChange={(e) => setEnd(e.target.value)} /></div>
      </div>
      <div className="record-times">
        <div className="m4-field"><label>Paused (min)</label><input className="field num" type="number" min={0} value={pause} onChange={(e) => setPause(e.target.value)} /></div>
        <div className="m4-field"><label>Extra (min)</label><input className="field num" type="number" value={adjust} data-testid="record-adjust" onChange={(e) => setAdjust(e.target.value)} /></div>
        <div className="m4-field"><label>Focused</label><div className="record-total" data-testid="record-total">{fmtMinutes(Math.max(0, (eMs - sMs) / 60000 - (Number(pause) || 0) + (Number(adjust) || 0)))}</div></div>
      </div>
      <div className="m4-field"><label>Note</label><textarea className="field" rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      {err && <div className="error small">{err}</div>}
      <div className="row end">
        {rec && <button className="btn danger" data-testid="record-delete" onClick={() => void m.m4.deleteFocus([rec.id]).then(onClose)}>Delete</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!!err} data-testid="record-save" onClick={() => void save()}>Save</button>
      </div>
      {bindA && <BindPicker anchor={bindA} onClose={() => setBindA(null)} onPick={setBinding} />}
    </Modal>
  );
}

/** Focus record export (IMP-023), built in the browser; the server export route is a listed server change. */
function exportFocusCsv(recs: FocusRecord[]): void {
  const esc = (v: unknown): string => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [["Type", "Start", "End", "Focused minutes", "Paused minutes", "Linked", "Note"].join(",")];
  for (const r of [...recs].sort((a, b) => recStart(a) - recStart(b))) {
    rows.push([r.type === 0 ? "Pomodoro" : "Stopwatch", new Date(recStart(r)).toISOString(), new Date(recEnd(r)).toISOString(), Math.round(recMinutes(r)), Math.round((r.pauseDuration ?? 0) / 60), recTitle(r), r.note ?? ""].map(esc).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  a.download = "noortasks-focus.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Task detail line (FOC-017): logged focus beside the task. */
export function TaskFocusLine({ task }: { task: Task }): JSX.Element | null {
  const m = useM4();
  const recs = m.pomos.filter((r) => recordBindings(r).some((b) => b.owner === 0 && b.id === task.id));
  const sum = (task.focusSummaries ?? [])[0] as { pomoCount?: number; pomoDuration?: number; stopwatchDuration?: number; estimatedPomo?: number; estimatedDuration?: number } | undefined;
  const pomos = Math.max(sum?.pomoCount ?? 0, recs.filter((r) => r.type === 0).length);
  const minutes = Math.max((sum?.pomoDuration ?? 0) + (sum?.stopwatchDuration ?? 0), recs.reduce((a, r) => a + recMinutes(r), 0));
  if (!pomos && !minutes && !sum?.estimatedPomo) return null;
  return (
    <div className="task-focus-line" data-testid="task-focus">
      <span>{pomos} pomo{pomos === 1 ? "" : "s"}{sum?.estimatedPomo ? ` of ${sum.estimatedPomo}` : ""}</span>
      <span>{fmtMinutes(minutes)} focused</span>
    </div>
  );
}

