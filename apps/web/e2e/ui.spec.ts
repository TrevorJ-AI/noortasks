import { expect, test, type Page } from "@playwright/test";
import { api, inboxId, oid } from "./seed";

type T = Record<string, unknown> & { id: string; title: string };
const row = (page: Page, title: string) => page.locator(`[data-testid=task-row][data-title="${title}"]`);
const menuLabels = (page: Page, testId: string) => page.getByTestId(testId).locator(".menu-item .menu-label").allInnerTexts();
async function serverTask(id: string): Promise<T | null> {
  try {
    return await api<T>("GET", `/api/v2/task/${id}`);
  } catch {
    return null;
  }
}
async function synced(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(600);
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
}
async function newTask(title: string, extra: Record<string, unknown> = {}): Promise<{ id: string; inbox: string }> {
  const inbox = await inboxId();
  const id = oid();
  await api("POST", "/api/v2/batch/task", { add: [{ id, projectId: inbox, title, status: 0, sortOrder: -(2 ** 52) + Math.floor(Math.random() * 1e6), priority: 0, ...extra }] });
  return { id, inbox };
}

test("task more menu: 14 items in order; priority menu; list picker", async ({ page }) => {
  const { id, inbox } = await newTask("Menu probe");
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await page.getByTestId("detail-more").click();
  expect(await menuLabels(page, "detail-more-menu")).toEqual(["Add Subtask", "Link Parent Task", "Pin", "Won't Do", "Tags", "Upload Attachment", "Task Activities", "Save as Template", "Duplicate", "Copy Link", "Convert to Note", "Export", "Print", "Delete"]);
  await page.keyboard.press("Escape");
  await page.getByTestId("detail-priority").click();
  expect(await menuLabels(page, "priority-menu")).toEqual(["High", "Medium", "Low", "None"]);
  await page.getByTestId("priority-high").click();
  await expect(page.getByTestId("detail-check")).toHaveClass(/pr-5/);
  await page.getByTestId("detail-list").click();
  const picker = page.getByTestId("list-picker");
  await expect(picker.locator(".menu-item .menu-label").first()).toHaveText("Inbox");
  await picker.locator(".menu-item", { hasText: "Reading list" }).click();
  await synced(page);
  const t = (await serverTask(id))!;
  expect(t.priority).toBe(5);
  expect(t.projectId).not.toBe(inbox);
});

test("pin, won't do, duplicate, convert to note, delete with undo, restore from trash", async ({ page }) => {
  const { id, inbox } = await newTask("Lifecycle probe");
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-pin").click();
  await expect(page.getByTestId("group-pinned")).toContainText("Lifecycle probe");
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-duplicate").click();
  await expect(row(page, "Lifecycle probe")).toHaveCount(2);
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-convert-note").click();
  await expect(page.getByTestId("detail-check")).toHaveCount(0); // notes have no checkbox
  await page.getByTestId("detail-more").click();
  await expect(page.getByTestId("detail-more-menu")).toContainText("Convert to Task");
  await page.getByTestId("menu-convert-note").click();
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-wontdo").click();
  await synced(page);
  expect((await serverTask(id))!.status).toBe(-1);
  await page.goto("/#q/all/abandoned");
  await expect(row(page, "Lifecycle probe")).toBeVisible();
  await row(page, "Lifecycle probe").click();
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-wontdo").click(); // reads Reopen now
  await synced(page);
  expect((await serverTask(id))!.status).toBe(0);
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-delete").click();
  await expect(page.getByTestId("toast").last()).toContainText("Task deleted");
  await page.getByTestId("toast-undo").last().click();
  await expect(row(page, "Lifecycle probe").first()).toBeVisible();
  await synced(page);
  expect((await serverTask(id))!.deleted).toBe(0);
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-delete").click();
  await synced(page);
  expect((await serverTask(id))!.deleted).toBe(1);
  await page.goto("/#q/all/trash");
  await expect(page.getByTestId("trash-screen")).toBeVisible();
  const trow = page.locator(".trash-row", { has: row(page, "Lifecycle probe") }).first();
  await trow.hover();
  await trow.getByTestId("trash-restore").click();
  await synced(page);
  expect((await serverTask(id))!.deleted).toBe(0);
});

