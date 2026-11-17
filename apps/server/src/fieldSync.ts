import { isPlainObject, type Loose } from "@noortasks/core";

/** Partial updates preserve omitted fields. Legacy writes clear omitted known fields.
 * A new client explicitly lists removed fields. The existing endpoint owns validation,
 * permissions, server-owned fields and timestamps after this merge.
 */
export function mergeUpdate(old: Loose, raw: Loose, legacyFields: readonly string[] = []): Loose {
  const next: Loose = { ...old, ...raw };
  delete next._sync;
  if (!isPlainObject(raw._sync)) {
    for (const key of legacyFields) if (!(key in raw)) delete next[key];
  }
  if (isPlainObject(raw._sync) && Array.isArray(raw._sync.unset)) {
    for (const key of raw._sync.unset) {
      // Identity and routing are never removable through metadata.
      if (typeof key === "string" && !["id", "name", "projectId", "habitId", "__proto__", "constructor", "prototype"].includes(key)) delete next[key];
    }
  }
  return next;
}

/** Known wire fields retain legacy whole-object omission semantics. New/unknown fields survive. */
export const LEGACY_FIELDS: Record<string, readonly string[]> = {
  task: ["id", "projectId", "title", "kind", "content", "desc", "status", "priority", "sortOrder", "startDate", "dueDate", "timeZone", "isAllDay", "isFloating", "reminder", "reminders", "repeatFlag", "repeatFrom", "repeatFirstDate", "repeatTaskId", "exDate", "completedTime", "completedUserId", "creator", "createdTime", "modifiedTime", "deleted", "deletedTime", "deletedBy", "etag", "tags", "parentId", "childIds", "columnId", "items", "attachments", "commentCount", "focusSummaries", "progress", "annoyingAlert", "pinnedTime", "assignee"],
  projects: ["id", "name", "color", "sortOrder", "sortType", "sortOption", "viewMode", "kind", "groupId", "userCount", "isOwner", "inAll", "muted", "closed", "showType", "reminderType", "permission", "teamId", "timeline", "needAudit", "barcodeNeedAudit", "openToTeam", "teamMemberPermission", "transferred", "source", "background", "notificationOptions", "etag", "modifiedTime"],
  project_groups: ["id", "name", "sortOrder", "sortType", "sortOption", "timeline", "teamId", "etag"],
  columns: ["id", "name", "projectId", "sortOrder", "etag", "createdTime", "modifiedTime"],
  tags: ["name", "rawName", "label", "color", "parent", "sortOrder", "sortType", "sortOption", "timeline", "viewMode", "type", "etag"],
  filters: ["id", "name", "rule", "sortType", "sortOrder", "sortOption", "viewMode", "timeline", "etag"],
  habits: ["id", "name", "iconRes", "color", "encouragement", "goal", "step", "type", "unit", "status", "repeatRule", "reminders", "recordEnable", "sortOrder", "sectionId", "style", "targetDays", "targetStartDate", "completedCycles", "exDates", "archivedTime", "totalCheckIns", "currentStreak", "maxStreak", "createdTime", "modifiedTime", "etag"],
  habit_sections: ["id", "name", "sortOrder", "createdTime", "modifiedTime", "etag"],
  checkin: ["id", "habitId", "checkinStamp", "checkinTime", "opTime", "goal", "value", "status", "etag"],
  habitRecord: ["id", "habitId", "checkinStamp", "stamp", "content", "emoji", "etag"],
  focus: ["id", "type", "startTime", "endTime", "pauseDuration", "adjustTime", "note", "status", "tasks", "etag"],
  timers: ["id", "name", "icon", "color", "type", "pomodoroTime", "status", "archivedTime", "sortOrder", "createdTime", "etag"],
  countdowns: ["id", "name", "type", "date", "status", "timerMode", "daysOption", "dateDisplayFormat", "style", "styleColor", "icon", "color", "repeatFlag", "reminders", "remark", "showRemark", "showAge", "ignoreYear", "showCalendarType", "pinnedTime", "archivedTime", "sortOrder", "backgroundImage", "etag"],
};
