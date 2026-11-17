import { convertRruleToRepeatFlag } from "@noortasks/recurrence";
import { ORDER_STEP, formatServerDate, isValidTimeZone, parseTrigger, wallToInstant } from "../../lib/core";
import { cleanTagName } from "../../data/repo";
import { deviceZone } from "../../lib/dates";
import { buildReminderTriggerFromInstants, finalizeBundle, resolveTimeZone } from "./dates";
import { OccurrenceKeyer } from "./ids";
import type {
  ImportBundle,
  ImportList,
  ImportLossItem,
  ImportTag,
  ImportTask,
  ParseImportOptions,
} from "./types";

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface IcsAlarm {
  action: string;
  trigger?: IcsProp;
  hasRepeat: boolean;
}

interface IcsComponent {
  kind: "VTODO" | "VEVENT";
  props: IcsProp[];
  alarms: IcsAlarm[];
}

function unfoldIcs(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r?\n[ \t]/g, "");
}

function unescapeIcsText(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseContentLine(line: string): IcsProp | null {
  let inQuotes = false;
  let colonIdx = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ":" && !inQuotes) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx <= 0) return null;

  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  const segments: string[] = [];
  let cur = "";
  inQuotes = false;
  for (let i = 0; i < left.length; i++) {
    const ch = left[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ";" && !inQuotes) {
      segments.push(cur);
      cur = "";
    } else cur += ch;
  }
  segments.push(cur);

  const name = segments[0]!.trim().toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i]!;
    const eq = seg.indexOf("=");
    if (eq > 0) {
      const pk = seg.slice(0, eq).trim().toUpperCase();
      let pv = seg.slice(eq + 1).trim();
      if (pv.startsWith('"') && pv.endsWith('"') && pv.length >= 2) pv = pv.slice(1, -1);
      params[pk] = pv;
    }
  }
  return { name, params, value };
}

