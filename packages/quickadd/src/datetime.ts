import * as chrono from 'chrono-node';
import { LOCALES } from './locales/en.js';
import type { LocaleTable } from './locales/types.js';
import type { Range } from './masking.js';
import { overlapsAny, touchesDisabledSeam } from './masking.js';
import {
  addDays,
  addMonths,
  daysInMonth,
  getWeekStartDate,
  getWeekday,
  isValidCalendarDate,
  toChronoReferenceDate,
} from './timezone.js';
import type { CalendarDate, LocalDateTime, ParsedDateTimeInfo, RecognizedSpan } from './types.js';

const UNIT_DURATION_RE =
  /^\s+for\s+(half\s+(?:an?\s+)?|\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(minutes?|mins?|m(?![a-z])|hours?|hrs?|h(?![a-z])|days?|d(?![a-z])|weeks?|wks?|w(?![a-z]))(?:\s+(?:and\s+)?(\d+)\s*(minutes?|mins?|m(?![a-z])))?(?=$|[\s.,;:!?)])/i;

const STANDALONE_TIME_DURATION_RE =
  /\bfor\s+(half\s+(?:an?\s+)?|\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)(?:\s+(?:and\s+)?(\d+)\s*(minutes?|mins?))?(?=$|[\s.,;:!?)])/i;

const ELAPSED_RELATIVE_RE =
  /^(?:in|after)\s+(half\s+(?:an?\s+)?|\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:-one|-two|-three|-four)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)(?:\s+from\s+now)?$/i;

const LATER_RELATIVE_RE =
  /^(half\s+(?:an?\s+)?|\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:-one|-two|-three|-four)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\s+later$/i;

const DOT_TIME_RE = /(?:^|(?<=[\s(])|(?<=\b(?:at|from|until|till|to)\s))(\d{1,2})\.(\d{2})(?:\s*(a\.?m\.?|p\.?m\.?|a\.|p\.))?(?=$|[\s.,;:!?)\]-])/gi;

const CURRENCY_OR_VERSION_BEFORE = /[$€£¥₹#vV.]$/;
const BAD_DOT_TIME_FOLLOWERS = /^\s*(?:\.|%|kg|g|lb|lbs|oz|km|m\b|cm|mm|mi|ft|usd|eur|euros?|dollars?|cents?|gbp|chf|cad|aud|mb|gb|kb|tb|ghz|mhz)/i;

const FORCED_DATE_OPTIONS_RE = new RegExp(
  [
    // day after tomorrow
    '(?:the\\s+)?day\\s+after\\s+tomorrow',
    // ISO date with optional time
    '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}(?:[T\\s]\\d{1,2}:\\d{2}(?::\\d{2})?)?',
    // numeric date M/D/Y or M/D
    '\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?\\b',
    // this/next + weekday/week/month/weekend/year
    '(?:this|next|last)\\s+(?:monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun|week|weekend|month|year)\\b',
    // end/beginning of month/week/year
    '(?:at\\s+the\\s+)?(?:beginning|start|end|last\\s+day)\\s+of\\s+(?:(?:this|the|next)\\s+)?(?:week|month|year)\\b',
    // Month + day (+ optional year) or standalone month (forced by *)
    '(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\s+\\d{4})?\\b',
    // Day + Month (+ optional year)
    '\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)(?:,?\\s+\\d{4})?\\b',
    // Casual days & weekdays
    '(?:yesterday|today|tod|tomorrow|tom|tmrw|tmr|tonight|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\\b',
    // Time
    '(?:\\d{1,2}(?:[:.]\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)|\\d{1,2}:\\d{2}|noon|midnight)\\b',
  ].join('|'),
  'iy',
);

function parseNumberToken(raw: string, locale: LocaleTable): number | null {
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith('half')) return 0.5;
  if (lower in locale.numberWords) return locale.numberWords[lower]!;
  const n = Number(lower);
  return Number.isFinite(n) ? n : null;
}

function getWordBefore(text: string, index: number): string | null {
  const before = text.slice(0, index);
  const m = /([a-zA-Z]+)\s+$/.exec(before);
  return m ? m[1]!.toLowerCase() : null;
}

function getRawTokenBefore(text: string, index: number): string | null {
  const before = text.slice(0, index);
  const m = /([a-zA-Z]+)\s+$/.exec(before);
  return m ? m[1]! : null;
}

function getWordAfter(text: string, endIndex: number): string | null {
  const after = text.slice(endIndex);
  const m = /^\s+([a-zA-Z]+)/.exec(after);
  return m ? m[1]!.toLowerCase() : null;
}

function findLastWeekdayModifier(text: string, index: number): 'this' | 'next' | 'last' | null {
  const slice = text.slice(Math.max(0, index - 10), index).toLowerCase();
  const m = /\b(this|next|last)\s+$/.exec(slice);
  return m ? (m[1] as 'this' | 'next' | 'last') : null;
}

function isTimeOnlyComp(c: chrono.ParsedComponents): boolean {
  return (
    c.isCertain('hour') &&
    !c.isCertain('day') &&
    !c.isCertain('month') &&
    !c.isCertain('year') &&
    !c.isCertain('weekday')
  );
}

function assignCalendarDate(comp: chrono.ParsingComponents, d: CalendarDate): void {
  comp.assign('year', d.year);
  comp.assign('month', d.month);
  comp.assign('day', d.day);
}

function assignExplicitTime(comp: chrono.ParsingComponents, hour: number, minute = 0): void {
  comp.assign('hour', hour);
  comp.assign('minute', minute);
  comp.assign('second', 0);
  comp.assign('meridiem', hour >= 12 ? chrono.Meridiem.PM : chrono.Meridiem.AM);
}

function computeRelativeElapsedMs(text: string, locale: LocaleTable): number | null {
  const m1 = ELAPSED_RELATIVE_RE.exec(text.trim());
  const m2 = m1 ?? LATER_RELATIVE_RE.exec(text.trim());
  if (!m2) return null;
  const qty = parseNumberToken(m2[1]!, locale);
  if (qty === null) return null;
  const unit = m2[2]!.toLowerCase();
  if (unit.startsWith('sec')) return Math.round(qty * 1000);
  if (unit.startsWith('min')) return Math.round(qty * 60 * 1000);
  if (unit.startsWith('hour') || unit.startsWith('hr')) return Math.round(qty * 3600 * 1000);
  return null;
}

