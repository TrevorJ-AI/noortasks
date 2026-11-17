import { ORDER_STEP } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import {
  appendNoteBlock,
  buildHeaderIndex,
  collectTagsIntoMap,
  csvCell,
  deriveListFromFileName,
  parseCsvTable,
  parsePriorityToken,
  parseStatusToken,
  pickHeaderMatch,
  reportUnmappedCsvColumns,
} from "./csvCommon";
import { finalizeBundle, parseFlexibleDate, type ParsedDateValue } from "./dates";
import { OccurrenceKeyer } from "./ids";
import type {
  ImportBundle,
  ImportList,
  ImportLossItem,
  ImportSection,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

function parseNotionDateValue(
  raw: string,
  defaultTz: string,
): { start: ParsedDateValue; due: ParsedDateValue } | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(/\s*(?:→|->)\s*/);
  if (parts.length >= 2 && parts[0]?.trim() && parts[1]?.trim()) {
    const start = parseFlexibleDate(parts[0].trim(), { defaultTimeZone: defaultTz });
    const end = parseFlexibleDate(parts[1].trim(), { defaultTimeZone: defaultTz });
    if (start && end) {
      return { start, due: end.ms >= start.ms ? end : start };
    }
    if (start) return { start, due: start };
  }
  const single = parseFlexibleDate(s, { defaultTimeZone: defaultTz });
  return single ? { start: single, due: single } : null;
}

function stripNotionRelationUrl(raw: string): string {
  return raw.replace(/\s*\(https?:\/\/(?:www\.)?notion\.so\/[^)]+\)\s*$/i, "").trim();
}

function formatFilesMediaLinks(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (/^https?:\/\//i.test(part)) {
      const tail = part.split("/").pop()?.split("?")[0] || "Attachment";
      out.push(`[${decodeURIComponent(tail)}](${part})`);
    } else {
      out.push(part);
    }
  }
  return out;
}