function parseOffsetMinutes(raw: string): number | null {
  const m = /^([+-])(\d{2})(\d{2})(?:\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function parseIcsDateProp(
  prop: IcsProp | undefined,
  defaultTz: string,
  vtimezoneOffsets: Map<string, number>,
): { ms: number; wireDate: string; isAllDay: boolean; isFloating: boolean; timeZone: string; tzLost?: string } | null {
  if (!prop) return null;
  const val = prop.value.trim();
  if (!val) return null;

  const tzidParam = prop.params.TZID;
  const isDateOnly = prop.params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(val);

  if (isDateOnly) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(val);
    if (!m) return null;
    const tzInfo = resolveTimeZone(tzidParam, defaultTz);
    const ms = wallToInstant(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, tzInfo.zone);
    return {
      ms,
      wireDate: formatServerDate(ms),
      isAllDay: true,
      isFloating: !tzidParam,
      timeZone: tzInfo.zone,
      ...(tzInfo.lost ? { tzLost: tzInfo.lost } : {}),
    };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(val);
  if (!dt) return null;
  const y = Number(dt[1]), mo = Number(dt[2]), d = Number(dt[3]);
  const h = Number(dt[4]), min = Number(dt[5]), s = Number(dt[6]);
  const isUtc = Boolean(dt[7]);

  if (isUtc) {
    const ms = Date.UTC(y, mo - 1, d, h, min, s);
    const zone = tzidParam && isValidTimeZone(tzidParam) ? tzidParam : defaultTz;
    return { ms, wireDate: formatServerDate(ms), isAllDay: false, isFloating: false, timeZone: zone };
  }

  if (tzidParam) {
    const tzInfo = resolveTimeZone(tzidParam, defaultTz);
    if (!tzInfo.lost) {
      const ms = wallToInstant(y, mo, d, h, min, s, tzInfo.zone);
      return { ms, wireDate: formatServerDate(ms), isAllDay: false, isFloating: false, timeZone: tzInfo.zone };
    }
    const vtzOff = vtimezoneOffsets.get(tzidParam);
    if (vtzOff !== undefined) {
      const ms = Date.UTC(y, mo - 1, d, h, min, s) - vtzOff * 60_000;
      return {
        ms,
        wireDate: formatServerDate(ms),
        isAllDay: false,
        isFloating: false,
        timeZone: defaultTz,
        tzLost: `Non-IANA VTIMEZONE "${tzidParam}" converted using offset; stored under ${defaultTz}`,
      };
    }
    const ms = wallToInstant(y, mo, d, h, min, s, tzInfo.zone);
    return { ms, wireDate: formatServerDate(ms), isAllDay: false, isFloating: true, timeZone: tzInfo.zone, tzLost: tzInfo.lost };
  }

  const ms = wallToInstant(y, mo, d, h, min, s, defaultTz);
  return { ms, wireDate: formatServerDate(ms), isAllDay: false, isFloating: true, timeZone: defaultTz };
}

function mapIcsPriority(raw: string | undefined): 0 | 1 | 3 | 5 {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 0;
  if (n <= 4) return 5;
  if (n === 5) return 3;
  return 1;
}

function deriveIcsListName(calName: string | undefined, opts: ParseImportOptions): string {
  if (opts.listName?.trim()) return opts.listName.trim();
  if (calName?.trim()) return calName.trim();
  if (opts.fileName?.trim()) {
    const base = opts.fileName.trim().replace(/^.*[/\\]/, "").replace(/\.ics$/i, "").trim();
    if (base) return base;
  }
  return "Reminders";
}

/** Parse Apple Reminders / iCalendar `.ics` exports (VTODO and VEVENT) into ImportBundle. */
export function parseAppleRemindersIcsBundle(text: string, opts: ParseImportOptions = {}): ImportBundle {
  const unfolded = unfoldIcs(text);
  if (!/\bBEGIN:VCALENDAR\b/i.test(unfolded) || !/\bEND:VCALENDAR\b/i.test(unfolded)) {
    throw new Error("Invalid ICS file: missing BEGIN:VCALENDAR / END:VCALENDAR");
  }

  const lines = unfolded.split(/\r?\n/);
  const stack: string[] = [];
  let calName: string | undefined;
  let calTz: string | undefined;
  let currentVtzId: string | undefined;
  const vtimezoneOffsets = new Map<string, number>();

  const components: IcsComponent[] = [];
  let currentComp: IcsComponent | null = null;
  let currentAlarm: IcsAlarm | null = null;

  for (const line of lines) {
    if (!line.trim()) continue;
    const upper = line.trim().toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const kind = upper.slice(6).trim();
      stack.push(kind);
      if (kind === "VTODO" || kind === "VEVENT") {
        currentComp = { kind, props: [], alarms: [] };
      } else if (kind === "VALARM" && currentComp) {
        currentAlarm = { action: "DISPLAY", hasRepeat: false };
      } else if (kind === "VTIMEZONE") {
        currentVtzId = undefined;
      }
      continue;
    }
    if (upper.startsWith("END:")) {
      const kind = upper.slice(4).trim();
      if (kind === "VALARM" && currentComp && currentAlarm) {
        currentComp.alarms.push(currentAlarm);
        currentAlarm = null;
      } else if ((kind === "VTODO" || kind === "VEVENT") && currentComp) {
        components.push(currentComp);
        currentComp = null;
      } else if (kind === "VTIMEZONE") {
        currentVtzId = undefined;
      }
      stack.pop();
      continue;
    }

    const prop = parseContentLine(line);
    if (!prop) continue;

    const top = stack[stack.length - 1];
    if (top === "VCALENDAR") {
      if (prop.name === "X-WR-CALNAME") calName = unescapeIcsText(prop.value).trim();
      else if (prop.name === "X-WR-TIMEZONE") calTz = prop.value.trim();
    } else if (top === "VTIMEZONE") {
      if (prop.name === "TZID") currentVtzId = prop.value.trim();
    } else if ((top === "STANDARD" || top === "DAYLIGHT") && currentVtzId) {
      if (prop.name === "TZOFFSETTO" && (!vtimezoneOffsets.has(currentVtzId) || top === "STANDARD")) {
        const off = parseOffsetMinutes(prop.value);
        if (off !== null) vtimezoneOffsets.set(currentVtzId, off);
      }
    } else if (top === "VALARM" && currentAlarm) {
      if (prop.name === "ACTION") currentAlarm.action = prop.value.trim().toUpperCase();
      else if (prop.name === "TRIGGER") currentAlarm.trigger = prop;
      else if (prop.name === "REPEAT") currentAlarm.hasRepeat = true;
    } else if ((top === "VTODO" || top === "VEVENT") && currentComp) {
      currentComp.props.push(prop);
    }
  }

  const defaultTzRes = resolveTimeZone(calTz, opts.defaultTimeZone ?? deviceZone());
  const defaultTz = defaultTzRes.zone;
  const listName = deriveIcsListName(calName, opts);
  const isInbox = listName.toLowerCase() === "inbox";
  const listKey = isInbox ? "Inbox" : listName;
  const lists: ImportList[] = isInbox ? [] : [{ sourceKey: listKey, name: listName }];
  const tagMap = new Map<string, ImportTag>();
  const tasks: ImportTask[] = [];
  const losses: ImportLossItem[] = [];
  const keyer = new OccurrenceKeyer();
  const seenUids = new Set<string>();
  let sawVevent = false;

  if (defaultTzRes.lost) {
    losses.push({ category: "field_ignored", field: "X-WR-TIMEZONE", reason: defaultTzRes.lost });
  }

  for (const comp of components) {
    const propOf = (name: string): IcsProp | undefined => comp.props.find((p) => p.name === name);
    const propsOf = (name: string): IcsProp[] => comp.props.filter((p) => p.name === name);

    const summaryProp = propOf("SUMMARY");
    const title = summaryProp ? unescapeIcsText(summaryProp.value).trim() : "(Untitled)";
    const uidProp = propOf("UID")?.value.trim();
    const recIdProp = propOf("RECURRENCE-ID");

    if (uidProp && recIdProp) {
      losses.push({
        category: "unsupported_recurrence",
        sourceItem: title,
        field: "RECURRENCE-ID",
        reason: `Single-occurrence ICS recurrence override skipped for "${title}"; parent series retained`,
      });
      continue;
    }
    if (uidProp && seenUids.has(uidProp)) {
      continue;
    }
    if (uidProp) seenUids.add(uidProp);

    if (comp.kind === "VEVENT") sawVevent = true;

    let notes = propOf("DESCRIPTION") ? unescapeIcsText(propOf("DESCRIPTION")!.value).trim() : "";
    const urlVal = propOf("URL")?.value.trim();
    if (urlVal && !notes.includes(urlVal)) {
      notes = notes ? `${notes}\n\n${urlVal}` : urlVal;
    }

    const locTitle = propOf("X-APPLE-STRUCTURED-LOCATION")?.params["X-TITLE"] ?? propOf("LOCATION")?.value;
    if (locTitle && locTitle.trim()) {
      const cleanLoc = unescapeIcsText(locTitle).trim();
      if (!notes.includes(cleanLoc)) notes = notes ? `${notes}\n\nLocation: ${cleanLoc}` : `Location: ${cleanLoc}`;
    }
    if (propOf("X-APPLE-STRUCTURED-LOCATION") || propOf("X-APPLE-PROXIMITY")) {
      losses.push({
        category: "unsupported_reminder",
        sourceItem: title,
        field: "X-APPLE-STRUCTURED-LOCATION",
        reason: "Location-based proximity trigger could not be carried over as an active alert",
      });
    }

    for (const att of propsOf("ATTACH")) {
      losses.push({
        category: "attachment",
        sourceItem: title,
        field: "ATTACH",
        reason: `ICS attachment (${att.value.slice(0, 60)}) could not be carried over`,
      });
    }

    // Status
    const rawStatus = propOf("STATUS")?.value.trim().toUpperCase() ?? "";
    const pct = Number(propOf("PERCENT-COMPLETE")?.value ?? "0");
    const completedProp = propOf("COMPLETED");
    const status: 0 | 2 | -1 =
      rawStatus === "CANCELLED"
        ? -1
        : rawStatus === "COMPLETED" || pct >= 100 || Boolean(completedProp)
          ? 2
          : 0;

    const completedParsed = parseIcsDateProp(completedProp, defaultTz, vtimezoneOffsets);
    const createdParsed = parseIcsDateProp(propOf("CREATED"), defaultTz, vtimezoneOffsets);

    // Categories -> tags
    const taskTags: string[] = [];
    for (const cp of propsOf("CATEGORIES")) {
      for (const rawCat of cp.value.split(/(?<!\\),/).map((x) => unescapeIcsText(x).trim()).filter(Boolean)) {
        const clean = cleanTagName(rawCat);
        if (!clean) continue;
        const low = clean.toLowerCase();
        if (!taskTags.includes(low)) taskTags.push(low);
        if (!tagMap.has(low)) tagMap.set(low, { name: low, label: clean });
      }
    }

    // Dates: DTSTART, DUE / DTEND
    const dtStartParsed = parseIcsDateProp(propOf("DTSTART"), defaultTz, vtimezoneOffsets);
    const dueParsed = parseIcsDateProp(propOf("DUE") ?? propOf("DTEND"), defaultTz, vtimezoneOffsets);
    if (dtStartParsed?.tzLost) losses.push({ category: "field_ignored", sourceItem: title, field: "TZID", reason: dtStartParsed.tzLost });
    if (dueParsed?.tzLost) losses.push({ category: "field_ignored", sourceItem: title, field: "TZID", reason: dueParsed.tzLost });

    const startVal = dtStartParsed ?? dueParsed;
    const dueVal = dueParsed ?? dtStartParsed;

    // Recurrence (RRULE, EXDATE, RDATE)
    const rruleProps = propsOf("RRULE");
    let repeatFlag: string | undefined;
    if (rruleProps.length > 0) {
      const conv = convertRruleToRepeatFlag(`RRULE:${rruleProps[0]!.value.trim()}`);
      if (conv.repeatFlag) repeatFlag = conv.repeatFlag;
      if (conv.lostReason) {
        losses.push({ category: "unsupported_recurrence", sourceItem: title, field: "RRULE", reason: conv.lostReason });
      }
      if (rruleProps.length > 1) {
        losses.push({
          category: "unsupported_recurrence",
          sourceItem: title,
          field: "RRULE",
          reason: `${rruleProps.length - 1} extra RRULE line(s) dropped (only one recurrence rule per task)`,
        });
      }
    }
    if (propsOf("RDATE").length > 0) {
      losses.push({
        category: "unsupported_recurrence",
        sourceItem: title,
        field: "RDATE",
        reason: "Additional RDATE occurrence dates could not be carried over",
      });
    }

    const exDate: string[] = [];
    for (const exProp of propsOf("EXDATE")) {
      for (const tok of exProp.value.split(",").map((s) => s.trim()).filter(Boolean)) {
        const m = /^(\d{4})(\d{2})(\d{2})/.exec(tok);
        if (m) exDate.push(`${m[1]}-${m[2]}-${m[3]}`);
      }
    }

    // Alarms (VALARM)
    const reminders: Array<{ trigger: string }> = [];
    for (const al of comp.alarms) {
      if (al.action === "EMAIL" || al.action === "PROCEDURE") {
        losses.push({
          category: "unsupported_reminder",
          sourceItem: title,
          field: "VALARM",
          reason: `VALARM action "${al.action}" is not supported`,
        });
        continue;
      }
      if (al.hasRepeat) {
        losses.push({
          category: "metadata",
          sourceItem: title,
          field: "VALARM.REPEAT",
          reason: "VALARM repeat count/snooze interval dropped; single reminder kept",
        });
      }
      const trigProp = al.trigger;
      if (!trigProp) continue;

      const rel = trigProp.params.RELATED?.toUpperCase() === "END" ? "END" : "START";
      const val = trigProp.value.trim();

      if (trigProp.params.VALUE?.toUpperCase() === "DATE-TIME" || /^\d{8}T\d{6}Z?$/i.test(val)) {
        const alarmParsed = parseIcsDateProp(trigProp, defaultTz, vtimezoneOffsets);
        const anchor = rel === "END" ? dueVal : startVal;
        if (alarmParsed && anchor) {
          const built = buildReminderTriggerFromInstants(anchor.ms, alarmParsed.ms, anchor.isAllDay, anchor.timeZone);
          if (built) reminders.push({ trigger: built });
          else {
            losses.push({
              category: "unsupported_reminder",
              sourceItem: title,
              field: "VALARM",
              reason: `Absolute alarm "${val}" could not be converted relative to task date`,
            });
          }
        } else {
          losses.push({
            category: "unsupported_reminder",
            sourceItem: title,
            field: "VALARM",
            reason: `Absolute alarm "${val}" on undated reminder could not be carried over`,
          });
        }
        continue;
      }

      const candidate = rel === "END" ? `TRIGGER;RELATED=END:${val}` : `TRIGGER:${val}`;
      if (parseTrigger(candidate)) {
        if (!startVal) {
          losses.push({
            category: "unsupported_reminder",
            sourceItem: title,
            field: "VALARM",
            reason: `Relative alarm "${val}" on undated reminder dropped (NoorTasks reminders require a date)`,
          });
        } else {
          reminders.push({ trigger: candidate });
        }
      } else {
        losses.push({
          category: "unsupported_reminder",
          sourceItem: title,
          field: "VALARM",
          reason: `Unsupported VALARM trigger "${val}" dropped`,
        });
      }
    }

    // Subtask relation (RELATED-TO)
    const relProp = propsOf("RELATED-TO").find((p) => !p.params.RELTYPE || p.params.RELTYPE.toUpperCase() === "PARENT");
    const parentSourceId = relProp?.value.trim() || undefined;
    const sourceId = uidProp || keyer.next(`${listKey}\0${title}`);

    tasks.push({
      sourceId,
      listKey,
      ...(parentSourceId ? { parentSourceId } : {}),
      title,
      kind: "TEXT",
      ...(notes ? { content: notes } : {}),
      status,
      priority: mapIcsPriority(propOf("PRIORITY")?.value),
      ...(startVal ? {
        startDate: startVal.wireDate,
        dueDate: (dueVal && dueVal.ms >= startVal.ms ? dueVal : startVal).wireDate,
        isAllDay: startVal.isAllDay,
        isFloating: startVal.isFloating,
        timeZone: startVal.timeZone,
      } : {}),
      ...(reminders.length ? { reminders } : {}),
      ...(repeatFlag ? { repeatFlag } : {}),
      ...(exDate.length ? { exDate } : {}),
      ...(createdParsed ? { createdTime: createdParsed.wireDate } : {}),
      ...(completedParsed ? { completedTime: completedParsed.wireDate } : {}),
      tags: taskTags,
      sortOrder: tasks.length * ORDER_STEP,
    });
  }

  if (sawVevent) {
    losses.push({
      category: "metadata",
      reason: "Calendar VEVENT components imported as tasks",
    });
  }

  return finalizeBundle({
    source: "appleReminders",
    sourceLabel: "Apple Reminders",
    folders: [],
    lists,
    sections: [],
    tags: [...tagMap.values()],
    tasks,
    losses,
  });
}
