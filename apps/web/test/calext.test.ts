import { describe, expect, test } from "vitest";
import type { CalendarAccount, CalendarEventItem, CalendarSubscription, Task } from "../src/lib/core";
import { DAY, startOfDay } from "../src/lib/dates";
import { ItemKind, calendarItems, layoutDayEvents, layoutSpans } from "../src/model/calendar";
import { buildSources, defaultSourceColor, eventDays, eventPatch, eventSourceKey, feedLink, providerItemType, snapAllDay, sourceRoute, visibleEvents } from "../src/model/extCal";
import { parseHash } from "../src/model/router";

// the browser zone of the e2e run; the server in tests runs in UTC, so all-day midnights differ by 1 to 2 hours
process.env.TZ = "Europe/Amsterdam";

const local = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
const utc = (y: number, m: number, d: number, h = 0): number => Date.UTC(y, m - 1, d, h);
const wire = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");

const sub = (p: Partial<CalendarSubscription>): CalendarSubscription => ({ id: "s1", name: "Club", url: "https://x.test/a.ics", kind: "url", show: true, hidden: false, sortOrder: 1, itemType: 5, color: "#3fa66b", ...p });
const acc = (p: Partial<CalendarAccount>): CalendarAccount => ({ id: "a1", provider: "google", account: "me@example.test", itemType: 6, status: "active", needsReauth: false, show: true, calendars: [{ id: "c1", name: "Work", color: "#e5484d", show: true }], ...p });
const ev = (p: Partial<CalendarEventItem> & { start: number; end: number }): CalendarEventItem => {
  const allDay = p.allDay ?? false;
  return { id: "e1", key: "sub:e1", kind: 3, sourceType: "url", sourceId: "s1", calendarId: "s1", title: "Event", color: null, allDay, isAllDay: allDay, startDate: wire(p.start), dueDate: wire(p.end), dueStart: wire(p.start), dueEnd: wire(p.end), completed: false, readOnly: true, ...p };
};
const T = (p: Partial<Task>): Task => ({ id: Math.random().toString(16).slice(2), projectId: "p1", title: "t", status: 0, sortOrder: 0, ...p }) as Task;
const opts = (from: number, to: number) => ({ from, to, showCompleted: true, showChecklist: false, showFutureTask: true, showRepeat: false, now: local(2026, 11, 16, 10) });

describe("sources (CAL-064, CAL-077)", () => {
  test("feeds then account calendars, keyed by subscription id or account:calendar", () => {
    const s = buildSources([sub({ id: "s2", sortOrder: 2, name: "B" }), sub({ id: "s1", sortOrder: 1, name: "A", kind: "holiday" })], [acc({})]);
    expect(s.map((x) => x.key)).toEqual(["s1", "s2", "a1:c1"]);
    expect(s[0]!.kind).toBe("holiday");
    expect(s[2]).toMatchObject({ kind: "account", id: "a1", calendarId: "c1", provider: "google", group: "me@example.test", readOnly: false, color: "#e5484d" });
  });
  test("item type numbers per provider", () => {
    expect(["url", "google", "caldav", "outlook", "exchange", "icloud"].map(providerItemType)).toEqual([5, 6, 7, 8, 9, 10]);
  });
  test("CalDAV, iCloud and read-only remote calendars are read-only; feeds always", () => {
    const s = buildSources([sub({})], [acc({ id: "a2", provider: "caldav", itemType: 7 }), acc({ id: "a3", provider: "outlook", itemType: 8, calendars: [{ id: "c9", name: "Shared", readOnly: true }] })]);
    expect(s.map((x) => [x.key, x.readOnly])).toEqual([["s1", true], ["a2:c1", true], ["a3:c9", true]]);
  });
  test("a source without a colour gets a stable default; a hidden account hides its calendars", () => {
    const s = buildSources([sub({ color: null })], [acc({ show: false })]);
    expect(s[0]!.color).toBe(defaultSourceColor("s1"));
    expect(s[0]!.color).toBe(buildSources([sub({ color: null })], [])[0]!.color);
    expect(s[1]!.show).toBe(false);
  });
});

