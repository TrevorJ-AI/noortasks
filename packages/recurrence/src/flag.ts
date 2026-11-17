import { WEEKDAYS, type Weekday } from "./civil";
import { RepeatFlagParseError } from "./errors";
import {
  CALENDAR_PREFIXES,
  type ByDay,
  type CalendarPrefix,
  type Freq,
  type RepeatModel,
  type SkipKind,
} from "./model";

const FREQS: Freq[] = ["SECONDLY", "MINUTELY", "HOURLY", "DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const SKIPS: SkipKind[] = ["HOLIDAY", "WEEKEND", "OFFICIAL_WORKDAY"];

export function emptyModel(): RepeatModel {
  return {
    prefix: "RRULE",
    byMonth: [], byMonthDay: [], byYearDay: [], byWeekNo: [], bySetPos: [], byDay: [],
    byHour: [], byMinute: [], bySecond: [],
    extras: {}, order: [], completedCount: -1, skip: [],
  };
}

function ints(v: string, flag: string, key: string): number[] {
  return v.split(",").filter((s) => s !== "").map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new RepeatFlagParseError(`Bad ${key} value "${s}"`, flag);
    return n;
  });
}

function parseByDay(v: string, flag: string): ByDay[] {
  return v.split(",").filter((s) => s !== "").map((tok) => {
    const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(tok.trim());
    if (!m) throw new RepeatFlagParseError(`Bad BYDAY token "${tok}"`, flag);
    const out: ByDay = { day: m[2] as Weekday };
    if (m[1] !== undefined) out.n = Number(m[1]);
    return out;
  });
}

/**
 * Parse a repeatFlag string. Lossless for everything it accepts, except the documented drops:
 * UNTIL with a length other than 8, 15 or 16, a trailing ";", and "BYDAY=+2MO" (written back as "2MO").
 * Returns null for null / empty input. Throws RepeatFlagParseError on malformed rules.
 */
