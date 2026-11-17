import { expect, test, type Page } from "@playwright/test";
import { api, inboxId, oid } from "./seed";

/**
 * M4 on synthetic data against the real server: habits, focus, statistics, countdown, summary, calendar overlays.
 * The file sorts last on purpose: it switches the M4 features on, and the earlier specs expect them off.
 */
const step = 2 ** 40;
const today = (): number => {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};
const shift = (stamp: number, n: number): number => {
  const d = new Date(Math.floor(stamp / 10000), Math.floor((stamp % 10000) / 100) - 1, stamp % 100);
  d.setDate(d.getDate() + n);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};
async function synced(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
}
type Checkin = { id: string; checkinStamp: number; status: number; value: number };
const checkins = async (habitId: string): Promise<Checkin[]> => (await api<{ checkins: Record<string, Checkin[]> }>("POST", "/api/v2/habitCheckins/query", { habitIds: [habitId] })).checkins[habitId] ?? [];
const habitByName = async (name: string) => (await api<Array<{ id: string; name: string; exDates?: string[]; status: number; recordEnable?: boolean; sectionId?: string }>>("GET", "/api/v2/habits")).find((h) => h.name === name);
const settings = () => api<{ tabBars?: Array<{ name: string; enabled: boolean }>; enableCountdown?: boolean; pomodoroEnabled?: boolean }>("GET", "/api/v2/user/preferences/settings");

test.describe.configure({ mode: "serial" });

test("features: Habit Tracker, Pomodoro and Countdown switches add and remove their tabs (HAB-001, FOC-001, CNT-001, SET-121..123)", async ({ page }) => {
  await page.goto("/#q/all/tasks?modalType=settings&tabs=feature");
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await expect(page.getByTestId("rail-habit")).toHaveCount(0);
  await page.getByTestId("feature-habit").click();
  await page.getByTestId("feature-pomo").click();
  await page.getByTestId("feature-countdown").click();
  await expect(page.getByTestId("rail-habit")).toBeVisible();
  await expect(page.getByTestId("rail-focus")).toBeVisible();
  await expect(page.getByTestId("rail-countdown")).toBeVisible();
  await synced(page);
  const s = await settings();
  expect(s.tabBars?.find((b) => b.name === "HABIT")?.enabled).toBe(true);
  expect(s.tabBars?.find((b) => b.name === "POMO")?.enabled).toBe(true);
  expect(s.pomodoroEnabled).toBe(true);
  expect(s.enableCountdown).toBe(true);
  expect(await api("GET", "/api/v2/user/preferences/habit?platform=web")).toMatchObject({ enabled: true });
  // off hides, on again for the rest of the file
  await page.getByTestId("feature-countdown").click();
  await expect(page.getByTestId("rail-countdown")).toHaveCount(0);
  await page.getByTestId("feature-countdown").click();
  await expect(page.getByTestId("rail-countdown")).toBeVisible();
  // the Focus and Habit settings tabs carry their controls (SET-214..228)
  await page.getByTestId("settings-tab-focus").click();
  for (const id of ["set-pomo-duration", "set-short-break", "set-long-break", "set-long-interval", "set-auto-pomo", "set-auto-break", "set-pomo-goal", "set-tab-time", "set-auto-full", "set-anti-burn", "set-focus-sync"]) await expect(page.getByTestId(id)).toBeVisible();
  await page.getByTestId("set-pomo-duration").fill("3");
  await page.getByTestId("set-pomo-goal").click();
  await expect(page.getByTestId("set-pomo-duration")).toHaveValue("5");
  await page.getByTestId("settings-tab-habit").click();
  for (const id of ["set-habit-sort", "set-habit-today", "set-manage-sections"]) await expect(page.getByTestId(id)).toBeVisible();
  await synced(page);
  expect(await api("GET", "/api/v2/user/preferences/pomodoro")).toMatchObject({ pomoDuration: 5 });
  await api("POST", "/api/v2/user/preferences/pomodoro", { pomoDuration: 25 });
});