test("date picker: quick icons, repeat presets follow the date, custom editor modes, reminders", async ({ page }) => {
  const { id, inbox } = await newTask("Picker probe");
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await expect(page.getByTestId("detail-date")).toHaveText("Due Date");
  await page.getByTestId("detail-date").click();
  await expect(page.getByTestId("date-picker").locator(".dp-week span")).toHaveText(["S", "M", "T", "W", "T", "F", "S"]);
  await page.getByTestId("dp-nextweek").click();
  await page.getByTestId("dp-repeat").click();
  const labels = await page.getByTestId("repeat-list").locator(".menu-item .menu-label").allInnerTexts();
  const d = new Date();
  d.setDate(d.getDate() + 7);
  const wd = d.toLocaleDateString("en-US", { weekday: "long" });
  expect(labels.map((l) => l.replace(/\s+/g, " ").trim())).toEqual([`Daily`, `Weekly (${wd})`, expect.stringMatching(/^Monthly \(\d+(st|nd|rd|th)\)$/), expect.stringMatching(/^Yearly \([A-Z][a-z]{2} \d+(st|nd|rd|th)\)$/), "Every Weekday (Mon - Fri)", "Custom"]);
  await page.getByTestId("repeat-custom").click();
  const mode = page.getByTestId("custom-repeat").getByLabel("Repeat mode");
  await expect(mode.locator("option")).toHaveText(["By Due Dates", "By Completion Date", "By Specific Dates"]);
  await expect(page.getByTestId("custom-repeat").getByLabel("Unit").locator("option")).toHaveText(["Day", "Week", "Month", "Year"]);
  await page.getByTestId("custom-repeat").getByLabel("Interval").fill("2");
  await page.getByTestId("custom-repeat").getByLabel("Ends", { exact: true }).selectOption("count");
  await page.getByTestId("custom-repeat-ok").click();
  await expect(page.getByTestId("dp-repeat")).toContainText("Every 2 weeks");
  await page.getByTestId("dp-reminder").click();
  await expect(page.getByTestId("reminder-list")).toContainText("On the day (09:00)");
  await page.getByTestId("reminder-list").locator(".check-row", { hasText: "1 day early (09:00)" }).locator("input").check();
  await page.getByTestId("reminder-ok").click();
  await page.getByTestId("dp-ok").click();
  await synced(page);
  const t = (await serverTask(id))!;
  expect(String(t.repeatFlag)).toMatch(/^RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU;BYDAY=[A-Z]{2};COUNT=5$/);
  expect((t.reminders as Array<{ trigger: string }>).map((r) => r.trigger)).toEqual(["TRIGGER:-P0DT15H0M0S"]);
  // Clear removes the date
  await page.getByTestId("detail-date").click();
  await page.getByTestId("dp-clear").click();
  await expect(page.getByTestId("detail-date")).toHaveText("Due Date");
  await synced(page);
  expect((await serverTask(id))!.startDate ?? null).toBeNull();
});

test("date picker duration tab sets a start and end time", async ({ page }) => {
  const { id, inbox } = await newTask("Duration probe");
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await page.getByTestId("detail-date").click();
  await page.getByTestId("dp-duration-tab").click();
  await page.getByTestId("dur-start-time").click();
  await page.getByTestId("time-10:00").click();
  await page.getByTestId("dur-end-time").click();
  await page.getByTestId("time-11:30").click();
  await page.getByTestId("dp-ok").click();
  await expect(page.getByTestId("detail-date")).toContainText("10:00 - 11:30");
  await synced(page);
  const t = (await serverTask(id))!;
  expect(t.isAllDay).toBe(false);
  expect(Date.parse(String(t.dueDate).replace("+0000", "Z")) - Date.parse(String(t.startDate).replace("+0000", "Z"))).toBe(90 * 60_000);
});