function computeWeekdayDate(
  today: CalendarDate,
  targetDow: number,
  modifier: 'this' | 'next' | 'last' | null,
  weekStart: 0 | 1 | 6,
): CalendarDate {
  const weekStartDate = getWeekStartDate(today, weekStart);
  const offsetInWeek = (targetDow - weekStart + 7) % 7;

  if (modifier === 'next') {
    return addDays(weekStartDate, 7 + offsetInWeek);
  }
  if (modifier === 'this') {
    const candidate = addDays(weekStartDate, offsetInWeek);
    // ForwardDate semantics: if that weekday already passed earlier this week, jump +7 days.
    const todayDow = getWeekday(today);
    const todayOffset = (todayDow - weekStart + 7) % 7;
    return offsetInWeek >= todayOffset ? candidate : addDays(candidate, 7);
  }
  if (modifier === 'last') {
    const todayDow = getWeekday(today);
    let back = (todayDow - targetDow + 7) % 7;
    if (back === 0) back = 7;
    return addDays(today, -back);
  }

  // Bare weekday: upcoming occurrence on or after today.
  const todayDow = getWeekday(today);
  const forward = (targetDow - todayDow + 7) % 7;
  return addDays(today, forward);
}

/**
 * Extracts explicit `*`-prefixed date options (`*tomorrow`, `*next friday`, `*may`, etc.).
 * Runs both when `dateParsing` is true (to force otherwise guarded words) and false.
 */
