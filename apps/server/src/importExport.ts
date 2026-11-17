import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CLOSED_PAGE_SIZE, TRASH_PAGE_SIZE, TaskStatus, isPlainObject, toMs, type Loose, type OrderBean, type Task } from "@noortasks/core";
import { loadOrderBean, readOrderBean } from "./orders.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import { buildCheck, type SyncEnvelope } from "./sync.js";

/** Singleton documents round-tripped through the `docs` table (snapshot file layout kept for backup/sync compatibility). */
export const DOC_FILES: Array<{ name: string; re: RegExp; def: string }> = [
  { name: "settings", re: /(^|\/)api_v2_user_preferences_settings__[^/]*\.json$/, def: "captured/api_v2_user_preferences_settings__includeWeb=true.json" },
  { name: "profile", re: /(^|\/)api_v2_user_profile\.json$/, def: "captured/api_v2_user_profile.json" },
  { name: "status", re: /(^|\/)api_v2_user_status\.json$/, def: "captured/api_v2_user_status.json" },
  { name: "limits", re: /(^|\/)api_v2_configs_limits\.json$/, def: "captured/api_v2_configs_limits.json" },
  { name: "pomodoro", re: /(^|\/)api_v2_user_preferences_pomodoro\.json$/, def: "captured/api_v2_user_preferences_pomodoro.json" },
  { name: "habit", re: /(^|\/)api_v2_user_preferences_habit__[^/]*\.json$/, def: "captured/api_v2_user_preferences_habit__platform=web.json" },
  { name: "dailyReminder", re: /(^|\/)api_v2_user_preferences_dailyReminder\.json$/, def: "captured/api_v2_user_preferences_dailyReminder.json" },
  { name: "featurePrompt", re: /(^|\/)api_v2_user_preferences_featurePrompt\.json$/, def: "captured/api_v2_user_preferences_featurePrompt.json" },
  { name: "ext", re: /(^|\/)api_v2_user_preferences_ext__[^/]*\.json$/, def: "captured/api_v2_user_preferences_ext.json" },
  { name: "pluginSettings", re: /(^|\/)api_v2_user_preferences_pluginSettings\.json$/, def: "captured/api_v2_user_preferences_pluginSettings.json" },
  { name: "apps", re: /(^|\/)api_v2_user_preferences_apps\.json$/, def: "captured/api_v2_user_preferences_apps.json" },
  { name: "projectTemplates", re: /(^|\/)api_v2_projectTemplates_all__[^/]*\.json$/, def: "captured/api_v2_projectTemplates_all__timestamp=0.json" },
];

/** M4 entity files. The first pattern that matches an export file claims it; the path is remembered so the exporter writes the file back, even when empty. */
interface M4Entity {
  key: string;
  label: string;
  patterns: RegExp[];
  def: string;
  idKey: string;
}
export const M4_ENTITIES: M4Entity[] = [
  { key: "habits", label: "habits", patterns: [/^habits\.json$/, /(^|\/)api_v2_habits\.json$/], def: "habits.json", idKey: "id" },
  { key: "habitSections", label: "habitSections", patterns: [/^habit-sections\.json$/, /(^|\/)api_v2_habitSections\.json$/], def: "habit-sections.json", idKey: "id" },
  { key: "habitCheckins", label: "habitCheckins", patterns: [/^habit-checkins\.json$/], def: "habit-checkins.json", idKey: "id" },
  { key: "habitRecords", label: "habitRecords", patterns: [/^habit-records\.json$/], def: "habit-records.json", idKey: "id" },
  { key: "pomodoros", label: "pomodoros", patterns: [/^pomodoros\.json$/], def: "pomodoros.json", idKey: "id" },
  { key: "pomodoroTiming", label: "pomodoroTiming", patterns: [/^pomodoro-timing\.json$/, /(^|\/)api_v2_pomodoros_timing__[^/]*\.json$/], def: "pomodoro-timing.json", idKey: "id" },
  { key: "timers", label: "timers", patterns: [/^timers\.json$/], def: "timers.json", idKey: "id" },
  { key: "countdowns", label: "countdowns", patterns: [/^countdowns\.json$/, /(^|\/)api_v2_countdown_list\.json$/], def: "countdowns.json", idKey: "id" },
  { key: "comments", label: "comments", patterns: [/^comments\.json$/], def: "comments.json", idKey: "id" },
  { key: "activities", label: "activities", patterns: [/^activities\.json$/], def: "activities.json", idKey: "id" },
  { key: "notifications", label: "notifications", patterns: [/^notifications\.json$/], def: "notifications.json", idKey: "id" },
  { key: "matrixProfiles", label: "matrixProfiles", patterns: [/^matrix-profiles\.json$/, /(^|\/)api_v2_matrixProfiles\.json$/], def: "matrix-profiles.json", idKey: "id" },
];
const M4_BY_BASE = (base: string): M4Entity | undefined => M4_ENTITIES.find((e) => e.patterns.some((p) => p.test(base)));

