import type { Quadrant } from "./filterRule.js";
import type { Loose } from "./unknown.js";

/**
 * Wire shapes. Every interface carries an index signature: fields we do not model are stored and
 * returned untouched. Optional fields are usually OMITTED on the wire (not null); a few are
 * explicitly null (for example `repeatFrom`, project `closed`), so both are allowed.
 */

export interface Reminder extends Loose {
  id: string;
  trigger: string;
}

export interface ChecklistItem extends Loose {
  id: string;
  title: string;
  /** 0 open, 2 done on reads (1 is also treated as done). */
  status: number;
  sortOrder: number;
  startDate?: string | null;
  isAllDay?: boolean | null;
  timeZone?: string;
  snoozeReminderTime?: string | null;
  completedTime?: string | null;
}

export type AttachmentAiStatus = "idle" | "transcribing" | "summarizing" | "done" | "error";

export interface AttachmentSummary extends Loose {
  keyPoints?: string[];
  decisions?: string[];
  actionItems?: string[];
  text?: string;
  language?: string;
  model?: string;
  updatedAt?: string;
}

export interface AiStatusResponse {
  configured: boolean;
  provider: string;
  transcribeModel: string;
  summarizeModel: string;
}

export interface Attachment extends Loose {
  id: string;
  refId: string;
  path: string;
  fileName: string;
  fileType: "IMAGE" | "OTHER" | string;
  size: number;
  status: number;
  createdTime: string;
  transcript?: string;
  summary?: AttachmentSummary;
  aiStatus?: AttachmentAiStatus | string;
  aiError?: string;
  transcribedAt?: string;
  summarizedAt?: string;
}

export interface FocusSummary extends Loose {
  userId?: number;
  estimatedDuration?: number;
  estimatedPomo?: number;
  pomoCount?: number;
  pomoDuration?: number;
  stopwatchDuration?: number;
  focuses?: unknown[][];
}

export interface Task extends Loose {
  id: string;
  projectId: string;
  title: string;
  kind?: "TEXT" | "NOTE" | "CHECKLIST" | string;
  content?: string;
  desc?: string;
  status: number;
  priority?: number;
  sortOrder: number;
  startDate?: string | null;
  dueDate?: string | null;
  timeZone?: string;
  isAllDay?: boolean | null;
  isFloating?: boolean;
  reminder?: string;
  reminders?: Reminder[];
  repeatFlag?: string | null;
  repeatFrom?: string | null;
  repeatFirstDate?: string | null;
  repeatTaskId?: string | null;
  exDate?: string[];
  completedTime?: string | null;
  completedUserId?: number | null;
  creator?: number;
  createdTime?: string;
  modifiedTime?: string;
  deleted?: number;
  deletedTime?: number;
  deletedBy?: number;
  etag?: string;
  tags?: string[];
  parentId?: string | null;
  childIds?: string[];
  columnId?: string | null;
  items?: ChecklistItem[];
  attachments?: Attachment[];
  commentCount?: number;
  focusSummaries?: FocusSummary[];
  progress?: number;
  annoyingAlert?: number;
  pinnedTime?: string | null;
}

export interface SortOption extends Loose {
  groupBy?: string;
  orderBy?: string;
  order?: string | null;
}

export interface Project extends Loose {
  id: string;
  name: string;
  color?: string | null;
  sortOrder: number;
  sortType?: string | null;
  sortOption?: SortOption | null;
  viewMode?: "list" | "kanban" | "timeline" | string;
  kind?: "TASK" | "NOTE" | string;
  groupId?: string | null;
  userCount?: number;
  isOwner?: boolean;
  inAll?: boolean;
  muted?: boolean;
  closed?: boolean | null;
  showType?: number | null;
  reminderType?: number | null;
  permission?: string | null;
  teamId?: string | null;
  timeline?: Loose | null;
  needAudit?: boolean;
  barcodeNeedAudit?: boolean;
  openToTeam?: boolean | null;
  teamMemberPermission?: unknown;
  transferred?: unknown;
  source?: string | number;
  background?: string | null;
  notificationOptions?: unknown[];
  etag?: string;
  modifiedTime?: string;
}

/** Folder (`projectGroups`). */
export interface ProjectGroup extends Loose {
  id: string;
  name: string;
  sortOrder: number;
  sortType?: string | null;
  sortOption?: SortOption | null;
  timeline?: Loose | null;
  teamId?: string | null;
  etag?: string;
}

/** Kanban column (`id, name, projectId, sortOrder`); server adds etag and times. */
export interface Column extends Loose {
  id: string;
  name: string;
  projectId: string;
  sortOrder: number;
  etag?: string;
  createdTime?: string;
  modifiedTime?: string;
}

