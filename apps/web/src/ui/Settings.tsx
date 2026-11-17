import { Bell, CalendarDays, CircleUserRound, Clock, Filter, Handshake, Info, Keyboard, LayoutGrid, PaintRoller, Plug, Settings2, Sprout, Timer, Users, X, Layers, Sun, Sunrise, CalendarRange, UserCheck, Inbox as InboxIcon, NotebookText, Tag, ListFilter, CircleCheck, CircleX, Trash2, ChevronDown } from "lucide-react";
import { clampPomo } from "../data/m4types";
import { sectionLabel, SectionsDialog } from "./Habits";
import { useM4 } from "./m4ctx";
import { useEffect, useState } from "react";
import { getStoredServerUrl, isCapacitor, saveServerUrl } from "../lib/capacitor";
import { defaultPreferences } from "../lib/core";
import { go } from "../model/router";
import { ALLDAY_REMINDERS, TIMED_REMINDERS, reminderLabel } from "./DatePicker";
import { ALT_CALENDARS } from "../model/calendar";
import { useApp } from "./ctx";
import { Modal, PRIORITIES, Select, Switch } from "./primitives";
import { SHORTCUT_GROUPS, keyLabel } from "./shortcuts";
import { SMART_DEFAULT_VIS } from "./Sidebar";
import { NotificationSettings } from "./Notify";
import { BackupButtons, IntegrationsTab } from "./Backup";
import { TemplateManager } from "./Templates";
import { CalendarTab } from "./CalSettings";
import { CollaborateTab, MembersTab } from "./Members";
import { PairingPanel, type PairingState } from "./Setup";
import { AudioAiGlyph } from "./AttachmentAi";
import { Card, CheckLine, Drop, LinkBtn, MultiDrop, Row, SearchDrop, SetSection, SetTitle } from "./settings/kit";
import { AppearanceTab } from "./settings/Appearance";
import { AboutTab } from "./settings/About";

const TABS: Array<{ key: string; label: string; icon: JSX.Element; group?: boolean; title?: boolean }> = [
  { key: "profile", label: "Account", icon: <CircleUserRound size={18} /> },
  { key: "feature", label: "Features", icon: <LayoutGrid size={18} />, group: true, title: true },
  { key: "smart", label: "Smart List", icon: <Filter size={18} />, title: true },
  { key: "notifications", label: "Notifications", icon: <Bell size={18} />, title: true },
  { key: "focus", label: "Focus", icon: <Timer size={18} />, title: true },
  { key: "habit", label: "Habit", icon: <Sprout size={18} />, title: true },
  { key: "date", label: "Date & Time", icon: <Clock size={18} />, title: true },
  { key: "calendar", label: "Calendar", icon: <CalendarDays size={18} />, title: true },
  { key: "appearance", label: "Appearance", icon: <PaintRoller size={18} /> },
  { key: "more", label: "More", icon: <Settings2 size={18} /> },
  { key: "integrations", label: "Integrations & Import", icon: <Plug size={18} />, group: true },
  { key: "collaborate", label: "Collaborate", icon: <Handshake size={18} />, title: true },
  { key: "members", label: "Members", icon: <Users size={18} />, title: true },
  { key: "shortcuts", label: "Shortcuts", icon: <Keyboard size={18} /> },
  { key: "about", label: "About", icon: <Info size={18} />, group: true },
];


