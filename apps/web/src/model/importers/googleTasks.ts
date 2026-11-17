import { ORDER_STEP } from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import { finalizeBundle, parseFlexibleDate } from "./dates";
import type {
  ImportBundle,
  ImportList,
  ImportLossItem,
  ImportTask,
  ParseImportOptions,
} from "./types";

interface RawGoogleList {
  id?: string;
  title: string;
  items: Array<Record<string, unknown>>;
}

function extractGoogleLists(doc: unknown, opts: ParseImportOptions): RawGoogleList[] {
  const fallbackTitle = opts.listName?.trim() || "My Tasks";

  if (Array.isArray(doc)) {
    return doc
      .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"))
      .map((l, idx) => ({
        ...(typeof l.id === "string" ? { id: l.id } : {}),
        title: String(l.title ?? `List ${idx + 1}`).trim(),
        items: Array.isArray(l.items) ? (l.items as Array<Record<string, unknown>>) : [],
      }));
  }

  if (!doc || typeof doc !== "object") {
    throw new Error("Google Tasks JSON must be an object or array");
  }

  const obj = doc as Record<string, unknown>;
  if (obj.kind === "tasks#tasks" || (Array.isArray(obj.items) && obj.items.some((x) => x && typeof x === "object" && !Array.isArray((x as Record<string, unknown>).items) && "status" in (x as Record<string, unknown>)))) {
    return [{
      ...(typeof obj.id === "string" ? { id: obj.id } : {}),
      title: String(obj.title ?? fallbackTitle).trim(),
      items: (obj.items as Array<Record<string, unknown>>) ?? [],
    }];
  }

  if (Array.isArray(obj.items)) {
    return (obj.items as Array<Record<string, unknown>>)
      .filter((x) => x && typeof x === "object")
      .map((l, idx) => ({
        ...(typeof l.id === "string" ? { id: l.id } : {}),
        title: String(l.title ?? `List ${idx + 1}`).trim(),
        items: Array.isArray(l.items) ? (l.items as Array<Record<string, unknown>>) : [],
      }));
  }

  throw new Error("Unrecognized Google Tasks Takeout JSON (expected tasks#taskLists or tasks#tasks)");
}

/** Parse Google Takeout `Tasks.json` into ImportBundle. */
export function parseGoogleTasksBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid Google Tasks JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const rawLists = extractGoogleLists(doc, opts);
  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const lists: ImportList[] = [];
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];

  for (let li = 0; li < rawLists.length; li++) {
    const rl = rawLists[li]!;
    const listName = rl.title || `List ${li + 1}`;
    const isInbox = listName.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : listName;
    if (!isInbox && !lists.some((l) => l.sourceKey === listKey)) {
      lists.push({ sourceKey: listKey, name: listName });
    }

    const sortedItems = [...rl.items].sort((a, b) => {
      const pa = typeof a.position === "string" ? a.position : "";
      const pb = typeof b.position === "string" ? b.position : "";
      return pa.localeCompare(pb);
    });

    for (let ti = 0; ti < sortedItems.length; ti++) {
      const it = sortedItems[ti];
      if (!it || typeof it !== "object") continue;

      const title = String(it.title ?? "").trim() || "(Untitled)";
      if (it.deleted === true) {
        losses.push({
          category: "metadata",
          sourceItem: title,
          field: "deleted",
          reason: `Deleted Google Task "${title}" skipped`,
        });
        continue;
      }

      const sid = String(it.id ?? `${listKey}:${ti}:${title}`);
      let notes = typeof it.notes === "string" ? it.notes.trim() : "";

      if (Array.isArray(it.links) && it.links.length > 0) {
        const linkLines: string[] = [];
        for (const lk of it.links) {
          if (!lk || typeof lk !== "object") continue;
          const lo = lk as Record<string, unknown>;
          const url = typeof lo.link === "string" ? lo.link.trim() : "";
          const label = String(lo.description ?? lo.type ?? "Link").trim();
          if (url) linkLines.push(`[${label}](${url})`);
        }
        if (linkLines.length > 0) {
          notes = notes ? `${notes}\n\n${linkLines.join("\n")}` : linkLines.join("\n");
          losses.push({
            category: "metadata",
            sourceItem: title,
            field: "links",
            reason: `${linkLines.length} Google Task link(s) appended to task notes`,
          });
        }
      }

      const status: 0 | 2 = String(it.status ?? "").toLowerCase() === "completed" ? 2 : 0;
      const completedRaw = typeof it.completed === "string" ? it.completed : status === 2 && typeof it.updated === "string" ? it.updated : undefined;
      const completedParsed = completedRaw ? parseFlexibleDate(completedRaw, { defaultTimeZone: defaultTz }) : null;

      let startDate: string | undefined;
      let dueDate: string | undefined;
      let isAllDay: boolean | undefined;
      let isFloating: boolean | undefined;
      let timeZone: string | undefined;

      if (typeof it.due === "string" && it.due.trim()) {
        const dueStr = it.due.trim();
        const isDateMidnight = /^\d{4}-\d{2}-\d{2}(?:T00:00:00(?:\.0+)?Z?)?$/i.test(dueStr);
        const parsed = parseFlexibleDate(dueStr, { defaultTimeZone: defaultTz, forceAllDay: isDateMidnight });
        if (parsed) {
          startDate = parsed.wireDate;
          dueDate = parsed.wireDate;
          isAllDay = parsed.isAllDay;
          isFloating = parsed.isFloating;
          timeZone = parsed.timeZone;
        } else {
          losses.push({ category: "invalid_date", sourceItem: title, field: "due", reason: `Could not parse due date "${dueStr}"` });
        }
      }

      if (it.recurrence || it.repeat) {
        losses.push({
          category: "unsupported_recurrence",
          sourceItem: title,
          field: "recurrence",
          reason: "Unexpected recurrence field in Google Tasks JSON could not be carried over",
        });
      }

      tasks.push({
        sourceId: sid,
        listKey,
        ...(typeof it.parent === "string" && it.parent ? { parentSourceId: it.parent } : {}),
        title,
        kind: "TEXT",
        ...(notes ? { content: notes } : {}),
        status,
        priority: 0,
        ...(startDate ? { startDate, dueDate, isAllDay, isFloating, timeZone } : {}),
        ...(completedParsed ? { completedTime: completedParsed.wireDate } : {}),
        tags: [],
        sortOrder: tasks.length * ORDER_STEP,
      });
    }
  }

  return finalizeBundle({
    source: "googleTasks",
    sourceLabel: "Google Tasks",
    folders: [],
    lists,
    sections: [],
    tags: [],
    tasks,
    losses,
  });
}