test("habits: create from the dialog, check in, the URL carries the habit, Today shows it (HAB-002, HAB-005, HAB-011, HAB-013)", async ({ page }) => {
  await page.goto("/#q/all/habit");
  await expect(page.getByTestId("habit-screen")).toBeVisible();
  await page.getByTestId("habit-add").click();
  await expect(page.getByTestId("gallery-tab")).toHaveCount(4);
  await page.getByTestId("habit-custom").click();
  // defaults: daily, every day, check in once
  await expect(page.getByTestId("habit-weekdays").locator("button.on")).toHaveCount(7);
  await page.getByTestId("habit-name").fill("Stretch e2e");
  await page.getByTestId("habit-save").click();
  await expect(page).toHaveURL(/#q\/all\/habit\/[0-9a-f]{24}$/);
  await expect(page.getByTestId("habit-detail-name")).toHaveText("Stretch e2e");
  const row = page.locator('[data-testid=habit-row][data-name="Stretch e2e"]');
  await row.getByTestId("habit-check").click();
  await expect(row.getByTestId("habit-check")).toHaveAttribute("data-done", "1");
  await synced(page);
  const h = (await habitByName("Stretch e2e"))!;
  expect(h).toMatchObject({ status: 0 });
  expect((await api<Array<{ id: string; repeatRule: string; goal: number; unit: string }>>("GET", "/api/v2/habits")).find((x) => x.id === h.id)).toMatchObject({ repeatRule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA", goal: 1, unit: "Count" });
  expect(await checkins(h.id)).toEqual([expect.objectContaining({ checkinStamp: today(), status: 2 })]);
  // Today list shows the habit; the habit setting removes it
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("today-habits").locator('[data-name="Stretch e2e"]')).toBeVisible();
  await page.goto("/#q/today/tasks?modalType=settings&tabs=habit");
  await page.getByTestId("set-habit-today").click();
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("today-habits")).toHaveCount(0);
  await page.goto("/#q/today/tasks?modalType=settings&tabs=habit");
  await page.getByTestId("set-habit-today").click();
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("today-habits")).toBeVisible();
});

test("habits: edit a past check-in, skip a day, streak badge flips and survives reload (HAB-025, RPT-104, HAB-024)", async ({ page }) => {
  const h = (await habitByName("Stretch e2e"))!;
  const past = shift(today(), -2);
  await page.goto(`/#q/all/habit/${h.id}`);
  await expect(page.getByTestId("habit-detail")).toBeVisible();
  // the past day may sit in the previous month
  if (Math.floor(past / 100) !== Math.floor(today() / 100)) await page.getByTestId("habit-month-prev").click();
  const day = page.locator(`[data-testid=habit-day][data-stamp="${past}"]`);
  await day.click();
  await expect(day).toHaveAttribute("data-state", "done");
  await synced(page);
  expect((await checkins(h.id)).find((c) => c.checkinStamp === past)).toMatchObject({ status: 2 });
  // after the fact: edit the same day to Not done with a note
  await day.click({ button: "right" });
  await page.getByTestId("habit-day-edit").click();
  await expect(page.getByTestId("checkin-editor")).toBeVisible();
  await page.getByTestId("checkin-status").getByText("Not done").click();
  await page.getByTestId("log-note").fill("Too tired, back tomorrow");
  await page.getByTestId("checkin-save").click();
  await expect(day).toHaveAttribute("data-state", "undone");
  await synced(page);
  expect((await checkins(h.id)).find((c) => c.checkinStamp === past)).toMatchObject({ status: 1 });
  const recs = await api<{ habitRecords: Record<string, Array<{ content: string }>> }>("POST", "/api/v2/getHabitRecords", { habitIds: [h.id] });
  expect(recs.habitRecords[h.id]![0]!.content).toBe("Too tired, back tomorrow");
  // skip the day before: exDates gets the date
  const skip = shift(today(), -1);
  if (Math.floor(skip / 100) !== Math.floor(past / 100)) await page.getByTestId("habit-month-next").click();
  await page.locator(`[data-testid=habit-day][data-stamp="${skip}"]`).click({ button: "right" });
  await page.getByTestId("habit-day-skip").click();
  await expect(page.locator(`[data-testid=habit-day][data-stamp="${skip}"]`)).toHaveAttribute("data-state", "skipped");
  await synced(page);
  expect((await habitByName("Stretch e2e"))!.exDates).toContain(String(skip));
  // streak badge
  await expect(page.getByTestId("habit-streak-label")).toHaveText("Current Streak");
  await page.getByTestId("habit-streak").click();
  await expect(page.getByTestId("habit-streak-label")).toHaveText("Total Days");
  await synced(page);
  await page.reload();
  await expect(page.getByTestId("habit-streak-label")).toHaveText("Total Days");
  await page.getByTestId("habit-streak").click();
  await expect(page.getByTestId("habit-streak-label")).toHaveText("Current Streak");
});