test("list header menus: group by and sort by options, more menu items, hide completed", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await page.getByTestId("side-list-Home projects").getByRole("button").first().click();
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("group-by").click();
  const popovers = page.locator(".popover");
  expect(await popovers.last().locator(".menu-item .menu-label").allInnerTexts()).toEqual(["Custom", "Date", "Created Time", "Tag", "Priority", "None"]);
  await page.getByTestId("sort-by").click();
  expect((await popovers.last().locator(".menu-item .menu-label").allInnerTexts()).slice(0, 7)).toEqual(["Custom", "Date", "Created Time", "Modified Time", "Title", "Tag", "Priority"]);
  await page.getByTestId("sort-title").click();
  const titles = () => page.locator(".task-group:not(.completed-group) [data-testid=task-row]").evaluateAll((els) => els.filter((e) => !(e as HTMLElement).style.paddingLeft.startsWith("30")).map((e) => e.getAttribute("data-title")!));
  await expect.poll(async () => { const t = await titles(); return JSON.stringify(t) === JSON.stringify([...t].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }))); }).toBe(true);
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("group-by").click();
  await page.getByTestId("group-priority").click();
  await expect(page.getByTestId("group-priority_5")).toBeVisible();
  await page.getByTestId("list-more").click();
  expect(await menuLabels(page, "list-more-menu")).toEqual(["Hide Completed", "Show Details", "View Options", "Add Section", "Share", "List Activities", "Print"]);
  await expect(page.getByTestId("completed-group")).toBeVisible();
  await page.getByTestId("toggle-completed").click();
  await expect(page.getByTestId("completed-group")).toHaveCount(0);
  await page.getByTestId("list-more").click();
  await page.getByTestId("toggle-completed").click();
  await page.getByTestId("list-more").click();
  await page.getByTestId("toggle-details").click();
  await expect(page.locator(".task-detail-line").first()).toBeVisible();
  // restore defaults for later tests
  await page.getByTestId("list-more").click();
  await page.getByTestId("toggle-details").click();
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("group-by").click();
  await page.getByTestId("group-sortOrder").click();
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("sort-by").click();
  await page.getByTestId("sort-sortOrder").click();
});

test("add list dialog: color, folder, note type, hidden from All; rename, archive, delete", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await page.getByTestId("add-list").click();
  const dlg = page.getByTestId("list-dialog");
  await page.getByTestId("list-name").fill('Notes: "ideas"?');
  await dlg.locator(".swatch").nth(2).click();
  await page.getByTestId("list-folder").click();
  expect(await page.locator(".popover").last().locator(".menu-label").allInnerTexts()).toEqual(["None", "Personal", "New Folder"]);
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Personal" }).click();
  await page.getByTestId("list-kind").click();
  expect(await page.locator(".popover").last().locator(".menu-label").allInnerTexts()).toEqual(["Task List", "Note List"]);
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Note List" }).click();
  await page.getByTestId("list-inall").click();
  expect(await page.locator(".popover").last().locator(".menu-label").allInnerTexts()).toEqual(["All tasks", "Do not show"]);
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Do not show" }).click();
  await page.getByTestId("list-save").click();
  await expect(page.getByTestId("view-title")).toHaveText("Notes ideas");
  await synced(page);
  const r = await api<{ projectProfiles: Array<Record<string, unknown>> }>("GET", "/api/v3/batch/check/0");
  const p = r.projectProfiles.find((x) => x.name === "Notes ideas")!;
  expect(p.kind).toBe("NOTE");
  expect(p.inAll).toBe(false);
  expect(p.groupId).toBeTruthy();
  expect(p.color).toBeTruthy();
  // sidebar row menu: edit name, then delete
  const side = page.getByTestId("side-list-Notes ideas");
  await side.hover();
  await side.locator(".side-more").click();
  expect(await page.locator(".popover").last().locator(".menu-label").allInnerTexts()).toEqual(["Edit", "Duplicate", "Move to folder", "Show in All", "Archive", "Delete"]);
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Edit" }).click();
  await page.getByTestId("list-name").fill("Notebook");
  await page.getByTestId("list-save").click();
  await expect(page.getByTestId("side-list-Notebook")).toBeVisible();
  await page.getByTestId("side-list-Notebook").hover();
  await page.getByTestId("side-list-Notebook").locator(".side-more").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Delete" }).click();
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("side-list-Notebook")).toHaveCount(0);
  await synced(page);
  const r2 = await api<{ projectProfiles: Array<Record<string, unknown>> }>("GET", "/api/v3/batch/check/0");
  expect(r2.projectProfiles.some((x) => x.id === p.id)).toBe(false);
});

