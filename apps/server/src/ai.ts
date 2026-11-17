import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openAsBlob, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  formatServerDate,
  isAudioAttachment,
  isPlainObject,
  newEtag,
  type AiStatusResponse,
  type Attachment,
  type AttachmentSummary,
  type Comment,
  type Loose,
  type Task,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import { currentActor } from "./actor.js";
import { ApiError, type Service } from "./service.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_AI_PROVIDER = "groq";
export const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const DEFAULT_GROQ_TRANSCRIBE_MODEL = "whisper-large-v3-turbo";
/** Groq deprecated free/dev Llama 3.1/3.3 chat models on 2026-08-16 and Llama 4 Scout/Maverick in 2026-03/07; openai/gpt-oss-120b is Groq's active Production replacement. */
export const DEFAULT_GROQ_SUMMARIZE_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_GROQ_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_AI_RATE_LIMIT_PER_HOUR = 20;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CHUNKS = 48;
const GROQ_DIRECT_AUDIO_EXT = new Set(["flac", "mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm"]);
const AUDIO_MIME: Record<string, string> = {
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
};

export type AiFetchLike = typeof fetch;

export interface AiConfig {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  transcribeModel?: string;
  summarizeModel?: string;
  maxFileBytes?: number;
  rateLimitPerHour?: number;
}

export interface ResolvedAiConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  transcribeModel: string;
  summarizeModel: string;
  maxFileBytes: number;
  rateLimitPerHour: number;
}

export interface TranscribeInput {
  filePath: string;
  fileName: string;
}

export interface TranscribeOutput {
  text: string;
  language?: string;
}

export interface SummarizeInput {
  transcript: string;
  language?: string;
}

export interface SummarizeOutput {
  summary: AttachmentSummary;
}

export interface AiProvider {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<TranscribeOutput>;
  summarize(input: SummarizeInput): Promise<SummarizeOutput>;
}

export interface AiDeps {
  fetch?: AiFetchLike;
  hasFfmpeg?: () => Promise<boolean>;
  runFfmpeg?: (args: string[]) => Promise<void>;
  rateLimiter?: AiRateLimiter;
}

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return m ? m[1]!.toLowerCase() : "";
}

