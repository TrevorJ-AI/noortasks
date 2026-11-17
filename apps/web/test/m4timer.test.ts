import { describe, expect, it } from "vitest";
import { POMO_DEFAULTS } from "../src/data/m4types";
import { applyFocusOp, type FocusOp } from "../src/lib/m4core";
import { activeMs, breakAfter, completePhase, deriveId, displayMs, dueAt, finishTimer, formatClock, fromRemote, isDue, opFor, pauseTimer, reconcile, remainingMs, resumeTimer, startTimer, type TimerState } from "../src/model/timer";

/** Focus timer state machine (FOC-004..FOC-013, FOC-026, FOC-801): pure, clock injected. */
const T0 = Date.UTC(2026, 10, 16, 8, 0, 0);
const MIN = 60_000;
const base = "65a0f0c0aabbccddeeff0000";
const prefs = { ...POMO_DEFAULTS };
const pomo = (p: Partial<Parameters<typeof startTimer>[0]> = {}): TimerState => startTimer({ mode: "pomo", baseId: base, now: T0, deviceId: "devA", prefs, ...p });

describe("start and display (FOC-004, FOC-012)", () => {
  it("a pomodoro counts down from the focus length, a stopwatch counts up from zero", () => {
    const s = pomo();
    expect(formatClock(displayMs(s, T0))).toBe("25:00");
    expect(formatClock(displayMs(s, T0 + 90_000))).toBe("23:30");
    const w = startTimer({ mode: "stopwatch", baseId: base, now: T0, deviceId: "devA", prefs });
    expect(displayMs(w, T0)).toBe(0);
    expect(formatClock(displayMs(w, T0 + 3_725_000))).toBe("1:02:05");
    expect(isDue(w, T0 + 10 * 3600_000)).toBe(false); // no preset end
  });
  it("focus lengths under 5 minutes run as 5, 50 runs as 50", () => {
    expect(pomo({ prefs: { pomoDuration: 3 } }).plannedMs).toBe(5 * MIN);
    expect(formatClock(displayMs(pomo({ prefs: { pomoDuration: 50 } }), T0))).toBe("50:00");
  });
  it("strict mode only applies to pomodoros (FOC-012)", () => {
    expect(pomo({ strict: true }).strict).toBe(true);
    expect(startTimer({ mode: "stopwatch", baseId: base, now: T0, deviceId: "d", prefs, strict: true }).strict).toBe(false);
    const s = pomo({ strict: true });
    expect(pauseTimer(s, T0 + MIN)).toBe(s); // strict: pause refused
  });
});

describe("pause and resume (FOC-013)", () => {
  it("resume opens a new fragment and adds the paused time to pauseMs", () => {
    let s = pomo();
    s = pauseTimer(s, T0 + 10 * MIN);
    expect(s.status).toBe("paused");
    expect(s.fragments).toEqual([{ startTime: T0, endTime: T0 + 10 * MIN }]);
    expect(remainingMs(s, T0 + 30 * MIN)).toBe(15 * MIN); // paused: the clock stands still
    s = resumeTimer(s, T0 + 13 * MIN);
    expect(s.fragments).toHaveLength(2);
    expect(s.fragments[1]).toEqual({ startTime: T0 + 13 * MIN, endTime: null });
    expect(s.pauseMs).toBe(3 * MIN);
    expect(activeMs(s, T0 + 14 * MIN)).toBe(11 * MIN);
    expect(dueAt(s)).toBe(T0 + 28 * MIN); // 25 minutes of focus plus the 3 minute pause
  });
  it("a reload restores the timer: the state is plain JSON and time comes from timestamps", () => {
    const s = resumeTimer(pauseTimer(pomo(), T0 + 5 * MIN), T0 + 6 * MIN);
    const back = JSON.parse(JSON.stringify(s)) as TimerState;
    expect(displayMs(back, T0 + 16 * MIN)).toBe(displayMs(s, T0 + 16 * MIN));
    expect(displayMs(back, T0 + 16 * MIN)).toBe(10 * MIN);
  });
});

