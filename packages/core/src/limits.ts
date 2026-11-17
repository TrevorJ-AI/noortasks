/** `GET /api/v2/configs/limits`: three tiers with flat numeric keys. Every limit is effectively unlimited. */

export const UNLIMITED_COUNT = 1_000_000_000;
export const UNLIMITED_SIZE = 2 ** 50;

export const COUNT_LIMIT_KEYS = [
  "projectNumber", "projectTaskNumber", "inboxTaskNumber", "subtaskNumber", "shareUserNumber", "dailyUploadNumber",
  "taskAttachmentNumber", "reminderNumber", "dailyReminderNumber", "habitNumber", "kanbanNumber", "teamNumber",
  "teamMemberNumber", "habitSectionNumber", "timerNumber", "visitorNumber", "countdownNumber", "notionWorkspaceNumber",
  "notionDatabaseNumber", "googleCalendarNumber", "googleConnectNumber", "calendarBindNumber", "urlCalendarNumber",
  "holidayNumber", "matrixProfileNumber", "subscribeLimit", "subscribeAccountLimit", "subscribeCalDavLimit",
  "subscribeExchangeLimit", "subscribeICloudLimit",
] as const;

export const SIZE_LIMIT_KEYS = ["attachmentSize", "proAttachmentSize", "teamAttachmentSize"] as const;

export const LENGTH_LIMIT_KEYS = [
  "commentWordLimit", "subtaskWordLimit", "taskTitleWordLimit", "taskContentWordLimit", "taskDescWordLimit",
  "nickNameLimit", "commonNameLimit", "commonContentLimit", "templateNameLimit", "habitLogWordLimit",
] as const;

export type LimitTable = Record<string, number | string>;
export interface Limits {
  free: LimitTable;
  pro: LimitTable;
  team: LimitTable;
}

function tier(type: string): LimitTable {
  const t: LimitTable = {};
  for (const k of COUNT_LIMIT_KEYS) t[k] = UNLIMITED_COUNT;
  for (const k of SIZE_LIMIT_KEYS) t[k] = UNLIMITED_SIZE;
  for (const k of LENGTH_LIMIT_KEYS) t[k] = UNLIMITED_COUNT;
  t.type = type;
  return t;
}

export function unlimitedLimits(): Limits {
  return { free: tier("free"), pro: tier("pro"), team: tier("team") };
}
