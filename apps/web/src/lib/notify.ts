/**
 * Reminder and notification helpers (RMD, NTF rows). `hashFor` mirrors `public/sw-notify.js`, which the
 * service worker loads; `test/m5notify.test.ts` checks both give the same route for every case.
 */

export interface ReminderInstance {
  kind: "task" | "checklist" | "habit" | "countdown" | "dailySummary";
  targetId: string;
  taskId?: string;
  itemId?: string;
  projectId?: string;
  title: string;
  reminderId?: string;
  trigger?: string;
  occurrenceMs?: number;
  fireAtMs: number;
  fireAt: string;
  isSnooze?: boolean;
  constant?: boolean;
  todayCount?: number;
  overdueCount?: number;
}

export interface NotificationItem {
  id: string;
  title: string;
  type: string;
  data: Record<string, unknown>;
  actionStatus?: number;
  createdTime: string;
  category?: string | null;
  unread: boolean;
  /** fired by this device while the app was open (not from the server list) */
  local?: boolean;
}

/** Same id the server gives the notification-centre row of a delivered reminder (reminders.ts dispatchDue). */
export function notificationId(i: ReminderInstance): string {
  const stamp = i.occurrenceMs ?? (i.constant ? undefined : i.fireAtMs);
  return `notif:${i.kind}:${i.targetId}:${i.itemId ?? ""}:${i.reminderId ?? ""}:${stamp ?? "const"}`;
}

/** Key of one firing (constant reminders fire every minute; each cycle is its own firing). */
export const firingKey = (i: ReminderInstance): string => `${i.kind}:${i.targetId}:${i.itemId ?? ""}:${i.reminderId ?? ""}:${i.fireAtMs}`;

export function instanceToNotification(i: ReminderInstance, now: number): NotificationItem {
  return {
    id: notificationId(i),
    title: i.kind === "dailySummary" ? "Daily summary" : i.title,
    type: i.kind === "dailySummary" ? "dailyReminder" : "reminder",
    category: "notification",
    unread: true,
    local: true,
    createdTime: new Date(now).toISOString().replace("Z", "+0000"),
    data: {
      kind: i.kind,
      targetId: i.targetId,
      ...(i.taskId ? { taskId: i.taskId } : {}),
      ...(i.itemId ? { itemId: i.itemId } : {}),
      ...(i.projectId ? { projectId: i.projectId } : {}),
      fireAt: i.fireAt,
      ...(i.todayCount !== undefined ? { todayCount: i.todayCount } : {}),
      ...(i.overdueCount !== undefined ? { overdueCount: i.overdueCount } : {}),
    },
  };
}

/** Hash route a reminder, push payload or notification row opens. */
export function hashFor(d: Record<string, unknown> | null | undefined): string {
  const x = (d ?? {}) as Record<string, unknown>;
  const inner = (x.data ?? {}) as Record<string, unknown>;
  const kind = String(x.kind ?? inner.kind ?? "");
  const taskId = String(x.taskId ?? inner.taskId ?? "");
  const projectId = String(x.projectId ?? inner.projectId ?? "");
  if (taskId && projectId) return `#p/${projectId}/tasks/${taskId}`;
  if (kind === "habit") return `#q/all/habit${x.targetId ? `/${String(x.targetId)}` : ""}`;
  if (kind === "countdown") return `#countdown${x.targetId ? `/${String(x.targetId)}` : ""}`;
  if (kind === "dailySummary" || x.type === "dailyReminder") return "#q/today/tasks";
  if (typeof x.url === "string" && x.url.startsWith("#")) return x.url;
  return "#n/notification/all";
}

/** Route for a notification-centre row: its data carries targetId for habits and countdowns. */
export function notificationHash(n: NotificationItem): string {
  return hashFor({ ...n.data, type: n.type });
}

/** Merge server rows and rows fired on this device; server wins on the same id; newest first. */
export function mergeNotifications(server: NotificationItem[], local: NotificationItem[]): NotificationItem[] {
  const ids = new Set(server.map((n) => n.id));
  const all = [...server, ...local.filter((n) => !ids.has(n.id))];
  return all.sort((a, b) => b.createdTime.localeCompare(a.createdTime));
}

/** Snooze presets offered on a reminder (minutes); the last one used comes first (recentSnoozeReminderMinutes). */
export const SNOOZE_MINUTES = [5, 10, 15, 30, 60];

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