/** Tag. Referenced from tasks by `name` (lowercase), `label` is the display name. */
export interface Tag extends Loose {
  name: string;
  rawName?: string;
  label?: string;
  color?: string | null;
  parent?: string | null;
  sortOrder?: number;
  sortType?: string | null;
  sortOption?: SortOption | null;
  timeline?: Loose | null;
  viewMode?: string | null;
  type?: number;
  etag?: string;
}

export interface Filter extends Loose {
  id: string;
  name: string;
  /** JSON string: {"and":[...],"type":0,"version":1}. */
  rule?: string;
  sortType?: string | null;
  sortOrder?: number;
  sortOption?: SortOption | null;
  viewMode?: string | null;
  timeline?: Loose | null;
  etag?: string;
}

/** One manual-order record inside `changed` / `deleted`. */
export interface OrderRecord extends Loose {
  id: string;
  order: number | null;
  type?: number;
}

export interface OrderLeaf {
  changed: OrderRecord[];
  deleted: OrderRecord[];
}

/** `orderByType[typeKey][scope] = leaf` (scope is a list id or "all"). */
export type OrderByType = Record<string, Record<string, OrderLeaf>>;

export interface OrderBean {
  orderByType: OrderByType;
}

export interface TaskOrderBean extends Loose {
  taskOrderByDate?: Loose;
  taskOrderByPriority?: Loose;
  taskOrderByProject?: Loose;
}

export interface SyncTaskBean {
  update: Task[];
  tagUpdate: unknown[];
  delete: Array<{ taskId: string; projectId: string }>;
  add: Task[];
  empty: boolean;
}

/** `GET /api/v3/batch/check/{checkPoint}`. Unchanged collections are null on a delta. */
export interface BatchCheckResponse extends Loose {
  checkPoint: number;
  syncTaskBean: SyncTaskBean;
  projectProfiles: Project[] | null;
  projectGroups: ProjectGroup[] | null;
  filters: Filter[] | null;
  tags: Tag[] | null;
  syncTaskOrderBean: TaskOrderBean;
  syncOrderBean: OrderBean;
  syncOrderBeanV3: OrderBean;
  inboxId: string | null;
  checks: unknown[] | null;
  remindChanges: unknown[];
}

export interface BatchRequest<T> {
  add?: T[];
  update?: T[];
  delete?: unknown[];
}

export interface BatchResponse {
  id2etag: Record<string, string>;
  id2error: Record<string, string>;
}

export interface UserProfile extends Loose {
  username?: string;
  name?: string;
  email?: string;
  userCode?: string;
  displayName?: string;
  picture?: string;
  locale?: string | null;
  verifiedEmail?: boolean;
  filledPassword?: boolean;
  fakedEmail?: boolean;
}

export interface UserStatus extends Loose {
  userId: string;
  userCode?: string;
  username?: string;
  teamPro: boolean;
  proEndDate?: string;
  needSubscribe: boolean;
  inboxId: string;
  teamUser: boolean;
  activeTeamUser: boolean;
  freeTrial: boolean;
  timeStamp: number;
  registerDate?: string;
  pro: boolean;
  ds?: boolean;
}

export interface SmartProject extends Loose {
  name: string;
  visibility: string | null;
  order: number | null;
}
export interface TabBar extends Loose {
  name: string;
  enabled: boolean;
}

/** `GET /api/v2/user/preferences/settings?includeWeb=true`: the known settings keys, plus any unknown. */
export interface Preferences extends Loose {
  id: number;
  timeZone: string;
  locale: string;
  isTimeZoneOptionEnabled: boolean;
  startDayOfWeek: string;
  defaultRemindTime: string;
  dailyRemindTime: string;
  showMeridiem: boolean;
  defaultPriority: number;
  defaultDueDate: number;
  defaultReminds: string[];
  defaultTags: string[];
  defaultADReminders: string[];
  defaultTimeMode: string;
  defaultTimeDuration: number;
  defaultToAdd: number;
  sortTypeOfAllProject: string;
  sortTypeOfInbox: string;
  sortTypeOfAssignMe: string;
  sortTypeOfToday: string;
  sortTypeOfTomorrow: string;
  sortTypeOfWeek: string;
  theme: string;
  removeDate: boolean;
  removeTag: boolean;
  showPomodoro: boolean;
  showCompleted: boolean;
  posOfOverdue: number;
  showFutureTask: boolean;
  showChecklist: boolean;
  webCalendarViewType: string;
  swipeConf: string;
  collapsedTime: number[];
  enableCountdown: boolean;
  smartProjects: SmartProject[];
  isNotificationEnabled: boolean;
  tabBars: TabBar[];
  weekNumbersEnabled: boolean;
  notificationOptions: string[];
  inboxColor: string;
  templateEnabled: boolean;
  calendarViewConf: Loose;
  startWeekOfYear: string;
  isEmailEnabled: boolean;
  supportNotifyOption: number;
  nlpEnabled: boolean;
  nlpenabled: boolean;
  dateKeptInText: boolean;
  lunarEnabled: boolean;
  holidayEnabled: boolean;
  notificationEnabled: boolean;
}

