/**
 * Browser-safe view of the M4 parts of @noortasks/core: habit rules and streaks, focus records and live
 * timer ops, calendar-date (YYYYMMDD) helpers. The client uses the same functions as the server so the numbers it
 * shows equal the numbers the server stores. Core's `addDays` works on stamps; it is exported as `addStampDays`
 * because the web `lib/dates` has an `addDays` on epoch ms.
 */
export * from "../../../../packages/core/src/habits";
export * from "../../../../packages/core/src/focus";
export {
  stampOf,
  parseStamp,
  makeStamp,
  isValidStamp,
  daysInMonth,
  addDays as addStampDays,
  weekdayOf,
  weekStartOf as stampWeekStart,
  monthStartOf,
  addMonths as addStampMonths,
  stampRange,
  diffDays,
  dayStartMs,
} from "../../../../packages/core/src/dates";

import { stampOf as _stampOf, parseStamp as _parseStamp } from "../../../../packages/core/src/dates";

/** Zone the stamps are computed in: the account zone (settings.timeZone), else the device zone. */
export function userZone(settingsZone?: string | null): string {
  if (settingsZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: settingsZone });
      return settingsZone;
    } catch {
      /* fall through */
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export const todayStamp = (now: number, tz: string): number => _stampOf(now, tz);

/** Local midnight (device zone) of a stamp, for drawing on the device's calendar grids. */
export function stampToLocalMs(stamp: number): number {
  const { y, m, d } = _parseStamp(stamp);
  return new Date(y, m - 1, d).getTime();
}
/** Stamp of a device-local day start (ms). */
export function localMsToStamp(ms: number): number {
  const d = new Date(ms);
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
