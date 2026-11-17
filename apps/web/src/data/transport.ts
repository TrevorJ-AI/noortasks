import type { BatchCheckResponse, BatchResponse, Column, Filter, Project, Tag, Task } from "../lib/core";
import { Api, HttpError } from "./api";
import type { NoorDb, Op, OpKind } from "./db";
import { pullM4, sendM4, sendPrefs } from "./m4sync";
import { mergeColl, pendingKey, stripLocal, updatePayload, withSyncBase } from "./fieldSync";
import type { SyncEngine } from "./sync";

/** The engine owns the outbox and checkpoint; a transport owns the wire and auxiliary reads. */
export interface SyncTransport {
  sendRun(run: Op[]): Promise<void>;
  pullDelta(checkPoint: number): Promise<BatchCheckResponse>;
  afterPull?(): Promise<void>;
}

export class HttpTransport implements SyncTransport {
  constructor(readonly db: NoorDb, readonly api: Api, private engine: SyncEngine) {}
  private get maybeGone(): Set<string> { return this.engine.maybeGone; }
  private get m4Always(): boolean { return this.engine.m4Always; }
  private pendingKeys(): Promise<Set<string>> { return this.engine.pendingKeys(); }
  private enqueue(kind: OpKind, key: string, payload: Record<string, unknown>): Promise<void> { return this.engine.enqueue(kind, key, payload); }
  pullDelta(cp: number): Promise<BatchCheckResponse> { return this.api.get(`/api/v3/batch/check/${cp}`); }

