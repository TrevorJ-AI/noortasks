import { parseDateExpressionForUntil } from './datetime.js';
import { LOCALES } from './locales/en.js';
import type { LocaleTable, WeekdayCode } from './locales/types.js';
import type { Range } from './masking.js';
import { touchesDisabledSeam } from './masking.js';
import {
  addDays,
  addMonths,
  compareCalendarDates,
  daysInMonth,
  formatYYYYMMDD,
  getWeekday,
} from './timezone.js';
import type { CalendarDate, LocalDateTime, RepeatParseResult } from './types.js';

const WEEKDAY_CODES: WeekdayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

const MONTH_PAT =
  '(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
const WEEKDAY_SINGULAR_PAT =
  '(?:sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)';
const WEEKDAY_PLURAL_PAT =
  '(?:sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)';
const WEEKDAY_ANY_PAT = `(?:${WEEKDAY_PLURAL_PAT}|${WEEKDAY_SINGULAR_PAT})`;
const WEEKDAY_SEP_PAT = '(?:\\s*,\\s*(?:(?:&|\\band\\b)\\s*)?|\\s*(?:/|&|\\band\\b)\\s*|\\s+)';
const WEEKDAY_LIST_PAT = `${WEEKDAY_ANY_PAT}(?:${WEEKDAY_SEP_PAT}${WEEKDAY_ANY_PAT})*`;
const ORD_PAT = '(?:1st|first|2nd|second|3rd|third|4th|fourth|5th|fifth|last)';
const INTERVAL_NUM_PAT =
  '(?:\\d+|other|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:-one|-two|-three|-four)?)';

const END_COUNT_RE = new RegExp(
  `^\\s+(?:for\\s+(${INTERVAL_NUM_PAT})\\s+(times?|occurrences?|cycles?|days?|weeks?|months?|years?)|x\\s*(\\d+))(?=$|[\\s.,;:!?)#＃!！~～^＾@＠＊*])`,
  'i',
);