test("tags: create via dialog, tag view add bar pre-fills, rename rewrites tasks, delete strips them", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await page.getByTestId("add-tag").click();
  await page.getByTestId("tag-name").fill("health check");
  await page.getByTestId("tag-save").click();
  await expect(page.getByTestId("side-tag-healthcheck")).toBeVisible(); // whitespace stripped (TAG-003)
  await page.getByTestId("side-tag-healthcheck").getByRole("button").first().click();
  expect(page.url()).toContain(`#t/${Buffer.from("healthcheck").toString("base64")}/tasks`);
  await expect(page.getByTestId("empty-state")).toContainText("No tasks");
  await expect(page.getByTestId("empty-state")).toContainText("Take it easy");
  await expect(page.getByTestId("quick-add-input")).toHaveAttribute("placeholder", "#healthcheck");
  await page.getByTestId("quick-add-input").fill("Book a checkup");
  await page.getByTestId("quick-add-input").press("Enter");
  await expect(row(page, "Book a checkup")).toBeVisible();
  await synced(page);
  const side = page.getByTestId("side-tag-healthcheck");
  await side.hover();
  await side.locator(".side-more").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Edit" }).click();
  await page.getByTestId("tag-name").fill("wellness");
  await page.getByTestId("tag-save").click();
  await expect(page.getByTestId("side-tag-wellness")).toBeVisible();
  await synced(page);
  const all = (await api<{ syncTaskBean: { update: T[] } }>("GET", "/api/v3/batch/check/0")).syncTaskBean.update;
  const t = all.find((x) => x.title === "Book a checkup")!;
  expect(t.tags).toEqual(["wellness"]);
  await page.getByTestId("side-tag-wellness").hover();
  await page.getByTestId("side-tag-wellness").locator(".side-more").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Delete" }).click();
  await page.getByTestId("confirm-ok").click();
  await synced(page);
  expect((await serverTask(t.id))!.tags ?? []).toEqual([]);
});

test("completed screen: chips and their options, grouping by day; won't do empty state", async ({ page }) => {
  await page.goto("/#q/all/completed");
  await expect(page.getByTestId("completed-screen")).toBeVisible();
  await expect(page.locator(".group-label").first()).toHaveText(/^[A-Z][a-z]+day, (Today|Yesterday|[A-Z][a-z]{2} \d+)/);
  await page.getByTestId("chip-dates").click();
  expect(await menuLabels(page, "dates-menu")).toEqual(["All Dates", "This Week", "Last Week", "This Month", "Other Date"]);
  await page.keyboard.press("Escape");
  await page.getByTestId("chip-lists").click();
  const labels = await page.getByTestId("lists-menu").locator(".check-row").allInnerTexts();
  expect(labels[0]!.trim()).toBe("All Lists");
  expect(labels[1]!.trim()).toBe("Inbox");
  await page.keyboard.press("Escape");
  await page.goto("/#q/all/abandoned");
  // earlier tests may have left won't do rows; the empty text shows only when there are none
  const empty = page.getByTestId("empty-state");
  if (await empty.count()) await expect(empty).toContainText("Everything is in progress");
});

