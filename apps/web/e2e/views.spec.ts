import { expect, test, type Page } from "@playwright/test";
import { api, oid } from "./seed";

/** M3 views on synthetic data, against the real server. */
type T = Record<string, unknown> & { id: string; title: string; status: number; sortOrder: number };
const step = 2 ** 40;
const wire = (s: unknown): number => Date.parse(String(s).replace("+0000", "Z"));
const at = (offsetDays: number, h: number, m = 0): number => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
};
const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
async function serverTask(id: string): Promise<T> {
  return api<T>("GET", `/api/v2/task/${id}`);
}
async function synced(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
}
/** pointer drag in small steps so dnd-kit and the custom grids see a real gesture */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { ctrl?: boolean } = {}): Promise<void> {
  await page.mouse.move(from.x, from.y);
  if (opts.ctrl) await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.mouse.move(to.x + 1, to.y + 1, { steps: 2 });
  await page.mouse.up();
  if (opts.ctrl) await page.keyboard.up("Control");
}
const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

async function list(name: string, viewMode = "list"): Promise<string> {
  const id = oid();
  await api("POST", "/api/v2/batch/project", { add: [{ id, name, sortOrder: 50 * step + Math.floor(Math.random() * step), kind: "TASK", viewMode, inAll: true }] });
  return id;
}

test("kanban: move a card to another column, reload, columnId on the server (KANB-007)", async ({ page }) => {
  const pid = await list("Board kitchen", "kanban");
  const c1 = oid();
  const c2 = oid();
  await api("POST", "/api/v2/batch/columnProject", { add: [{ id: c1, projectId: pid, name: "To do", sortOrder: 0 }, { id: c2, projectId: pid, name: "Doing", sortOrder: step }] });
  const ids = [oid(), oid(), oid()];
  await api("POST", "/api/v2/batch/task", {
    add: [
      { id: ids[0], projectId: pid, title: "Sand the cabinet doors", status: 0, sortOrder: 0, columnId: c1 },
      { id: ids[1], projectId: pid, title: "Pick tile samples", status: 0, sortOrder: step, columnId: c1 },
      { id: ids[2], projectId: pid, title: "Measure the window", status: 0, sortOrder: 0, columnId: c2 },
    ],
  });
  await page.goto(`/#p/${pid}/tasks`);
  // the saved viewMode picks the layout and the URL suffix
  await expect(page).toHaveURL(new RegExp(`#p/${pid}/kanban`));
  const lane = (n: string) => page.locator(`[data-testid=kb-lane][data-lane="${n}"]`);
  await expect(lane("To do").getByTestId("kb-card")).toHaveCount(2);
  const card = lane("To do").locator('[data-title="Pick tile samples"]');
  const target = lane("Doing").locator('[data-title="Measure the window"]');
  await drag(page, center((await card.boundingBox())!), { x: center((await target.boundingBox())!).x, y: (await target.boundingBox())!.y + (await target.boundingBox())!.height - 4 });
  await expect(lane("Doing").getByTestId("kb-card")).toHaveCount(2);
  await synced(page);
  await page.reload();
  await expect(lane("Doing").locator('[data-title="Pick tile samples"]')).toBeVisible();
  await expect(lane("To do").getByTestId("kb-card")).toHaveCount(1);
  expect((await serverTask(ids[1]!)).columnId).toBe(c2);
});

test("timeline: drag a bar by two days and stretch its end by one (TIME-007)", async ({ page }) => {
  const pid = await list("Renovation plan", "timeline");
  const id = oid();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: pid, title: "Order the tiles", status: 0, sortOrder: 0, startDate: iso(start.getTime()), dueDate: iso(start.getTime()), isAllDay: true }] });
  await page.goto(`/#p/${pid}/timeline`);
  await expect(page.getByTestId("timeline-view")).toBeVisible();
  await page.getByTestId("tl-zoom-week").click();
  await page.getByTestId("toggle-sidebar").click(); // room for a two day drag
  const bar = page.locator('[data-testid=tl-bar][data-title="Order the tiles"]');
  await expect(bar).toBeVisible();
  const b = (await bar.boundingBox())!;
  // week zoom: 120 px per day
  await drag(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, { x: b.x + b.width / 2 + 240, y: b.y + b.height / 2 });
  await synced(page);
  let t = await serverTask(id);
  const day2 = new Date(start);
  day2.setDate(day2.getDate() + 2);
  expect(wire(t.startDate)).toBe(day2.getTime());
  expect(t.dueDate).toBe(t.startDate);
  const b2 = (await bar.boundingBox())!;
  const handle = bar.getByTestId("tl-handle-end");
  const h = (await handle.boundingBox())!;
  await drag(page, center(h), { x: center(h).x + 120, y: center(h).y });
  await synced(page);
  t = await serverTask(id);
  const end = new Date(day2);
  end.setDate(end.getDate() + 2); // exclusive end of a two day span
  expect(wire(t.startDate)).toBe(day2.getTime());
  expect(wire(t.dueDate)).toBe(end.getTime());
  expect((await bar.boundingBox())!.width).toBeGreaterThan(b2.width + 100);
  await page.getByTestId("toggle-sidebar").click();
});

