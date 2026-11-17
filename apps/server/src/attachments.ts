import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  ActivityAction,
  DISK_LOW_WARNING_BYTES,
  formatServerDate,
  newEtag,
  newId,
  type Attachment,
  type Loose,
  type Task,
} from "@noortasks/core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ActivityService } from "./activity.js";
import { UPLOAD_LIMIT } from "./http-security.js";
import { ApiError, type Service } from "./service.js";
import { Store } from "./store.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "svg", "avif"]);
const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", json: "application/json", mp4: "video/mp4", mp3: "audio/mpeg",
};

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

export interface StorageStatus {
  lowDisk: boolean;
  freeBytes: number;
  thresholdBytes: number;
  warning?: string;
}

export function checkDiskSpace(
  dir: string,
  statfs: (p: string) => { bavail: number; bsize: number } = statfsSync,
): StorageStatus {
  try {
    const s = statfs(dir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const lowDisk = freeBytes < DISK_LOW_WARNING_BYTES;
    return {
      lowDisk,
      freeBytes,
      thresholdBytes: DISK_LOW_WARNING_BYTES,
      ...(lowDisk ? { warning: "low_disk_space" } : {}),
    };
  } catch {
    return { lowDisk: false, freeBytes: -1, thresholdBytes: DISK_LOW_WARNING_BYTES };
  }
}

async function streamUpload(
  req: FastifyRequest,
  target: string,
  fallbackId: string,
  maxBytes = UPLOAD_LIMIT,
): Promise<{ fileName: string; ext: string; fileType: "IMAGE" | "OTHER"; size: number }> {
  const part = await req.file();
  if (!part) throw new ApiError(400, "no_file");
  mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomBytes(8).toString("hex")}.part`;
  let size = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new ApiError(413, "file_too_large"));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(part.file, counter, createWriteStream(tmp, { mode: 0o600 }));
    if (part.file.truncated) throw new ApiError(413, "file_truncated");
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  const fileName = typeof part.filename === "string" && part.filename ? part.filename : fallbackId;
  const ext = extOf(fileName);
  const fileType = part.mimetype.startsWith("image/") || IMAGE_EXT.has(ext) ? "IMAGE" : "OTHER";
  return { fileName, ext, fileType, size };
}

export function registerAttachmentRoutes(
  app: FastifyInstance,
  svc: Service,
  dataDir: string,
  act?: ActivityService,
): void {
  const root = join(dataDir, "attachments");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const store = svc.store;

  const fileFor = (id: string): string => join(root, id.slice(0, 2).padEnd(2, "_"), id);
  let pendingBytes = 0;
  const upload = async (req: FastifyRequest, target: string, id: string) => {
    const used = store.get<{ bytes: number; n: number }>("select coalesce(sum(size), 0) as bytes, count(*) as n from attachments where state = 'stored'")!;
    const available = 1024 * 1024 * 1024 - used.bytes - pendingBytes;
    if (used.n >= 10_000 || available <= 0) throw new ApiError(413, "attachment_quota_exceeded");
    if (checkDiskSpace(root).lowDisk) throw new ApiError(507, "storage_full");
    if (pendingBytes >= 2 * UPLOAD_LIMIT) throw new ApiError(429, "upload_busy");
    const budget = Math.min(UPLOAD_LIMIT, available);
    pendingBytes += budget;
    try { return await streamUpload(req, target, id, budget); }
    finally { pendingBytes -= budget; }
  };

  app.get("/api/v1/attachment/isUnderQuota", async () => true);
  app.get("/api/v1/attachment/dailyLimit", async () => 1_000_000_000);
  app.get("/api/v1/attachment/storage", async () => checkDiskSpace(root));

  app.post<{ Params: { projectId: string; taskId: string; attachmentId: string } }>(
    "/api/v1/attachment/upload/:projectId/:taskId/:attachmentId",
    { bodyLimit: UPLOAD_LIMIT + 64 * 1024 },
    async (req) => {
      const { taskId, attachmentId } = req.params;
      if (!SAFE_ID.test(attachmentId) || !SAFE_ID.test(taskId)) throw new ApiError(400, "invalid_id");
      if (!store.getTask(taskId)) throw new ApiError(404, "task_not_found");
      const target = fileFor(attachmentId);
      const { fileName, ext, fileType, size } = await upload(req, target, attachmentId);
      return store.tx(() => {
        const seq = store.seq();
        const now = formatServerDate(svc.now());
        const task = store.getTask(taskId)!;
        const list = [...(task.attachments ?? [])];
        const i = list.findIndex((a) => a.id === attachmentId);
        const prevRow = store.get<{ path: string | null }>("select path from attachments where id = ?", attachmentId);
        const ym = now.slice(0, 7).replace("-", "");
        const path = (i >= 0 && list[i]!.path) || prevRow?.path || `/files/upload/${svc.userId}/${ym}/${attachmentId}${ext ? "." + ext : ""}`;
        const att: Attachment = {
          ...(i >= 0 ? list[i]! : {}),
          id: attachmentId,
          refId: (i >= 0 && list[i]!.refId) || attachmentId,
          path,
          fileName,
          fileType,
          size,
          status: 0,
          createdTime: (i >= 0 && list[i]!.createdTime) || now,
        };
        if (i >= 0) list[i] = att;
        else list.push(att);
        task.attachments = list;
        task.etag = newEtag();
        task.modifiedTime = now;
        store.putTask(task, { seq });
        svc.upsertAttachmentRow(task, att as Loose, { state: "stored", file: target });
        act?.record({
          taskId: task.id,
          projectId: task.projectId,
          action: ActivityAction.AttachAdd,
          summary: `Uploaded attachment ${fileName}`,
          taskTitle: task.title ?? "",
        });
        return att;
      });
    },
  );

  /** Comment attachment upload (ATT-901): streams bytes without task attachment array mutation, within the same upload quota. */
  app.post<{ Params: { projectId: string; commentTaskId: string } }>(
    "/api/v1/attachment/upload/comment/:projectId/:commentTaskId",
    { bodyLimit: UPLOAD_LIMIT + 64 * 1024 },
    async (req) => {
      const { commentTaskId } = req.params;
      if (!SAFE_ID.test(commentTaskId)) throw new ApiError(400, "invalid_id");
      const task = store.getTask(commentTaskId);
      if (!task) throw new ApiError(404, "task_not_found");
      const attachmentId = newId(svc.now());
      const target = fileFor(attachmentId);
      const { fileName, ext, fileType, size } = await upload(req, target, attachmentId);
      return store.tx(() => {
        const now = formatServerDate(svc.now());
        const ym = now.slice(0, 7).replace("-", "");
        const path = `/files/upload/${svc.userId}/${ym}/${attachmentId}${ext ? "." + ext : ""}`;
        const att: Attachment = { id: attachmentId, refId: attachmentId, path, fileName, fileType, size, status: 0, createdTime: now };
        svc.upsertAttachmentRow(task, att as Loose, { state: "stored", file: target, taskSet: "comment" });
        return att;
      });
    },
  );

  /** Countdown card image upload (ATT-902): streams bytes directly without a task, supporting optional ?attachmentId=. */
  app.post<{ Querystring: { attachmentId?: string } }>(
    "/api/v1/attachment/upload/countdown",
    { bodyLimit: UPLOAD_LIMIT + 64 * 1024 },
    async (req) => {
      const rawId = req.query.attachmentId;
      if (rawId !== undefined && rawId !== "" && !SAFE_ID.test(rawId)) throw new ApiError(400, "invalid_id");
      const attachmentId = rawId && rawId !== "" ? rawId : newId(svc.now());
      const target = fileFor(attachmentId);
      const { fileName, ext, fileType, size } = await upload(req, target, attachmentId);
      return store.tx(() => {
        const now = formatServerDate(svc.now());
        const ym = now.slice(0, 7).replace("-", "");
        const path = `/files/upload/${svc.userId}/${ym}/${attachmentId}${ext ? "." + ext : ""}`;
        const att: Attachment = { id: attachmentId, refId: attachmentId, path, fileName, fileType, size, status: 0, createdTime: now };
        svc.upsertAttachmentRow({ id: "", projectId: "countdown" } as Task, att as Loose, { state: "stored", file: target, taskSet: "countdown" });
        return att;
      });
    },
  );

  const serve = (reply: import("fastify").FastifyReply, row: { fileName: string | null; file: string | null; state: string }) => {
    if (row.state !== "stored" || !row.file) throw new ApiError(404, "attachment_not_uploaded", "the file bytes are not on this server");
    const st = statSync(row.file);
    const ext = extOf(row.fileName ?? "");
    reply.header("content-type", ext === "svg" ? "application/octet-stream" : MIME[ext] ?? "application/octet-stream");
    reply.header("content-security-policy", "sandbox; default-src 'none'");
    reply.header("content-length", st.size);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.fileName ?? "file")}`);
    reply.header("x-content-type-options", "nosniff");
    return reply.send(createReadStream(row.file));
  };

  app.get<{ Params: { id: string } }>("/api/v1/attachment/:id", async (req, reply) => {
    const row = store.get<{ fileName: string | null; file: string | null; state: string }>("select fileName, file, state from attachments where id = ?", req.params.id);
    if (!row) throw new ApiError(404, "attachment_not_found");
    return serve(reply, row);
  });

  app.get("/files/upload/*", async (req, reply) => {
    const row = store.get<{ fileName: string | null; file: string | null; state: string }>(
      "select fileName, file, state from attachments where path = ?",
      new URL(req.url, "http://x").pathname,
    );
    if (!row) throw new ApiError(404, "attachment_not_found");
    return serve(reply, row);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/attachment/:id", async (req) => {
    const id = req.params.id;
    const row = store.get<{ taskId: string; fileName: string | null; taskSet: string | null }>(
      "select taskId, fileName, taskSet from attachments where id = ?",
      id,
    );
    if (!row) throw new ApiError(404, "attachment_not_found");
    store.tx(() => {
      const task = store.getTask(row.taskId);
      if (task && row.taskSet !== "comment" && row.taskSet !== "countdown") {
        task.attachments = (task.attachments ?? []).filter((a) => a.id !== id);
        task.etag = newEtag();
        task.modifiedTime = formatServerDate(svc.now());
        store.putTask(task, { seq: store.seq() });
        act?.record({
          taskId: task.id,
          projectId: task.projectId,
          action: ActivityAction.AttachDel,
          summary: `Deleted attachment ${row.fileName ?? id}`,
          taskTitle: task.title ?? "",
        });
      }
      svc.removeAttachmentRow(id);
    });
    return {};
  });
}

