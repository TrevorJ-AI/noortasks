import { safeLink } from "../lib/markdown";
import { ExternalLink, Lock, MapPin, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { DAY, addDays, formatTime, startOfDay } from "../lib/dates";
import { calErrorText, deleteEvent, saveEvent, useCalSources, useExtEvents } from "../data/calApi";
import { eventPatch, type ExtEvent } from "../model/extCal";
import { useApp } from "./ctx";
import { Popover, type Anchor } from "./primitives";

const PROVIDER_LABEL: Record<string, string> = { url: "URL calendar", holiday: "Holiday calendar", google: "Google", outlook: "Outlook", caldav: "CalDAV", icloud: "iCloud" };

/** "Mon, Nov 16, 09:00 - 10:30" or "Mon, Nov 16 - Wed, Nov 18 (all day)". */
export function eventWhen(e: Pick<ExtEvent, "start" | "end" | "allDay">, meridiem: boolean): string {
  const day = (ms: number): string => new Date(ms).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  if (e.allDay) {
    const last = addDays(e.end, -1);
    return Math.round((e.end - e.start) / DAY) <= 1 ? `${day(e.start)}, all day` : `${day(e.start)} - ${day(last)}, all day`;
  }
  const sameDay = new Date(e.start).toDateString() === new Date(e.end - 1).toDateString();
  return sameDay ? `${day(e.start)}, ${formatTime(e.start, meridiem)} - ${formatTime(e.end, meridiem)}` : `${day(e.start)} ${formatTime(e.start, meridiem)} - ${day(e.end)} ${formatTime(e.end, meridiem)}`;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const localInput = (ms: number, allDay: boolean): string => {
  const d = new Date(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return allDay ? date : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromInput = (v: string): number => {
  const [date, time] = v.split("T");
  const [y, m, d] = (date ?? "").split("-").map(Number);
  const [h, min] = (time ?? "00:00").split(":").map(Number);
  return new Date(y!, m! - 1, d!, h ?? 0, min ?? 0).getTime();
};

/**
 * Event detail popover: read-only for ICS feeds, holidays, CalDAV and iCloud; editable (title, time, place,
 * notes, delete) for two-way Google and Outlook calendars through the account event routes.
 */
export function ExtEventPopover({ anchor, ev, onClose }: { anchor: Anchor; ev: ExtEvent; onClose: () => void }): JSX.Element {
  const app = useApp();
  const meridiem = app.settings.showMeridiem !== false;
  const [edit, setEdit] = useState<null | { title: string; allDay: boolean; start: string; end: string; location: string; description: string }>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);
  const src = ev.source;
  const startEdit = (): void =>
    setEdit({ title: ev.wire.title, allDay: ev.allDay, start: localInput(ev.start, ev.allDay), end: localInput(ev.allDay ? addDays(ev.end, -1) : ev.end, ev.allDay), location: ev.wire.location ?? "", description: ev.wire.description ?? "" });
  const save = async (): Promise<void> => {
    if (!edit) return;
    const s = fromInput(edit.start);
    const e = edit.allDay ? addDays(fromInput(edit.end), 1) : fromInput(edit.end);
    setBusy(true);
    const r = await saveEvent(app.engine.api, ev, eventPatch(ev, { title: edit.title, allDay: edit.allDay, start: s, end: e, location: edit.location, description: edit.description }));
    setBusy(false);
    if (!r.ok) return setErr(calErrorText(r));
    app.toast("Event saved");
    onClose();
  };
  const remove = async (): Promise<void> => {
    setBusy(true);
    const r = await deleteEvent(app.engine.api, ev);
    setBusy(false);
    if (!r.ok) return setErr(calErrorText(r));
    app.toast("Event deleted");
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} testId="ext-event-pop" className="ext-pop">
      <div className="ext-pop-body" style={{ ["--ev" as string]: ev.color }}>
        <div className="ext-pop-head">
          <span className="ext-pop-swatch" style={{ background: ev.color }} />
          <div className="grow">
            {edit ? (
              <input className="field full" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} aria-label="Event title" data-testid="ext-edit-title" autoFocus />
            ) : (
              <h3 className="ext-pop-title" data-testid="ext-event-title">{ev.title}</h3>
            )}
            <div className="muted small" data-testid="ext-event-source">
              {src.name}
              {src.group ? ` · ${src.group}` : ""} · {PROVIDER_LABEL[src.provider] ?? src.provider}
            </div>
          </div>
          <button className="icon-btn xs" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        {edit ? (
          <div className="ext-edit">
            <label className="row gap small">
              <input type="checkbox" checked={edit.allDay} onChange={(e) => setEdit({ ...edit, allDay: e.target.checked, start: localInput(fromInput(edit.start), e.target.checked), end: localInput(fromInput(edit.end), e.target.checked) })} /> All day
            </label>
            <div className="row gap">
              <input className="field" type={edit.allDay ? "date" : "datetime-local"} value={edit.start} onChange={(e) => setEdit({ ...edit, start: e.target.value })} aria-label="Starts" />
              <input className="field" type={edit.allDay ? "date" : "datetime-local"} value={edit.end} onChange={(e) => setEdit({ ...edit, end: e.target.value })} aria-label="Ends" />
            </div>
            <input className="field full" placeholder="Location" value={edit.location} onChange={(e) => setEdit({ ...edit, location: e.target.value })} aria-label="Location" />
            <textarea className="field full" rows={3} placeholder="Notes" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} aria-label="Notes" />
            {err && <div className="form-error" role="alert">{err}</div>}
            <div className="row end gap">
              <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
              <button className="btn primary" disabled={busy || !edit.title.trim()} onClick={() => void save()} data-testid="ext-edit-save">Save</button>
            </div>
          </div>
        ) : (
          <>
            <div className="ext-pop-when" data-testid="ext-event-when">{eventWhen(ev, meridiem)}</div>
            {ev.wire.location && (
              <div className="ext-pop-line"><MapPin size={13} /> <span>{ev.wire.location}</span></div>
            )}
            {ev.wire.description && <p className="ext-pop-desc">{ev.wire.description}</p>}
            {ev.wire.url && /^https?:\/\//i.test(ev.wire.url) && (
              <a className="ext-pop-line link" href={safeLink(ev.wire.url)} target="_blank" rel="noreferrer noopener"><ExternalLink size={13} /> Open link</a>
            )}
            {err && <div className="form-error" role="alert">{err}</div>}
            <div className="ext-pop-foot">
              {ev.readOnly ? (
                <span className="muted small row gap" data-testid="ext-event-readonly"><Lock size={12} /> Read-only{src.kind === "account" ? "" : " subscription"}</span>
              ) : (
                <>
                  <button className="btn sm" onClick={startEdit} data-testid="ext-event-edit"><Pencil size={13} /> Edit</button>
                  {confirmDel ? (
                    <button className="btn sm danger" disabled={busy} onClick={() => void remove()} data-testid="ext-event-delete-confirm"><Trash2 size={13} /> Delete from {PROVIDER_LABEL[src.provider] ?? src.provider}</button>
                  ) : (
                    <button className="btn sm" onClick={() => setConfirmDel(true)} data-testid="ext-event-delete"><Trash2 size={13} /> Delete</button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}

/** One subscribed calendar as a list of its events, today plus the next 60 days (CAL-078 routes). */
export function SubCalScreen({ id }: { id: string }): JSX.Element {
  const app = useApp();
  const { sources, loaded } = useCalSources(app.engine.api);
  const today = startOfDay(app.now);
  const to = addDays(today, 61);
  const all = useExtEvents(app.engine.api, today, to, { holidayEnabled: true, showDeclined: true, includeHidden: true });
  const mine = sources.filter((s) => s.id === id);
  const evs = all.filter((e) => e.source.id === id);
  const [pop, setPop] = useState<{ anchor: Anchor; ev: ExtEvent } | null>(null);
  const meridiem = app.settings.showMeridiem !== false;
  const days: Array<[number, ExtEvent[]]> = [];
  for (const e of evs) {
    const d = Math.max(startOfDay(e.start), today);
    const last = days[days.length - 1];
    if (last && last[0] === d) last[1].push(e);
    else days.push([d, [e]]);
  }
  const title = mine.length === 1 ? mine[0]!.name : mine[0]?.group ?? mine[0]?.name ?? "Subscribed calendar";
  return (
    <div className="list-view subcal" data-testid="subcal-screen">
      <div className="view-header">
        <h1 className="view-title">
          {mine[0] && <span className="ext-pop-swatch inline" style={{ background: mine[0].color }} />} {title}
        </h1>
      </div>
      <div className="subcal-body">
        {loaded && mine.length === 0 && <div className="empty-note">This calendar is no longer subscribed.</div>}
        {mine.some((s) => !s.show) && <div className="muted small subcal-note">Hidden in the calendar; its events are listed here anyway.</div>}
        {mine.length > 0 && evs.length === 0 && <div className="empty-note">No events in the next 60 days{mine.some((s) => !s.show) ? " that are shown" : ""}.</div>}
        {days.map(([d, list]) => (
          <section key={d} className="cal-agenda-day">
            <h3 className={d === today ? "today" : ""}>{d === today ? "Today" : new Date(d).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}</h3>
            {list.map((e) => (
              <div
                key={e.id}
                className="cal-agenda-item ext"
                data-testid="subcal-item"
                data-title={e.title}
                onClick={(ev) => setPop({ anchor: { left: ev.clientX, right: ev.clientX, top: ev.clientY, bottom: ev.clientY, width: 0, height: 0 }, ev: e })}
              >
                <span className="tl-dot" style={{ background: e.color }} />
                <span className="grow">{e.title}</span>
                <span className="muted small">{e.allDay ? "All day" : `${formatTime(e.start, meridiem)} - ${formatTime(e.end, meridiem)}`}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
      {pop && <ExtEventPopover anchor={pop.anchor} ev={pop.ev} onClose={() => setPop(null)} />}
    </div>
  );
}
