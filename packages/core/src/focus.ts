import { FocusType } from "./constants.js";
import { parseWireDate } from "./constants.js";
import { isPlainObject, type Loose } from "./unknown.js";

/** Focus times on the wire: epoch ms numbers, or server date strings (both accepted, stored as sent). */
export function toMs(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const p = parseWireDate(v);
    if (!Number.isNaN(p)) return p;
    const d = Date.parse(v);
    return Number.isNaN(d) ? NaN : d;
  }
  return NaN;
}

export interface FocusBinding {
  owner: 0 | 1 | 2;
  id: string;
  title?: string;
  projectId?: string;
  startMs?: number;
  endMs?: number;
}

/** Entries of `tasks[]` of a record as owner bindings (taskId 0, habitId 1, timerId 2). */
export function recordBindings(rec: Loose): FocusBinding[] {
  const out: FocusBinding[] = [];
  const list = Array.isArray(rec.tasks) ? rec.tasks : [];
  for (const t of list) {
    if (!isPlainObject(t)) continue;
    const owner: 0 | 1 | 2 | undefined = typeof t.taskId === "string" && t.taskId ? 0 : typeof t.habitId === "string" && t.habitId ? 1 : typeof t.timerId === "string" && t.timerId ? 2 : undefined;
    if (owner === undefined) continue;
    const id = (owner === 0 ? t.taskId : owner === 1 ? t.habitId : t.timerId) as string;
    const b: FocusBinding = { owner, id };
    if (typeof t.title === "string") b.title = t.title;
    if (typeof t.projectId === "string") b.projectId = t.projectId;
    const s = toMs(t.startTime);
    const e = toMs(t.endTime);
    if (!Number.isNaN(s)) b.startMs = s;
    if (!Number.isNaN(e)) b.endMs = e;
    out.push(b);
  }
  return out;
}

/**
 * Active focus time of a record in ms: the span minus pauses, plus `adjustTime`.
 * `pauseDuration` and `adjustTime` are seconds on the wire (assumption).
 */
export function recordActiveMs(rec: Loose): number {
  const s = toMs(rec.startTime);
  const e = toMs(rec.endTime);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  const pause = typeof rec.pauseDuration === "number" ? rec.pauseDuration * 1000 : 0;
  const adjust = typeof rec.adjustTime === "number" ? rec.adjustTime * 1000 : 0;
  return Math.max(0, e - s - pause + adjust);
}

export interface FocusSlice {
  id: string;
  type: number;
  startMs: number;
  endMs: number;
  /** Active ms after the overlap rule. */
  activeMs: number;
  rec: Loose;
}

/**
 * Overlap rule: records are never rejected. Sorted by start (then id), the part of a record that an
 * earlier record already covers is not counted again: its active time is scaled by the share of its span
 * that is new. Counts (how many pomodoros) are unaffected.
 */
export function effectiveSlices(records: Array<{ id: string; type: number; rec: Loose }>): FocusSlice[] {
  const rows = records
    .map((r) => ({ ...r, startMs: toMs(r.rec.startTime), endMs: toMs(r.rec.endTime) }))
    .filter((r) => !Number.isNaN(r.startMs) && !Number.isNaN(r.endMs))
    .sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));
  const out: FocusSlice[] = [];
  let covered = -Infinity;
  for (const r of rows) {
    const full = recordActiveMs(r.rec);
    const span = r.endMs - r.startMs;
    let active = full;
    if (span > 0 && covered > r.startMs) {
      const fresh = Math.max(0, r.endMs - Math.max(r.startMs, covered));
      active = Math.round((full * fresh) / span);
    } else if (span === 0 && covered > r.startMs) active = 0;
    covered = Math.max(covered, r.endMs);
    out.push({ id: r.id, type: r.type, startMs: r.startMs, endMs: r.endMs, activeMs: active, rec: r.rec });
  }
  return out;
}

// ------------------------------------------------------------------ live timer state (focus ops)

export type FocusOpName = "start" | "pause" | "continue" | "finish" | "exit" | "skip" | "workFinish" | "relaxFinish" | "autoPomoStart";

export interface FocusFragment {
  startTime: number;
  endTime: number | null;
}
/** Live timer state: fragment timings plus the owner and the status the server tracks. */
export interface FocusState extends Loose {
  id: string;
  type: number;
  status: "running" | "paused";
  fragments: FocusFragment[];
  startTime: number;
  endTime: number | null;
  pauseStartTime: number | null;
  /** ms */
  pauseDuration: number;
  /** ms of active focus up to the last op. */
  duration: number;
  sumOfPomo: number;
  lastPomoCompletedTime: number | null;
  speed: number;
  firstFocusId: string;
  autoPomoLeft: number;
  needSync: boolean;
  autoPomoStart: boolean;
  deviceId?: string;
}

