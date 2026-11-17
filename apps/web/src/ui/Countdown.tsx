import { Archive, ArchiveRestore, ChevronDown, ChevronLeft, Hourglass, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { Countdown } from "../data/m4types";
import { newId } from "../lib/core";
import { toServer } from "../lib/dates";
import { todayStamp } from "../lib/m4core";
import { CountdownTypes, GROUPS, HOLIDAYS, ICON_PRESETS, REMINDER_PRESETS, STYLES, ageOn, counterOf, formatStamp, inUnit, inputToStamp, nextFixedDate, nextUnit, sortCountdowns, stampToInput, typeLabel, type Unit } from "../model/countdown";
import { countdownPath, go } from "../model/router";
import { useApp } from "./ctx";
import { useM4 } from "./m4ctx";
import { ColorSwatches, Menu, MenuButton, Modal, Popover, Select, Switch, anchorOf, type Anchor } from "./primitives";

type Filter = "active" | "archived";
const DEFAULT_COLOR = "#2f8fbf";

function blank(type: number, today: number): Countdown {
  return {
    id: newId(),
    name: "",
    type,
    date: today,
    status: 0,
    timerMode: type === CountdownTypes.Anniversary ? 1 : 0,
    daysOption: 0,
    dateDisplayFormat: "day",
    style: "normal",
    styleColor: null,
    icon: type === CountdownTypes.Birthday ? "🎂" : type === CountdownTypes.Anniversary ? "💍" : type === CountdownTypes.Holiday ? "🎉" : "📅",
    color: DEFAULT_COLOR,
    repeatFlag: type === CountdownTypes.Birthday || type === CountdownTypes.Anniversary ? "RRULE:FREQ=YEARLY;INTERVAL=1" : null,
    reminders: ["TRIGGER:P0DT9H0M0S", "TRIGGER:-P2DT15H0M0S"],
    remark: "",
    showRemark: false,
    showAge: type === CountdownTypes.Birthday,
    ignoreYear: false,
    showCalendarType: 1,
    pinnedTime: null,
  };
}

/** Big counter text of a countdown in its display unit. */
function useCounter(c: Countdown, today: number): { value: string; label: string; rest?: string; caption: string } {
  const k = counterOf(c, today);
  const u = inUnit(k.days, c.dateDisplayFormat as Unit);
  const caption = k.dir === "today" ? "Today" : k.dir === "left" ? `${u.label} left` : `${u.label} since`;
  return { ...u, caption };
}

function Badge({ c, size = "" }: { c: Countdown; size?: string }): JSX.Element {
  const icon = c.icon || c.name.slice(0, 1).toUpperCase() || "?";
  return (
    <span className={`m4-icon-badge cd-badge ${size}`} style={{ background: `color-mix(in srgb, ${c.color || DEFAULT_COLOR} 18%, var(--surface))`, color: c.color || DEFAULT_COLOR }}>
      {icon}
    </span>
  );
}

export function CountdownScreen(): JSX.Element {
  const app = useApp();
  const { countdowns, m4, tz } = useM4();
  const today = todayStamp(app.now, tz);
  const [filter, setFilter] = useState<Filter>("active");
  const [titleA, setTitleA] = useState<Anchor | null>(null);
  const [addA, setAddA] = useState<Anchor | null>(null);
  const [dialog, setDialog] = useState<{ c: Countdown; isNew: boolean } | null>(null);
  const showSection = !!((app.ext.countdownConf ?? {}) as { showSection?: boolean }).showSection;
  const selected = app.route.itemId ? countdowns.find((c) => c.id === app.route.itemId) : undefined;

  const visible = useMemo(() => sortCountdowns(countdowns.filter((c) => (filter === "archived" ? c.status === 1 : c.status !== 1)), today), [countdowns, filter, today]);
  const groups = showSection ? GROUPS.map((g) => ({ ...g, items: visible.filter((c) => c.type === g.type) })).filter((g) => g.items.length) : [{ type: 0, label: "", items: visible }];

  const open = (type: number): void => setDialog({ c: blank(type, today), isNew: true });
  return (
    <div className={`m4-screen cd-screen${selected ? " has-item" : ""}`} data-testid="countdown-screen">
      <section className="m4-list">
        <div className="m4-head">
          <button className="cd-title-btn view-title" data-testid="countdown-filter" onClick={(e) => setTitleA(anchorOf(e.currentTarget))}>
            {filter === "active" ? "Countdown" : "Archived"} <ChevronDown size={16} />
          </button>
          <button className="icon-btn" aria-label="Add countdown" title="Add countdown" data-testid="countdown-add" onClick={(e) => setAddA(anchorOf(e.currentTarget))}>
            <Plus size={18} />
          </button>
          <MenuButton title="More" testId="countdown-more" placement="bottom-end" items={() => [{ label: "Show Group", checked: showSection, testId: "countdown-show-group", onClick: () => void app.repo.setExt("countdownConf", { ...((app.ext.countdownConf ?? {}) as object), showSection: !showSection }) }]}>
            <MoreHorizontal size={18} />
          </MenuButton>
        </div>
        <div className="m4-scroll">
          {visible.length === 0 && (
            <div className="m4-empty" data-testid="countdown-empty">
              <Hourglass size={40} strokeWidth={1.3} />
              <div className="empty-title">{filter === "active" ? "Keep track of every special day." : "No archived countdowns"}</div>
              {filter === "active" && <div className="empty-sub">Birthdays, anniversaries, trips and deadlines.</div>}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.type} className="cd-group" data-testid={g.label ? "countdown-group" : undefined} data-label={g.label}>
              {g.label && <div className="m4-section-head">{g.label}<span className="grow" />{g.items.length}</div>}
              {g.items.map((c) => (
                <CountdownRow key={c.id} c={c} today={today} active={selected?.id === c.id} onUnit={() => void m4.saveCountdown({ ...c, dateDisplayFormat: nextUnit(c.dateDisplayFormat as Unit) })} />
              ))}
            </div>
          ))}
        </div>
      </section>
      <section className={`m4-detail${selected ? "" : " center"}`}>
        {selected ? (
          <CountdownDetail key={selected.id} c={selected} today={today} onEdit={() => setDialog({ c: selected, isNew: false })} />
        ) : (
          <div className="cd-detail-empty">Select a countdown to see its card</div>
        )}
      </section>
      {titleA && (
        <Popover anchor={titleA} onClose={() => setTitleA(null)} testId="countdown-filter-menu">
          <Menu
            onClose={() => setTitleA(null)}
            items={[
              { label: "Active", checked: filter === "active", onClick: () => setFilter("active") },
              { label: "Archived", checked: filter === "archived", onClick: () => setFilter("archived") },
            ]}
          />
        </Popover>
      )}
      {addA && (
        <Popover anchor={addA} onClose={() => setAddA(null)} placement="bottom-end" testId="countdown-add-menu">
          <Menu
            onClose={() => setAddA(null)}
            items={[
              { label: "Countdown", testId: "countdown-add-4", onClick: () => open(CountdownTypes.Countdown) },
              { label: "Anniversary", testId: "countdown-add-3", onClick: () => open(CountdownTypes.Anniversary) },
              { label: "Birthday", testId: "countdown-add-2", onClick: () => open(CountdownTypes.Birthday) },
              { label: "Holiday", testId: "countdown-add-1", onClick: () => open(CountdownTypes.Holiday) },
            ]}
          />
        </Popover>
      )}
      {dialog && (
        <CountdownDialog
          initial={dialog.c}
          isNew={dialog.isNew}
          today={today}
          onClose={() => setDialog(null)}
          onSave={async (c) => {
            await m4.saveCountdown(c);
            setDialog(null);
            if (dialog.isNew) go(countdownPath(c.id));
          }}
        />
      )}
    </div>
  );
}

