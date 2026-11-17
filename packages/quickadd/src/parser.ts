import { extractForcedSymbolDates, parseNaturalDateTimes } from './datetime.js';
import {
  findProtectedRegions,
  maskRanges,
  normalizeDisabledSpans,
  reconstructTitle,
  touchesDisabledSeam,
  type Range,
} from './masking.js';
import { formatReminderTriggers, parseReminderPhrases } from './reminders.js';
import { LOCALES } from './locales/en.js';
import { parseRepeatPhrase } from './repeat.js';
import { addDays, formatIsoWithOffset, getLocalParts, resolveLocalToIso } from './timezone.js';
import { parseSymbolTriggers } from './triggers.js';
import type {
  CalendarDate,
  LocalDateTime,
  ParsedDateTimeInfo,
  ParseQuickAddOptions,
  QuickAddResult,
  RecognizedSpan,
} from './types.js';

const NON_DATE_TRIGGER_KINDS = new Set<RecognizedSpan['kind']>(['tag', 'priority', 'list', 'assignee']);

function combineForcedAndNatural(
  forcedList: ReadonlyArray<ParsedDateTimeInfo>,
  natural: ParsedDateTimeInfo | null,
): ParsedDateTimeInfo | null {
  if (forcedList.length === 0) return natural;
  const primaryForced = forcedList[0]!;
  if (!natural) return primaryForced;

  // Combine forced date ("*tomorrow") with natural time ("at 3pm").
  if (primaryForced.hasExplicitDate && !primaryForced.hasExplicitTime && !natural.hasExplicitDate && natural.hasExplicitTime) {
    const start: LocalDateTime = {
      year: primaryForced.start.year,
      month: primaryForced.start.month,
      day: primaryForced.start.day,
      hour: natural.start.hour,
      minute: natural.start.minute,
      second: natural.start.second,
    };
    let end: LocalDateTime | undefined;
    if (natural.end) {
      const dayDelta = Math.round(
        (Date.UTC(natural.end.year, natural.end.month - 1, natural.end.day) -
          Date.UTC(natural.start.year, natural.start.month - 1, natural.start.day)) /
          86400000,
      );
      const shiftedDay = addDays(primaryForced.start, Math.max(0, dayDelta));
      end = {
        ...shiftedDay,
        hour: natural.end.hour,
        minute: natural.end.minute,
        second: natural.end.second,
      };
    }
    const out: ParsedDateTimeInfo = {
      start,
      isAllDay: false,
      hasExplicitDate: true,
      hasExplicitTime: true,
      spans: [...primaryForced.spans, ...natural.spans].sort((a, b) => a.start - b.start),
    };
    if (end) out.end = end;
    return out;
  }

  return primaryForced;
}

