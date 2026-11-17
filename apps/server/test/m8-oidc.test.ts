import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { task } from "./helpers.js";
import { startMockOidc, type MockOidc } from "./mock-oidc.js";
import { mkMulti } from "./multi-helpers.js";

type M = Awaited<ReturnType<typeof mkMulti>>;
let mock: MockOidc;
let m: M;
const REDIRECT = "http://127.0.0.1:4999/api/auth/oidc/callback";

beforeAll(async () => {
  mock = await startMockOidc();
});
afterAll(async () => {
  await mock.close();
});
beforeEach(async () => {
  if (m) await m.app.close();
  m = await mkMulti({
    config: {
      passwordLogin: undefined,
      admins: ["admin@example.com"],
      oidc: { issuer: mock.issuer, clientId: mock.clientId, clientSecret: mock.clientSecret, redirectUri: REDIRECT, label: "Google", allowInsecure: true },
    },
  });
});

const cookieOf = (setCookie: unknown, name: string): string | undefined => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list as string[]) {
    const m1 = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m1) return m1[1];
  }
  return undefined;
};

async function login(email: string, o: { overrides?: Record<string, unknown>; sub?: string; dropStateCookie?: boolean; nonce?: string } = {}) {
  const start = await m.app.inject({ method: "GET", url: "/api/auth/oidc/start" });
  expect(start.statusCode).toBe(302);
  const url = new URL(String(start.headers.location));
  expect(url.origin).toBe(mock.issuer);
  const q = url.searchParams;
  expect(q.get("code_challenge_method")).toBe("S256");
  expect(q.get("redirect_uri")).toBe(REDIRECT);
  const state = q.get("state")!;
  const stateCookie = cookieOf(start.headers["set-cookie"], "oidc_state");
  expect(stateCookie).toBe(state);
  const code = mock.approve({ state, nonce: o.nonce ?? q.get("nonce")!, challenge: q.get("code_challenge")!, redirectUri: REDIRECT, email, ...(o.sub ? { sub: o.sub } : {}), ...(o.overrides ? { overrides: o.overrides } : {}) });
  const cb = await m.app.inject({
    method: "GET",
    url: `/api/auth/oidc/callback?code=${code}&state=${state}&iss=${encodeURIComponent(mock.issuer)}`,
    headers: o.dropStateCookie ? {} : { cookie: `oidc_state=${state}` },
  });
  const t = cookieOf(cb.headers["set-cookie"], "t");
  const csrf = cookieOf(cb.headers["set-cookie"], "_csrf_token");
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await m.app.inject({ method: method as "GET", url: path, ...(body !== undefined ? { payload: body as object } : {}), headers: { cookie: `t=${t}; _csrf_token=${csrf}`, "x-csrftoken": csrf ?? "" } });
    return { status: r.statusCode, json: r.json() as any };
  };
  return { status: cb.statusCode, location: String(cb.headers.location ?? ""), token: t, call, state };
}

