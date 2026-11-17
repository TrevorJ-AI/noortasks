import { createECDH, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { Agent as HttpsAgent, createServer as createHttpsServer, type Server } from "node:https";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { CONSTANT_REMINDER_CYCLE_MS, CONSTANT_REMINDER_FLAG, NotificationCategory, TaskStatus } from "@noortasks/core";
import { generateVAPIDKeys } from "web-push";
import { afterAll, describe, expect, test } from "vitest";
import { loadVapidKeys } from "../src/reminders.js";
import { hex, mk, task, tmp } from "./helpers.js";

const cleanDirs: string[] = [];
afterAll(() => {
  for (const d of cleanDirs) rmSync(d, { recursive: true, force: true });
});

function makeEnv(over?: Parameters<typeof mk>[0]) {
  const env = mk(over);
  const addTasks = async (rows: Array<Record<string, unknown>>) => {
    const res = await env.call("POST", "/api/v2/batch/task", {
      add: rows.map((r) => task({ projectId: env.svc.inboxId, ...r })),
    });
    expect(res.status).toBe(200);
    expect(res.json.id2error).toEqual({});
    return res;
  };
  return { ...env, addTasks };
}

function freshVapid() {
  const dir = tmp();
  cleanDirs.push(dir);
  const file = join(dir, "vapid.json");
  const keys = generateVAPIDKeys();
  writeFileSync(file, JSON.stringify({ ...keys, subject: "mailto:test@noortasks.local" }), { mode: 0o600 });
  return { dir, file, keys };
}

function makeClientSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const p256dh = ecdh.getPublicKey().toString("base64url");
  const auth = randomBytes(16).toString("base64url");
  return { endpoint, keys: { p256dh, auth } };
}

