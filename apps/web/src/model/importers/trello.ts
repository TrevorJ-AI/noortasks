import { ORDER_STEP } from "../../lib/core";
import { cleanTagName } from "../../data/repo";
import { deviceZone } from "../../lib/dates";
import { appendNoteBlock, deriveListFromFileName } from "./csvCommon";
import { finalizeBundle, parseFlexibleDate } from "./dates";
import { OccurrenceKeyer } from "./ids";
import type {
  ImportBundle,
  ImportChecklistItem,
  ImportList,
  ImportLossItem,
  ImportSection,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

const TRELLO_COLORS: Record<string, string> = {
  green: "#61bd4f",
  green_dark: "#1f845a",
  green_light: "#baf3db",
  yellow: "#f2d600",
  yellow_dark: "#946f00",
  yellow_light: "#f8e6a0",
  orange: "#ff9f1a",
  orange_dark: "#c25100",
  orange_light: "#fedec8",
  red: "#eb5a46",
  red_dark: "#ae2e24",
  red_light: "#ffd5d2",
  purple: "#c377e0",
  purple_dark: "#5e4db2",
  purple_light: "#dfd8fd",
  blue: "#0079bf",
  blue_dark: "#0c66e4",
  blue_light: "#cce0ff",
  sky: "#00c2e0",
  sky_dark: "#206a83",
  sky_light: "#c6edfb",
  lime: "#51e898",
  lime_dark: "#4c6b1f",
  lime_light: "#d3f1a7",
  pink: "#ff78cb",
  pink_dark: "#943d73",
  pink_light: "#fdd0ec",
  black: "#344563",
  black_dark: "#44546f",
  black_light: "#dcdfe4",
};

function mapTrelloColor(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim().toLowerCase();
  return TRELLO_COLORS[s] ?? null;
}

function posSort(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const pa = typeof a.pos === "number" ? a.pos : Number.MAX_SAFE_INTEGER;
  const pb = typeof b.pos === "number" ? b.pos : Number.MAX_SAFE_INTEGER;
  return pa - pb;
}

/** Parse a Trello board JSON export (`{ name, lists, cards, checklists, labels, actions }`). */
export function parseTrelloBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new Error(`Invalid Trello JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Trello board JSON must be an object");
  }

  const doc = raw as Record<string, unknown>;
  if (!Array.isArray(doc.cards) || !Array.isArray(doc.lists)) {
    throw new Error("Trello board JSON must contain lists and cards arrays");
  }

  const defaultTz = opts.defaultTimeZone ?? deviceZone();
  const keyer = new OccurrenceKeyer();
  const losses: ImportLossItem[] = [];

  const boardName = (typeof doc.name === "string" && doc.name.trim()) ||
    opts.listName?.trim() ||
    deriveListFromFileName(opts.fileName, "Trello Board");
  const isInbox = boardName.toLowerCase() === "inbox";
  const listKey = isInbox ? "Inbox" : boardName;
  const lists: ImportList[] = isInbox
    ? []
    : [{ sourceKey: listKey, name: boardName, viewMode: "kanban" }];

  if (doc.closed === true) {
    losses.push({
      category: "metadata",
      sourceItem: boardName,
      field: "closed",
      reason: `Closed Trello board "${boardName}" imported as an active list`,
    });
  }

  // Labels by ID
  const tagMap = new Map<string, ImportTag>();
  const labelById = new Map<string, { low: string; display: string; color: string | null }>();
  const rawLabels = Array.isArray(doc.labels) ? (doc.labels as Array<Record<string, unknown>>) : [];
  for (const lbl of rawLabels) {
    if (!lbl || typeof lbl !== "object") continue;
    const lid = typeof lbl.id === "string" ? lbl.id : "";
    const colorName = typeof lbl.color === "string" ? lbl.color.trim() : "";
    const rawName = typeof lbl.name === "string" ? lbl.name.trim() : "";
    const fallbackName = rawName || colorName;
    const clean = cleanTagName(fallbackName);
    if (!clean) continue;
    const low = clean.toLowerCase();
    const color = mapTrelloColor(colorName);
    if (!rawName && colorName) {
      losses.push({
        category: "metadata",
        sourceItem: clean,
        field: "labels",
        reason: `Unnamed Trello "${colorName}" label imported as tag "${clean}"`,
      });
    }
    if (!tagMap.has(low)) tagMap.set(low, { name: low, label: clean, color });
    if (lid) labelById.set(lid, { low, display: clean, color });
  }

  // Lists -> Kanban sections
  const sections: ImportSection[] = [];
  const listMetaById = new Map<string, { name: string; closed: boolean; sectionKey?: string }>();
  const rawLists = (doc.lists as Array<Record<string, unknown>>)
    .filter((l) => l && typeof l === "object")
    .sort(posSort);

  for (const l of rawLists) {
    const lid = String(l.id ?? "");
    const lname = String(l.name ?? "Untitled List").trim();
    const closed = Boolean(l.closed);
    if (!closed && !isInbox) {
      const sk = `sec:${lid || `${listKey}\0${lname}`}`;
      sections.push({
        sourceKey: sk,
        listKey,
        name: lname,
        sortOrder: sections.length * ORDER_STEP,
      });
      if (lid) listMetaById.set(lid, { name: lname, closed, sectionKey: sk });
    } else {
      if (lid) listMetaById.set(lid, { name: lname, closed });
      if (!closed && isInbox) {
        losses.push({
          category: "field_ignored",
          sourceItem: lname,
          field: "lists",
          reason: `Inbox does not support sections; Trello list "${lname}" flattened`,
        });
      }
    }
  }

  // Checklists indexed by ID and card ID
  const checklistById = new Map<string, Record<string, unknown>>();
  const checklistsByCard = new Map<string, Array<Record<string, unknown>>>();
  const rawChecklists = Array.isArray(doc.checklists)
    ? (doc.checklists as Array<Record<string, unknown>>).filter((c) => c && typeof c === "object").sort(posSort)
    : [];
  for (const cl of rawChecklists) {
    const cid = typeof cl.id === "string" ? cl.id : "";
    const cardId = typeof cl.idCard === "string" ? cl.idCard : "";
    if (cid) checklistById.set(cid, cl);
    if (cardId) {
      const arr = checklistsByCard.get(cardId) ?? [];
      arr.push(cl);
      checklistsByCard.set(cardId, arr);
    }
  }

  // Actions -> card comments & action history note
  const commentsByCard = new Map<string, string[]>();
  const rawActions = Array.isArray(doc.actions) ? (doc.actions as Array<Record<string, unknown>>) : [];
  let nonCommentActions = 0;
  for (const act of rawActions) {
    if (!act || typeof act !== "object") continue;
    if (act.type === "commentCard") {
      const data = act.data && typeof act.data === "object" ? (act.data as Record<string, unknown>) : null;
      const cardObj = data?.card && typeof data.card === "object" ? (data.card as Record<string, unknown>) : null;
      const cardId = typeof cardObj?.id === "string" ? cardObj.id : "";
      const body = typeof data?.text === "string" ? data.text.trim() : "";
      if (cardId && body) {
        const list = commentsByCard.get(cardId) ?? [];
        list.push(body);
        commentsByCard.set(cardId, list);
      }
    } else {
      nonCommentActions++;
    }
  }
  if (nonCommentActions > 0 || rawActions.length >= 1000) {
    losses.push({
      category: "metadata",
      field: "actions",
      count: nonCommentActions || rawActions.length,
      reason: "Trello board activity history (non-comment actions and exports capped at 1,000 recent actions) is not imported",
    });
  }

  // Cards -> Tasks
  const rawCards = (doc.cards as Array<Record<string, unknown>>)
    .filter((c) => c && typeof c === "object")
    .sort(posSort);

  const tasks: ImportTask[] = [];
  const warnedArchivedLists = new Set<string>();

  for (let i = 0; i < rawCards.length; i++) {
    const card = rawCards[i]!;
    const title = String(card.name ?? "").trim() || "(Untitled)";
    const cid = typeof card.id === "string" && card.id.trim() ? card.id.trim() : keyer.next(`${listKey}\0${title}`);
    const idList = typeof card.idList === "string" ? card.idList : "";
    const listMeta = idList ? listMetaById.get(idList) : undefined;
    const sectionKey = listMeta?.sectionKey;

    if (listMeta?.closed) {
      if (!warnedArchivedLists.has(idList)) {
        warnedArchivedLists.add(idList);
        losses.push({
          category: "metadata",
          sourceItem: listMeta.name,
          field: "lists.closed",
          reason: `Archived Trello list "${listMeta.name}" omitted; its cards imported without a section`,
        });
      }
    }

    const dueComplete = card.dueComplete === true;
    const isClosed = card.closed === true;
    const status: 0 | 2 | -1 = dueComplete ? 2 : isClosed ? -1 : 0;
    if (isClosed && !dueComplete) {
      losses.push({
        category: "metadata",
        sourceItem: title,
        field: "closed",
        reason: "Archived Trello card imported as Won't Do",
      });
    }

    // Tags from idLabels + embedded labels
    const taskTags: string[] = [];
    const registerTag = (low: string, label: string, color: string | null): void => {
      if (!taskTags.includes(low)) taskTags.push(low);
      if (!tagMap.has(low)) tagMap.set(low, { name: low, label, color });
    };
    if (Array.isArray(card.idLabels)) {
      for (const lid of card.idLabels) {
        const mapped = typeof lid === "string" ? labelById.get(lid) : undefined;
        if (mapped) registerTag(mapped.low, mapped.display, mapped.color);
      }
    }
    if (Array.isArray(card.labels)) {
      for (const el of card.labels) {
        if (!el || typeof el !== "object") continue;
        const elo = el as Record<string, unknown>;
        const rawName = typeof elo.name === "string" ? elo.name.trim() : "";
        const colorName = typeof elo.color === "string" ? elo.color.trim() : "";
        const clean = cleanTagName(rawName || colorName);
        if (clean) registerTag(clean.toLowerCase(), clean, mapTrelloColor(colorName));
      }
    }

    // Description, comments, attachments
    let notes = typeof card.desc === "string" ? card.desc.trim() : "";
    const comments = commentsByCard.get(cid);
    if (comments && comments.length > 0) {
      const merged = comments.map((c) => `Comment: ${c}`).join("\n");
      notes = appendNoteBlock(notes, merged);
      losses.push({
        category: "comment",
        sourceItem: title,
        field: "actions",
        count: comments.length,
        reason: `${comments.length} Trello comment(s) merged into task notes (author and timestamp metadata omitted)`,
      });
    }

    const rawAttachments = Array.isArray(card.attachments) ? (card.attachments as Array<Record<string, unknown>>) : [];
    const badgeAttachments = card.badges && typeof card.badges === "object"
      ? Number((card.badges as Record<string, unknown>).attachments ?? 0)
      : 0;
    if (rawAttachments.length > 0 || badgeAttachments > 0) {
      const linkLines: string[] = [];
      for (const att of rawAttachments) {
        if (!att || typeof att !== "object") continue;
        const url = typeof att.url === "string" ? att.url.trim() : "";
        const label = String(att.name ?? url ?? "Attachment").trim();
        if (url) linkLines.push(`[${label}](${url})`);
      }
      if (linkLines.length > 0) notes = appendNoteBlock(notes, linkLines.join("\n"));
      losses.push({
        category: "attachment",
        sourceItem: title,
        field: "attachments",
        count: rawAttachments.length || badgeAttachments,
        reason: linkLines.length > 0
          ? "Trello attachment files are not carried over; attachment URLs appended to notes"
          : "Trello attachment files cannot be carried over",
      });
    }

    if (Array.isArray(card.idMembers) && card.idMembers.length > 0) {
      losses.push({
        category: "assignee",
        sourceItem: title,
        field: "idMembers",
        count: card.idMembers.length,
        reason: `Trello member assignment(s) (${card.idMembers.length}) could not be carried over`,
      });
    }

    if (Array.isArray(card.customFieldItems) && card.customFieldItems.length > 0) {
      losses.push({
        category: "field_ignored",
        sourceItem: title,
        field: "customFieldItems",
        count: card.customFieldItems.length,
        reason: `${card.customFieldItems.length} Trello custom field value(s) ignored`,
      });
    }

    // Dates
    const startRaw = typeof card.start === "string" ? card.start.trim() : "";
    const dueRaw = typeof card.due === "string" ? card.due.trim() : "";
    const parsedStart = startRaw ? parseFlexibleDate(startRaw, { defaultTimeZone: defaultTz }) : null;
    const parsedDue = dueRaw ? parseFlexibleDate(dueRaw, { defaultTimeZone: defaultTz }) : null;
    if (startRaw && !parsedStart) {
      losses.push({ category: "invalid_date", sourceItem: title, field: "start", reason: `Could not parse Trello start date "${startRaw}"` });
    }
    if (dueRaw && !parsedDue) {
      losses.push({ category: "invalid_date", sourceItem: title, field: "due", reason: `Could not parse Trello due date "${dueRaw}"` });
    }
    const startVal = parsedStart ?? parsedDue;
    const dueVal = parsedDue ?? parsedStart;

    // Checklists (preserve order from card.idChecklists when available)
    const cardChecklistIds = Array.isArray(card.idChecklists) ? card.idChecklists.map(String) : [];
    const resolvedChecklists: Array<Record<string, unknown>> = [];
    const seenCl = new Set<string>();
    for (const clId of cardChecklistIds) {
      const cl = checklistById.get(clId);
      if (cl) {
        resolvedChecklists.push(cl);
        seenCl.add(clId);
      }
    }
    for (const cl of checklistsByCard.get(cid) ?? []) {
      const clId = typeof cl.id === "string" ? cl.id : "";
      if (!clId || !seenCl.has(clId)) resolvedChecklists.push(cl);
    }

    const multiChecklist = resolvedChecklists.length > 1;
    if (multiChecklist) {
      losses.push({
        category: "metadata",
        sourceItem: title,
        field: "checklists",
        count: resolvedChecklists.length,
        reason: `${resolvedChecklists.length} Trello checklists flattened into one NoorTasks checklist`,
      });
    }

    const items: ImportChecklistItem[] = [];
    for (const cl of resolvedChecklists) {
      const clName = String(cl.name ?? "").trim();
      const rawItems = Array.isArray(cl.checkItems)
        ? (cl.checkItems as Array<Record<string, unknown>>).filter((ci) => ci && typeof ci === "object").sort(posSort)
        : [];
      for (const ci of rawItems) {
        const itemTitle = String(ci.name ?? "").trim();
        if (!itemTitle) continue;
        const formatted = multiChecklist && clName ? `[${clName}] ${itemTitle}` : itemTitle;
        const itemId = typeof ci.id === "string" ? ci.id : undefined;
        items.push({
          ...(itemId ? { sourceId: itemId } : {}),
          title: formatted,
          status: String(ci.state ?? "").toLowerCase() === "complete" ? 1 : 0,
          sortOrder: items.length * ORDER_STEP,
        });
      }
    }

    const isChecklist = items.length > 0;
    const completedRaw = dueComplete && typeof card.dateLastActivity === "string" ? card.dateLastActivity : undefined;
    const completedParsed = completedRaw ? parseFlexibleDate(completedRaw, { defaultTimeZone: defaultTz }) : null;

    tasks.push({
      sourceId: cid,
      listKey,
      ...(sectionKey ? { sectionKey } : {}),
      title,
      kind: isChecklist ? "CHECKLIST" : "TEXT",
      ...(isChecklist ? { ...(notes ? { desc: notes } : {}), items } : notes ? { content: notes } : {}),
      status,
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
      ...(completedParsed ? { completedTime: completedParsed.wireDate } : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    });
  }

  return finalizeBundle({
    source: "trello",
    sourceLabel: "Trello",
    folders: [],
    lists,
    sections,
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}
