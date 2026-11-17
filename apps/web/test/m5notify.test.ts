import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { hashFor, instanceToNotification, mergeNotifications, notificationHash, notificationId, type NotificationItem, type ReminderInstance } from "../src/lib/notify";
import { VoiceRecorder, VOICE_MEMO_MAX_MS, type RecorderLike } from "../src/model/recorder";

/** Notification click routing (RMD-034, NTF-009): the service worker handlers, run in a sandbox. */

const pub = join(__dirname, "../public");
type Handler = (e: Record<string, unknown>) => void;

function loadWorker(clients: Array<{ url: string; postMessage: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> }>) {
  const handlers: Record<string, Handler> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const self: Record<string, unknown> = {
    location: { origin: "https://tasks.example" },
    registration: { scope: "https://tasks.example/", showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: { matchAll: async () => clients, openWindow: async (u: string) => void opened.push(u), claim: async () => {} },
    addEventListener: (k: string, fn: Handler) => (handlers[k] = fn),
    skipWaiting: () => {},
  };
  self.self = self;
  const sandbox: Record<string, unknown> = {
    self,
    caches: { open: async () => ({ addAll: async () => {} }), keys: async () => [] },
    importScripts: (...files: string[]) => {
      for (const f of files) runInNewContext(readFileSync(join(pub, f.replace("./", "")), "utf8"), sandbox);
    },
    URL,
    Promise,
    console,
  };
  runInNewContext(readFileSync(join(pub, "sw.js"), "utf8"), sandbox);
  return { handlers, shown, opened, self };
}

async function click(handlers: Record<string, Handler>, data: Record<string, unknown>): Promise<void> {
  let wait: Promise<unknown> = Promise.resolve();
  handlers.notificationclick!({ notification: { data, close: () => {} }, waitUntil: (p: Promise<unknown>) => (wait = p) });
  await wait;
}

const cases: Array<[string, Record<string, unknown>, string]> = [
  ["task reminder", { type: "reminder", kind: "task", taskId: "t1", projectId: "p1", title: "Pay rent" }, "#p/p1/tasks/t1"],
  ["checklist item", { kind: "checklist", taskId: "t2", itemId: "i1", projectId: "inbox123" }, "#p/inbox123/tasks/t2"],
  ["daily summary", { type: "dailyReminder", kind: "dailySummary", todayCount: 3, url: "#q/today/tasks" }, "#q/today/tasks"],
  ["habit with id", { kind: "habit", targetId: "h1" }, "#q/all/habit/h1"],
  ["habit push without id", { kind: "habit", url: "#q/today/tasks" }, "#q/all/habit"],
  ["countdown", { kind: "countdown", targetId: "c1" }, "#countdown/c1"],
  ["server notification row", { type: "reminder", data: { kind: "task", taskId: "t3", projectId: "p3" } }, "#p/p3/tasks/t3"],
  ["unknown", { type: "system" }, "#n/notification/all"],
];

describe("notification click routing", () => {
  it.each(cases)("%s: the worker and the app route to the same place", (_n, data, hash) => {
    const sandbox: Record<string, unknown> = {};
    sandbox.self = sandbox;
    runInNewContext(readFileSync(join(pub, "sw-notify.js"), "utf8"), sandbox);
    const nn = (sandbox as { noorNotify: { hashFor: (d: unknown) => string; target: (d: unknown, s: string) => string } }).noorNotify;
    expect(nn.hashFor(data)).toBe(hash);
    expect(hashFor(data)).toBe(hash);
    expect(nn.target(data, "https://tasks.example/")).toBe(`https://tasks.example/${hash}`);
  });

  it("a click focuses the open window and routes it to the task", async () => {
    const win = { url: "https://tasks.example/#q/today/tasks", postMessage: vi.fn(), focus: vi.fn(async () => win) };
    const w = loadWorker([win]);
    await click(w.handlers, { kind: "task", taskId: "t9", projectId: "p9", title: "Call" });
    expect(win.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "noor-open", hash: "#p/p9/tasks/t9" }));
    expect(win.focus).toHaveBeenCalled();
    expect(w.opened).toEqual([]);
  });

  it("with no window open a click opens the task URL", async () => {
    const w = loadWorker([]);
    await click(w.handlers, { kind: "task", taskId: "t9", projectId: "p9" });
    expect(w.opened).toEqual(["https://tasks.example/#p/p9/tasks/t9"]);
  });

  it("a push shows a notification carrying the payload (constant reminders stay until dismissed)", async () => {
    const win = { url: "https://tasks.example/", postMessage: vi.fn(), focus: vi.fn() };
    const w = loadWorker([win]);
    let wait: Promise<unknown> = Promise.resolve();
    const payload = { type: "reminder", kind: "task", title: "Water plants", taskId: "t1", projectId: "p1", fireAt: "2026-11-16T09:00:00.000+0000", constant: true };
    w.handlers.push!({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]!.title).toBe("Water plants");
    expect(w.shown[0]!.options.requireInteraction).toBe(true);
    expect(w.shown[0]!.options.data).toEqual(payload);
    expect(win.postMessage).toHaveBeenCalledWith({ type: "noor-push", data: payload });
  });

  it("notification-centre rows use the server's id formula, merge without duplicates, and route", () => {
    const inst: ReminderInstance = { kind: "task", targetId: "t1", taskId: "t1", projectId: "p1", title: "Rent", reminderId: "r1", fireAtMs: 1000, fireAt: "x", occurrenceMs: 900 };
    expect(notificationId(inst)).toBe("notif:task:t1::r1:900");
    const local = instanceToNotification(inst, Date.parse("2026-11-16T10:00:00Z"));
    const server: NotificationItem = { ...local, local: undefined, unread: false, createdTime: "2026-11-16T10:00:01.000+0000" };
    const older: NotificationItem = { ...local, id: "other", createdTime: "2026-11-15T10:00:00.000+0000" };
    const merged = mergeNotifications([server], [local, older]);
    expect(merged.map((n) => n.id)).toEqual(["notif:task:t1::r1:900", "other"]);
    expect(merged[0]!.unread).toBe(false);
    expect(notificationHash(local)).toBe("#p/p1/tasks/t1");
    expect(notificationHash(instanceToNotification({ kind: "habit", targetId: "h7", title: "Run", fireAtMs: 1, fireAt: "x" }, 0))).toBe("#q/all/habit/h7");
  });
});

describe("voice memo recorder (ATT-020)", () => {
  it("stops and saves by itself at exactly 30 minutes", () => {
    vi.useFakeTimers();
    let now = 0;
    const fake: RecorderLike = {
      state: "inactive",
      mimeType: "audio/webm",
      ondataavailable: null,
      onstop: null,
      start() {
        this.state = "recording";
      },
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["abc"]) });
        this.onstop?.();
      },
    };
    const done = vi.fn();
    const r = new VoiceRecorder(() => fake, {} as MediaStream, { onDone: done, now: () => now });
    r.start();
    now = VOICE_MEMO_MAX_MS - 1000;
    vi.advanceTimersByTime(VOICE_MEMO_MAX_MS - 1000);
    expect(done).not.toHaveBeenCalled();
    now = VOICE_MEMO_MAX_MS;
    vi.advanceTimersByTime(1000);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0]![1]).toBe(1_800_000);
    expect((done.mock.calls[0]![0] as Blob).size).toBe(3);
    vi.useRealTimers();
  });
});