test("habits: amount goal by taps, log popup with Don't show again, card tap, sections, archive and delete (HAB-014, HAB-801, HAB-029, HAB-019, HAB-026, HAB-027)", async ({ page }) => {
  await page.goto("/#q/all/habit");
  await page.getByTestId("habit-add").click();
  await page.getByTestId("habit-custom").click();
  await page.getByTestId("habit-name").fill("Water e2e");
  await page.getByTestId("goal-amount").click();
  await page.getByTestId("habit-goal").fill("3");
  await page.getByTestId("habit-unit").fill("glasses");
  await page.getByTestId("habit-record-enable").click();
  await page.getByTestId("habit-save").click();
  const row = page.locator('[data-testid=habit-row][data-name="Water e2e"]');
  const btn = row.getByTestId("habit-check");
  await btn.click();
  await btn.click();
  await expect(btn).toHaveAttribute("data-done", "0");
  await btn.click();
  await expect(btn).toHaveAttribute("data-done", "1");
  // the third tap completed the day: the log popup asks for a note
  await expect(page.getByTestId("habit-log-popup")).toBeVisible();
  await page.getByTestId("log-note").fill("Easy today");
  await page.getByTestId("log-save").click();
  await synced(page);
  const h = (await habitByName("Water e2e"))!;
  expect((await checkins(h.id))[0]).toMatchObject({ value: 3, status: 2 });
  // open the log again (Add log), delete it, and switch the popup off
  await page.getByTestId("habit-add-log").click();
  await expect(page.getByTestId("log-note")).toHaveValue("Easy today");
  await page.getByTestId("log-never").check();
  await page.getByTestId("log-delete").click();
  await expect(page.getByTestId("habit-log")).toHaveCount(0);
  await synced(page);
  expect((await habitByName("Water e2e"))!.recordEnable).toBe(false);
  // undo today and achieve it all from the menu: no popup any more
  await btn.click();
  await btn.click({ button: "right" });
  await page.getByText("Achieve it all").click();
  await expect(btn).toHaveAttribute("data-done", "1");
  await expect(page.getByTestId("habit-log-popup")).toHaveCount(0);
  // card layout: tapping the icon checks in
  await page.getByTestId("habit-style-card").click();
  const card = page.locator('[data-testid=habit-card][data-name="Stretch e2e"]');
  await card.getByTestId("habit-card-icon").click();
  await page.getByTestId("habit-style-list").click();
  await synced(page);
  const st = (await habitByName("Stretch e2e"))!;
  expect((await checkins(st.id)).find((c) => c.checkinStamp === today())?.status).not.toBe(2); // it was done, the tap undid it
  // sections: add Evening, assign the habit, the group header shows
  await page.getByTestId("habit-more").click();
  await page.getByTestId("habit-manage-sections").click();
  await page.getByTestId("section-name").fill("Evening");
  await page.getByTestId("section-add").click();
  await expect(page.locator('[data-testid=section-item][data-name="Evening"]')).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await row.click();
  await page.getByTestId("habit-edit").click();
  await page.getByTestId("habit-section").click();
  await page.getByRole("menuitem", { name: "Evening" }).click();
  await page.getByTestId("habit-save").click();
  await expect(page.locator('[data-testid=habit-group][data-name="Evening"]').locator('[data-name="Water e2e"]')).toBeVisible();
  // archive, restore, delete
  await page.getByTestId("habit-detail-more").click();
  await page.getByTestId("habit-archive").click();
  await expect(row).toHaveCount(0);
  await page.getByTestId("habit-more").click();
  await page.getByTestId("habit-show-archived").click();
  await expect(row).toBeVisible();
  await row.click();
  await page.getByTestId("habit-detail-more").click();
  await page.getByTestId("habit-unarchive").click();
  await expect(row).toHaveCount(0); // restored: it left the archived list
  await page.getByTestId("habit-more").click();
  await page.getByTestId("habit-show-archived").click();
  await expect(row).toBeVisible(); // back in the active list, history kept
  await synced(page);
  expect((await habitByName("Water e2e"))!.status).toBe(0);
  await row.click();
  await page.getByTestId("habit-detail-more").click();
  await page.getByTestId("habit-delete").click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(row).toHaveCount(0);
  await synced(page);
  expect(await habitByName("Water e2e")).toBeUndefined();
  expect(await checkins(h.id)).toEqual([]);
});

