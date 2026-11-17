import { expect, test, type Page } from "@playwright/test";
import { api } from "./seed";

/** UI polish before/after shots on synthetic data. Opt-in: SCREENS_POLISH=before|after npx playwright test e2e/zz-polish-screens.spec.ts */
const tag = process.env.SCREENS_POLISH;
test.skip(!tag, "screenshots only on request");

let listUrl = "";
let detailUrl = "";

test.beforeAll(async () => {
  await api("PUT", "/api/v2/user/preferences/settings", { theme: "night", themeChosen: true, autoDarkTheme: false });
  const state = await api<{ projectProfiles: Array<{ id: string; name: string }>; syncTaskBean: { update: Array<{ id: string; title: string }> } }>("GET", "/api/v3/batch/check/0");
  const home = state.projectProfiles.find((p) => p.name === "Home projects")!;
  listUrl = `/#p/${home.id}/tasks`;
  const paint = state.syncTaskBean.update.find((t) => t.title === "Paint the spare room");
  detailUrl = paint ? `${listUrl}/${paint.id}` : listUrl;
});

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `screens/polish-${tag}-${name}.png` });
}

for (const [prefix, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`${prefix} polish screens`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(size);
    await page.goto(listUrl);
    await expect(page.getByTestId("view-title")).toHaveText("Home projects");
    await shot(page, `${prefix}-list`);
    if (detailUrl !== listUrl) {
      await page.goto(detailUrl);
      await expect(page.getByTestId("detail-title")).toHaveValue("Paint the spare room");
      await shot(page, `${prefix}-detail`);
    }
    for (const t of ["profile", "feature", "appearance"]) {
      await page.goto(`${listUrl}?modalType=settings&tabs=${t}`);
      await expect(page.getByTestId("settings-modal")).toBeVisible();
      await shot(page, `${prefix}-settings-${t}`);
    }
    // every other tab, looked at but not kept in the repo
    if (process.env.POLISH_ALL_TABS && prefix === "desktop") {
      for (const t of ["smart", "notifications", "focus", "habit", "date", "calendar", "more", "integrations", "shortcuts", "about"]) {
        await page.goto(`${listUrl}?modalType=settings&tabs=${t}`);
        await expect(page.getByTestId("settings-modal")).toBeVisible();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${process.env.POLISH_ALL_TABS}/tab-${t}.png` });
      }
    }
  });
}
