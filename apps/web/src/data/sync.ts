import type { BatchCheckResponse, Filter, Project, ProjectGroup, Tag, Task } from "../lib/core";
import { Api, AuthError, HttpError, OfflineError } from "./api";
import type { NoorDb, Op, OpKind } from "./db";
import { m4PendingKey, M4_ENTITIES, type M4Entity } from "./m4sync";
import { applyFields, changedPayload, mergeColl, pendingKey, stripLocal, updatePayload, withSyncBase } from "./fieldSync";
export { pendingKey } from "./fieldSync";
import { HttpTransport, type SyncTransport } from "./transport";
export { HttpTransport, type SyncTransport } from "./transport";

/**
 * Local-first sync engine.
 *
 * Local writes go to IndexedDB first and append an op to the outbox. `push()` drains the outbox through the
 * batch endpoints in order (consecutive ops of the same endpoint share one request). `pull()` asks
 * `GET /api/v3/batch/check/{checkPoint}` for the delta and applies it, skipping every row that still has a
 * pending local op: local edits win until they are pushed, after which the merged server copy flows back on the next pull.
 * Updates carry changed fields and explicit removals; the later push wins only for fields it supplies. Network errors leave the outbox untouched.
 */

export type SyncState = "idle" | "syncing" | "offline" | "auth" | "error";

export interface SyncStatus {
  state: SyncState;
  lastSync: number | null;
  pending: number;
  oldestPending?: number | null;
  error?: string;
}

const UPSERT_KINDS: ReadonlySet<OpKind> = new Set(["task", "project", "group", "tag", "settings", "column", "ext", "m4", "pref", "filter"]);
const M4_BATCH: ReadonlySet<OpKind> = new Set(["m4", "m4Delete"]);
const TASK_BATCH: ReadonlySet<OpKind> = new Set(["task", "taskDelete"]);

export class SyncEngine {
  private listeners = new Set<(s: SyncStatus) => void>();
  private running: Promise<void> | null = null;
  private again = false;
  /** seqs of ops currently being sent: new edits must not coalesce into them (they would be deleted unsent) */
  private inflight = new Set<number>();
  /** rows already in the local trash that the server reported deleted again: trashed or deleted for good */
  readonly maybeGone = new Set<string>();
  status: SyncStatus = { state: "idle", lastSync: null, pending: 0 };
  /** read habits, focus and countdowns even while their features are switched off (tests) */
  m4Always = false;
  /** the signed-in account was compared with the account the local data belongs to (once per sign-in) */
  private identityChecked = false;
  /** the signed-in account (null on servers without accounts) */
  accountId: number | null = null;

  private initialized: Promise<void> | null = null;
  readonly transport: SyncTransport;

  constructor(
    readonly db: NoorDb,
    readonly api: Api,
    transport?: SyncTransport,
  ) { this.transport = transport ?? new HttpTransport(db, api, this); }

