import { convertMsTodoRecurrenceToRepeatFlag } from "@noortasks/recurrence";
import { ORDER_STEP } from "../../lib/core";
import { cleanTagName } from "../../data/repo";
import { deviceZone } from "../../lib/dates";
import {
  buildReminderTriggerFromInstants,
  finalizeBundle,
  parseFlexibleDate,
  resolveTimeZone,
} from "./dates";
import type {
  ImportBundle,
  ImportChecklistItem,
  ImportList,
  ImportLossItem,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

function stripHtmlBody(html: string): { text: string; hadHtml: boolean } {
  const hasTags = /<[a-z][\s\S]*>/i.test(html);
  if (!hasTags) return { text: html.trim(), hadHtml: false };
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, hadHtml: true };
}

function mapMsImportance(raw: unknown): 0 | 1 | 3 | 5 {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "high") return 5;
  if (s === "low") return 1;
  return 0;
}

function parseMsDateTimeZone(
  dtObj: unknown,
  defaultTz: string,
  taskTitle: string,
  field: string,
  losses: ImportLossItem[],
): { wireDate: string; ms: number; isAllDay: boolean; isFloating: boolean; timeZone: string } | null {
  if (!dtObj || typeof dtObj !== "object") return null;
  const o = dtObj as Record<string, unknown>;
  const dtStr = typeof o.dateTime === "string" ? o.dateTime.trim() : "";
  if (!dtStr) return null;
  const tzStr = typeof o.timeZone === "string" ? o.timeZone.trim() : "";
  const tzInfo = resolveTimeZone(tzStr, defaultTz);
  if (tzInfo.lost) {
    losses.push({ category: "field_ignored", sourceItem: taskTitle, field: `${field}.timeZone`, reason: tzInfo.lost });
  }
  const midnightOnly = /T00:00:00(?:\.0+)?$/i.test(dtStr);
  const parsed = parseFlexibleDate(dtStr, {
    timeZone: tzStr,
    defaultTimeZone: defaultTz,
    forceAllDay: midnightOnly,
  });
  if (!parsed) {
    losses.push({ category: "invalid_date", sourceItem: taskTitle, field, reason: `Could not parse Microsoft To Do date "${dtStr}"` });
    return null;
  }
  return parsed;
}

interface NormalizedList {
  id: string;
  displayName: string;
  wellknownListName?: string;
  tasks: Array<Record<string, unknown>>;
}

