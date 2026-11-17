/**
 * Capacitor runtime bridge for the NoorTasks Android shell.
 * All exports are safe no-ops when running in a standard browser or Node/Vitest.
 */
import type { Project, Task } from "./core";
import { formatTime, isOverdue, isTimed, relativeDayLabel, taskStart } from "./dates";
import { firingKey, type ReminderInstance } from "./notify";
import { inAllSet, inDateWindow } from "../model/views";
import type { ThemeDef } from "../ui/theme";

function readDefaultServerUrl(): string {
  const raw = String((import.meta.env ? import.meta.env.VITE_DEFAULT_SERVER_URL : "") ?? "");
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}

export const DEFAULT_SERVER_URL = readDefaultServerUrl();
const SERVER_URL_KEY = "noorServerUrl";
const SERVER_CONFIRMED_KEY = "noorServerConfirmed";
const SCHEDULED_IDS_KEY = "noorScheduledNotifIds";
const REMINDER_CHANNEL_ID = "noor_reminders";
export const REMINDER_ACTION_TYPE_ID = "NOOR_REMINDER";

export type NativeAction =
  | { type: "share"; text: string; subject?: string }
  | { type: "quickAdd" }
  | { type: "openHash"; hash: string }
  | { type: "widgetCompletions" }
  | { type: "notificationAction"; actionId: string; notification?: { extra?: Record<string, unknown> } };

export interface NativeNotificationAction {
  actionId: string;
  notification?: { id?: number; extra?: Record<string, unknown> };
}

export interface WidgetTaskItem {
  id: string;
  projectId: string;
  title: string;
  dueLabel: string;
  priority: number;
}

interface CapGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    App?: {
      addListener: (event: string, cb: (data: { canGoBack?: boolean; url?: string }) => void) => Promise<{ remove: () => void }> | { remove: () => void };
      getLaunchUrl?: () => Promise<{ url: string } | undefined>;
      minimizeApp?: () => Promise<void>;
      exitApp?: () => Promise<void>;
    };
    Browser?: { open: (opts: { url: string }) => Promise<void> };
    CapacitorBarcodeScanner?: {
      scanBarcode: (opts: {
        hint: number;
        scanInstructions?: string;
        scanButton?: boolean;
        scanText?: string;
        cameraDirection?: number;
        scanOrientation?: number;
        android?: { scanningLibrary?: "zxing" | "mlkit" };
      }) => Promise<{ ScanResult?: string; format?: number }>;
    };
    StatusBar?: {
      setStyle: (opts: { style: "DARK" | "LIGHT" | "DEFAULT" }) => Promise<void>;
      setBackgroundColor: (opts: { color: string }) => Promise<void>;
    };
    SystemBars?: {
      setStyle: (opts: { style: "DARK" | "LIGHT" | "DEFAULT" }) => Promise<void>;
    };
    Haptics?: {
      impact: (opts: { style: "LIGHT" | "MEDIUM" | "HEAVY" }) => Promise<void>;
    };
    LocalNotifications?: {
      checkPermissions: () => Promise<{ display: string }>;
      requestPermissions: () => Promise<{ display: string }>;
      checkExactNotificationSetting?: () => Promise<{ exact_alarm: string }>;
      createChannel?: (opts: Record<string, unknown>) => Promise<void>;
      registerActionTypes: (opts: { types: Array<Record<string, unknown>> }) => Promise<void>;
      schedule: (opts: { notifications: Array<Record<string, unknown>> }) => Promise<unknown>;
      cancel: (opts: { notifications: Array<{ id: number }> }) => Promise<void>;
      addListener: (event: string, cb: (data: NativeNotificationAction) => void) => Promise<{ remove: () => void }> | { remove: () => void };
    };
    NoorNative?: {
      consumePendingActions: () => Promise<{ actions?: NativeAction[]; completedTaskIds?: string[] }>;
      setServerUrl: (opts: { url: string }) => Promise<void>;
      setSystemBarColor: (opts: { color: string; dark: boolean }) => Promise<void>;
      syncWidgetData: (opts: { tasks: WidgetTaskItem[] }) => Promise<void>;
      addListener: (event: string, cb: (data: NativeAction) => void) => Promise<{ remove: () => void }> | { remove: () => void };
    };
  };
}

