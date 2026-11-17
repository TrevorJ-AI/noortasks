import { Inbox, Sun } from "lucide-react";
import { useState } from "react";
import type { Preferences } from "../../lib/core";
import { useApp } from "../ctx";
import { Switch } from "../primitives";
import { THEMES, resolveThemeId, type ThemeDef } from "../theme";
import { Card, NavValue, PickBadge, Picker, Row, SetSection, StDialog } from "./kit";

type Prefs = Preferences & { autoDarkTheme?: boolean; darkTheme?: string; darkCustomColor?: string; themeChosen?: boolean };

/** Settings > Appearance: Theme | Display. */
export function AppearanceTab(): JSX.Element {
  const [sub, setSub] = useState<"theme" | "display">("theme");
  return (
    <>
      <div className="seg center-seg" role="tablist">
        <button role="tab" aria-selected={sub === "theme"} className={sub === "theme" ? "on" : ""} onClick={() => setSub("theme")} data-testid="appearance-theme">
          Theme
        </button>
        <button role="tab" aria-selected={sub === "display"} className={sub === "display" ? "on" : ""} onClick={() => setSub("display")} data-testid="appearance-display">
          Display
        </button>
      </div>
      {sub === "theme" ? <ThemePane /> : <DisplayPane />}
    </>
  );
}

const STYLE_LABEL: Record<string, string> = { flat: "Flat", card: "Card", classic: "Classic" };

function ThemePane(): JSX.Element {
  const { settings, repo, local } = useApp();
  const s = settings as Prefs;
  const [dialog, setDialog] = useState<"style" | "dark" | null>(null);
  const resolved = resolveThemeId(settings.theme, s.themeChosen);
  const current = resolved === "dark" ? "night" : resolved;
  const setTheme = (id: string): void => void repo.setSettings({ theme: id, themeChosen: true } as never);
  const series = (name: ThemeDef["series"]): ThemeDef[] => THEMES.filter((t) => t.series === name);
  return (
    <>
      <Card>
        <Row label="Interface Style">
          <NavValue testId="interface-style" onClick={() => setDialog("style")}>{STYLE_LABEL[local.interfaceStyle] ?? "Flat"}</NavValue>
        </Row>
        <Row label="Follow System Dark Mode">
          <NavValue testId="follow-dark" onClick={() => setDialog("dark")}>{s.autoDarkTheme ? "On" : "Off"}</NavValue>
        </Row>
      </Card>

      <SetSection title="Color Series" />
      <div className="theme-swatches">
        {[...series("color").filter((t) => t.id !== "noor"), ...series("color").filter((t) => t.id === "noor")].map((t) => (
          <ThemeChoice key={t.id} t={t} on={current === t.id} onPick={() => setTheme(t.id)} kind="swatch" />
        ))}
      </div>
      <SetSection title="City Series" />
      <div className="theme-cards">
        {series("city").map((t) => (
          <ThemeChoice key={t.id} t={t} on={current === t.id} onPick={() => setTheme(t.id)} kind="city" />
        ))}
      </div>
      <SetSection title="Season Series" />
      <div className="theme-cards">
        {series("season").map((t) => (
          <ThemeChoice key={t.id} t={t} on={current === t.id} onPick={() => setTheme(t.id)} kind="image" />
        ))}
      </div>
      <SetSection title="Photograph Series" />
      <div className="theme-cards">
        {series("photo").map((t) => (
          <ThemeChoice key={t.id} t={t} on={current === t.id} onPick={() => setTheme(t.id)} kind="image" />
        ))}
      </div>

      {dialog === "style" && <InterfaceStyleDialog onClose={() => setDialog(null)} />}
      {dialog === "dark" && <DarkModeDialog onClose={() => setDialog(null)} />}
    </>
  );
}

