import { LEGACY_FIELDS, mergeUpdate } from "./fieldSync.js";
import { BatchError, formatServerDate, isPlainObject, newEtag, type BatchResponse, type Loose } from "@noortasks/core";
import type { Service } from "./service.js";
import type { CollName } from "./store.js";

export function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function emptyResult(): BatchResponse {
  return { id2etag: {}, id2error: {} };
}

export interface BatchCtx {
  now: string;
  nowMs: number;
  seq: number;
}

export interface SimpleHooks {
  /** Normalise a new object in place; return an error code to refuse it. */
  add?: (o: Loose, ctx: BatchCtx) => string | void;
  /** Normalise an updated object in place (`old` is the stored one); return an error code to refuse it. */
  update?: (o: Loose, old: Loose, ctx: BatchCtx) => string | void;
  /** Return an error code to refuse the delete; runs inside the transaction before the row goes. */
  del?: (id: string, old: Loose, ctx: BatchCtx) => string | void;
  /** Runs once after the batch, inside the transaction. */
  after?: (ctx: BatchCtx) => void;
  /** Fields kept from the stored copy when an update omits them. */
  keep?: string[];
}

/** The `{add, update, delete}` batch used by habits, sections, countdowns and timers. */
export function batchSimple(svc: Service, table: CollName, body: unknown, hooks: SimpleHooks = {}): BatchResponse {
  const res = emptyResult();
  const b = isPlainObject(body) ? body : {};
  const store = svc.store;
  store.tx(() => {
    const ctx: BatchCtx = { now: formatServerDate(svc.now()), nowMs: svc.now(), seq: store.seq() };
    for (const raw of asList(b.add)) {
      if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
      const id = raw.id;
      if (store.collGet(table, id)) {
        res.id2error[id] = BatchError.Existed;
        continue;
      }
      const o: Loose = { ...raw };
      const err = hooks.add?.(o, ctx);
      if (err) {
        res.id2error[id] = err;
        continue;
      }
      o.etag = newEtag();
      if (!o.createdTime) o.createdTime = ctx.now;
      o.modifiedTime = ctx.now;
      store.collPut(table, id, o, { seq: ctx.seq });
      res.id2etag[id] = o.etag as string;
    }
    for (const raw of asList(b.update)) {
      if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
      const id = raw.id;
      const old = store.collGet<Loose>(table, id);
      if (!old) {
        res.id2error[id] = BatchError.NotExisted;
        continue;
      }
      const o: Loose = mergeUpdate(old, raw, LEGACY_FIELDS[table]);
      for (const k of ["createdTime", ...(hooks.keep ?? [])]) if (o[k] === undefined && old[k] !== undefined) o[k] = old[k];
      const err = hooks.update?.(o, old, ctx);
      if (err) {
        res.id2error[id] = err;
        continue;
      }
      o.etag = newEtag();
      o.modifiedTime = ctx.now;
      store.collPut(table, id, o, { seq: ctx.seq });
      res.id2etag[id] = o.etag as string;
    }
    for (const raw of asList(b.delete)) {
      const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
      if (!id) continue;
      const old = store.collGet<Loose>(table, id);
      if (!old) {
        res.id2error[id] = BatchError.NotExisted;
        continue;
      }
      const err = hooks.del?.(id, old, ctx);
      if (err) {
        res.id2error[id] = err;
        continue;
      }
      store.collDelete(table, id);
    }
    hooks.after?.(ctx);
  });
  return res;
}

export const numOr = (v: unknown, d: number): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : d;
};