async function startMockHttpsPushServer(responder: (req: IncomingMessage, body: Buffer) => number) {
  const certDir = tmp();
  cleanDirs.push(certDir);
  const keyPath = join(certDir, "key.pem");
  const certPath = join(certDir, "cert.pem");
  const gen = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) throw new Error(`openssl failed: ${gen.stderr}`);
  const key = readFileSync(keyPath);
  const cert = readFileSync(certPath);

  const received: Array<{ url: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
  const server: Server = createHttpsServer({ key, cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      received.push({ url: req.url ?? "/", headers: req.headers, body: buf });
      const code = responder(req, buf);
      res.writeHead(code);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected address");
  const agent = new HttpsAgent({ ca: cert });
  return {
    url: `https://127.0.0.1:${addr.port}/push/sub1`,
    agent,
    received,
    close: async () => {
      agent.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("M5 reminders: computation, recurrence, habits, countdowns, daily summary", () => {
  test("one-off timed reminder computes exact UTC instant for non-UTC timezone", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "Asia/Tokyo" });
    // 2026-06-10 14:00:00 +09:00 = 2026-06-10T05:00:00Z
    const id = hex();
    await addTasks([
      {
        id,
        title: "Tokyo meeting",
        isAllDay: false,
        isFloating: false,
        timeZone: "Asia/Tokyo",
        startDate: "2026-06-10T05:00:00.000+0000",
        reminders: [
          { id: "r1", trigger: "TRIGGER:-PT15M" },
          { id: "r2", trigger: "TRIGGER:PT0S" },
        ],
      },
    ]);
    const fromMs = Date.parse("2026-06-10T04:00:00.000Z");
    const toMs = Date.parse("2026-06-10T06:00:00.000Z");
    const r = await call("GET", `/api/v2/reminder/instances?from=${fromMs}&to=${toMs}`);
    expect(r.status).toBe(200);
    expect(r.json).toHaveLength(2);
    expect(r.json.map((x: any) => x.fireAtMs)).toEqual([
      Date.parse("2026-06-10T04:45:00.000Z"),
      Date.parse("2026-06-10T05:00:00.000Z"),
    ]);
    expect(r.json[0].trigger).toBe("TRIGGER:-PT15M");
    expect(r.json[0].targetId).toBe(id);
  });

  test("floating task follows changing user timezone without altering stored timeZone", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "America/New_York" });
    const id = hex();
    // Created for 09:00 in America/New_York (-04:00 in June = 13:00Z)
    await addTasks([
      {
        id,
        title: "Floating call",
        isAllDay: false,
        isFloating: true,
        timeZone: "America/New_York",
        startDate: "2026-06-15T13:00:00.000+0000",
        reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }],
      },
    ]);
    const r1 = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-06-15T00:00:00Z")}&to=${Date.parse("2026-06-15T23:59:59Z")}`);
    expect(r1.json).toHaveLength(1);
    expect(r1.json[0].fireAtMs).toBe(Date.parse("2026-06-15T13:00:00.000Z"));

    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "America/Los_Angeles" });
    const r2 = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-06-15T00:00:00Z")}&to=${Date.parse("2026-06-15T23:59:59Z")}`);
    expect(r2.json).toHaveLength(1);
    expect(r2.json[0].fireAtMs).toBe(Date.parse("2026-06-15T16:00:00.000Z"));
  });

  test("all-day reminders: on-day 09:00, 00:00, and negative 1-3 days early 09:00", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await addTasks([
      {
        id: hex(),
        title: "All-day event",
        isAllDay: true,
        timeZone: "UTC",
        startDate: "2026-07-10T00:00:00.000+0000",
        reminders: [
          { id: "r0", trigger: "TRIGGER:PT0S" }, // 2026-07-10 00:00
          { id: "r9", trigger: "TRIGGER:PT540M" }, // 2026-07-10 09:00
          { id: "r1d", trigger: "TRIGGER:-P0DT15H0M0S" }, // 2026-07-09 09:00
          { id: "r2d", trigger: "TRIGGER:-P1DT15H0M0S" }, // 2026-07-08 09:00
          { id: "r3d", trigger: "TRIGGER:-P2DT15H0M0S" }, // 2026-07-07 09:00
        ],
      },
    ]);
    const fromMs = Date.parse("2026-07-07T00:00:00Z");
    const toMs = Date.parse("2026-07-10T23:59:59Z");
    const r = await call("GET", `/api/v2/reminder/instances?from=${fromMs}&to=${toMs}`);
    expect(r.json.map((x: any) => new Date(x.fireAtMs).toISOString())).toEqual([
      "2026-07-07T09:00:00.000Z",
      "2026-07-08T09:00:00.000Z",
      "2026-07-09T09:00:00.000Z",
      "2026-07-10T00:00:00.000Z",
      "2026-07-10T09:00:00.000Z",
    ]);
  });

  test("end-anchored reminder fires relative to dueDate, ignoring invalid trigger gracefully", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await addTasks([
      {
        id: hex(),
        title: "Bounded window",
        isAllDay: false,
        startDate: "2026-08-01T10:00:00.000+0000",
        dueDate: "2026-08-01T12:00:00.000+0000",
        reminders: [
          { id: "bad", trigger: "NOT_A_TRIGGER" },
          { id: "end", trigger: "TRIGGER:-PT30M", isBeforeStart: false },
          { id: "end2", trigger: "TRIGGER;RELATED=END:-PT15M" },
        ],
      },
    ]);
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-08-01T09:00:00Z")}&to=${Date.parse("2026-08-01T13:00:00Z")}`);
    expect(r.json.map((x: any) => x.fireAtMs)).toEqual([
      Date.parse("2026-08-01T11:30:00.000Z"),
      Date.parse("2026-08-01T11:45:00.000Z"),
    ]);
  });

  test("DST spring-forward and fall-back preserve local 09:00 wall clock for all-day reminders", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "America/New_York" });
    // Spring forward 2026-03-08 (UTC-4 => 13:00Z), Fall back 2026-11-01 (UTC-5 => 14:00Z)
    await addTasks([
      {
        id: hex(),
        title: "Spring DST",
        isAllDay: true,
        timeZone: "America/New_York",
        startDate: "2026-03-08T05:00:00.000+0000",
        reminders: [{ id: "rs", trigger: "TRIGGER:PT540M" }],
      },
      {
        id: hex(),
        title: "Fall DST",
        isAllDay: true,
        timeZone: "America/New_York",
        startDate: "2026-11-01T04:00:00.000+0000",
        reminders: [{ id: "rf", trigger: "TRIGGER:PT540M" }],
      },
    ]);
    const spring = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-03-08T10:00:00Z")}&to=${Date.parse("2026-03-08T16:00:00Z")}`);
    expect(spring.json).toHaveLength(1);
    expect(new Date(spring.json[0].fireAtMs).toISOString()).toBe("2026-03-08T13:00:00.000Z");

    const fall = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-01T10:00:00Z")}&to=${Date.parse("2026-11-01T16:00:00Z")}`);
    expect(fall.json).toHaveLength(1);
    expect(new Date(fall.json[0].fireAtMs).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  test("completed, wont-do, and trashed tasks emit no reminder instances", async () => {
    const { call, svc, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const base = {
      isAllDay: false,
      startDate: "2026-09-01T10:00:00.000+0000",
      reminders: [{ id: "r", trigger: "TRIGGER:PT0S" }],
    };
    const trashedId = hex();
    await addTasks([
      { ...base, id: hex(), status: TaskStatus.Completed, title: "done" },
      { ...base, id: hex(), status: TaskStatus.WontDo, title: "wontdo" },
      { ...base, id: trashedId, title: "to-trash" },
    ]);
    await call("POST", "/api/v2/batch/task", { delete: [{ taskId: trashedId, projectId: svc.inboxId }] });
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-09-01T00:00:00Z")}&to=${Date.parse("2026-09-01T23:59:59Z")}`);
    expect(r.json).toEqual([]);
  });

  test("checklist item reminders compute independently and stop when item completes", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const taskId = hex();
    await addTasks([
      {
        id: taskId,
        title: "Checklist parent",
        kind: "CHECKLIST",
        reminders: [],
        items: [
          {
            id: "item1",
            title: "Buy milk",
            status: 0,
            sortOrder: 0,
            startDate: "2026-09-05T10:00:00.000+0000",
            reminders: [{ id: "ir1", trigger: "TRIGGER:-PT10M" }],
          },
          {
            id: "item2",
            title: "Done item",
            status: 1,
            sortOrder: 1,
            startDate: "2026-09-05T11:00:00.000+0000",
            reminders: [{ id: "ir2", trigger: "TRIGGER:PT0S" }],
          },
        ],
      },
    ]);
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-09-05T09:00:00Z")}&to=${Date.parse("2026-09-05T12:00:00Z")}`);
    expect(r.json).toHaveLength(1);
    expect(r.json[0]).toMatchObject({
      kind: "checklist",
      taskId,
      itemId: "item1",
      fireAtMs: Date.parse("2026-09-05T09:50:00.000Z"),
    });
  });

  test("repeating task emits instances with COUNT, UNTIL, and excludes exDate", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await addTasks([
      {
        id: hex(),
        title: "Daily count 3 skip day 2",
        isAllDay: false,
        timeZone: "UTC",
        startDate: "2026-10-01T08:00:00.000+0000",
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=3",
        exDate: ["2026-10-02T08:00:00.000+0000"],
        reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }],
      },
      {
        id: hex(),
        title: "Daily until Oct 11",
        isAllDay: false,
        timeZone: "UTC",
        startDate: "2026-10-10T08:00:00.000+0000",
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261011T000000Z",
        reminders: [{ id: "r2", trigger: "TRIGGER:PT0S" }],
      },
    ]);
    const r1 = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-10-01T00:00:00Z")}&to=${Date.parse("2026-10-06T00:00:00Z")}`);
    expect(r1.json.map((x: any) => new Date(x.fireAtMs).toISOString())).toEqual([
      "2026-10-01T08:00:00.000Z",
      "2026-10-03T08:00:00.000Z",
      "2026-10-04T08:00:00.000Z",
    ]);

    const r2 = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-10-10T00:00:00Z")}&to=${Date.parse("2026-10-15T00:00:00Z")}`);
    expect(r2.json.map((x: any) => new Date(x.fireAtMs).toISOString())).toEqual([
      "2026-10-10T08:00:00.000Z",
      "2026-10-11T08:00:00.000Z",
    ]);
  });

  test("TT_SKIP=HOLIDAY,WEEKEND consults /api/v2/holidays restDays and workDays", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    // 2026-10-05 Mon, 2026-10-06 Tue (holiday restDay!), 2026-10-07..09 Wed..Fri,
    // 2026-10-10 Sat (make-up workDay!), 2026-10-11 Sun (weekend skipped)
    const hol = await call("PUT", "/api/v2/holidays", {
      restDays: ["2026-10-06"],
      workDays: ["2026-10-10"],
    });
    expect(hol.status).toBe(200);
    expect((await call("GET", "/api/v2/holidays")).json.restDays).toEqual(["2026-10-06"]);

    await addTasks([
      {
        id: hex(),
        title: "Workday reminder",
        isAllDay: false,
        timeZone: "UTC",
        startDate: "2026-10-05T09:00:00.000+0000",
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND",
        reminders: [{ id: "r", trigger: "TRIGGER:PT0S" }],
      },
    ]);
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-10-05T00:00:00Z")}&to=${Date.parse("2026-10-11T23:59:59Z")}`);
    const dates = r.json.map((x: any) => new Date(x.fireAtMs).toISOString().slice(0, 10));
    expect(dates).toEqual(["2026-10-05", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"]);
  });

  test("completing a repeating task (RMD-027) stops old occurrence and advances repeatFrom=1 from now", async () => {
    const clock = Date.parse("2026-10-05T10:00:00Z");
    const { call, svc, addTasks } = makeEnv({ now: () => clock });
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const id = hex();
    await addTasks([
      {
        id,
        title: "Water plants every 3d from completion",
        isAllDay: false,
        timeZone: "UTC",
        startDate: "2026-10-01T09:00:00.000+0000",
        dueDate: "2026-10-01T09:00:00.000+0000",
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=3",
        repeatFrom: "1",
        reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }],
      },
    ]);
    const done = await call("POST", `/api/v2/project/${svc.inboxId}/task/${id}/complete`, {});
    expect(done.status).toBe(200);
    // Old Oct 01 no longer fires; next fires Oct 08 (Oct 05 + 3d)
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-10-01T00:00:00Z")}&to=${Date.parse("2026-10-10T00:00:00Z")}`);
    expect(r.json.map((x: any) => new Date(x.fireAtMs).toISOString())).toEqual(["2026-10-08T09:00:00.000Z"]);
  });

  test("habit reminders fire on scheduled uncompleted days and skip checked-in days", async () => {
    const { call } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const hid = hex();
    await call("POST", "/api/v2/habits/batch", {
      add: [
        {
          id: hid,
          name: "Drink water",
          type: "Boolean",
          goal: 1,
          targetStartDate: 20261101,
          repeatRule: "RRULE:FREQ=DAILY;INTERVAL=1",
          reminders: ["08:30"],
          status: 0,
        },
      ],
    });
    await call("POST", "/api/v2/habitCheckins/batch", {
      add: [{ id: hex(), habitId: hid, checkinStamp: 20261102, status: 2, value: 1 }],
    });
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-01T00:00:00Z")}&to=${Date.parse("2026-11-03T23:59:59Z")}`);
    expect(r.json.map((x: any) => new Date(x.fireAtMs).toISOString())).toEqual([
      "2026-11-01T08:30:00.000Z",
      "2026-11-03T08:30:00.000Z",
    ]);
    expect(r.json[0].kind).toBe("habit");
  });

  test("countdown reminders compute on-day and early triggers", async () => {
    const { call } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const cid = hex();
    const res = await call("POST", "/api/v2/countdown/batch", {
      add: [
        {
          id: cid,
          name: "Launch day",
          date: "2026-12-01",
          reminders: ["TRIGGER:PT540M", "TRIGGER:-P0DT15H0M0S"],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.id2error).toEqual({});
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-30T00:00:00Z")}&to=${Date.parse("2026-12-01T23:59:59Z")}`);
    expect(r.json.map((x: any) => new Date(x.fireAtMs).toISOString())).toEqual([
      "2026-11-30T09:00:00.000Z",
      "2026-12-01T09:00:00.000Z",
    ]);
    expect(r.json[0].kind).toBe("countdown");
  });

  test("daily summary reminder reads dailyReminder + syncs settings.dailyRemindTimeConfig and counts today/overdue", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await call("PUT", "/api/v2/holidays", { restDays: ["2026-11-03"], workDays: [] });
    await addTasks([
      { id: hex(), title: "Overdue task", isAllDay: true, startDate: "2026-10-30T00:00:00.000+0000", dueDate: "2026-10-30T00:00:00.000+0000" },
      { id: hex(), title: "Today task", isAllDay: true, startDate: "2026-11-02T00:00:00.000+0000", dueDate: "2026-11-02T00:00:00.000+0000" },
      { id: hex(), title: "Note ignored", kind: "NOTE", isAllDay: true, startDate: "2026-11-02T00:00:00.000+0000" },
    ]);
    await call("PUT", "/api/v2/user/preferences/dailyReminder", {
      enable: true,
      dailyReminders: ["07:30"],
      notifyOptions: ["TODAY", "OVERDUE"],
      weekDays: ["MO", "TU"],
      holidayNotify: false,
    });
    // 2026-11-02 is Mon (fires), 2026-11-03 is Tue holiday (skipped because holidayNotify=false)
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-02T00:00:00Z")}&to=${Date.parse("2026-11-04T00:00:00Z")}`);
    expect(r.json).toHaveLength(1);
    expect(r.json[0]).toMatchObject({
      kind: "dailySummary",
      fireAtMs: Date.parse("2026-11-02T07:30:00.000Z"),
      todayCount: 1,
      overdueCount: 1,
    });

    // Updating via settings.dailyRemindTimeConfig syncs back to dailyReminder
    await call("PUT", "/api/v2/user/preferences/settings", {
      dailyRemindTimeConfig: { enable: true, dailyReminders: ["08:00"], notifyOptions: ["TODAY"], weekDays: ["MO"], holidayNotify: true },
    });
    const dr = await call("GET", "/api/v2/user/preferences/dailyReminder");
    expect(dr.json.dailyReminders).toEqual(["08:00"]);
    expect(dr.json.notifyOptions).toEqual(["TODAY"]);
  });

  test("constant reminder re-fires every 60s until acknowledged via closeRemind", async () => {
    let clock = Date.parse("2026-11-05T10:00:00Z");
    const { call, addTasks } = makeEnv({ now: () => clock });
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const id = hex();
    await addTasks([
      {
        id,
        title: "Constant nag",
        isAllDay: false,
        startDate: "2026-11-05T10:00:00.000+0000",
        reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }],
        annoyingAlert: CONSTANT_REMINDER_FLAG,
      },
    ]);
    const r1 = await call(
      "GET",
      `/api/v2/reminder/instances?from=${Date.parse("2026-11-05T10:00:00Z")}&to=${Date.parse("2026-11-05T10:02:10Z")}`,
    );
    expect(r1.json.map((x: any) => x.fireAtMs)).toEqual([
      Date.parse("2026-11-05T10:00:00Z"),
      Date.parse("2026-11-05T10:00:00Z") + CONSTANT_REMINDER_CYCLE_MS,
      Date.parse("2026-11-05T10:00:00Z") + 2 * CONSTANT_REMINDER_CYCLE_MS,
    ]);
    expect(r1.json.every((x: any) => x.constant === true)).toBe(true);

    // Acknowledge via closeRemind
    clock = Date.parse("2026-11-05T10:01:30Z");
    const closed = await call("POST", "/api/v2/task/closeRemind", { taskId: id });
    expect(closed.status).toBe(200);
    expect(closed.json.id2etag[id]).toBeTruthy();

    const r2 = await call(
      "GET",
      `/api/v2/reminder/instances?from=${Date.parse("2026-11-05T10:00:00Z")}&to=${Date.parse("2026-11-05T10:05:00Z")}`,
    );
    expect(r2.json).toEqual([]);
  });

  test("constant reminder activates globally via ext.reminder.annoyingAlertEnabled and annoyingRemindItems", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await call("PUT", "/api/v2/user/preferences/ext", {
      reminder: { annoyingAlertEnabled: true, annoyingRemindItems: ["task"], mtime: 500 },
    });
    const id = hex();
    await addTasks([
      {
        id,
        title: "Global ext constant",
        isAllDay: false,
        startDate: "2026-11-06T14:00:00.000+0000",
        reminders: [{ id: "r2", trigger: "TRIGGER:PT0S" }],
      },
    ]);
    const r = await call(
      "GET",
      `/api/v2/reminder/instances?from=${Date.parse("2026-11-06T14:00:00Z")}&to=${Date.parse("2026-11-06T14:01:05Z")}`,
    );
    expect(r.json).toHaveLength(2);
    expect(r.json.every((x: any) => x.constant === true)).toBe(true);
  });
});

