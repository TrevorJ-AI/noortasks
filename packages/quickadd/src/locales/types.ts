/**
 * Locale data-table schema so additional languages can be added declaratively.
 */

export type WeekdayCode = 'SU' | 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA';

export interface WeekdayEntry {
  num: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  code: WeekdayCode;
  /** Short words that also occur in common English phrases (e.g. "sat", "sun", "wed"). */
  ambiguousShort?: boolean;
}

export interface LocaleTable {
  code: 'en';
  priorityWords: Record<string, 0 | 1 | 3 | 5>;
  partOfDayHours: {
    morning: number;
    afternoon: number;
    evening: number;
    night: number;
    tonight: number;
    noon: number;
    midnight: number;
    breakfast: number;
    brunch: number;
    lunch: number;
    dinner: number;
    supper: number;
  };
  relativeDayAliases: Record<string, number>;
  weekdays: Record<string, WeekdayEntry>;
  months: Record<string, number>;
  numberWords: Record<string, number>;
  ordinals: Record<string, number>;
  /** Words immediately after `sat` that indicate the past-tense verb rather than Saturday. */
  satVerbFollowers: Set<string>;
  /** Words immediately before/after `may` / `march` / `sun` / `wed` indicating non-date usage. */
  datePrepositions: Set<string>;
  bareMonthBadFollowers: Set<string>;
  dotTimeBadPreceders: Set<string>;
  fractionUnits: Set<string>;
}
