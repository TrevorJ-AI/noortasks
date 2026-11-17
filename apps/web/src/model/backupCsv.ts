import { convertRruleToRepeatFlag } from "@noortasks/recurrence";
import { ORDER_STEP, TaskKind, parseTrigger } from "../lib/core";
import { finalizeBundle, resolveTimeZone } from "./importers/dates";
import { OccurrenceKeyer } from "./importers/ids";
import type {
  ImportBundle,
  ImportChecklistItem,
  ImportFolder,
  ImportList,
  ImportLossItem,
  ImportSection,
  ImportTag,
  ImportTask,
} from "./importers/types";

/**
 * Backup CSV preview (IMP-014, IMP-025, IMP-033): parses a TickTick-format backup on the client so the import
 * dialog can show what the file holds before anything is sent. Mirrors the server's reader (apps/server
 * backup.ts importTasksCsv): optional BOM and metadata preamble, header found dynamically (a row with Title
 * and List Name, taskId or Status), optional status legend line "0 Normal, 1 Completed, 2 Archived".
 */

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  /** row objects keyed by lower-case header */
  records: Array<Record<string, string>>;
  counts: {
    tasks: number;
    open: number;
    completed: number;
    wontDo: number;
    checklists: number;
    subtasks: number;
    notes: number;
    lists: number;
    folders: number;
    tags: number;
    sections: number;
  };
  lists: string[];
  folders: string[];
  tags: string[];
  /** true when the status legend says 1 completed, 2 archived (TickTick backup format compatibility) */
  archiveLegend: boolean;
}

export class CsvFormatError extends Error {}

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function statusOf(raw: string, legend: boolean): 0 | 2 | -1 {
  const s = raw.trim().toLowerCase();
  if (s === "-1" || s === "abandoned" || s === "wontdo" || s === "won't do") return -1;
  if (s === "completed" || s === "done") return 2;
  if (legend) return s === "1" ? 2 : s === "2" ? -1 : 0;
  return s === "2" || s === "1" ? 2 : 0;
}

export function previewBackupCsv(text: string): CsvPreview {
  const parsed = parseCsv(text);
  let legend = false;
  let headerIdx = -1;
  for (let i = 0; i < parsed.length; i++) {
    const row = parsed[i]!;
    const joined = row.join(" ").toLowerCase();
    if (joined.includes("1 completed") && joined.includes("2 archived")) legend = true;
    const norm = row.map((c) => c.trim().toLowerCase());
    if (norm.includes("title") && (norm.includes("list name") || norm.includes("taskid") || norm.includes("status"))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new CsvFormatError("This file has no backup header row (Title, List Name, Status...)");
  const headers = parsed[headerIdx]!.map((h) => h.trim());
  const keys = headers.map((h) => h.toLowerCase());
  const rows = parsed.slice(headerIdx + 1).filter((r) => r.some((c) => c.trim() !== ""));
  const records = rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? ""])));
  const lists = new Set<string>();
  const folders = new Set<string>();
  const tags = new Set<string>();
  const sections = new Set<string>();
  const counts = { tasks: records.length, open: 0, completed: 0, wontDo: 0, checklists: 0, subtasks: 0, notes: 0, lists: 0, folders: 0, tags: 0, sections: 0 };
  for (const r of records) {
    const st = statusOf(r.status ?? "", legend);
    if (st === 2) counts.completed++;
    else if (st === -1) counts.wontDo++;
    else counts.open++;
    const yes = (r["is check list"] ?? "").trim().toLowerCase();
    if (yes === "y" || yes === "yes" || yes === "true") counts.checklists++;
    if ((r.kind ?? "").trim().toUpperCase() === "NOTE") counts.notes++;
    if ((r.parentid ?? "").trim()) counts.subtasks++;
    const list = (r["list name"] ?? "").trim() || "Inbox";
    lists.add(list);
    const folder = (r["folder name"] ?? "").trim();
    if (folder) folders.add(folder);
    for (const t of (r.tags ?? "").split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean)) tags.add(t.toLowerCase());
    const col = (r["column name"] ?? "").trim();
    if (col) sections.add(`${list}\0${col}`);
  }
  counts.lists = lists.size;
  counts.folders = folders.size;
  counts.tags = tags.size;
  counts.sections = sections.size;
  return { headers, rows, records, counts, lists: [...lists], folders: [...folders], tags: [...tags], archiveLegend: legend };
}

