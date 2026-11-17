import { expect, test, type Page } from "@playwright/test";
import { at, icsOf, startMockCal, type MockCal } from "./mockcal";
import { api, inboxId, oid } from "./seed";

/**
 * Calendar integrations on synthetic data against the real server, with a local mock ICS feed served by this
 * test: subscribe by URL, events in week, month, year, agenda, mini calendar and the subscribed list route, hide
 * and show, recolour, rename and unsubscribe, the private feed link (copy, fetch, reset), the Google entry in its
 * not-configured state, the CalDAV error path and the catalogue order. Sorts after zm5 on purpose.
 */
test.describe.configure({ mode: "serial" });
// a tall window: month cells then hold every chip of a busy day instead of folding them into "+N more"
test.use({ permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 3000 } });

let mock: MockCal;
const NAME = "Synthetic Running Club";
const TIMED = "Club practice";
const ALLDAY = "Neighbourhood market";
const MULTI = "Club weekend trip";
const feedTask = `Feed check ${Math.random().toString(36).slice(2, 8)}`;
const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");

test.beforeAll(async () => {
  mock = await startMockCal({
    "/club.ics": () =>
      icsOf(NAME, [
        { uid: "practice-1@e2e", title: TIMED, start: at(0, 10), end: at(0, 11), location: "Track 2", description: "Bring spikes." },
        { uid: "market-1@e2e", title: ALLDAY, day: 0 },
        { uid: "trip-1@e2e", title: MULTI, day: 1, days: 2 },
      ]),
  });
});
test.afterAll(async () => {
  await mock?.close();
});

async function openCalSettings(page: Page, view = "w"): Promise<void> {
  await page.goto(`/#c/all/calendar/${view}?modalType=settings&tabs=calendar`);
  await expect(page.getByTestId("cal-settings")).toBeVisible({ timeout: 15_000 });
}
async function closeSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.getByTestId("settings-modal")).toHaveCount(0);
}
const pick = async (page: Page, sel: "week" | "month" | "year" | "agenda"): Promise<void> => {
  await page.getByTestId("cal-view").click();
  await page.getByTestId(`cal-view-${sel}`).click();
  await expect(page.getByTestId("calendar")).toHaveAttribute("data-view", sel);
};
const srcRow = (page: Page) => page.getByTestId("cal-src").filter({ has: page.locator(`.cal-src-name`, { hasText: NAME }) });

test("catalogue: seven entries in order, every one opens a form, no upgrade prompt (CAL-061, CAL-087)", async ({ page }) => {
  await page.goto("/#q/all/tasks?modalType=settings&tabs=integrations");
  const names = page.getByTestId("cal-catalogue").locator(".cal-entry-name");
  await expect(names).toHaveText(["Google Calendar", "Outlook Calendar", "Exchange Calendar", "iCloud Calendar", "CalDAV", "Holidays", "URL"]);
  for (const k of ["google", "outlook", "exchange", "icloud", "caldav", "holiday", "url"]) {
    await page.getByTestId(`cal-entry-${k}`).click();
    await expect(page.getByTestId(`cal-form-${k}`)).toBeVisible();
    // each card opens its form in a dialog; Escape closes only the dialog
    await page.keyboard.press("Escape");
    await expect(page.getByTestId(`cal-form-${k}`)).toHaveCount(0);
    await expect(page.getByTestId("settings-modal")).toBeVisible();
  }
  await expect(page.getByText(/upgrade/i)).toHaveCount(0);
});

test("Google and Outlook show the not-configured state; Exchange says it is unavailable (CAL-071, CAL-072, CAL-073)", async ({ page }) => {
  await openCalSettings(page);
  await page.getByTestId("cal-entry-google").click();
  await expect(page.getByTestId("google-not-configured")).toBeVisible();
  await expect(page.getByTestId("google-connect-panel")).toHaveAttribute("data-state", "not-configured");
  await expect(page.getByTestId("google-connect")).toBeDisabled();
  await expect(page.getByTestId("google-connect")).toHaveText("Connect Google");
  await page.getByTestId("cal-entry-outlook").click();
  await expect(page.getByTestId("outlook-not-configured")).toBeVisible();
  await page.getByTestId("cal-entry-exchange").click();
  await expect(page.getByTestId("exchange-unavailable")).toBeVisible();
});