  async sendRun(run: Op[]): Promise<void> {
    const kind = run[0]!.kind;
    const api = this.api;
    switch (kind) {
      case "task":
      case "taskDelete":
        return this.sendTasks(run);
      case "taskProject":
        await api.post("/api/v2/batch/taskProject", run.map((o) => ({ taskId: o.payload.taskId, toProjectId: o.payload.toProjectId })));
        return;
      case "taskParent":
        await api.post(
          "/api/v2/batch/taskParent",
          run.map((o) => ({ taskId: o.payload.taskId, parentId: o.payload.parentId ?? "", oldParentId: o.payload.oldParentId ?? undefined })),
        );
        return;
      case "project":
      case "group": {
        const table = kind === "project" ? this.db.projects : this.db.groups;
        const add: unknown[] = [];
        const update: unknown[] = [];
        for (const o of run) {
          const row = (o.payload.wire as Project | undefined) ?? await table.get(o.key);
          if (!row) continue;
          (o.payload.add ? add : update).push((o.payload.wire ?? stripLocal(row)) as never);
        }
        const path = kind === "project" ? "/api/v2/batch/project" : "/api/v2/batch/projectGroup";
        const res = await api.post<BatchResponse>(path, { add, update, delete: [] });
        // an add that already exists becomes an update; an update of a missing row becomes an add
        const retryUpd = add.filter((r) => res?.id2error?.[(r as Project).id] === "EXISTED");
        const retryAdd = update.filter((r) => !(r as Record<string, unknown>)._sync && res?.id2error?.[(r as Project).id] === "NOT_EXISTED");
        if (retryUpd.length || retryAdd.length) await api.post(path, { add: retryAdd, update: retryUpd, delete: [] });
        await this.applyEtags(table, res);
        await this.dropMissing(table, res, update as Project[], (row) => row.id);
        return;
      }
      case "projectDelete":
        await api.post("/api/v2/batch/project", { add: [], update: [], delete: run.map((o) => o.key) });
        return;
      case "groupDelete":
        await api.post("/api/v2/batch/projectGroup", { add: [], update: [], delete: run.map((o) => o.key) });
        return;
      case "tag": {
        const add: Tag[] = [];
        const update: Tag[] = [];
        for (const o of run) {
          const row = await this.db.tags.get(o.key);
          if (row) (o.payload.add ? add : update).push((o.payload.wire ?? stripLocal(row)) as Tag);
        }
        const res = await api.post<BatchResponse>("/api/v2/batch/tag", { add, update });
        await this.dropMissing(this.db.tags, res, update, (row) => row.name);
        return;
      }
      case "tagRename":
      case "tagMerge": {
        const o = run[0]!;
        try {
          await api.put(kind === "tagRename" ? "/api/v2/tag/rename" : "/api/v2/tag/merge", { name: o.payload.name, newName: o.payload.newName });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
        }
        return;
      }
      case "tagDelete":
        try {
          await api.del(`/api/v2/tag/delete?name=${encodeURIComponent(String(run[0]!.payload.name))}`);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
        }
        return;
      case "trashRestore": {
        const res = await api.post<BatchResponse>("/api/v2/trash/restore", run.map((o) => ({ taskId: o.payload.taskId, projectId: o.payload.projectId })));
        // restoring a row the server already deleted for good: drop the local ghost
        for (const [id, err] of Object.entries(res?.id2error ?? {})) if (err === "NOT_EXISTED") await this.db.tasks.delete(id);
        return;
      }
      case "attachmentDelete":
        await api.post("/api/v2/batch/task", { deleteAttachments: run.map((o) => ({ id: o.payload.taskId, attachments: [{ id: o.payload.attachmentId }] })) });
        return;
      case "deleteForever":
        await api.del("/api/v2/task?deleteforever=true", run.map((o) => ({ taskId: o.payload.taskId, projectId: o.payload.projectId })));
        return;
      case "cleanTrash":
        await api.del("/api/v2/trash/cleanUp");
        return;
      case "settings": {
        const merged = Object.assign({}, ...run.map((o) => o.payload));
        await api.put("/api/v2/user/preferences/settings", merged);
        return;
      }
      case "ext": {
        // whole sections: the server merges ext one level deep (per section)
        const merged = Object.assign({}, ...run.map((o) => o.payload));
        await api.post("/api/v2/user/preferences/ext", merged);
        return;
      }
      case "column": {
        const add: Column[] = [];
        const update: Column[] = [];
        for (const o of run) {
          const row = await this.db.columns.get(o.key);
          if (row) (o.payload.add ? add : update).push((o.payload.wire ?? stripLocal(row)) as never);
        }
        const res = await api.post<BatchResponse>("/api/v2/batch/columnProject", { add, update, delete: [] });
        const retryUpd = add.filter((r) => res?.id2error?.[r.id] === "EXISTED");
        const retryAdd = update.filter((r) => !(r as Record<string, unknown>)._sync && res?.id2error?.[r.id] === "NOT_EXISTED");
        if (retryUpd.length || retryAdd.length) await api.post("/api/v2/batch/columnProject", { add: retryAdd, update: retryUpd, delete: [] });
        await this.applyEtags(this.db.columns, res);
        await this.dropMissing(this.db.columns, res, update, (row) => row.id);
        return;
      }
      case "order": {
        const orderByType: Record<string, Record<string, { changed: unknown[]; deleted: unknown[] }>> = {};
        for (const o of run) {
          const tk = String(o.payload.typeKey);
          const leaf = ((orderByType[tk] ??= {})[o.key] ??= { changed: [], deleted: [] });
          leaf.changed.push(...((o.payload.records as unknown[]) ?? []));
        }
        await api.post("/api/v3/batch/order", { orderByType });
        return;
      }
      case "columnDelete":
        await api.post("/api/v2/batch/columnProject", { add: [], update: [], delete: run.map((o) => ({ columnId: o.key, projectId: o.payload.projectId })) });
        return;
      case "upload":
        return this.sendUpload(run[0]!);
      case "m4":
      case "m4Delete":
        return sendM4(this.db, api, run, (kind, key, payload) => this.enqueue(kind, key, payload));
      case "pref":
        return sendPrefs(api, run);
      case "focusOp":
        await api.post("/api/v2/batch/focusOp", { ops: run.map((o) => o.payload) });
        return;
      case "filter": {
        const add: Filter[] = [];
        const update: Filter[] = [];
        for (const o of run) {
          const row = await this.db.filters.get(o.key);
          if (row) (o.payload.add ? add : update).push((o.payload.wire ?? stripLocal(row)) as never);
        }
        const res = await api.post<BatchResponse>("/api/v2/batch/filter", { add, update, delete: [] });
        const retryUpd = add.filter((r) => res?.id2error?.[r.id] === "EXISTED");
        const retryAdd = update.filter((r) => !(r as Record<string, unknown>)._sync && res?.id2error?.[r.id] === "NOT_EXISTED");
        if (retryUpd.length || retryAdd.length) await api.post("/api/v2/batch/filter", { add: retryAdd, update: retryUpd, delete: [] });
        await this.applyEtags(this.db.filters, res);
        await this.dropMissing(this.db.filters, res, update, (row) => row.id);
        return;
      }
      case "filterDelete":
        await api.post("/api/v2/batch/filter", { add: [], update: [], delete: run.map((o) => o.key) });
        return;
    }
  }

