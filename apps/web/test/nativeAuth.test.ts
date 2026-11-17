import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { finishNativeOidc, startNativeOidc, watchNativeOidc } from "../src/lib/nativeAuth";

const base = "https://tasks.example.com";
let open: ReturnType<typeof vi.fn>;
let post: ReturnType<typeof vi.fn>;
const pending = () => JSON.parse(localStorage.getItem("noorNativeLogin")!);
const link = (state: string, query = `code=${"c".repeat(43)}`) => `app.noortasks://auth?state=${state}&${query}`;

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k) });
  open = vi.fn().mockResolvedValue(undefined);
  post = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("Capacitor", { isNativePlatform: () => true, Plugins: { Browser: { open } } });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("native OIDC", () => {
  it("opens the system browser with a challenge, keeps the verifier off URLs, and redeems against the saved server", async () => {
    await startNativeOidc(base);
    const p = pending();
    const url = new URL(open.mock.calls[0][0].url);
    expect(url.origin).toBe(base);
    expect(url.pathname).toBe("/api/auth/oidc/start");
    expect(url.searchParams.get("native_state")).toBe(p.state);
    expect(url.searchParams.get("native_challenge")).toBe(createHash("sha256").update(p.verifier).digest("base64url"));
    expect(url.href).not.toContain(p.verifier);
    expect(await finishNativeOidc(link(p.state), { base, post })).toBe(true);
    expect(post).toHaveBeenCalledWith("/api/auth/oidc/native/redeem", { code: "c".repeat(43), verifier: p.verifier });
    expect(localStorage.getItem("noorNativeLogin")).toBeNull();
    expect(await finishNativeOidc(link(p.state), { base, post })).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("ignores unsolicited, wrong state, wrong server and unrelated deep links", async () => {
    expect(await finishNativeOidc(link("anything"), { base, post })).toBe(false);
    await startNativeOidc(base);
    const p = pending();
    for (const url of [link("wrong"), link(p.state).replace("app.noortasks:", "https:"), link(p.state).replace("//auth", "//evil"), link(p.state).replace("//auth?", "//auth/other?")]) {
      expect(await finishNativeOidc(url, { base, post })).toBe(false);
    }
    expect(await finishNativeOidc(link(p.state), { base: "https://other.example", post })).toBe(false);
    expect(post).not.toHaveBeenCalled();
    expect(pending().verifier).toBe(p.verifier);
  });

  it("requires HTTPS and an origin without credentials or paths", async () => {
    for (const url of ["http://tasks.example.com", "https://user:password@example.com", `${base}/path`]) {
      await expect(startNativeOidc(url)).rejects.toThrow("https_required");
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("removes pending secrets when opening the browser fails", async () => {
    open.mockRejectedValue(new Error("unavailable"));
    await expect(startNativeOidc(base)).rejects.toThrow("browser_unavailable");
    expect(localStorage.getItem("noorNativeLogin")).toBeNull();
  });

  it("rejects stale handoffs and returns provider errors without redeeming", async () => {
    await startNativeOidc(base);
    const p = pending();
    localStorage.setItem("noorNativeLogin", JSON.stringify({ ...p, createdMs: Date.now() - 600_001 }));
    await expect(finishNativeOidc(link(p.state), { base, post })).rejects.toThrow("state_mismatch");
    await startNativeOidc(base);
    await expect(finishNativeOidc(link(pending().state, "auth_error=not_invited"), { base, post })).rejects.toThrow("not_invited");
    expect(post).not.toHaveBeenCalled();
  });

  it("handles both cold launch and warm events once and removes the listener", async () => {
    await startNativeOidc(base);
    const url = link(pending().state);
    const remove = vi.fn();
    let callback: (data: { url: string }) => void = () => {};
    const addListener = vi.fn((_event, cb) => { callback = cb; return Promise.resolve({ remove }); });
    (globalThis as any).Capacitor.Plugins.App = { addListener, getLaunchUrl: vi.fn().mockResolvedValue({ url }) };
    const done = vi.fn();
    const failed = vi.fn();
    const stop = watchNativeOidc({ base, post }, done, failed);
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(addListener).toHaveBeenCalledWith("appUrlOpen", expect.any(Function));
    callback({ url });
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    stop();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
