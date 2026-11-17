import { expect, test, type Page } from "@playwright/test";
import { api, inboxId, oid } from "./seed";

type T = Record<string, unknown> & { id: string; title: string; status: number; sortOrder: number };

async function serverTasks(): Promise<T[]> {
  const r = await api<{ syncTaskBean: { update: T[] } }>("GET", "/api/v3/batch/check/0");
  return r.syncTaskBean.update;
}
async function serverTask(id: string): Promise<T | null> {
  try {
    return await api<T>("GET", `/api/v2/task/${id}`);
  } catch {
    return null;
  }
}
async function byTitle(title: string): Promise<T | undefined> {
  return (await serverTasks()).find((t) => t.title === title);
}
const row = (page: Page, title: string) => page.locator(`[data-testid=task-row][data-title="${title}"]`);
const localMidnight = (offset: number): number => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d.getTime();
};
const wire = (s: unknown): number => Date.parse(String(s).replace("+0000", "Z"));
/** wait until the app's outbox is empty (sync badge gone and state idle) */
async function synced(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(600); // debounced editor saves
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
}

test("quick add with date, tag and priority creates a parsed task", async ({ page }) => {
  await page.goto(`/#p/${await inboxId()}/tasks`);
  const input = page.getByTestId("quick-add-input");
  await input.click();
  await input.fill("Pay electricity bill tomorrow #bills !high");
  // live recognition: date, tag and priority are adjacent, so they merge into one highlighted run (QADD-064)
  await expect(page.getByTestId("qa-mark")).toHaveCount(1);
  await expect(page.getByTestId("qa-mark")).toHaveText("tomorrow #bills !high");
  await input.press("Enter");
  await expect(row(page, "Pay electricity bill")).toBeVisible();
  await expect(row(page, "Pay electricity bill").getByTestId("date-chip")).toHaveText("Tomorrow");
  await expect(row(page, "Pay electricity bill").locator(".tag-pill")).toHaveText("bills");
  await synced(page);
  const t = (await byTitle("Pay electricity bill"))!;
  expect(t.priority).toBe(5);
  expect(t.tags).toEqual(["bills"]);
  expect(wire(t.startDate)).toBe(localMidnight(1));
  expect(t.isAllDay).toBe(true);
  // it shows in Tomorrow
  await page.goto("/#q/tomorrow/tasks");
  await expect(row(page, "Pay electricity bill")).toBeVisible();
});

test("clicking a highlighted date cancels its recognition", async ({ page }) => {
  await page.goto(`/#p/${await inboxId()}/tasks`);
  const input = page.getByTestId("quick-add-input");
  await input.click();
  await input.fill("Read Monday report");
  await expect(page.getByTestId("qa-mark")).toHaveCount(1);
  // put the caret inside the word "Monday" by clicking in the middle of the highlight
  const box = (await page.getByTestId("qa-mark").boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("qa-mark-off")).toHaveCount(1);
  await expect(page.getByTestId("qa-mark")).toHaveCount(0);
  await input.press("Enter");
  await expect(row(page, "Read Monday report")).toBeVisible();
  await synced(page);
  const t = (await byTitle("Read Monday report"))!;
  expect(t.startDate ?? null).toBeNull();
});

test("edit in the detail pane: title, priority, date, description persist", async ({ page }) => {
  const inbox = await inboxId();
  const id = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: inbox, title: "Draft newsletter", status: 0, sortOrder: -(2 ** 50), priority: 0 }] });
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  const title = page.getByTestId("detail-title");
  await expect(title).toHaveValue("Draft newsletter");
  await title.fill("Draft the spring newsletter");
  await title.press("Enter");
  await page.getByTestId("detail-priority").click();
  await page.getByTestId("priority-medium").click();
  await page.getByTestId("detail-date").click();
  await page.getByTestId("dp-tomorrow").click();
  await page.getByTestId("dp-time").click();
  await page.getByTestId("time-14:00").click();
  await page.getByTestId("dp-ok").click();
  await page.getByTestId("detail-body").click();
  await page.getByTestId("detail-body").fill("## Outline\n\n- intro\n- events");
  await page.getByTestId("detail-title").click();
  await synced(page);
  await page.reload();
  await expect(page.getByTestId("detail-title")).toHaveValue("Draft the spring newsletter");
  await expect(page.getByTestId("detail-body-rendered").locator("h2")).toHaveText("Outline");
  await expect(page.getByTestId("detail-date")).toContainText("Tomorrow, 14:00");
  const t = (await serverTask(id))!;
  expect(t.title).toBe("Draft the spring newsletter");
  expect(t.priority).toBe(3);
  expect(t.isAllDay).toBe(false);
  expect(wire(t.startDate)).toBe(localMidnight(1) + 14 * 3600_000);
  expect(t.content).toBe("## Outline\n\n- intro\n- events");
  expect((t.reminders as unknown[]).length).toBe(1); // default reminder (on time) applied when a time is set
});