/** One theme in a grid: colour swatch, city tile (our own gradient) or season/photo thumbnail. */
function ThemeChoice({ t, on, onPick, kind }: { t: ThemeDef; on: boolean; onPick: () => void; kind: "swatch" | "city" | "image" }): JSX.Element {
  let art: JSX.Element;
  if (kind === "image") art = <img src={`/themes/${t.id}-thumb.webp`} alt="" loading="lazy" draggable={false} />;
  else if (t.base === "dark") art = <span className="ts-dots" style={{ color: t.accent }}>&bull;&bull;&bull;</span>;
  else art = <></>;
  const style =
    kind === "image"
      ? undefined
      : t.id === "default"
        ? { background: "#ffffff" }
        : t.base === "dark"
          ? { background: t.bg ?? "#111111" }
          : kind === "city"
            ? { background: `radial-gradient(circle at 74% 34%, color-mix(in srgb, ${t.accent} 25%, #fff6dc) 0 9%, transparent 10%), linear-gradient(180deg, color-mix(in srgb, ${t.accent} 35%, #ffffff) 0%, ${t.accent} 100%)` }
            : { background: `linear-gradient(160deg, color-mix(in srgb, ${t.accent} 45%, #ffffff) 0%, ${t.accent} 100%)` };
  return (
    <button className={`theme-choice tc-${kind}${on ? " on" : ""}`} data-testid={`theme-${t.id}`} onClick={onPick} title={t.label} aria-pressed={on}>
      <span className="tc-art" style={style}>
        {art}
        {kind === "city" && <span className="tc-skyline" aria-hidden />}
        {on && <PickBadge />}
      </span>
      <span className="tc-label">{t.label}</span>
    </button>
  );
}

/** Mini app drawing used by the Interface Style choices. */
function StylePreview({ style }: { style: string }): JSX.Element {
  return (
    <span className={`isp isp-${style}`} aria-hidden>
      <span className="isp-side">
        {[0, 1, 2, 3, 4, 5].map((i) => <i key={i} />)}
      </span>
      <span className="isp-list">
        {[0, 1, 2, 3, 4].map((i) => <i key={i} />)}
      </span>
      <span className="isp-detail">
        <i />
        <i />
      </span>
    </span>
  );
}

function InterfaceStyleDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { local, setLocal } = useApp();
  return (
    <StDialog title="Interface Style" sub="Choose how task rows look." onClose={onClose} testId="interface-style-dialog">
      <div className="isp-choices" role="radiogroup">
        {(["flat", "card", "classic"] as const).map((v) => (
          <button key={v} role="radio" aria-checked={local.interfaceStyle === v} className={`isp-choice${local.interfaceStyle === v ? " on" : ""}`} data-testid={`interface-style-${v}`} onClick={() => setLocal("interfaceStyle", v)}>
            <StylePreview style={v} />
            <span className="isp-radio">
              <span className="isp-dot" aria-hidden />
              {STYLE_LABEL[v]}
            </span>
          </button>
        ))}
      </div>
    </StDialog>
  );
}

function DarkModeDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { settings, repo } = useApp();
  const s = settings as Prefs;
  const darks = [THEMES.find((t) => t.id === "night")!, ...THEMES.filter((t) => t.series === "dark")];
  const chosen = s.darkTheme ?? "night";
  return (
    <StDialog title="Follow System Dark Mode" onClose={onClose} testId="dark-mode-dialog">
      <Card className="st-dialog-card">
        <Row label="Switch automatically">
          <Switch testId="auto-dark" checked={!!s.autoDarkTheme} onChange={(v) => void repo.setSettings({ autoDarkTheme: v } as never)} />
        </Row>
        <Row label="Night theme">
          <span className="night-dots" role="radiogroup">
            {darks.map((t) =>
              t.id === "darkcustom" ? (
                <label key={t.id} className={`night-dot custom${chosen === t.id ? " on" : ""}`} title="Custom colour" data-testid="theme-darkcustom">
                  <input type="color" value={s.darkCustomColor ?? "#52b097"} aria-label="Custom night colour" onChange={(e) => void repo.setSettings({ darkTheme: "darkcustom", darkCustomColor: e.target.value } as never)} onClick={() => chosen !== "darkcustom" && void repo.setSettings({ darkTheme: "darkcustom" } as never)} />
                </label>
              ) : (
                <button key={t.id} role="radio" aria-checked={chosen === t.id} aria-label={t.label} title={t.label} className={`night-dot${chosen === t.id ? " on" : ""}`} style={{ background: t.accent }} data-testid={`theme-${t.id}-night`} onClick={() => void repo.setSettings({ darkTheme: t.id } as never)} />
              ),
            )}
          </span>
        </Row>
      </Card>
      <p className="st-dialog-sub">When your system switches to dark, the app uses the night theme; in light mode it uses the theme you picked.</p>
    </StDialog>
  );
}

