import { readFileSync } from "node:fs";
import { addDays, isValidTimeZone, makeStamp, parseStamp, wallToInstant, zonedParts, type CalendarAccountCalendar, type Loose } from "@noortasks/core";
import { parseAndExpandIcs } from "./calendar-ics.js";
import {
  buildPropfindCalendarsXml,
  buildPropfindHomeSetXml,
  buildPropfindPrincipalXml,
  buildReportCalendarQueryXml,
  findAll,
  findFirst,
  parseXml,
  textOf,
} from "./calendar-xml.js";

export type FetchLike = typeof fetch;

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
  tenant?: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  userInfoUrl?: string;
  apiBaseUrl: string;
  scopes: string[];
}

export interface CalendarOAuthConfig {
  google?: OAuthProviderConfig;
  outlook?: OAuthProviderConfig;
}

function normalizeProviderConfig(provider: "google" | "outlook", raw: unknown): OAuthProviderConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const clientId = typeof r.clientId === "string" ? r.clientId.trim() : "";
  const clientSecret = typeof r.clientSecret === "string" ? r.clientSecret.trim() : "";
  if (!clientId || !clientSecret) return undefined;

  if (provider === "google") {
    return {
      clientId,
      clientSecret,
      ...(typeof r.redirectUri === "string" && r.redirectUri ? { redirectUri: r.redirectUri.trim() } : {}),
      authUrl: typeof r.authUrl === "string" && r.authUrl ? r.authUrl : "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: typeof r.tokenUrl === "string" && r.tokenUrl ? r.tokenUrl : "https://oauth2.googleapis.com/token",
      revokeUrl: typeof r.revokeUrl === "string" && r.revokeUrl ? r.revokeUrl : "https://oauth2.googleapis.com/revoke",
      userInfoUrl: typeof r.userInfoUrl === "string" && r.userInfoUrl ? r.userInfoUrl : "https://www.googleapis.com/oauth2/v2/userinfo",
      apiBaseUrl: typeof r.apiBaseUrl === "string" && r.apiBaseUrl ? r.apiBaseUrl.replace(/\/+$/, "") : "https://www.googleapis.com/calendar/v3",
      scopes: Array.isArray(r.scopes) ? r.scopes.filter((s): s is string => typeof s === "string" && !!s) : ["https://www.googleapis.com/auth/calendar"],
    };
  }

  const tenant = typeof r.tenant === "string" && r.tenant ? r.tenant.trim() : "common";
  return {
    clientId,
    clientSecret,
    tenant,
    ...(typeof r.redirectUri === "string" && r.redirectUri ? { redirectUri: r.redirectUri.trim() } : {}),
    authUrl: typeof r.authUrl === "string" && r.authUrl ? r.authUrl : `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`,
    tokenUrl: typeof r.tokenUrl === "string" && r.tokenUrl ? r.tokenUrl : `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
    ...(typeof r.revokeUrl === "string" && r.revokeUrl ? { revokeUrl: r.revokeUrl } : {}),
    userInfoUrl: typeof r.userInfoUrl === "string" && r.userInfoUrl ? r.userInfoUrl : "https://graph.microsoft.com/v1.0/me",
    apiBaseUrl: typeof r.apiBaseUrl === "string" && r.apiBaseUrl ? r.apiBaseUrl.replace(/\/+$/, "") : "https://graph.microsoft.com/v1.0",
    scopes: Array.isArray(r.scopes)
      ? r.scopes.filter((s): s is string => typeof s === "string" && !!s)
      : ["offline_access", "Calendars.ReadWrite", "User.Read"],
  };
}

export function loadCalendarOAuthConfig(filePath: string): CalendarOAuthConfig {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const google = normalizeProviderConfig("google", raw.google);
  const outlook = normalizeProviderConfig("outlook", raw.outlook);
  return {
    ...(google ? { google } : {}),
    ...(outlook ? { outlook } : {}),
  };
}

export function resolveOAuthProviderConfig(cfg: CalendarOAuthConfig | undefined, provider: "google" | "outlook"): OAuthProviderConfig | undefined {
  const raw = cfg?.[provider];
  return raw ? normalizeProviderConfig(provider, raw) : undefined;
}

export class RemoteAuthError extends Error {
  constructor(
    message: string,
    readonly code = "remote_auth_failed",
    readonly status = 401,
  ) {
    super(message);
  }
}

export class RemoteApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "remote_api_failed",
  ) {
    super(message);
  }
}

export type CalendarInfo = CalendarAccountCalendar;

export interface RemoteCalendarEvent {
  externalId: string;
  calendarId: string;
  etag?: string | null;
  title: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  isAllDay: boolean;
  timeZone?: string;
  status: "confirmed" | "tentative" | "cancelled";
  partStat?: "accepted" | "declined" | "tentative" | "needs-action";
  updatedMs?: number;
  url?: string;
}

export interface CreateRemoteEventInput {
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  startMs: number;
  endMs: number;
  isAllDay: boolean;
  timeZone: string;
}

export interface UpdateRemoteEventInput extends Partial<CreateRemoteEventInput> {
  externalId: string;
  calendarId: string;
  etag?: string | null;
}

export interface AdapterContext {
  accountId: string;
  provider: "google" | "outlook" | "caldav" | "icloud";
  accessToken?: string;
  apiBaseUrl?: string;
  serverUrl?: string;
  username?: string;
  password?: string;
  userTz: string;
  fetchImpl: FetchLike;
}

export interface CalendarReadAdapter {
  readonly kind: "read" | "readwrite";
  listCalendars(ctx: AdapterContext): Promise<CalendarInfo[]>;
  fetchEvents(
    ctx: AdapterContext,
    calendarId: string,
    window: { fromMs: number; toMs: number; timeZone: string },
  ): Promise<RemoteCalendarEvent[]>;
}

export interface CalendarReadWriteAdapter extends CalendarReadAdapter {
  readonly kind: "readwrite";
  createCalendar(ctx: AdapterContext, name: string, timeZone?: string): Promise<CalendarInfo>;
  createEvent(ctx: AdapterContext, input: CreateRemoteEventInput): Promise<RemoteCalendarEvent>;
  updateEvent(ctx: AdapterContext, input: UpdateRemoteEventInput): Promise<RemoteCalendarEvent>;
  deleteEvent(ctx: AdapterContext, calendarId: string, externalId: string): Promise<void>;
}

const p2 = (n: number): string => String(n).padStart(2, "0");

function formatIsoDateInTz(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${String(p.y).padStart(4, "0")}-${p2(p.m)}-${p2(p.d)}`;
}

