import type { Weekday } from "./civil";

export type CalendarPrefix =
  | "RRULE"
  | "LUNAR"
  | "KOREAN"
  | "HEBCAL"
  | "SHAKA"
  | "PERSIAN"
  | "VIETNAM"
  | "HIJRI"
  | "KUWAITI"
  | "SAUDI";
export const CALENDAR_PREFIXES: readonly CalendarPrefix[] = [
  "RRULE", "LUNAR", "KOREAN", "HEBCAL", "SHAKA", "PERSIAN", "VIETNAM", "HIJRI", "KUWAITI", "SAUDI",
];

export type Freq = "SECONDLY" | "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type SkipKind = "HOLIDAY" | "WEEKEND" | "OFFICIAL_WORKDAY";
export type RepeatFrom = "0" | "1" | "2";

export interface ByDay {
  /** ordinal ("2" in 2SU, -1 in -1FR); undefined = every such weekday */
  n?: number;
  day: Weekday;
}

export type ERule =
  | { name: "CUSTOM"; byDate: string[] }
  | { name: "FORGETTINGCURVE"; cycle: number };

export interface RepeatModel {
  /** null = bare rule without prefix (habit style) */
  prefix: CalendarPrefix | "ERULE" | null;
  freq?: Freq;
  interval?: number;
  count?: number;
  /** raw UNTIL string (8, 15 or 16 chars) */
  until?: string;
  wkst?: Weekday;
  byMonth: number[];
  byMonthDay: number[];
  byYearDay: number[];
  byWeekNo: number[];
  bySetPos: number[];
  byDay: ByDay[];
  byHour: number[];
  byMinute: number[];
  bySecond: number[];
  erule?: ERule;
  /** unknown parts (X-*, TT_TIMES, ...) in input order (extension prefixes kept for import/sync compatibility) */
  extras: Record<string, string>;
  /** key order of the body as parsed; keeps serialisation byte-stable */
  order: string[];
  /** TK_COMPLETEDCOUNT, -1 when absent */
  completedCount: number;
  skip: SkipKind[];
  /** raw value of a legacy TK_SKIP part; when set it is written back instead of TT_SKIP */
  legacySkip?: string;
  /** TT_WORKDAY */
  workday?: 1 | -1;
}

export interface HolidayProvider {
  /** statutory holiday (a weekday that is a day off). date is "YYYY-MM-DD" in the task zone. */
  isHoliday(date: string): boolean;
  /** official working day, including make-up workdays on weekends, excluding holidays. */
  isWorkday(date: string): boolean;
}

export type DateInput = Date | string | number;

export interface RecurrenceContext {
  /** zone for floating and all-day tasks (no timeZoneId). Default "UTC". */
  deviceZone?: string;
  /** "now" for mode "2" (advance to today). Required for mode "2" when no completedTime is given. */
  now?: DateInput;
  holidays?: HolidayProvider;
  /** week start when the rule has no WKST. Default "MO" (RFC 5545). */
  defaultWeekStart?: Weekday;
  /** lunar: BYMONTH=m also fires in leap month m. Default true (repeat on leap months). */
  lunarLeapMonthRepeat?: boolean;
}

export interface RecurringObject {
  repeatFlag: string | null | undefined;
  repeatFrom?: string | null | undefined;
  startDate: DateInput;
  completedTime?: DateInput | null;
  /** undefined / null for all-day and floating tasks */
  timeZoneId?: string | null;
  exDates?: Iterable<string> | null;
}