test("CalDAV form: four fields, a refused login shows an error and adds no account (CAL-068)", async ({ page }) => {
  await openCalSettings(page);
  await page.getByTestId("cal-entry-caldav").click();
  await page.getByTestId("caldav-server").fill(`${mock.base}/dav/`);
  await page.getByTestId("caldav-account").fill("synthetic-user");
  await page.getByTestId("caldav-password").fill("wrong-password");
  await page.getByTestId("caldav-name").fill("Synthetic DAV");
  await page.getByTestId("caldav-submit").click();
  await expect(page.getByTestId("cal-form-error")).toContainText(/refused|could not be reached/);
  expect(await api<unknown[]>("GET", "/api/v2/calendar/third/accounts")).toEqual([]);
});

test("holiday presets come from the server (CAL-079)", async ({ page }) => {
  const presets = await api<Array<{ name: string }>>("GET", "/api/v2/calendar/holidays/presets");
  await openCalSettings(page);
  await page.getByTestId("cal-entry-holiday").click();
  // never submitted here: a preset would make the server fetch a real public feed
  await expect(page.getByTestId("cal-holiday-select").locator("option")).toHaveCount(presets.length + 1);
  await expect(page.getByTestId("cal-holiday-select")).toContainText(presets[0]!.name);
});

test("subscribe to the mock ICS: its events show in week view in the calendar colour (CAL-064, CAL-065)", async ({ page }) => {
  // a tall all-day row so the seeded all-day tasks of today do not push the event into "+N"
  await page.addInitScript(() => localStorage.setItem("allDayViewHeight", "600"));
  await openCalSettings(page);
  await page.getByTestId("cal-entry-url").click();
  await page.getByTestId("cal-url-input").fill(`${mock.base}/club.ics`);
  await page.getByTestId("cal-url-name").fill(NAME);
  await page.getByTestId("cal-url-colors").locator('[data-color="#3fa66b"]').click();
  await page.getByTestId("cal-url-submit").click();
  await expect(srcRow(page)).toHaveCount(1);
  await expect(srcRow(page).getByTestId("cal-src-error")).toHaveCount(0);
  expect(mock.hits()).toBeGreaterThan(0);
  const subs = await api<Array<{ name: string; url: string; show: boolean }>>("GET", "/api/v2/calendar/subscription");
  expect(subs).toEqual([expect.objectContaining({ name: NAME, url: `${mock.base}/club.ics`, show: true })]);
  await closeSettings(page);

  await pick(page, "week");
  const block = page.locator(`[data-testid=cal-block][data-title="${TIMED}"]`);
  await expect(block).toHaveCount(1);
  await expect(block).toHaveAttribute("data-color", "#3fa66b");
  await expect(page.locator(`[data-testid=cal-allday-chip][data-title="${ALLDAY}"]`)).toHaveCount(1);
  // read-only detail popover
  await block.click();
  await expect(page.getByTestId("ext-event-pop")).toBeVisible();
  await expect(page.getByTestId("ext-event-title")).toHaveText(TIMED);
  await expect(page.getByTestId("ext-event-source")).toContainText(NAME);
  await expect(page.getByTestId("ext-event-readonly")).toBeVisible();
  await expect(page.getByTestId("ext-event-edit")).toHaveCount(0);
  await expect(page.locator(".ext-pop-body")).toContainText("Track 2");
  await expect(page.locator(".ext-pop-body")).toContainText("Bring spikes.");
  await page.getByTestId("ext-event-pop").getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("ext-event-pop")).toHaveCount(0);
  // events are not tasks: no resize handles, no checkbox
  await expect(block.locator(".cal-resize")).toHaveCount(0);
  await expect(block.getByTestId("cal-check")).toHaveCount(0);
});

