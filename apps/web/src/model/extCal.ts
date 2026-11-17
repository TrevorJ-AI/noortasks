import type { CalendarAccount, CalendarEventItem, CalendarSubscription } from "../lib/core";
import { DAY, addDays, startOfDay } from "../lib/dates";
import type { SubscribedEvent } from "./calendar";

/**
 * External calendars on the client (CAL-064..081): subscriptions (ICS URL and holiday feeds) and connected
 * accounts (Google, Outlook, CalDAV, iCloud) become a flat list of sources; wire events from the server are
 * filtered by the live source list (show / hide, holidays switch) and coloured from it, so a change in
 * settings applies at once without a refetch.
 */

/** Sidebar / list-type item numbers per provider (CAL-077). */
export const SOURCE_ITEM_TYPE = { url: 5, holiday: 5, google: 6, caldav: 7, outlook: 8, exchange: 9, icloud: 10 } as const;
export function providerItemType(provider: string): number {
  return (SOURCE_ITEM_TYPE as Record<string, number>)[provider] ?? 5;
}

/** Colour choices for calendars: the list colours of the app, readable in light and dark themes. */
export const SOURCE_COLORS = ["#2f6f5e", "#3fa66b", "#e5484d", "#e2b714", "#8e5bd8", "#2f8fbf", "#ef7d31", "#d6408b", "#5f6b7a", "#14a3a3"];

/** A stable default colour for a source without one. */
export function defaultSourceColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return SOURCE_COLORS[h % SOURCE_COLORS.length]!;
}

export type SourceKind = "url" | "holiday" | "account";

export interface ExtSource {
  /** subscription id, or accountId + ":" + calendarId for an account calendar */
  key: string;
  kind: SourceKind;
  /** subscription id or account id */
  id: string;
  calendarId?: string;
  provider: string;
  itemType: number;
  name: string;
  /** account display name for account calendars */
  group?: string;
  color: string;
  show: boolean;
  /** events cannot be edited here (ICS, holidays, CalDAV, iCloud, read-only remote calendars) */
  readOnly: boolean;
  lastError?: string | null;
  url?: string;
}

/** Source key of a wire event: subscription id for feeds, account:calendar for accounts. */
export function eventSourceKey(e: Pick<CalendarEventItem, "sourceId" | "accountId" | "calendarId">): string {
  return e.accountId ? `${e.accountId}:${e.calendarId ?? ""}` : e.sourceId;
}

const TWO_WAY = new Set(["google", "outlook"]);

/** Flatten subscriptions and account calendars into sources, in sidebar order (feeds first, then accounts). */
export function buildSources(subs: readonly CalendarSubscription[], accounts: readonly CalendarAccount[]): ExtSource[] {
  const out: ExtSource[] = [];
  for (const s of [...subs].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
    out.push({
      key: s.id,
      kind: s.kind === "holiday" ? "holiday" : "url",
      id: s.id,
      provider: s.kind === "holiday" ? "holiday" : "url",
      itemType: providerItemType("url"),
      name: s.name || s.url,
      color: s.color || defaultSourceColor(s.id),
      show: s.show !== false,
      readOnly: true,
      lastError: s.lastError ?? null,
      url: s.url,
    });
  }
  for (const a of accounts) {
    for (const c of a.calendars ?? []) {
      out.push({
        key: `${a.id}:${c.id}`,
        kind: "account",
        id: a.id,
        calendarId: c.id,
        provider: a.provider,
        itemType: a.itemType || providerItemType(a.provider),
        name: c.name || c.id,
        group: a.displayName || a.email || a.account,
        color: c.color || defaultSourceColor(`${a.id}:${c.id}`),
        show: a.show !== false && c.show !== false,
        readOnly: !TWO_WAY.has(a.provider) || c.readOnly === true,
        lastError: a.lastError ?? null,
      });
    }
  }
  return out;
}

/**
 * The calendar date span of an all-day event in this browser's zone. The server sends all-day events as
 * midnights in the account time zone; when that zone differs from the browser's, the raw instants fall a few
 * hours off local midnight and a one-day event would cover two columns. Snap each edge to the nearest local
 * midnight (exact for zone differences under 12 hours) and keep at least one day.
 */
export function snapAllDay(start: number, end: number): { start: number; end: number } {
  const s = startOfDay(start + DAY / 2);
  let e = startOfDay(end + DAY / 2);
  if (e <= s) e = addDays(s, 1);
  return { start: s, end: e };
}

