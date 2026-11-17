import type { FocusRecord, FocusTaskRef, PomoPrefs } from "../data/m4types";
import { toServer } from "../lib/dates";

/**
 * Focus timer state machine (FOC-004..FOC-013, FOC-026, FOC-801). Pure: every function takes the clock as an
 * argument and derives time from wall-clock timestamps, never from tick counts, so a background tab that wakes late
 * still ends the pomodoro at its scheduled moment, and a reload resumes from the stored state.
 *
 * Phases: a pomodoro run alternates work and break phases; each phase is its own focus session (own session id).
 * Session ids of one run are derived from the run's base id, so two devices that both see a phase end derive the
 * same next id and push the same record id (a double push is an update, not a duplicate).
 */
export type TimerMode = "pomo" | "stopwatch";
export type Phase = "work" | "short" | "long";
export type TimerStatus = "running" | "paused" | "idle";

export interface Binding {
  kind: "task" | "habit" | "timer";
  id: string;
  title: string;
  projectId?: string;
}

export interface Fragment {
  startTime: number;
  endTime: number | null;
}

export interface TimerState {
  /** session id of the current phase (focus op `oId`, and the record id of a work phase) */
  sessionId: string;
  /** base id of the run; phase n gets deriveId(baseId, n) */
  baseId: string;
  /** phase index inside the run (0 = first work phase) */
  index: number;
  mode: TimerMode;
  phase: Phase;
  /** idle = a phase is prepared but not started (break or next pomodoro waiting for Start) */
  status: TimerStatus;
  startTime: number;
  fragments: Fragment[];
  pauseStart: number | null;
  /** ms */
  pauseMs: number;
  /** planned length of the phase in ms (0 for the stopwatch) */
  plannedMs: number;
  /** work phases completed in this run */
  cycle: number;
  binding?: Binding;
  note: string;
  strict: boolean;
  deviceId: string;
  /** true once the server acknowledged the start of this session */
  synced: boolean;
}

/** Phase n of a run: the base id with its last 4 hex digits replaced by n (stays a 24-hex ObjectId). */
export function deriveId(baseId: string, n: number): string {
  if (n === 0) return baseId;
  const tail = (parseInt(baseId.slice(-4), 16) + n) & 0xffff;
  return baseId.slice(0, -4) + tail.toString(16).padStart(4, "0");
}

export interface StartOpts {
  mode: TimerMode;
  baseId: string;
  now: number;
  deviceId: string;
  prefs: Pick<PomoPrefs, "pomoDuration">;
  binding?: Binding;
  strict?: boolean;
  note?: string;
  /** minutes, overrides the preference (timer cards with their own length) */
  minutes?: number;
}

export function startTimer(o: StartOpts): TimerState {
  const minutes = o.mode === "pomo" ? Math.max(5, o.minutes ?? o.prefs.pomoDuration) : 0;
  return {
    sessionId: o.baseId,
    baseId: o.baseId,
    index: 0,
    mode: o.mode,
    phase: "work",
    status: "running",
    startTime: o.now,
    fragments: [{ startTime: o.now, endTime: null }],
    pauseStart: null,
    pauseMs: 0,
    plannedMs: minutes * 60_000,
    cycle: 0,
    binding: o.binding,
    note: o.note ?? "",
    strict: o.mode === "pomo" && !!o.strict,
    deviceId: o.deviceId,
    synced: false,
  };
}

export function activeMs(s: TimerState, now: number): number {
  let t = 0;
  for (const f of s.fragments) t += Math.max(0, (f.endTime ?? now) - f.startTime);
  return t;
}
export function remainingMs(s: TimerState, now: number): number {
  return s.mode === "stopwatch" ? 0 : Math.max(0, s.plannedMs - activeMs(s, now));
}
/** Wall-clock moment the running phase reaches its planned length. */
export function dueAt(s: TimerState): number {
  if (s.mode === "stopwatch" || s.status !== "running") return Infinity;
  const closed = s.fragments.filter((f) => f.endTime !== null).reduce((a, f) => a + (f.endTime! - f.startTime), 0);
  const open = s.fragments.find((f) => f.endTime === null);
  return open ? open.startTime + (s.plannedMs - closed) : Infinity;
}
export const isDue = (s: TimerState, now: number): boolean => s.mode === "pomo" && s.status === "running" && now >= dueAt(s);