const END_UNTIL_RE = /^\s+(?:until|till|ending(?:\s+on)?)\s+([^\n;#!~^@*]+)/i;

interface RawRepeatCandidate {
  start: number;
  end: number;
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  specificity: number;
  byDay?: string[];
  byMonthDay?: number;
  byMonth?: number;
  ttSkip?: string;
  ttWorkday?: 1 | -1;
  impliedPartOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
}

function parseInterval(raw: string | undefined, locale: LocaleTable): number {
  if (!raw) return 1;
  const lower = raw.trim().toLowerCase();
  if (lower in locale.numberWords) return locale.numberWords[lower]!;
  const n = Number(lower);
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

function parseWeekdayList(rawList: string, locale: LocaleTable): WeekdayCode[] {
  const tokens = rawList
    .toLowerCase()
    .split(/\s*(?:,|\/|&|\band\b)\s*|\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const seen = new Set<WeekdayCode>();
  const codes: WeekdayCode[] = [];
  for (const tok of tokens) {
    let entry = locale.weekdays[tok];
    if (!entry && tok.endsWith('s')) {
      entry = locale.weekdays[tok.slice(0, -1)];
    }
    if (entry && !seen.has(entry.code)) {
      seen.add(entry.code);
      codes.push(entry.code);
    }
  }
  return codes;
}

function nthWeekdayInMonth(year: number, month: number, ord: number, targetDow: number): CalendarDate {
  const maxD = daysInMonth(year, month);
  if (ord === -1) {
    for (let day = maxD; day >= 1; day--) {
      if (getWeekday({ year, month, day }) === targetDow) {
        return { year, month, day };
      }
    }
    return { year, month, day: maxD };
  }
  let count = 0;
  for (let day = 1; day <= maxD; day++) {
    if (getWeekday({ year, month, day }) === targetDow) {
      count++;
      if (count === ord) {
        return { year, month, day };
      }
    }
  }
  // Fallback if 5th weekday doesn't exist in month: clamp to last matching weekday.
  return nthWeekdayInMonth(year, month, -1, targetDow);
}

function monthWorkday(year: number, month: number, kind: 1 | -1): CalendarDate {
  const maxD = daysInMonth(year, month);
  if (kind === 1) {
    for (let day = 1; day <= maxD; day++) {
      const dow = getWeekday({ year, month, day });
      if (dow >= 1 && dow <= 5) return { year, month, day };
    }
  } else {
    for (let day = maxD; day >= 1; day--) {
      const dow = getWeekday({ year, month, day });
      if (dow >= 1 && dow <= 5) return { year, month, day };
    }
  }
  return { year, month, day: 1 };
}

function buildFirstOccurrenceResolver(
  cand: RawRepeatCandidate,
  locale: LocaleTable,
): (from: CalendarDate) => CalendarDate {
  const codeToDow = new Map<string, number>();
  for (const entry of Object.values(locale.weekdays)) {
    codeToDow.set(entry.code, entry.num);
  }

  return (from: CalendarDate): CalendarDate => {
    if (cand.freq === 'DAILY') {
      if (cand.ttSkip?.includes('WEEKEND')) {
        let cur = from;
        for (let i = 0; i < 7; i++) {
          const dow = getWeekday(cur);
          if (dow >= 1 && dow <= 5) return cur;
          cur = addDays(cur, 1);
        }
      }
      return from;
    }

    if (cand.freq === 'WEEKLY') {
      if (cand.byDay && cand.byDay.length > 0) {
        const targetSet = new Set(cand.byDay.map((c) => codeToDow.get(c)).filter((n): n is number => n !== undefined));
        let cur = from;
        for (let i = 0; i < 7; i++) {
          if (targetSet.has(getWeekday(cur))) return cur;
          cur = addDays(cur, 1);
        }
      }
      return from;
    }

    if (cand.freq === 'MONTHLY') {
      if (cand.ttWorkday !== undefined) {
        const curCandidate = monthWorkday(from.year, from.month, cand.ttWorkday);
        if (compareCalendarDates(curCandidate, from) >= 0) return curCandidate;
        const nextM = addMonths({ year: from.year, month: from.month, day: 1 }, 1);
        return monthWorkday(nextM.year, nextM.month, cand.ttWorkday);
      }

      if (cand.byMonthDay !== undefined) {
        const maxCur = daysInMonth(from.year, from.month);
        const dayCur = cand.byMonthDay === -1 ? maxCur : Math.min(cand.byMonthDay, maxCur);
        const curCandidate = { year: from.year, month: from.month, day: dayCur };
        if (compareCalendarDates(curCandidate, from) >= 0) return curCandidate;
        const nextM = addMonths({ year: from.year, month: from.month, day: 1 }, 1);
        const maxNext = daysInMonth(nextM.year, nextM.month);
        const dayNext = cand.byMonthDay === -1 ? maxNext : Math.min(cand.byMonthDay, maxNext);
        return { year: nextM.year, month: nextM.month, day: dayNext };
      }

      if (cand.byDay && cand.byDay.length === 1) {
        const m = /^(-?\d+)([A-Z]{2})$/.exec(cand.byDay[0]!);
        if (m) {
          const ord = Number(m[1]);
          const dow = codeToDow.get(m[2]!);
          if (dow !== undefined) {
            const curCandidate = nthWeekdayInMonth(from.year, from.month, ord, dow);
            if (compareCalendarDates(curCandidate, from) >= 0) return curCandidate;
            const nextM = addMonths({ year: from.year, month: from.month, day: 1 }, 1);
            return nthWeekdayInMonth(nextM.year, nextM.month, ord, dow);
          }
        }
      }

      return from;
    }

    // YEARLY
    if (cand.byMonth !== undefined && cand.byMonthDay !== undefined) {
      const month = cand.byMonth;
      const dayCur = Math.min(cand.byMonthDay, daysInMonth(from.year, month));
      const curCandidate = { year: from.year, month, day: dayCur };
      if (compareCalendarDates(curCandidate, from) >= 0) return curCandidate;
      const nextY = from.year + 1;
      return { year: nextY, month, day: Math.min(cand.byMonthDay, daysInMonth(nextY, month)) };
    }

    if (cand.byMonth !== undefined && cand.byDay && cand.byDay.length === 1) {
      const m = /^(-?\d+)([A-Z]{2})$/.exec(cand.byDay[0]!);
      if (m) {
        const ord = Number(m[1]);
        const dow = codeToDow.get(m[2]!);
        if (dow !== undefined) {
          const curCandidate = nthWeekdayInMonth(from.year, cand.byMonth, ord, dow);
          if (compareCalendarDates(curCandidate, from) >= 0) return curCandidate;
          return nthWeekdayInMonth(from.year + 1, cand.byMonth, ord, dow);
        }
      }
    }

    return from;
  };
}

function tryMatchFirstRepeat(text: string, locale: LocaleTable): RawRepeatCandidate | null {
  const candidates: RawRepeatCandidate[] = [];

  const collect = (
    re: RegExp,
    build: (m: RegExpExecArray) => Omit<RawRepeatCandidate, 'start' | 'end' | 'specificity'> | null,
    specificity = 2,
  ): void => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const built = build(m);
      if (built) {
        candidates.push({
          start: m.index,
          end: m.index + m[0].length,
          specificity,
          ...built,
        });
      }
    }
  };

  // 1. Yearly ordinal weekday of month ("every 2nd Sunday of May", "every year on the 4th Thursday of November")
  collect(
    new RegExp(
      `\\b(?:(?:every|each|ev)\\s+(?:(?:(${INTERVAL_NUM_PAT})\\s+)?years?\\s+(?:on\\s+)?(?:the\\s+)?)?|yearly\\s+on\\s+(?:the\\s+)?|annually\\s+on\\s+(?:the\\s+)?)(${ORD_PAT})\\s+(${WEEKDAY_SINGULAR_PAT})\\s+(?:of|in)\\s+(${MONTH_PAT})\\b`,
      'gi',
    ),
    (m) => {
      const interval = parseInterval(m[1], locale);
      const ord = locale.ordinals[m[2]!.toLowerCase()]!;
      const wd = locale.weekdays[m[3]!.toLowerCase()]!.code;
      const month = locale.months[m[4]!.toLowerCase()]!;
      return {
        freq: 'YEARLY',
        interval,
        byMonth: month,
        byDay: [`${ord}${wd}`],
      };
    },
    3,
  );

  // 2. Yearly on month + day ("every year on March 4", "every Oct 1st", "every 25th of December")
  collect(
    new RegExp(
      `\\b(?:(?:every|each|ev)\\s+(?:(?:(${INTERVAL_NUM_PAT})\\s+)?years?\\s+(?:on\\s+)?)?|yearly\\s+on\\s+|annually\\s+on\\s+)(?:the\\s+)?(?:(${MONTH_PAT})\\s+(\\d{1,2})(?:st|nd|rd|th)?|(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PAT}))\\b`,
      'gi',
    ),
    (m) => {
      const interval = parseInterval(m[1], locale);
      const monthName = (m[2] ?? m[5])!.toLowerCase();
      const dayNum = Number(m[3] ?? m[4]);
      const month = locale.months[monthName]!;
      const maxDays = daysInMonth(2024, month); // Use leap year 2024 so Feb 29 is valid.
      if (dayNum < 1 || dayNum > maxDays) return null;
      return {
        freq: 'YEARLY',
        interval,
        byMonth: month,
        byMonthDay: dayNum,
      };
    },
    3,
  );

  // 3. Monthly first / last workday
  collect(
    new RegExp(
      `\\b(?:(?:every|each|ev)\\s+(?:(${INTERVAL_NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?(first|1st|last)\\s+work\\s*day|(?:(?:every|each|ev)\\s+|on\\s+(?:the\\s+)?|the\\s+)?(first|1st|last)\\s+work\\s*day\\s+of\\s+(?:the\\s+|every\\s+|each\\s+)?(?:(${INTERVAL_NUM_PAT})\\s+)?months?|monthly\\s+on\\s+(?:the\\s+)?(first|1st|last)\\s+work\\s*day)\\b`,
      'gi',
    ),
    (m) => {
      const interval = parseInterval(m[1] ?? m[4], locale);
      const pos = (m[2] ?? m[3] ?? m[5])!.toLowerCase();
      return {
        freq: 'MONTHLY',
        interval,
        ttWorkday: pos === 'last' ? -1 : 1,
      };
    },
    3,
  );

  // 4. Monthly last day ("last day of every month", "every month on the last day", "end of every month")
  collect(
    new RegExp(
      `\\b(?:(?:every|each|ev)\\s+(?:(${INTERVAL_NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?last\\s+day|(?:on\\s+)?(?:the\\s+)?last\\s+day\\s+of\\s+(?:every|each)(?:\\s+(${INTERVAL_NUM_PAT}))?\\s+months?|(?:at\\s+)?(?:the\\s+)?end\\s+of\\s+(?:every|each)\\s+month|monthly\\s+on\\s+(?:the\\s+)?last\\s+day)\\b`,
      'gi',
    ),
    (m) => ({
      freq: 'MONTHLY',
      interval: parseInterval(m[1] ?? m[2], locale),
      byMonthDay: -1,
    }),
    3,
  );

  // 5a. Monthly ordinal weekday with explicit "month" or "monthly"
  collect(
    new RegExp(
      `\\b(?:(?:every|each|ev)\\s+(?:(${INTERVAL_NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?(${ORD_PAT})\\s+(${WEEKDAY_SINGULAR_PAT})|(?:(?:every|each|ev)\\s+|on\\s+(?:the\\s+)?|the\\s+)?(${ORD_PAT})\\s+(${WEEKDAY_SINGULAR_PAT})\\s+of\\s+(?:the|every|each)\\s+month|monthly\\s+on\\s+(?:the\\s+)?(${ORD_PAT})\\s+(${WEEKDAY_SINGULAR_PAT}))\\b`,
      'gi',
    ),
    (m) => {
      const interval = parseInterval(m[1], locale);
      const ordStr = (m[2] ?? m[4] ?? m[6])!.toLowerCase();
      const wdStr = (m[3] ?? m[5] ?? m[7])!.toLowerCase();
      const ord = locale.ordinals[ordStr]!;
      const wd = locale.weekdays[wdStr]!.code;
      return {
        freq: 'MONTHLY',
        interval,
        byDay: [`${ord}${wd}`],
      };
    },
    3,
  );

  // 5b. Shorthand "every 2nd Tuesday" / "every first Monday" / "every last Friday"
  collect(
    new RegExp(`\\b(?:every|each|ev)\\s+(${ORD_PAT})\\s+(${WEEKDAY_SINGULAR_PAT})\\b`, 'gi'),
    (m) => {
      const ord = locale.ordinals[m[1]!.toLowerCase()]!;
      const wd = locale.weekdays[m[2]!.toLowerCase()]!.code;
      return {
        freq: 'MONTHLY',
        interval: 1,
        byDay: [`${ord}${wd}`],
      };
    },
    3,
  );

  // 6. Monthly on Nth day ("every month on the 15th", "every 1st day of the month", "on the 15th of every month", "every 15th")
  collect(
    new RegExp(
      `\\b(?:(?:every|each|ev)\\s+(?:(${INTERVAL_NUM_PAT})\\s+)?months?\\s+(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+day)?|(?:every|each|ev)\\s+(\\d{1,2})(?:st|nd|rd|th)(?:\\s+day)?\\s+of\\s+(?:the|every|each)\\s+month|(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)(?:\\s+day)?\\s+of\\s+(?:every|each)\\s+month|monthly\\s+on\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+day)?|(?:every|each|ev)\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)(?:\\s+day)?(?!\\s+(?:of|in)\\s+${MONTH_PAT}))\\b`,
      'gi',
    ),
    (m) => {
      const interval = parseInterval(m[1], locale);
      const dayNum = Number(m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6]);
      if (dayNum < 1 || dayNum > 31) return null;
      return {
        freq: 'MONTHLY',
        interval,
        byMonthDay: dayNum,
      };
    },
    3,
  );

  // 7. Workday / weekday / weekend
  collect(
    /\b(?:(?:every|each|ev)\s+(?:official\s+)?(?:work\s*days?|working\s+days?|business\s+days?)|on\s+(?:official\s+)?work\s*days)\b/gi,
    () => ({
      freq: 'DAILY',
      interval: 1,
      ttSkip: 'HOLIDAY,WEEKEND',
    }),
    3,
  );

  collect(
    /\b(?:(?:every|each|ev)\s+week\s*days?|on\s+week\s*days)\b/gi,
    () => ({
      freq: 'WEEKLY',
      interval: 1,
      byDay: ['MO', 'TU', 'WE', 'TH', 'FR'],
    }),
    3,
  );

  collect(
    /\b(?:(?:every|each|ev)\s+weekends?|on\s+weekends)\b/gi,
    () => ({
      freq: 'WEEKLY',
      interval: 1,
      byDay: ['SA', 'SU'],
    }),
    3,
  );

  // 8. Weekly with specific weekday(s)
  collect(
    new RegExp(
      `\\b(?:(?:every|each|ev)\\s+(?:(${INTERVAL_NUM_PAT})\\s+)?weeks?\\s+(?:on\\s+)?|(weekly|biweekly)\\s+(?:on\\s+)?)(${WEEKDAY_LIST_PAT})\\b`,
      'gi',
    ),
    (m) => {
      const codes = parseWeekdayList(m[3]!, locale);
      if (codes.length === 0) return null;
      const interval = m[2]?.toLowerCase() === 'biweekly' ? 2 : parseInterval(m[1], locale);
      return {
        freq: 'WEEKLY',
        interval,
        byDay: codes,
      };
    },
    3,
  );

  collect(
    new RegExp(`\\b(?:every|each|ev)\\s+(?:(${INTERVAL_NUM_PAT})\\s+)?(${WEEKDAY_LIST_PAT})\\b`, 'gi'),
    (m) => {
      const codes = parseWeekdayList(m[2]!, locale);
      if (codes.length === 0) return null;
      return {
        freq: 'WEEKLY',
        interval: parseInterval(m[1], locale),
        byDay: codes,
      };
    },
    3,
  );

  collect(
    new RegExp(`\\bon\\s+(${WEEKDAY_PLURAL_PAT}(?:${WEEKDAY_SEP_PAT}${WEEKDAY_ANY_PAT})*)\\b`, 'gi'),
    (m) => {
      const codes = parseWeekdayList(m[1]!, locale);
      if (codes.length === 0) return null;
      return {
        freq: 'WEEKLY',
        interval: 1,
        byDay: codes,
      };
    },
    2,
  );

  // 9. Every morning/afternoon/evening/night -> daily cadence + implied part-of-day time
  collect(
    /\b(?:every|each|ev)\s+(morning|afternoon|evening|night)\b/gi,
    (m) => ({
      freq: 'DAILY',
      interval: 1,
      impliedPartOfDay: m[1]!.toLowerCase() as 'morning' | 'afternoon' | 'evening' | 'night',
    }),
    2,
  );

  // 10. General "every N units" and bare cadence keywords
  collect(
    new RegExp(`\\b(?:every|each|ev)\\s+(?:(${INTERVAL_NUM_PAT})\\s+)?(days?|weeks?|months?|years?)\\b`, 'gi'),
    (m) => {
      const interval = parseInterval(m[1], locale);
      const u = m[2]!.toLowerCase();
      const freq = u.startsWith('day')
        ? 'DAILY'
        : u.startsWith('week')
          ? 'WEEKLY'
          : u.startsWith('month')
            ? 'MONTHLY'
            : 'YEARLY';
      return { freq, interval };
    },
    2,
  );

  collect(
    /\b(everyday|daily|weekly|biweekly|bimonthly|monthly|quarterly|semi-?annually|semiannually|biyearly|biannually|yearly|annually)\b/gi,
    (m) => {
      const word = m[1]!.toLowerCase();
      if (word === 'everyday' || word === 'daily') return { freq: 'DAILY', interval: 1 };
      if (word === 'weekly') return { freq: 'WEEKLY', interval: 1 };
      if (word === 'biweekly') return { freq: 'WEEKLY', interval: 2 };
      if (word === 'bimonthly') return { freq: 'MONTHLY', interval: 2 };
      if (word === 'monthly') return { freq: 'MONTHLY', interval: 1 };
      if (word === 'quarterly') return { freq: 'MONTHLY', interval: 3 };
      if (word.startsWith('semi')) return { freq: 'MONTHLY', interval: 6 };
      if (word === 'biyearly' || word === 'biannually') return { freq: 'YEARLY', interval: 2 };
      return { freq: 'YEARLY', interval: 1 };
    },
    1,
  );

  if (candidates.length === 0) return null;

  // Prefer explicit multi-part phrases over bare adjectives, then earliest start and longest match.
  candidates.sort((a, b) => b.specificity - a.specificity || a.start - b.start || b.end - a.end);
  return candidates[0]!;
}

function attachEndCondition(
  cand: RawRepeatCandidate,
  maskedText: string,
  firstOccurrence: CalendarDate,
  nowParts: LocalDateTime,
  weekStart: 0 | 1 | 6,
  locale: LocaleTable,
): { end: number; count?: number; until?: CalendarDate } {
  const after = maskedText.slice(cand.end);

  // 1. Check COUNT / duration end condition ("for 5 times", "for 4 weeks", "x5")
  const countMatch = END_COUNT_RE.exec(after);
  if (countMatch) {
    if (countMatch[3]) {
      const count = Number(countMatch[3]);
      if (count >= 1) {
        return { end: cand.end + countMatch[0].length, count };
      }
    } else if (countMatch[1] && countMatch[2]) {
      const qty = parseInterval(countMatch[1], locale);
      const unit = countMatch[2].toLowerCase();
      const endPos = cand.end + countMatch[0].length;

      if (unit.startsWith('time') || unit.startsWith('occurrence') || unit.startsWith('cycle')) {
        return { end: endPos, count: qty };
      }

      const matchesFreq =
        (cand.freq === 'DAILY' && unit.startsWith('day')) ||
        (cand.freq === 'WEEKLY' && unit.startsWith('week')) ||
        (cand.freq === 'MONTHLY' && unit.startsWith('month')) ||
        (cand.freq === 'YEARLY' && unit.startsWith('year'));

      if (matchesFreq && cand.interval === 1) {
        return { end: endPos, count: qty };
      }

      // Compute UNTIL end date when cadence interval != 1 or unit differs from FREQ.
      let untilDate: CalendarDate;
      if (unit.startsWith('day')) {
        untilDate = addDays(firstOccurrence, qty - 1);
      } else if (unit.startsWith('week')) {
        untilDate = addDays(firstOccurrence, qty * 7 - 1);
      } else if (unit.startsWith('month')) {
        untilDate = addDays(addMonths(firstOccurrence, qty), -1);
      } else {
        untilDate = addDays(addMonths(firstOccurrence, qty * 12), -1);
      }
      return { end: endPos, until: untilDate };
    }
  }

  // 2. Check UNTIL end condition ("until June 1", "until Dec 31, 2026", "ending 2027-03-01")
  const untilMatch = END_UNTIL_RE.exec(after);
  if (untilMatch) {
    const rawPhrase = untilMatch[1]!.trim();
    const prefixLen = untilMatch[0].indexOf(untilMatch[1]!);
    const words = rawPhrase.split(/\s+/);
    // Try longest-to-shortest word prefixes so "until June 1 at 9am" captures "until June 1".
    for (let len = Math.min(words.length, 6); len >= 1; len--) {
      const sliceStr = words.slice(0, len).join(' ').replace(/[.,;:]+$/, '');
      if (!sliceStr) continue;
      const parsedUntil = parseDateExpressionForUntil(sliceStr, nowParts, weekStart, locale.code);
      if (parsedUntil) {
        const subIdx = untilMatch[0].indexOf(sliceStr, prefixLen);
        return {
          end: cand.end + subIdx + sliceStr.length,
          until: parsedUntil,
        };
      }
    }
  }

  return { end: cand.end };
}

function serializeRepeatFlag(
  cand: RawRepeatCandidate,
  endCond: { count?: number; until?: CalendarDate },
): string {
  const parts: string[] = [`FREQ=${cand.freq}`, `INTERVAL=${cand.interval}`];

  if (cand.byMonth !== undefined) {
    parts.push(`BYMONTH=${cand.byMonth}`);
  }
  if (cand.byMonthDay !== undefined) {
    parts.push(`BYMONTHDAY=${cand.byMonthDay}`);
  }
  if (cand.byDay && cand.byDay.length > 0) {
    parts.push(`BYDAY=${cand.byDay.join(',')}`);
  }
  if (endCond.count !== undefined) {
    parts.push(`COUNT=${endCond.count}`);
  }
  if (endCond.until !== undefined) {
    parts.push(`UNTIL=${formatYYYYMMDD(endCond.until)}`);
  }
  // TT_SKIP and TT_WORKDAY RRULE extensions are kept for wire/import compatibility.
  if (cand.ttSkip) {
    parts.push(`TT_SKIP=${cand.ttSkip}`);
  }
  if (cand.ttWorkday !== undefined) {
    parts.push(`TT_WORKDAY=${cand.ttWorkday}`);
  }

  return `RRULE:${parts.join(';')}`;
}

/**
 * Parses natural-language recurrence expressions and end conditions (`UNTIL`, `COUNT`)
 * into `RRULE:` strings.
 */
export function parseRepeatPhrase(
  originalText: string,
  maskedText: string,
  disabled: ReadonlyArray<Range>,
  opts: {
    nowParts: LocalDateTime;
    weekStart: 0 | 1 | 6;
    language: 'en';
  },
): RepeatParseResult | null {
  const locale = LOCALES[opts.language];
  const cand = tryMatchFirstRepeat(maskedText, locale);
  if (!cand) return null;

  const today: CalendarDate = {
    year: opts.nowParts.year,
    month: opts.nowParts.month,
    day: opts.nowParts.day,
  };
  const firstOccurrenceOnOrAfter = buildFirstOccurrenceResolver(cand, locale);
  const firstOcc = firstOccurrenceOnOrAfter(today);

  const endCond = attachEndCondition(cand, maskedText, firstOcc, opts.nowParts, opts.weekStart, locale);
  if (touchesDisabledSeam(originalText, cand.start, endCond.end, disabled)) {
    return null;
  }

  const repeatFlag = serializeRepeatFlag(cand, endCond);
  const out: RepeatParseResult = {
    repeatFlag,
    span: {
      start: cand.start,
      end: endCond.end,
      kind: 'repeat',
      text: originalText.slice(cand.start, endCond.end),
    },
    firstOccurrenceOnOrAfter,
  };
  if (cand.impliedPartOfDay !== undefined) {
    out.impliedPartOfDay = cand.impliedPartOfDay;
  }
  return out;
}

export { WEEKDAY_CODES };
