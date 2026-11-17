import { newId } from "../lib/core";
import { completePhase, finishTimer, isDue, opFor, pauseTimer, reconcile, resumeTimer, startTimer, dueAt, type Binding, type FocusOpOut, type TimerMode, type TimerState } from "../model/timer";
import { OfflineError } from "./api";
import type { M4Repo } from "./m4repo";
import { POMO_DEFAULTS, type FocusRecord, type PomoPrefs } from "./m4types";
import type { SyncEngine } from "./sync";

/**
 * Runs the live focus timer of this device: persists it (localStorage pomoState / stopwatchState, SET-279), ends
 * phases on time even after the tab slept, writes the focus record of a finished work phase, and, when Sync Across
 * Devices is on (ext.focusConf.keepInSync, FOC-027), pushes focus ops and follows the server's live timer by polling
 * `GET /api/v2/batch/focusOp` every 2 seconds.
 */
export interface FocusEnv {
  prefs: () => PomoPrefs;
  keepInSync: () => boolean;
  /** a work phase ended: e.g. play the end sound, offer the kanban Progress column */
  onPhaseEnd?: (s: TimerState, record?: FocusRecord) => void;
}

const LS_POMO = "pomoState";
const LS_WATCH = "stopwatchState";
const LS_GLOBAL_POMO = "globalPomoState";
const LS_GLOBAL_WATCH = "globalStopwatchState";

export function deviceId(): string {
  let id = localStorage.getItem("noorDeviceId");
  if (!id) {
    id = newId();
    localStorage.setItem("noorDeviceId", id);
  }
  return id;
}

export class FocusController {
  state: TimerState | null = null;
  private listeners = new Set<() => void>();
  private inflight = 0;
  private since = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  readonly device = deviceId();
  /** session id of the last session another device replaced or ended, for the UI notice */
  lastRemoteEvent: { kind: "adopt" | "drop"; at: number } | null = null;

  constructor(
    readonly engine: SyncEngine,
    readonly m4: M4Repo,
    readonly env: FocusEnv,
  ) {
    this.state = this.load();
    this.since = Number(localStorage.getItem("focusOptionCommitPoint") ?? 0) || 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }

