import { WEEKDAYS, type Weekday } from "./civil";
import { parseRepeatFlag, serializeRepeatFlag, validateRepeatModel, emptyModel } from "./flag";
import type { ByDay, Freq, RepeatFrom, RepeatModel } from "./model";

export interface RecurrenceConvertResult {
  repeatFlag?: string;
  repeatFrom?: RepeatFrom;
  /** Present when recurrence could not convert or lost part of its semantics (for loss report). */
  lostReason?: string;
  /** Optional local wall time extracted from phrases such as "every day at 9am" or "every morning". */
  time?: { hour: number; minute: number };
  /** Optional explicit start date (YYYY-MM-DD) extracted from "starting ..." or structured recurrence range. */
  startDateIso?: string;
}

const SUPPORTED_FREQS = new Set<Freq>(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);

const WEEKDAY_MAP: Record<string, Weekday> = {
  su: "SU", sun: "SU", sunday: "SU", sundays: "SU",
  mo: "MO", mon: "MO", monday: "MO", mondays: "MO",
  tu: "TU", tue: "TU", tues: "TU", tuesday: "TU", tuesdays: "TU",
  we: "WE", wed: "WE", weds: "WE", wednesday: "WE", wednesdays: "WE",
  th: "TH", thu: "TH", thur: "TH", thurs: "TH", thursday: "TH", thursdays: "TH",
  fr: "FR", fri: "FR", friday: "FR", fridays: "FR",
  sa: "SA", sat: "SA", saturday: "SA", saturdays: "SA",
};

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const ORD_MAP: Record<string, number> = {
  "1st": 1, first: 1,
  "2nd": 2, second: 2,
  "3rd": 3, third: 3,
  "4th": 4, fourth: 4,
  "5th": 5, fifth: 5,
  last: -1,
};

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, other: 2,
  two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
};

const PART_OF_DAY_HOURS: Record<string, number> = {
  morning: 9,
  afternoon: 13,
  evening: 18,
  night: 21,
};

