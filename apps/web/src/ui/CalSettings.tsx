import { Check, ChevronRight, Copy, ExternalLink, Link2, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { CalendarProjectBinding, HolidayPreset } from "../lib/core";
import {
  bindCalDav,
  bindProject,
  listBindings,
  refreshSub,
  syncAccount,
  unbindProject,
  calErrorText,
  cancelFeed,
  deleteSub,
  disconnectAccount,
  getFeed,
  newFeed,
  oauthStartUrl,
  oauthStatus,
  presets,
  setShown,
  setSourceColor,
  subscribeHoliday,
  subscribeUrl,
  updateFeed,
  updateSub,
  useCalSources,
  type FeedState,
  type OAuthProvider,
  type OAuthStatus,
} from "../data/calApi";
import { SOURCE_COLORS, feedLink, type ExtSource } from "../model/extCal";
import { useApp } from "./ctx";
import { Popover, Switch, anchorOf, type Anchor } from "./primitives";

type RowC = (p: { label: string; children: React.ReactNode; hint?: string }) => JSX.Element;

/** The seven calendar provider entries (CAL-061). */
export const CAL_ENTRIES: Array<{ key: Entry; label: string; hint: string }> = [
  { key: "google", label: "Google", hint: "Two-way: events show here, edits go back to Google" },
  { key: "outlook", label: "Outlook", hint: "Microsoft 365 and Outlook.com, two-way" },
  { key: "exchange", label: "Exchange", hint: "On-premises Exchange accounts" },
  { key: "icloud", label: "iCloud", hint: "With an app-specific password, read-only" },
  { key: "caldav", label: "CalDAV", hint: "Any CalDAV server (Nextcloud, Radicale, Fastmail), read-only" },
  { key: "holiday", label: "Holidays", hint: "Public holidays of a country or region" },
  { key: "url", label: "URL", hint: "Subscribe to any .ics or webcal link, read-only" },
];
export type Entry = "google" | "outlook" | "exchange" | "icloud" | "caldav" | "holiday" | "url";

/** Settings > Integrations & Import > Calendar: the catalogue, each entry opens its form inline (CAL-061, CAL-087). */
export function CalCatalogue({ Row }: { Row: RowC }): JSX.Element {
  const [open, setOpen] = useState<Entry | null>(null);
  return (
    <div className="cal-catalogue" data-testid="cal-catalogue">
      {CAL_ENTRIES.map((e) => (
        <div key={e.key} className={`cal-entry${open === e.key ? " open" : ""}`}>
          <button className="cal-entry-head" data-testid={`cal-entry-${e.key}`} aria-expanded={open === e.key} onClick={() => setOpen(open === e.key ? null : e.key)}>
            <span className="cal-entry-name">{e.label}</span>
            <span className="muted small grow">{e.hint}</span>
            <ChevronRight size={15} className="cal-entry-chev" />
          </button>
          {open === e.key && <CalEntryForm entry={e.key} Row={Row} onDone={() => setOpen(null)} />}
        </div>
      ))}
    </div>
  );
}

/** The form behind one catalogue entry; Integrations opens it in a dialog, the Calendar tab inline. */
export function CalEntryForm({ entry, Row, onDone }: { entry: Entry; Row: RowC; onDone: () => void }): JSX.Element {
  return (
    <div className="cal-entry-form" data-testid={`cal-form-${entry}`}>
      {entry === "url" && <UrlForm Row={Row} onDone={onDone} />}
      {entry === "holiday" && <HolidayForm Row={Row} onDone={onDone} />}
      {(entry === "caldav" || entry === "icloud") && <CalDavForm Row={Row} provider={entry} onDone={onDone} />}
      {(entry === "google" || entry === "outlook") && <OAuthConnect provider={entry} />}
      {entry === "exchange" && <ExchangeInfo />}
    </div>
  );
}

function ColorRow({ value, onPick, testId }: { value: string; onPick: (c: string) => void; testId?: string }): JSX.Element {
  return (
    <div className="cal-colors" role="radiogroup" aria-label="Colour" data-testid={testId}>
      {SOURCE_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={c} className={`cal-color${value === c ? " on" : ""}`} style={{ background: c }} data-color={c} onClick={() => onPick(c)}>
          {value === c && <Check size={11} />}
        </button>
      ))}
    </div>
  );
}

