import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { Api } from "../src/data/api";
import { NoorDb } from "../src/data/db";
import { FocusController, defaultPrefs } from "../src/data/focusController";
import { M4Repo, newHabit } from "../src/data/m4repo";
import { Repo } from "../src/data/repo";
import { SyncEngine } from "../src/data/sync";
import { CheckinStatus, HabitType } from "../src/lib/core";
import { toServer } from "../src/lib/dates";

/** M4 data paths against the real server in-process: habits, check-ins, focus records, prefs, countdowns, live focus ops. */
let base = "";
let close: () => Promise<void>;
let dir = "";
let n = 0;

// node has no localStorage or document: tiny in-memory stand-ins for the focus controller
class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
const g = globalThis as unknown as { localStorage: MemStorage; document: unknown };
g.localStorage = new MemStorage();
g.document = { addEventListener() {}, removeEventListener() {} };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nt-m4-"));
  const { app } = buildApp({ noAuth: true, dataDir: join(dir, "files"), dbPath: join(dir, "db.sqlite") });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  close = () => app.close();
});
afterAll(async () => {
  await close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => g.localStorage.clear());

async function client() {
  const db = new NoorDb(`m4-${++n}-${Math.random()}`);
  const engine = new SyncEngine(db, new Api({ base }));
  engine.m4Always = true;
  const repo = new Repo(db, engine);
  const m4 = new M4Repo(db, engine);
  await engine.sync();
  return { db, engine, repo, m4 };
}
const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T;
const post = async <T>(path: string, body: unknown): Promise<T> => (await (await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()) as T;
const today = (): number => {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};

describe("feature switches gate the reads", () => {
  it("with Habit, Pomodoro and Countdown off a sync does not read their lists", async () => {
    const db = new NoorDb(`m4-off-${Math.random()}`);
    const seen: string[] = [];
    const api = new Api({ base, fetch: (u, i) => (seen.push(String(u)), fetch(u, i)) });
    await new SyncEngine(db, api).sync();
    expect(seen.some((u) => /habits|countdown|pomodoro|timer/.test(u))).toBe(false);
  });
});

describe("habits and check-ins (SYNC-036, HAB-014, HAB-017, HAB-025, HAB-027)", () => {
  it("a habit and a check-in reach the server; the server counts the streak", async () => {
    const a = await client();
    const h = await a.m4.saveHabit(newHabit({ name: "Stretch" }));
    await a.m4.setCheckin(h, today(), { status: CheckinStatus.Done });
    await a.engine.sync();
    const habits = await get<Array<{ id: string; totalCheckIns: number; currentStreak: number }>>("/api/v2/habits");
    expect(habits.find((x) => x.id === h.id)).toMatchObject({ totalCheckIns: 1, currentStreak: 1 });
    const q = await post<{ checkins: Record<string, Array<{ status: number; checkinStamp: number }>> }>("/api/v2/habitCheckins/query", { habitIds: [h.id], afterStamp: 0 });
    expect(q.checkins[h.id]).toEqual([expect.objectContaining({ status: 2, checkinStamp: today() })]);
    // the server-owned counters flow back into the local row
    expect((await a.db.habits.get(h.id))?.totalCheckIns).toBe(1);
  });
  it("an amount habit: goal 3, three taps of step 1 make the day done (status 2)", async () => {
    const a = await client();
    const h = await a.m4.saveHabit(newHabit({ name: "Water", type: HabitType.Real, goal: 3, step: 1, unit: "glasses" }));
    for (let i = 1; i <= 3; i++) await a.m4.setCheckin(h, today(), { value: i });
    const local = await a.m4.checkinOf(h.id, today());
    expect(local).toMatchObject({ value: 3, status: 2, goal: 3 });
    await a.engine.sync();
    const q = await post<{ checkins: Record<string, Array<{ status: number; value: number }>> }>("/api/v2/habitCheckins/query", { habitIds: [h.id] });
    expect(q.checkins[h.id]![0]).toMatchObject({ value: 3, status: 2 });
  });
  it("unchecking keeps the row with status 1; a past day can be edited after the fact", async () => {
    const a = await client();
    const h = await a.m4.saveHabit(newHabit({ name: "Read" }));
    const past = Number(String(today()).slice(0, 6) + "01") === today() ? today() : Number(String(today()).slice(0, 6) + "01");
    await a.m4.setCheckin(h, past, { status: CheckinStatus.Done });
    await a.engine.sync();
    await a.m4.setCheckin(h, past, { status: CheckinStatus.Undone });
    await a.engine.sync();
    const q = await post<{ checkins: Record<string, Array<{ status: number; checkinStamp: number }>> }>("/api/v2/habitCheckins/query", { habitIds: [h.id] });
    expect(q.checkins[h.id]).toEqual([expect.objectContaining({ checkinStamp: past, status: 1 })]);
  });
  it("two devices check in the same day: the second adopts the server row instead of failing", async () => {
    const a = await client();
    const h = await a.m4.saveHabit(newHabit({ name: "Walk" }));
    await a.engine.sync();
    const b = await client();
    await a.m4.setCheckin(h, today(), { status: CheckinStatus.Done });
    await b.m4.setCheckin((await b.db.habits.get(h.id))!, today(), { status: CheckinStatus.Done });
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const q = await post<{ checkins: Record<string, unknown[]> }>("/api/v2/habitCheckins/query", { habitIds: [h.id] });
    expect(q.checkins[h.id]).toHaveLength(1);
    expect(await b.db.checkins.where("habitId").equals(h.id).count()).toBe(1);
    expect((await b.db.outbox.count())).toBe(0);
  });
  it("offline edits keep their order: tick A, create B, tick B, one sync sends both check-ins", async () => {
    const a = await client();
    const A = await a.m4.saveHabit(newHabit({ name: "Order A" }));
    await a.engine.sync();
    await a.m4.setCheckin(A, today(), { status: CheckinStatus.Done });
    const B = await a.m4.saveHabit(newHabit({ name: "Order B" }));
    await a.m4.setCheckin(B, today(), { status: CheckinStatus.Done });
    await a.m4.saveRecord(B.id, today(), "first day", 50);
    await a.engine.sync();
    const q = await post<{ checkins: Record<string, unknown[]> }>("/api/v2/habitCheckins/query", { habitIds: [A.id, B.id] });
    expect(q.checkins[A.id]).toHaveLength(1);
    expect(q.checkins[B.id]).toHaveLength(1);
    const r = await post<{ habitRecords: Record<string, unknown[]> }>("/api/v2/getHabitRecords", { habitIds: [B.id] });
    expect(r.habitRecords[B.id]).toHaveLength(1);
    expect(await a.db.checkins.where("habitId").equals(B.id).count()).toBe(1);
  });
  it("a record that changes type moves to the other endpoint", async () => {
    const a = await client();
    const id = "65b0f0c0aabbccddeeff00aa";
    await a.m4.saveFocus({ id, type: 0, startTime: toServer(Date.now() - 3600000), endTime: toServer(Date.now() - 3000000) });
    await a.engine.sync();
    await a.m4.saveFocus({ ...(await a.db.pomos.get(id))!, type: 1 });
    await a.engine.sync();
    expect((await get<Array<{ id: string }>>("/api/v2/pomodoros/timing")).some((x) => x.id === id)).toBe(true);
    expect((await get<Array<{ id: string }>>("/api/v2/pomodoros")).some((x) => x.id === id)).toBe(false);
  });
  it("a log (note and mood) per day; a 3000 character note is accepted (HAB-018, PREM-043)", async () => {
    const a = await client();
    const h = await a.m4.saveHabit(newHabit({ name: "Journal" }));
    await a.m4.saveRecord(h.id, today(), "x".repeat(3000), 40);
    await a.engine.sync();
    const r = await post<{ habitRecords: Record<string, Array<{ content: string; emoji: number }>> }>("/api/v2/getHabitRecords", { habitIds: [h.id] });
    expect(r.habitRecords[h.id]![0]!.content.length).toBe(3000);
    expect(r.habitRecords[h.id]![0]!.emoji).toBe(40);
  });
  it("skip a day writes exDates; archive and delete (RPT-104, HAB-026, HAB-027)", async () => {
    const a = await client();
    const h = await a.m4.saveHabit(newHabit({ name: "Meditate" }));
    await a.m4.toggleSkip(h.id, today());
    await a.m4.archiveHabit(h.id, true);
    await a.engine.sync();
    const row = (await get<Array<{ id: string; exDates: string[]; status: number; archivedTime: string | null }>>("/api/v2/habits")).find((x) => x.id === h.id)!;
    expect(row.exDates).toEqual([String(today())]);
    expect(row.status).toBe(1);
    expect(row.archivedTime).toBeTruthy();
    await a.m4.setCheckin((await a.db.habits.get(h.id))!, today(), { status: 2 });
    await a.engine.sync();
    await a.m4.deleteHabit(h.id);
    await a.engine.sync();
    expect((await get<Array<{ id: string }>>("/api/v2/habits")).some((x) => x.id === h.id)).toBe(false);
    const q = await post<{ checkins: Record<string, unknown[]> }>("/api/v2/habitCheckins/query", { habitIds: [h.id] });
    expect(q.checkins[h.id]).toEqual([]);
  });
  it("30 sections and 300 habits are accepted (PREM-051, PREM-052, HAB-007, HAB-008)", async () => {
    const a = await client();
    for (let i = 0; i < 30; i++) await a.m4.saveSection({ id: `${"5".repeat(20)}${String(i).padStart(4, "0")}`, name: `S${i}` });
    for (let i = 0; i < 300; i++) await a.m4.saveHabit(newHabit({ name: `H${i}` }));
    await a.engine.sync();
    expect((await get<unknown[]>("/api/v2/habitSections")).length).toBeGreaterThanOrEqual(30);
    expect((await get<unknown[]>("/api/v2/habits")).length).toBeGreaterThanOrEqual(300);
    expect(await a.db.outbox.count()).toBe(0);
  });
});

describe("focus records (SYNC-037, TASK-151, FOC-019, FOC-020, FOC-022)", () => {
  it("a record on a task reaches the timeline and the task's record list; a second client pulls it by delta", async () => {
    const a = await client();
    const t = await a.repo.createTask({ title: "Write chapter" });
    const s = Date.now() - 30 * 60000;
    await a.m4.saveFocus({ id: "65b0f0c0aabbccddeeff0001", type: 0, startTime: toServer(s), endTime: toServer(s + 25 * 60000), pauseDuration: 0, tasks: [{ taskId: t.id, projectId: t.projectId, title: t.title }] });
    await a.engine.sync();
    const tl = await get<Array<{ id: string }>>("/api/v2/pomodoros/timeline");
    expect(tl.some((r) => r.id === "65b0f0c0aabbccddeeff0001")).toBe(true);
    const byTask = await get<Array<{ id: string }>>(`/api/v2/pomodoros/task?taskId=${t.id}`);
    expect(byTask.map((r) => r.id)).toContain("65b0f0c0aabbccddeeff0001");
    const b = await client();
    expect((await b.db.pomos.get("65b0f0c0aabbccddeeff0001"))?.type).toBe(0);
    // the task's focusSummaries move with it (TASK-028 starts empty)
    await a.engine.sync();
    const sum = (await a.db.tasks.get(t.id))?.focusSummaries as Array<{ pomoCount: number }> | undefined;
    expect(sum?.[0]?.pomoCount).toBe(1);
  });
  it("a new task starts with an empty focusSummaries list (TASK-028)", async () => {
    const a = await client();
    const t = await a.repo.createTask({ title: "Fresh" });
    await a.engine.sync();
    const srv = await get<{ focusSummaries?: unknown[] }>(`/api/v2/task/${t.id}`);
    expect(srv.focusSummaries ?? []).toEqual([]);
  });
  it("a record six months back is accepted; edit changes totals; delete propagates as a tombstone", async () => {
    const a = await client();
    const b = await client();
    const old = Date.now() - 182 * 86400000;
    await a.m4.saveFocus({ id: "65b0f0c0aabbccddeeff0002", type: 1, startTime: toServer(old), endTime: toServer(old + 40 * 60000), note: "old one" });
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.db.pomos.get("65b0f0c0aabbccddeeff0002"))?.note).toBe("old one");
    await a.m4.saveFocus({ ...(await a.db.pomos.get("65b0f0c0aabbccddeeff0002"))!, endTime: toServer(old + 60 * 60000) });
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.db.pomos.get("65b0f0c0aabbccddeeff0002"))?.endTime).toBe(toServer(old + 60 * 60000));
    await a.m4.deleteFocus(["65b0f0c0aabbccddeeff0002"]);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.db.pomos.get("65b0f0c0aabbccddeeff0002")).toBeUndefined();
  });
  it("Delete All clears records on the server and locally", async () => {
    const a = await client();
    await a.m4.saveFocus({ id: "65b0f0c0aabbccddeeff0003", type: 0, startTime: toServer(Date.now() - 3600000), endTime: toServer(Date.now() - 2000000) });
    await a.engine.sync();
    await a.m4.deleteAllFocus();
    expect(await a.db.pomos.count()).toBe(0);
    expect(await get<unknown[]>("/api/v2/pomodoros/timeline")).toEqual([]);
  });
  it("60 timers, archive one (PREM-053, FOC-015)", async () => {
    const a = await client();
    for (let i = 0; i < 60; i++) await a.m4.saveTimer({ id: `${"7".repeat(20)}${String(i).padStart(4, "0")}`, name: `Timer ${i}`, type: "pomodoro", pomodoroTime: 25, status: 0 });
    await a.engine.sync();
    const t0 = (await a.db.timers.get(`${"7".repeat(20)}0000`))!;
    await a.m4.saveTimer({ ...t0, status: 1, archivedTime: toServer(Date.now()) });
    await a.engine.sync();
    const all = await get<Array<{ id: string; status: number }>>("/api/v2/timer");
    expect(all.length).toBeGreaterThanOrEqual(60);
    expect(all.find((x) => x.id === t0.id)?.status).toBe(1);
  });
});

