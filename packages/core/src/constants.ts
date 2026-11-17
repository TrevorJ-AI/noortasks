/** Shared wire-protocol enums and constants, kept stable for sync and backup import compatibility. */

export const TaskStatus = { WontDo: -1, Open: 0, Completed: 2 } as const;
export const ChecklistStatus = { Open: 0, Done: 1 } as const;
export const Priority = { None: 0, Low: 1, Medium: 3, High: 5 } as const;
export const TaskKind = { Text: "TEXT", Note: "NOTE", Checklist: "CHECKLIST" } as const;
export const ProjectKind = { Task: "TASK", Note: "NOTE" } as const;
export const ViewMode = { List: "list", Kanban: "kanban", Timeline: "timeline" } as const;
export const FileType = { Image: "IMAGE", Other: "OTHER" } as const;
export const AttachmentStatus = { Normal: 0, Inactive: 1 } as const;
export const Deleted = { Live: 0, Trashed: 1 } as const;

/** Server error codes of the batch endpoints (`id2error` values). */
export const BatchError = {
  Existed: "EXISTED",
  Deleted: "DELETED",
  NotExisted: "NOT_EXISTED",
  ProjectMoveError: "PROJECT_MOVE_ERROR",
  Unknown: "UNKNOWN",
  ExceedQuota: "EXCEED_QUOTA",
  NoProjectPermission: "NO_PROJECT_PERMISSION",
  /** Habit family error codes. */
  HabitNotExist: "habit_not_exist",
  DuplicateCheckin: "DuplicateCheckinException",
  NoHabitPermission: "NoHabitPermissionException",
  NoHabit: "NO_HABIT",
} as const;
export type BatchErrorCode = (typeof BatchError)[keyof typeof BatchError];

export const COMPLETED_STATUS_PARAM = { Completed: TaskStatus.Completed, Abandoned: TaskStatus.WontDo } as const;

/** Page sizes seen on the wire. */
export const CLOSED_PAGE_SIZE = 50;
export const TRASH_PAGE_SIZE = 50;

export const INBOX_PREFIX = "inbox";
/** Maximum nesting depth of subtasks. */
export const MAX_TASK_DEPTH = 5;

/** Server date format: `YYYY-MM-DDTHH:mm:ss.SSS+0000`. */
export function formatServerDate(d: Date | number = new Date()): string {
  const date = typeof d === "number" ? new Date(d) : d;
  return date.toISOString().replace("Z", "+0000");
}

/** `YYYY-MM-DD HH:mm:ss` (the query parameter style of the closed/completed endpoints). */
export function formatQueryDate(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d) : d;
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Parse either a server date or a query date into epoch ms (both read as UTC). Returns NaN when unparsable. */
export function parseWireDate(s: string): number {
  if (!s) return NaN;
  const q = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{4})?$/.exec(s);
  if (!q) return NaN;
  const off = q[4] && q[4] !== "Z" ? `${q[4].slice(0, 3)}:${q[4].slice(3)}` : "Z";
  return Date.parse(`${q[1]}T${q[2]}${q[3] ?? ".000"}${off}`);
}

export function isInboxId(id: string): boolean {
  return /^inbox\d+$/.test(id);
}

// ------------------------------------------------------------------ M4: habits, focus, countdown
export const HabitStatus = { Normal: 0, Archived: 1 } as const;
/** Check-in status: unlabeled 0, undone 1, done 2. */
export const CheckinStatus = { Unlabeled: 0, Undone: 1, Done: 2 } as const;
export const HabitType = { Boolean: "Boolean", Real: "Real" } as const;
export const HabitMood = { Smiley: 50, Smile: 40, General: 30, Sad: 20, Cry: 10 } as const;
export const DEFAULT_HABIT_RULE = "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA";
/** Focus record type: pomodoro 0, timing (stopwatch) 1. */
export const FocusType = { Pomodoro: 0, Timing: 1 } as const;
/** Focus fragment owner: 0 task, 1 habit, 2 timer. */
export const FocusOwner = { Task: 0, Habit: 1, Timer: 2 } as const;
export const CountdownType = { Holiday: 1, Birthday: 2, Anniversary: 3, Countdown: 4 } as const;
export const UNKNOWN_CATEGORY = "UNKNOWN_CATEGORY";

// ------------------------------------------------------------------ M5: reminders, activity, notifications
export const CONSTANT_REMINDER_FLAG = -1;
export const CONSTANT_REMINDER_CYCLE_MS = 60_000;
export const DISK_LOW_WARNING_BYTES = 1024 * 1024 * 1024; // 1 GiB (ATT-015)

export const NotificationCategory = {
  Notification: "notification",
  Activity: "activity",
} as const;

export const ActivityAction = {
  Create: "T_CREATE",
  Update: "T_UPDATE",
  Complete: "T_COMPLETE",
  WontDo: "T_WONTDO",
  Reopen: "T_REOPEN",
  Title: "T_TITLE",
  Content: "T_CONTENT",
  Due: "T_DUE",
  Priority: "T_PRIORITY",
  Tag: "T_TAG",
  Reminder: "T_REMINDER",
  Repeat: "T_REPEAT",
  Items: "T_ITEMS",
  Column: "T_COLUMN",
  Assign: "T_ASSIGN",
  Pin: "T_PIN",
  Move: "T_MOVE",
  Parent: "T_PARENT",
  Trash: "T_TRASH",
  Restore: "T_RESTORE",
  Delete: "T_DELETE",
  AttachAdd: "T_ATTACH_ADD",
  AttachDel: "T_ATTACH_DEL",
  CommentAdd: "T_COMMENT_ADD",
  CommentEdit: "T_COMMENT_EDIT",
  CommentDel: "T_COMMENT_DEL",
  ProjectCreate: "P_CREATE",
  ProjectUpdate: "P_UPDATE",
  ProjectDelete: "P_DELETE",
  ColumnCreate: "COL_CREATE",
  ColumnUpdate: "COL_UPDATE",
  ColumnDelete: "COL_DELETE",
} as const;

// ------------------------------------------------------------------ M7: calendar subscriptions, accounts & events
/** Calendar item kinds. */
export const CalendarItemKind = {
  Task: 1,
  Subtask: 2,
  Subscribe: 3,
  Repeat: 4,
  Course: 10,
} as const;
export type CalendarItemKindValue = (typeof CalendarItemKind)[keyof typeof CalendarItemKind];

/** Calendar source / sidebar item types. */
export const CalendarSourceItemType = {
  UrlCalendar: 5,
  GoogleCalendar: 6,
  CalDavCalendar: 7,
  OutlookCalendar: 8,
  ExchangeCalendar: 9,
  ICloudCalendar: 10,
} as const;
export type CalendarSourceItemTypeValue = (typeof CalendarSourceItemType)[keyof typeof CalendarSourceItemType];

export const CALENDAR_CACHE_TTL_MS = 15 * 60 * 1000;

export const AUDIO_EXTENSIONS = ["m4a", "mp3", "wav", "ogg", "webm", "aac", "flac", "opus"] as const;

const AUDIO_EXT_RE = /\.(m4a|mp3|wav|ogg|webm|aac|flac|opus)$/i;

/** Returns true when a filename carries one of the supported audio extensions. */
export function isAudioFileName(fileName?: string): boolean {
  return AUDIO_EXT_RE.test(fileName ?? "");
}

/** Returns true when an attachment is audio by fileType or filename extension. */
export function isAudioAttachment(a: { fileName?: string; fileType?: string }): boolean {
  return a.fileType === "AUDIO" || isAudioFileName(a.fileName);
}