test("completing a repeating task rolls it to the next occurrence", async ({ page }) => {
  const inbox = await inboxId();
  const id = oid();
  const today = new Date(localMidnight(0)).toISOString().replace("Z", "+0000");
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: inbox, title: "Stretch for ten minutes", status: 0, sortOrder: 0, startDate: today, dueDate: today, isAllDay: true, repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1", repeatFrom: "2", timeZone: "Europe/Amsterdam" }] });
  await page.goto("/#q/today/tasks");
  await expect(row(page, "Stretch for ten minutes")).toBeVisible();
  await row(page, "Stretch for ten minutes").getByTestId("task-check").click();
  await expect(row(page, "Stretch for ten minutes")).toHaveCount(1); // the completed copy sits in Completed below
  await expect(page.getByTestId("completed-group").locator(`[data-title="Stretch for ten minutes"]`)).toBeVisible();
  await page.goto("/#q/tomorrow/tasks");
  const open = page.locator(`.task-group:not(.completed-group) [data-testid=task-row][data-title="Stretch for ten minutes"]`);
  await expect(open).toBeVisible();
  await expect(open.getByTestId("date-chip")).toHaveText("Tomorrow");
  await synced(page);
  const master = (await serverTask(id))!;
  expect(master.status).toBe(0);
  expect(wire(master.startDate)).toBe(localMidnight(1));
  const closed = await api<T[]>("GET", "/api/v2/project/all/closed?status=Completed&limit=50");
  const copy = closed.find((t) => t.repeatTaskId === id);
  expect(copy?.status).toBe(2);
});

test("drag reorder writes sortOrder and survives a reload", async ({ page }) => {
  const pid = oid();
  const step = 2 ** 40;
  await api("POST", "/api/v2/batch/project", { add: [{ id: pid, name: "Packing", sortOrder: 99 * step, kind: "TASK", viewMode: "list", inAll: true }] });
  const ids = [oid(), oid(), oid()];
  await api("POST", "/api/v2/batch/task", { add: ["Passport", "Charger", "Sunscreen"].map((title, i) => ({ id: ids[i], projectId: pid, title, status: 0, sortOrder: i * step })) });
  await page.goto(`/#p/${pid}/tasks`);
  const titles = () => page.locator("[data-testid=task-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-title")));
  await expect.poll(titles).toEqual(["Passport", "Charger", "Sunscreen"]);
  const handle = row(page, "Sunscreen").getByTestId("drag-handle");
  await row(page, "Sunscreen").hover();
  const from = (await handle.boundingBox())!;
  const to = (await row(page, "Passport").boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 4, from.y - 10, { steps: 4 });
  await page.mouse.move(to.x + 40, to.y + 4, { steps: 12 });
  await page.mouse.move(to.x + 40, to.y + 2, { steps: 2 });
  await page.mouse.up();
  await expect.poll(titles).toEqual(["Sunscreen", "Passport", "Charger"]);
  await synced(page);
  await page.reload();
  await expect.poll(titles).toEqual(["Sunscreen", "Passport", "Charger"]);
  const s = await Promise.all(ids.map((i) => serverTask(i)));
  expect(s[2]!.sortOrder).toBeLessThan(s[0]!.sortOrder);
});

test("an offline edit syncs after reconnect", async ({ page, context }) => {
  const inbox = await inboxId();
  const id = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: inbox, title: "Offline candidate", status: 0, sortOrder: -(2 ** 51) }] });
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await expect(page.getByTestId("detail-title")).toHaveValue("Offline candidate");
  await synced(page);
  await context.setOffline(true);
  await page.getByTestId("detail-title").fill("Edited while offline");
  await page.getByTestId("detail-title").press("Enter");
  await page.getByTestId("rail-sync").click();
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "offline");
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveText("1");
  expect((await serverTask(id))!.title).toBe("Offline candidate");
  // the edit is in IndexedDB: survives a reload while offline is not required, but it is visible locally
  await expect(row(page, "Edited while offline")).toBeVisible();
  await context.setOffline(false);
  await expect.poll(async () => (await serverTask(id))!.title, { timeout: 20_000 }).toBe("Edited while offline");
});

test("two browser contexts converge", async ({ browser }) => {
  const inbox = await inboxId();
  const a = await browser.newContext({ timezoneId: "Europe/Amsterdam", viewport: { width: 1440, height: 900 } });
  const b = await browser.newContext({ timezoneId: "Europe/Amsterdam", viewport: { width: 1440, height: 900 } });
  const pa = await a.newPage();
  const pb = await b.newPage();
  await pa.goto(`/#p/${inbox}/tasks`);
  await pb.goto(`/#p/${inbox}/tasks`);
  await expect(pa.getByTestId("view-title")).toHaveText("Inbox");
  await expect(pb.getByTestId("view-title")).toHaveText("Inbox");
  const input = pa.getByTestId("quick-add-input");
  await input.click();
  await input.fill("Shared shopping list !medium");
  await input.press("Enter");
  await expect(row(pa, "Shared shopping list")).toBeVisible();
  await synced(pa);
  await pb.keyboard.press("."); // sync shortcut
  await expect(row(pb, "Shared shopping list")).toBeVisible({ timeout: 15_000 });
  // B renames it, A sees the rename; then A completes it and B sees it leave the open list
  await row(pb, "Shared shopping list").click();
  await pb.getByTestId("detail-title").fill("Shared shopping list v2");
  await pb.getByTestId("detail-title").press("Enter");
  await synced(pb);
  await pa.keyboard.press(".");
  await expect(row(pa, "Shared shopping list v2")).toBeVisible({ timeout: 15_000 });
  await row(pa, "Shared shopping list v2").getByTestId("task-check").click();
  await synced(pa);
  await pb.keyboard.press("Escape");
  await pb.keyboard.press(".");
  await expect(pb.locator(`.task-group:not(.completed-group) [data-title="Shared shopping list v2"]`)).toHaveCount(0, { timeout: 15_000 });
  await a.close();
  await b.close();
});