describe("M5 closeRemind, delay, ext mtime, and notification center", () => {
  test("delayReminder supports delayMinutes and explicit snoozeReminderTime and emits snooze instance", async () => {
    const clock = Date.parse("2026-11-10T10:00:00Z");
    const { call, addTasks } = makeEnv({ now: () => clock });
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const id = hex();
    await addTasks([
      {
        id,
        title: "Snooze me",
        isAllDay: false,
        annoyingAlert: CONSTANT_REMINDER_FLAG,
        startDate: "2026-11-10T10:00:00.000+0000",
        reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }],
      },
    ]);
    const d1 = await call("POST", "/api/v2/reminder/delay", { taskId: id, delayMinutes: 15 });
    expect(d1.status).toBe(200);
    expect(d1.json.snoozeReminderTime).toBe("2026-11-10T10:15:00.000+0000");

    // Constant cycle before 10:15 is acked, snooze fires at 10:15 and repeats at 10:16
    const inst = await call(
      "GET",
      `/api/v2/reminder/instances?from=${Date.parse("2026-11-10T10:00:00Z")}&to=${Date.parse("2026-11-10T10:16:05Z")}`,
    );
    expect(inst.json.map((x: any) => new Date(x.fireAtMs).toISOString())).toEqual([
      "2026-11-10T10:15:00.000Z",
      "2026-11-10T10:16:00.000Z",
    ]);

    // Explicit snoozeReminderTime
    const d2 = await call("POST", "/api/v2/reminder/delay", { taskId: id, snoozeReminderTime: "2026-11-10T11:00:00.000+0000" });
    expect(d2.status).toBe(200);
    expect(d2.json.snoozeReminderTime).toBe("2026-11-10T11:00:00.000+0000");
  });

  test("closeRemind and delay validation errors and per-item close/snooze", async () => {
    const { call, addTasks } = makeEnv();
    const id = hex();
    await addTasks([
      {
        id,
        title: "Item snooze",
        kind: "CHECKLIST",
        isAllDay: false,
        startDate: "2026-11-10T10:00:00.000+0000",
        reminders: [{ id: "tr1", trigger: "TRIGGER:PT0S" }],
        items: [{ id: "ci1", title: "Sub", status: 0, sortOrder: 0, startDate: "2026-11-10T10:00:00.000+0000", reminders: [{ id: "ir", trigger: "TRIGGER:PT0S" }] }],
      },
    ]);
    expect((await call("POST", "/api/v2/task/closeRemind", {})).status).toBe(400);
    expect((await call("POST", "/api/v2/task/closeRemind", { taskId: hex() })).status).toBe(404);
    expect((await call("POST", "/api/v2/task/closeRemind", { taskId: id, itemId: "missing" })).status).toBe(404);
    expect((await call("POST", "/api/v2/reminder/delay", { taskId: id, delayMinutes: -5 })).status).toBe(400);
    expect((await call("POST", "/api/v2/reminder/delay", { taskId: hex(), delayMinutes: 5 })).status).toBe(404);

    // Delay checklist item, close only item -> task reminder remains
    const di = await call("POST", "/api/v2/reminder/delay", { taskId: id, itemId: "ci1", delayMinutes: 30 });
    expect(di.status).toBe(200);
    const ci = await call("POST", "/api/v2/task/closeRemind", { taskId: id, itemId: "ci1" });
    expect(ci.status).toBe(200);
    const inst = await call(
      "GET",
      `/api/v2/reminder/instances?from=${Date.parse("2026-11-10T09:59:00Z")}&to=${Date.parse("2026-11-10T11:00:00Z")}`,
    );
    expect(inst.json.map((x: any) => x.kind)).toEqual(["task"]);
  });

  test("ext preference merges per-section mtime (newer wins) and supports ?mtime= delta query", async () => {
    const { call } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/ext", {
      theme: { name: "dark", mtime: 200 },
      reminder: { annoyingAlertEnabled: false, mtime: 100 },
    });
    // Stale theme (mtime 150 < 200) is ignored; newer reminder (mtime 250 > 100) wins
    const w2 = await call("PUT", "/api/v2/user/preferences/ext", {
      theme: { name: "light", mtime: 150 },
      reminder: { annoyingAlertEnabled: true, mtime: 250 },
    });
    expect(w2.json.theme.name).toBe("dark");
    expect(w2.json.reminder.annoyingAlertEnabled).toBe(true);

    const delta = await call("GET", "/api/v2/user/preferences/ext?mtime=200");
    expect(delta.json).toEqual({ reminder: { annoyingAlertEnabled: true, mtime: 250 } });
  });

  test("notification center unread counts, category markRead, and autoMarkRead", async () => {
    const { call, reminders } = makeEnv();
    reminders.addNotification({ title: "N1", category: NotificationCategory.Notification });
    reminders.addNotification({ title: "N2", category: NotificationCategory.Notification });
    reminders.addNotification({ title: "A1", category: NotificationCategory.Activity });

    expect((await call("GET", "/api/v2/notification/unread")).json).toEqual({ notification: 2, activity: 1 });
    expect((await call("PUT", "/api/v2/notification/markRead?category=activity")).json).toEqual({ notification: 2, activity: 0 });

    const list = await call("GET", "/api/v2/notification?autoMarkRead=true");
    expect(list.json).toHaveLength(3);
    expect((await call("GET", "/api/v2/notification/unread")).json).toEqual({ notification: 0, activity: 0 });
  });
});