describe("colour and visibility filtering", () => {
  const sources = buildSources([sub({}), sub({ id: "h1", kind: "holiday", name: "Holidays", color: "#8e5bd8" }), sub({ id: "s3", show: false, hidden: true })], [acc({})]);
  const base = local(2026, 11, 16, 9);
  const events = [
    ev({ id: "e1", key: "sub:e1", sourceId: "s1", start: base, end: base + 3600_000, color: "#000000" }),
    ev({ id: "e2", key: "sub:e2", sourceId: "s3", start: base, end: base + 3600_000 }),
    ev({ id: "e3", key: "sub:e3", sourceId: "h1", sourceType: "holiday", allDay: true, start: local(2026, 11, 16), end: local(2026, 11, 17) }),
    ev({ id: "a1:c1:x", key: "acc:a1:c1:x", sourceId: "a1", accountId: "a1", calendarId: "c1", sourceType: "google", start: base, end: base + 1800_000, readOnly: false }),
    ev({ id: "e5", key: "sub:e5", sourceId: "gone", start: base, end: base + 3600_000 }),
    ev({ id: "e6", key: "sub:e6", sourceId: "s1", start: base, end: base + 3600_000, partStat: "declined" }),
    ev({ id: "e1", key: "sub:e1", sourceId: "s1", start: base, end: base + 3600_000 }),
  ];
  test("hidden, unknown and declined dropped; duplicates kept once; colour from the live source, not the wire", () => {
    const v = visibleEvents(events, sources);
    expect(v.map((e) => e.id).sort()).toEqual(["acc:a1:c1:x", "sub:e1", "sub:e3"]);
    expect(v.find((e) => e.id === "sub:e1")!.color).toBe("#3fa66b");
    expect(v.find((e) => e.id === "acc:a1:c1:x")).toMatchObject({ color: "#e5484d", readOnly: false });
    expect(v.find((e) => e.id === "sub:e3")!.readOnly).toBe(true);
  });
  test("a colour change or a hide on the source applies without new events", () => {
    const recoloured = buildSources([sub({ color: "#2f8fbf" }), sub({ id: "h1", kind: "holiday", color: "#8e5bd8" })], [acc({ calendars: [{ id: "c1", name: "Work", show: false }] })]);
    const v = visibleEvents(events, recoloured);
    expect(v.find((e) => e.id === "sub:e1")!.color).toBe("#2f8fbf");
    expect(v.some((e) => e.id.startsWith("acc:"))).toBe(false);
  });
  test("holidays switch (holidayEnabled false), declined switch and the single-calendar list (includeHidden)", () => {
    expect(visibleEvents(events, sources, { holidayEnabled: false }).some((e) => e.id === "sub:e3")).toBe(false);
    expect(visibleEvents(events, sources, { showDeclined: true }).some((e) => e.id === "sub:e6")).toBe(true);
    expect(visibleEvents(events, sources, { includeHidden: true }).some((e) => e.id === "sub:e2")).toBe(true);
  });
  test("eventSourceKey", () => {
    expect(eventSourceKey({ sourceId: "s1" })).toBe("s1");
    expect(eventSourceKey({ sourceId: "a1", accountId: "a1", calendarId: "c1" })).toBe("a1:c1");
  });
});

