import { expect, test, type Page } from "@playwright/test";
import { api, oid } from "./seed";

/** M3 visual check screenshots on synthetic data. Opt-in: SCREENS=1 npx playwright test e2e/screens-m3.spec.ts */
test.skip(!process.env.SCREENS, "screenshots only on request");

const out = (n: string): string => `screens/${n}.png`;
const step = 2 ** 40;
const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
const at = (d: number, h: number, m = 0): number => {
  const x = new Date();
  x.setHours(h, m, 0, 0);
  x.setDate(x.getDate() + d);
  return x.getTime();
};
const day = (d: number): number => at(d, 0);
let board = "";

test.beforeAll(async () => {
  board = oid();
  await api("POST", "/api/v2/batch/project", { add: [{ id: board, name: "Kitchen renovation", color: "#e2b714", sortOrder: 70 * step, kind: "TASK", viewMode: "kanban", inAll: true }] });
  const cols = [oid(), oid(), oid()];
  await api("POST", "/api/v2/batch/columnProject", { add: ["Ideas", "In progress", "Done soon"].map((name, i) => ({ id: cols[i], projectId: board, name, sortOrder: i * step })) });
  const T = (title: string, col: number, p: Record<string, unknown> = {}, i = 0) => ({ id: oid(), projectId: board, title, status: 0, sortOrder: i * step, columnId: cols[col], priority: 0, ...p });
  await api("POST", "/api/v2/batch/task", {
    add: [
      T("Compare worktop materials", 0, { priority: 3 }, 0),
      T("Collect cabinet quotes", 0, { startDate: iso(day(1)), dueDate: iso(day(4)), isAllDay: true, tags: ["errands"] }, 1),
      T("Sketch the new layout", 0, {}, 2),
      T("Remove old tiles", 1, { priority: 5, startDate: iso(day(0)), dueDate: iso(day(2)), isAllDay: true }, 0),
      T("Electrician visit", 1, { startDate: iso(at(0, 13)), dueDate: iso(at(0, 15)), isAllDay: false }, 1),
      T("Plumber call", 1, { startDate: iso(at(0, 14)), dueDate: iso(at(0, 14, 45)), isAllDay: false, priority: 1 }, 2),
      T("Paint samples on the wall", 2, { startDate: iso(at(1, 10)), dueDate: iso(at(1, 12)), isAllDay: false }, 0),
      T("Pick up grout", 2, { startDate: iso(at(2, 17)), dueDate: iso(at(2, 18)), isAllDay: false, priority: 3 }, 1),
      T("Order the sink", 2, { startDate: iso(day(3)), dueDate: iso(day(3)), isAllDay: true, priority: 5 }, 2),
    ],
  });
  await api("POST", "/api/v2/batch/task", { add: [1, 2, 4, 6, 9, 13].map((d, i) => ({ id: oid(), projectId: board, title: `Finished step ${i + 1}`, status: 2, completedTime: iso(at(-d, 11)), sortOrder: 0 })) });
  // the matrix is switched on for the screenshots
  await api("POST", "/api/v2/user/preferences/ext", { desktopTabBars: { tabBars: [{ name: "TASK", active: true }, { name: "CALENDAR", active: true }, { name: "MATRIX", active: true }] } });
});

async function shot(page: Page, name: string, path: string, ready: string, opts: { pick?: string } = {}): Promise<void> {
  await page.goto(`/#${path}`);
  if (opts.pick) {
    await page.getByTestId("cal-view").click();
    await page.getByTestId(`cal-view-${opts.pick}`).click();
  }
  await expect(page.getByTestId(ready)).toBeVisible();
  await page.waitForTimeout(700);
  await page.screenshot({ path: out(name) });
}

for (const [prefix, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`${prefix} M3 screens`, async ({ page }) => {
    await page.setViewportSize(size);
    await shot(page, `${prefix}-kanban`, `p/${board}/kanban`, "kanban-view");
    await shot(page, `${prefix}-timeline`, `p/${board}/timeline`, "timeline-view");
    await shot(page, `${prefix}-list-sections`, `p/${board}/tasks`, "list-view");
    await shot(page, `${prefix}-cal-month`, "c/all/calendar/m", "cal-month", { pick: "month" });
    await shot(page, `${prefix}-cal-week`, "c/all/calendar/w", "cal-timegrid", { pick: "week" });
    await shot(page, `${prefix}-cal-day`, "c/all/calendar/d", "cal-timegrid", { pick: "day" });
    await shot(page, `${prefix}-cal-multiday`, "c/all/calendar/d", "cal-timegrid", { pick: "multiDay" });
    await shot(page, `${prefix}-cal-multiweek`, "c/all/calendar/w", "cal-month", { pick: "multiWeek" });
    await shot(page, `${prefix}-cal-year`, "c/all/calendar/y", "cal-year", { pick: "year" });
    await shot(page, `${prefix}-cal-agenda`, "c/all/calendar/a", "cal-agenda", { pick: "agenda" });
    await shot(page, `${prefix}-matrix`, "m/all/matrix", "matrix");
    if (prefix === "desktop") {
      await page.goto("/#c/all/calendar/w");
      await page.getByTestId("cal-view").click();
      await expect(page.getByTestId("cal-view-menu")).toBeVisible();
      await page.screenshot({ path: out("desktop-cal-view-menu") });
      await page.keyboard.press("Escape");
      await page.getByTestId("cal-options").click();
      await expect(page.getByTestId("cal-options-menu")).toBeVisible();
      await page.screenshot({ path: out("desktop-cal-options") });
      await page.keyboard.press("Escape");
      await page.getByTestId("cal-split").click();
      await expect(page.getByTestId("cal-arrange")).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: out("desktop-cal-split") });
      await page.getByTestId("cal-split").click();
      await page.goto("/#m/all/matrix");
      await page.getByTestId("matrix-more").click();
      await page.getByTestId("matrix-edit-rules").click();
      await expect(page.getByTestId("matrix-rules")).toBeVisible();
      await page.screenshot({ path: out("desktop-matrix-rules") });
    }
  });
}