function extractMsTodoLists(doc: unknown, opts: ParseImportOptions): NormalizedList[] {
  const fallbackListName = opts.listName?.trim() || "Tasks";

  if (Array.isArray(doc)) {
    // Array of lists OR array of tasks
    const items = doc.filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
    if (items.length === 0) return [];
    const looksLikeLists = items.some((x) => "displayName" in x || Array.isArray(x.tasks));
    if (looksLikeLists) {
      return items.map((l, idx) => ({
        id: String(l.id ?? `list-${idx}`),
        displayName: String(l.displayName ?? l.name ?? `List ${idx + 1}`).trim(),
        ...(typeof l.wellknownListName === "string" ? { wellknownListName: l.wellknownListName } : {}),
        tasks: Array.isArray(l.tasks) ? (l.tasks as Array<Record<string, unknown>>) : [],
      }));
    }
    return [{ id: "default", displayName: fallbackListName, tasks: items }];
  }

  if (!doc || typeof doc !== "object") {
    throw new Error("Microsoft To Do JSON must be an object or array");
  }

  const obj = doc as Record<string, unknown>;
  if (Array.isArray(obj.lists)) {
    const rawLists = obj.lists as Array<Record<string, unknown>>;
    const flatTasks = Array.isArray(obj.tasks) ? (obj.tasks as Array<Record<string, unknown>>) : [];
    const tasksByList = obj.tasksByList && typeof obj.tasksByList === "object"
      ? (obj.tasksByList as Record<string, Array<Record<string, unknown>>>)
      : null;

    return rawLists.map((l, idx) => {
      const lid = String(l.id ?? `list-${idx}`);
      let tasks: Array<Record<string, unknown>> = [];
      if (Array.isArray(l.tasks)) tasks = l.tasks as Array<Record<string, unknown>>;
      else if (tasksByList && Array.isArray(tasksByList[lid])) tasks = tasksByList[lid]!;
      else if (flatTasks.length > 0) {
        tasks = flatTasks.filter((t) => String(t.listId ?? t.parentListId ?? "") === lid);
      }
      return {
        id: lid,
        displayName: String(l.displayName ?? l.name ?? `List ${idx + 1}`).trim(),
        ...(typeof l.wellknownListName === "string" ? { wellknownListName: l.wellknownListName } : {}),
        tasks,
      };
    });
  }

  if (Array.isArray(obj.value)) {
    const val = (obj.value as unknown[]).filter((x): x is Record<string, unknown> => Boolean(x && typeof x === "object"));
    const looksLikeLists = val.some((x) => "displayName" in x || Array.isArray(x.tasks));
    if (looksLikeLists) {
      return val.map((l, idx) => ({
        id: String(l.id ?? `list-${idx}`),
        displayName: String(l.displayName ?? l.name ?? `List ${idx + 1}`).trim(),
        ...(typeof l.wellknownListName === "string" ? { wellknownListName: l.wellknownListName } : {}),
        tasks: Array.isArray(l.tasks) ? (l.tasks as Array<Record<string, unknown>>) : [],
      }));
    }
    return [{
      id: String(obj.id ?? "default"),
      displayName: String(obj.displayName ?? obj.listName ?? fallbackListName).trim(),
      ...(typeof obj.wellknownListName === "string" ? { wellknownListName: obj.wellknownListName } : {}),
      tasks: val,
    }];
  }

  if (Array.isArray(obj.tasks)) {
    return [{
      id: String(obj.id ?? "default"),
      displayName: String(obj.displayName ?? obj.listName ?? fallbackListName).trim(),
      ...(typeof obj.wellknownListName === "string" ? { wellknownListName: obj.wellknownListName } : {}),
      tasks: obj.tasks as Array<Record<string, unknown>>,
    }];
  }

  throw new Error("Unrecognized Microsoft To Do JSON structure (expected lists/tasks or Graph value array)");
}

