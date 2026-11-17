import { chromium, expect, test, type Page } from "@playwright/test";
import { api, inboxId, oid } from "./seed";

/** M5 visual check screenshots on synthetic data. Opt-in: SCREENS=1 npx playwright test e2e/zm5-screens.spec.ts */
test.skip(!process.env.SCREENS, "screenshots only on request");

const API = process.env.NOORTASKS_API ?? "http://127.0.0.1:18731";
const out = (n: string): string => `screens/${n}.png`;
const step = 2 ** 40;
const iso = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
const day = (d: number, h = 0, m = 0): number => {
  const x = new Date();
  x.setHours(h, m, 0, 0);
  x.setDate(x.getDate() + d);
  return x.getTime();
};
let detailTask = { id: "", projectId: "" };
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 420 297]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 96>>stream\nBT /F1 20 Tf 40 220 Td (Tiler quote, synthetic) Tj 0 -40 Td /F1 14 Tf (Wall and floor tiles: 1 240 EUR) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
let homeId = "";

async function upload(projectId: string, taskId: string, name: string, type: string, bytes: Buffer, comment = false): Promise<Record<string, unknown>> {
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array(bytes)], { type }), name);
  const path = comment ? `/api/v1/attachment/upload/comment/${projectId}/${taskId}` : `/api/v1/attachment/upload/${projectId}/${taskId}/${oid()}`;
  const r = await fetch(API + path, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`upload ${r.status} ${await r.text()}`);
  return (await r.json()) as Record<string, unknown>;
}

/** A small synthetic picture drawn as an SVG-free PPM-to-PNG would need a codec; Chromium draws it instead. */
async function picture(page: Page, label: string, a: string, b: string): Promise<Buffer> {
  const b64 = await page.evaluate(
    ([t, c1, c2]) => {
      const cv = document.createElement("canvas");
      cv.width = 640;
      cv.height = 420;
      const g = cv.getContext("2d")!;
      const grd = g.createLinearGradient(0, 0, 640, 420);
      grd.addColorStop(0, c1!);
      grd.addColorStop(1, c2!);
      g.fillStyle = grd;
      g.fillRect(0, 0, 640, 420);
      g.fillStyle = "rgba(255,255,255,.85)";
      for (let i = 0; i < 5; i++) g.fillRect(48, 70 + i * 54, 380 - i * 40, 22);
      g.font = "600 34px sans-serif";
      g.fillText(t!, 48, 380);
      return cv.toDataURL("image/png").split(",")[1]!;
    },
    [label, a, b],
  );
  return Buffer.from(b64, "base64");
}

test.beforeAll(async () => {
  const inbox = await inboxId();
  const check = await api<{ projectProfiles: Array<{ id: string; name: string }> }>("GET", "/api/v3/batch/check/0");
  homeId = check.projectProfiles.find((p) => p.name === "Home projects")!.id;
  const T = (p: Record<string, unknown>) => ({ id: oid(), projectId: homeId, status: 0, kind: "TEXT", priority: 0, sortOrder: -step * 20, timeZone: "Europe/Amsterdam", isFloating: false, tags: [], items: [], reminders: [], exDate: [], content: "", ...p });
  const main = T({ title: "Renovate the bathroom", priority: 3, content: "Quotes from two tilers, then pick the grout colour.\n\n- measure the floor\n- check the extractor fan", startDate: iso(day(2)), dueDate: iso(day(2)), isAllDay: true, tags: ["errands"], reminders: [{ id: oid(), trigger: "TRIGGER:P0DT9H0M0S" }] });
  detailTask = { id: main.id as string, projectId: homeId };
  await api("POST", "/api/v2/batch/task", {
    add: [
      main,
      T({ title: "Weekend market run", priority: 5, tags: ["weekend", "errands"], startDate: iso(day(5)), dueDate: iso(day(5)), isAllDay: true }),
      T({ title: "Fix the bike brakes", priority: 5, tags: ["weekend"] }),
      T({ title: "Replace the smoke alarm battery", priority: 5, startDate: iso(day(-1)), dueDate: iso(day(-1)), isAllDay: true, tags: ["weekend"] }),
      T({ projectId: inbox, title: "Book the boiler service", priority: 1, tags: ["weekend"] }),
    ],
  });
  await api("POST", "/api/v2/batch/filter", {
    add: [
      { id: oid(), name: "Urgent errands", rule: JSON.stringify({ and: [{ conditionName: "priority", conditionType: 1, or: [5, 3] }, { conditionName: "tag", conditionType: 1, or: ["errands", "weekend"] }], type: 0, version: 1 }), sortOrder: 0, viewMode: "list", sortType: "project" },
      { id: oid(), name: "This week, not low", rule: JSON.stringify({ and: [{ conditionName: "dueDate", conditionType: 1, or: ["thisweek", "overdue"] }, { not: [{ conditionName: "priority", conditionType: 1, or: [1] }] }], type: 1, version: 1 }), sortOrder: step, viewMode: "list", sortType: "project" },
    ],
  });
});

