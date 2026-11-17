import { expect, test, type Page } from "@playwright/test";
import { api, inboxId, oid } from "./seed";

/** M4 visual check screenshots on synthetic data. Opt-in: SCREENS=1 npx playwright test e2e/zm4-screens.spec.ts */
test.skip(!process.env.SCREENS, "screenshots only on request");

const out = (n: string): string => `screens/${n}.png`;
const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
const at = (d: number, h: number, m = 0): number => {
  const x = new Date();
  x.setHours(h, m, 0, 0);
  x.setDate(x.getDate() + d);
  return x.getTime();
};
const stamp = (d: number): number => {
  const x = new Date();
  x.setDate(x.getDate() + d);
  return x.getFullYear() * 10000 + (x.getMonth() + 1) * 100 + x.getDate();
};
let habitId = "";
let timerId = "";
let countdownId = "";

test.beforeAll(async () => {
  const settings = await api<{ tabBars?: Array<{ name: string; enabled: boolean }> }>("GET", "/api/v2/user/preferences/settings");
  const bars = (settings.tabBars ?? []).filter((b) => !["HABIT", "POMO"].includes(b.name));
  await api("PUT", "/api/v2/user/preferences/settings", {
    tabBars: [...bars, { name: "HABIT", enabled: true }, { name: "POMO", enabled: true }],
    enableCountdown: true,
    calendarViewConf: { showDetail: false, showCompleted: true, showChecklist: false, showFutureTask: true, showFocusRecord: true, showHabit: true, cellColorType: "list", showCountdown: true },
    smartProjects: [{ name: "summary", visibility: "show", order: null }],
  });
  await api("POST", "/api/v2/user/preferences/pomodoro", { pomoGoal: 6 });
  const secs = [oid(), oid()];
  await api("POST", "/api/v2/habitSections/batch", { add: [{ id: secs[0], name: "_morning", sortOrder: 1 }, { id: secs[1], name: "_night", sortOrder: 2 }] });
  const H = (p: Record<string, unknown>) => ({ id: oid(), iconRes: "habit_daily_check_in", type: "Boolean", unit: "Count", goal: 1, step: 1, status: 0, repeatRule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA", sectionId: "-1", targetStartDate: stamp(-40), ...p });
  const habits = [
    H({ name: "Morning run", iconRes: "nt_run", color: "#f08c2e", sectionId: secs[0], repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", encouragement: "Out the door first." }),
    H({ name: "Drink water", iconRes: "nt_water", color: "#2f8fbf", sectionId: secs[0], type: "Real", goal: 8, unit: "glasses" }),
    H({ name: "Read", iconRes: "nt_book", color: "#e2b714", sectionId: secs[1], encouragement: "Ten pages a day.", recordEnable: true }),
    H({ name: "Meditate", iconRes: "nt_meditate", color: "#5b6ee1", sectionId: secs[1] }),
    H({ name: "Strength training", iconRes: "nt_dumbbell", color: "#a35bd6", repeatRule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;TT_TIMES=3" }),
  ];
  habitId = habits[2]!.id;
  await api("POST", "/api/v2/habits/batch", { add: habits });
  const checks: Array<Record<string, unknown>> = [];
  for (let d = -34; d <= 0; d++) {
    const s = stamp(d);
    const dow = new Date(at(d, 12)).getDay();
    if ([1, 3, 5].includes(dow) && d % 9 !== 0) checks.push({ id: oid(), habitId: habits[0]!.id, checkinStamp: s, status: 2, value: 1 });
    checks.push({ id: oid(), habitId: habits[1]!.id, checkinStamp: s, value: d === 0 ? 5 : 8 - (Math.abs(d) % 4 === 0 ? 3 : 0), goal: 8 });
    if (d % 7 !== 3 && d !== 0) checks.push({ id: oid(), habitId: habits[2]!.id, checkinStamp: s, status: 2, value: 1 });
    if (d % 3 === 0) checks.push({ id: oid(), habitId: habits[3]!.id, checkinStamp: s, status: 2, value: 1 });
    if ([1, 3, 6].includes(dow) && d < 0) checks.push({ id: oid(), habitId: habits[4]!.id, checkinStamp: s, status: 2, value: 1 });
  }
  await api("POST", "/api/v2/habitCheckins/batch", { add: checks });
  await api("POST", "/api/v2/habitRecords", { add: [{ id: oid(), habitId, checkinStamp: stamp(-1), content: "Finished the chapter on the river delta. Slow but good.", emoji: 50 }, { id: oid(), habitId, checkinStamp: stamp(-3), content: "Only five pages, long day.", emoji: 30 }] });

  const inbox = await inboxId();
  const task = { id: oid(), projectId: inbox, title: "Draft the quarterly report", status: 0, kind: "TEXT", priority: 3, sortOrder: 0 };
  await api("POST", "/api/v2/batch/task", { add: [task] });
  timerId = oid();
  await api("POST", "/api/v2/timer", { add: [{ id: timerId, name: "Reading", type: "pomodoro", pomodoroTime: 30, color: "#e2b714", status: 0, sortOrder: 1 }, { id: oid(), name: "Guitar", type: "timing", color: "#a35bd6", status: 0, sortOrder: 2 }] });
  const recs: Array<Record<string, unknown>> = [];
  const timing: Array<Record<string, unknown>> = [];
  for (let d = -60; d <= 0; d++) {
    if (d % 4 === 1) continue;
    const n = 1 + (Math.abs(d) % 3);
    for (let k = 0; k < n; k++) {
      const s = at(d, 8 + k * 2 + (Math.abs(d) % 2), k * 10);
      const bind = k === 0 ? [{ taskId: task.id, projectId: inbox, title: task.title }] : k === 1 ? [{ timerId, timerName: "Reading", title: "Reading" }] : [{ habitId, title: "Read" }];
      if (s < Date.now() - 30 * 60000) recs.push({ id: oid(), type: 0, startTime: iso(s), endTime: iso(s + 25 * 60000), pauseDuration: 0, tasks: bind, note: k === 0 && d === -1 ? "Outline done, numbers next" : "" });
    }
    if (d % 5 === 0 && d < 0) timing.push({ id: oid(), type: 1, startTime: iso(at(d, 19)), endTime: iso(at(d, 19, 50)), pauseDuration: 120, tasks: [] });
  }
  await api("POST", "/api/v2/batch/pomodoro", { add: recs });
  await api("POST", "/api/v2/batch/pomodoro/timing", { add: timing });

  const y = new Date().getFullYear();
  countdownId = oid();
  await api("POST", "/api/v2/countdown/batch", {
    add: [
      { id: countdownId, name: "Trip to Lisbon", type: 4, date: stamp(23), icon: "✈️", color: "#2f8fbf", style: "two_color_card", remark: "Book the airport transfer.", showRemark: true, pinnedTime: iso(Date.now()) },
      { id: oid(), name: "Wedding anniversary", type: 3, date: (y - 3) * 10000 + 612, timerMode: 1, icon: "💍", color: "#e5484d", repeatFlag: "RRULE:FREQ=YEARLY" },
      { id: oid(), name: "Mum's birthday", type: 2, date: 19620304, showAge: true, color: "#f08c2e", repeatFlag: "RRULE:FREQ=YEARLY", style: "calendar" },
      { id: oid(), name: "New Year's Day", type: 1, date: (y + 1) * 10000 + 101, color: "#3fa66b", style: "polaroid" },
      { id: oid(), name: "Thesis deadline", type: 4, date: stamp(4), color: "#a35bd6", style: "perpetual" },
    ],
  });
});

async function open(page: Page, path: string, ready: string): Promise<void> {
  await page.goto(`/#${path}`);
  await expect(page.getByTestId(ready).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(900);
}

for (const [prefix, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`${prefix} M4 screens`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    await open(page, "q/all/habit", "habit-row");
    await page.screenshot({ path: out(`${prefix}-habits`) });
    await open(page, `q/all/habit/${habitId}`, "habit-detail");
    await page.screenshot({ path: out(`${prefix}-habit-detail`) });
    if (prefix === "desktop") {
      await page.getByTestId("habit-style-card").click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: out(`${prefix}-habits-card`) });
      await page.getByTestId("habit-style-list").click();
    }
    await open(page, "q/all/habit", "habit-row");
    await page.getByTestId("habit-add").click();
    await expect(page.getByTestId("habit-gallery")).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-habit-gallery`) });
    await page.getByTestId("habit-custom").click();
    await page.getByTestId("habit-name").fill("Evening walk");
    await page.screenshot({ path: out(`${prefix}-habit-dialog`) });
    await page.keyboard.press("Escape");

    await open(page, "focus", "timer-panel");
    await page.screenshot({ path: out(`${prefix}-focus`) });
    await open(page, `focus/${timerId}`, "timer-detail");
    await page.screenshot({ path: out(`${prefix}-focus-timer`) });
    await open(page, "focus", "timer-panel");
    await page.getByTestId("focus-start").click();
    await page.waitForTimeout(2200);
    await page.screenshot({ path: out(`${prefix}-focus-running`) });
    await page.getByTestId("full-btn").click();
    await expect(page.getByTestId("focus-full")).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-focus-fullscreen`) });
    await page.getByTestId("clock-next").click();
    await page.screenshot({ path: out(`${prefix}-focus-fullscreen-flip`) });
    await page.keyboard.press("Escape");
    await page.getByTestId("focus-pause").click();
    await page.getByTestId("focus-end").click();
    await page.getByRole("button", { name: "Discard" }).click();
    if (prefix === "desktop") {
      await page.getByTestId("record-row").first().click();
      await expect(page.getByTestId("record-dialog")).toBeVisible();
      await page.screenshot({ path: out(`${prefix}-focus-record`) });
      await page.keyboard.press("Escape");
    }

    for (const t of ["overview", "task", "pomo"]) {
      await open(page, `statistics/${t}`, "statistics");
      await page.waitForTimeout(800);
      await page.screenshot({ path: out(`${prefix}-stats-${t}`) });
    }
    if (prefix === "desktop") {
      await page.getByTestId("statistics").evaluate((el) => el.querySelector(".stats-body, .stats-scroll")?.scrollBy(0, 900));
      await page.waitForTimeout(300);
      await page.screenshot({ path: out(`${prefix}-stats-pomo-2`) });
    }

    await open(page, "countdown", "countdown-card");
    await page.screenshot({ path: out(`${prefix}-countdown`) });
    await open(page, `countdown/${countdownId}`, "countdown-detail");
    await page.screenshot({ path: out(`${prefix}-countdown-detail`) });
    await page.getByTestId("countdown-edit").click();
    await expect(page.getByTestId("countdown-dialog")).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-countdown-dialog`) });
    await page.keyboard.press("Escape");

    await open(page, "q/all/summary", "summary-report");
    await page.screenshot({ path: out(`${prefix}-summary`) });
    await open(page, "c/all/calendar/m", "cal-month");
    await page.screenshot({ path: out(`${prefix}-cal-overlays`) });
    await open(page, "q/today/tasks", "today-habits");
    await page.screenshot({ path: out(`${prefix}-today-habits`) });
    if (prefix === "desktop") {
      await page.goto("/#c/all/calendar/w");
      await expect(page.getByTestId("cal-timegrid")).toBeVisible();
      await page.getByTestId("cal-view").click();
      await page.getByTestId("cal-view-week").click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: out(`${prefix}-cal-week-overlays`) });
      await page.goto("/#q/all/tasks?modalType=settings&tabs=focus");
      await expect(page.getByTestId("settings-modal")).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: out(`${prefix}-settings-focus`) });
      await page.goto("/#q/all/tasks?modalType=settings&tabs=habit");
      await page.waitForTimeout(400);
      await page.screenshot({ path: out(`${prefix}-settings-habit`) });
    }
  });
}