function UrlForm({ Row, onDone }: { Row: RowC; onDone: () => void }): JSX.Element {
  const app = useApp();
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(SOURCE_COLORS[0]!);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr("");
    const r = await subscribeUrl(app.engine.api, { url: url.trim(), ...(name.trim() ? { name: name.trim() } : {}), color });
    setBusy(false);
    if (!r.ok) {
      setErr(calErrorText(r));
      // a stored subscription whose first download failed stays in the list with its error
      if (r.data && (r.data as { id?: string }).id) app.toast("Subscribed, but the first download failed");
      return;
    }
    app.toast(`Subscribed to ${r.data.name}`);
    onDone();
  };
  return (
    <form onSubmit={(e) => (e.preventDefault(), void submit())}>
      <Row label="Calendar link" hint="https://, http:// or webcal://">
        <input className="field cal-wide" type="text" inputMode="url" placeholder="webcal://example.com/calendar.ics" value={url} onChange={(e) => setUrl(e.target.value)} data-testid="cal-url-input" aria-label="Calendar link" required />
      </Row>
      <Row label="Name" hint="Optional, the link's host name otherwise">
        <input className="field cal-wide" value={name} onChange={(e) => setName(e.target.value)} data-testid="cal-url-name" aria-label="Calendar name" />
      </Row>
      <Row label="Colour">
        <ColorRow value={color} onPick={setColor} testId="cal-url-colors" />
      </Row>
      {err && <div className="form-error cal-err" role="alert" data-testid="cal-form-error">{err}</div>}
      <div className="row end gap cal-form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !url.trim()} data-testid="cal-url-submit">{busy ? "Subscribing..." : "Subscribe"}</button>
      </div>
    </form>
  );
}

function HolidayForm({ Row, onDone }: { Row: RowC; onDone: () => void }): JSX.Element {
  const app = useApp();
  const { subs } = useCalSources(app.engine.api);
  const [list, setList] = useState<HolidayPreset[] | null>(null);
  const [pick, setPick] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    void presets(app.engine.api).then((r) => {
      setList(r.ok && Array.isArray(r.data) ? r.data : []);
      if (!r.ok) setErr(calErrorText(r));
    });
  }, [app.engine.api]);
  const taken = new Set(subs.map((s) => s.presetId).filter(Boolean));
  const avail = (list ?? []).filter((p) => !taken.has(p.id));
  return (
    <>
      <Row label="Region" hint={list === null ? "Loading the server's holiday calendars" : `${list.length} calendars on this server`}>
        <select className="field cal-wide" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="cal-holiday-select" aria-label="Holiday calendar">
          <option value="">Choose...</option>
          {avail.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </Row>
      {err && <div className="form-error cal-err" role="alert">{err}</div>}
      <div className="row end gap cal-form-actions">
        <button className="btn" onClick={onDone}>Cancel</button>
        <button
          className="btn primary"
          disabled={!pick}
          data-testid="cal-holiday-submit"
          onClick={async () => {
            const r = await subscribeHoliday(app.engine.api, pick);
            if (!r.ok) return setErr(calErrorText(r));
            app.toast(`Added ${r.data.name}`);
            onDone();
          }}
        >
          Add
        </button>
      </div>
    </>
  );
}

