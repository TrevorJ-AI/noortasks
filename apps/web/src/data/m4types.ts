/** Wire shapes of the M4 objects (see apps/server/M4-ASSUMPTIONS.md). Extra fields are kept verbatim. */

export interface Habit {
  id: string;
  name: string;
  iconRes?: string;
  color?: string | null;
  encouragement?: string;
  goal?: number;
  step?: number;
  /** "Boolean" | "Real" */
  type?: string;
  unit?: string;
  status?: number;
  repeatRule?: string;
  reminders?: string[];
  recordEnable?: boolean;
  sortOrder?: number;
  sectionId?: string;
  style?: number;
  targetDays?: number;
  targetStartDate?: number | null;
  completedCycles?: number;
  exDates?: string[];
  archivedTime?: string | null;
  totalCheckIns?: number;
  currentStreak?: number;
  maxStreak?: number;
  createdTime?: string;
  modifiedTime?: string;
  etag?: string;
  [k: string]: unknown;
}

export interface HabitSection {
  id: string;
  name: string;
  sortOrder?: number;
  createdTime?: string;
  modifiedTime?: string;
  etag?: string;
  [k: string]: unknown;
}

export interface Checkin {
  id: string;
  habitId: string;
  checkinStamp: number;
  checkinTime?: string;
  opTime?: string;
  goal?: number;
  value?: number;
  /** 0 unlabeled, 1 undone, 2 done */
  status?: number;
  etag?: string;
  [k: string]: unknown;
}

/** Per-day habit log (HAB-801): note and mood. */
export interface HabitRecord {
  id: string;
  habitId: string;
  checkinStamp?: number;
  stamp?: number;
  content?: string;
  emoji?: number;
  etag?: string;
  [k: string]: unknown;
}

export interface FocusTaskRef {
  taskId?: string;
  habitId?: string;
  timerId?: string;
  timerName?: string;
  title?: string;
  projectId?: string;
  tags?: string[];
  startTime?: string | number;
  endTime?: string | number;
}

/** A focus record. `type` 0 pomodoro, 1 stopwatch (timing). Times stored as sent (server date strings here). */
export interface FocusRecord {
  id: string;
  type: number;
  startTime: string | number;
  endTime: string | number;
  /** seconds */
  pauseDuration?: number;
  /** seconds */
  adjustTime?: number;
  note?: string;
  status?: number;
  tasks?: FocusTaskRef[];
  etag?: string;
  [k: string]: unknown;
}

export interface FocusTimer {
  id: string;
  name: string;
  icon?: string;
  color?: string | null;
  /** "pomodoro" | "timing" */
  type?: string;
  pomodoroTime?: number;
  status?: number;
  archivedTime?: string | null;
  sortOrder?: number;
  createdTime?: string;
  etag?: string;
  [k: string]: unknown;
}

export interface Countdown {
  id: string;
  name: string;
  /** 1 holiday, 2 birthday, 3 anniversary, 4 countdown */
  type: number;
  /** YYYYMMDD */
  date: number;
  status?: number;
  timerMode?: number;
  daysOption?: number;
  dateDisplayFormat?: "day" | "week" | "year";
  style?: string;
  styleColor?: string | null;
  icon?: string;
  color?: string | null;
  repeatFlag?: string | null;
  reminders?: string[];
  remark?: string;
  showRemark?: boolean;
  showAge?: boolean;
  ignoreYear?: boolean;
  showCalendarType?: number;
  pinnedTime?: string | null;
  archivedTime?: string | null;
  sortOrder?: number;
  backgroundImage?: string | null;
  etag?: string;
  [k: string]: unknown;
}

export interface PomoPrefs {
  id?: number;
  pomoDuration: number;
  shortBreakDuration: number;
  longBreakDuration: number;
  longBreakInterval: number;
  pomoGoal: number;
  focusDuration: number | null;
  mindfulnessEnabled: boolean;
  autoPomo: boolean;
  autoBreak: boolean;
  lightsOn: boolean;
  focused: boolean;
  soundsOn: boolean;
  [k: string]: unknown;
}

export interface HabitPrefs {
  showInCalendar: boolean;
  showInToday: boolean;
  defaultSection: { order: number };
  enabled: boolean;
  sortType?: string;
  [k: string]: unknown;
}

export const POMO_DEFAULTS: PomoPrefs = { id: 0, shortBreakDuration: 5, longBreakDuration: 15, longBreakInterval: 4, pomoGoal: 4, focusDuration: null, mindfulnessEnabled: false, autoPomo: false, autoBreak: false, lightsOn: false, focused: false, soundsOn: true, pomoDuration: 25 };
export const HABIT_PREF_DEFAULTS: HabitPrefs = { showInCalendar: true, showInToday: true, defaultSection: { order: 0 }, enabled: true };

/** FOC-004: focus length below 5 minutes is raised to 5. */
export const clampPomo = (n: number): number => (Number.isFinite(n) ? Math.max(5, Math.round(n)) : 25);