test("focus: a pomodoro linked to a task runs to the end, the record and statistics show it (FOC-014, TASK-151, FOC-038, FOC-008)", async ({ page }) => {
  const inbox = await inboxId();
  const tid = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id: tid, projectId: inbox, title: "Focus target e2e", status: 0, kind: "TEXT", priority: 0, sortOrder: -step }] });
  await page.clock.install();
  await page.goto(`/#p/${inbox}/tasks`);
  const taskRow = page.locator('[data-testid=task-row][data-title="Focus target e2e"]');
  await expect(taskRow).toBeVisible();
  await taskRow.click({ button: "right" });
  await page.getByTestId("menu-start-focus").click();
  await expect(page.getByTestId("focus-screen")).toBeVisible();
  await expect(page.getByTestId("bind-title")).toHaveText("Focus target e2e");
  await expect(page.getByTestId("timer-clock")).toHaveText(/^2[45]:\d\d$/);
  await page.clock.runFor(3000);
  await expect.poll(() => page.title()).toMatch(/^24:5\d Focus - NoorTasks$/);
  // jump to the end of the 25 minutes: the phase ends on its scheduled moment
  await page.clock.fastForward("25:30");
  await page.clock.runFor(1500);
  await expect(page.getByTestId("timer-phase")).toContainText("Short break");
  const rec = page.locator('[data-testid=record-row][data-title="Focus target e2e"]');
  await expect(rec).toBeVisible();
  await expect(rec.getByTestId("record-duration")).toHaveText("25m");
  await page.clock.runFor(16_000);
  await synced(page);
  const byTask = await api<Array<{ id: string; type?: number }>>("GET", `/api/v2/pomodoros/task?taskId=${tid}`);
  expect(byTask).toHaveLength(1);
  const gen = await api<{ todayPomoCount: number; todayPomoDuration: number; pomoGoal: number }>("GET", "/api/v2/statistics/general");
  expect(gen.todayPomoCount).toBeGreaterThanOrEqual(1);
  expect(gen.todayPomoDuration).toBeGreaterThanOrEqual(25);
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.goto("/#statistics/pomo");
  await expect(page.getByTestId("focus-today-pomos")).toContainText(/[1-9]/);
  await expect(page.getByTestId("goal-progress")).toBeVisible();
});

test("focus: add a record six months back, edit it, delete it; stopwatch then replace prompt (FOC-019, FOC-020, FOC-801, FOC-012)", async ({ page }) => {
  await page.goto("/#focus");
  await expect(page.getByTestId("records-pane")).toBeVisible();
  await synced(page);
  await expect(page.getByTestId("kpi-total-focus")).not.toHaveText("0m"); // the record of the previous test arrived
  const total0 = await page.getByTestId("kpi-total-focus").textContent();
  await page.getByTestId("record-add").click();
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await page.getByTestId("record-date").fill(ds);
  await page.getByTestId("record-start").fill("10:00");
  await page.getByTestId("record-end").fill("10:40");
  await page.getByTestId("record-save").click();
  const row = page.getByTestId("record-row").filter({ hasText: "10:00" }).last();
  await expect(row.getByTestId("record-duration")).toHaveText("40m");
  await row.click();
  await page.getByTestId("record-end").fill("11:10");
  await page.getByTestId("record-save").click();
  await expect(page.getByTestId("record-row").filter({ hasText: "11:10" }).last().getByTestId("record-duration")).toHaveText("1h 10m");
  await synced(page);
  const tl = await api<Array<{ startTime: string }>>("GET", "/api/v2/pomodoros/timeline");
  void tl;
  await page.getByTestId("record-row").filter({ hasText: "11:10" }).last().click();
  await page.getByTestId("record-delete").click();
  await expect(page.getByTestId("kpi-total-focus")).toHaveText(total0 ?? "");
  // stopwatch counts up; a timer card start while it runs asks first
  await page.getByTestId("mode-stopwatch").click();
  await page.getByTestId("focus-start").click();
  await expect(page.getByTestId("timer-phase")).toHaveText("Stopwatch");
  await page.getByTestId("timer-add").click();
  await page.getByTestId("timer-name").fill("Reading e2e");
  await page.getByTestId("timer-save").click();
  await page.locator('[data-testid=timer-card][data-name="Reading e2e"]').getByTestId("timer-start").click();
  await expect(page.getByTestId("focus-replace")).toBeVisible();
  await page.getByTestId("focus-replace-ok").click();
  await expect(page.getByTestId("timer-phase")).toHaveText("Focus");
  await expect(page.getByTestId("bind-title")).toHaveText("Reading e2e");
  await page.getByTestId("focus-pause").click();
  await page.getByTestId("focus-end").click();
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByTestId("focus-start")).toBeVisible();
  await synced(page);
  expect((await api<Array<{ name: string }>>("GET", "/api/v2/timer")).some((t) => t.name === "Reading e2e")).toBe(true);
});

