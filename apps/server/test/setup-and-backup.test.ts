import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runDailyBackup } from "../src/dailyBackup.js";
import { buildServer } from "../src/server.js";
import { Store } from "../src/store.js";
import { startMockOidc } from "./mock-oidc.js";
import { tmp } from "./helpers.js";

const cookieOf = (setCookie: unknown, name: string): string | undefined => {
  const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const c of list as string[]) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return undefined;
};

describe("first-run setup and phone pairing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("first visit shows setup, creates admin and server name, locks setup and refuses second admin", async () => {
    const dir = tmp();
    const web = join(dir, "dist");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>NoorTasks</title>");

    const dbPath = join(dir, "noortasks.sqlite");
    const dataDir = join(dir, "files");
    const srv = await buildServer({ setupToken: "test-operator-token-0000000000000000", dbPath, dataDir, staticDir: web });

    // First visit on empty data dir advertises setupRequired and serves /setup and /
    const cfg0 = await srv.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(cfg0.statusCode).toBe(200);
    expect(cfg0.json()).toEqual({ mode: "multi", oidc: null, password: true, setupRequired: true });

    const st0 = await srv.app.inject({ method: "GET", url: "/api/setup/status" });
    expect(st0.statusCode).toBe(200);
    expect(st0.json()).toEqual({ setupRequired: true, oidc: null, password: true });

    const setupPage = await srv.app.inject({ method: "GET", url: "/setup" });
    expect(setupPage.statusCode).toBe(200);
    expect(setupPage.body).toContain("<title>NoorTasks</title>");

    const rootPage = await srv.app.inject({ method: "GET", url: "/" });
    expect(rootPage.statusCode).toBe(200);
    expect(rootPage.body).toContain("<title>NoorTasks</title>");

    // Protected endpoints remain closed before setup
    expect((await srv.app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: "GET", url: "/api/v3/batch/check/0" })).statusCode).toBe(401);

    // Reject invalid inputs before locking setup
    expect((await srv.app.inject({ method: "POST", url: "/api/setup", payload: { setupToken: "test-operator-token-0000000000000000", serverName: "", email: "admin@example.com", password: "password1" } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: "POST", url: "/api/setup", payload: { setupToken: "test-operator-token-0000000000000000", serverName: "Home", email: "bad", password: "password1" } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: "POST", url: "/api/setup", payload: { setupToken: "test-operator-token-0000000000000000", serverName: "Home", email: "admin@example.com", password: "short" } })).statusCode).toBe(400);
    expect(srv.sys!.users()).toHaveLength(0);

    // Complete setup
    const setupRes = await srv.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { setupToken: "test-operator-token-0000000000000000", serverName: "Family Tasks", email: "Admin@Example.com", name: "Alice", password: "correct horse battery" },
    });
    expect(setupRes.statusCode).toBe(200);
    expect(setupRes.headers["cache-control"]).toBe("no-store");
    const body = setupRes.json();
    expect(body.ok).toBe(true);
    expect(body.serverName).toBe("Family Tasks");
    expect(body.user).toMatchObject({ email: "admin@example.com", name: "Alice", role: "admin" });
    expect(typeof body.pairingToken).toBe("string");
    expect(body.pairingToken.length).toBeGreaterThanOrEqual(32);

    const tCookie = cookieOf(setupRes.headers["set-cookie"], "t");
    const csrfCookie = cookieOf(setupRes.headers["set-cookie"], "_csrf_token");
    expect(tCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();

    // Admin is signed in immediately
    const meRes = await srv.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `t=${tCookie}` } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json()).toMatchObject({ email: "admin@example.com", role: "admin", serverName: "Family Tasks" });

    // Setup is now locked and unreachable
    const secondAdmin = await srv.app.inject({
      method: "POST",
      url: "/api/setup",
      payload: { setupToken: "test-operator-token-0000000000000000", serverName: "Hijack", email: "attacker@example.com", password: "attacker-password" },
    });
    expect(secondAdmin.statusCode).toBe(403);
    expect(secondAdmin.json().errorCode).toBe("setup_locked");
    expect(srv.sys!.users()).toHaveLength(1);

    expect((await srv.app.inject({ method: "GET", url: "/setup" })).statusCode).toBe(404);
    expect((await srv.app.inject({ method: "GET", url: "/setup/step2" })).statusCode).toBe(404);
    expect((await srv.app.inject({ method: "GET", url: "/api/setup/status" })).statusCode).toBe(404);

    const cfg1 = await srv.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(cfg1.json()).toEqual({ mode: "multi", oidc: null, password: true, serverName: "Family Tasks" });

    await srv.app.close();

    // Restarting on the same data directory keeps setup locked and sign-in working
    const restarted = await buildServer({ setupToken: "test-operator-token-0000000000000000", dbPath, dataDir, staticDir: web });
    expect((await restarted.app.inject({ method: "GET", url: "/setup" })).statusCode).toBe(404);
    expect((await restarted.app.inject({ method: "POST", url: "/api/setup", payload: { setupToken: "test-operator-token-0000000000000000", serverName: "X", email: "x@example.com", password: "password1" } })).statusCode).toBe(403);
    expect((await restarted.app.inject({ method: "GET", url: "/api/auth/config" })).json()).toEqual({
      mode: "multi",
      oidc: null,
      password: true,
      serverName: "Family Tasks",
    });
    const loginRes = await restarted.app.inject({
      method: "POST",
      url: "/api/v2/user/signon",
      payload: { username: "admin@example.com", password: "correct horse battery" },
    });
    expect(loginRes.statusCode).toBe(200);
    await restarted.app.close();
  });

  test("OIDC setup claims the admin once, preserves normal setup_required refusal, then locks setup", async () => {
    const mock = await startMockOidc();
    const dir = tmp();
    const web = join(dir, "dist");
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>NoorTasks</title>");
    const redirectUri = "http://127.0.0.1:4998/api/auth/oidc/callback";

    const srv = await buildServer({ setupToken: "test-operator-token-0000000000000000",
      dbPath: join(dir, "noortasks.sqlite"),
      dataDir: join(dir, "files"),
      staticDir: web,
      config: {
        admins: [],
        passwordLogin: false,
        oidc: { issuer: mock.issuer, clientId: mock.clientId, clientSecret: mock.clientSecret, redirectUri, label: "Google", allowInsecure: true },
      },
    });

    try {
      expect((await srv.app.inject({ method: "GET", url: "/api/auth/config" })).json()).toEqual({
        mode: "multi",
        oidc: { label: "Google" },
        password: false,
        setupRequired: true,
      });

      // Password setup is refused when passwordLogin is off
      expect((await srv.app.inject({ method: "POST", url: "/api/setup", payload: { setupToken: "test-operator-token-0000000000000000", serverName: "S", email: "a@example.com", password: "password1" } })).statusCode).toBe(403);

      // Start OIDC setup flow
      const start = await srv.app.inject({ method: "GET", url: "/api/setup/oidc/start?setupToken=test-operator-token-0000000000000000&serverName=Studio%20Tasks" });
      expect(start.statusCode).toBe(302);
      const authUrl = new URL(String(start.headers.location));
      const state = authUrl.searchParams.get("state")!;
      const nonce = authUrl.searchParams.get("nonce")!;
      const challenge = authUrl.searchParams.get("code_challenge")!;
      const stateCookie = cookieOf(start.headers["set-cookie"], "oidc_state");
      expect(stateCookie).toBe(state);

      const code = mock.approve({ state, nonce, challenge, redirectUri, email: "Owner@Example.com", name: "Owner" });
      const cb = await srv.app.inject({
        method: "GET",
        url: `/api/auth/oidc/callback?code=${code}&state=${state}&iss=${encodeURIComponent(mock.issuer)}`,
        headers: { cookie: `oidc_state=${stateCookie}` },
      });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe("/?setup_paired=1");
      const t = cookieOf(cb.headers["set-cookie"], "t")!;
      const csrf = cookieOf(cb.headers["set-cookie"], "_csrf_token")!;
      expect(t).toBeTruthy();

      const me = await srv.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `t=${t}` } });
      expect(me.json()).toMatchObject({ email: "owner@example.com", role: "admin", signIn: "oidc", serverName: "Studio Tasks" });

      // Setup is locked after OIDC completion
      expect((await srv.app.inject({ method: "GET", url: "/setup" })).statusCode).toBe(404);
      expect((await srv.app.inject({ method: "GET", url: "/api/setup/oidc/start?serverName=Hack" })).statusCode).toBe(403);

      // Authenticated admin can generate a pairing token (requires CSRF)
      expect((await srv.app.inject({ method: "POST", url: "/api/auth/pairing-token", headers: { cookie: `t=${t}; _csrf_token=${csrf}` } })).statusCode).toBe(403);
      const pt = await srv.app.inject({
        method: "POST",
        url: "/api/auth/pairing-token",
        headers: { cookie: `t=${t}; _csrf_token=${csrf}`, "x-csrftoken": csrf },
      });
      expect(pt.statusCode).toBe(200);
      expect(pt.json().serverName).toBe("Studio Tasks");
      expect(pt.json().token).toBeTruthy();
    } finally {
      await srv.app.close();
      await mock.close();
    }
  });

  test("pairing tokens are hashed at rest, single-use, expire in 10 minutes, and throttle failures", async () => {
    const dir = tmp();
    let nowMs = Date.UTC(2026, 10, 16, 12, 0, 0);
    const srv = await buildServer({ setupToken: "test-operator-token-0000000000000000",
      dbPath: join(dir, "noortasks.sqlite"),
      dataDir: join(dir, "files"),
      common: { now: () => nowMs },
    });

    try {
      const setup = await srv.app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { setupToken: "test-operator-token-0000000000000000", serverName: "My Server", email: "admin@example.com", password: "password123" },
      });
      const adminT = cookieOf(setup.headers["set-cookie"], "t")!;
      const adminCsrf = cookieOf(setup.headers["set-cookie"], "_csrf_token")!;
      const token1 = setup.json().pairingToken as string;
      expect(setup.json().pairingExpiresMs).toBe(nowMs + 10 * 60_000);

      // Raw pairing token must not be stored in plaintext in SQLite
      const storedRows = srv.sys!.all<{ hash: string }>("select hash from pairing_tokens");
      expect(storedRows).toHaveLength(1);
      expect(storedRows[0]!.hash).not.toBe(token1);

      // Valid just before 10-minute mark
      nowMs += 9 * 60_000 + 59_000;
      const pairOk = await srv.app.inject({ method: "POST", url: "/api/auth/pair", payload: { token: token1 } });
      expect(pairOk.statusCode).toBe(200);
      expect(pairOk.headers["cache-control"]).toBe("no-store");
      const pairedT = cookieOf(pairOk.headers["set-cookie"], "t")!;
      expect(pairedT).toBeTruthy();
      expect((await srv.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `t=${pairedT}` } })).json()).toMatchObject({
        email: "admin@example.com",
        role: "admin",
      });

      // Single-use: second redemption of the same token fails
      const replay = await srv.app.inject({ method: "POST", url: "/api/auth/pair", payload: { token: token1 } });
      expect(replay.statusCode).toBe(403);
      expect(replay.cookies).toHaveLength(0);

      // Expired token at 10 minutes is refused
      const gen = await srv.app.inject({
        method: "POST",
        url: "/api/auth/pairing-token",
        headers: { cookie: `t=${adminT}; _csrf_token=${adminCsrf}`, "x-csrftoken": adminCsrf },
      });
      const token2 = gen.json().token as string;
      nowMs += 10 * 60_000;
      const expired = await srv.app.inject({ method: "POST", url: "/api/auth/pair", payload: { token: token2 } });
      expect(expired.statusCode).toBe(403);
      expect(expired.cookies).toHaveLength(0);

      // Rate-limiting blocks after 5 failed attempts within 60s
      for (let i = 0; i < 4; i++) {
        expect((await srv.app.inject({ method: "POST", url: "/api/auth/pair", payload: { token: "wrong-" + i } })).statusCode).toBe(403);
      }
      // 1 expired failure + 4 wrong = 5 failures in window; 6th returns 429
      expect((await srv.app.inject({ method: "POST", url: "/api/auth/pair", payload: { token: "wrong-final" } })).statusCode).toBe(429);
    } finally {
      await srv.app.close();
    }
  });
});