describe("preferences and countdowns (SET-101, SET-102, CNT-019, PREM-055)", () => {
  it("pomodoro prefs: 3 minutes saves as 5 and reads back; habit prefs persist", async () => {
    const a = await client();
    await a.m4.setPomoPrefs({ pomoDuration: 3, pomoGoal: 6 });
    await a.m4.setHabitPrefs({ showInToday: false });
    await a.engine.sync();
    expect(await get("/api/v2/user/preferences/pomodoro")).toMatchObject({ pomoDuration: 5, pomoGoal: 6, shortBreakDuration: 5, longBreakDuration: 15, longBreakInterval: 4 });
    expect(await get("/api/v2/user/preferences/habit?platform=web")).toMatchObject({ showInToday: false, showInCalendar: true, enabled: true });
    const b = await client();
    expect(await b.db.getKV("pomoPrefs", {})).toMatchObject({ pomoDuration: 5 });
    await a.m4.setHabitPrefs({ showInToday: true });
    await a.engine.sync();
  });
  it("400 countdowns are accepted, no cap (CNT-018, PREM-055, PREM-067)", async () => {
    const a = await client();
    for (let i = 0; i < 400; i++) await a.m4.saveCountdown({ id: `${"9".repeat(20)}${String(i).padStart(4, "0")}`, name: `C${i}`, type: 4, date: 20300101 });
    await a.engine.sync();
    expect((await get<unknown[]>("/api/v2/countdown/list")).length).toBeGreaterThanOrEqual(400);
    expect(await a.db.outbox.count()).toBe(0);
  });
  it("pin A then B: only B stays pinned", async () => {
    const a = await client();
    const A = { id: "65c0f0c0aabbccddeeff0001", name: "A", type: 4, date: 20270101 };
    const B = { id: "65c0f0c0aabbccddeeff0002", name: "B", type: 4, date: 20270201 };
    await a.m4.saveCountdown({ ...A, pinnedTime: toServer(Date.now() - 1000) });
    await a.engine.sync();
    await a.m4.saveCountdown({ ...B, pinnedTime: toServer(Date.now()) });
    await a.engine.sync();
    const list = await get<Array<{ id: string; pinnedTime: string | null }>>("/api/v2/countdown/list");
    expect(list.find((c) => c.id === A.id)?.pinnedTime).toBeFalsy();
    expect(list.find((c) => c.id === B.id)?.pinnedTime).toBeTruthy();
    expect((await a.db.countdowns.get(A.id))?.pinnedTime).toBeFalsy();
  });
});