function listOf(v: unknown): Loose[] {
  if (Array.isArray(v)) return v.filter(isPlainObject) as Loose[];
  // `{habitId: [..]}` maps (a check-in query response body) flatten too
  if (isPlainObject(v)) {
    const inner = isPlainObject(v.checkins) ? v.checkins : v;
    return Object.values(inner).flatMap((x) => (Array.isArray(x) ? (x.filter(isPlainObject) as Loose[]) : []));
  }
  return [];
}

const F = {
  sync: "captured/api_v3_batch_check_0.json",
  completedMerged: "completed-tasks-merged.json",
  completedPages: "completed-pages.json",
  trash: "trash-pages.json",
  wontdo: "wontdo-closed.json",
  attachments: "attachments-index.json",
  templates: "captured/api_v2_templates.json",
  columns: "captured/api_v2_column__from=0.json",
};

export function walkJson(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) rec(p);
      else if (name.endsWith(".json")) out.push(relative(dir, p).split("\\").join("/"));
    }
  };
  rec(dir);
  return out;
}

export interface ImportReport {
  counts: Record<string, number>;
  blobs: number;
  skippedFiles: number;
  duplicates: number;
}

function flattenTasks(v: unknown): Task[] {
  const out: Task[] = [];
  const rec = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(rec);
    else if (isPlainObject(x)) {
      if (Array.isArray(x.tasks)) rec(x.tasks);
      else if (typeof x.id === "string") out.push(x as Task);
    }
  };
  rec(v);
  return out;
}

const M4_TABLE: Record<string, "habits" | "habit_sections" | "timers" | "countdowns" | "matrix_profiles"> = {
  habits: "habits",
  habitSections: "habit_sections",
  timers: "timers",
  countdowns: "countdowns",
  matrixProfiles: "matrix_profiles",
};

function importM4(store: Store, key: string, id: string, o: Loose, seq: number): boolean {
  const table = M4_TABLE[key];
  if (table) {
    if (store.collGet(table, id)) return false;
    store.collPut(table, id, o, { seq });
    return true;
  }
  if (key === "habitCheckins" || key === "habitRecords") {
    const habitId = typeof o.habitId === "string" ? o.habitId : "";
    const stamp = typeof o.checkinStamp === "number" ? o.checkinStamp : typeof o.stamp === "number" ? o.stamp : typeof o.recordStamp === "number" ? o.recordStamp : 0;
    const tbl = key === "habitCheckins" ? "habit_checkins" : "habit_records";
    if (store.get(`select 1 from ${tbl} where id = ?`, id)) return false;
    if (key === "habitCheckins" && store.get("select 1 from habit_checkins where habitId = ? and stamp = ?", habitId, stamp)) return false;
    store.run(`insert into ${tbl}(id, habitId, stamp, seq, json) values (?,?,?,?,?)`, id, habitId, stamp, seq, JSON.stringify(o));
    return true;
  }
  if (key === "pomodoros" || key === "pomodoroTiming") {
    if (store.get("select 1 from pomodoros where id = ?", id)) return false;
    const s = toMs(o.startTime);
    const e = toMs(o.endTime);
    store.run("insert into pomodoros(id, type, startMs, endMs, seq, createSeq, json) values (?,?,?,?,?,?,?)", id, key === "pomodoros" ? 0 : 1, Number.isNaN(s) ? 0 : s, Number.isNaN(e) ? 0 : e, seq, seq, JSON.stringify(o));
    return true;
  }
  if (key === "comments") {
    if (store.get("select 1 from comments where id = ?", id)) return false;
    store.run("insert into comments(id, taskId, projectId, createdTime, json) values (?,?,?,?,?)", id, String(o.taskId ?? ""), String(o.projectId ?? ""), String(o.createdTime ?? ""), JSON.stringify(o));
    return true;
  }
  if (key === "activities") {
    if (store.get("select 1 from activities where id = ?", id)) return false;
    store.run("insert into activities(id, taskId, projectId, action, whenMs, json) values (?,?,?,?,?,?)", id, typeof o.taskId === "string" ? o.taskId : null, String(o.projectId ?? ""), String(o.action ?? "T_UPDATE"), typeof o.when === "number" ? o.when : 0, JSON.stringify(o));
    return true;
  }
  if (key === "notifications") {
    if (store.get("select 1 from notifications where id = ?", id)) return false;
    store.run("insert into notifications(id, category, unread, whenMs, json) values (?,?,?,?,?)", id, typeof o.category === "string" ? o.category : null, o.unread ? 1 : 0, 0, JSON.stringify(o));
    return true;
  }
  return false;
}

