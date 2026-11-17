import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { previewBackupCsv } from "../src/model/backupCsv";
import { api, inboxId, oid } from "./seed";

/**
 * M5 on synthetic data against the real server: reminders and the notification centre, push registration,
 * comments with images, attachments (paste, drop, preview), templates, advanced filters, activity, CSV backup
 * export and import into a fresh account. Sorts after zm4 on purpose (runs last).
 */
const API2 = process.env.NOORTASKS_API2 ?? "http://127.0.0.1:18733";
const WEB2 = process.env.NOORTASKS_WEB2 ?? "http://127.0.0.1:4274";
const step = 2 ** 40;
const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");

async function synced(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
  await expect(page.getByTestId("rail-sync").locator(".badge")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
}
type T = { id: string; title: string; projectId: string; status: number; priority?: number; tags?: string[]; deleted?: number; kind?: string; items?: Array<{ title: string; [k: string]: unknown }>; snoozeReminderTime?: string; annoyingAlert?: number; reminders?: Array<{ trigger: string; [k: string]: unknown }>; attachments?: Array<{ id: string; fileName: string }> };
const openTasks = async (base?: string): Promise<T[]> => {
  const r = base ? await (await fetch(`${base}/api/v3/batch/check/0`)).json() : await api<{ syncTaskBean: { update: T[] } }>("GET", "/api/v3/batch/check/0");
  return ((r as { syncTaskBean: { update: T[] } }).syncTaskBean.update ?? []).filter((t) => !t.deleted);
};
const task = async (id: string): Promise<T> => api<T>("GET", `/api/v2/task/${id}`);
async function addTask(p: Partial<T> & Record<string, unknown>): Promise<T> {
  const inbox = await inboxId();
  const t = { id: oid(), projectId: inbox, status: 0, kind: "TEXT", priority: 0, sortOrder: -step * 50, timeZone: "Europe/Amsterdam", isFloating: false, tags: [], items: [], reminders: [], exDate: [], content: "", ...p };
  await api("POST", "/api/v2/batch/task", { add: [t] });
  return t as unknown as T;
}
async function pngBytes(page: Page, label: string, color = "#3fa66b"): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([text, c]) => {
      const cv = document.createElement("canvas");
      cv.width = 320;
      cv.height = 200;
      const g = cv.getContext("2d")!;
      g.fillStyle = c!;
      g.fillRect(0, 0, 320, 200);
      g.fillStyle = "#fff";
      g.font = "bold 28px sans-serif";
      g.fillText(text!, 24, 110);
      return cv.toDataURL("image/png").split(",")[1]!;
    },
    [label, color],
  );
  return Buffer.from(b64, "base64");
}
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 52>>stream\nBT /F1 22 Tf 30 100 Td (Synthetic invoice) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);

test.describe.configure({ mode: "serial" });

test("reminders: picker presets, custom 15 minutes, constant switch (RMD-007..013, PREM-174)", async ({ page }) => {
  const t = await addTask({ title: "Reminder picker check" });
  await page.goto(`/#p/${t.projectId}/tasks/${t.id}`);
  await page.getByTestId("detail-date").click();
  await page.getByTestId("dp-today").click();
  await page.getByTestId("dp-reminder").click();
  const allDay = page.getByTestId("reminder-list").locator(".check-row");
  await expect(allDay).toHaveText(["On the day (09:00)", "1 day early (09:00)", "2 days early (09:00)", "3 days early (09:00)", "1 week early (09:00)"]);
  await expect(page.getByTestId("reminder-custom")).toBeVisible();
  await allDay.filter({ hasText: "On the day (09:00)" }).locator("input").check();
  await page.getByTestId("reminder-ok").click();
  // RMD-012: setting a time turns the all-day reminder into its timed twin
  await page.getByTestId("dp-time").click();
  await page.getByTestId("time-10:00").click();
  await page.getByTestId("dp-reminder").click();
  const timed = page.getByTestId("reminder-list").locator(".check-row");
  await expect(timed).toHaveText(["On time", "5 minutes early", "30 minutes early", "1 hour early", "1 day early"]);
  await expect(timed.filter({ hasText: "On time" }).locator("input")).toBeChecked();
  await expect(timed.filter({ hasText: "15 minutes" })).toHaveCount(0); // RMD-009
  await page.getByTestId("reminder-custom").click();
  await page.getByTestId("custom-m").fill("15");
  await page.getByTestId("custom-ok").click();
  await page.getByTestId("reminder-constant").click();
  await page.getByTestId("reminder-ok").click();
  await page.getByTestId("dp-ok").click();
  await expect(page.getByTestId("detail-reminder-chip")).toBeVisible();
  await synced(page);
  const s = await task(t.id);
  expect((s.reminders ?? []).map((r) => r.trigger).sort()).toEqual(["TRIGGER:-PT15M", "TRIGGER:PT0S"]);
  expect(s.annoyingAlert).toBe(-1);
  // RMD-013: the row shows the alarm icon
  await expect(page.locator(`[data-task-id="${t.id}"] [aria-label=Reminder]`)).toBeVisible();
  // a constant reminder at 10:00 today would keep firing through the rest of the file: complete it
  await api("POST", `/api/v2/project/${t.projectId}/task/${t.id}/complete`, {});
});