function AccountTab(): JSX.Element {
  const { engine, sync, toast, me } = useApp();
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [binding, setBinding] = useState<{ thirdSiteBinds?: Array<{ nickName?: string; email?: string }> } | null>(null);
  const [serverUrl, setServerUrl] = useState(getStoredServerUrl);
  const [pairing, setPairing] = useState<PairingState | null>(null);
  const [pairBusy, setPairBusy] = useState(false);
  useEffect(() => {
    engine.api.get<Record<string, unknown>>("/api/v2/user/profile").then(setProfile, () => setProfile(null));
    engine.api.get<{ thirdSiteBinds?: Array<{ nickName?: string; email?: string }> }>("/api/v2/user/userBindingInfo").then(setBinding, () => setBinding(null));
  }, [engine]);
  const issuePairing = async (): Promise<void> => {
    setPairBusy(true);
    try {
      const res = await engine.api.post<{ serverName: string; token: string; expiresMs: number }>("/api/auth/pairing-token");
      setPairing(res);
    } catch {
      toast("Could not generate pairing code");
    } finally {
      setPairBusy(false);
    }
  };
  const name = String(profile?.displayName ?? profile?.name ?? me?.name ?? "NoorTasks") || "NoorTasks";
  const google = binding?.thirdSiteBinds?.[0];
  const multi = !!me && !me.single;
  return (
    <div className="st-account">
      <div className="account-head">
        <span className="account-avatar" aria-hidden>{name.trim().charAt(0).toUpperCase() || "N"}</span>
        <div className="account-name">{name}</div>
        <div className="account-sub">All features unlocked</div>
      </div>
      <Card>
        <Row label="Email">{String(profile?.email || me?.email || "Not set")}</Row>
        <Row label="Password">{google ? "Signs in with Google" : "Set on the server"}</Row>
      </Card>
      {google && (
        <Card>
          <Row label="Google">{google.nickName || google.email || "Linked"}</Row>
        </Card>
      )}
      <Card>
        {multi && (
          <Row label="Login Devices">
            <LinkBtn testId="generate-pairing-qr" disabled={pairBusy} onClick={() => void issuePairing()}>
              {pairBusy ? "Generating..." : "Pair a device"}
            </LinkBtn>
          </Row>
        )}
        <Row label="Backup & Restore">
          <BackupButtons />
        </Row>
      </Card>
      <Card>
        {me?.serverName && <Row label="Server">{me.serverName}</Row>}
        {isCapacitor() && (
          <Row label="Server address" hint="Reachable over Tailscale or your local network">
            <div className="row gap">
              <input className="field" type="url" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} aria-label="Server address" />
              <LinkBtn
                onClick={() => {
                  const next = saveServerUrl(serverUrl);
                  if (!next) return;
                  setServerUrl(next);
                  engine.api.setBase(next);
                  void engine.sync();
                  toast("Server address saved");
                }}
              >
                Save
              </LinkBtn>
            </div>
          </Row>
        )}
        <Row label="Sync">
          {sync.state === "idle" ? "Up to date" : sync.state}
          {sync.lastSync ? `, ${new Date(sync.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}
          {sync.pending ? `, ${sync.pending} waiting` : ""}
        </Row>
      </Card>
      {pairing && (
        <Modal onClose={() => setPairing(null)} testId="pairing-modal">
          <PairingPanel serverName={pairing.serverName} token={pairing.token} onRegenerate={issuePairing} onDone={() => setPairing(null)} doneLabel="Done" />
        </Modal>
      )}
    </div>
  );
}

const DESKTOP_TABS = ["TASK", "CALENDAR", "MATRIX", "POMO", "HABIT", "COUNTDOWN", "SEARCH", "AI_ASSISTANT"];

function FeaturesTab(): JSX.Element {
  const app = useApp();
  const { settings, repo } = app;
  const { m4 } = useM4();
  // Eisenhower Matrix lives in ext.desktopTabBars, off by default (MTRX-001, SET-120)
  const desk = ((app.ext.desktopTabBars ?? {}) as { tabBars?: Array<{ name: string; active: boolean }> }).tabBars ?? DESKTOP_TABS.map((name) => ({ name, active: name === "TASK" || name === "CALENDAR" || name === "SEARCH" }));
  const matrixOn = desk.find((b) => b.name === "MATRIX")?.active === true;
  const setMatrix = (v: boolean): void => void repo.setExt("desktopTabBars", { tabBars: desk.map((b) => (b.name === "MATRIX" ? { ...b, active: v } : b)) });
  const bars = settings.tabBars ?? defaultPreferences().tabBars;
  const isOn = (name: string): boolean => bars.find((b) => b.name === name)?.enabled ?? false;
  const toggle = (name: string, v: boolean): void => {
    const next = bars.some((b) => b.name === name) ? bars.map((b) => (b.name === name ? { ...b, enabled: v } : b)) : [...bars, { name, enabled: v }];
    void repo.setSettings({ tabBars: next });
  };
  const barsWith = (name: string, v: boolean) => (bars.some((b) => b.name === name) ? bars.map((b) => (b.name === name ? { ...b, enabled: v } : b)) : [...bars, { name, enabled: v }]);
  // HAB-001 / SET-121: tabBars HABIT plus the habit preference enabled; FOC-001 / SET-122: tabBars POMO plus pomodoroEnabled
  const setHabit = (v: boolean): void => {
    void repo.setSettings({ tabBars: barsWith("HABIT", v) });
    void m4.setHabitPrefs({ enabled: v });
  };
  const setPomo = (v: boolean): void => void repo.setSettings({ tabBars: barsWith("POMO", v), pomodoroEnabled: v } as never);
  const cards: Array<{ key: string; label: string; desc: string; on: boolean; set: (v: boolean) => void }> = [
    { key: "calendar", label: "Calendar", desc: "Manage your tasks with calendar views", on: isOn("CALENDAR"), set: (v) => toggle("CALENDAR", v) },
    { key: "matrix", label: "Eisenhower Matrix", desc: "Focus on what's important and urgent", on: matrixOn, set: setMatrix },
    { key: "habit", label: "Habit Tracker", desc: "Build habits and keep track of them", on: isOn("HABIT"), set: setHabit },
    { key: "pomo", label: "Pomodoro", desc: "Use a Pomodoro timer or stopwatch to stay focused", on: isOn("POMO"), set: setPomo },
    { key: "countdown", label: "Countdown", desc: "Remember every special day", on: !!settings.enableCountdown, set: (v) => void repo.setSettings({ enableCountdown: v }) },
    { key: "search", label: "Search tab", desc: "Find any task, note or tag from the side bar", on: isOn("SEARCH"), set: (v) => toggle("SEARCH", v) },
  ];
  return (
    <>
      <div className="feat-grid">
        {cards.map((c) => (
          <div key={c.key} className="feat-card">
            <div className="feat-head">
              <span className="feat-name">{c.label}</span>
              <Switch testId={c.key === "search" ? undefined : `feature-${c.key}`} checked={c.on} onChange={c.set} />
            </div>
            <div className="feat-desc">{c.desc}</div>
            <FeatureArt kind={c.key} />
          </div>
        ))}
      </div>
      <Card className="feat-ai-card" testId="feature-ai-card">
        <Row
          icon={<AudioAiGlyph size={15} />}
          label="AI transcription"
          hint={
            app.ai.configured
              ? `Ready (${app.ai.provider}: ${app.ai.transcribeModel})`
              : "Not configured on the server"
          }
          testId="feature-ai-row"
        >
          <span
            className={`feat-ai-badge${app.ai.configured ? " configured" : ""}`}
            data-testid="feature-ai-status"
          >
            {app.ai.configured ? "Configured" : "Not configured"}
          </span>
        </Row>
      </Card>
    </>
  );
}

/** Small CSS drawings of each feature on a coloured frame (our own shapes, no screenshots). */
function FeatureArt({ kind }: { kind: string }): JSX.Element {
  const n = (k: number): number[] => Array.from({ length: k }, (_, i) => i);
  let body: JSX.Element;
  if (kind === "calendar") {
    body = (
      <div className="fa-cal">
        {n(21).map((i) => (
          <span key={i} className="fa-cell">
            {[1, 3, 4, 8, 9, 12, 15, 17, 19].includes(i) && <i className={`fa-ev c${i % 4}`} />}
            {[3, 9, 15].includes(i) && <i className={`fa-ev c${(i + 1) % 4}`} />}
          </span>
        ))}
      </div>
    );
  } else if (kind === "matrix") {
    body = (
      <div className="fa-matrix">
        {n(4).map((q) => (
          <span key={q} className={`fa-q q${q}`}>
            <i className="fa-dot" />
            {n(3 - (q % 2)).map((l) => <i key={l} className="fa-line" />)}
          </span>
        ))}
      </div>
    );
  } else if (kind === "habit") {
    body = (
      <div className="fa-habit">
        {n(4).map((r) => (
          <span key={r} className="fa-hrow">
            <i className={`fa-hicon h${r}`} />
            <i className="fa-line" />
            <span className="fa-checks">{n(5).map((d) => <i key={d} className={(d + r) % 3 ? "on" : ""} />)}</span>
          </span>
        ))}
      </div>
    );
  } else if (kind === "pomo") {
    body = (
      <div className="fa-pomo">
        <span className="fa-ring"><b>25:00</b></span>
        <i className="fa-play" />
      </div>
    );
  } else if (kind === "countdown") {
    body = (
      <div className="fa-count">
        {[12, 48, 205].map((d, i) => (
          <span key={d} className="fa-tile">
            <i className={`fa-hicon h${i}`} />
            <b>{d}</b>
          </span>
        ))}
      </div>
    );
  } else {
    body = (
      <div className="fa-search">
        <span className="fa-bar"><i /></span>
        {n(3).map((r) => (
          <span key={r} className="fa-res"><i className="fa-box" /><i className="fa-line" /></span>
        ))}
      </div>
    );
  }
  return (
    <div className={`feat-art fa-${kind}-frame`} aria-hidden>
      <div className="fa-window">{body}</div>
    </div>
  );
}

const SHOW3 = [
  { value: "auto", label: "Show if not empty" },
  { value: "show", label: "Show" },
  { value: "hide", label: "Hide" },
];
const SHOW2 = [
  { value: "show", label: "Show" },
  { value: "hide", label: "Hide" },
];
const TAG_OPTS = [
  { value: "show", label: "Show" },
  { value: "auto", label: "Show(Omit Empty Tags)" },
  { value: "hide", label: "Hide" },
];
const SMART_CARDS: Array<Array<{ name: string; label: string; icon: JSX.Element; opts: typeof SHOW3 }>> = [
  [
    { name: "all", label: "All", icon: <Layers />, opts: SHOW2 },
    { name: "today", label: "Today", icon: <Sun />, opts: SHOW3 },
    { name: "tomorrow", label: "Tomorrow", icon: <Sunrise />, opts: SHOW3 },
    { name: "n7ds", label: "Next 7 Days", icon: <CalendarRange />, opts: SHOW3 },
    { name: "assignee", label: "Assigned to Me", icon: <UserCheck />, opts: SHOW3 },
    { name: "inbox", label: "Inbox", icon: <InboxIcon />, opts: SHOW3 },
    { name: "summary", label: "Summary", icon: <NotebookText />, opts: SHOW2 },
  ],
  [
    { name: "tag", label: "Tags", icon: <Tag />, opts: TAG_OPTS },
    { name: "filter", label: "Filters", icon: <ListFilter />, opts: SHOW2 },
  ],
  [
    { name: "completed", label: "Completed", icon: <CircleCheck />, opts: SHOW2 },
    { name: "abandoned", label: "Won't Do", icon: <CircleX />, opts: SHOW3 },
    { name: "trash", label: "Trash", icon: <Trash2 />, opts: SHOW2 },
  ],
];

function SmartTab(): JSX.Element {
  const { settings, repo } = useApp();
  const vis = (name: string): string => settings.smartProjects?.find((s) => s.name === name)?.visibility ?? SMART_DEFAULT_VIS[name] ?? "show";
  const set = (name: string, visibility: string): void => {
    const list = [...(settings.smartProjects ?? [])];
    const i = list.findIndex((s) => s.name === name);
    if (i >= 0) list[i] = { ...list[i]!, visibility };
    else list.push({ name, visibility, order: null });
    void repo.setSettings({ smartProjects: list });
  };
  return (
    <>
      {SMART_CARDS.map((card, i) => (
        <Card key={i}>
          {card.map((r) => {
            // a stored value outside this row's options (e.g. "auto" where only Show/Hide exist) reads as Show
            // a stored "Show if not empty" on a Show/Hide row (older data) is shown as it is, so the sidebar matches
            const v = vis(r.name);
            const opts = r.opts.some((o) => o.value === v) ? r.opts : SHOW3;
            return (
              <Row key={r.name} label={r.label} icon={r.icon}>
                <Drop testId={`smart-${r.name}`} value={v} onChange={(x) => set(r.name, x)} options={opts} />
              </Row>
            );
          })}
        </Card>
      ))}
    </>
  );
}

/** Focus settings (SET-214..220, SET-101, FOC-004..011, FOC-027, FOC-029). */
function FocusTab(): JSX.Element {
  const app = useApp();
  const { pomoPrefs: p, m4, focusConf } = useM4();
  const setConf = (patch: Record<string, unknown>): void => void app.repo.setExt("focusConf", { ...focusConf, ...patch });
  const num = (key: "pomoDuration" | "shortBreakDuration" | "longBreakDuration" | "longBreakInterval" | "pomoGoal", testId: string, min = 1) => (
    <input
      key={`${key}-${p[key]}`}
      className="field num"
      type="number"
      min={min}
      defaultValue={p[key]}
      data-testid={testId}
      onBlur={(e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        const next = key === "pomoDuration" ? clampPomo(v) : Math.max(min, Math.round(v));
        e.target.value = String(next);
        if (next !== p[key]) void m4.setPomoPrefs({ [key]: next });
      }}
    />
  );
  return (
    <>
      <div className="set-group">Pomodoro</div>
      <Row label="Pomo Duration" hint="minutes, at least 5">{num("pomoDuration", "set-pomo-duration", 5)}</Row>
      <Row label="Short Break" hint="minutes">{num("shortBreakDuration", "set-short-break")}</Row>
      <Row label="Long Break" hint="minutes">{num("longBreakDuration", "set-long-break")}</Row>
      <Row label="Long Break Interval" hint="pomos before a long break">{num("longBreakInterval", "set-long-interval")}</Row>
      <Row label="Auto-start next Pomo"><Switch testId="set-auto-pomo" checked={p.autoPomo} onChange={(v) => void m4.setPomoPrefs({ autoPomo: v })} /></Row>
      <Row label="Auto-start Break"><Switch testId="set-auto-break" checked={p.autoBreak} onChange={(v) => void m4.setPomoPrefs({ autoBreak: v })} /></Row>
      <div className="set-group">Daily Focus Goals</div>
      <Row label="Pomos per day">{num("pomoGoal", "set-pomo-goal")}</Row>
      <Row label="Focus minutes per day" hint="0 = no minutes goal">
        <input className="field num" type="number" min={0} defaultValue={p.focusDuration ?? 0} data-testid="set-focus-goal" onBlur={(e) => void m4.setPomoPrefs({ focusDuration: Number(e.target.value) > 0 ? Math.round(Number(e.target.value)) : null })} />
      </Row>
      <div className="set-group">Sound and screen</div>
      <Row label="End Sound"><Switch checked={p.soundsOn} onChange={(v) => void m4.setPomoPrefs({ soundsOn: v })} /></Row>
      <Row label="Focus Timer in Browser Tabs"><Switch testId="set-tab-time" checked={focusConf.showTabFocusTime !== false} onChange={(v) => setConf({ showTabFocusTime: v })} /></Row>
      <Row label="Auto access to Full-Screen Mode" hint="5 seconds after a session starts"><Switch testId="set-auto-full" checked={!!focusConf.autoFullScreen} onChange={(v) => setConf({ autoFullScreen: v })} /></Row>
      <Row label="Anti Burn-in" hint="moves the full-screen clock slowly"><Switch testId="set-anti-burn" checked={!!focusConf.antiBurnIn} onChange={(v) => setConf({ antiBurnIn: v })} /></Row>
      <Row label="Strict Mode" hint="Pomo only: no pause, ending gives up"><Switch checked={!!focusConf.strict} onChange={(v) => setConf({ strict: v })} /></Row>
      <div className="set-group">Devices</div>
      <Row label="Sync Across Devices" hint="share the running timer with your other devices"><Switch testId="set-focus-sync" checked={!!focusConf.keepInSync} onChange={(v) => setConf({ keepInSync: v })} /></Row>
      <Row label="Show focus records in lists and calendar"><Switch testId="set-show-pomodoro" checked={!!app.settings.showPomodoro} onChange={(v) => void app.repo.setSettings({ showPomodoro: v })} /></Row>
    </>
  );
}

/** Habit settings (SET-226..228, SET-102, HAB-004, HAB-005, SET-064). */
function HabitTab(): JSX.Element {
  const app = useApp();
  const { habitPrefs: p, m4, sections } = useM4();
  const [manage, setManage] = useState(false);
  return (
    <>
      <Row label="Sort by Check-in Status"><Switch testId="set-habit-sort" checked={p.sortType === "status"} onChange={(v) => void m4.setHabitPrefs({ sortType: v ? "status" : "" })} /></Row>
      <Row label="Show in Today and Next 7 Days"><Switch testId="set-habit-today" checked={p.showInToday} onChange={(v) => void m4.setHabitPrefs({ showInToday: v })} /></Row>
      <Row label="Show in Calendar"><Switch testId="set-habit-calendar" checked={p.showInCalendar} onChange={(v) => void m4.setHabitPrefs({ showInCalendar: v })} /></Row>
      <Row label="Streak display" hint="what the habit list shows under each name">
        <Select testId="set-habit-display" value={(app.settings as { habitDisplayType?: boolean }).habitDisplayType ? "total" : "streak"} onChange={(v) => void app.repo.setSettings({ habitDisplayType: v === "total" } as never)} options={[{ value: "streak", label: "Current streak" }, { value: "total", label: "Total days" }]} />
      </Row>
      <Row label="Habit Constant Reminder" hint="Habit reminders repeat every minute until closed">
        <Switch
          testId="set-habit-constant"
          checked={((app.ext.reminder ?? {}) as { annoyingAlertEnabled?: boolean; annoyingRemindItems?: string[] }).annoyingAlertEnabled === true && (((app.ext.reminder ?? {}) as { annoyingRemindItems?: string[] }).annoyingRemindItems ?? ["task", "habit", "countdown"]).includes("habit")}
          onChange={(v) => {
            const rem = (app.ext.reminder ?? {}) as { annoyingAlertEnabled?: boolean; annoyingRemindItems?: string[] };
            const on = rem.annoyingAlertEnabled === true;
            const items = on ? (rem.annoyingRemindItems ?? ["task", "habit", "countdown"]) : [];
            const next = v ? [...new Set([...items, "habit"])] : items.filter((x) => x !== "habit");
            void app.repo.setExt("reminder", { ...rem, annoyingAlertEnabled: next.length > 0, annoyingRemindItems: next });
          }}
        />
      </Row>
      <Row label="Manage Section" hint={sections.length ? [...sections].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((s) => sectionLabel(s.name)).join(", ") : "No sections"}>
        <button className="btn sm" data-testid="set-manage-sections" onClick={() => setManage(true)}>Manage</button>
      </Row>
      {manage && <SectionsDialog onClose={() => setManage(false)} />}
    </>
  );
}

function NotificationsTab(): JSX.Element {
  return <NotificationSettings Row={Row} />;
}

function DateTab(): JSX.Element {
  const app = useApp();
  const { settings, repo, local, setLocal } = app;
  return (
    <>
      <Card>
        <Row label="Time Format">
          <Drop testId="set-time-format" value={settings.showMeridiem ? "12" : "24"} onChange={(v) => void repo.setSettings({ showMeridiem: v === "12" })} options={[{ value: "12", label: "12 Hour (1:00 PM)" }, { value: "24", label: "24 Hour (13:00)" }]} />
        </Row>
        <Row label="Date Format">
          <Drop testId="set-date-format" value={local.dateFormat} onChange={(v) => setLocal("dateFormat", v)} options={[{ value: "MM/DD/YYYY", label: "12/31/2026" }, { value: "DD/MM/YYYY", label: "31/12/2026" }, { value: "YYYY/MM/DD", label: "2026/12/31" }]} />
        </Row>
        <Row label="Start Week on">
          <Drop testId="set-week-start" value={settings.startDayOfWeek ?? "SUN"} onChange={(v) => void repo.setSettings({ startDayOfWeek: v })} options={[{ value: "SUN", label: "Sunday" }, { value: "MON", label: "Monday" }, { value: "SAT", label: "Saturday" }]} />
        </Row>
      </Card>
      <Card>
        <Row label="Additional Calendar">
          <Drop
            testId="set-alt-calendar"
            value={((app.ext.alternativeCalendar ?? {}) as { calendar?: string }).calendar ?? ""}
            onChange={(v) => {
              void repo.setExt("alternativeCalendar", { calendar: v });
              void repo.setSettings({ lunarEnabled: v === "lunar" });
            }}
            options={ALT_CALENDARS}
          />
        </Row>
        <Row label="Show Week Numbers (W)">
          <Switch testId="set-week-numbers" checked={!!settings.weekNumbersEnabled} onChange={(v) => void repo.setSettings({ weekNumbersEnabled: v })} />
        </Row>
      </Card>
      <Card>
        <Row label="Time Zone" hint="When on, you can pick a time zone for each task in the time picker.">
          <Switch testId="set-time-zone" checked={settings.isTimeZoneOptionEnabled !== false} onChange={(v) => void repo.setSettings({ isTimeZoneOptionEnabled: v })} />
        </Row>
      </Card>
      <Card>
        <Row label="Default task duration">
          <Drop value={settings.defaultTimeDuration ?? 60} onChange={(v) => void repo.setSettings({ defaultTimeDuration: v })} options={[15, 30, 45, 60, 90, 120, 180].map((m) => ({ value: m, label: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}` }))} />
        </Row>
        <HolidaysRow />
      </Card>
    </>
  );
}