describe("M5 VAPID, push registration, and real Web Push HTTPS delivery", () => {
  test("cli generate-vapid writes 0600 file and loadVapidKeys validates it", () => {
    const dir = tmp();
    cleanDirs.push(dir);
    const out = join(dir, "vapid.json");
    const r = spawnSync("npx", ["tsx", "src/cli.ts", "generate-vapid", out, "--subject", "mailto:ops@example.com"], {
      cwd: join(__dirname, ".."),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const mode = statSync(out).mode & 0o777;
    expect(mode).toBe(0o600);
    const loaded = loadVapidKeys(out);
    expect(loaded.subject).toBe("mailto:ops@example.com");
    expect(loaded.publicKey.length).toBeGreaterThan(20);
    expect(loaded.privateKey.length).toBeGreaterThan(20);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ publicKey: "" }));
    expect(() => loadVapidKeys(bad)).toThrow();
    chmodSync(out, 0o600);
  });

  test("/api/v2/push/vapidPublicKey, /push/register (upsert + version), and /push/stats/arrive", async () => {
    const { file, keys } = freshVapid();
    const { call } = makeEnv({ vapidFile: file });
    const pk = await call("GET", "/api/v2/push/vapidPublicKey");
    expect(pk.json).toEqual({ publicKey: keys.publicKey });

    expect((await call("POST", "/api/v2/push/register", {})).status).toBe(400);
    const sub = makeClientSubscription("https://push.example.com/push");
    const r1 = await call("POST", "/api/v2/push/register", { pushToken: JSON.stringify(sub), osType: 20, subscription: sub });
    expect(r1.status).toBe(200);
    expect(r1.json.version).toBe(1);
    const r2 = await call("POST", "/api/v2/push/register", { pushToken: JSON.stringify(sub), osType: 20 });
    expect(r2.json.version).toBe(2);
    expect(r2.json.id).toBe(r1.json.id);

    const arr = await call("POST", "/api/v2/push/stats/arrive", { id: r1.json.id });
    expect(arr.status).toBe(200);

    const noVapid = makeEnv();
    expect((await noVapid.call("GET", "/api/v2/push/vapidPublicKey")).json).toEqual({ publicKey: null });
  });

  test("web-push delivers encrypted HTTPS payload with VAPID header, deduplicates cycles, re-fires constant at +60s, respects disabled setting, and cleans 410", async () => {
    let statusCode = 201;
    const mock = await startMockHttpsPushServer(() => statusCode);
    try {
      const { file } = freshVapid();
      let clock = Date.parse("2026-11-20T12:00:30Z");
      const { call, reminders, addTasks } = makeEnv({ vapidFile: file, pushAgent: mock.agent, now: () => clock });
      await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC", notificationEnabled: true });
      await call("POST", "/api/v2/push/register", { subscription: makeClientSubscription(mock.url), osType: 20 });

      const tid = hex();
      await addTasks([
        {
          id: tid,
          title: "Push test urgent",
          isAllDay: false,
          annoyingAlert: CONSTANT_REMINDER_FLAG,
          startDate: "2026-11-20T12:00:00.000+0000",
          reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }],
        },
      ]);

      // 1st dispatch at 12:00:30 delivers cycle 0
      const rep1 = await reminders.dispatchDue(clock, clock - 60_000);
      expect(rep1).toMatchObject({ due: 1, sent: 1, failed: 0, removed: 0 });
      expect(mock.received).toHaveLength(1);
      const req1 = mock.received[0]!;
      expect(String(req1.headers.authorization ?? "")).toContain("vapid ");
      expect(req1.headers["content-encoding"]).toBe("aes128gcm");
      expect(req1.body.length).toBeGreaterThan(30);
      expect(req1.body.toString("utf8")).not.toContain("Push test urgent");

      // Notification added in notification center
      const notifs = await call("GET", "/api/v2/notification");
      expect(notifs.json.some((n: any) => n.title === "Push test urgent")).toBe(true);

      // Re-running within same window deduplicates
      const repDup = await reminders.dispatchDue(clock + 10_000, clock - 60_000);
      expect(repDup.sent).toBe(0);
      expect(mock.received).toHaveLength(1);

      // Advance +60s -> constant cycle 1 fires!
      clock = Date.parse("2026-11-20T12:01:05Z");
      const rep2 = await reminders.dispatchDue(clock, Date.parse("2026-11-20T12:00:00Z"));
      expect(rep2.sent).toBe(1);
      expect(mock.received).toHaveLength(2);

      // notificationEnabled: false stops dispatch
      await call("PUT", "/api/v2/user/preferences/settings", { notificationEnabled: false });
      clock = Date.parse("2026-11-20T12:02:05Z");
      const repDisabled = await reminders.dispatchDue(clock, Date.parse("2026-11-20T12:00:00Z"));
      expect(repDisabled).toMatchObject({ skipped: "disabled", sent: 0 });

      // Re-enable + closeRemind acks constant loop; new task hits 410 -> removes dead subscription
      await call("PUT", "/api/v2/user/preferences/settings", { notificationEnabled: true });
      await call("POST", "/api/v2/task/closeRemind", { taskId: tid });
      statusCode = 410;
      const tid2 = hex();
      await addTasks([
        {
          id: tid2,
          title: "Gone sub",
          isAllDay: false,
          startDate: "2026-11-20T12:03:00.000+0000",
          reminders: [{ id: "r2", trigger: "TRIGGER:PT0S" }],
        },
      ]);
      clock = Date.parse("2026-11-20T12:03:05Z");
      const rep410 = await reminders.dispatchDue(clock, clock - 60_000);
      expect(rep410).toMatchObject({ failed: 1, removed: 1 });
      expect(reminders.listPushSubscriptions()).toEqual([]);
      expect(readFileSync(file, "utf8")).toContain("publicKey");
    } finally {
      await mock.close();
    }
  });
});