test("a reminder fires on time: in-app card, snooze reaches the server, notification centre entry, Got it closes (RMD-026, TASK-148, NTF-001, NTF-007)", async ({ page }) => {
  // real time, no fake clock: the server computes the instances with its own clock, so both must agree
  const fireAt = Date.now() + 12_000;
  const t = await addTask({ title: "Take the bread out", startDate: iso(fireAt), dueDate: iso(fireAt), isAllDay: false, reminders: [{ id: oid(), trigger: "TRIGGER:PT0S" }] });
  await page.goto("/#q/all/tasks");
  await synced(page);
  const card = page.getByTestId("reminder-card").filter({ hasText: "Take the bread out" });
  await expect(card).toHaveCount(0);
  await expect(card).toBeVisible({ timeout: 30_000 });
  expect(Date.now()).toBeGreaterThanOrEqual(fireAt - 1000);
  await expect(page.getByTestId("rail-bell").getByTestId("bell-badge")).toBeVisible();
  await card.getByTestId("reminder-snooze").click();
  await page.getByTestId("snooze-10").click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await task(t.id)).snoozeReminderTime ?? "", { timeout: 10_000 }).not.toBe("");
  const snoozed = Date.parse((await task(t.id)).snoozeReminderTime!.replace("+0000", "Z"));
  expect(Math.abs(snoozed - (Date.now() + 10 * 60_000))).toBeLessThan(30_000);
  expect(await page.evaluate(() => localStorage.getItem("recentSnoozeReminderMinutes"))).toBe("10");
  await expect(page.getByTestId("detail-snoozed")).toHaveCount(0);
  // the centre lists the firing and opens the task
  await page.getByTestId("rail-bell").click();
  const centre = page.getByTestId("notification-centre");
  await expect(centre.getByTestId("ntf-tab-notifications")).toBeVisible();
  await expect(centre.getByTestId("ntf-tab-activities")).toBeVisible();
  const row = centre.getByTestId("ntf-row").filter({ hasText: "Take the bread out" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Reminder at");
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${t.id}$`));
  await expect(page.getByTestId("detail-title")).toHaveValue("Take the bread out");
  await expect(page.getByTestId("detail-snoozed")).toBeVisible();
  // a second task: Got it closes the reminder on the server (closeRemind)
  const at2 = Date.now() + 8_000;
  const t2 = await addTask({ title: "Move the laundry", startDate: iso(at2), dueDate: iso(at2), isAllDay: false, reminders: [{ id: oid(), trigger: "TRIGGER:PT0S" }] });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  const card2 = page.getByTestId("reminder-card").filter({ hasText: "Move the laundry" });
  await expect(card2).toBeVisible({ timeout: 30_000 });
  const [close] = await Promise.all([page.waitForRequest((r) => r.url().endsWith("/api/v2/task/closeRemind")), card2.getByTestId("reminder-close").click()]);
  expect(close.postDataJSON()).toMatchObject({ taskId: t2.id });
  expect((await close.response())?.status()).toBe(200);
  await expect(card2).toHaveCount(0);
});

test("notification deep link and settings: n/notification/all, daily summary times, constant reminder (NTF-009, NTF-010, NTF-012, SET-125..129, SET-208)", async ({ page }) => {
  await page.goto("/#n/notification/all");
  await expect(page.getByTestId("notification-centre")).toBeVisible();
  await expect(page).not.toHaveURL(/#n\//);
  await page.keyboard.press("Escape");
  await page.goto("/#q/all/tasks?modalType=settings&tabs=notifications");
  const labels = page.locator(".settings-scroll .set-row .set-label > span:first-child");
  await expect(labels).toHaveText(["Daily Notifications", "Web Reminder", "Global Constant Reminder", "Email Notifications", "Email address"]);
  await page.getByTestId("set-daily-enable").click();
  await expect(page.getByTestId("daily-options")).toBeVisible();
  await page.getByTestId("daily-time-input").fill("08:00");
  await page.getByTestId("daily-time-add").click();
  await page.getByTestId("daily-time-input").fill("18:00");
  await page.getByTestId("daily-time-add").click();
  await page.getByTestId("daily-skip-weekends").click();
  await expect.poll(async () => (await api<{ enable: boolean; dailyReminders: string[]; weekDays: string[] }>("GET", "/api/v2/user/preferences/dailyReminder")).dailyReminders, { timeout: 8000 }).toEqual(["08:00", "09:00", "18:00"]);
  const dr = await api<{ enable: boolean; weekDays: string[] }>("GET", "/api/v2/user/preferences/dailyReminder");
  expect(dr.enable).toBe(true);
  expect(dr.weekDays).toEqual(["MO", "TU", "WE", "TH", "FR"]);
  await page.getByTestId("set-constant").click();
  await expect(page.getByTestId("constant-types")).toBeVisible();
  await page.getByTestId("constant-countdown").click();
  await synced(page);
  const ext = await api<{ reminder?: { annoyingAlertEnabled?: boolean; annoyingRemindItems?: string[] } }>("GET", "/api/v2/user/preferences/ext");
  expect(ext.reminder).toMatchObject({ annoyingAlertEnabled: true, annoyingRemindItems: ["task", "habit"] });
  // switch the global constant reminder off again for the rest of the file
  await page.getByTestId("set-constant").click();
  await synced(page);
});

test("Web Push: subscribing registers the subscription with the server (RMD-032, SET-126)", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  // headless Chromium has no push service and reports the granted permission as "denied": stand in for the
  // browser's permission getter and subscribe only, the app code runs as is
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    const fake = { endpoint: "https://127.0.0.1:9/push/e2e-device", expirationTime: null, keys: { p256dh: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U", auth: "tBHItJI5svbpez7KI4CCXg" } };
    const sub = { ...fake, toJSON: () => fake, unsubscribe: async () => true };
    PushManager.prototype.subscribe = async () => sub as unknown as PushSubscription;
    PushManager.prototype.getSubscription = async () => null;
  });
  await page.goto("/#q/all/tasks?modalType=settings&tabs=notifications");
  await expect(page.getByTestId("push-enable")).toBeVisible();
  const [req] = await Promise.all([page.waitForRequest((r) => r.url().endsWith("/api/v2/push/register") && r.method() === "POST"), page.getByTestId("push-enable").click()]);
  const res = await req.response();
  expect(res?.status()).toBe(200);
  const body = req.postDataJSON() as { pushToken: string; subscription: { endpoint: string } };
  expect(body.subscription.endpoint).toBe("https://127.0.0.1:9/push/e2e-device");
  expect(JSON.parse(body.pushToken).keys.auth).toBe("tBHItJI5svbpez7KI4CCXg");
  const rec = (await res!.json()) as { id: string; version: number };
  expect(rec.version).toBeGreaterThanOrEqual(1);
  expect(await api<{ publicKey: string | null }>("GET", "/api/v2/push/vapidPublicKey")).toMatchObject({ publicKey: expect.stringMatching(/^[A-Za-z0-9_-]{80,}$/) });
});

test("comments: write a comment with an image, it shows and reaches the server (TASK-116..120, ATT-025)", async ({ page }) => {
  const t = await addTask({ title: "Plan the garden beds" });
  await page.goto(`/#p/${t.projectId}/tasks/${t.id}`);
  const seen: string[] = [];
  page.on("request", (r) => r.url().includes("/comments") && seen.push(r.url()));
  await page.getByTestId("detail-comments").click();
  await expect(page.getByTestId("comment-input")).toBeVisible();
  await expect(page.getByTestId("comment-emoji")).toBeVisible();
  await expect(page.getByTestId("comment-image-btn")).toBeVisible();
  expect(seen).toEqual([]); // TASK-116: no request for a task without comments
  await page.getByTestId("comment-input").fill("Raised beds along the fence, see sketch");
  await page.getByTestId("comment-file").setInputFiles({ name: "sketch.png", mimeType: "image/png", buffer: await pngBytes(page, "Bed layout") });
  await expect(page.getByTestId("comment-pending-file")).toHaveText(/sketch\.png/);
  await page.getByTestId("comment-send").click();
  const c = page.getByTestId("comment");
  await expect(c).toHaveCount(1);
  await expect(c.getByTestId("comment-text")).toHaveText("Raised beds along the fence, see sketch");
  const img = c.getByTestId("comment-image");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(320);
  const list = await api<Array<{ text: string; attachments?: Array<{ fileName: string; fileType: string }> }>>("GET", `/api/v2/project/${t.projectId}/task/${t.id}/comments`);
  expect(list).toHaveLength(1);
  expect(list[0]!.attachments).toMatchObject([{ fileName: "sketch.png", fileType: "IMAGE" }]);
  await expect.poll(async () => ((await task(t.id)) as T & { commentCount?: number }).commentCount).toBe(1);
});