  private load(): TimerState | null {
    for (const k of [LS_POMO, LS_WATCH]) {
      try {
        const v = localStorage.getItem(k);
        if (v) {
          const s = JSON.parse(v) as TimerState;
          if (s && s.sessionId) return s;
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }
  private save(): void {
    const s = this.state;
    localStorage.removeItem(s?.mode === "pomo" ? LS_WATCH : LS_POMO);
    if (s) {
      localStorage.setItem(s.mode === "pomo" ? LS_POMO : LS_WATCH, JSON.stringify(s));
      localStorage.setItem("focusTimerType", JSON.stringify(s.mode));
      localStorage.setItem("pomoInfo", JSON.stringify({ cycle: s.cycle, phase: s.phase, index: s.index }));
      if (s.binding?.kind === "task") {
        localStorage.setItem("focusTaskId", JSON.stringify(s.binding.id));
        if (s.binding.projectId) localStorage.setItem("pomoTaskProjectId", JSON.stringify(s.binding.projectId));
      }
      localStorage.setItem("focusNote", JSON.stringify(s.note));
    } else {
      localStorage.removeItem(LS_POMO);
      localStorage.removeItem(LS_WATCH);
    }
  }
  private set(s: TimerState | null): void {
    this.state = s;
    this.save();
    this.emit();
  }

  /** Start ticking and (when sync is on) polling. Idempotent. */
  run(): () => void {
    if (!this.tickTimer) this.tickTimer = setInterval(() => void this.tick(), 500);
    if (!this.pollTimer) this.pollTimer = setInterval(() => void this.poll(), 2000);
    const vis = (): void => void this.tick();
    document.addEventListener("visibilitychange", vis);
    void this.tick();
    void this.poll();
    return () => {
      document.removeEventListener("visibilitychange", vis);
      if (this.tickTimer) clearInterval(this.tickTimer);
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.tickTimer = this.pollTimer = null;
    };
  }

  // ---------------------------------------------------------------- user actions
  /** Is another timer live here or on the server? (FOC-801 asks before replacing it.) */
  busy(): boolean {
    return !!this.state && this.state.status !== "idle";
  }

  async start(mode: TimerMode, opts: { binding?: Binding; strict?: boolean; minutes?: number; now?: number } = {}): Promise<void> {
    const now = opts.now ?? Date.now();
    const s = startTimer({ mode, baseId: newId(now), now, deviceId: this.device, prefs: this.env.prefs(), binding: opts.binding, strict: opts.strict, minutes: opts.minutes });
    if (opts.minutes) localStorage.setItem("recentFocusTimerPomoTime", JSON.stringify(opts.minutes));
    this.set(s);
    await this.send([opFor("start", s, now, newId())]);
  }
  async pause(now = Date.now()): Promise<void> {
    if (!this.state) return;
    const s = pauseTimer(this.state, now);
    if (s === this.state) return;
    this.set(s);
    await this.send([opFor("pause", s, now, newId())]);
  }
  async resume(now = Date.now()): Promise<void> {
    if (!this.state) return;
    const wasIdle = this.state.status === "idle";
    const s = resumeTimer(this.state, now);
    this.set(s);
    await this.send([opFor(wasIdle ? "start" : "continue", s, now, newId())]);
  }
  setNote(note: string): void {
    if (this.state) this.set({ ...this.state, note });
  }
  setBinding(binding: Binding | undefined): void {
    if (this.state) this.set({ ...this.state, binding });
  }
  /** End now (FOC-023: optional extra minutes). Returns the record written, if any. */
  async finish(extraMinutes = 0, now = Date.now()): Promise<FocusRecord | undefined> {
    const s = this.state;
    if (!s) return undefined;
    const rec = finishTimer(s, now, extraMinutes);
    this.set(null);
    if (rec) await this.m4.saveFocus(rec);
    await this.send([opFor("finish", s, now, newId())]);
    return rec;
  }
  /** Give up or skip: no record (strict mode's only way out). */
  async exit(now = Date.now()): Promise<void> {
    const s = this.state;
    if (!s) return;
    this.set(null);
    if (s.status !== "idle") await this.send([opFor("exit", s, now, newId())]);
  }
  /** Skip the waiting break (or the running one) and prepare the next pomodoro. */
  async skipBreak(now = Date.now()): Promise<void> {
    const s = this.state;
    if (!s || s.phase === "work") return;
    const end = completePhase(s, { ...this.env.prefs(), autoPomo: false }, now);
    if (s.status !== "idle") await this.send([opFor("exit", s, now, newId())]);
    this.set(end.next);
  }

  // ---------------------------------------------------------------- clock
  async tick(now = Date.now()): Promise<void> {
    const s = this.state;
    if (!s || !isDue(s, now)) return;
    // the phase ended at its scheduled moment, also when this tab slept past it
    const end = dueAt(s);
    const out = completePhase(s, this.env.prefs(), end);
    this.set(out.next);
    if (out.record) await this.m4.saveFocus(out.record);
    const ops: FocusOpOut[] = [];
    if (s.phase === "work") ops.push(opFor("workFinish", s, end, `${s.sessionId}:wf`));
    ops.push(opFor("finish", s, end, `${s.sessionId}:fin`));
    if (out.next.status === "running") ops.push(opFor("start", out.next, end, `${out.next.sessionId}:start`));
    this.env.onPhaseEnd?.(s, out.record);
    await this.send(ops);
    // auto mode can chain: a long sleep may have passed several phases
    if (this.state && isDue(this.state, now)) await this.tick(now);
  }

  // ---------------------------------------------------------------- server
  private async send(ops: FocusOpOut[]): Promise<void> {
    if (!this.env.keepInSync() || ops.length === 0) return;
    this.inflight++;
    try {
      const res = await this.engine.api.post<{ checkPoint: number; current: Record<string, unknown> | null }>(`/api/v2/batch/focusOp`, { ops, since: this.since });
      this.since = res?.checkPoint ?? this.since;
      localStorage.setItem("focusOptionCommitPoint", String(this.since));
      const s = this.state;
      if (s && res?.current && res.current.id === s.sessionId && !s.synced) this.set({ ...s, synced: true });
    } catch (e) {
      if (e instanceof OfflineError) for (const op of ops) await this.engine.enqueue("focusOp", op.id, op as never);
    } finally {
      this.inflight--;
    }
  }

  async poll(): Promise<void> {
    if (!this.env.keepInSync() || this.inflight > 0) return;
    try {
      const res = await this.engine.api.get<{ checkPoint: number; current: Record<string, unknown> | null }>(`/api/v2/batch/focusOp?since=${this.since}`);
      if (this.inflight > 0 || !res) return;
      this.since = res.checkPoint;
      localStorage.setItem("focusOptionCommitPoint", String(this.since));
      localStorage.setItem(res.current?.type === 1 ? LS_GLOBAL_WATCH : LS_GLOBAL_POMO, JSON.stringify(res.current));
      const r = reconcile(this.state, res.current, this.device);
      if (r.kind === "adopt") {
        if (this.state?.sessionId !== r.state.sessionId) this.lastRemoteEvent = { kind: "adopt", at: Date.now() };
        this.set(r.state);
      } else if (r.kind === "drop") {
        this.lastRemoteEvent = { kind: "drop", at: Date.now() };
        this.set(null);
      }
    } catch {
      /* offline: keep the local timer */
    }
  }
}

export const defaultPrefs = (p: Partial<PomoPrefs> | null | undefined): PomoPrefs => ({ ...POMO_DEFAULTS, ...(p ?? {}) });
