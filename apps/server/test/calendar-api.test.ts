import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import ical, { type VEvent } from "node-ical";
import { afterAll, describe, expect, test } from "vitest";
import { CalendarItemKind, CalendarSourceItemType, TaskStatus } from "@noortasks/core";
import { hashPassphrase } from "../src/auth.js";
import { loadCalendarOAuthConfig } from "../src/calendar-adapters.js";
import { HOLIDAY_PRESETS } from "../src/calendar.js";
import { mk as makeApp, seedProject, task, tmp } from "./helpers.js";

const mk = (over: Parameters<typeof makeApp>[0] = {}) => makeApp({ calendarFetch: fetch, ...over });

const cleanDirs: string[] = [];
const servers: Server[] = [];

afterAll(async () => {
  for (const s of servers) {
    await new Promise<void>((res) => s.close(() => res()));
  }
  for (const d of cleanDirs) rmSync(d, { recursive: true, force: true });
});

async function startHttpServer(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<string> {
  const s = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => handler(req, Buffer.concat(chunks).toString("utf8"), res));
  });
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  servers.push(s);
  const addr = s.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

const utc = (y: number, m: number, d: number, h = 0, mi = 0): number => Date.UTC(y, m - 1, d, h, mi);

// ------------------------------------------------------------------ 1 & 2. ICS URL Subscriptions, Holiday Presets, & Cache Behaviour