test("attachments: paste an image, drop a file, upload a PDF, preview and download (ATT-017, ATT-018, ATT-022, TASK-054)", async ({ page }) => {
  const t = await addTask({ title: "Receipts for the tax return" });
  await page.goto(`/#p/${t.projectId}/tasks/${t.id}`);
  await expect(page.getByTestId("detail-pane")).toBeVisible();
  // paste: a clipboard image becomes an attachment
  const b64 = (await pngBytes(page, "Pasted receipt", "#2f8fbf")).toString("base64");
  await page.getByTestId("detail-title").click();
  await page.evaluate((data) => {
    const bin = Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], "image.png", { type: "image/png" }));
    document.querySelector("[data-testid=detail-title]")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await expect(page.getByTestId("attachment")).toHaveCount(1);
  // drop: one attachment per file
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["Line one\nLine two\n"], "notes.txt", { type: "text/plain" }));
    const pane = document.querySelector("[data-testid=detail-pane]")!;
    for (const type of ["dragenter", "dragover", "drop"]) pane.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("attachment")).toHaveCount(2);
  // menu > Upload Attachment: a PDF
  await page.getByTestId("detail-more").click();
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("menu-upload").click()]);
  await chooser.setFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: PDF });
  await expect(page.getByTestId("attachment")).toHaveCount(3);
  await synced(page);
  await expect.poll(async () => ((await task(t.id)).attachments ?? []).length, { timeout: 15_000 }).toBe(3);
  const names = ((await task(t.id)).attachments ?? []).map((a) => a.fileName);
  expect(names[0]).toMatch(/^Pasted image .*\.png$/);
  expect(names.slice(1)).toEqual(["notes.txt", "invoice.pdf"]);
  // the row shows the paperclip (ATT-022)
  await expect(page.locator(`[data-task-id="${t.id}"] [aria-label=Attachment]`)).toBeVisible();
  // preview: the image at full size, then the PDF in a frame, with download
  await page.getByTestId("attachment").first().locator("img").click();
  const pv = page.getByTestId("attachment-preview");
  await expect(pv.getByTestId("preview-image")).toBeVisible();
  await expect.poll(() => pv.getByTestId("preview-image").evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(320);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(pv.getByTestId("preview-name")).toHaveText("invoice.pdf");
  await expect(pv.getByTestId("preview-pdf")).toHaveAttribute("data", /^blob:/);
  const [dl] = await Promise.all([page.waitForEvent("download"), pv.getByTestId("preview-download").click()]);
  expect(dl.suggestedFilename()).toBe("invoice.pdf");
  expect(readFileSync((await dl.path())!).subarray(0, 8).toString()).toBe("%PDF-1.4");
});