/** RPT-061: the holiday store behind Skip holidays (repeats) and the daily summary. No regional list is bundled. */
function HolidaysRow(): JSX.Element {
  const { engine, toast } = useApp();
  const [h, setH] = useState<{ restDays: string[]; workDays: string[] } | null>(null);
  const [day, setDay] = useState("");
  const [kind, setKind] = useState<"restDays" | "workDays">("restDays");
  useEffect(() => {
    engine.api.get<{ restDays?: string[]; workDays?: string[] }>("/api/v2/holidays").then(
      (x) => setH({ restDays: x?.restDays ?? [], workDays: x?.workDays ?? [] }),
      () => setH({ restDays: [], workDays: [] }),
    );
  }, [engine]);
  const save = (next: { restDays: string[]; workDays: string[] }): void => {
    setH(next);
    void engine.api.put("/api/v2/holidays", next).catch(() => toast("Could not save while offline"));
  };
  const chips = (k: "restDays" | "workDays") =>
    (h?.[k] ?? []).map((d) => (
      <span key={k + d} className={`time-chip${k === "workDays" ? " work" : ""}`}>
        {d}
        <button className="pill-x" aria-label={`Remove ${d}`} onClick={() => h && save({ ...h, [k]: h[k].filter((x) => x !== d) })}><X size={10} /></button>
      </span>
    ));
  return (
    <>
      <Row label="Holidays" hint="Public holidays and make-up workdays, used by Skip holidays in repeats and the daily summary">
        <div className="row gap" data-testid="holidays-add">
          <input className="field" type="date" aria-label="Holiday date" value={day} onChange={(e) => setDay(e.target.value)} />
          <select className="field" aria-label="Day type" value={kind} onChange={(e) => setKind(e.target.value as never)}>
            <option value="restDays">Holiday</option>
            <option value="workDays">Workday</option>
          </select>
          <button className="btn sm" disabled={!day || !h} onClick={() => h && day && save({ ...h, [kind]: [...new Set([...h[kind], day])].sort() })}>Add</button>
        </div>
      </Row>
      {h && (h.restDays.length > 0 || h.workDays.length > 0) && (
        <div className="set-sub" data-testid="holidays-list">
          <div className="chip-wrap start">{chips("restDays")}{chips("workDays")}</div>
        </div>
      )}
    </>
  );
}

