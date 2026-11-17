import {
  CalendarItemKind,
  addDays,
  isScheduled,
  isValidStamp,
  isValidTimeZone,
  makeStamp,
  parseHabitRule,
  parseStamp,
  parseWireDate,
  stampOf,
  stampRange,
  wallToInstant,
  zonedParts,
  type Loose,
  type Task,
} from "@noortasks/core";
import { occurrencesBetween, type HolidayProvider } from "@noortasks/recurrence";
import ical, { type CalendarResponse, type ParameterValue, type VEvent } from "node-ical";

import { ApiError } from "./service.js";

/** Reject inputs with disproportionate synchronous recurrence work before invoking node-ical. */
export function assertIcsBudget(raw: string): void {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024 || (raw.match(/BEGIN:VEVENT/gi) ?? []).length > 1000 ||
      (raw.match(/^RRULE[;:]/gmi) ?? []).length > 100 || /FREQ=(?:SECONDLY|MINUTELY|HOURLY)/i.test(raw)) throw new ApiError(400, "calendar_too_complex");
}

const DAY_MS = 86_400_000;

export interface ExpandedCalendarEvent {
  id: string;
  uid: string;
  title: string;
  description?: string;
  location?: string;
  url?: string;
  startMs: number;
  endMs: number;
  isAllDay: boolean;
  timeZone?: string;
  status: "confirmed" | "tentative";
  partStat?: "accepted" | "declined" | "tentative" | "needs-action";
  isRecurring: boolean;
  isOverride: boolean;
}

export interface ParseExpandOptions {
  fromMs: number;
  toMs: number;
  userTz: string;
  sourceId: string;
}

export interface ParsedCalendarFeed {
  events: ExpandedCalendarEvent[];
  calendarName?: string;
  calendarTimeZone?: string;
}

function unfoldIcs(raw: string): string {
  return raw.replace(/\r?\n[ \t]/g, "");
}

/**
 * RFC 5545 §3.3.5: DATE-TIME values without `Z` and without `TZID` are floating local wall times.
 * When a feed defines no VTIMEZONE block, tag floating VEVENT date-times with `userTz` before
 * passing to node-ical so neither single instances nor RRULEs depend on the host OS timezone.
 */
export function preprocessFloatingTimes(icsText: string, userTz: string): string {
  const unfolded = unfoldIcs(icsText);
  if (/\bBEGIN:VTIMEZONE\b/i.test(unfolded)) return unfolded;
  const zone = isValidTimeZone(userTz) ? userTz : "UTC";
  const lines = unfolded.split(/\r?\n/);
  const stack: string[] = [];
  const out: string[] = [];

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      stack.push(upper.slice(6));
      out.push(line);
      continue;
    }
    if (upper.startsWith("END:")) {
      stack.pop();
      out.push(line);
      continue;
    }
    if (stack[stack.length - 1] === "VEVENT") {
      const m = /^(DTSTART|DTEND|RECURRENCE-ID|EXDATE|RDATE)((?:;[^:]*)?):(.*)$/i.exec(line);
      if (m) {
        const [, prop, params = "", val] = m;
        const hasTz = /(?:^|;)TZID=/i.test(params);
        const isDate = /(?:^|;)VALUE=DATE(?:$|;)/i.test(params);
        const parts = val!.split(",").map((s) => s.trim()).filter(Boolean);
        const allFloatingDateTime = parts.length > 0 && parts.every((p) => /^\d{8}T\d{6}$/.test(p));
        if (!hasTz && !isDate && allFloatingDateTime) {
          out.push(`${prop}${params};TZID=${zone}:${val}`);
          continue;
        }
      }
    }
    out.push(line);
  }
  return out.join("\r\n");
}

