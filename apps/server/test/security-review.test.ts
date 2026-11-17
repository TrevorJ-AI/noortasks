import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { Throttle, hashPassphrase } from "../src/auth.js";
import { CalDavCalendarAdapter, OutlookCalendarAdapter, type AdapterContext } from "../src/calendar-adapters.js";
import { assertIcsBudget } from "../src/calendar-ics.js";
import { parseXml } from "../src/calendar-xml.js";
import { JSON_LIMIT, UPLOAD_LIMIT, requestLogPath } from "../src/http-security.js";
import { OidcClient } from "../src/oidc.js";
import { buildServer } from "../src/server.js";
import { hex, mk, task, tmp } from "./helpers.js";
import { mkMulti } from "./multi-helpers.js";

const password = "security-regression-password";
let m: Awaited<ReturnType<typeof mkMulti>>;
beforeAll(async () => { m = await mkMulti({ config: { passphraseHash: await hashPassphrase(password) }, opts: { secureCookies: true, trustProxy: true } }); });
afterAll(async () => { await m.app.close(); });
const multipart = (bytes: number) => Buffer.concat([Buffer.from('--security\r\nContent-Disposition: form-data; name="file"; filename="test.svg"\r\nContent-Type: image/svg+xml\r\n\r\n'), Buffer.alloc(bytes, 65), Buffer.from('\r\n--security--\r\n')]);