/** Load a backup export snapshot into an EMPTY database. Objects are stored verbatim (no etag or time re-stamping). */
export function importBackup(dir: string, dbPath: string): ImportReport {
  const store = new Store(dbPath);
  try {
    if (store.get<{ n: number }>("select count(*) as n from tasks")!.n > 0 || store.collCount("projects") > 0) {
      throw new Error("database is not empty; import needs an empty database");
    }
    const svc = new Service(store);
    const files = walkJson(dir);
    const read = (rel: string): unknown => JSON.parse(readFileSync(join(dir, rel), "utf8"));
    const counts: Record<string, number> = {};
    const report: ImportReport = { counts, blobs: 0, skippedFiles: 0, duplicates: 0 };
    const used = new Set<string>();
    const fileFor = (re: RegExp): string | undefined => files.find((f) => re.test(f));
    const files_: Record<string, string> = {};

    store.tx(() => {
      const seq = store.seq();
      let pos = 0;
      const seen = new Set<string>();
      const addTasks = (tasks: Task[], label: string): void => {
        let n = 0;
        for (const t of tasks) {
          if (seen.has(t.id)) {
            if (label !== "completed") report.duplicates++;
            continue;
          }
          seen.add(t.id);
          store.putTask(t, { seq, pos: ++pos });
          n++;
        }
        counts[label] = (counts[label] ?? 0) + n;
      };

      // sync payload
      const syncRel = fileFor(/(^|\/)api_v3_batch_check_0\.json$/);
      if (syncRel) {
        used.add(syncRel);
        files_.sync = syncRel;
        const s = read(syncRel) as Loose;
        const bean = (s.syncTaskBean ?? {}) as Loose;
        addTasks([...((bean.update as Task[]) ?? []), ...((bean.add as Task[]) ?? [])], "tasks.open");
        const coll = (table: "projects" | "project_groups" | "filters" | "tags", arr: unknown, key: string, label: string): void => {
          let n = 0;
          for (const o of (Array.isArray(arr) ? arr : []) as Loose[]) {
            store.collPut(table, String(o[key]), o, { seq });
            n++;
          }
          counts[label] = n;
        };
        coll("projects", s.projectProfiles, "id", "projects");
        coll("project_groups", s.projectGroups, "id", "projectGroups");
        coll("filters", s.filters, "id", "filters");
        coll("tags", s.tags, "name", "tags");
        loadOrderBean(store, "v2", s.syncOrderBean as OrderBean, seq);
        loadOrderBean(store, "v3", s.syncOrderBeanV3 as OrderBean, seq);
        const env: SyncEnvelope = {
          tagUpdate: (bean.tagUpdate as unknown[]) ?? [],
          checks: s.checks === undefined ? null : (s.checks as unknown[] | null),
          remindChanges: (s.remindChanges as unknown[]) ?? [],
          syncTaskOrderBean: s.syncTaskOrderBean as Loose,
          filtersNull: s.filters === null || s.filters === undefined,
        };
        store.setMetaJson("syncEnvelope", env);
        if (typeof s.inboxId === "string") {
          store.setMeta("inboxId", s.inboxId);
          const m = /(\d+)$/.exec(s.inboxId);
          if (m) store.setMeta("userId", m[1]!);
        }
        if (typeof s.checkPoint === "number") store.setMeta("sourceCheckPoint", String(s.checkPoint));
      }

      // completed, won't do, trash
      const merged = fileFor(/(^|\/)completed-tasks-merged\.json$/);
      const pages = fileFor(/(^|\/)completed-pages\.json$/);
      const compRel = merged ?? pages;
      if (compRel) {
        used.add(compRel);
        if (merged) used.add(merged);
        if (pages) used.add(pages);
        files_.completed = compRel;
        addTasks(flattenTasks(read(compRel)), "completed");
      }
      const wd = fileFor(/(^|\/)wontdo-closed\.json$/);
      if (wd) {
        used.add(wd);
        addTasks(flattenTasks(read(wd)), "wontdo");
      }
      const tr = fileFor(/(^|\/)trash-pages\.json$/);
      if (tr) {
        used.add(tr);
        addTasks(flattenTasks(read(tr)), "trash");
      }

      // attachments index (pending records: bytes are not in the export)
      const ai = fileFor(/(^|\/)attachments-index\.json$/);
      if (ai) {
        used.add(ai);
        let n = 0;
        for (const a of read(ai) as Loose[]) {
          store.run(
            `insert into attachments(id, taskId, projectId, taskSet, fileName, size, type, path, refId, state, file, json) values (?,?,?,?,?,?,?,?,?,?,?,?)`,
            String(a.attachmentId), String(a.taskId), String(a.projectId), (a.taskSet as string) ?? null, (a.fileName as string) ?? null,
            (a.size as number) ?? null, (a.type as string) ?? null, (a.path as string) ?? null, (a.refId as string) ?? null,
            "pending", null, JSON.stringify(a),
          );
          n++;
        }
        counts.attachmentIndex = n;
      }

      // templates
      const tp = fileFor(/(^|\/)api_v2_templates\.json$/);
      if (tp) {
        used.add(tp);
        files_.templates = tp;
        const t = read(tp) as Loose;
        let n = 0;
        for (const kind of ["taskTemplates", "noteTemplates"] as const) {
          ((t[kind] as Loose[]) ?? []).forEach((o, i) => {
            store.run("insert into templates(id, kind, pos, json) values (?,?,?,?)", String(o.id), kind, i + 1, JSON.stringify(o));
            n++;
          });
        }
        store.setMetaJson("templatesMerged", t.merged ?? null);
        counts.templates = n;
      }

      // columns (map projectId -> [column])
      const cf = fileFor(/(^|\/)api_v2_column__from=[^/]*\.json$/);
      if (cf) {
        used.add(cf);
        files_.columns = cf;
        const m = read(cf) as Record<string, Loose[]>;
        let n = 0;
        for (const list of Object.values(m)) for (const c of list) store.collPut("columns", String(c.id), c, { seq }), n++;
        counts.columns = n;
      }

      // habits, focus records, timers, countdowns: stored verbatim, no counters recomputed and no re-stamping
      for (const ent of M4_ENTITIES) {
        let rel: string | undefined;
        for (const re of ent.patterns) {
          rel = files.find((f) => re.test(f));
          if (rel) break;
        }
        if (!rel) continue;
        used.add(rel);
        files_[ent.key] = rel;
        let n = 0;
        for (const o of listOf(read(rel))) {
          const id = o[ent.idKey];
          if (typeof id !== "string" || !id) continue;
          if (importM4(store, ent.key, id, o, seq)) n++;
          else report.duplicates++;
        }
        counts[ent.label] = n;
      }

      // singleton docs
      for (const d of DOC_FILES) {
        const rel = fileFor(d.re);
        if (!rel) continue;
        used.add(rel);
        store.putDoc(d.name, read(rel), rel);
      }

      // everything else passes through verbatim
      for (const rel of files) {
        if (used.has(rel)) continue;
        try {
          store.run("insert into blobs(relpath, json) values (?,?)", rel, JSON.stringify(read(rel)));
          report.blobs++;
        } catch {
          report.skippedFiles++;
        }
      }
      store.setMeta("templatesSeeded", "1");
      store.setMeta("projectTemplatesSeeded", "1");
      store.setMetaJson("files", files_);
    });
    // After import, a fresh sync must pick everything up from checkpoint 0 only; the import stamp is the base.
    counts.tasks = store.get<{ n: number }>("select count(*) as n from tasks")!.n;
    void svc;
    return report;
  } finally {
    store.close();
  }
}