async function go(page: Page, path: string, ready: string): Promise<void> {
  // a full load each time: the phone drawer and popovers start closed
  await page.goto("about:blank");
  await page.goto(`/#${path}`);
  await expect(page.getByTestId(ready).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(700);
}

test("seed pictures, comments and attachments", async ({ page }) => {
  await page.goto("/#q/all/tasks");
  const { id, projectId } = detailTask;
  await upload(projectId, id, "tile-samples.png", "image/png", await picture(page, "Tile samples", "#4f7ac7", "#86b7e8"));
  await upload(projectId, id, "floor-plan.png", "image/png", await picture(page, "Floor plan", "#3f8f6b", "#9fd6b4"));
  await upload(projectId, id, "quote-tiler.pdf", "application/pdf", PDF);
  const img = await upload(projectId, id, "grout.png", "image/png", await picture(page, "Grout", "#a35bd6", "#d7b4ef"), true);
  await api("POST", `/api/v2/project/${projectId}/task/${id}/comment`, { id: oid(), text: "Second tiler can start on the 20th. **Cheaper** by a fair bit." });
  await api("POST", `/api/v2/project/${projectId}/task/${id}/comment`, { id: oid(), text: "Grout colour options from the shop:", attachments: [img] });
  await api("POST", "/api/v2/templates/task", { title: "Bathroom checklist", content: "Before the tiler arrives\n- [ ] Clear the room\n- [ ] Turn off the water\n- [ ] Cover the floor" });
});

for (const [prefix, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`${prefix} M5 screens`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    const phone = prefix === "phone";
    const { id, projectId } = detailTask;

    // reminders firing, then the notification centre
    const soon = Date.now() + 4000;
    const inbox = await inboxId();
    await api("POST", "/api/v2/batch/task", {
      add: ["Call the plumber back", "Water the balcony plants"].map((title, i) => ({ id: oid(), projectId: i ? homeId : inbox, title, status: 0, kind: "TEXT", priority: i ? 0 : 3, sortOrder: -step * 30, timeZone: "Europe/Amsterdam", isFloating: false, isAllDay: false, startDate: iso(soon + i * 1500), dueDate: iso(soon + i * 1500), reminders: [{ id: oid(), trigger: "TRIGGER:PT0S" }], tags: [], items: [], exDate: [] })),
    });
    await go(page, "q/today/tasks", phone ? "mobile-menu" : "sidebar");
    await expect(page.getByTestId("reminder-card")).toHaveCount(2, { timeout: 30_000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: out(`${prefix}-reminder-cards`) });
    while ((await page.getByTestId("reminder-close").count()) > 0) await page.getByTestId("reminder-close").first().click();
    if (phone) {
      await page.getByTestId("mobile-menu").click();
      await page.getByTestId("drawer-bell").click();
    } else await page.getByTestId("rail-bell").click();
    await expect(page.getByTestId("ntf-row").first()).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${prefix}-notification-centre`) });
    await page.keyboard.press("Escape");

    // date picker reminder list with the Constant Reminder switch
    await go(page, `p/${projectId}/tasks/${id}`, "detail-title");
    await page.getByTestId("detail-date").click();
    await page.getByTestId("dp-reminder").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${prefix}-reminder-picker`) });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    // task detail: attachments grid and comments
    await go(page, `p/${projectId}/tasks/${id}`, "attachments");
    await page.getByTestId("detail-comments").click();
    await expect(page.getByTestId("comment")).toHaveCount(2);
    await page.waitForTimeout(800);
    await page.screenshot({ path: out(`${prefix}-task-attachments-comments`) });
    await page.getByTestId("attachment").first().locator("img").click();
    await expect(page.getByTestId("preview-image")).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: out(`${prefix}-attachment-preview`) });
    await page.keyboard.press("Escape");

    // task activity
    await page.getByTestId("detail-more").click();
    await page.getByTestId("menu-activity").click();
    await expect(page.getByTestId("activity-row").first()).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-task-activity`) });
    await page.keyboard.press("Escape");

    // add from template
    await go(page, `p/${projectId}/tasks`, "quick-add-input");
    await page.getByTestId("quick-add-input").click();
    await page.getByTestId("qa-more").click();
    await page.getByTestId("qa-from-template").click();
    await expect(page.getByTestId("template-option").first()).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-template-picker`) });
    await page.keyboard.press("Escape");

    // filters: sidebar, a filter view, the editor
    const filters = await api<{ filters: Array<{ id: string; name: string }> }>("GET", "/api/v3/batch/check/0");
    const urgent = filters.filters.find((f) => f.name === "Urgent errands")!;
    await go(page, `f/${urgent.id}/tasks`, "quick-add-input");
    await page.screenshot({ path: out(`${prefix}-filter-view`) });
    if (phone) {
      await page.getByTestId("mobile-menu").click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: out(`${prefix}-filters-sidebar`) });
    }
    if (!phone) {
      await page.getByTestId("side-filter-This week, not low").hover();
      await page.getByTestId("side-filter-This week, not low").getByRole("button", { name: "More" }).click();
    } else {
      await page.getByTestId("side-filter-This week, not low").hover();
      await page.getByTestId("side-filter-This week, not low").getByRole("button", { name: "More" }).click();
    }
    await page.getByTestId("filter-menu-edit").click();
    await expect(page.getByTestId("filter-preview-row").first()).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${prefix}-filter-editor-advanced`) });
    await page.getByTestId("filter-editor").getByRole("button", { name: "Cancel" }).click();
    if (phone) await page.keyboard.press("Escape");
    await go(page, "q/all/tasks", "quick-add-input");
    await page.getByTestId(phone ? "mobile-menu" : "add-filter").click();
    if (phone) {
      await page.waitForTimeout(500);
      await page.getByTestId("filters-head").hover();
      await page.getByTestId("add-filter").click({ force: true });
    }
    await expect(page.getByTestId("filter-normal")).toBeVisible();
    await page.getByTestId("flt-cond-n2-values").click();
    await page.getByTestId("flt-cond-n2-values-menu").locator(".check-row", { hasText: "High" }).locator("input").check();
    await page.keyboard.press("Escape");
    await page.getByTestId("filter-name").fill("High priority");
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${prefix}-filter-editor-normal`) });
    await page.keyboard.press("Escape");

    // search with facets and Save as Filter
    await go(page, "q/all/tasks", "quick-add-input");
    if (phone) await page.keyboard.press("/");
    else await page.getByTestId("rail-search").click();
    await page.getByTestId("search-input").fill("the");
    await page.getByTestId("search-facet-tag").selectOption("weekend");
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${prefix}-search-facets`) });
    await page.keyboard.press("Escape");

    // settings: notifications, templates manager, integrations, account backup
    await go(page, "q/all/tasks?modalType=settings&tabs=notifications", "set-daily-enable");
    await page.screenshot({ path: out(`${prefix}-settings-notifications`) });
    if (!(await page.getByTestId("daily-options").isVisible())) await page.getByTestId("set-daily-enable").click();
    await page.getByTestId("daily-time-input").fill("18:30");
    await page.getByTestId("daily-time-add").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: out(`${prefix}-settings-daily`) });
    await go(page, "q/all/tasks?modalType=settings&tabs=date", "holidays-add");
    const hol = page.getByTestId("holidays-add");
    for (const [d, k] of [["2026-12-25", "restDays"], ["2026-12-26", "restDays"], ["2027-01-02", "workDays"]] as const) {
      if (await page.getByTestId("holidays-list").getByText(d).count()) continue;
      await hol.locator("select").selectOption(k);
      await hol.locator("input[type=date]").fill(d);
      await hol.getByRole("button", { name: "Add" }).click();
    }
    await page.getByTestId("holidays-list").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${prefix}-settings-holidays`) });
    await go(page, "q/all/tasks?modalType=settings&tabs=more", "template-manager");
    await page.getByTestId("template-manager").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: out(`${prefix}-settings-templates`) });
    await go(page, "q/all/tasks?modalType=settings&tabs=integrations", "import-entries");
    await page.screenshot({ path: out(`${prefix}-settings-integrations`) });
    await go(page, "q/all/tasks?modalType=settings&tabs=profile", "generate-backup");
    await page.screenshot({ path: out(`${prefix}-settings-backup`) });

    // import dialog with a preview of a backup
    const v = await api<{ verifyId: string }>("POST", "/api/v2/user/verify", {});
    const csv = await (await fetch(`${API}/api/v2/data/export`, { headers: { "x-verify-id": v.verifyId } })).text();
    await page.getByTestId("import-backups").click();
    await page.getByTestId("import-file").setInputFiles({ name: "NoorTasks-backup.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await expect(page.getByTestId("import-preview")).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-import-preview`) });
    // a 23-column CSV backup with preamble and new lists, so the result shows real counts
    const stamp = Date.now().toString(16).slice(-6);
    const tt = [
      '"Date: 2026-11-16+0000"',
      '"Status: \n0 Normal\n1 Completed\n2 Archived"',
      '"Folder Name","List Name","Title","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"',
      ...[["Studio", `Ceramics ${prefix}`, "Order clay", "studio", "3", "0"], ["Studio", `Ceramics ${prefix}`, "Glaze test tiles", "", "1", "0"], ["Studio", `Ceramics ${prefix}`, "Clean the kiln", "studio", "0", "1"], ["", `Garden plans ${prefix}`, "Sketch the raised beds", "garden", "0", "0"]].map(
        ([f, l, t, tag, p, st], i) => `"${f}","${l}","${t}","${tag}","","N","","","","","${p}","${st}","","","${i}","Europe/Amsterdam","","false","","","list","66${stamp}00000000000000${i}${prefix.length}",""`,
      ),
    ].join("\n");
    await page.getByTestId("import-file").setInputFiles({ name: "tasks-backup.csv", mimeType: "text/csv", buffer: Buffer.from(tt) });
    await page.getByTestId("import-run").click();
    await expect(page.getByTestId("import-result")).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-import-result`) });
    await page.keyboard.press("Escape");

    // list template gallery and a preview
    await go(page, "q/all/tasks", "quick-add-input");
    if (phone) await page.getByTestId("mobile-menu").click();
    await page.getByTestId("add-list").click();
    await page.getByTestId("list-from-template").click();
    await expect(page.getByTestId("gallery-card").first()).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-template-gallery`) });
    await page.getByTestId("gallery-card").first().click();
    await expect(page.getByTestId("gallery-preview")).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-template-gallery-preview`) });
    await page.keyboard.press("Escape");

    // list activity
    await go(page, `p/${homeId}/tasks`, "list-more");
    await page.getByTestId("list-more").click();
    await page.getByTestId("list-activities").click();
    await expect(page.getByTestId("activity-row").first()).toBeVisible();
    await page.screenshot({ path: out(`${prefix}-list-activity`) });
  });
}

// PDF preview needs the full Chromium build (the headless shell has no PDF viewer): launch it for this shot only
test("desktop PDF preview (full Chromium)", async ({ baseURL }) => {
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Amsterdam", locale: "en-US" });
    const { id, projectId } = detailTask;
    await go(page, `p/${projectId}/tasks/${id}`, "attachments");
    await page.getByTestId("attachment").filter({ hasText: "quote-tiler.pdf" }).locator(".att-name").click();
    await expect(page.getByTestId("preview-pdf")).toBeVisible();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: out("desktop-attachment-pdf") });
  } finally {
    await browser.close();
  }
});