function parseNum(raw: string | undefined): number | null {
  if (!raw) return 1;
  const low = raw.trim().toLowerCase();
  if (low in NUM_WORDS) return NUM_WORDS[low]!;
  const n = Number(low);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function validateAndSerialize(model: RepeatModel, rawSource: string): RecurrenceConvertResult {
  const problems = validateRepeatModel(model);
  if (problems.length > 0) {
    return { lostReason: `Invalid recurrence "${rawSource}": ${problems.join("; ")}` };
  }
  if (model.prefix !== "ERULE") {
    if (!model.freq || !SUPPORTED_FREQS.has(model.freq)) {
      return { lostReason: `Unsupported recurrence frequency "${model.freq ?? "unknown"}" in "${rawSource}"` };
    }
    if (model.byHour.length || model.byMinute.length || model.bySecond.length) {
      return { lostReason: `Sub-day recurrence parts (BYHOUR/BYMINUTE/BYSECOND) in "${rawSource}" are not supported` };
    }
    if ("BYEASTER" in model.extras) {
      return { lostReason: `BYEASTER recurrence in "${rawSource}" is not supported` };
    }
  }
  if (model.prefix === null) model.prefix = "RRULE";
  if (model.interval === undefined && model.prefix === "RRULE") model.interval = 1;
  const repeatFlag = serializeRepeatFlag(model);
  const unknownKeys = Object.keys(model.extras).filter((k) => !k.startsWith("TT_"));
  if (unknownKeys.length > 0) {
    return {
      repeatFlag,
      lostReason: `Unsupported RRULE parameter(s) (${unknownKeys.join(", ")}) ignored during recurrence conversion`,
    };
  }
  return { repeatFlag };
}

/** Validate and normalize an RFC 5545 / NoorTasks RRULE string through packages/recurrence. */
export function convertRruleToRepeatFlag(raw: string): RecurrenceConvertResult {
  const trimmed = raw.trim();
  if (!trimmed) return { lostReason: "Empty recurrence rule" };

  // Normalize key case for standard RFC 5545 RRULEs (e.g., "freq=weekly;byday=mo")
  let normalized = trimmed;
  const colonIdx = normalized.indexOf(":");
  if (colonIdx > 0 && /^[A-Za-z]+$/.test(normalized.slice(0, colonIdx))) {
    const pfx = normalized.slice(0, colonIdx).toUpperCase();
    const rest = normalized.slice(colonIdx + 1);
    normalized = `${pfx}:${rest}`;
  } else if (!/^[A-Z]+:/i.test(normalized)) {
    normalized = `RRULE:${normalized}`;
  }

  const sep = normalized.indexOf(":");
  const prefix = normalized.slice(0, sep);
  const body = normalized
    .slice(sep + 1)
    .split(";")
    .filter((p) => p.trim() !== "")
    .map((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return p;
      const k = p.slice(0, eq).trim().toUpperCase();
      const v = p.slice(eq + 1).trim();
      if (k.startsWith("X-")) return `${k}=${v}`;
      return `${k}=${v.toUpperCase()}`;
    })
    .join(";");

  try {
    const model = parseRepeatFlag(`${prefix}:${body}`);
    if (!model) return { lostReason: `Empty recurrence rule "${raw}"` };
    return validateAndSerialize(model, raw);
  } catch (e) {
    return { lostReason: `Unsupported RRULE "${raw}": ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Convert todo.txt `rec:` value (`rec:1d`, `rec:+1w`, `rec:2m`, `rec:1y`, `rec:1b`) to RRULE. */
export function convertTodoTxtRepeatToRepeatFlag(raw: string): RecurrenceConvertResult {
  const s = raw.trim().replace(/^rec:/i, "");
  const m = /^(\+)?(\d+)(d|w|m|y|bd?)$/i.exec(s);
  if (!m) {
    return { lostReason: `Unsupported todo.txt recurrence "rec:${s}"` };
  }
  const strict = m[1] === "+";
  const interval = Number(m[2]);
  if (!Number.isInteger(interval) || interval < 1) {
    return { lostReason: `Invalid todo.txt recurrence interval in "rec:${s}"` };
  }
  const unit = m[3]!.toLowerCase();
  const repeatFrom: RepeatFrom = strict ? "0" : "1";

  const model = emptyModel();
  model.interval = interval;
  if (unit === "b" || unit === "bd") {
    if (interval !== 1) {
      return { lostReason: `Unsupported todo.txt business-day interval "${s}" (only interval 1 is supported)` };
    }
    model.freq = "DAILY";
    model.skip = ["HOLIDAY", "WEEKEND"];
  } else {
    model.freq = unit === "d" ? "DAILY" : unit === "w" ? "WEEKLY" : unit === "m" ? "MONTHLY" : "YEARLY";
  }

  const out = validateAndSerialize(model, `rec:${s}`);
  if (out.repeatFlag) out.repeatFrom = repeatFrom;
  return out;
}

const MS_DOW: Record<string, Weekday> = {
  sunday: "SU", monday: "MO", tuesday: "TU", wednesday: "WE", thursday: "TH", friday: "FR", saturday: "SA",
};

const MS_INDEX: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, last: -1,
};

/** Convert Microsoft Graph `PatternedRecurrence` JSON object to RRULE. */
export function convertMsTodoRecurrenceToRepeatFlag(rec: unknown): RecurrenceConvertResult {
  if (!rec || typeof rec !== "object") {
    return { lostReason: "Invalid Microsoft To Do recurrence object" };
  }
  const r = rec as Record<string, unknown>;
  const pat = r.pattern as Record<string, unknown> | undefined;
  const range = r.range as Record<string, unknown> | undefined;
  if (!pat || typeof pat !== "object") {
    return { lostReason: "Microsoft To Do recurrence missing pattern" };
  }

  const type = typeof pat.type === "string" ? pat.type : "";
  const interval = typeof pat.interval === "number" && Number.isInteger(pat.interval) && pat.interval >= 1 ? pat.interval : 1;
  const model = emptyModel();
  model.interval = interval;

  const parseDays = (): Weekday[] | null => {
    if (!Array.isArray(pat.daysOfWeek) || pat.daysOfWeek.length === 0) return null;
    const out: Weekday[] = [];
    for (const d of pat.daysOfWeek) {
      const wd = typeof d === "string" ? MS_DOW[d.toLowerCase()] : undefined;
      if (!wd) return null;
      if (!out.includes(wd)) out.push(wd);
    }
    return out;
  };

  if (typeof pat.firstDayOfWeek === "string") {
    const wk = MS_DOW[pat.firstDayOfWeek.toLowerCase()];
    if (wk) model.wkst = wk;
  }

  switch (type) {
    case "daily":
      model.freq = "DAILY";
      break;
    case "weekly": {
      model.freq = "WEEKLY";
      if (pat.daysOfWeek !== undefined) {
        const days = parseDays();
        if (!days) return { lostReason: `Invalid daysOfWeek in weekly Microsoft To Do recurrence` };
        model.byDay = days.map((day) => ({ day }));
      }
      break;
    }
    case "absoluteMonthly": {
      model.freq = "MONTHLY";
      const dom = typeof pat.dayOfMonth === "number" ? pat.dayOfMonth : undefined;
      if (!dom || dom < 1 || dom > 31) return { lostReason: `Invalid dayOfMonth (${String(pat.dayOfMonth)}) in monthly recurrence` };
      model.byMonthDay = [dom];
      break;
    }
    case "relativeMonthly": {
      model.freq = "MONTHLY";
      const days = parseDays();
      const idx = typeof pat.index === "string" ? MS_INDEX[pat.index.toLowerCase()] : undefined;
      if (!days || idx === undefined) return { lostReason: `Unsupported relativeMonthly recurrence parameters` };
      model.byDay = days.map((day) => ({ n: idx, day }));
      break;
    }
    case "absoluteYearly": {
      model.freq = "YEARLY";
      const month = typeof pat.month === "number" ? pat.month : undefined;
      const dom = typeof pat.dayOfMonth === "number" ? pat.dayOfMonth : undefined;
      if (!month || month < 1 || month > 12 || !dom || dom < 1 || dom > 31) {
        return { lostReason: `Invalid month/dayOfMonth in yearly Microsoft To Do recurrence` };
      }
      model.byMonth = [month];
      model.byMonthDay = [dom];
      break;
    }
    case "relativeYearly": {
      model.freq = "YEARLY";
      const month = typeof pat.month === "number" ? pat.month : undefined;
      const days = parseDays();
      const idx = typeof pat.index === "string" ? MS_INDEX[pat.index.toLowerCase()] : undefined;
      if (!month || month < 1 || month > 12 || !days || idx === undefined) {
        return { lostReason: `Unsupported relativeYearly Microsoft To Do recurrence parameters` };
      }
      model.byMonth = [month];
      model.byDay = days.map((day) => ({ n: idx, day }));
      break;
    }
    default:
      return { lostReason: `Unsupported Microsoft To Do recurrence pattern "${type}"` };
  }

  let startDateIso: string | undefined;
  if (range && typeof range === "object") {
    if (typeof range.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(range.startDate)) {
      startDateIso = range.startDate;
    }
    const rangeType = typeof range.type === "string" ? range.type : "noEnd";
    if (rangeType === "endDate" && typeof range.endDate === "string") {
      const compact = range.endDate.replace(/-/g, "").slice(0, 8);
      if (/^\d{8}$/.test(compact)) model.until = compact;
    } else if (rangeType === "numbered" && typeof range.numberOfOccurrences === "number" && range.numberOfOccurrences >= 1) {
      model.count = Math.floor(range.numberOfOccurrences);
    }
  }

  const out = validateAndSerialize(model, JSON.stringify(rec));
  if (startDateIso) out.startDateIso = startDateIso;
  if (out.repeatFlag) out.repeatFrom = "2";
  return out;
}

function parseSimpleDateIso(raw: string): string | null {
  const s = raw.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const y = Number(iso[1]), m = Number(iso[2]), d = Number(iso[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  const md = new RegExp(`^(${Object.keys(MONTH_MAP).join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?$`, "i").exec(s);
  if (md) {
    const m = MONTH_MAP[md[1]!.toLowerCase()]!;
    const d = Number(md[2]);
    const y = md[3] ? Number(md[3]) : new Date().getUTCFullYear();
    if (d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return null;
}

function parseClockTime(raw: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const mer = m[3]?.toLowerCase();
  if (min < 0 || min > 59) return null;
  if (mer) {
    if (h < 1 || h > 12) return null;
    if (mer === "am") h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (!m[2] || h < 0 || h > 23) {
    return null;
  }
  return { hour: h, minute: min };
}

function parseWeekdaysList(raw: string): Weekday[] | null {
  const tokens = raw
    .toLowerCase()
    .split(/\s*(?:,|\/|&|\band\b)\s*|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out: Weekday[] = [];
  for (const tok of tokens) {
    const wd = WEEKDAY_MAP[tok];
    if (!wd) return null;
    if (!out.includes(wd)) out.push(wd);
  }
  return out.length > 0 ? out : null;
}

const MONTH_PAT = Object.keys(MONTH_MAP).join("|");
const WD_SING_PAT = "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat";
const WD_ANY_PAT = `(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|${WD_SING_PAT})`;
const WD_LIST_PAT = `${WD_ANY_PAT}(?:(?:\\s*,\\s*(?:(?:&|\\band\\b)\\s*)?|\\s*(?:/|&|\\band\\b)\\s*|\\s+)${WD_ANY_PAT})*`;
const ORD_PAT = "1st|first|2nd|second|3rd|third|4th|fourth|5th|fifth|last";
const NUM_PAT = "\\d+|other|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve";

/**
 * Convert Todoist / natural-language English recurrence expressions into NoorTasks RRULE strings.
 * Handles `every` (schedule) vs `every!` / `after` (from completion), trailing time, `starting`, `until`/`ending`, and `for N times`.
 */
export function convertTodoistRepeatToRepeatFlag(raw: string, opts: { dateLang?: string } = {}): RecurrenceConvertResult {
  const original = raw.trim();
  if (!original) return { lostReason: "Empty recurrence expression" };

  let work = original;
  let repeatFrom: RepeatFrom = "2";
  if (/\b(?:every|ev)!/i.test(work) || /^\s*after\b/i.test(work)) {
    repeatFrom = "1";
    work = work.replace(/\b(every|ev)!/gi, "$1").replace(/^\s*after\s+/i, "every ");
  }

  // Extract optional "at <time>" anywhere before end or another clause
  let time: { hour: number; minute: number } | undefined;
  work = work.replace(/\s+(?:at|@)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?=$|\s+(?:starting|from|until|till|ending|for|x\d))/i, (_, t: string) => {
    const parsed = parseClockTime(t);
    if (parsed) time = parsed;
    return "";
  });

  // Extract optional "starting <date>" or "from <date>"
  let startDateIso: string | undefined;
  let startWarn: string | undefined;
  work = work.replace(/\s+(?:starting|from)\s+([^\n]+?)(?=$|\s+(?:at|@|until|till|ending|for|x\d))/i, (_, d: string) => {
    const iso = parseSimpleDateIso(d);
    if (iso) startDateIso = iso;
    else startWarn = `Could not parse recurrence start date "${d.trim()}"`;
    return "";
  });

  // Catch trailing "at <time>" that followed "starting <date>"
  if (!time) {
    work = work.replace(/\s+(?:at|@)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?=$|\s+(?:until|till|ending|for|x\d))/i, (_, t: string) => {
      const parsed = parseClockTime(t);
      if (parsed) time = parsed;
      return "";
    });
  }

  // Extract optional "until/ending <date>"
  let untilCompact: string | undefined;
  let untilWarn: string | undefined;
  work = work.replace(/\s+(?:until|till|ending(?:\s+on)?)\s+([^\n]+?)(?=$|\s+(?:for|x\d))/i, (_, d: string) => {
    const iso = parseSimpleDateIso(d);
    if (iso) untilCompact = iso.replace(/-/g, "");
    else untilWarn = `Could not parse recurrence end date "${d.trim()}"`;
    return "";
  });

  // Extract optional "for N times" / "xN"
  let count: number | undefined;
  work = work.replace(/\s+(?:for\s+(\d+)\s+times?|x\s*(\d+))$/i, (_, a?: string, b?: string) => {
    const n = Number(a ?? b);
    if (Number.isInteger(n) && n >= 1) count = n;
    return "";
  });

  work = work.replace(/\s+/g, " ").trim();

  const model = emptyModel();
  if (untilCompact) model.until = untilCompact;
  if (count !== undefined) model.count = count;

  let matched = false;
  let m: RegExpExecArray | null;

  // 1. Yearly ordinal weekday of month ("every 2nd Sunday of May")
  if (!matched && (m = new RegExp(`^(?:(?:every|each|ev)\\s+(?:(?:(${NUM_PAT})\\s+)?years?\\s+(?:on\\s+)?(?:the\\s+)?)?|yearly\\s+on\\s+(?:the\\s+)?)(${ORD_PAT})\\s+(${WD_SING_PAT})\\s+(?:of|in)\\s+(${MONTH_PAT})$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    const ord = ORD_MAP[m[2]!.toLowerCase()];
    const wd = WEEKDAY_MAP[m[3]!.toLowerCase()];
    const month = MONTH_MAP[m[4]!.toLowerCase()];
    if (interval && ord !== undefined && wd && month) {
      model.freq = "YEARLY";
      model.interval = interval;
      model.byMonth = [month];
      model.byDay = [{ n: ord, day: wd }];
      matched = true;
    }
  }

  // 2. Yearly on Month + Day ("every year on March 4", "every May 5", "every 4th of March")
  if (!matched && (m = new RegExp(`^(?:(?:every|each|ev)\\s+(?:(?:(${NUM_PAT})\\s+)?years?\\s+(?:on\\s+)?)?|yearly\\s+on\\s+)(?:the\\s+)?(?:(${MONTH_PAT})\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PAT}))$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    const month = MONTH_MAP[(m[2] ?? m[5])!.toLowerCase()];
    const dom = Number(m[3] ?? m[4]);
    if (interval && month && dom >= 1 && dom <= 31) {
      model.freq = "YEARLY";
      model.interval = interval;
      model.byMonth = [month];
      model.byMonthDay = [dom];
      matched = true;
    }
  }

  // 3. Monthly first / last workday
  if (!matched && (m = new RegExp(`^(?:(?:every|each|ev)\\s+(?:(${NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?(first|1st|last)\\s+work\\s*day|(?:every|each|ev)\\s+(first|1st|last)\\s+work\\s*day(?:\\s+of\\s+(?:the\\s+|every\\s+)?months?)?)$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    const pos = (m[2] ?? m[3])!.toLowerCase();
    if (interval) {
      model.freq = "MONTHLY";
      model.interval = interval;
      model.workday = pos === "last" ? -1 : 1;
      matched = true;
    }
  }

  // 4. Monthly last day
  if (!matched && (m = new RegExp(`^(?:(?:every|each|ev)\\s+(?:(${NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?last\\s+day|(?:every|each|ev)\\s+last\\s+day(?:\\s+of\\s+(?:the|every)\\s+month)?)$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    if (interval) {
      model.freq = "MONTHLY";
      model.interval = interval;
      model.byMonthDay = [-1];
      matched = true;
    }
  }

  // 5. Monthly ordinal weekday ("every 2nd Tuesday", "every month on the last Friday")
  if (!matched && (m = new RegExp(`^(?:(?:every|each|ev)\\s+(?:(${NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?(${ORD_PAT})\\s+(${WD_SING_PAT})|(?:every|each|ev)\\s+(${ORD_PAT})\\s+(${WD_SING_PAT}))$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    const ord = ORD_MAP[(m[2] ?? m[4])!.toLowerCase()];
    const wd = WEEKDAY_MAP[(m[3] ?? m[5])!.toLowerCase()];
    if (interval && ord !== undefined && wd) {
      model.freq = "MONTHLY";
      model.interval = interval;
      model.byDay = [{ n: ord, day: wd }];
      matched = true;
    }
  }

  // 6. Monthly Nth day ("every 15th", "every month on the 15th", "every 2 months on the 1st")
  if (!matched && (m = new RegExp(`^(?:(?:every|each|ev)\\s+(?:(${NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+day)?|(?:every|each|ev)\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)(?:\\s+day)?(?:\\s+of\\s+(?:the|every)\\s+month)?)$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    const dom = Number(m[2] ?? m[3]);
    if (interval && dom >= 1 && dom <= 31) {
      model.freq = "MONTHLY";
      model.interval = interval;
      model.byMonthDay = [dom];
      matched = true;
    }
  }

  // 7. Workdays / weekdays / weekends
  if (!matched && /^(?:every|each|ev)\s+(?:official\s+)?(?:work\s*days?|working\s+days?|business\s+days?)$/i.test(work)) {
    model.freq = "DAILY";
    model.interval = 1;
    model.skip = ["HOLIDAY", "WEEKEND"];
    matched = true;
  }
  if (!matched && /^(?:every|each|ev)\s+week\s*days?$/i.test(work)) {
    model.freq = "WEEKLY";
    model.interval = 1;
    model.byDay = (["MO", "TU", "WE", "TH", "FR"] as const).map((day) => ({ day }));
    matched = true;
  }
  if (!matched && /^(?:every|each|ev)\s+weekends?$/i.test(work)) {
    model.freq = "WEEKLY";
    model.interval = 1;
    model.byDay = (["SA", "SU"] as const).map((day) => ({ day }));
    matched = true;
  }

  // 8. Weekly with specific weekdays ("every mon, wed", "every 2 weeks on Tue, Thu")
  if (!matched && (m = new RegExp(`^(?:(?:every|each|ev)\\s+(?:(${NUM_PAT})\\s+)?weeks?\\s+(?:on\\s+)?|(?:weekly|biweekly)\\s+on\\s+)(${WD_LIST_PAT})$`, "i").exec(work))) {
    const interval = /^biweekly/i.test(work) ? 2 : parseNum(m[1]);
    const days = parseWeekdaysList(m[2]!);
    if (interval && days) {
      model.freq = "WEEKLY";
      model.interval = interval;
      model.byDay = days.map((day) => ({ day }));
      matched = true;
    }
  }
  if (!matched && (m = new RegExp(`^(?:every|each|ev)\\s+(?:(${NUM_PAT})\\s+)?(${WD_LIST_PAT})$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    const days = parseWeekdaysList(m[2]!);
    if (interval && days) {
      model.freq = "WEEKLY";
      model.interval = interval;
      model.byDay = days.map((day) => ({ day }));
      matched = true;
    }
  }

  // 9. Part of day ("every morning", "every evening")
  if (!matched && (m = /^(?:every|each|ev)\s+(morning|afternoon|evening|night)$/i.exec(work))) {
    model.freq = "DAILY";
    model.interval = 1;
    if (!time) time = { hour: PART_OF_DAY_HOURS[m[1]!.toLowerCase()]!, minute: 0 };
    matched = true;
  }

  // 10. General "every N units" / keywords
  if (!matched && (m = new RegExp(`^(?:every|each|ev)\\s+(?:(${NUM_PAT})\\s+)?(days?|weeks?|wks?|months?|mos?|years?|yrs?|quarters?)$`, "i").exec(work))) {
    const interval = parseNum(m[1]);
    const u = m[2]!.toLowerCase();
    if (interval) {
      if (u.startsWith("day")) model.freq = "DAILY";
      else if (u.startsWith("w")) model.freq = "WEEKLY";
      else if (u.startsWith("q")) {
        model.freq = "MONTHLY";
        model.interval = interval * 3;
      } else if (u.startsWith("mo")) model.freq = "MONTHLY";
      else model.freq = "YEARLY";
      model.interval ??= interval;
      matched = true;
    }
  }

  if (!matched && (m = /^(everyday|daily|weekly|biweekly|bimonthly|monthly|quarterly|semi-?annually|semiannually|biyearly|biannually|yearly|annually)$/i.exec(work))) {
    const w = m[1]!.toLowerCase();
    if (w === "everyday" || w === "daily") { model.freq = "DAILY"; model.interval = 1; }
    else if (w === "weekly") { model.freq = "WEEKLY"; model.interval = 1; }
    else if (w === "biweekly") { model.freq = "WEEKLY"; model.interval = 2; }
    else if (w === "bimonthly") { model.freq = "MONTHLY"; model.interval = 2; }
    else if (w === "monthly") { model.freq = "MONTHLY"; model.interval = 1; }
    else if (w === "quarterly") { model.freq = "MONTHLY"; model.interval = 3; }
    else if (w.startsWith("semi")) { model.freq = "MONTHLY"; model.interval = 6; }
    else if (w === "biyearly" || w === "biannually") { model.freq = "YEARLY"; model.interval = 2; }
    else { model.freq = "YEARLY"; model.interval = 1; }
    matched = true;
  }

  if (!matched) {
    const lang = opts.dateLang?.trim().toLowerCase();
    if (lang && !lang.startsWith("en")) {
      return { lostReason: `Unsupported non-English recurrence (${opts.dateLang}): "${original}"` };
    }
    return { lostReason: `Unsupported recurrence expression: "${original}"` };
  }

  const res = validateAndSerialize(model, original);
  if (!res.repeatFlag) return res;
  res.repeatFrom = repeatFrom;
  if (time) res.time = time;
  if (startDateIso) res.startDateIso = startDateIso;
  const partialWarnings = [startWarn, untilWarn].filter(Boolean);
  if (partialWarnings.length > 0) res.lostReason = partialWarnings.join("; ");
  return res;
}

export { WEEKDAYS };