test("focus: a timer started in one browser shows in another, pause follows (FOC-026, FOC-027)", async ({ browser }, info) => {
  await api("POST", "/api/v2/user/preferences/ext", { focusConf: { keepInSync: true } });
  const opts = { baseURL: info.project.use.baseURL, timezoneId: "Europe/Amsterdam", viewport: { width: 1440, height: 900 } };
  const ca = await browser.newContext(opts);
  const cb = await browser.newContext(opts);
  const a = await ca.newPage();
  const b = await cb.newPage();
  await a.goto("/#focus");
  await b.goto("/#focus");
  await expect(a.getByTestId("focus-start")).toBeVisible();
  await expect(b.getByTestId("focus-start")).toBeVisible();
  await a.getByTestId("focus-start").click();
  await expect(a.getByTestId("focus-pause")).toBeVisible();
  // B picks it up from the server within a few seconds
  await expect(b.getByTestId("focus-pause")).toBeVisible({ timeout: 10_000 });
  await expect(b.getByTestId("timer-clock")).toHaveText(/^2[45]:\d\d$/);
  await b.getByTestId("focus-pause").click();
  await expect(a.getByTestId("timer-phase")).toContainText("paused", { timeout: 10_000 });
  await a.getByTestId("focus-end").click();
  await a.getByRole("button", { name: "Discard" }).click();
  await expect(b.getByTestId("focus-start")).toBeVisible({ timeout: 10_000 });
  await ca.close();
  await cb.close();
  await api("POST", "/api/v2/user/preferences/ext", { focusConf: { keepInSync: false } });
});

test("kanban: focusing a task in a kanban list offers to move it to Progress (KANB-801)", async ({ page }) => {
  const pid = oid();
  await api("POST", "/api/v2/batch/project", { add: [{ id: pid, name: "Board focus e2e", sortOrder: 60 * step, kind: "TASK", viewMode: "kanban", inAll: true }] });
  const col = oid();
  await api("POST", "/api/v2/batch/columnProject", { add: [{ id: col, projectId: pid, name: "To do", sortOrder: 0 }] });
  const tid = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id: tid, projectId: pid, columnId: col, title: "Card to focus", status: 0, sortOrder: 0 }] });
  await page.goto(`/#p/${pid}/kanban`);
  const card = page.locator('[data-testid=kb-card][data-title="Card to focus"]');
  await expect(card).toBeVisible();
  await card.click();
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-start-focus").click();
  await expect(page.getByTestId("toast-action")).toHaveText("Move");
  await page.getByTestId("toast-action").click();
  await page.getByTestId("focus-pause").click();
  await page.getByTestId("focus-end").click();
  await page.getByRole("button", { name: "Discard" }).click();
  await synced(page);
  const cols = await api<Array<{ id: string; name: string }>>("GET", `/api/v2/column/project/${pid}`);
  const prog = cols.find((c) => c.name === "Progress");
  expect(prog).toBeTruthy();
  expect((await api<{ columnId: string }>("GET", `/api/v2/task/${tid}`)).columnId).toBe(prog!.id);
});