/** Display value: pomodoro counts down, stopwatch counts up (FOC-012). */
export function displayMs(s: TimerState, now: number): number {
  return s.mode === "pomo" ? remainingMs(s, now) : activeMs(s, now);
}
export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function pauseTimer(s: TimerState, now: number): TimerState {
  if (s.status !== "running" || s.strict) return s;
  const fragments = s.fragments.map((f) => (f.endTime === null ? { ...f, endTime: Math.max(f.startTime, now) } : f));
  return { ...s, status: "paused", fragments, pauseStart: now };
}
export function resumeTimer(s: TimerState, now: number): TimerState {
  if (s.status === "paused") {
    const start = Math.max(now, s.pauseStart ?? now);
    return { ...s, status: "running", pauseStart: null, pauseMs: s.pauseMs + Math.max(0, now - (s.pauseStart ?? now)), fragments: [...s.fragments, { startTime: start, endTime: null }] };
  }
  if (s.status === "idle") return { ...s, status: "running", startTime: now, fragments: [{ startTime: now, endTime: null }], pauseStart: null, pauseMs: 0 };
  return s;
}

/** The phase that follows a finished work phase: every `longBreakInterval`-th pomodoro gets the long break (FOC-007). */
export function breakAfter(cycle: number, prefs: Pick<PomoPrefs, "shortBreakDuration" | "longBreakDuration" | "longBreakInterval">): { phase: Phase; minutes: number } {
  const interval = Math.max(1, prefs.longBreakInterval || 4);
  return cycle > 0 && cycle % interval === 0 ? { phase: "long", minutes: prefs.longBreakDuration } : { phase: "short", minutes: prefs.shortBreakDuration };
}

export interface PhaseEnd {
  /** focus record of a finished work phase (none for breaks) */
  record?: FocusRecord;
  /** the next phase, running when auto start is on, idle otherwise */
  next: TimerState;
}

type CyclePrefs = Pick<PomoPrefs, "pomoDuration" | "shortBreakDuration" | "longBreakDuration" | "longBreakInterval" | "autoPomo" | "autoBreak">;

/** A pomodoro phase reached its end at `end` (= dueAt for a timer that ran out). */
export function completePhase(s: TimerState, prefs: CyclePrefs, end: number): PhaseEnd {
  const closed = closeAt(s, end);
  const index = s.index + 1;
  const sessionId = deriveId(s.baseId, index);
  if (s.phase === "work") {
    const cycle = s.cycle + 1;
    const b = breakAfter(cycle, prefs);
    const next: TimerState = { ...fresh(s, sessionId, index, end, prefs.autoBreak), phase: b.phase, plannedMs: b.minutes * 60_000, cycle };
    return { record: toRecord(closed, end), next };
  }
  return { next: { ...fresh(s, sessionId, index, end, prefs.autoPomo), phase: "work", plannedMs: Math.max(5, prefs.pomoDuration) * 60_000 } };
}

function fresh(s: TimerState, sessionId: string, index: number, at: number, running: boolean): TimerState {
  return { ...s, sessionId, index, status: running ? "running" : "idle", startTime: at, fragments: running ? [{ startTime: at, endTime: null }] : [], pauseStart: null, pauseMs: 0, note: "", synced: false };
}

function closeAt(s: TimerState, end: number): TimerState {
  return { ...s, fragments: s.fragments.map((f) => (f.endTime === null ? { ...f, endTime: Math.max(f.startTime, end) } : f)) };
}

/**
 * The user ends the session. Stopwatch: the record covers what ran. Pomodoro ended early: a record is kept when at
 * least one minute was focused (our rule for early completion). Breaks give none.
 */
export function finishTimer(s: TimerState, now: number, extraMinutes = 0): FocusRecord | undefined {
  if (s.phase !== "work" || s.status === "idle") return undefined;
  const end = s.status === "paused" ? (s.pauseStart ?? now) : now;
  const closed = closeAt(s, end);
  if (activeMs(closed, end) < 60_000 && extraMinutes <= 0) return undefined;
  return toRecord(closed, end, extraMinutes);
}