interface NoorJsBridge {
  getCsrfToken?: (url: string) => string;
  getServerUrl?: () => string;
}

const cap = (): CapGlobal | undefined => (globalThis as { Capacitor?: CapGlobal }).Capacitor;
const nativeBridge = (): NoorJsBridge | undefined => (globalThis as { NoorNativeBridge?: NoorJsBridge }).NoorNativeBridge;

export function isCapacitor(): boolean {
  const c = cap();
  return typeof c?.isNativePlatform === "function" && c.isNativePlatform();
}

export function normalizeServerUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return DEFAULT_SERVER_URL;
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

export function getStoredServerUrl(): string {
  try {
    const v = localStorage.getItem(SERVER_URL_KEY);
    if (v && v.trim()) return normalizeServerUrl(v);
  } catch {
    /* ignore */
  }
  return DEFAULT_SERVER_URL;
}

export function hasConfirmedServerUrl(): boolean {
  if (!isCapacitor()) return true;
  try {
    return localStorage.getItem(SERVER_CONFIRMED_KEY) === "1";
  } catch {
    return true;
  }
}

export function getApiBase(): string {
  if (!isCapacitor()) return "";
  return getStoredServerUrl();
}

export function saveServerUrl(raw: string): string {
  const url = normalizeServerUrl(raw);
  if (!url) return "";
  try {
    localStorage.setItem(SERVER_URL_KEY, url);
    localStorage.setItem(SERVER_CONFIRMED_KEY, "1");
  } catch {
    /* ignore */
  }
  void cap()?.Plugins?.NoorNative?.setServerUrl({ url }).catch(() => {});
  return url;
}

export function getNativeCsrfToken(apiBase: string): string | undefined {
  if (!isCapacitor() || !apiBase) return undefined;
  try {
    const t = nativeBridge()?.getCsrfToken?.(apiBase);
    return t ? t : undefined;
  } catch {
    return undefined;
  }
}

export function syncNativeStatusBar(theme: ThemeDef): void {
  if (!isCapacitor()) return;
  const plugins = cap()?.Plugins;
  const dark = theme.base === "dark";
  const color = theme.bg ?? (dark ? "#1f1f1f" : "#ffffff");
  const style = dark ? "DARK" : "LIGHT";
  void plugins?.StatusBar?.setStyle({ style }).catch(() => {});
  void plugins?.StatusBar?.setBackgroundColor({ color }).catch(() => {});
  void plugins?.SystemBars?.setStyle({ style }).catch(() => {});
  void plugins?.NoorNative?.setSystemBarColor({ color, dark }).catch(() => {});
}

export function triggerHaptic(style: "LIGHT" | "MEDIUM" | "HEAVY" = "LIGHT"): void {
  if (!isCapacitor()) return;
  void cap()?.Plugins?.Haptics?.impact({ style }).catch(() => {});
}

/** Deterministic positive 31-bit integer ID for Android NotificationManager / AlarmManager. */
export function notificationIntId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h & 0x7fffffff) || 1;
}

let setupDone = false;

export async function ensureReminderSetup(): Promise<void> {
  if (!isCapacitor() || setupDone) return;
  const ln = cap()?.Plugins?.LocalNotifications;
  if (!ln) return;
  setupDone = true;
  try {
    await ln.createChannel?.({
      id: REMINDER_CHANNEL_ID,
      name: "Reminders",
      description: "Task, habit, countdown and daily summary reminders",
      importance: 4,
      visibility: 1,
      vibration: true,
    });
    await ln.registerActionTypes({
      types: [
        {
          id: REMINDER_ACTION_TYPE_ID,
          actions: [
            { id: "done", title: "Done" },
            { id: "snooze", title: "Snooze" },
          ],
        },
      ],
    });
  } catch {
    setupDone = false;
  }
}

export async function requestNativeNotificationPermission(): Promise<boolean> {
  if (!isCapacitor()) return false;
  const ln = cap()?.Plugins?.LocalNotifications;
  if (!ln) return false;
  await ensureReminderSetup();
  try {
    const cur = await ln.checkPermissions();
    if (cur.display === "granted") return true;
    const req = await ln.requestPermissions();
    return req.display === "granted";
  } catch {
    return false;
  }
}