test("templates: save a task as a template, add a task from it, manage and search (TASK-056, TPL-006..013, QADD-008)", async ({ page }) => {
  const inbox = await inboxId();
  const src = await addTask({ title: "Bike service checklist", kind: "CHECKLIST", desc: "Before the spring rides", items: [{ id: oid(), title: "Pump tyres", status: 0, sortOrder: 0 }, { id: oid(), title: "Oil the chain", status: 0, sortOrder: step }] });
  await page.goto(`/#p/${inbox}/tasks/${src.id}`);
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-save-template").click();
  await expect(page.getByText("Saved as a task template")).toBeVisible();
  const tpls = await api<{ taskTemplates: Array<{ id: string; title: string; content: string }> }>("GET", "/api/v2/templates");
  expect(tpls.taskTemplates.find((x) => x.title === "Bike service checklist")?.content).toBe("Before the spring rides\n- [ ] Pump tyres\n- [ ] Oil the chain");
  // add from template in the add bar
  await page.goto(`/#p/${inbox}/tasks`);
  await page.getByTestId("quick-add-input").click();
  await page.getByTestId("qa-more").click();
  await page.getByTestId("qa-from-template").click();
  const picker = page.getByTestId("template-picker");
  await expect(picker).toContainText("Task Template");
  await expect(picker.getByTestId("template-option")).toHaveCount(tpls.taskTemplates.length);
  await picker.getByTestId("template-option").filter({ hasText: "Bike service checklist" }).click();
  await expect(page.getByTestId("detail-title")).toHaveValue("Bike service checklist");
  await expect(page.getByTestId("checklist").locator(".check-title")).toHaveCount(3); // two items plus the add row
  await synced(page);
  const made = (await openTasks()).filter((x) => x.title === "Bike service checklist" && x.id !== src.id);
  expect(made).toHaveLength(1);
  expect(made[0]!.kind).toBe("CHECKLIST");
  expect(made[0]!.items!.map((i) => i.title)).toEqual(["Pump tyres", "Oil the chain"]);
  // the manager in Settings > More: search, add, delete
  await page.goto(`/#p/${inbox}/tasks?modalType=settings&tabs=more`);
  const mgr = page.getByTestId("template-manager");
  await expect(mgr.getByTestId("template-row")).toHaveCount(tpls.taskTemplates.length);
  await mgr.getByTestId("template-search").fill("bike");
  await expect(mgr.getByTestId("template-row")).toHaveCount(1);
  await mgr.getByTestId("template-search").fill("");
  await mgr.getByTestId("template-add").click();
  await mgr.getByTestId("template-title").fill("Weekly review");
  await mgr.getByTestId("template-content").fill("- [ ] Inbox zero\n- [ ] Plan next week");
  await mgr.getByTestId("template-save").click();
  await expect(mgr.getByTestId("template-row").filter({ hasText: "Weekly review" })).toBeVisible();
  await mgr.getByTestId("tpl-kind-note").click();
  await expect(mgr.getByTestId("template-row")).toHaveCount(3); // seeded note templates (TPL-004)
});