export function extractForcedSymbolDates(
  originalText: string,
  maskedText: string,
  disabled: ReadonlyArray<Range>,
  opts: {
    now: Date;
    nowParts: LocalDateTime;
    timeZone: string;
    weekStart: 0 | 1 | 6;
    language: 'en';
  },
): {
  forcedResults: ParsedDateTimeInfo[];
  matchedRanges: Range[];
} {
  const locale = LOCALES[opts.language];
  const forcedResults: ParsedDateTimeInfo[] = [];
  const matchedRanges: Range[] = [];
  const today: CalendarDate = {
    year: opts.nowParts.year,
    month: opts.nowParts.month,
    day: opts.nowParts.day,
  };

  for (let i = 0; i < maskedText.length; i++) {
    const ch = maskedText[i]!;
    if (ch !== '*' && ch !== '＊') continue;

    // Require start of string, whitespace, or opening paren for ASCII `*`; allow fullwidth `＊` after CJK or letters.
    if (ch !== '＊' && i > 0 && !/[\s(\[{]/.test(maskedText[i - 1]!)) continue;
    const nextCh = maskedText[i + 1];
    if (!nextCh || /\s/.test(nextCh)) continue;

    FORCED_DATE_OPTIONS_RE.lastIndex = i + 1;
    const m = FORCED_DATE_OPTIONS_RE.exec(maskedText);
    if (!m) continue;

    const matchEnd = i + 1 + m[0].length;
    // Must end at a clean token boundary.
    const afterChar = maskedText[matchEnd];
    if (afterChar !== undefined && /[a-zA-Z0-9_]/.test(afterChar)) continue;
    if (touchesDisabledSeam(originalText, i, matchEnd, disabled)) continue;

    const body = m[0].trim();
    const parsed = resolveForcedDateOption(body, today, opts.nowParts, opts.weekStart, locale);
    if (!parsed) continue;

    const spanText = originalText.slice(i, matchEnd);
    const span: RecognizedSpan = {
      start: i,
      end: matchEnd,
      kind: parsed.hasExplicitDate ? 'date' : 'time',
      text: spanText,
    };

    forcedResults.push({
      ...parsed,
      spans: [span],
    });
    matchedRanges.push([i, matchEnd]);
    i = matchEnd - 1;
  }

  return { forcedResults, matchedRanges };
}

function resolveForcedDateOption(
  body: string,
  today: CalendarDate,
  nowParts: LocalDateTime,
  weekStart: 0 | 1 | 6,
  locale: LocaleTable,
): Omit<ParsedDateTimeInfo, 'spans'> | null {
  const lower = body.toLowerCase().replace(/\s+/g, ' ');

  if (lower in locale.relativeDayAliases) {
    const delta = locale.relativeDayAliases[lower]!;
    const d = addDays(today, delta);
    return {
      start: { ...d, hour: 0, minute: 0, second: 0 },
      isAllDay: true,
      hasExplicitDate: true,
      hasExplicitTime: false,
    };
  }
  if (lower === 'tonight') {
    return {
      start: { ...today, hour: locale.partOfDayHours.tonight, minute: 0, second: 0 },
      isAllDay: false,
      hasExplicitDate: true,
      hasExplicitTime: true,
    };
  }
  if (/^(?:the )?day after tomorrow$/.test(lower)) {
    const d = addDays(today, 2);
    return {
      start: { ...d, hour: 0, minute: 0, second: 0 },
      isAllDay: true,
      hasExplicitDate: true,
      hasExplicitTime: false,
    };
  }

  // Weekday with optional this/next/last
  const wdMatch = /^(?:(this|next|last)\s+)?([a-z]+)$/.exec(lower);
  if (wdMatch) {
    const mod = (wdMatch[1] as 'this' | 'next' | 'last' | undefined) ?? null;
    const word = wdMatch[2]!;
    if (word in locale.weekdays) {
      const target = computeWeekdayDate(today, locale.weekdays[word]!.num, mod, weekStart);
      return {
        start: { ...target, hour: 0, minute: 0, second: 0 },
        isAllDay: true,
        hasExplicitDate: true,
        hasExplicitTime: false,
      };
    }
    if (word === 'weekend') {
      const target = computeWeekdayDate(today, 6, mod ?? 'this', weekStart);
      return {
        start: { ...target, hour: 0, minute: 0, second: 0 },
        isAllDay: true,
        hasExplicitDate: true,
        hasExplicitTime: false,
      };
    }
    if (word === 'week' && mod === 'next') {
      const target = addDays(getWeekStartDate(today, weekStart), 7);
      return {
        start: { ...target, hour: 0, minute: 0, second: 0 },
        isAllDay: true,
        hasExplicitDate: true,
        hasExplicitTime: false,
      };
    }
    if (word === 'month' && mod === 'next') {
      const m = addMonths({ year: today.year, month: today.month, day: 1 }, 1);
      return {
        start: { ...m, hour: 0, minute: 0, second: 0 },
        isAllDay: true,
        hasExplicitDate: true,
        hasExplicitTime: false,
      };
    }
    if (word === 'year' && mod === 'next') {
      return {
        start: { year: today.year + 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
        isAllDay: true,
        hasExplicitDate: true,
        hasExplicitTime: false,
      };
    }
    // Standalone month name forced by `*` (e.g. `*may`, `*march`)
    if (!mod && word in locale.months) {
      const monthNum = locale.months[word]!;
      let year = today.year;
      if (monthNum < today.month || (monthNum === today.month && today.day > 1)) {
        year += 1;
      }
      return {
        start: { year, month: monthNum, day: 1, hour: 0, minute: 0, second: 0 },
        isAllDay: true,
        hasExplicitDate: true,
        hasExplicitTime: false,
      };
    }
  }

  // Fallback to Chrono instance for explicit calendar dates or times attached to `*`
  const ref = toChronoReferenceDate(nowParts);
  const custom = createQuickAddChrono(locale, weekStart, nowParts, { allowBareMonths: true });
  const results = custom.parse(body, ref, { forwardDate: true });
  if (results.length === 1 && results[0]!.index === 0 && results[0]!.text.length === body.length) {
    const r = results[0]!;
    const hasTime = r.start.isCertain('hour');
    const year = r.start.get('year') ?? today.year;
    const month = r.start.get('month') ?? today.month;
    const day = r.start.get('day') ?? today.day;
    const hour = hasTime ? (r.start.get('hour') ?? 0) : 0;
    const minute = hasTime ? (r.start.get('minute') ?? 0) : 0;
    const second = hasTime ? (r.start.get('second') ?? 0) : 0;
    return {
      start: { year, month, day, hour, minute, second },
      isAllDay: !hasTime,
      hasExplicitDate: !isTimeOnlyComp(r.start),
      hasExplicitTime: hasTime,
    };
  }

  return null;
}

interface PreMergePiece {
  start: number;
  end: number;
  kind: 'date' | 'time';
  text: string;
}

function createQuickAddChrono(
  locale: LocaleTable,
  weekStart: 0 | 1 | 6,
  nowParts: LocalDateTime,
  options?: { allowBareMonths?: boolean; preMergeOut?: PreMergePiece[]; durationIndexes?: Set<number> },
): chrono.Chrono {
  const custom = chrono.en.casual.clone();
  const today: CalendarDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day };

  // Custom parsers
  custom.parsers.unshift(
    // 1. Casual day aliases: tod, tom, day after tomorrow
    {
      pattern: () => /\b(?:(?:the\s+)?day\s+after\s+tomorrow|tod|tom)\b/i,
      extract: (context, match) => {
        const raw = match[0];
        const idx = match.index ?? 0;
        const lower = raw.toLowerCase().replace(/\s+/g, ' ');
        if (lower === 'tom') {
          const isCapitalized = raw === 'Tom';
          const prevWord = getWordBefore(context.text, idx);
          const personVerbs = new Set([
            'call',
            'email',
            'text',
            'meet',
            'ask',
            'ping',
            'tell',
            'with',
            'from',
            'to',
            'for',
            'by',
            'thank',
            'invite',
            'pay',
            'see',
            'visit',
            'message',
            'dm',
          ]);
          if (isCapitalized && prevWord && personVerbs.has(prevWord)) {
            return null;
          }
        }
        const delta = lower === 'tod' ? 0 : lower === 'tom' ? 1 : 2;
        const d = addDays(today, delta);
        const comp = context.createParsingComponents();
        assignCalendarDate(comp, d);
        return comp;
      },
    },
    // 2. Boundary dates, "on the Nth", "next week", "next month", "next year"
    {
      pattern: () =>
        /\b(?:(?:at\s+the\s+)?(?:beginning|start)\s+of\s+(?:(?:this|the|next)\s+)?(?:week|month|year)|(?:the\s+)?(?:end|last\s+day)\s+of\s+(?:(?:this|the|next)\s+)?(?:week|year)|on\s+the\s+(\d{1,2})(?:st|nd|rd|th)|next\s+(?:week|month|year))\b/i,
      extract: (context, match) => {
        const text = match[0].toLowerCase().replace(/\s+/g, ' ');
        const comp = context.createParsingComponents();

        if (match[1]) {
          const dayNum = Number(match[1]);
          if (dayNum < 1 || dayNum > 31) return null;
          let targetMonth = today.month;
          let targetYear = today.year;
          if (dayNum < today.day || dayNum > daysInMonth(targetYear, targetMonth)) {
            const nextM = addMonths({ year: targetYear, month: targetMonth, day: 1 }, 1);
            targetYear = nextM.year;
            targetMonth = nextM.month;
          }
          while (dayNum > daysInMonth(targetYear, targetMonth)) {
            const nextM = addMonths({ year: targetYear, month: targetMonth, day: 1 }, 1);
            targetYear = nextM.year;
            targetMonth = nextM.month;
          }
          assignCalendarDate(comp, { year: targetYear, month: targetMonth, day: dayNum });
          return comp;
        }

        if (text === 'next week') {
          assignCalendarDate(comp, addDays(getWeekStartDate(today, weekStart), 7));
          return comp;
        }
        if (text === 'next month') {
          assignCalendarDate(comp, addMonths({ year: today.year, month: today.month, day: 1 }, 1));
          return comp;
        }
        if (text === 'next year') {
          assignCalendarDate(comp, { year: today.year + 1, month: 1, day: 1 });
          return comp;
        }

        const isNext = /\bnext\b/.test(text);
        const isStart = /\b(?:beginning|start)\b/.test(text);

        if (/\bweek\b/.test(text)) {
          const baseStart = getWeekStartDate(today, weekStart);
          const weekBase = isNext ? addDays(baseStart, 7) : baseStart;
          assignCalendarDate(comp, isStart ? weekBase : addDays(weekBase, 6));
          return comp;
        }
        if (/\bmonth\b/.test(text)) {
          const m = addMonths({ year: today.year, month: today.month, day: 1 }, isNext ? 1 : 0);
          assignCalendarDate(comp, m);
          return comp;
        }
        if (/\byear\b/.test(text)) {
          const y = today.year + (isNext ? 1 : 0);
          assignCalendarDate(comp, isStart ? { year: y, month: 1, day: 1 } : { year: y, month: 12, day: 31 });
          return comp;
        }
        return null;
      },
    },
    // 3. Dot-separated times like 21.30, at 9.30, 9.30am
    {
      pattern: () => new RegExp(DOT_TIME_RE.source, 'gi'),
      extract: (context, match) => {
        const idx = match.index ?? 0;
        const hourRaw = Number(match[1]);
        const minRaw = Number(match[2]);
        const meridiemRaw = match[3]?.toLowerCase();
        if (minRaw < 0 || minRaw > 59) return null;

        const beforeChar = idx > 0 ? (context.text[idx - 1] ?? '') : '';
        if (CURRENCY_OR_VERSION_BEFORE.test(beforeChar)) return null;
        const afterText = context.text.slice(idx + match[0].length);
        if (BAD_DOT_TIME_FOLLOWERS.test(afterText)) return null;

        if (meridiemRaw) {
          if (hourRaw < 1 || hourRaw > 12) return null;
          const isPm = meridiemRaw.startsWith('p');
          const hour24 = (hourRaw % 12) + (isPm ? 12 : 0);
          const comp = context.createParsingComponents();
          assignExplicitTime(comp, hour24, minRaw);
          return comp;
        }

        const prevWord = getWordBefore(context.text, idx);
        const hasPrep = prevWord !== null && (prevWord === 'at' || prevWord === 'from' || prevWord === 'until' || prevWord === 'till' || prevWord === 'to');
        if (!hasPrep && prevWord !== null && locale.dotTimeBadPreceders.has(prevWord)) return null;
        if (!hasPrep && (hourRaw < 13 || hourRaw > 23)) return null;
        if (hourRaw < 0 || hourRaw > 23) return null;

        const comp = context.createParsingComponents();
        if (hasPrep && hourRaw >= 1 && hourRaw <= 12) {
          comp.assign('hour', hourRaw);
          comp.assign('minute', minRaw);
          comp.assign('second', 0);
        } else {
          assignExplicitTime(comp, hourRaw, minRaw);
        }
        const res = context.createParsingResult(idx, match[0], comp);
        res.addTag('quickadd-dot-time');
        return res;
      },
    },
    // 4. Meal anchors only when explicitly preceded by "at "
    {
      pattern: () => /\bat\s+(breakfast|brunch|lunch|dinner|supper)\b/i,
      extract: (context, match) => {
        const meal = match[1]!.toLowerCase() as keyof LocaleTable['partOfDayHours'];
        const hour = locale.partOfDayHours[meal];
        const comp = context.createParsingComponents();
        assignExplicitTime(comp, hour, 0);
        return comp;
      },
    },
  );

  // Build refined pipeline around chrono's built-in refiners.
  // Wrap UnlikelyFormatFilter / ENUnlikelyFormatFilter so validated dot-times (e.g. "21.30") survive.
  const baseRefiners = custom.refiners.map((refiner): chrono.Refiner => {
    const name = refiner.constructor.name;
    if (name !== 'UnlikelyFormatFilter' && name !== 'ENUnlikelyFormatFilter') {
      return refiner;
    }
    return {
      refine: (context, results) => {
        const preserved = results.filter((r) => r.tags().has('quickadd-dot-time'));
        const others = results.filter((r) => !r.tags().has('quickadd-dot-time'));
        const filteredOthers = refiner.refine(context, others);
        if (preserved.length === 0) return filteredOthers;
        return [...filteredOthers, ...preserved].sort((a, b) => a.index - b.index);
      },
    };
  });
  const mergeIdx = custom.refiners.findIndex((r) => r.constructor.name === 'ENMergeDateTimeRefiner');

  const preMergeRefiners: chrono.Refiner[] = [
    // 1. False-positive filter
    {
      refine: (context, results) => {
        return results.filter((r) => {
          const textLower = r.text.toLowerCase().trim();
          const endIdx = r.index + r.text.length;

          // Filter standalone "for <duration>" matches from chrono's relative parsers.
          if (/^for\s+/i.test(textLower)) {
            return false;
          }

          // Filter ambiguous "this week" when it produces no certain date components.
          if (textLower === 'this week' && !r.start.isCertain('day') && !r.start.isCertain('weekday')) {
            return false;
          }

          // Filter "a second" / "one second" / "a minute" unless preceded by in/after or followed by later.
          if (/^(?:a|an|one)\s+(?:seconds?|minutes?|moments?)$/i.test(textLower)) {
            const prev = getWordBefore(context.text, r.index);
            const after = getWordAfter(context.text, endIdx);
            if (prev !== 'in' && prev !== 'after' && after !== 'later') {
              return false;
            }
          }

          // Reject "<Weekday> the <Ordinal>" idiom/title phrases like "friday the 13th".
          if (r.start.isOnlyWeekdayComponent() && !r.end && /^\s+the\s+\d{1,2}(?:st|nd|rd|th)\b/i.test(context.text.slice(endIdx))) {
            return false;
          }

          // Reject bare "all morning/afternoon/evening/night" and "<noun> night" phrases (e.g. "movie night").
          if (!r.start.isCertain('day') && /^(?:morning|afternoon|evening|night)$/i.test(textLower)) {
            const prev = getWordBefore(context.text, r.index);
            if (prev === 'all') {
              return false;
            }
            if (
              textLower === 'night' &&
              prev !== null &&
              new Set([
                'movie',
                'date',
                'game',
                'pizza',
                'trivia',
                'ladies',
                'girls',
                'boys',
                'guys',
                'family',
                'taco',
                'fight',
                'opening',
                'late',
                'good',
                'one',
              ]).has(prev)
            ) {
              return false;
            }
          }

          // Guard ambiguous short weekdays: sat, sun, wed
          if (r.start.isOnlyWeekdayComponent() && !r.end) {
            const bareWord = textLower.replace(/^(?:on|this|next|last)\s+/, '');
            const wdInfo = locale.weekdays[bareWord];
            if (wdInfo?.ambiguousShort) {
              const rawMatch = context.text.slice(r.index, endIdx);
              const hasMod = /^(?:on|this|next|last)\s+/i.test(textLower);
              const prevWord = getWordBefore(context.text, r.index);
              const nextWord = getWordAfter(context.text, endIdx);
              const afterChar = context.text[endIdx] ?? '';

              if (!hasMod) {
                // Reject all-caps acronyms like "SAT prep" unless followed by time.
                if (rawMatch === rawMatch.toUpperCase() && !/^\s*\d/.test(context.text.slice(endIdx))) {
                  return false;
                }
                if (bareWord === 'sat' && nextWord && locale.satVerbFollowers.has(nextWord)) {
                  return false;
                }
                if (bareWord === 'sun' && (prevWord === 'the' || prevWord === 'a' || prevWord === 'my')) {
                  return false;
                }
                if (bareWord === 'wed' && (prevWord === 'they' || prevWord === 'to' || prevWord === 'newly' || prevWord === 'get')) {
                  return false;
                }
                // If lowercase ambiguous 3-letter weekday with no weekday preposition/comma/time context, reject.
                const hasWeekdayPrep = prevWord !== null && ['on', 'by', 'before', 'until', 'till', 'from'].includes(prevWord);
                const hasWeekdayFollower = /^,/.test(afterChar) || /^\s+(?:at\s+)?(?:\d|morning|afternoon|evening|night|noon)/i.test(context.text.slice(endIdx));
                const isTitleCase = /^[A-Z][a-z]+$/.test(rawMatch);
                if (!hasWeekdayPrep && !hasWeekdayFollower && !isTitleCase) {
                  return false;
                }
              }
            }
          }

          // Guard bare month names ("may", "march", "march of", "august", "june", "april", etc.)
          const bareMonthMatch =
            !r.start.isCertain('day') && !r.start.isCertain('year')
              ? /^([a-z]+)(?:\s+(of|in))?$/.exec(textLower)
              : null;
          if (!options?.allowBareMonths && r.start.isCertain('month') && bareMonthMatch && bareMonthMatch[1]! in locale.months) {
            // Chrono's ENMonthNameParser can include trailing "of"/"in" ("march of"); reject unconditionally.
            if (bareMonthMatch[2]) {
              return false;
            }
            const prevWord = getWordBefore(context.text, r.index);
            const rawPrev = getRawTokenBefore(context.text, r.index);
            const afterWord = getWordAfter(context.text, endIdx);
            if (afterWord && locale.bareMonthBadFollowers.has(afterWord)) {
              return false;
            }
            const allowedPrep = prevWord !== null && locale.datePrepositions.has(prevWord);
            if (!allowedPrep) {
              return false;
            }
            // Include "in " when it enables a bare month like "Meet in May".
            if (prevWord === 'in' && rawPrev) {
              const prefixMatch = new RegExp(`${rawPrev}\\s+$`, 'i').exec(context.text.slice(0, r.index));
              if (prefixMatch) {
                r.index -= prefixMatch[0].length;
                r.text = context.text.slice(r.index, endIdx);
              }
            }
          }

          // Reject "May 32" style 2-digit year <= 49 implied from invalid day-of-month
          if (
            r.start.isCertain('month') &&
            r.start.isCertain('year') &&
            !r.start.isCertain('day') &&
            /\b[a-z]+\s+\d{2}\b/i.test(r.text) &&
            !/\d{4}/.test(r.text)
          ) {
            return false;
          }

          // Reject invalid ISO YYYY-MM-DD with middle component > 12 (chrono flips YYYY-DD-MM)
          const isoLike = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(textLower);
          if (isoLike && Number(isoLike[2]) > 12) {
            return false;
          }

          // Reject slash fractions like "1/2 cup" or "3/4 inch"
          if (/^\d{1,2}\/\d{1,2}$/.test(textLower)) {
            const nextWord = getWordAfter(context.text, endIdx);
            if (nextWord && locale.fractionUnits.has(nextWord)) {
              return false;
            }
          }

          return true;
        });
      },
    },
    // 2. Part-of-day hour normalization
    {
      refine: (_context, results) => {
        for (const r of results) {
          const lower = r.text.toLowerCase();
          if (/\btonight\b/.test(lower)) {
            assignCalendarDate(r.start, today);
            assignExplicitTime(r.start, locale.partOfDayHours.tonight, 0);
            continue;
          }
          const podMatch = /\b(morning|afternoon|evening|night|noon|midnight)\b/.exec(lower);
          if (podMatch && !r.start.isCertain('hour')) {
            const key = podMatch[1] as keyof LocaleTable['partOfDayHours'];
            const hour = locale.partOfDayHours[key];
            assignExplicitTime(r.start, hour, 0);
            if (/\bthis\s+(?:morning|afternoon|evening|night)\b/.test(lower)) {
              assignCalendarDate(r.start, today);
            }
          }
        }
        return results;
      },
    },
    // 3. WeekStart-aware weekday refinement ("this" / "next" / "last" / weekend)
    {
      refine: (context, results) => {
        for (const r of results) {
          if (!r.start.isOnlyWeekdayComponent()) continue;
          const lower = r.text.toLowerCase();
          const modMatch = /\b(this|next|last)\b/.exec(lower);
          const mod = modMatch
            ? (modMatch[1] as 'this' | 'next' | 'last')
            : findLastWeekdayModifier(context.text, r.index);
          if (mod && !modMatch) {
            // Pull modifier word into the span so "next Monday" doesn't leave "next" behind.
            const prefixMatch = new RegExp(`\\b${mod}\\s+$`, 'i').exec(context.text.slice(0, r.index));
            if (prefixMatch) {
              const endIdx = r.index + r.text.length;
              r.index -= prefixMatch[0].length;
              r.text = context.text.slice(r.index, endIdx);
            }
          }
          const weekday = r.start.get('weekday');
          if (weekday === null) continue;
          const target = computeWeekdayDate(today, weekday, mod, weekStart);
          assignCalendarDate(r.start, target);
          if (!mod) {
            r.addTag('bare-weekday');
          }
        }
        return results;
      },
    },
    // 4. PM propagation from preceding evening/night/tonight/afternoon & ambiguous bare 12h clock time
    {
      refine: (context, results) => {
        for (let idx = 0; idx < results.length - 1; idx++) {
          const prev = results[idx]!;
          const next = results[idx + 1]!;
          if (
            /\b(?:tonight|evening|night|afternoon)\b/i.test(prev.text) &&
            isTimeOnlyComp(next.start) &&
            !next.start.isCertain('meridiem')
          ) {
            const gap = context.text.slice(prev.index + prev.text.length, next.index).trim();
            if (gap === '' || /^at$/i.test(gap)) {
              const nh = next.start.get('hour');
              const nm = next.start.get('minute') ?? 0;
              if (nh !== null && nh >= 1 && nh <= 11) {
                assignExplicitTime(next.start, nh + 12, nm);
                if (next.end && !next.end.isCertain('meridiem')) {
                  const eh = next.end.get('hour');
                  const em = next.end.get('minute') ?? 0;
                  if (eh !== null && eh >= nh && eh <= 11) {
                    assignExplicitTime(next.end, eh + 12, em);
                  }
                }
              }
            }
          }
        }

        const hasExplicitDateResult = results.some((res) => !isTimeOnlyComp(res.start));
        for (const r of results) {
          if (r.end) continue;
          if (!r.start.isOnlyTime() || r.start.isCertain('meridiem') || hasExplicitDateResult) continue;
          const hour = r.start.get('hour');
          const minute = r.start.get('minute') ?? 0;
          if (hour === null || hour < 1 || hour > 11) continue;
          const nowTotalMin = nowParts.hour * 60 + nowParts.minute;
          const amTotalMin = hour * 60 + minute;
          const pmTotalMin = (hour + 12) * 60 + minute;
          if (amTotalMin < nowTotalMin && pmTotalMin >= nowTotalMin) {
            assignExplicitTime(r.start, hour + 12, minute);
          }
        }
        return results;
      },
    },
  ];

  // Snapshot pre-merge pieces right before ENMergeDateTimeRefiner runs.
  const preMergeSnapshotRefiner: chrono.Refiner = {
    refine: (_context, results) => {
      if (options?.preMergeOut) {
        options.preMergeOut.length = 0;
        for (const r of results) {
          const isTime = r.start.isOnlyTime() && !r.start.isCertain('day');
          options.preMergeOut.push({
            start: r.index,
            end: r.index + r.text.length,
            kind: isTime ? 'time' : 'date',
            text: r.text,
          });
        }
      }
      return results;
    },
  };

  const postMergeRefiners: chrono.Refiner[] = [
    // Include trailing possessive 's ("tomorrow's"), leading "from " on ranges, and "on " before explicit dates
    {
      refine: (context, results) => {
        for (const r of results) {
          if (r.start.isCertain('day')) {
            const after = context.text.slice(r.index + r.text.length);
            const poss = /^['’]s(?=$|[\s.,;:!?)])/.exec(after);
            if (poss) {
              r.text = context.text.slice(r.index, r.index + r.text.length + poss[0].length);
            }
          }
          const before = context.text.slice(0, r.index);
          if (r.end) {
            const mFrom = /\bfrom\s+$/i.exec(before);
            if (mFrom) {
              const endIdx = r.index + r.text.length;
              r.index -= mFrom[0].length;
              r.text = context.text.slice(r.index, endIdx);
              continue;
            }
          }
          if (r.start.isCertain('month') && r.start.isCertain('day')) {
            const mOn = /\bon\s+$/i.exec(before);
            if (mOn) {
              const endIdx = r.index + r.text.length;
              r.index -= mOn[0].length;
              r.text = context.text.slice(r.index, endIdx);
            }
          }
        }
        return results;
      },
    },
    // Attach trailing "for N unit" duration to a parsed start date/time
    {
      refine: (context, results) => {
        for (const r of results) {
          if (r.end) continue;
          const after = context.text.slice(r.index + r.text.length);
          const m = UNIT_DURATION_RE.exec(after);
          if (!m) continue;

          const qty = parseNumberToken(m[1]!, locale);
          if (qty === null || qty <= 0) continue;
          const unit = m[2]!.toLowerCase();

          let totalMinutes = 0;
          let isDayDuration = false;
          if (unit.startsWith('m')) {
            totalMinutes = Math.round(qty);
          } else if (unit.startsWith('h')) {
            totalMinutes = Math.round(qty * 60);
            if (m[3]) {
              totalMinutes += Number(m[3]);
            }
          } else if (unit.startsWith('d')) {
            isDayDuration = true;
          } else if (unit.startsWith('w')) {
            isDayDuration = true;
          }

          if (isDayDuration) {
            const daysCount = Math.round(qty * (unit.startsWith('w') ? 7 : 1));
            const sYear = r.start.get('year') ?? today.year;
            const sMonth = r.start.get('month') ?? today.month;
            const sDay = r.start.get('day') ?? today.day;
            const endCal = addDays({ year: sYear, month: sMonth, day: sDay }, Math.max(0, daysCount - 1));
            const endComp = context.createParsingComponents();
            assignCalendarDate(endComp, endCal);
            r.end = endComp;
            r.text = context.text.slice(r.index, r.index + r.text.length + m[0].length);
            options?.durationIndexes?.add(r.index);
          } else if (totalMinutes > 0 && r.start.isCertain('hour')) {
            const sYear = r.start.get('year') ?? today.year;
            const sMonth = r.start.get('month') ?? today.month;
            const sDay = r.start.get('day') ?? today.day;
            const sHour = r.start.get('hour') ?? 0;
            const sMin = r.start.get('minute') ?? 0;
            const totalEndMin = sHour * 60 + sMin + totalMinutes;
            const dayOverflow = Math.floor(totalEndMin / 1440);
            const endMinOfDay = totalEndMin % 1440;
            const endCal = addDays({ year: sYear, month: sMonth, day: sDay }, dayOverflow);
            const endComp = context.createParsingComponents();
            assignCalendarDate(endComp, endCal);
            assignExplicitTime(endComp, Math.floor(endMinOfDay / 60), endMinOfDay % 60);
            r.end = endComp;
            r.text = context.text.slice(r.index, r.index + r.text.length + m[0].length);
            options?.durationIndexes?.add(r.index);
          }
        }
        return results;
      },
    },
    // Roll midnight-crossing time ranges forward (e.g. "from 10pm to 2am")
    // and advance bare same-day weekday when combined with a passed time.
    {
      refine: (_context, results) => {
        for (const r of results) {
          if (r.tags().has('bare-weekday') && r.start.isCertain('hour')) {
            const sYear = r.start.get('year');
            const sMonth = r.start.get('month');
            const sDay = r.start.get('day');
            if (sYear === today.year && sMonth === today.month && sDay === today.day) {
              const sTotal = (r.start.get('hour') ?? 0) * 60 + (r.start.get('minute') ?? 0);
              const nowTotal = nowParts.hour * 60 + nowParts.minute;
              if (sTotal < nowTotal) {
                assignCalendarDate(r.start, addDays(today, 7));
              }
            }
          }
          if (!r.end) continue;
          if (!r.start.isCertain('hour') || !r.end.isCertain('hour')) continue;
          const startCal: CalendarDate = {
            year: r.start.get('year') ?? today.year,
            month: r.start.get('month') ?? today.month,
            day: r.start.get('day') ?? today.day,
          };
          const endCal: CalendarDate = {
            year: r.end.get('year') ?? startCal.year,
            month: r.end.get('month') ?? startCal.month,
            day: r.end.get('day') ?? startCal.day,
          };
          const startMin = (r.start.get('hour') ?? 0) * 60 + (r.start.get('minute') ?? 0);
          const endMin = (r.end.get('hour') ?? 0) * 60 + (r.end.get('minute') ?? 0);
          if (
            endCal.year < startCal.year ||
            (endCal.year === startCal.year &&
              (endCal.month < startCal.month || (endCal.month === startCal.month && endCal.day < startCal.day)))
          ) {
            const syncedEnd = endMin < startMin ? addDays(startCal, 1) : startCal;
            assignCalendarDate(r.end, syncedEnd);
          } else if (
            startCal.year === endCal.year &&
            startCal.month === endCal.month &&
            startCal.day === endCal.day &&
            endMin < startMin
          ) {
            assignCalendarDate(r.end, addDays(endCal, 1));
          }
        }
        return results;
      },
    },
  ];

  // Assemble refiners: preMerge before ENMergeDateTimeRefiner, postMerge at the end (after ENMergeDateRangeRefiner).
  const insertPreAt = mergeIdx >= 0 ? mergeIdx : 0;
  custom.refiners = [
    ...baseRefiners.slice(0, insertPreAt),
    ...preMergeRefiners,
    preMergeSnapshotRefiner,
    ...baseRefiners.slice(insertPreAt),
    ...postMergeRefiners,
  ];

  return custom;
}

/**
 * Parses a date-only expression (used by repeat `until <date>` end conditions).
 */
export function parseDateExpressionForUntil(
  expr: string,
  nowParts: LocalDateTime,
  weekStart: 0 | 1 | 6,
  language: 'en' = 'en',
): CalendarDate | null {
  const locale = LOCALES[language];
  const custom = createQuickAddChrono(locale, weekStart, nowParts);
  const ref = toChronoReferenceDate(nowParts);
  const results = custom.parse(expr, ref, { forwardDate: true });
  if (results.length !== 1) return null;
  const r = results[0]!;
  if (r.index !== 0 || r.text.length !== expr.trim().length) return null;
  // Reject time-only expressions like "until 5pm" as RRULE UNTIL dates.
  if (isTimeOnlyComp(r.start)) {
    return null;
  }
  const year = r.start.get('year');
  const month = r.start.get('month');
  const day = r.start.get('day');
  if (year === null || month === null || day === null) return null;
  if (!isValidCalendarDate(year, month, day)) return null;
  return { year, month, day };
}

function buildSpansForResult(
  r: chrono.ParsedResult,
  originalText: string,
  preMergePieces: ReadonlyArray<PreMergePiece>,
  durationIndexes: ReadonlySet<number>,
): RecognizedSpan[] {
  const rStart = r.index;
  const rEnd = r.index + r.text.length;
  const isAllDay = !r.start.isCertain('hour') && !(r.end?.isCertain('hour') ?? false);

  // If this is a continuous range (e.g. "from 2pm to 4pm" or "from Nov 20 to Nov 22"), emit one span.
  if (r.end && !durationIndexes.has(rStart)) {
    const inside = preMergePieces.filter((p) => p.start >= rStart && p.end <= rEnd);
    const hasDate = inside.some((p) => p.kind === 'date');
    const hasTime = inside.some((p) => p.kind === 'time');
    if (hasDate && hasTime) {
      // Split date prefix and time range (e.g. "tomorrow from 2pm to 4pm").
      const datePieces = inside.filter((p) => p.kind === 'date');
      const timePieces = inside.filter((p) => p.kind === 'time');
      const firstDate = datePieces[0]!;
      const firstTime = timePieces[0]!;
      if (firstDate.end <= firstTime.start) {
        const between = originalText.slice(firstDate.end, firstTime.start);
        const nonWs = between.search(/\S/);
        const timeStart = nonWs >= 0 ? firstDate.end + nonWs : firstTime.start;
        return [
          {
            start: firstDate.start,
            end: firstDate.end,
            kind: 'date',
            text: originalText.slice(firstDate.start, firstDate.end),
          },
          {
            start: timeStart,
            end: rEnd,
            kind: 'time',
            text: originalText.slice(timeStart, rEnd),
          },
        ];
      }
    }
    return [
      {
        start: rStart,
        end: rEnd,
        kind: isAllDay ? 'date' : 'time',
        text: originalText.slice(rStart, rEnd),
      },
    ];
  }

  // Duration or merged date+time: inspect pre-merge pieces inside [rStart, rEnd].
  const inside = preMergePieces.filter((p) => p.start >= rStart && p.end <= rEnd);
  const datePieces = inside.filter((p) => p.kind === 'date');
  const timePieces = inside.filter((p) => p.kind === 'time');

  if (datePieces.length === 1 && timePieces.length === 1) {
    const dp = datePieces[0]!;
    const tp = timePieces[0]!;
    // Extend boundaries if post-merge refiners absorbed leading prepositions or trailing durations.
    const dpStart = rStart < dp.start && dp.start <= tp.start ? rStart : dp.start;
    const tpStart = rStart < tp.start && tp.start < dp.start ? rStart : tp.start;
    const tpEnd = rEnd > tp.end && tp.end >= dp.end ? rEnd : tp.end;
    const dpEnd = rEnd > dp.end && dp.end > tp.end ? rEnd : dp.end;
    const spans: RecognizedSpan[] = [
      { start: dpStart, end: dpEnd, kind: 'date', text: originalText.slice(dpStart, dpEnd) },
      { start: tpStart, end: tpEnd, kind: 'time', text: originalText.slice(tpStart, tpEnd) },
    ];
    return spans.sort((a, b) => a.start - b.start);
  }

  return [
    {
      start: rStart,
      end: rEnd,
      kind: isAllDay || datePieces.length > 0 ? 'date' : 'time',
      text: originalText.slice(rStart, rEnd),
    },
  ];
}

function resultToLocalDateTime(
  comp: chrono.ParsedComponents,
  fallbackDate: CalendarDate,
  isAllDay: boolean,
): LocalDateTime {
  const year = comp.get('year') ?? fallbackDate.year;
  const month = comp.get('month') ?? fallbackDate.month;
  const day = comp.get('day') ?? fallbackDate.day;
  return {
    year,
    month,
    day,
    hour: isAllDay ? 0 : (comp.get('hour') ?? 0),
    minute: isAllDay ? 0 : (comp.get('minute') ?? 0),
    second: isAllDay ? 0 : (comp.get('second') ?? 0),
  };
}

function scoreTimeResultSpecificity(r: chrono.ParsedResult): number {
  let score = 0;
  if (r.end) score += 4;
  if (/\d|\b(?:noon|midnight|breakfast|brunch|lunch|dinner|supper)\b/i.test(r.text)) score += 2;
  if (/\b(?:this|tomorrow|tonight|at|from)\b/i.test(r.text)) score += 1;
  return score;
}

/**
 * Parses natural-language dates, times, ranges, durations, and part-of-day words
 * using chrono-node with custom parsers and refiners.
 */
export function parseNaturalDateTimes(
  originalText: string,
  nlpMaskedText: string,
  disabled: ReadonlyArray<Range>,
  opts: {
    now: Date;
    nowParts: LocalDateTime;
    weekStart: 0 | 1 | 6;
    language: 'en';
  },
): ParsedDateTimeInfo | null {
  const locale = LOCALES[opts.language];
  const preMergePieces: PreMergePiece[] = [];
  const durationIndexes = new Set<number>();
  const custom = createQuickAddChrono(locale, opts.weekStart, opts.nowParts, {
    preMergeOut: preMergePieces,
    durationIndexes,
  });
  const ref = toChronoReferenceDate(opts.nowParts);
  const today: CalendarDate = {
    year: opts.nowParts.year,
    month: opts.nowParts.month,
    day: opts.nowParts.day,
  };

  const rawResults = custom.parse(nlpMaskedText, ref, { forwardDate: true });
  const validResults = rawResults.filter(
    (r) => !touchesDisabledSeam(originalText, r.index, r.index + r.text.length, disabled),
  );
  if (validResults.length === 0) {
    // Handle standalone time-unit duration when no explicit date/time appears (e.g. "Run for 45 minutes").
    const durMatch = STANDALONE_TIME_DURATION_RE.exec(nlpMaskedText);
    if (durMatch) {
      const start = durMatch.index;
      const end = start + durMatch[0].length;
      if (!touchesDisabledSeam(originalText, start, end, disabled)) {
        const qty = parseNumberToken(durMatch[1]!, locale);
        const unit = durMatch[2]!.toLowerCase();
        if (qty !== null && qty > 0) {
          let totalMs = 0;
          if (unit.startsWith('sec')) totalMs = Math.round(qty * 1000);
          else if (unit.startsWith('min')) totalMs = Math.round(qty * 60 * 1000);
          else if (unit.startsWith('h')) {
            totalMs = Math.round(qty * 3600 * 1000);
            if (durMatch[3]) totalMs += Number(durMatch[3]) * 60 * 1000;
          }
          if (totalMs > 0) {
            const startMs = opts.now.getTime();
            return {
              start: opts.nowParts,
              isAllDay: false,
              hasExplicitDate: false,
              hasExplicitTime: true,
              isRelativeElapsedTime: true,
              elapsedStartMs: startMs,
              elapsedEndMs: startMs + totalMs,
              spans: [{ start, end, kind: 'time', text: originalText.slice(start, end) }],
            };
          }
        }
      }
    }
    return null;
  }

  // Pick primary date and time results, preferring explicit/range time expressions over bare words like "Night".
  const dateCandidates = validResults.filter((r) => !isTimeOnlyComp(r.start));
  const timeCandidates = validResults.filter(
    (r) => r.start.isCertain('hour') || (r.end?.isCertain('hour') ?? false),
  );
  const sortedTimes = [...timeCandidates].sort(
    (a, b) => scoreTimeResultSpecificity(b) - scoreTimeResultSpecificity(a) || a.index - b.index,
  );

  let chosenDateResult: chrono.ParsedResult | null = dateCandidates[0] ?? null;
  let chosenTimeResult: chrono.ParsedResult | null = sortedTimes[0] ?? null;

  if (chosenDateResult && chosenTimeResult && chosenDateResult !== chosenTimeResult) {
    const overlap = overlapsAny(chosenTimeResult.index, chosenTimeResult.index + chosenTimeResult.text.length, [
      [chosenDateResult.index, chosenDateResult.index + chosenDateResult.text.length],
    ]);
    if (overlap) {
      chosenTimeResult = chosenDateResult;
    }
  } else if (!chosenDateResult && chosenTimeResult) {
    chosenDateResult = null;
  }
  const first = chosenDateResult ?? chosenTimeResult ?? validResults[0]!;

  // Case A: Separate date-only and time-only results (e.g. "Meet tomorrow with Bob at 3pm")
  if (chosenDateResult && chosenTimeResult && chosenDateResult !== chosenTimeResult) {
    const datePart = resultToLocalDateTime(chosenDateResult.start, today, true);
    const timeStart = resultToLocalDateTime(chosenTimeResult.start, datePart, false);
    const start: LocalDateTime = {
      year: datePart.year,
      month: datePart.month,
      day: datePart.day,
      hour: timeStart.hour,
      minute: timeStart.minute,
      second: timeStart.second,
    };

    let end: LocalDateTime | undefined;
    if (chosenTimeResult.end) {
      const timeEnd = resultToLocalDateTime(chosenTimeResult.end, datePart, false);
      const tStartDay: CalendarDate = {
        year: chosenTimeResult.start.get('year') ?? datePart.year,
        month: chosenTimeResult.start.get('month') ?? datePart.month,
        day: chosenTimeResult.start.get('day') ?? datePart.day,
      };
      const tEndDay: CalendarDate = {
        year: chosenTimeResult.end.get('year') ?? tStartDay.year,
        month: chosenTimeResult.end.get('month') ?? tStartDay.month,
        day: chosenTimeResult.end.get('day') ?? tStartDay.day,
      };
      const dayDelta = Math.round(
        (Date.UTC(tEndDay.year, tEndDay.month - 1, tEndDay.day) -
          Date.UTC(tStartDay.year, tStartDay.month - 1, tStartDay.day)) /
          86400000,
      );
      const shiftedEndDay = addDays(datePart, Math.max(0, dayDelta));
      end = {
        ...shiftedEndDay,
        hour: timeEnd.hour,
        minute: timeEnd.minute,
        second: timeEnd.second,
      };
    }

    const spans = [
      ...buildSpansForResult(chosenDateResult, originalText, preMergePieces, durationIndexes),
      ...buildSpansForResult(chosenTimeResult, originalText, preMergePieces, durationIndexes),
    ].sort((a, b) => a.start - b.start);

    const out: ParsedDateTimeInfo = {
      start,
      isAllDay: false,
      hasExplicitDate: true,
      hasExplicitTime: true,
      spans,
    };
    if (end) out.end = end;
    return out;
  }

  // Case B: Single result (date-only, time-only, merged date+time, or range)
  const target = chosenDateResult ?? chosenTimeResult ?? first;
  const isAllDay = !target.start.isCertain('hour') && !(target.end?.isCertain('hour') ?? false);
  const start = resultToLocalDateTime(target.start, today, isAllDay);
  const spans = buildSpansForResult(target, originalText, preMergePieces, durationIndexes);

  const elapsedDelta = computeRelativeElapsedMs(target.text, locale);
  if (elapsedDelta !== null) {
    return {
      start,
      isAllDay: false,
      hasExplicitDate: false,
      hasExplicitTime: true,
      isRelativeElapsedTime: true,
      elapsedStartMs: opts.now.getTime() + elapsedDelta,
      spans,
    };
  }

  let end: LocalDateTime | undefined;
  if (target.end) {
    const rawEnd = resultToLocalDateTime(target.end, start, isAllDay);
    if (isAllDay) {
      // All-day multi-day ranges use an exclusive +1 day end date.
      const exclusiveEnd = addDays(rawEnd, 1);
      end = { ...exclusiveEnd, hour: 0, minute: 0, second: 0 };
    } else {
      end = rawEnd;
    }
  }

  const out: ParsedDateTimeInfo = {
    start,
    isAllDay,
    hasExplicitDate: !isTimeOnlyComp(target.start) || target.start.isCertain('day'),
    hasExplicitTime: !isAllDay,
    spans,
  };
  if (end) out.end = end;
  return out;
}
