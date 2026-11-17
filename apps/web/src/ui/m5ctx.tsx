import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HttpError } from "../data/api";
import {
  cancelTaskNativeReminders,
  ensureReminderSetup,
  isCapacitor,
  onNotificationAction,
  requestNativeNotificationPermission,
  scheduleLocalSnoozeFallback,
  scheduleNativeReminders,
  type NativeNotificationAction,
} from "../lib/capacitor";
import type { ProjectTemplate, Template } from "../lib/core";
import { firingKey, hashFor, instanceToNotification, mergeNotifications, urlBase64ToUint8Array, type NotificationItem, type ReminderInstance } from "../lib/notify";
import { useApp } from "./ctx";

/**
 * M5 client state next to the task data: reminder firing while the app is open, the notification centre,
 * Web Push registration and the template catalogue.
 *
 * Reminders: the server computes reminder instances (GET /api/v2/reminder/instances). This device polls the
 * next hours and fires each instance on time with an in-app reminder card and a notification-centre row
 * (same id as the server's row, so a delivered push and an in-app firing show once). The server only writes
 * a centre row after a push is delivered, so rows fired here are kept on this device.
 */

export type PushState = "unsupported" | "denied" | "off" | "on" | "nokey" | "error";

export interface M5 {
  notifications: NotificationItem[];
  unread: number;
  refreshNotifications: () => Promise<void>;
  markAllRead: () => Promise<void>;
  popups: ReminderInstance[];
  closeReminder: (i: ReminderInstance) => Promise<void>;
  snoozeReminder: (i: ReminderInstance, minutes: number) => Promise<boolean>;
  dismissPopup: (i: ReminderInstance) => void;
  /** test and settings hook: poll the reminder instances now */
  pollReminders: () => Promise<void>;
  push: PushState;
  enablePush: () => Promise<PushState>;
  disablePush: () => Promise<void>;
  taskTemplates: Template[];
  noteTemplates: Template[];
  projectTemplates: ProjectTemplate[];
  reloadTemplates: () => Promise<void>;
  bellOpen: boolean;
  setBellOpen: (v: boolean) => void;
}

const Ctx = createContext<M5 | null>(null);
export const useM5 = (): M5 => {
  const c = useContext(Ctx);
  if (!c) throw new Error("no m5 context");
  return c;
};

const LOOKAHEAD = 6 * 3600_000;
const FIRED_KEY = "noorFiredReminders";
const PUSH_KEY = "noorPushEndpoint";

function readLS<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as T);
  } catch {
    return d;
  }
}
const writeLS = (k: string, v: unknown): void => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* quota */
  }
};