  private async sendTasks(run: Op[]): Promise<void> {
    const add: Task[] = [];
    const update: Task[] = [];
    const del: Array<{ taskId: string; projectId: string }> = [];
    for (const o of run) {
      if (o.kind === "taskDelete") {
        del.push({ taskId: o.key, projectId: String(o.payload.projectId ?? "") });
        continue;
      }
      const t = await this.db.tasks.get(o.key);
      if (!t) continue;
      if (o.payload.add) {
        // attachments travel through the upload endpoint, never inside the task add
        const row = { ...(o.payload.wire ?? stripLocal(t)) } as Task;
        const uploaded = (row.attachments ?? []).filter((a) => !a.localBlob);
        if (uploaded.length) row.attachments = uploaded;
        else delete row.attachments;
        add.push(row);
      }
      else update.push((o.payload.wire ?? updatePayload(t)) as Task);
    }
    const res = await this.api.post<BatchResponse>("/api/v2/batch/task", { add, update, delete: del });
    const err = res?.id2error ?? {};
    const retryUpdate = add.filter((t) => err[t.id] === "EXISTED").map((t) => updatePayload(t));
    const retryAdd: Task[] = [];
    for (const t of update) {
      if (err[t.id] === "NOT_EXISTED" && (t as Record<string, unknown>)._sync) { await this.db.tasks.delete(t.id); continue; }
      if (err[t.id] === "NOT_EXISTED") {
        const local = await this.db.tasks.get(t.id);
        if (local && !local.deleted) retryAdd.push(stripLocal(local) as Task);
      }
      if (err[t.id] === "DELETED") {
        try { await this.db.tasks.put(withSyncBase(await this.api.get<Task>(`/api/v2/task/${t.id}`))); }
        catch (e) { if (e instanceof HttpError && e.status === 404) await this.db.tasks.delete(t.id); else throw e; }
      }
    }
    let res2: BatchResponse | undefined;
    if (retryUpdate.length || retryAdd.length) res2 = await this.api.post<BatchResponse>("/api/v2/batch/task", { add: retryAdd, update: retryUpdate, delete: [] });
    await this.applyEtags(this.db.tasks, res);
    if (res2) await this.applyEtags(this.db.tasks, res2);
    // shared lists: a refused edit (view-only list, collaboration off, assignee not a member) is rolled back
    // to the server copy instead of lingering on this device
    for (const [id, e] of Object.entries(err)) {
      if (e !== "NO_PROJECT_PERMISSION" && e !== "INVALID_ASSIGNEE") continue;
      try {
        await this.db.tasks.put(withSyncBase(await this.api.get<Task>(`/api/v2/task/${id}`)));
      } catch (x) {
        if (x instanceof HttpError && x.status === 404) await this.db.tasks.delete(id);
        else if (!(x instanceof HttpError)) throw x;
      }
    }
  }

  private async sendUpload(o: Op): Promise<void> {
    const p = o.payload as { taskId: string; projectId: string; attachmentId: string; blobKey: string; fileName: string };
    const row = await this.db.blobs.get(p.blobKey);
    if (!row) return;
    const fd = new FormData();
    fd.append("file", row.blob, p.fileName);
    const att = await this.api.req<Record<string, unknown>>("POST", `/api/v1/attachment/upload/${p.projectId}/${p.taskId}/${p.attachmentId}`, fd);
    await this.db.transaction("rw", this.db.tasks, this.db.blobs, async () => {
      const t = await this.db.tasks.get(p.taskId);
      if (t) {
        const list = (t.attachments ?? []).filter((a) => a.id !== p.attachmentId);
        list.push({ ...(att as Record<string, unknown>), localBlob: undefined } as never);
        await this.db.tasks.update(p.taskId, { attachments: list });
      }
      await this.db.blobs.delete(p.blobKey);
    });
  }

  private async dropMissing<T extends object>(table: import("dexie").Table<T, string>, res: BatchResponse | undefined, rows: T[], key: (r: T) => string): Promise<void> {
    for (const row of rows) {
      if ((row as Record<string, unknown>)._sync && res?.id2error?.[key(row)] === "NOT_EXISTED") await table.delete(key(row));
    }
  }

  private async applyEtags<T extends { etag?: string }>(table: import("dexie").Table<T, string>, res: BatchResponse | undefined): Promise<void> {
    const map = res?.id2etag ?? {};
    for (const [id, etag] of Object.entries(map)) await table.update(id, { etag } as never);
  }

  async afterPull(): Promise<void> {
    // a delete for a row already in the local trash is either our own trash echo or a permanent delete: ask
    for (const id of [...this.maybeGone]) {
      this.maybeGone.delete(id);
      try {
        await this.api.get(`/api/v2/task/${id}`);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404 && !(await this.pendingKeys()).has(pendingKey("task", id))) await this.db.tasks.delete(id);
        else if (!(e instanceof HttpError)) throw e;
      }
    }
    try {
      const prefs = await this.api.get<Record<string, unknown>>("/api/v2/user/preferences/settings");
      const pending = await this.pendingKeys();
      if (!pending.has("settings") && prefs) await this.db.setKV("settings", prefs);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
    await this.pullColumnsAndExt();
    await pullM4(this.db, this.api, () => this.pendingKeys(), this.m4Always);
  }

  /**
   * Kanban columns and extended preferences are not in batch/check. Columns are fetched in full (from=0) and
   * replace the local table, because a delta never reports deletions; pending local rows win until pushed.
   */
  async pullColumnsAndExt(): Promise<void> {
    try {
      const map = await this.api.get<Record<string, Column[]>>("/api/v2/column?from=0");
      const ext = await this.api.get<Record<string, unknown>>("/api/v2/user/preferences/ext");
      const db = this.db;
      await db.transaction("rw", [db.columns, db.kv, db.outbox], async () => {
        const pending = await this.pendingKeys();
        const rows = Object.values(map ?? {}).flat();
        await mergeColl(db.columns, rows, (c: Column) => c.id, "column", pending, true);
        if (!pending.has("ext") && ext && typeof ext === "object") await db.setKV("ext", ext);
      });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }

}