function parseIsoDateAllDay(rawDate: string, userTz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(rawDate);
  if (!m) return NaN;
  return wallToInstant(Number(m[1]), Number(m[2]), Number(m[3]), 0, 0, 0, userTz);
}

async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  const res = await fetchImpl(url, init);
  if (res.status === 401) throw new RemoteAuthError(`Upstream auth error (401) from ${url}`, "oauth_token_expired", 401);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new RemoteApiError(`Upstream HTTP ${res.status}: ${body.slice(0, 200)}`, res.status);
  }
  if (res.status === 204) return {};
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ------------------------------------------------------------------ Google Calendar Adapter

export class GoogleCalendarAdapter implements CalendarReadWriteAdapter {
  readonly kind = "readwrite" as const;

  private headers(ctx: AdapterContext): Record<string, string> {
    if (!ctx.accessToken) throw new RemoteAuthError("Missing Google access token");
    return {
      Authorization: `Bearer ${ctx.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
  }

  private base(ctx: AdapterContext): string {
    return (ctx.apiBaseUrl ?? "https://www.googleapis.com/calendar/v3").replace(/\/+$/, "");
  }

  async listCalendars(ctx: AdapterContext): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      if (++pages > 20) throw new RemoteApiError("Too many calendar pages", 502);
      const u = new URL(`${this.base(ctx)}/users/me/calendarList`);
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const data = (await fetchJson(ctx.fetchImpl, u.toString(), { method: "GET", headers: this.headers(ctx) })) as Loose;
      const items = Array.isArray(data.items) ? (data.items as Loose[]) : [];
      for (const c of items) {
        if (typeof c.id !== "string") continue;
        const accessRole = typeof c.accessRole === "string" ? c.accessRole : "owner";
        out.push({
          id: c.id,
          name: String(c.summaryOverride ?? c.summary ?? c.id),
          color: typeof c.backgroundColor === "string" ? c.backgroundColor : null,
          primary: c.primary === true,
          readOnly: accessRole === "reader" || accessRole === "freeBusyReader",
          show: c.selected !== false,
          ...(typeof c.timeZone === "string" ? { timeZone: c.timeZone } : {}),
          ...(typeof c.description === "string" ? { description: c.description } : {}),
        });
      }
      pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  async createCalendar(ctx: AdapterContext, name: string, timeZone?: string): Promise<CalendarInfo> {
    const created = (await fetchJson(ctx.fetchImpl, `${this.base(ctx)}/calendars`, {
      method: "POST",
      headers: this.headers(ctx),
      body: JSON.stringify({ summary: name, ...(timeZone ? { timeZone } : {}) }),
    })) as Loose;
    return {
      id: String(created.id ?? ""),
      name: String(created.summary ?? name),
      readOnly: false,
      show: true,
      ...(typeof created.timeZone === "string" ? { timeZone: created.timeZone } : {}),
    };
  }

  private mapGoogleEvent(ev: Loose, calendarId: string, userTz: string): RemoteCalendarEvent | null {
    if (typeof ev.id !== "string" || !ev.id) return null;
    const startObj = (ev.start && typeof ev.start === "object" ? ev.start : {}) as Loose;
    const endObj = (ev.end && typeof ev.end === "object" ? ev.end : {}) as Loose;
    const isAllDay = typeof startObj.date === "string" && !startObj.dateTime;

    let startMs: number;
    let endMs: number;
    if (isAllDay) {
      startMs = parseIsoDateAllDay(String(startObj.date), userTz);
      endMs = typeof endObj.date === "string" ? parseIsoDateAllDay(String(endObj.date), userTz) : NaN;
      if (Number.isNaN(startMs)) return null;
      if (Number.isNaN(endMs) || endMs <= startMs) {
        const sp = zonedParts(startMs, userTz);
        const next = parseStamp(addDays(makeStamp(sp.y, sp.m, sp.d), 1));
        endMs = wallToInstant(next.y, next.m, next.d, 0, 0, 0, userTz);
      }
    } else {
      startMs = typeof startObj.dateTime === "string" ? Date.parse(startObj.dateTime) : NaN;
      endMs = typeof endObj.dateTime === "string" ? Date.parse(endObj.dateTime) : startMs;
      if (Number.isNaN(startMs)) return null;
      if (Number.isNaN(endMs) || endMs < startMs) endMs = startMs;
    }

    const rawStatus = typeof ev.status === "string" ? ev.status.toLowerCase() : "confirmed";
    const status: RemoteCalendarEvent["status"] =
      rawStatus === "cancelled" ? "cancelled" : rawStatus === "tentative" ? "tentative" : "confirmed";
    const attendees = Array.isArray(ev.attendees) ? (ev.attendees as Loose[]) : [];
    const self = attendees.find((a) => a && typeof a === "object" && a.self === true);
    const resp = typeof self?.responseStatus === "string" ? self.responseStatus.toLowerCase() : undefined;
    const partStat: RemoteCalendarEvent["partStat"] | undefined =
      resp === "declined"
        ? "declined"
        : resp === "tentative"
          ? "tentative"
          : resp === "accepted"
            ? "accepted"
            : resp === "needsaction"
              ? "needs-action"
              : undefined;

    const timeZone =
      typeof startObj.timeZone === "string" && startObj.timeZone ? startObj.timeZone : isAllDay ? userTz : undefined;

    return {
      externalId: ev.id,
      calendarId,
      etag: typeof ev.etag === "string" ? ev.etag : null,
      title: typeof ev.summary === "string" && ev.summary ? ev.summary : "(No title)",
      ...(typeof ev.description === "string" ? { description: ev.description } : {}),
      ...(typeof ev.location === "string" ? { location: ev.location } : {}),
      startMs,
      endMs,
      isAllDay,
      ...(timeZone ? { timeZone } : {}),
      status,
      ...(partStat ? { partStat } : {}),
      ...(typeof ev.updated === "string" && !Number.isNaN(Date.parse(ev.updated)) ? { updatedMs: Date.parse(ev.updated) } : {}),
      ...(typeof ev.htmlLink === "string" ? { url: ev.htmlLink } : {}),
    };
  }

  async fetchEvents(
    ctx: AdapterContext,
    calendarId: string,
    window: { fromMs: number; toMs: number; timeZone: string },
  ): Promise<RemoteCalendarEvent[]> {
    const out: RemoteCalendarEvent[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      if (++pages > 20) throw new RemoteApiError("Too many calendar pages", 502);
      const u = new URL(`${this.base(ctx)}/calendars/${encodeURIComponent(calendarId)}/events`);
      u.searchParams.set("timeMin", new Date(window.fromMs).toISOString());
      u.searchParams.set("timeMax", new Date(window.toMs).toISOString());
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("orderBy", "startTime");
      u.searchParams.set("maxResults", "2500");
      if (pageToken) u.searchParams.set("pageToken", pageToken);

      const data = (await fetchJson(ctx.fetchImpl, u.toString(), { method: "GET", headers: this.headers(ctx) })) as Loose;
      const items = Array.isArray(data.items) ? (data.items as Loose[]) : [];
      for (const item of items) {
        const mapped = this.mapGoogleEvent(item, calendarId, window.timeZone);
        if (mapped) out.push(mapped);
      }
      pageToken = typeof data.nextPageToken === "string" && data.nextPageToken ? data.nextPageToken : undefined;
    } while (pageToken);
    return out;
  }

  private buildGoogleBody(input: Partial<CreateRemoteEventInput>, timeZone: string): Loose {
    const body: Loose = {};
    if (input.title !== undefined) body.summary = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.location !== undefined) body.location = input.location;
    if (input.startMs !== undefined && input.endMs !== undefined) {
      if (input.isAllDay) {
        const startStr = formatIsoDateInTz(input.startMs, timeZone);
        let endStr = formatIsoDateInTz(input.endMs, timeZone);
        if (endStr <= startStr) {
          const sp = zonedParts(input.startMs, timeZone);
          const next = parseStamp(addDays(makeStamp(sp.y, sp.m, sp.d), 1));
          endStr = `${String(next.y).padStart(4, "0")}-${p2(next.m)}-${p2(next.d)}`;
        }
        body.start = { date: startStr };
        body.end = { date: endStr };
      } else {
        body.start = { dateTime: new Date(input.startMs).toISOString(), timeZone };
        body.end = { dateTime: new Date(Math.max(input.endMs, input.startMs)).toISOString(), timeZone };
      }
    }
    return body;
  }

  async createEvent(ctx: AdapterContext, input: CreateRemoteEventInput): Promise<RemoteCalendarEvent> {
    const tz = isValidTimeZone(input.timeZone) ? input.timeZone : ctx.userTz;
    const res = (await fetchJson(ctx.fetchImpl, `${this.base(ctx)}/calendars/${encodeURIComponent(input.calendarId)}/events`, {
      method: "POST",
      headers: this.headers(ctx),
      body: JSON.stringify(this.buildGoogleBody(input, tz)),
    })) as Loose;
    const mapped = this.mapGoogleEvent(res, input.calendarId, tz);
    if (!mapped) throw new RemoteApiError("Invalid event returned from Google Calendar", 502);
    return mapped;
  }

  async updateEvent(ctx: AdapterContext, input: UpdateRemoteEventInput): Promise<RemoteCalendarEvent> {
    const tz = isValidTimeZone(input.timeZone) ? input.timeZone : ctx.userTz;
    const res = (await fetchJson(
      ctx.fetchImpl,
      `${this.base(ctx)}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.externalId)}`,
      {
        method: "PATCH",
        headers: this.headers(ctx),
        body: JSON.stringify(this.buildGoogleBody(input, tz)),
      },
    )) as Loose;
    const mapped = this.mapGoogleEvent(res, input.calendarId, tz);
    if (!mapped) throw new RemoteApiError("Invalid event returned from Google Calendar", 502);
    return mapped;
  }

  async deleteEvent(ctx: AdapterContext, calendarId: string, externalId: string): Promise<void> {
    const url = `${this.base(ctx)}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`;
    const res = await ctx.fetchImpl(url, { method: "DELETE", headers: this.headers(ctx) });
    if (res.status === 401) throw new RemoteAuthError("Upstream auth error (401) from Google", "oauth_token_expired", 401);
    if (res.status === 404 || res.status === 410) return;
    if (!res.ok) throw new RemoteApiError(`Google deleteEvent HTTP ${res.status}`, res.status);
  }
}

// ------------------------------------------------------------------ Outlook / Microsoft Graph Adapter

export class OutlookCalendarAdapter implements CalendarReadWriteAdapter {
  readonly kind = "readwrite" as const;

  private headers(ctx: AdapterContext, extra: Record<string, string> = {}): Record<string, string> {
    if (!ctx.accessToken) throw new RemoteAuthError("Missing Outlook access token");
    return {
      Authorization: `Bearer ${ctx.accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private base(ctx: AdapterContext): string {
    return (ctx.apiBaseUrl ?? "https://graph.microsoft.com/v1.0").replace(/\/+$/, "");
  }

  async listCalendars(ctx: AdapterContext): Promise<CalendarInfo[]> {
    const out: CalendarInfo[] = [];
    let nextUrl: string | undefined = `${this.base(ctx)}/me/calendars`;
    let pages = 0;
    while (nextUrl) {
      if (++pages > 20 || new URL(nextUrl).origin !== new URL(this.base(ctx)).origin) throw new RemoteApiError("Calendar pagination blocked", 502);
      const data = (await fetchJson(ctx.fetchImpl, nextUrl, { method: "GET", headers: this.headers(ctx) })) as Loose;
      const items = Array.isArray(data.value) ? (data.value as Loose[]) : [];
      for (const c of items) {
        if (typeof c.id !== "string") continue;
        out.push({
          id: c.id,
          name: String(c.name ?? c.id),
          color: typeof c.hexColor === "string" && c.hexColor ? c.hexColor : null,
          primary: c.isDefaultCalendar === true,
          readOnly: c.canEdit === false,
          show: true,
        });
      }
      nextUrl = typeof data["@odata.nextLink"] === "string" && data["@odata.nextLink"] ? data["@odata.nextLink"] : undefined;
    }
    return out;
  }

  async createCalendar(ctx: AdapterContext, name: string): Promise<CalendarInfo> {
    const created = (await fetchJson(ctx.fetchImpl, `${this.base(ctx)}/me/calendars`, {
      method: "POST",
      headers: this.headers(ctx),
      body: JSON.stringify({ name }),
    })) as Loose;
    return {
      id: String(created.id ?? ""),
      name: String(created.name ?? name),
      readOnly: false,
      show: true,
    };
  }

  private parseGraphDateTime(dtObj: unknown): number {
    if (!dtObj || typeof dtObj !== "object") return NaN;
    const raw = (dtObj as Loose).dateTime;
    const tz = (dtObj as Loose).timeZone;
    if (typeof raw !== "string" || !raw) return NaN;
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) return Date.parse(raw);
    if (tz === "UTC" || tz === "Etc/UTC") return Date.parse(`${raw}Z`);
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(raw);
    if (m && typeof tz === "string" && isValidTimeZone(tz)) {
      return wallToInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), tz);
    }
    return Date.parse(`${raw}Z`);
  }

  private mapOutlookEvent(ev: Loose, calendarId: string, userTz: string): RemoteCalendarEvent | null {
    if (typeof ev.id !== "string" || !ev.id) return null;
    const isAllDay = ev.isAllDay === true;
    let startMs: number;
    let endMs: number;
    if (isAllDay) {
      const sRaw = typeof (ev.start as Loose | undefined)?.dateTime === "string" ? String((ev.start as Loose).dateTime) : "";
      const eRaw = typeof (ev.end as Loose | undefined)?.dateTime === "string" ? String((ev.end as Loose).dateTime) : "";
      startMs = parseIsoDateAllDay(sRaw, userTz);
      endMs = parseIsoDateAllDay(eRaw, userTz);
      if (Number.isNaN(startMs)) return null;
      if (Number.isNaN(endMs) || endMs <= startMs) {
        const sp = zonedParts(startMs, userTz);
        const next = parseStamp(addDays(makeStamp(sp.y, sp.m, sp.d), 1));
        endMs = wallToInstant(next.y, next.m, next.d, 0, 0, 0, userTz);
      }
    } else {
      startMs = this.parseGraphDateTime(ev.start);
      endMs = this.parseGraphDateTime(ev.end);
      if (Number.isNaN(startMs)) return null;
      if (Number.isNaN(endMs) || endMs < startMs) endMs = startMs;
    }

    const bodyObj = ev.body && typeof ev.body === "object" ? (ev.body as Loose) : undefined;
    const description =
      typeof ev.bodyPreview === "string" && ev.bodyPreview
        ? ev.bodyPreview
        : typeof bodyObj?.content === "string"
          ? bodyObj.content
          : undefined;
    const locObj = ev.location && typeof ev.location === "object" ? (ev.location as Loose) : undefined;
    const location = typeof locObj?.displayName === "string" && locObj.displayName ? locObj.displayName : undefined;
    const resp = typeof (ev.responseStatus as Loose | undefined)?.response === "string"
      ? String((ev.responseStatus as Loose).response).toLowerCase()
      : undefined;
    const partStat: RemoteCalendarEvent["partStat"] | undefined =
      resp === "declined"
        ? "declined"
        : resp === "tentativelyaccepted"
          ? "tentative"
          : resp === "accepted" || resp === "organizer"
            ? "accepted"
            : resp === "notresponded"
              ? "needs-action"
              : undefined;

    const status: RemoteCalendarEvent["status"] =
      ev.isCancelled === true ? "cancelled" : ev.showAs === "tentative" ? "tentative" : "confirmed";

    return {
      externalId: ev.id,
      calendarId,
      etag: typeof ev["@odata.etag"] === "string" ? ev["@odata.etag"] : typeof ev.changeKey === "string" ? ev.changeKey : null,
      title: typeof ev.subject === "string" && ev.subject ? ev.subject : "(No title)",
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      startMs,
      endMs,
      isAllDay,
      ...(isAllDay ? { timeZone: userTz } : {}),
      status,
      ...(partStat ? { partStat } : {}),
      ...(typeof ev.lastModifiedDateTime === "string" && !Number.isNaN(Date.parse(ev.lastModifiedDateTime))
        ? { updatedMs: Date.parse(ev.lastModifiedDateTime) }
        : {}),
      ...(typeof ev.webLink === "string" ? { url: ev.webLink } : {}),
    };
  }

  async fetchEvents(
    ctx: AdapterContext,
    calendarId: string,
    window: { fromMs: number; toMs: number; timeZone: string },
  ): Promise<RemoteCalendarEvent[]> {
    const out: RemoteCalendarEvent[] = [];
    const u = new URL(`${this.base(ctx)}/me/calendars/${encodeURIComponent(calendarId)}/calendarView`);
    u.searchParams.set("startDateTime", new Date(window.fromMs).toISOString());
    u.searchParams.set("endDateTime", new Date(window.toMs).toISOString());
    u.searchParams.set("$top", "250");

    let nextUrl: string | undefined = u.toString();
    let pages = 0;
    while (nextUrl) {
      if (++pages > 20 || new URL(nextUrl).origin !== new URL(this.base(ctx)).origin) throw new RemoteApiError("Calendar pagination blocked", 502);
      const data = (await fetchJson(ctx.fetchImpl, nextUrl, {
        method: "GET",
        headers: this.headers(ctx, { Prefer: 'outlook.timezone="UTC"' }),
      })) as Loose;
      const items = Array.isArray(data.value) ? (data.value as Loose[]) : [];
      for (const item of items) {
        const mapped = this.mapOutlookEvent(item, calendarId, window.timeZone);
        if (mapped) out.push(mapped);
      }
      nextUrl = typeof data["@odata.nextLink"] === "string" && data["@odata.nextLink"] ? data["@odata.nextLink"] : undefined;
    }
    return out;
  }

  private buildOutlookBody(input: Partial<CreateRemoteEventInput>, timeZone: string): Loose {
    const body: Loose = {};
    if (input.title !== undefined) body.subject = input.title;
    if (input.description !== undefined) body.body = { contentType: "text", content: input.description };
    if (input.location !== undefined) body.location = { displayName: input.location };
    if (input.isAllDay !== undefined) body.isAllDay = input.isAllDay;
    if (input.startMs !== undefined && input.endMs !== undefined) {
      if (input.isAllDay) {
        const startDate = formatIsoDateInTz(input.startMs, timeZone);
        let endDate = formatIsoDateInTz(input.endMs, timeZone);
        if (endDate <= startDate) {
          const sp = zonedParts(input.startMs, timeZone);
          const next = parseStamp(addDays(makeStamp(sp.y, sp.m, sp.d), 1));
          endDate = `${String(next.y).padStart(4, "0")}-${p2(next.m)}-${p2(next.d)}`;
        }
        body.start = { dateTime: `${startDate}T00:00:00`, timeZone };
        body.end = { dateTime: `${endDate}T00:00:00`, timeZone };
      } else {
        body.start = { dateTime: new Date(input.startMs).toISOString().replace(/Z$/, ""), timeZone: "UTC" };
        body.end = { dateTime: new Date(Math.max(input.endMs, input.startMs)).toISOString().replace(/Z$/, ""), timeZone: "UTC" };
      }
    }
    return body;
  }

  async createEvent(ctx: AdapterContext, input: CreateRemoteEventInput): Promise<RemoteCalendarEvent> {
    const tz = isValidTimeZone(input.timeZone) ? input.timeZone : ctx.userTz;
    const res = (await fetchJson(ctx.fetchImpl, `${this.base(ctx)}/me/calendars/${encodeURIComponent(input.calendarId)}/events`, {
      method: "POST",
      headers: this.headers(ctx),
      body: JSON.stringify(this.buildOutlookBody(input, tz)),
    })) as Loose;
    const mapped = this.mapOutlookEvent(res, input.calendarId, tz);
    if (!mapped) throw new RemoteApiError("Invalid event returned from Outlook Graph", 502);
    return mapped;
  }

  async updateEvent(ctx: AdapterContext, input: UpdateRemoteEventInput): Promise<RemoteCalendarEvent> {
    const tz = isValidTimeZone(input.timeZone) ? input.timeZone : ctx.userTz;
    const res = (await fetchJson(ctx.fetchImpl, `${this.base(ctx)}/me/events/${encodeURIComponent(input.externalId)}`, {
      method: "PATCH",
      headers: this.headers(ctx),
      body: JSON.stringify(this.buildOutlookBody(input, tz)),
    })) as Loose;
    const mapped = this.mapOutlookEvent(res, input.calendarId, tz);
    if (!mapped) throw new RemoteApiError("Invalid event returned from Outlook Graph", 502);
    return mapped;
  }

  async deleteEvent(ctx: AdapterContext, _calendarId: string, externalId: string): Promise<void> {
    const url = `${this.base(ctx)}/me/events/${encodeURIComponent(externalId)}`;
    const res = await ctx.fetchImpl(url, { method: "DELETE", headers: this.headers(ctx) });
    if (res.status === 401) throw new RemoteAuthError("Upstream auth error (401) from Outlook", "oauth_token_expired", 401);
    if (res.status === 404 || res.status === 410) return;
    if (!res.ok) throw new RemoteApiError(`Outlook deleteEvent HTTP ${res.status}`, res.status);
  }
}