export function M5Provider({ children }: { children: ReactNode }): JSX.Element {
  const app = useApp();
  const { engine, db, settings, sync, tasks, repo } = app;
  const api = engine.api;
  const [server, setServer] = useState<NotificationItem[]>([]);
  const [local, setLocal] = useState<NotificationItem[]>([]);
  const [popups, setPopups] = useState<ReminderInstance[]>([]);
  const [push, setPush] = useState<PushState>("off");
  const [bellOpen, setBellOpen] = useState(false);
  const [taskTemplates, setTaskTemplates] = useState<Template[]>(() => readLS("taskTemplates", []));
  const [noteTemplates, setNoteTemplates] = useState<Template[]>(() => readLS("noteTemplates", []));
  const [projectTemplates, setProjectTemplates] = useState<ProjectTemplate[]>(() => readLS("projectTemplates", []));
  const enabled = settings.isNotificationEnabled !== false && (settings as { notificationEnabled?: boolean }).notificationEnabled !== false;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // ------------------------------------------------------------ notification centre

  useEffect(() => {
    void db.getKV<NotificationItem[]>("localNotifications", []).then(setLocal);
  }, [db]);
  const saveLocal = useCallback(
    (fn: (l: NotificationItem[]) => NotificationItem[]) =>
      setLocal((cur) => {
        const next = fn(cur).slice(0, 300);
        void db.setKV("localNotifications", next);
        return next;
      }),
    [db],
  );
  const refreshNotifications = useCallback(async () => {
    try {
      const list = await api.get<NotificationItem[]>("/api/v2/notification");
      setServer(Array.isArray(list) ? list : []);
    } catch {
      /* offline: keep what we have */
    }
  }, [api]);
  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications, sync.lastSync === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const markAllRead = useCallback(async () => {
    saveLocal((l) => l.map((n) => (n.unread ? { ...n, unread: false } : n)));
    setServer((s) => s.map((n) => ({ ...n, unread: false })));
    try {
      await api.put("/api/v2/notification/markRead?category=all");
    } catch {
      /* offline */
    }
  }, [api, saveLocal]);
  const notifications = useMemo(() => mergeNotifications(server, local), [server, local]);
  const unread = notifications.filter((n) => n.unread).length;

  // ------------------------------------------------------------ reminder firing

  const fired = useRef<Map<string, number>>(new Map(Object.entries(readLS<Record<string, number>>(FIRED_KEY, {}))));
  const timers = useRef<number[]>([]);
  const fire = useCallback(
    (i: ReminderInstance) => {
      const key = firingKey(i);
      if (fired.current.has(key) || !enabledRef.current) return;
      const now = Date.now();
      fired.current.set(key, now);
      for (const [k, at] of fired.current) if (now - at > 3 * 86_400_000) fired.current.delete(k);
      writeLS(FIRED_KEY, Object.fromEntries(fired.current));
      const n = instanceToNotification(i, now);
      saveLocal((l) => [n, ...l.filter((x) => x.id !== n.id)]);
      setPopups((p) => [...p.filter((x) => !(x.targetId === i.targetId && (x.itemId ?? "") === (i.itemId ?? ""))), i]);
      // a system notification when the tab is in the background and this device has no push subscription
      if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible" && !localStorage.getItem(PUSH_KEY)) {
        void navigator.serviceWorker?.getRegistration().then((reg) => {
          const title = n.title;
          const opts = { body: "Reminder", tag: n.id, data: { ...n.data, title } };
          if (reg) return reg.showNotification(title, opts);
          new Notification(title, opts);
        });
      }
    },
    [saveLocal],
  );
  const pollReminders = useCallback(async () => {
    if (!enabledRef.current) {
      if (isCapacitor()) void scheduleNativeReminders([], false);
      return;
    }
    const now = Date.now();
    const ahead = isCapacitor() ? 48 * 3600_000 : LOOKAHEAD;
    let list: ReminderInstance[];
    try {
      list = await api.get<ReminderInstance[]>(`/api/v2/reminder/instances?from=${now - 60_000}&to=${now + ahead}`);
    } catch {
      return;
    }
    if (isCapacitor()) void scheduleNativeReminders(Array.isArray(list) ? list : [], true);
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
    const seenConstant = new Set<string>();
    for (const i of Array.isArray(list) ? list : []) {
      if (fired.current.has(firingKey(i))) continue;
      // constant reminders come as one instance per minute: schedule only the next one of each target
      if (i.constant) {
        const k = `${i.kind}:${i.targetId}:${i.itemId ?? ""}`;
        if (seenConstant.has(k)) continue;
        seenConstant.add(k);
      }
      const delay = i.fireAtMs - Date.now();
      if (delay <= 0) fire(i);
      else timers.current.push(window.setTimeout(() => fire(i), delay));
    }
  }, [api, fire]);
  // poll on start, every minute, and after a sync that changed reminder-bearing tasks
  const sig = useMemo(
    () =>
      tasks
        .filter((t) => (t.reminders?.length ?? 0) > 0 || t.snoozeReminderTime || (t.items ?? []).some((it) => (it as { reminders?: unknown[] }).reminders?.length))
        .map((t) => `${t.id}:${t.modifiedTime ?? ""}:${t.status}:${t.deleted ? 1 : 0}`)
        .join("|"),
    [tasks],
  );
  // the server computes instances from its own copy, so poll after a sync has pushed the change
  const dirtyAt = useRef<number | null>(0);
  useEffect(() => {
    dirtyAt.current = Date.now();
  }, [sig]);
  useEffect(() => {
    if (sync.lastSync === null || dirtyAt.current === null || sync.lastSync < dirtyAt.current) return;
    dirtyAt.current = null;
    void pollReminders();
  }, [sync.lastSync, pollReminders]);
  useEffect(() => {
    const i = window.setInterval(() => void pollReminders(), 60_000);
    return () => {
      clearInterval(i);
      timers.current.forEach((t) => clearTimeout(t));
    };
  }, [pollReminders]);

  const dismissPopup = useCallback((i: ReminderInstance) => setPopups((p) => p.filter((x) => x !== i)), []);
  const closeReminder = useCallback(
    async (i: ReminderInstance) => {
      dismissPopup(i);
      if (!i.taskId) return;
      try {
        const res = await api.post<{ id2etag?: Record<string, string> }>("/api/v2/task/closeRemind", { taskId: i.taskId, ...(i.itemId ? { itemId: i.itemId } : {}), ...(i.reminderId ? { reminderId: i.reminderId } : {}), triggerTime: i.fireAt });
        const etag = res?.id2etag?.[i.taskId];
        await repo.patchFromServer(i.taskId, { snoozeReminderTime: undefined, remindTime: undefined, ...(etag ? { etag } : {}) } as never);
      } catch (e) {
        if (!(e instanceof HttpError)) app.toast("Offline: the reminder closes here only");
      }
      void pollReminders();
    },
    [api, repo, dismissPopup, pollReminders, app],
  );
  const snoozeReminder = useCallback(
    async (i: ReminderInstance, minutes: number): Promise<boolean> => {
      dismissPopup(i);
      writeLS("recentSnoozeReminderMinutes", minutes);
      if (!i.taskId) return false;
      let ok = false;
      try {
        const res = await api.post<{ snoozeReminderTime?: string; id2etag?: Record<string, string> }>("/api/v2/reminder/delay", { taskId: i.taskId, ...(i.itemId ? { itemId: i.itemId } : {}), delayMinutes: minutes });
        const etag = res?.id2etag?.[i.taskId];
        if (!i.itemId && res?.snoozeReminderTime) await repo.patchFromServer(i.taskId, { snoozeReminderTime: res.snoozeReminderTime, ...(etag ? { etag } : {}) } as never);
        app.toast(`Snoozed for ${minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes === 60 ? "" : "s"}`}`);
        ok = true;
      } catch {
        app.toast(isCapacitor() ? `Snoozed locally for ${minutes} min` : "Could not snooze while offline");
      }
      void pollReminders();
      return ok;
    },
    [api, repo, dismissPopup, pollReminders, app],
  );

  // ------------------------------------------------------------ service worker messages and Web Push

  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const on = (e: MessageEvent): void => {
      const d = e.data as { type?: string; hash?: string } | null;
      if (d?.type === "noor-open" && d.hash) location.hash = d.hash;
      if (d?.type === "noor-push") void refreshNotifications();
    };
    sw.addEventListener("message", on);
    return () => sw.removeEventListener("message", on);
  }, [refreshNotifications]);

  useEffect(() => {
    if (isCapacitor()) {
      void ensureReminderSetup();
      if (enabledRef.current) {
        void requestNativeNotificationPermission().then((ok) => {
          setPush(ok ? "on" : "denied");
          if (ok) void pollReminders();
        });
      } else {
        setPush("off");
      }
      return;
    }
    if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || typeof PushManager === "undefined") return setPush("unsupported");
    if (Notification.permission === "denied") return setPush("denied");
    void navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = await reg?.pushManager?.getSubscription().catch(() => null);
      setPush(sub && localStorage.getItem(PUSH_KEY) ? "on" : "off");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isCapacitor()) return;
    const handleAction = async (ev: NativeNotificationAction): Promise<void> => {
      const extra = (ev.notification?.extra ?? {}) as Record<string, unknown>;
      const inst: ReminderInstance = {
        kind: (extra.kind as ReminderInstance["kind"]) || "task",
        targetId: String(extra.targetId ?? extra.taskId ?? ""),
        ...(extra.taskId ? { taskId: String(extra.taskId) } : {}),
        ...(extra.itemId ? { itemId: String(extra.itemId) } : {}),
        ...(extra.projectId ? { projectId: String(extra.projectId) } : {}),
        title: String(extra.title ?? "Reminder"),
        ...(extra.reminderId ? { reminderId: String(extra.reminderId) } : {}),
        fireAtMs: Number(extra.fireAtMs ?? Date.now()),
        fireAt: String(extra.fireAt ?? new Date().toISOString().replace("Z", "+0000")),
      };
      if (ev.actionId === "done") {
        if (inst.taskId && !inst.itemId) {
          const cur = await db.tasks.get(inst.taskId);
          if (cur && cur.status === 0) await repo.toggleComplete(inst.taskId);
        }
        await closeReminder(inst);
        if (inst.taskId) await cancelTaskNativeReminders(inst.taskId);
        app.toast("Task completed");
      } else if (ev.actionId === "snooze") {
        const mins = readLS<number>("recentSnoozeReminderMinutes", 10);
        const synced = await snoozeReminder(inst, mins);
        if (!synced) await scheduleLocalSnoozeFallback(inst, mins);
      } else {
        location.hash = hashFor(extra);
      }
    };
    const offNative = onNotificationAction((ev) => void handleAction(ev));
    const onCustom = (e: Event): void => void handleAction((e as CustomEvent<NativeNotificationAction>).detail);
    window.addEventListener("noor-notif-action", onCustom);
    return () => {
      offNative();
      window.removeEventListener("noor-notif-action", onCustom);
    };
  }, [db, repo, closeReminder, snoozeReminder, app]);

  const enablePush = useCallback(async (): Promise<PushState> => {
    if (isCapacitor()) {
      const ok = await requestNativeNotificationPermission();
      const state: PushState = ok ? "on" : "denied";
      setPush(state);
      if (ok) void pollReminders();
      return state;
    }
    if (typeof Notification === "undefined" || !("serviceWorker" in navigator) || typeof PushManager === "undefined") {
      setPush("unsupported");
      return "unsupported";
    }
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") {
      setPush("denied");
      return "denied";
    }
    try {
      const { publicKey } = await api.get<{ publicKey: string | null }>("/api/v2/push/vapidPublicKey");
      if (!publicKey) {
        setPush("nokey");
        return "nokey";
      }
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js"));
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource }));
      const json = sub.toJSON();
      await api.post("/api/v2/push/register", { pushToken: JSON.stringify(json), osType: 0, hl: "en_US", subscription: json });
      localStorage.setItem(PUSH_KEY, String(json.endpoint ?? ""));
      setPush("on");
      return "on";
    } catch (e) {
      console.warn("push subscribe failed", e);
      setPush("error");
      return "error";
    }
  }, [api, pollReminders]);
  const disablePush = useCallback(async () => {
    if (isCapacitor()) {
      await scheduleNativeReminders([], false);
      setPush("off");
      return;
    }
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription().catch(() => null);
    await sub?.unsubscribe().catch(() => false);
    localStorage.removeItem(PUSH_KEY);
    setPush("off");
  }, []);

  // ------------------------------------------------------------ templates (TPL-018: cached in local keys)

  const reloadTemplates = useCallback(async () => {
    try {
      const t = await api.get<{ taskTemplates?: Template[]; noteTemplates?: Template[] }>("/api/v2/templates");
      const tt = [...(t.taskTemplates ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      setTaskTemplates(tt);
      setNoteTemplates(t.noteTemplates ?? []);
      writeLS("taskTemplates", tt);
      writeLS("noteTemplates", t.noteTemplates ?? []);
      const p = await api.get<{ projectTemplates?: ProjectTemplate[] }>("/api/v2/projectTemplates/all?timestamp=0");
      const pt = (p.projectTemplates ?? []).filter((x) => !x.deleted);
      setProjectTemplates(pt);
      writeLS("projectTemplates", pt);
    } catch {
      /* offline: the cached lists stay */
    }
  }, [api]);
  useEffect(() => {
    const on = (): void => void reloadTemplates();
    window.addEventListener("noor-templates", on);
    return () => window.removeEventListener("noor-templates", on);
  }, [reloadTemplates]);
  useEffect(() => {
    if (sync.lastSync !== null) void reloadTemplates();
  }, [sync.lastSync === null, reloadTemplates]); // eslint-disable-line react-hooks/exhaustive-deps

  const value: M5 = {
    notifications,
    unread,
    refreshNotifications,
    markAllRead,
    popups,
    closeReminder,
    snoozeReminder,
    dismissPopup,
    pollReminders,
    push,
    enablePush,
    disablePush,
    taskTemplates,
    noteTemplates,
    projectTemplates,
    reloadTemplates,
    bellOpen,
    setBellOpen,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
