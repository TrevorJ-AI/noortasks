import { expect, test, type Page } from "@playwright/test";
import { api } from "./seed";

/**
 * Settings, one shot per tab at 1440x900 on synthetic data (night theme), for SETTINGS-COVERAGE.md.
 * Opt-in: SCREENS_SETTINGS=1 npx playwright test e2e/zz-settings-screens.spec.ts
 */
test.skip(!process.env.SCREENS_SETTINGS, "screenshots only on request");

const MULTI = process.env.NOORTASKS_MULTI ?? "http://127.0.0.1:18736";

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `screens/settings-${name}.png` });
}
async function open(page: Page, tab: string, base = ""): Promise<void> {
  await page.goto(`${base}/#q/all/tasks?modalType=settings&tabs=${tab}`);
  await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 15_000 });
}
const scroll = (page: Page, y: number): Promise<void> => page.locator(".settings-scroll").evaluate((e, top) => void (e.scrollTop = top), y);

test("settings tabs, single account", async ({ page }) => {
  test.setTimeout(180_000);
  await api("PUT", "/api/v2/user/preferences/settings", { theme: "night", themeChosen: true, autoDarkTheme: false });
  for (const t of ["profile", "feature", "smart", "notifications", "date", "more", "integrations", "shortcuts", "about", "focus", "habit", "calendar"]) {
    await open(page, t);
    await shot(page, t);
  }
  await open(page, "smart");
  await page.getByTestId("smart-tag").click();
  await shot(page, "smart-dropdown");
  await open(page, "date");
  await page.getByTestId("set-alt-calendar").click();
  await shot(page, "date-additional-calendar");
  await open(page, "appearance");
  await shot(page, "appearance-theme");
  await scroll(page, 720);
  await shot(page, "appearance-theme-scrolled");
  await scroll(page, 0);
  await page.getByTestId("interface-style").click();
  await shot(page, "appearance-interface-style");
  await page.keyboard.press("Escape");
  await page.getByTestId("follow-dark").click();
  await shot(page, "appearance-dark-mode");
  await page.keyboard.press("Escape");
  await page.getByTestId("appearance-display").click();
  await shot(page, "appearance-display");
  await open(page, "more");
  await scroll(page, 560);
  await shot(page, "more-scrolled");
  await scroll(page, 300);
  await page.getByTestId("default-reminds").click();
  await shot(page, "more-default-reminders");
  await open(page, "integrations");
  await scroll(page, 2000);
  await shot(page, "integrations-scrolled");
  await scroll(page, 0);
  await page.getByTestId("cal-entry-url").click();
  await shot(page, "integrations-url-dialog");
  await open(page, "shortcuts");
  await scroll(page, 1000);
  await shot(page, "shortcuts-scrolled");
  // a photo theme behind the app
  await api("PUT", "/api/v2/user/preferences/settings", { theme: "spring", themeChosen: true });
  await page.goto("/#q/all/tasks");
  await expect(page.locator("html")).toHaveAttribute("data-image", "spring", { timeout: 20_000 });
  await shot(page, "theme-spring-app");
  await api("PUT", "/api/v2/user/preferences/settings", { theme: "night", themeChosen: true });
});

test("settings tabs, multi-user server (Account, Collaborate, Members)", async ({ page }) => {
  await page.goto(`${MULTI}/`);
  await page.getByTestId("signin-oidc").click();
  await page.getByTestId("mock-email").fill("alice@example.com");
  await page.getByTestId("mock-name").fill("Alice");
  await page.getByTestId("mock-approve").click();
  await expect(page.getByTestId("rail-sync")).toBeVisible({ timeout: 20_000 });
  for (const t of ["profile", "collaborate", "members"]) {
    await open(page, t, MULTI);
    await shot(page, `multi-${t}`);
  }
});
