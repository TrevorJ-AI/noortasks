import { describe, expect, test } from "vitest";
import { hashPassphrase, safeEqual, Throttle, verifyPassphrase } from "../src/auth.js";
import { mk, task } from "./helpers.js";

const PASS = "correct horse battery";
async function authed() {
  const m = mk({ noAuth: false, auth: { passphraseHash: await hashPassphrase(PASS) } });
  return m;
}
const cookies = (r: { cookies: Array<{ name: string; value: string }> }) => Object.fromEntries(r.cookies.map((c) => [c.name, c.value]));

describe("passphrase hashing", () => {
  test("verify accepts the right one and rejects others", async () => {
    const h = await hashPassphrase("abc12345");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassphrase("abc12345", h)).toBe(true);
    expect(await verifyPassphrase("abc12346", h)).toBe(false);
    expect(await verifyPassphrase("", h)).toBe(false);
  });
  test("two hashes of one passphrase differ (salted)", async () => {
    expect(await hashPassphrase("same")).not.toBe(await hashPassphrase("same"));
  });
  test.each(["", "nope", "scrypt$1$2", "scrypt$x$y$z$a$b"])("garbage stored hash %j never verifies", async (h) => {
    expect(await verifyPassphrase("x", h)).toBe(false);
  });
  test("safeEqual", () => {
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });
  test("throttle blocks after five failures, clear resets", () => {
    const t = new Throttle();
    for (let i = 0; i < 5; i++) t.fail("k", 1000);
    expect(t.blocked("k", 1500)).toBe(true);
    expect(t.blocked("k", 70_000)).toBe(false);
    t.fail("k", 1000);
    t.clear("k");
    expect(t.blocked("k", 1500)).toBe(false);
  });
});

describe("sessions and csrf", () => {
  test("no cookie is 401", async () => {
    const m = await authed();
    expect((await m.app.inject({ method: "GET", url: "/api/v3/batch/check/0" })).statusCode).toBe(401);
    expect((await m.app.inject({ method: "POST", url: "/api/v2/batch/task", payload: {} })).statusCode).toBe(401);
  });
  test("wrong passphrase is 401 and sets no cookie", async () => {
    const m = await authed();
    const r = await m.app.inject({ method: "POST", url: "/api/v2/user/signon?wc=true&remember=true", payload: { username: "x", password: "bad" } });
    expect(r.statusCode).toBe(401);
    expect(r.cookies).toHaveLength(0);
  });
  test("sign in sets the session and csrf cookies", async () => {
    const m = await authed();
    const r = await m.app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { username: "me", password: PASS } });
    expect(r.statusCode).toBe(200);
    const c = cookies(r);
    expect(c.t).toMatch(/^[0-9a-f]{64}$/);
    expect(c._csrf_token).toBeTruthy();
    expect(r.json().inboxId).toBe(m.svc.inboxId);
    const t = r.cookies.find((x) => x.name === "t") as { httpOnly?: boolean };
    expect(t.httpOnly).toBe(true);
  });
  const login = async (m: Awaited<ReturnType<typeof authed>>) => {
    const c = cookies(await m.app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { password: PASS } }));
    return c as { t: string; _csrf_token: string };
  };
  test("GET works with the session cookie alone", async () => {
    const m = await authed();
    const c = await login(m);
    expect((await m.app.inject({ method: "GET", url: "/api/v2/user/status", cookies: { t: c.t } })).statusCode).toBe(200);
  });
  test("POST without the csrf header is 403, with a wrong one is 403, with the right one passes", async () => {
    const m = await authed();
    const c = await login(m);
    const post = (headers: Record<string, string>) => m.app.inject({ method: "POST", url: "/api/v2/batch/task", payload: { add: [task({ projectId: m.svc.inboxId })] }, cookies: { t: c.t, _csrf_token: c._csrf_token }, headers });
    expect((await post({})).statusCode).toBe(403);
    expect((await post({ "x-csrftoken": "wrong" })).statusCode).toBe(403);
    expect((await post({ "x-csrftoken": c._csrf_token })).statusCode).toBe(200);
  });
  test("a forged session cookie is refused", async () => {
    const m = await authed();
    expect((await m.app.inject({ method: "GET", url: "/api/v2/user/status", cookies: { t: "0".repeat(64) } })).statusCode).toBe(401);
  });
  test("sign out kills the session", async () => {
    const m = await authed();
    const c = await login(m);
    await m.app.inject({ method: "POST", url: "/api/v2/user/signout", cookies: { t: c.t, _csrf_token: c._csrf_token }, headers: { "x-csrftoken": c._csrf_token } });
    expect((await m.app.inject({ method: "GET", url: "/api/v2/user/status", cookies: { t: c.t } })).statusCode).toBe(401);
  });
  test("public config route needs no session", async () => {
    const m = await authed();
    expect((await m.app.inject({ method: "GET", url: "/pub/api/v1/app/config" })).statusCode).toBe(200);
  });
  test("six wrong tries in a row get 429", async () => {
    const m = await authed();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await m.app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { password: "bad" + i } })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
    expect((await m.app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { password: PASS } })).statusCode).toBe(429);
  });
  test("--no-auth skips both checks", async () => {
    const m = mk();
    expect((await m.call("POST", "/api/v2/batch/task", { add: [] })).status).toBe(200);
  });
  test("sessions survive in the database across app instances", async () => {
    const m = await authed();
    const c = await login(m);
    const again = (await import("../src/app.js")).buildApp({ store: m.store, dataDir: m.svc.opts.dataDir!, auth: { passphraseHash: "x" } });
    expect((await again.app.inject({ method: "GET", url: "/api/v2/user/status", cookies: { t: c.t } })).statusCode).toBe(200);
  });
});
