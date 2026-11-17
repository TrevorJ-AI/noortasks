import { convertTodoTxtRepeatToRepeatFlag, convertTodoistRepeatToRepeatFlag } from "@noortasks/recurrence";
import { MAX_TASK_DEPTH, ORDER_STEP } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import { cleanTagName } from "../../data/repo";
import { finalizeBundle, parseFlexibleDate } from "./dates";
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

function deriveMarkdownListName(opts: ParseImportOptions): string {
  if (opts.listName?.trim()) return opts.listName.trim();
  if (opts.fileName?.trim()) {
    const base = opts.fileName.trim().replace(/^.*[/\\]/, "").replace(/\.(md|markdown|txt)$/i, "").trim();
    if (base) return base;
  }
  return "Inbox";
}

function indentWidth(ws: string): number {
  let n = 0;
  for (const ch of ws) n += ch === "\t" ? 2 : 1;
  return n;
}

/** Parse Markdown checklist files (`#` lists, `##` sections, nested `- [ ]`/`- [x]` subtasks, tags, dates, priorities, repeats, notes). */
export function parseMarkdownBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  const defaultList = deriveMarkdownListName(opts);
  let currentListName = defaultList;
  let currentSectionKey: string | undefined;
  let sawDeepHeading = false;
  let skippedProseLines = 0;

  const listMap = new Map<string, ImportList>();
  const sectionMap = new Map<string, ImportSection>();
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();

  const stack: Array<{ indent: number; sourceId: string; listKey: string; sectionKey?: string }> = [];
  let lastTask: { indent: number; task: ImportTask } | null = null;

  const ensureCurrentList = (): string => {
    const isInbox = currentListName.toLowerCase() === "inbox";
    const key = isInbox ? "Inbox" : currentListName;
    if (!isInbox && !listMap.has(key)) {
      listMap.set(key, { sourceKey: key, name: currentListName });
    }
    return key;
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const headingText = heading[2]!.trim();
      stack.length = 0;
      lastTask = null;
      if (level === 1) {
        currentListName = headingText || defaultList;
        currentSectionKey = undefined;
        ensureCurrentList();
      } else {
        if (level > 2) sawDeepHeading = true;
        const listKey = ensureCurrentList();
        if (listKey !== "Inbox") {
          const sk = `${listKey}\0${headingText}`;
          if (!sectionMap.has(sk)) {
            sectionMap.set(sk, { sourceKey: sk, listKey, name: headingText, sortOrder: sectionMap.size * ORDER_STEP });
          }
          currentSectionKey = sk;
        } else {
          losses.push({
            category: "field_ignored",
            sourceItem: headingText,
            field: "section",
            reason: `Inbox does not support sections; heading "${headingText}" flattened`,
          });
        }
      }
      continue;
    }

    const cb = /^(\s*)(?:[-*+]|\d+\.)\s+\[([ xX\-~!])\]\s+(.*)$/.exec(line);
    if (cb) {
      const indent = indentWidth(cb[1]!);
      const mark = cb[2]!;
      let body = cb[3]!.trim();

      const status: 0 | 2 | -1 = mark === "x" || mark === "X" ? 2 : mark === "-" || mark === "~" ? -1 : 0;
      let priority: 0 | 1 | 3 | 5 = 0;

      // Priority markers
      if (/[⏫🔺]/u.test(body) || /\[p1\]/i.test(body)) priority = 5;
      else if (/🔼/u.test(body) || /\[p2\]/i.test(body)) priority = 3;
      else if (/🔽/u.test(body) || /\[p3\]/i.test(body)) priority = 1;
      body = body.replace(/[⏫🔺🔼🔽]/gu, " ").replace(/\[p[123]\]/gi, " ");

      // Dates: 📅 YYYY-MM-DD, @due(...), due:YYYY-MM-DD, 🛫 YYYY-MM-DD, start:YYYY-MM-DD, ✅ YYYY-MM-DD
      let dueRaw: string | undefined;
      let startRaw: string | undefined;
      let completedRaw: string | undefined;

      body = body.replace(/📅\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)/gu, (_, d: string) => { dueRaw ??= d; return ""; });
      body = body.replace(/@due\(([^)]+)\)/gi, (_, d: string) => { dueRaw ??= d.trim(); return ""; });
      body = body.replace(/(?:^|\s)due:(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/gi, (_, d: string) => { dueRaw ??= d; return ""; });

      body = body.replace(/🛫\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)/gu, (_, d: string) => { startRaw ??= d; return ""; });
      body = body.replace(/@start\(([^)]+)\)/gi, (_, d: string) => { startRaw ??= d.trim(); return ""; });
      body = body.replace(/(?:^|\s)start:(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?)/gi, (_, d: string) => { startRaw ??= d; return ""; });

      body = body.replace(/✅\s*(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?)/gu, (_, d: string) => { completedRaw ??= d; return ""; });

      // Recurrence: 🔁 <phrase> or rec:<token>
      let repeatFlag: string | undefined;
      let repeatFrom: "0" | "1" | "2" | undefined;
      body = body.replace(/🔁\s*([^📅🛫✅⏫🔺🔼🔽#]+?)(?=\s*(?:[📅🛫✅⏫🔺🔼🔽#]|$))/gu, (_, expr: string) => {
        const conv = convertTodoistRepeatToRepeatFlag(expr.trim());
        if (conv.repeatFlag) {
          repeatFlag = conv.repeatFlag;
          repeatFrom = conv.repeatFrom;
        }
        if (conv.lostReason) {
          losses.push({ category: "unsupported_recurrence", sourceItem: cb[3]!.trim(), field: "🔁", reason: conv.lostReason });
        }
        return "";
      });
      body = body.replace(/(?:^|\s)rec:(\S+)/gi, (_, tok: string) => {
        const conv = convertTodoTxtRepeatToRepeatFlag(tok);
        if (conv.repeatFlag) {
          repeatFlag = conv.repeatFlag;
          repeatFrom = conv.repeatFrom;
        }
        if (conv.lostReason) {
          losses.push({ category: "unsupported_recurrence", sourceItem: cb[3]!.trim(), field: "rec", reason: conv.lostReason });
        }
        return "";
      });

      // Tags: #tag
      const taskTags: string[] = [];
      body = body.replace(/(^|\s)#([A-Za-z][A-Za-z0-9_/-]*)/g, (_, lead: string, rawTag: string) => {
        const clean = cleanTagName(rawTag);
        if (clean) {
          const low = clean.toLowerCase();
          if (!taskTags.includes(low)) taskTags.push(low);
          if (!tagMap.has(low)) tagMap.set(low, { name: low, label: clean });
        }
        return lead;
      });

      const title = body.replace(/\s+/g, " ").trim() || "(Untitled)";

      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
        stack.pop();
      }
      let parent = stack[stack.length - 1];
      const listKey = parent ? parent.listKey : ensureCurrentList();
      const sectionKey = parent ? parent.sectionKey : currentSectionKey;

      if (stack.length >= MAX_TASK_DEPTH) {
        losses.push({
          category: "subtask_depth",
          sourceItem: title,
          reason: `Markdown subtask nesting exceeded ${MAX_TASK_DEPTH} levels; capped at level ${MAX_TASK_DEPTH}`,
        });
        parent = stack[MAX_TASK_DEPTH - 2];
      }

      const parsedStart = startRaw ? parseFlexibleDate(startRaw, { defaultTimeZone: defaultTz }) : null;
      const parsedDue = dueRaw ? parseFlexibleDate(dueRaw, { defaultTimeZone: defaultTz }) : null;
      const parsedCompleted = completedRaw ? parseFlexibleDate(completedRaw, { defaultTimeZone: defaultTz }) : null;
      if (startRaw && !parsedStart) losses.push({ category: "invalid_date", sourceItem: title, field: "start", reason: `Invalid date "${startRaw}"` });
      if (dueRaw && !parsedDue) losses.push({ category: "invalid_date", sourceItem: title, field: "due", reason: `Invalid date "${dueRaw}"` });

      const startVal = parsedStart ?? parsedDue;
      const dueVal = parsedDue ?? parsedStart;

      const sourceId = keyer.next(`${listKey}\0${sectionKey ?? ""}\0${indent}\0${title}`);
      const task: ImportTask = {
        sourceId,
        listKey,
        ...(sectionKey ? { sectionKey } : {}),
        ...(parent ? { parentSourceId: parent.sourceId } : {}),
        title,
        kind: "TEXT",
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
        ...(parsedCompleted ? { completedTime: parsedCompleted.wireDate } : {}),
        tags: taskTags,
        sortOrder: tasks.length * ORDER_STEP,
      };

      tasks.push(task);
      lastTask = { indent, task };
      if (stack.length < MAX_TASK_DEPTH) {
        stack.push({ indent, sourceId, listKey, ...(sectionKey ? { sectionKey } : {}) });
      }
      continue;
    }

    // Indented note line under the previous task
    if (lastTask && line.trim()) {
      const lineIndent = indentWidth(/^\s*/.exec(line)![0]!);
      if (lineIndent > lastTask.indent) {
        const cleanNote = line.trim().replace(/^>\s?/, "");
        lastTask.task.content = lastTask.task.content ? `${lastTask.task.content}\n${cleanNote}` : cleanNote;
        continue;
      }
    }

    if (line.trim()) {
      lastTask = null;
      skippedProseLines++;
    }
  }

  if (sawDeepHeading) {
    losses.push({
      category: "metadata",
      reason: "Deep Markdown subheadings (### or deeper) flattened to sections",
    });
  }
  if (skippedProseLines > 0) {
    losses.push({
      category: "metadata",
      count: skippedProseLines,
      reason: `${skippedProseLines} non-task Markdown line(s) outside task items skipped`,
    });
  }

  return finalizeBundle({
    source: "markdown",
    sourceLabel: "Markdown",
    folders: [],
    lists: [...listMap.values()],
    sections: [...sectionMap.values()],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}