test("search modal: slash opens it, chips, local results with list chip; command menu entries", async ({ page }) => {
  await page.goto("/#q/today/tasks");
  await expect(page.getByTestId("view-title")).toHaveText("Today");
  await page.keyboard.press("/");
  await expect(page.getByTestId("search-modal")).toBeVisible();
  await expect(page.getByTestId("search-results")).toContainText("Enter keywords to search");
  await expect(page.getByTestId("search-modal").locator(".chip-btn")).toHaveText(["Task", "Tag", "List"]);
  const before = await page.evaluate(() => performance.getEntriesByType("resource").length);
  await page.getByTestId("search-input").fill("garage");
  await expect(page.getByTestId("search-hit")).toHaveCount(1);
  await expect(page.getByTestId("search-hit").locator("mark")).toHaveText("garage");
  const after = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("/search")).length);
  expect(after).toBe(0);
  void before;
  await page.getByTestId("search-hit").click();
  await expect(page.getByTestId("detail-title")).toHaveValue("Clean out the garage");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  const cmd = page.getByTestId("command-menu");
  await expect(cmd.locator("input")).toHaveAttribute("placeholder", "Type a command or search");
  const items = await cmd.locator(".menu-item .menu-label").allInnerTexts();
  expect(items.slice(0, 15)).toEqual(["New task", "Task", "Calendar", "Search", "Go to Settings", "All", "Today", "Tomorrow", "Next 7 Days", "Assigned to Me", "Inbox", "Completed", "Won't do", "Summary", "Trash"]);
  await cmd.locator("input").fill("trash");
  await cmd.locator("input").press("Enter");
  await expect(page.getByTestId("trash-screen")).toBeVisible();
});

test("keyboard: G then X navigation, Tab+1 date, Alt+3 priority, Tab+M complete, ? sheet, Ctrl+Z undo", async ({ page }) => {
  const { id, inbox } = await newTask("Keyboard probe");
  await page.goto("/#q/all/trash");
  await expect(page.getByTestId("trash-screen")).toBeVisible();
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page.getByTestId("view-title")).toHaveText("Today");
  await page.keyboard.press("g");
  await page.keyboard.press("i");
  await expect(page.getByTestId("view-title")).toHaveText("Inbox");
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  await expect(page.getByTestId("completed-screen")).toBeVisible();
  await page.goto(`/#p/${inbox}/tasks`);
  await row(page, "Keyboard probe").click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down("Tab");
  await page.keyboard.press("1");
  await page.keyboard.up("Tab");
  await expect(row(page, "Keyboard probe").getByTestId("date-chip")).toHaveText("Today");
  await page.keyboard.press("Alt+3");
  await expect(row(page, "Keyboard probe").getByTestId("task-check")).toHaveClass(/pr-5/);
  await page.keyboard.press("Control+z");
  await expect(row(page, "Keyboard probe").getByTestId("task-check")).not.toHaveClass(/pr-5/);
  await page.keyboard.down("Tab");
  await page.keyboard.press("m");
  await page.keyboard.up("Tab");
  await expect(page.locator(`.task-group:not(.completed-group) [data-title="Keyboard probe"]`)).toHaveCount(0);
  await synced(page);
  expect((await serverTask(id))!.status).toBe(2);
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcuts-dialog")).toContainText("Open Command Menu");
});