export function parseRepeatFlag(input: string | null | undefined): RepeatModel | null {
  if (input == null) return null;
  let s = input.trim();
  if (s === "") return null;
  while (s.endsWith(";")) s = s.slice(0, -1);
  const m = emptyModel();

  const pm = /^([A-Z]+):/.exec(s);
  let body = s;
  if (pm) {
    const p = pm[1]!;
    if (p === "ERULE" || (CALENDAR_PREFIXES as readonly string[]).includes(p)) {
      m.prefix = p as RepeatModel["prefix"];
      body = s.slice(p.length + 1);
    } else {
      throw new RepeatFlagParseError(`Unknown prefix "${p}"`, input);
    }
  } else {
    m.prefix = null;
  }

  for (const part of body.split(";")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    if (eq < 0) throw new RepeatFlagParseError(`Part without "="`, input);
    const key = part.slice(0, eq);
    const val = part.slice(eq + 1);
    switch (key) {
      case "TK_COMPLETEDCOUNT": {
        const n = Number(val);
        if (!Number.isInteger(n)) throw new RepeatFlagParseError("Bad TK_COMPLETEDCOUNT", input);
        m.completedCount = n;
        break;
      }
      case "TT_SKIP":
        m.skip = val.split(",").filter((x) => x !== "").map((x) => {
          if (!SKIPS.includes(x as SkipKind)) throw new RepeatFlagParseError(`Bad TT_SKIP value "${x}"`, input);
          return x as SkipKind;
        });
        break;
      case "TK_SKIP":
        m.legacySkip = val;
        m.skip = val === "HOLIDAY" ? ["HOLIDAY", "WEEKEND"] : [];
        break;
      case "TT_WORKDAY":
        if (val !== "1" && val !== "-1") throw new RepeatFlagParseError("Bad TT_WORKDAY", input);
        m.workday = val === "1" ? 1 : -1;
        break;
      case "UNTIL":
        if (val.length === 8 || val.length === 15 || val.length === 16) {
          m.until = val;
          m.order.push(key);
        }
        break;
      case "FREQ":
        if (!FREQS.includes(val as Freq)) throw new RepeatFlagParseError(`Bad FREQ "${val}"`, input);
        m.freq = val as Freq;
        m.order.push(key);
        break;
      case "INTERVAL":
        { const v = ints(val, input, key)[0]; if (v !== undefined) m.interval = v; }
        m.order.push(key);
        break;
      case "COUNT":
        { const v = ints(val, input, key)[0]; if (v !== undefined) m.count = v; }
        m.order.push(key);
        break;
      case "WKST":
        if (!WEEKDAYS.includes(val as Weekday)) throw new RepeatFlagParseError("Bad WKST", input);
        m.wkst = val as Weekday;
        m.order.push(key);
        break;
      case "BYMONTH": m.byMonth = ints(val, input, key); m.order.push(key); break;
      case "BYMONTHDAY": m.byMonthDay = ints(val, input, key); m.order.push(key); break;
      case "BYYEARDAY": m.byYearDay = ints(val, input, key); m.order.push(key); break;
      case "BYWEEKNO": m.byWeekNo = ints(val, input, key); m.order.push(key); break;
      case "BYSETPOS": m.bySetPos = ints(val, input, key); m.order.push(key); break;
      case "BYHOUR": m.byHour = ints(val, input, key); m.order.push(key); break;
      case "BYMINUTE": m.byMinute = ints(val, input, key); m.order.push(key); break;
      case "BYSECOND": m.bySecond = ints(val, input, key); m.order.push(key); break;
      case "BYDAY": m.byDay = parseByDay(val, input); m.order.push(key); break;
      case "NAME":
        if (m.prefix !== "ERULE") { m.extras[key] = val; m.order.push(key); break; }
        if (val === "CUSTOM") m.erule = { name: "CUSTOM", byDate: [] };
        else if (val === "FORGETTINGCURVE") m.erule = { name: "FORGETTINGCURVE", cycle: 0 };
        else throw new RepeatFlagParseError(`Unknown ERULE name "${val}"`, input);
        m.order.push(key);
        break;
      case "BYDATE":
        if (m.erule?.name === "CUSTOM") { m.erule.byDate = val.split(",").filter((x) => x !== ""); m.order.push(key); }
        else { m.extras[key] = val; m.order.push(key); }
        break;
      case "CYCLE":
        if (m.erule?.name === "FORGETTINGCURVE") { m.erule.cycle = ints(val, input, key)[0] ?? 0; m.order.push(key); }
        else { m.extras[key] = val; m.order.push(key); }
        break;
      default:
        m.extras[key] = val;
        m.order.push(key);
    }
  }

  if (m.prefix === "ERULE") {
    if (!m.erule) throw new RepeatFlagParseError("ERULE without NAME", input);
  } else if (!m.freq) {
    throw new RepeatFlagParseError("Missing FREQ", input);
  }
  return m;
}

const CANON_ORDER = [
  "NAME", "BYDATE", "CYCLE",
  "FREQ", "INTERVAL", "BYMONTH", "BYWEEKNO", "BYYEARDAY", "BYMONTHDAY", "BYDAY", "BYSETPOS",
  "BYHOUR", "BYMINUTE", "BYSECOND", "WKST", "COUNT", "UNTIL",
];

function bodyValue(m: RepeatModel, key: string): string | undefined {
  switch (key) {
    case "NAME": return m.erule?.name;
    case "BYDATE": return m.erule?.name === "CUSTOM" ? m.erule.byDate.join(",") : undefined;
    case "CYCLE": return m.erule?.name === "FORGETTINGCURVE" ? String(m.erule.cycle) : undefined;
    case "FREQ": return m.freq;
    case "INTERVAL": return m.interval === undefined ? undefined : String(m.interval);
    case "COUNT": return m.count === undefined ? undefined : String(m.count);
    case "UNTIL": return m.until;
    case "WKST": return m.wkst;
    case "BYMONTH": return m.byMonth.length ? m.byMonth.join(",") : undefined;
    case "BYMONTHDAY": return m.byMonthDay.length ? m.byMonthDay.join(",") : undefined;
    case "BYYEARDAY": return m.byYearDay.length ? m.byYearDay.join(",") : undefined;
    case "BYWEEKNO": return m.byWeekNo.length ? m.byWeekNo.join(",") : undefined;
    case "BYSETPOS": return m.bySetPos.length ? m.bySetPos.join(",") : undefined;
    case "BYHOUR": return m.byHour.length ? m.byHour.join(",") : undefined;
    case "BYMINUTE": return m.byMinute.length ? m.byMinute.join(",") : undefined;
    case "BYSECOND": return m.bySecond.length ? m.bySecond.join(",") : undefined;
    case "BYDAY":
      return m.byDay.length ? m.byDay.map((d) => (d.n === undefined ? "" : String(d.n)) + d.day).join(",") : undefined;
    default: return m.extras[key];
  }
}

