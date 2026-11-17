import { convertTodoTxtRepeatToRepeatFlag } from "@noortasks/recurrence";
import { ORDER_STEP } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import { cleanTagName } from "../../data/repo";
import { finalizeBundle, parseFlexibleDate } from "./dates";
import { OccurrenceKeyer } from "./ids";
import type {
  ImportBundle,
  ImportList,
  ImportLossItem,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

function mapTodoTxtPriority(letter: string): { priority: 0 | 1 | 3 | 5; lost?: string } {
  const up = letter.toUpperCase();
  if (up === "A") return { priority: 5 };
  if (up === "B") return { priority: 3 };
  if (up === "C") return { priority: 1 };
  return { priority: 0, lost: `todo.txt priority (${up}) mapped to None (supports High/Medium/Low)` };
}

/** Parse todo.txt format (`x`, dates, `(A)`, `+project`, `@context`, `due:`, `t:`, `rec:`, `pri:`). */
export function parseTodoTxtBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const listMap = new Map<string, ImportList>();
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let rest = trimmed;
    let status: 0 | 2 | -1 = 0;
    let priority: 0 | 1 | 3 | 5 = 0;
    let completedTime: string | undefined;
    let createdTime: string | undefined;
    let priLetter: string | undefined;

    if (rest === "x" || rest.startsWith("x ")) {
      status = 2;
      rest = rest.slice(1).trimStart();
    }

    // Leading priority (A)
    const priHead = /^\(([A-Z])\)\s+(.*)$/.exec(rest);
    if (priHead) {
      priLetter = priHead[1]!;
      rest = priHead[2]!.trimStart();
    }

    // Optional completion + creation dates (YYYY-MM-DD)
    const twoDates = /^(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(rest);
    const oneDate = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(rest);
    if (status === 2 && twoDates) {
      completedTime = parseFlexibleDate(twoDates[1]!, { defaultTimeZone: defaultTz })?.wireDate;
      createdTime = parseFlexibleDate(twoDates[2]!, { defaultTimeZone: defaultTz })?.wireDate;
      rest = twoDates[3]!;
    } else if (oneDate) {
      const parsed = parseFlexibleDate(oneDate[1]!, { defaultTimeZone: defaultTz })?.wireDate;
      if (status === 2) completedTime = parsed;
      else createdTime = parsed;
      rest = oneDate[2]!;
    }

    // Some writers place (A) after x
    if (!priLetter) {
      const priMid = /^\(([A-Z])\)\s+(.*)$/.exec(rest);
      if (priMid) {
        priLetter = priMid[1]!;
        rest = priMid[2]!.trimStart();
      }
    }

    const projects: string[] = [];
    const contexts: string[] = [];
    const extraKv: string[] = [];
    let dueRaw: string | undefined;
    let thresholdRaw: string | undefined;
    let repeatFlag: string | undefined;
    let repeatFrom: "0" | "1" | "2" | undefined;

    const tokens = rest.split(/\s+/).filter(Boolean);
    const titleTokens: string[] = [];

    for (const tok of tokens) {
      if (tok.startsWith("+") && tok.length > 1) {
        projects.push(tok.slice(1));
        continue;
      }
      if (tok.startsWith("@") && tok.length > 1) {
        contexts.push(tok.slice(1));
        continue;
      }
      const kv = /^([a-zA-Z][a-zA-Z0-9_-]*):(\S+)$/.exec(tok);
      if (kv) {
        const k = kv[1]!.toLowerCase();
        const v = kv[2]!;
        if (k === "due") { dueRaw = v; continue; }
        if (k === "t") { thresholdRaw = v; continue; }
        if (k === "pri" && /^[A-Za-z]$/.test(v)) { priLetter ??= v; continue; }
        if (k === "rec") {
          const conv = convertTodoTxtRepeatToRepeatFlag(v);
          if (conv.repeatFlag) {
            repeatFlag = conv.repeatFlag;
            repeatFrom = conv.repeatFrom;
          }
          if (conv.lostReason) {
            losses.push({ category: "unsupported_recurrence", sourceItem: trimmed, field: "rec", reason: conv.lostReason });
          }
          continue;
        }
        if (k === "http" || k === "https" || k === "mailto") {
          titleTokens.push(tok);
          continue;
        }
        extraKv.push(tok);
        losses.push({
          category: "metadata",
          sourceItem: trimmed,
          field: k,
          reason: `Custom todo.txt token "${tok}" preserved in task notes`,
        });
        continue;
      }
      titleTokens.push(tok);
    }

    const title = titleTokens.join(" ").trim() || trimmed;

    if (priLetter) {
      const pr = mapTodoTxtPriority(priLetter);
      priority = pr.priority;
      if (pr.lost) losses.push({ category: "field_ignored", sourceItem: title, field: "priority", reason: pr.lost });
    }

    const primaryProj = projects[0];
    const isInbox = !primaryProj || primaryProj.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : primaryProj;
    if (!isInbox && !listMap.has(listKey)) {
      listMap.set(listKey, { sourceKey: listKey, name: primaryProj });
    }
    if (projects.length > 1) {
      losses.push({
        category: "field_ignored",
        sourceItem: title,
        field: "+project",
        reason: `Multiple +project tags (${projects.map((p) => `+${p}`).join(", ")}); placed in "${listKey}" and extra projects added as tags`,
      });
    }

    const taskTags: string[] = [];
    for (const rawTag of [...contexts, ...projects.slice(1)]) {
      const clean = cleanTagName(rawTag);
      if (!clean) continue;
      const low = clean.toLowerCase();
      if (!taskTags.includes(low)) taskTags.push(low);
      if (!tagMap.has(low)) tagMap.set(low, { name: low, label: clean });
    }

    const parsedDue = dueRaw ? parseFlexibleDate(dueRaw, { defaultTimeZone: defaultTz }) : null;
    const parsedThresh = thresholdRaw ? parseFlexibleDate(thresholdRaw, { defaultTimeZone: defaultTz }) : null;
    if (dueRaw && !parsedDue) losses.push({ category: "invalid_date", sourceItem: title, field: "due", reason: `Invalid todo.txt due date "${dueRaw}"` });
    if (thresholdRaw && !parsedThresh) losses.push({ category: "invalid_date", sourceItem: title, field: "t", reason: `Invalid todo.txt threshold date "${thresholdRaw}"` });

    const startVal = parsedThresh ?? parsedDue;
    const dueVal = parsedDue ?? parsedThresh;

    const notes = extraKv.length > 0 ? extraKv.join(" ") : undefined;
    const sourceId = keyer.next(trimmed);

    tasks.push({
      sourceId,
      listKey,
      title,
      kind: "TEXT",
      ...(notes ? { content: notes } : {}),
      status,
      priority,
      ...(startVal ? {
        startDate: startVal.wireDate,
        dueDate: (dueVal && dueVal.ms >= startVal.ms ? dueVal : startVal).wireDate,
        isAllDay: startVal.isAllDay,
        isFloating: startVal.isFloating,
        timeZone: startVal.timeZone,
      } : {}),
      ...(repeatFlag ? { repeatFlag } : {}),
      ...(repeatFrom ? { repeatFrom } : {}),
      ...(createdTime ? { createdTime } : {}),
      ...(completedTime ? { completedTime } : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    });
  }

  return finalizeBundle({
    source: "todotxt",
    sourceLabel: "todo.txt",
    folders: [],
    lists: [...listMap.values()],
    sections: [],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}