  onStatus(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn);
    fn(this.status);
    return () => this.listeners.delete(fn);
  }
  private setStatus(p: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...p };
    for (const l of this.listeners) l(this.status);
  }

  /** Restore durability information even when the very first network request fails. */
  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      const lastSync = await this.db.getKV<number | null>("lastSync", null);
      this.setStatus({ lastSync });
      // Older outboxes had no timestamp. Freeze a conservative estimate once, across reloads.
      await this.db.outbox.filter((o) => o.createdAt === undefined).modify({ createdAt: lastSync ?? Date.now() });
      await this.refreshPending();
      if (typeof navigator !== "undefined" && navigator.storage?.persist) {
        try { void navigator.storage.persist().catch(() => {}); } catch { /* unsupported/denied is best effort */ }
      }
    })();
  }

  private async refreshPending(): Promise<void> {
    const ops = await this.db.outbox.toArray();
    const times = ops.map((o) => o.createdAt ?? this.status.lastSync ?? Date.now());
    this.setStatus({ pending: ops.length, oldestPending: times.length ? times.reduce((a, b) => Math.min(a, b)) : null });
  }

  // ---------------------------------------------------------------- outbox

  private opTable(kind: OpKind, payload: Record<string, unknown>): import("dexie").Table | undefined {
    return kind === "m4" ? M4_ENTITIES[payload.entity as M4Entity]?.table(this.db)
      : ({ task: this.db.tasks, project: this.db.projects, group: this.db.groups, tag: this.db.tags, column: this.db.columns, filter: this.db.filters } as Record<string, import("dexie").Table>)[kind];
  }

  private async acknowledge(run: Op[]): Promise<void> {
    const tables = [...new Set(run.map((o) => this.opTable(o.kind, o.payload)).filter((t): t is import("dexie").Table => !!t))];
    await this.db.transaction("rw", [this.db.outbox, ...tables], async () => {
      for (const op of run) {
        const table = this.opTable(op.kind, op.payload);
        const wire = op.payload.wire as Record<string, unknown> | undefined;
        if (!table || !wire) continue;
        const row = await table.get(op.key);
        if (!row) continue;
        const base = row._syncBase as Record<string, unknown> | undefined;
        const meta = wire._sync as { baseEtag?: string | null } | undefined;
        // A refused shared edit may already have been replaced with an authoritative server row.
        if (meta && base && (base.etag ?? null) !== meta.baseEtag) continue;
        const next = applyFields(base ?? {}, wire);
        if (!base && row.etag) next.etag = row.etag;
        await table.update(op.key, { _syncBase: next });
      }
      await this.db.outbox.bulkDelete(run.map((o) => o.seq!));
    });
  }

  /** Append an op. Upserts of the same row coalesce into the earliest pending op (keeping its add flag). */
  async enqueue(kind: OpKind, key: string, payload: Record<string, unknown> = {}): Promise<void> {
    const table = this.opTable(kind, payload);
    await this.db.transaction("rw", [this.db.outbox, ...(table ? [table] : [])], async () => {
      if (table) {
        let row = await table.get(key);
        if (row) {
          // Diff against writes already in flight, so reverting to the original value still sends a field.
          const earlier = await this.db.outbox.where("[kind+key]").anyOf([[kind, key], ["taskProject", key]]).sortBy("seq");
          let base = row._syncBase as Record<string, unknown> | undefined;
          for (const op of earlier) {
            if (op.kind === kind && op.key === key && this.inflight.has(op.seq!) && op.payload.wire) {
              base = applyFields(base ?? {}, op.payload.wire as Record<string, unknown>);
            }
            if (kind === "task" && op.kind === "taskProject" && op.payload.taskId === key) {
              base = { ...(base ?? {}), projectId: op.payload.toProjectId, columnId: undefined };
            }
          }
          if (base) row = { ...row, _syncBase: base };
          payload = { ...payload, wire: payload.add ? stripLocal(row) : kind === "task" ? updatePayload(row) : changedPayload(row) };
        }
      }
      if (UPSERT_KINDS.has(kind)) {
        let prev = (await this.db.outbox.where("[kind+key]").equals([kind, key]).toArray()).filter((o) => !this.inflight.has(o.seq!)).pop();
        // a task edit queued after a move or re-parent must stay behind it: the server's taskProject clears
        // columnId, so coalescing a column change into an earlier op would send it first and lose it
        if (prev && kind === "task") {
          const after = await this.db.outbox.where("seq").above(prev.seq!).filter((o) => (o.kind === "taskProject" || o.kind === "taskParent") && o.payload.taskId === key).count();
          if (after > 0) prev = undefined;
        }
        if (prev) {
          if (prev.payload.add && table) {
            const row = await table.get(key);
            if (row) payload = { ...payload, wire: stripLocal(row) };
          }
          const merged = kind === "settings" || kind === "ext" || kind === "pref" ? { ...prev.payload, ...payload } : { ...payload, add: prev.payload.add || payload.add || undefined };
          await this.db.outbox.update(prev.seq!, { payload: merged });
          return;
        }
      }
      if (kind === "taskDelete") {
        // a row that never reached the server: drop its pending add and skip the delete
        const prev = (await this.db.outbox.where("[kind+key]").equals(["task", key]).toArray()).find((o) => !this.inflight.has(o.seq!));
        if (prev?.payload.add) {
          await this.db.outbox.delete(prev.seq!);
          const rest = await this.db.outbox.filter((o) => (o.payload.taskId as string) === key).toArray();
          await this.db.outbox.bulkDelete(rest.map((o) => o.seq!));
          return;
        }
      }
      if (kind === "filterDelete") {
        // a filter that never reached the server: drop its pending add and skip the delete
        const prev = (await this.db.outbox.where("[kind+key]").equals(["filter", key]).toArray()).find((o) => !this.inflight.has(o.seq!));
        if (prev) {
          await this.db.outbox.delete(prev.seq!);
          if (prev.payload.add) return;
        }
      }
      if (kind === "m4Delete") {
        const prev = (await this.db.outbox.where("[kind+key]").equals(["m4", key]).toArray()).find((o) => !this.inflight.has(o.seq!));
        if (prev) {
          await this.db.outbox.delete(prev.seq!);
          if (prev.payload.add) return;
        }
      }
      // an upsert queued behind an in-flight add of the same row is an update
      const behindAdd = UPSERT_KINDS.has(kind) && payload.add && (await this.db.outbox.where("[kind+key]").equals([kind, key]).count()) > 0;
      await this.db.outbox.add({ createdAt: Date.now(), kind, key, payload: behindAdd ? { ...payload, add: undefined } : payload });
    });
    await this.refreshPending();
  }

  async pendingKeys(): Promise<Set<string>> {
    const ops = await this.db.outbox.toArray();
    const s = new Set<string>();
    for (const o of ops) {
      if (o.kind === "task" || o.kind === "taskDelete" || o.kind === "taskProject" || o.kind === "taskParent" || o.kind === "trashRestore" || o.kind === "deleteForever" || o.kind === "upload" || o.kind === "attachmentDelete")
        s.add(pendingKey("task", (o.payload.taskId as string) ?? o.key));
      else if (o.kind === "project" || o.kind === "projectDelete") s.add(pendingKey("project", o.key));
      else if (o.kind === "group" || o.kind === "groupDelete") s.add(pendingKey("group", o.key));
      else if (o.kind === "tag" || o.kind === "tagDelete" || o.kind === "tagRename" || o.kind === "tagMerge") {
        s.add(pendingKey("tag", o.key));
        if (o.payload.newName) s.add(pendingKey("tag", String(o.payload.newName).toLowerCase()));
      } else if (o.kind === "settings") s.add("settings");
      else if (o.kind === "ext") s.add("ext");
      else if (o.kind === "order") s.add("order");
      else if (o.kind === "column" || o.kind === "columnDelete") s.add(pendingKey("column", o.key));
      else if (o.kind === "m4" || o.kind === "m4Delete") s.add(m4PendingKey(o.key));
      else if (o.kind === "pref") s.add(`pref:${o.key}`);
      else if (o.kind === "filter" || o.kind === "filterDelete") s.add(pendingKey("filter", o.key));
    }
    return s;
  }

  // ---------------------------------------------------------------- push

  async push(): Promise<void> {
    for (;;) {
      const ops = await this.db.outbox.orderBy("seq").toArray();
      if (ops.length === 0) break;
      // take the first run of ops that share an endpoint
      const first = ops[0]!;
      const run: Op[] = [first];
      for (let i = 1; i < ops.length; i++) {
        const o = ops[i]!;
        const same = TASK_BATCH.has(first.kind) ? TASK_BATCH.has(o.kind) : M4_BATCH.has(first.kind) ? M4_BATCH.has(o.kind) : o.kind === first.kind;
        if (!same || first.kind === "upload" || first.kind === "attachmentDelete" || first.kind === "tagRename" || first.kind === "tagMerge" || first.kind === "tagDelete" || first.kind === "cleanTrash") break;
        run.push(o);
      }
      for (const o of run) this.inflight.add(o.seq!);
      try {
        await this.transport.sendRun(run);
        await this.acknowledge(run);
      } finally {
        for (const o of run) this.inflight.delete(o.seq!);
      }
    }
    await this.refreshPending();
  }

  // ---------------------------------------------------------------- pull

  async pull(): Promise<BatchCheckResponse> {
    const cp = await this.db.getKV<number>("fieldSyncVersion", 0) < 1 ? 0 : await this.db.getKV<number>("checkPoint", 0);
    const res = await this.transport.pullDelta(cp);
    await this.applyCheck(res, cp);
    await this.transport.afterPull?.();
    return res;
  }

  async applyCheck(res: BatchCheckResponse, cp: number): Promise<void> {
    const db = this.db;
    const full = cp <= 0;
    await db.transaction("rw", [db.tasks, db.projects, db.groups, db.tags, db.filters, db.kv, db.outbox], async () => {
      // read pending ops inside the transaction so a local edit cannot slip between the check and the write
      const pending = await this.pendingKeys();
      const bean = res.syncTaskBean;
      const incoming = [...(bean?.add ?? []), ...(bean?.update ?? [])];
      const seen = new Set<string>();
      for (const t of incoming) {
        seen.add(t.id);
        if (pending.has(pendingKey("task", t.id))) continue;
        await db.tasks.put(withSyncBase(t));
      }
      for (const d of bean?.delete ?? []) {
        if (pending.has(pendingKey("task", d.taskId))) continue;
        const local = await db.tasks.get(d.taskId);
        if (local && !local.deleted) await db.tasks.update(d.taskId, { deleted: 1, deletedTime: Date.now() });
        else if (local?.deleted) this.maybeGone.add(d.taskId);
      }
      if (full) {
        // a full check lists every open task: open local rows it does not list are gone on the server
        const openLocal = await db.tasks.where("status").equals(0).toArray();
        for (const t of openLocal) {
          if (!t.deleted && !seen.has(t.id) && !pending.has(pendingKey("task", t.id))) await db.tasks.update(t.id, { deleted: 1 });
        }
      }
      const sharedBefore = full ? (await db.projects.toArray()).filter((p) => p.isOwner === false).map((p) => p.id) : [];
      await mergeColl(db.projects, res.projectProfiles, (p: Project) => p.id, "project", pending, full);
      await mergeColl(db.groups, res.projectGroups, (g: ProjectGroup) => g.id, "group", pending, full);
      await mergeColl(db.tags, res.tags, (t: Tag) => t.name, "tag", pending, full);
      await mergeColl(db.filters, res.filters, (f: Filter) => f.id, "filter", pending, full);
      const gone = res as Record<string, unknown>;
      for (const id of (gone.deletedProjects as string[] | undefined) ?? []) if (!pending.has(pendingKey("project", id))) await db.projects.delete(id);
      // shared lists: a list the member lost access to and tasks that left a shared list vanish from this
      // device outright (not into the local trash: they were never this account's)
      const revoked = new Set((gone.revokedProjects as string[] | undefined) ?? []);
      if (full) for (const p of sharedBefore) if (!(res.projectProfiles ?? []).some((x) => x.id === p)) revoked.add(p);
      for (const id of revoked) {
        await db.projects.delete(id);
        const rows = await db.tasks.where("projectId").equals(id).primaryKeys();
        await db.tasks.bulkDelete(rows);
      }
      for (const id of (gone.removedTasks as string[] | undefined) ?? []) await db.tasks.delete(id);
      for (const id of (gone.deletedProjectGroups as string[] | undefined) ?? []) if (!pending.has(pendingKey("group", id))) await db.groups.delete(id);
      for (const n of (gone.deletedTags as string[] | undefined) ?? []) if (!pending.has(pendingKey("tag", n))) await db.tags.delete(n);
      for (const id of (gone.deletedFilters as string[] | undefined) ?? []) if (!pending.has(pendingKey("filter", id))) await db.filters.delete(id);
      if (res.inboxId) await db.setKV("inboxId", res.inboxId);
      if (full && res.syncOrderBean) await db.setKV("orderBean", res.syncOrderBean);
      // matrix manual order (MTRX-018): order records under typeKey "matrix", scope quadrantN_<profileId>
      const v3 = (res as { syncOrderBeanV3?: { orderByType?: Record<string, Record<string, { changed?: Array<{ id: string; order: number | null }> }>> } }).syncOrderBeanV3;
      const mx = v3?.orderByType?.matrix;
      if (mx && !pending.has("order")) {
        const cur = full ? {} : await db.getKV<Record<string, Record<string, number>>>("matrixOrders", {});
        for (const [scope, leaf] of Object.entries(mx)) {
          const m = { ...(cur[scope] ?? {}) };
          for (const r of leaf.changed ?? []) if (typeof r.order === "number") m[r.id] = r.order;
          cur[scope] = m;
        }
        await db.setKV("matrixOrders", cur);
      }
      await db.setKV("checkPoint", res.checkPoint);
      await db.setKV("fieldSyncVersion", 1);
    });
  }

  // ---------------------------------------------------------------- driver

  /** push then pull; concurrent callers share one run, and a call during a run schedules one more. */
  sync(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        this.setStatus({ state: "syncing" });
        try {
          await this.initialize();
          await this.ensureIdentity();
          await this.push();
          await this.pull();
          const lastSync = Date.now();
          await this.db.setKV("lastSync", lastSync);
          await this.refreshPending();
          this.setStatus({ state: "idle", lastSync, error: undefined });
        } catch (e) {
          await this.refreshPending();
          const pendingCount = this.status.pending;
          if (e instanceof OfflineError) this.setStatus({ state: "offline", pending: pendingCount });
          else if (e instanceof AuthError) {
            this.identityChecked = false;
            this.setStatus({ state: "auth", pending: pendingCount });
          }
          else {
            this.setStatus({ state: "error", pending: pendingCount, error: String(e) });
            // a permanently rejected op must not block the queue forever
            if (e instanceof HttpError) await this.dropHead();
          }
          this.again = false;
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async dropHead(): Promise<void> {
    const head = await this.db.outbox.orderBy("seq").first();
    if (!head) return;
    const tries = (head.tries ?? 0) + 1;
    if (tries >= 3) await this.db.outbox.delete(head.seq!);
    else await this.db.outbox.update(head.seq!, { tries });
  }

  /**
   * Multi-user servers: the local database (tasks, outbox) belongs to one account. When another account signs
   * in on this device, everything local is wiped before anything is pushed, so one person's queued edits can
   * never be sent as another person.
   */
  async ensureIdentity(): Promise<void> {
    if (this.identityChecked || !(this.transport instanceof HttpTransport)) return;
    let me: { userId?: number } | undefined;
    try {
      me = await this.api.get<{ userId?: number }>("/api/auth/me");
    } catch (e) {
      // an older or single-user server without accounts
      if (e instanceof HttpError && e.status === 404) {
        this.identityChecked = true;
        return;
      }
      throw e;
    }
    const id = typeof me?.userId === "number" ? me.userId : null;
    const prev = await this.db.getKV<number | null>("accountId", null);
    if (id !== null && prev !== null && prev !== id) await this.wipeLocal();
    if (id !== null) await this.db.setKV("accountId", id);
    this.accountId = id;
    this.identityChecked = true;
  }

  /** Drops every local row, the outbox and the checkpoints (another account signed in). */
  async wipeLocal(): Promise<void> {
    const db = this.db;
    await db.transaction("rw", db.tables, async () => {
      for (const t of db.tables) await t.clear();
    });
    this.setStatus({ lastSync: null, pending: 0, oldestPending: null });
  }

  /** Reset local state and do a full check (used after sign-in as another user, and by tests). */
  async resetAndPull(): Promise<void> {
    const db = this.db;
    await db.transaction("rw", [db.tasks, db.projects, db.groups, db.tags, db.columns, db.kv, db.outbox, db.habits, db.habitSections, db.checkins, db.habitRecords, db.pomos, db.timers, db.countdowns, db.filters], async () => {
      await Promise.all([db.tasks, db.projects, db.groups, db.tags, db.columns, db.outbox, db.habits, db.habitSections, db.checkins, db.habitRecords, db.pomos, db.timers, db.countdowns, db.filters].map((t) => (t as { clear: () => Promise<void> }).clear()));
      await db.kv.delete("checkPoint");
      await db.kv.delete("pomoCheckPoint");
    });
    await this.pull();
  }
}