describe("all-day and multi-day external events", () => {
  test("server midnights in another zone snap to local dates (one column, not two)", () => {
    // UTC midnights: 01:00 local in winter
    const s = snapAllDay(utc(2026, 11, 20), utc(2026, 11, 21));
    expect(s).toEqual({ start: local(2026, 11, 20), end: local(2026, 11, 21) });
    // a zone west of the browser (New York midnight = 06:00 local)
    expect(snapAllDay(utc(2026, 11, 20, 5), utc(2026, 11, 21, 5))).toEqual({ start: local(2026, 11, 20), end: local(2026, 11, 21) });
    // empty or inverted span keeps one day
    expect(snapAllDay(local(2026, 11, 20), local(2026, 11, 20))).toEqual({ start: local(2026, 11, 20), end: local(2026, 11, 21) });
  });
  test("a one-day and a three-day all-day event lay out over 1 and 3 columns of the week row", () => {
    const sources = buildSources([sub({})], []);
    const v = visibleEvents(
      [
        ev({ id: "d1", key: "sub:d1", allDay: true, start: utc(2026, 11, 17), end: utc(2026, 11, 18) }),
        ev({ id: "d3", key: "sub:d3", allDay: true, start: utc(2026, 11, 18), end: utc(2026, 11, 21) }),
      ],
      sources,
    );
    const weekStart = local(2026, 11, 16);
    const items = calendarItems([], opts(weekStart, weekStart + 7 * DAY), v);
    const spans = layoutSpans(items, weekStart, 7);
    expect(spans.find((s) => s.key === "sub:d1")).toMatchObject({ startCol: 1, endCol: 1, lane: 0 });
    expect(spans.find((s) => s.key === "sub:d3")).toMatchObject({ startCol: 2, endCol: 4 });
  });
  test("a multi-day event crossing the row edge is clipped on both sides", () => {
    const v = visibleEvents([ev({ id: "long", key: "sub:long", allDay: true, start: utc(2026, 11, 14), end: utc(2026, 11, 25) })], buildSources([sub({})], []));
    const weekStart = local(2026, 11, 16);
    const items = calendarItems([], opts(weekStart, weekStart + 7 * DAY), v);
    expect(layoutSpans(items, weekStart, 7)[0]).toMatchObject({ startCol: 0, endCol: 6, clipStart: true, clipEnd: true });
  });
  test("eventDays marks every covered local day once, first colour wins", () => {
    const v = visibleEvents([ev({ id: "x", key: "sub:x", allDay: true, start: utc(2026, 11, 18), end: utc(2026, 11, 20) }), ev({ id: "y", key: "sub:y", start: local(2026, 11, 18, 22), end: local(2026, 11, 19, 1) })], buildSources([sub({})], []));
    const m = eventDays(v, local(2026, 11, 1), local(2026, 12, 1));
    expect([...m.keys()]).toEqual([local(2026, 11, 18), local(2026, 11, 19)]);
  });
});

describe("event layout merging tasks and external events", () => {
  const sources = buildSources([sub({})], [acc({})]);
  const day = local(2026, 11, 18);
  const events = visibleEvents(
    [
      ev({ id: "m", key: "sub:m", start: local(2026, 11, 18, 9), end: local(2026, 11, 18, 10) }),
      ev({ id: "a1:c1:z", key: "acc:a1:c1:z", sourceId: "a1", accountId: "a1", calendarId: "c1", start: local(2026, 11, 18, 9, 30), end: local(2026, 11, 18, 11) }),
      ev({ id: "out", key: "sub:out", start: local(2026, 11, 25, 9), end: local(2026, 11, 25, 10) }),
    ],
    sources,
  );
  const tasks = [T({ id: "t1", title: "Task at 9", startDate: wire(local(2026, 11, 18, 9)), dueDate: wire(local(2026, 11, 18, 9, 45)), isAllDay: false }), T({ id: "t2", title: "All-day task", startDate: wire(day), dueDate: wire(day), isAllDay: true })];
  const items = calendarItems(tasks, opts(day, day + DAY), events);

  test("tasks and events in one list: kinds, keys and the event's source travel along; outside the range dropped", () => {
    expect(items.map((i) => [i.key, i.kind])).toEqual([
      ["t1", ItemKind.Task],
      ["t2", ItemKind.Task],
      ["sub:m", ItemKind.Subscribe],
      ["acc:a1:c1:z", ItemKind.Subscribe],
    ]);
    const m = items.find((i) => i.key === "sub:m")!;
    expect(m.taskId).toBe("");
    expect(m.ext?.source.key).toBe("s1");
    expect(m.ext?.color).toBe("#3fa66b");
  });
  test("overlapping task and events share the day column", () => {
    const timed = items.filter((i) => !i.allDay);
    const placed = layoutDayEvents(timed);
    expect(placed.get("t1")!.cols).toBe(3);
    expect(new Set(["t1", "sub:m", "acc:a1:c1:z"].map((k) => placed.get(k)!.col)).size).toBe(3);
  });
  test("an all-day external event takes its own lane beside an all-day task", () => {
    const withAllDay = calendarItems(tasks, opts(day, day + DAY), visibleEvents([ev({ id: "h", key: "sub:h", allDay: true, start: utc(2026, 11, 18), end: utc(2026, 11, 19) })], sources));
    const spans = layoutSpans(withAllDay.filter((i) => i.allDay), day, 1);
    expect(spans.map((s) => s.lane).sort()).toEqual([0, 1]);
  });
  test("the existing subscribed-event shape still maps (M3 compatibility)", () => {
    const old = calendarItems([], opts(day, day + DAY), [{ id: "ev", title: "Plain", start: local(2026, 11, 18, 8), end: local(2026, 11, 18, 9), allDay: false }]);
    expect(old[0]).toMatchObject({ key: "sub:ev", kind: 3, taskId: "" });
    expect(old[0]!.ext).toBeUndefined();
  });
});

