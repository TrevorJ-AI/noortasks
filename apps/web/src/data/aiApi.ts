import type { Api } from "./api";
import { getNativeCsrfToken, isCapacitor } from "../lib/capacitor";
import type { AiStatusResponse, Attachment } from "../lib/core";

/**
 * Raw HTTP client for attachment AI transcription and summarization endpoints.
 * Mirrors calApi: handles 5xx directly instead of collapsing them into OfflineError
 * so 503 ai_not_configured and 502 provider errors reach the UI cleanly.
 */

export interface AiResult<T> {
  ok: boolean;
  status: number;
  data: T;
  /** server errorCode, or "offline" when the request failed before receiving a response */
  error?: string;
  message?: string;
}

export const DEFAULT_AI_STATUS: AiStatusResponse = {
  configured: false,
  provider: "groq",
  transcribeModel: "",
  summarizeModel: "",
};

function csrfFromCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const m = /(?:^|;\s*)_csrf_token=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export async function aiReq<T = unknown>(
  api: Pick<Api, "base">,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AiResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const csrf = isCapacitor() && api.base ? (getNativeCsrfToken(api.base) ?? csrfFromCookie()) : csrfFromCookie();
  if (csrf) headers["X-Csrftoken"] = csrf;

  let res: Response;
  try {
    res = await fetchImpl(api.base + path, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      data: undefined as T,
      error: "offline",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const errObj = data && typeof data === "object" ? (data as { errorCode?: unknown; errorMessage?: unknown }) : undefined;
    const error = typeof errObj?.errorCode === "string" ? errObj.errorCode : `http_${res.status}`;
    const message =
      typeof errObj?.errorMessage === "string"
        ? errObj.errorMessage
        : typeof data === "string" && data.trim()
          ? data.trim()
          : `Request failed (${res.status})`;
    return { ok: false, status: res.status, data: data as T, error, message };
  }

  return { ok: true, status: res.status, data: data as T };
}

export function fetchAiStatus(api: Pick<Api, "base">, fetchImpl?: typeof fetch): Promise<AiResult<AiStatusResponse>> {
  return aiReq<AiStatusResponse>(api, "GET", "/api/v2/ai/status", undefined, fetchImpl);
}

export function transcribeAttachment(
  api: Pick<Api, "base">,
  attachmentId: string,
  opts: { force?: boolean } = {},
  fetchImpl?: typeof fetch,
): Promise<AiResult<Attachment>> {
  return aiReq<Attachment>(
    api,
    "POST",
    `/api/v2/attachment/${encodeURIComponent(attachmentId)}/transcribe`,
    opts.force ? { force: true } : {},
    fetchImpl,
  );
}

export function summarizeAttachment(
  api: Pick<Api, "base">,
  attachmentId: string,
  opts: { force?: boolean } = {},
  fetchImpl?: typeof fetch,
): Promise<AiResult<Attachment>> {
  return aiReq<Attachment>(
    api,
    "POST",
    `/api/v2/attachment/${encodeURIComponent(attachmentId)}/summarize`,
    opts.force ? { force: true } : {},
    fetchImpl,
  );
}
