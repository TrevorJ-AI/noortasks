import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { Api, OfflineError } from "../src/data/api";
import { NoorDb } from "../src/data/db";
import { SyncEngine } from "../src/data/sync";
import {
  executeImportBundle,
  fetchMsTodoGraphJson,
  inspectGenericCsv,
  parseAnydoBundle,
  parseAppleRemindersIcsBundle,
  parseBackupCsvBundle,
  parseGenericCsvBundle,
  parseGoogleTasksBundle,
  parseMarkdownBundle,
  parseMsTodoBundle,
  parseNotionCsvBundle,
  parseThingsBundle,
  parseTodoTxtBundle,
  parseTodoistBundle,
  parseTrelloBundle,
} from "../src/model/importers";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "fixtures/importers", name), "utf8");

describe("client-side importers pipeline", () => {
  it("parses 23-column backup CSV fixture with counts, subtasks, checklists, tags, recurrence, and loss report", () => {
    const bundle = parseBackupCsvBundle(fixture("backup.csv"));
    expect(bundle.counts).toEqual({
      tasks: 4,
      open: 2,
      completed: 1,
      wontDo: 1,
      checklists: 1,
      subtasks: 1,
      notes: 0,
      lists: 2,
      folders: 1,
      tags: 2,
      sections: 1 + 1, // Doing and Done
    });
    const parent = bundle.tasks.find((t) => t.title === "Inspect roof gutters")!;
    expect(parent.priority).toBe(5);
    expect(parent.repeatFlag).toBe("RRULE:FREQ=MONTHLY;INTERVAL=6");
    expect(parent.timeZone).toBe("Europe/Amsterdam");
    expect(parent.isAllDay).toBe(false);
    expect(parent.reminders).toEqual([{ trigger: "TRIGGER:-PT15M" }]);
    expect(parent.tags).toEqual(["home", "maintenance"]);
    expect(parent.content).toBe("Check east downspout");

    const cl = bundle.tasks.find((t) => t.title === "Pack toolbox")!;
    expect(cl.kind).toBe("CHECKLIST");
    expect(cl.status).toBe(2);
    expect(cl.items?.map((i) => [i.title, i.status])).toEqual([
      ["Gloves", 1],
      ["Ladder", 0],
    ]);

    const wontdo = bundle.tasks.find((t) => t.title === "Clear downspout debris")!;
    expect(wontdo.status).toBe(-1);
    expect(wontdo.listKey).toBe("Inbox");

    const sub = bundle.tasks.find((t) => t.title === "Buy replacement bracket")!;
    expect(sub.parentSourceId).toBe(parent.explicitId);
    expect(bundle.losses.some((l) => l.category === "unsupported_reminder" && l.sourceItem === "Buy replacement bracket")).toBe(true);
  });

  it("parses Todoist project CSV fixture: INDENT subtasks, sections, priorities, timezone dates, duration, recurrence, comments, and loss report", () => {
    const bundle = parseTodoistBundle(fixture("todoist-project.csv"), {
      fileName: "Engineering [9988].csv",
      defaultTimeZone: "UTC",
      now: Date.UTC(2026, 10, 16, 12, 0, 0),
    });

    expect(bundle.lists.map((l) => l.name)).toEqual(["Engineering"]);
    expect(bundle.sections.map((s) => s.name)).toEqual(["Planning", "Execution"]);
    expect(bundle.counts).toMatchObject({
      tasks: 6,
      open: 6,
      completed: 0,
      subtasks: 2,
      lists: 1,
      sections: 2,
      tags: 4,
    });

    const roadmap = bundle.tasks.find((t) => t.title === "Finalize Q4 roadmap")!;
    expect(roadmap.priority).toBe(5);
    expect(roadmap.tags).toEqual(["planning", "urgent"]);
    expect(roadmap.timeZone).toBe("America/New_York");
    expect(roadmap.isAllDay).toBe(false);
    // 2026-11-20 09:30 EST (-05:00) = 14:30 UTC; duration 60m -> 15:30 UTC
    expect(roadmap.startDate).toBe("2026-11-20T14:30:00.000+0000");
    expect(roadmap.dueDate).toBe("2026-11-20T15:30:00.000+0000");
    expect(roadmap.content).toContain("Review milestones with engineering leads");
    expect(roadmap.content).toContain("Deadline: 2026-11-25");

    const memo = bundle.tasks.find((t) => t.title === "Draft architecture memo")!;
    expect(memo.parentSourceId).toBe(roadmap.sourceId);
    expect(memo.priority).toBe(3);

    const bench = bundle.tasks.find((t) => t.title === "Benchmark Dexie batch writes")!;
    expect(bench.parentSourceId).toBe(memo.sourceId);
    expect(bench.priority).toBe(1);
    expect(bench.content).toContain("Comment: Remember to compare Chrome and Firefox timings");

    const standup = bundle.tasks.find((t) => t.title === "Weekly standup prep")!;
    expect(standup.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
    expect(standup.repeatFrom).toBe("2");
    expect(standup.timeZone).toBe("Europe/Amsterdam");
    expect(standup.isAllDay).toBe(false);

    const rotate = bundle.tasks.find((t) => t.title === "Rotate staging keys")!;
    expect(rotate.priority).toBe(0);
    expect(rotate.repeatFlag).toBe("RRULE:FREQ=DAILY;INTERVAL=3");
    expect(rotate.repeatFrom).toBe("1");

    expect(bundle.losses.some((l) => l.category === "unsupported_recurrence" && l.sourceItem === "Check hourly queue metrics")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "recurrence_start_lost")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "assignee" && l.sourceItem === "Finalize Q4 roadmap")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "comment")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "completed_absent")).toBe(true);
  });

  it("parses Todoist JSON backup fixture with completed items, API priorities, sections, labels, attachments loss", () => {
    const bundle = parseTodoistBundle(fixture("todoist-backup.json"), { defaultTimeZone: "UTC" });
    expect(bundle.counts).toMatchObject({
      tasks: 3,
      open: 2,
      completed: 1,
      subtasks: 1,
      lists: 2,
      sections: 1,
      tags: 2,
    });
    const rel = bundle.tasks.find((t) => t.title === "Publish release notes")!;
    expect(rel.priority).toBe(5);
    expect(rel.repeatFlag).toBe("RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=24");
    expect(rel.timeZone).toBe("America/New_York");
    expect(rel.content).toContain("Copy-edited by product team");
    const sub = bundle.tasks.find((t) => t.title === "Verify changelog links")!;
    expect(sub.status).toBe(2);
    expect(sub.parentSourceId).toBe(rel.sourceId);
    expect(bundle.losses.some((l) => l.category === "attachment")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "unsupported_recurrence")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "assignee")).toBe(true);
  });

  it("parses Generic CSV with column inspection, unmapped column loss, subtasks, timezone dates, and remapping", () => {
    const raw = fixture("generic.csv");
    const insp = inspectGenericCsv(raw);
    expect(insp.suggested.title).toBe("Task Name");
    expect(insp.suggested.list).toBe("Project");
    expect(insp.suggested.section).toBe("Board Stage");
    expect(insp.suggested.dueDate).toBe("Due");
    expect(insp.suggested.timeZone).toBe("TZ");
    expect(insp.suggested.repeat).toBe("Schedule");
    expect(insp.suggested.parent).toBe("Parent Task");

    const bundle = parseGenericCsvBundle(raw);
    expect(bundle.counts).toMatchObject({ tasks: 3, open: 2, completed: 1, subtasks: 1, lists: 2, sections: 1, tags: 4 });
    const design = bundle.tasks.find((t) => t.title === "Design schema")!;
    expect(design.priority).toBe(5);
    expect(design.timeZone).toBe("Europe/London");
    expect(design.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR");
    expect(design.content).toBe("Include migration notes");
    const tests = bundle.tasks.find((t) => t.title === "Write schema tests")!;
    expect(tests.parentSourceId).toBe(design.sourceId);
    expect(bundle.losses.some((l) => l.category === "unmapped_column" && l.field === "Story Points" && l.count === 3)).toBe(true);
    expect(bundle.losses.some((l) => l.category === "unsupported_recurrence" && l.sourceItem === "Archive legacy job")).toBe(true);

    // Custom column remapping changes output
    const remapped = parseGenericCsvBundle(raw, { csvMapping: { ...insp.suggested, notes: "Story Points" } });
    expect(remapped.tasks.find((t) => t.title === "Design schema")!.content).toBe("5");
    expect(remapped.losses.some((l) => l.field === "Story Points")).toBe(false);
  });

  it("parses todo.txt fixture with priorities, +projects, @contexts, due/threshold dates, rec:, and loss report", () => {
    const bundle = parseTodoTxtBundle(fixture("todotxt.txt"), { defaultTimeZone: "UTC" });
    expect(bundle.counts).toMatchObject({ tasks: 4, open: 3, completed: 1, lists: 4, tags: 6 });

    const renew = bundle.tasks.find((t) => t.title === "Renew domain registration")!;
    expect(renew.priority).toBe(5);
    expect(renew.listKey).toBe("Infra");
    expect(renew.tags).toEqual(["ops", "billing"]);
    expect(renew.startDate).toBe("2026-11-18T00:00:00.000+0000");
    expect(renew.dueDate).toBe("2026-11-25T00:00:00.000+0000");
    expect(renew.repeatFlag).toBe("RRULE:FREQ=YEARLY;INTERVAL=1");
    expect(renew.repeatFrom).toBe("0");

    const retro = bundle.tasks.find((t) => t.title === "Prepare team retro notes")!;
    expect(retro.priority).toBe(3);
    expect(retro.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1");
    expect(retro.repeatFrom).toBe("1");
    expect(retro.content).toBe("est:45m");

    const bookmarks = bundle.tasks.find((t) => t.title === "Organize bookmarks")!;
    expect(bookmarks.priority).toBe(0);
    expect(bookmarks.tags).toContain("archive");
    expect(bundle.losses.some((l) => l.field === "priority" && l.sourceItem === "Organize bookmarks")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "+project" && l.sourceItem === "Organize bookmarks")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "unsupported_recurrence" && l.field === "rec")).toBe(true);

    const expense = bundle.tasks.find((t) => t.title === "File expense report")!;
    expect(expense.status).toBe(2);
    expect(expense.priority).toBe(1);
    expect(expense.completedTime).toBe("2026-11-15T00:00:00.000+0000");
  });

  it("parses Markdown checklists fixture with sections, nested subtasks, dates, priorities, repeats, notes, and loss report", () => {
    const bundle = parseMarkdownBundle(fixture("checklists.md"), { defaultTimeZone: "UTC" });
    expect(bundle.counts).toMatchObject({
      tasks: 5,
      open: 3,
      completed: 1,
      wontDo: 1,
      subtasks: 2,
      lists: 1,
      sections: 2,
      tags: 4,
    });
    const order = bundle.tasks.find((t) => t.title === "Order cabinet hardware")!;
    expect(order.priority).toBe(5);
    expect(order.tags).toEqual(["hardware", "kitchen"]);
    expect(order.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2");
    expect(order.startDate).toBe("2026-11-20T00:00:00.000+0000");
    expect(order.dueDate).toBe("2026-11-24T00:00:00.000+0000");
    expect(order.content).toBe("Measure hinge spacing before ordering.\nCheck brushed nickel stock.");

    const pull = bundle.tasks.find((t) => t.title === "Confirm drawer pull count")!;
    expect(pull.parentSourceId).toBe(order.sourceId);
    expect(pull.priority).toBe(3);

    const trim = bundle.tasks.find((t) => t.title === "Paint ceiling trim")!;
    expect(trim.status).toBe(-1);
    expect(trim.priority).toBe(1);

    expect(bundle.losses.some((l) => l.category === "unsupported_recurrence")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "metadata" && l.reason.includes("non-task Markdown"))).toBe(true);
  });

  it("parses Microsoft To Do Graph JSON fixture and supports client-side Graph token fetch", async () => {
    const bundle = parseMsTodoBundle(fixture("microsoft-todo.json"), { defaultTimeZone: "UTC" });
    expect(bundle.counts).toMatchObject({
      tasks: 3,
      open: 2,
      completed: 1,
      checklists: 1,
      lists: 2,
      tags: 3,
    });

    const bill = bundle.tasks.find((t) => t.title === "Pay utility bill")!;
    expect(bill.listKey).toBe("Inbox");
    expect(bill.kind).toBe("CHECKLIST");
    expect(bill.priority).toBe(5);
    expect(bill.timeZone).toBe("America/New_York");
    expect(bill.isAllDay).toBe(false);
    // 14:00 EST (-05:00) = 19:00 UTC; reminder 13:30 EST = -30m
    expect(bill.startDate).toBe("2026-11-27T19:00:00.000+0000");
    expect(bill.reminders).toEqual([{ trigger: "TRIGGER:-PT30M" }]);
    expect(bill.repeatFlag).toBe("RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR");
    expect(bill.desc).toContain("Pay before Friday.");
    expect(bill.desc).toContain("[Billing Portal](https://billing.example.invalid/pay)");
    expect(bill.items?.map((i) => [i.title, i.status])).toEqual([
      ["Download invoice", 1],
      ["Submit bank transfer", 0],
    ]);

    const pr = bundle.tasks.find((t) => t.title === "Review PR backlog")!;
    expect(pr.listKey).toBe("Work Sprint");
    expect(pr.timeZone).toBe("Europe/Berlin");
    expect(pr.isAllDay).toBe(true);
    expect(pr.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH;WKST=MO;UNTIL=20270301");

    expect(bundle.losses.some((l) => l.category === "attachment" && l.sourceItem === "Pay utility bill")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "unsupported_reminder" && l.sourceItem === "Undated alarm test")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "unsupported_recurrence" && l.sourceItem === "Undated alarm test")).toBe(true);

    // Client-side Graph token flow with mocked fetch
    const calls: string[] = [];
    const mockFetch = async (url: string): Promise<Response> => {
      calls.push(url);
      if (url.endsWith("/lists")) {
        return new Response(JSON.stringify({ value: [{ id: "l1", displayName: "Errands" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ value: [{ id: "t1", title: "Fetched task", importance: "high", status: "notStarted" }] }), { status: 200 });
    };
    const jsonText = await fetchMsTodoGraphJson("fake-graph-token", mockFetch);
    const fetchedBundle = parseMsTodoBundle(jsonText);
    expect(calls).toHaveLength(2);
    expect(fetchedBundle.tasks).toHaveLength(1);
    expect(fetchedBundle.tasks[0]!.priority).toBe(5);
  });

  it("parses Google Tasks Takeout JSON preserving calendar due date across negative timezones, subtasks, links, and deleted task loss", () => {
    const bundle = parseGoogleTasksBundle(fixture("google-tasks.json"), { defaultTimeZone: "America/New_York" });
    expect(bundle.counts).toMatchObject({
      tasks: 3,
      open: 2,
      completed: 1,
      subtasks: 1,
      lists: 2,
    });
    const plan = bundle.tasks.find((t) => t.title === "Plan winter trip")!;
    // 2026-12-01 in America/New_York (-05:00) -> 2026-12-01T05:00:00.000+0000 (not Nov 30!)
    expect(plan.isAllDay).toBe(true);
    expect(plan.startDate).toBe("2026-12-01T05:00:00.000+0000");
    expect(plan.content).toContain("Compare train and ferry times.");
    expect(plan.content).toContain("[Ferry confirmation](https://mail.example.invalid/msg/42)");

    const book = bundle.tasks.find((t) => t.title === "Book cabin seats")!;
    expect(book.parentSourceId).toBe(plan.sourceId);
    expect(book.status).toBe(2);
    expect(bundle.losses.some((l) => l.field === "deleted" && l.sourceItem === "Old cancelled task")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "links")).toBe(true);
  });

  it("parses Apple Reminders ICS fixture with VTIMEZONE, RRULE, EXDATE, VALARM, RELATED-TO subtasks, and loss report", () => {
    const bundle = parseAppleRemindersIcsBundle(fixture("apple-reminders.ics"), { defaultTimeZone: "Europe/Amsterdam" });
    expect(bundle.counts).toMatchObject({
      tasks: 3,
      open: 2,
      completed: 1,
      subtasks: 1,
      lists: 1,
      tags: 2,
    });
    expect(bundle.lists[0]!.name).toBe("Errands");

    const tax = bundle.tasks.find((t) => t.title === "Submit quarterly tax packet")!;
    expect(tax.priority).toBe(5);
    expect(tax.tags).toEqual(["finance", "tax"]);
    expect(tax.content).toBe("Send signed PDF, keep receipt");
    expect(tax.timeZone).toBe("America/New_York");
    expect(tax.isAllDay).toBe(false);
    // 09:00 EST (-05:00) = 14:00 UTC
    expect(tax.startDate).toBe("2026-11-25T14:00:00.000+0000");
    expect(tax.dueDate).toBe("2026-11-25T15:00:00.000+0000");
    expect(tax.repeatFlag).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
    expect(tax.exDate).toEqual(["2026-12-04"]);
    expect(tax.reminders).toEqual([{ trigger: "TRIGGER:-PT15M" }]);

    const gather = bundle.tasks.find((t) => t.title === "Gather W-2 forms")!;
    expect(gather.status).toBe(2);
    expect(gather.priority).toBe(3);
    expect(gather.parentSourceId).toBe(tax.sourceId);
    expect(gather.isAllDay).toBe(true);
    // 2026-11-24T09:00Z in Europe/Amsterdam (+01:00) = 10:00 local on same day -> P0DT10H0M0S
    expect(gather.reminders).toEqual([{ trigger: "TRIGGER:P0DT10H0M0S" }]);

    const rx = bundle.tasks.find((t) => t.title === "Pick up prescription")!;
    expect(rx.priority).toBe(1);
    expect(rx.content).toContain("Location: Corner Pharmacy");
    expect(bundle.losses.some((l) => l.category === "unsupported_recurrence" && l.sourceItem === "Pick up prescription")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "attachment" && l.sourceItem === "Pick up prescription")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "X-APPLE-STRUCTURED-LOCATION")).toBe(true);
  });

  it("parses Trello board JSON fixture with Kanban sections, checklists, labels, dates, comments, attachments, and loss report", () => {
    const bundle = parseTrelloBundle(fixture("trello-board.json"), { defaultTimeZone: "UTC" });
    expect(bundle.lists).toEqual([{ sourceKey: "Product Launch", name: "Product Launch", viewMode: "kanban" }]);
    expect(bundle.sections.map((s) => s.name)).toEqual(["Backlog", "In Progress", "Done"]);
    expect(bundle.counts).toMatchObject({
      tasks: 4,
      open: 2,
      completed: 1,
      wontDo: 1,
      checklists: 2,
      lists: 1,
      sections: 3,
      tags: 3,
    });

    const release = bundle.tasks.find((t) => t.title === "Prepare v0.2 release")!;
    expect(release.kind).toBe("CHECKLIST");
    expect(release.tags).toEqual(["backend", "urgent"]);
    expect(release.startDate).toBe("2026-11-20T09:00:00.000+0000");
    expect(release.dueDate).toBe("2026-11-24T17:00:00.000+0000");
    expect(release.desc).toContain("Coordinate deployment steps");
    expect(release.desc).toContain("[release-plan.pdf](https://files.example.invalid/release-plan.pdf)");
    expect(release.items?.map((i) => [i.title, i.status])).toEqual([
      ["Verify /healthz endpoint", 1],
      ["Check backup rotation", 0],
    ]);

    const proxy = bundle.tasks.find((t) => t.title === "Configure Caddy proxy")!;
    expect(proxy.tags).toEqual(["green"]);
    expect(proxy.desc).toContain("Comment: Verified HSTS header on staging.");
    expect(proxy.items?.map((i) => [i.title, i.status])).toEqual([
      ["[TLS] Point A record", 1],
      ["[DNS] Verify CAA record", 0],
    ]);

    const docs = bundle.tasks.find((t) => t.title === "Publish quickstart guide")!;
    expect(docs.status).toBe(2);
    const legacy = bundle.tasks.find((t) => t.title === "Retire old staging host")!;
    expect(legacy.status).toBe(-1);
    expect(legacy.sectionKey).toBeUndefined();

    expect(bundle.losses.some((l) => l.category === "assignee" && l.sourceItem === "Prepare v0.2 release")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "attachment" && l.sourceItem === "Prepare v0.2 release")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "comment" && l.sourceItem === "Configure Caddy proxy")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "customFieldItems" && l.sourceItem === "Configure Caddy proxy")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "checklists" && l.sourceItem === "Configure Caddy proxy")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "lists.closed")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "actions")).toBe(true);
  });

  it("parses Notion database CSV fixture with UUID filename stripping, date ranges, Parent item subtasks, tags, and loss report", () => {
    const bundle = parseNotionCsvBundle(fixture("notion-database.csv"), {
      fileName: "Engineering Backlog 0123456789abcdef0123456789abcdef.csv",
      defaultTimeZone: "UTC",
    });
    expect(bundle.lists.map((l) => l.name)).toEqual(["Engineering Backlog"]);
    expect(bundle.counts).toMatchObject({
      tasks: 4,
      open: 2,
      completed: 1,
      wontDo: 1,
      subtasks: 2,
      lists: 1,
      tags: 4,
    });

    const launch = bundle.tasks.find((t) => t.title === "Launch public docs site")!;
    expect(launch.priority).toBe(5);
    expect(launch.status).toBe(0);
    expect(launch.tags).toEqual(["docs", "launch"]);
    expect(launch.isAllDay).toBe(true);
    expect(launch.startDate).toBe("2026-11-20T00:00:00.000+0000");
    expect(launch.dueDate).toBe("2026-11-25T00:00:00.000+0000");
    expect(launch.content).toContain("[wireframe.png](https://assets.example.invalid/wireframe.png)");

    const guides = bundle.tasks.find((t) => t.title === "Write hosting guides")!;
    expect(guides.status).toBe(2);
    expect(guides.priority).toBe(3);
    expect(guides.isAllDay).toBe(false);
    expect(guides.startDate).toBe("2026-11-18T14:30:00.000+0000");
    expect(guides.parentSourceId).toBe(launch.sourceId);

    const guard = bundle.tasks.find((t) => t.title === "Verify export guard")!;
    expect(guard.parentSourceId).toBe(launch.sourceId);

    expect(bundle.losses.some((l) => l.category === "unmapped_column" && l.field === "Story Points" && l.count === 4)).toBe(true);
    expect(bundle.losses.some((l) => l.category === "assignee" && l.sourceItem === "Launch public docs site")).toBe(true);
    expect(bundle.losses.some((l) => l.category === "attachment" && l.sourceItem === "Launch public docs site")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "view_export")).toBe(true);
    expect(bundle.losses.some((l) => l.reason.includes("In progress"))).toBe(true);
  });

  it("parses Any.do archived CSV fixture with categories, checklists, priorities, statuses, and archived-only loss note", () => {
    const bundle = parseAnydoBundle(fixture("anydo-archived.csv"), { defaultTimeZone: "UTC" });
    expect(bundle.counts).toMatchObject({
      tasks: 4,
      open: 1,
      completed: 2,
      wontDo: 1,
      checklists: 1,
      lists: 4,
    });

    const ssl = bundle.tasks.find((t) => t.title === "Renew SSL certificate")!;
    expect(ssl.listKey).toBe("Operations");
    expect(ssl.priority).toBe(5);
    expect(ssl.status).toBe(2);
    expect(ssl.isAllDay).toBe(false);
    expect(ssl.startDate).toBe("2026-11-10T09:00:00.000+0000");

    const supplies = bundle.tasks.find((t) => t.title === "Order office supplies")!;
    expect(supplies.kind).toBe("CHECKLIST");
    expect(supplies.priority).toBe(0);
    expect(supplies.items?.map((i) => i.title)).toEqual(["Buy pens", "Buy notebooks"]);

    const budget = bundle.tasks.find((t) => t.title === "Review Q4 budget")!;
    expect(budget.status).toBe(0);
    expect(budget.priority).toBe(1);

    const trial = bundle.tasks.find((t) => t.title === "Cancel unused trial")!;
    expect(trial.listKey).toBe("Inbox");
    expect(trial.status).toBe(-1);

    expect(bundle.losses.some((l) => l.category === "assignee" && l.sourceItem === "Review Q4 budget")).toBe(true);
    expect(bundle.losses.some((l) => l.field === "archived_export")).toBe(true);
  });

  it("parses Things 3 fixtures via todo.txt, Markdown, and AppleScript CSV routes with folders, sections, checklists, and losses", () => {
    const txtBundle = parseThingsBundle(fixture("things-export.txt"), { defaultTimeZone: "UTC" });
    expect(txtBundle.source).toBe("things");
    expect(txtBundle.counts).toMatchObject({ tasks: 3, open: 2, completed: 1, lists: 3, tags: 3 });
    const audit = txtBundle.tasks.find((t) => t.title === "Audit home backup drives")!;
    expect(audit.listKey).toBe("Infra");
    expect(audit.repeatFlag).toBe("RRULE:FREQ=MONTHLY;INTERVAL=1");
    expect(audit.startDate).toBe("2026-11-19T00:00:00.000+0000");
    expect(audit.dueDate).toBe("2026-11-26T00:00:00.000+0000");

    const mdBundle = parseThingsBundle(fixture("checklists.md"), { defaultTimeZone: "UTC" });
    expect(mdBundle.source).toBe("things");
    expect(mdBundle.counts.tasks).toBe(5);
    expect(mdBundle.counts.subtasks).toBe(2);

    const csvBundle = parseThingsBundle(fixture("things-export.csv"), { defaultTimeZone: "UTC" });
    expect(csvBundle.source).toBe("things");
    expect(csvBundle.folders.map((f) => f.name)).toEqual(["Work"]);
    expect(csvBundle.counts).toMatchObject({
      tasks: 3,
      open: 2,
      wontDo: 1,
      checklists: 1,
      folders: 1,
      lists: 2,
      sections: 1,
      tags: 4,
    });
    const draft = csvBundle.tasks.find((t) => t.title === "Draft migration notes")!;
    expect(draft.kind).toBe("CHECKLIST");
    expect(draft.items?.map((i) => [i.title, i.status])).toEqual([
      ["Outline sections", 1],
      ["Add examples", 0],
    ]);
    expect(draft.startDate).toBe("2026-11-21T00:00:00.000+0000");
    expect(draft.dueDate).toBe("2026-11-24T00:00:00.000+0000");
    const drop = csvBundle.tasks.find((t) => t.title === "Drop legacy sync flag")!;
    expect(drop.status).toBe(-1);
    expect(csvBundle.losses.some((l) => l.sourceItem === "Review travel packing list" && l.reason.includes("Someday"))).toBe(true);
  });

  describe("Dexie + outbox execution, sync to server, offline queueing, and idempotent re-import", () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-imp-sync-"));
    const { app } = buildApp({ noAuth: true, dataDir: join(dir, "files"), dbPath: join(dir, "db.sqlite") });
    const portBase = { url: "" };

    afterAll(async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("imports Todoist bundle locally, syncs to server, and skips 100% on re-import", async () => {
      const addr = await app.listen({ port: 0, host: "127.0.0.1" });
      portBase.url = addr;

      const db = new NoorDb(`imp-idempotent-${Math.random()}`);
      const engine = new SyncEngine(db, new Api({ base: addr }));
      try {
        await engine.sync();

        const bundle = parseTodoistBundle(fixture("todoist-project.csv"), {
          fileName: "Engineering.csv",
          defaultTimeZone: "UTC",
          now: Date.UTC(2026, 10, 16, 12, 0, 0),
        });

        const first = await executeImportBundle(db, engine, bundle);
        expect(first.imported).toBe(6);
        expect(first.skipped).toBe(0);
        expect(first.createdProjects).toBe(1);
        expect(first.createdColumns).toBe(2);
        expect(first.createdTags).toBe(4);
        expect(await db.outbox.count()).toBeGreaterThan(0);

        await engine.sync();
        expect(await db.outbox.count()).toBe(0);

        // Verify server holds all imported folders/lists/columns/tags/tasks + parent link
        const chk = (await app.inject({ method: "GET", url: "/api/v3/batch/check/0" })).json() as {
          projectProfiles: Array<{ id: string; name: string }>;
          syncTaskBean: { update: Array<{ id: string; title: string; parentId?: string; childIds?: string[]; columnId?: string }> };
        };
        const engProj = chk.projectProfiles.find((p) => p.name === "Engineering")!;
        expect(engProj).toBeTruthy();
        const cols = (await app.inject({ method: "GET", url: `/api/v2/column/project/${engProj.id}` })).json() as Array<{ id: string; name: string }>;
        expect(cols.map((c) => c.name).sort()).toEqual(["Execution", "Planning"]);

        const roadmap = chk.syncTaskBean.update.find((t) => t.title === "Finalize Q4 roadmap")!;
        const memo = chk.syncTaskBean.update.find((t) => t.title === "Draft architecture memo")!;
        expect(memo.parentId).toBe(roadmap.id);
        expect(roadmap.childIds).toContain(memo.id);
        expect(roadmap.columnId).toBe(cols.find((c) => c.name === "Planning")!.id);

        // Second import: deterministic IDs skip every task and enqueue zero ops
        const second = await executeImportBundle(db, engine, bundle);
        expect(second.imported).toBe(0);
        expect(second.skipped).toBe(6);
        expect(second.createdProjects).toBe(0);
        expect(second.createdColumns).toBe(0);
        expect(second.createdTags).toBe(0);
        expect(await db.outbox.count()).toBe(0);
      } finally {
        db.close();
        await db.delete();
      }
    });

    it("imports while offline into Dexie and outbox, then syncs when online", async () => {
      let offline = true;
      const db = new NoorDb(`imp-offline-${Math.random()}`);
      const api = new Api({
        base: portBase.url,
        isOffline: () => offline,
        fetch: (input, init) => {
          if (offline) throw new OfflineError();
          return globalThis.fetch(input, init);
        },
      });
      const engine = new SyncEngine(db, api);
      try {
        const bundle = parseMarkdownBundle(fixture("checklists.md"), { defaultTimeZone: "UTC" });
        const res = await executeImportBundle(db, engine, bundle);
        expect(res.imported).toBe(5);
        await engine.sync();
        expect(engine.status.state).toBe("offline");
        expect(await db.outbox.count()).toBeGreaterThan(0);

        offline = false;
        await engine.sync();
        expect(engine.status.state).toBe("idle");
        expect(await db.outbox.count()).toBe(0);
      } finally {
        db.close();
        await db.delete();
      }
    });

    it("imports Trello, Notion, Any.do, and Things 3 bundles and skips 100% on deterministic re-import", async () => {
      const db = new NoorDb(`imp-v3-${Math.random()}`);
      const engine = new SyncEngine(db, new Api({ base: portBase.url }));
      try {
        await engine.sync();
        const bundles = [
          parseTrelloBundle(fixture("trello-board.json"), { defaultTimeZone: "UTC" }),
          parseNotionCsvBundle(fixture("notion-database.csv"), { fileName: "Engineering Backlog 0123456789abcdef0123456789abcdef.csv", defaultTimeZone: "UTC" }),
          parseAnydoBundle(fixture("anydo-archived.csv"), { defaultTimeZone: "UTC" }),
          parseThingsBundle(fixture("things-export.txt"), { defaultTimeZone: "UTC" }),
        ];
        const expectedTotal = bundles.reduce((acc, b) => acc + b.tasks.length, 0);

        for (const b of bundles) {
          const r1 = await executeImportBundle(db, engine, b);
          expect(r1.imported).toBe(b.tasks.length);
          expect(r1.skipped).toBe(0);
        }
        await engine.sync();
        expect(await db.outbox.count()).toBe(0);

        for (const b of bundles) {
          const r2 = await executeImportBundle(db, engine, b);
          expect(r2.imported).toBe(0);
          expect(r2.skipped).toBe(b.tasks.length);
        }
        expect(await db.outbox.count()).toBe(0);

        const chk = (await app.inject({ method: "GET", url: "/api/v3/batch/check/0" })).json() as {
          syncTaskBean: { update: Array<{ title: string }> };
        };
        expect(chk.syncTaskBean.update.length).toBeGreaterThanOrEqual(expectedTotal);
      } finally {
        db.close();
        await db.delete();
      }
    });
  });
});