test("list template gallery: preview and Use Template (TPL-020, TPL-021, LIST-032)", async ({ page }) => {
  await page.goto("/#q/all/tasks");
  await page.getByTestId("add-list").click();
  await page.getByTestId("list-from-template").click();
  const g = page.getByTestId("template-gallery");
  await expect(g.getByTestId("gallery-card")).toHaveCount(3);
  await g.getByTestId("gallery-search").fill("sprint");
  await expect(g.getByTestId("gallery-card")).toHaveCount(1);
  await g.getByTestId("gallery-card").click();
  await expect(g.getByTestId("gallery-preview")).toContainText("tasks");
  await g.getByTestId("gallery-use").click();
  await expect(page.getByTestId("side-list-Sprint Board")).toBeVisible();
  await expect(page).toHaveURL(/#p\/[0-9a-f]{24}\//);
});

test("advanced filter: AND/OR/NOT builder with live preview, saved filter view shows the right tasks (FILT-001..019, SMART-049)", async ({ page }) => {
  await addTask({ title: "Filter probe high weekend", priority: 5, tags: ["weekend"] });
  await addTask({ title: "Filter probe high plain", priority: 5 });
  await addTask({ title: "Filter probe low weekend", priority: 1, tags: ["weekend"] });
  await page.goto("/#q/all/tasks");
  await expect(page.getByTestId("filters-empty")).toHaveText("Display tasks filtered by list, date, priority, tag, and more");
  await page.getByTestId("add-filter").click();
  const ed = page.getByTestId("filter-editor");
  await expect(ed.getByTestId("filter-tab-normal")).toBeVisible();
  await expect(ed.getByTestId("filter-tab-advanced")).toBeVisible();
  await ed.getByTestId("filter-name").fill("Hot or weekend");
  await ed.getByTestId("filter-tab-advanced").click();
  await ed.getByTestId("flt-group-r-or").click();
  await ed.getByTestId("flt-cond-r-0-name").selectOption("priority");
  await ed.getByTestId("flt-cond-r-0-values").click();
  await page.getByTestId("flt-cond-r-0-values-menu").locator(".check-row", { hasText: "High" }).locator("input").check();
  await page.keyboard.press("Escape");
  await ed.getByTestId("flt-cond-r-1-name").selectOption("tag");
  await ed.getByTestId("flt-cond-r-1-values").click();
  await page.getByTestId("flt-cond-r-1-values-menu").locator(".check-row", { hasText: "weekend" }).locator("input").check();
  await page.keyboard.press("Escape");
  await ed.getByTestId("flt-cond-r-2").getByRole("button", { name: "Remove condition" }).click();
  const all = await openTasks();
  const want = (fn: (t: T) => boolean) => all.filter((t) => t.status === 0 && fn(t)).map((t) => t.title).sort();
  const orWant = want((t) => t.priority === 5 || (t.tags ?? []).includes("weekend"));
  await expect(ed.getByTestId("filter-preview-count")).toHaveText(`${orWant.length} tasks`);
  // AND narrows the preview live
  await ed.getByTestId("flt-group-r-and").click();
  const andWant = want((t) => t.priority === 5 && (t.tags ?? []).includes("weekend"));
  await expect(ed.getByTestId("filter-preview-count")).toHaveText(`${andWant.length} ${andWant.length === 1 ? "task" : "tasks"}`);
  // OR again, then a nested NOT group: (High OR weekend) AND NOT (Low)
  await ed.getByTestId("flt-group-r-or").click();
  await ed.getByTestId("flt-group-r-addgroup").click();
  await ed.getByTestId("flt-group-r-2-not").check();
  await ed.getByTestId("flt-cond-r-2-0-name").selectOption("priority");
  await ed.getByTestId("flt-cond-r-2-0-values").click();
  await page.getByTestId("flt-cond-r-2-0-values-menu").locator(".check-row", { hasText: "Low" }).locator("input").check();
  await page.keyboard.press("Escape");
  // the root is OR, so: High OR weekend OR NOT(Low): back to AND for the intended rule
  await ed.getByTestId("flt-group-r-and").click();
  const finalWant = want((t) => t.priority === 5 && (t.tags ?? []).includes("weekend")); // NOT (Low) cannot drop a High task
  await expect(ed.getByTestId("filter-preview-count")).toHaveText(`${finalWant.length} ${finalWant.length === 1 ? "task" : "tasks"}`);
  await expect(ed.getByTestId("filter-preview-row").filter({ hasText: "Filter probe high weekend" })).toBeVisible();
  await ed.getByTestId("filter-save").click();
  await expect(page).toHaveURL(/#f\/[0-9a-f]{24}\/tasks$/);
  await expect(page.getByTestId("side-filter-Hot or weekend")).toBeVisible();
  await expect(page.locator("[data-task-id]")).toHaveCount(finalWant.length);
  await synced(page);
  const check = await api<{ filters: Array<{ id: string; name: string; rule: string }> | null }>("GET", "/api/v3/batch/check/0");
  const f = check.filters!.find((x) => x.name === "Hot or weekend")!;
  expect(JSON.parse(f.rule)).toMatchObject({ and: [{ conditionName: "priority", or: [5] }, { conditionName: "tag", or: ["weekend"] }, { not: [{ conditionName: "priority", or: [1] }] }], version: 1 });
  // FILT-015: a task added here gets the filter's priority and tag
  await page.getByTestId("quick-add-input").fill("Filter probe added in view");
  await page.getByTestId("quick-add-input").press("Enter");
  await expect(page.locator("[data-task-id]")).toHaveCount(finalWant.length + 1);
  await synced(page);
  const added = (await openTasks()).find((x) => x.title === "Filter probe added in view")!;
  expect(added.priority).toBe(5);
  expect(added.tags).toEqual(["weekend"]);
  // kanban keeps the filter (FILT-013); edit, duplicate, delete from the sidebar menu (FILT-014)
  await page.getByTestId("list-more").click();
  await page.getByTestId("view-mode-kanban").click();
  await expect(page).toHaveURL(/#f\/[0-9a-f]{24}\/kanban$/);
  await expect(page.locator("[data-task-id]")).toHaveCount(finalWant.length + 1);
  await page.getByTestId("side-filter-Hot or weekend").hover();
  await page.getByTestId("side-filter-Hot or weekend").getByRole("button", { name: "More" }).click();
  await page.getByTestId("filter-menu-duplicate").click();
  await expect(page.getByTestId("side-filter-Hot or weekend copy")).toBeVisible();
  await page.getByTestId("side-filter-Hot or weekend copy").hover();
  await page.getByTestId("side-filter-Hot or weekend copy").getByRole("button", { name: "More" }).click();
  await page.getByTestId("filter-menu-delete").click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("side-filter-Hot or weekend copy")).toHaveCount(0);
});

test("search: save the criteria as a filter, search lists saved filters (FILT-019, SRCH-004, SRCH-010)", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => seen.push(r.url()));
  await page.goto("/#q/all/tasks");
  await page.getByTestId("rail-search").click();
  await expect.poll(() => seen.some((u) => u.includes("/api/v2/projectTemplates/all?timestamp=0"))).toBe(true);
  await page.getByTestId("search-input").fill("probe");
  await page.getByTestId("search-facet-tag").selectOption("weekend");
  await page.getByTestId("search-facet-priority").selectOption("1");
  await expect(page.getByTestId("search-hit")).toHaveCount(1);
  await page.getByTestId("search-save-filter").click();
  const ed = page.getByTestId("filter-editor");
  await expect(ed.getByTestId("filter-preview-row")).toHaveText([/Filter probe low weekend/]);
  await ed.getByTestId("filter-name").fill("Low weekend probes");
  await ed.getByTestId("filter-save").click();
  await expect(page.getByTestId("side-filter-Low weekend probes")).toBeVisible();
  await page.getByTestId("rail-search").click();
  await page.getByTestId("search-input").fill("weekend probes");
  await expect(page.getByTestId("search-filter-hit")).toHaveText(["Low weekend probes"]);
});