describe("two-way event edit payload", () => {
  const sources = buildSources([], [acc({})]);
  const [e] = visibleEvents([ev({ id: "a1:c1:abc", key: "acc:a1:c1:abc", uid: "abc", sourceId: "a1", accountId: "a1", calendarId: "c1", title: "Standup", location: "Room 1", start: local(2026, 11, 18, 9), end: local(2026, 11, 18, 9, 30), readOnly: false })], sources);
  test("only changed fields plus the calendar id", () => {
    expect(eventPatch(e!, { title: "Standup", allDay: false, start: e!.start, end: e!.end, location: "Room 1", description: "" })).toEqual({ calendarId: "c1" });
    expect(eventPatch(e!, { title: " Daily standup ", allDay: false, start: e!.start, end: e!.end, location: "Room 2", description: "agenda" })).toEqual({ calendarId: "c1", title: "Daily standup", location: "Room 2", description: "agenda" });
  });
  test("time changes send start and end; an end before the start becomes 30 minutes; all-day ends at the next midnight", () => {
    const later = local(2026, 11, 18, 14);
    expect(eventPatch(e!, { title: "Standup", allDay: false, start: later, end: later - 1, location: "Room 1", description: "" })).toEqual({ calendarId: "c1", isAllDay: false, start: later, end: later + 30 * 60_000 });
    expect(eventPatch(e!, { title: "Standup", allDay: true, start: local(2026, 11, 18, 9), end: local(2026, 11, 18, 9), location: "Room 1", description: "" })).toEqual({ calendarId: "c1", isAllDay: true, start: local(2026, 11, 18), end: local(2026, 11, 19) });
  });
});

describe("feed link and routes (CAL-078, CAL-080)", () => {
  test("relative feed path gets the page origin; absolute stays", () => {
    expect(feedLink("/feed/abc.ics", "http://127.0.0.1:4273")).toBe("http://127.0.0.1:4273/feed/abc.ics");
    expect(feedLink("https://h.test/feed/x.ics", "http://o")).toBe("https://h.test/feed/x.ics");
    expect(feedLink(null, "http://o")).toBe("");
  });
  test("subscribed list routes per source type parse back to the source id", () => {
    const [u, a, c] = buildSources([sub({ id: "6739a1b2c3d4e5f601234567" })], [acc({ id: "6739a1b2c3d4e5f601234568" }), acc({ id: "6739a1b2c3d4e5f601234569", provider: "caldav", itemType: 7 })]);
    expect(sourceRoute(u!)).toBe("q/6739a1b2c3d4e5f601234567/subscribe-calendar");
    expect(sourceRoute(a!)).toBe("q/6739a1b2c3d4e5f601234568/subscribe-account-calendar");
    expect(sourceRoute(c!)).toBe("q/6739a1b2c3d4e5f601234569/subscribe-cal-dav");
    for (const s of [u!, a!, c!]) expect(parseHash(`#${sourceRoute(s)}`)?.subcal).toBe(s.id);
    expect(parseHash("#q/all/tasks")?.subcal).toBeUndefined();
  });
  test("startOfDay sanity in the test zone", () => {
    expect(startOfDay(local(2026, 11, 18, 13))).toBe(local(2026, 11, 18));
  });
});
