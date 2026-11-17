import { SyncHealth } from "./SyncHealth";
import { KeyRound, Menu as MenuIcon, QrCode } from "lucide-react";
import { startNativeOidc, watchNativeOidc } from "../lib/nativeAuth";
import { HttpError } from "../data/api";
import { AUTH_ERROR_TEXT, type AuthConfig } from "../data/accounts";
import { useEffect, useRef, useState } from "react";
import { addDays, startOfDay } from "../lib/dates";
import { allowedModes, calendarPath, DEFAULT_PATH, go, matrixPath, modeOf, routeTaskPath, viewPath } from "../model/router";
import {
  consumeNativeActions,
  formatSharedText,
  getStoredServerUrl,
  hasConfirmedServerUrl,
  isCapacitor,
  onNativeAction,
  registerBackButton,
  saveServerUrl,
  scanQrCode,
  syncNativeStatusBar,
  syncNativeWidgetTasks,
  type NativeAction,
} from "../lib/capacitor";
import { extractPairingToken, parsePairingQr } from "../lib/pairing";
import { GoogleMark, PairingPanel, SetupCard, type PairingState } from "./Setup";
import { MobileQuickAdd } from "./MobileQuickAdd";
import { useApp } from "./ctx";
import { Detail, DetailEmpty } from "./Detail";
import { BatchAddDialog, ConfirmDialog, DuplicateListDialog, FolderDialog, LinkParentDialog, ListDialog, PrintDialog, ShortcutsDialog, TagDialog, ViewOptionsDialog } from "./Dialogs";
import { ShareDialog } from "./Members";
import { DndShell, dragModel } from "./dnd";
import { ListView, viewKey } from "./ListView";
import { AddSectionDialog, KanbanView } from "./Kanban";
import { switchMode } from "./ViewSwitch";
import { TimelineView } from "./Timeline";
import { CalendarScreen, GotoDateDialog } from "./Calendar";
import { SubCalScreen } from "./CalEvent";
import { MatrixRulesDialog, MatrixScreen, MatrixViewsDialog } from "./Matrix";
import { CommandMenu, SearchModal, Toasts } from "./Overlays";
import { QuickAddStyleDialog } from "./QuickAdd";
import { ClosedScreen, PlaceholderScreen, TrashScreen } from "./Screens";
import { SettingsModal } from "./Settings";
import { HabitLogHost, HabitScreen } from "./Habits";
import { FocusGlobal } from "./Focus";
import { recordOpenDay } from "../model/stats";
import { FocusScreen } from "./Focus";
import { CountdownScreen } from "./Countdown";
import { StatisticsScreen } from "./Statistics";
import { SummaryScreen } from "./Summary";
import { Rail, Sidebar } from "./Sidebar";
import { NotifyRoute, ReminderPopups } from "./Notify";
import { FilterEditor } from "./Filters";
import { ActivityDialog } from "./Activity";
import { TemplateGallery } from "./Templates";
import { ImportBackupDialog } from "./Backup";
import { AttachmentPreview } from "./Attach";
import { ALL_SHORTCUTS, alternatives, eventCombo } from "./shortcuts";
import { applyTheme, effectiveTheme } from "./theme";
import { moveToDay } from "./taskutil";

function usePrefersDark(): boolean {
  const [v, setV] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!m) return;
    const on = (): void => setV(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return v;
}

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
}

