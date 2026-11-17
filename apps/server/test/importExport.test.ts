import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { diffExports, diffPaths, exportBackup, formatDiff, importBackup, maskKey, maskPath, pageClosed, pageTrash, walkJson } from "../src/importExport.js";
import { makeExport, tmp, w } from "./helpers.js";

const dirs: string[] = [];
const fresh = () => { const d = tmp(); dirs.push(d); return d; };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function roundTrip(opts?: { completed?: number; trash?: number }) {
  const src = fresh();
  const { ids } = makeExport(src, opts);
  const work = fresh();
  const db = join(work, "m.sqlite");
  const report = importBackup(src, db);
  const out = join(work, "out");
  const counts = exportBackup(db, out);
  return { src, db, out, report, counts, ids, work };
}

describe("import and export", () => {
  test("counts per entity", () => {
    const r = roundTrip();
    expect(r.report.counts).toMatchObject({ "tasks.open": 3, projects: 1, tags: 1, completed: 120, trash: 60, wontdo: 0, attachmentIndex: 1, templates: 2, tasks: 183 });
    expect(r.counts).toMatchObject({ "tasks.open": 3, completed: 120, trash: 60, attachmentIndex: 1, orderRecords: 4 });
  });
  test("round trip diff is empty", () => {
    const r = roundTrip();
    const d = diffExports(r.src, r.out);
    expect(d.mismatches).toBe(0);
    expect(d.rows.find((x) => x.entity === "completed")).toMatchObject({ a: 120, b: 120 });
  });
  test("round trip of a bigger completed set pages with 50-row boundary overlap", () => {
    const r = roundTrip({ completed: 723, trash: 329 });
    expect(diffExports(r.src, r.out).mismatches).toBe(0);
    const pages = JSON.parse(readFileSync(join(r.out, "completed-pages.json"), "utf8"));
    expect(pages).toHaveLength(15);
    expect(pages.flat()).toHaveLength(737);
    const trash = JSON.parse(readFileSync(join(r.out, "trash-pages.json"), "utf8"));
    expect(trash.map((p: any) => p.next)).toEqual([50, 100, 150, 200, 250, 300, 329]);
  });
  test("objects are stored verbatim: etag and modifiedTime are not re-stamped, nulls stay null", () => {
    const r = roundTrip();
    const o = JSON.parse(readFileSync(join(r.out, "captured/api_v3_batch_check_0.json"), "utf8"));
    expect(o.syncTaskBean.update[0].etag).toBe("e1");
    expect(o.syncTaskBean.update[0].modifiedTime).toBe("2026-01-01T00:00:00.000+0000");
    expect(o.syncTaskBean.update[0].repeatFrom).toBeNull();
    expect(o.syncTaskBean.update[0].zzUnknownField).toEqual({ nested: [1, null] });
    expect(o.filters).toBeNull();
    expect(o.checkPoint).toBe(1794773057425);
    expect(o.syncOrderBean.orderByType.projectPinned.all.changed).toEqual([]);
  });
  test("open tasks with a completedTime stay open", () => {
    const r = roundTrip();
    const o = JSON.parse(readFileSync(join(r.out, "captured/api_v3_batch_check_0.json"), "utf8"));
    expect(o.syncTaskBean.update.filter((t: any) => t.completedTime)).toHaveLength(1);
  });
  test("attachment index entries become pending records", () => {
    const r = roundTrip();
    const { svc } = buildApp({ dbPath: r.db, dataDir: fresh(), noAuth: true });
    const row = svc.store.get<{ state: string; file: string | null }>("select state, file from attachments where id = 'att1'");
    expect(row).toEqual({ state: "pending", file: null });
  });
  test("passthrough documents come back untouched, including dynamic keys", () => {
    const r = roundTrip();
    expect(JSON.parse(readFileSync(join(r.out, "captured/api_v2_statistics_color.json"), "utf8"))).toEqual({ project2color: { "some list": "#000" }, tag2color: {} });
    expect(existsSync(join(r.out, "habits.json"))).toBe(true);
  });
  test("every input file appears in the output", () => {
    const r = roundTrip();
    expect(walkJson(r.out).sort()).toEqual(walkJson(r.src).sort());
  });
  test("exported files are private (0600, dirs 0700)", () => {
    const r = roundTrip();
    expect(statSync(join(r.out, "completed-pages.json")).mode & 0o777).toBe(0o600);
    expect(statSync(r.out).mode & 0o777).toBe(0o700);
  });
  test("import refuses a database that already has data", () => {
    const r = roundTrip();
    expect(() => importBackup(r.src, r.db)).toThrow(/not empty/);
  });
  test("imports with pages only (no merged file) and dedupes the repeated boundary rows", () => {
    const src = fresh();
    makeExport(src);
    rmSync(join(src, "completed-tasks-merged.json"));
    const work = fresh();
    const rep = importBackup(src, join(work, "m.sqlite"));
    expect(rep.counts.completed).toBe(120);
  });
  test("a half-filled export (no sync file) still imports", () => {
    const src = fresh();
    w(src, "completed-tasks-merged.json", []);
    const rep = importBackup(src, join(fresh(), "m.sqlite"));
    expect(rep.counts.completed).toBe(0);
  });
  test("served after import: the imported state is what batch/check/0 returns", async () => {
    const r = roundTrip();
    const { app, svc } = buildApp({ dbPath: r.db, dataDir: fresh(), noAuth: true });
    const full = (await app.inject({ method: "GET", url: "/api/v3/batch/check/0" })).json();
    expect(full.syncTaskBean.update).toHaveLength(3);
    expect(full.inboxId).toBe("inbox424242");
    expect(svc.userId).toBe(424242);
    const st = (await app.inject({ method: "GET", url: "/api/v2/user/status" })).json();
    expect(st.pro).toBe(true);
    const trash = (await app.inject({ method: "GET", url: "/api/v2/project/all/trash/page?limit=50&type=1" })).json();
    expect(trash.tasks).toHaveLength(50);
    expect(trash.next).toBe(50);
    const closed = (await app.inject({ method: "GET", url: "/api/v2/project/all/closed?status=Completed" })).json();
    expect(closed).toHaveLength(50);
    // the stored status document is kept for export while the served one is overlaid
    const raw = svc.store.getDoc<any>("status")!.json;
    expect(raw.pro).toBe(false);
  });
  test("the app keeps working on imported data: edit then re-export shows exactly that edit", async () => {
    const r = roundTrip();
    const { app, store } = buildApp({ dbPath: r.db, dataDir: fresh(), noAuth: true });
    const t = (await app.inject({ method: "GET", url: `/api/v2/task/${r.ids.open0}` })).json();
    await app.inject({ method: "POST", url: "/api/v2/batch/task", payload: { update: [{ ...t, title: "changed" }] } });
    await app.close();
    store.close();
    const out2 = join(r.work, "out2");
    exportBackup(r.db, out2);
    const d = diffExports(r.src, out2);
    const row = d.rows.find((x) => x.entity === "tasks.open")!;
    expect(row.fieldMismatches.sort()).toEqual(["etag (value)", "modifiedTime (value)", "title (value)"]);
    expect(d.mismatches).toBeGreaterThan(0);
  });
});

