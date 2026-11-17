import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkMulti } from "./multi-helpers.js";
import { startMockOidc, type MockOidc } from "./mock-oidc.js";

let mock: MockOidc;
let m: Awaited<ReturnType<typeof mkMulti>>;
const REDIRECT = "http://127.0.0.1:4999/api/auth/oidc/callback";
const verifier = "a".repeat(64);
const appState = "b".repeat(64);
const challenge = createHash("sha256").update(verifier).digest("base64url");
beforeAll(async () => { mock = await startMockOidc(); });
beforeEach(async () => {
  if (m) await m.app.close();
  m = await mkMulti({ config: { passwordLogin: undefined, oidc: {
    issuer: mock.issuer, clientId: mock.clientId, clientSecret: mock.clientSecret,
    redirectUri: REDIRECT, allowInsecure: true,
  } } });
});
afterAll(async () => { await m?.app.close(); await mock.close(); });

async function login(email = "admin@example.com", overrides: Record<string, unknown> = {}, opts: { dropCookie?: boolean; error?: string; state?: string; nonce?: string; badPkce?: boolean } = {}) {
  const start = await m.app.inject({ method: "GET", url: `/api/auth/oidc/start?native_challenge=${challenge}&native_state=${appState}` });
  expect(start.statusCode).toBe(302);
  expect(start.headers["cache-control"]).toBe("no-store");
  const q = new URL(String(start.headers.location)).searchParams;
  const state = q.get("state")!;
  const code = mock.approve({ email, overrides, state, nonce: opts.nonce ?? q.get("nonce")!,
    challenge: opts.badPkce ? "wrong-challenge" : q.get("code_challenge")!, redirectUri: REDIRECT });
  const query = opts.error ? `error=${opts.error}` : `code=${code}`;
  const cb = await m.app.inject({ method: "GET", url: `/api/auth/oidc/callback?${query}&state=${opts.state ?? state}&iss=${encodeURIComponent(mock.issuer)}`,
    headers: opts.dropCookie ? {} : { cookie: `oidc_state=${state}` } });
  const url = new URL(String(cb.headers.location), "https://server.example");
  expect(cb.headers["cache-control"]).toBe("no-store");
  const cookies = (Array.isArray(cb.headers["set-cookie"]) ? cb.headers["set-cookie"] : [cb.headers["set-cookie"]]) as string[];
  expect(cookies.some((c) => c?.startsWith("t="))).toBe(false);
  expect(cookies.some((c) => c?.startsWith("_csrf_token="))).toBe(false);
  return { url, code: url.searchParams.get("code") };
}
const redeem = (code: string | null, secret = verifier) => m.app.inject({ method: "POST", url: "/api/auth/oidc/native/redeem", payload: { code, verifier: secret } });