function cleanStr(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function cleanPosInt(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** Resolve AI config with optional environment overrides (never returns empty/invalid numeric limits). */
export function resolveAiConfig(raw?: AiConfig, env?: NodeJS.ProcessEnv): ResolvedAiConfig {
  const provider = (cleanStr(env?.NOORTASKS_AI_PROVIDER) ?? cleanStr(raw?.provider) ?? DEFAULT_AI_PROVIDER).toLowerCase();
  const envKey =
    provider === "groq"
      ? cleanStr(env?.NOORTASKS_GROQ_API_KEY) ?? cleanStr(env?.NOORTASKS_AI_API_KEY)
      : cleanStr(env?.NOORTASKS_AI_API_KEY);
  const apiKey = envKey ?? cleanStr(raw?.apiKey) ?? "";
  const baseUrl = (cleanStr(env?.NOORTASKS_AI_BASE_URL) ?? cleanStr(raw?.baseUrl) ?? DEFAULT_GROQ_BASE_URL).replace(/\/+$/, "");
  const transcribeModel =
    cleanStr(env?.NOORTASKS_AI_TRANSCRIBE_MODEL) ?? cleanStr(raw?.transcribeModel) ?? DEFAULT_GROQ_TRANSCRIBE_MODEL;
  const summarizeModel =
    cleanStr(env?.NOORTASKS_AI_SUMMARIZE_MODEL) ?? cleanStr(raw?.summarizeModel) ?? DEFAULT_GROQ_SUMMARIZE_MODEL;
  const maxFileBytes =
    cleanPosInt(env?.NOORTASKS_AI_MAX_FILE_BYTES) ?? cleanPosInt(raw?.maxFileBytes) ?? DEFAULT_GROQ_MAX_FILE_BYTES;
  const rateLimitPerHour =
    cleanPosInt(env?.NOORTASKS_AI_RATE_LIMIT) ?? cleanPosInt(raw?.rateLimitPerHour) ?? DEFAULT_AI_RATE_LIMIT_PER_HOUR;

  return {
    provider,
    apiKey,
    baseUrl,
    transcribeModel,
    summarizeModel,
    maxFileBytes,
    rateLimitPerHour,
  };
}

export function validateAiConfig(raw: unknown): AiConfig {
  if (!isPlainObject(raw)) throw new Error("config: ai must be an object");
  for (const k of ["provider", "apiKey", "baseUrl", "transcribeModel", "summarizeModel"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") throw new Error(`config: ai.${k} must be a string`);
  }
  for (const k of ["maxFileBytes", "rateLimitPerHour"] as const) {
    if (raw[k] !== undefined && (typeof raw[k] !== "number" || !Number.isFinite(raw[k]) || raw[k] <= 0)) {
      throw new Error(`config: ai.${k} must be a positive number`);
    }
  }
  const provider = (cleanStr(raw.provider) ?? DEFAULT_AI_PROVIDER).toLowerCase();
  if (provider !== "groq") throw new Error(`config: unsupported ai.provider "${provider}"`);
  return raw as AiConfig;
}

/** Sliding-window per-user rate limiter shared across tenants in multi-user mode. */
export class AiRateLimiter {
  private hits = new Map<number, number[]>();

  constructor(
    private readonly maxRequests = DEFAULT_AI_RATE_LIMIT_PER_HOUR,
    private readonly windowMs = 3_600_000,
  ) {}

  consume(userId: number, now = Date.now()): void {
    const cutoff = now - this.windowMs;
    const prev = (this.hits.get(userId) ?? []).filter((t) => t > cutoff);
    if (prev.length >= this.maxRequests) {
      this.hits.set(userId, prev);
      throw new ApiError(429, "rate_limit_exceeded", `AI rate limit reached (${this.maxRequests} requests per hour). Try again later.`);
    }
    prev.push(now);
    this.hits.set(userId, prev);
  }
}

async function defaultHasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function defaultRunFfmpeg(args: string[]): Promise<void> {
  await execFileAsync("ffmpeg", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
}

interface PreparedPart {
  blob: () => Promise<Blob>;
  fileName: string;
}

interface PreparedAudio {
  parts: PreparedPart[];
  cleanup: () => void;
}

function byteSplitParts(filePath: string, fileName: string, ext: string, size: number, maxBytes: number): PreparedPart[] {
  const count = Math.ceil(size / maxBytes);
  if (count > MAX_CHUNKS) {
    throw new ApiError(413, "audio_too_large", "Audio file is too large to process");
  }
  const mime = AUDIO_MIME[ext] ?? "application/octet-stream";
  const uploadName = ext === "opus" ? `${fileName.replace(/\.opus$/i, "")}.ogg` : fileName;
  const parts: PreparedPart[] = [];
  const raw = readFileSync(filePath);
  for (let offset = 0, idx = 0; offset < raw.length; offset += maxBytes, idx++) {
    const slice = raw.subarray(offset, Math.min(raw.length, offset + maxBytes));
    const partName = count === 1 ? uploadName : `part-${idx}-${uploadName}`;
    parts.push({
      fileName: partName,
      blob: async () => new Blob([slice], { type: mime }),
    });
  }
  return parts;
}

async function prepareAudioForGroq(
  filePath: string,
  fileName: string,
  maxFileBytes: number,
  deps: { hasFfmpeg: () => Promise<boolean>; runFfmpeg: (args: string[]) => Promise<void> },
): Promise<PreparedAudio> {
  const st = statSync(filePath);
  const ext = extOf(fileName);
  const needsSizeReduction = st.size > maxFileBytes;
  const needsContainerTranscode = ext === "aac" || ext === "opus";

  if (!needsSizeReduction && !needsContainerTranscode && GROQ_DIRECT_AUDIO_EXT.has(ext)) {
    const mime = AUDIO_MIME[ext] ?? "application/octet-stream";
    return {
      parts: [{ fileName, blob: () => openAsBlob(filePath, { type: mime }) }],
      cleanup: () => {},
    };
  }

  let tmpDir: string | null = null;
  const cleanup = (): void => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  };

  try {
    const ffmpegAvailable = await deps.hasFfmpeg();
    if (ffmpegAvailable) {
      tmpDir = mkdtempSync(join(tmpdir(), "nt-ai-"));
      const encoded = join(tmpDir, "audio.ogg");
      try {
        await deps.runFfmpeg([
          "-y",
          "-v",
          "error",
          "-i",
          filePath,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "libopus",
          "-b:a",
          "32k",
          encoded,
        ]);
        if (existsSync(encoded)) {
          const outSize = statSync(encoded).size;
          if (outSize > 0 && outSize <= maxFileBytes) {
            return {
              parts: [{ fileName: "audio.ogg", blob: () => openAsBlob(encoded, { type: "audio/ogg" }) }],
              cleanup,
            };
          }
          if (outSize > maxFileBytes) {
            // Re-encoded file still exceeds the limit: split by size on the compressed stream.
            return { parts: byteSplitParts(encoded, "audio.ogg", "ogg", outSize, maxFileBytes), cleanup };
          }
        }
      } catch {
        // Fall through to raw chunking if ffmpeg fails on an unusual container/test fixture.
      }
    }

    if (st.size <= maxFileBytes) {
      const fallbackName = ext === "opus" ? `${fileName.replace(/\.opus$/i, "")}.ogg` : fileName;
      const mime = AUDIO_MIME[ext] ?? "application/octet-stream";
      return {
        parts: [{ fileName: fallbackName, blob: () => openAsBlob(filePath, { type: mime }) }],
        cleanup,
      };
    }

    return {
      parts: byteSplitParts(filePath, fileName, ext, st.size, maxFileBytes),
      cleanup,
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}

function cleanStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .slice(0, 30);
}

/** Formats structured summary fields as clean markdown for display and task description insertion. */
export function formatSummaryMarkdown(s: Pick<AttachmentSummary, "keyPoints" | "decisions" | "actionItems" | "text">): string {
  const sections: string[] = [];
  if (s.keyPoints?.length) {
    sections.push(`### Key Points\n${s.keyPoints.map((x) => `- ${x}`).join("\n")}`);
  }
  if (s.decisions?.length) {
    sections.push(`### Decisions\n${s.decisions.map((x) => `- ${x}`).join("\n")}`);
  }
  if (s.actionItems?.length) {
    sections.push(`### Action Items\n${s.actionItems.map((x) => `- ${x}`).join("\n")}`);
  }
  if (sections.length) return sections.join("\n\n");
  return s.text?.trim() || "No key points extracted.";
}

function parseMarkdownSections(raw: string): { keyPoints: string[]; decisions: string[]; actionItems: string[] } {
  const keyPoints: string[] = [];
  const decisions: string[] = [];
  const actionItems: string[] = [];
  let bucket: string[] = keyPoints;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.replace(/^#+\s*/, "").replace(/:$/, "").toLowerCase();
    if (/^(key points?|summary|highlights?)$/.test(lower)) {
      bucket = keyPoints;
      continue;
    }
    if (/^decisions?$/.test(lower)) {
      bucket = decisions;
      continue;
    }
    if (/^(action items?|next steps?|tasks?|todos?)$/.test(lower)) {
      bucket = actionItems;
      continue;
    }
    const bullet = trimmed.replace(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "").trim();
    if (bullet && !/^none$/i.test(bullet)) bucket.push(bullet);
  }
  return { keyPoints, decisions, actionItems };
}

export function parseSummaryContent(raw: string, model: string, updatedAt: string, language?: string): AttachmentSummary {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    if (isPlainObject(parsed)) {
      const keyPoints = cleanStringList(parsed.keyPoints ?? parsed.key_points);
      const decisions = cleanStringList(parsed.decisions);
      const actionItems = cleanStringList(parsed.actionItems ?? parsed.action_items);
      const summary: AttachmentSummary = {
        keyPoints,
        decisions,
        actionItems,
        text: formatSummaryMarkdown({ keyPoints, decisions, actionItems, ...(typeof parsed.text === "string" ? { text: parsed.text } : {}) }),
        ...(language ? { language } : {}),
        model,
        updatedAt,
      };
      return summary;
    }
  } catch {
    // Fallback to markdown section extraction when a custom model returns prose/bullets instead of JSON.
  }

  const md = parseMarkdownSections(stripped);
  return {
    keyPoints: md.keyPoints,
    decisions: md.decisions,
    actionItems: md.actionItems,
    text: formatSummaryMarkdown({ ...md, text: stripped }),
    ...(language ? { language } : {}),
    model,
    updatedAt,
  };
}

async function parseUpstreamError(res: Response): Promise<string> {
  try {
    const txt = await res.text();
    if (!txt) return `AI provider error (HTTP ${res.status})`;
    try {
      const j = JSON.parse(txt) as { error?: { message?: string }; message?: string };
      const msg = j.error?.message ?? j.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 240);
    } catch {
      /* non-json body */
    }
    return txt.trim().slice(0, 240);
  } catch {
    return `AI provider error (HTTP ${res.status})`;
  }
}

export class GroqProvider implements AiProvider {
  readonly name = "groq";
  private readonly fetchImpl: AiFetchLike;
  private readonly hasFfmpeg: () => Promise<boolean>;
  private readonly runFfmpeg: (args: string[]) => Promise<void>;

  constructor(
    private readonly cfg: ResolvedAiConfig,
    deps: AiDeps = {},
  ) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
    this.hasFfmpeg = deps.hasFfmpeg ?? defaultHasFfmpeg;
    this.runFfmpeg = deps.runFfmpeg ?? defaultRunFfmpeg;
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    const prepared = await prepareAudioForGroq(input.filePath, input.fileName, this.cfg.maxFileBytes, {
      hasFfmpeg: this.hasFfmpeg,
      runFfmpeg: this.runFfmpeg,
    });
    const texts: string[] = [];
    let language: string | undefined;

    try {
      for (const part of prepared.parts) {
        const fd = new FormData();
        fd.append("file", await part.blob(), part.fileName);
        fd.append("model", this.cfg.transcribeModel);
        fd.append("response_format", "verbose_json");

        let res: Response;
        try {
          res = await this.fetchImpl(`${this.cfg.baseUrl}/audio/transcriptions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
            body: fd,
            signal: AbortSignal.timeout(120_000),
          });
        } catch {
          throw new ApiError(502, "ai_provider_unreachable", "Could not reach AI transcription service");
        }

        if (!res.ok) {
          const msg = await parseUpstreamError(res);
          if (res.status === 401 || res.status === 403) {
            throw new ApiError(502, "ai_auth_failed", `AI provider rejected credentials: ${msg}`);
          }
          if (res.status === 429) {
            throw new ApiError(502, "ai_upstream_rate_limit", msg);
          }
          throw new ApiError(502, "ai_provider_error", msg);
        }

        const data = (await res.json()) as { text?: unknown; language?: unknown };
        if (typeof data.text === "string" && data.text.trim()) {
          texts.push(data.text.trim());
        }
        if (!language && typeof data.language === "string" && data.language.trim()) {
          language = data.language.trim();
        }
      }
    } finally {
      prepared.cleanup();
    }

    return {
      text: texts.join(" ").trim(),
      ...(language ? { language } : {}),
    };
  }

  async summarize(input: SummarizeInput): Promise<SummarizeOutput> {
    const payload: Record<string, unknown> = {
      model: this.cfg.summarizeModel,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            'Summarize the transcript concisely in the same language as the transcript. Return ONLY a valid JSON object with three string arrays: "keyPoints", "decisions", and "actionItems". Use [] when none apply.',
        },
        {
          role: "user",
          content: input.transcript,
        },
      ],
    };
    if (this.cfg.summarizeModel.startsWith("openai/gpt-oss-")) {
      payload.reasoning_effort = "low";
      payload.include_reasoning = false;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ApiError(502, "ai_provider_unreachable", "Could not reach AI summarization service");
    }

    if (!res.ok) {
      const msg = await parseUpstreamError(res);
      if (res.status === 401 || res.status === 403) {
        throw new ApiError(502, "ai_auth_failed", `AI provider rejected credentials: ${msg}`);
      }
      if (res.status === 429) {
        throw new ApiError(502, "ai_upstream_rate_limit", msg);
      }
      throw new ApiError(502, "ai_provider_error", msg);
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new ApiError(502, "ai_empty_response", "AI provider returned an empty summary");
    }

    return {
      summary: parseSummaryContent(content, this.cfg.summarizeModel, formatServerDate(), input.language),
    };
  }
}

export function createAiProvider(cfg: ResolvedAiConfig, deps: AiDeps = {}): AiProvider | undefined {
  if (!cfg.apiKey) return undefined;
  if (cfg.provider === "groq") return new GroqProvider(cfg, deps);
  throw new Error(`Unsupported ai.provider: ${cfg.provider}`);
}

interface AttachmentRow {
  id: string;
  taskId: string;
  projectId: string;
  taskSet: string | null;
  fileName: string | null;
  type: string | null;
  state: string;
  file: string | null;
  json: string | null;
}

export class AiService {
  private readonly cfg: ResolvedAiConfig;
  private readonly provider: AiProvider | undefined;
  private readonly limiter: AiRateLimiter;
  private readonly inflight = new Map<string, Promise<Attachment>>();

  constructor(
    private readonly svc: Service,
    rawConfig?: AiConfig,
    deps: AiDeps = {},
  ) {
    this.cfg = resolveAiConfig(rawConfig);
    this.provider = createAiProvider(this.cfg, deps);
    this.limiter = deps.rateLimiter ?? new AiRateLimiter(this.cfg.rateLimitPerHour);
  }

  status(): AiStatusResponse {
    return {
      configured: Boolean(this.provider),
      provider: this.cfg.provider,
      transcribeModel: this.cfg.transcribeModel,
      summarizeModel: this.cfg.summarizeModel,
    };
  }

  private actorId(): number {
    return currentActor()?.userId ?? this.svc.userId;
  }

  private getRow(id: string): AttachmentRow {
    if (!SAFE_ID.test(id)) throw new ApiError(400, "invalid_id");
    const row = this.svc.store.get<AttachmentRow>(
      "select id, taskId, projectId, taskSet, fileName, type, state, file, json from attachments where id = ?",
      id,
    );
    if (!row) throw new ApiError(404, "attachment_not_found");
    return row;
  }

  private loadAttachment(row: AttachmentRow): Attachment {
    const task = row.taskSet !== "comment" && row.taskSet !== "countdown" ? this.svc.store.getTask(row.taskId) : undefined;
    const fromTask = task?.attachments?.find((a) => a.id === row.id);
    if (fromTask) return fromTask;
    if (row.json) return JSON.parse(row.json) as Attachment;
    return {
      id: row.id,
      refId: row.id,
      path: "",
      fileName: row.fileName ?? row.id,
      fileType: row.type ?? "OTHER",
      size: 0,
      status: 0,
      createdTime: formatServerDate(this.svc.now()),
    };
  }

  private saveAttachment(row: AttachmentRow, patch: { [K in keyof Attachment]?: Attachment[K] | undefined }): Attachment {
    return this.svc.store.tx(() => {
      const seq = this.svc.store.seq();
      const now = formatServerDate(this.svc.now());
      const freshRow = this.getRow(row.id);
      const base = this.loadAttachment(freshRow);
      const merged: Loose = { ...base };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete merged[k];
        else merged[k] = v;
      }
      const next = merged as Attachment;

      if (freshRow.taskSet === "comment") {
        const comments = this.svc.store.all<{ id: string; json: string }>(
          "select id, json from comments where taskId = ?",
          freshRow.taskId,
        );
        for (const c of comments) {
          const parsed = JSON.parse(c.json) as Comment;
          const list = parsed.attachments ?? [];
          const idx = list.findIndex((a) => a.id === row.id);
          if (idx >= 0) {
            const updatedList = [...list];
            updatedList[idx] = next;
            parsed.attachments = updatedList;
            parsed.modifiedTime = now;
            this.svc.store.run("update comments set json = ? where id = ?", JSON.stringify(parsed), c.id);
          }
        }
        this.svc.upsertAttachmentRow({ id: freshRow.taskId, projectId: freshRow.projectId } as Task, next as Loose, {
          state: freshRow.state,
          file: freshRow.file,
          taskSet: "comment",
        });
        const task = this.svc.store.getTask(freshRow.taskId);
        if (task) {
          task.etag = newEtag();
          task.modifiedTime = now;
          this.svc.store.putTask(task, { seq });
        }
        return next;
      }

      const task = this.svc.store.getTask(freshRow.taskId);
      if (task) {
        const list = [...(task.attachments ?? [])];
        const idx = list.findIndex((a) => a.id === row.id);
        if (idx >= 0) list[idx] = next;
        else list.push(next);
        task.attachments = list;
        task.etag = newEtag();
        task.modifiedTime = now;
        this.svc.store.putTask(task, { seq });
        this.svc.upsertAttachmentRow(task, next as Loose, {
          state: freshRow.state,
          file: freshRow.file,
          ...(freshRow.taskSet ? { taskSet: freshRow.taskSet } : {}),
        });
      } else {
        this.svc.upsertAttachmentRow({ id: freshRow.taskId, projectId: freshRow.projectId } as Task, next as Loose, {
          state: freshRow.state,
          file: freshRow.file,
          ...(freshRow.taskSet ? { taskSet: freshRow.taskSet } : {}),
        });
      }
      return next;
    });
  }

  private requireAudioFile(row: AttachmentRow, att: Attachment): { filePath: string; fileName: string } {
    if (!isAudioAttachment(att)) {
      throw new ApiError(400, "unsupported_media_type", "Attachment is not a supported audio file");
    }
    if (row.state !== "stored" || !row.file || !existsSync(row.file)) {
      throw new ApiError(404, "attachment_not_uploaded", "the file bytes are not on this server");
    }
    return { filePath: row.file, fileName: att.fileName || row.fileName || row.id };
  }

  private async runExclusive(id: string, fn: () => Promise<Attachment>): Promise<Attachment> {
    const existing = this.inflight.get(id);
    if (existing) return existing;
    const p = fn().finally(() => {
      if (this.inflight.get(id) === p) this.inflight.delete(id);
    });
    this.inflight.set(id, p);
    return p;
  }

  async transcribe(id: string, opts: { force?: boolean } = {}): Promise<Attachment> {
    const row = this.getRow(id);
    const current = this.loadAttachment(row);
    this.requireAudioFile(row, current);

    if (!opts.force && typeof current.transcript === "string" && current.transcript.length > 0 && current.aiStatus !== "error") {
      return current;
    }
    if (!this.provider) {
      throw new ApiError(503, "ai_not_configured", "AI transcription is not configured on this server");
    }

    return this.runExclusive(id, async () => {
      const latestRow = this.getRow(id);
      const latest = this.loadAttachment(latestRow);
      const { filePath, fileName } = this.requireAudioFile(latestRow, latest);
      if (!opts.force && typeof latest.transcript === "string" && latest.transcript.length > 0 && latest.aiStatus !== "error") {
        return latest;
      }

      this.limiter.consume(this.actorId(), this.svc.now());
      this.saveAttachment(latestRow, { aiStatus: "transcribing", aiError: undefined });

      try {
        const out = await this.provider!.transcribe({ filePath, fileName });
        return this.saveAttachment(latestRow, {
          transcript: out.text,
          aiStatus: "done",
          aiError: undefined,
          transcribedAt: formatServerDate(this.svc.now()),
          ...(out.language ? { aiLanguage: out.language } : {}),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Transcription failed";
        this.saveAttachment(latestRow, { aiStatus: "error", aiError: msg });
        throw err;
      }
    });
  }

  async summarize(id: string, opts: { force?: boolean } = {}): Promise<Attachment> {
    const row = this.getRow(id);
    const current = this.loadAttachment(row);
    this.requireAudioFile(row, current);

    if (!opts.force && isPlainObject(current.summary) && (current.aiStatus === "done" || (typeof current.summary.text === "string" && current.summary.text.length > 0))) {
      return current;
    }
    if (!this.provider) {
      throw new ApiError(503, "ai_not_configured", "AI transcription is not configured on this server");
    }

    return this.runExclusive(id, async () => {
      const latestRow = this.getRow(id);
      let latest = this.loadAttachment(latestRow);
      const { filePath, fileName } = this.requireAudioFile(latestRow, latest);
      if (!opts.force && isPlainObject(latest.summary) && (latest.aiStatus === "done" || (typeof latest.summary.text === "string" && latest.summary.text.length > 0))) {
        return latest;
      }

      this.limiter.consume(this.actorId(), this.svc.now());

      let transcript = typeof latest.transcript === "string" ? latest.transcript : "";
      let language = typeof (latest as Loose).aiLanguage === "string" ? String((latest as Loose).aiLanguage) : undefined;

      try {
        if (!transcript.trim()) {
          this.saveAttachment(latestRow, { aiStatus: "transcribing", aiError: undefined });
          const stt = await this.provider!.transcribe({ filePath, fileName });
          transcript = stt.text;
          language = stt.language ?? language;
          latest = this.saveAttachment(latestRow, {
            transcript,
            aiStatus: "summarizing",
            aiError: undefined,
            transcribedAt: formatServerDate(this.svc.now()),
            ...(language ? { aiLanguage: language } : {}),
          });
        } else {
          this.saveAttachment(latestRow, { aiStatus: "summarizing", aiError: undefined });
        }

        if (!transcript.trim()) {
          throw new ApiError(422, "empty_transcript", "No speech was detected in this audio");
        }

        const out = await this.provider!.summarize({ transcript, ...(language ? { language } : {}) });
        return this.saveAttachment(latestRow, {
          summary: {
            ...out.summary,
            updatedAt: formatServerDate(this.svc.now()),
          },
          aiStatus: "done",
          aiError: undefined,
          summarizedAt: formatServerDate(this.svc.now()),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Summarization failed";
        this.saveAttachment(latestRow, { aiStatus: "error", aiError: msg });
        throw err;
      }
    });
  }
}

export function registerAiRoutes(app: FastifyInstance, svc: Service, rawConfig?: AiConfig, deps: AiDeps = {}): AiService {
  const ai = new AiService(svc, rawConfig, deps);
  app.get("/api/v2/ai/status", async () => ai.status());
  app.post<{ Params: { id: string }; Body: { force?: boolean } | undefined }>(
    "/api/v2/attachment/:id/transcribe",
    async (req) => ai.transcribe(req.params.id, { force: isPlainObject(req.body) && req.body.force === true }),
  );
  app.post<{ Params: { id: string }; Body: { force?: boolean } | undefined }>(
    "/api/v2/attachment/:id/summarize",
    async (req) => ai.summarize(req.params.id, { force: isPlainObject(req.body) && req.body.force === true }),
  );
  return ai;
}