describe("phase ends, also in a background tab (FOC-005..FOC-009)", () => {
  it("a tab that wakes late ends the pomodoro at its scheduled moment, not at wake-up", () => {
    const s = pomo();
    const wake = T0 + 40 * MIN; // the tab slept through the end
    expect(isDue(s, wake)).toBe(true);
    const out = completePhase(s, prefs, dueAt(s));
    expect(out.record!.endTime).toBe("2026-11-16T08:25:00.000+0000");
    expect(out.record!.id).toBe(base);
    expect(out.record!.type).toBe(0);
    expect(out.next.phase).toBe("short");
    expect(out.next.plannedMs).toBe(5 * MIN);
    expect(out.next.status).toBe("idle"); // autoBreak off: the break waits for Start
    expect(out.next.cycle).toBe(1);
  });
  it("short break 10, long break 20 after every 4th pomodoro, interval 2 gives a long break after the 2nd", () => {
    const p = { ...prefs, shortBreakDuration: 10, longBreakDuration: 20 };
    expect(breakAfter(1, p)).toEqual({ phase: "short", minutes: 10 });
    expect(breakAfter(4, p)).toEqual({ phase: "long", minutes: 20 });
    expect(breakAfter(2, { ...p, longBreakInterval: 2 })).toEqual({ phase: "long", minutes: 20 });
  });
  it("auto mode: the break starts by itself, then the next pomodoro (FOC-009)", () => {
    const auto = { ...prefs, autoBreak: true, autoPomo: true };
    const a = completePhase(pomo(), auto, T0 + 25 * MIN);
    expect(a.next.status).toBe("running");
    expect(a.next.fragments[0]!.startTime).toBe(T0 + 25 * MIN);
    expect(isDue(a.next, T0 + 30 * MIN)).toBe(true);
    const b = completePhase(a.next, auto, dueAt(a.next));
    expect(b.record).toBeUndefined(); // breaks leave no record
    expect(b.next.phase).toBe("work");
    expect(b.next.status).toBe("running");
    expect(b.next.sessionId).toBe(deriveId(base, 2));
  });
  it("phase ids are derived from the run, so two devices write the same record id", () => {
    expect(deriveId(base, 0)).toBe(base);
    expect(deriveId(base, 3)).toBe("65a0f0c0aabbccddeeff0003");
    expect(deriveId(base, 3)).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe("finishing (FOC-023)", () => {
  it("a stopwatch record carries type 1, pause in seconds and extra minutes as adjustTime", () => {
    let s = startTimer({ mode: "stopwatch", baseId: base, now: T0, deviceId: "d", prefs, binding: { kind: "task", id: "t1", title: "Write report", projectId: "p1" } });
    s = resumeTimer(pauseTimer(s, T0 + 10 * MIN), T0 + 12 * MIN);
    const r = finishTimer({ ...s, note: "went well" }, T0 + 30 * MIN, 5)!;
    expect(r.type).toBe(1);
    expect(r.pauseDuration).toBe(120);
    expect(r.adjustTime).toBe(300);
    expect(r.note).toBe("went well");
    expect(r.tasks).toEqual([{ taskId: "t1", projectId: "p1", title: "Write report", startTime: "2026-11-16T08:00:00.000+0000", endTime: "2026-11-16T08:30:00.000+0000" }]);
  });
  it("ending under a minute writes nothing; a break never writes a record", () => {
    expect(finishTimer(pomo(), T0 + 30_000)).toBeUndefined();
    const brk = completePhase(pomo(), { ...prefs, autoBreak: true }, T0 + 25 * MIN).next;
    expect(finishTimer(brk, T0 + 28 * MIN)).toBeUndefined();
  });
  it("habit and timer bindings use habitId and timerId (FOC-014)", () => {
    const h = finishTimer(pomo({ binding: { kind: "habit", id: "h1", title: "Read" } }), T0 + 10 * MIN)!;
    expect(h.tasks![0]).toMatchObject({ habitId: "h1", title: "Read" });
    const t = finishTimer(pomo({ binding: { kind: "timer", id: "x1", title: "Reading" } }), T0 + 10 * MIN)!;
    expect(t.tasks![0]).toMatchObject({ timerId: "x1", timerName: "Reading" });
  });
});

describe("cross-device follow and takeover (FOC-026, FOC-027, FOC-801)", () => {
  const server = (ops: FocusOp[]) => ops.reduce((st, op) => applyFocusOp(st, op).state, null as ReturnType<typeof applyFocusOp>["state"]);
  it("the server state built from our start op rebuilds the same timer on another device", () => {
    const a = pomo({ binding: { kind: "task", id: "t1", title: "Essay" } });
    const cur = server([opFor("start", a, T0, "op1") as FocusOp]);
    const b = fromRemote(cur as never, "devB");
    expect(b.sessionId).toBe(a.sessionId);
    expect(b.plannedMs).toBe(25 * MIN);
    expect(b.binding).toEqual({ kind: "task", id: "t1", title: "Essay" });
    expect(b.deviceId).toBe("devB");
    expect(displayMs(b, T0 + 5 * MIN)).toBe(displayMs(a, T0 + 5 * MIN));
  });
  it("pause on one device: the other adopts the paused state", () => {
    const a = pomo();
    const paused = pauseTimer(a, T0 + 4 * MIN);
    const cur = server([opFor("start", a, T0, "1") as FocusOp, opFor("pause", paused, T0 + 4 * MIN, "2") as FocusOp]);
    const r = reconcile({ ...a, synced: true }, cur as never, "devB");
    expect(r.kind).toBe("adopt");
    if (r.kind === "adopt") {
      expect(r.state.status).toBe("paused");
      expect(displayMs(r.state, T0 + 20 * MIN)).toBe(21 * MIN);
    }
  });
  it("a start elsewhere replaces ours (takeover); an end elsewhere drops ours", () => {
    const mine = { ...pomo(), synced: true };
    const other = startTimer({ mode: "stopwatch", baseId: "65a0f0c0aabbccddeeff1111", now: T0 + MIN, deviceId: "devB", prefs });
    const cur = server([opFor("start", mine, T0, "1") as FocusOp, opFor("start", other, T0 + MIN, "2") as FocusOp]);
    const r = reconcile(mine, cur as never, "devA");
    expect(r.kind).toBe("adopt");
    if (r.kind === "adopt") expect(r.state.mode).toBe("stopwatch");
    expect(reconcile(mine, null, "devA").kind).toBe("drop");
  });
  it("an unacknowledged local start (offline) is kept when the server knows nothing", () => {
    expect(reconcile(pomo(), null, "devA").kind).toBe("keep");
    expect(reconcile(null, null, "devA").kind).toBe("keep");
  });
});