test("activity: an edit shows in Task Activities and List Activities (TASK-055, TASK-121, TASK-122, PREM-172)", async ({ page }) => {
  const t = await addTask({ title: "Draft the newsletter" });
  await page.goto(`/#p/${t.projectId}/tasks/${t.id}`);
  const title = page.getByTestId("detail-title");
  await title.fill("Draft the spring newsletter");
  await title.press("Enter");
  await page.getByTestId("detail-priority").click();
  await page.getByTestId("priority-high").click();
  await synced(page);
  await page.getByTestId("detail-more").click();
  await page.getByTestId("menu-activity").click();
  const dlg = page.getByTestId("activity-dialog");
  await expect(dlg.getByTestId("activity-row").filter({ hasText: 'Renamed from "Draft the newsletter" to "Draft the spring newsletter"' })).toBeVisible();
  await expect(dlg.getByTestId("activity-row").filter({ hasText: "Changed priority from None to High" })).toBeVisible();
  await expect(dlg.getByTestId("activity-row").filter({ hasText: "Created the task" })).toBeVisible();
  await page.keyboard.press("Escape");
  // list activity aggregates the list's tasks (Home projects is a seeded list)
  const lists = await api<{ projectProfiles: Array<{ id: string; name: string }> }>("GET", "/api/v3/batch/check/0");
  const home = lists.projectProfiles.find((p) => p.name === "Home projects")!;
  const other = await addTask({ title: "Sand the bench", projectId: home.id });
  await page.goto(`/#p/${home.id}/tasks/${other.id}`);
  await page.getByTestId("detail-title").fill("Sand and oil the bench");
  await page.getByTestId("detail-title").press("Enter");
  await synced(page);
  await page.getByTestId("list-more").click();
  await page.getByTestId("list-activities").click();
  const la = page.getByTestId("activity-dialog");
  await expect(la).toContainText("List Activities");
  await expect(la.getByTestId("activity-row").filter({ hasText: "Sand and oil the bench" }).first()).toBeVisible();
});