/** Parse a Notion database CSV export into ImportBundle. */
export function parseNotionCsvBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  const { headers, rows } = parseCsvTable(text, "Notion CSV file is empty");
  const colIdx = buildHeaderIndex(headers);
  const cell = (row: string[], headerName: string | undefined): string => csvCell(row, colIdx, headerName);

  const used = new Set<string>();
  const colTitle = pickHeaderMatch(headers, ["name", "title", "task name", "task"], used) ?? headers[0]!;
  used.add(colTitle);
  const colStatus = pickHeaderMatch(headers, ["status", "state"], used);
  const colDone = pickHeaderMatch(headers, ["done", "completed", "complete", "checkbox"], used);
  const colList = pickHeaderMatch(headers, ["list", "project", "area"], used);
  const colSection = pickHeaderMatch(headers, ["section", "stage", "group", "column"], used);
  const colTags = pickHeaderMatch(headers, ["tags", "tag", "labels", "label", "category", "categories"], used);
  const colPriority = pickHeaderMatch(headers, ["priority", "importance", "urgency"], used);
  const colStart = pickHeaderMatch(headers, ["start", "start date", "start_date"], used);
  const colDue = pickHeaderMatch(headers, ["due", "due date", "due_date", "date", "deadline"], used);
  const colNotes = pickHeaderMatch(headers, ["notes", "note", "description", "summary", "details"], used);
  const colAssignee = pickHeaderMatch(headers, ["assignee", "assigned to", "assign", "owner", "person"], used);
  const colParent = pickHeaderMatch(headers, ["parent item", "parent task", "parent", "parent-item"], used);
  const colSubItems = pickHeaderMatch(headers, ["sub-item", "sub-items", "subtasks"], used);
  const colFiles = pickHeaderMatch(headers, ["files & media", "files and media", "files", "attachments", "attachment"], used);
  const colId = pickHeaderMatch(headers, ["id", "uid"], used, false);

  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const defaultListName = opts.listName?.trim() || deriveListFromFileName(opts.fileName, "Notion Import");

  const listMap = new Map<string, ImportList>();
  const sectionMap = new Map<string, ImportSection>();
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();

  losses.push({
    category: "metadata",
    field: "view_export",
    reason: "Notion CSV exports cover the active database view only; separate page body Markdown files and page comments are not included",
  });

  reportUnmappedCsvColumns(headers, rows, used, losses);

  const titleToSource = new Map<string, string>();
  const idToSource = new Map<string, string>();
  const pendingParents: Array<{ task: ImportTask; rawParent: string }> = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const title = cell(row, colTitle) || "(Untitled)";
    const rawList = cell(row, colList);
    const listName = rawList || defaultListName;
    const isInbox = listName.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : listName;
    if (!isInbox && !listMap.has(listKey)) {
      listMap.set(listKey, { sourceKey: listKey, name: listName });
    }

    const secName = cell(row, colSection);
    let sectionKey: string | undefined;
    if (secName) {
      if (isInbox) {
        losses.push({
          category: "field_ignored",
          sourceItem: title,
          field: colSection ?? "section",
          reason: `Inbox does not support sections; section "${secName}" omitted`,
        });
      } else {
        sectionKey = `${listKey}\0${secName}`;
        if (!sectionMap.has(sectionKey)) {
          sectionMap.set(sectionKey, { sourceKey: sectionKey, listKey, name: secName, sortOrder: sectionMap.size * ORDER_STEP });
        }
      }
    }

    const taskTags = collectTagsIntoMap(cell(row, colTags), tagMap);

    const prio = parsePriorityToken(cell(row, colPriority));
    if (prio.lost) {
      losses.push({ category: "field_ignored", sourceItem: title, field: colPriority ?? "priority", reason: prio.lost });
    }

    const rawStatus = cell(row, colStatus);
    const rawDone = cell(row, colDone);
    const st = rawStatus
      ? parseStatusToken(rawStatus, { archivedStatus: -1, sourceName: "Notion" })
      : parseStatusToken(rawDone, { archivedStatus: -1, sourceName: "Notion" });
    if (st.lost) {
      losses.push({ category: "field_ignored", sourceItem: title, field: colStatus ?? colDone ?? "status", reason: st.lost });
    }

    const startRaw = cell(row, colStart);
    const dueRaw = cell(row, colDue);
    const parsedStart = startRaw ? parseNotionDateValue(startRaw, defaultTz) : null;
    const parsedDue = dueRaw ? parseNotionDateValue(dueRaw, defaultTz) : null;
    if (startRaw && !parsedStart) {
      losses.push({ category: "invalid_date", sourceItem: title, field: colStart ?? "Start", reason: `Could not parse Notion date "${startRaw}"` });
    }
    if (dueRaw && !parsedDue) {
      losses.push({ category: "invalid_date", sourceItem: title, field: colDue ?? "Due", reason: `Could not parse Notion date "${dueRaw}"` });
    }
    const effectiveStart = parsedStart?.start ?? parsedDue?.start;
    const effectiveDue = parsedDue?.due ?? parsedStart?.due;

    let notes = cell(row, colNotes);
    const filesRaw = cell(row, colFiles);
    if (filesRaw) {
      const links = formatFilesMediaLinks(filesRaw);
      if (links.length > 0) notes = appendNoteBlock(notes, links.join("\n"));
      losses.push({
        category: "attachment",
        sourceItem: title,
        field: colFiles ?? "Files & media",
        count: links.length || 1,
        reason: "Notion Files & media cannot transfer binary files; URLs/filenames preserved in notes",
      });
    }

    const assignee = cell(row, colAssignee);
    if (assignee) {
      losses.push({
        category: "assignee",
        sourceItem: title,
        field: colAssignee ?? "Assignee",
        reason: `Notion assignee "${assignee}" could not be carried over`,
      });
    }

    const rawId = cell(row, colId);
    const sourceId = rawId || keyer.next(`${listKey}\0${title}`);
    if (rawId && !idToSource.has(rawId)) idToSource.set(rawId, sourceId);
    if (!titleToSource.has(`${listKey}\0${title}`)) titleToSource.set(`${listKey}\0${title}`, sourceId);

    const task: ImportTask = {
      sourceId,
      listKey,
      ...(sectionKey ? { sectionKey } : {}),
      title,
      kind: "TEXT",
      ...(notes ? { content: notes } : {}),
      status: st.status,
      priority: prio.priority,
      ...(effectiveStart
        ? {
            startDate: effectiveStart.wireDate,
            dueDate: (effectiveDue && effectiveDue.ms >= effectiveStart.ms ? effectiveDue : effectiveStart).wireDate,
            isAllDay: effectiveStart.isAllDay,
            isFloating: effectiveStart.isFloating,
            timeZone: effectiveStart.timeZone,
          }
        : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    };

    const rawParent = cell(row, colParent);
    if (rawParent) {
      const parentEntries = rawParent
        .split(",")
        .map((x) => stripNotionRelationUrl(x.trim()))
        .filter(Boolean);
      if (parentEntries.length > 1) {
        losses.push({
          category: "metadata",
          sourceItem: title,
          field: colParent ?? "Parent item",
          reason: `Multiple Notion parent items (${parentEntries.join(", ")}); linked to "${parentEntries[0]}" only`,
        });
      }
      if (parentEntries[0]) pendingParents.push({ task, rawParent: parentEntries[0] });
    } else if (colSubItems && cell(row, colSubItems)) {
      // Sub-items column acknowledged to avoid false unmapped_column noise
    }

    tasks.push(task);
  }

  for (const { task, rawParent } of pendingParents) {
    const target = idToSource.get(rawParent) ?? titleToSource.get(`${task.listKey}\0${rawParent}`);
    if (target) task.parentSourceId = target;
    else {
      losses.push({
        category: "subtask_cross_list",
        sourceItem: task.title,
        field: colParent ?? "Parent item",
        reason: `Notion parent reference "${rawParent}" not found in list "${task.listKey}"`,
      });
    }
  }

  return finalizeBundle({
    source: "notion",
    sourceLabel: "Notion",
    folders: [],
    lists: [...listMap.values()],
    sections: [...sectionMap.values()],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}
