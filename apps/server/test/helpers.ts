import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp, type AppOptions, type BuiltApp } from "../src/app.js";
import { pageClosed, pageTrash } from "../src/importExport.js";

export function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nt-"));
}

export function mk(over: Partial<AppOptions> = {}): BuiltApp & { call: (m: string, url: string, body?: unknown) => Promise<{ status: number; json: any }> } {
  const b = buildApp({ dbPath: ":memory:", dataDir: tmp(), noAuth: true, ...over });
  const call = async (m: string, url: string, body?: unknown) => {
    const r = await b.app.inject({ method: m as "GET", url, ...(body !== undefined ? { payload: body as object } : {}) });
    let json: any;
    try { json = r.json(); } catch { json = r.body; }
    return { status: r.statusCode, json };
  };
  return { ...b, call };
}

let n = 0;
export const hex = (): string => (++n).toString(16).padStart(24, "0");

export function task(over: Record<string, unknown> = {}): any {
  return { id: hex(), projectId: "inbox1", title: "t", status: 0, priority: 0, sortOrder: 0, kind: "TEXT", ...over };
}
export async function seedProject(call: ReturnType<typeof mk>["call"], over: Record<string, unknown> = {}): Promise<string> {
  const id = hex();
  await call("POST", "/api/v2/batch/project", { add: [{ id, name: "p", sortOrder: 0, kind: "TASK", ...over }] });
  return id;
}

export function w(root: string, rel: string, data: unknown): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data));
}

/** A hand-made export with the same file layout as the real one. No real data. */
export function makeExport(root: string, opts: { completed?: number; trash?: number } = {}): { ids: Record<string, string> } {
  const nC = opts.completed ?? 120;
  const nT = opts.trash ?? 60;
  const pid = "aaaaaaaaaaaaaaaaaaaaaaa1";
  const inbox = "inbox424242";
  const mkT = (i: number, extra: Record<string, unknown>) => ({
    id: (0x1000 + i).toString(16).padStart(24, "0"), projectId: i % 2 ? pid : inbox, title: `synthetic ${i}`, status: 0, priority: 0,
    sortOrder: -i * 1099511627776, kind: "TEXT", etag: `e${i}`, modifiedTime: "2026-01-01T00:00:00.000+0000", createdTime: "2026-01-01T00:00:00.000+0000",
    deleted: 0, creator: 424242, timeZone: "UTC", isFloating: false, reminders: [], exDate: [], items: [], zzUnknownField: { nested: [1, null] }, ...extra,
  });
  const open = [mkT(1, { tags: ["alpha"], repeatFrom: null }), mkT(2, { attachments: [{ id: "att1", refId: "att1", path: "/files/upload/1/202611/x.png", size: 10, fileType: "IMAGE", status: 0, createdTime: "2026-01-01T00:00:00.000+0000" }] }), mkT(3, { completedTime: "2026-01-02T00:00:00.000+0000", repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1" })];
  const completed = Array.from({ length: nC }, (_, i) => mkT(100 + i, { status: 2, completedTime: new Date(Date.UTC(2026, 5, 1) - i * 60000).toISOString().replace("Z", "+0000") }));
  const trash = Array.from({ length: nT }, (_, i) => mkT(5000 + i, { deleted: 1, deletedTime: 1790000000000 - i, deletedBy: 424242, status: i % 3 ? 0 : 2 }));
  const sync = {
    checkPoint: 1794773057425,
    syncTaskBean: { update: open, tagUpdate: [], delete: [], add: [], empty: false },
    projectProfiles: [{ id: pid, name: "proj", sortOrder: -1, kind: "TASK", viewMode: "list", etag: "pe1", closed: null, groupId: null, sortOption: { groupBy: "sortOrder", orderBy: "dueDate", order: "asc" }, extraProjectField: 5 }],
    projectGroups: [], filters: null,
    tags: [{ name: "alpha", rawName: "Alpha", label: "Alpha", color: "#fff", sortOrder: 0, type: 1, etag: "te1" }],
    syncTaskOrderBean: { taskOrderByDate: {}, taskOrderByPriority: {}, taskOrderByProject: {} },
    syncOrderBean: { orderByType: { projectPinned: { all: { changed: [], deleted: [{ id: pid, order: null, type: 1 }] } } } },
    syncOrderBeanV3: { orderByType: { "taskBy#sortOrder|none_dueDate": { [pid]: { changed: [{ id: open[0]!.id, order: 5, type: 1 }, { id: open[1]!.id, order: 9, type: 1 }], deleted: [] } }, "taskBy#dueDate|noDate_dueDate": { all: { changed: [{ id: open[2]!.id, order: 1, type: 1 }], deleted: [] } } } },
    inboxId: inbox, checks: null, remindChanges: [],
  };
  w(root, "captured/api_v3_batch_check_0.json", sync);
  w(root, "captured/api_v3_batch_check_1790000000000.json", { checkPoint: 1790000000001, syncTaskBean: { update: [], tagUpdate: [], delete: [], add: [], empty: true }, projectProfiles: null });
  w(root, "completed-tasks-merged.json", completed);
  w(root, "completed-pages.json", pageClosed(completed));
  w(root, "trash-pages.json", pageTrash(trash));
  w(root, "wontdo-closed.json", []);
  w(root, "attachments-index.json", [{ taskId: open[1]!.id, projectId: inbox, taskSet: "open", attachmentId: "att1", fileName: "pic.png", size: 10, type: "IMAGE", path: "/files/upload/1/202611/x.png", refId: "att1" }]);
  w(root, "captured/api_v2_user_preferences_settings__includeWeb=true.json", { id: 424242, theme: "night", zzUnknownSetting: true });
  w(root, "captured/api_v2_user_status.json", { userId: "424242", pro: false, needSubscribe: true, inboxId: inbox, proEndDate: "2020-01-01T00:00:00.000+0000" });
  w(root, "captured/api_v2_user_profile.json", { username: "someone", name: "x" });
  w(root, "captured/api_v2_configs_limits.json", { free: { projectNumber: 9 }, pro: {}, team: {} });
  w(root, "captured/api_v2_templates.json", { taskTemplates: [{ id: "tm1", title: "a", order: 1 }], noteTemplates: [{ id: "tm2", title: "b" }], merged: null });
  w(root, "captured/api_v2_column__from=0.json", {});
  w(root, "captured/api_v2_statistics_color.json", { project2color: { "some list": "#000" }, tag2color: {} });
  w(root, "captured/api_v2_habits.json", []);
  w(root, "habits.json", []);
  return { ids: { pid, inbox, open0: open[0]!.id, completed0: completed[0]!.id } };
}

export type App = FastifyInstance;
