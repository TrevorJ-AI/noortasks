import { LOCALES } from './locales/en.js';
import type { LocaleTable } from './locales/types.js';
import type { Range } from './masking.js';
import { overlapsAny, touchesDisabledSeam } from './masking.js';
import type { ReminderOffsetSpec } from './types.js';

const EXTRA_NUMBER_WORDS: Record<string, number> = {
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  'forty-five': 45,
};

const OFFSET_REMINDER_RE = new RegExp(
  [
    '(?:(?:remind\\s+me|reminds\\s+me|reminder)\\s+)?',
    '(?:',
    // Numeric quantity allows full or single-letter units (e.g. 15m, 1h, 2d)
    '(\\d+(?:\\.\\d+)?)\\s*(seconds?|secs?|s(?![a-z])|minutes?|mins?|months?|mos?|mo(?![a-z])|m(?![a-z])|hours?|hrs?|h(?![a-z])|days?|d(?![a-z])|weeks?|wks?|w(?![a-z]))',
    '|',
    // Word quantity requires multi-letter unit words to avoid matching "a m"
    '(half\\s+(?:an?\\s+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty-five)\\s*(seconds?|secs?|minutes?|mins?|months?|mos?|hours?|hrs?|days?|weeks?|wks?)',
    ')',
    '\\s+(?:beforehand|before|ahead(?:\\s+of\\s+time)?|early|earlier|in\\s+advance)\\b',
  ].join(''),
  'gi',
);

const BARE_REMIND_ME_RE = /\b(?:reminds?\s+me)(?:\s+(?:at\s+|on\s+)?(?:the\s+)?(?:time|due(?:\s+time)?))?\b/gi;

function parseQty(raw: string, locale: LocaleTable): number | null {
  const lower = raw.trim().toLowerCase();
  if (lower.startsWith('half')) return 0.5;
  if (lower in locale.numberWords) return locale.numberWords[lower]!;
  if (lower in EXTRA_NUMBER_WORDS) return EXTRA_NUMBER_WORDS[lower]!;
  const n = Number(lower);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normalizeUnit(raw: string): ReminderOffsetSpec['unit'] {
  const u = raw.toLowerCase();
  if (u.startsWith('mo')) return 'month';
  if (u.startsWith('s')) return 'second';
  if (u.startsWith('m')) return 'minute';
  if (u.startsWith('h')) return 'hour';
  if (u.startsWith('d')) return 'day';
  return 'week';
}

/**
 * Extracts reminder phrases such as "remind me", "15 minutes before", "1h early",
 * and "2 days in advance".
 */
export function parseReminderPhrases(
  originalText: string,
  maskedText: string,
  disabled: ReadonlyArray<Range>,
  language: 'en' = 'en',
): ReminderOffsetSpec[] {
  const locale = LOCALES[language];
  const specs: ReminderOffsetSpec[] = [];
  const occupied: Range[] = [];

  OFFSET_REMINDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OFFSET_REMINDER_RE.exec(maskedText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (touchesDisabledSeam(originalText, start, end, disabled)) continue;

    const rawQty = (m[1] ?? m[3])!;
    const rawUnit = (m[2] ?? m[4])!;
    const qty = parseQty(rawQty, locale);
    if (qty === null) continue;

    const unit = normalizeUnit(rawUnit);
    let beforeMinutes = 0;
    let beforeSeconds: number | undefined;

    if (unit === 'second') {
      beforeSeconds = Math.round(qty);
      beforeMinutes = beforeSeconds < 60 ? 0 : Math.floor(beforeSeconds / 60);
    } else if (unit === 'minute') {
      if (qty === 0.5) {
        // Half-unit mapping: 0.5 minute -> 30s
        beforeSeconds = 30;
      } else {
        beforeMinutes = Math.round(qty);
      }
    } else if (unit === 'hour') {
      // 0.5 hour -> 30 min
      beforeMinutes = Math.round(qty * 60);
    } else if (unit === 'day') {
      // 0.5 day -> 12h (720 min)
      beforeMinutes = Math.round(qty * 1440);
    } else if (unit === 'week') {
      // Half-unit mapping: 0.5 week -> 3d, else 7d per week
      const days = qty === 0.5 ? 3 : Math.round(qty * 7);
      beforeMinutes = days * 1440;
    } else {
      // Half-unit mapping: 0.5 month -> 15d, else 30d per month
      const days = qty === 0.5 ? 15 : Math.round(qty * 30);
      beforeMinutes = days * 1440;
    }

    const spec: ReminderOffsetSpec = {
      beforeMinutes,
      unit,
      span: {
        start,
        end,
        kind: 'reminder',
        text: originalText.slice(start, end),
      },
    };
    if (beforeSeconds !== undefined) {
      spec.beforeSeconds = beforeSeconds;
    }

    specs.push(spec);
    occupied.push([start, end]);
  }

  BARE_REMIND_ME_RE.lastIndex = 0;
  while ((m = BARE_REMIND_ME_RE.exec(maskedText)) !== null) {
    const start = m.index;
    let end = start + m[0].length;
    if (start === 0) {
      const toPrefix = /^\s+to(?=\s+\S)/i.exec(maskedText.slice(end));
      if (toPrefix) {
        end += toPrefix[0].length;
      }
    }
    if (overlapsAny(start, end, occupied)) continue;
    if (touchesDisabledSeam(originalText, start, end, disabled)) continue;

    specs.push({
      beforeMinutes: 0,
      unit: 'minute',
      span: {
        start,
        end,
        kind: 'reminder',
        text: originalText.slice(start, end),
      },
    });
    occupied.push([start, end]);
  }

  return specs.sort((a, b) => a.span.start - b.span.start);
}

/**
 * Formats parsed reminder offset specs into canonical iCalendar TRIGGER strings.
 */
export function formatReminderTriggers(
  specs: ReadonlyArray<ReminderOffsetSpec>,
  isAllDay: boolean,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    let trigger: string;
    if (isAllDay) {
      // All-day tasks shift relative reminders around the default 09:00 (+540 min) clock.
      const totalBeforeMin =
        spec.beforeSeconds !== undefined && spec.beforeMinutes === 0
          ? Math.round(spec.beforeSeconds / 60)
          : spec.beforeMinutes;
      const netMinutes = 540 - totalBeforeMin;
      const sign = netMinutes < 0 ? '-' : '';
      const absMin = Math.abs(netMinutes);
      const days = Math.floor(absMin / 1440);
      const remAfterDays = absMin % 1440;
      const hours = Math.floor(remAfterDays / 60);
      const mins = remAfterDays % 60;
      trigger = `TRIGGER:${sign}P${days}DT${hours}H${mins}M0S`;
    } else if (spec.beforeSeconds !== undefined && spec.beforeSeconds < 60 && spec.beforeMinutes === 0) {
      trigger = spec.beforeSeconds === 0 ? 'TRIGGER:PT0S' : `TRIGGER:-PT${spec.beforeSeconds}S`;
    } else if (spec.beforeMinutes === 0) {
      trigger = 'TRIGGER:PT0S';
    } else if ((spec.unit === 'day' || spec.unit === 'week' || spec.unit === 'month') && spec.beforeMinutes % 1440 === 0) {
      trigger = `TRIGGER:-P${spec.beforeMinutes / 1440}D`;
    } else {
      trigger = `TRIGGER:-PT${spec.beforeMinutes}M`;
    }

    if (!seen.has(trigger)) {
      seen.add(trigger);
      result.push(trigger);
    }
  }

  return result;
}