function CalDavForm({ Row, provider, onDone }: { Row: RowC; provider: "caldav" | "icloud"; onDone: () => void }): JSX.Element {
  const app = useApp();
  const [f, setF] = useState({ serverUrl: provider === "icloud" ? "https://caldav.icloud.com/" : "", username: "", password: "", name: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (): Promise<void> => {
    setBusy(true);
    setErr("");
    const r = await bindCalDav(app.engine.api, provider, { serverUrl: f.serverUrl.trim(), username: f.username.trim(), password: f.password, ...(f.name.trim() ? { name: f.name.trim() } : {}) });
    setBusy(false);
    if (!r.ok) return setErr(calErrorText(r));
    app.toast(`Connected ${r.data.displayName || r.data.account}: ${r.data.calendars.length} calendar(s)`);
    onDone();
  };
  return (
    <form onSubmit={(e) => (e.preventDefault(), void submit())} autoComplete="off">
      <Row label="Server Address">
        <input className="field cal-wide" value={f.serverUrl} onChange={(e) => setF({ ...f, serverUrl: e.target.value })} placeholder="https://dav.example.com/" aria-label="Server Address" data-testid={`${provider}-server`} required />
      </Row>
      <Row label="Account" hint={provider === "icloud" ? "Your Apple ID email" : undefined}>
        <input className="field cal-wide" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} aria-label="Account" data-testid={`${provider}-account`} required />
      </Row>
      <Row label="Password" hint={provider === "icloud" ? "An app-specific password, not your Apple ID password" : undefined}>
        <input className="field cal-wide" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-label="Password" data-testid={`${provider}-password`} autoComplete="new-password" required />
      </Row>
      <Row label="Name" hint="Optional">
        <input className="field cal-wide" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Name" data-testid={`${provider}-name`} />
      </Row>
      {provider === "icloud" && (
        <p className="muted small cal-note">
          Make an app-specific password at appleid.apple.com, under Sign-In and Security.{" "}
          <a className="link-btn" href="https://support.apple.com/en-us/102654" target="_blank" rel="noreferrer noopener">How <ExternalLink size={11} /></a>
        </p>
      )}
      {err && <div className="form-error cal-err" role="alert" data-testid="cal-form-error">{err}</div>}
      <div className="row end gap cal-form-actions">
        <button type="button" className="btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy || !f.username || !f.password || !f.serverUrl} data-testid={`${provider}-submit`}>{busy ? "Connecting..." : "Connect"}</button>
      </div>
    </form>
  );
}

const PROVIDER_NAME: Record<OAuthProvider, string> = { google: "Google", outlook: "Outlook" };

/** Google / Outlook: the server runs the OAuth flow; without client credentials on the server the entry says so. */
function OAuthConnect({ provider }: { provider: OAuthProvider }): JSX.Element {
  const app = useApp();
  const [st, setSt] = useState<OAuthStatus>("checking");
  useEffect(() => {
    let alive = true;
    void oauthStatus(app.engine.api, provider).then((s) => alive && setSt(s));
    return () => {
      alive = false;
    };
  }, [app.engine.api, provider]);
  const after = `/#${app.route.path}?modalType=settings&tabs=calendar`;
  return (
    <div className="cal-oauth" data-testid={`${provider}-connect-panel`} data-state={st}>
      {st === "not-configured" && (
        <div className="cal-notice" data-testid={`${provider}-not-configured`}>
          <b>{PROVIDER_NAME[provider]} is not configured on this server yet.</b>
          <span className="muted small">
            The server needs its own {PROVIDER_NAME[provider]} OAuth client (client id and secret in the file named by NOORTASKS_CALENDAR_OAUTH_FILE, see apps/server/CALENDAR-NOTES.md). Until then, subscribe to the calendar's secret iCal address with URL.
          </span>
        </div>
      )}
      {st === "offline" && <div className="cal-notice muted small">The server is not reachable.</div>}
      <div className="row end">
        <button className="btn primary" disabled={st !== "ready"} data-testid={`${provider}-connect`} onClick={() => (location.href = oauthStartUrl(app.engine.api, provider, after))}>
          {st === "checking" ? "Checking..." : `Connect ${PROVIDER_NAME[provider]}`}
        </button>
      </div>
    </div>
  );
}

function ExchangeInfo(): JSX.Element {
  return (
    <div className="cal-notice" data-testid="exchange-unavailable">
      <b>Exchange accounts are not available yet.</b>
      <span className="muted small">This server has no Exchange connector. Exchange Online (Microsoft 365) works through Outlook; an on-premises server with CalDAV works through CalDAV.</span>
    </div>
  );
}

// ------------------------------------------------------------------ connected calendars

function SwatchButton({ src }: { src: ExtSource }): JSX.Element {
  const app = useApp();
  const [a, setA] = useState<Anchor | null>(null);
  return (
    <>
      <button className="cal-swatch" style={{ background: src.color }} aria-label={`Colour of ${src.name}`} data-testid="cal-src-color" data-color={src.color} onClick={(e) => setA(anchorOf(e.currentTarget))} />
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} testId="cal-color-pop">
          <div className="cal-color-pop">
            <ColorRow
              value={src.color}
              onPick={(c) => {
                setA(null);
                void setSourceColor(app.engine.api, src, c).then((r) => !r.ok && app.toast(calErrorText(r)));
              }}
            />
          </div>
        </Popover>
      )}
    </>
  );
}

