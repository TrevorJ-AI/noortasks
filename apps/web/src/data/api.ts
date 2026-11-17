import { getApiBase, getNativeCsrfToken, isCapacitor } from "../lib/capacitor";

/** Thin HTTP client for the NoorTasks server sync and REST endpoints. */
export class OfflineError extends Error {
  constructor(msg = "offline") {
    super(msg);
  }
}
export class AuthError extends Error {
  constructor() {
    super("unauthorized");
  }
}
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`http ${status}`);
  }
}

export interface ApiOptions {
  base?: string;
  fetch?: typeof fetch;
  /** test hook: pretend the network is down */
  isOffline?: () => boolean;
}

function csrfFromCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const m = /(?:^|;\s*)_csrf_token=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export class Api {
  private _base: string;
  private f: typeof fetch;
  constructor(private opts: ApiOptions = {}) {
    this._base = opts.base ?? getApiBase();
    this.f = opts.fetch ?? ((...a) => globalThis.fetch(...a));
  }

  get base(): string {
    return this._base;
  }

  setBase(next: string): void {
    this._base = next;
  }

  url(path: string): string {
    return this._base + path;
  }

  async req<T = unknown>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
    if (this.opts.isOffline?.()) throw new OfflineError();
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
    const csrf = isCapacitor() && this._base ? (getNativeCsrfToken(this._base) ?? csrfFromCookie()) : csrfFromCookie();
    if (csrf) headers["X-Csrftoken"] = csrf;
    let res: Response;
    try {
      res = await this.f(this._base + path, {
        ...init,
        method,
        headers,
        credentials: "include",
        body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      });
    } catch (e) {
      throw new OfflineError(String(e));
    }
    if (res.status === 401) throw new AuthError();
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (res.status >= 500 || res.status === 0) throw new OfflineError(`server ${res.status}`);
    if (!res.ok) throw new HttpError(res.status, data);
    return data as T;
  }
  get<T = unknown>(path: string): Promise<T> {
    return this.req<T>("GET", path);
  }
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>("POST", path, body);
  }
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>("PUT", path, body);
  }
  del<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>("DELETE", path, body);
  }
}
