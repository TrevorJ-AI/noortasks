import { expect, test, type Page } from "@playwright/test";
import { api, oid } from "./seed";

/** M3 breadth checks (UI): calendar sub-views, options and shortcuts, kanban sections, timeline zoom and grouping, matrix rules and views. */
type T = Record<string, unknown> & { id: string; title: string; status: number; priority: number; projectId: string };
const step = 2 ** 40;
const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
const wire = (s: unknown): number => Date.parse(String(s).replace("+0000", "Z"));
const at = (d: number, h: number, m = 0): number => {
  const x = new Date();
  x.setHours(h, m, 0, 0);
  x.setDate(x.getDate() + d);
  return x.getTime();
};
const midnight = (d: number): number => at(d, 0);
const center = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, ctrl = false): Promise<void> {
  await page.mouse.move(from.x, from.y);
  if (ctrl) await page.keyboard.down("Control");
  await page.mouse.down();
  await page.mouse.move(from.x + 6, from.y + 6, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.mouse.move(to.x + 1, to.y + 1, { steps: 2 });
  await page.mouse.up();
  if (ctrl) await page.keyboard.up("Control");
}
async function synced(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
}
const all = async (): Promise<T[]> => (await api<{ syncTaskBean: { update: T[] } }>("GET", "/api/v3/batch/check/0")).syncTaskBean.update;
const inbox = async (): Promise<string> => (await api<{ inboxId: string }>("GET", "/api/v2/user/status")).inboxId;
async function openView(page: Page, sel: string): Promise<void> {
  await page.getByTestId("cal-view").click();
  await page.getByTestId(`cal-view-${sel}`).click();
}

test("calendar views, header, shortcuts and options (CAL-006..041)", async ({ page }) => {
  test.setTimeout(120_000);
  const ib = await inbox();
  const doneId = oid();
  await api("POST", "/api/v2/batch/task", {
    add: [
      { id: oid(), projectId: ib, title: "Weekly review", status: 0, sortOrder: 0, startDate: iso(midnight(0)), dueDate: iso(midnight(0)), isAllDay: true, repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1" },
      { id: doneId, projectId: ib, title: "Filed the receipts", status: 2, completedTime: iso(at(0, 8)), sortOrder: 0, startDate: iso(midnight(0)), dueDate: iso(midnight(0)), isAllDay: true },
    ],
  });
  await page.goto("/#c/all/calendar/m");
  await openView(page, "month");
  // the dropdown lists seven views in the expected order (CAL-007)
  await page.getByTestId("cal-view").click();
  await expect(page.getByTestId("cal-view-menu").locator(".menu-label")).toHaveText(["Year", "Month", "Week", "Day", "Agenda", "Multi-Day", "Multi-Week"]);
  await page.keyboard.press("Escape");
  const title = await page.getByTestId("cal-title").textContent();
  await page.getByTestId("cal-next").click();
  await expect(page.getByTestId("cal-title")).not.toHaveText(title!);
  await page.getByTestId("cal-today").click();
  await expect(page.getByTestId("cal-title")).toHaveText(title!);
  // repeat cycles: off shows one instance, on shows the weekly occurrences (RPT-106, CAL-036); read in Agenda
  await openView(page, "agenda");
  const chips = page.locator('[data-testid=agenda-item][data-title="Weekly review"]');
  await expect(chips).toHaveCount(1);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-repeat").click();
  await expect.poll(() => chips.count()).toBeGreaterThan(4);
  // show completed off hides the completed task (CAL-029); checked in Agenda, where a busy day never overflows
  const filed = page.locator('[data-testid=agenda-item][data-title="Filed the receipts"]');
  await expect(filed).toHaveCount(1);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-completed").click();
  await expect(filed).toHaveCount(0);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-completed").click();
  await expect(filed).toHaveCount(1);
  await openView(page, "month");
  // week numbers (CAL-038) and hide weekends (CAL-041)
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-weeknum").click();
  await expect(page.getByTestId("cal-weeknum").first()).toHaveText(/^W\d+$/);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-weekend").click();
  await expect(page.locator(".cal-month-head span:not(:empty)")).toHaveCount(5);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-weekend").click();
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-weeknum").click();
  // shortcuts: w week, 3 month, y year, a agenda, d day, t today (CAL-010, KEYS-046..051)
  await page.keyboard.press("w");
  await expect(page).toHaveURL(/calendar\/w$/);
  await expect(page.getByTestId("cal-day-head")).toHaveCount(7);
  await page.keyboard.press("3");
  await expect(page.getByTestId("cal-month")).toBeVisible();
  await page.keyboard.press("y");
  await expect(page.getByTestId("cal-year-day")).toHaveCount(new Date(new Date().getFullYear(), 1, 29).getDate() === 29 ? 366 : 365);
  await page.keyboard.press("a");
  await expect(page.getByTestId("agenda-today")).toBeVisible();
  await page.keyboard.press("d");
  await expect(page.getByTestId("cal-day-head")).toHaveCount(1);
  await page.getByTestId("cal-next").click();
  await page.keyboard.press("t");
  await expect(page.locator(".cal-day-head.today")).toHaveCount(1);
  // multi-day count and multi-week count (CAL-021, CAL-022)
  await openView(page, "multiDay");
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-days").click();
  await page.getByTestId("opt-days-5").click();
  await expect(page.getByTestId("cal-day-head")).toHaveCount(5);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-days").click();
  await page.getByTestId("opt-days-14").click();
  await expect(page.getByTestId("cal-day-head")).toHaveCount(14);
  await openView(page, "multiWeek");
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-weeks").click();
  await page.getByTestId("opt-weeks-2").click();
  await expect(page.locator(".cal-week-row")).toHaveCount(2);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-weeks").click();
  await page.getByTestId("opt-weeks-6").click();
  await expect(page.locator(".cal-week-row")).toHaveCount(6);
  // the device remembers the multi-day count (SET-274)
  expect(await page.evaluate(() => localStorage.getItem("multiCalendarCount"))).toBe("14");
  // year heatmap: today has completions, toggling Heatmap removes the shading (CAL-017, CAL-018)
  await openView(page, "year");
  const todayCell = page.locator(`[data-testid=cal-year-day][data-date="${new Date(midnight(0)).toLocaleDateString("sv-SE")}"]`);
  await expect.poll(async () => Number(await todayCell.getAttribute("data-heat"))).toBeGreaterThan(0);
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-heatmap").click();
  await expect(todayCell).toHaveAttribute("data-heat", "0");
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-heatmap").click();
  await todayCell.click();
  await expect(page.getByTestId("cal-day-pop")).toContainText("Filed the receipts");
});

test("calendar writes: click a slot to add, drag across days, copy, re-day, split view, batch postpone, recurring choice (CAL-012, 013, 051..057, RPT-102)", async ({ page }) => {
  test.setTimeout(150_000);
  const ib = await inbox();
  const a = oid();
  const b = oid();
  const undated = oid();
  const rep = oid();
  await api("POST", "/api/v2/batch/task", {
    add: [
      { id: a, projectId: ib, title: "Call the bank", status: 0, sortOrder: 0, startDate: iso(at(0, 9)), dueDate: iso(at(0, 10)), isAllDay: false },
      { id: b, projectId: ib, title: "Water the herbs", status: 0, sortOrder: 0, startDate: iso(at(0, 16)), dueDate: iso(at(0, 16, 30)), isAllDay: false },
      { id: undated, projectId: ib, title: "Plan the picnic", status: 0, sortOrder: -(2 ** 52) },
      { id: rep, projectId: ib, title: "Stretching", status: 0, sortOrder: 0, startDate: iso(at(0, 19)), dueDate: iso(at(0, 19, 30)), isAllDay: false, repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1" },
    ],
  });
  await page.goto("/#c/all/calendar/d");
  await openView(page, "multiDay");
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-days").click();
  await page.getByTestId("opt-days-3").click();
  await expect(page.getByTestId("cal-day-head")).toHaveCount(3);
  const cols = page.locator("[data-col]");
  const hh = 48;
  // click an empty 14:00 slot today: a task due 14:00 (CAL-012); grid top is 07:00 after a 22px band
  const c0 = (await cols.nth(0).boundingBox())!;
  const y14 = c0.y + 22 + (14 - 7) * hh + 10;
  await page.mouse.click(c0.x + c0.width / 2, y14);
  await page.getByTestId("add-at-input").fill("Pick up the parcel");
  await page.getByTestId("add-at-input").press("Enter");
  await synced(page);
  const parcel = (await all()).find((t) => t.title === "Pick up the parcel")!;
  expect(wire(parcel.startDate)).toBe(at(0, 14));
  expect(parcel.isAllDay).toBe(false);
  // cross-day drag keeps the time (CAL-053)
  const blockA = page.locator('[data-testid=cal-block][data-title="Call the bank"]');
  const ba = (await blockA.boundingBox())!;
  const c1 = (await cols.nth(1).boundingBox())!;
  await drag(page, { x: ba.x + ba.width / 2, y: ba.y + 8 }, { x: c1.x + c1.width / 2, y: ba.y + 8 });
  await synced(page);
  let ta = (await all()).find((t) => t.id === a)!;
  expect(wire(ta.startDate)).toBe(at(1, 9));
  // Ctrl-drag copies (CAL-054, TASK-080)
  const bb = (await page.locator('[data-testid=cal-block][data-title="Water the herbs"]').boundingBox())!;
  const c2 = (await cols.nth(2).boundingBox())!;
  await drag(page, { x: bb.x + bb.width / 2, y: bb.y + 6 }, { x: c2.x + c2.width / 2, y: bb.y + 6 }, true);
  await synced(page);
  const herbs = (await all()).filter((t) => t.title === "Water the herbs" && t.status === 0);
  expect(herbs.length).toBe(2);
  expect(herbs.map((t) => wire(t.startDate)).sort()).toEqual([at(0, 16), at(2, 16)].sort());
  // Ctrl-click two blocks, Postpone moves both one hour (CAL-055)
  await page.locator('[data-testid=cal-block][data-title="Call the bank"]').click({ modifiers: ["Control"] });
  await page.locator('[data-testid=cal-block][data-title="Pick up the parcel"]').click({ modifiers: ["Control"] });
  await expect(page.getByTestId("cal-batch")).toContainText("2 selected");
  await page.getByTestId("cal-postpone").click();
  await synced(page);
  ta = (await all()).find((t) => t.id === a)!;
  expect(wire(ta.startDate)).toBe(at(1, 10));
  expect(wire((await all()).find((t) => t.title === "Pick up the parcel")!.startDate)).toBe(at(0, 15));
  // completion checkbox on a block (CAL-056)
  await page.locator('[data-testid=cal-block][data-title="Pick up the parcel"]').getByTestId("cal-check").click();
  await synced(page);
  expect((await all()).find((t) => t.title === "Pick up the parcel")).toBeUndefined();
  // split view: drag an unscheduled task onto tomorrow 11:00 (CAL-051, CAL-057)
  await page.getByTestId("cal-split").click();
  const item = page.locator('[data-testid=arrange-item][data-title="Plan the picnic"]');
  await expect(item).toBeVisible();
  const c1b = (await cols.nth(1).boundingBox())!;
  await item.dragTo(cols.nth(1), { targetPosition: { x: c1b.width / 2, y: 22 + (11 - 7) * hh + 2 } });
  await synced(page);
  const pic = (await all()).find((t) => t.id === undated)!;
  expect(wire(pic.startDate)).toBe(at(1, 11));
  await page.getByTestId("cal-split").click();
  // recurring: drag tomorrow's occurrence, keep the series, change only this one (RPT-102)
  await page.getByTestId("cal-options").click();
  await page.getByTestId("opt-repeat").click();
  const occ = page.locator('[data-testid=cal-block][data-title="Stretching"]').nth(1);
  const ob = (await occ.boundingBox())!;
  // grab the left end of the block: undo toasts sit over the middle of the grid
  await drag(page, { x: ob.x + 40, y: ob.y + 12 }, { x: ob.x + 40, y: ob.y + 12 - hh });
  await page.getByRole("button", { name: "Only this recurrence" }).click();
  await synced(page);
  const series = (await all()).find((t) => t.id === rep)!;
  expect(series.exDate).toContain(new Date(midnight(1)).toLocaleDateString("sv-SE").replace(/-/g, ""));
  expect(wire(series.startDate)).toBe(at(0, 19));
  const oneOff = (await all()).find((t) => t.title === "Stretching" && t.id !== rep)!;
  expect(wire(oneOff.startDate)).toBe(at(1, 18));
  expect(oneOff.repeatFlag ?? null).toBeNull();
  // month: press on one cell and drag across three days creates a three-day task (CAL-013)
  await openView(page, "month");
  const d0 = page.locator(`[data-testid=cal-cell][data-date="${new Date(midnight(0)).toLocaleDateString("sv-SE")}"]`);
  const d2 = page.locator(`[data-testid=cal-cell][data-date="${new Date(midnight(2)).toLocaleDateString("sv-SE")}"]`);
  const r0 = (await d0.boundingBox())!;
  const r2 = (await d2.boundingBox())!;
  await drag(page, { x: r0.x + r0.width - 12, y: r0.y + r0.height - 8 }, { x: r2.x + 20, y: r2.y + r2.height - 8 });
  await page.getByTestId("add-at-input").fill("Family visit");
  await page.getByTestId("add-at-input").press("Enter");
  await synced(page);
  const fam = (await all()).find((t) => t.title === "Family visit")!;
  expect(wire(fam.startDate)).toBe(midnight(0));
  expect(wire(fam.dueDate)).toBe(midnight(3));
  expect(fam.isAllDay).toBe(true);
});

test("features: calendar switch, mini calendar day list, go to date (CAL-003, CAL-046, VIEW-039, SET-165)", async ({ page }) => {
  await page.goto("/#q/today/tasks?modalType=settings&tabs=more");
  await page.getByTestId("set-mini-calendar").click();
  await page.goto("/#q/today/tasks?modalType=settings&tabs=feature");
  await page.getByTestId("feature-calendar").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rail-calendar")).toHaveCount(0);
  await page.goto("/#q/today/tasks?modalType=settings&tabs=feature");
  await page.getByTestId("feature-calendar").click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("rail-calendar")).toBeVisible();
  const mini = page.getByTestId("sidebar-mini-month");
  await expect(mini).toBeVisible();
  const key = new Date(midnight(0)).toLocaleDateString("sv-SE");
  await mini.locator(`[data-date="${key}"]`).click();
  await expect(page).toHaveURL(new RegExp(`#d/${key}/tasks`));
  await expect(page.getByTestId("list-view")).toBeVisible();
  await page.getByTestId("rail-calendar").click();
  await expect(page.getByTestId("calendar")).toBeVisible();
});

test("kanban sections from the list menu, rename, quick add, collapse, Today board by priority (LIST-037, KANB-004/005/009/010/012/013)", async ({ page }) => {
  test.setTimeout(120_000);
  // Add List with View Type Kanban opens the board (LIST-028)
  await page.goto("/#q/today/tasks");
  await page.getByTestId("add-list").click();
  await page.getByTestId("list-name").fill("Garage clean-up");
  await page.getByTestId("list-dialog").getByRole("button", { name: "Kanban" }).click();
  await page.getByTestId("list-save").click();
  await expect(page.getByTestId("kanban-view")).toBeVisible();
  const pid = page.url().split("#p/")[1]!.split("/")[0]!;
  // Add Section from the list menu (LIST-037)
  await page.getByTestId("list-more").click();
  await page.getByTestId("add-section").click();
  await page.getByTestId("section-name").fill("Sort");
  await page.getByTestId("section-ok").click();
  await page.getByTestId("kb-new-lane").click();
  await page.getByTestId("kb-new-lane-input").fill("Haul away");
  await page.getByTestId("kb-new-lane-input").press("Enter");
  // isolation (M4 pass): wait for the first add to land, or the cleared field races the next fill on a busy box
  await expect(page.locator('[data-testid=kb-lane][data-lane="Haul away"]')).toBeVisible();
  await expect(page.getByTestId("kb-new-lane-input")).toHaveValue("");
  await page.getByTestId("kb-new-lane-input").fill("sort");
  await page.getByTestId("kb-new-lane-input").press("Enter");
  await expect(page.getByText("A section with this name already exists")).toBeVisible();
  await page.keyboard.press("Escape");
  const lane = (n: string) => page.locator(`[data-testid=kb-lane][data-lane="${n}"]`);
  await expect(lane("Sort")).toBeVisible();
  await expect(lane("Haul away")).toBeVisible();
  // quick add inside a column (KANB-013)
  await lane("Sort").getByTestId("kb-add").click();
  await lane("Sort").getByTestId("kb-add-input").fill("Old paint cans");
  await lane("Sort").getByTestId("kb-add-input").press("Enter");
  await expect(lane("Sort").locator('[data-title="Old paint cans"]')).toBeVisible();
  // rename (KANB-005)
  await lane("Haul away").getByTestId("kb-lane-menu").click();
  await page.getByTestId("kb-lane-rename").click();
  await page.getByTestId("kb-rename").fill("Recycle");
  await page.getByTestId("kb-rename").press("Enter");
  await expect(lane("Recycle")).toBeVisible();
  // collapse survives reload (KANB-012)
  await lane("Recycle").locator(".kb-lane-name").click();
  await page.reload();
  await expect(lane("Recycle")).toHaveClass(/collapsed/);
  await synced(page);
  const cols = await api<Array<{ name: string; id: string }>>("GET", `/api/v2/column/project/${pid}`);
  expect(cols.map((c) => c.name).sort()).toEqual(["Recycle", "Sort"]);
  const cans = (await all()).find((t) => t.title === "Old paint cans")!;
  expect(cans.columnId).toBe(cols.find((c) => c.name === "Sort")!.id);
  // the list view shows sections as headings (LIST-037)
  await page.getByTestId("list-more").click();
  await page.getByTestId("view-mode-tasks").click();
  await expect(page.locator(".group-label", { hasText: "Sort" })).toBeVisible();
  // Today: kanban offered, timeline not (VIEW-022, TIME-003); group by priority and drag to High (KANB-010)
  const ib = await inbox();
  const id = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: ib, title: "Return the drill", status: 0, priority: 0, sortOrder: -(2 ** 52), startDate: iso(midnight(0)), dueDate: iso(midnight(0)), isAllDay: true }] });
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("view-title")).toHaveText("Today");
  await page.getByTestId("list-more").click();
  await expect(page.getByTestId("view-mode-kanban")).toBeVisible();
  await expect(page.getByTestId("view-mode-timeline")).toHaveCount(0);
  await page.getByTestId("view-mode-kanban").click();
  await expect(page).toHaveURL(/#q\/today\/kanban/);
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("group-by").click();
  await page.getByTestId("group-priority").click();
  await page.keyboard.press("Escape");
  const card = page.locator('[data-testid=kb-card][data-title="Return the drill"]');
  await expect(lane("None").locator('[data-title="Return the drill"]')).toBeVisible();
  const high = (await lane("High").boundingBox())!;
  await drag(page, center((await card.boundingBox())!), { x: high.x + high.width / 2, y: high.y + high.height - 20 });
  await expect(lane("High").locator('[data-title="Return the drill"]')).toBeVisible();
  await synced(page);
  expect((await all()).find((t) => t.id === id)!.priority).toBe(5);
  // back to list for the other tests
  await page.getByTestId("list-more").click();
  await page.getByTestId("view-mode-tasks").click();
});