test("month, year, agenda and the mini calendar show the events too (CAL-065, CAL-046)", async ({ page }) => {
  await page.goto("/#c/all/calendar/m");
  await pick(page, "month");
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveCount(1);
  await expect(page.locator(`[data-testid=cal-chip][data-title="${ALLDAY}"]`)).toHaveCount(1);
  // the two-day event is one bar (or two when it crosses a week row)
  const trip = page.locator(`[data-testid=cal-chip][data-title="${MULTI}"]`);
  expect(await trip.count()).toBeGreaterThanOrEqual(1);
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  await pick(page, "year");
  await expect(page.locator(`[data-testid=cal-year-day][data-date="${key}"]`)).toHaveAttribute("data-event", "1");
  await pick(page, "agenda");
  await expect(page.getByTestId("agenda-today").locator(`[data-testid=agenda-item][data-title="${TIMED}"]`)).toHaveCount(1);
  await expect(page.getByTestId("agenda-today").locator(`[data-testid=agenda-item][data-title="${TIMED}"] .cal-check`)).toHaveCount(0);
  // the calendar side panel's month navigator marks the day
  if ((await page.getByTestId("cal-side").count()) === 0) await page.getByTestId("cal-toggle-side").click();
  await expect(page.getByTestId("mini-month").locator(`[data-date="${key}"]`)).toHaveAttribute("data-event", "1");
  await expect(page.getByTestId("cal-side-source")).toHaveCount(1);
});