export function isValidIcsDocument(raw: string): boolean {
  if (typeof raw !== "string") return false;
  assertIcsBudget(raw);
  const trimmed = raw.trim();
  if (!/BEGIN:VCALENDAR/i.test(trimmed) || !/END:VCALENDAR/i.test(trimmed)) return false;
  try {
    const parsed = ical.sync.parseICS(trimmed);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function paramText(v: ParameterValue | undefined): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.val === "string") return v.val;
  return "";
}

function extractPartStat(attendee: VEvent["attendee"]): ExpandedCalendarEvent["partStat"] | undefined {
  const list = Array.isArray(attendee) ? attendee : attendee ? [attendee] : [];
  let found: ExpandedCalendarEvent["partStat"] | undefined;
  for (const a of list) {
    if (!a || typeof a !== "object" || !("params" in a)) continue;
    const raw = a.params?.PARTSTAT;
    if (typeof raw !== "string") continue;
    const up = raw.toUpperCase();
    if (up === "DECLINED") return "declined";
    if (up === "TENTATIVE") found = "tentative";
    else if (up === "ACCEPTED") found ??= "accepted";
    else if (up === "NEEDS-ACTION") found ??= "needs-action";
  }
  return found;
}

function overlapsWindow(startMs: number, endMs: number, fromMs: number, toMs: number): boolean {
  if (fromMs === toMs) {
    return endMs > startMs ? startMs <= fromMs && endMs > fromMs : startMs === fromMs;
  }
  return endMs > startMs ? endMs > fromMs && startMs < toMs : startMs >= fromMs && startMs < toMs;
}

