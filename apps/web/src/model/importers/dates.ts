import {
  formatServerDate,
  isValidTimeZone,
  parseTrigger,
  wallToInstant,
  zonedParts,
} from "../../lib/core";
import { deviceZone } from "../../lib/dates";
import type { ImportBundle, ImportCounts, ImportLossItem } from "./types";

/**
 * Common Windows timezone names (used by Microsoft To Do / Exchange / older ICS producers)
 * mapped to canonical IANA identifiers.
 */
const WINDOWS_TZ_MAP: Record<string, string> = {
  "utc": "UTC",
  "coordinated universal time": "UTC",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Budapest",
  "romance standard time": "Europe/Paris",
  "central european standard time": "Europe/Warsaw",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Helsinki",
  "gtb standard time": "Europe/Bucharest",
  "turkey standard time": "Europe/Istanbul",
  "russian standard time": "Europe/Moscow",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indianapolis",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "pacific standard time": "America/Los_Angeles",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  "atlantic standard time": "America/Halifax",
  "canada central standard time": "America/Regina",
  "sa eastern standard time": "America/Cayenne",
  "e. south america standard time": "America/Sao_Paulo",
  "india standard time": "Asia/Kolkata",
  "china standard time": "Asia/Shanghai",
  "taipei standard time": "Asia/Taipei",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "singapore standard time": "Asia/Singapore",
  "aus eastern standard time": "Australia/Sydney",
  "cen. australia standard time": "Australia/Adelaide",
  "w. australia standard time": "Australia/Perth",
  "new zealand standard time": "Pacific/Auckland",
  "arabian standard time": "Asia/Dubai",
  "israel standard time": "Asia/Jerusalem",
  "south africa standard time": "Africa/Johannesburg",
  "w. central africa standard time": "Africa/Lagos",
  "egypt standard time": "Africa/Cairo",
};

export function resolveTimeZone(raw: string | null | undefined, fallback = deviceZone()): { zone: string; lost?: string } {
  const fb = isValidTimeZone(fallback) ? fallback : "UTC";
  if (!raw || !raw.trim()) return { zone: fb };
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (isValidTimeZone(trimmed as unknown)) return { zone: trimmed };
  const mapped = WINDOWS_TZ_MAP[lower];
  if (mapped && isValidTimeZone(mapped as unknown)) return { zone: mapped };
  return {
    zone: fb,
    lost: `Unrecognized timezone "${trimmed}"; fell back to ${fb}`,
  };
}

