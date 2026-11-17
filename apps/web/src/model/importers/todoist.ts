import { convertTodoistRepeatToRepeatFlag } from "@noortasks/recurrence";
import { MAX_TASK_DEPTH, ORDER_STEP, formatServerDate, wallToInstant, zonedParts } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import { parseCsv } from "../backupCsv";
import { finalizeBundle, parseFlexibleDate, resolveTimeZone } from "./dates";
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

const TODOIST_COLORS: Record<string, string> = {
  berry_red: "#b8256f",
  red: "#db4035",
  orange: "#ff9933",
  yellow: "#fad000",
  olive_green: "#afb83b",
  lime_green: "#7ecc49",
  green: "#299438",
  mint_green: "#6accbc",
  teal: "#158fad",
  sky_blue: "#14aaf5",
  light_blue: "#96c3eb",
  blue: "#4073ff",
  grape: "#884dff",
  violet: "#af38eb",
  lavender: "#eb96eb",
  magenta: "#e05194",
  salmon: "#ff8d85",
  charcoal: "#808080",
  grey: "#b8b8b8",
  taupe: "#ccac93",
};

function mapTodoistColor(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return TODOIST_COLORS[s] ?? null;
}

function mapCsvPriority(raw: string): { priority: 0 | 1 | 3 | 5; lost?: string } {
  const s = raw.trim();
  if (!s || s === "4") return { priority: 0 };
  if (s === "1") return { priority: 5 };
  if (s === "2") return { priority: 3 };
  if (s === "3") return { priority: 1 };
  return { priority: 0, lost: `Unrecognized Todoist CSV priority "${s}" defaulted to None` };
}

function mapApiPriority(raw: unknown): 0 | 1 | 3 | 5 {
  const n = Number(raw);
  if (n === 4) return 5;
  if (n === 3) return 3;
  if (n === 2) return 1;
  return 0;
}

