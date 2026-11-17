import { join } from "node:path";
import { expect, test } from "@playwright/test";

const todoistCsvPath = join(import.meta.dirname, "../test/fixtures/importers/todoist-project.csv");
const trelloJsonPath = join(import.meta.dirname, "../test/fixtures/importers/trello-board.json");

test("Todoist CSV import: previews counts and loss report, imports through UI, shows tasks and skips duplicates on re-import", async ({ page }) => {
  // Go to Settings > Integrations & Import
  await page.goto("/#q/all/tasks?modalType=settings&tabs=integrations");
  await expect(page.getByTestId("importer-Todoist")).toBeEnabled();
  await page.getByTestId("importer-Todoist").click();

  const dlg = page.getByTestId("import-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("import-source")).toHaveValue("todoist");

  // Pick Todoist project CSV fixture
  await dlg.getByTestId("import-file").setInputFiles(todoistCsvPath);

  const preview = dlg.getByTestId("import-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("import-count-tasks").locator(".imp-num")).toHaveText("6");
  await expect(preview.getByTestId("import-count-subtasks").locator(".imp-num")).toHaveText("2");
  await expect(preview.getByTestId("import-count-sections").locator(".imp-num")).toHaveText("2");
  await expect(preview.getByTestId("import-count-tags").locator(".imp-num")).toHaveText("4");

  const loss = preview.getByTestId("import-loss-report");
  await expect(loss).toBeVisible();
  await expect(loss).toContainText("Unsupported recurrence expression");
  await expect(loss).toContainText("every 3 hours");

  // Run import
  await dlg.getByTestId("import-run").click();
  const res = dlg.getByTestId("import-result");
  await expect(res).toBeVisible({ timeout: 15_000 });
  await expect(res.getByTestId("import-result-imported").locator(".imp-num")).toHaveText("6");
  await expect(res.getByTestId("import-result-skipped").locator(".imp-num")).toHaveText("0");
  await expect(res.getByTestId("import-result-lists").locator(".imp-num")).toHaveText("1");
  await expect(res.getByTestId("import-result-sections").locator(".imp-num")).toHaveText("2");

  // Close import modal and settings, navigate to the created list in the sidebar
  await dlg.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  const sideList = page.getByTestId("side-list-todoist-project");
  await expect(sideList).toBeVisible({ timeout: 10_000 });
  await sideList.click();

  await expect(page.getByTestId("view-title")).toHaveText("todoist-project");
  await expect(page.locator("[data-task-id]").filter({ hasText: "Finalize Q4 roadmap" })).toBeVisible();
  await expect(page.locator("[data-task-id]").filter({ hasText: "Weekly standup prep" })).toBeVisible();
  await expect(page.locator("[data-task-id]").filter({ hasText: "Rotate staging keys" })).toBeVisible();

  // Re-import the same Todoist CSV fixture: deterministic IDs skip all 6 tasks cleanly
  await page.goto("/#q/all/tasks?modalType=settings&tabs=integrations");
  await page.getByTestId("importer-Todoist").click();
  await page.getByTestId("import-file").setInputFiles(todoistCsvPath);
  await page.getByTestId("import-run").click();
  const res2 = page.getByTestId("import-result");
  await expect(res2.getByTestId("import-result-imported").locator(".imp-num")).toHaveText("0", { timeout: 15_000 });
  await expect(res2.getByTestId("import-result-skipped").locator(".imp-num")).toHaveText("6");
});

test("Trello board JSON import: previews Kanban sections and checklists, imports through UI, and skips duplicates on re-import", async ({ page }) => {
  await page.goto("/#q/all/tasks?modalType=settings&tabs=integrations");
  await expect(page.getByTestId("importer-trello")).toBeEnabled();
  await page.getByTestId("importer-trello").click();

  const dlg = page.getByTestId("import-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("import-source")).toHaveValue("trello");

  await dlg.getByTestId("import-file").setInputFiles(trelloJsonPath);

  const preview = dlg.getByTestId("import-preview");
  await expect(preview).toBeVisible();
  await expect(preview.getByTestId("import-count-tasks").locator(".imp-num")).toHaveText("4");
  await expect(preview.getByTestId("import-count-checklists").locator(".imp-num")).toHaveText("2");
  await expect(preview.getByTestId("import-count-sections").locator(".imp-num")).toHaveText("3");
  await expect(preview.getByTestId("import-count-tags").locator(".imp-num")).toHaveText("3");

  const loss = preview.getByTestId("import-loss-report");
  await expect(loss).toBeVisible();
  await expect(loss).toContainText("Archived Trello list");

  await dlg.getByTestId("import-run").click();
  const res = dlg.getByTestId("import-result");
  await expect(res).toBeVisible({ timeout: 15_000 });
  await expect(res.getByTestId("import-result-imported").locator(".imp-num")).toHaveText("4");
  await expect(res.getByTestId("import-result-skipped").locator(".imp-num")).toHaveText("0");

  await dlg.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  const sideList = page.getByTestId("side-list-Product Launch");
  await expect(sideList).toBeVisible({ timeout: 10_000 });
  await sideList.click();
  await expect(page.getByTestId("view-title")).toHaveText("Product Launch");
  await expect(page.locator("[data-task-id]").filter({ hasText: "Prepare v0.2 release" })).toBeVisible();

  await page.goto("/#q/all/tasks?modalType=settings&tabs=integrations");
  await page.getByTestId("importer-trello").click();
  await page.getByTestId("import-file").setInputFiles(trelloJsonPath);
  await page.getByTestId("import-run").click();
  const res2 = page.getByTestId("import-result");
  await expect(res2.getByTestId("import-result-imported").locator(".imp-num")).toHaveText("0", { timeout: 15_000 });
  await expect(res2.getByTestId("import-result-skipped").locator(".imp-num")).toHaveText("4");
});
