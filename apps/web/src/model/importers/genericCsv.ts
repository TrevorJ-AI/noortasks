import { convertRruleToRepeatFlag, convertTodoistRepeatToRepeatFlag } from "@noortasks/recurrence";
import { ORDER_STEP } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import {
  buildHeaderIndex,
  collectTagsIntoMap,
  csvCell,
  parseCsvTable,
  parsePriorityToken,
  parseStatusToken,
  pickHeaderMatch,
  reportUnmappedCsvColumns,
} from "./csvCommon";
import { finalizeBundle, parseFlexibleDate, resolveTimeZone } from "./dates";
import { OccurrenceKeyer } from "./ids";
import type {
  CsvColumnMapping,
  CsvInspection,
  ImportBundle,
  ImportList,
  ImportLossItem,
  ImportSection,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

const HEADER_ALIASES: Record<keyof CsvColumnMapping, string[]> = {
  title: ["title", "task name", "task_name", "task", "name", "summary", "subject", "todo", "item", "content"],
  notes: ["notes", "note", "description", "desc", "body", "details", "memo"],
  list: ["list", "list name", "project", "folder", "category", "board", "group"],
  section: ["section", "column", "column name", "board stage", "stage", "bucket"],
  tags: ["tags", "tag", "labels", "label", "contexts", "context"],
  priority: ["priority", "prio", "importance", "urgency"],
  status: ["status", "completed", "done", "state", "checked"],
  startDate: ["start", "start date", "start_date", "startdate", "dtstart"],
  dueDate: ["due", "due date", "due_date", "duedate", "deadline", "date"],
  timeZone: ["timezone", "time zone", "tz", "time_zone"],
  repeat: ["repeat", "recurrence", "rrule", "repeating", "schedule"],
  parent: ["parent", "parentid", "parent_id", "parent task"],
  id: ["id", "taskid", "task_id", "external id", "external_id", "uid"],
};

function guessMapping(headers: string[]): CsvColumnMapping {
  const used = new Set<string>();
  const titleExact = pickHeaderMatch(headers, HEADER_ALIASES.title, used, false);
  const idExact = pickHeaderMatch(headers, HEADER_ALIASES.id, used, false);
  const notes = pickHeaderMatch(headers, HEADER_ALIASES.notes, used);
  const list = pickHeaderMatch(headers, HEADER_ALIASES.list, used);
  const section = pickHeaderMatch(headers, HEADER_ALIASES.section, used);
  const tags = pickHeaderMatch(headers, HEADER_ALIASES.tags, used);
  const priority = pickHeaderMatch(headers, HEADER_ALIASES.priority, used);
  const status = pickHeaderMatch(headers, HEADER_ALIASES.status, used);
  const startDate = pickHeaderMatch(headers, HEADER_ALIASES.startDate, used);
  const dueDate = pickHeaderMatch(headers, HEADER_ALIASES.dueDate, used);
  const timeZone = pickHeaderMatch(headers, HEADER_ALIASES.timeZone, used);
  const repeat = pickHeaderMatch(headers, HEADER_ALIASES.repeat, used);
  const parent = pickHeaderMatch(headers, HEADER_ALIASES.parent, used);

  const title = titleExact ?? pickHeaderMatch(headers, HEADER_ALIASES.title, used) ?? headers.find((h) => !used.has(h)) ?? headers[0] ?? "Title";
  used.add(title);
  const id = idExact ?? pickHeaderMatch(headers, HEADER_ALIASES.id, used);

  return {
    title,
    ...(notes ? { notes } : {}),
    ...(list ? { list } : {}),
    ...(section ? { section } : {}),
    ...(tags ? { tags } : {}),
    ...(priority ? { priority } : {}),
    ...(status ? { status } : {}),
    ...(startDate ? { startDate } : {}),
    ...(dueDate ? { dueDate } : {}),
    ...(timeZone ? { timeZone } : {}),
    ...(repeat ? { repeat } : {}),
    ...(parent ? { parent } : {}),
    ...(id ? { id } : {}),
  };
}

export function inspectGenericCsv(text: string): CsvInspection {
  const { headers, rows } = parseCsvTable(text);
  return {
    headers,
    sampleRows: rows.slice(1, 6),
    suggested: guessMapping(headers),
  };
}

export function parseGenericCsvBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  const { headers, rows } = parseCsvTable(text);
  const mapping = opts.csvMapping ?? guessMapping(headers);
  const colIdx = buildHeaderIndex(headers);
  const cell = (row: string[], headerName: string | undefined): string => csvCell(row, colIdx, headerName);

  const mappedHeaders = new Set(Object.values(mapping).filter((v): v is string => Boolean(v)));
  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const listMap = new Map<string, ImportList>();
  const sectionMap = new Map<string, ImportSection>();
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();

  reportUnmappedCsvColumns(headers, rows, mappedHeaders, losses);

  const idToSource = new Map<string, string>();
  const titleToSource = new Map<string, string>();
  const pendingParents: Array<{ task: ImportTask; rawParent: string }> = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    const title = cell(row, mapping.title) || "(Untitled)";
    const notes = cell(row, mapping.notes);
    const rawList = cell(row, mapping.list);
    const listName = rawList || (opts.listName?.trim() || "Inbox");
    const isInbox = listName.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : listName;
    if (!isInbox && !listMap.has(listKey)) {
      listMap.set(listKey, { sourceKey: listKey, name: listName });
    }

    const colName = cell(row, mapping.section);
    let sectionKey: string | undefined;
    if (colName) {
      if (isInbox) {
        losses.push({
          category: "field_ignored",
          sourceItem: title,
          field: mapping.section ?? "section",
          reason: `Inbox does not support sections; section "${colName}" omitted`,
        });
      } else {
        sectionKey = `${listKey}\0${colName}`;
        if (!sectionMap.has(sectionKey)) {
          sectionMap.set(sectionKey, { sourceKey: sectionKey, listKey, name: colName, sortOrder: sectionMap.size * ORDER_STEP });
        }
      }
    }

    const taskTags = collectTagsIntoMap(cell(row, mapping.tags), tagMap);

    const prio = parsePriorityToken(cell(row, mapping.priority));
    if (prio.lost) losses.push({ category: "field_ignored", sourceItem: title, field: mapping.priority ?? "priority", reason: prio.lost });

    const st = parseStatusToken(cell(row, mapping.status));
    if (st.lost) losses.push({ category: "field_ignored", sourceItem: title, field: mapping.status ?? "status", reason: st.lost });

    const tzRaw = cell(row, mapping.timeZone);
    const tzInfo = resolveTimeZone(tzRaw, defaultTz);
    if (tzInfo.lost) losses.push({ category: "field_ignored", sourceItem: title, field: mapping.timeZone ?? "timeZone", reason: tzInfo.lost });

    const startRaw = cell(row, mapping.startDate);
    const dueRaw = cell(row, mapping.dueDate);
    const parsedStart = startRaw ? parseFlexibleDate(startRaw, { timeZone: tzRaw, defaultTimeZone: defaultTz }) : null;
    const parsedDue = dueRaw ? parseFlexibleDate(dueRaw, { timeZone: tzRaw, defaultTimeZone: defaultTz }) : null;
    if (startRaw && !parsedStart) losses.push({ category: "invalid_date", sourceItem: title, field: mapping.startDate ?? "startDate", reason: `Could not parse start date "${startRaw}"` });
    if (dueRaw && !parsedDue) losses.push({ category: "invalid_date", sourceItem: title, field: mapping.dueDate ?? "dueDate", reason: `Could not parse due date "${dueRaw}"` });

    const effectiveStart = parsedStart ?? parsedDue;
    const effectiveDue = parsedDue ?? parsedStart;

    let repeatFlag: string | undefined;
    let repeatFrom: "0" | "1" | "2" | undefined;
    const repeatRaw = cell(row, mapping.repeat);
    if (repeatRaw) {
      const conv = /^(?:RRULE|ERULE|LUNAR):|FREQ=/i.test(repeatRaw)
        ? convertRruleToRepeatFlag(repeatRaw)
        : convertTodoistRepeatToRepeatFlag(repeatRaw);
      if (conv.repeatFlag) {
        repeatFlag = conv.repeatFlag;
        repeatFrom = conv.repeatFrom;
      }
      if (conv.lostReason) {
        losses.push({ category: "unsupported_recurrence", sourceItem: title, field: mapping.repeat ?? "repeat", reason: conv.lostReason });
      }
    }

    const mappedId = cell(row, mapping.id);
    const sourceId = mappedId || keyer.next(`${listKey}\0${title}\0${effectiveStart?.wireDate ?? ""}`);
    if (mappedId && !idToSource.has(mappedId)) idToSource.set(mappedId, sourceId);
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
      ...(effectiveStart ? {
        startDate: effectiveStart.wireDate,
        dueDate: (effectiveDue && effectiveDue.ms >= effectiveStart.ms ? effectiveDue : effectiveStart).wireDate,
        isAllDay: effectiveStart.isAllDay,
        isFloating: effectiveStart.isFloating,
        timeZone: effectiveStart.timeZone,
      } : {}),
      ...(repeatFlag ? { repeatFlag } : {}),
      ...(repeatFrom ? { repeatFrom } : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    };

    const rawParent = cell(row, mapping.parent);
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
        field: mapping.parent ?? "parent",
        reason: `Parent reference "${rawParent}" not found in list "${task.listKey}"`,
      });
    }
  }

  return finalizeBundle({
    source: "genericCsv",
    sourceLabel: "Generic CSV",
    folders: [],
    lists: [...listMap.values()],
    sections: [...sectionMap.values()],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}