test("backup: Generate Backup downloads the CSV, Import Backups previews and restores it into a fresh account with equal counts (IMP-013..020, IMP-033, ACC-035)", async ({ page, browser }) => {
  await page.goto("/#q/all/tasks?modalType=settings&tabs=profile");
  await expect(page.getByTestId("generate-backup")).toBeVisible();
  await expect(page.getByTestId("import-backups")).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("generate-backup").click()]);
  expect(dl.suggestedFilename()).toMatch(/^NoorTasks-backup-\d{8}\.csv$/);
  const file = (await dl.path())!;
  const csv = readFileSync(file, "utf8");
  const exported = previewBackupCsv(csv);
  expect(exported.headers).toHaveLength(23);
  const before = await openTasks();
  expect(exported.counts.open).toBe(before.filter((t) => t.status === 0).length);

  // a fresh account: the second server behind its own preview (new origin, empty IndexedDB)
  const ctx2 = await browser.newContext({ baseURL: WEB2, viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Amsterdam", locale: "en-US" });
  const p2 = await ctx2.newPage();
  const fresh = await openTasks(API2);
  expect(fresh).toHaveLength(0);
  await p2.goto("/#q/all/tasks?modalType=settings&tabs=profile");
  await p2.getByTestId("import-backups").click();
  await p2.getByTestId("import-file").setInputFiles(file);
  const pv = p2.getByTestId("import-preview");
  await expect(pv.getByTestId("import-count-tasks").locator(".imp-num")).toHaveText(String(exported.counts.tasks));
  await expect(pv.getByTestId("import-count-completed").locator(".imp-num")).toHaveText(String(exported.counts.completed));
  await expect(pv.getByTestId("import-count-lists").locator(".imp-num")).toHaveText(String(exported.counts.lists));
  await p2.getByTestId("import-run").click();
  const res = p2.getByTestId("import-result");
  await expect(res.getByTestId("import-result-imported").locator(".imp-num")).toHaveText(String(exported.counts.tasks), { timeout: 20_000 });
  await expect(res.getByTestId("import-result-skipped").locator(".imp-num")).toHaveText("0");
  // compare by status and by list through the second server's own export
  const v = (await (await fetch(`${API2}/api/v2/user/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as { verifyId: string };
  const back = previewBackupCsv(await (await fetch(`${API2}/api/v2/data/export`, { headers: { "x-verify-id": v.verifyId } })).text());
  expect(back.counts).toEqual(exported.counts);
  expect(back.lists.sort()).toEqual(exported.lists.sort());
  // the fresh account's app shows the restored open tasks
  await p2.getByRole("button", { name: "Done" }).click();
  await p2.goto("/#q/all/tasks");
  await expect.poll(async () => p2.locator("[data-task-id]").count(), { timeout: 15_000 }).toBeGreaterThan(5);
  await ctx2.close();
});

test("integrations tab: six importers listed, habit and focus export download (SET-169, INTG-004, HAB-028)", async ({ page }) => {
  await page.goto("/#q/all/tasks?modalType=settings&tabs=integrations");
  const rows = page.getByTestId("import-entries").locator(".int-name");
  await expect(rows).toHaveText(["Todoist", "Microsoft Todo", "Things", "OmniFocus", "Toodledo", "iCal"]);
  const [h] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-habits-csv").click()]);
  expect(h.suggestedFilename()).toMatch(/^NoorTasks-habits-\d{8}\.csv$/);
  expect(readFileSync((await h.path())!, "utf8").split("\n")[0]).toMatch(/Habit/i);
  const [f] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-focus-csv").click()]);
  expect(f.suggestedFilename()).toMatch(/^NoorTasks-focus-\d{8}\.csv$/);
  const [x] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-habits-xlsx").click()]);
  expect(readFileSync((await x.path())!).subarray(0, 2).toString()).toBe("PK");
});

test("settings extras: holidays store, habit constant reminder, a filter keeps its own sort (RPT-061, SET-230, FILT-018)", async ({ page }) => {
  await page.goto("/#q/all/tasks?modalType=settings&tabs=date");
  const add = page.getByTestId("holidays-add");
  await add.locator("input[type=date]").fill("2026-12-25");
  await add.getByRole("button", { name: "Add" }).click();
  await add.locator("select").selectOption("workDays");
  await add.locator("input[type=date]").fill("2026-12-27");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(page.getByTestId("holidays-list")).toContainText("2026-12-25");
  await expect.poll(() => api("GET", "/api/v2/holidays")).toEqual({ restDays: ["2026-12-25"], workDays: ["2026-12-27"] });
  await page.getByTestId("settings-tab-habit").click();
  await page.getByTestId("set-habit-constant").click();
  await synced(page);
  expect((await api<{ reminder?: { annoyingAlertEnabled?: boolean; annoyingRemindItems?: string[] } }>("GET", "/api/v2/user/preferences/ext")).reminder).toMatchObject({ annoyingAlertEnabled: true, annoyingRemindItems: ["habit"] });
  await page.getByTestId("set-habit-constant").click();
  await synced(page);
  // FILT-018: Sort by on a filter view is stored on the filter
  const f = (await api<{ filters: Array<{ id: string; name: string }> }>("GET", "/api/v3/batch/check/0")).filters.find((x) => x.name === "Hot or weekend")!;
  await page.goto(`/#f/${f.id}/tasks`);
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("sort-by").click();
  await page.getByTestId("sort-title").click();
  await synced(page);
  const after = (await api<{ filters: Array<{ id: string; sortOption?: { orderBy?: string }; sortType?: string }> }>("GET", "/api/v3/batch/check/0")).filters.find((x) => x.id === f.id)!;
  expect(after.sortOption?.orderBy).toBe("title");
  await page.reload();
  await page.getByTestId("sort-menu").click();
  await page.getByTestId("sort-by").click();
  await expect(page.getByTestId("sort-title").locator(".menu-check")).toBeVisible();
});

test("rest of the M5 rows: print paths, default reminders and Reset Default, note template, comment edit and delete, attachment remove, email address (VIEW-034, LIST-040, SMART-037, RMD-018, RMD-021, TPL-007, TASK-117, ATT-023, NTF-015)", async ({ page }) => {
  const inbox = await inboxId();
  // print: Ctrl+P on a list, the list menu submenu, the Completed header icon
  await page.goto(`/#p/${inbox}/tasks`);
  await expect(page.locator("[data-task-id]").first()).toBeVisible();
  const titles = await page.locator("[data-task-id] .task-title").allInnerTexts();
  await page.keyboard.press("Control+p");
  await expect(page.getByTestId("print-dialog")).toBeVisible();
  for (const t of titles.slice(0, 5)) await expect(page.getByTestId("print-dialog")).toContainText(t);
  await page.keyboard.press("Escape");
  await page.getByTestId("list-more").click();
  await page.getByTestId("list-more-menu").getByText("Print", { exact: true }).click();
  await expect(page.locator(".popover .menu-label")).toContainText(["Title only", "Title and details"]);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.goto("/#q/all/completed");
  await page.getByTestId("completed-screen").getByRole("button", { name: "Print" }).click();
  await expect(page.getByTestId("print-dialog")).toContainText("Completed");
  await page.keyboard.press("Escape");
  // RMD-018 options and RMD-021 Reset Default
  await page.goto("/#q/all/tasks?modalType=settings&tabs=more");
  const row = page.locator(".set-row", { hasText: "Default Reminders (Due time task)" });
  await row.locator(".select").click();
  await expect(page.locator(".popover .menu-label")).toHaveText(["On time", "5 minutes early", "30 minutes early", "1 hour early", "1 day early", "At end time"]);
  // several reminders can be ticked; OK stores them (On time was the default, untick it)
  await page.locator(".popover .menu-item", { hasText: "On time" }).click();
  await page.locator(".popover .menu-item", { hasText: "30 minutes early" }).click();
  await page.getByTestId("default-reminds-ok").click();
  await synced(page);
  expect((await api<{ defaultReminds: string[] }>("GET", "/api/v2/user/preferences/settings")).defaultReminds).toEqual(["TRIGGER:-PT30M"]);
  await expect(row.locator(".select")).toHaveText("30 minutes early");
  await page.getByTestId("task-defaults-reset").click();
  await synced(page);
  expect((await api<{ defaultReminds: string[] }>("GET", "/api/v2/user/preferences/settings")).defaultReminds).toEqual(["TRIGGER:PT0S"]);
  // TPL-007: a note template from the manager
  const mgr = page.getByTestId("template-manager");
  await mgr.getByTestId("tpl-kind-note").click();
  await mgr.getByTestId("template-add").click();
  await mgr.getByTestId("template-title").fill("Meeting notes");
  await mgr.getByTestId("template-content").fill("## Attendees\n\n## Decisions");
  await mgr.getByTestId("template-save").click();
  await expect(mgr.getByTestId("template-row").filter({ hasText: "Meeting notes" })).toBeVisible();
  expect((await api<{ noteTemplates: Array<{ title: string; content: string; order?: number }> }>("GET", "/api/v2/templates")).noteTemplates.find((t) => t.title === "Meeting notes")).toMatchObject({ content: "## Attendees\n\n## Decisions" });
  // NTF-015: the email address row saves
  await page.getByTestId("settings-tab-notifications").click();
  await page.getByTestId("set-email-address").fill("me@example.org");
  await page.getByTestId("set-email-address").blur();
  await synced(page);
  expect((await api<{ general_conf?: { notificationEmail?: string } }>("GET", "/api/v2/user/preferences/ext")).general_conf?.notificationEmail).toBe("me@example.org");
  // TASK-117 edit and delete, ATT-023 remove
  const t = await addTask({ title: "Comment edit probe" });
  await page.goto(`/#p/${t.projectId}/tasks/${t.id}`);
  await page.getByTestId("detail-comments").click();
  await page.getByTestId("comment-input").fill("First thought");
  await page.getByTestId("comment-input").press("Enter");
  await expect(page.getByTestId("comment-text")).toHaveText("First thought");
  await page.getByTestId("comment").hover();
  await page.getByRole("button", { name: "Edit comment" }).click();
  await page.locator(".cmt textarea").fill("Second thought");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("comment-text")).toHaveText("Second thought");
  expect((await api<Array<{ text: string }>>("GET", `/api/v2/project/${t.projectId}/task/${t.id}/comments`))[0]!.text).toBe("Second thought");
  await page.getByTestId("comment").hover();
  await page.getByTestId("comment-delete").click();
  await expect(page.getByTestId("comment")).toHaveCount(0);
  expect(await api<unknown[]>("GET", `/api/v2/project/${t.projectId}/task/${t.id}/comments`)).toEqual([]);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["to be removed"], "remove-me.txt", { type: "text/plain" }));
    const pane = document.querySelector("[data-testid=detail-pane]")!;
    for (const type of ["dragenter", "dragover", "drop"]) pane.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await synced(page);
  await expect.poll(async () => ((await task(t.id)).attachments ?? []).length).toBe(1);
  await page.getByTestId("attachment").hover();
  await page.getByTestId("attachment").getByRole("button", { name: "Remove attachment" }).click();
  await expect(page.getByTestId("attachment")).toHaveCount(0);
  await synced(page);
  await expect.poll(async () => ((await task(t.id)).attachments ?? []).length).toBe(0);
});
