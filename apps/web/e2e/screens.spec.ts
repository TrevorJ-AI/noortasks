import { expect, test } from "@playwright/test";
import { inboxId } from "./seed";

/** Visual check screenshots (synthetic data). Opt-in: SCREENS=1 npx playwright test e2e/screens.spec.ts */
test.skip(!process.env.SCREENS, "screenshots only on request");

const out = (n: string): string => `screens/${n}.png`;
const listId = async (page: import("@playwright/test").Page, name: string): Promise<string> => {
  const el = page.getByTestId(`side-list-${name}`);
  await el.getByRole("button").first().click();
  await expect(page.getByTestId("view-title")).toHaveText(name);
  return page.url().split("#p/")[1]!.split("/")[0]!;
};

test("desktop screens 1440x900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("view-title")).toHaveText("Today");
  await page.waitForTimeout(800);
  await page.screenshot({ path: out("desktop-today") });
  await page.getByTestId("sidebar").screenshot({ path: out("desktop-sidebar") });

  const id = await listId(page, "Home projects");
  await page.waitForTimeout(400);
  await page.screenshot({ path: out("desktop-list") });

  await page.locator('[data-testid=task-row][data-title="Paint the spare room"]').click();
  await expect(page.getByTestId("detail-title")).toHaveValue("Paint the spare room");
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("desktop-task-detail") });

  await page.getByTestId("detail-date").click();
  await expect(page.getByTestId("date-picker")).toBeVisible();
  await page.screenshot({ path: out("desktop-date-picker") });
  await page.getByTestId("dp-repeat").click();
  await expect(page.getByTestId("repeat-list")).toBeVisible();
  await page.screenshot({ path: out("desktop-repeat-picker") });
  await page.getByTestId("repeat-custom").click();
  await expect(page.getByTestId("custom-repeat")).toBeVisible();
  await page.screenshot({ path: out("desktop-repeat-custom") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.goto(`/#p/${id}/tasks?modalType=settings&tabs=appearance`);
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("desktop-settings-appearance") });
  await page.locator(".settings-scroll").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(200);
  await page.screenshot({ path: out("desktop-settings-appearance-2") });

  await page.goto(`/#p/${id}/tasks`);
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("group-by").hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: out("desktop-groupby-menu") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.getByTestId("list-more").click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: out("desktop-list-more-menu") });
  await page.keyboard.press("Escape");

  await page.goto(`/#p/${await inboxId()}/tasks`);
  await page.getByTestId("quick-add-input").click();
  await page.getByTestId("quick-add-input").fill("Plan picnic next saturday #weekend !medium");
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("desktop-quick-add") });
  await page.getByTestId("quick-add-input").fill("");

  await page.goto("/#q/all/completed");
  await expect(page.getByTestId("completed-screen")).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: out("desktop-completed") });

  await page.goto("/#q/today/tasks");
  await page.getByTestId("add-list").click();
  await expect(page.getByTestId("list-dialog")).toBeVisible();
  await page.getByTestId("list-name").fill("Example list");
  await page.screenshot({ path: out("desktop-add-list") });
  await page.keyboard.press("Escape");

  await page.keyboard.press("/");
  await expect(page.getByTestId("search-modal")).toBeVisible();
  await page.getByTestId("search-input").fill("the");
  await page.waitForTimeout(200);
  await page.screenshot({ path: out("desktop-search") });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("command-menu")).toBeVisible();
  await page.screenshot({ path: out("desktop-command-menu") });
});

test("phone screens 390x844", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("view-title")).toHaveText("Today");
  await page.waitForTimeout(800);
  await page.screenshot({ path: out("phone-today") });
  await page.locator('[data-testid=task-row][data-title="Fix the squeaky hallway door"]').click();
  await expect(page.getByTestId("detail-title")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("phone-task-detail") });
  await page.goBack();
  await page.getByTestId("mobile-menu").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: out("phone-drawer") });
});