export interface ExtEvent extends SubscribedEvent {
  color: string;
  source: ExtSource;
  wire: CalendarEventItem;
  readOnly: boolean;
}

export interface FilterOpts {
  /** Settings > Date & Time > Show holidays (holidayEnabled, CAL-050) */
  holidayEnabled?: boolean;
  /** calendarViewConf.showDeclinedEvents (CAL-028) */
  showDeclined?: boolean;
  /** keep events of hidden calendars (a single calendar's list route) */
  includeHidden?: boolean;
}

/**
 * Wire events to drawable events: dropped when the source is unknown or hidden, holidays dropped when the
 * holidays switch is off, declined invitations dropped unless shown; colour from the live source; all-day spans
 * snapped to local dates; duplicates (same key) kept once.
 */
export function visibleEvents(events: readonly CalendarEventItem[], sources: readonly ExtSource[], opts: FilterOpts = {}): ExtEvent[] {
  const byKey = new Map(sources.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const out: ExtEvent[] = [];
  for (const w of events) {
    const src = byKey.get(eventSourceKey(w));
    if (!src || (!src.show && !opts.includeHidden)) continue;
    if (src.kind === "holiday" && opts.holidayEnabled === false) continue;
    if (w.partStat === "declined" && !opts.showDeclined) continue;
    if (w.status === "cancelled") continue;
    const key = w.key || `${src.kind === "account" ? "acc" : "sub"}:${w.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const allDay = w.allDay ?? w.isAllDay ?? false;
    const span = allDay ? snapAllDay(w.start, w.end) : { start: w.start, end: Math.max(w.end, w.start + 15 * 60_000) };
    out.push({ id: key, title: w.title || "(No title)", start: span.start, end: span.end, allDay, color: src.color, source: src, wire: w, readOnly: src.readOnly || w.readOnly !== false });
  }
  out.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
  return out;
}

/** Local day starts covered by events, with the first event colour per day (year view, mini calendar). */
export function eventDays(events: readonly ExtEvent[], from: number, to: number): Map<number, string> {
  const m = new Map<number, string>();
  for (const e of events) {
    const last = e.allDay ? addDays(e.end, -1) : e.end - 1;
    for (let d = Math.max(startOfDay(e.start), startOfDay(from)); d <= startOfDay(last) && d < to; d = addDays(d, 1)) if (!m.has(d)) m.set(d, e.color);
  }
  return m;
}

export interface EventEdit {
  title: string;
  allDay: boolean;
  start: number;
  end: number;
  location: string;
  description: string;
}

/**
 * Body for PUT /api/v2/calendar/accounts/{accountId}/events/{externalId} on a two-way account: only the changed
 * fields plus the calendar id, all-day ends exclusive at local midnight, an end never before the start.
 */
export function eventPatch(e: ExtEvent, edit: EventEdit): Record<string, unknown> {
  const body: Record<string, unknown> = { calendarId: e.wire.calendarId ?? e.source.calendarId };
  const trimmed = edit.title.trim();
  if (trimmed && trimmed !== e.wire.title) body.title = trimmed;
  if ((edit.location ?? "") !== (e.wire.location ?? "")) body.location = edit.location;
  if ((edit.description ?? "") !== (e.wire.description ?? "")) body.description = edit.description;
  let s = edit.start;
  let en = edit.end;
  if (edit.allDay) {
    s = startOfDay(s);
    en = Math.max(addDays(s, 1), startOfDay(en) === en ? en : addDays(startOfDay(en), 1));
  } else if (en <= s) en = s + 30 * 60_000;
  if (edit.allDay !== e.allDay || s !== e.start || en !== e.end) {
    body.isAllDay = edit.allDay;
    body.start = s;
    body.end = en;
  }
  return body;
}

/** The ICS feed link shown and copied in settings: the server returns a path, the link needs the origin. */
export function feedLink(url: string | null | undefined, origin: string): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return origin.replace(/\/$/, "") + (url.startsWith("/") ? url : `/${url}`);
}

/** Route segment per source type for the subscribed list routes (CAL-078). */
export function sourceRoute(s: Pick<ExtSource, "kind" | "provider" | "id" | "key">): string {
  if (s.kind !== "account") return `q/${s.id}/subscribe-calendar`;
  if (s.provider === "caldav" || s.provider === "icloud") return `q/${s.id}/subscribe-cal-dav`;
  return `q/${s.id}/subscribe-account-calendar`;
}