function MoreTab(): JSX.Element {
  const { settings, repo, tags, projects, inboxId, local, setLocal } = useApp();
  const [tplOpen, setTplOpen] = useState(true);
  const timed = [...TIMED_REMINDERS, { trigger: "TRIGGER;RELATED=END:PT0S", label: "At end time" }].map((r) => ({ value: r.trigger, label: r.label }));
  const allDay = ALLDAY_REMINDERS.map((r) => ({ value: r.trigger, label: r.label }));
  const resetDefaults = (): void => {
    const d = defaultPreferences();
    void repo.setSettings({ defaultDueDate: d.defaultDueDate, defaultReminds: d.defaultReminds, defaultADReminders: d.defaultADReminders, defaultPriority: d.defaultPriority, defaultTags: d.defaultTags, defaultToAdd: d.defaultToAdd, posOfOverdue: d.posOfOverdue, defaultTimeMode: d.defaultTimeMode, defaultTimeDuration: d.defaultTimeDuration, defaultProjectId: inboxId } as never);
  };
  return (
    <>
      <Card>
        <Row label="Language">
          <Drop testId="set-language" value={settings.locale ?? "en_US"} onChange={(v) => void repo.setSettings({ locale: v })} options={[{ value: "en_US", label: "English" }]} />
        </Row>
      </Card>

      <SetSection title="Smart Recognition" />
      <Card>
        <Row label="Date Recognition" hint="Reads dates and times in a new task's title and sets the date and reminder for you.">
          <Switch testId="nlp-switch" checked={settings.nlpEnabled !== false} onChange={(v) => void repo.setSettings({ nlpEnabled: v, nlpenabled: v })} />
        </Row>
        <div className="st-checks">
          <CheckLine testId="remove-date-text" label="Remove text in tasks" checked={settings.removeDate !== false} onChange={(v) => void repo.setSettings({ removeDate: v, dateKeptInText: !v })} />
        </div>
        <Row label="Tag Recognition" hint="Turns #words in a new task's title into tags; choose whether they stay in the title.">
          <Switch testId="tag-switch" checked={settings.tagging !== false} onChange={(v) => void repo.setSettings({ tagging: v } as never)} />
        </Row>
        <div className="st-checks">
          <CheckLine testId="remove-tag-text" label="Remove tags from task name" checked={settings.removeTag !== false} onChange={(v) => void repo.setSettings({ removeTag: v })} />
        </div>
        <Row label="URL Parsing" hint="A task whose title is a link gets the page title as its name.">
          <Switch testId="url-switch" checked={local.urlParseEnabled} onChange={(v) => setLocal("urlParseEnabled", v)} />
        </Row>
      </Card>

      <SetSection title="Task Default" help="Applied to every new task unless you set something else while adding it." />
      <Card>
        <Row label="Default Date">
          <Drop testId="default-date" value={settings.defaultDueDate ?? 0} onChange={(v) => void repo.setSettings({ defaultDueDate: v })} options={[{ value: 0, label: "None" }, { value: 1, label: "Today" }, { value: 2, label: "Tomorrow" }, { value: 3, label: "Day after Tomorrow" }, { value: 4, label: "Next Week" }]} />
        </Row>
        <Row label="Default Reminders (Due time task)">
          <MultiDrop testId="default-reminds" labelOf={(v) => reminderLabel(v, false)} value={settings.defaultReminds ?? []} onChange={(v) => void repo.setSettings({ defaultReminds: v })} options={timed} />
        </Row>
        <Row label="Default Reminders (All day task)">
          <MultiDrop testId="default-ad-reminds" labelOf={(v) => reminderLabel(v, true)} value={settings.defaultADReminders ?? []} onChange={(v) => void repo.setSettings({ defaultADReminders: v })} options={allDay} />
        </Row>
      </Card>
      <Card>
        <Row label="Default Priority">
          <Drop testId="default-priority" value={settings.defaultPriority ?? 0} onChange={(v) => void repo.setSettings({ defaultPriority: v })} options={[...PRIORITIES].reverse().map((p) => ({ value: p.value, label: p.label }))} />
        </Row>
        <Row label="Default Tag">
          <MultiDrop testId="default-tags" search value={settings.defaultTags ?? []} onChange={(v) => void repo.setSettings({ defaultTags: v })} options={tags.map((t) => ({ value: t.name, label: t.label ?? t.name }))} />
        </Row>
        <Row label="Default List">
          <SearchDrop testId="default-list" value={(settings.defaultProjectId as string) || inboxId} onChange={(v) => void repo.setSettings({ defaultProjectId: v } as never)} options={[{ value: inboxId, label: "Inbox" }, ...projects.filter((p) => !p.closed && p.kind !== "NOTE").map((p) => ({ value: p.id, label: p.name }))]} />
        </Row>
      </Card>
      <Card>
        <Row label="Default Add to">
          <Drop testId="default-add-to" value={settings.defaultToAdd ?? 0} onChange={(v) => void repo.setSettings({ defaultToAdd: v })} options={[{ value: 0, label: "Top of List" }, { value: 1, label: "Bottom of List" }]} />
        </Row>
        <Row label="Overdue Section shows at">
          <Drop testId="overdue-at" value={settings.posOfOverdue ?? 0} onChange={(v) => void repo.setSettings({ posOfOverdue: v })} options={[{ value: 0, label: "Top of List" }, { value: 1, label: "Bottom of List" }]} />
        </Row>
      </Card>
      <div className="st-after-card">
        <LinkBtn testId="task-defaults-reset" onClick={resetDefaults}>Reset Default</LinkBtn>
      </div>

      <SetSection title="Mini Calendar" help="A small month calendar at the bottom of the sidebar; click a day to open it in the calendar." />
      <Card>
        <Row label="Show Mini Calendar in Sidebar">
          <Switch testId="set-mini-calendar" checked={local.showMiniCalendar} onChange={(v) => setLocal("showMiniCalendar", v)} />
        </Row>
      </Card>

      <div className="st-section st-collapse">
        <button className="st-collapse-head" aria-expanded={tplOpen} onClick={() => setTplOpen(!tplOpen)} data-testid="templates-toggle">
          Task Template <ChevronDown size={14} className={tplOpen ? "" : "closed"} />
        </button>
      </div>
      {tplOpen && (
        <div className="st-templates">
          <TemplateManager />
        </div>
      )}
    </>
  );
}