function parseBoolCell(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "true" || s === "y" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "n" || s === "no" || s === "0") return false;
  return undefined;
}

function parsePriorityCell(raw: string): 0 | 1 | 3 | 5 {
  const s = raw.trim().toLowerCase();
  if (s === "5" || s === "high") return 5;
  if (s === "3" || s === "medium") return 3;
  if (s === "1" || s === "low") return 1;
  return 0;
}

function parseChecklistContent(raw: string): { desc: string; items: ImportChecklistItem[] } {
  const items: ImportChecklistItem[] = [];
  const descLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const md = /^\s*(?:[-*]\s*)?\[([ xX])\]\s*(.*)$/.exec(line);
    const sym = /^\s*([▫▪])\s*(.*)$/.exec(line);
    if (md) {
      items.push({ title: md[2] ?? "", status: md[1]!.toLowerCase() === "x" ? 1 : 0, sortOrder: items.length * ORDER_STEP });
    } else if (sym) {
      items.push({ title: sym[2] ?? "", status: sym[1] === "▪" ? 1 : 0, sortOrder: items.length * ORDER_STEP });
    } else {
      descLines.push(line);
    }
  }
  return { desc: descLines.join("\n").trim(), items };
}

/** Parse a NoorTasks or TickTick 23-column CSV backup into the shared ImportBundle pipeline. */
export function parseBackupCsvBundle(text: string): ImportBundle {
  const preview = previewBackupCsv(text);
  const losses: ImportLossItem[] = [];
  const folderMap = new Map<string, ImportFolder>();
  const listMap = new Map<string, ImportList>();
  const sectionMap = new Map<string, ImportSection>();
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const keyer = new OccurrenceKeyer();

  for (const r of preview.records) {
    const folderName = (r["folder name"] ?? "").trim();
    if (folderName && !folderMap.has(folderName)) {
      folderMap.set(folderName, { sourceKey: folderName, name: folderName, sortOrder: folderMap.size * ORDER_STEP });
    }

    const rawListName = (r["list name"] ?? "").trim();
    const listName = rawListName || "Inbox";
    const isInbox = listName.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : listName;
    const viewModeRaw = (r["view mode"] ?? "").trim().toLowerCase();
    const viewMode = viewModeRaw === "kanban" || viewModeRaw === "timeline" ? viewModeRaw : "list";
    if (!isInbox && !listMap.has(listKey)) {
      listMap.set(listKey, {
        sourceKey: listKey,
        name: listName,
        ...(folderName ? { folderKey: folderName } : {}),
        viewMode,
      });
    }

    const colName = (r["column name"] ?? "").trim();
    let sectionKey: string | undefined;
    if (colName) {
      if (isInbox) {
        losses.push({
          category: "field_ignored",
          sourceItem: (r.title ?? "").trim() || "(Untitled)",
          field: "Column Name",
          reason: `Inbox does not support Kanban sections; section "${colName}" omitted`,
        });
      } else {
        sectionKey = `${listKey}\0${colName}`;
        if (!sectionMap.has(sectionKey)) {
          const coRaw = (r["column order"] ?? "").trim();
          const co = Number(coRaw);
          sectionMap.set(sectionKey, {
            sourceKey: sectionKey,
            listKey,
            name: colName,
            sortOrder: coRaw !== "" && Number.isFinite(co) ? co : sectionMap.size * ORDER_STEP,
          });
        }
      }
    }

    const rawTags = (r.tags ?? "").split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
    const taskTags: string[] = [];
    for (const rt of rawTags) {
      const low = rt.toLowerCase();
      if (!taskTags.includes(low)) taskTags.push(low);
      if (!tagMap.has(low)) tagMap.set(low, { name: low, label: rt });
    }

    const remRaw = r.reminder ?? "";
    const reminders: Array<{ trigger: string }> = [];
    for (const part of remRaw.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean)) {
      if (parseTrigger(part) !== null) reminders.push({ trigger: part });
      else {
        losses.push({
          category: "unsupported_reminder",
          sourceItem: (r.title ?? "").trim() || "(Untitled)",
          field: "Reminder",
          reason: `Unsupported reminder trigger "${part}" dropped`,
        });
      }
    }

    const repeatRaw = (r.repeat ?? "").trim();
    let repeatFlag: string | undefined;
    if (repeatRaw) {
      const conv = convertRruleToRepeatFlag(repeatRaw);
      if (conv.repeatFlag) repeatFlag = conv.repeatFlag;
      if (conv.lostReason) {
        losses.push({
          category: "unsupported_recurrence",
          sourceItem: (r.title ?? "").trim() || "(Untitled)",
          field: "Repeat",
          reason: conv.lostReason,
        });
      }
    }

    const kindCell = (r.kind ?? "").trim().toUpperCase();
    const isChecklist = parseBoolCell(r["is check list"] ?? "") === true || kindCell === TaskKind.Checklist;
    const contentRaw = r.content ?? "";
    let kind: "TEXT" | "NOTE" | "CHECKLIST" = kindCell === TaskKind.Note ? "NOTE" : isChecklist ? "CHECKLIST" : "TEXT";
    let content: string | undefined = contentRaw || undefined;
    let desc: string | undefined;
    let items: ImportChecklistItem[] | undefined;
    if (isChecklist) {
      const parsedCl = parseChecklistContent(contentRaw);
      items = parsedCl.items;
      desc = parsedCl.desc || undefined;
      content = undefined;
      kind = "CHECKLIST";
    }

    const tzRaw = (r.timezone ?? "").trim();
    let timeZone: string | undefined;
    if (tzRaw) {
      const tzRes = resolveTimeZone(tzRaw);
      timeZone = tzRes.zone;
      if (tzRes.lost) {
        losses.push({
          category: "field_ignored",
          sourceItem: (r.title ?? "").trim() || "(Untitled)",
          field: "Timezone",
          reason: tzRes.lost,
        });
      }
    }

    const rawTaskId = (r.taskid ?? "").trim();
    const title = r.title ?? "";
    const status = statusOf(r.status ?? "", preview.archiveLegend);
    const priority = parsePriorityCell(r.priority ?? "");
    const orderRaw = (r.order ?? "").trim();
    const orderNum = Number(orderRaw);
    const sortOrder = orderRaw !== "" && Number.isFinite(orderNum) ? orderNum : 0;
    const startDate = (r["start date"] ?? "").trim() || undefined;
    const dueDate = (r["due date"] ?? "").trim() || undefined;
    const createdTime = (r["created time"] ?? "").trim() || undefined;
    const completedTime = (r["completed time"] ?? "").trim() || undefined;
    const isAllDay = parseBoolCell(r["is all day"] ?? "");
    const isFloating = parseBoolCell(r["is floating"] ?? "");
    const parentSourceId = (r.parentid ?? "").trim() || undefined;

    const sourceId = rawTaskId || keyer.next(`${listKey}\0${title}\0${startDate ?? ""}`);

    tasks.push({
      sourceId,
      ...(rawTaskId ? { explicitId: rawTaskId } : {}),
      listKey,
      ...(sectionKey ? { sectionKey } : {}),
      ...(parentSourceId ? { parentSourceId } : {}),
      title,
      kind,
      ...(content ? { content } : {}),
      ...(desc ? { desc } : {}),
      ...(items ? { items } : {}),
      status,
      priority,
      ...(startDate ? { startDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(isAllDay !== undefined ? { isAllDay } : {}),
      ...(isFloating !== undefined ? { isFloating } : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(reminders.length ? { reminders } : {}),
      ...(repeatFlag ? { repeatFlag } : {}),
      tags: taskTags,
      sortOrder,
      ...(createdTime ? { createdTime } : {}),
      ...(completedTime ? { completedTime } : {}),
    });
  }

  return finalizeBundle({
    source: "backupCsv",
    sourceLabel: "NoorTasks / TickTick Backup",
    folders: [...folderMap.values()],
    lists: [...listMap.values()],
    sections: [...sectionMap.values()],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}