function SubRow({ src }: { src: ExtSource }): JSX.Element {
  const app = useApp();
  const [edit, setEdit] = useState<null | { name: string; url: string }>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="cal-src" data-testid="cal-src" data-source={src.key} data-name={src.name}>
      <div className="cal-src-line">
        <SwatchButton src={src} />
        <div className="grow cal-src-text">
          <span className="cal-src-name">{src.name}</span>
          <span className="muted small ellipsis">{src.kind === "holiday" ? "Holidays" : src.url}</span>
          {src.lastError && <span className="cal-src-err small" data-testid="cal-src-error">Last download failed: {src.lastError}</span>}
        </div>
        <Switch checked={src.show} onChange={(v) => void setShown(app.engine.api, src, v)} testId="cal-src-show" />
        <button className="icon-btn" aria-label={`Refresh ${src.name}`} title="Download again now" data-testid="cal-src-refresh" onClick={() => void refreshSub(app.engine.api, src.id).then((r) => app.toast(r.ok ? `${src.name} refreshed` : calErrorText(r)))}><RefreshCw size={14} /></button>
        <button className="btn sm" onClick={() => setEdit(edit ? null : { name: src.name, url: src.url ?? "" })} data-testid="cal-src-edit">Edit</button>
        {confirm ? (
          <button className="btn sm danger" data-testid="cal-src-delete-confirm" onClick={() => void deleteSub(app.engine.api, src.id).then((r) => app.toast(r.ok ? `Unsubscribed from ${src.name}` : calErrorText(r)))}>Remove</button>
        ) : (
          <button className="icon-btn" aria-label={`Unsubscribe ${src.name}`} title="Unsubscribe" data-testid="cal-src-delete" onClick={() => setConfirm(true)}><Trash2 size={15} /></button>
        )}
      </div>
      {edit && (
        <form
          className="cal-src-edit"
          onSubmit={(e) => {
            e.preventDefault();
            const p: { name?: string; url?: string } = {};
            if (edit.name.trim() && edit.name.trim() !== src.name) p.name = edit.name.trim();
            if (src.kind === "url" && edit.url.trim() && edit.url.trim() !== src.url) p.url = edit.url.trim();
            setEdit(null);
            if (Object.keys(p).length) void updateSub(app.engine.api, src.id, p).then((r) => !r.ok && app.toast(calErrorText(r)));
          }}
        >
          <input className="field" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} aria-label="Name" data-testid="cal-src-name-input" />
          {src.kind === "url" && <input className="field grow" value={edit.url} onChange={(e) => setEdit({ ...edit, url: e.target.value })} aria-label="Link" data-testid="cal-src-url-input" />}
          <button className="btn sm primary" type="submit" data-testid="cal-src-save">Save</button>
        </form>
      )}
    </div>
  );
}