describe("daily backup scheduler and rotation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("daily backup is off by default", async () => {
    const dir = tmp();
    const srv = await buildServer({ setupToken: "test-operator-token-0000000000000000", dbPath: join(dir, "noortasks.sqlite"), dataDir: join(dir, "files"), noAuth: true });
    expect(existsSync(join(dir, "backups"))).toBe(false);
    expect(srv.runDailyBackup).toBeUndefined();
    await srv.app.close();
  });

  test("server clock writes daily backups only after setup and rotation keeps 7 snapshots", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const startMs = Date.UTC(2026, 10, 1, 2, 0, 0);
    vi.setSystemTime(startMs);

    const dir = tmp();
    const backupDir = join(dir, "backups");
    const srv = await buildServer({ setupToken: "test-operator-token-0000000000000000",
      dbPath: join(dir, "noortasks.sqlite"),
      dataDir: join(dir, "files"),
      common: { now: () => Date.now() },
      dailyBackup: { enabled: true, backupDir, retention: 7, intervalMs: 24 * 60 * 60 * 1000 },
    });

    try {
      // No backups written before first-run setup finishes
      expect(existsSync(backupDir)).toBe(false);

      const setup = await srv.app.inject({
        method: "POST",
        url: "/api/setup",
        payload: { setupToken: "test-operator-token-0000000000000000", serverName: "Backup Box", email: "admin@example.com", password: "password123" },
      });
      const t = cookieOf(setup.headers["set-cookie"], "t")!;
      const csrf = cookieOf(setup.headers["set-cookie"], "_csrf_token")!;
      const check = await srv.app.inject({ method: "GET", url: "/api/v3/batch/check/0", headers: { cookie: `t=${t}` } });
      const inboxId = check.json().inboxId as string;

      await srv.app.inject({
        method: "POST",
        url: "/api/v2/batch/task",
        headers: { cookie: `t=${t}; _csrf_token=${csrf}`, "x-csrftoken": csrf },
        payload: { add: [{ id: "111122223333444455556666", projectId: inboxId, title: "Daily backup canary", status: 0, priority: 0, sortOrder: 0, kind: "TEXT" }] },
      });

      // Advance the server's clock across 10 consecutive days
      for (let day = 0; day < 10; day++) {
        if (day > 0) vi.advanceTimersByTime(24 * 60 * 60 * 1000);
        else srv.runDailyBackup!();
      }

      const kept = readdirSync(backupDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
      expect(kept).toEqual([
        "2026-11-04",
        "2026-11-05",
        "2026-11-06",
        "2026-11-07",
        "2026-11-08",
        "2026-11-09",
        "2026-11-10",
      ]);

      const latestDir = join(backupDir, "2026-11-10");
      expect(existsSync(join(latestDir, "noortasks-system.sqlite"))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(latestDir, "manifest.json"), "utf8"));
      expect(manifest.serverName).toBe("Backup Box");
      expect(manifest.users).toHaveLength(1);

      const uid = manifest.users[0].userId;
      const csv = readFileSync(join(latestDir, "users", String(uid), "tasks.csv"), "utf8");
      expect(csv).toContain("Daily backup canary");

      const snapStore = new Store(join(latestDir, "users", String(uid), "noortasks.sqlite"));
      expect(snapStore.getTask("111122223333444455556666")?.title).toBe("Daily backup canary");
      snapStore.close();
    } finally {
      await srv.app.close();
    }
  });

  test("runDailyBackup in single-user mode snapshots sqlite + csv and keeps 7", async () => {
    const dir = tmp();
    const backupDir = join(dir, "backups");
    const srv = await buildServer({ setupToken: "test-operator-token-0000000000000000", dbPath: join(dir, "noortasks.sqlite"), dataDir: join(dir, "files"), noAuth: true });
    try {
      const inbox = srv.single!.svc.inboxId;
      await srv.single!.app.inject({
        method: "POST",
        url: "/api/v2/batch/task",
        payload: { add: [{ id: "aaaa22223333444455556666", projectId: inbox, title: "Single backup task", status: 0, priority: 0, sortOrder: 0, kind: "TEXT" }] },
      });

      const base = Date.UTC(2026, 9, 1, 3, 0, 0);
      for (let i = 0; i < 9; i++) {
        runDailyBackup({ backupDir, single: srv.single!, now: base + i * 24 * 60 * 60 * 1000 });
      }
      const kept = readdirSync(backupDir).sort();
      expect(kept).toHaveLength(7);
      expect(kept[0]).toBe("2026-10-03");
      expect(kept[6]).toBe("2026-10-09");
      const csv = readFileSync(join(backupDir, "2026-10-09", "tasks.csv"), "utf8");
      expect(csv).toContain("Single backup task");
    } finally {
      await srv.app.close();
    }
  });
});