function extractInlineLabels(text: string): { title: string; labels: string[] } {
  const labels: string[] = [];
  const cleaned = text
    .replace(/(^|\s)@([^\s@#]+)/g, (_, lead: string, tag: string) => {
      labels.push(tag);
      return lead;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { title: cleaned || text.trim(), labels };
}

function deriveListName(opts: ParseImportOptions): string {
  if (opts.listName && opts.listName.trim()) return opts.listName.trim();
  if (opts.fileName && opts.fileName.trim()) {
    const base = opts.fileName.trim().replace(/^.*[/\\]/, "").replace(/\.csv$/i, "");
    const stripped = base.replace(/\s*\[\d+\]$/, "").replace(/\s*\(\d+\)$/, "").trim();
    if (stripped) return stripped;
  }
  return "Todoist Import";
}

function parseTodoistDateAndRepeat(
  dateRaw: string,
  dateLang: string,
  tz: string,
  defaultTz: string,
  nowMs: number,
  taskTitle: string,
  losses: ImportLossItem[],
  isCsv: boolean,
): {
  startDate?: string;
  dueDate?: string;
  startMs?: number;
  isAllDay?: boolean;
  isFloating?: boolean;
  timeZone: string;
  repeatFlag?: string;
  repeatFrom?: "0" | "1" | "2";
} {
  const tzInfo = resolveTimeZone(tz, defaultTz);
  if (tzInfo.lost) {
    losses.push({ category: "field_ignored", sourceItem: taskTitle, field: "TIMEZONE", reason: tzInfo.lost });
  }
  const zone = tzInfo.zone;
  const s = dateRaw.trim();
  if (!s) return { timeZone: zone };

  // Check if the DATE value starts with an explicit date followed by a recurrence phrase
  const leadingDateRe = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?)\s+((?:every|ev|daily|weekly|monthly|yearly|annually|after)\b.*)$/i;
  const leadM = leadingDateRe.exec(s);
  const looksLikeRepeat =
    Boolean(leadM) ||
    /^(?:every|ev|daily|everyday|weekly|biweekly|bimonthly|monthly|quarterly|semi-?annually|semiannually|biyearly|biannually|yearly|annually|after)\b/i.test(s) ||
    /\bevery!/i.test(s);

  if (looksLikeRepeat) {
    const leadDateStr = leadM?.[1];
    const repeatExpr = leadM?.[2] ?? s;
    const conv = convertTodoistRepeatToRepeatFlag(repeatExpr, dateLang ? { dateLang } : {});

    if (conv.lostReason) {
      losses.push({
        category: "unsupported_recurrence",
        sourceItem: taskTitle,
        field: "DATE",
        reason: conv.lostReason,
      });
    }

    let anchorMs: number | undefined;
    let anchorAllDay = true;
    let anchorFloating = !tz.trim();

    if (leadDateStr) {
      const parsedLead = parseFlexibleDate(leadDateStr, { timeZone: tz, defaultTimeZone: defaultTz });
      if (parsedLead) {
        anchorMs = parsedLead.ms;
        anchorAllDay = parsedLead.isAllDay;
        anchorFloating = parsedLead.isFloating;
      }
    } else if (conv.startDateIso) {
      const parsedStart = parseFlexibleDate(conv.startDateIso, { timeZone: tz, defaultTimeZone: defaultTz });
      if (parsedStart) {
        anchorMs = parsedStart.ms;
        anchorAllDay = true;
        anchorFloating = !tz.trim();
      }
    }

    if (anchorMs === undefined) {
      const p = zonedParts(nowMs, zone);
      anchorMs = wallToInstant(p.y, p.m, p.d, 0, 0, 0, zone);
      if (isCsv && conv.repeatFlag) {
        losses.push({
          category: "recurrence_start_lost",
          sourceItem: taskTitle,
          field: "DATE",
          reason: "Todoist CSV omits original start date for recurring tasks; anchored to import date",
        });
      }
    }

    if (conv.time) {
      const p = zonedParts(anchorMs, zone);
      anchorMs = wallToInstant(p.y, p.m, p.d, conv.time.hour, conv.time.minute, 0, zone);
      anchorAllDay = false;
    }

    if (conv.repeatFlag) {
      const wire = formatServerDate(anchorMs);
      return {
        startDate: wire,
        dueDate: wire,
        startMs: anchorMs,
        isAllDay: anchorAllDay,
        isFloating: anchorFloating,
        timeZone: zone,
        repeatFlag: conv.repeatFlag,
        ...(conv.repeatFrom ? { repeatFrom: conv.repeatFrom } : {}),
      };
    }

    if (leadDateStr) {
      const parsedLead = parseFlexibleDate(leadDateStr, { timeZone: tz, defaultTimeZone: defaultTz });
      if (parsedLead) {
        return {
          startDate: parsedLead.wireDate,
          dueDate: parsedLead.wireDate,
          startMs: parsedLead.ms,
          isAllDay: parsedLead.isAllDay,
          isFloating: parsedLead.isFloating,
          timeZone: parsedLead.timeZone,
        };
      }
    }
    return { timeZone: zone };
  }

  const parsed = parseFlexibleDate(s, { timeZone: tz, defaultTimeZone: defaultTz });
  if (!parsed) {
    losses.push({
      category: "invalid_date",
      sourceItem: taskTitle,
      field: "DATE",
      reason: `Could not parse date "${s}"`,
    });
    return { timeZone: zone };
  }

  return {
    startDate: parsed.wireDate,
    dueDate: parsed.wireDate,
    startMs: parsed.ms,
    isAllDay: parsed.isAllDay,
    isFloating: parsed.isFloating,
    timeZone: parsed.timeZone,
  };
}

function parseTodoistCsvBundle(text: string, opts: ParseImportOptions): ImportBundle {
  const rows = parseCsv(text);
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) throw new Error("Todoist CSV file is empty");

  const headers = nonEmpty[0]!.map((h) => h.trim().toLowerCase());
  if (!headers.includes("type") || !headers.includes("content")) {
    throw new Error("This CSV does not have Todoist TYPE and CONTENT columns");
  }
  const idxOf = (col: string): number => headers.indexOf(col);
  const cell = (row: string[], col: string): string => {
    const i = idxOf(col);
    return i >= 0 && i < row.length ? (row[i] ?? "") : "";
  };

  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const nowMs = opts.now ?? Date.now();
  const listName = deriveListName(opts);
  const isInbox = listName.toLowerCase() === "inbox";
  const listKey = isInbox ? "Inbox" : listName;
  const lists: ImportList[] = isInbox ? [] : [{ sourceKey: listKey, name: listName, viewMode: "list" }];
  const sections: ImportSection[] = [];
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();

  let currentSectionKey: string | undefined;
  const indentStack: Array<{ indent: number; sourceId: string; sectionKey?: string }> = [];
  let lastTask: ImportTask | undefined;
  let sawAuthor = false;

  for (let r = 1; r < nonEmpty.length; r++) {
    const row = nonEmpty[r]!;
    const type = cell(row, "type").trim().toLowerCase();
    const rawContent = cell(row, "content").trim();
    if (!type && !rawContent) continue;

    if (type === "section") {
      if (!rawContent) {
        losses.push({ category: "parse_warning", reason: `Row ${r + 1}: empty section name skipped` });
        continue;
      }
      if (isInbox) {
        losses.push({
          category: "field_ignored",
          sourceItem: rawContent,
          field: "section",
          reason: `Inbox does not support sections; section "${rawContent}" flattened`,
        });
        currentSectionKey = undefined;
      } else {
        const sk = `${listKey}\0${rawContent}`;
        if (!sections.some((s) => s.sourceKey === sk)) {
          sections.push({ sourceKey: sk, listKey, name: rawContent, sortOrder: sections.length * ORDER_STEP });
        }
        currentSectionKey = sk;
      }
      indentStack.length = 0;
      lastTask = undefined;
      continue;
    }

    if (type === "note") {
      if (lastTask && rawContent) {
        lastTask.content = lastTask.content ? `${lastTask.content}\n\nComment: ${rawContent}` : `Comment: ${rawContent}`;
        losses.push({
          category: "comment",
          sourceItem: lastTask.title,
          field: "TYPE=note",
          reason: "Todoist CSV comment merged into task notes (separate comment metadata not preserved)",
        });
      } else if (rawContent) {
        losses.push({
          category: "comment",
          field: "TYPE=note",
          reason: `Orphaned comment row "${rawContent.slice(0, 40)}" skipped`,
        });
      }
      continue;
    }

    if (type !== "task") {
      losses.push({ category: "parse_warning", sourceItem: rawContent || `Row ${r + 1}`, reason: `Unsupported Todoist CSV row TYPE "${type}" skipped` });
      continue;
    }

    const { title, labels: inlineLabels } = extractInlineLabels(rawContent);
    const colLabels = cell(row, "labels")
      .split(",")
      .map((x) => x.trim().replace(/^@/, ""))
      .filter(Boolean);
    const taskTags: string[] = [];
    for (const lbl of [...inlineLabels, ...colLabels]) {
      const low = lbl.toLowerCase();
      if (!taskTags.includes(low)) taskTags.push(low);
      if (!tagMap.has(low)) tagMap.set(low, { name: low, label: lbl });
    }

    const indentRaw = cell(row, "indent").trim();
    const indentNum = indentRaw ? Number(indentRaw) : 1;
    const indent = Number.isInteger(indentNum) && indentNum >= 1 ? indentNum : 1;

    while (indentStack.length > 0 && indentStack[indentStack.length - 1]!.indent >= indent) {
      indentStack.pop();
    }
    let parentEntry = indentStack[indentStack.length - 1];
    if (indent > 1 && !parentEntry) {
      losses.push({
        category: "parse_warning",
        sourceItem: title,
        field: "INDENT",
        reason: `Subtask indent ${indent} had no preceding parent task; imported as top-level task`,
      });
    } else if (indentStack.length >= MAX_TASK_DEPTH) {
      losses.push({
        category: "subtask_depth",
        sourceItem: title,
        field: "INDENT",
        reason: `Subtask depth exceeded maximum of ${MAX_TASK_DEPTH} levels; promoted to level ${MAX_TASK_DEPTH}`,
      });
      parentEntry = indentStack[MAX_TASK_DEPTH - 2];
    }

    const prioRes = mapCsvPriority(cell(row, "priority"));
    if (prioRes.lost) {
      losses.push({ category: "field_ignored", sourceItem: title, field: "PRIORITY", reason: prioRes.lost });
    }

    const dateRaw = cell(row, "date").trim();
    const dateLang = cell(row, "date_lang").trim();
    const tzRaw = cell(row, "timezone").trim();
    const dateInfo = parseTodoistDateAndRepeat(dateRaw, dateLang, tzRaw, defaultTz, nowMs, title, losses, true);

    let notes = cell(row, "description").trim();
    const durRaw = cell(row, "duration").trim();
    const durUnit = cell(row, "duration_unit").trim().toLowerCase();
    let dueDate = dateInfo.dueDate;
    if (durRaw) {
      const dur = Number(durRaw);
      if (Number.isFinite(dur) && dur > 0) {
        const mins = durUnit.startsWith("day") ? dur * 1440 : dur;
        if (dateInfo.startMs !== undefined && dateInfo.isAllDay === false) {
          dueDate = formatServerDate(dateInfo.startMs + mins * 60_000);
        } else if (dateInfo.startMs !== undefined && dateInfo.isAllDay && durUnit.startsWith("day") && dur > 1) {
          dueDate = formatServerDate(dateInfo.startMs + dur * 86_400_000);
        } else {
          losses.push({
            category: "duration",
            sourceItem: title,
            field: "DURATION",
            reason: `Duration (${durRaw}${durUnit ? ` ${durUnit}` : "m"}) requires a timed start date`,
          });
        }
      }
    }

    let startDate = dateInfo.startDate;
    let isAllDay = dateInfo.isAllDay;
    let isFloating = dateInfo.isFloating;
    let timeZone = dateInfo.startDate ? dateInfo.timeZone : undefined;

    const deadlineRaw = cell(row, "deadline").trim();
    if (deadlineRaw) {
      const dl = parseFlexibleDate(deadlineRaw, { timeZone: tzRaw, defaultTimeZone: defaultTz });
      if (!startDate && dl) {
        startDate = dl.wireDate;
        dueDate = dl.wireDate;
        isAllDay = dl.isAllDay;
        isFloating = dl.isFloating;
        timeZone = dl.timeZone;
      } else {
        notes = notes ? `${notes}\n\nDeadline: ${deadlineRaw}` : `Deadline: ${deadlineRaw}`;
        losses.push({
          category: "metadata",
          sourceItem: title,
          field: "DEADLINE",
          reason: `Separate Todoist deadline (${deadlineRaw}) appended to task notes`,
        });
      }
    }

    const responsible = cell(row, "responsible").trim();
    if (responsible) {
      losses.push({
        category: "assignee",
        sourceItem: title,
        field: "RESPONSIBLE",
        reason: `Assignee "${responsible}" could not be carried over`,
      });
    }
    if (cell(row, "author").trim()) sawAuthor = true;

    const taskSectionKey = parentEntry ? parentEntry.sectionKey : currentSectionKey;
    const sourceId = keyer.next(`${listKey}\0${taskSectionKey ?? ""}\0${indent}\0${title}`);

    const task: ImportTask = {
      sourceId,
      listKey,
      ...(taskSectionKey ? { sectionKey: taskSectionKey } : {}),
      ...(parentEntry ? { parentSourceId: parentEntry.sourceId } : {}),
      title,
      kind: "TEXT",
      ...(notes ? { content: notes } : {}),
      status: 0,
      priority: prioRes.priority,
      ...(startDate ? { startDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(isAllDay !== undefined ? { isAllDay } : {}),
      ...(isFloating !== undefined ? { isFloating } : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(dateInfo.repeatFlag ? { repeatFlag: dateInfo.repeatFlag } : {}),
      ...(dateInfo.repeatFrom ? { repeatFrom: dateInfo.repeatFrom } : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    };

    tasks.push(task);
    lastTask = task;
    if (indentStack.length < MAX_TASK_DEPTH) {
      indentStack.push({ indent, sourceId, ...(taskSectionKey ? { sectionKey: taskSectionKey } : {}) });
    }
  }

  if (sawAuthor) {
    losses.push({
      category: "metadata",
      field: "AUTHOR",
      reason: "Todoist CSV task author metadata could not be carried over",
    });
  }
  losses.push({
    category: "completed_absent",
    field: "status",
    reason: "Todoist project CSV exports do not include completed tasks",
  });

  return finalizeBundle({
    source: "todoist",
    sourceLabel: "Todoist",
    folders: [],
    lists,
    sections,
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}

function parseTodoistJsonBundle(text: string, opts: ParseImportOptions): ImportBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid Todoist JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).items)) {
    throw new Error("Todoist JSON backup must contain an items array");
  }

  const doc = raw as Record<string, unknown>;
  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const nowMs = opts.now ?? Date.now();
  const losses: ImportLossItem[] = [];
  const lists: ImportList[] = [];
  const sections: ImportSection[] = [];
  const tagMap = new Map<string, ImportTag>();
  const projectKeyById = new Map<string, string>();
  const sectionKeyById = new Map<string, string>();

  const rawProjects = Array.isArray(doc.projects) ? (doc.projects as Array<Record<string, unknown>>) : [];
  for (const p of rawProjects) {
    if (!p || typeof p !== "object" || p.is_deleted) continue;
    const pid = String(p.id ?? "");
    const name = String(p.name ?? "Todoist Project").trim();
    const isInbox = Boolean(p.inbox_project) || name.toLowerCase() === "inbox";
    if (isInbox) {
      projectKeyById.set(pid, "Inbox");
      continue;
    }
    if (p.parent_id) {
      losses.push({
        category: "metadata",
        sourceItem: name,
        field: "parent_id",
        reason: `Nested Todoist project "${name}" flattened to top-level list`,
      });
    }
    if (p.is_archived) {
      losses.push({
        category: "metadata",
        sourceItem: name,
        field: "is_archived",
        reason: `Archived Todoist project "${name}" imported as active list`,
      });
    }
    const listKey = `proj:${pid || name}`;
    projectKeyById.set(pid, listKey);
    const viewStyle = String(p.view_style ?? "").toLowerCase();
    lists.push({
      sourceKey: listKey,
      name,
      viewMode: viewStyle === "board" || viewStyle === "kanban" ? "kanban" : "list",
      color: mapTodoistColor(p.color),
    });
  }

  const rawSections = Array.isArray(doc.sections) ? (doc.sections as Array<Record<string, unknown>>) : [];
  for (const s of rawSections) {
    if (!s || typeof s !== "object" || s.is_deleted) continue;
    const sid = String(s.id ?? "");
    const pid = String(s.project_id ?? "");
    const listKey = projectKeyById.get(pid) ?? "Inbox";
    const name = String(s.name ?? "").trim();
    if (!name || listKey === "Inbox") continue;
    const sk = `sec:${sid || `${listKey}\0${name}`}`;
    sectionKeyById.set(sid, sk);
    sections.push({
      sourceKey: sk,
      listKey,
      name,
      sortOrder: typeof s.section_order === "number" ? s.section_order * ORDER_STEP : sections.length * ORDER_STEP,
    });
  }

  const rawLabels = Array.isArray(doc.labels) ? (doc.labels as Array<Record<string, unknown>>) : [];
  for (const l of rawLabels) {
    if (!l || typeof l !== "object" || l.is_deleted) continue;
    const label = String(l.name ?? "").trim();
    if (!label) continue;
    const low = label.toLowerCase();
    tagMap.set(low, { name: low, label, color: mapTodoistColor(l.color) });
  }

  const commentsByItem = new Map<string, string[]>();
  const rawNotes = Array.isArray(doc.notes) ? (doc.notes as Array<Record<string, unknown>>) : [];
  for (const n of rawNotes) {
    if (!n || typeof n !== "object" || n.is_deleted) continue;
    const itemId = n.item_id ? String(n.item_id) : "";
    const body = typeof n.content === "string" ? n.content.trim() : "";
    if (itemId && body) {
      const list = commentsByItem.get(itemId) ?? [];
      list.push(body);
      commentsByItem.set(itemId, list);
    }
    if (n.file_attachment) {
      losses.push({
        category: "attachment",
        sourceItem: itemId || undefined,
        field: "file_attachment",
        reason: "Todoist comment attachment reference could not be carried over",
      });
    }
  }

  const rawItems = doc.items as Array<Record<string, unknown>>;
  const tasks: ImportTask[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i];
    if (!it || typeof it !== "object" || it.is_deleted) continue;
    const sid = String(it.id ?? `item-${i}`);
    const pid = it.project_id ? String(it.project_id) : "";
    const listKey = projectKeyById.get(pid) ?? (pid ? `proj:${pid}` : "Inbox");
    if (listKey.startsWith("proj:") && !lists.some((l) => l.sourceKey === listKey)) {
      lists.push({ sourceKey: listKey, name: `Project ${pid}` });
    }
    const secId = it.section_id ? String(it.section_id) : "";
    const sectionKey = secId ? sectionKeyById.get(secId) : undefined;
    const rawContent = String(it.content ?? "").trim();
    const { title, labels: inlineLabels } = extractInlineLabels(rawContent);
    const arrLabels = Array.isArray(it.labels) ? it.labels.map((x) => String(x).trim()).filter(Boolean) : [];
    const taskTags: string[] = [];
    for (const lbl of [...arrLabels, ...inlineLabels]) {
      const low = lbl.toLowerCase();
      if (!taskTags.includes(low)) taskTags.push(low);
      if (!tagMap.has(low)) tagMap.set(low, { name: low, label: lbl });
    }

    let notes = typeof it.description === "string" ? it.description.trim() : "";
    const itemComments = commentsByItem.get(sid);
    if (itemComments && itemComments.length > 0) {
      const merged = itemComments.map((c) => `Comment: ${c}`).join("\n");
      notes = notes ? `${notes}\n\n${merged}` : merged;
      losses.push({
        category: "comment",
        sourceItem: title,
        field: "notes",
        reason: `${itemComments.length} Todoist comment(s) merged into task notes`,
      });
    }

    const dueObj = it.due && typeof it.due === "object" ? (it.due as Record<string, unknown>) : null;
    let startDate: string | undefined;
    let dueDate: string | undefined;
    let startMs: number | undefined;
    let isAllDay: boolean | undefined;
    let isFloating: boolean | undefined;
    let timeZone: string | undefined;
    let repeatFlag: string | undefined;
    let repeatFrom: "0" | "1" | "2" | undefined;

    if (dueObj) {
      const dueDateStr = typeof dueObj.date === "string" ? dueObj.date.trim() : "";
      const dueTz = typeof dueObj.timezone === "string" ? dueObj.timezone.trim() : "";
      const dueStr = typeof dueObj.string === "string" ? dueObj.string.trim() : "";
      const dueLang = typeof dueObj.lang === "string" ? dueObj.lang.trim() : "";
      if (dueDateStr) {
        const parsed = parseFlexibleDate(dueDateStr, { timeZone: dueTz, defaultTimeZone: defaultTz });
        if (parsed) {
          startDate = parsed.wireDate;
          dueDate = parsed.wireDate;
          startMs = parsed.ms;
          isAllDay = parsed.isAllDay;
          isFloating = parsed.isFloating;
          timeZone = parsed.timeZone;
        } else {
          losses.push({ category: "invalid_date", sourceItem: title, field: "due.date", reason: `Could not parse date "${dueDateStr}"` });
        }
      }
      if (dueObj.is_recurring && dueStr) {
        const conv = convertTodoistRepeatToRepeatFlag(dueStr, dueLang ? { dateLang: dueLang } : {});
        if (conv.repeatFlag) {
          repeatFlag = conv.repeatFlag;
          repeatFrom = conv.repeatFrom;
          if (!startDate) {
            const dRes = parseTodoistDateAndRepeat(dueStr, dueLang, dueTz, defaultTz, nowMs, title, losses, false);
            startDate = dRes.startDate;
            dueDate = dRes.dueDate;
            startMs = dRes.startMs;
            isAllDay = dRes.isAllDay;
            isFloating = dRes.isFloating;
            timeZone = dRes.timeZone;
          }
        }
        if (conv.lostReason) {
          losses.push({ category: "unsupported_recurrence", sourceItem: title, field: "due.string", reason: conv.lostReason });
        }
      }
    }

    const durObj = it.duration && typeof it.duration === "object" ? (it.duration as Record<string, unknown>) : null;
    if (durObj && typeof durObj.amount === "number" && durObj.amount > 0) {
      const unit = String(durObj.unit ?? "minute").toLowerCase();
      const mins = unit === "day" ? durObj.amount * 1440 : durObj.amount;
      if (startMs !== undefined && isAllDay === false) {
        dueDate = formatServerDate(startMs + mins * 60_000);
      } else if (startMs !== undefined && isAllDay && unit === "day" && durObj.amount > 1) {
        dueDate = formatServerDate(startMs + durObj.amount * 86_400_000);
      } else {
        losses.push({ category: "duration", sourceItem: title, field: "duration", reason: `Duration (${durObj.amount} ${unit}) requires a timed start date` });
      }
    }

    const dlObj = it.deadline && typeof it.deadline === "object" ? (it.deadline as Record<string, unknown>) : null;
    if (dlObj && typeof dlObj.date === "string" && dlObj.date.trim()) {
      notes = notes ? `${notes}\n\nDeadline: ${dlObj.date.trim()}` : `Deadline: ${dlObj.date.trim()}`;
      losses.push({ category: "metadata", sourceItem: title, field: "deadline", reason: `Separate Todoist deadline (${dlObj.date.trim()}) appended to task notes` });
    }

    if (it.responsible_uid) {
      losses.push({ category: "assignee", sourceItem: title, field: "responsible_uid", reason: "Todoist assignee reference could not be carried over" });
    }

    const checked = Boolean(it.checked);
    const completedAtRaw = typeof it.completed_at === "string" ? it.completed_at : undefined;
    const completedParsed = completedAtRaw ? parseFlexibleDate(completedAtRaw, { defaultTimeZone: defaultTz }) : null;
    const addedParsed = typeof it.added_at === "string" ? parseFlexibleDate(it.added_at, { defaultTimeZone: defaultTz }) : null;

    tasks.push({
      sourceId: sid,
      listKey,
      ...(sectionKey ? { sectionKey } : {}),
      ...(it.parent_id ? { parentSourceId: String(it.parent_id) } : {}),
      title,
      kind: "TEXT",
      ...(notes ? { content: notes } : {}),
      status: checked ? 2 : 0,
      priority: mapApiPriority(it.priority),
      ...(startDate ? { startDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(isAllDay !== undefined ? { isAllDay } : {}),
      ...(isFloating !== undefined ? { isFloating } : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(repeatFlag ? { repeatFlag } : {}),
      ...(repeatFrom ? { repeatFrom } : {}),
      tags: taskTags,
      sortOrder: typeof it.child_order === "number" ? it.child_order * ORDER_STEP : tasks.length * ORDER_STEP,
      ...(addedParsed ? { createdTime: addedParsed.wireDate } : {}),
      ...(completedParsed ? { completedTime: completedParsed.wireDate } : {}),
    });
  }

  return finalizeBundle({
    source: "todoist",
    sourceLabel: "Todoist",
    folders: [],
    lists,
    sections,
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}

/** Parse either a Todoist project CSV export or a Todoist JSON backup into ImportBundle. */
export function parseTodoistBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return parseTodoistJsonBundle(trimmed, opts);
  }
  return parseTodoistCsvBundle(text, opts);
}