function writeJson(root: string, rel: string, data: unknown): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(data), { mode: 0o600 });
}

/** Closed-history paging (50 rows a page; each page overlaps by repeating the previous page's last row for client compat). */
export function pageClosed(rows: Task[]): Task[][] {
  const pages: Task[][] = [];
  for (let i = 0; ; i++) {
    const start = (CLOSED_PAGE_SIZE - 1) * i;
    const page = rows.slice(start, start + CLOSED_PAGE_SIZE);
    if (page.length === 0) break;
    pages.push(page);
    if (page.length < CLOSED_PAGE_SIZE) break;
  }
  return pages;
}

export function pageTrash(rows: Task[]): Array<{ tasks: Task[]; next: number }> {
  const pages: Array<{ tasks: Task[]; next: number }> = [];
  for (let off = 0; off < rows.length; off += TRASH_PAGE_SIZE) {
    const tasks = rows.slice(off, off + TRASH_PAGE_SIZE);
    pages.push({ tasks, next: off + tasks.length });
  }
  return pages;
}

export function exportBackup(dbPath: string, outDir: string): Record<string, number> {
  const store = new Store(dbPath);
  try {
    const svc = new Service(store);
    const files = store.getMetaJson<Record<string, string>>("files") ?? {};
    const counts: Record<string, number> = {};
    mkdirSync(outDir, { recursive: true, mode: 0o700 });

    const tasksWhere = (where: string): Task[] =>
      store.all<{ json: string }>(`select json from tasks where ${where} order by pos`).map((r) => JSON.parse(r.json) as Task);
    const completed = tasksWhere(`deleted = 0 and status = ${TaskStatus.Completed}`);
    const wontdo = tasksWhere(`deleted = 0 and status = ${TaskStatus.WontDo}`);
    const trash = tasksWhere("deleted = 1");

    const sync = buildCheck(svc, 0);
    const srcCp = store.getMeta("sourceCheckPoint");
    if (srcCp !== undefined) sync.checkPoint = Number(srcCp);
    writeJson(outDir, files.sync ?? F.sync, sync);
    counts["tasks.open"] = sync.syncTaskBean.update.length;
    counts.projects = sync.projectProfiles?.length ?? 0;
    counts.projectGroups = sync.projectGroups?.length ?? 0;
    counts.filters = sync.filters?.length ?? 0;
    counts.tags = sync.tags?.length ?? 0;

    writeJson(outDir, F.completedMerged, completed);
    writeJson(outDir, F.completedPages, pageClosed(completed));
    writeJson(outDir, F.wontdo, wontdo);
    writeJson(outDir, F.trash, pageTrash(trash));
    counts.completed = completed.length;
    counts.wontdo = wontdo.length;
    counts.trash = trash.length;

    const setOf = (taskId: string): string => {
      const r = store.getTaskRow(taskId);
      if (!r) return "gone";
      return r.deleted ? "trash" : r.status === TaskStatus.Completed ? "completed" : r.status === TaskStatus.WontDo ? "wontdo" : "open";
    };
    const idx = store
      .all<{ id: string; taskId: string; projectId: string; taskSet: string | null; fileName: string | null; size: number | null; type: string | null; path: string | null; refId: string | null; json: string }>(
        "select * from attachments order by rowid",
      )
      .map((a) => {
        const orig = JSON.parse(a.json) as Loose;
        return isPlainObject(orig) && "attachmentId" in orig
          ? { ...orig, taskSet: setOf(a.taskId) }
          : { taskId: a.taskId, projectId: a.projectId, taskSet: setOf(a.taskId), attachmentId: a.id, fileName: a.fileName, size: a.size, type: a.type, path: a.path, refId: a.refId };
      });
    writeJson(outDir, F.attachments, idx);
    counts.attachmentIndex = idx.length;

    const tmpl = (kind: string): unknown[] => store.all<{ json: string }>("select json from templates where kind = ? order by pos", kind).map((r) => JSON.parse(r.json));
    const tt = tmpl("taskTemplates");
    const nt = tmpl("noteTemplates");
    if (tt.length || nt.length || files.templates) {
      writeJson(outDir, files.templates ?? F.templates, { taskTemplates: tt, noteTemplates: nt, merged: store.getMetaJson("templatesMerged") ?? null });
    }
    counts.templates = tt.length + nt.length;

    if (files.columns || store.collCount("columns") > 0) {
      const map: Record<string, Loose[]> = {};
      for (const c of store.collAll<Loose>("columns")) (map[c.projectId as string] ??= []).push(c);
      writeJson(outDir, files.columns ?? F.columns, map);
    }
    counts.columns = store.collCount("columns");

    const parse = (r: { json: string }): Loose => JSON.parse(r.json) as Loose;
    const m4: Record<string, Loose[]> = {
      habits: store.collAll<Loose>("habits"),
      habitSections: store.collAll<Loose>("habit_sections"),
      habitCheckins: store.all<{ json: string }>("select json from habit_checkins order by rowid").map(parse),
      habitRecords: store.all<{ json: string }>("select json from habit_records order by rowid").map(parse),
      pomodoros: store.all<{ json: string }>("select json from pomodoros where type = 0 order by rowid").map(parse),
      pomodoroTiming: store.all<{ json: string }>("select json from pomodoros where type = 1 order by rowid").map(parse),
      timers: store.collAll<Loose>("timers"),
      countdowns: store.collAll<Loose>("countdowns"),
      comments: store.all<{ json: string }>("select json from comments order by rowid").map(parse),
      activities: store.all<{ json: string }>("select json from activities order by rowid").map(parse),
      notifications: store.all<{ json: string }>("select json from notifications order by rowid").map(parse),
      matrixProfiles: store.collAll<Loose>("matrix_profiles"),
    };
    for (const ent of M4_ENTITIES) {
      const list = m4[ent.key]!;
      counts[ent.label] = list.length;
      if (list.length > 0 || files[ent.key]) writeJson(outDir, files[ent.key] ?? ent.def, list);
    }

    for (const d of DOC_FILES) {
      const doc = store.getDoc(d.name);
      if (doc) writeJson(outDir, doc.file ?? d.def, doc.json);
    }
    for (const b of store.all<{ relpath: string; json: string }>("select relpath, json from blobs order by relpath")) writeJson(outDir, b.relpath, JSON.parse(b.json));
    counts.blobs = store.get<{ n: number }>("select count(*) as n from blobs")!.n;
    // v2 order bean is part of `sync`; echo record counts for the report
    counts.orderRecords = [...Object.values(readOrderBean(store, "v2").orderByType), ...Object.values(readOrderBean(store, "v3").orderByType)].reduce(
      (n, scopes) => n + Object.values(scopes).reduce((m, l) => m + l.changed.length + l.deleted.length, 0),
      0,
    );
    return counts;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------------------------- diff

export interface DiffRow {
  entity: string;
  a: number;
  b: number;
  onlyA: number;
  onlyB: number;
  fieldMismatches: string[];
}
export interface DiffReport {
  rows: DiffRow[];
  filesOnlyA: string[];
  filesOnlyB: string[];
  mismatches: number;
}

interface Extracted {
  entities: Record<string, Map<string, unknown>>;
  rest: unknown;
}

function byKey(list: unknown, key: string): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (Array.isArray(list)) list.forEach((o, i) => m.set(isPlainObject(o) && o[key] !== undefined ? String(o[key]) : `#${i}`, o));
  return m;
}

function orderEntities(bean: unknown, label: string, into: Record<string, Map<string, unknown>>): void {
  const m = new Map<string, unknown>();
  if (isPlainObject(bean) && isPlainObject(bean.orderByType)) {
    for (const [tk, scopes] of Object.entries(bean.orderByType)) {
      if (!isPlainObject(scopes)) continue;
      for (const [sc, leaf] of Object.entries(scopes)) {
        if (!isPlainObject(leaf)) continue;
        for (const bucket of ["changed", "deleted"]) {
          const arr = Array.isArray(leaf[bucket]) ? (leaf[bucket] as unknown[]) : [];
          arr.forEach((rec, i) => m.set(`${tk}|${sc}|${bucket}|${i}`, rec));
        }
        for (const k of Object.keys(leaf)) if (k !== "changed" && k !== "deleted") m.set(`${tk}|${sc}|extra|${k}`, leaf[k]);
        m.set(`${tk}|${sc}|leaf`, { changedCount: Array.isArray(leaf.changed) ? leaf.changed.length : null, deletedCount: Array.isArray(leaf.deleted) ? leaf.deleted.length : null });
      }
    }
  }
  into[label] = m;
}

function flatDedupe(v: unknown): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const t of flattenTasks(v)) if (!m.has(t.id)) m.set(t.id, t);
  return m;
}

