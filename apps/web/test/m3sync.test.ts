import "fake-indexeddb/auto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { Api } from "../src/data/api";
import { NoorDb } from "../src/data/db";
import { Repo } from "../src/data/repo";
import { SyncEngine } from "../src/data/sync";
import { defaultMatrixPrefs, type Column } from "../src/lib/core";

/** M3 data paths against the real server in-process: kanban columns, ext preferences, calendar settings, matrix order. */
let base = "";
let close: () => Promise<void>;
let dir = "";
let n = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nt-m3-"));
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

async function client(): Promise<{ db: NoorDb; engine: SyncEngine; repo: Repo }> {
  const db = new NoorDb(`m3-${++n}-${Math.random()}`);
  const engine = new SyncEngine(db, new Api({ base }));
  const repo = new Repo(db, engine);
  await engine.sync();
  return { db, engine, repo };
}
const get = async <T>(path: string): Promise<T> => (await (await fetch(base + path)).json()) as T;

describe("kanban columns (SYNC-027, SYNC-033, KANB-004..008, PREM-038, PREM-069)", () => {
  it("a fresh store has no columns", async () => {
    expect(await get("/api/v2/column?from=0")).toEqual({});
    expect(await get("/api/v2/column/project/000000000000000000000000")).toEqual([]);
  });
  it("100 columns on one list are accepted and listed by both column reads", async () => {
    const a = await client();
    const p = await a.repo.createProject({ name: "Big board", viewMode: "kanban" });
    for (let i = 0; i < 100; i++) expect(typeof (await a.repo.createColumn(p.id, `Col ${i}`))).toBe("object");
    expect(await a.repo.createColumn(p.id, "col 5")).toBe("A section with this name already exists");
    await a.engine.sync();
    expect((await get<Column[]>(`/api/v2/column/project/${p.id}`)).length).toBe(100);
    expect((await get<Record<string, Column[]>>("/api/v2/column?from=0"))[p.id]!.length).toBe(100);
  });
  it("rename, reorder and delete converge; tasks of a deleted column move to the first remaining one", async () => {
    const a = await client();
    const p = await a.repo.createProject({ name: "Sections", viewMode: "kanban" });
    const c1 = (await a.repo.createColumn(p.id, "One")) as Column;
    const c2 = (await a.repo.createColumn(p.id, "Two")) as Column;
    const t = await a.repo.createTask({ title: "card", projectId: p.id, columnId: c2.id });
    await a.engine.sync();
    const b = await client();
    expect((await b.repo.columnsOf(p.id)).map((c) => c.name)).toEqual(["One", "Two"]);
    await b.repo.updateColumn(c1.id, { name: "First" });
    await b.repo.moveColumn(c2.id, undefined, (await b.repo.columnsOf(p.id))[0]!.sortOrder);
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.repo.columnsOf(p.id)).map((c) => c.name)).toEqual(["Two", "First"]);
    await a.repo.deleteColumn(c2.id);
    await a.engine.sync();
    await b.engine.sync();
    expect((await b.repo.columnsOf(p.id)).map((c) => c.name)).toEqual(["First"]);
    expect((await get<{ columnId?: string }>(`/api/v2/task/${t.id}`)).columnId).toBe(c1.id);
    expect((await b.db.tasks.get(t.id))!.columnId).toBe(c1.id);
  });
  it("moving a card to a column of another list sets projectId and columnId even with an earlier pending edit (KANB-008)", async () => {
    const a = await client();
    const p1 = await a.repo.createProject({ name: "From" });
    const p2 = await a.repo.createProject({ name: "To", viewMode: "kanban" });
    const col = (await a.repo.createColumn(p2.id, "Landing")) as Column;
    const t = await a.repo.createTask({ title: "traveller", projectId: p1.id });
    await a.engine.sync();
    await a.repo.updateTask(t.id, { title: "traveller (edited)" }); // pending edit before the move
    await a.repo.moveToColumn(t.id, { id: col.id, projectId: p2.id });
    await a.engine.sync();
    const s = await get<{ projectId: string; columnId?: string; title: string }>(`/api/v2/task/${t.id}`);
    expect(s).toMatchObject({ projectId: p2.id, columnId: col.id, title: "traveller (edited)" });
  });
  it("moving between lists restores the same column id after the move clears it", async () => {
    const a = await client();
    const p1 = await a.repo.createProject({ name: "Original list" });
    const p2 = await a.repo.createProject({ name: "Other list" });
    const col = (await a.repo.createColumn(p1.id, "Original column")) as Column;
    const t = await a.repo.createTask({ title: "Traveller", projectId: p1.id, columnId: col.id });
    await a.engine.sync();
    await a.repo.moveTasks([t.id], p2.id);
    await a.repo.moveToColumn(t.id, { id: col.id, projectId: p1.id });
    await a.engine.sync();
    expect(await get(`/api/v2/task/${t.id}`)).toMatchObject({ projectId: p1.id, columnId: col.id });
  });

});