function attachRepeatStartAnchor(
  dateInfo: ParsedDateTimeInfo | null,
  repeat: NonNullable<ReturnType<typeof parseRepeatPhrase>>,
  nowParts: LocalDateTime,
  language: 'en',
): ParsedDateTimeInfo {
  const locale = LOCALES[language];
  const today: CalendarDate = { year: nowParts.year, month: nowParts.month, day: nowParts.day };
  const impliedHour =
    repeat.impliedPartOfDay !== undefined ? locale.partOfDayHours[repeat.impliedPartOfDay] : undefined;

  if (!dateInfo) {
    const firstDate = repeat.firstOccurrenceOnOrAfter(today);
    if (impliedHour !== undefined) {
      let anchored = firstDate;
      const nowTotalMin = nowParts.hour * 60 + nowParts.minute;
      if (
        anchored.year === today.year &&
        anchored.month === today.month &&
        anchored.day === today.day &&
        impliedHour * 60 < nowTotalMin
      ) {
        anchored = repeat.firstOccurrenceOnOrAfter(addDays(today, 1));
      }
      return {
        start: { ...anchored, hour: impliedHour, minute: 0, second: 0 },
        isAllDay: false,
        hasExplicitDate: false,
        hasExplicitTime: true,
        spans: [],
      };
    }
    return {
      start: { ...firstDate, hour: 0, minute: 0, second: 0 },
      isAllDay: true,
      hasExplicitDate: false,
      hasExplicitTime: false,
      spans: [],
    };
  }

  // If date was given (e.g. "starting tomorrow") and repeat implies part-of-day ("every morning") without explicit time:
  if (!dateInfo.hasExplicitTime && impliedHour !== undefined) {
    return {
      ...dateInfo,
      start: { ...dateInfo.start, hour: impliedHour, minute: 0, second: 0 },
      isAllDay: false,
      hasExplicitTime: true,
    };
  }

  // If the user provided a time (e.g. "every Monday at 9am") without a date, anchor on first occurrence.
  if (!dateInfo.hasExplicitDate && dateInfo.hasExplicitTime) {
    let firstDate = repeat.firstOccurrenceOnOrAfter(today);
    if (
      firstDate.year === today.year &&
      firstDate.month === today.month &&
      firstDate.day === today.day
    ) {
      const startTotalMin = dateInfo.start.hour * 60 + dateInfo.start.minute;
      const nowTotalMin = nowParts.hour * 60 + nowParts.minute;
      if (startTotalMin < nowTotalMin) {
        firstDate = repeat.firstOccurrenceOnOrAfter(addDays(today, 1));
      }
    }

    const start: LocalDateTime = {
      year: firstDate.year,
      month: firstDate.month,
      day: firstDate.day,
      hour: dateInfo.start.hour,
      minute: dateInfo.start.minute,
      second: dateInfo.start.second,
    };

    let end: LocalDateTime | undefined;
    if (dateInfo.end) {
      const dayDelta = Math.round(
        (Date.UTC(dateInfo.end.year, dateInfo.end.month - 1, dateInfo.end.day) -
          Date.UTC(dateInfo.start.year, dateInfo.start.month - 1, dateInfo.start.day)) /
          86400000,
      );
      const endDay = addDays(firstDate, Math.max(0, dayDelta));
      end = {
        ...endDay,
        hour: dateInfo.end.hour,
        minute: dateInfo.end.minute,
        second: dateInfo.end.second,
      };
    }

    const out: ParsedDateTimeInfo = {
      start,
      isAllDay: false,
      hasExplicitDate: false,
      hasExplicitTime: true,
      spans: dateInfo.spans,
    };
    if (end) out.end = end;
    return out;
  }

  return dateInfo;
}

/**
 * Parses quick-add task text into structured task fields and recognized character spans.
 */
