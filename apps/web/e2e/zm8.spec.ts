import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * M8 on synthetic accounts against the multi-user production server (it serves the built app itself) and a
 * local mock OIDC provider: invite-only Google sign-in, the admin's Members page, sharing a list between two
 * browser contexts, edits flowing both ways, and the collaboration switch taking edit rights away.
 * Screenshots only with SCREENS=1.
 */
const MULTI = process.env.NOORTASKS_MULTI ?? "http://127.0.0.1:18736";
const shot = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SCREENS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `screens/m8-${name}.png` });
};
const both = async (page: Page, name: string): Promise<void> => {
  if (!process.env.SCREENS) return;
  await shot(page, `desktop-${name}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot(page, `mobile-${name}`);
  await page.setViewportSize({ width: 1440, height: 900 });
};

async function signIn(page: Page, email: string, name: string): Promise<void> {
  await page.goto(`${MULTI}/`);
  await expect(page.getByTestId("signin-card")).toBeVisible();
  await page.getByTestId("signin-oidc").click();
  await page.getByTestId("mock-email").fill(email);
  await page.getByTestId("mock-name").fill(name);
  await page.getByTestId("mock-approve").click();
}

async function synced(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
}

async function call<T = any>(ctx: BrowserContext, method: string, path: string, data?: unknown): Promise<T> {
  const csrf = (await ctx.cookies()).find((c) => c.name === "_csrf_token")?.value ?? "";
  const r = await ctx.request.fetch(`${MULTI}${path}`, { method, headers: { "x-csrftoken": csrf, "content-type": "application/json" }, ...(data !== undefined ? { data } : {}) });
  return (await r.json()) as T;
}

const oid = (): string => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

test("M8: invite-only Google sign-in, sharing between two people, collaboration switch", async ({ browser }) => {
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Amsterdam", locale: "en-US" });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Amsterdam", locale: "en-US" });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();

  // the sign-in screen: one button, no passphrase field (password sign-in is off with OIDC)
  await b.goto(`${MULTI}/`);
  await expect(b.getByTestId("signin-oidc")).toHaveText("Sign in with Google");
  await expect(b.getByTestId("signin-password")).toHaveCount(0);
  await both(b, "signin");

  // Bob is not invited yet: refused with a readable message, no account made
  await signIn(b, "bob@example.com", "Bob");
  await expect(b.getByTestId("signin-error")).toContainText("not invited");

  // Alice is the configured admin
  await signIn(a, "alice@example.com", "Alice");
  await expect(a.getByTestId("app")).toBeVisible();
  await synced(a);
  await a.goto(`${MULTI}/#q/today/tasks?modalType=settings&tabs=members`);
  await expect(a.getByTestId("members-tab")).toBeVisible();
  await a.getByTestId("invite-email").fill("bob@example.com");
  await a.getByTestId("invite-add").click();
  await expect(a.getByTestId("invite-list")).toContainText("bob@example.com");

  // Bob can sign in now
  await signIn(b, "bob@example.com", "Bob");
  await expect(b.getByTestId("app")).toBeVisible();
  await synced(b);
  await a.reload();
  await expect(a.getByTestId("member-bob@example.com")).toBeVisible();
  await both(a, "members");

  // Alice makes a list with two tasks (through the API, as her) and shares it with Bob in the UI
  const pid = oid();
  const t1 = { id: oid(), projectId: pid, title: "Book train", status: 0, priority: 0, sortOrder: 0, kind: "TEXT" };
  const t2 = { id: oid(), projectId: pid, title: "Pack the tent", status: 0, priority: 0, sortOrder: 2 ** 40, kind: "TEXT" };
  await call(ctxA, "POST", "/api/v2/batch/project", { add: [{ id: pid, name: "Weekend trip", sortOrder: 0, kind: "TASK" }] });
  await call(ctxA, "POST", "/api/v2/batch/task", { add: [t1, t2] });
  await a.goto(`${MULTI}/#p/${pid}/tasks`);
  await synced(a);
  await a.getByTestId("list-more").click();
  await a.getByTestId("list-share").click();
  const dlg = a.getByTestId("share-dialog");
  await expect(dlg).toBeVisible();
  await dlg.getByTestId("share-pick").click();
  await a.locator(".popover .menu").getByText("Bob (bob@example.com)").click();
  await dlg.getByTestId("share-add").click();
  await expect(dlg.getByTestId("share-row-bob@example.com")).toBeVisible();
  await both(a, "share-dialog");
  await dlg.getByRole("button", { name: "Done" }).click();

  // Bob sees the shared list and edits a task
  await b.goto(`${MULTI}/#p/${pid}/tasks`);
  await b.reload();
  await expect(b.getByTestId("side-list-Weekend trip")).toBeVisible();
  await expect(b.getByText("Pack the tent")).toBeVisible();
  await b.goto(`${MULTI}/#p/${pid}/tasks/${t1.id}`);
  const title = b.getByTestId("detail-title");
  await expect(title).toHaveValue("Book train");
  await title.fill("Book train tickets");
  await synced(b);
  await expect.poll(async () => (await call(ctxA, "GET", `/api/v2/task/${t1.id}`)).title, { timeout: 15_000 }).toBe("Book train tickets");
  // and Alice's app shows it after its next sync
  await a.goto(`${MULTI}/#p/${pid}/tasks`);
  await a.reload();
  await expect(a.getByText("Book train tickets")).toBeVisible();
  await b.goto(`${MULTI}/#p/${pid}/tasks/${t2.id}`);
  await both(b, "shared-list");

  // the admin switches collaboration off: Bob keeps the list but loses edit rights
  await a.goto(`${MULTI}/#q/today/tasks?modalType=settings&tabs=members`);
  await a.getByTestId("collab-switch").click();
  await expect(a.getByTestId("collab-switch")).toHaveAttribute("aria-checked", "false");
  await b.reload();
  await b.goto(`${MULTI}/#p/${pid}/tasks/${t1.id}`);
  await synced(b);
  await expect(b.getByTestId("readonly-banner")).toBeVisible();
  await expect(b.getByTestId("detail-title")).toBeDisabled();
  const refused = await call(ctxB, "POST", "/api/v2/batch/task", { update: [{ ...t1, title: "sneaky" }] });
  expect(refused.id2error[t1.id]).toBe("NO_PROJECT_PERMISSION");
  expect((await call(ctxA, "GET", `/api/v2/task/${t1.id}`)).title).toBe("Book train tickets");
  await both(b, "shared-list-readonly");

  await ctxA.close();
  await ctxB.close();
});