// ------------------------------------------------------------------ CalDAV Adapter (Generic & iCloud, read-only)

export const ICLOUD_CALDAV_URL = "https://caldav.icloud.com";

export class CalDavCalendarAdapter implements CalendarReadAdapter {
  readonly kind = "read" as const;

  private authHeaders(ctx: AdapterContext, extra: Record<string, string> = {}): Record<string, string> {
    const user = ctx.username ?? "";
    const pass = ctx.password ?? "";
    const basic = Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
    return {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/xml; charset=utf-8",
      Accept: "application/xml, text/xml;q=0.9, */*;q=0.8",
      ...extra,
    };
  }

  private async davRequest(ctx: AdapterContext, method: "PROPFIND" | "REPORT", url: string, depth: string, body: string): Promise<string> {
    const base = new URL(ctx.serverUrl || ICLOUD_CALDAV_URL);
    const target = new URL(url);
    const iCloudShard = ctx.provider === "icloud" && base.protocol === "https:" && base.hostname.endsWith(".icloud.com") &&
      target.protocol === "https:" && (target.hostname === "caldav.icloud.com" || /^p[0-9]+-caldav\.icloud\.com$/.test(target.hostname)) && !target.port;
    if (target.origin !== base.origin && !iCloudShard) throw new RemoteApiError("CalDAV origin mismatch", 400, "caldav_origin_blocked");
    const res = await ctx.fetchImpl(url, {
      method,
      headers: this.authHeaders(ctx, { Depth: depth }),
      body,
    });
    if (res.status === 401 || res.status === 403) {
      throw new RemoteAuthError(`CalDAV authentication failed (${res.status})`, "caldav_auth_failed", 401);
    }
    if (!res.ok && res.status !== 207) {
      const txt = await res.text().catch(() => "");
      throw new RemoteApiError(`CalDAV ${method} HTTP ${res.status}: ${txt.slice(0, 200)}`, res.status, "caldav_request_failed");
    }
    return await res.text();
  }