describe("M5 reminder & notification additional edge cases", () => {
  test("batch closeRemind returns partial id2etag and NOT_EXISTED in id2error", async () => {
    const { call, addTasks } = makeEnv();
    const id = hex();
    const missing = hex();
    await addTasks([{ id, title: "Batch close", isAllDay: false, startDate: "2026-11-10T10:00:00.000+0000", reminders: [{ id: "r1", trigger: "TRIGGER:PT0S" }] }]);
    const res = await call("POST", "/api/v2/task/closeRemind", { tasks: [{ taskId: id }, { taskId: missing }] });
    expect(res.status).toBe(200);
    expect(res.json.id2etag[id]).toBeTruthy();
    expect(res.json.id2error[missing]).toBe("NOT_EXISTED");
  });

  test("closeRemind with specific reminderId leaves other reminder triggers on same task intact", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    const id = hex();
    await addTasks([
      {
        id,
        title: "Two reminders",
        isAllDay: false,
        startDate: "2026-11-12T10:00:00.000+0000",
        reminders: [
          { id: "remA", trigger: "TRIGGER:-PT10M" },
          { id: "remB", trigger: "TRIGGER:PT0S" },
        ],
      },
    ]);
    await call("POST", "/api/v2/task/closeRemind", { taskId: id, reminderId: "remA" });
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-12T09:00:00Z")}&to=${Date.parse("2026-11-12T11:00:00Z")}`);
    expect(r.json).toHaveLength(1);
    expect(r.json[0].reminderId).toBe("remB");
  });

  test("reminder/instances rejects inverted from > to with 400 invalid_date_range", async () => {
    const { call } = makeEnv();
    const r = await call("GET", `/api/v2/reminder/instances?from=2000&to=1000`);
    expect(r.status).toBe(400);
  });

  test("legacy string task.reminder triggers without reminders array", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await addTasks([
      {
        id: hex(),
        title: "Legacy string",
        isAllDay: false,
        startDate: "2026-11-13T10:00:00.000+0000",
        reminder: "TRIGGER:-PT5M",
        reminders: [],
      },
    ]);
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-13T09:00:00Z")}&to=${Date.parse("2026-11-13T11:00:00Z")}`);
    expect(r.json).toHaveLength(1);
    expect(r.json[0].fireAtMs).toBe(Date.parse("2026-11-13T09:55:00.000Z"));
  });

  test("daily summary with holidayNotify=true fires on holiday and OVERDUE-only omits todayCount", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await call("PUT", "/api/v2/holidays", { restDays: ["2026-11-03"], workDays: [] });
    await addTasks([{ id: hex(), title: "Late", isAllDay: true, startDate: "2026-11-01T00:00:00.000+0000", dueDate: "2026-11-01T00:00:00.000+0000" }]);
    await call("PUT", "/api/v2/user/preferences/dailyReminder", {
      enable: true,
      dailyReminders: ["08:00"],
      notifyOptions: ["OVERDUE"],
      weekDays: [],
      holidayNotify: true,
    });
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-03T00:00:00Z")}&to=${Date.parse("2026-11-03T23:59:59Z")}`);
    expect(r.json).toHaveLength(1);
    expect(r.json[0].overdueCount).toBe(1);
    expect(r.json[0].todayCount).toBeUndefined();
  });

  test("archived habits, deleted countdowns, and completed checklist parent emit no reminders", async () => {
    const { call, addTasks } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC" });
    await call("POST", "/api/v2/habits/batch", {
      add: [{ id: hex(), name: "Arch habit", type: "Boolean", goal: 1, targetStartDate: 20261101, repeatRule: "RRULE:FREQ=DAILY;INTERVAL=1", reminders: ["09:00"], status: 1 }],
    });
    const cid = hex();
    await call("POST", "/api/v2/countdown/batch", {
      add: [{ id: cid, name: "Del cnt", date: "2026-11-01", reminders: ["TRIGGER:PT540M"], deleted: 1 }],
    });
    await addTasks([
      {
        id: hex(),
        title: "Done checklist",
        kind: "CHECKLIST",
        status: TaskStatus.Completed,
        items: [{ id: "i1", title: "Sub", status: 0, sortOrder: 0, startDate: "2026-11-01T10:00:00.000+0000", reminders: [{ id: "r", trigger: "TRIGGER:PT0S" }] }],
      },
    ]);
    const r = await call("GET", `/api/v2/reminder/instances?from=${Date.parse("2026-11-01T00:00:00Z")}&to=${Date.parse("2026-11-02T00:00:00Z")}`);
    expect(r.json).toEqual([]);
  });

  test("markRead supports category=notification and category=all, and dispatchDue without VAPID returns skipped=no_vapid", async () => {
    const { call, reminders } = makeEnv();
    reminders.addNotification({ title: "N1", category: NotificationCategory.Notification });
    reminders.addNotification({ title: "A1", category: NotificationCategory.Activity });
    expect((await call("PUT", "/api/v2/notification/markRead?category=notification")).json).toEqual({ notification: 0, activity: 1 });
    expect((await call("PUT", "/api/v2/notification/markRead?category=all")).json).toEqual({ notification: 0, activity: 0 });
    expect(await reminders.dispatchDue(Date.now())).toMatchObject({ skipped: "no_vapid", sent: 0 });
  });

  test("ext overwrite without mtime always updates section", async () => {
    const { call } = makeEnv();
    await call("PUT", "/api/v2/user/preferences/ext", { custom: { a: 1 } });
    const w = await call("PUT", "/api/v2/user/preferences/ext", { custom: { a: 2 } });
    expect(w.json.custom.a).toBe(2);
  });
});
