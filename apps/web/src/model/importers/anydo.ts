import { convertRruleToRepeatFlag, convertTodoistRepeatToRepeatFlag } from "@noortasks/recurrence";
import { ORDER_STEP, formatServerDate } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import {
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
  ImportChecklistItem,
  ImportList,
  ImportLossItem,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

function parseAnydoDate(raw: string, defaultTz: string): ParsedDateValue | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const ms = s.length === 10 ? n * 1000 : n;
    if (Number.isFinite(ms)) {
      return { wireDate: formatServerDate(ms), ms, isAllDay: false, isFloating: false, timeZone: defaultTz };
    }
  }
  return parseFlexibleDate(s, { defaultTimeZone: defaultTz });
}

function splitChecklistCell(raw: string): ImportChecklistItem[] {
  return raw
    .split(/\r?\n|\s*[;|]\s*/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((title, idx) => ({
      title,
      status: 0,
      sortOrder: idx * ORDER_STEP,
    }));
}

function parseAnydoCsvBundle(text: string, opts: ParseImportOptions): ImportBundle {
  const { headers, rows } = parseCsvTable(text, "Any.do CSV file is empty");
  const colIdx = buildHeaderIndex(headers);
  const cell = (row: string[], headerName: string | undefined): string => csvCell(row, colIdx, headerName);

  const used = new Set<string>();
  const colTitle = pickHeaderMatch(headers, ["title", "task", "task name", "name", "content"], used) ?? headers[0]!;
  used.add(colTitle);
  const colList = pickHeaderMatch(headers, ["category", "list", "board", "project"], used);
  const colNotes = pickHeaderMatch(headers, ["notes", "note", "description", "details"], used);
  const colDue = pickHeaderMatch(headers, ["due date", "due", "alert", "date"], used);
  const colPriority = pickHeaderMatch(headers, ["priority", "important", "importance"], used);
  const colStatus = pickHeaderMatch(headers, ["status", "state", "completed", "done", "archived"], used);
  const colArchivedDate = pickHeaderMatch(headers, ["archived date", "completed date", "completed at"], used);
  const colCreatedDate = pickHeaderMatch(headers, ["created date", "created at", "created"], used);
  const colTags = pickHeaderMatch(headers, ["tags", "labels", "tag"], used);
  const colSubtasks = pickHeaderMatch(headers, ["subtasks", "subtask", "checklist", "steps"], used);
  const colParent = pickHeaderMatch(headers, ["parent", "parent task", "subtask of"], used);
  const colRepeat = pickHeaderMatch(headers, ["repeat", "recurrence", "rrule"], used);
  const colAssignee = pickHeaderMatch(headers, ["assigned to", "assignee", "owner"], used);
  const colId = pickHeaderMatch(headers, ["id", "uid"], used, false);

  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const defaultListName = opts.listName?.trim() || "Personal";

  const listMap = new Map<string, ImportList>();
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [
    {
      category: "metadata",
      field: "archived_export",
      reason: "Any.do native CSV exports include archived tasks only; active personal lists export as PDF only",
    },
  ];
  const keyer = new OccurrenceKeyer();

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

    const notes = cell(row, colNotes);
    const taskTags = collectTagsIntoMap(cell(row, colTags), tagMap);

    const rawPriority = cell(row, colPriority);
    const prio = rawPriority.toLowerCase() === "true" || rawPriority.toLowerCase() === "yes"
      ? { priority: 5 as const }
      : parsePriorityToken(rawPriority, { normalPriority: 0 });
    if (prio.lost) {
      losses.push({ category: "field_ignored", sourceItem: title, field: colPriority ?? "Priority", reason: prio.lost });
    }

    const rawStatus = cell(row, colStatus);
    const rawArchivedDate = cell(row, colArchivedDate);
    let status: 0 | 2 | -1 = 0;
    if (rawStatus) {
      // Archived tasks in Any.do's Archived Tasks CSV export represent completed & archived items
      const st = parseStatusToken(rawStatus, { archivedStatus: 2, sourceName: "Any.do" });
      status = st.status;
      if (st.lost) {
        losses.push({ category: "field_ignored", sourceItem: title, field: colStatus ?? "Status", reason: st.lost });
      }
    } else if (rawArchivedDate) {
      status = 2;
    }

    const dueRaw = cell(row, colDue);
    const dueParsed = dueRaw ? parseAnydoDate(dueRaw, defaultTz) : null;
    if (dueRaw && !dueParsed) {
      losses.push({ category: "invalid_date", sourceItem: title, field: colDue ?? "Due Date", reason: `Could not parse Any.do date "${dueRaw}"` });
    }

    const archivedParsed = rawArchivedDate ? parseAnydoDate(rawArchivedDate, defaultTz) : null;
    const createdRaw = cell(row, colCreatedDate);
    const createdParsed = createdRaw ? parseAnydoDate(createdRaw, defaultTz) : null;

    let repeatFlag: string | undefined;
    let repeatFrom: "0" | "1" | "2" | undefined;
    const repeatRaw = cell(row, colRepeat);
    if (repeatRaw) {
      const conv = /^(?:RRULE|ERULE|LUNAR):|FREQ=/i.test(repeatRaw)
        ? convertRruleToRepeatFlag(repeatRaw)
        : convertTodoistRepeatToRepeatFlag(repeatRaw);
      if (conv.repeatFlag) {
        repeatFlag = conv.repeatFlag;
        repeatFrom = conv.repeatFrom;
      }
      if (conv.lostReason) {
        losses.push({ category: "unsupported_recurrence", sourceItem: title, field: colRepeat ?? "Repeat", reason: conv.lostReason });
      }
    }

    const assignee = cell(row, colAssignee);
    if (assignee) {
      losses.push({
        category: "assignee",
        sourceItem: title,
        field: colAssignee ?? "Assigned To",
        reason: `Any.do assignee "${assignee}" could not be carried over`,
      });
    }

    const items = splitChecklistCell(cell(row, colSubtasks));
    const isChecklist = items.length > 0;
    const rawId = cell(row, colId);
    const sourceId = rawId || keyer.next(`${listKey}\0${title}`);
    if (rawId && !idToSource.has(rawId)) idToSource.set(rawId, sourceId);
    if (!titleToSource.has(`${listKey}\0${title}`)) titleToSource.set(`${listKey}\0${title}`, sourceId);

    const task: ImportTask = {
      sourceId,
      listKey,
      title,
      kind: isChecklist ? "CHECKLIST" : "TEXT",
      ...(isChecklist ? { ...(notes ? { desc: notes } : {}), items } : notes ? { content: notes } : {}),
      status,
      priority: prio.priority,
      ...(dueParsed
        ? {
            startDate: dueParsed.wireDate,
            dueDate: dueParsed.wireDate,
            isAllDay: dueParsed.isAllDay,
            isFloating: dueParsed.isFloating,
            timeZone: dueParsed.timeZone,
          }
        : {}),
      ...(repeatFlag ? { repeatFlag } : {}),
      ...(repeatFrom ? { repeatFrom } : {}),
      ...(createdParsed ? { createdTime: createdParsed.wireDate } : {}),
      ...(archivedParsed && status !== 0 ? { completedTime: archivedParsed.wireDate } : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    };

    const rawParent = cell(row, colParent);
    if (rawParent) pendingParents.push({ task, rawParent });
    tasks.push(task);
  }

  for (const { task, rawParent } of pendingParents) {
    const target = idToSource.get(rawParent) ?? titleToSource.get(`${task.listKey}\0${rawParent}`);
    if (target) task.parentSourceId = target;
    else {
      losses.push({
        category: "subtask_cross_list",
        sourceItem: task.title,
        field: colParent ?? "Parent",
        reason: `Parent task "${rawParent}" not found in list "${task.listKey}"`,
      });
    }
  }

  return finalizeBundle({
    source: "anydo",
    sourceLabel: "Any.do",
    folders: [],
    lists: [...listMap.values()],
    sections: [],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}

function parseAnydoJsonBundle(text: string, opts: ParseImportOptions): ImportBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid Any.do JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const doc = Array.isArray(raw) ? { tasks: raw } : (raw as Record<string, unknown>);
  const rawTasks = Array.isArray(doc?.tasks)
    ? (doc.tasks as Array<Record<string, unknown>>)
    : Array.isArray(doc?.items)
      ? (doc.items as Array<Record<string, unknown>>)
      : null;
  if (!rawTasks) {
    throw new Error("Any.do JSON must contain a tasks or items array");
  }

  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const fallbackList = opts.listName?.trim() || deriveListFromFileName(opts.fileName, "Personal");
  const listMap = new Map<string, ImportList>();
  const catNames = new Map<string, string>();
  if (Array.isArray(doc.categories)) {
    for (const c of doc.categories as Array<Record<string, unknown>>) {
      if (!c || typeof c !== "object") continue;
      const cid = String(c.id ?? "");
      const cname = String(c.name ?? "").trim();
      if (cid && cname) catNames.set(cid, cname);
    }
  }

  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();

  for (const t of rawTasks) {
    if (!t || typeof t !== "object") continue;
    const title = String(t.title ?? "").trim() || "(Untitled)";
    const rawStatus = String(t.status ?? "").toUpperCase();
    if (rawStatus === "DELETED") {
      losses.push({ category: "metadata", sourceItem: title, field: "status", reason: `Deleted Any.do task "${title}" skipped` });
      continue;
    }
    const status: 0 | 2 = rawStatus === "CHECKED" || rawStatus === "DONE" || rawStatus === "COMPLETED" ? 2 : 0;

    const cid = typeof t.categoryId === "string" ? t.categoryId : "";
    const listName = (cid ? catNames.get(cid) : undefined) || (typeof t.category === "string" ? t.category.trim() : "") || fallbackList;
    const isInbox = listName.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : listName;
    if (!isInbox && !listMap.has(listKey)) listMap.set(listKey, { sourceKey: listKey, name: listName });

    const notes = typeof t.note === "string" ? t.note.trim() : typeof t.notes === "string" ? t.notes.trim() : "";
    const prio = parsePriorityToken(String(t.priority ?? ""), { normalPriority: 0 });
    const dueRaw = t.dueDate ?? t.due;
    const dueParsed = dueRaw !== undefined && dueRaw !== null && String(dueRaw).trim()
      ? parseAnydoDate(String(dueRaw), defaultTz)
      : null;

    const rawSubs = Array.isArray(t.subTasks) ? (t.subTasks as Array<Record<string, unknown>>) : [];
    const items: ImportChecklistItem[] = rawSubs
      .filter((s) => s && typeof s === "object" && String(s.title ?? "").trim())
      .map((s, idx) => ({
        title: String(s.title).trim(),
        status: String(s.status ?? "").toUpperCase() === "CHECKED" || String(s.status ?? "").toUpperCase() === "DONE" ? 1 : 0,
        sortOrder: idx * ORDER_STEP,
      }));
    const isChecklist = items.length > 0;
    const sourceId = typeof t.id === "string" && t.id.trim() ? t.id.trim() : keyer.next(`${listKey}\0${title}`);

    tasks.push({
      sourceId,
      listKey,
      title,
      kind: isChecklist ? "CHECKLIST" : "TEXT",
      ...(isChecklist ? { ...(notes ? { desc: notes } : {}), items } : notes ? { content: notes } : {}),
      status,
      priority: prio.priority,
      ...(dueParsed
        ? {
            startDate: dueParsed.wireDate,
            dueDate: dueParsed.wireDate,
            isAllDay: dueParsed.isAllDay,
            isFloating: dueParsed.isFloating,
            timeZone: dueParsed.timeZone,
          }
        : {}),
      tags: [],
      sortOrder: tasks.length * ORDER_STEP,
    });
  }

  return finalizeBundle({
    source: "anydo",
    sourceLabel: "Any.do",
    folders: [],
    lists: [...listMap.values()],
    sections: [],
    tags: [],
    tasks,
    losses,
  });
}

/** Parse Any.do CSV (archived tasks export) or JSON export into ImportBundle. */
export function parseAnydoBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseAnydoJsonBundle(trimmed, opts);
  }
  return parseAnydoCsvBundle(text, opts);
}