function extract(rel: string, json: unknown): Extracted {
  const base = rel.split("/").pop()!;
  if (/^api_v3_batch_check_0\.json$/.test(base) && isPlainObject(json)) {
    const bean = (json.syncTaskBean ?? {}) as Loose;
    const entities: Record<string, Map<string, unknown>> = {
      "tasks.open": byKey([...((bean.update as unknown[]) ?? []), ...((bean.add as unknown[]) ?? [])], "id"),
      projects: byKey(json.projectProfiles, "id"),
      projectGroups: byKey(json.projectGroups, "id"),
      filters: byKey(json.filters, "id"),
      tags: byKey(json.tags, "name"),
    };
    orderEntities(json.syncOrderBean, "orders.v2", entities);
    orderEntities(json.syncOrderBeanV3, "orders.v3", entities);
    const rest: Loose = { ...json };
    for (const k of ["projectProfiles", "projectGroups", "filters", "tags", "syncOrderBean", "syncOrderBeanV3"]) delete rest[k];
    rest.syncTaskBean = { ...bean, update: undefined, add: undefined, updateCount: Array.isArray(bean.update) ? bean.update.length : null, addCount: Array.isArray(bean.add) ? bean.add.length : null };
    rest.filtersIsNull = json.filters === null;
    rest.groupsIsNull = json.projectGroups === null;
    return { entities, rest };
  }
  if (base === "completed-tasks-merged.json" || base === "completed-pages.json") return { entities: { completed: flatDedupe(json) }, rest: null };
  if (base === "trash-pages.json") {
    const nexts = Array.isArray(json) ? (json as Loose[]).map((p) => p.next) : [];
    return { entities: { trash: flatDedupe(json) }, rest: { nexts } };
  }
  if (base === "wontdo-closed.json") return { entities: { wontdo: flatDedupe(json) }, rest: null };
  if (base === "attachments-index.json") return { entities: { attachmentIndex: byKey(json, "attachmentId") }, rest: null };
  const m4 = M4_BY_BASE(base);
  if (m4 && Array.isArray(json)) return { entities: { [m4.label]: byKey(json, m4.idKey) }, rest: null };
  if (base === "api_v2_templates.json" && isPlainObject(json)) {
    return { entities: { templates: new Map([...byKey(json.taskTemplates, "id"), ...byKey(json.noteTemplates, "id")]) }, rest: { merged: json.merged ?? null } };
  }
  return { entities: {}, rest: json };
}

