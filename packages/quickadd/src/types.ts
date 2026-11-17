/**
 * Public and internal types for the quick-add parser.
 */

export type QuickAddKind =
  | 'date'
  | 'time'
  | 'repeat'
  | 'reminder'
  | 'tag'
  | 'priority'
  | 'list'
  | 'assignee';

export interface RecognizedSpan {
  start: number;
  end: number;
  kind: QuickAddKind;
  text: string;
}

export interface ParseQuickAddOptions {
  now: Date;
  timeZone: string;
  weekStart: 0 | 1 | 6;
  language?: 'en';
  dateParsing?: boolean;
  removeRecognizedText?: boolean;
  disabledSpans?: Array<[number, number]>;
  lists?: string[];
  tags?: string[];
  assignees?: string[];
}

export interface QuickAddResult {
  title: string;
  startDate?: string;
  dueDate?: string;
  isAllDay?: boolean;
  repeatFlag?: string;
  reminders?: string[];
  priority?: 0 | 1 | 3 | 5;
  tags: string[];
  list?: string;
  assignee?: string;
  recognized: RecognizedSpan[];
}

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface LocalDateTime extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

export interface ParsedDateTimeInfo {
  start: LocalDateTime;
  end?: LocalDateTime;
  isAllDay: boolean;
  hasExplicitDate: boolean;
  hasExplicitTime: boolean;
  isRelativeElapsedTime?: boolean;
  elapsedStartMs?: number;
  elapsedEndMs?: number;
  spans: RecognizedSpan[];
}

export interface RepeatParseResult {
  repeatFlag: string;
  span: RecognizedSpan;
  /**
   * Computes the first calendar date on or after `fromDate` that satisfies
   * the recurrence rule when no explicit start date was supplied separately.
   */
  firstOccurrenceOnOrAfter: (fromDate: CalendarDate) => CalendarDate;
  /** Optional part-of-day implied by phrases like "every morning" or "every night". */
  impliedPartOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
}

export interface ReminderOffsetSpec {
  /** Minutes before the task anchor (0 means at the anchor time). */
  beforeMinutes: number;
  /** Exact seconds before the anchor when sub-minute units are used. */
  beforeSeconds?: number;
  /** Explicit unit style preserved for timed reminders when appropriate. */
  unit: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month';
  span: RecognizedSpan;
}
