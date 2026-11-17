import type { Task } from "../lib/core";
/** A local shadow of the last server row. Never sent or exported as entity data. */
export function stripLocal<T extends object>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (k.startsWith("_")) delete out[k];
  return out as T;
}

export function withSyncBase<T extends object>(row: T): T {
  return { ...row, _syncBase: stripLocal(row) };
}

const META = new Set(["etag", "modifiedTime", "createdTime"]);
/** Missing properties are explicit removals, distinct from null. Arrays/objects are one field. */
export function changedPayload<T extends object>(row: T, omit: readonly string[] = []): T {
  const current = stripLocal(row) as Record<string, unknown>;
  const base = (row as Record<string, unknown>)._syncBase as Record<string, unknown> | undefined;
  if (!base) {
    for (const k of omit) delete current[k];
    return current as T; // pre-upgrade pending op: legacy whole-object update
  }
  const out: Record<string, unknown> = {};
  const unset: string[] = [];
  for (const key of new Set([...Object.keys(base), ...Object.keys(current)])) {
    if (META.has(key) || omit.includes(key) || key.startsWith("_")) continue;
    if (JSON.stringify(current[key]) === JSON.stringify(base[key])) continue;
    if (current[key] === undefined) unset.push(key);
    else out[key] = current[key];
  }
  // Routing/identity fields must stay visible to the existing permission layer.
  for (const key of ["id", "name", "projectId", "habitId"]) {
    if (key === "name" && current.id !== undefined) continue;
    if (current[key] !== undefined && !omit.includes(key)) out[key] = current[key];
  }
  out._sync = { baseModifiedTime: base.modifiedTime ?? null, baseEtag: base.etag ?? null, unset };
  return out as T;
}

/** Project an acknowledged or in-flight field update onto a local shadow. */
export function applyFields(base: Record<string, unknown>, wire: Record<string, unknown>): Record<string, unknown> {
  const next = { ...base, ...wire };
  delete next._sync;
  const unset = (wire._sync as { unset?: string[] } | undefined)?.unset ?? [];
  for (const key of unset) delete next[key];
  return next;
}

const TASK_SERVER_FIELDS = ["parentId", "childIds", "attachments", "commentCount", "focusSummaries", "createdTime", "creator", "deleted", "deletedTime", "deletedBy", "projectId"];
export function updatePayload(t: Task): Task { return changedPayload(t, TASK_SERVER_FIELDS); }
export const pendingKey = (kind: string, key: string): string => `${kind}:${key}`;

export async function mergeColl<T>(
  table: import("dexie").Table<T, string>,
  rows: T[] | null | undefined,
  keyOf: (r: T) => string,
  kind: string,
  pending: Set<string>,
  full: boolean,
): Promise<void> {
  if (!rows) {
    if (full) {
      // a full check with a null collection means none exist
      const all = await table.toArray();
      for (const r of all) if (!pending.has(pendingKey(kind, keyOf(r)))) await table.delete(keyOf(r));
    }
    return;
  }
  const keep = new Set(rows.map(keyOf));
  for (const r of rows) if (!pending.has(pendingKey(kind, keyOf(r)))) await table.put(withSyncBase(r as object) as T);
  if (full) {
    const all = await table.toArray();
    for (const r of all) {
      const k = keyOf(r);
      if (!keep.has(k) && !pending.has(pendingKey(kind, k))) await table.delete(k);
    }
  }
}