describe("Android system-browser OIDC handoff", () => {
  test("valid signed ID token hands off only a one-time code; redemption creates native cookies with CSRF intact", async () => {
    const { url, code } = await login();
    expect(url.protocol).toBe("app.noortasks:");
    expect(url.host).toBe("auth");
    expect(url.searchParams.get("state")).toBe(appState);
    expect([...url.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = m.sys!.all<{ hash: string; challenge: string }>("select * from native_login_codes");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).not.toBe(code);
    expect(rows[0]!.challenge).toBe(challenge);
    const r = await redeem(code);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(r.headers["cache-control"]).toBe("no-store");
    const cookies = r.cookies;
    const t = cookies.find((c) => c.name === "t")!;
    const csrf = cookies.find((c) => c.name === "_csrf_token")!;
    expect(t.httpOnly).toBe(true);
    expect(t.sameSite).toBe("Lax");
    const headers = { cookie: `t=${t.value}; _csrf_token=${csrf.value}` };
    const me = await m.app.inject({ method: "GET", url: "/api/auth/me", headers });
    expect(me.json()).toMatchObject({ email: "admin@example.com", role: "admin", signIn: "oidc" });
    expect((await m.app.inject({ method: "PUT", url: "/api/auth/me", headers, payload: { name: "New" } })).statusCode).toBe(403);
    expect((await m.app.inject({ method: "PUT", url: "/api/auth/me", headers: { ...headers, "x-csrftoken": csrf.value }, payload: { name: "New" } })).statusCode).toBe(200);
  });

  test.each([
    ["wrong audience", { aud: "another-client" }],
    ["expired token", { iat: 1, exp: 2 }],
    ["wrong issuer", { iss: "https://wrong.example" }],
    ["invalid signature", { badSignature: true }],
  ])("rejects %s before issuing a handoff", async (_name, overrides) => {
    const { url, code } = await login("admin@example.com", overrides);
    expect(url.searchParams.get("auth_error")).toBe("token_rejected");
    expect(url.searchParams.get("state")).toBe(appState);
    expect(code).toBeNull();
    expect(m.sys!.all("select * from native_login_codes")).toHaveLength(0);
  });

  test("rejects a replayed handoff", async () => {
    const { code } = await login();
    expect((await redeem(code)).statusCode).toBe(200);
    const replay = await redeem(code);
    expect(replay.statusCode).toBe(401);
    expect(replay.cookies).toHaveLength(0);
  });

  test("intercepted code cannot be redeemed without the app secret", async () => {
    const { code } = await login();
    expect((await redeem(code, "c".repeat(64))).statusCode).toBe(401);
    expect((await redeem(code)).statusCode).toBe(200);
  });

  test("handoff expires after sixty seconds", async () => {
    const { code } = await login();
    m.sys!.run("update native_login_codes set expires = ?", Date.now() - 1);
    expect((await redeem(code)).statusCode).toBe(401);
  });

  test("not on allowlist: no account, handoff or session", async () => {
    const { url, code } = await login("stranger@example.com");
    expect(url.searchParams.get("auth_error")).toBe("not_invited");
    expect(code).toBeNull();
    expect(m.sys!.userByEmail("stranger@example.com")).toBeUndefined();
  });

  test("invited member can join through Android", async () => {
    m.sys!.allow("friend@example.com", m.admin.id);
    const { code } = await login("friend@example.com");
    expect((await redeem(code)).statusCode).toBe(200);
    expect(m.sys!.userByEmail("friend@example.com")?.role).toBe("member");
  });

  test("member disabled after the callback cannot redeem", async () => {
    const { code } = await login();
    m.sys!.updateUser(m.admin.id, { status: "disabled" });
    expect((await redeem(code)).statusCode).toBe(403);
  });

  test("a removed member, user cap and unverified email keep the same rules", async () => {
    m.sys!.allow("friend@example.com", m.admin.id);
    const first = await login("friend@example.com");
    expect(first.code).toBeTruthy();
    const user = m.sys!.userByEmail("friend@example.com")!;
    m.sys!.updateUser(user.id, { status: "removed" });
    m.sys!.disallow(user.email);
    expect((await login(user.email)).url.searchParams.get("auth_error")).toBe("not_invited");
    m.sys!.allow("full@example.com", m.admin.id);
    m.sys!.setSetting("maxUsers", 1);
    expect((await login("full@example.com")).url.searchParams.get("auth_error")).toBe("max_users");
    expect((await login("admin@example.com", { email_verified: false })).url.searchParams.get("auth_error")).toBe("email_not_verified");
  });

  test("browser cookie, provider PKCE and nonce are still required", async () => {
    expect((await login("admin@example.com", {}, { dropCookie: true })).url.searchParams.get("auth_error")).toBe("state_mismatch");
    expect((await login("admin@example.com", {}, { nonce: "wrong" })).url.searchParams.get("auth_error")).toBe("token_rejected");
    expect((await login("admin@example.com", {}, { badPkce: true })).url.searchParams.get("auth_error")).toBe("token_rejected");
  });

  test("provider cancellation returns a bound error to the app", async () => {
    const { url } = await login("admin@example.com", {}, { error: "access_denied" });
    expect(url.protocol).toBe("app.noortasks:");
    expect(url.searchParams.get("auth_error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe(appState);
  });

  test("rejects malformed requests and arbitrary redirect destinations", async () => {
    for (const query of ["native_state=x", "native_challenge=x", `native_challenge=${challenge}&native_state=https://evil.example`]) {
      expect((await m.app.inject({ method: "GET", url: `/api/auth/oidc/start?${query}` })).statusCode).toBe(400);
    }
    expect((await redeem("bad")).statusCode).toBe(400);
    expect((await redeem("z".repeat(43))).statusCode).toBe(401);
  });
});