export function parseQuickAdd(text: string, opts: ParseQuickAddOptions): QuickAddResult {
  const language = opts.language ?? 'en';
  const dateParsing = opts.dateParsing ?? true;
  const removeRecognizedText = opts.removeRecognizedText ?? true;

  const disabled = normalizeDisabledSpans(opts.disabledSpans, text.length);
  const protectedRegions = findProtectedRegions(text);
  const baseMasked = maskRanges(text, [...disabled, ...protectedRegions]);
  const nowParts = getLocalParts(opts.now, opts.timeZone);

  // 1. Symbol triggers (#, !, ~, ^, @)
  const triggerOpts: {
    language: 'en';
    lists?: ReadonlyArray<string>;
    tags?: ReadonlyArray<string>;
    assignees?: ReadonlyArray<string>;
  } = { language };
  if (opts.lists !== undefined) triggerOpts.lists = opts.lists;
  if (opts.tags !== undefined) triggerOpts.tags = opts.tags;
  if (opts.assignees !== undefined) triggerOpts.assignees = opts.assignees;

  const triggerResult = parseSymbolTriggers(text, baseMasked, disabled, triggerOpts);
  const afterTriggersMasked = maskRanges(
    baseMasked,
    triggerResult.spans.map((s) => [s.start, s.end] as Range),
  );

  // 2. Forced `*` explicit date triggers (active even when dateParsing is false)
  const forced = extractForcedSymbolDates(text, afterTriggersMasked, disabled, {
    now: opts.now,
    nowParts,
    timeZone: opts.timeZone,
    weekStart: opts.weekStart,
    language,
  });
  const afterForcedMasked = maskRanges(afterTriggersMasked, forced.matchedRanges);

  // 3. Natural-language repeat, reminder, and date/time parsing
  let repeatResult: ReturnType<typeof parseRepeatPhrase> = null;
  let reminderSpecs: ReturnType<typeof parseReminderPhrases> = [];
  let naturalDateInfo: ParsedDateTimeInfo | null = null;

  if (dateParsing) {
    repeatResult = parseRepeatPhrase(text, afterForcedMasked, disabled, {
      nowParts,
      weekStart: opts.weekStart,
      language,
    });
    const afterRepeatMasked = repeatResult
      ? maskRanges(afterForcedMasked, [[repeatResult.span.start, repeatResult.span.end]])
      : afterForcedMasked;

    reminderSpecs = parseReminderPhrases(text, afterRepeatMasked, disabled, language);
    const afterRemindersMasked = maskRanges(
      afterRepeatMasked,
      reminderSpecs.map((r) => [r.span.start, r.span.end] as Range),
    );

    naturalDateInfo = parseNaturalDateTimes(text, afterRemindersMasked, disabled, {
      now: opts.now,
      nowParts,
      weekStart: opts.weekStart,
      language,
    });
  }

  let finalDateInfo = combineForcedAndNatural(forced.forcedResults, naturalDateInfo);

  // Absorb leading "starting " before an explicit date when paired with a repeat phrase.
  if (repeatResult && finalDateInfo) {
    const firstDateSpan = finalDateInfo.spans.find((s) => s.kind === 'date');
    if (firstDateSpan) {
      const beforeDate = text.slice(0, firstDateSpan.start);
      const startPrefix = /\bstarting\s+$/i.exec(beforeDate);
      if (startPrefix) {
        const newStart = firstDateSpan.start - startPrefix[0].length;
        if (!touchesDisabledSeam(text, newStart, firstDateSpan.end, disabled)) {
          firstDateSpan.start = newStart;
          firstDateSpan.text = text.slice(newStart, firstDateSpan.end);
        }
      }
    }
  }

  if (repeatResult) {
    finalDateInfo = attachRepeatStartAnchor(finalDateInfo, repeatResult, nowParts, language);
  }

  // 4. Collect and sort non-overlapping recognized spans
  const allSpans: RecognizedSpan[] = [...triggerResult.spans];
  if (finalDateInfo) allSpans.push(...finalDateInfo.spans);
  if (repeatResult) allSpans.push(repeatResult.span);
  for (const rem of reminderSpecs) allSpans.push(rem.span);

  allSpans.sort((a, b) => a.start - b.start || a.end - b.end);
  const recognized: RecognizedSpan[] = [];
  let prevEnd = 0;
  for (const span of allSpans) {
    if (span.start >= prevEnd) {
      recognized.push(span);
      prevEnd = span.end;
    }
  }

  // 5. Reconstruct cleaned title
  const spansToRemove = removeRecognizedText
    ? recognized
    : recognized.filter((s) => NON_DATE_TRIGGER_KINDS.has(s.kind));
  const title = reconstructTitle(text, spansToRemove);

  // 6. Build exact output object (omitting undefined optional properties)
  const result: QuickAddResult = {
    title,
    tags: triggerResult.tags,
    recognized,
  };

  if (finalDateInfo) {
    result.isAllDay = finalDateInfo.isAllDay;
    if (finalDateInfo.isRelativeElapsedTime && finalDateInfo.elapsedStartMs !== undefined) {
      result.startDate = formatIsoWithOffset(new Date(finalDateInfo.elapsedStartMs), opts.timeZone);
    } else {
      result.startDate = resolveLocalToIso(finalDateInfo.start, opts.timeZone).iso;
    }
    if (finalDateInfo.isRelativeElapsedTime && finalDateInfo.elapsedEndMs !== undefined) {
      result.dueDate = formatIsoWithOffset(new Date(finalDateInfo.elapsedEndMs), opts.timeZone);
    } else if (finalDateInfo.end) {
      result.dueDate = resolveLocalToIso(finalDateInfo.end, opts.timeZone).iso;
    }
  }

  if (repeatResult) {
    result.repeatFlag = repeatResult.repeatFlag;
  }

  if (reminderSpecs.length > 0) {
    const isAllDayForReminders = finalDateInfo ? finalDateInfo.isAllDay : true;
    const triggers = formatReminderTriggers(reminderSpecs, isAllDayForReminders);
    if (triggers.length > 0) {
      result.reminders = triggers;
    }
  }

  if (triggerResult.priority !== undefined) {
    result.priority = triggerResult.priority;
  }
  if (triggerResult.list !== undefined) {
    result.list = triggerResult.list;
  }
  if (triggerResult.assignee !== undefined) {
    result.assignee = triggerResult.assignee;
  }

  return result;
}
