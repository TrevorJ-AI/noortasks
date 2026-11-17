import { expect, test } from "@playwright/test";
import { inboxId } from "./seed";

test("25-hour offline banner survives reload, persistent storage requested, reconnect clears it", async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  const origin = new URL(test.info().project.use.baseURL!).origin;
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  await cdp.send("Browser.grantPermissions", { origin, browserContextId: targetInfo.browserContextId, permissions: ["durableStorage"] });
  // Capture the real persist call while retaining Chromium's actual storage implementation.
  await page.addInitScript(() => {
    const persist = navigator.storage.persist.bind(navigator.storage);
    navigator.storage.persist = () => { localStorage.setItem("persist-requested", "yes"); return persist(); };
  });
  await page.goto(`/#p/${await inboxId()}/tasks`);
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle");
  await expect.poll(() => page.evaluate(() => navigator.storage.persisted())).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("persist-requested"))).toBe("yes");
  await expect(page.getByTestId("last-sync-age")).toHaveText("Last synced just now");
  // Cached app remains available; only its API connection is offline.
  await page.route("**/api/**", (route) => route.abort("internetdisconnected"));
  await page.getByTestId("quick-add-input").fill("M10 offline durability task");
  await page.getByTestId("quick-add-input").press("Enter");
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "offline");
  await expect(page.getByTestId("offline-sync-warning")).toHaveCount(0);
  // Advance the browser clock, preserving the real outbox timestamp across reload.
  const later = Date.now() + 25 * 60 * 60 * 1000;
  await page.clock.setFixedTime(later);
  await page.reload();
  await expect(page.getByTestId("offline-sync-warning")).toBeVisible();
  await expect(page.getByTestId("sync-health")).toHaveAttribute("role", "alert");
  await expect(page.getByTestId("last-sync-age")).toHaveText("Last synced 1d ago");
  await page.unroute("**/api/**");
  await page.getByRole("button", { name: "Sync now", exact: true }).click();
  await expect(page.getByTestId("offline-sync-warning")).toHaveCount(0);
  await expect(page.getByTestId("last-sync-age")).toHaveText("Last synced just now");
});

test("a late profile response preserves the email draft queued for sync", async ({ page }) => {
  await page.goto(`/#p/${await inboxId()}/tasks`);
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/v2/user/profile", async (route) => {
    requested();
    await gate;
    await route.fulfill({ json: { email: "late-profile@example.invalid" } });
  });
  await page.goto("/#q/all/tasks?modalType=settings&tabs=notifications");
  await started;
  const field = page.getByTestId("set-email-address");
  await field.fill("draft@example.invalid");
  const response = page.waitForResponse("**/api/v2/user/profile");
  release();
  await response;
  await field.blur();
  await expect.poll(async () => {
    const res = await page.request.get("/api/v2/user/preferences/ext");
    return (await res.json()).general_conf?.notificationEmail;
  }).toBe("draft@example.invalid");
  await expect(field).toHaveValue("draft@example.invalid");
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0);
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle");
});