describe("public launch security regressions", () => {
  test("first-run ownership requires the operator token for password and OIDC setup", async () => {
    const dir = tmp();
    const token = "operator-setup-token-00000000000000000";
    const srv = await buildServer({ dbPath: join(dir, "db"), dataDir: join(dir, "files"), setupToken: token, config: { passwordLogin: true, oidc: { issuer: "https://accounts.google.com", clientId: "fixture", clientSecret: "fixture", redirectUri: "https://tasks.example.com/api/auth/oidc/callback" } } });
    try {
      const payload = { serverName: "Private", email: "owner@example.com", password };
      for (const setupToken of [undefined, "wrong"]) {
        expect((await srv.app.inject({ method: "POST", url: "/api/setup", payload: { ...payload, setupToken } })).statusCode).toBe(403);
      }
      expect((await srv.app.inject({ url: "/api/setup/oidc/start" })).json().errorCode).toBe("setup_token_required");
      expect(srv.sys!.users()).toHaveLength(0);
      expect((await srv.app.inject({ method: "POST", url: "/api/setup", payload: { ...payload, setupToken: token } })).statusCode).toBe(200);
      expect((await srv.app.inject({ method: "POST", url: "/api/setup", payload: { ...payload, setupToken: token } })).json().errorCode).toBe("setup_locked");
    } finally { await srv.app.close(); }
  });

  test("sign-in blocks hostile browser origins, rotates sessions, and logout invalidates the session", async () => {
    const login = (headers = {}) => m.app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { username: m.admin.email, password }, headers });
    expect((await login({ origin: "https://attacker.example" })).statusCode).toBe(403);
    expect((await login({ "sec-fetch-site": "cross-site" })).statusCode).toBe(403);
    const old = m.sys!.createSession(m.admin.id);
    const r = await login({ cookie: `t=${old}`, host: "tasks.example.com", origin: "https://tasks.example.com", "x-forwarded-proto": "https" });
    expect(r.statusCode).toBe(200);
    expect(m.sys!.sessionUser(old)).toBeUndefined();
    const session = r.cookies.find((c) => c.name === "t")!;
    const csrf = r.cookies.find((c) => c.name === "_csrf_token")!;
    expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax" });
    const cookie = `t=${session.value}; _csrf_token=${csrf.value}`;
    expect((await m.app.inject({ method: "POST", url: "/api/v2/user/signout", headers: { cookie, "x-csrftoken": csrf.value } })).statusCode).toBe(200);
    expect(m.sys!.sessionUser(session.value)).toBeUndefined();
  });

  test("CSRF covers forwarded account writes, multipart and the legacy GET mark-read side effect", async () => {
    const t = m.sys!.createSession(m.admin.id);
    const headers = { cookie: `t=${t}; _csrf_token=fixture` };
    for (const [method, url] of [["POST", "/api/v2/batch/task"], ["PUT", "/api/auth/me"], ["POST", "/api/auth/pairing-token"], ["POST", "/api/v1/attachment/upload/countdown"], ["GET", "/api/v2/notification?autoMarkRead=true"], ["GET", "/api/v2/notification/?autoMarkRead=%74rue"]] as const) {
      expect((await m.app.inject({ method, url, headers })).statusCode, url).toBe(403);
    }
    const r = await m.app.inject({ method: "PUT", url: "/api/v2/user/preferences/settings", payload: { theme: "dark" }, headers: { ...headers, host: "tasks.example.com", origin: "https://tasks.example.com", "x-forwarded-proto": "https", "x-csrftoken": "fixture" } });
    expect(r.statusCode).toBe(200); // the inner app must not reinterpret the trusted HTTPS request as HTTP
    m.sys!.destroySession(t);
  });

  test("reserves password attempts synchronously, even when verification has not finished", async () => {
    const limiter = new Throttle();
    expect(Array.from({ length: 20 }, () => limiter.take("one-client", 100))).toEqual([...Array(5).fill(true), ...Array(15).fill(false)]);
    expect(limiter.take("one-client", 60_101)).toBe(true);
    const requests = await Promise.all(Array.from({ length: 12 }, () => m.app.inject({ method: "POST", url: "/api/v2/user/signon", remoteAddress: "203.0.113.9", payload: { username: m.admin.email, password: "wrong-password" } })));
    expect(requests.filter((r) => r.statusCode === 429).length).toBeGreaterThanOrEqual(7);
    expect((await m.app.inject({ method: "POST", url: "/api/v2/user/signon", remoteAddress: "203.0.113.10", payload: { password: "x".repeat(1025) } })).statusCode).toBe(400);
  });

  test("disabling a member revokes unredeemed pairing and native codes too", async () => {
    const u = m.addUser("revoked@example.com");
    const pair = m.sys!.createPairingToken(u.id);
    const native = m.sys!.createNativeLoginCode(u.id, "fixture-challenge");
    await m.admin.call("POST", `/api/admin/members/${u.id}/disable`);
    await m.admin.call("POST", `/api/admin/members/${u.id}/enable`);
    expect(m.sys!.takePairingToken(pair.token)).toBeUndefined();
    expect(m.sys!.takeNativeLoginCode(native, "fixture-challenge")).toBeUndefined();
  });

  test("a shared-list commenter cannot delete a private comment attachment by referencing its id", async () => {
    const b = m.addUser("commenter@example.com");
    const pid = hex(); const sharedTask = hex(); const privateTask = hex();
    const owner = m.tenants!.get(m.admin.id);
    expect(statSync(m.sys!.user(m.admin.id)!.dbFile).mode & 0o777).toBe(0o600);
    await m.admin.call("POST", "/api/v2/batch/project", { add: [{ id: pid, name: "Shared" }] });
    await m.admin.call("POST", "/api/v2/batch/task", { add: [task({ id: sharedTask, projectId: pid }), task({ id: privateTask, projectId: owner.svc.inboxId })] });
    await m.admin.call("POST", `/api/v2/project/${pid}/share`, { userId: b.id, permission: "comment" });
    const secretFile = join(m.dir, "private-attachment");
    writeFileSync(secretFile, "private bytes");
    owner.svc.upsertAttachmentRow(owner.store.getTask(privateTask)!, { id: "private-file", fileName: "private.txt", size: 13 }, { file: secretFile, state: "stored", taskSet: "comment" });
    const comment = await b.call("POST", `/api/v2/project/${pid}/task/${sharedTask}/comment`, { text: "malicious reference", attachments: [{ id: "private-file" }] });
    expect(comment.status).toBe(200);
    expect((await b.call("DELETE", `/api/v2/project/${pid}/task/${sharedTask}/comment/${comment.json.id}`)).status).toBe(200);
    expect(existsSync(secretFile)).toBe(true);
    expect(owner.store.get("select 1 from attachments where id = ?", "private-file")).toBeTruthy();
  });

  test("account requests bound payload size, batches, nesting, and prototype keys", async () => {
    const b = mk();
    try {
      expect((await b.call("POST", "/api/v2/batch/task", { add: Array.from({ length: 1001 }, () => ({})) })).status).toBe(400);
      expect((await b.call("PUT", "/api/v2/user/preferences/ext", { big: "x".repeat(JSON_LIMIT) })).status).toBe(413);
      const nested: any = {}; let node = nested;
      for (let i = 0; i < 40; i++) node = node.next = {};
      expect((await b.call("PUT", "/api/v2/user/preferences/ext", nested)).status).toBe(400);
      expect((await b.app.inject({ method: "POST", url: "/api/v2/batch/order", headers: { "content-type": "application/json" }, payload: '{"orderByType":{"__proto__":{"polluted":{"changed":[{"id":"x"}]}}}}' })).statusCode).toBe(400);
      expect(({} as any).polluted).toBeUndefined();
      expect((await b.app.inject({ method: "POST", url: "/api/v1/import/restore", headers: { "content-type": "multipart/form-data; boundary=security" }, payload: multipart(JSON_LIMIT + 1) })).statusCode).toBe(413);
    } finally { await b.app.close(); b.store.close(); }
  });

  test("attachment streaming rejects oversized files and cleans temporary bytes", async () => {
    const b = mk();
    try {
      async function* upload() {
        yield multipart(0).subarray(0, -16);
        for (let i = 0; i <= UPLOAD_LIMIT / (1024 * 1024); i++) yield Buffer.alloc(1024 * 1024);
        yield Buffer.from("\r\n--security--\r\n");
      }
      const r = await b.app.inject({ method: "POST", url: "/api/v1/attachment/upload/countdown?attachmentId=oversized", headers: { "content-type": "multipart/form-data; boundary=security" }, payload: Readable.from(upload()) });
      expect(r.statusCode).toBe(413);
      expect(b.store.get("select 1 from attachments where id = 'oversized'")).toBeUndefined();
      expect(existsSync(join(b.svc.opts.dataDir!, "attachments", "ov", "oversized"))).toBe(false);
    } finally { await b.app.close(); b.store.close(); }
  });

  test("attachment quota uses server byte counts and stored SVGs are sandboxed downloads", async () => {
    const b = mk();
    try {
      const r = await b.app.inject({ method: "POST", url: "/api/v1/attachment/upload/countdown?attachmentId=svg", headers: { "content-type": "multipart/form-data; boundary=security" }, payload: multipart(20) });
      expect(r.statusCode).toBe(200);
      const dl = await b.app.inject({ url: "/api/v1/attachment/svg" });
      expect(dl.headers["content-type"]).toBe("application/octet-stream");
      expect(dl.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(dl.headers["x-content-type-options"]).toBe("nosniff");
      expect(dl.headers["content-security-policy"]).toContain("sandbox");
      const inbox = b.svc.inboxId;
      b.svc.upsertAttachmentRow({ id: "", projectId: inbox } as any, { id: "svg", size: -1 });
      expect(b.store.get<{ size: number }>("select size from attachments where id = 'svg'")!.size).toBe(20);
      b.store.run("update attachments set size = ? where id = 'svg'", 1024 * 1024 * 1024);
      expect((await b.app.inject({ method: "POST", url: "/api/v1/attachment/upload/countdown", headers: { "content-type": "multipart/form-data; boundary=security" }, payload: multipart(1) })).statusCode).toBe(413);
    } finally { await b.app.close(); b.store.close(); }
  });

  test("CalDAV discovery cannot forward credentials across origins", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(new Response('<D:multistatus xmlns:D="DAV:"><D:calendar-home-set><D:href>https://attacker.example/private</D:href></D:calendar-home-set></D:multistatus>'));
    const ctx: AdapterContext = { accountId: "fixture", provider: "caldav", serverUrl: "https://calendar.example/", username: "user", password: "secret-fixture", userTz: "UTC", fetchImpl: remote };
    await expect(new CalDavCalendarAdapter().listCalendars(ctx)).rejects.toThrow("CalDAV origin mismatch");
    expect(remote).toHaveBeenCalledTimes(1);
  });

  test("Outlook next links cannot leak bearer tokens or paginate forever", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ value: [], "@odata.nextLink": "https://attacker.example/" })));
    const ctx: AdapterContext = { accountId: "fixture", provider: "outlook", accessToken: "secret-fixture", userTz: "UTC", fetchImpl: remote };
    await expect(new OutlookCalendarAdapter().listCalendars(ctx)).rejects.toThrow("Calendar pagination blocked");
    expect(remote).toHaveBeenCalledTimes(1);
  });

  test("OAuth rejects callback overrides and external return URLs", async () => {
    const b = mk({ calendarOAuth: { google: { clientId: "fixture", clientSecret: "fixture", redirectUri: "https://tasks.example/callback", authUrl: "https://accounts.google.com/auth", tokenUrl: "https://accounts.google.com/token", apiBaseUrl: "https://www.googleapis.com/calendar/v3", scopes: ["calendar"] } } });
    try {
      expect((await b.call("GET", "/api/v2/calendar/oauth/google/start?redirectUri=https://attacker.example/callback")).status).toBe(400);
      for (const target of ["https://attacker.example/", "//attacker.example/", "/\\attacker.example/"]) {
        expect((await b.call("GET", `/api/v2/calendar/oauth/google/start?redirectAfter=${encodeURIComponent(target)}`)).status).toBe(400);
      }
      const started = b.calendar.startOAuth("google");
      await expect(b.calendar.completeOAuthCallback("google", { state: started.state, code: "fixture", redirectUri: "https://attacker.example/" })).rejects.toThrow("invalid_redirect_uri");
    } finally { await b.app.close(); b.store.close(); }
  });

  test("SSRF guards apply to default ICS, CalDAV, OIDC and push entry points; errors hide upstream details", async () => {
    const b = mk();
    try {
      const sub = b.calendar.subscribe({ url: "http://127.0.0.1:9/private?token=SECRET_FIXTURE" });
      const r = await b.call("GET", `/api/v2/calendar/subscribe/events/${sub.id}`);
      expect(r.status).toBe(502);
      expect(JSON.stringify(r.json)).not.toContain("SECRET_FIXTURE");
      expect(JSON.stringify(r.json)).not.toContain("127.0.0.1");
      expect((await b.call("POST", "/api/v4/calendar/bind", { serverUrl: "http://127.0.0.1:9/", username: "user", password })).status).toBe(502);
      await expect(new OidcClient({ issuer: "https://127.0.0.1:9/", clientId: "fixture", clientSecret: "fixture", redirectUri: "https://tasks.example.com/callback" }).start()).rejects.toThrow();
      expect((await b.call("POST", "/api/v2/push/register", { subscription: { endpoint: "https://100.100.100.100/private", keys: { p256dh: "fixture", auth: "fixture" } } })).json.errorCode).toBe("invalid_push_endpoint");
    } finally { await b.app.close(); b.store.close(); }
  });


  test("invite consumption and account capacity are rechecked after password hashing", async () => {
    const small = await mkMulti({ config: { maxUsers: 2 } });
    try {
      const a = await small.admin.call("POST", "/api/admin/allowlist", { email: "race-a@example.com" });
      const b = await small.admin.call("POST", "/api/admin/allowlist", { email: "race-b@example.com" });
      const joined = await Promise.all([
        small.anon("POST", "/api/auth/password/join", { email: "race-a@example.com", code: a.json.inviteCode, password }),
        small.anon("POST", "/api/auth/password/join", { email: "race-b@example.com", code: b.json.inviteCode, password }),
      ]);
      expect(joined.map((r) => r.status).sort()).toEqual([200, 403]);
      expect(small.sys!.activeCount()).toBe(2);
      const loser = joined[0]!.status === 403 ? ["race-a@example.com", a.json.inviteCode] : ["race-b@example.com", b.json.inviteCode];
      expect(small.sys!.validInvite(loser[0]!, loser[1]!)).toBe(true);
    } finally { await small.app.close(); }
  });

  test("calendar work, XML nesting and task hierarchies have finite bounds", async () => {
    const b = mk();
    try {
      expect(() => b.calendar.resolveWindow(0, 367 * 86400_000)).toThrow("invalid_date_range");
      expect(() => b.reminders.computeInstances(0, 367 * 86400_000)).toThrow("invalid_date_range");
      expect(() => assertIcsBudget("BEGIN:VCALENDAR\nRRULE:FREQ=SECONDLY\nEND:VCALENDAR")).toThrow("calendar_too_complex");
      expect(b.svc.batchTask({ add: [task({ id: "old-date", projectId: b.svc.inboxId, createdTime: "0100-01-01T00:00:00.000+0000" })] }).id2etag["old-date"]).toBeTruthy();
      expect((await b.call("GET", "/api/v2/statistics/general")).status).toBe(200);
      expect((await b.call("POST", "/api/v2/batch/pomodoro", { add: [{ id: "huge-focus", startTime: 0, endTime: 100 * 86400_000 }] })).json.id2error["huge-focus"]).toBeTruthy();
      expect((await b.call("POST", "/api/v2/habits/batch", { add: [{ id: "old-habit", name: "old", targetStartDate: 1000101 }] })).status).toBe(400);
      expect(requestLogPath("/feed/secret.ics?extra=secret")).toBe("/feed/[redacted]");
      expect(requestLogPath("/api/auth/oidc/callback?code=secret")).toBe("/api/auth/oidc/callback");
      expect(() => parseXml("<a>".repeat(70) + "</a>".repeat(70))).toThrow("calendar_xml_too_deep");
      const id = hex();
      b.svc.batchTask({ add: [task({ id, parentId: id, projectId: b.svc.inboxId })] });
      expect(b.store.getTask(id)!.parentId).toBeUndefined();
      expect(b.svc.deleteForever([id]).id2error).toEqual({});
    } finally { await b.app.close(); b.store.close(); }
  });
});