test("quick add: chevron menu items, priority flags, input box setting, batch paste, list marker", async ({ page }) => {
  await page.goto(`/#p/${await inboxId()}/tasks`);
  await page.getByTestId("quick-add-input").click();
  await page.getByTestId("qa-more").click();
  const menu = page.getByTestId("qa-menu");
  await expect(menu.locator(".menu-flags button")).toHaveCount(4);
  expect(await menu.locator(".menu .menu-item .menu-label").allInnerTexts()).toEqual(["Inbox", "Tags", "Attachment", "Add from Template", "Convert to Note", "Input Box Setting"]);
  await page.getByTestId("qa-priority-1").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("quick-add-input").fill("Low flag task ~Garden");
  await page.getByTestId("quick-add-input").press("Enter");
  await expect(page.getByTestId("toast")).toContainText("Added to Garden");
  await synced(page);
  const all = (await api<{ syncTaskBean: { update: T[] }; projectProfiles: Array<{ id: string; name: string }> }>("GET", "/api/v3/batch/check/0"));
  const t = all.syncTaskBean.update.find((x) => x.title === "Low flag task")!;
  expect(t.priority).toBe(1);
  expect(t.projectId).toBe(all.projectProfiles.find((p) => p.name === "Garden")!.id);
  // multi-line paste asks to batch add
  await page.getByTestId("quick-add-input").click();
  await page.evaluate(() => {
    const el = document.querySelector("[data-testid=quick-add-input]") as HTMLInputElement;
    const dt = new DataTransfer();
    dt.setData("text/plain", "Line one task\nLine two task tomorrow");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("batch-add")).toContainText("Add 2 tasks");
  await page.getByTestId("batch-ok").click();
  await expect(row(page, "Line one task")).toBeVisible();
  await expect(row(page, "Line two task").getByTestId("date-chip")).toHaveText("Tomorrow");
  // input box setting dialog
  await page.getByTestId("quick-add-input").click();
  await page.getByTestId("qa-more").click();
  await page.getByTestId("qa-menu").locator(".menu-item", { hasText: "Input Box Setting" }).click();
  await expect(page.getByTestId("quickadd-style")).toContainText("Simple");
  await expect(page.getByTestId("quickadd-style")).toContainText("Detailed");
});

test("settings: smart list visibility hides a sidebar row, time format changes chips, week start changes the picker", async ({ page }) => {
  await page.goto("/#q/today/tasks?modalType=settings&tabs=smart");
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await expect(page.getByTestId("settings-modal").locator(".set-label > span:first-child")).toHaveText(["All", "Today", "Tomorrow", "Next 7 Days", "Assigned to Me", "Inbox", "Summary", "Tags", "Filters", "Completed", "Won't Do", "Trash"]);
  await page.getByTestId("smart-tomorrow").click();
  expect(await page.locator(".popover").last().locator(".menu-label").allInnerTexts()).toEqual(["Show if not empty", "Show", "Hide"]);
  await page.locator(".popover").last().locator(".menu-item", { hasText: /^Show$/ }).click();
  await expect(page.getByTestId("side-tomorrow")).toBeVisible();
  await page.getByTestId("smart-tomorrow").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: /^Hide$/ }).click();
  await expect(page.getByTestId("side-tomorrow")).toHaveCount(0);
  await page.getByTestId("settings-tab-date").click();
  await page.getByTestId("set-time-format").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: "12 Hour" }).click();
  await page.getByTestId("set-week-start").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Monday" }).click();
  await page.keyboard.press("Escape");
  await expect(row(page, "Replace kitchen light bulbs").getByTestId("date-chip")).toHaveText("Today, 6:30 PM");
  await row(page, "Replace kitchen light bulbs").click();
  await page.getByTestId("detail-date").click();
  await expect(page.getByTestId("date-picker").locator(".dp-week span")).toHaveText(["M", "T", "W", "T", "F", "S", "S"]);
  await page.keyboard.press("Escape");
  await synced(page);
  const s = await api<Record<string, unknown>>("GET", "/api/v2/user/preferences/settings");
  expect(s.showMeridiem).toBe(true);
  expect(s.startDayOfWeek).toBe("MON");
  // appearance: picking a theme switches the document theme and is stored
  await page.goto("/#q/today/tasks?modalType=settings&tabs=appearance");
  await page.getByTestId("theme-sky").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "sky");
  await expect(page.locator("html")).toHaveAttribute("data-base", "light");
  await page.getByTestId("theme-night").click();
  await expect(page.locator("html")).toHaveAttribute("data-base", "dark");
  await synced(page);
  expect((await api<Record<string, unknown>>("GET", "/api/v2/user/preferences/settings")).theme).toBe("night");
  expect(await page.evaluate(() => localStorage.getItem("appTheme"))).toBe("night");
  // restore
  await page.goto("/#q/today/tasks?modalType=settings&tabs=date");
  await page.getByTestId("set-time-format").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: "24 Hour" }).click();
  await page.getByTestId("set-week-start").click();
  await page.locator(".popover").last().locator(".menu-item", { hasText: "Sunday" }).click();
  await synced(page);
});

