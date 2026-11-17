import { expect, test, type Page } from "@playwright/test";
import { api, inboxId, oid } from "./seed";

/** Noor Black visual check on synthetic data. Opt-in: SCREENS_NOOR=1 npx playwright test e2e/zz-noor-screens.spec.ts (runs last: it seeds habits, tabs and tasks) */
test.skip(!process.env.SCREENS_NOOR, "screenshots only on request");

const out = (n: string): string => `screens/noor-${n}.png`;
const at = (d: number, h: number, m = 0): string => {
  const x = new Date();
  x.setHours(h, m, 0, 0);
  x.setDate(x.getDate() + d);
  return x.toISOString().replace("Z", "+0000");
};
const stamp = (d: number): number => {
  const x = new Date();
  x.setDate(x.getDate() + d);
  return x.getFullYear() * 10000 + (x.getMonth() + 1) * 100 + x.getDate();
};
let timerId = "";
let detailUrl = "";

test.beforeAll(async () => {
  const settings = await api<{ tabBars?: Array<{ name: string; enabled: boolean }> }>("GET", "/api/v2/user/preferences/settings");
  const bars = (settings.tabBars ?? []).filter((b) => !["HABIT", "POMO"].includes(b.name));
  // pick Noor Black explicitly (the default is the classic dark theme)
  await api("PUT", "/api/v2/user/preferences/settings", { theme: "noor", themeChosen: true, autoDarkTheme: false, tabBars: [...bars, { name: "HABIT", enabled: true }, { name: "POMO", enabled: true }] });
  const H = (p: Record<string, unknown>) => ({ id: oid(), iconRes: "habit_daily_check_in", type: "Boolean", unit: "Count", goal: 1, step: 1, status: 0, repeatRule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA", sectionId: "-1", targetStartDate: stamp(-30), ...p });
  // one habit without a colour falls back to the accent
  const habits = [H({ name: "Morning walk", iconRes: "nt_run" }), H({ name: "Read", iconRes: "nt_book", color: "#e2b714" }), H({ name: "Stretch", iconRes: "nt_meditate", color: "#5b6ee1" })];
  await api("POST", "/api/v2/habits/batch", { add: habits });
  const checks: Array<Record<string, unknown>> = [];
  for (let d = -20; d <= 0; d++) {
    if (d % 3 !== 1) checks.push({ id: oid(), habitId: habits[0]!.id, checkinStamp: stamp(d), status: 2, value: 1 });
    if (d % 2 === 0) checks.push({ id: oid(), habitId: habits[1]!.id, checkinStamp: stamp(d), status: 2, value: 1 });
  }
  await api("POST", "/api/v2/habitCheckins/batch", { add: checks });
  timerId = oid();
  await api("POST", "/api/v2/timer", { add: [{ id: timerId, name: "Deep work", type: "pomodoro", pomodoroTime: 25, status: 0, sortOrder: 1 }] });
  const inbox = await inboxId();
  const T = (title: string, d: number, h: number, priority = 0) => ({ id: oid(), projectId: inbox, title, status: 0, kind: "TEXT", priority, startDate: at(d, h), dueDate: at(d, h + 1), isAllDay: false, timeZone: "Europe/Amsterdam" });
  const plumber = { ...T("Call the plumber", 0, 9, 3), isAllDay: true, startDate: at(0, 0), dueDate: at(0, 0) };
  detailUrl = `/#p/${inbox}/tasks/${plumber.id}`;
  await api("POST", "/api/v2/batch/task", { add: [plumber, T("Team sync", 0, 10, 3), T("Write proposal", 1, 13, 5), T("Gym", -1, 7), T("Review notes", 2, 15, 1)] });
});

/** fails when any visible element paints white text on the amber accent */
async function noWhiteOnAmber(page: Page): Promise<void> {
  const bad = await page.evaluate(() => {
    const hits: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      if (cs.backgroundColor !== "rgb(233, 178, 46)") continue;
      if (!el.textContent?.trim() && !el.querySelector("svg")) continue;
      const kids = [el, ...Array.from(el.querySelectorAll<HTMLElement>("*"))];
      if (kids.some((k) => getComputedStyle(k).color === "rgb(255, 255, 255)")) hits.push(`${el.tagName}.${el.className}`);
    }
    return hits;
  });
  expect(bad, "white on amber").toEqual([]);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(700);
  await noWhiteOnAmber(page);
  await page.screenshot({ path: out(name) });
}

for (const [prefix, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`${prefix} Noor Black screens`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await page.goto("/#q/today/tasks");
    await expect(page.getByTestId("view-title")).toHaveText("Today");
    // Noor Black picked in settings
    await expect(page.locator("html")).toHaveAttribute("data-theme", "noor");
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--on-accent").trim())).toBe("#0a0a0c");
    await shot(page, `${prefix}-today`);
    if (prefix === "desktop") {
      // a primary button on the accent
      await page.getByTestId("add-list").click();
      await expect(page.getByTestId("list-dialog")).toBeVisible();
      await page.getByTestId("list-name").fill("Example list");
      await shot(page, `${prefix}-dialog`);
      await page.keyboard.press("Escape");
    }

    await page.goto(detailUrl);
    await expect(page.getByTestId("detail-title")).toHaveValue("Call the plumber");
    await shot(page, `${prefix}-task-detail`);
    await page.keyboard.press("Escape");

    await page.goto("/#c/all/calendar/w");
    await expect(page.getByTestId("cal-block").first()).toBeVisible({ timeout: 15_000 });
    await shot(page, `${prefix}-calendar-week`);

    await page.goto("/#q/all/tasks?modalType=settings&tabs=appearance");
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByTestId("theme-noor")).toHaveClass(/on/);
    await shot(page, `${prefix}-settings-appearance`);

    await page.goto("/#q/all/habit");
    await expect(page.getByTestId("habit-row").first()).toBeVisible({ timeout: 15_000 });
    await shot(page, `${prefix}-habits`);

    await page.goto(`/#focus/${timerId}`);
    await expect(page.getByTestId("timer-detail")).toBeVisible({ timeout: 15_000 });
    await page.goto("/#focus");
    await expect(page.getByTestId("timer-panel")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("focus-start").click();
    await page.waitForTimeout(1500);
    await shot(page, `${prefix}-focus`);
    await page.getByTestId("focus-pause").click();
  });
}

test("other themes keep white on their accent", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "noor");
  await page.goto("/#q/all/tasks?modalType=settings&tabs=appearance");
  await page.getByTestId("theme-sky").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sky");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--on-accent").trim())).toBe("#ffffff");
  // an explicit Dark pick stays Dark
  await page.getByTestId("theme-night").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "night");
  await page.getByTestId("theme-noor").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "noor");
});