describe("diff-export", () => {
  const mutate = (fn: (dir: string) => void) => {
    const r = roundTrip();
    const copy = fresh();
    cpSync(r.out, copy, { recursive: true });
    fn(copy);
    return diffExports(r.src, copy);
  };
  const edit = (dir: string, rel: string, f: (j: any) => void) => {
    const p = join(dir, rel);
    const j = JSON.parse(readFileSync(p, "utf8"));
    f(j);
    writeFileSync(p, JSON.stringify(j));
  };
  test("key order is ignored", () => {
    const d = mutate((dir) => edit(dir, "captured/api_v3_batch_check_0.json", (j) => { j.syncTaskBean.update[0] = Object.fromEntries(Object.entries(j.syncTaskBean.update[0]).reverse()); }));
    expect(d.mismatches).toBe(0);
  });
  test("a changed value is found, by field name", () => {
    const d = mutate((dir) => edit(dir, "completed-tasks-merged.json", (j) => { j[3].priority = 99; }));
    expect(d.rows.find((r) => r.entity === "completed")!.fieldMismatches).toEqual(["priority (value)"]);
  });
  test("a dropped field is found", () => {
    const d = mutate((dir) => edit(dir, "completed-pages.json", (j) => { delete j[0][2].etag; }));
    expect(d.rows.find((r) => r.entity === "completed")!.fieldMismatches).toEqual(["etag (missing in B)"]);
  });
  test("an added unknown field is found", () => {
    const d = mutate((dir) => edit(dir, "trash-pages.json", (j) => { j[0].tasks[0].invented = 1; }));
    expect(d.rows.find((r) => r.entity === "trash")!.fieldMismatches).toEqual(["invented (missing in A)"]);
  });
  test("a missing entity is counted", () => {
    const d = mutate((dir) => edit(dir, "completed-tasks-merged.json", (j) => { j.pop(); }));
    expect(d.rows.find((r) => r.entity === "completed")!.onlyA).toBe(1);
  });
  test("a reordered array is a mismatch", () => {
    const d = mutate((dir) => edit(dir, "captured/api_v3_batch_check_0.json", (j) => { j.syncOrderBeanV3.orderByType["taskBy#sortOrder|none_dueDate"][Object.keys(j.syncOrderBeanV3.orderByType["taskBy#sortOrder|none_dueDate"])[0]!].changed.reverse(); }));
    expect(d.mismatches).toBeGreaterThan(0);
  });
  test("tag, project and attachment index changes are found", () => {
    const d = mutate((dir) => {
      edit(dir, "captured/api_v3_batch_check_0.json", (j) => { j.tags[0].color = "#000"; j.projectProfiles[0].name = "q"; });
      edit(dir, "attachments-index.json", (j) => { j[0].size = 1; });
    });
    expect(d.rows.find((r) => r.entity === "tags")!.fieldMismatches).toEqual(["color (value)"]);
    expect(d.rows.find((r) => r.entity === "projects")!.fieldMismatches).toEqual(["name (value)"]);
    expect(d.rows.find((r) => r.entity === "attachmentIndex")!.fieldMismatches).toEqual(["size (value)"]);
  });
  test("a changed passthrough document is reported by top-level key only", () => {
    const d = mutate((dir) => edit(dir, "captured/api_v2_statistics_color.json", (j) => { j.project2color["some list"] = "#fff"; }));
    const row = d.rows.find((r) => r.fieldMismatches.length)!;
    expect(row.fieldMismatches).toEqual(["project2color (value)"]);
  });
  test("files present on one side only are listed", () => {
    const d = mutate((dir) => { rmSync(join(dir, "habits.json")); w(dir, "extra.json", {}); });
    expect(d.filesOnlyA).toEqual(["habits.json"]);
    expect(d.filesOnlyB).toEqual(["extra.json"]);
  });
  test("the printed report never contains values or ids", () => {
    const d = mutate((dir) => {
      edit(dir, "completed-tasks-merged.json", (j) => { j[0].title = "SECRET-TITLE"; j[1].id = "deadbeefdeadbeefdeadbeef"; });
      edit(dir, "captured/api_v2_statistics_color.json", (j) => { j.project2color = { "SECRET LIST": "#1" }; });
    });
    const text = formatDiff(d);
    expect(text).not.toMatch(/SECRET|deadbeef|synthetic|some list/);
    expect(text).toMatch(/mismatches: [1-9]/);
  });
  test("diffPaths removes array indexes and masks dynamic keys", () => {
    const s = new Set<string>();
    diffPaths({ a: [{ b: 1 }, { b: 2 }], "5f1d7f3b8e1b4c0012345678": { x: 1 }, "has space": 1 }, { a: [{ b: 1 }, { b: 3 }], "5f1d7f3b8e1b4c0012345678": { x: 2 }, "has space": 2 }, "", s);
    expect([...s].sort()).toEqual(["<id>.x (value)", "<key> (value)", "a[].b (value)"]);
  });
  test.each([["5f1d7f3b8e1b4c0012345678", "<id>"], ["inbox123456", "<inbox>"], ["title", "title"], ["a b", "<key>"], ["9x", "<key>"]])("maskKey(%s)", (k, o) => expect(maskKey(k)).toBe(o));
  test("maskPath hides ids, inbox numbers and long numbers", () => {
    expect(maskPath("captured/api_v2_task_5f1d7f3b8e1b4c0012345678__projectId=inbox123456_1794773028261.json")).toBe("captured/api_v2_task_<id>__projectId=<inbox>_<n>.json");
  });
  test("identical directories compare clean and the CLI exits 0, a difference exits 1", () => {
    const src = fresh();
    makeExport(src);
    const other = fresh();
    cpSync(src, other, { recursive: true });
    const cli = (a: string, b: string) => spawnSync("npx", ["tsx", "src/cli.ts", "diff-export", a, b], { cwd: join(__dirname, ".."), encoding: "utf8" });
    const ok = cli(src, other);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("mismatches: 0");
    writeFileSync(join(other, "wontdo-closed.json"), JSON.stringify([{ id: "x1" }]));
    expect(cli(src, other).status).toBe(1);
  }, 60_000);
});

describe("paging helpers", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i) })) as any;
  test.each([[0, 0], [10, 1], [50, 2], [99, 3], [723, 15]])("pageClosed(%i rows) gives %i pages", (n, pages) => {
    expect(pageClosed(rows(n))).toHaveLength(pages);
  });
  test("each closed page starts with the previous page's last row", () => {
    const p = pageClosed(rows(200));
    for (let i = 1; i < p.length; i++) expect(p[i]![0]!.id).toBe(p[i - 1]![p[i - 1]!.length - 1]!.id);
  });
  test("pageTrash cumulative next", () => {
    expect(pageTrash(rows(120)).map((p) => p.next)).toEqual([50, 100, 120]);
    expect(pageTrash(rows(0))).toEqual([]);
  });
});