/** Parse Microsoft To Do Graph JSON export into ImportBundle. */
export function parseMsTodoBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`Invalid Microsoft To Do JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  const rawLists = extractMsTodoLists(doc, opts);
  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const lists: ImportList[] = [];
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];

  for (let li = 0; li < rawLists.length; li++) {
    const rl = rawLists[li]!;
    const isInbox = rl.wellknownListName === "defaultList" || rl.displayName.toLowerCase() === "inbox";
    const listKey = isInbox ? "Inbox" : (rl.displayName || `List ${li + 1}`);
    if (!isInbox && !lists.some((l) => l.sourceKey === listKey)) {
      lists.push({ sourceKey: listKey, name: listKey });
    }

    for (let ti = 0; ti < rl.tasks.length; ti++) {
      const t = rl.tasks[ti];
      if (!t || typeof t !== "object") continue;

      const title = String(t.title ?? "").trim() || "(Untitled)";
      const sid = String(t.id ?? `${listKey}:${ti}:${title}`);

      // Status
      const rawStatus = typeof t.status === "string" ? t.status.trim() : "notStarted";
      const status: 0 | 2 | -1 = rawStatus === "completed" ? 2 : 0;
      if (rawStatus !== "notStarted" && rawStatus !== "completed") {
        losses.push({
          category: "field_ignored",
          sourceItem: title,
          field: "status",
          reason: `Microsoft To Do status "${rawStatus}" simplified to Open`,
        });
      }

      // Categories -> tags
      const taskTags: string[] = [];
      if (Array.isArray(t.categories)) {
        for (const c of t.categories) {
          const clean = cleanTagName(String(c));
          if (!clean) continue;
          const low = clean.toLowerCase();
          if (!taskTags.includes(low)) taskTags.push(low);
          if (!tagMap.has(low)) tagMap.set(low, { name: low, label: clean });
        }
      }

      // Body / notes
      let notes = "";
      if (t.body && typeof t.body === "object") {
        const bodyObj = t.body as Record<string, unknown>;
        const rawBody = typeof bodyObj.content === "string" ? bodyObj.content : "";
        const contentType = typeof bodyObj.contentType === "string" ? bodyObj.contentType.toLowerCase() : "text";
        if (rawBody.trim()) {
          if (contentType === "html") {
            const stripped = stripHtmlBody(rawBody);
            notes = stripped.text;
            if (stripped.hadHtml) {
              losses.push({
                category: "metadata",
                sourceItem: title,
                field: "body",
                reason: "HTML formatting in Microsoft To Do note simplified to plain text",
              });
            }
          } else {
            notes = rawBody.trim();
          }
        }
      }

      // Linked resources
      if (Array.isArray(t.linkedResources) && t.linkedResources.length > 0) {
        const linkLines: string[] = [];
        for (const lr of t.linkedResources) {
          if (!lr || typeof lr !== "object") continue;
          const lro = lr as Record<string, unknown>;
          const label = String(lro.displayName ?? lro.name ?? lro.applicationName ?? "Link").trim();
          const url = typeof lro.webUrl === "string" ? lro.webUrl.trim() : "";
          if (url) linkLines.push(`[${label}](${url})`);
          else if (label) linkLines.push(label);
        }
        if (linkLines.length > 0) {
          notes = notes ? `${notes}\n\n${linkLines.join("\n")}` : linkLines.join("\n");
          losses.push({
            category: "metadata",
            sourceItem: title,
            field: "linkedResources",
            reason: `${linkLines.length} linked resource(s) appended to task notes`,
          });
        }
      }

      // Attachments
      if (t.hasAttachments === true || (Array.isArray(t.attachments) && t.attachments.length > 0)) {
        losses.push({
          category: "attachment",
          sourceItem: title,
          field: "attachments",
          reason: "Microsoft To Do file attachments are not carried over",
        });
      }

      // Dates
      const dueParsed = parseMsDateTimeZone(t.dueDateTime, defaultTz, title, "dueDateTime", losses);
      const startParsed = parseMsDateTimeZone(t.startDateTime, defaultTz, title, "startDateTime", losses);
      let startVal = startParsed ?? dueParsed;
      let dueVal = dueParsed ?? startParsed;

      // Recurrence
      let repeatFlag: string | undefined;
      let repeatFrom: "0" | "1" | "2" | undefined;
      if (t.recurrence) {
        const conv = convertMsTodoRecurrenceToRepeatFlag(t.recurrence);
        if (conv.repeatFlag) {
          repeatFlag = conv.repeatFlag;
          repeatFrom = conv.repeatFrom;
          if (!startVal && conv.startDateIso) {
            const recStart = parseFlexibleDate(conv.startDateIso, { defaultTimeZone: defaultTz });
            if (recStart) {
              startVal = recStart;
              dueVal = recStart;
            }
          }
        }
        if (conv.lostReason) {
          losses.push({
            category: "unsupported_recurrence",
            sourceItem: title,
            field: "recurrence",
            reason: conv.lostReason,
          });
        }
      }

      // Reminders
      const reminders: Array<{ trigger: string }> = [];
      if (t.isReminderOn && t.reminderDateTime) {
        const remParsed = parseMsDateTimeZone(t.reminderDateTime, defaultTz, title, "reminderDateTime", losses);
        if (remParsed) {
          if (startVal) {
            const trig = buildReminderTriggerFromInstants(startVal.ms, remParsed.ms, startVal.isAllDay, startVal.timeZone);
            if (trig) reminders.push({ trigger: trig });
            else {
              losses.push({
                category: "unsupported_reminder",
                sourceItem: title,
                field: "reminderDateTime",
                reason: "Reminder offset exceeded range and could not be converted to a relative trigger",
              });
            }
          } else {
            losses.push({
              category: "unsupported_reminder",
              sourceItem: title,
              field: "reminderDateTime",
              reason: "Reminder on undated task could not be carried over (NoorTasks reminders require a date)",
            });
          }
        }
      }

      // Checklist steps
      const rawSteps = Array.isArray(t.checklistItems) ? (t.checklistItems as Array<Record<string, unknown>>) : [];
      const items: ImportChecklistItem[] = rawSteps
        .filter((s) => s && typeof s === "object" && String(s.displayName ?? "").trim())
        .map((s, idx) => ({
          ...(typeof s.id === "string" && s.id ? { sourceId: s.id } : {}),
          title: String(s.displayName).trim(),
          status: s.isChecked ? 1 : 0,
          sortOrder: idx * ORDER_STEP,
        }));

      const completedParsed = parseMsDateTimeZone(t.completedDateTime, defaultTz, title, "completedDateTime", losses);
      const createdParsed = typeof t.createdDateTime === "string"
        ? parseFlexibleDate(t.createdDateTime, { defaultTimeZone: defaultTz })
        : null;

      const isChecklist = items.length > 0;
      tasks.push({
        sourceId: sid,
        listKey,
        title,
        kind: isChecklist ? "CHECKLIST" : "TEXT",
        ...(isChecklist ? { ...(notes ? { desc: notes } : {}), items } : notes ? { content: notes } : {}),
        status,
        priority: mapMsImportance(t.importance),
        ...(startVal ? {
          startDate: startVal.wireDate,
          dueDate: (dueVal && dueVal.ms >= startVal.ms ? dueVal : startVal).wireDate,
          isAllDay: startVal.isAllDay,
          isFloating: startVal.isFloating,
          timeZone: startVal.timeZone,
        } : {}),
        ...(reminders.length ? { reminders } : {}),
        ...(repeatFlag ? { repeatFlag } : {}),
        ...(repeatFrom ? { repeatFrom } : {}),
        ...(createdParsed ? { createdTime: createdParsed.wireDate } : {}),
        ...(completedParsed ? { completedTime: completedParsed.wireDate } : {}),
        tags: taskTags,
        sortOrder: tasks.length * ORDER_STEP,
      });
    }
  }

  return finalizeBundle({
    source: "microsoftTodo",
    sourceLabel: "Microsoft To Do",
    folders: [],
    lists,
    sections: [],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function fetchGraphPages(url: string, token: string, fetchFn: FetchLike): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let next: string | undefined = url;
  while (next) {
    const res = await fetchFn(next, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Microsoft Graph returned HTTP ${res.status}`);
    }
    const json = (await res.json()) as { value?: unknown[]; "@odata.nextLink"?: string };
    if (Array.isArray(json.value)) {
      for (const item of json.value) {
        if (item && typeof item === "object") out.push(item as Record<string, unknown>);
      }
    }
    next = typeof json["@odata.nextLink"] === "string" ? json["@odata.nextLink"] : undefined;
  }
  return out;
}

/**
 * Client-side Microsoft Graph token flow (browser only, never routed through NoorTasks server).
 * Fetches /me/todo/lists and each list's tasks (with checklistItems and linkedResources).
 */
export async function fetchMsTodoGraphJson(
  accessToken: string,
  fetchFn: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<string> {
  const token = accessToken.trim().replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Microsoft Graph access token is required");

  const base = "https://graph.microsoft.com/v1.0/me/todo/lists";
  const lists = await fetchGraphPages(base, token, fetchFn);
  const enriched: Array<Record<string, unknown>> = [];

  for (const l of lists) {
    const lid = String(l.id ?? "");
    if (!lid) continue;
    let tasks: Array<Record<string, unknown>>;
    try {
      tasks = await fetchGraphPages(`${base}/${encodeURIComponent(lid)}/tasks?$expand=checklistItems,linkedResources`, token, fetchFn);
    } catch {
      tasks = await fetchGraphPages(`${base}/${encodeURIComponent(lid)}/tasks`, token, fetchFn);
    }
    enriched.push({ ...l, tasks });
  }
  return JSON.stringify(enriched);
}