export interface AttachFilesReport {
  pending: number;
  attached: number;
  missing: number;
  failed: number;
}

/**
 * Offline loader: for each pending attachment row (from an import) that has a downloaded file at
 * `<dir>/<attachmentId>/<one file>`, copy it where a normal upload would put it, verify size and sha256
 * (against the row, and against attachments-downloaded.json when present in `dir` or its parent),
 * and flip the row to stored. Rows that fail verification stay pending. Idempotent.
 */
export function attachFiles(dir: string, dbPath: string, dataDir: string): AttachFilesReport {
  const manifest = new Map<string, { bytes?: number; sha256?: string }>();
  for (const m of [join(dir, "attachments-downloaded.json"), join(dirname(dir), "attachments-downloaded.json")]) {
    if (!existsSync(m)) continue;
    for (const e of JSON.parse(readFileSync(m, "utf8")) as Array<{ id: string; bytes?: number; sha256?: string }>) manifest.set(String(e.id), e);
    break;
  }
  const root = join(dataDir, "attachments");
  const store = new Store(dbPath);
  const rep: AttachFilesReport = { pending: 0, attached: 0, missing: 0, failed: 0 };
  try {
    const rows = store.all<{ id: string; size: number | null }>("select id, size from attachments where state = 'pending' order by id");
    rep.pending = rows.length;
    for (const row of rows) {
      const id = row.id;
      const sub = join(dir, id);
      let src: string | undefined;
      if (SAFE_ID.test(id) && existsSync(sub) && statSync(sub).isDirectory()) {
        const files = readdirSync(sub).filter((f) => statSync(join(sub, f)).isFile());
        if (files.length === 1) src = join(sub, files[0]!);
      }
      if (!src) {
        rep.missing++;
        continue;
      }
      const buf = readFileSync(src);
      const want = manifest.get(id);
      const sha = createHash("sha256").update(buf).digest("hex");
      if ((row.size != null && buf.length !== row.size) || (want?.bytes != null && buf.length !== want.bytes) || (want?.sha256 && sha !== want.sha256.toLowerCase())) {
        rep.failed++;
        continue;
      }
      const target = join(root, id.slice(0, 2).padEnd(2, "_"), id);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      const tmp = `${target}.${randomBytes(8).toString("hex")}.part`;
      try {
        copyFileSync(src, tmp);
        renameSync(tmp, target);
      } catch {
        rmSync(tmp, { force: true });
        rep.failed++;
        continue;
      }
      if (statSync(target).size !== buf.length) {
        rmSync(target, { force: true });
        rep.failed++;
        continue;
      }
      store.run("update attachments set state = 'stored', file = ? where id = ? and state = 'pending'", target, id);
      rep.attached++;
    }
  } finally {
    store.close();
  }
  return rep;
}