export interface FocusOp extends Loose {
  id: string;
  /** focus session id the op belongs to */
  oId?: string;
  focusId?: string;
  op: string;
  time: number;
}

export function activeMsOf(s: FocusState, now?: number): number {
  let total = 0;
  for (const f of s.fragments) total += (f.endTime ?? (now ?? f.startTime)) - f.startTime;
  return Math.max(0, total);
}

export function opSessionId(op: FocusOp): string {
  return String(op.oId ?? op.focusId ?? op.firstId ?? op.firstFocusId ?? op.id);
}

/** Result of applying an op: the new state (null = no live timer) and the session that was replaced, if any. */
export function applyFocusOp(state: FocusState | null, op: FocusOp): { state: FocusState | null; replaced: FocusState | null } {
  const t = op.time;
  const sid = opSessionId(op);
  switch (op.op) {
    case "start":
    case "autoPomoStart": {
      const replaced = state && state.id !== sid ? state : null;
      if (state && state.id === sid && op.op === "start") return { state, replaced: null }; // duplicate start of the same session
      const type = typeof op.oType === "number" ? op.oType : typeof op.type === "number" ? op.type : FocusType.Pomodoro;
      const next: FocusState = {
        ...(isPlainObject(op.state) ? op.state : {}),
        id: sid,
        type,
        status: "running",
        fragments: [{ startTime: t, endTime: null }],
        startTime: t,
        endTime: null,
        pauseStartTime: null,
        pauseDuration: 0,
        duration: 0,
        sumOfPomo: typeof op.sumOfPomo === "number" ? op.sumOfPomo : 0,
        lastPomoCompletedTime: null,
        speed: typeof op.speed === "number" ? op.speed : 1,
        firstFocusId: String(op.firstId ?? op.firstFocusId ?? sid),
        autoPomoLeft: typeof op.autoPomoLeft === "number" ? op.autoPomoLeft : 0,
        needSync: false,
        autoPomoStart: op.op === "autoPomoStart",
      };
      for (const k of ["focusOnId", "focusOnType", "focusOnTitle", "taskId", "habitId", "timerId", "projectId", "note"]) if (op[k] !== undefined) next[k] = op[k];
      if (typeof op.deviceId === "string") next.deviceId = op.deviceId;
      return { state: next, replaced };
    }
    case "pause": {
      if (!state || state.id !== sid || state.status !== "running") return { state, replaced: null };
      const frags = state.fragments.map((f, i) => (i === state.fragments.length - 1 ? { ...f, endTime: Math.max(f.startTime, t) } : f));
      const next = { ...state, status: "paused" as const, fragments: frags, pauseStartTime: t };
      next.duration = activeMsOf(next);
      return { state: next, replaced: null };
    }
    case "continue":
    case "resume": {
      if (!state || state.id !== sid || state.status !== "paused") return { state, replaced: null };
      const pauseStart = state.pauseStartTime ?? t;
      const next = {
        ...state,
        status: "running" as const,
        pauseStartTime: null,
        pauseDuration: state.pauseDuration + Math.max(0, t - pauseStart),
        fragments: [...state.fragments, { startTime: Math.max(t, pauseStart), endTime: null }],
      };
      return { state: next, replaced: null };
    }
    case "workFinish": {
      if (!state || state.id !== sid) return { state, replaced: null };
      return { state: { ...state, sumOfPomo: state.sumOfPomo + 1, lastPomoCompletedTime: t }, replaced: null };
    }
    case "finish":
    case "exit":
    case "drop": {
      if (!state || state.id !== sid) return { state, replaced: null };
      return { state: null, replaced: null };
    }
    default:
      return { state, replaced: null };
  }
}

/** Final summary of a session when it ends (used to answer `finish`). */
export function finishedSummary(state: FocusState, t: number): Loose {
  const frags = state.fragments.map((f, i) => (i === state.fragments.length - 1 && f.endTime === null ? { ...f, endTime: Math.max(f.startTime, t) } : f));
  const closed: FocusState = { ...state, fragments: frags, endTime: t };
  return { ...closed, duration: activeMsOf(closed) };
}