function CountdownRow({ c, today, active, onUnit }: { c: Countdown; today: number; active: boolean; onUnit: () => void }): JSX.Element {
  const k = useCounter(c, today);
  const target = counterOf(c, today).target;
  return (
    <div className={`cd-row${active ? " active" : ""}`} data-testid="countdown-card" data-name={c.name} onClick={() => go(countdownPath(c.id))}>
      <Badge c={c} />
      <div className="cd-row-main">
        <div className="cd-row-name">
          {c.pinnedTime && <Pin size={12} className="cd-pin" aria-label="Pinned" />}
          <span>{c.name || "Untitled"}</span>
        </div>
        <div className="cd-row-sub">
          {formatStamp(target)}
          {c.type === CountdownTypes.Birthday && c.showAge && <span> · turns {ageOn(c.date, target)}</span>}
        </div>
        {c.showRemark && c.remark && <div className="cd-row-remark">{c.remark}</div>}
      </div>
      <button
        className="cd-num"
        data-testid="countdown-number"
        title="Switch days, weeks, years"
        onClick={(e) => {
          e.stopPropagation();
          onUnit();
        }}
      >
        <span className="cd-num-v">{k.caption === "Today" ? "Today" : k.value}</span>
        {k.caption !== "Today" && <span className="cd-num-l">{k.caption}</span>}
      </button>
    </div>
  );
}

