import type { CalendarDate, LocalDateTime } from './types.js';

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Extracts wall-clock date/time components for `date` in the given IANA `timeZone`.
 */
export function getLocalParts(date: Date, timeZone: string): LocalDateTime {
  const parts = getFormatter(timeZone).formatToParts(date);
  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
    }
  }

  return { year, month, day, hour, minute, second };
}

/**
 * Formats an instant `Date` as ISO 8601 with the exact numeric UTC offset of `timeZone`.
 */
export function formatIsoWithOffset(date: Date, timeZone: string): string {
  const local = getLocalParts(date, timeZone);
  const localAsUtcMs = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
    0,
  );
  const instantSecMs = Math.floor(date.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((localAsUtcMs - instantSecMs) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMinutes);
  const offH = pad2(Math.floor(absMin / 60));
  const offM = pad2(absMin % 60);

  return `${pad4(local.year)}-${pad2(local.month)}-${pad2(local.day)}T${pad2(local.hour)}:${pad2(local.minute)}:${pad2(local.second)}.000${sign}${offH}:${offM}`;
}

/**
 * Resolves wall-clock `LocalDateTime` components inside `timeZone` to an instant `Date`
 * and formats it as ISO 8601 with offset. Handles DST transitions cleanly.
 */
export function resolveLocalToIso(parts: LocalDateTime, timeZone: string): { date: Date; iso: string } {
  const targetUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0,
  );

  // First pass estimate of timezone offset at the guessed UTC instant.
  const firstGuess = new Date(targetUtcMs);
  const p1 = getLocalParts(firstGuess, timeZone);
  const p1UtcMs = Date.UTC(p1.year, p1.month - 1, p1.day, p1.hour, p1.minute, p1.second, 0);
  const diff1 = p1UtcMs - targetUtcMs;

  let resolved = new Date(targetUtcMs - diff1);
  const p2 = getLocalParts(resolved, timeZone);
  const p2UtcMs = Date.UTC(p2.year, p2.month - 1, p2.day, p2.hour, p2.minute, p2.second, 0);
  const diff2 = p2UtcMs - targetUtcMs;

  if (diff2 !== 0) {
    const secondCandidate = new Date(resolved.getTime() - diff2);
    const p3 = getLocalParts(secondCandidate, timeZone);
    const p3UtcMs = Date.UTC(p3.year, p3.month - 1, p3.day, p3.hour, p3.minute, p3.second, 0);
    // Keep second candidate when it accurately hits the wall clock (handles DST boundaries).
    if (p3UtcMs === targetUtcMs) {
      resolved = secondCandidate;
    }
  }

  return {
    date: resolved,
    iso: formatIsoWithOffset(resolved, timeZone),
  };
}

/** Returns number of days in a Gregorian month (1-indexed `month`). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Adds `deltaDays` to a Gregorian `CalendarDate` purely in UTC arithmetic. */
export function addDays(date: CalendarDate, deltaDays: number): CalendarDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + deltaDays));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** Adds `deltaMonths` to a `CalendarDate`, clamping to the target month's last day. */
export function addMonths(date: CalendarDate, deltaMonths: number): CalendarDate {
  const totalMonths = date.year * 12 + (date.month - 1) + deltaMonths;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const maxDay = daysInMonth(year, month);
  return {
    year,
    month,
    day: Math.min(date.day, maxDay),
  };
}

/** Adds `deltaYears` to a `CalendarDate`, clamping Feb 29 on non-leap years. */
export function addYears(date: CalendarDate, deltaYears: number): CalendarDate {
  const year = date.year + deltaYears;
  const maxDay = daysInMonth(year, date.month);
  return {
    year,
    month: date.month,
    day: Math.min(date.day, maxDay),
  };
}

/** Returns 0 (Sun) .. 6 (Sat) for a Gregorian `CalendarDate`. */
export function getWeekday(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Returns the start of the week containing `date` given `weekStart` (0, 1, or 6). */
export function getWeekStartDate(date: CalendarDate, weekStart: 0 | 1 | 6): CalendarDate {
  const dow = getWeekday(date);
  const diff = (dow - weekStart + 7) % 7;
  return addDays(date, -diff);
}

/** Compares two calendar dates: negative if a < b, 0 if equal, positive if a > b. */
export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/** Formats a `CalendarDate` as `YYYYMMDD` (used in RRULE `UNTIL=`). */
export function formatYYYYMMDD(date: CalendarDate): string {
  return `${pad4(date.year)}${pad2(date.month)}${pad2(date.day)}`;
}

/** Validates whether `(year, month, day)` is a valid calendar date. */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  if (month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

/**
 * Builds a pseudo-local `Date` whose host-local getters return the exact wall-clock
 * numbers from `parts`. Used exclusively as a wall-clock reference carrier for chrono-node.
 */
export function toChronoReferenceDate(parts: LocalDateTime): Date {
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
}