test("calendar week: drag a block two hours later, then stretch its end by 30 minutes (CAL-014, CAL-052)", async ({ page }) => {
  const id = oid();
  const inbox = (await api<{ inboxId: string }>("GET", "/api/v2/user/status")).inboxId;
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: inbox, title: "Dentist check-up", status: 0, sortOrder: 0, startDate: iso(at(0, 10)), dueDate: iso(at(0, 11)), isAllDay: false }] });
  await page.goto("/#c/all/calendar/w");
  await expect(page.getByTestId("cal-timegrid")).toBeVisible();
  await expect(page.getByTestId("cal-view")).toContainText("Week");
  const block = page.locator('[data-testid=cal-block][data-title="Dentist check-up"]');
  await expect(block).toBeVisible();
  await expect(block).toContainText("10:00 - 11:00");
  const b = (await block.boundingBox())!;
  const hh = 48; // default hour height
  await drag(page, { x: b.x + b.width / 2, y: b.y + 8 }, { x: b.x + b.width / 2, y: b.y + 8 + 2 * hh });
  await expect(block).toContainText("12:00 - 13:00");
  await synced(page);
  let t = await serverTask(id);
  expect(wire(t.startDate)).toBe(at(0, 12));
  expect(wire(t.dueDate)).toBe(at(0, 13));
  const edge = block.getByTestId("cal-resize-bottom");
  const e = (await edge.boundingBox())!;
  await drag(page, center(e), { x: center(e).x, y: center(e).y + hh / 2 });
  await expect(block).toContainText("12:00 - 13:30");
  await synced(page);
  t = await serverTask(id);
  expect(wire(t.startDate)).toBe(at(0, 12));
  expect(wire(t.dueDate)).toBe(at(0, 13, 30));
  // the chosen view is remembered (webCalendarViewType, CAL-005)
  expect((await api<{ webCalendarViewType: string }>("GET", "/api/v2/user/preferences/settings")).webCalendarViewType).toBe("w");
});

test("matrix: switched on in Settings, drag a task from Q4 to Q2 raises its priority (MTRX-001, MTRX-017)", async ({ page }) => {
  const inbox = (await api<{ inboxId: string }>("GET", "/api/v2/user/status")).inboxId;
  const id = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: inbox, title: "Sort the photo archive", status: 0, priority: 0, sortOrder: -(2 ** 52) }] });
  // isolation (M4 pass): views-ui runs first and leaves the matrix on; start from the default (off)
  await api("POST", "/api/v2/user/preferences/ext", { desktopTabBars: { tabBars: [{ name: "TASK", active: true }, { name: "CALENDAR", active: true }, { name: "MATRIX", active: false }] } });
  // off by default: the route renders an empty shell
  await page.goto("/#m/all/matrix");
  await expect(page.getByTestId("matrix-off")).toBeVisible();
  await page.goto("/#m/all/matrix?modalType=settings&tabs=feature");
  await page.getByTestId("feature-matrix").click();
  await page.keyboard.press("Escape");
  await page.goto("/#m/all/matrix");
  await expect(page.getByTestId("matrix")).toBeVisible();
  await expect(page.getByTestId("rail-matrix")).toBeVisible();
  const row = page.locator('[data-testid=task-row][data-title="Sort the photo archive"]');
  await expect(page.getByTestId("quadrant-4").locator('[data-title="Sort the photo archive"]')).toBeVisible();
  await row.hover();
  const h = (await row.getByTestId("drag-handle").boundingBox())!;
  const q2 = (await page.getByTestId("quadrant-2").boundingBox())!;
  await drag(page, center(h), { x: q2.x + q2.width / 2, y: q2.y + q2.height - 30 });
  await expect(page.getByTestId("quadrant-2").locator('[data-title="Sort the photo archive"]')).toBeVisible();
  await synced(page);
  const t = await serverTask(id);
  expect(t.priority).toBe(3);
  expect(t.startDate ?? null).toBeNull();
  const ext = await api<{ desktopTabBars: { tabBars: Array<{ name: string; active: boolean }> } }>("GET", "/api/v2/user/preferences/ext");
  expect(ext.desktopTabBars.tabBars.find((b) => b.name === "MATRIX")!.active).toBe(true);
});

test("view mode: switching a list to kanban persists after reload and in a second browser context (VIEW-020)", async ({ page, browser }) => {
  const pid = await list("Wedding prep");
  await api("POST", "/api/v2/batch/task", { add: [{ id: oid(), projectId: pid, title: "Send the invitations", status: 0, sortOrder: 0 }] });
  await page.goto(`/#p/${pid}/tasks`);
  await expect(page.getByTestId("list-view")).toBeVisible();
  await page.getByTestId("list-more").click();
  await page.getByTestId("view-mode-kanban").click();
  await expect(page).toHaveURL(new RegExp(`#p/${pid}/kanban`));
  await expect(page.getByTestId("kanban-view")).toBeVisible();
  await synced(page);
  expect((await api<Array<{ id: string; viewMode: string }>>("GET", "/api/v3/batch/check/0").then((r: unknown) => (r as { projectProfiles: Array<{ id: string; viewMode: string }> }).projectProfiles)).find((p) => p.id === pid)!.viewMode).toBe("kanban");
  await page.reload();
  await expect(page.getByTestId("kanban-view")).toBeVisible();
  // V then T switches to timeline (KEYS-016)
  await page.keyboard.press("v");
  await page.keyboard.press("t");
  await expect(page.getByTestId("timeline-view")).toBeVisible();
  await synced(page);
  const other = await browser.newContext({ timezoneId: "Europe/Amsterdam", viewport: { width: 1440, height: 900 } });
  const p2 = await other.newPage();
  await p2.goto(`/#p/${pid}/tasks`);
  await expect(p2.getByTestId("timeline-view")).toBeVisible({ timeout: 15_000 });
  await expect(p2).toHaveURL(new RegExp(`#p/${pid}/timeline`));
  await other.close();
});
