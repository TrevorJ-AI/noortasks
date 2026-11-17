import { clampOrder, isPlainObject, type OrderBean, type OrderByType, type OrderLeaf, type OrderRecord } from "@noortasks/core";
import type { Store } from "./store.js";

/** `v2` = legacy `syncOrderBean`, `v3` = `syncOrderBeanV3`. Same leaf grammar. */
export type OrderFamily = "v2" | "v3";

interface Row {
  typeKey: string;
  scope: string;
  bucket: string;
  pos: number;
  itemId: string;
  json: string;
}

/** Build the bean. With `since`, only records written after that checkpoint (and the scopes they sit in). */
export function readOrderBean(store: Store, family: OrderFamily, since = 0): OrderBean {
  const out: OrderByType = {};
  const rows =
    since > 0
      ? store.all<Row>("select typeKey, scope, bucket, pos, itemId, json from orders where family = ? and seq > ? order by typeKey, scope, bucket, pos", family, since)
      : store.all<Row>("select typeKey, scope, bucket, pos, itemId, json from orders where family = ? order by typeKey, scope, bucket, pos", family);
  if (since <= 0) {
    for (const s of store.all<{ typeKey: string; scope: string }>("select typeKey, scope from order_scopes where family = ? order by pos", family)) {
      ((out[s.typeKey] ??= {})[s.scope] ??= { changed: [], deleted: [] });
    }
  }
  for (const r of rows) {
    const leaf = ((out[r.typeKey] ??= {})[r.scope] ??= { changed: [], deleted: [] });
    (r.bucket === "changed" ? leaf.changed : leaf.deleted).push(JSON.parse(r.json) as OrderRecord);
  }
  return { orderByType: out };
}

function ensureScope(store: Store, family: OrderFamily, typeKey: string, scope: string): void {
  const have = store.get("select 1 as x from order_scopes where family = ? and typeKey = ? and scope = ?", family, typeKey, scope);
  if (!have) {
    const pos = (store.get<{ m: number | null }>("select max(pos) as m from order_scopes where family = ?", family)?.m ?? 0) + 1;
    store.run("insert into order_scopes(family, typeKey, scope, pos) values (?,?,?,?)", family, typeKey, scope, pos);
  }
}

function nextRowPos(store: Store, family: OrderFamily, typeKey: string, scope: string, bucket: string): number {
  return (
    (store.get<{ m: number | null }>(
      "select max(pos) as m from orders where family = ? and typeKey = ? and scope = ? and bucket = ?",
      family, typeKey, scope, bucket,
    )?.m ?? 0) + 1
  );
}

function upsertRecord(store: Store, family: OrderFamily, typeKey: string, scope: string, bucket: "changed" | "deleted", rec: OrderRecord, seq: number): void {
  const existing = store.get<{ pos: number }>(
    "select pos from orders where family = ? and typeKey = ? and scope = ? and bucket = ? and itemId = ?",
    family, typeKey, scope, bucket, rec.id,
  );
  const pos = existing?.pos ?? nextRowPos(store, family, typeKey, scope, bucket);
  store.run(
    `insert into orders(family, typeKey, scope, bucket, pos, itemId, seq, json) values (?,?,?,?,?,?,?,?)
     on conflict(family, typeKey, scope, bucket, pos) do update set itemId=excluded.itemId, seq=excluded.seq, json=excluded.json`,
    family, typeKey, scope, bucket, pos, rec.id, seq, JSON.stringify(rec),
  );
}

function removeRecord(store: Store, family: OrderFamily, typeKey: string, scope: string, bucket: string, id: string): void {
  store.run("delete from orders where family = ? and typeKey = ? and scope = ? and bucket = ? and itemId = ?", family, typeKey, scope, bucket, id);
}

/** Import a bean verbatim (positions follow the file). */
export function loadOrderBean(store: Store, family: OrderFamily, bean: OrderBean | undefined, seq: number): void {
  if (!bean || !isPlainObject(bean.orderByType)) return;
  for (const [typeKey, scopes] of Object.entries(bean.orderByType)) {
    for (const [scope, leaf] of Object.entries(scopes)) {
      ensureScope(store, family, typeKey, scope);
      for (const bucket of ["changed", "deleted"] as const) {
        const list = (leaf as OrderLeaf)[bucket] ?? [];
        list.forEach((rec, i) => {
          store.run(
            "insert into orders(family, typeKey, scope, bucket, pos, itemId, seq, json) values (?,?,?,?,?,?,?,?)",
            family, typeKey, scope, bucket, i + 1, String(rec.id), seq, JSON.stringify(rec),
          );
        });
      }
    }
  }
}

/** `POST batch/order` (v2 and v3): merge `{orderByType: {key: {scope: {changed, deleted}}}}` into the stored order. */
export function applyOrderBatch(store: Store, family: OrderFamily, body: unknown): { applied: number } {
  let applied = 0;
  if (!isPlainObject(body) || !isPlainObject(body.orderByType)) return { applied };
  const seq = store.seq();
  for (const [typeKey, scopes] of Object.entries(body.orderByType)) {
    if (!isPlainObject(scopes)) continue;
    for (const [scope, leaf] of Object.entries(scopes)) {
      if (!isPlainObject(leaf)) continue;
      ensureScope(store, family, typeKey, scope);
      for (const raw of Array.isArray(leaf.changed) ? leaf.changed : []) {
        if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
        const rec = { ...raw, ...(typeof raw.order === "number" ? { order: clampOrder(raw.order) } : {}) } as OrderRecord;
        removeRecord(store, family, typeKey, scope, "deleted", rec.id);
        upsertRecord(store, family, typeKey, scope, "changed", rec, seq);
        applied++;
      }
      for (const raw of Array.isArray(leaf.deleted) ? leaf.deleted : []) {
        if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
        const rec = raw as OrderRecord;
        removeRecord(store, family, typeKey, scope, "changed", rec.id);
        upsertRecord(store, family, typeKey, scope, "deleted", rec, seq);
        applied++;
      }
    }
  }
  return { applied };
}