/** Field-name paths where a and b differ. Array order counts, object key order does not. Array indexes become `[]`. */
export function diffPaths(a: unknown, b: unknown, prefix: string, out: Set<string>, depthLimit = 12): void {
  if (a === b) return;
  if (depthLimit <= 0) return void out.add(prefix || "$");
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.add(`${prefix}[] (length)`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffPaths(a[i], b[i], `${prefix}[]`, out, depthLimit - 1);
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const inA = Object.prototype.hasOwnProperty.call(a, k);
      const inB = Object.prototype.hasOwnProperty.call(b, k);
      const p = prefix ? `${prefix}.${maskKey(k)}` : maskKey(k);
      if (inA !== inB) out.add(`${p} (${inA ? "missing in B" : "missing in A"})`);
      else diffPaths(a[k], b[k], p, out, depthLimit - 1);
    }
    return;
  }
  out.add(`${prefix || "$"} (value)`);
}

/** Never print ids, names or other values: dynamic keys become placeholders. */
export function maskKey(k: string): string {
  if (/^[0-9a-f]{24}$/.test(k)) return "<id>";
  if (/^inbox\d+$/.test(k)) return "<inbox>";
  if (/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k)) return k;
  return "<key>";
}

export function maskPath(p: string): string {
  return p.replace(/[0-9a-f]{24}/g, "<id>").replace(/inbox\d+/g, "<inbox>").replace(/\d{9,}/g, "<n>");
}