function readScheduledMap(): Record<string, { id: number; taskId?: string }> {
  try {
    const raw = localStorage.getItem(SCHEDULED_IDS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, { id: number; taskId?: string }>) : {};
  } catch {
    return {};
  }
}

function writeScheduledMap(m: Record<string, { id: number; taskId?: string }>): void {
  try {
    localStorage.setItem(SCHEDULED_IDS_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

export async function scheduleNativeReminders(instances: ReminderInstance[], enabled: boolean): Promise<void> {
  if (!isCapacitor()) return;
  const ln = cap()?.Plugins?.LocalNotifications;
  if (!ln) return;
  await ensureReminderSetup();

  const prev = readScheduledMap();
  if (!enabled) {
    const ids = Object.values(prev).map((v) => ({ id: v.id }));
    if (ids.length) await ln.cancel({ notifications: ids }).catch(() => {});
    writeScheduledMap({});
    return;
  }

  try {
    const perm = await ln.checkPermissions();
    if (perm.display !== "granted") return;
  } catch {
    return;
  }

  let exactAllowed = false;
  try {
    const ex = await ln.checkExactNotificationSetting?.();
    exactAllowed = ex?.exact_alarm === "granted";
  } catch {
    exactAllowed = false;
  }

  const now = Date.now();
  const seenConstant = new Set<string>();
  const upcoming: ReminderInstance[] = [];
  for (const inst of instances) {
    if (inst.fireAtMs <= now + 500) continue;
    if (inst.constant) {
      const ck = `${inst.kind}:${inst.targetId}:${inst.itemId ?? ""}`;
      if (seenConstant.has(ck)) continue;
      seenConstant.add(ck);
    }
    upcoming.push(inst);
    if (upcoming.length >= 50) break;
  }

  const nextMap: Record<string, { id: number; taskId?: string }> = {};
  const toSchedule: Array<Record<string, unknown>> = [];

  for (const inst of upcoming) {
    const key = firingKey(inst);
    const id = notificationIntId(key);
    nextMap[key] = { id, ...(inst.taskId ? { taskId: inst.taskId } : {}) };
    if (!prev[key]) {
      const isTask = inst.kind === "task" || inst.kind === "checklist";
      toSchedule.push({
        id,
        title: inst.kind === "dailySummary" ? "Daily summary" : inst.title || "Reminder",
        body: inst.kind === "dailySummary" ? inst.title : isTask ? "Task reminder" : `${inst.kind} reminder`,
        channelId: REMINDER_CHANNEL_ID,
        smallIcon: "ic_stat_noortasks",
        ...(isTask ? { actionTypeId: REMINDER_ACTION_TYPE_ID } : {}),
        isExactNotification: exactAllowed,
        schedule: { at: new Date(inst.fireAtMs).toISOString(), allowWhileIdle: true },
        extra: {
          kind: inst.kind,
          targetId: inst.targetId,
          ...(inst.taskId ? { taskId: inst.taskId } : {}),
          ...(inst.itemId ? { itemId: inst.itemId } : {}),
          ...(inst.reminderId ? { reminderId: inst.reminderId } : {}),
          ...(inst.projectId ? { projectId: inst.projectId } : {}),
          fireAt: inst.fireAt,
          fireAtMs: inst.fireAtMs,
          title: inst.title,
        },
      });
    }
  }

  const stale = Object.entries(prev)
    .filter(([k]) => !nextMap[k])
    .map(([, v]) => ({ id: v.id }));
  if (stale.length) await ln.cancel({ notifications: stale }).catch(() => {});
  if (toSchedule.length) await ln.schedule({ notifications: toSchedule }).catch(() => {});
  writeScheduledMap(nextMap);
}

export async function scheduleLocalSnoozeFallback(inst: ReminderInstance, minutes: number): Promise<void> {
  if (!isCapacitor()) return;
  const ln = cap()?.Plugins?.LocalNotifications;
  if (!ln) return;
  await ensureReminderSetup();
  const fireAtMs = Date.now() + minutes * 60_000;
  const key = `snooze:${inst.targetId}:${inst.itemId ?? ""}:${fireAtMs}`;
  const id = notificationIntId(key);
  let exactAllowed = false;
  try {
    exactAllowed = (await ln.checkExactNotificationSetting?.())?.exact_alarm === "granted";
  } catch {
    exactAllowed = false;
  }
  await ln
    .schedule({
      notifications: [
        {
          id,
          title: inst.title || "Reminder",
          body: "Snoozed reminder",
          channelId: REMINDER_CHANNEL_ID,
          smallIcon: "ic_stat_noortasks",
          actionTypeId: REMINDER_ACTION_TYPE_ID,
          isExactNotification: exactAllowed,
          schedule: { at: new Date(fireAtMs).toISOString(), allowWhileIdle: true },
          extra: {
            kind: inst.kind,
            targetId: inst.targetId,
            ...(inst.taskId ? { taskId: inst.taskId } : {}),
            ...(inst.itemId ? { itemId: inst.itemId } : {}),
            ...(inst.projectId ? { projectId: inst.projectId } : {}),
            fireAt: new Date(fireAtMs).toISOString().replace("Z", "+0000"),
            fireAtMs,
            title: inst.title,
          },
        },
      ],
    })
    .catch(() => {});
}

export async function cancelTaskNativeReminders(taskId: string): Promise<void> {
  if (!isCapacitor() || !taskId) return;
  const ln = cap()?.Plugins?.LocalNotifications;
  if (!ln) return;
  const prev = readScheduledMap();
  const ids: Array<{ id: number }> = [];
  const next: Record<string, { id: number; taskId?: string }> = {};
  for (const [k, v] of Object.entries(prev)) {
    if (v.taskId === taskId) ids.push({ id: v.id });
    else next[k] = v;
  }
  if (ids.length) {
    await ln.cancel({ notifications: ids }).catch(() => {});
    writeScheduledMap(next);
  }
}

export function buildWidgetPayload(
  tasks: Task[],
  projects: Project[],
  inboxId: string,
  now: number,
  meridiem = true,
): WidgetTaskItem[] {
  const allowed = inAllSet(projects, inboxId);
  const today = tasks
    .filter((t) => !t.deleted && t.status === 0 && t.kind !== "NOTE" && allowed.has(t.projectId) && inDateWindow(t, "today", now))
    .sort((a, b) => {
      const ao = isOverdue(a, now) ? 0 : 1;
      const bo = isOverdue(b, now) ? 0 : 1;
      if (ao !== bo) return ao - bo;
      const ap = a.priority ?? 0;
      const bp = b.priority ?? 0;
      if (ap !== bp) return bp - ap;
      const as = taskStart(a);
      const bs = taskStart(b);
      if (!Number.isNaN(as) && !Number.isNaN(bs) && as !== bs) return as - bs;
      return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
    });
  return today.slice(0, 25).map((t) => {
    const s = taskStart(t);
    let dueLabel = "";
    if (!Number.isNaN(s)) {
      if (isOverdue(t, now)) dueLabel = relativeDayLabel(s, now);
      else if (isTimed(t)) dueLabel = formatTime(s, meridiem);
    }
    return {
      id: t.id,
      projectId: t.projectId,
      title: t.title || "Untitled",
      dueLabel,
      priority: t.priority ?? 0,
    };
  });
}

export function syncNativeWidgetTasks(tasks: Task[], projects: Project[], inboxId: string, now: number, meridiem = true): void {
  if (!isCapacitor() || !inboxId) return;
  const payload = buildWidgetPayload(tasks, projects, inboxId, now, meridiem);
  void cap()?.Plugins?.NoorNative?.syncWidgetData({ tasks: payload }).catch(() => {});
}

export function formatSharedText(subject?: string, text?: string): string {
  const s = (subject ?? "").trim();
  const t = (text ?? "").trim();
  if (!s) return t;
  if (!t) return s;
  if (t.includes(s)) return t;
  return `${s} ${t}`;
}

export async function consumeNativeActions(): Promise<{ actions: NativeAction[]; completedTaskIds: string[] }> {
  if (!isCapacitor()) return { actions: [], completedTaskIds: [] };
  try {
    const res = await cap()?.Plugins?.NoorNative?.consumePendingActions();
    return {
      actions: Array.isArray(res?.actions) ? res.actions : [],
      completedTaskIds: Array.isArray(res?.completedTaskIds) ? res.completedTaskIds : [],
    };
  } catch {
    return { actions: [], completedTaskIds: [] };
  }
}

export function onNativeAction(cb: (a: NativeAction) => void): () => void {
  if (!isCapacitor()) return () => {};
  const plugin = cap()?.Plugins?.NoorNative;
  if (!plugin) return () => {};
  let handle: { remove: () => void } | undefined;
  let removed = false;
  Promise.resolve(plugin.addListener("noorAction", cb)).then((h) => {
    if (removed) h?.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    handle?.remove();
  };
}

export function onNotificationAction(cb: (ev: NativeNotificationAction) => void): () => void {
  if (!isCapacitor()) return () => {};
  const ln = cap()?.Plugins?.LocalNotifications;
  if (!ln) return () => {};
  let handle: { remove: () => void } | undefined;
  let removed = false;
  Promise.resolve(ln.addListener("localNotificationActionPerformed", cb)).then((h) => {
    if (removed) h?.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    handle?.remove();
  };
}

export function registerBackButton(handler: () => boolean | Promise<boolean>): () => void {
  if (!isCapacitor()) return () => {};
  const appPlugin = cap()?.Plugins?.App;
  if (!appPlugin) return () => {};
  let handle: { remove: () => void } | undefined;
  let removed = false;
  Promise.resolve(
    appPlugin.addListener("backButton", (ev) => {
      void Promise.resolve(handler()).then((handled) => {
        if (handled) return;
        if (ev?.canGoBack && window.history.length > 1) {
          window.history.back();
        } else {
          void appPlugin.minimizeApp?.();
        }
      });
    }),
  ).then((h) => {
    if (removed) h?.remove();
    else handle = h;
  });
  return () => {
    removed = true;
    handle?.remove();
  };
}

/** Google must open in a Custom Tab, never by navigating the app WebView. */
export async function openSystemBrowser(url: string): Promise<void> {
  const browser = cap()?.Plugins?.Browser;
  if (!isCapacitor() || !browser) throw new Error("browser_unavailable");
  await browser.open({ url });
}

export async function scanQrCode(): Promise<string | null> {
  const scanner = cap()?.Plugins?.CapacitorBarcodeScanner;
  if (!isCapacitor() || !scanner?.scanBarcode) throw new Error("scanner_unavailable");
  try {
    const res = await scanner.scanBarcode({
      hint: 0, // QR_CODE
      scanInstructions: "Scan the NoorTasks pairing QR code",
      cameraDirection: 1, // BACK
      android: { scanningLibrary: "zxing" },
    });
    const text = typeof res?.ScanResult === "string" ? res.ScanResult.trim() : "";
    return text || null;
  } catch (e: unknown) {
    const err = e as { code?: unknown; message?: unknown } | undefined;
    const code = typeof err?.code === "string" ? err.code : "";
    const msg = typeof err?.message === "string" ? err.message : String(e ?? "");
    if (code === "OS-PLUG-BARC-0006" || /cancel/i.test(msg)) return null;
    throw new Error("scanner_failed");
  }
}

/** Listen before reading the launch URL so both warm and cold launches are covered. */
export function onNativeAuthUrl(cb: (url: string) => void): () => void {
  const plugin = cap()?.Plugins?.App;
  if (!isCapacitor() || !plugin) return () => {};
  let handle: { remove: () => void } | undefined;
  let removed = false;
  Promise.resolve(plugin.addListener("appUrlOpen", (data) => {
    if (!removed && data.url) cb(data.url);
  })).then(async (h) => {
    if (removed) { h.remove(); return; }
    handle = h;
    const launch = await plugin.getLaunchUrl?.();
    if (!removed && launch?.url) cb(launch.url);
  }).catch(() => {});
  return () => { removed = true; handle?.remove(); };
}