/** Global keyboard shortcuts (KEYS rows): single keys never fire while typing (KEYS-062). */
function useShortcuts(): void {
  const app = useApp();
  const ref = useRef(app);
  ref.current = app;
  useEffect(() => {
    let tabHeld = false;
    let tabUsed = false;
    let prefix: { key: string; at: number } | null = null;
    const binding = (id: string): string[] => {
      const def = ALL_SHORTCUTS.find((s) => s.id === id);
      return alternatives(ref.current.local.customShortcuts[id] ?? def?.keys ?? "");
    };
    const focusedTask = () => {
      const a = ref.current;
      const id = a.focusedId ?? a.route.taskId ?? null;
      return id ? a.tasks.find((t) => t.id === id) : undefined;
    };
    const run = async (id: string): Promise<boolean> => {
      const a = ref.current;
      if (id.startsWith("cal_")) {
        // calendar keys only act while the calendar is open (KEYS-046..052)
        if (a.route.screen !== "calendar") return false;
        window.dispatchEvent(new CustomEvent("noor-cal", { detail: id }));
        return true;
      }
      const t = focusedTask();
      const today = startOfDay(a.now);
      switch (id) {
        case "sync":
          void a.engine.sync();
          return true;
        case "undo": {
          const label = await a.repo.undo();
          a.toast(label ? `Undone: ${label}` : "Nothing to undo");
          return true;
        }
        case "redo":
          a.toast("Nothing to redo");
          return true;
        case "print":
          a.setModal({ kind: "print", taskIds: t && a.route.taskId ? [t.id] : dragModel.ids, title: "Tasks" });
          return true;
        case "command":
          a.setModal({ kind: "command" });
          return true;
        case "shortcuts":
          a.setModal({ kind: "shortcuts" });
          return true;
        case "add_task":
          (document.querySelector("[data-testid=quick-add-input]") as HTMLInputElement | null)?.focus();
          return true;
        case "expand_all": {
          const parents = a.tasks.filter((x) => dragModel.ids.includes(x.id) && a.tasks.some((k) => k.parentId === x.id));
          const anyOpen = parents.some((p) => !a.local.collapsedTasks[p.id]);
          const next = { ...a.local.collapsedTasks };
          for (const p of parents) next[p.id] = anyOpen;
          a.setLocal("collapsedTasks", next);
          return true;
        }
        case "toggle_groups":
          return false;
        case "view_list":
        case "view_kanban":
        case "view_timeline": {
          if (a.route.screen) return false;
          const m = id === "view_list" ? "tasks" : id === "view_kanban" ? "kanban" : "timeline";
          if (!allowedModes(a.route.view).includes(m)) {
            a.toast(m === "timeline" ? "Timeline is not available here" : "Not available here");
            return true;
          }
          await switchMode(a, a.route.view, m);
          return true;
        }
        case "nav_split":
          a.setLocal("isTaskCalendarMode", !(a.route.screen === "calendar" && a.local.isTaskCalendarMode));
          if (a.route.screen !== "calendar") go(calendarPath((a.settings.webCalendarViewType as "m") || "m"));
          return true;
        case "nav_calendar":
          go(calendarPath((a.settings.webCalendarViewType as "m") || "m"));
          return true;
        case "nav_search":
          a.setModal({ kind: "search" });
          return true;
        case "nav_settings":
          go(a.route.path, { modalType: "settings", tabs: "profile" });
          return true;
        case "nav_all":
          go("q/all/tasks");
          return true;
        case "nav_today":
          go("q/today/tasks");
          return true;
        case "nav_tomorrow":
          go("q/tomorrow/tasks");
          return true;
        case "nav_week":
          go("q/week/tasks");
          return true;
        case "nav_assigned":
          go("q/all/assignedme");
          return true;
        case "nav_inbox":
          go(`p/${a.inboxId}/tasks`);
          return true;
        case "nav_completed":
          go("q/all/completed");
          return true;
        case "nav_wontdo":
          go("q/all/abandoned");
          return true;
        case "nav_summary":
          go("q/all/summary");
          return true;
        case "nav_trash":
          go("q/all/trash");
          return true;
      }
      if (!t) return false;
      const ids = a.selected.size ? [...a.selected] : [t.id];
      switch (id) {
        case "complete":
          for (const x of ids) await a.repo.toggleComplete(x);
          a.toast("Task completed", () => void a.repo.undo());
          return true;
        case "pin":
          await a.repo.updateTask(t.id, { pinnedTime: t.pinnedTime ? undefined : new Date().toISOString().replace("Z", "+0000") }, { undo: "Pin changed" });
          return true;
        case "delete":
          await a.repo.trashIds(ids);
          a.toast("Task deleted", () => void a.repo.undo());
          return true;
        case "set_date":
          if (a.route.taskId !== t.id) location.hash = routeTaskPath(a.route, t.id);
          setTimeout(() => (document.querySelector("[data-testid=detail-date]") as HTMLElement | null)?.click(), 60);
          return true;
        case "clear_time":
          await a.repo.updateEach(ids, () => ({ startDate: undefined, dueDate: undefined, isAllDay: undefined, reminders: [] }), "Date cleared");
          return true;
        case "date_today":
          await a.repo.updateEach(ids, (x) => moveToDay(x, today), "Date changed");
          return true;
        case "date_tomorrow":
          await a.repo.updateEach(ids, (x) => moveToDay(x, addDays(today, 1)), "Date changed");
          return true;
        case "date_next_week":
          await a.repo.updateEach(ids, (x) => moveToDay(x, addDays(today, 7)), "Date changed");
          return true;
      }
      return false;
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      const a = ref.current;
      if (e.key === "Tab" && !isTyping(e.target)) {
        tabHeld = true;
        tabUsed = false;
        e.preventDefault();
        return;
      }
      // zoom: Ctrl +, -, 0
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0") && !e.shiftKey) {
        e.preventDefault();
        const z = e.key === "0" ? 1 : Math.max(0.7, Math.min(1.6, a.local.zoom + (e.key === "-" ? -0.1 : 0.1)));
        a.setLocal("zoom", Math.round(z * 10) / 10);
        return;
      }
      const combo = eventCombo(e, tabHeld);
      if ((e.ctrlKey || e.metaKey) && combo === "Ctrl+K") {
        e.preventDefault();
        a.setModal(a.modal?.kind === "command" ? null : { kind: "command" });
        return;
      }
      if (isTyping(e.target)) return;
      if (a.modal || document.querySelector(".popover") || a.route.query.get("modalType")) return;
      if (tabHeld) tabUsed = true;

      // priority Alt+0..3
      if (e.altKey && !e.ctrlKey && /^[0-3]$/.test(e.key)) {
        const t = focusedTask();
        if (t) {
          e.preventDefault();
          void a.repo.updateEach(a.selected.size ? [...a.selected] : [t.id], () => ({ priority: [0, 1, 3, 5][Number(e.key)] }), "Priority changed");
        }
        return;
      }
      // two-key sequences (G then X, V then X)
      if (prefix && Date.now() - prefix.at < 1500 && !e.ctrlKey && !e.altKey) {
        const seq = `${prefix.key} ${e.key.toUpperCase()}`;
        prefix = null;
        const hit = ALL_SHORTCUTS.find((s) => binding(s.id).includes(seq));
        if (hit) {
          e.preventDefault();
          void run(hit.id);
        }
        return;
      }
      const onCal = a.route.screen === "calendar";
      if (onCal && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        void run(e.key === "ArrowLeft" ? "cal_prev" : "cal_next");
        return;
      }
      // calendar letters win on the calendar, and never fire elsewhere
      const hit = ALL_SHORTCUTS.filter((s) => onCal || !s.id.startsWith("cal_"))
        .sort((x, y) => Number(y.id.startsWith("cal_")) - Number(x.id.startsWith("cal_")))
        .find((s) => binding(s.id).includes(combo) || (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && binding(s.id).includes(e.key)));
      if (hit) {
        e.preventDefault();
        void run(hit.id);
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "g" || e.key === "G" || e.key === "v" || e.key === "V")) {
        prefix = { key: e.key.toUpperCase(), at: Date.now() };
        return;
      }
      // focused-row keys: arrows, Enter (add below), Shift+Enter (add subtask), Delete
      const ids = dragModel.ids;
      const cur = a.focusedId ?? a.route.taskId ?? null;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!ids.length) return;
        e.preventDefault();
        const i = cur ? ids.indexOf(cur) : -1;
        const nextId = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]!;
        if (e.shiftKey) {
          const n = new Set(a.selected);
          if (cur) n.add(cur);
          n.add(nextId);
          a.setSelected(n);
        }
        a.setFocusedId(nextId);
        document.querySelector(`[data-task-id="${nextId}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }
      const t = focusedTask();
      if (e.key === "Enter" && t) {
        e.preventDefault();
        void (async () => {
          const c = e.shiftKey ? await a.repo.createTask({ title: "", projectId: t.projectId, parentId: t.id }, { position: "bottom" }) : await a.repo.createTask({ title: "", projectId: t.projectId, parentId: t.parentId ?? undefined }, { after: t });
          location.hash = routeTaskPath(a.route, c.id);
        })();
        return;
      }
      if (e.key === "Delete" && t) {
        e.preventDefault();
        void run("delete");
        return;
      }
      if (e.key === "Escape") {
        if (a.selected.size) a.setSelected(new Set());
        else if (a.route.taskId) go(routeTaskPath(a.route));
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === "Tab") {
        tabHeld = false;
        void tabUsed;
      }
    };
    const onBlur = (): void => {
      tabHeld = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}

function Modals(): JSX.Element | null {
  const { modal, setModal, route } = useApp();
  const settingsTab = route.query.get("modalType") === "settings" ? (route.query.get("tabs") ?? "profile") : null;
  return (
    <>
      {settingsTab && <SettingsModal tab={settingsTab} />}
      {modal?.kind === "search" && <SearchModal />}
      {modal?.kind === "command" && <CommandMenu />}
      {modal?.kind === "shortcuts" && <ShortcutsDialog />}
      {modal?.kind === "list" && <ListDialog projectId={modal.projectId} groupId={modal.groupId} />}
      {modal?.kind === "folder" && <FolderDialog groupId={modal.groupId} projectIds={modal.projectIds} />}
      {modal?.kind === "tag" && <TagDialog name={modal.name} parent={modal.parent} />}
      {modal?.kind === "confirm" && <ConfirmDialog m={modal} />}
      {modal?.kind === "duplicateList" && <DuplicateListDialog projectId={modal.projectId} />}
      {modal?.kind === "batchAdd" && <BatchAddDialog m={modal} />}
      {modal?.kind === "quickAddStyle" && <QuickAddStyleDialog onClose={() => setModal(null)} />}
      {modal?.kind === "viewOptions" && <ViewOptionsDialog />}
      {modal?.kind === "linkParent" && <LinkParentDialog taskIds={modal.taskIds} />}
      {modal?.kind === "print" && <PrintDialog taskIds={modal.taskIds} title={modal.title} />}
      {modal?.kind === "addSection" && <AddSectionDialog projectId={modal.projectId} />}
      {modal?.kind === "gotoDate" && <GotoDateDialog />}
      {modal?.kind === "matrixRules" && <MatrixRulesDialog profileId={modal.profileId} quadrant={modal.quadrant} />}
      {modal?.kind === "matrixViews" && <MatrixViewsDialog />}
      {modal?.kind === "filter" && <FilterEditor filterId={modal.filterId} rule={modal.rule} name={modal.name} />}
      {modal?.kind === "activity" && <ActivityDialog taskId={modal.taskId} projectId={modal.projectId} title={modal.title} />}
      {modal?.kind === "templates" && <TemplateGallery />}
      {modal?.kind === "importBackup" && <ImportBackupDialog initialSource={modal.source ?? "backupCsv"} />}
      {modal?.kind === "share" && <ShareDialog projectId={modal.projectId} />}
      {modal?.kind === "preview" && <AttachmentPreview m={modal} />}
      <HabitLogHost />
    </>
  );
}

function SignIn({
  onServerSaved,
  onSetupComplete,
  pairError,
}: {
  onServerSaved?: () => void;
  onSetupComplete?: (pairing: PairingState) => void;
  pairError?: string;
} = {}): JSX.Element {
  const { engine } = useApp();
  const capMode = isCapacitor();
  const [confirmed, setConfirmed] = useState(hasConfirmedServerUrl);
  const [editingServer, setEditingServer] = useState(false);
  const [serverUrl, setServerUrl] = useState(getStoredServerUrl);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanErr, setScanErr] = useState("");
  const [localPairErr, setLocalPairErr] = useState("");

  if (capMode && (!confirmed || editingServer)) {
    return (
      <div className="signin">
        <form
          className="signin-card"
          data-testid="android-server-card"
          onSubmit={(e) => {
            e.preventDefault();
            setScanErr("");
            setLocalPairErr("");
            const saved = saveServerUrl(serverUrl);
            if (!saved) return;
            setServerUrl(saved);
            engine.api.setBase(saved);
            setConfirmed(true);
            setEditingServer(false);
            onServerSaved?.();
            void engine.sync();
          }}
        >
          <img src="/icon.svg" width={48} height={48} alt="" />
          <h2>NoorTasks</h2>
          <button
            type="button"
            className="btn primary full"
            data-testid="scan-qr-button"
            disabled={scanBusy}
            onClick={async () => {
              setScanErr("");
              setLocalPairErr("");
              setScanBusy(true);
              try {
                const raw = await scanQrCode();
                if (!raw) return;
                const parsed = parsePairingQr(raw);
                if (!parsed) {
                  setScanErr("That QR code is not a NoorTasks server or pairing code.");
                  return;
                }
                const saved = saveServerUrl(parsed.url);
                if (!saved) {
                  setScanErr("Invalid server URL in QR code.");
                  return;
                }
                setServerUrl(saved);
                engine.api.setBase(saved);
                setConfirmed(true);
                setEditingServer(false);
                onServerSaved?.();
                if (parsed.token) {
                  try {
                    await engine.api.post("/api/auth/pair", { token: parsed.token });
                  } catch {
                    setLocalPairErr(AUTH_ERROR_TEXT.invalid_pairing_token!);
                  }
                }
                void engine.sync();
              } catch {
                setScanErr("Could not scan QR code. Check camera permission or type the URL below.");
              } finally {
                setScanBusy(false);
              }
            }}
          >
            <QrCode size={16} />
            <span>{scanBusy ? "Opening camera..." : "Scan QR code"}</span>
          </button>
          <div className="signin-or">or</div>
          <input
            className="field full"
            type="url"
            required
            placeholder="https://tasks.example.com"
            aria-label="Server address"
            data-testid="server-url-input"
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
          />
          <div className="signin-server">Server address (HTTPS, Tailscale, or LAN)</div>
          <button className="btn full" type="submit" data-testid="server-url-continue">Continue</button>
          {scanErr && <div className="error" role="alert" data-testid="scan-qr-error">{scanErr}</div>}
          {confirmed && (
            <button type="button" className="link-btn" onClick={() => setEditingServer(false)}>
              Cancel
            </button>
          )}
        </form>
      </div>
    );
  }

  return (
    <SignInCard
      capMode={capMode}
      serverUrl={serverUrl}
      onEditServer={() => {
        setLocalPairErr("");
        setEditingServer(true);
      }}
      onSetupComplete={onSetupComplete}
      externalErr={localPairErr || pairError || ""}
    />
  );
}

/** The sign-in card: "Sign in with <provider>" when the server has OIDC, an email and password form when enabled. */
function SignInCard({
  capMode,
  serverUrl,
  onEditServer,
  onSetupComplete,
  externalErr,
}: {
  capMode: boolean;
  serverUrl: string;
  onEditServer: () => void;
  onSetupComplete?: ((pairing: PairingState) => void) | undefined;
  externalErr: string;
}): JSX.Element {
  const { engine, sync } = useApp();
  const [cfg, setCfg] = useState<AuthConfig | null | "legacy">(null);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [mode, setMode] = useState<"signin" | "join" | "pair">("signin");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(() => {
    const m = /[?&]auth_error=([a-z_]+)/.exec(location.search);
    return m ? (AUTH_ERROR_TEXT[m[1]!] ?? "Sign-in failed. Try again.") : "";
  });
  useEffect(() => {
    if (externalErr) setErr(externalErr);
  }, [externalErr]);
  useEffect(() => {
    if (/[?&]auth_error=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
    engine.api.get<AuthConfig>("/api/auth/config").then((next) => {
      setCfg(next);
      if (!next.setupRequired && location.pathname === "/setup") {
        history.replaceState(null, "", "/" + location.hash);
      }
    }, () => setCfg("legacy"));
  }, [engine]);
  useEffect(() => {
    if (!capMode) return;
    return watchNativeOidc(engine.api, () => { setErr(""); void engine.sync(); },
      (code) => setErr(AUTH_ERROR_TEXT[code] ?? "Sign-in failed. Try again."));
  }, [capMode, engine]);

  if (!capMode && cfg !== null && cfg !== "legacy" && cfg.setupRequired) {
    return (
      <SetupCard
        cfg={cfg}
        onComplete={(pairing) => {
          onSetupComplete?.(pairing);
          void engine.sync();
        }}
      />
    );
  }

  const multi = cfg !== null && cfg !== "legacy" && cfg.mode === "multi";
  const showPassword = cfg === "legacy" || (cfg !== null && cfg.password);
  const oidc = cfg !== null && cfg !== "legacy" ? cfg.oidc : null;
  const serverTitle = cfg !== null && cfg !== "legacy" && cfg.serverName ? cfg.serverName : "NoorTasks";
  const join = mode === "join";
  const pairing = mode === "pair";
  const done = (): void => {
    setErr("");
    void engine.sync();
  };

  return (
    <div className="signin">
      <div className="signin-card" data-testid="signin-card">
        <img src="/icon.svg" width={44} height={44} alt="" />
        <h2>{serverTitle}</h2>
        <p className="signin-sub">{join ? "Join with your invite code" : pairing ? "Enter a pairing code or link" : "Sign in to your tasks"}</p>
        {capMode && (
          <div className="signin-server">
            {serverUrl}{" "}
            <button type="button" className="link-btn" onClick={onEditServer}>
              Change
            </button>
          </div>
        )}
        {oidc && mode === "signin" && (
          <a className="btn full signin-oidc" data-testid="signin-oidc" href={capMode ? "#" : engine.api.url("/api/auth/oidc/start")}
            onClick={capMode ? (e) => {
              e.preventDefault();
              if (busy) return;
              setBusy(true);
              setErr("");
              void startNativeOidc(engine.api.base).catch((error: unknown) => {
                setErr(error instanceof Error && error.message === "https_required"
                  ? "Google sign-in needs an HTTPS server address. Change the address above."
                  : "Could not open the system browser. Try again.");
              }).finally(() => setBusy(false));
            } : undefined}>
            {oidc.label === "Google" ? <GoogleMark /> : <KeyRound size={16} />}
            <span>Sign in with {oidc.label}</span>
          </a>
        )}
        {oidc && showPassword && mode === "signin" && <div className="signin-or">or</div>}
        {pairing && (
          <form
            className="signin-form"
            onSubmit={async (e) => {
              e.preventDefault();
              const token = extractPairingToken(pairCode);
              if (!token) {
                setErr("Enter a pairing code or link.");
                return;
              }
              setBusy(true);
              setErr("");
              try {
                await engine.api.post("/api/auth/pair", { token });
                done();
              } catch (x) {
                const c = x instanceof HttpError ? String((x.body as { errorCode?: string } | undefined)?.errorCode ?? "") : "";
                setErr(
                  sync.state === "offline" && !(x instanceof HttpError)
                    ? "Cannot reach server"
                    : c === "too_many_attempts"
                      ? "Too many tries. Wait a minute."
                      : AUTH_ERROR_TEXT.invalid_pairing_token!,
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              className="field full"
              autoFocus
              placeholder="Pairing code or link"
              aria-label="Pairing code or link"
              data-testid="signin-pair-input"
              value={pairCode}
              onChange={(e) => setPairCode(e.target.value)}
            />
            <button className="btn primary full" type="submit" disabled={busy} data-testid="signin-pair-submit">
              Pair and sign in
            </button>
          </form>
        )}
        {showPassword && !pairing && (
          <form
            className="signin-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                if (join) await engine.api.post("/api/auth/password/join", { email, code, password: pw, name });
                else await engine.api.post("/api/v2/user/signon", { username: multi ? email : "noortasks", password: pw });
                done();
              } catch (x) {
                const c = x instanceof HttpError ? String((x.body as { errorCode?: string } | undefined)?.errorCode ?? "") : "";
                setErr(
                  sync.state === "offline" && !(x instanceof HttpError)
                    ? "Cannot reach server"
                    : c === "too_many_attempts"
                      ? "Too many tries. Wait a minute."
                      : c === "password_too_short"
                        ? "Use at least 8 characters."
                        : c === "invalid_invite"
                          ? "That code does not match this email."
                          : c === "max_users"
                            ? AUTH_ERROR_TEXT.max_users!
                            : multi
                              ? "Wrong email or password"
                              : "Wrong passphrase",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {multi && <input className="field full" type="email" autoComplete="username" placeholder="Email" aria-label="Email" data-testid="signin-email" value={email} onChange={(e) => setEmail(e.target.value)} />}
            {join && <input className="field full" placeholder="Invite code" aria-label="Invite code" value={code} onChange={(e) => setCode(e.target.value)} />}
            {join && <input className="field full" placeholder="Your name" aria-label="Your name" value={name} onChange={(e) => setName(e.target.value)} />}
            <input
              className="field full"
              type="password"
              autoFocus={!oidc}
              autoComplete={join ? "new-password" : "current-password"}
              placeholder={multi ? (join ? "Choose a password" : "Password") : "Passphrase"}
              aria-label={multi ? "Password" : "Passphrase"}
              data-testid="signin-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <button className={`btn full${oidc ? "" : " primary"}`} type="submit" disabled={busy}>
              {join ? "Create account" : "Sign in"}
            </button>
          </form>
        )}
        {multi && (
          <div className="signin-links">
            {showPassword && (
              <button type="button" className="link-btn signin-switch" onClick={() => (setMode((v) => (v === "join" ? "signin" : "join")), setErr(""))}>
                {join ? "Back to sign in" : "Have an invite code?"}
              </button>
            )}
            <button type="button" className="link-btn signin-switch" data-testid="signin-pair-toggle" onClick={() => (setMode((v) => (v === "pair" ? "signin" : "pair")), setErr(""))}>
              {pairing ? "Back to sign in" : "Have a pairing code?"}
            </button>
          </div>
        )}
        {err && (
          <div className="error" role="alert" data-testid="signin-error">
            {err}
          </div>
        )}
        {!err && capMode && sync.state === "offline" && <div className="error">Cannot reach server</div>}
        {capMode && sync.state === "offline" && (
          <button type="button" className="btn full" onClick={() => void engine.sync()}>
            Retry connection
          </button>
        )}
      </div>
    </div>
  );
}

function BatchBar(): JSX.Element | null {
  const app = useApp();
  const { selected, repo } = app;
  if (selected.size < 2) return null;
  const ids = [...selected];
  return (
    <div className="batch-bar" data-testid="batch-bar">
      <span className="strong">{ids.length} tasks selected</span>
      <button className="btn" onClick={() => void repo.updateEach(ids, (t) => moveToDay(t, app.now), "Date changed")}>Today</button>
      <button className="btn" onClick={() => void repo.updateEach(ids, (t) => moveToDay(t, addDays(app.now, 1)), "Date changed")}>Tomorrow</button>
      {[5, 3, 1, 0].map((p) => (
        <button key={p} className="btn" onClick={() => void repo.updateEach(ids, () => ({ priority: p }), "Priority changed")}>
          {p === 5 ? "High" : p === 3 ? "Medium" : p === 1 ? "Low" : "None"}
        </button>
      ))}
      <button className="btn" onClick={() => app.setModal({ kind: "linkParent", taskIds: ids })}>Link Parent Task</button>
      <button className="btn danger" onClick={() => void repo.trashIds(ids).then(() => (app.setSelected(new Set()), app.toast(`${ids.length} tasks deleted`, () => void repo.undo())))}>Delete</button>
      <button className="btn" onClick={() => app.setSelected(new Set())}>Cancel</button>
    </div>
  );
}

export function App(): JSX.Element {
  const app = useApp();
  const { route, local, settings, sync, ready, initialPairToken, clearInitialPairToken, initialSetupPaired, clearInitialSetupPaired } = app;
  const prefersDark = usePrefersDark();
  const [drawer, setDrawer] = useState(false);
  const [serverConfirmed, setServerConfirmed] = useState(hasConfirmedServerUrl);
  const [quickAddInitial, setQuickAddInitial] = useState<string | null>(null);
  const [setupPairing, setSetupPairing] = useState<PairingState | null>(null);
  const [pairError, setPairError] = useState("");
  const redeemedTokenRef = useRef<string | null>(null);
  const setupPairedHandledRef = useRef(false);

  useEffect(() => {
    if (!initialPairToken || redeemedTokenRef.current === initialPairToken) return;
    redeemedTokenRef.current = initialPairToken;
    clearInitialPairToken();
    void (async () => {
      try {
        await app.engine.api.post("/api/auth/pair", { token: initialPairToken });
        setPairError("");
        void app.engine.sync();
      } catch {
        setPairError(AUTH_ERROR_TEXT.invalid_pairing_token!);
      }
    })();
  }, [initialPairToken, clearInitialPairToken, app.engine]);

  useEffect(() => {
    if (!initialSetupPaired || !ready || setupPairedHandledRef.current) return;
    setupPairedHandledRef.current = true;
    clearInitialSetupPaired();
    void app.engine.api
      .post<{ serverName: string; token: string; expiresMs: number }>("/api/auth/pairing-token")
      .then((res) => setSetupPairing(res))
      .catch(() => {});
  }, [initialSetupPaired, ready, clearInitialSetupPaired, app.engine]);
  useShortcuts();
  useEffect(() => void recordOpenDay(Date.now()), []);
  useEffect(() => {
    if (!isCapacitor()) return;
    document.documentElement.dataset.capacitor = "1";
    if (hasConfirmedServerUrl()) saveServerUrl(getStoredServerUrl());
  }, []);
  const s = settings as typeof settings & { autoDarkTheme?: boolean; darkTheme?: string; darkCustomColor?: string; themeChosen?: boolean };
  useEffect(() => {
    const t = effectiveTheme(settings.theme, !!s.autoDarkTheme, s.darkTheme, prefersDark, s.themeChosen);
    applyTheme(t, { customDark: s.darkCustomColor, fontSize: local.fontSize, zoom: local.zoom, style: local.interfaceStyle });
    syncNativeStatusBar(t);
  }, [settings.theme, s.themeChosen, s.autoDarkTheme, s.darkTheme, s.darkCustomColor, prefersDark, local.fontSize, local.zoom, local.interfaceStyle]);
  useEffect(() => {
    setDrawer(false);
    if (!route.taskId) app.setFocusedId(null);
  }, [route.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const backRef = useRef({ modal: app.modal, route, drawer, quickAddInitial, setModal: app.setModal });
  backRef.current = { modal: app.modal, route, drawer, quickAddInitial, setModal: app.setModal };
  useEffect(() => {
    if (!isCapacitor()) return;
    return registerBackButton(() => {
      const cur = backRef.current;
      if (cur.quickAddInitial !== null) {
        setQuickAddInitial(null);
        return true;
      }
      if (cur.modal) {
        cur.setModal(null);
        return true;
      }
      if (cur.route.query.get("modalType")) {
        go(cur.route.path);
        return true;
      }
      if (drawer) {
        setDrawer(false);
        return true;
      }
      if (cur.route.taskId) {
        go(routeTaskPath(cur.route));
        return true;
      }
      if (cur.route.path !== DEFAULT_PATH && window.history.length > 1) {
        window.history.back();
        return true;
      }
      return false;
    });
  }, [drawer]);

  useEffect(() => {
    if (!ready || !isCapacitor()) return;
    syncNativeWidgetTasks(app.tasks, app.projects, app.inboxId, app.now, app.settings.showMeridiem !== false);
  }, [ready, app.tasks, app.projects, app.inboxId, app.now, app.settings.showMeridiem]);

  useEffect(() => {
    if (!ready || !isCapacitor()) return;
    const applyNative = async (actions: NativeAction[], completedIds: string[]): Promise<void> => {
      for (const tid of completedIds) {
        const cur = await app.db.tasks.get(tid);
        if (cur && cur.status === 0) await app.repo.toggleComplete(tid);
      }
      for (const act of actions) {
        if (act.type === "share") setQuickAddInitial(formatSharedText(act.subject, act.text));
        else if (act.type === "quickAdd") setQuickAddInitial("");
        else if (act.type === "openHash" && act.hash) location.hash = act.hash;
        else if (act.type === "notificationAction") {
          window.dispatchEvent(new CustomEvent("noor-notif-action", { detail: act }));
        } else if (act.type === "widgetCompletions") {
          const extra = await consumeNativeActions();
          for (const tid of extra.completedTaskIds) {
            const cur = await app.db.tasks.get(tid);
            if (cur && cur.status === 0) await app.repo.toggleComplete(tid);
          }
        }
      }
    };
    void consumeNativeActions().then(({ actions, completedTaskIds }) => applyNative(actions, completedTaskIds));
    return onNativeAction(() => {
      void consumeNativeActions().then(({ actions, completedTaskIds }) => applyNative(actions, completedTaskIds));
    });
  }, [ready, app.db, app.repo]);

  // a list opens in its saved layout (TIME-004): follow the saved view mode when it (or the view) changes
  const resolved = route.screen ? route.mode : modeOf(route.view);
  const vk = viewKey(route.view);
  useEffect(() => {
    if (!ready || route.screen || route.subcal || route.mode === resolved || !allowedModes(route.view).includes(resolved)) return;
    location.replace(`#${routeTaskPath({ ...route, mode: resolved }, route.taskId)}`);
  }, [resolved, vk, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  if (setupPairing) {
    return (
      <div className="signin">
        <div className="signin-card setup-card">
          <PairingPanel
            serverName={setupPairing.serverName}
            token={setupPairing.token}
            onRegenerate={async () => {
              const next = await app.engine.api.post<{ serverName: string; token: string; expiresMs: number }>("/api/auth/pairing-token");
              setSetupPairing(next);
            }}
            onDone={() => {
              if (location.pathname !== "/") history.replaceState(null, "", "/" + location.hash);
              setSetupPairing(null);
            }}
          />
        </div>
      </div>
    );
  }
  if (isCapacitor() && !serverConfirmed) return <SignIn onServerSaved={() => setServerConfirmed(true)} onSetupComplete={setSetupPairing} pairError={pairError} />;
  if (sync.state === "auth" || (isCapacitor() && !ready && sync.state === "offline")) return <SignIn onServerSaved={() => setServerConfirmed(true)} onSetupComplete={setSetupPairing} pairError={pairError} />;
  if (!ready) return <div className="boot">Loading...</div>;

  const v = route.view;
  let main: JSX.Element;
  if (route.screen === "calendar") main = <CalendarScreen />;
  else if (route.screen === "matrix") main = <MatrixScreen />;
  else if (route.screen === "habit") main = <HabitScreen />;
  else if (route.screen === "focus") main = <FocusScreen />;
  else if (route.screen === "countdown") main = <CountdownScreen />;
  else if (route.screen === "statistics") main = <StatisticsScreen />;
  else if (route.screen === "notify") main = <NotifyRoute />;
  else if (route.subcal) main = <SubCalScreen key={route.subcal} id={route.subcal} />;
  else if (v.type === "smart" && v.name === "completed") main = <ClosedScreen key="c" wontDo={false} />;
  else if (v.type === "smart" && v.name === "abandoned") main = <ClosedScreen key="w" wontDo />;
  else if (v.type === "smart" && v.name === "trash") main = <TrashScreen />;
  else if (v.type === "smart" && v.name === "summary") main = <SummaryScreen />;
  else if (v.type === "search") main = <PlaceholderScreen title="Search" text="Press / to search." />;
  else if (route.mode === "kanban") main = <KanbanView key={JSON.stringify(v)} view={v} />;
  else if (route.mode === "timeline") main = <TimelineView key={JSON.stringify(v)} view={v} />;
  else main = <ListView key={JSON.stringify(v)} view={v} />;

  const popup = local.taskDetailLayout === "popup";
  return (
    <DndShell>
      <div className={`app${local.isLeftListHide || route.screen ? " side-hidden" : ""}${route.screen ? " on-screen" : ""}${route.taskId ? " has-detail" : ""}${drawer ? " drawer-open" : ""}`} data-testid="app">
        <Rail />
        <Sidebar />
        <div className="drawer-scrim" onClick={() => setDrawer(false)} />
        <main className="main">
          <SyncHealth />
          <button className="icon-btn mobile-menu" aria-label="Open menu" data-testid="mobile-menu" onClick={() => setDrawer(true)}>
            <MenuIcon size={18} />
          </button>
          {main}
          <BatchBar />
        </main>
        {!popup && (route.taskId ? <Detail key={route.taskId} taskId={route.taskId} /> : !route.screen && !route.subcal && route.mode === "tasks" && !(v.type === "smart" && v.name === "summary") && <DetailEmpty />)}
        {popup && route.taskId && (
          <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && go(routeTaskPath(route))}>
            <div className="modal wide detail-modal">
              <Detail key={route.taskId} taskId={route.taskId} popup />
            </div>
          </div>
        )}
        <Modals />
        {quickAddInitial !== null && <MobileQuickAdd initialText={quickAddInitial} onClose={() => setQuickAddInitial(null)} />}
        <FocusGlobal />
        <ReminderPopups />
        <Toasts />
      </div>
    </DndShell>
  );
}