function AccountBlock({ id }: { id: string }): JSX.Element | null {
  const app = useApp();
  const { accounts, sources } = useCalSources(app.engine.api);
  const acc = accounts.find((a) => a.id === id);
  const [confirm, setConfirm] = useState(false);
  const [bindings, setBindings] = useState<CalendarProjectBinding[]>([]);
  const twoWay = acc?.provider === "google" || acc?.provider === "outlook";
  const loadBindings = (): void => {
    if (twoWay) void listBindings(app.engine.api, id).then((r) => r.ok && Array.isArray(r.data) && setBindings(r.data));
  };
  useEffect(loadBindings, [id, twoWay]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!acc) return null;
  const cals = sources.filter((s) => s.kind === "account" && s.id === id);
  const label = { google: "Google", outlook: "Outlook", caldav: "CalDAV", icloud: "iCloud" }[acc.provider] ?? acc.provider;
  return (
    <div className="cal-account" data-testid="cal-account" data-provider={acc.provider}>
      <div className="cal-src-line">
        <span className="cal-account-badge">{label}</span>
        <div className="grow cal-src-text">
          <span className="cal-src-name">{acc.displayName || acc.email || acc.account}</span>
          <span className="muted small">{acc.needsReauth ? "Access expired: connect again" : acc.provider === "google" || acc.provider === "outlook" ? "Two-way" : "Read-only"}{acc.lastError ? ` · ${acc.lastError}` : ""}</span>
        </div>
        <Switch checked={acc.show !== false} onChange={(v) => void setShown(app.engine.api, { kind: "account", id: acc.id }, v)} testId="cal-account-show" />
        {confirm ? (
          <button className="btn sm danger" data-testid="cal-account-disconnect-confirm" onClick={() => void disconnectAccount(app.engine.api, acc.id).then((r) => app.toast(r.ok ? "Account disconnected" : calErrorText(r)))}>Disconnect</button>
        ) : (
          <button className="btn sm" data-testid="cal-account-disconnect" onClick={() => setConfirm(true)}>Disconnect</button>
        )}
      </div>
      {cals.length === 0 && <div className="muted small cal-indent">No calendars found on this account.</div>}
      {cals.map((c) => (
        <div key={c.key} className="cal-indent" data-testid="cal-src" data-source={c.key} data-name={c.name}>
          <div className="cal-src-line">
            <SwatchButton src={c} />
            <span className="grow cal-src-name">{c.name}{c.readOnly && acc.provider !== "caldav" && acc.provider !== "icloud" ? <span className="muted small"> · read-only</span> : null}</span>
            <Switch checked={c.show} onChange={(v) => void setShown(app.engine.api, c, v)} testId="cal-src-show" />
          </div>
          {twoWay && !c.readOnly && <BindingRow accountId={acc.id} calendarId={c.calendarId!} bindings={bindings} reload={loadBindings} />}
        </div>
      ))}
      {twoWay && bindings.length > 0 && (
        <div className="row end cal-indent">
          <button className="btn sm" data-testid="cal-account-sync" onClick={() => void syncAccount(app.engine.api, acc.id).then((r) => app.toast(r.ok ? `Synced: ${r.data.pulled} in, ${r.data.pushed} out` : calErrorText(r)))}><RefreshCw size={13} /> Sync now</button>
        </div>
      )}
    </div>
  );
}

/**
 * Two-way link of one remote calendar to a list (or to All, routing by ~list and #tag in the title). A link
 * cannot be edited in place: unlink and link again (CAL-070); unlinking keeps tasks and events on both sides.
 */