/** Record shape: times as server dates, pause and adjust in seconds, bound owner in tasks[]. */
export function toRecord(s: TimerState, end: number, extraMinutes = 0): FocusRecord {
  const first = s.fragments[0]?.startTime ?? s.startTime;
  const pauseSec = Math.round((end - first - activeMs(s, end)) / 1000);
  const ref: FocusTaskRef[] = s.binding
    ? [
        {
          ...(s.binding.kind === "task" ? { taskId: s.binding.id, projectId: s.binding.projectId } : s.binding.kind === "habit" ? { habitId: s.binding.id } : { timerId: s.binding.id, timerName: s.binding.title }),
          title: s.binding.title,
          startTime: toServer(first),
          endTime: toServer(end),
        },
      ]
    : [];
  return {
    id: s.sessionId,
    type: s.mode === "pomo" ? 0 : 1,
    startTime: toServer(first),
    endTime: toServer(end),
    pauseDuration: Math.max(0, pauseSec),
    adjustTime: Math.round(extraMinutes * 60),
    note: s.note,
    status: 1,
    tasks: ref,
  };
}

// ------------------------------------------------------------------ focus ops (cross-device)

export interface FocusOpOut {
  id: string;
  oId: string;
  op: string;
  time: number;
  oType: number;
  deviceId: string;
  [k: string]: unknown;
}

/** An op for the server log. `start` carries the phase, plan and binding in `state` so followers can rebuild it. */
export function opFor(op: "start" | "pause" | "continue" | "finish" | "exit" | "workFinish", s: TimerState, time: number, id: string): FocusOpOut {
  const out: FocusOpOut = { id, oId: s.sessionId, op, time, oType: s.mode === "pomo" ? 0 : 1, deviceId: s.deviceId };
  if (op === "start") {
    out.state = { plannedMs: s.plannedMs, phase: s.phase, cycle: s.cycle, baseId: s.baseId, index: s.index, strict: s.strict, note: s.note, binding: s.binding ?? null };
    if (s.binding) {
      out.focusOnId = s.binding.id;
      out.focusOnType = s.binding.kind === "task" ? 0 : s.binding.kind === "habit" ? 1 : 2;
      out.focusOnTitle = s.binding.title;
    }
    // a resumed-from-idle phase or a takeover start begins at its first fragment
    out.time = s.fragments[0]?.startTime ?? time;
  }
  return out;
}

/** Server `current` (FocusState with our `state` fields spread in) -> local state. */
export function fromRemote(cur: Record<string, unknown>, deviceId: string): TimerState {
  const frags = (Array.isArray(cur.fragments) ? cur.fragments : []) as Fragment[];
  const binding = (cur.binding ?? undefined) as Binding | undefined;
  return {
    sessionId: String(cur.id),
    baseId: typeof cur.baseId === "string" ? cur.baseId : String(cur.id),
    index: typeof cur.index === "number" ? cur.index : 0,
    mode: cur.type === 1 ? "stopwatch" : "pomo",
    phase: cur.phase === "short" || cur.phase === "long" ? cur.phase : "work",
    status: cur.status === "paused" ? "paused" : "running",
    startTime: Number(cur.startTime),
    fragments: frags.map((f) => ({ startTime: Number(f.startTime), endTime: f.endTime === null || f.endTime === undefined ? null : Number(f.endTime) })),
    pauseStart: typeof cur.pauseStartTime === "number" ? cur.pauseStartTime : null,
    pauseMs: Number(cur.pauseDuration) || 0,
    plannedMs: typeof cur.plannedMs === "number" ? cur.plannedMs : 25 * 60_000,
    cycle: typeof cur.cycle === "number" ? cur.cycle : 0,
    binding: binding ?? undefined,
    note: typeof cur.note === "string" ? cur.note : "",
    strict: !!cur.strict,
    deviceId,
    synced: true,
  };
}

export type Reconcile = { kind: "keep" } | { kind: "adopt"; state: TimerState } | { kind: "drop" };

/**
 * Follow the server's live timer (FOC-027). Only call with no local op in flight.
 * - another session runs on the server: adopt it (a start elsewhere replaced ours, FOC-801)
 * - same session: take its status (pause or resume pressed on another device)
 * - no session on the server while ours was acknowledged: it ended elsewhere, drop it
 * - ours was never acknowledged (offline start): keep it
 */
export function reconcile(local: TimerState | null, remote: Record<string, unknown> | null, deviceId: string): Reconcile {
  if (!remote) {
    if (local && local.synced && local.status !== "idle") return { kind: "drop" };
    return { kind: "keep" };
  }
  if (!local || local.status === "idle" || local.sessionId !== remote.id) return { kind: "adopt", state: fromRemote(remote, deviceId) };
  const r = fromRemote(remote, deviceId);
  if (r.status !== local.status || r.fragments.length !== local.fragments.length) return { kind: "adopt", state: { ...r, note: local.note || r.note } };
  return local.synced ? { kind: "keep" } : { kind: "adopt", state: { ...local, synced: true } };
}