function ShortcutsTab(): JSX.Element {
  const { local, setLocal } = useApp();
  const [recording, setRecording] = useState<string | null>(null);
  useEffect(() => {
    if (!recording) return;
    const on = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      const mods = [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey && e.key.length !== 1 ? "Shift" : ""].filter(Boolean);
      const combo = [...mods, e.key.length === 1 ? e.key.toUpperCase() : e.key].join("+");
      setLocal("customShortcuts", { ...local.customShortcuts, [recording]: combo });
      setRecording(null);
    };
    window.addEventListener("keydown", on, true);
    return () => window.removeEventListener("keydown", on, true);
  }, [recording, local.customShortcuts, setLocal]);
  return (
    <div className="st-shortcuts">
      {SHORTCUT_GROUPS.map((g) => (
        <div key={g.title} className="shortcut-group">
          <SetSection title={g.title}>{SHORTCUT_NOTES[g.title]}</SetSection>
          <Card>
            {g.items.map((it) => {
              const keys = local.customShortcuts[it.id] ?? it.keys;
              return (
                <div key={it.id} className={`shortcut-row${it.locked ? " locked" : ""}`}>
                  <span>{it.label}</span>
                  <button className={`kbd-btn${keys ? "" : " unset"}`} disabled={it.locked} title={it.locked ? "Fixed shortcut" : "Click, then press the new keys"} onClick={() => setRecording(it.id)}>
                    {recording === it.id ? "Press keys..." : keys ? keyLabel(keys) : "Set shortcut"}
                  </button>
                </div>
              );
            })}
          </Card>
        </div>
      ))}
      <div className="st-footer">
        <button className="btn" data-testid="shortcuts-reset" onClick={() => setLocal("customShortcuts", {})}>Reset Default</button>
      </div>
    </div>
  );
}

