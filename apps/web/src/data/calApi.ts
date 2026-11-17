import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CalendarAccount, CalendarEventItem, CalendarFeedConfig, CalendarProjectBinding, CalendarSubscription, HolidayPreset } from "../lib/core";
import { buildSources, visibleEvents, type ExtEvent, type ExtSource, type FilterOpts } from "../model/extCal";
import type { Api } from "./api";

/**
 * Calendar integration calls (server `/api/v2/calendar/*`, `/api/v4/calendar/*`). These go through their own
 * request helper because the shared client turns every 5xx into "offline" and drops the body, while here the
 * 503 oauth_not_configured and the 502 feed / CalDAV errors must reach the screen.
 */

export interface CalResult<T> {
  ok: boolean;
  status: number;
  data: T;
  /** server errorCode, "offline" when the request never reached the server */
  error?: string;
  message?: string;
}

function csrf(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const m = /(?:^|;\s*)_csrf_token=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]!) : undefined;
}

export async function calReq<T = unknown>(api: Api, method: string, path: string, body?: unknown): Promise<CalResult<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const t = csrf();
  if (t) headers["X-Csrftoken"] = t;
  let res: Response;
  try {
    res = await fetch(api.base + path, { method, headers, credentials: "include", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, data: undefined as T, error: "offline", message: String(e) };
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (res.ok) return { ok: true, status: res.status, data: data as T };
  const err = (data ?? {}) as { errorCode?: string; errorMessage?: string };
  return { ok: false, status: res.status, data: data as T, error: err.errorCode ?? `http_${res.status}`, message: err.errorMessage ?? err.errorCode ?? `HTTP ${res.status}` };
}

/** Readable text for a calendar error code. */
export function calErrorText(r: Pick<CalResult<unknown>, "error" | "message" | "status">): string {
  switch (r.error) {
    case "offline":
      return "The server is not reachable.";
    case "invalid_calendar_url":
      return "That is not a calendar link. Use an https, http or webcal address of an .ics file.";
    case "calendar_fetch_failed":
      return `The calendar could not be downloaded (${r.message ?? "no answer"}).`;
    case "invalid_ics_payload":
      return "The link answered, but not with an iCalendar file.";
    case "caldav_auth_failed":
      return "The server refused the account or password.";
    case "caldav_connection_failed":
      return "The CalDAV server could not be reached.";
    case "invalid_caldav_credentials":
      return "Enter the account and the password.";
    case "invalid_caldav_url":
      return "Enter the server address.";
    case "oauth_not_configured":
      return "Not configured on this server yet.";
    case "read_only_provider":
      return "This calendar is read-only.";
    case "oauth_token_revoked":
      return "Access was revoked. Connect the account again.";
    default:
      return r.message || `Request failed (${r.status}).`;
  }
}

// ------------------------------------------------------------------ shared store (sources + event windows)

interface State {
  subs: CalendarSubscription[];
  accounts: CalendarAccount[];
  loaded: boolean;
  /** bumped whenever events must be fetched again */
  version: number;
}

let state: State = { subs: [], accounts: [], loaded: false, version: 0 };
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
const set = (p: Partial<State>): void => {
  state = { ...state, ...p };
  emit();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
let loading: Promise<void> | null = null;

/** Load (or reload) subscriptions and accounts. */
export function reloadSources(api: Api): Promise<void> {
  loading = (async () => {
    const [s, a] = await Promise.all([calReq<CalendarSubscription[]>(api, "GET", "/api/v2/calendar/subscription"), calReq<CalendarAccount[]>(api, "GET", "/api/v2/calendar/third/accounts")]);
    set({ subs: s.ok && Array.isArray(s.data) ? s.data : state.subs, accounts: a.ok && Array.isArray(a.data) ? a.data : state.accounts, loaded: state.loaded || (s.ok && a.ok) });
  })().finally(() => {
    loading = null;
  });
  return loading;
}

/** Ask every mounted view to fetch its event window again (after a subscribe, an account change, an edit). */
export function refreshEvents(): void {
  windowCache.clear();
  set({ version: state.version + 1 });
}

/** Local edits that apply before the server answers (show / hide, colour, rename). */
export function patchSub(id: string, p: Partial<CalendarSubscription>): void {
  set({ subs: state.subs.map((s) => (s.id === id ? { ...s, ...p } : s)) });
}
export function patchAccount(id: string, p: Partial<CalendarAccount>): void {
  set({ accounts: state.accounts.map((a) => (a.id === id ? { ...a, ...p } : a)) });
}
export function removeSub(id: string): void {
  set({ subs: state.subs.filter((s) => s.id !== id) });
}
export function removeAccount(id: string): void {
  set({ accounts: state.accounts.filter((a) => a.id !== id) });
}
export function upsertSub(s: CalendarSubscription): void {
  set({ subs: state.subs.some((x) => x.id === s.id) ? state.subs.map((x) => (x.id === s.id ? s : x)) : [...state.subs, s] });
}
export function upsertAccount(a: CalendarAccount): void {
  set({ accounts: state.accounts.some((x) => x.id === a.id) ? state.accounts.map((x) => (x.id === a.id ? a : x)) : [...state.accounts, a] });
}

/** Subscriptions, accounts and the flattened source list; loads once per page. */
export function useCalSources(api: Api): { subs: CalendarSubscription[]; accounts: CalendarAccount[]; sources: ExtSource[]; loaded: boolean } {
  const st = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!st.loaded && !loading) void reloadSources(api);
  }, [api, st.loaded]);
  const sources = useMemo(() => buildSources(st.subs, st.accounts), [st.subs, st.accounts]);
  return { subs: st.subs, accounts: st.accounts, sources, loaded: st.loaded };
}