export interface ParsedDateValue {
  wireDate: string;
  ms: number;
  isAllDay: boolean;
  isFloating: boolean;
  timeZone: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** Parse flexible date/datetime inputs from external apps into NoorTasks wire dates. */
export function parseFlexibleDate(
  raw: string,
  opts: { timeZone?: string; defaultTimeZone?: string; forceAllDay?: boolean } = {},
): ParsedDateValue | null {
  const s = raw.trim();
  if (!s) return null;

  const tzInfo = resolveTimeZone(opts.timeZone, opts.defaultTimeZone);
  const zone = tzInfo.zone;
  const hasExplicitTz = Boolean(opts.timeZone && opts.timeZone.trim());

  // 1. Date-only YYYY-MM-DD (or YYYY/MM/DD)
  const dateOnly = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (dateOnly) {
    const y = Number(dateOnly[1]), m = Number(dateOnly[2]), d = Number(dateOnly[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const ms = wallToInstant(y, m, d, 0, 0, 0, zone);
      return { wireDate: formatServerDate(ms), ms, isAllDay: true, isFloating: !hasExplicitTz, timeZone: zone };
    }
  }

  // 2. ISO / date-time with explicit offset or Z
  const isoZoned = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.exec(s);
  if (isoZoned) {
    const offRaw = isoZoned[7]!;
    const off = offRaw === "Z" ? "Z" : offRaw.includes(":") ? offRaw : `${offRaw.slice(0, 3)}:${offRaw.slice(3)}`;
    const ms = Date.parse(`${isoZoned[1]}-${isoZoned[2]}-${isoZoned[3]}T${isoZoned[4]}:${isoZoned[5]}:${isoZoned[6] ?? "00"}${off}`);
    if (!Number.isNaN(ms)) {
      if (opts.forceAllDay) {
        const y = Number(isoZoned[1]), m = Number(isoZoned[2]), d = Number(isoZoned[3]);
        const midnight = wallToInstant(y, m, d, 0, 0, 0, zone);
        return { wireDate: formatServerDate(midnight), ms: midnight, isAllDay: true, isFloating: false, timeZone: zone };
      }
      return { wireDate: formatServerDate(ms), ms, isAllDay: false, isFloating: false, timeZone: zone };
    }
  }

  // 3. Local / floating date-time without offset (YYYY-MM-DD HH:mm[:ss[.fffffff]] or T)
  const localDt = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:\s*(am|pm))?$/i.exec(s);
  if (localDt) {
    const y = Number(localDt[1]), m = Number(localDt[2]), d = Number(localDt[3]);
    let h = Number(localDt[4]);
    const min = Number(localDt[5]), sec = Number(localDt[6] ?? 0);
    const mer = localDt[7]?.toLowerCase();
    if (mer) {
      if (h < 1 || h > 12) return null;
      h = mer === "am" ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12;
    }
    if (opts.forceAllDay) {
      const ms = wallToInstant(y, m, d, 0, 0, 0, zone);
      return { wireDate: formatServerDate(ms), ms, isAllDay: true, isFloating: !hasExplicitTz, timeZone: zone };
    }
    const ms = wallToInstant(y, m, d, h, min, sec, zone);
    return { wireDate: formatServerDate(ms), ms, isAllDay: false, isFloating: !hasExplicitTz, timeZone: zone };
  }

  // 4. Natural English date ("Nov 20 2026", "Nov 20, 2026 2:30pm", "20 Nov 2026")
  const m1 = new RegExp(`^(${Object.keys(MONTHS).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?(?:\\s+(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?$`, "i").exec(s);
  if (m1) {
    const mo = MONTHS[m1[1]!.toLowerCase()]!;
    const d = Number(m1[2]);
    const y = m1[3] ? Number(m1[3]) : new Date().getUTCFullYear();
    if (m1[4]) {
      let h = Number(m1[4]);
      const min = Number(m1[5] ?? 0);
      const mer = m1[6]?.toLowerCase();
      if (mer) h = mer === "am" ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12;
      const ms = wallToInstant(y, mo, d, h, min, 0, zone);
      return { wireDate: formatServerDate(ms), ms, isAllDay: false, isFloating: !hasExplicitTz, timeZone: zone };
    }
    const ms = wallToInstant(y, mo, d, 0, 0, 0, zone);
    return { wireDate: formatServerDate(ms), ms, isAllDay: true, isFloating: !hasExplicitTz, timeZone: zone };
  }

  // 5. Fallback Date.parse for RFC 2822 / US MM/DD/YYYY
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?$/i.exec(s);
  if (us) {
    const mo = Number(us[1]), d = Number(us[2]), y = Number(us[3]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      if (us[4]) {
        let h = Number(us[4]);
        const min = Number(us[5] ?? 0);
        const mer = us[6]?.toLowerCase();
        if (mer) h = mer === "am" ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12;
        const ms = wallToInstant(y, mo, d, h, min, 0, zone);
        return { wireDate: formatServerDate(ms), ms, isAllDay: false, isFloating: !hasExplicitTz, timeZone: zone };
      }
      const ms = wallToInstant(y, mo, d, 0, 0, 0, zone);
      return { wireDate: formatServerDate(ms), ms, isAllDay: true, isFloating: !hasExplicitTz, timeZone: zone };
    }
  }

  const parsedMs = Date.parse(s);
  if (!Number.isNaN(parsedMs)) {
    return { wireDate: formatServerDate(parsedMs), ms: parsedMs, isAllDay: false, isFloating: !hasExplicitTz, timeZone: zone };
  }
  return null;
}

/**
 * Convert an absolute reminder instant into a valid NoorTasks TRIGGER string relative to task start.
 * Returns null if the offset cannot be cleanly represented as a trigger.
 */
export function buildReminderTriggerFromInstants(
  taskStartMs: number,
  alarmMs: number,
  isAllDay: boolean,
  timeZone: string,
): string | null {
  if (isAllDay) {
    const tp = zonedParts(taskStartMs, timeZone);
    const ap = zonedParts(alarmMs, timeZone);
    const taskDayUtc = Date.UTC(tp.y, tp.m - 1, tp.d);
    const alarmDayUtc = Date.UTC(ap.y, ap.m - 1, ap.d);
    const dayDiff = Math.round((alarmDayUtc - taskDayUtc) / 86_400_000);
    if (Math.abs(dayDiff) > 366) return null;
    if (dayDiff === 0 && ap.h === 0 && ap.min === 0 && ap.s === 0) return "TRIGGER:PT0S";
    if (dayDiff >= 0) {
      const cand = `TRIGGER:P${dayDiff}DT${ap.h}H${ap.min}M${ap.s}S`;
      return parseTrigger(cand) ? cand : null;
    }
    const secFromMidnight = ap.h * 3600 + ap.min * 60 + ap.s;
    const totalNegSec = -dayDiff * 86_400 - secFromMidnight;
    if (totalNegSec <= 0) return null;
    const days = Math.floor(totalNegSec / 86_400);
    const rem = totalNegSec % 86_400;
    const h = Math.floor(rem / 3600);
    const m = Math.floor((rem % 3600) / 60);
    const s = rem % 60;
    const cand = `TRIGGER:-P${days}DT${h}H${m}M${s}S`;
    return parseTrigger(cand) ? cand : null;
  }

  const diffSec = Math.round((alarmMs - taskStartMs) / 1000);
  if (Math.abs(diffSec) > 366 * 86_400) return null;
  if (diffSec === 0) return "TRIGGER:PT0S";
  const neg = diffSec < 0;
  const abs = Math.abs(diffSec);
  const sign = neg ? "-" : "";
  if (abs % 86_400 === 0) return `TRIGGER:${sign}P${abs / 86_400}D`;
  if (abs % 60 === 0 && abs < 86_400) return `TRIGGER:${sign}PT${abs / 60}M`;
  const d = Math.floor(abs / 86_400);
  const rem = abs % 86_400;
  const h = Math.floor(rem / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  const cand = d > 0 ? `TRIGGER:${sign}P${d}DT${h}H${m}M${s}S` : `TRIGGER:${sign}PT${h}H${m}M${s}S`;
  return parseTrigger(cand) ? cand : null;
}

export function computeBundleCounts(bundle: Omit<ImportBundle, "counts">): ImportCounts {
  let open = 0;
  let completed = 0;
  let wontDo = 0;
  let checklists = 0;
  let subtasks = 0;
  let notes = 0;
  const listKeys = new Set<string>();
  const tagSet = new Set<string>(bundle.tags.map((t) => t.name.toLowerCase()));

  for (const l of bundle.lists) listKeys.add(l.sourceKey);
  for (const t of bundle.tasks) {
    if (t.status === 2) completed++;
    else if (t.status === -1) wontDo++;
    else open++;
    if (t.kind === "CHECKLIST") checklists++;
    if (t.kind === "NOTE") notes++;
    if (t.parentSourceId) subtasks++;
    listKeys.add(t.listKey || "Inbox");
    for (const tag of t.tags) tagSet.add(tag.toLowerCase());
  }

  return {
    tasks: bundle.tasks.length,
    open,
    completed,
    wontDo,
    checklists,
    subtasks,
    notes,
    lists: listKeys.size,
    folders: bundle.folders.length,
    tags: tagSet.size,
    sections: bundle.sections.length,
  };
}

export function buildPreviewRows(bundle: Omit<ImportBundle, "counts" | "previewRows">): ImportBundle["previewRows"] {
  const listNames = new Map(bundle.lists.map((l) => [l.sourceKey, l.name]));
  return bundle.tasks.slice(0, 50).map((t) => ({
    title: t.title || "(Untitled)",
    list: t.listKey.toLowerCase() === "inbox" ? "Inbox" : (listNames.get(t.listKey) ?? t.listKey),
    status: t.status === 2 ? "Completed" : t.status === -1 ? "Won't Do" : "Open",
    due: t.startDate ? t.startDate.slice(0, 10) : "",
    tags: t.tags.join(", "),
  }));
}

export function finalizeBundle(
  partial: Omit<ImportBundle, "counts" | "previewRows">,
  losses?: ImportLossItem[],
): ImportBundle {
  const full = { ...partial, losses: losses ?? partial.losses };
  return {
    ...full,
    counts: computeBundleCounts(full),
    previewRows: buildPreviewRows(full),
  };
}

export function formatDueShort(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}
