import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { diffExports, exportBackup, formatDiff, importBackup } from "../src/importExport.js";
import { makeExport, tmp, w } from "./helpers.js";

const dirs: string[] = [];
const fresh = () => { const d = tmp(); dirs.push(d); return d; };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const hab = (i: number) => ({ id: `h${i}`.padEnd(24, "0"), name: `habit ${i}`, iconRes: "habit_daily_check_in", type: i % 2 ? "Real" : "Boolean", goal: i % 2 ? 8 : 1, unit: "Count", repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE", currentStreak: 7 + i, maxStreak: 30, totalCheckIns: 99, status: 0, sectionId: "s1".padEnd(24, "0"), exDates: [20261101], zzUnknown: { a: [1, null] }, etag: `he${i}`, createdTime: "2026-01-01T00:00:00.000+0000", modifiedTime: "2026-01-02T00:00:00.000+0000" });
const section = { id: "s1".padEnd(24, "0"), name: "_morning", sortOrder: -1099511627776, etag: "se1", createdTime: "2026-01-01T00:00:00.000+0000", modifiedTime: "2026-01-01T00:00:00.000+0000" };
const checkins = [1, 2].flatMap((i) => [20261101, 20261102, 20261103].map((s, k) => ({ id: `c${i}${k}`.padEnd(24, "0"), habitId: `h${i}`.padEnd(24, "0"), checkinStamp: s, checkinTime: "2026-11-03T08:00:00.000+0000", goal: 1, value: 1, status: 2, opTime: "2026-11-03T08:00:00.000+0000", zzNote: "kept", etag: "x" })));
const records = [{ id: "r1".padEnd(24, "0"), habitId: "h1".padEnd(24, "0"), checkinStamp: 20261101, content: "note", mood: 40 }];
const pomo = (i: number, type: 0 | 1) => ({ id: `p${type}${i}`.padEnd(24, "0"), startTime: 1790000000000 + i * 3600000, endTime: 1790000000000 + i * 3600000 + 1500000, pauseDuration: 0, status: 1, tasks: [{ taskId: "t1".padEnd(24, "0"), title: "x", startTime: 1790000000000, endTime: 1790000600000 }], note: "n", zzFlag: true });
const pomos = [0, 1, 2].map((i) => pomo(i, 0));
const timing = [0, 1].map((i) => ({ ...pomo(i, 1), tasks: [{ timerId: "tm1".padEnd(24, "0"), timerName: "Reading" }] }));
const timers = [{ id: "tm1".padEnd(24, "0"), name: "Reading", status: 0, sortOrder: 5, etag: "te", createdTime: "2026-01-01T00:00:00.000+0000", zzT: 1 }];
const countdowns = [{ id: "d1".padEnd(24, "0"), name: "Trip", type: 4, date: "2026-12-24T00:00:00.000+0000", timerMode: 0, reminders: ["TRIGGER:P0DT9H0M0S"], pinnedTime: null, status: 0, etag: "ce", zzC: [null] }];

function withM4(): { src: string; work: string; db: string; out: string } {
  const src = fresh();
  makeExport(src);
  w(src, "habits.json", [hab(1), hab(2)]);
  w(src, "habit-sections.json", [section]);
  w(src, "habit-checkins.json", checkins);
  w(src, "habit-records.json", records);
  w(src, "pomodoros.json", pomos);
  w(src, "pomodoro-timing.json", timing);
  w(src, "timers.json", timers);
  w(src, "countdowns.json", countdowns);
  const work = fresh();
  return { src, work, db: join(work, "m.sqlite"), out: join(work, "out") };
}

describe("M4 entities round trip", () => {
  test("import counts", () => {
    const t = withM4();
    const r = importBackup(t.src, t.db);
    expect(r.counts).toMatchObject({ habits: 2, habitSections: 1, habitCheckins: 6, habitRecords: 1, pomodoros: 3, pomodoroTiming: 2, timers: 1, countdowns: 1 });
  });
  test("export counts match", () => {
    const t = withM4();
    importBackup(t.src, t.db);
    expect(exportBackup(t.db, t.out)).toMatchObject({ habits: 2, habitSections: 1, habitCheckins: 6, habitRecords: 1, pomodoros: 3, pomodoroTiming: 2, timers: 1, countdowns: 1 });
  });
  test("the diff of source and re-export is empty", () => {
    const t = withM4();
    importBackup(t.src, t.db);
    exportBackup(t.db, t.out);
    const d = diffExports(t.src, t.out);
    expect(formatDiff(d)).toContain("mismatches: 0");
    expect(d.mismatches).toBe(0);
    expect(d.rows.find((r) => r.entity === "habitCheckins")).toMatchObject({ a: 6, b: 6 });
    expect(d.rows.find((r) => r.entity === "pomodoroTiming")).toMatchObject({ a: 2, b: 2 });
  });
  test("objects are verbatim: counters are not recomputed, unknown fields and etags stay", () => {
    const t = withM4();
    importBackup(t.src, t.db);
    exportBackup(t.db, t.out);
    const h = JSON.parse(readFileSync(join(t.out, "habits.json"), "utf8"));
    expect(h[0]).toMatchObject({ currentStreak: 8, maxStreak: 30, totalCheckIns: 99, etag: "he1", zzUnknown: { a: [1, null] } });
    const p = JSON.parse(readFileSync(join(t.out, "pomodoros.json"), "utf8"));
    expect(p[2]).toEqual(pomos[2]);
    const c = JSON.parse(readFileSync(join(t.out, "habit-checkins.json"), "utf8"));
    expect(c).toEqual(checkins);
    expect(JSON.parse(readFileSync(join(t.out, "countdowns.json"), "utf8"))).toEqual(countdowns);
    expect(JSON.parse(readFileSync(join(t.out, "timers.json"), "utf8"))).toEqual(timers);
  });
  test("the imported data is served by the endpoints", async () => {
    const t = withM4();
    importBackup(t.src, t.db);
    const { app } = buildApp({ dbPath: t.db, dataDir: fresh(), noAuth: true, now: () => Date.UTC(2026, 10, 15, 12) });
    const get = async (u: string) => (await app.inject({ method: "GET", url: u })).json();
    expect(await get("/api/v2/habits")).toHaveLength(2);
    expect(await get("/api/v2/habitSections")).toHaveLength(1);
    expect(await get("/api/v2/pomodoros?from=0")).toHaveLength(3);
    expect(await get("/api/v2/pomodoros/timing?from=0")).toHaveLength(2);
    expect(await get("/api/v2/timer")).toHaveLength(1);
    expect(await get("/api/v2/countdown/list")).toHaveLength(1);
    const q = (await app.inject({ method: "POST", url: "/api/v2/habitCheckins/query", payload: { habitIds: [hab(1).id], afterStamp: 0 } })).json();
    expect(q.checkins[hab(1).id]).toHaveLength(3);
    expect((await get("/api/v2/timer/overview/" + timers[0]!.id)).totalCount).toBe(2);
    await app.close();
  });
  test("an edit after import survives a second export", async () => {
    const t = withM4();
    importBackup(t.src, t.db);
    const { app, store } = buildApp({ dbPath: t.db, dataDir: fresh(), noAuth: true, now: () => Date.UTC(2026, 10, 15, 12) });
    await app.inject({ method: "POST", url: "/api/v2/countdown/batch", payload: { update: [{ ...countdowns[0], name: "Edited" }] } });
    await app.inject({ method: "DELETE", url: `/api/v2/pomodoro/${pomos[0]!.id}` });
    store.close();
    const out2 = join(t.work, "out2");
    const counts = exportBackup(t.db, out2);
    expect(counts.pomodoros).toBe(2);
    expect(JSON.parse(readFileSync(join(out2, "countdowns.json"), "utf8"))[0].name).toBe("Edited");
  });
  test("importing needs an empty database even with M4 data", () => {
    const t = withM4();
    importBackup(t.src, t.db);
    expect(() => importBackup(t.src, t.db)).toThrow(/not empty/);
  });
  test("an export with no M4 files imports and exports without creating them", () => {
    const src = fresh();
    makeExport(src);
    const work = fresh();
    const db = join(work, "m.sqlite");
    importBackup(src, db);
    exportBackup(db, join(work, "out"));
    for (const f of ["habit-checkins.json", "pomodoros.json", "pomodoro-timing.json", "timers.json", "countdowns.json", "habit-sections.json", "habit-records.json"]) expect(existsSync(join(work, "out", f))).toBe(false);
    expect(diffExports(src, join(work, "out")).mismatches).toBe(0);
  });
  test("empty entity files that exist in the source are written back (the real export has them)", () => {
    const src = fresh();
    makeExport(src);
    w(src, "captured/api_v2_habitSections.json", []);
    w(src, "captured/api_v2_pomodoros_timing__from=0.json", []);
    w(src, "captured/api_v2_countdown_list.json", []);
    const work = fresh();
    const db = join(work, "m.sqlite");
    importBackup(src, db);
    exportBackup(db, join(work, "out"));
    for (const f of ["captured/api_v2_habitSections.json", "captured/api_v2_pomodoros_timing__from=0.json", "captured/api_v2_countdown_list.json"]) expect(JSON.parse(readFileSync(join(work, "out", f), "utf8"))).toEqual([]);
    expect(diffExports(src, join(work, "out")).mismatches).toBe(0);
  });
  test("statistics snapshots stay passthrough documents", () => {
    const src = fresh();
    makeExport(src);
    w(src, "captured/api_v2_statistics_general.json", { score: 5, level: 1, scoreByDay: { "20261101": 5 } });
    w(src, "captured/api_v2_habits_statistics_week_current.json", { "20261101": { totalHabitCount: 1, completedHabitCount: 0 } });
    w(src, "captured/api_v2_pomodoro_record_0.json", { checkPoint: 0, pomodoroRecords: null });
    const work = fresh();
    const db = join(work, "m.sqlite");
    importBackup(src, db);
    exportBackup(db, join(work, "out"));
    expect(diffExports(src, join(work, "out")).mismatches).toBe(0);
    expect(JSON.parse(readFileSync(join(work, "out", "captured/api_v2_statistics_general.json"), "utf8")).score).toBe(5);
  });
  test("a duplicate check-in day is counted, not silently merged", () => {
    const src = fresh();
    makeExport(src);
    w(src, "habits.json", [hab(1)]);
    w(src, "habit-checkins.json", [checkins[0], { ...checkins[0], id: "dup".padEnd(24, "0") }]);
    const work = fresh();
    const r = importBackup(src, join(work, "m.sqlite"));
    expect(r.counts.habitCheckins).toBe(1);
    expect(r.duplicates).toBe(1);
  });
  test("the sync envelope carries no M4 keys (these entities sync through their own endpoints)", async () => {
    const t = withM4();
    importBackup(t.src, t.db);
    const { app } = buildApp({ dbPath: t.db, dataDir: fresh(), noAuth: true });
    const full = (await app.inject({ method: "GET", url: "/api/v3/batch/check/0" })).json();
    expect(Object.keys(full).sort()).toEqual(["checkPoint", "checks", "filters", "inboxId", "projectGroups", "projectProfiles", "remindChanges", "syncOrderBean", "syncOrderBeanV3", "syncTaskBean", "syncTaskOrderBean", "tags"]);
    await app.close();
  });
});