/**
 * Serialise. Body parts follow the order they were parsed in (byte-stable round trip); parts added later
 * follow a canonical order (FREQ, INTERVAL, BYMONTH, BYWEEKNO, BYYEARDAY, BYMONTHDAY, BYDAY, BYSETPOS,
 * BYHOUR.., WKST, COUNT, UNTIL, extras). Trailing metadata keys (TK_COMPLETEDCOUNT if >= 0, TT_SKIP or legacy TK_SKIP,
 * TT_WORKDAY) are preserved in canonical wire order for import/sync compatibility.
 */
export function serializeRepeatFlag(m: RepeatModel): string {
  const keys: string[] = [];
  for (const k of m.order) if (!keys.includes(k)) keys.push(k);
  for (const k of CANON_ORDER) if (!keys.includes(k)) keys.push(k);
  for (const k of Object.keys(m.extras)) if (!keys.includes(k)) keys.push(k);
  const parts: string[] = [];
  for (const k of keys) {
    const v = bodyValue(m, k);
    if (v !== undefined) parts.push(`${k}=${v}`);
  }
  if (m.completedCount >= 0) parts.push(`TK_COMPLETEDCOUNT=${m.completedCount}`);
  if (m.legacySkip !== undefined) parts.push(`TK_SKIP=${m.legacySkip}`);
  else if (m.skip.length) parts.push(`TT_SKIP=${m.skip.join(",")}`);
  if (m.workday !== undefined) parts.push(`TT_WORKDAY=${m.workday}`);
  const prefix = m.prefix === null ? "" : `${m.prefix}:`;
  return prefix + parts.join(";");
}

/**
 * Rewrite legacy stored flags on load: TK_SKIP=HOLIDAY becomes TT_SKIP=HOLIDAY,WEEKEND for
 * repeatFrom "2" and TT_SKIP=HOLIDAY otherwise; other TK_SKIP values are removed; TK_COMPLETEDCOUNT is removed;
 * trailing ";" removed; a WEEKEND skip whose BYDAY is only SA/SU is invalid and yields null.
 * This is a separate step so parse/serialize stay lossless.
 */
export function normalizeStoredRepeatFlag(flag: string | null | undefined, repeatFrom: string | null | undefined): string | null {
  const m = parseRepeatFlag(flag);
  if (!m) return null;
  if (m.legacySkip !== undefined) {
    m.skip = m.legacySkip === "HOLIDAY" ? (repeatFrom === "2" || repeatFrom == null ? ["HOLIDAY", "WEEKEND"] : ["HOLIDAY"]) : [];
    delete m.legacySkip;
  }
  m.completedCount = -1;
  if (m.skip.includes("WEEKEND") && m.byDay.length > 0 && m.byDay.every((d) => d.day === "SA" || d.day === "SU")) return null;
  return serializeRepeatFlag(m);
}

/** Checks the editor limits that generation relies on. Returns a list of problems (empty = fine). */
export function validateRepeatModel(m: RepeatModel): string[] {
  const out: string[] = [];
  if (m.prefix === "LUNAR") for (const d of m.byMonthDay) if (d === 0 || Math.abs(d) > 30) out.push(`lunar BYMONTHDAY ${d} unsupported`);
  if (m.interval !== undefined && m.interval < 1) out.push("INTERVAL must be >= 1");
  if (m.count !== undefined && m.count < 1) out.push("COUNT must be >= 1");
  return out;
}