export function parseAndExpandIcs(rawIcs: string, opts: ParseExpandOptions): ParsedCalendarFeed {
  assertIcsBudget(rawIcs);
  const userTz = isValidTimeZone(opts.userTz) ? opts.userTz : "UTC";
  const prepared = preprocessFloatingTimes(rawIcs, userTz);
  const parsed: CalendarResponse = ical.sync.parseICS(prepared);

  const vcal = parsed.vcalendar;
  const calendarName = typeof vcal?.["WR-CALNAME"] === "string" && vcal["WR-CALNAME"].trim()
    ? vcal["WR-CALNAME"].trim()
    : undefined;
  const calendarTimeZone = typeof vcal?.["WR-TIMEZONE"] === "string" && vcal["WR-TIMEZONE"].trim()
    ? vcal["WR-TIMEZONE"].trim()
    : undefined;

  const padFrom = new Date(opts.fromMs - 2 * DAY_MS);
  const padTo = new Date(opts.toMs + 2 * DAY_MS);
  const events: ExpandedCalendarEvent[] = [];
  const seenIds = new Set<string>();

  for (const comp of Object.values(parsed)) {
    if (!comp || typeof comp !== "object" || comp.type !== "VEVENT") continue;
    const vevent = comp as VEvent;
    if (!(vevent.start instanceof Date) || Number.isNaN(vevent.start.getTime())) continue;
    if (!vevent.rrule && String(vevent.status ?? "").toUpperCase() === "CANCELLED") continue;

    let instances: ReturnType<typeof ical.expandRecurringEvent>;
    try {
      instances = ical.expandRecurringEvent(vevent, {
        from: padFrom,
        to: padTo,
        includeOverrides: true,
        excludeExdates: true,
        expandOngoing: true,
        maxIterations: 10_000,
      });
    } catch {
      continue;
    }

    for (const inst of instances) {
      const ev = inst.event;
      if (String(ev?.status ?? "").toUpperCase() === "CANCELLED") continue;

      let startMs: number;
      let endMs: number;
      if (inst.isFullDay) {
        const sy = inst.start.getFullYear();
        const sm = inst.start.getMonth() + 1;
        const sd = inst.start.getDate();
        const startStamp = makeStamp(sy, sm, sd);
        const ey = inst.end.getFullYear();
        const em = inst.end.getMonth() + 1;
        const ed = inst.end.getDate();
        let endStamp = makeStamp(ey, em, ed);
        if (endStamp <= startStamp) endStamp = addDays(startStamp, 1);
        const ep = parseStamp(endStamp);
        startMs = wallToInstant(sy, sm, sd, 0, 0, 0, userTz);
        endMs = wallToInstant(ep.y, ep.m, ep.d, 0, 0, 0, userTz);
      } else {
        startMs = inst.start.getTime();
        endMs = inst.end instanceof Date && !Number.isNaN(inst.end.getTime()) ? inst.end.getTime() : startMs;
        if (endMs < startMs) endMs = startMs;
      }

      if (!overlapsWindow(startMs, endMs, opts.fromMs, opts.toMs)) continue;

      const uid = String(ev?.uid || vevent.uid || "");
      const id = `${opts.sourceId}:${uid || "evt"}:${startMs}${inst.isOverride ? ":ov" : ""}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const title = paramText(inst.summary) || paramText(vevent.summary) || "(No title)";
      const description = paramText(ev?.description) || paramText(vevent.description) || undefined;
      const location = paramText(ev?.location) || paramText(vevent.location) || undefined;
      const url = typeof ev?.url === "string" ? ev.url : typeof vevent.url === "string" ? vevent.url : undefined;
      const rawTz = inst.start.tz;
      const timeZone = inst.isFullDay ? userTz : typeof rawTz === "string" && rawTz ? rawTz : undefined;
      const evStatus = String(ev?.status ?? "").toUpperCase() === "TENTATIVE" ? "tentative" : "confirmed";
      const partStat = extractPartStat(ev?.attendee);

      events.push({
        id,
        uid,
        title,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        ...(url ? { url } : {}),
        startMs,
        endMs,
        isAllDay: inst.isFullDay,
        ...(timeZone ? { timeZone } : {}),
        status: evStatus,
        ...(partStat ? { partStat } : {}),
        isRecurring: inst.isRecurring,
        isOverride: inst.isOverride,
      });
    }
  }

  events.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  return {
    events,
    ...(calendarName ? { calendarName } : {}),
    ...(calendarTimeZone ? { calendarTimeZone } : {}),
  };
}

// ------------------------------------------------------------------ Outgoing ICS feed generator

const p2 = (n: number): string => String(n).padStart(2, "0");

function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** Fold an iCalendar line to max 75 UTF-8 octets per RFC 5545 §3.1 without splitting multi-byte chars. */
function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  const chunks: string[] = [];
  let cur = "";
  let limit = 75;
  for (const ch of line) {
    const candidate = cur + ch;
    if (Buffer.byteLength(candidate, "utf8") > limit && cur.length > 0) {
      chunks.push(cur);
      cur = ch;
      limit = 74; // continuation lines have a leading single space
    } else {
      cur = candidate;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks.join("\r\n ");
}

function formatUtcIcsDateTime(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`
  );
}

function formatLocalIcsDateTime(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${String(p.y).padStart(4, "0")}${p2(p.m)}${p2(p.d)}T${p2(p.h)}${p2(p.min)}${p2(p.s)}`;
}

function formatIcsDate(stamp: number): string {
  const p = parseStamp(stamp);
  return `${String(p.y).padStart(4, "0")}${p2(p.m)}${p2(p.d)}`;
}

function parseTaskInstant(raw: string | null | undefined, isFloating: boolean, srcTz: string, userTz: string): number | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const hasZone = /(?:Z|[+-]\d{4}|[+-]\d{2}:\d{2})$/.test(raw);
  if (!hasZone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
    if (!m) return undefined;
    return wallToInstant(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      Number(m[4] ?? 0),
      Number(m[5] ?? 0),
      Number(m[6] ?? 0),
      isFloating ? userTz : srcTz,
    );
  }
  const w = parseWireDate(raw);
  const utcMs = Number.isNaN(w) ? Date.parse(raw) : w;
  if (Number.isNaN(utcMs)) return undefined;
  if (isFloating) {
    const p = zonedParts(utcMs, srcTz);
    return wallToInstant(p.y, p.m, p.d, p.h, p.min, p.s, userTz);
  }
  return utcMs;
}

function mapPriorityToIcs(priority: number | undefined): number {
  if (priority === 5) return 1;
  if (priority === 3) return 5;
  if (priority === 1) return 9;
  return 0;
}

const STANDARD_RRULE_KEYS = new Set([
  "FREQ",
  "UNTIL",
  "COUNT",
  "INTERVAL",
  "BYSECOND",
  "BYMINUTE",
  "BYHOUR",
  "BYDAY",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
]);

function extractStandardRrule(repeatFlag: string | null | undefined, tz: string, isAllDay: boolean): string | null {
  if (typeof repeatFlag !== "string" || !repeatFlag) return null;
  const trimmed = repeatFlag.trim();
  if (/^(?:ERULE|LUNAR):/i.test(trimmed)) return null;
  // Wire repeat extension kept for backup/sync compatibility
  if (/TT_SKIP=/i.test(trimmed)) return null;
  const body = trimmed.replace(/^RRULE:/i, "");
  const kept: string[] = [];
  let hasFreq = false;

  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim().toUpperCase();
    let v = part.slice(eq + 1).trim();
    if (/[\r\n]/.test(v)) return null;
    if (!STANDARD_RRULE_KEYS.has(k)) continue;
    if (k === "FREQ") {
      if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(v.toUpperCase())) return null;
      hasFreq = true;
    }
    if (k === "UNTIL") {
      if (isAllDay) {
        v = v.replace(/[^0-9]/g, "").slice(0, 8);
        if (v.length !== 8) continue;
      } else if (/^\d{8}T\d{6}$/.test(v)) {
        const ms = wallToInstant(
          Number(v.slice(0, 4)),
          Number(v.slice(4, 6)),
          Number(v.slice(6, 8)),
          Number(v.slice(9, 11)),
          Number(v.slice(11, 13)),
          Number(v.slice(13, 15)),
          tz,
        );
        v = formatUtcIcsDateTime(ms);
      }
    }
    kept.push(`${k}=${v}`);
  }
  return hasFreq ? kept.join(";") : null;
}

function buildTaskDescription(t: Task): string {
  const parts: string[] = [];
  if (typeof t.content === "string" && t.content.trim()) parts.push(t.content.trim());
  else if (typeof t.desc === "string" && t.desc.trim()) parts.push(t.desc.trim());
  if (Array.isArray(t.items) && t.items.length > 0) {
    const lines = t.items.map((it) => `${it.status ? "[x]" : "[ ]"} ${it.title ?? ""}`);
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

export interface GenerateIcsFeedOptions {
  calName: string;
  timeZone: string;
  tasks: Task[];
  habits?: Loose[];
  includeHabits: boolean;
  holidays: HolidayProvider;
  nowMs: number;
  weekStart: string;
}

export function generateIcsFeed(opts: GenerateIcsFeedOptions): string {
  const userTz = isValidTimeZone(opts.timeZone) ? opts.timeZone : "UTC";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//NoorTasks//NoorTasks Calendar Feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(opts.calName)}`,
    `X-WR-TIMEZONE:${userTz}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT15M",
    "X-PUBLISHED-TTL:PT15M",
  ];

  const pushEvent = (fields: string[]): void => {
    lines.push("BEGIN:VEVENT");
    for (const f of fields) lines.push(foldIcsLine(f));
    lines.push("END:VEVENT");
  };

  for (const t of opts.tasks) {
    if (t.deleted) continue;
    const rawStart = t.startDate ?? t.dueDate;
    if (!rawStart) continue;

    const isAllDay = t.isAllDay !== false;
    const isFloating = t.isFloating === true;
    const srcTz = isValidTimeZone(t.timeZone) ? t.timeZone : userTz;
    const targetTz = isFloating ? userTz : srcTz;

    const startMs = parseTaskInstant(rawStart, isFloating, srcTz, userTz);
    if (startMs === undefined) continue;
    const dueMs = parseTaskInstant(t.dueDate, isFloating, srcTz, userTz);

    const modRaw = t.modifiedTime ?? t.createdTime;
    const modMs = modRaw ? parseWireDate(modRaw) : NaN;
    const dtstamp = formatUtcIcsDateTime(Number.isNaN(modMs) ? opts.nowMs : modMs);
    const desc = buildTaskDescription(t);
    const prio = mapPriorityToIcs(t.priority);
    const tags = Array.isArray(t.tags) && t.tags.length > 0 ? t.tags.map(escapeIcsText).join(",") : "";

    const computeSpan = (occStartMs: number): { dtstart: string; dtend: string } => {
      if (isAllDay) {
        const sp = zonedParts(occStartMs, targetTz);
        const startStamp = makeStamp(sp.y, sp.m, sp.d);
        let endStamp = addDays(startStamp, 1);
        if (dueMs !== undefined && dueMs > startMs) {
          const spanDays = Math.max(1, Math.round((dueMs - startMs) / DAY_MS));
          const dp = zonedParts(occStartMs + (dueMs - startMs), targetTz);
          const dueStamp = makeStamp(dp.y, dp.m, dp.d);
          if (dp.h === 0 && dp.min === 0 && dp.s === 0 && dueStamp > startStamp) {
            endStamp = dueStamp;
          } else {
            endStamp = addDays(startStamp, spanDays);
          }
        }
        return {
          dtstart: `DTSTART;VALUE=DATE:${formatIcsDate(startStamp)}`,
          dtend: `DTEND;VALUE=DATE:${formatIcsDate(endStamp)}`,
        };
      }
      const durationMs = dueMs !== undefined && dueMs > startMs ? dueMs - startMs : 30 * 60_000;
      const occEndMs = occStartMs + durationMs;
      if (t.repeatFlag && t.repeatFrom !== "1") {
        return {
          dtstart: `DTSTART;TZID=${targetTz}:${formatLocalIcsDateTime(occStartMs, targetTz)}`,
          dtend: `DTEND;TZID=${targetTz}:${formatLocalIcsDateTime(occEndMs, targetTz)}`,
        };
      }
      return {
        dtstart: `DTSTART:${formatUtcIcsDateTime(occStartMs)}`,
        dtend: `DTEND:${formatUtcIcsDateTime(occEndMs)}`,
      };
    };

    const emitTaskEvent = (uid: string, occStartMs: number, rrule?: string | null, exDates?: string[]): void => {
      const { dtstart, dtend } = computeSpan(occStartMs);
      const fields = [
        `UID:${escapeIcsText(uid)}`,
        `DTSTAMP:${dtstamp}`,
        dtstart,
        dtend,
        `SUMMARY:${escapeIcsText(t.title || "(Untitled)")}`,
        "STATUS:CONFIRMED",
      ];
      if (desc) fields.push(`DESCRIPTION:${escapeIcsText(desc)}`);
      if (prio > 0) fields.push(`PRIORITY:${prio}`);
      if (tags) fields.push(`CATEGORIES:${tags}`);
      if (rrule) fields.push(`RRULE:${rrule}`);
      if (exDates && exDates.length > 0) {
        const formattedEx: string[] = [];
        for (const ex of exDates) {
          const compact = ex.replace(/-/g, "").slice(0, 8);
          if (!/^\d{8}$/.test(compact)) continue;
          if (isAllDay) {
            formattedEx.push(compact);
          } else {
            const sp = zonedParts(occStartMs, targetTz);
            const exMs = wallToInstant(
              Number(compact.slice(0, 4)),
              Number(compact.slice(4, 6)),
              Number(compact.slice(6, 8)),
              sp.h,
              sp.min,
              sp.s,
              targetTz,
            );
            formattedEx.push(formatLocalIcsDateTime(exMs, targetTz));
          }
        }
        if (formattedEx.length > 0) {
          if (isAllDay) fields.push(`EXDATE;VALUE=DATE:${formattedEx.join(",")}`);
          else fields.push(`EXDATE;TZID=${targetTz}:${formattedEx.join(",")}`);
        }
      }
      pushEvent(fields);
    };

    if (t.repeatFlag && t.repeatFrom !== "1") {
      const stdRrule = extractStandardRrule(t.repeatFlag, targetTz, isAllDay);
      if (stdRrule) {
        emitTaskEvent(`${t.id}@noortasks`, startMs, stdRrule, Array.isArray(t.exDate) ? t.exDate : undefined);
        continue;
      }
      try {
        const occs = occurrencesBetween(
          {
            repeatFlag: t.repeatFlag,
            repeatFrom: t.repeatFrom ?? "2",
            startDate: startMs,
            timeZoneId: targetTz,
            exDates: Array.isArray(t.exDate) ? t.exDate : [],
          },
          opts.nowMs - 30 * DAY_MS,
          opts.nowMs + 180 * DAY_MS,
          { deviceZone: targetTz, defaultWeekStart: (opts.weekStart as "SU") ?? "SU", holidays: opts.holidays },
        );
        for (const d of occs) {
          emitTaskEvent(`${t.id}-${d.getTime()}@noortasks`, d.getTime());
        }
        continue;
      } catch {
        // fall through to emit single instance
      }
    }

    emitTaskEvent(`${t.id}@noortasks`, startMs);
  }

  if (opts.includeHabits && Array.isArray(opts.habits)) {
    const fromStamp = stampOf(opts.nowMs - 30 * DAY_MS, userTz);
    const toStamp = stampOf(opts.nowMs + 90 * DAY_MS, userTz);
    const stamps = stampRange(fromStamp, toStamp);
    const dtstamp = formatUtcIcsDateTime(opts.nowMs);

    for (const h of opts.habits) {
      if (!h || h.status === 1 || typeof h.id !== "string") continue;
      const rule = parseHabitRule(h.repeatRule);
      const anchor = isValidStamp(h.targetStartDate) ? h.targetStartDate : fromStamp;
      const rems = Array.isArray(h.reminders) ? h.reminders.filter((r): r is string => typeof r === "string") : [];
      const firstHm = rems.map((r) => /^(\d{1,2}):(\d{2})$/.exec(r.trim())).find(Boolean);

      for (const stamp of stamps) {
        if (!isScheduled(rule, anchor, stamp, h.exDates)) continue;
        const p = parseStamp(stamp);
        const fields: string[] = [
          `UID:habit-${escapeIcsText(h.id)}-${stamp}@noortasks`,
          `DTSTAMP:${dtstamp}`,
        ];
        if (firstHm) {
          const sMs = wallToInstant(p.y, p.m, p.d, Number(firstHm[1]), Number(firstHm[2]), 0, userTz);
          const eMs = sMs + 30 * 60_000;
          fields.push(`DTSTART:${formatUtcIcsDateTime(sMs)}`, `DTEND:${formatUtcIcsDateTime(eMs)}`);
        } else {
          const next = formatIcsDate(addDays(stamp, 1));
          fields.push(`DTSTART;VALUE=DATE:${formatIcsDate(stamp)}`, `DTEND;VALUE=DATE:${next}`);
        }
        fields.push(
          `SUMMARY:${escapeIcsText(String(h.name || "Habit"))}`,
          "STATUS:CONFIRMED",
          "CATEGORIES:Habit",
        );
        if (typeof h.encouragement === "string" && h.encouragement.trim()) {
          fields.push(`DESCRIPTION:${escapeIcsText(h.encouragement.trim())}`);
        }
        pushEvent(fields);
      }
    }
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

export { CalendarItemKind };