test("timeline zoom, grouping, click to add and drawer (TIME-006, 008, 009)", async ({ page }) => {
  const pid = oid();
  await api("POST", "/api/v2/batch/project", { add: [{ id: pid, name: "Studio move", sortOrder: 80 * step, kind: "TASK", viewMode: "timeline", inAll: true }] });
  await api("POST", "/api/v2/batch/task", {
    add: [
      { id: oid(), projectId: pid, title: "Rent the van", status: 0, priority: 5, sortOrder: 0, startDate: iso(midnight(1)), dueDate: iso(midnight(1)), isAllDay: true },
      { id: oid(), projectId: pid, title: "Pack the books", status: 0, priority: 1, sortOrder: step, startDate: iso(midnight(2)), dueDate: iso(midnight(4)), isAllDay: true },
      { id: oid(), projectId: pid, title: "Find a cleaner", status: 0, sortOrder: 2 * step },
    ],
  });
  await page.goto(`/#p/${pid}/timeline`);
  const bar = page.locator('[data-testid=tl-bar][data-title="Rent the van"]');
  await page.getByTestId("tl-zoom-week").click();
  const w1 = (await bar.boundingBox())!.width;
  await page.getByTestId("tl-zoom-month").click();
  await expect.poll(async () => (await bar.boundingBox())!.width).toBeLessThan(w1 / 2);
  await page.getByTestId("tl-zoom-day").click();
  await expect.poll(async () => (await bar.boundingBox())!.width).toBeGreaterThan(w1 * 3);
  expect(await page.evaluate(() => localStorage.getItem("timelineViewRangeTypeKey"))).toBe('"day"');
  await page.getByTestId("tl-zoom-week").click();
  await page.getByTestId("tl-options").click();
  await page.getByTestId("tl-group-by").click();
  await page.getByTestId("tl-group-priority").click();
  await expect(page.getByTestId("tl-group-High")).toBeVisible();
  await expect(page.getByTestId("tl-group-Low")).toBeVisible();
  // click on an empty spot creates a task on that day (TIME-006)
  const grid = (await page.getByTestId("tl-grid").boundingBox())!;
  const scroll = (await page.getByTestId("tl-scroll").boundingBox())!;
  await page.mouse.click(scroll.x + 60, grid.y + grid.height - 40);
  await page.getByTestId("add-at-input").fill("Label the boxes");
  await page.getByTestId("add-at-input").press("Enter");
  await expect(page.locator('[data-testid=tl-bar][data-title="Label the boxes"]')).toBeVisible();
  // the arrange drawer lists unscheduled tasks
  await page.getByTestId("tl-arrange").click();
  await expect(page.locator('[data-testid=tl-unscheduled][data-title="Find a cleaner"]')).toBeVisible();
  await synced(page);
  const created = (await all()).find((t) => t.title === "Label the boxes")!;
  expect(created.projectId).toBe(pid);
  expect(created.isAllDay).toBe(true);
});

