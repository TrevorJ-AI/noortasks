import { AlarmClock, MessageSquare, Pencil, UserCheck, Users, Bell, BellRing, CalendarCheck, Check, ChevronDown, Hourglass, Plus, Sprout, X } from "lucide-react";
import { Card, CheckLine, LinkBtn } from "./settings/kit";
import { useEffect, useRef, useState } from "react";
import { formatTime, parseDate } from "../lib/dates";
import { SNOOZE_MINUTES, notificationHash, type NotificationItem, type ReminderInstance } from "../lib/notify";
import { go } from "../model/router";
import { useApp } from "./ctx";
import { useM5, type PushState } from "./m5ctx";
import { Menu, Popover, Switch, anchorOf, type Anchor } from "./primitives";

function ago(iso: string, now: number): string {
  const t = parseDate(iso);
  if (Number.isNaN(t)) return "";
  const m = Math.round((now - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function kindIcon(n: { type?: string; data?: Record<string, unknown> }): JSX.Element {
  const k = String(n.data?.kind ?? "");
  // M8 collaboration notifications
  if (n.type === "share") return <Users size={16} />;
  if (n.type === "assign") return <UserCheck size={16} />;
  if (n.type === "comment" || n.type === "mention") return <MessageSquare size={16} />;
  if (n.type === "change") return <Pencil size={16} />;
  if (n.type === "dailyReminder" || k === "dailySummary") return <CalendarCheck size={16} />;
  if (k === "habit") return <Sprout size={16} />;
  if (k === "countdown") return <Hourglass size={16} />;
  return <AlarmClock size={16} />;
}

/** The bell popover (NTF-001, NTF-007): Notifications and Activities tabs, newest first. */
export function NotificationCentre({ onClose }: { onClose: () => void }): JSX.Element {
  const app = useApp();
  const m5 = useM5();
  const [tab, setTab] = useState<"notification" | "activity">(app.route.itemId === "activity" ? "activity" : "notification");
  useEffect(() => {
    void m5.refreshNotifications();
    return () => void m5.markAllRead();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = m5.notifications.filter((n) => (tab === "activity" ? n.category === "activity" : n.category !== "activity"));
  const open = (n: NotificationItem): void => {
    onClose();
    location.hash = notificationHash(n);
  };
  const sub = (n: NotificationItem): string => {
    const d = n.data ?? {};
    if (n.type === "dailyReminder") return `${Number(d.todayCount ?? 0)} due today${d.overdueCount ? `, ${Number(d.overdueCount)} overdue` : ""}`;
    const at = parseDate(String(d.fireAt ?? ""));
    const what = d.kind === "habit" ? "Habit" : d.kind === "countdown" ? "Countdown" : d.kind === "checklist" ? "Checklist item" : "Reminder";
    return Number.isNaN(at) ? what : `${what} at ${formatTime(at, app.settings.showMeridiem)}`;
  };
  return (
    <div className="ntf" data-testid="notification-centre">
      <div className="ntf-head">
        <div className="seg small" role="tablist">
          <button role="tab" className={tab === "notification" ? "on" : ""} data-testid="ntf-tab-notifications" onClick={() => setTab("notification")}>Notifications</button>
          <button role="tab" className={tab === "activity" ? "on" : ""} data-testid="ntf-tab-activities" onClick={() => setTab("activity")}>Activities</button>
        </div>
      </div>
      <div className="ntf-list">
        {rows.length === 0 && (
          <div className="ntf-empty">
            <Bell size={28} strokeWidth={1.4} />
            <span>{tab === "activity" ? "No activity from shared lists yet" : "No notifications"}</span>
          </div>
        )}
        {rows.map((n) => (
          <button key={n.id} className={`ntf-row${n.unread ? " unread" : ""}`} data-testid="ntf-row" onClick={() => open(n)}>
            <span className="ntf-icon">{kindIcon(n)}</span>
            <span className="ntf-text">
              <span className="ntf-title">{n.title || "Untitled"}</span>
              <span className="ntf-sub">{sub(n)}</span>
            </span>
            <span className="ntf-time">{ago(n.createdTime, app.now)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Opens the centre from the n/:name/:type route (NTF-009), then returns to the last list. */
export function NotifyRoute(): JSX.Element | null {
  const m5 = useM5();
  useEffect(() => {
    m5.setBellOpen(true);
    const back = localStorage.getItem("lastTaskPath") || "q/today/tasks";
    location.replace(`#${back}`);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function SnoozeButton({ i }: { i: ReminderInstance }): JSX.Element {
  const m5 = useM5();
  const [a, setA] = useState<Anchor | null>(null);
  const recent = Number(localStorage.getItem("recentSnoozeReminderMinutes") ?? "0");
  const opts = recent && !SNOOZE_MINUTES.includes(recent) ? [recent, ...SNOOZE_MINUTES] : SNOOZE_MINUTES;
  const label = (m: number): string => (m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`);
  return (
    <>
      <button className="btn sm" data-testid="reminder-snooze" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        Snooze <ChevronDown size={13} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="snooze-menu">
          <Menu onClose={() => setA(null)} items={[...opts.map((m) => ({ label: label(m), checked: m === recent, testId: `snooze-${m}`, onClick: () => void m5.snoozeReminder(i, m) })), { label: "Tomorrow", onClick: () => void m5.snoozeReminder(i, 24 * 60) }]} />
        </Popover>
      )}
    </>
  );
}

/** In-app reminder cards, bottom right, newest at the bottom (RMD-026 snooze, TASK-148 close). */
export function ReminderPopups(): JSX.Element | null {
  const app = useApp();
  const m5 = useM5();
  if (!m5.popups.length) return null;
  return (
    <div className="rem-stack" data-testid="reminder-popups">
      {m5.popups.map((i) => {
        const task = i.taskId ? app.tasks.find((t) => t.id === i.taskId) : undefined;
        const title = i.kind === "dailySummary" ? "Daily summary" : (task?.title ?? i.title) || "Untitled";
        return (
          <div key={`${i.kind}:${i.targetId}:${i.itemId ?? ""}`} className={`rem-card${i.constant ? " constant" : ""}`} data-testid="reminder-card" role="alert">
            <div className="rem-card-head">
              <BellRing size={15} />
              <span>{i.kind === "dailySummary" ? "Daily summary" : i.kind === "habit" ? "Habit" : i.kind === "countdown" ? "Countdown" : i.constant ? "Constant reminder" : "Reminder"}</span>
              <span className="grow" />
              <span className="muted small">{formatTime(i.fireAtMs, app.settings.showMeridiem)}</span>
              <button className="icon-btn xs" aria-label="Dismiss reminder" onClick={() => m5.dismissPopup(i)}>
                <X size={13} />
              </button>
            </div>
            <button
              className="rem-card-title"
              onClick={() => {
                location.hash = notificationHash({ id: "", title, type: i.kind === "dailySummary" ? "dailyReminder" : "reminder", createdTime: "", unread: false, data: { ...i } });
                if (i.kind !== "task" && i.kind !== "checklist") m5.dismissPopup(i);
              }}
            >
              {title}
            </button>
            {i.kind === "dailySummary" && <div className="muted small">{i.todayCount ?? 0} due today{i.overdueCount ? `, ${i.overdueCount} overdue` : ""}</div>}
            <div className="rem-card-actions">
              {i.taskId && <SnoozeButton i={i} />}
              {task && task.status === 0 && i.kind === "task" && (
                <button className="btn sm" data-testid="reminder-complete" onClick={() => void app.repo.toggleComplete(task.id).then(() => m5.closeReminder(i))}>
                  <Check size={13} /> Complete
                </button>
              )}
              <button className="btn sm primary" data-testid="reminder-close" onClick={() => void m5.closeReminder(i)}>
                Got it
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ Settings > Notifications

interface DailyReminder {
  enable: boolean;
  dailyReminders: string[];
  notifyOptions: string[];
  weekDays: string[];
  holidayNotify: boolean;
}
const WEEK = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const WEEK_LABEL: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

const PUSH_TEXT: Record<PushState, string> = {
  unsupported: "This browser cannot receive push reminders",
  denied: "Notifications are blocked for this site in the browser",
  off: "Reminders arrive while the app is open",
  on: "This device receives reminders when the app is closed",
  nokey: "The server has no push key yet (generate-vapid); reminders arrive while the app is open",
  error: "Push registration failed; reminders arrive while the app is open",
};

/** Settings > Notifications (NTF-010 order): Daily Notifications, Web Reminder, Global Constant Reminder, Email, address. */
export function NotificationSettings({ Row }: { Row: (p: { label: string; children: React.ReactNode; hint?: string }) => JSX.Element }): JSX.Element {
  const app = useApp();
  const m5 = useM5();
  const { settings, repo, engine } = app;
  const [dr, setDr] = useState<DailyReminder | null>(null);
  const [newTime, setNewTime] = useState("08:00");
  const [email, setEmail] = useState<string>("");
  const emailEdited = useRef(false);
  useEffect(() => {
    engine.api.get<DailyReminder>("/api/v2/user/preferences/dailyReminder").then(
      (d) => setDr({ enable: !!d?.enable, dailyReminders: d?.dailyReminders ?? [], notifyOptions: d?.notifyOptions ?? [], weekDays: d?.weekDays ?? [], holidayNotify: !!d?.holidayNotify }),
      () => setDr({ enable: false, dailyReminders: [], notifyOptions: [], weekDays: [], holidayNotify: false }),
    );
    const stored = ((app.ext.general_conf ?? {}) as { notificationEmail?: string }).notificationEmail;
    if (stored) setEmail(stored);
    else engine.api.get<Record<string, unknown>>("/api/v2/user/profile").then((p) => { if (!emailEdited.current) setEmail(String(p?.email ?? "")); }, () => {});
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps
  const saveDr = (patch: Partial<DailyReminder>): void => {
    if (!dr) return;
    const next = { ...dr, ...patch };
    if (next.enable && next.dailyReminders.length === 0) next.dailyReminders = ["09:00"];
    setDr(next);
    void engine.api.post("/api/v2/user/preferences/dailyReminder", next).catch(() => app.toast("Could not save while offline"));
  };
  const rem = ((app.ext.reminder ?? {}) as { annoyingAlertEnabled?: boolean; annoyingRemindItems?: string[] });
  const items = rem.annoyingRemindItems ?? ["task", "habit", "countdown"];
  const setRem = (patch: Record<string, unknown>): void => void repo.setExt("reminder", { ...rem, annoyingRemindItems: items, ...patch });
  const gc = ((app.ext.general_conf ?? {}) as { emailRemindEnabled?: boolean; emailRemindItems?: string[] });
  const webOn = settings.isNotificationEnabled !== false && (settings as { notificationEnabled?: boolean }).notificationEnabled !== false;
  const opts = dr?.notifyOptions.length ? dr.notifyOptions : ["TODAY", "OVERDUE"];
  const days = dr?.weekDays.length ? dr.weekDays : WEEK;
  return (
    <>
      <Card>
        <Row label="Daily Notifications" hint="Get a summary of today's and overdue tasks at the times you choose every day.">
          <Switch testId="set-daily-enable" checked={!!dr?.enable} onChange={(v) => saveDr({ enable: v })} />
        </Row>
        {dr?.enable && (
          <div className="set-sub" data-testid="daily-options">
            <div className="set-sub-row">
              <span>Daily Alert Time</span>
              <div className="chip-wrap">
                {dr.dailyReminders.map((t) => (
                  <span key={t} className="time-chip" data-testid="daily-time">
                    {t}
                    <button className="pill-x" aria-label={`Remove ${t}`} onClick={() => saveDr({ dailyReminders: dr.dailyReminders.filter((x) => x !== t) })}><X size={10} /></button>
                  </span>
                ))}
                <input className="field time" type="time" step={1800} value={newTime} aria-label="New alert time" data-testid="daily-time-input" onChange={(e) => setNewTime(e.target.value)} />
                <button className="icon-btn sm" aria-label="Add alert time" title="Add this time" data-testid="daily-time-add" onClick={() => newTime && saveDr({ dailyReminders: [...new Set([...dr.dailyReminders, newTime])].sort() })}><Plus size={14} /></button>
              </div>
            </div>
            <div className="set-sub-row">
              <span>Days</span>
              <div className="day-pick">
                {WEEK.map((w) => (
                  <button key={w} className={days.includes(w) ? "on" : ""} onClick={() => saveDr({ weekDays: days.includes(w) ? days.filter((x) => x !== w) : WEEK.filter((x) => x === w || days.includes(x)) })}>{WEEK_LABEL[w]}</button>
                ))}
              </div>
            </div>
            <div className="set-sub-row">
              <span>Skip weekends</span>
              <Switch testId="daily-skip-weekends" checked={days.length === 5 && !days.includes("SA") && !days.includes("SU")} onChange={(v) => saveDr({ weekDays: v ? ["MO", "TU", "WE", "TH", "FR"] : [] })} />
            </div>
            <div className="set-sub-row">
              <span>Content</span>
              <div className="row gap">
                {[["TODAY", "Today"], ["OVERDUE", "Overdue"]].map(([k, l]) => (
                  <CheckLine key={k} label={l} checked={opts.includes(k!)} onChange={() => saveDr({ notifyOptions: opts.includes(k!) ? opts.filter((x) => x !== k) : [...opts, k!] })} />
                ))}
              </div>
            </div>
            <div className="set-sub-row">
              <span>Also on holidays</span>
              <Switch checked={dr.holidayNotify} onChange={(v) => saveDr({ holidayNotify: v })} />
            </div>
          </div>
        )}
      </Card>
      <Card>
        <Row label="Web Reminder" hint={webOn ? (m5.push === "on" ? undefined : PUSH_TEXT[m5.push]) : "Reminders are off on every device"}>
          <Switch
            testId="set-web-reminder"
            checked={webOn}
            onChange={(v) => {
              void repo.setSettings({ isNotificationEnabled: v, notificationEnabled: v } as never);
              if (v) void m5.enablePush();
              else void m5.disablePush();
            }}
          />
        </Row>
        {webOn && (m5.push === "off" || m5.push === "error" || m5.push === "nokey") && (
          <div className="set-sub">
            <LinkBtn testId="push-enable" onClick={() => void m5.enablePush().then((s) => app.toast(PUSH_TEXT[s]))}>Get reminders when the app is closed</LinkBtn>
          </div>
        )}
      </Card>
      <Card>
        <Row label="Global Constant Reminder" hint="When on, a reminder keeps coming back every minute until you act on it.">
          <Switch testId="set-constant" checked={rem.annoyingAlertEnabled === true} onChange={(v) => setRem({ annoyingAlertEnabled: v })} />
        </Row>
        {rem.annoyingAlertEnabled && (
          <div className="set-sub" data-testid="constant-types">
            {[["task", "Tasks"], ["habit", "Habits"], ["countdown", "Countdowns"]].map(([k, l]) => (
              <div key={k} className="set-sub-row">
                <span>{l}</span>
                <Switch testId={`constant-${k}`} checked={items.includes(k!)} onChange={(v) => setRem({ annoyingRemindItems: v ? [...items, k] : items.filter((x) => x !== k) })} />
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card>
        <Row label="Email Notifications" hint="Also send task reminders by email. Saved now; mail goes out once the server has a mail transport.">
          <Switch
            testId="set-email"
            checked={!!settings.isEmailEnabled}
            onChange={(v) => {
              void repo.setSettings({ isEmailEnabled: v });
              void repo.setExt("general_conf", { ...gc, emailRemindEnabled: v, emailRemindItems: gc.emailRemindItems ?? ["task", "habit"] });
            }}
          />
        </Row>
        <Row label="Email address">
          <input
            className="field st-inline-field"
            type="email"
            data-testid="set-email-address"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => { emailEdited.current = true; setEmail(e.target.value); }}
            onBlur={() => void repo.setExt("general_conf", { ...gc, notificationEmail: email })}
          />
        </Row>
      </Card>
    </>
  );
}