  private resolveHref(baseUrl: string, href: string): string {
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return href;
    }
  }

  async listCalendars(ctx: AdapterContext): Promise<CalendarInfo[]> {
    const startUrl = (ctx.serverUrl || (ctx.provider === "icloud" ? ICLOUD_CALDAV_URL : "")).trim();
    if (!startUrl) throw new RemoteApiError("CalDAV server URL is required", 400, "invalid_caldav_url");

    const entryXml = await this.davRequest(ctx, "PROPFIND", startUrl, "0", buildPropfindPrincipalXml());
    const entryDoc = parseXml(entryXml);

    // Case 1: startUrl already points directly to a calendar collection
    const entryRes = findAll(entryDoc, "response");
    const directCal = this.extractCalendarsFromResponses(entryRes, startUrl);
    if (directCal.length > 0 && !findFirst(entryDoc, "calendar-home-set")) {
      return directCal;
    }

    // Case 2: calendar-home-set present on entry response
    const entryHomeSet = findFirst(entryDoc, "calendar-home-set");
    let homeHref = entryHomeSet ? textOf(findFirst(entryHomeSet, "href")) : "";
    if (!homeHref) {
      const principalNode = findFirst(entryDoc, "current-user-principal");
      const principalHref = principalNode ? textOf(findFirst(principalNode, "href")) : "";
      if (principalHref) {
        const principalUrl = this.resolveHref(startUrl, principalHref);
        const homeXml = await this.davRequest(ctx, "PROPFIND", principalUrl, "0", buildPropfindHomeSetXml());
        const homeDoc = parseXml(homeXml);
        const homeSet = findFirst(homeDoc, "calendar-home-set");
        homeHref = homeSet ? textOf(findFirst(homeSet, "href")) : "";
      }
    }

    const targetUrl = homeHref ? this.resolveHref(startUrl, homeHref) : startUrl;
    const listXml = await this.davRequest(ctx, "PROPFIND", targetUrl, "1", buildPropfindCalendarsXml());
    const listDoc = parseXml(listXml);
    const cals = this.extractCalendarsFromResponses(findAll(listDoc, "response"), targetUrl);
    return cals;
  }

  private extractCalendarsFromResponses(responses: ReturnType<typeof findAll>, baseUrl: string): CalendarInfo[] {
    const out: CalendarInfo[] = [];
    const seen = new Set<string>();
    for (const resp of responses) {
      const hrefRaw = textOf(findFirst(resp, "href"));
      if (!hrefRaw) continue;
      const resType = findFirst(resp, "resourcetype");
      if (!resType) continue;
      const isCal = resType.children.some((c) => c.localName === "calendar");
      const isInboxOutbox = resType.children.some((c) => c.localName === "schedule-inbox" || c.localName === "schedule-outbox");
      if (!isCal || isInboxOutbox) continue;

      const compSet = findFirst(resp, "supported-calendar-component-set");
      if (compSet) {
        const comps = findAll(compSet, "comp").map((c) => (c.attrs.name ?? "").toUpperCase());
        if (comps.length > 0 && !comps.includes("VEVENT")) continue;
      }

      const id = this.resolveHref(baseUrl, hrefRaw);
      if (seen.has(id)) continue;
      seen.add(id);

      const displayName = textOf(findFirst(resp, "displayname")) || id.replace(/\/+$/, "").split("/").pop() || "Calendar";
      const color = textOf(findFirst(resp, "calendar-color")) || null;
      const ctag = textOf(findFirst(resp, "getctag")) || undefined;

      out.push({
        id,
        name: displayName,
        color,
        readOnly: true,
        show: true,
        ...(ctag ? { ctag } : {}),
      });
    }
    return out;
  }

  async fetchEvents(
    ctx: AdapterContext,
    calendarId: string,
    window: { fromMs: number; toMs: number; timeZone: string },
  ): Promise<RemoteCalendarEvent[]> {
    const baseUrl = (ctx.serverUrl || (ctx.provider === "icloud" ? ICLOUD_CALDAV_URL : "")).trim();
    const calUrl = this.resolveHref(baseUrl || calendarId, calendarId);
    const pad = 2 * 86_400_000;
    const reportXml = buildReportCalendarQueryXml(window.fromMs - pad, window.toMs + pad);
    const xml = await this.davRequest(ctx, "REPORT", calUrl, "1", reportXml);
    const doc = parseXml(xml);
    const out: RemoteCalendarEvent[] = [];

    for (const resp of findAll(doc, "response")) {
      const href = textOf(findFirst(resp, "href"));
      const etag = textOf(findFirst(resp, "getetag")).replace(/^"|"$/g, "") || null;
      const calData = textOf(findFirst(resp, "calendar-data"));
      if (!calData) continue;

      const parsed = parseAndExpandIcs(calData, {
        fromMs: window.fromMs,
        toMs: window.toMs,
        userTz: window.timeZone,
        sourceId: `${ctx.accountId}:${calendarId}`,
      });
      for (const ev of parsed.events) {
        const resolvedUrl = href ? this.resolveHref(calUrl, href) : ev.url;
        out.push({
          externalId: ev.uid ? `${ev.uid}:${ev.startMs}` : ev.id,
          calendarId,
          etag,
          title: ev.title,
          ...(ev.description ? { description: ev.description } : {}),
          ...(ev.location ? { location: ev.location } : {}),
          startMs: ev.startMs,
          endMs: ev.endMs,
          isAllDay: ev.isAllDay,
          ...(ev.timeZone ? { timeZone: ev.timeZone } : {}),
          status: ev.status,
          ...(ev.partStat ? { partStat: ev.partStat } : {}),
          ...(resolvedUrl ? { url: resolvedUrl } : {}),
        });
      }
    }
    return out;
  }
}
