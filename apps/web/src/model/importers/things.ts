import { ORDER_STEP } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import {
  buildHeaderIndex,
  collectTagsIntoMap,
  csvCell,
  parseCsvTable,
  parseStatusToken,
  pickHeaderMatch,
  reportUnmappedCsvColumns,
} from "./csvCommon";
import { finalizeBundle, parseFlexibleDate } from "./dates";
import { OccurrenceKeyer } from "./ids";
import { parseMarkdownBundle } from "./markdown";
import { parseTodoTxtBundle } from "./todotxt";
import type {
  ImportBundle,
  ImportChecklistItem,
  ImportFolder,
  ImportList,
  ImportLossItem,
  ImportSection,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

const THINGS_BUCKETS = new Set(["today", "this evening", "evening", "tonight", "anytime", "someday", "upcoming", "inbox"]);

function looksLikeThingsCsv(text: string): boolean {
  const firstLine = text.replace(/^\uFEFF/, "").split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  if (!firstLine.includes(",")) return false;
  const low = firstLine.toLowerCase();
  return low.includes("title") && (low.includes("project") || low.includes("area") || low.includes("when") || low.includes("deadline") || low.includes("notes"));
}

function looksLikeMarkdown(text: string): boolean {
  const clean = text.replace(/^\uFEFF/, "");
  return /^#{1,6}\s+/m.test(clean) || /^\s*(?:[-*+]|\d+\.)\s+\[[ xX\-~!]\]\s+/m.test(clean);
}

function parseThingsCsvBundle(text: string, opts: ParseImportOptions): ImportBundle {
  const { headers, rows } = parseCsvTable(text, "Things 3 CSV file is empty");
  const colIdx = buildHeaderIndex(headers);
  const cell = (row: string[], headerName: string | undefined): string => csvCell(row, colIdx, headerName);

  const used = new Set<string>();
  const colTitle = pickHeaderMatch(headers, ["title", "name", "task"], used) ?? headers[0]!;
  used.add(colTitle);
  const colNotes = pickHeaderMatch(headers, ["notes", "note", "description"], used);
  const colArea = pickHeaderMatch(headers, ["area", "folder"], used);
  const colProject = pickHeaderMatch(headers, ["project", "list"], used);
  const colHeading = pickHeaderMatch(headers, ["heading", "section"], used);
  const colTags = pickHeaderMatch(headers, ["tags", "tag"], used);
  const colWhen = pickHeaderMatch(headers, ["when", "start", "start date", "scheduled"], used);
  const colDeadline = pickHeaderMatch(headers, ["deadline", "due", "due date"], used);
  const colStatus = pickHeaderMatch(headers, ["status", "completed", "state"], used);
  const colChecklist = pickHeaderMatch(headers, ["checklist", "checklist items", "subtasks"], used);
  const colId = pickHeaderMatch(headers, ["id", "uuid"], used, false);

  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const folderMap = new Map<string, ImportFolder>();
  const listMap = new Map<string, ImportList>();
  const sectionMap = new Map<string, ImportSection>();
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();

  reportUnmappedCsvColumns(headers, rows, used, losses);

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const title = cell(row, colTitle) || "(Untitled)";
    const areaName = cell(row, colArea);
    const projectName = cell(row, colProject);

    let folderKey: string | undefined;
    if (areaName && projectName && projectName.toLowerCase() !== "inbox") {
      folderKey = areaName;
      if (!folderMap.has(folderKey)) {
        folderMap.set(folderKey, { sourceKey: folderKey, name: areaName, sortOrder: folderMap.size * ORDER_STEP });
      }
    }

    const rawListName = projectName || areaName || "Inbox";
    const isInbox = rawListName.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : (folderKey ? `${folderKey}\0${rawListName}` : rawListName);
    if (!isInbox && !listMap.has(listKey)) {
      listMap.set(listKey, {
        sourceKey: listKey,
        name: rawListName,
        ...(folderKey ? { folderKey } : {}),
      });
    }

    const heading = cell(row, colHeading);
    let sectionKey: string | undefined;
    if (heading) {
      if (isInbox) {
        losses.push({
          category: "field_ignored",
          sourceItem: title,
          field: colHeading ?? "Heading",
          reason: `Inbox does not support sections; Things heading "${heading}" omitted`,
        });
      } else {
        sectionKey = `${listKey}\0${heading}`;
        if (!sectionMap.has(sectionKey)) {
          sectionMap.set(sectionKey, { sourceKey: sectionKey, listKey, name: heading, sortOrder: sectionMap.size * ORDER_STEP });
        }
      }
    }

    const notes = cell(row, colNotes);
    const taskTags = collectTagsIntoMap(cell(row, colTags), tagMap);
    const st = parseStatusToken(cell(row, colStatus), { archivedStatus: -1, sourceName: "Things 3" });
    if (st.lost) losses.push({ category: "field_ignored", sourceItem: title, field: colStatus ?? "Status", reason: st.lost });

    const whenRaw = cell(row, colWhen);
    const deadlineRaw = cell(row, colDeadline);
    let parsedWhen = null;
    if (whenRaw) {
      if (THINGS_BUCKETS.has(whenRaw.toLowerCase())) {
        losses.push({
          category: "metadata",
          sourceItem: title,
          field: colWhen ?? "When",
          reason: `Things 3 scheduling bucket "${whenRaw}" without a calendar date was omitted`,
        });
      } else {
        parsedWhen = parseFlexibleDate(whenRaw, { defaultTimeZone: defaultTz });
        if (!parsedWhen) {
          losses.push({ category: "invalid_date", sourceItem: title, field: colWhen ?? "When", reason: `Could not parse Things date "${whenRaw}"` });
        }
      }
    }

    const parsedDeadline = deadlineRaw ? parseFlexibleDate(deadlineRaw, { defaultTimeZone: defaultTz }) : null;
    if (deadlineRaw && !parsedDeadline) {
      losses.push({ category: "invalid_date", sourceItem: title, field: colDeadline ?? "Deadline", reason: `Could not parse Things deadline "${deadlineRaw}"` });
    }

    const startVal = parsedWhen ?? parsedDeadline;
    const dueVal = parsedDeadline ?? parsedWhen;

    const checklistRaw = cell(row, colChecklist);
    const items: ImportChecklistItem[] = checklistRaw
      ? checklistRaw
          .split(/\r?\n|\s*[;|]\s*/)
          .map((x) => x.trim())
          .filter(Boolean)
          .map((itemText, idx) => {
            const doneMark = /^\[([xX ])\]\s+(.*)$/.exec(itemText);
            return {
              title: doneMark ? doneMark[2]!.trim() : itemText,
              status: doneMark && doneMark[1]!.toLowerCase() === "x" ? 1 : 0,
              sortOrder: idx * ORDER_STEP,
            };
          })
      : [];
    const isChecklist = items.length > 0;
    const rawId = cell(row, colId);
    const sourceId = rawId || keyer.next(`${listKey}\0${title}`);

    tasks.push({
      sourceId,
      listKey,
      ...(sectionKey ? { sectionKey } : {}),
      title,
      kind: isChecklist ? "CHECKLIST" : "TEXT",
      ...(isChecklist ? { ...(notes ? { desc: notes } : {}), items } : notes ? { content: notes } : {}),
      status: st.status,
      priority: 0,
      ...(startVal
        ? {
            startDate: startVal.wireDate,
            dueDate: (dueVal && dueVal.ms >= startVal.ms ? dueVal : startVal).wireDate,
            isAllDay: startVal.isAllDay,
            isFloating: startVal.isFloating,
            timeZone: startVal.timeZone,
          }
        : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    });
  }

  return finalizeBundle({
    source: "things",
    sourceLabel: "Things 3",
    folders: [...folderMap.values()],
    lists: [...listMap.values()],
    sections: [...sectionMap.values()],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}

/**
 * Parse a Things 3 export via its documented export routes:
 * Markdown (Apple Shortcuts / Copy as Text), todo.txt (AppleScript), or CSV (AppleScript / script output).
 */
export function parseThingsBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  if (looksLikeThingsCsv(text)) {
    return parseThingsCsvBundle(text, opts);
  }
  const base = looksLikeMarkdown(text)
    ? parseMarkdownBundle(text, opts)
    : parseTodoTxtBundle(text, opts);
  return {
    ...base,
    source: "things",
    sourceLabel: "Things 3",
  };
}