describe("OIDC sign-in (authorization code + PKCE against a local provider)", () => {
  test("the config endpoint advertises the provider and hides password sign-in", async () => {
    const r = await m.anon("GET", "/api/auth/config");
    expect(r.json).toEqual({ mode: "multi", oidc: { label: "Google" }, password: false });
    expect((await m.anon("POST", "/api/v2/user/signon", { username: "admin@example.com", password: "x" })).status).toBe(403);
  });

  test("the configured admin signs in with a valid token and lands in the migrated account", async () => {
    const legacyId = Number(m.sys!.getMeta("legacyAdminId"));
    await m.admin.call("POST", "/api/v2/batch/task", { add: [task({ projectId: (await m.admin.call("GET", "/api/v3/batch/check/0")).json.inboxId, title: "from before" })] });
    const a = await login("Admin@Example.com");
    expect(a.status).toBe(302);
    expect(a.location).toBe("/");
    expect(a.token).toBeTruthy();
    const me = await a.call("GET", "/api/auth/me");
    expect(me.json).toMatchObject({ userId: legacyId, email: "admin@example.com", role: "admin", signIn: "oidc" });
    const check = await a.call("GET", "/api/v3/batch/check/0");
    expect(JSON.stringify(check.json)).toContain("from before");
    // the identity is bound: the same provider subject signs into the same account again
    const again = await login("Admin@Example.com");
    expect((await again.call("GET", "/api/auth/me")).json.userId).toBe(legacyId);
  });

  test("an allowlisted email gets a new, empty member account", async () => {
    await m.admin.call("POST", "/api/admin/allowlist", { email: "friend@example.com" });
    const f = await login("friend@example.com");
    expect(f.location).toBe("/");
    const me = (await f.call("GET", "/api/auth/me")).json;
    expect(me).toMatchObject({ email: "friend@example.com", role: "member" });
    expect(me.userId).not.toBe(Number(m.sys!.getMeta("legacyAdminId")));
    const check = (await f.call("GET", "/api/v3/batch/check/0")).json;
    expect(check.syncTaskBean.update).toEqual([]);
    expect((await f.call("GET", "/api/admin/members")).status).toBe(403);
  });

  test("an email that is not on the allowlist is refused and no account is made", async () => {
    const r = await login("stranger@example.com");
    expect(r.location).toBe("/?auth_error=not_invited");
    expect(r.token).toBeUndefined();
    expect(m.sys!.userByEmail("stranger@example.com")).toBeUndefined();
  });

  test("a token for another audience is rejected", async () => {
    await m.admin.call("POST", "/api/admin/allowlist", { email: "friend@example.com" });
    const r = await login("friend@example.com", { overrides: { aud: "some-other-client" } });
    expect(r.location).toBe("/?auth_error=token_rejected");
    expect(r.token).toBeUndefined();
  });

  test("an expired token is rejected", async () => {
    await m.admin.call("POST", "/api/admin/allowlist", { email: "friend@example.com" });
    const past = Math.floor(Date.now() / 1000) - 3600;
    const r = await login("friend@example.com", { overrides: { iat: past - 600, exp: past } });
    expect(r.location).toBe("/?auth_error=token_rejected");
  });

  test("a token with the wrong nonce is rejected", async () => {
    const r = await login("admin@example.com", { nonce: "not-the-nonce" });
    expect(r.location).toBe("/?auth_error=token_rejected");
  });

  test("an unverified email is refused", async () => {
    await m.admin.call("POST", "/api/admin/allowlist", { email: "friend@example.com" });
    const r = await login("friend@example.com", { overrides: { email_verified: false } });
    expect(r.location).toBe("/?auth_error=email_not_verified");
    const stringClaim = await login("friend@example.com", { overrides: { email_verified: "true" } });
    expect(stringClaim.location).toBe("/?auth_error=email_not_verified");
  });

  test("max users reached: an invited person cannot create an account", async () => {
    await m.admin.call("PUT", "/api/admin/settings", { maxUsers: 2 });
    await m.admin.call("POST", "/api/admin/allowlist", { email: "one@example.com" });
    await m.admin.call("POST", "/api/admin/allowlist", { email: "two@example.com" });
    expect((await login("one@example.com")).location).toBe("/");
    const r = await login("two@example.com");
    expect(r.location).toBe("/?auth_error=max_users");
    expect(m.sys!.userByEmail("two@example.com")).toBeUndefined();
  });

  test("the callback must come back to the browser that started it (state cookie), once", async () => {
    const r = await login("admin@example.com", { dropStateCookie: true });
    expect(r.location).toBe("/?auth_error=state_mismatch");
    const ok = await login("admin@example.com");
    const replay = await m.app.inject({ method: "GET", url: `/api/auth/oidc/callback?code=x&state=${ok.state}`, headers: { cookie: `oidc_state=${ok.state}` } });
    expect(replay.headers.location).toBe("/?auth_error=state_mismatch");
  });

  test("the same email from another provider subject cannot take over an account", async () => {
    await login("admin@example.com", { sub: "real-sub" });
    const r = await login("admin@example.com", { sub: "other-sub" });
    expect(r.location).toBe("/?auth_error=identity_mismatch");
  });

  test("a disabled member cannot sign in; a removed one needs a new invite", async () => {
    await m.admin.call("POST", "/api/admin/allowlist", { email: "friend@example.com" });
    const f = await login("friend@example.com");
    const id = (await f.call("GET", "/api/auth/me")).json.userId;
    await m.admin.call("POST", `/api/admin/members/${id}/disable`);
    expect((await f.call("GET", "/api/auth/me")).status).toBe(401);
    expect((await login("friend@example.com")).location).toBe("/?auth_error=account_disabled");
    await m.admin.call("POST", `/api/admin/members/${id}/remove`, { confirm: "friend@example.com" });
    expect((await login("friend@example.com")).location).toBe("/?auth_error=not_invited");
    await m.admin.call("POST", "/api/admin/allowlist", { email: "friend@example.com" });
    const back = await login("friend@example.com");
    expect((await back.call("GET", "/api/auth/me")).json.userId).toBe(id);
  });

  test("provider errors come back as a sign-in error, not a crash", async () => {
    const r = await m.app.inject({ method: "GET", url: "/api/auth/oidc/callback?error=access_denied&state=x" });
    expect(r.headers.location).toBe("/?auth_error=access_denied");
  });
});

describe("OIDC with no admin configured", () => {
  test("nobody can claim the instance: the first sign-in is refused until admins is set", async () => {
    await m.app.close();
    m = await mkMulti({
      config: { passwordLogin: undefined, admins: [], oidc: { issuer: mock.issuer, clientId: mock.clientId, clientSecret: mock.clientSecret, redirectUri: REDIRECT, allowInsecure: true } },
    }).catch(async () => {
      throw new Error("server should start");
    });
    // mkMulti expects a bootstrap admin; without admins and passphrase there is none
    expect(m.sys!.users()).toEqual([]);
    const r = await login("anyone@example.com");
    expect(r.location).toBe("/?auth_error=setup_required");
  });
});