// event windows: one request pair per visible range, cached until something changes
const windowCache = new Map<string, Promise<CalendarEventItem[]>>();

async function fetchWindow(api: Api, from: number, to: number): Promise<CalendarEventItem[]> {
  const q = `from=${from}&to=${to}`;
  const [subs, accs] = await Promise.all([
    // hidden feeds come along so show / hide is instant; the filter below drops them
    calReq<CalendarEventItem[]>(api, "GET", `/api/v2/calendar/subscribe/events?${q}&includeHidden=true&showDeclined=true`),
    calReq<CalendarEventItem[]>(api, "GET", `/api/v2/calendar/bind/events/all?${q}&showDeclined=true`),
  ]);
  if (!subs.ok && !accs.ok) throw new Error(subs.error ?? "offline");
  return [...(subs.ok && Array.isArray(subs.data) ? subs.data : []), ...(accs.ok && Array.isArray(accs.data) ? accs.data : [])];
}

/** External events inside [from, to), filtered and coloured by the live source list. */
export function useExtEvents(api: Api, from: number, to: number, opts: FilterOpts = {}): ExtEvent[] {
  const { sources, subs, accounts, loaded } = useCalSources(api);
  const version = useSyncExternalStore(subscribe, () => state.version);
  const [raw, setRaw] = useState<CalendarEventItem[]>([]);
  const hasSources = subs.length + accounts.length > 0;
  useEffect(() => {
    if (!loaded || !hasSources) {
      setRaw([]);
      return;
    }
    let alive = true;
    const key = `${from}|${to}`;
    let p = windowCache.get(key);
    if (!p) {
      p = fetchWindow(api, from, to);
      windowCache.set(key, p);
      p.catch(() => windowCache.delete(key));
    }
    p.then(
      (rows) => alive && setRaw(rows),
      () => {
        /* offline: keep what is drawn */
      },
    );
    return () => {
      alive = false;
    };
  }, [api, from, to, version, loaded, hasSources]);
  return useMemo(() => visibleEvents(raw, sources, opts), [raw, sources, opts.holidayEnabled, opts.showDeclined, opts.includeHidden]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ------------------------------------------------------------------ actions

export async function subscribeUrl(api: Api, body: { url: string; name?: string; color?: string | null; kind?: string }): Promise<CalResult<CalendarSubscription>> {
  const r = await calReq<CalendarSubscription>(api, "POST", "/api/v2/calendar/subscribe", body);
  if (r.ok) {
    upsertSub(r.data);
    // check the feed once so a dead link shows its error at once, then draw its events
    const probe = await calReq(api, "GET", `/api/v2/calendar/subscribe/events/${r.data.id}?from=${Date.now()}&to=${Date.now() + 86_400_000}`);
    if (!probe.ok) {
      void reloadSources(api);
      return { ...probe, data: r.data } as CalResult<CalendarSubscription>;
    }
    void reloadSources(api);
    refreshEvents();
  }
  return r;
}

export async function subscribeHoliday(api: Api, presetId: string, color?: string): Promise<CalResult<CalendarSubscription>> {
  const r = await calReq<CalendarSubscription>(api, "POST", "/api/v2/calendar/holiday/subscribe", { presetId, ...(color ? { color } : {}) });
  if (r.ok) {
    upsertSub(r.data);
    refreshEvents();
  }
  return r;
}

export async function updateSub(api: Api, id: string, p: { name?: string; url?: string; color?: string | null }): Promise<CalResult<CalendarSubscription>> {
  patchSub(id, p as Partial<CalendarSubscription>);
  const r = await calReq<CalendarSubscription>(api, "PUT", `/api/v2/calendar/subscription/${id}`, p);
  if (r.ok) {
    upsertSub(r.data);
    if (p.url !== undefined) refreshEvents();
  } else void reloadSources(api);
  return r;
}

export async function deleteSub(api: Api, id: string): Promise<CalResult<unknown>> {
  removeSub(id);
  const r = await calReq(api, "DELETE", `/api/v2/calendar/unsubscribe/${id}`);
  if (!r.ok) void reloadSources(api);
  return r;
}

/** Show or hide a feed, a whole account, or one account calendar (PUT /calendar/batch/{id}/show, explicit show). */
export async function setShown(api: Api, src: Pick<ExtSource, "kind" | "id" | "calendarId">, show: boolean): Promise<CalResult<unknown>> {
  if (src.kind !== "account") {
    patchSub(src.id, { show, hidden: !show });
    const r = await calReq(api, "PUT", `/api/v2/calendar/batch/${src.id}/show?isMobile=false`, { show });
    if (!r.ok) void reloadSources(api);
    return r;
  }
  const acc = state.accounts.find((a) => a.id === src.id);
  if (acc) patchAccount(src.id, src.calendarId ? { calendars: acc.calendars.map((c) => (c.id === src.calendarId ? { ...c, show } : c)) } : { show });
  const r = await calReq(api, "PUT", `/api/v2/calendar/batch/${src.id}/show?isMobile=false`, src.calendarId ? { show, calendarId: src.calendarId } : { show });
  // account events are filtered on the server: fetch again after a change
  if (r.ok) refreshEvents();
  else void reloadSources(api);
  return r;
}

/** Colour of a feed (PUT subscription) or of one account calendar (POST /api/v4/calendar/update/{id} with the calendars list). */
export async function setSourceColor(api: Api, src: Pick<ExtSource, "kind" | "id" | "calendarId">, color: string): Promise<CalResult<unknown>> {
  if (src.kind !== "account") return updateSub(api, src.id, { color });
  const acc = state.accounts.find((a) => a.id === src.id);
  if (!acc) return { ok: false, status: 404, data: undefined, error: "account_not_found" };
  const calendars = acc.calendars.map((c) => (c.id === src.calendarId ? { ...c, color } : c));
  patchAccount(src.id, { calendars });
  const r = await calReq<CalendarAccount>(api, "POST", `/api/v4/calendar/update/${src.id}`, { calendars });
  if (r.ok && r.data?.id) upsertAccount(r.data);
  else if (!r.ok) void reloadSources(api);
  return r;
}

export async function bindCalDav(api: Api, provider: "caldav" | "icloud", body: { serverUrl?: string; username: string; password: string; name?: string }): Promise<CalResult<CalendarAccount>> {
  const r = await calReq<CalendarAccount>(api, "POST", provider === "icloud" ? "/api/v4/calendar/bind/icloud" : "/api/v4/calendar/bind", { ...body, provider });
  if (r.ok) {
    upsertAccount(r.data);
    refreshEvents();
  }
  return r;
}

export async function disconnectAccount(api: Api, id: string): Promise<CalResult<unknown>> {
  removeAccount(id);
  const r = await calReq(api, "DELETE", `/api/v2/calendar/connect/${id}`);
  refreshEvents();
  if (!r.ok) void reloadSources(api);
  return r;
}

export const presets = (api: Api): Promise<CalResult<HolidayPreset[]>> => calReq<HolidayPreset[]>(api, "GET", "/api/v2/calendar/holidays/presets");

export type OAuthProvider = "google" | "outlook";
/** "ready" when the server has client credentials; probing mints a short-lived state row (see CAL-COVERAGE server notes). */
export type OAuthStatus = "checking" | "ready" | "not-configured" | "offline";
export async function oauthStatus(api: Api, provider: OAuthProvider): Promise<OAuthStatus> {
  const r = await calReq(api, "GET", `/api/v2/calendar/oauth/${provider}/start`);
  if (r.ok) return "ready";
  if (r.error === "oauth_not_configured") return "not-configured";
  return r.error === "offline" ? "offline" : "not-configured";
}
/** Full-page start of the OAuth flow; the server callback sends the browser back to `after` (a path on this origin). */
export function oauthStartUrl(api: Api, provider: OAuthProvider, after: string): string {
  return `${api.base}/api/v2/calendar/oauth/${provider}/start?redirect=true&redirectAfter=${encodeURIComponent(after)}`;
}

// ------------------------------------------------------------------ outgoing feed

export interface FeedState {
  code: string | null;
  url: string | null;
  enabled?: boolean;
  includeDone: boolean;
  includeHabits: boolean;
  projectIds: string[] | null;
}
export const getFeed = (api: Api): Promise<CalResult<FeedState>> => calReq<FeedState>(api, "GET", "/api/v2/calendar/feeds/code");
export const newFeed = (api: Api, p: Partial<Pick<FeedState, "includeDone" | "includeHabits" | "projectIds">> = {}): Promise<CalResult<CalendarFeedConfig>> =>
  calReq<CalendarFeedConfig>(api, "POST", `/api/v2/calendar/feeds/code/new`, p);
export const updateFeed = (api: Api, p: Partial<Pick<FeedState, "includeDone" | "includeHabits" | "projectIds">>): Promise<CalResult<CalendarFeedConfig>> =>
  calReq<CalendarFeedConfig>(api, "PUT", "/api/v2/calendar/feeds/settings", p);
export const cancelFeed = (api: Api): Promise<CalResult<{ cancelled: boolean }>> => calReq<{ cancelled: boolean }>(api, "DELETE", "/api/v2/calendar/feeds/cancel");

// ------------------------------------------------------------------ two-way event edits

export async function saveEvent(api: Api, e: ExtEvent, body: Record<string, unknown>): Promise<CalResult<unknown>> {
  const id = e.wire.uid ?? e.wire.id.split(":").slice(2).join(":");
  const r = await calReq(api, "PUT", `/api/v2/calendar/accounts/${e.source.id}/events/${encodeURIComponent(id)}`, body);
  if (r.ok) refreshEvents();
  return r;
}
export async function deleteEvent(api: Api, e: ExtEvent): Promise<CalResult<unknown>> {
  const id = e.wire.uid ?? e.wire.id.split(":").slice(2).join(":");
  const r = await calReq(api, "DELETE", `/api/v2/calendar/accounts/${e.source.id}/events/${encodeURIComponent(id)}?calendarId=${encodeURIComponent(e.wire.calendarId ?? e.source.calendarId ?? "")}`);
  if (r.ok) refreshEvents();
  return r;
}

/** Test hook: forget everything (unit tests and sign-out). */
export function resetCalStore(): void {
  windowCache.clear();
  state = { subs: [], accounts: [], loaded: false, version: 0 };
  emit();
}

// ------------------------------------------------------------------ two-way bindings to lists (CAL-069, CAL-070, CAL-075)

export const listBindings = (api: Api, accountId: string): Promise<CalResult<CalendarProjectBinding[]>> => calReq<CalendarProjectBinding[]>(api, "GET", `/api/v2/calendar/${accountId}/bind/project`);
export const bindProject = (api: Api, accountId: string, body: { calendarId: string; syncProjectScope: "all" | "project"; syncProjectId?: string; defaultTags: string[] }): Promise<CalResult<CalendarProjectBinding>> =>
  calReq<CalendarProjectBinding>(api, "POST", `/api/v2/calendar/${accountId}/bind/project`, body);
export const unbindProject = (api: Api, accountId: string, bindingId: string): Promise<CalResult<{ unlinked: boolean }>> => calReq<{ unlinked: boolean }>(api, "DELETE", `/api/v2/calendar/${accountId}/bind/project?id=${encodeURIComponent(bindingId)}`);
export async function syncAccount(api: Api, accountId: string): Promise<CalResult<{ pulled: number; pushed: number; updated: number; deleted: number }>> {
  const now = Date.now();
  const r = await calReq<{ pulled: number; pushed: number; updated: number; deleted: number }>(api, "POST", `/api/v2/calendar/accounts/${accountId}/sync`, { from: now - 86_400_000, to: now + 90 * 86_400_000 });
  if (r.ok) refreshEvents();
  return r;
}
/** Download a feed again now instead of waiting for the 15-minute cache (CAL-067). */
export async function refreshSub(api: Api, id: string): Promise<CalResult<unknown>> {
  const now = Date.now();
  const r = await calReq(api, "GET", `/api/v2/calendar/subscribe/events/${id}?from=${now}&to=${now + 86_400_000}&refresh=true`);
  void reloadSources(api);
  if (r.ok) refreshEvents();
  return r;
}