const SHORTCUT_NOTES: Record<string, string> = {
  "Quick Add": "Type these in the task field while adding a task to set its details.",
  "Edit Tasks": "These work while a task is selected.",
  Navigation: "Jump to views, lists and settings.",
};

export function SettingsModal({ tab }: { tab: string }): JSX.Element {
  const { route, me } = useApp();
  const multi = !!me && !me.single;
  const tabs = TABS.filter((t) => (t.key === "members" ? multi && me?.role === "admin" : t.key === "collaborate" ? multi : true));
  const active = tabs.some((t) => t.key === tab) ? tab : "profile";
  const activeTab = TABS.find((t) => t.key === active);
  const close = (): void => go(route.path);
  const setTab = (k: string): void => go(route.path, { modalType: "settings", tabs: k });
  return (
    <Modal onClose={close} className="settings-modal" testId="settings-modal" wide>
      <div className="settings">
        <nav className="settings-nav">
          <h2 className="settings-title">Settings</h2>
          {tabs.map((t) => (
            <button key={t.key} className={`settings-tab${t.key === active ? " on" : ""}${t.group ? " gstart" : ""}`} data-testid={`settings-tab-${t.key}`} onClick={() => setTab(t.key)}>
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <div className="settings-head">
            <button className="icon-btn" aria-label="Close settings" onClick={close}>
              <X size={18} />
            </button>
          </div>
          <div className={`settings-scroll${activeTab?.title ? " has-title" : ""}`} key={active}>
            {activeTab?.title && <SetTitle>{activeTab.label}</SetTitle>}
            {active === "profile" && <AccountTab />}
            {active === "feature" && <FeaturesTab />}
            {active === "smart" && <SmartTab />}
            {active === "notifications" && <NotificationsTab />}
            {active === "focus" && <FocusTab />}
            {active === "habit" && <HabitTab />}
            {active === "date" && <DateTab />}
            {active === "calendar" && <CalendarTab Row={Row} />}
            {active === "appearance" && <AppearanceTab />}
            {active === "more" && <MoreTab />}
            {active === "integrations" && <IntegrationsTab Row={Row} />}
            {active === "collaborate" && <CollaborateTab Row={Row} />}
            {active === "members" && <MembersTab Row={Row} />}
            {active === "shortcuts" && <ShortcutsTab />}
            {active === "about" && <AboutTab onTab={setTab} />}
          </div>
        </div>
      </div>
    </Modal>
  );
}
