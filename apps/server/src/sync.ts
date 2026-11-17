import type { BatchCheckResponse, Filter, Loose, Project, ProjectGroup, Tag, Task } from "@noortasks/core";
import { readOrderBean } from "./orders.js";
import type { Service } from "./service.js";

export interface SyncEnvelope {
  tagUpdate?: unknown[];
  checks?: unknown[] | null;
  remindChanges?: unknown[];
  syncTaskOrderBean?: Loose;
  /** true when the source sent `filters: null` (no filters ever). */
  filtersNull?: boolean;
}

const EMPTY_TASK_ORDER = () => ({ taskOrderByDate: {}, taskOrderByPriority: {}, taskOrderByProject: {} });

/**
 * `GET /api/v3/batch/check/{cp}`. cp 0 = full state (open tasks only); otherwise a delta since cp.
 * Unchanged collections are null on a delta. Tasks that became completed or won't-do arrive in
 * `update`; trashed and permanently deleted tasks arrive in `delete`.
 */
export function buildCheck(svc: Service, cp: number): BatchCheckResponse {
  const store = svc.store;
  const env = store.getMetaJson<SyncEnvelope>("syncEnvelope") ?? {};
  const last = store.lastSeq();
  const checkPoint = Math.max(last, cp);

  if (cp <= 0) {
    const tasks = store.all<{ json: string }>("select json from tasks where deleted = 0 and status = 0 order by pos").map((r) => JSON.parse(r.json) as Task);
    const filters = store.collAll<Filter>("filters");
    return {
      checkPoint,
      syncTaskBean: { update: tasks, tagUpdate: env.tagUpdate ?? [], delete: [], add: [], empty: false },
      projectProfiles: store.collAll<Project>("projects"),
      projectGroups: store.collAll<ProjectGroup>("project_groups"),
      filters: filters.length === 0 && (env.filtersNull ?? true) ? null : filters,
      tags: store.collAll<Tag>("tags"),
      syncTaskOrderBean: (env.syncTaskOrderBean as never) ?? EMPTY_TASK_ORDER(),
      syncOrderBean: readOrderBean(store, "v2"),
      syncOrderBeanV3: readOrderBean(store, "v3"),
      inboxId: svc.inboxId,
      checks: env.checks === undefined ? null : env.checks,
      remindChanges: env.remindChanges ?? [],
    };
  }

  const add: Task[] = [];
  const update: Task[] = [];
  const del: Array<{ taskId: string; projectId: string }> = [];
  const seenDeleted = new Set<string>();
  for (const r of store.all<{ id: string; projectId: string; deleted: number; createSeq: number; json: string }>(
    "select id, projectId, deleted, createSeq, json from tasks where seq > ? order by pos",
    cp,
  )) {
    if (r.deleted) {
      del.push({ taskId: r.id, projectId: r.projectId });
      seenDeleted.add(r.id);
    } else (r.createSeq > cp ? add : update).push(JSON.parse(r.json) as Task);
  }
  for (const t of store.tombstonesSince("task", cp)) {
    if (!seenDeleted.has(t.id)) del.push({ taskId: t.id, projectId: (t.extra?.projectId as string) ?? "" });
  }

  const nz = <T>(l: T[]): T[] | null => (l.length ? l : null);
  const out: BatchCheckResponse = {
    checkPoint,
    syncTaskBean: { update, tagUpdate: [], delete: del, add, empty: add.length + update.length + del.length === 0 },
    projectProfiles: nz(store.collChanged<Project>("projects", cp)),
    projectGroups: nz(store.collChanged<ProjectGroup>("project_groups", cp)),
    filters: nz(store.collChanged<Filter>("filters", cp)),
    tags: nz(store.collChanged<Tag>("tags", cp)),
    syncTaskOrderBean: EMPTY_TASK_ORDER(),
    syncOrderBean: readOrderBean(store, "v2", cp),
    syncOrderBeanV3: readOrderBean(store, "v3", cp),
    inboxId: null,
    checks: [],
    remindChanges: [],
  };
  // Deletions of lists, folders, filters, tags and columns: not observed on the wire (documented assumption).
  const gone = (kind: string): string[] => store.tombstonesSince(kind, cp).map((t) => t.id);
  const extra: Array<[string, string[]]> = [
    ["deletedProjects", gone("project")],
    ["deletedProjectGroups", gone("projectGroup")],
    ["deletedFilters", gone("filter")],
    ["deletedTags", gone("tag")],
  ];
  for (const [k, v] of extra) if (v.length) out[k] = v;
  return out;
}