export interface Template extends Loose {
  id: string;
  etag?: string;
  createdTime?: string;
  modifiedTime?: string;
  title?: string;
  content?: string;
  order?: number;
}

export interface TemplatesResponse {
  taskTemplates: Template[];
  noteTemplates: Template[];
  merged: unknown;
}

export interface ClosedPage {
  tasks: Task[];
  next: number;
}

export interface CommentUserProfile extends Loose {
  userId?: string;
  userCode?: string;
  username?: string;
  name?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface Comment extends Loose {
  id: string;
  taskId: string;
  projectId: string;
  text: string;
  commentId?: string | null;
  userProfile: CommentUserProfile;
  attachments?: Attachment[];
  createdTime: string;
  modifiedTime: string;
}

export interface ActivityEntry extends Loose {
  id: string;
  taskId?: string | null;
  projectId: string;
  action: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  summary?: string;
  taskTitle?: string;
  userId?: number;
  createdTime: string;
  when: number;
}

export interface NotificationItem extends Loose {
  id: string;
  title: string;
  type: string;
  data: Loose;
  actionStatus: number;
  createdTime: string;
  category: string | null;
  unread: boolean | null;
}

export interface PushRegistration extends Loose {
  id: string;
  pushToken: string;
  osType: number;
  version: number;
  hl?: string;
}

export interface DailyReminderConfig extends Loose {
  enable: boolean;
  dailyReminders: string[];
  notifyOptions: string[];
  weekDays: string[];
  holidayNotify: boolean;
}

export interface ProjectTemplate extends Loose {
  id: string;
  name: string;
  keyword: string;
  deleted: number;
}

/** Named Eisenhower matrix view. */
export interface MatrixProfile extends Loose {
  id: string;
  name?: string;
  status?: number;
  sortOrder?: number;
  quadrants?: Quadrant[];
  etag?: string;
  createdTime?: string;
  modifiedTime?: string;
}

/** External ICS URL or holiday calendar subscription. */
export interface CalendarSubscription extends Loose {
  id: string;
  name: string;
  url: string;
  kind: "url" | "holiday" | string;
  presetId?: string;
  color?: string | null;
  desc?: string | null;
  show: boolean;
  hidden: boolean;
  sortOrder: number;
  itemType: number;
  etag?: string;
  lastFetchedAt?: string | null;
  lastError?: string | null;
  createdTime?: string;
  modifiedTime?: string;
}

export interface HolidayPreset {
  id: string;
  code: string;
  name: string;
  url: string;
  description: string;
}

export interface CalendarFeedConfig extends Loose {
  id: string;
  code: string;
  url: string;
  includeDone: boolean;
  includeHabits: boolean;
  projectIds: string[] | null;
  createdTime: string;
  modifiedTime: string;
}

export interface CalendarAccountCalendar extends Loose {
  id: string;
  name: string;
  color?: string | null;
  primary?: boolean;
  readOnly?: boolean;
  show?: boolean;
  timeZone?: string;
  description?: string;
}

export interface CalendarAccount extends Loose {
  id: string;
  provider: "google" | "outlook" | "caldav" | "icloud" | string;
  account: string;
  email?: string;
  displayName?: string;
  serverUrl?: string;
  itemType: number;
  status: "active" | "revoked" | "error" | string;
  needsReauth: boolean;
  show: boolean;
  calendars: CalendarAccountCalendar[];
  lastSyncAt?: string | null;
  lastError?: string | null;
  createdTime?: string;
  modifiedTime?: string;
}

export interface CalendarProjectBinding extends Loose {
  id: string;
  accountId: string;
  calendarId: string;
  syncProjectScope: "all" | "project" | string;
  syncProjectId?: string | null;
  defaultTags: string[];
  lastSyncAt?: string | null;
  createdTime?: string;
  modifiedTime?: string;
}

export interface CalendarEventItem extends Loose {
  id: string;
  key: string;
  uid?: string;
  kind: number;
  sourceType: string;
  itemType?: number;
  sourceId: string;
  calendarId?: string;
  accountId?: string;
  taskId?: string;
  itemId?: string;
  projectId?: string;
  title: string;
  description?: string;
  location?: string;
  color?: string | null;
  start: number;
  end: number;
  allDay: boolean;
  isAllDay: boolean;
  startDate: string;
  dueDate: string;
  dueStart: string;
  dueEnd: string;
  timeZone?: string;
  completed: boolean;
  readOnly: boolean;
  status?: string;
  partStat?: string;
  isRecurring?: boolean;
  isOverride?: boolean;
  occurrence?: number;
  url?: string;
}