function BindingRow({ accountId, calendarId, bindings, reload }: { accountId: string; calendarId: string; bindings: CalendarProjectBinding[]; reload: () => void }): JSX.Element {
  const app = useApp();
  const b = bindings.find((x) => x.calendarId === calendarId);
  const [target, setTarget] = useState("");
  const [tags, setTags] = useState("");
  const listName = (pid?: string | null): string => (!pid || pid === app.inboxId ? "Inbox" : app.projects.find((p) => p.id === pid)?.name ?? "a list");
  if (b)
    return (
      <div className="cal-bind" data-testid="cal-binding">
        <span className="muted small grow">
          Two-way with {b.syncProjectScope === "all" ? "All lists (~list and #tag in titles)" : listName(b.syncProjectId)}
          {b.defaultTags.length ? ` · tags ${b.defaultTags.map((t) => `#${t}`).join(" ")}` : ""}
        </span>
        <button className="btn sm" data-testid="cal-unbind" onClick={() => void unbindProject(app.engine.api, accountId, b.id).then((r) => (r.ok ? (app.toast("Unlinked; tasks and events stay"), reload()) : app.toast(calErrorText(r))))}>Unlink</button>
      </div>
    );
  return (
    <div className="cal-bind" data-testid="cal-bind-form">
      <select className="field" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Sync with list" data-testid="cal-bind-target">
        <option value="">Show only (no tasks)</option>
        <option value="all">Two-way with All lists</option>
        <option value={app.inboxId}>Two-way with Inbox</option>
        {app.projects.filter((p) => !p.closed).map((p) => (
          <option key={p.id} value={p.id}>Two-way with {p.name}</option>
        ))}
      </select>
      {target && <input className="field" placeholder="Default tags, e.g. gcal" value={tags} onChange={(e) => setTags(e.target.value)} aria-label="Default tags" data-testid="cal-bind-tags" />}
      {target && (
        <button
          className="btn sm primary"
          data-testid="cal-bind-save"
          onClick={() =>
            void bindProject(app.engine.api, accountId, {
              calendarId,
              syncProjectScope: target === "all" ? "all" : "project",
              ...(target === "all" ? {} : { syncProjectId: target }),
              defaultTags: tags.split(/[\s,#]+/).map((t) => t.trim()).filter(Boolean),
            }).then((r) => (r.ok ? (app.toast("Linked: events from today on become tasks"), setTarget(""), setTags(""), reload()) : app.toast(calErrorText(r))))
          }
        >
          Link
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ outgoing feed

export function FeedSection({ Row }: { Row: RowC }): JSX.Element {
  const app = useApp();
  const api = app.engine.api;
  const [feed, setFeed] = useState<FeedState | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    void getFeed(api).then((r) => (r.ok ? setFeed(r.data) : setErr(calErrorText(r))));
  }, [api]);
  const link = feedLink(feed?.url, location.origin);
  const apply = (r: { ok: boolean; data: FeedState | unknown; error?: string; message?: string; status: number }): void => {
    if (r.ok) {
      setFeed(r.data as FeedState);
      setErr("");
    } else setErr(calErrorText(r));
  };
  const lists = [{ id: "inbox", name: "Inbox" }, ...app.projects.filter((p) => !p.closed).sort((a, b) => a.sortOrder - b.sortOrder).map((p) => ({ id: p.id, name: p.name }))];
  const chosen = feed?.projectIds ?? null;
  const toggleList = (id: string): void => {
    const all = lists.map((l) => l.id);
    const cur = new Set(chosen ?? all);
    if (cur.has(id)) cur.delete(id);
    else cur.add(id);
    const next = all.every((x) => cur.has(x)) ? null : all.filter((x) => cur.has(x));
    setFeed(feed ? { ...feed, projectIds: next } : feed);
    void updateFeed(api, { projectIds: next }).then(apply);
  };
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
      app.toast("Link copied");
    } catch {
      (document.querySelector("[data-testid=feed-url]") as HTMLInputElement | null)?.select();
      app.toast("Select the link and copy it");
    }
  };
  return (
    <div data-testid="feed-section">
      {!feed?.url ? (
        <Row label="Private calendar link" hint="Show your dated tasks in Google Calendar, Apple Calendar or Outlook. Anyone with the link can read those tasks.">
          <button className="btn sm primary" data-testid="feed-create" onClick={() => void newFeed(api, {}).then(apply)}><Link2 size={14} /> Create link</button>
        </Row>
      ) : (
        <>
          <Row label="Private calendar link" hint="Paste it into your calendar app as a subscription (From URL). Keep it secret.">
            <div className="row gap cal-feed-actions">
              <button className="btn sm" data-testid="feed-copy" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}</button>
              {confirmReset ? (
                <button className="btn sm danger" data-testid="feed-reset-confirm" onClick={() => (setConfirmReset(false), void newFeed(api, {}).then((r) => (apply(r), r.ok && app.toast("New link made; the old one stopped working"))))}>Make new link</button>
              ) : (
                <button className="btn sm" data-testid="feed-reset" title="The old link stops working" onClick={() => setConfirmReset(true)}><RefreshCw size={14} /> Reset</button>
              )}
              <button className="btn sm" data-testid="feed-revoke" onClick={() => void cancelFeed(api).then((r) => (r.ok ? (setFeed({ code: null, url: null, includeDone: false, includeHabits: false, projectIds: null }), app.toast("Link turned off")) : setErr(calErrorText(r))))}>Turn off</button>
            </div>
          </Row>
          <div className="set-sub">
            <input className="field full cal-feed-url" readOnly value={link} data-testid="feed-url" aria-label="Private calendar link" onFocus={(e) => e.currentTarget.select()} />
          </div>
          <Row label="Include completed tasks">
            <Switch checked={!!feed.includeDone} onChange={(v) => (setFeed({ ...feed, includeDone: v }), void updateFeed(api, { includeDone: v }).then(apply))} testId="feed-include-done" />
          </Row>
          <Row label="Include habits">
            <Switch checked={!!feed.includeHabits} onChange={(v) => (setFeed({ ...feed, includeHabits: v }), void updateFeed(api, { includeHabits: v }).then(apply))} testId="feed-include-habits" />
          </Row>
          <Row label="Lists in the feed" hint={chosen === null ? "All lists" : `${chosen.length} of ${lists.length} lists`}>
            <span />
          </Row>
          <div className="set-sub cal-feed-lists" data-testid="feed-lists">
            {lists.map((l) => (
              <label key={l.id} className="check-row">
                <input type="checkbox" checked={chosen === null || chosen.includes(l.id)} onChange={() => toggleList(l.id)} /> {l.name}
              </label>
            ))}
          </div>
        </>
      )}
      {err && <div className="form-error cal-err" role="alert">{err}</div>}
    </div>
  );
}

/** Settings > Calendar: add, the connected calendars, the outgoing feed and the display switches. */
export function CalendarTab({ Row }: { Row: RowC }): JSX.Element {
  const app = useApp();
  const { sources, accounts, loaded } = useCalSources(app.engine.api);
  const feeds = sources.filter((s) => s.kind !== "account");
  const conf = (app.settings.calendarViewConf ?? {}) as Record<string, unknown>;
  return (
    <div className="cal-settings" data-testid="cal-settings">
      <h4 className="set-group">Subscribed calendars</h4>
      {loaded && feeds.length === 0 && accounts.length === 0 && <p className="muted small cal-empty" data-testid="cal-none">No calendars yet. Add one below.</p>}
      <div data-testid="cal-sources">
        {feeds.map((s) => (
          <SubRow key={s.key} src={s} />
        ))}
        {accounts.map((a) => (
          <AccountBlock key={a.id} id={a.id} />
        ))}
      </div>
      <h4 className="set-group">Add a calendar</h4>
      <CalCatalogue Row={Row} />
      <h4 className="set-group">Subscribe to NoorTasks in another calendar</h4>
      <FeedSection Row={Row} />
      <h4 className="set-group">Display</h4>
      <Row label="Show holidays" hint="Holiday calendars in the calendar, Today and the sidebar">
        <Switch checked={app.settings.holidayEnabled !== false} onChange={(v) => void app.repo.setSettings({ holidayEnabled: v })} testId="set-holiday-enabled" />
      </Row>
      <Row label="Show declined events" hint="Invitations you declined in a connected calendar">
        <Switch checked={!!conf.showDeclinedEvents} onChange={(v) => void app.repo.setSettings({ calendarViewConf: { ...conf, showDeclinedEvents: v } } as never)} testId="set-show-declined" />
      </Row>
    </div>
  );
}
