import { expect, test, type Page } from "@playwright/test";
import { at, icsOf, startMockCal, type MockCal } from "./mockcal";
import { api } from "./seed";

/** Calendar integration screenshots on synthetic data. Opt-in: SCREENS=1 npx playwright test e2e/zm7cal-screens.spec.ts */
test.skip(!process.env.SCREENS, "screenshots only on request");
test.describe.configure({ mode: "serial" });

const out = (n: string): string => `screens/${n}.png`;
let mock: MockCal;

test.beforeAll(async () => {
  mock = await startMockCal({
    "/club.ics": () =>
      icsOf("Riverside Running Club", [
        { uid: "c1@e2e", title: "Track session", start: at(0, 10), end: at(0, 11, 30), location: "Riverside track", description: "Intervals: 6 x 800 m. Bring spikes and water." },
        { uid: "c2@e2e", title: "Long run", start: at(2, 8), end: at(2, 10) },
        { uid: "c3@e2e", title: "Club committee", start: at(1, 19), end: at(1, 20, 30) },
        { uid: "c4@e2e", title: "Physio", start: at(-1, 15), end: at(-1, 15, 45) },
        { uid: "c5@e2e", title: "Club weekend trip", day: 3, days: 2 },
      ]),
    "/family.ics": () =>
      icsOf("Family", [
        { uid: "f1@e2e", title: "School pickup", start: at(0, 15, 15), end: at(0, 16) },
        { uid: "f2@e2e", title: "Grandma's birthday", day: 1 },
        { uid: "f3@e2e", title: "Dinner at Sam's", start: at(-2, 18, 30), end: at(-2, 21) },
      ]),
    "/holidays.ics": () => icsOf("Public holidays", [{ uid: "h1@e2e", title: "Founders' Day (synthetic)", day: 2 }]),
  });
  await api("POST", "/api/v2/calendar/subscribe", { url: `${mock.base}/club.ics`, name: "Riverside Running Club", color: "#3fa66b" });
  await api("POST", "/api/v2/calendar/subscribe", { url: `${mock.base}/family.ics`, name: "Family", color: "#8e5bd8" });
  await api("POST", "/api/v2/calendar/subscribe", { url: `${mock.base}/holidays.ics`, name: "Public holidays", kind: "holiday", color: "#ef7d31" });
  await api("POST", "/api/v2/calendar/feeds/code/new", {});
});
test.afterAll(async () => {
  await mock?.close();
});

async function go(page: Page, path: string, ready: string): Promise<void> {
  await page.goto("about:blank");
  await page.goto(`/#${path}`);
  await expect(page.getByTestId(ready).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(900);
}
const pickView = async (page: Page, sel: string): Promise<void> => {
  await page.getByTestId("cal-view").click();
  await page.getByTestId(`cal-view-${sel}`).click();
  await expect(page.getByTestId("calendar")).toHaveAttribute("data-view", sel);
  await page.waitForTimeout(700);
};

for (const [prefix, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`${prefix} calendar integration screens`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    const phone = prefix === "phone";

    await go(page, "c/all/calendar/w?modalType=settings&tabs=calendar", "cal-settings");
    await expect(page.getByTestId("cal-src")).toHaveCount(3);
    await expect(page.getByTestId("feed-url")).toHaveValue(/\/feed\//);
    await page.screenshot({ path: out(`${prefix}-cal-settings`) });
    // the add catalogue with the Google entry open (not configured on this server)
    await page.getByTestId("cal-entry-google").click();
    await expect(page.getByTestId("google-not-configured")).toBeVisible();
    await page.getByTestId("cal-catalogue").scrollIntoViewIfNeeded();
    await page.screenshot({ path: out(`${prefix}-cal-settings-add`) });
    await page.getByRole("button", { name: "Close settings" }).click();

    await pickView(page, "week");
    await expect(page.locator('[data-testid=cal-block][data-title="Track session"]')).toHaveCount(1);
    await page.screenshot({ path: out(`${prefix}-cal-week-external`) });
    if (!phone) {
      await page.locator('[data-testid=cal-block][data-title="Track session"]').click();
      await expect(page.getByTestId("ext-event-pop")).toBeVisible();
      await page.waitForTimeout(300);
      await page.screenshot({ path: out(`${prefix}-cal-event-popover`) });
      await page.getByTestId("ext-event-pop").getByRole("button", { name: "Close" }).click();
      await pickView(page, "month");
      if ((await page.getByTestId("cal-side").count()) === 0) await page.getByTestId("cal-toggle-side").click();
      await expect(page.getByTestId("cal-side-sources")).toBeVisible();
      await page.waitForTimeout(500);
      await page.screenshot({ path: out(`${prefix}-cal-month-external`) });
    }
  });
}