// ------------------------------------------------------------------ Display

function MiniSide({ counts }: { counts: [number, number] | null }): JSX.Element {
  return (
    <span className="mini-side">
      <span className="mini-line">
        <Sun size={11} />
        <b>Today</b>
        {counts && <em>{counts[0]}</em>}
      </span>
      <span className="mini-line">
        <Inbox size={11} />
        <b>Inbox</b>
        {counts && <em>{counts[1]}</em>}
      </span>
    </span>
  );
}

function MiniTasks({ colors, done, strike }: { colors?: boolean; done?: boolean; strike?: boolean }): JSX.Element {
  return (
    <span className={`mini-tasks${colors ? " colors" : ""}${done ? " done" : ""}${strike ? " strike" : ""}`}>
      {[0, 1].map((i) => (
        <span key={i} className={`mini-task c${i}`}>
          <i className="mini-box" />
          <b>Task Title</b>
        </span>
      ))}
    </span>
  );
}

function DisplayPane(): JSX.Element {
  const { local, setLocal } = useApp();
  return (
    <div className="st-display">
      <SetSection title="Sidebar Count" />
      <Picker
        testId="sidebar-count"
        value={local.sidebarCountStyle}
        onChange={(v) => setLocal("sidebarCountStyle", v)}
        options={[
          { value: "all", label: "Show(All)", preview: <MiniSide counts={[3, 16]} /> },
          { value: "hideNote", label: "Show(Hide Note)", preview: <MiniSide counts={[3, 10]} /> },
          { value: "hide", label: "Hide(All)", preview: <MiniSide counts={null} /> },
        ]}
      />
      <SetSection title="List Color" help="Shows each list's colour beside its tasks and in the sidebar." />
      <Picker
        testId="list-color"
        cols={3}
        value={local.isRenderProjectColor ? "show" : "hide"}
        onChange={(v) => setLocal("isRenderProjectColor", v === "show")}
        options={[
          { value: "show", label: "Show", preview: <MiniTasks colors /> },
          { value: "hide", label: "Hide", preview: <MiniTasks /> },
        ]}
      />
      <SetSection title="Completed Task Style" />
      <Picker
        testId="completed-style"
        cols={3}
        value={local.completedTaskStyle}
        onChange={(v) => setLocal("completedTaskStyle", v)}
        options={[
          { value: "plain", label: "Default", preview: <MiniTasks done /> },
          { value: "strike", label: "Strikethrough", preview: <MiniTasks done strike /> },
        ]}
      />
      <SetSection title="Font Size" help="Ctrl + / - / 0 also zoom the whole app." />
      <Picker
        testId="font-size"
        value={local.fontSize}
        onChange={(v) => setLocal("fontSize", v)}
        options={[
          { value: "normal", label: "Normal", preview: <span className="mini-aa s1">Aa</span> },
          { value: "large", label: "Large", preview: <span className="mini-aa s2">Aa</span> },
          { value: "xlarge", label: "Extra-Large", preview: <span className="mini-aa s3">Aa</span> },
        ]}
      />
    </div>
  );
}
