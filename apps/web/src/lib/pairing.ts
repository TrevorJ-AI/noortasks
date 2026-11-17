export interface PairingQrData {
  url: string;
  token: string | null;
}

function withDefaultScheme(trimmed: string): string | null {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:(?![0-9]+(?:$|[/?#]))/.test(trimmed)) return null;
  return `https://${trimmed}`;
}

/** Normalizes a server origin URL (accepting http/https; bare hosts default to https). Rejects credentials or invalid schemes. */
export function normalizeOriginUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const candidate = withDefaultScheme(trimmed);
  if (!candidate) return null;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.origin;
}

function cleanToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || /\s/.test(t) || t.length > 512) return null;
  return t;
}

/** Encodes the server origin and one-time pairing token into a compact URL fragment QR payload. */
export function buildPairingQrPayload(opts: { url: string; token: string }): string {
  const origin = normalizeOriginUrl(opts.url);
  if (!origin) throw new Error("invalid_server_url");
  const token = cleanToken(opts.token);
  if (!token) throw new Error("invalid_pairing_token");
  return `${origin}/#pair=${encodeURIComponent(token)}`;
}

/** Parses a scanned QR payload (pairing URL fragment, custom scheme, JSON, or bare server URL). */
export function parsePairingQr(raw: string): PairingQrData | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as { url?: unknown; serverUrl?: unknown; token?: unknown };
      const rawUrl = typeof obj.url === "string" ? obj.url : typeof obj.serverUrl === "string" ? obj.serverUrl : "";
      const url = normalizeOriginUrl(rawUrl);
      if (!url) return null;
      return { url, token: cleanToken(obj.token) };
    } catch {
      return null;
    }
  }

  if (/^(?:app\.noortasks|noortasks):\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      if (u.host !== "pair") return null;
      const url = normalizeOriginUrl(u.searchParams.get("url") ?? "");
      if (!url) return null;
      return { url, token: cleanToken(u.searchParams.get("token")) };
    } catch {
      return null;
    }
  }

  if (/\s/.test(trimmed)) return null;
  const candidate = withDefaultScheme(trimmed);
  if (!candidate) return null;
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || !u.hostname) return null;

  let token: string | null = null;
  if (u.hash.startsWith("#")) {
    const hashBody = u.hash.slice(1);
    if (hashBody.includes("pair=")) {
      token = cleanToken(new URLSearchParams(hashBody).get("pair"));
    }
  }
  if (!token && u.searchParams.has("pair")) {
    token = cleanToken(u.searchParams.get("pair"));
  }
  return { url: u.origin, token };
}

/** Extracts a pairing token from either a raw token string or a full pairing link/QR payload. */
export function extractPairingToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#pair=") || trimmed.startsWith("pair=")) {
    const q = new URLSearchParams(trimmed.replace(/^#/, ""));
    return cleanToken(q.get("pair")) ?? "";
  }
  const parsed = parsePairingQr(trimmed);
  if (parsed?.token) return parsed.token;
  return cleanToken(trimmed) ?? "";
}

/** Reads an initial `#pair=<token>` fragment or `?setup_paired=1` flag without mutating history. */
export function peekLaunchPairingParams(): { pairToken: string | null; setupPaired: boolean } {
  if (typeof window === "undefined") return { pairToken: null, setupPaired: false };
  let pairToken: string | null = null;
  let setupPaired = false;

  const hash = window.location.hash;
  if (hash && hash.includes("pair=")) {
    const q = new URLSearchParams(hash.replace(/^#\/?/, ""));
    pairToken = cleanToken(q.get("pair"));
  }

  const search = new URLSearchParams(window.location.search);
  if (search.get("setup_paired") === "1") {
    setupPaired = true;
  }

  return { pairToken, setupPaired };
}

/** Scrubs any `#pair=<token>` fragment or `?setup_paired=1` query param from the address bar. */
export function scrubLaunchPairingParams(): void {
  if (typeof window === "undefined") return;
  let changed = false;
  let nextHash = window.location.hash;
  if (nextHash && nextHash.includes("pair=")) {
    const q = new URLSearchParams(nextHash.replace(/^#\/?/, ""));
    if (cleanToken(q.get("pair"))) {
      nextHash = "";
      changed = true;
    }
  }
  const search = new URLSearchParams(window.location.search);
  if (search.has("setup_paired")) {
    search.delete("setup_paired");
    changed = true;
  }
  if (changed) {
    const nextSearch = search.toString();
    const nextUrl = window.location.pathname + (nextSearch ? `?${nextSearch}` : "") + nextHash;
    window.history.replaceState(null, "", nextUrl);
  }
}

/** Reads and scrubs an initial `#pair=<token>` fragment or `?setup_paired=1` flag before hash routing runs. */
export function consumeLaunchPairingParams(): { pairToken: string | null; setupPaired: boolean } {
  const res = peekLaunchPairingParams();
  scrubLaunchPairingParams();
  return res;
}