describe("calendar ICS URL & holiday subscriptions + conditional caching", () => {
  test("fresh DB lists empty subscriptions and empty bound events", async () => {
    const m = mk();
    expect((await m.call("GET", "/api/v2/calendar/subscription")).json).toEqual([]);
    const bindEv = await m.call("GET", "/api/v2/calendar/bind/events/all");
    expect(bindEv.status).toBe(200);
    expect(bindEv.json).toEqual([]);
  });

  test("holiday preset catalog includes NL, BE, UK, US, and Islamic with valid HTTPS URLs", async () => {
    const m = mk();
    const res = await m.call("GET", "/api/v2/calendar/holidays/presets");
    expect(res.status).toBe(200);
    const ids = (res.json as Array<{ id: string }>).map((p) => p.id);
    expect(ids).toEqual(["nl", "be", "uk", "us", "islamic"]);
    for (const p of HOLIDAY_PRESETS) expect(p.url.startsWith("https://")).toBe(true);
    expect((await m.call("GET", "/pub/api/v1/calendar/holiday/cn/recent")).json).toEqual([]);
  });

  test("subscribes URL (http, https, webcal, webcals) and rejects bad scheme", async () => {
    const m = mk();
    const s1 = await m.call("POST", "/api/v2/calendar/subscribe", { url: "webcal://cal.example.com/feed.ics", name: "Webcal", color: "#ff5500" });
    expect(s1.status).toBe(200);
    expect(s1.json).toMatchObject({ name: "Webcal", color: "#ff5500", show: true, hidden: false, kind: "url" });

    const s2 = await m.call("POST", "/api/v2/calendar/subscribe", { url: "webcals://cal.example.com/sec.ics" });
    expect(s2.status).toBe(200);

    const bad = await m.call("POST", "/api/v2/calendar/subscribe", { url: "file:///etc/passwd" });
    expect(bad.status).toBe(400);
    expect(bad.json.errorCode).toBe("invalid_calendar_url");
  });

  test("supports adding >10 URL subscriptions with no limit gate (CAL-063)", async () => {
    const m = mk();
    for (let i = 0; i < 12; i++) {
      const r = await m.call("POST", "/api/v2/calendar/subscribe", { url: `https://example.com/${i}.ics`, name: `Sub ${i}` });
      expect(r.status).toBe(200);
    }
    expect((await m.call("GET", "/api/v2/calendar/subscription")).json).toHaveLength(12);
  });

  test("renames, recolours, edits desc, toggles show/hide, reorders, and deletes subscriptions", async () => {
    const m = mk();
    const a = (await m.call("POST", "/api/v2/calendar/subscribe", { url: "https://example.com/a.ics", name: "A", color: "#111" })).json;
    const b = (await m.call("POST", "/api/v2/calendar/subscribe", { url: "https://example.com/b.ics", name: "B", color: "#222" })).json;

    const renamed = await m.call("PUT", `/api/v2/calendar/subscription/${a.id}`, { name: "Renamed A", color: "#00aa88" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ name: "Renamed A", color: "#00aa88" });

    const desc = await m.call("PUT", `/api/v2/calendar/${a.id}/desc`, { desc: "Work calendar" });
    expect(desc.status).toBe(200);
    expect(desc.json.desc).toBe("Work calendar");

    const hidden = await m.call("PUT", `/api/v2/calendar/batch/${a.id}/show`, { show: false });
    expect(hidden.status).toBe(200);
    expect(hidden.json).toMatchObject({ show: false, hidden: true });

    const toggled = await m.call("PUT", `/api/v2/calendar/batch/${a.id}/show`, {});
    expect(toggled.json).toMatchObject({ show: true, hidden: false });

    const sorted = await m.call("POST", "/api/v2/calendar/subscribe/sortOrder", { ids: [b.id, a.id] });
    expect(sorted.status).toBe(200);
    expect((sorted.json as Array<{ id: string }>).map((x) => x.id)).toEqual([b.id, a.id]);

    const delA = await m.call("DELETE", `/api/v2/calendar/unsubscribe/${a.id}`);
    expect(delA.status).toBe(200);
    const delB = await m.call("DELETE", "/api/v2/calendar/unsubscribe", { data: b.id });
    expect(delB.status).toBe(200);
    expect((await m.call("GET", "/api/v2/calendar/subscription")).json).toEqual([]);
  });

  test("batch subscribe supports both array and {add, update, delete} shapes", async () => {
    const m = mk();
    const arrRes = await m.call("POST", "/api/v2/calendar/batch/subscribe", [
      { id: "sub-1", url: "https://example.com/1.ics", name: "One" },
      { id: "sub-2", url: "https://example.com/2.ics", name: "Two" },
    ]);
    expect(arrRes.status).toBe(200);
    expect(arrRes.json).toHaveLength(2);

    const batchRes = await m.call("POST", "/api/v2/calendar/batch/subscribe", {
      add: [{ id: "sub-3", url: "https://example.com/3.ics", name: "Three" }],
      update: [{ id: "sub-1", url: "https://example.com/1.ics", name: "One Updated" }],
      delete: ["sub-2"],
    });
    expect(batchRes.status).toBe(200);
    expect(batchRes.json.id2error).toEqual({});
    const list = (await m.call("GET", "/api/v2/calendar/subscription")).json as Array<{ id: string; name: string }>;
    expect(list.map((s) => s.id).sort()).toEqual(["sub-1", "sub-3"]);
    expect(list.find((s) => s.id === "sub-1")!.name).toBe("One Updated");
  });

  test("holiday preset subscription uses same ICS mechanism and rejects unknown preset", async () => {
    const m = mk();
    const bad = await m.call("POST", "/api/v2/calendar/holiday/subscribe", { presetId: "mars" });
    expect(bad.status).toBe(400);

    const ok = await m.call("POST", "/api/v2/calendar/holiday/subscribe", { presetId: "nl", color: "#ff8800" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ kind: "holiday", presetId: "nl", color: "#ff8800" });
  });

  test("caches ICS with ETag & Last-Modified, skips refresh <15m, sends conditional headers >=15m, handles 304 and 200", async () => {
    let etag = '"v1"';
    let lastMod = "Fri, 01 May 2026 00:00:00 GMT";
    let eventTitle = "Original Feed Event";
    let statusOverride: number | null = null;
    const hits: Array<{ inm?: string; ims?: string }> = [];

    const baseUrl = await startHttpServer((req, _body, res) => {
      const inm = req.headers["if-none-match"];
      const ims = req.headers["if-modified-since"];
      hits.push({ ...(typeof inm === "string" ? { inm } : {}), ...(typeof ims === "string" ? { ims } : {}) });
      if (statusOverride) {
        res.statusCode = statusOverride;
        res.end("error");
        return;
      }
      if (inm === etag) {
        res.statusCode = 304;
        res.setHeader("ETag", etag);
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("ETag", etag);
      res.setHeader("Last-Modified", lastMod);
      res.end([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:cache-1",
        "DTSTART:20260510T090000Z",
        "DTEND:20260510T100000Z",
        `SUMMARY:${eventTitle}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"));
    });

    let nowMs = utc(2026, 5, 1, 10, 0);
    const m = mk({ now: () => nowMs });
    const sub = (await m.call("POST", "/api/v2/calendar/subscribe", { url: `${baseUrl}/feed.ics`, name: "Cached" })).json;
    const win = `from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`;

    // 1. Initial fetch (cache miss -> HTTP 200)
    const r1 = await m.call("GET", `/api/v2/calendar/subscribe/events?${win}`);
    expect(r1.status).toBe(200);
    expect(r1.json).toHaveLength(1);
    expect(r1.json[0].title).toBe("Original Feed Event");
    expect(hits).toHaveLength(1);

    // 2. +10 minutes: served from cache (0 extra requests)
    nowMs += 10 * 60_000;
    const r2 = await m.call("GET", `/api/v2/calendar/subscribe/events?${win}`);
    expect(r2.json[0].title).toBe("Original Feed Event");
    expect(hits).toHaveLength(1);

    // 3. +15 minutes total (+5 more): sends If-None-Match + If-Modified-Since, gets 304
    nowMs += 5 * 60_000;
    const r3 = await m.call("GET", `/api/v2/calendar/subscribe/events?${win}`);
    expect(r3.json[0].title).toBe("Original Feed Event");
    expect(hits).toHaveLength(2);
    expect(hits[1]).toEqual({ inm: '"v1"', ims: lastMod });

    // 4. +5 minutes after 304: still cached (0 extra requests)
    nowMs += 5 * 60_000;
    await m.call("GET", `/api/v2/calendar/subscribe/events?${win}`);
    expect(hits).toHaveLength(2);

    // 5. +15 minutes after 304 and upstream updated ETag -> 200 with updated event
    nowMs += 10 * 60_000;
    etag = '"v2"';
    eventTitle = "Updated Feed Event";
    const r5 = await m.call("GET", `/api/v2/calendar/subscribe/events?${win}`);
    expect(r5.json[0].title).toBe("Updated Feed Event");
    expect(hits).toHaveLength(3);

    // 6. Upstream 500 after cache expires: falls back to stale cache on multi-sub query, records lastError
    nowMs += 16 * 60_000;
    statusOverride = 500;
    const r6 = await m.call("GET", `/api/v2/calendar/subscribe/events?${win}`);
    expect(r6.status).toBe(200);
    expect(r6.json[0].title).toBe("Updated Feed Event");
    const cacheMeta = (await m.call("GET", `/api/v2/calendar/cache/${sub.id}`)).json;
    expect(cacheMeta).toMatchObject({ cached: true, status: 500, lastError: "HTTP 500", etag: '"v2"' });
  });

  test("hidden subscription excluded from /subscribe/events but accessible by /subscribe/events/:id", async () => {
    const baseUrl = await startHttpServer((_req, _body, res) => {
      res.setHeader("Content-Type", "text/calendar");
      res.end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:h1\r\nDTSTART:20260510T090000Z\r\nDTEND:20260510T100000Z\r\nSUMMARY:Hidden Ev\r\nEND:VEVENT\r\nEND:VCALENDAR");
    });
    const m = mk();
    const sub = (await m.call("POST", "/api/v2/calendar/subscribe", { url: `${baseUrl}/h.ics`, name: "H" })).json;
    await m.call("PUT", `/api/v2/calendar/batch/${sub.id}/show`, { show: false });

    const all = await m.call("GET", `/api/v2/calendar/subscribe/events?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(all.json).toEqual([]);

    const single = await m.call("GET", `/api/v2/calendar/subscribe/events/${sub.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(single.status).toBe(200);
    expect(single.json).toHaveLength(1);
  });

  test("changing subscription URL clears cache and invalid ICS on uncached feed returns 502", async () => {
    const baseUrl = await startHttpServer((req, _body, res) => {
      if (req.url === "/good.ics") {
        res.end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:g1\r\nDTSTART:20260510T090000Z\r\nDTEND:20260510T100000Z\r\nSUMMARY:Good\r\nEND:VEVENT\r\nEND:VCALENDAR");
      } else {
        res.end("<html>Not an ICS</html>");
      }
    });
    const m = mk();
    const sub = (await m.call("POST", "/api/v2/calendar/subscribe", { url: `${baseUrl}/good.ics` })).json;
    const ok = await m.call("GET", `/api/v2/calendar/subscribe/events/${sub.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(ok.json).toHaveLength(1);

    await m.call("PUT", `/api/v2/calendar/subscription/${sub.id}`, { url: `${baseUrl}/bad.html` });
    const bad = await m.call("GET", `/api/v2/calendar/subscribe/events/${sub.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(bad.status).toBe(502);
    expect(bad.json.errorCode).toBe("invalid_ics_payload");
  });

  test("changing user settings.timeZone re-evaluates cached floating ICS times without HTTP re-fetch", async () => {
    let fetches = 0;
    const baseUrl = await startHttpServer((_req, _body, res) => {
      fetches++;
      res.end([
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:fl-cache",
        "DTSTART:20260510T090000",
        "DTEND:20260510T100000",
        "SUMMARY:Floating",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n"));
    });

    let nowMs = utc(2026, 5, 1);
    const m = mk({ now: () => nowMs });
    await m.call("PUT", "/api/v2/user/preferences/settings", { timeZone: "America/New_York" });
    await m.call("POST", "/api/v2/calendar/subscribe", { url: `${baseUrl}/fl.ics` });

    const r1 = await m.call("GET", `/api/v2/calendar/subscribe/events?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(r1.json[0].start).toBe(utc(2026, 5, 10, 13, 0)); // 09:00 EDT = 13:00Z
    expect(fetches).toBe(1);

    nowMs += 60_000;
    await m.call("PUT", "/api/v2/user/preferences/settings", { timeZone: "Asia/Tokyo" });
    const r2 = await m.call("GET", `/api/v2/calendar/subscribe/events?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(r2.json[0].start).toBe(utc(2026, 5, 10, 0, 0)); // 09:00 JST = 00:00Z
    expect(fetches).toBe(1);
  });
});

// ------------------------------------------------------------------ 3. Outgoing Private ICS Feed

describe("outgoing private ICS feed (/feed/<secret-token>.ics)", () => {
  test("creates token, serves public ICS without auth cookie, rejects invalid token, and cancels cleanly", async () => {
    const pwHash = await hashPassphrase("correct horse battery staple");
    const m = mk({ noAuth: false, auth: { passphraseHash: pwHash } });
    // Sign in to obtain session + csrf
    const signon = await m.app.inject({ method: "POST", url: "/api/v2/user/signon", payload: { password: "correct horse battery staple" } });
    expect(signon.statusCode).toBe(200);
    const cookies = signon.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const csrf = signon.cookies.find((c) => c.name === "_csrf_token")!.value;
    const authed = (method: string, url: string, payload?: unknown) =>
      m.app.inject({
        method: method as "GET",
        url,
        headers: { cookie: cookies, ...(method !== "GET" ? { "x-csrftoken": csrf } : {}) },
        ...(payload !== undefined ? { payload: payload as object } : {}),
      });

    // Unauthenticated API calls fail, but /feed/... uses token auth only
    expect((await m.call("GET", "/api/v2/calendar/feeds/code")).status).toBe(401);
    const initial = (await authed("GET", "/api/v2/calendar/feeds/code")).json();
    expect(initial).toMatchObject({ code: null, enabled: false });

    await authed("POST", "/api/v2/batch/task", {
      add: [task({ id: "t1", projectId: m.svc.inboxId, title: "Public Feed Task", startDate: "2026-05-15T10:00:00.000+0000", dueDate: "2026-05-15T11:00:00.000+0000", isAllDay: false })],
    });

    const created = (await authed("POST", "/api/v2/calendar/feeds/code/new/default?includeDone=false")).json();
    expect(created.code).toMatch(/^[0-9a-f]{48}$/);
    expect(created.url).toBe(`/feed/${created.code}.ics`);

    // Wrong token -> 404 (no session cookie needed)
    const badToken = await m.app.inject({ method: "GET", url: `/feed/${"0".repeat(48)}.ics` });
    expect(badToken.statusCode).toBe(404);

    // Valid token -> 200 text/calendar without any session cookie, validates via node-ical
    const feedRes = await m.app.inject({ method: "GET", url: created.url });
    expect(feedRes.statusCode).toBe(200);
    expect(feedRes.headers["content-type"]).toContain("text/calendar");
    const parsed = ical.sync.parseICS(feedRes.body);
    const vevs = Object.values(parsed).filter((v): v is VEvent => Boolean(v && v.type === "VEVENT"));
    expect(vevs).toHaveLength(1);
    expect(vevs[0]!.summary).toBe("Public Feed Task");

    // Reset token invalidates old URL and serves on new URL
    const reset = (await authed("POST", "/api/v2/calendar/feeds/code/new/default")).json();
    expect(reset.code).not.toBe(created.code);
    expect((await m.app.inject({ method: "GET", url: created.url })).statusCode).toBe(404);
    expect((await m.app.inject({ method: "GET", url: reset.url })).statusCode).toBe(200);

    // Cancel revokes URL
    const cancel = await authed("DELETE", `/api/v2/calendar/feeds/cancel/${reset.code}`);
    expect(cancel.statusCode).toBe(200);
    expect((await m.app.inject({ method: "GET", url: reset.url })).statusCode).toBe(404);
  });

  test("respects includeDone, projectIds list selection, and includeHabits", async () => {
    const m = mk({ now: () => utc(2026, 5, 1) });
    const pWork = await seedProject(m.call, { name: "Work" });
    const pHome = await seedProject(m.call, { name: "Home" });

    await m.call("POST", "/api/v2/batch/task", {
      add: [
        task({ id: "open-w", projectId: pWork, title: "Work Open", startDate: "2026-05-10T00:00:00.000+0000", isAllDay: true }),
        task({ id: "done-w", projectId: pWork, title: "Work Done", status: TaskStatus.Completed, startDate: "2026-05-11T00:00:00.000+0000", isAllDay: true }),
        task({ id: "open-h", projectId: pHome, title: "Home Open", startDate: "2026-05-12T00:00:00.000+0000", isAllDay: true }),
      ],
    });
    await m.call("POST", "/api/v2/habits/batch", {
      add: [{ id: "hab-1", name: "Run", repeatRule: "FREQ=DAILY", targetStartDate: 20260510, reminders: ["07:00"] }],
    });

    const created = (await m.call("POST", "/api/v2/calendar/feeds/code/new/default?includeDone=false", { projectIds: [pWork], includeHabits: false })).json;
    const parseTitles = async () => {
      const r = await m.app.inject({ method: "GET", url: created.url });
      expect(r.statusCode).toBe(200);
      return Object.values(ical.sync.parseICS(r.body))
        .filter((v): v is VEvent => Boolean(v && v.type === "VEVENT"))
        .map((v) => String(v.summary));
    };

    expect(await parseTitles()).toEqual(["Work Open"]);

    // Enable includeDone
    await m.call("PUT", "/api/v2/calendar/feeds/code", { includeDone: true });
    expect((await parseTitles()).sort()).toEqual(["Work Done", "Work Open"]);

    // Enable all lists + habits
    await m.call("PUT", "/api/v2/calendar/feeds/code", { projectIds: null, includeHabits: true });
    const withHabits = await parseTitles();
    expect(withHabits).toContain("Home Open");
    expect(withHabits).toContain("Run");
  });
});

// ------------------------------------------------------------------ 4. Google & Outlook OAuth 2.0 + Two-Way Sync + Mock APIs

describe("Google & Outlook OAuth 2.0 flow, token refresh, revoked tokens, and two-way sync", () => {
  function makeMockGoogleServer() {
    let accessToken = "g-access-1";
    let refreshToken = "g-refresh-1";
    let tokenRevoked = false;
    let tokenExpired = false;
    let revokedCalls: string[] = [];
    let nextSeq = 1;
    const events: Array<Record<string, any>> = [
      {
        id: "gev-1",
        etag: '"ge1"',
        summary: "Google Team Lunch ~Work #social",
        description: "Cafe downstairs",
        start: { dateTime: "2026-05-10T12:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-05-10T13:00:00Z", timeZone: "UTC" },
        status: "confirmed",
      },
      {
        id: "gev-dec",
        etag: '"ged"',
        summary: "Declined Optional",
        start: { dateTime: "2026-05-11T12:00:00Z", timeZone: "UTC" },
        end: { dateTime: "2026-05-11T13:00:00Z", timeZone: "UTC" },
        status: "confirmed",
        attendees: [{ email: "trevor@example.com", self: true, responseStatus: "declined" }],
      },
    ];
    const calendars: Array<Record<string, any>> = [
      { id: "primary", summary: "Primary Calendar", backgroundColor: "#4285f4", primary: true, accessRole: "owner", selected: true },
    ];
    let lastCodeChallenge = "";
    let refreshCount = 0;

    const start = async () => {
      const base = await startHttpServer((req, body, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const json = (code: number, data: unknown) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };

        if (req.method === "POST" && u.pathname === "/oauth/token") {
          const p = new URLSearchParams(body);
          if (p.get("client_id") !== "g-cid" || p.get("client_secret") !== "g-sec") return json(401, { error: "invalid_client" });
          if (p.get("grant_type") === "authorization_code") {
            const verifier = p.get("code_verifier") ?? "";
            const challenge = createHash("sha256").update(verifier).digest("base64url");
            if (lastCodeChallenge && challenge !== lastCodeChallenge) return json(400, { error: "invalid_grant" });
            return json(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, token_type: "Bearer" });
          }
          if (p.get("grant_type") === "refresh_token") {
            if (tokenRevoked || p.get("refresh_token") !== refreshToken) {
              return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
            }
            refreshCount++;
            tokenExpired = false;
            accessToken = `g-access-${refreshCount + 1}`;
            return json(200, { access_token: accessToken, expires_in: 3600, token_type: "Bearer" });
          }
          return json(400, { error: "unsupported_grant_type" });
        }

        if (req.method === "POST" && u.pathname === "/oauth/revoke") {
          revokedCalls.push(u.searchParams.get("token") ?? "");
          return json(200, {});
        }

        // Protected API routes require current non-expired Bearer token
        const auth = req.headers.authorization;
        if (tokenExpired || auth !== `Bearer ${accessToken}`) return json(401, { error: { code: 401, message: "Invalid Credentials" } });

        if (req.method === "GET" && u.pathname === "/userinfo") {
          return json(200, { email: "trevor@example.com", name: "Trevor Jinadu" });
        }
        if (req.method === "GET" && u.pathname === "/calendar/v3/users/me/calendarList") {
          return json(200, { items: calendars });
        }
        if (req.method === "POST" && u.pathname === "/calendar/v3/calendars") {
          const b = JSON.parse(body);
          const cal = { id: `cal-${++nextSeq}`, summary: b.summary, accessRole: "owner", selected: true };
          calendars.push(cal);
          return json(200, cal);
        }
        if (req.method === "GET" && u.pathname === "/calendar/v3/calendars/primary/events") {
          const page = u.searchParams.get("pageToken");
          if (!page && events.length > 1) {
            return json(200, { items: [events[0]], nextPageToken: "p2" });
          }
          if (page === "p2") return json(200, { items: events.slice(1) });
          return json(200, { items: events });
        }
        if (req.method === "POST" && u.pathname === "/calendar/v3/calendars/primary/events") {
          const b = JSON.parse(body);
          const ev = { id: `gev-${++nextSeq}`, etag: `"etag-${nextSeq}"`, status: "confirmed", ...b };
          events.push(ev);
          return json(200, ev);
        }
        if (req.method === "PATCH" && u.pathname.startsWith("/calendar/v3/calendars/primary/events/")) {
          const id = decodeURIComponent(u.pathname.split("/").pop()!);
          const ev = events.find((e) => e.id === id);
          if (!ev) return json(404, { error: "not_found" });
          Object.assign(ev, JSON.parse(body), { etag: `"etag-${++nextSeq}"` });
          return json(200, ev);
        }
        if (req.method === "DELETE" && u.pathname.startsWith("/calendar/v3/calendars/primary/events/")) {
          const id = decodeURIComponent(u.pathname.split("/").pop()!);
          const idx = events.findIndex((e) => e.id === id);
          if (idx >= 0) events.splice(idx, 1);
          res.statusCode = 204;
          return res.end();
        }
        return json(404, { error: "unknown_route" });
      });
      return base;
    };

    return {
      start,
      events,
      setChallenge: (c: string) => { lastCodeChallenge = c; },
      expireToken: () => { tokenExpired = true; },
      revokeToken: () => { tokenRevoked = true; },
      getRefreshCount: () => refreshCount,
      getRevokedCalls: () => revokedCalls,
    };
  }

  function makeMockOutlookServer() {
    let accessToken = "ms-access-1";
    let refreshToken = "ms-refresh-1";
    let refreshCount = 0;
    const events: Array<Record<string, any>> = [
      {
        id: "mev-1",
        "@odata.etag": 'W/"me1"',
        subject: "Outlook Planning",
        bodyPreview: "Quarter roadmap",
        isAllDay: false,
        start: { dateTime: "2026-05-12T15:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-05-12T16:00:00", timeZone: "UTC" },
        responseStatus: { response: "accepted" },
      },
    ];
    let nextSeq = 1;

    const start = () =>
      startHttpServer((req, body, res) => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const json = (code: number, data: unknown) => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(data));
        };

        if (req.method === "POST" && u.pathname === "/oauth2/v2.0/token") {
          const p = new URLSearchParams(body);
          if (p.get("client_id") !== "ms-cid" || p.get("client_secret") !== "ms-sec") return json(401, { error: "invalid_client" });
          if (p.get("grant_type") === "refresh_token") {
            refreshCount++;
            accessToken = `ms-access-${refreshCount + 1}`;
            refreshToken = `ms-refresh-${refreshCount + 1}`;
          }
          return json(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 });
        }

        if (req.headers.authorization !== `Bearer ${accessToken}`) return json(401, { error: { code: "InvalidAuthenticationToken" } });

        if (req.method === "GET" && u.pathname === "/v1.0/me") {
          return json(200, { mail: "user@example.com", displayName: "Trevor MS" });
        }
        if (req.method === "GET" && u.pathname === "/v1.0/me/calendars") {
          return json(200, { value: [{ id: "ms-cal-1", name: "Calendar", hexColor: "#0078d4", isDefaultCalendar: true, canEdit: true }] });
        }
        if (req.method === "POST" && u.pathname === "/v1.0/me/calendars") {
          const b = JSON.parse(body);
          return json(200, { id: `ms-cal-${++nextSeq}`, name: b.name, canEdit: true });
        }
        if (req.method === "GET" && u.pathname === "/v1.0/me/calendars/ms-cal-1/calendarView") {
          return json(200, { value: events });
        }
        if (req.method === "POST" && u.pathname === "/v1.0/me/calendars/ms-cal-1/events") {
          const b = JSON.parse(body);
          const ev = { id: `mev-${++nextSeq}`, "@odata.etag": `W/"me${nextSeq}"`, ...b };
          events.push(ev);
          return json(200, ev);
        }
        if (req.method === "PATCH" && u.pathname.startsWith("/v1.0/me/events/")) {
          const id = decodeURIComponent(u.pathname.split("/").pop()!);
          const ev = events.find((e) => e.id === id);
          if (!ev) return json(404, {});
          Object.assign(ev, JSON.parse(body));
          return json(200, ev);
        }
        if (req.method === "DELETE" && u.pathname.startsWith("/v1.0/me/events/")) {
          const id = decodeURIComponent(u.pathname.split("/").pop()!);
          const idx = events.findIndex((e) => e.id === id);
          if (idx >= 0) events.splice(idx, 1);
          res.statusCode = 204;
          return res.end();
        }
        return json(404, {});
      });

    return { start, events, getRefreshCount: () => refreshCount };
  }

  test("returns 503 when OAuth credentials are not configured", async () => {
    const m = mk();
    const res = await m.call("GET", "/api/v2/calendar/oauth/google/start");
    expect(res.status).toBe(503);
    expect(res.json.errorCode).toBe("oauth_not_configured");
  });

  test("loads OAuth client id & secret from config file path and redacts tokens/secrets on API responses", async () => {
    const gMock = makeMockGoogleServer();
    const gBase = await gMock.start();
    const dir = tmp();
    cleanDirs.push(dir);
    const cfgPath = join(dir, "calendar-oauth.json");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        google: {
          clientId: "g-cid",
          clientSecret: "g-sec",
          authUrl: `${gBase}/oauth/auth`,
          tokenUrl: `${gBase}/oauth/token`,
          revokeUrl: `${gBase}/oauth/revoke`,
          userInfoUrl: `${gBase}/userinfo`,
          apiBaseUrl: `${gBase}/calendar/v3`,
        },
      }),
      { mode: 0o600 },
    );

    const m = mk({ calendarOAuthFile: cfgPath });
    const startRes = await m.call("GET", "/api/v2/calendar/oauth/google/start");
    expect(startRes.status).toBe(200);
    const authUrl = new URL(startRes.json.authorizationUrl);
    expect(authUrl.searchParams.get("client_id")).toBe("g-cid");
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    gMock.setChallenge(authUrl.searchParams.get("code_challenge")!);

    const cb = await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=auth-1&state=${startRes.json.state}`);
    expect(cb.status).toBe(200);
    expect(cb.json).toMatchObject({ provider: "google", email: "trevor@example.com", status: "active", needsReauth: false });
    const serialized = JSON.stringify(cb.json);
    expect(serialized).not.toContain("g-sec");
    expect(serialized).not.toContain("g-access-1");
    expect(serialized).not.toContain("g-refresh-1");

    // Replaying single-use state fails
    const replay = await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=auth-1&state=${startRes.json.state}`);
    expect(replay.status).toBe(400);
    expect(replay.json.errorCode).toBe("invalid_oauth_state");

    // Accounts list also hides tokens
    const list = await m.call("GET", "/api/v2/calendar/third/accounts");
    expect(JSON.stringify(list.json)).not.toContain("g-access-1");
    expect(JSON.stringify(list.json)).not.toContain("g-refresh-1");
  });

  test("handles OAuth error response, expired state, and redirect mode", async () => {
    const m = mk({
      calendarOAuth: {
        google: { clientId: "g-cid", clientSecret: "g-sec", authUrl: "https://example.com/auth", tokenUrl: "https://example.com/tok", apiBaseUrl: "https://example.com", scopes: ["cal"] },
      },
      now: () => 1_700_000_000_000,
    });

    const redir = await m.app.inject({ method: "GET", url: "/api/v2/calendar/oauth/google/start?redirect=true" });
    expect(redir.statusCode).toBe(302);
    expect(redir.headers.location).toContain("https://example.com/auth");

    const denied = await m.call("GET", "/api/v2/calendar/oauth/google/callback?error=access_denied&state=x");
    expect(denied.status).toBe(400);
    expect(denied.json.errorCode).toBe("oauth_authorization_error");

    const v3start = await m.call("GET", "/api/v3/calendar/bind?provider=google");
    expect(v3start.status).toBe(200);
    expect((await m.call("GET", `/api/v3/calendar/bind?state=${v3start.json.state}`)).json.pending).toBe(true);
  });

  test("refreshes OAuth token automatically when near expiry or on 401, and marks account revoked on invalid_grant", async () => {
    const gMock = makeMockGoogleServer();
    const gBase = await gMock.start();
    let nowMs = utc(2026, 5, 1, 10, 0);
    const m = mk({
      now: () => nowMs,
      calendarOAuth: {
        google: {
          clientId: "g-cid",
          clientSecret: "g-sec",
          authUrl: `${gBase}/oauth/auth`,
          tokenUrl: `${gBase}/oauth/token`,
          revokeUrl: `${gBase}/oauth/revoke`,
          userInfoUrl: `${gBase}/userinfo`,
          apiBaseUrl: `${gBase}/calendar/v3`,
          scopes: ["https://www.googleapis.com/auth/calendar"],
        },
      },
    });

    const s = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const acc = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=ok&state=${s.state}`)).json;

    // 1. Force server-side expiration (401 retry path)
    gMock.expireToken();
    const ev1 = await m.call("POST", `/api/v4/calendar/bind/events/${acc.id}`, { begin: utc(2026, 5, 1), end: utc(2026, 5, 31) });
    expect(ev1.status).toBe(200);
    expect(ev1.json.length).toBeGreaterThanOrEqual(1);
    expect(gMock.getRefreshCount()).toBe(1);

    // 2. Advance clock past expiry window -> proactive refresh
    nowMs += 3550 * 1000;
    const ev2 = await m.call("POST", `/api/v4/calendar/bind/events/${acc.id}`, { begin: utc(2026, 5, 1), end: utc(2026, 5, 31) });
    expect(ev2.status).toBe(200);
    expect(gMock.getRefreshCount()).toBe(2);

    // 3. Revoke refresh token -> explicit refresh marks account revoked + returns 401 oauth_token_revoked
    gMock.revokeToken();
    const rev = await m.call("POST", "/api/v2/calendar/oauth/google/refresh", { accountId: acc.id });
    expect(rev.status).toBe(401);
    expect(rev.json.errorCode).toBe("oauth_token_revoked");

    const accAfter = (await m.call("GET", "/api/v2/calendar/third/accounts")).json[0];
    expect(accAfter).toMatchObject({ status: "revoked", needsReauth: true, lastError: "invalid_grant" });
  });

  test("completes Outlook OAuth flow, lists calendars, fetches events, and creates/updates/deletes remote events", async () => {
    const msMock = makeMockOutlookServer();
    const msBase = await msMock.start();
    const m = mk({
      now: () => utc(2026, 5, 1),
      calendarOAuth: {
        outlook: {
          clientId: "ms-cid",
          clientSecret: "ms-sec",
          authUrl: `${msBase}/oauth2/v2.0/authorize`,
          tokenUrl: `${msBase}/oauth2/v2.0/token`,
          userInfoUrl: `${msBase}/v1.0/me`,
          apiBaseUrl: `${msBase}/v1.0`,
          scopes: ["offline_access", "Calendars.ReadWrite"],
        },
      },
    });

    const start = (await m.call("GET", "/api/v2/calendar/oauth/outlook/start")).json;
    const acc = (await m.call("POST", "/api/v2/calendar/oauth/outlook/callback", { code: "c1", state: start.state })).json;
    expect(acc).toMatchObject({ provider: "outlook", email: "user@example.com", itemType: CalendarSourceItemType.OutlookCalendar });

    const fetched = await m.call("POST", "/api/v2/calendar/bind/events/outlook", { begin: utc(2026, 5, 1), end: utc(2026, 5, 31) });
    expect(fetched.status).toBe(200);
    expect(fetched.json[0].title).toBe("Outlook Planning");

    // Two-way write via batch & REST endpoints
    const created = await m.call("POST", `/api/v2/calendar/accounts/${acc.id}/events`, {
      calendarId: "ms-cal-1",
      title: "1:1 Sync",
      start: utc(2026, 5, 14, 10, 0),
      end: utc(2026, 5, 14, 10, 30),
    });
    expect(created.status).toBe(200);
    expect(created.json.title).toBe("1:1 Sync");

    const updated = await m.call("PUT", `/api/v2/calendar/accounts/${acc.id}/events/${created.json.externalId}`, {
      calendarId: "ms-cal-1",
      title: "1:1 Sync Updated",
    });
    expect(updated.status).toBe(200);
    expect(updated.json.title).toBe("1:1 Sync Updated");

    const del = await m.call("DELETE", `/api/v2/calendar/accounts/${acc.id}/events/${created.json.externalId}?calendarId=ms-cal-1`);
    expect(del.status).toBe(200);
    expect(msMock.events.some((e) => e.id === created.json.externalId)).toBe(false);

    // Explicit refresh rotates refresh token
    const refreshed = await m.call("POST", `/api/v2/calendar/accounts/${acc.id}/refresh`);
    expect(refreshed.status).toBe(200);
    expect(msMock.getRefreshCount()).toBe(1);
  });

  test("two-way sync pulls with ~List/#tag/defaultTags, pushes task edits, handles remote cancel, and unlink keeps both sides", async () => {
    const gMock = makeMockGoogleServer();
    const gBase = await gMock.start();
    const m = mk({
      now: () => utc(2026, 5, 1),
      calendarOAuth: {
        google: {
          clientId: "g-cid",
          clientSecret: "g-sec",
          authUrl: `${gBase}/oauth/auth`,
          tokenUrl: `${gBase}/oauth/token`,
          revokeUrl: `${gBase}/oauth/revoke`,
          userInfoUrl: `${gBase}/userinfo`,
          apiBaseUrl: `${gBase}/calendar/v3`,
          scopes: ["https://www.googleapis.com/auth/calendar"],
        },
      },
    });
    const pWork = await seedProject(m.call, { name: "Work" });
    const s = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const acc = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=ok&state=${s.state}`)).json;

    // Create remote calendar
    const newCal = await m.call("POST", `/api/v2/calendar/${acc.id}/create`, { calendarName: "NoorTasks Sync" });
    expect(newCal.status).toBe(200);
    expect(newCal.json.name).toBe("NoorTasks Sync");

    // Bind primary calendar with scope "all" & defaultTags ["gcal"]
    const binding = (await m.call("POST", `/api/v2/calendar/${acc.id}/bind/project`, {
      calendarId: "primary",
      syncProjectScope: "all",
      syncProjectId: m.svc.inboxId,
      defaultTags: ["GCal"],
    })).json;

    // Add an unlinked task in Work and bind/update to project mode to also test push
    const sync1 = await m.call("POST", `/api/v2/calendar/accounts/${acc.id}/sync?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(sync1.status).toBe(200);
    expect(sync1.json.pulled).toBe(2);

    const workTasks = (await m.call("GET", `/api/v2/project/${pWork}/tasks`)).json as Array<Record<string, any>>;
    const lunch = workTasks.find((t) => t.title.includes("Google Team Lunch"));
    expect(lunch).toBeDefined();
    expect(lunch!.tags).toEqual(["gcal", "social"]);
    expect(lunch!.calendarId).toBe("primary");
    expect(lunch!.accountId).toBe(acc.id);

    // Edit the synced task locally -> sync pushes update to Google
    await m.call("POST", "/api/v2/batch/task", { update: [{ ...lunch, title: "Updated Lunch Title" }] });
    const sync2 = await m.call("POST", `/api/v2/calendar/accounts/${acc.id}/sync?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(sync2.json.updated).toBe(1);
    expect(gMock.events.find((e) => e.id === "gev-1")!.summary).toBe("Updated Lunch Title");

    // Switch binding to Work project, add a local task in Work -> pushes new event to Google
    await m.call("PUT", `/api/v2/calendar/${acc.id}/bind/project`, { id: binding.id, syncProjectScope: "project", syncProjectId: pWork });
    await m.call("POST", "/api/v2/batch/task", {
      add: [task({ id: "local-push-1", projectId: pWork, title: "Push Me", startDate: "2026-05-18T09:00:00.000+0000", dueDate: "2026-05-18T10:00:00.000+0000", isAllDay: false })],
    });
    const sync3 = await m.call("POST", `/api/v2/calendar/accounts/${acc.id}/sync?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(sync3.json.pushed).toBe(1);
    expect(gMock.events.some((e) => e.summary === "Push Me")).toBe(true);

    // Cancel remote event -> trashes linked local task
    gMock.events.find((e) => e.id === "gev-dec")!.status = "cancelled";
    const sync4 = await m.call("POST", `/api/v2/calendar/accounts/${acc.id}/sync?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(sync4.json.deleted).toBe(1);

    // Unlink keeps tasks on both sides (CAL-070)
    const unlink = await m.call("DELETE", `/api/v2/calendar/${acc.id}/bind/project?id=${binding.id}`);
    expect(unlink.status).toBe(200);
    expect(((await m.call("GET", `/api/v2/project/${pWork}/tasks`)).json as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect(gMock.events.some((e) => e.summary === "Push Me")).toBe(true);

    // Disconnect calls remote revoke and removes account without deleting tasks
    const disc = await m.call("DELETE", `/api/v2/calendar/bind/${acc.id}`);
    expect(disc.status).toBe(200);
    expect(gMock.getRevokedCalls().length).toBe(1);
    expect((await m.call("GET", "/api/v2/calendar/third/accounts")).json).toEqual([]);
  });
});

// ------------------------------------------------------------------ 5. CalDAV (Generic & iCloud) Mock PROPFIND / REPORT

describe("CalDAV (generic & iCloud) PROPFIND/REPORT adapter", () => {
  function makeMockCalDavServer() {
    const requests: Array<{ method: string; url: string; body: string }> = [];
    return {
      requests,
      start: () =>
        startHttpServer((req, body, res) => {
          requests.push({ method: req.method ?? "", url: req.url ?? "/", body });
          const auth = req.headers.authorization ?? "";
          const expected = `Basic ${Buffer.from("alice:app-pass-123").toString("base64")}`;
          if (auth !== expected) {
            res.statusCode = 401;
            res.setHeader("WWW-Authenticate", 'Basic realm="CalDAV"');
            return res.end("Unauthorized");
          }

          if (req.method === "PROPFIND" && req.url === "/") {
            res.statusCode = 207;
            res.setHeader("Content-Type", "application/xml; charset=utf-8");
            return res.end(`<?xml version="1.0" encoding="utf-8"?>
              <D:multistatus xmlns:D="DAV:">
                <D:response>
                  <D:href>/</D:href>
                  <D:propstat>
                    <D:prop>
                      <D:current-user-principal><D:href>/principals/alice/</D:href></D:current-user-principal>
                    </D:prop>
                    <D:status>HTTP/1.1 200 OK</D:status>
                  </D:propstat>
                </D:response>
              </D:multistatus>`);
          }

          if (req.method === "PROPFIND" && req.url === "/principals/alice/") {
            res.statusCode = 207;
            res.setHeader("Content-Type", "application/xml; charset=utf-8");
            return res.end(`<?xml version="1.0" encoding="utf-8"?>
              <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
                <D:response>
                  <D:href>/principals/alice/</D:href>
                  <D:propstat>
                    <D:prop><C:calendar-home-set><D:href>/calendars/alice/</D:href></C:calendar-home-set></D:prop>
                    <D:status>HTTP/1.1 200 OK</D:status>
                  </D:propstat>
                </D:response>
              </D:multistatus>`);
          }

          if (req.method === "PROPFIND" && req.url === "/calendars/alice/") {
            res.statusCode = 207;
            res.setHeader("Content-Type", "application/xml; charset=utf-8");
            return res.end(`<?xml version="1.0" encoding="utf-8"?>
              <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/" xmlns:CS="http://calendarserver.org/ns/">
                <D:response>
                  <D:href>/calendars/alice/</D:href>
                  <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
                </D:response>
                <D:response>
                  <D:href>/calendars/alice/home/</D:href>
                  <D:propstat>
                    <D:prop>
                      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
                      <D:displayname>Family</D:displayname>
                      <A:calendar-color>#34c759ff</A:calendar-color>
                      <CS:getctag>ctag-1</CS:getctag>
                      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
                    </D:prop>
                  </D:propstat>
                </D:response>
                <D:response>
                  <D:href>/calendars/alice/reminders/</D:href>
                  <D:propstat>
                    <D:prop>
                      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
                      <D:displayname>Tasks Only</D:displayname>
                      <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
                    </D:prop>
                  </D:propstat>
                </D:response>
              </D:multistatus>`);
          }

          if (req.method === "PROPFIND" && req.url === "/direct/") {
            res.statusCode = 207;
            res.setHeader("Content-Type", "application/xml; charset=utf-8");
            return res.end(`<?xml version="1.0" encoding="utf-8"?>
              <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
                <D:response>
                  <D:href>/direct/</D:href>
                  <D:propstat>
                    <D:prop>
                      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
                      <D:displayname>Direct Cal</D:displayname>
                    </D:prop>
                  </D:propstat>
                </D:response>
              </D:multistatus>`);
          }

          if (req.method === "REPORT" && (req.url === "/calendars/alice/home/" || req.url === "/direct/")) {
            res.statusCode = 207;
            res.setHeader("Content-Type", "application/xml; charset=utf-8");
            const ics = [
              "BEGIN:VCALENDAR",
              "VERSION:2.0",
              "BEGIN:VEVENT",
              "UID:dav-rec-1",
              "DTSTART;TZID=Europe/Amsterdam:20260510T180000",
              "DTEND;TZID=Europe/Amsterdam:20260510T190000",
              "RRULE:FREQ=DAILY;COUNT=3",
              "EXDATE;TZID=Europe/Amsterdam:20260511T180000",
              "SUMMARY:Dinner",
              "END:VEVENT",
              "BEGIN:VEVENT",
              "UID:dav-rec-1",
              "RECURRENCE-ID;TZID=Europe/Amsterdam:20260512T180000",
              "DTSTART;TZID=Europe/Amsterdam:20260512T193000",
              "DTEND;TZID=Europe/Amsterdam:20260512T203000",
              "SUMMARY:Late Dinner",
              "END:VEVENT",
              "END:VCALENDAR",
            ].join("\r\n");
            return res.end(`<?xml version="1.0" encoding="utf-8"?>
              <D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
                <D:response>
                  <D:href>/calendars/alice/home/evt1.ics</D:href>
                  <D:propstat>
                    <D:prop>
                      <D:getetag>"dav-e1"</D:getetag>
                      <C:calendar-data><![CDATA[${ics}]]></C:calendar-data>
                    </D:prop>
                  </D:propstat>
                </D:response>
              </D:multistatus>`);
          }

          res.statusCode = 404;
          res.end();
        }),
    };
  }

  test("binds generic CalDAV via PROPFIND discovery, filters non-VEVENT collections, and fetches REPORT events", async () => {
    const dav = makeMockCalDavServer();
    const base = await dav.start();
    const m = mk();

    const bind = await m.call("POST", "/api/v4/calendar/bind", {
      serverAddress: `${base}/`,
      account: "alice",
      password: "app-pass-123",
      name: "My Radicale",
    });
    expect(bind.status).toBe(200);
    expect(bind.json).toMatchObject({ provider: "caldav", displayName: "My Radicale", itemType: CalendarSourceItemType.CalDavCalendar });
    expect(bind.json.calendars).toHaveLength(1);
    expect(bind.json.calendars[0]).toMatchObject({ name: "Family", color: "#34c759ff", readOnly: true });
    expect(JSON.stringify(bind.json)).not.toContain("app-pass-123");

    const evs = await m.call("POST", `/api/v4/calendar/bind/events/${bind.json.id}`, { begin: utc(2026, 5, 1), end: utc(2026, 5, 20) });
    expect(evs.status).toBe(200);
    expect(evs.json).toHaveLength(2);
    expect(evs.json[0]).toMatchObject({ title: "Dinner", readOnly: true, start: utc(2026, 5, 10, 16, 0) });
    expect(evs.json[1]).toMatchObject({ title: "Late Dinner", readOnly: true, start: utc(2026, 5, 12, 17, 30) });
    expect(dav.requests.some((r) => r.method === "REPORT" && r.body.includes("<C:time-range"))).toBe(true);
  });

  test("rejects wrong CalDAV password with 401 caldav_auth_failed and enforces read-only", async () => {
    const dav = makeMockCalDavServer();
    const base = await dav.start();
    const m = mk();

    const bad = await m.call("POST", "/api/v4/calendar/bind", { serverAddress: `${base}/`, account: "alice", password: "wrong" });
    expect(bad.status).toBe(401);
    expect(bad.json.errorCode).toBe("caldav_auth_failed");

    const ok = await m.call("POST", "/api/v4/calendar/bind/icloud", { serverUrl: `${base}/direct/`, account: "alice", password: "app-pass-123" });
    expect(ok.status).toBe(200);
    expect(ok.json.provider).toBe("icloud");
    expect(ok.json.itemType).toBe(CalendarSourceItemType.ICloudCalendar);

    // Read-only enforcement
    const createCal = await m.call("POST", `/api/v2/calendar/${ok.json.id}/create`, { calendarName: "No" });
    expect(createCal.status).toBe(400);
    expect(createCal.json.errorCode).toBe("read_only_provider");

    const writeEv = await m.call("POST", `/api/v2/calendar/accounts/${ok.json.id}/events`, {
      calendarId: `${base}/direct/`,
      title: "Nope",
      start: utc(2026, 5, 10, 9, 0),
    });
    expect(writeEv.status).toBe(400);
    expect(writeEv.json.errorCode).toBe("read_only_provider");

    const support = await m.call("GET", "/api/v4/calendar/icloud/support/url");
    expect(support.status).toBe(200);
    expect(support.json.url).toContain("apple.com");
  });
});

// ------------------------------------------------------------------ 6. Unified GET /api/v2/calendar/events

describe("unified GET /api/v2/calendar/events across all sources", () => {
  test("aggregates tasks, repeat occurrences, checklist items, ICS URL, holiday, OAuth, and CalDAV in window with expected wire shape", async () => {
    const feedUrl = await startHttpServer((req, _body, res) => {
      res.setHeader("Content-Type", "text/calendar");
      if (req.url === "/url.ics") {
        return res.end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u-1\r\nDTSTART:20260510T110000Z\r\nDTEND:20260510T120000Z\r\nSUMMARY:URL Event\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:u-dec\r\nDTSTART:20260510T130000Z\r\nDTEND:20260510T140000Z\r\nSUMMARY:Declined URL\r\nATTENDEE;PARTSTAT=DECLINED:mailto:a@b.c\r\nEND:VEVENT\r\nEND:VCALENDAR");
      }
      return res.end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:hol-1\r\nDTSTART;VALUE=DATE:20260514\r\nDTEND;VALUE=DATE:20260515\r\nSUMMARY:Ascension Day\r\nEND:VEVENT\r\nEND:VCALENDAR");
    });

    const m = mk({ now: () => utc(2026, 5, 10, 8, 0) });
    const proj = await seedProject(m.call, { name: "Sprint", color: "#9933ff" });
    await m.call("POST", "/api/v2/batch/task", {
      add: [
        task({
          id: "t-open",
          projectId: proj,
          title: "Daily Task",
          startDate: "2026-05-10T09:00:00.000+0000",
          dueDate: "2026-05-10T09:45:00.000+0000",
          isAllDay: false,
          repeatFlag: "RRULE:FREQ=DAILY;COUNT=2",
          items: [{ id: "sub1", title: "Dated Subtask", status: 0, sortOrder: 0, startDate: "2026-05-10T15:00:00.000+0000", isAllDay: false }],
        }),
        task({
          id: "t-done",
          projectId: proj,
          title: "Done Task",
          status: TaskStatus.Completed,
          startDate: "2026-05-10T08:00:00.000+0000",
          isAllDay: false,
        }),
      ],
    });

    await m.call("POST", "/api/v2/calendar/subscribe", { url: `${feedUrl}/url.ics`, name: "My Feed", color: "#00aa00" });
    await m.call("POST", "/api/v2/calendar/subscribe", { url: `${feedUrl}/hol.ics`, kind: "holiday", presetId: "nl", name: "NL Holidays" });

    // Enable checklist & hide completed via settings
    await m.call("PUT", "/api/v2/user/preferences/settings", {
      calendarViewConf: { showCompleted: false, showChecklist: true, showFutureTask: true, showDeclinedEvents: false },
    });

    const unified = await m.call("GET", `/api/v2/calendar/events?from=${utc(2026, 5, 10)}&to=${utc(2026, 5, 16)}`);
    expect(unified.status).toBe(200);
    const items = unified.json as Array<Record<string, any>>;

    // Declined URL event and completed task are filtered out
    expect(items.map((x) => x.title)).toEqual([
      "Daily Task",
      "URL Event",
      "Dated Subtask",
      "Daily Task",
      "Ascension Day",
    ]);

    // Verify client wire shape fields
    expect(items[0]).toMatchObject({
      key: "t-open",
      kind: CalendarItemKind.Task,
      taskId: "t-open",
      projectId: proj,
      color: "#9933ff",
      allDay: false,
      isAllDay: false,
      completed: false,
      readOnly: false,
    });
    expect(typeof items[0]!.dueStart).toBe("string");
    expect(typeof items[0]!.dueEnd).toBe("string");
    expect(items[1]).toMatchObject({ kind: CalendarItemKind.Subscribe, sourceType: "url", itemType: CalendarSourceItemType.UrlCalendar, readOnly: true });
    expect(items[2]).toMatchObject({ kind: CalendarItemKind.Subtask, itemId: "sub1" });
    expect(items[3]).toMatchObject({ kind: CalendarItemKind.Repeat, isRecurring: true });
    expect(items[4]).toMatchObject({ kind: CalendarItemKind.Subscribe, sourceType: "holiday", allDay: true });

    // Source filtering and showDeclined override
    const onlyUrlWithDeclined = await m.call(
      "GET",
      `/api/v2/calendar/events?from=${utc(2026, 5, 10)}&to=${utc(2026, 5, 16)}&sources=subscriptions&showDeclined=true`,
    );
    expect((onlyUrlWithDeclined.json as Array<{ title: string }>).map((e) => e.title)).toEqual(["URL Event", "Declined URL"]);

    // Archive hides an event
    const firstUrlId = (onlyUrlWithDeclined.json as Array<{ id: string }>)[0]!.id;
    await m.call("POST", "/api/v2/calendar/archivedEvent", { id: firstUrlId });
    const afterArchive = await m.call("GET", `/api/v2/calendar/events?from=${utc(2026, 5, 10)}&to=${utc(2026, 5, 16)}&sources=subscriptions`);
    expect(afterArchive.json).toEqual([]);

    // Invalid date range -> 400
    const badRange = await m.call("GET", `/api/v2/calendar/events?from=${utc(2026, 5, 20)}&to=${utc(2026, 5, 10)}`);
    expect(badRange.status).toBe(400);
    expect(badRange.json.errorCode).toBe("invalid_date_range");
  });

  test("deduplicates two-way linked Google events in unified GET so linked task does not render twice", async () => {
    let calHit = false;
    const gBase = await startHttpServer((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/oauth/token")) return res.end(JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }));
      if (req.url?.startsWith("/userinfo")) return res.end(JSON.stringify({ email: "user@example.com", name: "T" }));
      if (req.url?.startsWith("/calendar/v3/users/me/calendarList")) return res.end(JSON.stringify({ items: [{ id: "primary", summary: "GCal", primary: true, accessRole: "owner", selected: true }] }));
      if (req.url?.startsWith("/calendar/v3/calendars/primary/events")) {
        calHit = true;
        return res.end(
          JSON.stringify({
            items: [
              { id: "g-linked", etag: '"e1"', summary: "Linked Meeting", start: { dateTime: "2026-05-12T10:00:00Z" }, end: { dateTime: "2026-05-12T11:00:00Z" } },
              { id: "g-unlinked", etag: '"e2"', summary: "Other Meeting", start: { dateTime: "2026-05-13T10:00:00Z" }, end: { dateTime: "2026-05-13T11:00:00Z" } },
            ],
          }),
        );
      }
      res.statusCode = 404;
      res.end("{}");
    });

    const m = mk({
      now: () => utc(2026, 5, 10),
      calendarOAuth: {
        google: { clientId: "c", clientSecret: "s", authUrl: `${gBase}/oauth/auth`, tokenUrl: `${gBase}/oauth/token`, userInfoUrl: `${gBase}/userinfo`, apiBaseUrl: `${gBase}/calendar/v3`, scopes: ["cal"] },
      },
    });
    const st = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const acc = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=c&state=${st.state}`)).json;
    await m.call("POST", `/api/v2/calendar/${acc.id}/bind/project`, { calendarId: "primary", syncProjectScope: "project", syncProjectId: m.svc.inboxId, defaultTags: [] });
    await m.call("POST", `/api/v2/calendar/accounts/${acc.id}/sync?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);

    // Now delete/unlink only g-unlinked link so g-linked is linked to a live task and g-unlinked is not
    m.store.run("delete from calendar_event_task_links where externalEventId = 'g-unlinked'");
    m.store.run("delete from tasks where json_extract(json, '$.title') = 'Other Meeting'");

    const unified = await m.call("GET", `/api/v2/calendar/events?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(calHit).toBe(true);
    const titles = (unified.json as Array<{ title: string }>).map((e) => e.title);
    expect(titles).toEqual(["Linked Meeting", "Other Meeting"]);
  });
});

// ------------------------------------------------------------------ 7. Extended Edge Cases, Aliases & Error Paths

describe("calendar extended edge cases, route aliases, and error paths", () => {
  test("explicit subscription id upserts and alias update routes mutate metadata", async () => {
    const m = mk();
    const s1 = await m.call("POST", "/api/v2/calendar/subscribe", { id: "custom-sub", url: "https://example.com/v1.ics", name: "V1", color: "#111" });
    expect(s1.status).toBe(200);

    const s2 = await m.call("POST", "/api/v2/calendar/subscribe", { id: "custom-sub", url: "https://example.com/v2.ics", name: "V2" });
    expect(s2.status).toBe(200);
    expect((await m.call("GET", "/api/v2/calendar/subscription")).json).toHaveLength(1);

    const patchRes = await m.call("PATCH", "/api/v2/calendar/subscription/custom-sub", { name: "V2 Patch" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.json.name).toBe("V2 Patch");

    const putAlias = await m.call("PUT", "/api/v2/calendar/subscribe/custom-sub", { color: "#222" });
    expect(putAlias.status).toBe(200);
    expect(putAlias.json.color).toBe("#222");

    const postV2 = await m.call("POST", "/api/v2/calendar/update/custom-sub", { name: "V2 Post" });
    expect(postV2.status).toBe(200);
    expect(postV2.json.name).toBe("V2 Post");

    const postV4 = await m.call("POST", "/api/v4/calendar/update/custom-sub", { color: "#333" });
    expect(postV4.status).toBe(200);
    expect(postV4.json).toMatchObject({ name: "V2 Post", color: "#333" });
  });

  test("batch/:id/show supports ?show query, hidden body flag, and 404 on unknown id", async () => {
    const m = mk();
    const sub = (await m.call("POST", "/api/v2/calendar/subscribe", { url: "https://example.com/a.ics", name: "A" })).json;

    const qHide = await m.call("PUT", `/api/v2/calendar/batch/${sub.id}/show?show=false`, {});
    expect(qHide.status).toBe(200);
    expect(qHide.json).toMatchObject({ show: false, hidden: true });

    const bShow = await m.call("PUT", `/api/v2/calendar/batch/${sub.id}/show`, { hidden: false });
    expect(bShow.status).toBe(200);
    expect(bShow.json).toMatchObject({ show: true, hidden: false });

    const missing = await m.call("PUT", "/api/v2/calendar/batch/does-not-exist/show", { show: false });
    expect(missing.status).toBe(404);
    expect(missing.json.errorCode).toBe("calendar_not_found");
  });

  test("sortOrder supports orders array and map shapes; unsubscribe reports NOT_EXISTED", async () => {
    const m = mk();
    const a = (await m.call("POST", "/api/v2/calendar/subscribe", { url: "https://example.com/a.ics", name: "A" })).json;
    const b = (await m.call("POST", "/api/v2/calendar/subscribe", { url: "https://example.com/b.ics", name: "B" })).json;

    const rOrders = await m.call("POST", "/api/v2/calendar/subscribe/sortOrder", { orders: [{ id: b.id, sortOrder: 1 }, { id: a.id, sortOrder: 5 }] });
    expect(rOrders.status).toBe(200);
    expect((rOrders.json as Array<{ id: string }>).map((x) => x.id)).toEqual([b.id, a.id]);

    const rMap = await m.call("POST", "/api/v2/calendar/subscribe/sortOrder", { sortOrder: { [a.id]: 0, [b.id]: 9 } });
    expect(rMap.status).toBe(200);
    expect((rMap.json as Array<{ id: string }>).map((x) => x.id)).toEqual([a.id, b.id]);

    const delRes = await m.call("DELETE", "/api/v2/calendar/unsubscribe", { ids: [a.id, "missing-sub"] });
    expect(delRes.status).toBe(200);
    expect(delRes.json.deleted).toEqual([a.id]);
    expect(delRes.json.id2error).toEqual({ "missing-sub": "NOT_EXISTED" });
  });

  test("subscribe/events/:id returns 404, 502 on uncached HTTP 500 or non-ICS, and ?refresh=true falls back to cache while recording errors", async () => {
    let calls = 0;
    let mode: "ok" | "http500" | "html" = "ok";
    const url = await startHttpServer((req, _body, res) => {
      calls++;
      if (mode === "http500" || req.url === "/err500.ics") {
        res.statusCode = 500;
        return res.end("upstream down");
      }
      if (mode === "html" || req.url === "/html.ics") {
        res.setHeader("Content-Type", "text/html");
        return res.end("<html>not calendar</html>");
      }
      res.setHeader("Content-Type", "text/calendar");
      return res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260510T100000Z\r\nDTEND:20260510T110000Z\r\nSUMMARY:Hit ${calls}\r\nEND:VEVENT\r\nEND:VCALENDAR`);
    });

    const baseUrl = url;
    const m = mk({ now: () => utc(2026, 5, 1) });
    expect((await m.call("GET", `/api/v2/calendar/subscribe/events/unknown-id?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`)).status).toBe(404);

    // Uncached 500 -> 502; uncached HTML -> 502 invalid_ics_payload
    const s500 = (await m.call("POST", "/api/v2/calendar/subscribe", { url: `${baseUrl}/err500.ics`, name: "S500" })).json;
    const bad500 = await m.call("GET", `/api/v2/calendar/subscribe/events/${s500.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(bad500.status).toBe(502);
    expect(bad500.json.errorCode).toBe("calendar_fetch_failed");

    const sHtml = (await m.call("POST", "/api/v2/calendar/subscribe", { url: `${baseUrl}/html.ics`, name: "SHtml" })).json;
    const badHtml = await m.call("GET", `/api/v2/calendar/subscribe/events/${sHtml.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(badHtml.status).toBe(502);
    expect(badHtml.json.errorCode).toBe("invalid_ics_payload");

    // Healthy feed supports ?refresh=true under 15m TTL, and falls back to stale cache if upstream fails later
    const sub = (await m.call("POST", "/api/v2/calendar/subscribe", { url: `${baseUrl}/good.ics`, name: "Refreshable" })).json;
    const first = await m.call("GET", `/api/v2/calendar/subscribe/events/${sub.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(first.status).toBe(200);
    expect(first.json[0].title).toBe("Hit 3");

    const forced = await m.call("GET", `/api/v2/calendar/subscribe/events/${sub.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}&refresh=true`);
    expect(forced.status).toBe(200);
    expect(forced.json[0].title).toBe("Hit 4");

    mode = "http500";
    const staleFallback = await m.call("GET", `/api/v2/calendar/subscribe/events/${sub.id}?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}&refresh=true`);
    expect(staleFallback.status).toBe(200);
    expect(staleFallback.json[0].title).toBe("Hit 4");
    const cacheMeta = await m.call("GET", `/api/v2/calendar/cache/${sub.id}`);
    expect(cacheMeta.status).toBe(200);
    expect(cacheMeta.json).toMatchObject({ status: 500, lastError: "HTTP 500" });
  });

  test("subscribe/events supports begin/end aliases, rejects invalid date range, and isolates per-feed failure", async () => {
    const base = await startHttpServer((req, _body, res) => {
      if (req.url === "/broken.ics") {
        res.statusCode = 502;
        return res.end("bad gateway");
      }
      res.setHeader("Content-Type", "text/calendar");
      return res.end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ok1\r\nDTSTART:20260512T100000Z\r\nDTEND:20260512T110000Z\r\nSUMMARY:Healthy Feed\r\nEND:VEVENT\r\nEND:VCALENDAR");
    });

    const m = mk({ now: () => utc(2026, 5, 1) });
    await m.call("POST", "/api/v2/calendar/subscribe", { url: `${base}/ok.ics`, name: "Good" });
    await m.call("POST", "/api/v2/calendar/subscribe", { url: `${base}/broken.ics`, name: "Broken" });

    const badRange = await m.call("GET", `/api/v2/calendar/subscribe/events?begin=${utc(2026, 5, 20)}&end=${utc(2026, 5, 10)}`);
    expect(badRange.status).toBe(400);
    expect(badRange.json.errorCode).toBe("invalid_date_range");

    const ok = await m.call("GET", `/api/v2/calendar/subscribe/events?begin=${utc(2026, 5, 1)}&end=${utc(2026, 5, 31)}`);
    expect(ok.status).toBe(200);
    expect((ok.json as Array<{ title: string }>).map((e) => e.title)).toEqual(["Healthy Feed"]);
  });

  test("holiday preset subscription supports case-insensitive holidayCode for uk, us, be, islamic", async () => {
    const m = mk();
    for (const [code, expectedId] of [["UK", "uk"], ["US", "us"], ["BE", "be"], ["ISLAMIC", "islamic"]] as const) {
      const res = await m.call("POST", "/api/v2/calendar/holiday/subscribe", { holidayCode: code });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ kind: "holiday", presetId: expectedId });
    }
    const unk = await m.call("POST", "/api/v2/calendar/holiday/subscribe", { holidayCode: "atlantis" });
    expect(unk.status).toBe(400);
    expect(unk.json.errorCode).toBe("unknown_holiday_preset");
  });

  test("outgoing feed enforces .ics extension and returns 404 on missing feed settings or wrong cancel token when active", async () => {
    const m = mk();
    expect((await m.app.inject({ method: "GET", url: `/feed/${"a".repeat(48)}` })).statusCode).toBe(404);
    expect((await m.call("PUT", "/api/v2/calendar/feeds/settings", { includeDone: true })).status).toBe(404);
    const idempotent = await m.call("DELETE", "/api/v2/calendar/feeds/cancel/wrong-token");
    expect(idempotent.status).toBe(200);
    expect(idempotent.json).toEqual({ cancelled: false });

    await m.call("POST", "/api/v2/calendar/feeds/code/new/default", {});
    const mismatchCancel = await m.call("DELETE", "/api/v2/calendar/feeds/cancel/wrong-token");
    expect(mismatchCancel.status).toBe(404);
    expect(mismatchCancel.json.errorCode).toBe("feed_not_found");
  });

  test("outgoing feed preserves settings on token reset, emits no-cache header, includes checklists, and skips deleted tasks", async () => {
    const m = mk({ now: () => utc(2026, 5, 1) });
    await m.call("POST", "/api/v2/batch/task", {
      add: [
        task({
          id: "live-t",
          projectId: m.svc.inboxId,
          title: "Live Task",
          startDate: "2026-05-10T10:00:00.000+0000",
          dueDate: "2026-05-10T11:00:00.000+0000",
          isAllDay: false,
          tags: ["focus"],
          items: [{ id: "c1", title: "Step 1", status: 0, sortOrder: 0 }],
        }),
        task({ id: "del-t", projectId: m.svc.inboxId, title: "Deleted Task", startDate: "2026-05-11T10:00:00.000+0000", isAllDay: true }),
      ],
    });
    await m.call("POST", "/api/v2/batch/task", { delete: [{ taskId: "del-t", projectId: m.svc.inboxId }] });

    await m.call("POST", "/api/v2/calendar/feeds/code/new/default", {});
    const upd = await m.call("PUT", "/api/v2/calendar/feeds/settings", { includeDone: true, includeHabits: false });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject({ includeDone: true, includeHabits: false });

    const reset = (await m.call("POST", "/api/v2/calendar/feeds/code/new", {})).json;
    expect(reset.includeDone).toBe(true);
    expect(reset.includeHabits).toBe(false);

    const feedRes = await m.app.inject({ method: "GET", url: reset.url });
    expect(feedRes.statusCode).toBe(200);
    expect(feedRes.headers["cache-control"]).toContain("no-cache");
    expect(feedRes.body).toContain("Step 1");
    expect(feedRes.body).not.toContain("Deleted Task");
  });

  test("outgoing feed supports multiple projectIds including inbox alias", async () => {
    const m = mk({ now: () => utc(2026, 5, 1) });
    const pWork = await seedProject(m.call, { name: "Work" });
    const pPlay = await seedProject(m.call, { name: "Play" });
    await m.call("POST", "/api/v2/batch/task", {
      add: [
        task({ id: "t-in", projectId: m.svc.inboxId, title: "Inbox Item", startDate: "2026-05-10T00:00:00.000+0000", isAllDay: true }),
        task({ id: "t-wk", projectId: pWork, title: "Work Item", startDate: "2026-05-11T00:00:00.000+0000", isAllDay: true }),
        task({ id: "t-pl", projectId: pPlay, title: "Play Item", startDate: "2026-05-12T00:00:00.000+0000", isAllDay: true }),
      ],
    });
    const feed = (await m.call("POST", "/api/v2/calendar/feeds/code/new/default", { projectIds: ["inbox", pWork] })).json;
    const res = await m.app.inject({ method: "GET", url: feed.url });
    const titles = Object.values(ical.sync.parseICS(res.body))
      .filter((v): v is VEvent => Boolean(v && v.type === "VEVENT"))
      .map((v) => String(v.summary))
      .sort();
    expect(titles).toEqual(["Inbox Item", "Work Item"]);
  });

  test("loadCalendarOAuthConfig handles valid JSON, missing file, and malformed JSON", () => {
    const dir = tmp();
    cleanDirs.push(dir);
    expect(() => loadCalendarOAuthConfig(join(dir, "nope.json"))).toThrow();

    const badJsonPath = join(dir, "bad.json");
    writeFileSync(badJsonPath, "{not-valid-json");
    expect(() => loadCalendarOAuthConfig(badJsonPath)).toThrow();

    const validPath = join(dir, "ok.json");
    writeFileSync(validPath, JSON.stringify({ google: { clientId: "env-id", clientSecret: "env-sec" } }));
    const cfg = loadCalendarOAuthConfig(validPath);
    expect(cfg.google?.clientId).toBe("env-id");
  });

  test("OAuth start/bind reject unsupported provider and missing query parameters", async () => {
    const m = mk();
    const badStart = await m.call("GET", "/api/v2/calendar/oauth/yahoo/start");
    expect(badStart.status).toBe(400);
    expect(badStart.json.errorCode).toBe("unsupported_provider");

    const badBind = await m.call("GET", "/api/v3/calendar/bind");
    expect(badBind.status).toBe(400);
    expect(badBind.json.errorCode).toBe("missing_state_or_provider");
  });

  test("OAuth callback rejects missing params, expired state, provider mismatch, and 502 on token HTTP 500", async () => {
    const base = await startHttpServer((req, _body, res) => {
      if (req.url === "/oauth/token") {
        res.statusCode = 500;
        return res.end("token service crashed");
      }
      res.statusCode = 404;
      res.end();
    });

    let nowMs = utc(2026, 5, 1, 12, 0);
    const m = mk({
      now: () => nowMs,
      calendarOAuth: {
        google: { clientId: "cid", clientSecret: "sec", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth/token`, apiBaseUrl: `${base}/cal`, scopes: ["cal"] },
        outlook: { clientId: "mcid", clientSecret: "msec", authUrl: `${base}/mauth`, tokenUrl: `${base}/oauth/token`, apiBaseUrl: `${base}/ms`, scopes: ["cal"] },
      },
    });

    const missing = await m.call("GET", "/api/v2/calendar/oauth/google/callback?code=only-code");
    expect(missing.status).toBe(400);
    expect(missing.json.errorCode).toBe("invalid_oauth_callback");

    const st1 = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const mismatch = await m.call("GET", `/api/v2/calendar/oauth/outlook/callback?code=ok&state=${st1.state}`);
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.errorCode).toBe("invalid_oauth_state");

    // Same valid state expires after >15 minutes
    nowMs += 16 * 60_000;
    const expired = await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=ok&state=${st1.state}`);
    expect(expired.status).toBe(400);
    expect(expired.json.errorCode).toBe("invalid_oauth_state");

    // Token endpoint 500 -> 502
    const st2 = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const tokErr = await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=ok&state=${st2.state}`);
    expect(tokErr.status).toBe(502);
    expect(tokErr.json.errorCode).toBe("oauth_token_exchange_failed");
  });

  test("OAuth callback supports a local redirectAfter and the configured redirectUri", async () => {
    let seenRedirectUri = "";
    const base = await startHttpServer((req, body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") {
        seenRedirectUri = new URLSearchParams(body).get("redirect_uri") ?? "";
        return res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      }
      if (req.url === "/userinfo") return res.end(JSON.stringify({ email: "r@example.com" }));
      if (req.url === "/calendar/v3/users/me/calendarList") return res.end(JSON.stringify({ items: [{ id: "primary", summary: "Main", primary: true }] }));
      res.statusCode = 404;
      res.end("{}");
    });

    const m = mk({
      calendarOAuth: {
        google: { clientId: "c", clientSecret: "s", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth/token`, userInfoUrl: `${base}/userinfo`, apiBaseUrl: `${base}/calendar/v3`, scopes: ["cal"] },
      },
    });
    const st = (await m.call("GET", "/api/v2/calendar/oauth/google/start?redirectAfter=/settings")).json;
    const cbRes = await m.app.inject({ method: "GET", url: `/api/v2/calendar/oauth/google/callback?code=abc&state=${st.state}&redirect=true` });
    expect(cbRes.statusCode).toBe(302);
    expect(cbRes.headers.location).toBe("/settings");
    expect(seenRedirectUri).toBe("http://localhost:80/api/v2/calendar/oauth/google/callback");
  });

  test("OAuth explicit refresh validates missing accountId, CalDAV provider, unknown id, and missing refresh token", async () => {
    const base = await startHttpServer((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") return res.end(JSON.stringify({ access_token: "at-only", expires_in: 3600 }));
      if (req.url === "/userinfo") return res.end(JSON.stringify({ email: "noref@example.com" }));
      if (req.url === "/calendar/v3/users/me/calendarList") return res.end(JSON.stringify({ items: [] }));
      if (req.method === "PROPFIND") {
        res.statusCode = 207;
        res.setHeader("Content-Type", "application/xml");
        return res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/c/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>CD</D:displayname></D:prop></D:propstat></D:response></D:multistatus>');
      }
      res.statusCode = 404;
      res.end();
    });

    const m = mk({
      calendarOAuth: {
        google: { clientId: "c", clientSecret: "s", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth/token`, userInfoUrl: `${base}/userinfo`, apiBaseUrl: `${base}/calendar/v3`, scopes: ["cal"] },
      },
    });
    expect((await m.call("POST", "/api/v2/calendar/oauth/google/refresh", {})).json.errorCode).toBe("missing_account_id");
    expect((await m.call("POST", "/api/v2/calendar/oauth/google/refresh", { accountId: "nope" })).status).toBe(404);

    const caldav = (await m.call("POST", "/api/v4/calendar/bind", { serverUrl: `${base}/c/`, username: "u", password: "p" })).json;
    const wrongProv = await m.call("POST", "/api/v2/calendar/oauth/google/refresh", { accountId: caldav.id });
    expect(wrongProv.status).toBe(400);
    expect(wrongProv.json.errorCode).toBe("provider_does_not_use_oauth");

    const st = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const gAcc = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=c&state=${st.state}`)).json;
    const noRef = await m.call("POST", `/api/v2/calendar/accounts/${gAcc.id}/refresh`);
    expect(noRef.status).toBe(401);
    expect(noRef.json.errorCode).toBe("oauth_token_revoked");
  });

  test("OAuth disconnect & connect/:id delete cleanly even when remote revoke returns 500", async () => {
    const base = await startHttpServer((req, _body, res) => {
      if (req.url?.startsWith("/oauth/revoke")) {
        res.statusCode = 500;
        return res.end("revoke failed");
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") return res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      if (req.url === "/userinfo") return res.end(JSON.stringify({ email: "d@example.com" }));
      if (req.url === "/calendar/v3/users/me/calendarList") return res.end(JSON.stringify({ items: [{ id: "primary", summary: "Main" }] }));
      res.statusCode = 404;
      res.end();
    });

    const m = mk({
      calendarOAuth: {
        google: { clientId: "c", clientSecret: "s", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth/token`, revokeUrl: `${base}/oauth/revoke`, userInfoUrl: `${base}/userinfo`, apiBaseUrl: `${base}/calendar/v3`, scopes: ["cal"] },
      },
    });
    const st1 = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const a1 = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=c&state=${st1.state}`)).json;
    const d1 = await m.call("POST", "/api/v2/calendar/oauth/google/disconnect", { accountId: a1.id });
    expect(d1.status).toBe(200);
    expect((await m.call("GET", "/api/v2/calendar/third/accounts")).json).toEqual([]);

    const st2 = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const a2 = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=c&state=${st2.state}`)).json;
    const d2 = await m.call("DELETE", `/api/v2/calendar/connect/${a2.id}`);
    expect(d2.status).toBe(200);
    expect((await m.call("DELETE", `/api/v2/calendar/connect/${a2.id}`)).status).toBe(404);
  });

  test("account create calendar & direct event mutations validate names, date ranges, and read-only CalDAV", async () => {
    const base = await startHttpServer((req, body, res) => {
      if (req.method === "PROPFIND") {
        res.statusCode = 207;
        res.setHeader("Content-Type", "application/xml");
        return res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/c/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>CD</D:displayname></D:prop></D:propstat></D:response></D:multistatus>');
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth2/token") return res.end(JSON.stringify({ access_token: "ms-at", refresh_token: "ms-rt", expires_in: 3600 }));
      if (req.url === "/v1.0/me") return res.end(JSON.stringify({ userPrincipalName: "user@example.com" }));
      if (req.url === "/v1.0/me/calendars" && req.method === "GET") return res.end(JSON.stringify({ value: [{ id: "ms-1", name: "Calendar", isDefaultCalendar: true, canEdit: true }] }));
      if (req.url === "/v1.0/me/calendars" && req.method === "POST") {
        const b = JSON.parse(body);
        return res.end(JSON.stringify({ id: "ms-2", name: b.name, canEdit: true }));
      }
      res.statusCode = 404;
      res.end();
    });

    const m = mk({
      calendarOAuth: {
        outlook: { clientId: "c", clientSecret: "s", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth2/token`, userInfoUrl: `${base}/v1.0/me`, apiBaseUrl: `${base}/v1.0`, scopes: ["cal"] },
      },
    });
    const cd = (await m.call("POST", "/api/v4/calendar/bind", { serverUrl: `${base}/c/`, username: "u", password: "p" })).json;
    expect((await m.call("POST", `/api/v2/calendar/${cd.id}/create`, { calendarName: "X" })).json.errorCode).toBe("read_only_provider");
    expect((await m.call("POST", `/api/v2/calendar/accounts/${cd.id}/events`, { calendarId: "/c/", title: "X", start: 1000, end: 2000 })).json.errorCode).toBe("read_only_provider");

    const st = (await m.call("GET", "/api/v2/calendar/oauth/outlook/start")).json;
    const msAcc = (await m.call("GET", `/api/v2/calendar/oauth/outlook/callback?code=c&state=${st.state}`)).json;
    expect((await m.call("POST", `/api/v2/calendar/${msAcc.id}/create`, { calendarName: "   " })).json.errorCode).toBe("invalid_calendar_name");

    const createdCal = await m.call("POST", `/api/v2/calendar/${msAcc.id}/create`, { calendarName: "Focus Blocks" });
    expect(createdCal.status).toBe(200);
    expect(createdCal.json.name).toBe("Focus Blocks");

    const badEv = await m.call("POST", `/api/v2/calendar/accounts/${msAcc.id}/events`, { calendarId: "ms-1", title: "Bad", start: 2000, end: 1000 });
    expect(badEv.status).toBe(400);
    expect(badEv.json.errorCode).toBe("invalid_date_range");
  });

  test("iCloud support URL and CalDAV credential update validate Basic auth and return 401/404 properly", async () => {
    let acceptedPass = "pass-1";
    const base = await startHttpServer((req, _body, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from(`bob:${acceptedPass}`).toString("base64")}`) {
        res.statusCode = 401;
        return res.end("Unauthorized");
      }
      if (req.method === "PROPFIND") {
        res.statusCode = 207;
        res.setHeader("Content-Type", "application/xml");
        return res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/cal/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>iCloud Work</D:displayname></D:prop></D:propstat></D:response></D:multistatus>');
      }
      res.statusCode = 404;
      res.end();
    });

    const m = mk();
    const sup = await m.call("GET", "/api/v4/calendar/icloud/support/url");
    expect(sup.status).toBe(200);
    expect(sup.json.url).toContain("apple.com");

    const bound = (await m.call("POST", "/api/v4/calendar/bind/icloud", { serverUrl: `${base}/cal/`, username: "bob", password: "pass-1" })).json;
    expect(bound.provider).toBe("icloud");

    acceptedPass = "pass-2";
    const badUpd = await m.call("POST", `/api/v4/calendar/update/icloud/${bound.id}`, { password: "wrong" });
    expect(badUpd.status).toBe(401);
    expect(badUpd.json.errorCode).toBe("caldav_auth_failed");

    const okUpd = await m.call("POST", `/api/v4/calendar/update/icloud/${bound.id}`, { password: "pass-2", displayName: "Updated iCloud" });
    expect(okUpd.status).toBe(200);
    expect(okUpd.json.displayName).toBe("Updated iCloud");

    expect((await m.call("POST", "/api/v4/calendar/update/icloud/missing", { password: "x" })).status).toBe(404);
  });

  test("CalDAV account deletion & batch/:id/show sub-calendar visibility toggle clean up cache", async () => {
    const base = await startHttpServer((req, _body, res) => {
      if (req.method === "PROPFIND") {
        res.statusCode = 207;
        res.setHeader("Content-Type", "application/xml");
        return res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/cal/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>CD</D:displayname></D:prop></D:propstat></D:response></D:multistatus>');
      }
      if (req.method === "REPORT") {
        res.statusCode = 207;
        res.setHeader("Content-Type", "application/xml");
        return res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/cal/e.ics</D:href><D:propstat><D:prop><D:getetag>"1"</D:getetag><C:calendar-data>BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:cd1\nDTSTART:20260512T100000Z\nDTEND:20260512T110000Z\nSUMMARY:CalDAV Visible\nEND:VEVENT\nEND:VCALENDAR</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>');
      }
      res.statusCode = 404;
      res.end();
    });

    const m = mk({ now: () => utc(2026, 5, 1) });
    const cd = (await m.call("POST", "/api/v4/calendar/bind", { serverUrl: `${base}/cal/`, username: "u", password: "p" })).json;

    const vis1 = await m.call("GET", `/api/v2/calendar/events?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect((vis1.json as Array<{ title: string }>).map((e) => e.title)).toEqual(["CalDAV Visible"]);

    // Hide sub-calendar via batch/:id/show with actual calendarId URL
    const hideSub = await m.call("PUT", `/api/v2/calendar/batch/${cd.id}/show`, { calendarId: cd.calendars[0].id, show: false });
    expect(hideSub.status).toBe(200);
    const vis2 = await m.call("GET", `/api/v2/calendar/events?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(vis2.json).toEqual([]);

    const del = await m.call("DELETE", `/api/v2/calendar/accounts/${cd.id}`);
    expect(del.status).toBe(200);
    expect((await m.call("GET", "/api/v2/calendar/third/accounts")).json).toEqual([]);
  });

  test("project binding endpoints validate unknown account, read-only provider, unknown project, missing ?id=, and 404 binding", async () => {
    const base = await startHttpServer((req, _body, res) => {
      if (req.method === "PROPFIND") {
        res.statusCode = 207;
        res.setHeader("Content-Type", "application/xml");
        return res.end('<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/c/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>RO</D:displayname></D:prop></D:propstat></D:response></D:multistatus>');
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") return res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      if (req.url === "/userinfo") return res.end(JSON.stringify({ email: "g@example.com" }));
      if (req.url === "/calendar/v3/users/me/calendarList") return res.end(JSON.stringify({ items: [{ id: "primary", summary: "Main" }] }));
      res.statusCode = 404;
      res.end();
    });

    const m = mk({
      calendarOAuth: {
        google: { clientId: "c", clientSecret: "s", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth/token`, userInfoUrl: `${base}/userinfo`, apiBaseUrl: `${base}/calendar/v3`, scopes: ["cal"] },
      },
    });
    expect((await m.call("POST", "/api/v2/calendar/missing-acc/bind/project", { calendarId: "primary", syncProjectScope: "all" })).status).toBe(404);

    const cd = (await m.call("POST", "/api/v4/calendar/bind", { serverUrl: `${base}/c/`, username: "u", password: "p" })).json;
    expect((await m.call("POST", `/api/v2/calendar/${cd.id}/bind/project`, { calendarId: "/c/", syncProjectScope: "all" })).json.errorCode).toBe("read_only_provider");

    const st = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const gAcc = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=c&state=${st.state}`)).json;

    const badProj = await m.call("POST", `/api/v2/calendar/${gAcc.id}/bind/project`, { calendarId: "primary", syncProjectScope: "project", syncProjectId: "no-such-project" });
    expect(badProj.status).toBe(404);
    expect(badProj.json.errorCode).toBe("project_not_found");

    const missId = await m.call("DELETE", `/api/v2/calendar/${gAcc.id}/bind/project`);
    expect(missId.status).toBe(400);
    expect(missId.json.errorCode).toBe("missing_binding_id");

    const badBind = await m.call("DELETE", `/api/v2/calendar/${gAcc.id}/bind/project?id=missing-bind`);
    expect(badBind.status).toBe(404);
    expect(badBind.json.errorCode).toBe("binding_not_found");
  });

  test("two-way sync in scope=all falls back unmatched events to inbox and cleans up when linked local task is trashed", async () => {
    const events: Array<Record<string, any>> = [
      { id: "g-unmatched", etag: '"e1"', summary: "Inbox Fallback Meeting", start: { dateTime: "2026-05-14T09:00:00Z" }, end: { dateTime: "2026-05-14T10:00:00Z" } },
    ];
    let deletedIds: string[] = [];
    const base = await startHttpServer((req, _body, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") return res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      if (req.url === "/userinfo") return res.end(JSON.stringify({ email: "g@example.com" }));
      if (req.url === "/calendar/v3/users/me/calendarList") return res.end(JSON.stringify({ items: [{ id: "primary", summary: "Main" }] }));
      if (req.method === "GET" && req.url?.startsWith("/calendar/v3/calendars/primary/events")) return res.end(JSON.stringify({ items: events }));
      if (req.method === "DELETE" && req.url?.startsWith("/calendar/v3/calendars/primary/events/")) {
        deletedIds.push(req.url.split("/").pop() ?? "");
        res.statusCode = 204;
        return res.end();
      }
      res.statusCode = 404;
      res.end();
    });

    const m = mk({
      now: () => utc(2026, 5, 1),
      calendarOAuth: {
        google: { clientId: "c", clientSecret: "s", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth/token`, userInfoUrl: `${base}/userinfo`, apiBaseUrl: `${base}/calendar/v3`, scopes: ["cal"] },
      },
    });
    const st = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    const gAcc = (await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=c&state=${st.state}`)).json;
    await m.call("POST", `/api/v2/calendar/${gAcc.id}/bind/project`, { calendarId: "primary", syncProjectScope: "all" });

    const s1 = await m.call("POST", `/api/v2/calendar/accounts/${gAcc.id}/sync?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(s1.json.pulled).toBe(1);
    const inboxTasks = (await m.call("GET", `/api/v2/project/${m.svc.inboxId}/tasks`)).json as Array<{ id: string; title: string; projectId: string }>;
    const imported = inboxTasks.find((t) => t.title === "Inbox Fallback Meeting");
    expect(imported).toBeDefined();

    // Delete local task -> next sync pushes deletion to remote
    await m.call("POST", "/api/v2/batch/task", { delete: [{ taskId: imported!.id, projectId: imported!.projectId }] });
    await m.call("POST", `/api/v2/calendar/accounts/${gAcc.id}/sync?from=${utc(2026, 5, 1)}&to=${utc(2026, 5, 31)}`);
    expect(deletedIds).toEqual(["g-unmatched"]);
  });

  test("unified GET /api/v2/calendar/events honors includeCompleted, includeChecklist=false, showRepeat=false, and showFutureTask=false", async () => {
    const m = mk({ now: () => utc(2026, 5, 10, 8, 0) });
    const proj = await seedProject(m.call, { name: "Focus" });
    await m.call("POST", "/api/v2/batch/task", {
      add: [
        task({
          id: "t-rep",
          projectId: proj,
          title: "Standup",
          startDate: "2026-05-10T09:00:00.000+0000",
          dueDate: "2026-05-10T09:30:00.000+0000",
          isAllDay: false,
          repeatFlag: "RRULE:FREQ=DAILY;COUNT=2",
          items: [{ id: "chk-1", title: "Prep notes", status: 0, sortOrder: 0, startDate: "2026-05-10T08:30:00.000+0000", isAllDay: false }],
        }),
        task({ id: "t-comp", projectId: proj, title: "Finished Item", status: TaskStatus.Completed, startDate: "2026-05-10T12:00:00.000+0000", isAllDay: false }),
        task({ id: "t-fut", projectId: proj, title: "Tomorrow Work", startDate: "2026-05-11T12:00:00.000+0000", isAllDay: false }),
      ],
    });

    const withAll = await m.call(
      "GET",
      `/api/v2/calendar/events?from=${utc(2026, 5, 10)}&to=${utc(2026, 5, 15)}&includeCompleted=true&includeChecklist=true&showRepeat=true&showFutureTask=true`,
    );
    expect((withAll.json as Array<{ title: string }>).map((x) => x.title)).toContain("Finished Item");
    expect((withAll.json as Array<{ title: string }>).map((x) => x.title)).toContain("Prep notes");

    const trimmed = await m.call(
      "GET",
      `/api/v2/calendar/events?from=${utc(2026, 5, 10)}&to=${utc(2026, 5, 15)}&includeCompleted=false&includeChecklist=false&showRepeat=false&showFutureTask=false`,
    );
    const trimmedTitles = (trimmed.json as Array<{ title: string }>).map((x) => x.title);
    expect(trimmedTitles).toEqual(["Standup"]);
  });

  test("unified GET /api/v2/calendar/events stays 200 and keeps healthy sources when an account is revoked or a feed fails", async () => {
    let googleInvalid = false;
    const base = await startHttpServer((req, _body, res) => {
      if (req.url === "/broken.ics") {
        res.statusCode = 500;
        return res.end("feed boom");
      }
      if (req.url === "/ok.ics") {
        res.setHeader("Content-Type", "text/calendar");
        return res.end("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20260512T100000Z\r\nDTEND:20260512T110000Z\r\nSUMMARY:Good Feed\r\nEND:VEVENT\r\nEND:VCALENDAR");
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/oauth/token") {
        if (googleInvalid) {
          res.statusCode = 400;
          return res.end(JSON.stringify({ error: "invalid_grant" }));
        }
        return res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }));
      }
      if (req.url === "/userinfo") return res.end(JSON.stringify({ email: "g@example.com" }));
      if (req.url === "/calendar/v3/users/me/calendarList") return res.end(JSON.stringify({ items: [{ id: "primary", summary: "Main" }] }));
      if (req.url?.startsWith("/calendar/v3/calendars/primary/events")) {
        if (googleInvalid) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ error: { code: 401 } }));
        }
        return res.end(JSON.stringify({ items: [] }));
      }
      res.statusCode = 404;
      res.end();
    });

    const m = mk({
      now: () => utc(2026, 5, 10),
      calendarOAuth: {
        google: { clientId: "c", clientSecret: "s", authUrl: `${base}/auth`, tokenUrl: `${base}/oauth/token`, userInfoUrl: `${base}/userinfo`, apiBaseUrl: `${base}/calendar/v3`, scopes: ["cal"] },
      },
    });
    await m.call("POST", "/api/v2/batch/task", {
      add: [task({ id: "t-ok", projectId: m.svc.inboxId, title: "Local Still Works", startDate: "2026-05-12T08:00:00.000+0000", isAllDay: false })],
    });
    await m.call("POST", "/api/v2/calendar/subscribe", { url: `${base}/ok.ics`, name: "Good" });
    await m.call("POST", "/api/v2/calendar/subscribe", { url: `${base}/broken.ics`, name: "Broken" });
    const st = (await m.call("GET", "/api/v2/calendar/oauth/google/start")).json;
    await m.call("GET", `/api/v2/calendar/oauth/google/callback?code=c&state=${st.state}`);

    googleInvalid = true;
    const unified = await m.call("GET", `/api/v2/calendar/events?from=${utc(2026, 5, 10)}&to=${utc(2026, 5, 15)}`);
    expect(unified.status).toBe(200);
    expect((unified.json as Array<{ title: string }>).map((e) => e.title)).toEqual(["Local Still Works", "Good Feed"]);
  });
});