describe("extended preferences and calendar settings (SET-042..099, CAL-027, CAL-028, CAL-044, CAL-088)", () => {
  it("a fresh account returns default calendar settings", async () => {
    const s = await get<Record<string, unknown>>("/api/v2/user/preferences/settings?includeWeb=true");
    expect(s.calendarViewConf).toEqual({ showDetail: false, showCompleted: true, showChecklist: false, showFutureTask: true, showFocusRecord: false, showHabit: false, cellColorType: "list", showCountdown: true });
    expect(s).toMatchObject({ webCalendarViewType: "m", collapsedTime: [7, 21], weekNumbersEnabled: false, startWeekOfYear: "", lunarEnabled: false, holidayEnabled: true });
    expect(await get("/api/v2/user/preferences/pluginSettings")).toEqual([]);
  });
  it("calendar settings written by one client reach another (ninth calendarViewConf key accepted)", async () => {
    const a = await client();
    await a.repo.setSettings({ calendarViewConf: { ...(await a.repo.settings()).calendarViewConf, showDeclinedEvents: true, cellColorType: "priority" }, webCalendarViewType: "w", collapsedTime: [8, 20], weekNumbersEnabled: true, webCalendarViewFilter: { hiddenProjects: ["x"] }, webCalendarViewSelected: "w" } as never);
    await a.engine.sync();
    const b = await client();
    const s = (await b.repo.settings()) as Record<string, unknown>;
    expect(s).toMatchObject({ webCalendarViewType: "w", collapsedTime: [8, 20], weekNumbersEnabled: true, webCalendarViewFilter: { hiddenProjects: ["x"] }, webCalendarViewSelected: "w" });
    expect(s.calendarViewConf).toMatchObject({ showDeclinedEvents: true, cellColorType: "priority" });
  });
  it("ext sections round-trip whole, stamped with mtime, other sections untouched", async () => {
    const a = await client();
    await a.repo.setExt("matrix", { ...defaultMatrixPrefs(), show_completed: false });
    await a.repo.setExt("timeline", { color: "list", showGuide: true, showWeek: true });
    await a.repo.setExt("calendarConfig", { itemStyle: "classic", heatmap: false });
    await a.repo.setExt("calendarColorConfig", { colorType: "tag" });
    await a.repo.setExt("alternativeCalendar", { calendar: "lunar" });
    await a.repo.setExt("timelineTimeZones", { enabled: true, current: [], additional: ["Asia/Tokyo"] });
    await a.repo.setExt("smartProjectsOption", { smartProjects: [{ name: "today", viewMode: "kanban" }] });
    await a.engine.sync();
    await a.repo.setExt("timeline", { color: "priority", showGuide: false, showWeek: false });
    await a.engine.sync();
    const ext = await get<Record<string, Record<string, unknown>>>("/api/v2/user/preferences/ext");
    expect(ext.matrix).toMatchObject({ show_completed: false, version: 1, defaultViewId: "" });
    expect((ext.matrix!.quadrants as unknown[]).length).toBe(4);
    expect(ext.timeline).toMatchObject({ color: "priority", showGuide: false });
    expect(ext.calendarConfig).toMatchObject({ itemStyle: "classic", heatmap: false });
    expect(ext.calendarColorConfig).toMatchObject({ colorType: "tag" });
    expect(ext.alternativeCalendar).toMatchObject({ calendar: "lunar" });
    expect(ext.timelineTimeZones).toMatchObject({ enabled: true, additional: ["Asia/Tokyo"] });
    expect(typeof ext.timeline!.mtime).toBe("number");
    const b = await client();
    expect(((await b.repo.ext()).smartProjectsOption as { smartProjects: unknown[] }).smartProjects).toEqual([{ name: "today", viewMode: "kanban" }]);
  });
  it("matrix manual order travels as batch/order records with a quadrant context (MTRX-018)", async () => {
    const a = await client();
    await a.repo.setMatrixOrder("quadrant2_default", "aaaaaaaaaaaaaaaaaaaaaaaa", 123);
    await a.engine.sync();
    const b = await client();
    expect((await b.db.getKV<Record<string, Record<string, number>>>("matrixOrders", {}))["quadrant2_default"]).toEqual({ aaaaaaaaaaaaaaaaaaaaaaaa: 123 });
  });
});