test("subtasks, checklist conversion, slash menu, multi-select batch bar, drag onto a sidebar list", async ({ page }) => {
  const { id, inbox } = await newTask("Structure probe", { content: "first line\n- second line" });
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await page.getByTestId("subtask-add").fill("Child step");
  await page.getByTestId("subtask-add").press("Enter");
  await expect(page.getByTestId("subtasks")).toContainText("Child step");
  await expect(row(page, "Child step")).toBeVisible();
  await page.getByTestId("convert-checklist").click();
  await expect(page.getByTestId("checklist").locator(".check-title")).toHaveCount(3); // two items + add field
  await page.getByTestId("checklist-add").fill("third line");
  await page.getByTestId("checklist-add").press("Enter");
  await synced(page);
  const t = (await serverTask(id))!;
  expect(t.kind).toBe("CHECKLIST");
  expect((t.items as Array<{ title: string }>).map((i) => i.title)).toEqual(["first line", "second line", "third line"]);
  expect(t.childIds).toHaveLength(1);
  await page.getByTestId("convert-checklist").click();
  await page.getByTestId("detail-body-rendered").click();
  await page.getByTestId("detail-body").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-menu")).toContainText("Heading 1");
  await page.keyboard.press("Escape");
  // multi-select with ctrl-click
  await row(page, "Renew library card").click();
  await row(page, "Structure probe").click({ modifiers: ["Control"] });
  await expect(page.getByTestId("batch-bar")).toContainText("2 tasks selected");
  await page.keyboard.press("Escape");
  // drag a task onto a list in the sidebar moves it
  await page.keyboard.press("Escape");
  const src = row(page, "Structure probe").getByTestId("drag-handle");
  await row(page, "Structure probe").hover();
  const a = (await src.boundingBox())!;
  const b = (await page.getByTestId("side-list-Trip planning").boundingBox())!;
  await page.mouse.move(a.x + 5, a.y + 5);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + 20, { steps: 4 });
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByTestId("toast").last()).toContainText("Moved to Trip planning");
  await synced(page);
  const moved = (await serverTask(id))!;
  const child = (await serverTask((t.childIds as string[])[0]!))!;
  expect(moved.projectId).toBe(child.projectId); // subtasks travel with the parent
  expect(moved.projectId).not.toBe(inbox);
});

test("attachments: upload from the more menu, listed, stored on the server, still there after reload", async ({ page }) => {
  const { id, inbox } = await newTask("Attachment probe");
  await page.goto(`/#p/${inbox}/tasks/${id}`);
  await page.getByTestId("detail-more").click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("detail-more-menu").locator(".menu-item", { hasText: "Upload Attachment" }).click();
  await (await chooser).setFiles({ name: "packing-list.txt", mimeType: "text/plain", buffer: Buffer.from("socks\nshirts\n") });
  await expect(page.getByTestId("attachments")).toContainText("packing-list.txt");
  await synced(page);
  const t = (await serverTask(id))!;
  const atts = t.attachments as Array<{ fileName: string; size: number }>;
  expect(atts.map((a) => [a.fileName, a.size])).toEqual([["packing-list.txt", 13]]);
  await page.reload();
  await expect(page.getByTestId("attachments")).toContainText("packing-list.txt");
  await expect(page.getByTestId("attachments")).toContainText("1 KB");
  await expect(row(page, "Attachment probe").getByLabel("Attachment")).toBeVisible();
});
