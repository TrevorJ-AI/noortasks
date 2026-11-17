import { onNativeAuthUrl, openSystemBrowser } from "./capacitor";

const PENDING_KEY = "noorNativeLogin";
interface Pending { base: string; state: string; verifier: string; createdMs: number }
interface AuthApi { base: string; post: (path: string, body: unknown) => Promise<unknown> }
const randomSecret = (): string => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

export async function startNativeOidc(base: string): Promise<void> {
  const server = new URL(base);
  // Login sends credentials. Require HTTPS even if the optional LAN password setup uses HTTP.
  if (server.protocol !== "https:" || server.username || server.password || server.pathname !== "/" || server.search || server.hash) throw new Error("https_required");
  const url = new URL("/api/auth/oidc/start", server);
  const verifier = randomSecret();
  const state = randomSecret();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const pending: Pending = { base, state, verifier, createdMs: Date.now() };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  url.searchParams.set("native_challenge", challenge);
  url.searchParams.set("native_state", state);
  try { await openSystemBrowser(url.href); }
  catch { localStorage.removeItem(PENDING_KEY); throw new Error("browser_unavailable"); }
}

/** Ignores unsolicited links and never accepts a server address from a return link. */
export async function finishNativeOidc(rawUrl: string, api: AuthApi): Promise<boolean> {
  let url: URL;
  let pending: Pending;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "app.noortasks:" || url.host !== "auth" || (url.pathname !== "" && url.pathname !== "/") || url.username || url.password || url.hash) return false;
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "null") as Pending;
    if (!pending || pending.base !== api.base || pending.state !== url.searchParams.get("state")) return false;
  } catch { return false; }
  localStorage.removeItem(PENDING_KEY); // before any await: duplicate intent/launch events cannot redeem twice
  if (Date.now() - pending.createdMs > 10 * 60_000) throw new Error("state_mismatch");
  const error = url.searchParams.get("auth_error");
  if (error) throw new Error(/^[a-z_]+$/.test(error) ? error : "token_rejected");
  const code = url.searchParams.get("code");
  if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error("token_rejected");
  await api.post("/api/auth/oidc/native/redeem", { code, verifier: pending.verifier });
  return true;
}

export function watchNativeOidc(api: AuthApi, done: () => void, failed: (code: string) => void): () => void {
  return onNativeAuthUrl((url) => {
    void finishNativeOidc(url, api).then((ok) => { if (ok) done(); }, (e: unknown) => failed(e instanceof Error ? e.message : "token_rejected"));
  });
}