test("matrix rules editor, restore defaults, named views, add inside a quadrant (MTRX-007, 008, 011, 016)", async ({ page }) => {
  test.setTimeout(120_000);
  await api("POST", "/api/v2/user/preferences/ext", { desktopTabBars: { tabBars: [{ name: "TASK", active: true }, { name: "CALENDAR", active: true }, { name: "MATRIX", active: true }] } });
  await page.goto("/#m/all/matrix");
  await expect(page.getByTestId("matrix")).toBeVisible();
  // add inside Q1: priority high side and due today (MTRX-016)
  await page.getByTestId("quad-add-1").click();
  await page.getByTestId("quad-add-input").fill("Renew passport");
  await page.getByTestId("quad-add-input").press("Enter");
  await expect(page.getByTestId("quadrant-1").locator('[data-title="Renew passport"]')).toBeVisible();
  await synced(page);
  const pass = (await all()).find((t) => t.title === "Renew passport")!;
  expect([5, 3]).toContain(pass.priority);
  expect(wire(pass.startDate)).toBe(midnight(0));
  // Q1 rule: priority Low only (custom rule), then restore defaults (MTRX-007, MTRX-008)
  await page.getByTestId("matrix-more").click();
  await page.getByTestId("matrix-edit-rules").click();
  await page.getByTestId("preset-priority").click();
  await page.getByTestId("rules-q1").click();
  await page.getByTestId("rule-prio-5").click();
  await page.getByTestId("rule-prio-1").click();
  await page.getByTestId("rules-name").fill("Low first");
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("quadrant-1")).toContainText("Low first");
  await expect(page.getByTestId("quadrant-1").locator('[data-title="Renew passport"]')).toHaveCount(0);
  await synced(page);
  const ext = await api<{ matrix: { quadrants: Array<{ rule: string }> } }>("GET", "/api/v2/user/preferences/ext");
  expect(JSON.parse(ext.matrix.quadrants[0]!.rule).and[0]).toMatchObject({ conditionName: "priority", or: [1] });
  await page.getByTestId("matrix-more").click();
  await page.getByTestId("matrix-edit-rules").click();
  await page.getByTestId("restore-defaults").click();
  await page.getByTestId("rules-save").click();
  await expect(page.getByTestId("quadrant-1").locator('[data-title="Renew passport"]')).toBeVisible();
  // named views: add Work (inherits rules), switch, delete (MTRX-011)
  await page.getByTestId("matrix-title").click();
  await page.getByTestId("matrix-manage").click();
  for (const n of ["Work", "Personal"]) {
    await page.getByTestId("matrix-view-name").fill(n);
    await page.getByTestId("matrix-view-add").click();
  }
  await expect(page.getByTestId("matrix-view-row")).toHaveCount(3);
  await page.keyboard.press("Escape");
  await page.getByTestId("matrix-title").click();
  await page.getByTestId("matrix-view-Work").click();
  await expect(page.getByTestId("matrix-title")).toContainText("Work");
  await expect(page.getByTestId("quadrant-1").locator('[data-title="Renew passport"]')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("matrixActiveViewId"))).not.toBe('""');
  await page.getByTestId("matrix-title").click();
  await page.getByTestId("matrix-manage").click();
  await page.getByTestId("matrix-view-delete").last().click();
  await expect(page.getByTestId("matrix-view-row")).toHaveCount(2);
});