test("countdown: empty state, add from the + menu, it shows on the calendar, the option hides it (CNT-002, CNT-004, CAL-034)", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await synced(page);
  const fired: string[] = [];
  page.on("request", (r) => r.url().includes("/countdown") && fired.push(r.url()));
  await page.getByTestId("rail-countdown").click();
  await expect(page.getByTestId("countdown-screen")).toBeVisible();
  await expect(page.getByTestId("countdown-empty")).toContainText("Keep track of every special day.");
  await page.waitForTimeout(300);
  expect(fired).toEqual([]); // opening the screen fires no countdown request
  await page.getByTestId("countdown-add").click();
  await expect(page.getByTestId("countdown-add-menu").getByRole("menuitem")).toHaveText(["Countdown", "Anniversary", "Birthday", "Holiday"]);
  await page.getByTestId("countdown-add-4").click();
  await page.getByTestId("countdown-name").fill("Exam day e2e");
  const d = new Date();
  d.setDate(d.getDate() + 3);
  const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  await page.getByTestId("countdown-date").fill(ds);
  await page.getByTestId("countdown-save").click();
  const card = page.locator('[data-testid=countdown-card][data-name="Exam day e2e"]');
  await expect(card).toBeVisible();
  await expect(card.getByTestId("countdown-number")).toContainText("3");
  await synced(page);
  const list = await api<Array<{ name: string; date: number; type: number }>>("GET", "/api/v2/countdown/list");
  expect(list.find((c) => c.name === "Exam day e2e")).toMatchObject({ date: Number(ds.replace(/-/g, "")), type: 4 });
  // a habit done today, for the Show Habits check below
  const hid = oid();
  await api("POST", "/api/v2/habits/batch", { add: [{ id: hid, name: "Calendar habit e2e", color: "#3fa66b" }] });
  await api("POST", "/api/v2/habitCheckins/batch", { add: [{ id: oid(), habitId: hid, checkinStamp: today(), status: 2 }] });
  // calendar month shows it on its date; Show Countdown off removes it
  await page.goto("/#c/all/calendar/m");
  await page.getByTestId("cal-view").click();
  await page.getByTestId("cal-view-month").click();
  const cell = page.locator(`[data-testid=cal-cell][data-date="${ds}"]`);
  await expect(cell.getByTestId("cal-mark-countdown")).toContainText("Exam day e2e");
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-countdown").click();
  await expect(cell.getByTestId("cal-mark-countdown")).toHaveCount(0);
  // Show Habits on: today's done check-ins appear in the cell (CAL-033)
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-habit").click();
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-countdown").click();
  await expect(cell.getByTestId("cal-mark-countdown")).toHaveCount(1);
  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await expect(page.locator(`[data-testid=cal-cell][data-date="${ts}"]`).getByTestId("cal-mark-habit").filter({ hasText: "Calendar habit e2e" })).toBeVisible();
});

test("statistics: avatar menu opens the overlay, tabs change the URL, Done goes back (SMART-045, STAT-001, STAT-002, STAT-006)", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await page.getByTestId("avatar").click();
  await page.getByRole("menuitem", { name: "Statistics" }).click();
  await expect(page.getByTestId("statistics")).toBeVisible();
  await expect(page.getByTestId("stats-tab-overview")).toBeVisible();
  await expect(page.getByTestId("stats-tab-pomo")).toBeVisible();
  await expect(page.getByTestId("score-line-pt")).toHaveCount(7);
  await page.getByTestId("stats-tab-task").click();
  await expect(page).toHaveURL(/#statistics\/task$/);
  await expect(page.getByTestId("task-distribution")).toBeVisible();
  await page.getByTestId("stats-done").click();
  // back on Today; an earlier spec may have saved Today's layout as kanban
  await expect(page).toHaveURL(/#q\/today\/(tasks|kanban)$/);
});

test("summary: G then B opens it and it asks for completed tasks with limit 1000 (KEYS-043, SMART-046, NOTE-020)", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("list-view")).toBeVisible();
  const req = page.waitForRequest((r) => r.url().includes("/api/v2/project/all/completed/") && r.url().includes("limit=1000"));
  await page.keyboard.press("g");
  await page.keyboard.press("b");
  const r = await req;
  // query dates travel in UTC (formatQueryDate, as the calendar and completed screens send them): local midnight to +6 days 23:59:59
  const utc = (q: string | null): number => Date.parse(`${String(q).replace(" ", "T")}Z`);
  const p = new URL(r.url()).searchParams;
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  expect(utc(p.get("from"))).toBe(midnight.getTime());
  const end = new Date(midnight);
  end.setDate(end.getDate() + 6);
  end.setHours(23, 59, 59, 0);
  expect(utc(p.get("to"))).toBe(end.getTime());
  await expect(page.getByTestId("summary-report")).toBeVisible();
  await expect(page).toHaveURL(/#q\/all\/summary$/);
});