export function diffExports(dirA: string, dirB: string): DiffReport {
  const fa = new Set(walkJson(dirA));
  const fb = new Set(walkJson(dirB));
  const rows = new Map<string, DiffRow>();
  const row = (e: string): DiffRow => {
    let r = rows.get(e);
    if (!r) rows.set(e, (r = { entity: e, a: 0, b: 0, onlyA: 0, onlyB: 0, fieldMismatches: [] }));
    return r;
  };
  const mism = new Map<string, Set<string>>();
  const note = (e: string, p: string): void => {
    let s = mism.get(e);
    if (!s) mism.set(e, (s = new Set()));
    s.add(p);
  };
  const seenEntities = new Set<string>();
  const rep: DiffReport = { rows: [], filesOnlyA: [], filesOnlyB: [], mismatches: 0 };

  // Roles that several files can supply (completed pages and merged) are compared once per role per side.
  const loadSide = (dir: string, files: Set<string>): Map<string, Extracted> => {
    const m = new Map<string, Extracted>();
    for (const rel of files) {
      let json: unknown;
      try {
        json = JSON.parse(readFileSync(join(dir, rel), "utf8"));
      } catch {
        json = { __unparsable: true };
      }
      m.set(rel, extract(rel, json));
    }
    return m;
  };
  const A = loadSide(dirA, fa);
  const B = loadSide(dirB, fb);
  for (const rel of fa) if (!fb.has(rel)) rep.filesOnlyA.push(maskPath(rel));
  for (const rel of fb) if (!fa.has(rel)) rep.filesOnlyB.push(maskPath(rel));

  for (const [rel, ea] of A) {
    const eb = B.get(rel);
    if (!eb) continue;
    for (const ent of new Set([...Object.keys(ea.entities), ...Object.keys(eb.entities)])) {
      const ma = ea.entities[ent] ?? new Map();
      const mb = eb.entities[ent] ?? new Map();
      const key = `${ent}`;
      // the same entity type can appear in two files (completed pages and merged): count it once
      if (!seenEntities.has(key)) {
        row(key).a += ma.size;
        row(key).b += mb.size;
        seenEntities.add(key);
      }
      for (const [id, va] of ma) {
        if (!mb.has(id)) row(key).onlyA++;
        else {
          const s = new Set<string>();
          diffPaths(va, mb.get(id), "", s);
          for (const p of s) note(key, p);
        }
      }
      for (const id of mb.keys()) if (!ma.has(id)) row(key).onlyB++;
    }
    const s = new Set<string>();
    if (isPlainObject(ea.rest) || isPlainObject(eb.rest) || Array.isArray(ea.rest) || ea.rest !== null) {
      diffPaths(ea.rest, eb.rest, "", s);
    }
    const label = `file:${maskPath(rel)}`;
    const isEntityFile = Object.keys(ea.entities).length > 0;
    const topOnly = (p: string): string => (isEntityFile ? p : p.split(/[.[]/)[0] + (p.includes("(") ? p.slice(p.indexOf(" (")) : ""));
    for (const p of s) {
      // for passthrough documents only the top-level field name is printed (deeper keys can be user data)
      note(isEntityFile ? `${label}#rest` : label, topOnly(p));
    }
    if (!isEntityFile) {
      row(label).a += 1;
      row(label).b += 1;
    }
  }
  for (const [k, set] of mism) row(k).fieldMismatches = [...set].sort();
  rep.rows = [...rows.values()].sort((x, y) => x.entity.localeCompare(y.entity));
  rep.mismatches =
    rep.rows.reduce((n, r) => n + r.onlyA + r.onlyB + r.fieldMismatches.length + (r.a !== r.b ? 1 : 0), 0) + rep.filesOnlyA.length + rep.filesOnlyB.length;
  return rep;
}

export function formatDiff(rep: DiffReport, opts: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  const important = rep.rows.filter((r) => !r.entity.startsWith("file:") || r.fieldMismatches.length || r.a !== r.b);
  for (const r of important) {
    lines.push(`${r.entity.padEnd(22)} A=${r.a} B=${r.b} onlyA=${r.onlyA} onlyB=${r.onlyB} fieldMismatches=${r.fieldMismatches.length}`);
    for (const f of r.fieldMismatches) lines.push(`    field: ${f}`);
  }
  const passthrough = rep.rows.filter((r) => r.entity.startsWith("file:") && !r.fieldMismatches.length && r.a === r.b).length;
  if (opts.verbose || passthrough) lines.push(`passthrough documents identical: ${passthrough}`);
  for (const f of rep.filesOnlyA) lines.push(`file only in A: ${f}`);
  for (const f of rep.filesOnlyB) lines.push(`file only in B: ${f}`);
  lines.push(`mismatches: ${rep.mismatches}`);
  return lines.join("\n");
}