describe("live focus across devices (FOC-026, FOC-027, FOC-801, SET-279, SET-280)", () => {
  const env = (sync = true) => ({ prefs: () => defaultPrefs(null), keepInSync: () => sync });
  it("device A starts a pomodoro, device B follows it, pause on B pauses A, finish on A drops B", async () => {
    const a = await client();
    const b = await client();
    const A = new FocusController(a.engine, a.m4, env());
    const B = new FocusController(b.engine, b.m4, env());
    await A.start("pomo", { binding: { kind: "task", id: "t1", title: "Essay" } });
    expect(A.state?.synced).toBe(true);
    await B.poll();
    expect(B.state?.sessionId).toBe(A.state?.sessionId);
    expect(B.state?.binding?.title).toBe("Essay");
    await B.pause();
    await A.poll();
    expect(A.state?.status).toBe("paused");
    await A.resume();
    await A.finish();
    await B.poll();
    expect(B.state).toBeNull();
  });
  it("a start on B while A runs replaces A's session; A takes over B's timer", async () => {
    const a = await client();
    const b = await client();
    const A = new FocusController(a.engine, a.m4, env());
    const B = new FocusController(b.engine, b.m4, env());
    await A.start("pomo");
    await B.poll();
    await B.exit();
    await B.start("stopwatch");
    await A.poll();
    expect(A.state?.mode).toBe("stopwatch");
    expect(A.state?.sessionId).toBe(B.state?.sessionId);
    await B.exit();
  });
  it("the running timer is stored under pomoState with focusTimerType and focusTaskId, and a reload restores it", async () => {
    const a = await client();
    const A = new FocusController(a.engine, a.m4, env(false));
    await A.start("pomo", { binding: { kind: "task", id: "t9", title: "Report", projectId: "p" } });
    expect(JSON.parse(g.localStorage.getItem("pomoState")!).sessionId).toBe(A.state!.sessionId);
    expect(JSON.parse(g.localStorage.getItem("focusTimerType")!)).toBe("pomo");
    expect(JSON.parse(g.localStorage.getItem("focusTaskId")!)).toBe("t9");
    expect(g.localStorage.getItem("pomoInfo")).toBeTruthy();
    const again = new FocusController(a.engine, a.m4, env(false));
    expect(again.state?.sessionId).toBe(A.state!.sessionId);
    await again.exit();
    expect(g.localStorage.getItem("pomoState")).toBeNull();
    await A.start("stopwatch");
    expect(g.localStorage.getItem("stopwatchState")).toBeTruthy();
  });
  it("a finished work phase writes its record once, even when two devices both end it", async () => {
    const a = await client();
    const b = await client();
    const A = new FocusController(a.engine, a.m4, env());
    const B = new FocusController(b.engine, b.m4, env());
    const t0 = Date.now() - 26 * 60000;
    await A.start("pomo", { now: t0 });
    await B.poll();
    await A.tick(Date.now());
    await B.tick(Date.now());
    await a.engine.sync();
    await b.engine.sync();
    const id = A.state!.baseId;
    const recs = (await get<Array<{ id: string }>>("/api/v2/pomodoros/timeline")).filter((r) => r.id === id);
    expect(recs).toHaveLength(1);
    expect(A.state?.phase).toBe("short");
    await A.exit();
  });
});