test("hide the calendar: its events vanish; show it again from the calendar side panel (CAL-075 visibility)", async ({ page }) => {
  await openCalSettings(page, "m");
  await srcRow(page).getByTestId("cal-src-show").click();
  await expect(srcRow(page).getByTestId("cal-src-show")).toHaveAttribute("aria-checked", "false");
  await closeSettings(page);
  await pick(page, "month");
  await expect(page.getByTestId("cal-chip").first()).toBeVisible();
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-testid=cal-chip][data-title="${ALLDAY}"]`)).toHaveCount(0);
  await expect.poll(async () => (await api<Array<{ show: boolean }>>("GET", "/api/v2/calendar/subscription"))[0]!.show).toBe(false);
  // still hidden after a reload (stored on the server)
  await page.reload();
  await expect(page.getByTestId("cal-month")).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveCount(0);
  if ((await page.getByTestId("cal-side").count()) === 0) await page.getByTestId("cal-toggle-side").click();
  await page.getByTestId("cal-side-source").locator("input").check();
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveCount(1);
  await expect.poll(async () => (await api<Array<{ show: boolean }>>("GET", "/api/v2/calendar/subscription"))[0]!.show).toBe(true);
});

test("change the colour: chips follow at once and after a reload (CAL-066)", async ({ page }) => {
  await openCalSettings(page, "m");
  await srcRow(page).getByTestId("cal-src-color").click();
  await page.getByTestId("cal-color-pop").locator('[data-color="#e5484d"]').click();
  await expect(srcRow(page).getByTestId("cal-src-color")).toHaveAttribute("data-color", "#e5484d");
  await closeSettings(page);
  await pick(page, "month");
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveAttribute("data-color", "#e5484d");
  await expect.poll(async () => (await api<Array<{ color: string }>>("GET", "/api/v2/calendar/subscription"))[0]!.color).toBe("#e5484d");
  await page.reload();
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveAttribute("data-color", "#e5484d");
});

test("sidebar Subscribed Calendars opens the calendar as a list (CAL-064, CAL-078)", async ({ page }) => {
  await page.goto("/#q/all/tasks");
  const row = page.getByTestId("side-subscribed");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(NAME);
  await row.locator(".side-main").click();
  await expect(page).toHaveURL(/#q\/[0-9a-f]{24}\/subscribe-calendar$/);
  await expect(page.getByTestId("subcal-screen")).toContainText(NAME);
  await expect(page.locator(`[data-testid=subcal-item][data-title="${TIMED}"]`)).toHaveCount(1);
  await page.locator(`[data-testid=subcal-item][data-title="${TIMED}"]`).click();
  await expect(page.getByTestId("ext-event-title")).toHaveText(TIMED);
});

test("private feed link: create, copy, fetch it with a dated task in it, list choice, reset revokes the old link (CAL-080, CAL-081)", async ({ page, request }) => {
  const inbox = await inboxId();
  const feedTaskId = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id: feedTaskId, projectId: inbox, title: feedTask, status: 0, kind: "TEXT", priority: 0, sortOrder: -(2 ** 40) * 70, timeZone: "Europe/Amsterdam", isFloating: false, isAllDay: true, startDate: iso(at(2, 0)), dueDate: iso(at(2, 0)), tags: [], items: [], reminders: [], exDate: [] }] });
  await openCalSettings(page);
  await page.getByTestId("feed-create").click();
  await expect(page.getByTestId("feed-url")).toHaveValue(/\/feed\/[0-9a-f]{48}\.ics$/);
  await page.getByTestId("feed-copy").click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(await page.getByTestId("feed-url").inputValue());
  expect(link.startsWith(new URL(page.url()).origin + "/feed/")).toBe(true);
  // fetched through the web origin (the same link a calendar app gets)
  const r1 = await request.get(link);
  expect(r1.status()).toBe(200);
  expect(r1.headers()["content-type"]).toContain("text/calendar");
  const body = await r1.text();
  expect(body).toContain("BEGIN:VCALENDAR");
  expect(body).toContain(`SUMMARY:${feedTask}`);
  // feed lists: leave the Inbox out, the task drops from the feed
  await page.getByTestId("feed-lists").getByLabel("Inbox").uncheck();
  await expect.poll(async () => (await api<{ projectIds: string[] | null }>("GET", "/api/v2/calendar/feeds/code")).projectIds?.includes("inbox")).toBe(false);
  expect(await (await request.get(link)).text()).not.toContain(feedTask);
  await page.getByTestId("feed-lists").getByLabel("Inbox").check();
  await expect.poll(async () => (await api<{ projectIds: string[] | null }>("GET", "/api/v2/calendar/feeds/code")).projectIds).toBeNull();
  // a completed task drops from the feed while Include completed is off, and returns when it is on
  await api("POST", "/api/v2/batch/task", { update: [{ ...(await api<Record<string, unknown>>("GET", `/api/v2/task/${feedTaskId}`)), status: 2, completedTime: iso(Date.now()) }] });
  expect(await (await request.get(link)).text()).not.toContain(feedTask);
  await page.getByTestId("feed-include-done").click();
  await expect.poll(async () => (await api<{ includeDone: boolean }>("GET", "/api/v2/calendar/feeds/code")).includeDone).toBe(true);
  expect(await (await request.get(link)).text()).toContain(feedTask);
  // reset: a new link, the old one answers 404
  await page.getByTestId("feed-reset").click();
  await page.getByTestId("feed-reset-confirm").click();
  await expect(page.getByTestId("feed-url")).not.toHaveValue(link);
  expect((await request.get(link)).status()).toBe(404);
  const fresh = await page.getByTestId("feed-url").inputValue();
  expect(await (await request.get(fresh)).text()).toContain(feedTask);
  // turn off: no link left
  await page.getByTestId("feed-revoke").click();
  await expect(page.getByTestId("feed-create")).toBeVisible();
  expect((await request.get(fresh)).status()).toBe(404);
});

test("display rows: Show holidays and Show declined events are stored (CAL-050, CAL-028)", async ({ page }) => {
  await openCalSettings(page);
  await expect(page.getByTestId("set-holiday-enabled")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("set-show-declined").click();
  await expect(page.getByTestId("set-show-declined")).toHaveAttribute("aria-checked", "true");
  await expect.poll(async () => ((await api<{ calendarViewConf?: { showDeclinedEvents?: boolean } }>("GET", "/api/v2/user/preferences/settings")).calendarViewConf ?? {}).showDeclinedEvents, { timeout: 15_000 }).toBe(true);
  await page.getByTestId("set-show-declined").click();
  await expect.poll(async () => ((await api<{ calendarViewConf?: { showDeclinedEvents?: boolean } }>("GET", "/api/v2/user/preferences/settings")).calendarViewConf ?? {}).showDeclinedEvents, { timeout: 15_000 }).toBe(false);
});

test("rename, then unsubscribe: the events disappear (CAL-066)", async ({ page }) => {
  await openCalSettings(page, "m");
  await srcRow(page).getByTestId("cal-src-edit").click();
  await page.getByTestId("cal-src-name-input").fill("Renamed Club");
  await page.getByTestId("cal-src-save").click();
  const renamed = page.getByTestId("cal-src").filter({ hasText: "Renamed Club" });
  await expect(renamed).toHaveCount(1);
  await expect.poll(async () => (await api<Array<{ name: string }>>("GET", "/api/v2/calendar/subscription"))[0]!.name).toBe("Renamed Club");
  await closeSettings(page);
  await pick(page, "month");
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveCount(1);
  await page.goto("/#c/all/calendar/m?modalType=settings&tabs=calendar");
  await renamed.getByTestId("cal-src-delete").click();
  await renamed.getByTestId("cal-src-delete-confirm").click();
  await expect(page.getByTestId("cal-src")).toHaveCount(0);
  await expect(page.getByTestId("cal-none")).toBeVisible();
  await closeSettings(page);
  await expect(page.getByTestId("cal-chip").first()).toBeVisible();
  await expect(page.locator(`[data-testid=cal-chip][data-title="${TIMED}"]`)).toHaveCount(0);
  expect(await api<unknown[]>("GET", "/api/v2/calendar/subscription")).toEqual([]);
});

/**
 * Connected-account screens against stubbed answers: the e2e server has no Google credentials and no account,
 * so the account routes are answered in the browser (page.route). The app code runs unchanged; this proves the
 * requests it makes and how it draws the answers, not a real Google round trip.
 */
test("two-way account (stubbed answers): colours, edit an event, per-calendar hide, link to a list, list route, disconnect (CAL-069, CAL-075, CAL-076)", async ({ page }) => {
  const A = "6739a1b2c3d4e5f6a7b8c9d0";
  const inbox = await inboxId();
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const account = {
    id: A, provider: "google", account: "synthetic@example.test", displayName: "synthetic@example.test", itemType: 6, status: "active", needsReauth: false, show: true,
    calendars: [{ id: "work", name: "Work", color: "#5b6ee1", show: true }, { id: "team", name: "Team", color: "#14a3a3", show: true, readOnly: true }],
  };
  const wireEv = (cal: string, uid: string, title: string, s: number, e: number, allDay: boolean, readOnly: boolean) => ({
    id: `${A}:${cal}:${uid}`, key: `acc:${A}:${cal}:${uid}`, uid, kind: 3, sourceType: "google", itemType: 6, sourceId: A, accountId: A, calendarId: cal, title, color: null,
    start: s, end: e, allDay, isAllDay: allDay, startDate: iso(s), dueDate: iso(e), dueStart: iso(s), dueEnd: iso(e), completed: false, readOnly, location: "Room 4",
  });
  let bindings: unknown[] = [];
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/v2/calendar/third/accounts", (r) => r.fulfill(json([account])));
  await page.route("**/api/v2/calendar/bind/events/all**", (r) => r.fulfill(json([wireEv("work", "evt-1", "Design review", at(0, 13), at(0, 14), false, false), wireEv("team", "evt-2", "Team offsite", at(0, 0), at(1, 0), true, true)])));
  await page.route(`**/api/v2/calendar/accounts/${A}/events/**`, async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill(json({}));
  });
  await page.route(`**/api/v2/calendar/batch/${A}/show**`, async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: r.request().postDataJSON() });
    await r.fulfill(json(account));
  });
  await page.route(`**/api/v4/calendar/update/${A}`, async (r) => {
    const body = r.request().postDataJSON() as { calendars: unknown };
    calls.push({ method: "POST", url: r.request().url(), body });
    await r.fulfill(json({ ...account, calendars: body.calendars }));
  });
  await page.route(`**/api/v2/calendar/${A}/bind/project**`, async (r) => {
    const m = r.request().method();
    if (m === "POST") {
      const b = r.request().postDataJSON() as Record<string, unknown>;
      calls.push({ method: m, url: r.request().url(), body: b });
      bindings = [{ id: "bind-1", accountId: A, ...b }];
      return r.fulfill(json(bindings[0]));
    }
    if (m === "DELETE") {
      calls.push({ method: m, url: r.request().url(), body: null });
      bindings = [];
      return r.fulfill(json({ unlinked: true }));
    }
    return r.fulfill(json(bindings));
  });
  await page.route(`**/api/v2/calendar/connect/${A}`, async (r) => {
    calls.push({ method: r.request().method(), url: r.request().url(), body: null });
    await r.fulfill(json({ disconnected: true }));
  });

  await page.addInitScript(() => localStorage.setItem("allDayViewHeight", "600"));
  await page.goto("/#c/all/calendar/w");
  await pick(page, "week");
  const review = page.locator('[data-testid=cal-block][data-title="Design review"]');
  await expect(review).toHaveAttribute("data-color", "#5b6ee1");
  await expect(page.locator('[data-testid=cal-allday-chip][data-title="Team offsite"]')).toHaveAttribute("data-color", "#14a3a3");
  // a read-only remote calendar: no edit
  await page.locator('[data-testid=cal-allday-chip][data-title="Team offsite"]').click();
  await expect(page.getByTestId("ext-event-readonly")).toBeVisible();
  await page.getByTestId("ext-event-pop").getByRole("button", { name: "Close" }).click();
  // a two-way calendar: edit the title, the PUT carries only the change and the calendar id
  await review.click();
  await expect(page.getByTestId("ext-event-source")).toContainText("Work · synthetic@example.test · Google");
  await page.getByTestId("ext-event-edit").click();
  await page.getByTestId("ext-edit-title").fill("Design review v2");
  await page.getByTestId("ext-edit-save").click();
  await expect(page.getByTestId("ext-event-pop")).toHaveCount(0);
  const put = calls.find((c) => c.method === "PUT" && c.url.includes("/events/"))!;
  expect(put.url).toContain(`/api/v2/calendar/accounts/${A}/events/evt-1`);
  expect(put.body).toEqual({ calendarId: "work", title: "Design review v2" });
  // delete
  await review.click();
  await page.getByTestId("ext-event-delete").click();
  await page.getByTestId("ext-event-delete-confirm").click();
  await expect(page.getByTestId("ext-event-pop")).toHaveCount(0);
  const del = calls.find((c) => c.method === "DELETE" && c.url.includes("/events/"))!;
  expect(del.url).toContain(`/events/evt-1?calendarId=work`);

  // settings: the account, its calendars, colour, hide one calendar, link it to the Inbox
  await page.goto("/#c/all/calendar/w?modalType=settings&tabs=calendar");
  const accRow = page.getByTestId("cal-account");
  await expect(accRow).toHaveAttribute("data-provider", "google");
  await expect(accRow).toContainText("Two-way");
  const work = accRow.locator('[data-testid=cal-src][data-name="Work"]');
  await work.getByTestId("cal-src-color").click();
  await page.getByTestId("cal-color-pop").locator('[data-color="#ef7d31"]').click();
  await expect.poll(() => calls.some((c) => c.url.includes("/api/v4/calendar/update/"))).toBe(true);
  expect((calls.find((c) => c.url.includes("/api/v4/calendar/update/"))!.body as { calendars: Array<{ id: string; color: string }> }).calendars.find((c) => c.id === "work")!.color).toBe("#ef7d31");
  await expect(accRow.locator('[data-testid=cal-src][data-name="Team"]').getByTestId("cal-bind-form")).toHaveCount(0);
  await work.getByTestId("cal-bind-target").selectOption(inbox);
  await work.getByTestId("cal-bind-tags").fill("gcal");
  await work.getByTestId("cal-bind-save").click();
  await expect(work.getByTestId("cal-binding")).toContainText("Two-way with Inbox");
  expect(calls.find((c) => c.method === "POST" && c.url.includes("/bind/project"))!.body).toEqual({ calendarId: "work", syncProjectScope: "project", syncProjectId: inbox, defaultTags: ["gcal"] });
  await work.getByTestId("cal-unbind").click();
  await expect(work.getByTestId("cal-bind-form")).toBeVisible();
  expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/bind/project?id=bind-1"))).toBe(true);
  await work.getByTestId("cal-src-show").click();
  const show = calls.find((c) => c.url.includes(`/batch/${A}/show`))!;
  expect(show.body).toEqual({ show: false, calendarId: "work" });
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(review).toHaveCount(0);
  await expect(page.locator('[data-testid=cal-allday-chip][data-title="Team offsite"]')).toHaveCount(1);

  // the account list route from the sidebar
  await page.goto("/#q/all/tasks");
  await page.getByTestId("side-subscribed").filter({ hasText: "synthetic@example.test" }).locator(".side-main").click();
  await expect(page).toHaveURL(new RegExp(`#q/${A}/subscribe-account-calendar$`));
  await expect(page.locator('[data-testid=subcal-item][data-title="Team offsite"]')).toHaveCount(1);

  // disconnect
  await page.goto("/#q/all/tasks?modalType=settings&tabs=calendar");
  await page.getByTestId("cal-account-disconnect").click();
  await page.getByTestId("cal-account-disconnect-confirm").click();
  await expect(page.getByTestId("cal-account")).toHaveCount(0);
  expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith(`/api/v2/calendar/connect/${A}`))).toBe(true);
});