function CountdownDetail({ c, today, onEdit }: { c: Countdown; today: number; onEdit: () => void }): JSX.Element {
  const app = useApp();
  const { m4 } = useM4();
  return (
    <div className="cd-detail" data-testid="countdown-detail">
      <div className="m4-head">
        <button className="icon-btn m4-back" aria-label="Back" onClick={() => go(countdownPath())}>
          <ChevronLeft size={18} />
        </button>
        <h2 className="view-title cd-detail-title">{c.name || "Untitled"}</h2>
        <button className="icon-btn" title="Edit" aria-label="Edit" data-testid="countdown-edit" onClick={onEdit}>
          <Pencil size={16} />
        </button>
        <button className="icon-btn" title={c.pinnedTime ? "Unpin" : "Pin"} aria-label={c.pinnedTime ? "Unpin" : "Pin"} data-testid="countdown-pin" onClick={() => void m4.saveCountdown({ ...c, pinnedTime: c.pinnedTime ? null : toServer(Date.now()) })}>
          {c.pinnedTime ? <PinOff size={16} /> : <Pin size={16} />}
        </button>
        <button
          className="icon-btn"
          title={c.status === 1 ? "Unarchive" : "Archive"}
          aria-label={c.status === 1 ? "Unarchive" : "Archive"}
          data-testid="countdown-archive"
          onClick={() => void m4.saveCountdown({ ...c, status: c.status === 1 ? 0 : 1, archivedTime: c.status === 1 ? null : toServer(Date.now()), pinnedTime: c.status === 1 ? c.pinnedTime : null }).then(() => go(countdownPath()))}
        >
          {c.status === 1 ? <ArchiveRestore size={16} /> : <Archive size={16} />}
        </button>
        <button
          className="icon-btn"
          title="Delete"
          aria-label="Delete"
          data-testid="countdown-delete"
          onClick={() => app.setModal({ kind: "confirm", title: "Delete countdown", body: `"${c.name}" will be deleted for good.`, ok: "Delete", danger: true, onOk: () => void m4.deleteCountdown(c.id).then(() => go(countdownPath())) })}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <CountdownCard c={c} today={today} onUnit={() => void m4.saveCountdown({ ...c, dateDisplayFormat: nextUnit(c.dateDisplayFormat as Unit) })} />
      <dl className="cd-facts">
        <dt>Type</dt>
        <dd>{typeLabel(c.type)}</dd>
        <dt>Date</dt>
        <dd>{formatStamp(c.date, true)}</dd>
        <dt>Counting</dt>
        <dd>{c.timerMode === 1 ? "Count up" : "Count down"}{c.daysOption === 1 ? ", start from day 1" : ""}</dd>
        <dt>Repeat</dt>
        <dd>{repeatLabel(c.repeatFlag, c.type)}</dd>
        {c.remark ? (
          <>
            <dt>Note</dt>
            <dd className="cd-remark-full">{c.remark}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

function repeatLabel(flag: string | null | undefined, type: number): string {
  const f = (flag ?? "").replace(/^RRULE:/, "");
  if (!f) return type === CountdownTypes.Birthday ? "Every year" : "None";
  if (f === "FREQ=YEARLY;INTERVAL=1" || f === "FREQ=YEARLY") return "Every year";
  if (f === "FREQ=MONTHLY;INTERVAL=1" || f === "FREQ=MONTHLY") return "Every month";
  return f;
}

/** The styled card (CNT-015): eight looks, a style colour and an optional background image. */
export function CountdownCard({ c, today, onUnit }: { c: Countdown; today: number; onUnit?: () => void }): JSX.Element {
  const k = useCounter(c, today);
  const target = counterOf(c, today).target;
  const color = c.styleColor || c.color || DEFAULT_COLOR;
  const style = c.style || "normal";
  const d = new Date(Math.floor(target / 10000), Math.floor((target % 10000) / 100) - 1, target % 100);
  const bg = c.backgroundImage && (style === "fullscreen_image" || style === "polaroid" || style === "normal") ? c.backgroundImage : null;
  return (
    <div className={`cd-card cd-style-${style}${bg ? " has-image" : ""}`} style={{ ["--cd" as string]: color, ...(bg && style !== "polaroid" ? { backgroundImage: `linear-gradient(rgba(0,0,0,.28), rgba(0,0,0,.45)), url(${bg})` } : {}) }} data-testid="countdown-preview" data-style={style}>
      {style === "polaroid" && <div className="cd-photo" style={bg ? { backgroundImage: `url(${bg})` } : undefined}>{!bg && <Badge c={c} size="lg" />}</div>}
      {(style === "calendar" || style === "perpetual") && (
        <div className="cd-cal">
          <div className="cd-cal-m">{d.toLocaleDateString("en-US", { month: "short" })}</div>
          <div className="cd-cal-d">{d.getDate()}</div>
          <div className="cd-cal-w">{d.toLocaleDateString("en-US", { weekday: "long" })}</div>
        </div>
      )}
      <div className="cd-card-body">
        {style !== "polaroid" && style !== "calendar" && style !== "perpetual" && <Badge c={c} size="lg" />}
        <div className="cd-card-name">{c.name || "Untitled"}</div>
        <button className="cd-card-num" onClick={onUnit} title="Switch days, weeks, years" data-testid="countdown-card-number">
          <span className="v">{k.caption === "Today" ? "Today" : k.value}</span>
          {k.caption !== "Today" && <span className="l">{k.caption}</span>}
        </button>
        {k.rest && <div className="cd-card-rest">and {k.rest}</div>}
        <div className="cd-card-date">
          {formatStamp(target, true)}
          {c.type === CountdownTypes.Birthday && c.showAge ? ` · turns ${ageOn(c.date, target)}` : ""}
        </div>
        {c.showRemark && c.remark && <div className="cd-card-remark">{c.remark}</div>}
      </div>
    </div>
  );
}

const REPEAT_OPTIONS = [
  { value: "none", label: "None" },
  { value: "yearly", label: "Every year" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom" },
] as const;
type RepeatChoice = (typeof REPEAT_OPTIONS)[number]["value"];
function repeatChoice(flag: string | null | undefined): RepeatChoice {
  const f = (flag ?? "").replace(/^RRULE:/, "");
  if (!f) return "none";
  if (f === "FREQ=YEARLY;INTERVAL=1" || f === "FREQ=YEARLY") return "yearly";
  if (f === "FREQ=MONTHLY;INTERVAL=1" || f === "FREQ=MONTHLY") return "monthly";
  return "custom";
}

async function resizeImage(file: File, max = 900): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function CountdownDialog({ initial, isNew, today, onClose, onSave }: { initial: Countdown; isNew: boolean; today: number; onClose: () => void; onSave: (c: Countdown) => Promise<void> }): JSX.Element {
  const [c, setC] = useState<Countdown>(initial);
  const [repeat, setRepeat] = useState<RepeatChoice>(repeatChoice(initial.repeatFlag));
  const [custom, setCustom] = useState(repeatChoice(initial.repeatFlag) === "custom" ? (initial.repeatFlag ?? "").replace(/^RRULE:/, "") : "FREQ=MONTHLY;INTERVAL=2");
  const [err, setErr] = useState("");
  const [iconText, setIconText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (p: Partial<Countdown>): void => setC((x) => ({ ...x, ...p }));
  const isBirthday = c.type === CountdownTypes.Birthday;

  const save = async (): Promise<void> => {
    if (!c.name.trim()) {
      setErr("Give it a name");
      return;
    }
    let repeatFlag: string | null = null;
    if (repeat === "yearly") repeatFlag = "RRULE:FREQ=YEARLY;INTERVAL=1";
    else if (repeat === "monthly") repeatFlag = "RRULE:FREQ=MONTHLY;INTERVAL=1";
    else if (repeat === "custom") {
      const body = custom.trim().replace(/^RRULE:/i, "").toUpperCase();
      if (!/FREQ=(YEARLY|MONTHLY|WEEKLY|DAILY)/.test(body)) {
        setErr("Custom repeat needs FREQ=YEARLY, MONTHLY, WEEKLY or DAILY");
        return;
      }
      repeatFlag = `RRULE:${body}`;
    }
    await onSave({ ...c, name: c.name.trim(), repeatFlag });
  };

  return (
    <Modal onClose={onClose} className="m4-dialog cd-dialog" testId="countdown-dialog">
      <h3>{isNew ? `New ${typeLabel(c.type).toLowerCase()}` : "Edit countdown"}</h3>
      {c.type === CountdownTypes.Holiday && (
        <div className="m4-field">
          <span className="m4-label">Recommended</span>
          <div className="cd-holidays" data-testid="countdown-holidays">
            {HOLIDAYS.map((h) => (
              <button key={h.name} className={`chip-btn${c.name === h.name ? " on" : ""}`} onClick={() => {
                set({ name: h.name, icon: h.icon, date: nextFixedDate(h.m, h.d, today) });
                setRepeat("yearly");
              }}>
                {h.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="cd-dialog-top">
        <IconPicker c={c} onPick={(icon) => set({ icon })} text={iconText} setText={setIconText} />
        <input className="field full" autoFocus placeholder="Name" data-testid="countdown-name" value={c.name} onChange={(e) => (set({ name: e.target.value }), setErr(""))} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </div>
      <div className="cd-grid">
        <div className="m4-field">
          <label>Type</label>
          <Select testId="countdown-type" value={c.type} onChange={(v) => set({ type: v, timerMode: v === CountdownTypes.Anniversary ? 1 : c.timerMode, showAge: v === CountdownTypes.Birthday ? true : c.showAge })} options={[4, 3, 2, 1].map((t) => ({ value: t, label: typeLabel(t) }))} />
        </div>
        <div className="m4-field">
          <label>Date</label>
          <input className="field" type="date" data-testid="countdown-date" value={stampToInput(c.date)} onChange={(e) => {
            const s = inputToStamp(e.target.value);
            if (s) set({ date: s });
          }} />
        </div>
        <div className="m4-field">
          <label>Counting</label>
          <div className="seg small">
            <button className={c.timerMode !== 1 ? "on" : ""} data-testid="countdown-mode-down" onClick={() => set({ timerMode: 0 })}>Count down</button>
            <button className={c.timerMode === 1 ? "on" : ""} data-testid="countdown-mode-up" onClick={() => set({ timerMode: 1 })}>Count up</button>
          </div>
        </div>
        <div className="m4-field">
          <label>Day calculation</label>
          <div className="seg small">
            <button className={c.daysOption !== 1 ? "on" : ""} onClick={() => set({ daysOption: 0 })}>Standard</button>
            <button className={c.daysOption === 1 ? "on" : ""} data-testid="countdown-day1" onClick={() => set({ daysOption: 1 })}>Start from day 1</button>
          </div>
        </div>
        <div className="m4-field">
          <label>Show in</label>
          <Select value={(c.dateDisplayFormat ?? "day") as Unit} onChange={(v) => set({ dateDisplayFormat: v })} options={[{ value: "day", label: "Days" }, { value: "week", label: "Weeks" }, { value: "year", label: "Years" }]} />
        </div>
        <div className="m4-field">
          <label>Repeat</label>
          <Select testId="countdown-repeat" value={repeat} onChange={(v) => setRepeat(v)} options={REPEAT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
        </div>
      </div>
      {repeat === "custom" && (
        <div className="m4-field">
          <label>Custom rule</label>
          <input className="field full" data-testid="countdown-custom-repeat" value={custom} onChange={(e) => (setCustom(e.target.value), setErr(""))} placeholder="FREQ=MONTHLY;INTERVAL=2" />
          <span className="muted small">FREQ is YEARLY, MONTHLY, WEEKLY or DAILY; INTERVAL is every n periods.</span>
        </div>
      )}
      {isBirthday && (
        <div className="cd-switches">
          <label className="m4-inline"><Switch checked={!!c.showAge} onChange={(v) => set({ showAge: v })} testId="countdown-show-age" /> Show age</label>
          <label className="m4-inline"><Switch checked={!!c.ignoreYear} onChange={(v) => set({ ignoreYear: v })} /> Year unknown</label>
        </div>
      )}
      <div className="cd-grid">
        <div className="m4-field">
          <label>Calendar</label>
          <Select value={c.showCalendarType ?? 1} onChange={(v) => set({ showCalendarType: v })} options={[{ value: 1, label: "Gregorian" }, { value: 2, label: "Lunar" }]} />
          {c.showCalendarType === 2 && <span className="muted small">Lunar dates are stored but not converted yet; the Gregorian date is used.</span>}
        </div>
        <div className="m4-field">
          <label>Reminders</label>
          <div className="cd-reminders">
            {REMINDER_PRESETS.map((r) => {
              const on = (c.reminders ?? []).includes(r.value);
              return (
                <button key={r.value} className={`chip-btn${on ? " on" : ""}`} onClick={() => set({ reminders: on ? (c.reminders ?? []).filter((x) => x !== r.value) : [...(c.reminders ?? []), r.value] })}>
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="m4-field">
        <label>Colour</label>
        <ColorSwatches value={c.color} onChange={(v) => set({ color: v })} />
      </div>
      <div className="m4-field">
        <label>Card style</label>
        <div className="cd-styles" data-testid="countdown-styles">
          {STYLES.map((s) => (
            <button key={s.value} className={`cd-style-pick${(c.style ?? "normal") === s.value ? " on" : ""}`} data-testid={`countdown-style-${s.value}`} onClick={() => set({ style: s.value })}>
              <span className={`cd-style-thumb cd-thumb-${s.value}`} style={{ ["--cd" as string]: c.styleColor || c.color || DEFAULT_COLOR }} />
              {s.label}
            </button>
          ))}
        </div>
        <div className="m4-inline">
          <span className="muted small">Style colour</span>
          <ColorSwatches value={c.styleColor} onChange={(v) => set({ styleColor: v })} />
        </div>
        <div className="m4-inline">
          <button className="btn sm" onClick={() => fileRef.current?.click()} data-testid="countdown-image">{c.backgroundImage ? "Change image" : "Background image"}</button>
          {c.backgroundImage && <button className="link-btn" onClick={() => set({ backgroundImage: null })}>Remove image</button>}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) set({ backgroundImage: await resizeImage(f), style: c.style === "normal" || !c.style ? "fullscreen_image" : c.style });
            e.target.value = "";
          }} />
        </div>
      </div>
      <div className="m4-field">
        <label>Note</label>
        <textarea className="field" data-testid="countdown-remark" value={c.remark ?? ""} onChange={(e) => set({ remark: e.target.value })} placeholder="A few words about this day" />
        <label className="m4-inline"><Switch checked={!!c.showRemark} onChange={(v) => set({ showRemark: v })} testId="countdown-show-remark" /> Show the note on the card</label>
      </div>
      <div className="cd-dialog-preview">
        <CountdownCard c={c} today={today} />
      </div>
      {err && <div className="error">{err}</div>}
      <div className="row end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" data-testid="countdown-save" onClick={() => void save()}>{isNew ? "Add" : "Save"}</button>
      </div>
    </Modal>
  );
}

function IconPicker({ c, onPick, text, setText }: { c: Countdown; onPick: (icon: string) => void; text: string; setText: (s: string) => void }): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  return (
    <>
      <button className="cd-icon-btn" title="Icon" aria-label="Icon" data-testid="countdown-icon" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <Badge c={c} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} testId="countdown-icon-menu">
          <div className="cd-icon-grid">
            {ICON_PRESETS.map((i) => (
              <button key={i} className={`cd-icon-cell${c.icon === i ? " on" : ""}`} onClick={() => (onPick(i), setA(null))}>{i}</button>
            ))}
          </div>
          <div className="cd-icon-text">
            <input className="field" maxLength={2} placeholder="Aa" value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn sm" disabled={!text.trim()} onClick={() => (onPick(text.trim()), setA(null))}>Use text</button>
          </div>
        </Popover>
      )}
    </>
  );
}
