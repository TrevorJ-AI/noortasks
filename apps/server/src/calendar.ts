import { createHash, randomBytes } from "node:crypto";
import {
  CALENDAR_CACHE_TTL_MS,
  CalendarItemKind,
  CalendarSourceItemType,
  TaskStatus,
  WEEKDAY_CODES,
  addDays,
  formatServerDate,
  isPlainObject,
  isValidTimeZone,
  makeStamp,
  newEtag,
  newId,
  parseStamp,
  parseWireDate,
  stampOf,
  wallToInstant,
  zonedParts,
  type BatchResponse,
  type CalendarAccount,
  type CalendarAccountCalendar,
  type CalendarEventItem,
  type CalendarFeedConfig,
  type CalendarProjectBinding,
  type CalendarSubscription,
  type HolidayPreset,
  type Loose,
  type Project,
  type Task,
} from "@noortasks/core";
import { occurrencesBetween, weekendOnlyProvider, type HolidayProvider } from "@noortasks/recurrence";
import type { FastifyInstance } from "fastify";
import { safeFetch } from "./network.js";
import { safeEqual } from "./auth.js";
import {
  CalDavCalendarAdapter,
  GoogleCalendarAdapter,
  ICLOUD_CALDAV_URL,
  OutlookCalendarAdapter,
  RemoteApiError,
  RemoteAuthError,
  resolveOAuthProviderConfig,
  type AdapterContext,
  type CalendarInfo,
  type CalendarOAuthConfig,
  type CalendarReadAdapter,
  type CalendarReadWriteAdapter,
  type FetchLike,
  type OAuthProviderConfig,
  type RemoteCalendarEvent,
} from "./calendar-adapters.js";
import { generateIcsFeed, isValidIcsDocument, parseAndExpandIcs } from "./calendar-ics.js";
import { ApiError, type Service } from "./service.js";

const DAY_MS = 86_400_000;
const OAUTH_STATE_TTL_MS = 15 * 60_000;

export const HOLIDAY_PRESETS: readonly HolidayPreset[] = [
  {
    id: "nl",
    code: "NL",
    name: "Netherlands Holidays",
    url: "https://calendar.google.com/calendar/ical/en.dutch%23holiday%40group.v.calendar.google.com/public/basic.ics",
    description: "Public holidays and observances in the Netherlands",
  },
  {
    id: "be",
    code: "BE",
    name: "Belgium Holidays",
    url: "https://calendar.google.com/calendar/ical/en.be%23holiday%40group.v.calendar.google.com/public/basic.ics",
    description: "Public holidays and observances in Belgium",
  },
  {
    id: "uk",
    code: "UK",
    name: "UK Bank Holidays (England & Wales)",
    url: "https://www.gov.uk/bank-holidays/england-and-wales.ics",
    description: "Official GOV.UK bank holidays for England and Wales",
  },
  {
    id: "us",
    code: "US",
    name: "US Holidays",
    url: "https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics",
    description: "Public holidays and observances in the United States",
  },
  {
    id: "islamic",
    code: "ISLAMIC",
    name: "Islamic Holidays",
    url: "https://calendar.google.com/calendar/ical/en.islamic%23holiday%40group.v.calendar.google.com/public/basic.ics",
    description: "Major Islamic holidays and observances",
  },
];

interface StoredTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAtMs?: number;
  tokenType?: string;
  scope?: string;
}

interface StoredCredentials {
  username?: string;
  password?: string;
}

interface StoredAccount extends CalendarAccount {
  _tokens?: StoredTokens;
  _credentials?: StoredCredentials;
}

interface FeedCacheRow {
  subId: string;
  url: string;
  etag: string | null;
  lastModified: string | null;
  body: string | null;
  fetchedAtMs: number;
  lastStatus: number | null;
  lastError: string | null;
}

export interface CalendarServiceOptions {
  oauth?: CalendarOAuthConfig;
  fetch?: FetchLike;
}

function parseQueryMs(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return fallback;
    if (/^-?\d+$/.test(t)) return Number(t);
    const w = parseWireDate(t);
    if (!Number.isNaN(w)) return w;
    const d = Date.parse(t);
    if (!Number.isNaN(d)) return d;
  }
  return NaN;
}

function parseBoolParam(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const low = v.trim().toLowerCase();
    if (low === "true" || low === "1") return true;
    if (low === "false" || low === "0") return false;
  }
  return undefined;
}

function normalizeCalendarUrl(rawUrl: string): { displayUrl: string; fetchUrl: string } {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new ApiError(400, "invalid_calendar_url");
  let fetchUrl = trimmed;
  if (/^webcal:\/\//i.test(fetchUrl)) fetchUrl = `https://${fetchUrl.slice(9)}`;
  else if (/^webcals:\/\//i.test(fetchUrl)) fetchUrl = `https://${fetchUrl.slice(10)}`;
  let parsed: URL;
  try {
    parsed = new URL(fetchUrl);
  } catch {
    throw new ApiError(400, "invalid_calendar_url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ApiError(400, "invalid_calendar_url");
  }
  return { displayUrl: trimmed, fetchUrl: parsed.toString() };
}

function findHolidayPreset(key: string): HolidayPreset | undefined {
  const k = key.trim().toLowerCase();
  return HOLIDAY_PRESETS.find((p) => p.id === k || p.code.toLowerCase() === k);
}

function sanitizeAccount(acc: StoredAccount): CalendarAccount {
  const copy: Loose = { ...acc };
  delete copy._tokens;
  delete copy._credentials;
  delete copy.password;
  delete copy.accessToken;
  delete copy.refreshToken;
  return copy as CalendarAccount;
}

function isReadWriteAdapter(a: CalendarReadAdapter): a is CalendarReadWriteAdapter {
  return a.kind === "readwrite";
}

function sha256Base64Url(input: string): string {
  return createHash("sha256").update(input).digest("base64url");
}

function parseTaskInstant(raw: string | null | undefined, isAllDay: boolean, isFloating: boolean, srcTz: string, userTz: string): number | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const hasZone = /(?:Z|[+-]\d{4}|[+-]\d{2}:\d{2})$/.test(raw);
  if (!hasZone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
    if (!m) return undefined;
    const z = isFloating ? userTz : srcTz;
    return wallToInstant(
      Number(m[1]),
      Number(m[2]),
      Number(m[3]),
      isAllDay ? 0 : Number(m[4] ?? 0),
      isAllDay ? 0 : Number(m[5] ?? 0),
      isAllDay ? 0 : Number(m[6] ?? 0),
      z,
    );
  }
  const w = parseWireDate(raw);
  const utcMs = Number.isNaN(w) ? Date.parse(raw) : w;
  if (Number.isNaN(utcMs)) return undefined;
  if (isAllDay) {
    const p = zonedParts(utcMs, isFloating ? srcTz : userTz);
    return wallToInstant(p.y, p.m, p.d, 0, 0, 0, userTz);
  }
  if (isFloating) {
    const p = zonedParts(utcMs, srcTz);
    return wallToInstant(p.y, p.m, p.d, p.h, p.min, p.s, userTz);
  }
  return utcMs;
}

function overlaps(startMs: number, endMs: number, fromMs: number, toMs: number): boolean {
  if (fromMs === toMs) return endMs > startMs ? startMs <= fromMs && endMs > fromMs : startMs === fromMs;
  return endMs > startMs ? endMs > fromMs && startMs < toMs : startMs >= fromMs && startMs < toMs;
}

function toWireEvent(base: {
  id: string;
  key: string;
  uid?: string;
  kind: number;
  sourceType: string;
  itemType?: number;
  sourceId: string;
  calendarId?: string;
  accountId?: string;
  taskId?: string;
  itemId?: string;
  projectId?: string;
  title: string;
  description?: string;
  location?: string;
  color?: string | null;
  startMs: number;
  endMs: number;
  isAllDay: boolean;
  timeZone?: string;
  completed: boolean;
  readOnly: boolean;
  status?: string;
  partStat?: string;
  isRecurring?: boolean;
  isOverride?: boolean;
  occurrence?: number;
  url?: string;
  priority?: number;
  tags?: string[];
}): CalendarEventItem {
  const sStr = formatServerDate(base.startMs);
  const eStr = formatServerDate(base.endMs);
  return {
    id: base.id,
    key: base.key,
    ...(base.uid ? { uid: base.uid } : {}),
    kind: base.kind,
    sourceType: base.sourceType,
    ...(base.itemType !== undefined ? { itemType: base.itemType } : {}),
    sourceId: base.sourceId,
    ...(base.calendarId ? { calendarId: base.calendarId } : {}),
    ...(base.accountId ? { accountId: base.accountId } : {}),
    ...(base.taskId ? { taskId: base.taskId } : {}),
    ...(base.itemId ? { itemId: base.itemId } : {}),
    ...(base.projectId ? { projectId: base.projectId } : {}),
    title: base.title,
    ...(base.description ? { description: base.description } : {}),
    ...(base.location ? { location: base.location } : {}),
    ...(base.color !== undefined ? { color: base.color } : {}),
    start: base.startMs,
    end: base.endMs,
    allDay: base.isAllDay,
    isAllDay: base.isAllDay,
    startDate: sStr,
    dueDate: eStr,
    dueStart: sStr,
    dueEnd: eStr,
    ...(base.timeZone ? { timeZone: base.timeZone } : {}),
    completed: base.completed,
    readOnly: base.readOnly,
    ...(base.status ? { status: base.status } : {}),
    ...(base.partStat ? { partStat: base.partStat } : {}),
    ...(base.isRecurring !== undefined ? { isRecurring: base.isRecurring } : {}),
    ...(base.isOverride !== undefined ? { isOverride: base.isOverride } : {}),
    ...(base.occurrence !== undefined ? { occurrence: base.occurrence } : {}),
    ...(base.url ? { url: base.url } : {}),
    ...(base.priority !== undefined ? { priority: base.priority } : {}),
    ...(base.tags !== undefined ? { tags: base.tags } : {}),
  };
}

function itemTypeForProvider(provider: string): number {
  switch (provider) {
    case "google":
      return CalendarSourceItemType.GoogleCalendar;
    case "outlook":
      return CalendarSourceItemType.OutlookCalendar;
    case "caldav":
      return CalendarSourceItemType.CalDavCalendar;
    case "icloud":
      return CalendarSourceItemType.ICloudCalendar;
    default:
      return CalendarSourceItemType.UrlCalendar;
  }
}

export class CalendarService {
  private googleAdapter = new GoogleCalendarAdapter();
  private outlookAdapter = new OutlookCalendarAdapter();
  private caldavAdapter = new CalDavCalendarAdapter();

  constructor(
    private svc: Service,
    private opts: CalendarServiceOptions = {},
  ) {}

  private get store() {
    return this.svc.store;
  }

  private get fetchImpl(): FetchLike {
    return this.opts.fetch ?? safeFetch;
  }

  private holidayProvider(): HolidayProvider {
    const doc = this.store.getDoc<{ restDays?: unknown[]; workDays?: unknown[] }>("holidays")?.json;
    if (!doc) return weekendOnlyProvider;
    const rest = new Set(Array.isArray(doc.restDays) ? doc.restDays.filter((x): x is string => typeof x === "string") : []);
    const work = new Set(Array.isArray(doc.workDays) ? doc.workDays.filter((x): x is string => typeof x === "string") : []);
    return {
      isHoliday: (d) => rest.has(d),
      isWorkday: (d) => (work.has(d) ? true : rest.has(d) ? false : weekendOnlyProvider.isWorkday(d)),
    };
  }

  private viewConf(): { showCompleted: boolean; showChecklist: boolean; showFutureTask: boolean; showDeclinedEvents: boolean } {
    const s = (this.store.getDoc<Loose>("settings")?.json ?? {}) as Loose;
    const vc = isPlainObject(s.calendarViewConf) ? s.calendarViewConf : {};
    return {
      showCompleted: vc.showCompleted !== false,
      showChecklist: vc.showChecklist === true,
      showFutureTask: vc.showFutureTask !== false,
      showDeclinedEvents: vc.showDeclinedEvents === true,
    };
  }

  resolveWindow(rawFrom: unknown, rawTo: unknown): { fromMs: number; toMs: number } {
    const now = this.svc.now();
    const { tz } = this.svc.userCtx();
    const today = stampOf(now, tz);
    const tp = parseStamp(today);
    const todayStart = wallToInstant(tp.y, tp.m, tp.d, 0, 0, 0, tz);
    const defFrom = todayStart - 7 * DAY_MS;
    const defTo = todayStart + 30 * DAY_MS;

    const fromMs = parseQueryMs(rawFrom, defFrom);
    const toMs = parseQueryMs(rawTo, defTo);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || toMs - fromMs > 366 * DAY_MS || Math.abs(fromMs) > 8.64e15 || Math.abs(toMs) > 8.64e15) {
      throw new ApiError(400, "invalid_date_range");
    }
    return { fromMs, toMs };
  }

  // ------------------------------------------------------------------ 1 & 2. ICS URL & Holiday Subscriptions

  listSubscriptions(): CalendarSubscription[] {
    return this.store
      .collAll<CalendarSubscription>("calendar_subscriptions")
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  getSubscription(id: string): CalendarSubscription | undefined {
    return this.store.collGet<CalendarSubscription>("calendar_subscriptions", id);
  }

  private buildSubscription(raw: Loose, existing?: CalendarSubscription): CalendarSubscription {
    const now = formatServerDate(this.svc.now());
    const presetKey = typeof raw.presetId === "string" ? raw.presetId : typeof raw.holidayCode === "string" ? raw.holidayCode : typeof raw.code === "string" ? raw.code : undefined;
    const preset = presetKey ? findHolidayPreset(presetKey) : undefined;
    if (presetKey && !preset && typeof raw.url !== "string") {
      throw new ApiError(400, "unknown_holiday_preset");
    }

    const rawUrl = typeof raw.url === "string" ? raw.url : preset?.url ?? existing?.url;
    if (!rawUrl) throw new ApiError(400, "invalid_calendar_url");
    const { displayUrl } = normalizeCalendarUrl(rawUrl);

    const kind = preset || raw.kind === "holiday" ? "holiday" : existing?.kind ?? "url";
    const id = typeof raw.id === "string" && raw.id ? raw.id : existing?.id ?? newId(this.svc.now());
    const nameInput = typeof raw.name === "string" ? raw.name : typeof raw.title === "string" ? raw.title : undefined;
    const name = nameInput !== undefined ? nameInput : existing?.name ?? preset?.name ?? new URL(displayUrl.replace(/^webcals?:/i, "https:")).hostname;

    let show = existing?.show ?? true;
    if (typeof raw.show === "boolean") show = raw.show;
    else if (typeof raw.visible === "boolean") show = raw.visible;
    else if (typeof raw.isShow === "boolean") show = raw.isShow;
    else if (typeof raw.hidden === "boolean") show = !raw.hidden;
    else if (typeof raw.closed === "boolean") show = !raw.closed;

    const maxOrder = this.listSubscriptions().reduce((m, s) => Math.max(m, s.sortOrder ?? 0), 0);
    const sortOrder = typeof raw.sortOrder === "number" && Number.isFinite(raw.sortOrder) ? raw.sortOrder : existing?.sortOrder ?? maxOrder + 1;

    return {
      ...(existing ?? {}),
      ...raw,
      id,
      name,
      url: displayUrl,
      kind,
      ...(preset ? { presetId: preset.id } : existing?.presetId ? { presetId: existing.presetId } : {}),
      color: raw.color !== undefined ? (typeof raw.color === "string" ? raw.color : null) : (existing?.color ?? null),
      desc: raw.desc !== undefined ? (typeof raw.desc === "string" ? raw.desc : null) : (existing?.desc ?? null),
      show,
      hidden: !show,
      sortOrder,
      itemType: CalendarSourceItemType.UrlCalendar,
      etag: newEtag(),
      createdTime: existing?.createdTime ?? now,
      modifiedTime: now,
    };
  }

  subscribe(body: unknown): CalendarSubscription {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_subscription");
    return this.store.tx(() => {
      const seq = this.store.seq();
      const existing = typeof body.id === "string" ? this.getSubscription(body.id) : undefined;
      const sub = this.buildSubscription(body, existing);
      if (existing && existing.url !== sub.url) {
        this.store.run("delete from calendar_feed_cache where subId = ?", sub.id);
      }
      this.store.collPut("calendar_subscriptions", sub.id, sub, { seq });
      return sub;
    });
  }

  batchSubscribe(body: unknown): BatchResponse | CalendarSubscription[] {
    if (Array.isArray(body)) {
      return this.store.tx(() => {
        const seq = this.store.seq();
        const saved: CalendarSubscription[] = [];
        for (const item of body) {
          if (!isPlainObject(item)) throw new ApiError(400, "invalid_subscription");
          const existing = typeof item.id === "string" ? this.getSubscription(item.id) : undefined;
          const sub = this.buildSubscription(item, existing);
          this.store.collPut("calendar_subscriptions", sub.id, sub, { seq });
          saved.push(sub);
        }
        return saved;
      });
    }
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_subscription");
    const res: BatchResponse = { id2etag: {}, id2error: {} };
    this.store.tx(() => {
      const seq = this.store.seq();
      for (const raw of Array.isArray(body.add) ? body.add : []) {
        if (!isPlainObject(raw)) continue;
        const id = typeof raw.id === "string" && raw.id ? raw.id : newId(this.svc.now());
        if (this.getSubscription(id)) {
          res.id2error[id] = "EXISTED";
          continue;
        }
        const sub = this.buildSubscription({ ...raw, id });
        this.store.collPut("calendar_subscriptions", sub.id, sub, { seq });
        res.id2etag[sub.id] = sub.etag!;
      }
      for (const raw of Array.isArray(body.update) ? body.update : []) {
        if (!isPlainObject(raw) || typeof raw.id !== "string") continue;
        const old = this.getSubscription(raw.id);
        if (!old) {
          res.id2error[raw.id] = "NOT_EXISTED";
          continue;
        }
        const sub = this.buildSubscription(raw, old);
        if (old.url !== sub.url) this.store.run("delete from calendar_feed_cache where subId = ?", sub.id);
        this.store.collPut("calendar_subscriptions", sub.id, sub, { seq });
        res.id2etag[sub.id] = sub.etag!;
      }
      for (const raw of Array.isArray(body.delete) ? body.delete : []) {
        const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
        if (!id) continue;
        if (!this.getSubscription(id)) {
          res.id2error[id] = "NOT_EXISTED";
          continue;
        }
        this.deleteSubscriptionLocal(id);
      }
    });
    return res;
  }

  updateSubscription(id: string, body: unknown): CalendarSubscription {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_subscription");
    return this.store.tx(() => {
      const seq = this.store.seq();
      const old = this.getSubscription(id);
      if (!old) throw new ApiError(404, "subscription_not_found");
      const sub = this.buildSubscription({ ...body, id }, old);
      if (old.url !== sub.url) this.store.run("delete from calendar_feed_cache where subId = ?", id);
      this.store.collPut("calendar_subscriptions", id, sub, { seq });
      return sub;
    });
  }

  setVisibility(id: string, body: unknown, queryShow?: unknown): Loose {
    const b = isPlainObject(body) ? body : {};
    const explicit =
      parseBoolParam(b.show) ??
      parseBoolParam(b.visible) ??
      parseBoolParam(b.isShow) ??
      parseBoolParam(queryShow) ??
      (typeof b.hidden === "boolean" ? !b.hidden : typeof b.closed === "boolean" ? !b.closed : undefined);

    return this.store.tx(() => {
      const seq = this.store.seq();
      const sub = this.getSubscription(id);
      if (sub) {
        const nextShow = explicit ?? !sub.show;
        const updated: CalendarSubscription = {
          ...sub,
          show: nextShow,
          hidden: !nextShow,
          etag: newEtag(),
          modifiedTime: formatServerDate(this.svc.now()),
        };
        this.store.collPut("calendar_subscriptions", id, updated, { seq });
        return updated;
      }

      const acc = this.getStoredAccount(id);
      if (acc) {
        const calId = typeof b.calendarId === "string" ? b.calendarId : undefined;
        const nextShow = explicit ?? !acc.show;
        if (calId) {
          acc.calendars = acc.calendars.map((c) => (c.id === calId ? { ...c, show: explicit ?? !(c.show !== false) } : c));
        } else {
          acc.show = nextShow;
        }
        acc.modifiedTime = formatServerDate(this.svc.now());
        this.saveStoredAccount(acc, seq);
        return sanitizeAccount(acc);
      }
      throw new ApiError(404, "calendar_not_found");
    });
  }

  setDescription(id: string, body: unknown): Loose {
    const desc = isPlainObject(body) && typeof body.desc === "string" ? body.desc : isPlainObject(body) && body.desc === null ? null : "";
    return this.store.tx(() => {
      const seq = this.store.seq();
      const sub = this.getSubscription(id);
      if (sub) {
        const updated = { ...sub, desc, etag: newEtag(), modifiedTime: formatServerDate(this.svc.now()) };
        this.store.collPut("calendar_subscriptions", id, updated, { seq });
        return updated;
      }
      const acc = this.getStoredAccount(id);
      if (acc) {
        acc.desc = desc;
        acc.modifiedTime = formatServerDate(this.svc.now());
        this.saveStoredAccount(acc, seq);
        return sanitizeAccount(acc);
      }
      throw new ApiError(404, "calendar_not_found");
    });
  }

  sortSubscriptions(body: unknown): CalendarSubscription[] {
    return this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.svc.now());
      const updates = new Map<string, number>();

      if (Array.isArray(body)) {
        body.forEach((v, i) => {
          if (typeof v === "string") updates.set(v, i);
          else if (isPlainObject(v) && typeof v.id === "string" && typeof v.sortOrder === "number") updates.set(v.id, v.sortOrder);
        });
      } else if (isPlainObject(body)) {
        if (Array.isArray(body.ids)) {
          body.ids.forEach((v, i) => {
            if (typeof v === "string") updates.set(v, i);
          });
        } else if (Array.isArray(body.orders)) {
          for (const o of body.orders) {
            if (isPlainObject(o) && typeof o.id === "string" && typeof o.sortOrder === "number") updates.set(o.id, o.sortOrder);
          }
        } else if (isPlainObject(body.sortOrder)) {
          for (const [k, v] of Object.entries(body.sortOrder)) {
            if (typeof v === "number") updates.set(k, v);
          }
        }
      }

      for (const [id, sortOrder] of updates) {
        const sub = this.getSubscription(id);
        if (sub) {
          this.store.collPut("calendar_subscriptions", id, { ...sub, sortOrder, etag: newEtag(), modifiedTime: now }, { seq });
        }
      }
      return this.listSubscriptions();
    });
  }

  private deleteSubscriptionLocal(id: string): void {
    this.store.collDelete("calendar_subscriptions", id);
    this.store.run("delete from calendar_feed_cache where subId = ?", id);
    this.store.addTombstone("calendarSubscription", id);
  }

  unsubscribe(ids: string[]): { deleted: string[]; id2error: Record<string, string> } {
    return this.store.tx(() => {
      const deleted: string[] = [];
      const id2error: Record<string, string> = {};
      for (const id of ids) {
        if (!this.getSubscription(id)) {
          id2error[id] = "NOT_EXISTED";
          continue;
        }
        this.deleteSubscriptionLocal(id);
        deleted.push(id);
      }
      return { deleted, id2error };
    });
  }

  private getFeedCache(subId: string): FeedCacheRow | undefined {
    return this.store.get<FeedCacheRow>("select * from calendar_feed_cache where subId = ?", subId);
  }

  /**
   * Fetch/refresh an ICS subscription on demand when cache is missing or >= 15 minutes old (or force=true).
   * Never uses background timers; relies on HTTP ETag / Last-Modified conditional GETs.
   */
  async ensureSubscriptionFeed(sub: CalendarSubscription, forceRefresh = false): Promise<{ body: string; cache: FeedCacheRow; refreshed: boolean }> {
    const nowMs = this.svc.now();
    const existing = this.getFeedCache(sub.id);
    const isFresh = existing && existing.body !== null && nowMs - existing.fetchedAtMs < CALENDAR_CACHE_TTL_MS;
    if (isFresh && !forceRefresh) {
      return { body: existing.body!, cache: existing, refreshed: false };
    }

    const { fetchUrl } = normalizeCalendarUrl(sub.url);
    const headers: Record<string, string> = {
      Accept: "text/calendar, text/plain;q=0.9, */*;q=0.8",
      "User-Agent": "NoorTasks/1.0",
    };
    if (existing?.etag) headers["If-None-Match"] = existing.etag;
    if (existing?.lastModified) headers["If-Modified-Since"] = existing.lastModified;

    let res: Response;
    try {
      res = await this.fetchImpl(fetchUrl, { method: "GET", headers });
    } catch (err) {
      const msg = "calendar_upstream_failed";
      this.recordFeedError(sub, existing, null, msg);
      if (existing?.body) return { body: existing.body, cache: this.getFeedCache(sub.id)!, refreshed: false };
      throw new ApiError(502, "calendar_fetch_failed", msg);
    }

    if (res.status === 304 && existing?.body) {
      const nextEtag = res.headers.get("etag") ?? existing.etag;
      const nextLastMod = res.headers.get("last-modified") ?? existing.lastModified;
      this.store.tx(() => {
        this.store.run(
          `insert into calendar_feed_cache(subId, url, etag, lastModified, body, fetchedAtMs, lastStatus, lastError)
           values (?,?,?,?,?,?,?,?)
           on conflict(subId) do update set url=excluded.url, etag=excluded.etag, lastModified=excluded.lastModified,
             fetchedAtMs=excluded.fetchedAtMs, lastStatus=excluded.lastStatus, lastError=null`,
          sub.id,
          fetchUrl,
          nextEtag,
          nextLastMod,
          existing.body,
          nowMs,
          304,
          null,
        );
        const seq = this.store.seq();
        this.store.collPut("calendar_subscriptions", sub.id, { ...sub, lastFetchedAt: formatServerDate(nowMs), lastError: null }, { seq });
      });
      return { body: existing.body, cache: this.getFeedCache(sub.id)!, refreshed: true };
    }

    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      this.recordFeedError(sub, existing, res.status, msg);
      if (existing?.body) return { body: existing.body, cache: this.getFeedCache(sub.id)!, refreshed: false };
      throw new ApiError(502, "calendar_fetch_failed", msg);
    }

    const body = await res.text();
    if (!isValidIcsDocument(body)) {
      const msg = "invalid_ics_payload";
      this.recordFeedError(sub, existing, res.status, msg);
      if (existing?.body) return { body: existing.body, cache: this.getFeedCache(sub.id)!, refreshed: false };
      throw new ApiError(502, "invalid_ics_payload");
    }

    const etag = res.headers.get("etag");
    const lastModified = res.headers.get("last-modified");
    this.store.tx(() => {
      this.store.run(
        `insert into calendar_feed_cache(subId, url, etag, lastModified, body, fetchedAtMs, lastStatus, lastError)
         values (?,?,?,?,?,?,?,?)
         on conflict(subId) do update set url=excluded.url, etag=excluded.etag, lastModified=excluded.lastModified,
           body=excluded.body, fetchedAtMs=excluded.fetchedAtMs, lastStatus=excluded.lastStatus, lastError=null`,
        sub.id,
        fetchUrl,
        etag,
        lastModified,
        body,
        nowMs,
        res.status,
        null,
      );
      const seq = this.store.seq();
      this.store.collPut("calendar_subscriptions", sub.id, { ...sub, lastFetchedAt: formatServerDate(nowMs), lastError: null }, { seq });
    });

    return { body, cache: this.getFeedCache(sub.id)!, refreshed: true };
  }

  private recordFeedError(sub: CalendarSubscription, existing: FeedCacheRow | undefined, status: number | null, err: string): void {
    const nowMs = this.svc.now();
    this.store.tx(() => {
      this.store.run(
        `insert into calendar_feed_cache(subId, url, etag, lastModified, body, fetchedAtMs, lastStatus, lastError)
         values (?,?,?,?,?,?,?,?)
         on conflict(subId) do update set lastStatus=excluded.lastStatus, lastError=excluded.lastError`,
        sub.id,
        sub.url,
        existing?.etag ?? null,
        existing?.lastModified ?? null,
        existing?.body ?? null,
        existing?.fetchedAtMs ?? 0,
        status,
        err,
      );
      const seq = this.store.seq();
      this.store.collPut("calendar_subscriptions", sub.id, { ...sub, lastError: err, modifiedTime: formatServerDate(nowMs) }, { seq });
    });
  }

  async getSubscriptionEvents(
    fromMs: number,
    toMs: number,
    opts: { subId?: string; includeHidden?: boolean; forceRefresh?: boolean; showDeclined?: boolean } = {},
  ): Promise<CalendarEventItem[]> {
    const { tz } = this.svc.userCtx();
    const vc = this.viewConf();
    const showDeclined = opts.showDeclined ?? vc.showDeclinedEvents;
    const archived = this.archivedIds();

    let subs: CalendarSubscription[];
    if (opts.subId) {
      const one = this.getSubscription(opts.subId);
      if (!one) throw new ApiError(404, "subscription_not_found");
      subs = [one];
    } else {
      subs = this.listSubscriptions().filter((s) => opts.includeHidden || s.show !== false);
    }

    const out: CalendarEventItem[] = [];
    for (const sub of subs) {
      let body: string;
      try {
        ({ body } = await this.ensureSubscriptionFeed(sub, opts.forceRefresh === true));
      } catch (err) {
        if (opts.subId) throw err;
        continue;
      }

      const parsed = parseAndExpandIcs(body, { fromMs, toMs, userTz: tz, sourceId: sub.id });
      for (const ev of parsed.events) {
        if (ev.partStat === "declined" && !showDeclined) continue;
        if (archived.has(ev.id) || (ev.uid && archived.has(ev.uid))) continue;
        out.push(
          toWireEvent({
            id: ev.id,
            key: `sub:${ev.id}`,
            uid: ev.uid,
            kind: CalendarItemKind.Subscribe,
            sourceType: sub.kind === "holiday" ? "holiday" : "url",
            itemType: CalendarSourceItemType.UrlCalendar,
            sourceId: sub.id,
            calendarId: sub.id,
            title: ev.title,
            ...(ev.description ? { description: ev.description } : {}),
            ...(ev.location ? { location: ev.location } : {}),
            color: sub.color ?? null,
            startMs: ev.startMs,
            endMs: ev.endMs,
            isAllDay: ev.isAllDay,
            ...(ev.timeZone ? { timeZone: ev.timeZone } : {}),
            completed: false,
            readOnly: true,
            status: ev.status,
            ...(ev.partStat ? { partStat: ev.partStat } : {}),
            isRecurring: ev.isRecurring,
            isOverride: ev.isOverride,
            ...(ev.url ? { url: ev.url } : {}),
          }),
        );
      }
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
    return out;
  }

  getCacheInfo(id: string): Loose {
    const fc = this.getFeedCache(id);
    if (fc) {
      return {
        id,
        type: "subscription",
        url: fc.url,
        etag: fc.etag,
        lastModified: fc.lastModified,
        fetchedAt: fc.fetchedAtMs ? formatServerDate(fc.fetchedAtMs) : null,
        fetchedAtMs: fc.fetchedAtMs,
        status: fc.lastStatus,
        lastError: fc.lastError,
        cached: fc.body !== null,
      };
    }
    const rows = this.store.all<{
      cacheKey: string;
      calendarId: string;
      windowFromMs: number;
      windowToMs: number;
      fetchedAtMs: number;
      lastError: string | null;
    }>("select cacheKey, calendarId, windowFromMs, windowToMs, fetchedAtMs, lastError from calendar_account_cache where accountId = ?", id);
    if (rows.length > 0) {
      return { id, type: "account", entries: rows };
    }
    return { id, cached: false };
  }

  // ------------------------------------------------------------------ 3. Outgoing Private ICS Feed

  getFeedCode(): Loose {
    const doc = this.store.getDoc<CalendarFeedConfig>("calendarFeed")?.json;
    if (!doc) {
      return { code: null, url: null, enabled: false, includeDone: false, includeHabits: false, projectIds: null };
    }
    return { ...doc, enabled: true };
  }

  createOrResetFeedCode(opts: { includeDone?: boolean; includeHabits?: boolean; projectIds?: string[] | null } = {}): CalendarFeedConfig {
    return this.store.tx(() => {
      const prev = this.store.getDoc<CalendarFeedConfig>("calendarFeed")?.json;
      const now = formatServerDate(this.svc.now());
      const code = randomBytes(24).toString("hex");
      const cfg: CalendarFeedConfig = {
        id: prev?.id ?? newId(this.svc.now()),
        code,
        url: `/feed/${code}.ics`,
        includeDone: opts.includeDone ?? prev?.includeDone ?? false,
        includeHabits: opts.includeHabits ?? prev?.includeHabits ?? false,
        projectIds: opts.projectIds !== undefined ? opts.projectIds : (prev?.projectIds ?? null),
        createdTime: prev?.createdTime ?? now,
        modifiedTime: now,
      };
      this.store.putDoc("calendarFeed", cfg);
      return cfg;
    });
  }

  updateFeedSettings(opts: { includeDone?: boolean; includeHabits?: boolean; projectIds?: string[] | null }): CalendarFeedConfig {
    return this.store.tx(() => {
      const prev = this.store.getDoc<CalendarFeedConfig>("calendarFeed")?.json;
      if (!prev) throw new ApiError(404, "feed_not_found");
      const next: CalendarFeedConfig = {
        ...prev,
        ...(opts.includeDone !== undefined ? { includeDone: opts.includeDone } : {}),
        ...(opts.includeHabits !== undefined ? { includeHabits: opts.includeHabits } : {}),
        ...(opts.projectIds !== undefined ? { projectIds: opts.projectIds } : {}),
        modifiedTime: formatServerDate(this.svc.now()),
      };
      this.store.putDoc("calendarFeed", next);
      return next;
    });
  }

  cancelFeedCode(target?: string): { cancelled: boolean } {
    return this.store.tx(() => {
      const prev = this.store.getDoc<CalendarFeedConfig>("calendarFeed")?.json;
      if (!prev) return { cancelled: false };
      if (target && target !== "default" && target !== "all" && target !== "0" && target !== prev.code && target !== prev.id) {
        throw new ApiError(404, "feed_not_found");
      }
      this.store.run("delete from docs where name = 'calendarFeed'");
      return { cancelled: true };
    });
  }

  renderPrivateFeed(token: string): string {
    const cfg = this.store.getDoc<CalendarFeedConfig>("calendarFeed")?.json;
    if (!cfg || !cfg.code || !token || !safeEqual(token, cfg.code)) {
      throw new ApiError(404, "feed_not_found");
    }
    const { tz, weekStart } = this.svc.userCtx();
    const wkCode = WEEKDAY_CODES[weekStart] ?? "SU";
    const allowedProjects = Array.isArray(cfg.projectIds)
      ? new Set(cfg.projectIds.map((id) => (id === "inbox" ? this.svc.inboxId : id)))
      : null;
    const tasks = this.store
      .all<{ json: string }>("select json from tasks where deleted = 0 order by pos")
      .map((r) => JSON.parse(r.json) as Task)
      .filter((t) => {
        if (!t.startDate && !t.dueDate) return false;
        if (allowedProjects && !allowedProjects.has(t.projectId)) return false;
        if (!cfg.includeDone && t.status !== TaskStatus.Open) return false;
        return true;
      });
    const habits = cfg.includeHabits ? this.store.collAll<Loose>("habits") : [];
    return generateIcsFeed({
      calName: "NoorTasks",
      timeZone: tz,
      tasks,
      habits,
      includeHabits: cfg.includeHabits,
      holidays: this.holidayProvider(),
      nowMs: this.svc.now(),
      weekStart: wkCode,
    });
  }

  // ------------------------------------------------------------------ 4. OAuth 2.0 (Google & Outlook) & CalDAV/iCloud

  private getStoredAccount(id: string): StoredAccount | undefined {
    const r = this.store.get<{ json: string }>("select json from calendar_accounts where id = ?", id);
    return r ? (JSON.parse(r.json) as StoredAccount) : undefined;
  }

  private listStoredAccounts(): StoredAccount[] {
    return this.store.all<{ json: string }>("select json from calendar_accounts order by pos").map((r) => JSON.parse(r.json) as StoredAccount);
  }

  private saveStoredAccount(acc: StoredAccount, seq: number): void {
    const prev = this.store.get<{ pos: number }>("select pos from calendar_accounts where id = ?", acc.id);
    const pos = prev?.pos ?? this.store.nextPos("calendar_accounts");
    this.store.run(
      `insert into calendar_accounts(id, provider, pos, seq, json) values (?,?,?,?,?)
       on conflict(id) do update set provider=excluded.provider, pos=excluded.pos, seq=excluded.seq, json=excluded.json`,
      acc.id,
      acc.provider,
      pos,
      seq,
      JSON.stringify(acc),
    );
  }

  listAccounts(): CalendarAccount[] {
    return this.listStoredAccounts().map(sanitizeAccount);
  }

  private oauthProviderConfig(provider: "google" | "outlook"): OAuthProviderConfig {
    const cfg = resolveOAuthProviderConfig(this.opts.oauth, provider);
    if (!cfg) throw new ApiError(503, "oauth_not_configured", `${provider} OAuth credentials are not configured`);
    return cfg;
  }

  private adapterFor(provider: string): CalendarReadAdapter {
    if (provider === "google") return this.googleAdapter;
    if (provider === "outlook") return this.outlookAdapter;
    if (provider === "caldav" || provider === "icloud") return this.caldavAdapter;
    throw new ApiError(400, "unsupported_provider");
  }

  private buildAdapterCtx(acc: StoredAccount): AdapterContext {
    const { tz } = this.svc.userCtx();
    let apiBaseUrl: string | undefined;
    if (acc.provider === "google" || acc.provider === "outlook") {
      apiBaseUrl = resolveOAuthProviderConfig(this.opts.oauth, acc.provider)?.apiBaseUrl;
    }
    return {
      accountId: acc.id,
      provider: acc.provider as AdapterContext["provider"],
      ...(acc._tokens?.accessToken ? { accessToken: acc._tokens.accessToken } : {}),
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(acc.serverUrl ? { serverUrl: acc.serverUrl } : {}),
      ...(acc._credentials?.username ? { username: acc._credentials.username } : {}),
      ...(acc._credentials?.password ? { password: acc._credentials.password } : {}),
      userTz: tz,
      fetchImpl: this.fetchImpl,
    };
  }

  startOAuth(providerRaw: string, opts: { originUrl?: string; redirectUri?: string; redirectAfter?: string } = {}): {
    provider: "google" | "outlook";
    state: string;
    authorizationUrl: string;
    url: string;
  } {
    if (providerRaw !== "google" && providerRaw !== "outlook") throw new ApiError(400, "unsupported_provider");
    const cfg = this.oauthProviderConfig(providerRaw);
    const nowMs = this.svc.now();
    const state = randomBytes(24).toString("hex");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = sha256Base64Url(codeVerifier);
    const redirectUri = cfg.redirectUri || `${opts.originUrl ?? "http://127.0.0.1"}/api/v2/calendar/oauth/${providerRaw}/callback`;
    if (opts.redirectUri && opts.redirectUri !== redirectUri) throw new ApiError(400, "invalid_redirect_uri");
    if (opts.redirectAfter && (!opts.redirectAfter.startsWith("/") || opts.redirectAfter.startsWith("//") || /[\\\r\n]/.test(opts.redirectAfter))) throw new ApiError(400, "invalid_redirect_after");

    this.store.tx(() => {
      this.store.run("delete from calendar_oauth_states where createdAtMs < ?", nowMs - OAUTH_STATE_TTL_MS);
      this.store.run(
        "insert into calendar_oauth_states(state, provider, codeVerifier, redirectUri, redirectAfter, createdAtMs) values (?,?,?,?,?,?)",
        state,
        providerRaw,
        codeVerifier,
        redirectUri,
        opts.redirectAfter ?? null,
        nowMs,
      );
    });

    const u = new URL(cfg.authUrl);
    u.searchParams.set("client_id", cfg.clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", cfg.scopes.join(" "));
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    if (providerRaw === "google") {
      u.searchParams.set("access_type", "offline");
      u.searchParams.set("prompt", "consent");
    } else {
      u.searchParams.set("response_mode", "query");
    }

    const authorizationUrl = u.toString();
    return { provider: providerRaw, state, authorizationUrl, url: authorizationUrl };
  }

  getOAuthStateStatus(state: string): { state: string; pending: boolean; provider?: string } {
    const row = this.store.get<{ state: string; provider: string; createdAtMs: number }>(
      "select state, provider, createdAtMs from calendar_oauth_states where state = ?",
      state,
    );
    if (!row || this.svc.now() - row.createdAtMs > OAUTH_STATE_TTL_MS) return { state, pending: false };
    return { state, pending: true, provider: row.provider };
  }

  async completeOAuthCallback(
    providerRaw: string,
    params: { code?: string; state?: string; error?: string; errorDescription?: string; originUrl?: string; redirectUri?: string },
  ): Promise<{ account: CalendarAccount; redirectAfter?: string | null }> {
    if (providerRaw !== "google" && providerRaw !== "outlook") throw new ApiError(400, "unsupported_provider");
    const cfg = this.oauthProviderConfig(providerRaw);

    if (params.error) {
      if (params.state) this.store.run("delete from calendar_oauth_states where state = ?", params.state);
      throw new ApiError(400, "oauth_authorization_error", params.errorDescription || params.error);
    }
    if (!params.code || !params.state) throw new ApiError(400, "invalid_oauth_callback");

    const nowMs = this.svc.now();
    const stateRow = this.store.tx(() => {
      const r = this.store.get<{ state: string; provider: string; codeVerifier: string | null; redirectUri: string | null; redirectAfter: string | null; createdAtMs: number }>(
        "select * from calendar_oauth_states where state = ?",
        params.state!,
      );
      if (r) this.store.run("delete from calendar_oauth_states where state = ?", params.state!);
      return r;
    });
    if (!stateRow || stateRow.provider !== providerRaw || nowMs - stateRow.createdAtMs > OAUTH_STATE_TTL_MS) {
      throw new ApiError(400, "invalid_oauth_state");
    }

    if (params.redirectUri && params.redirectUri !== stateRow.redirectUri) throw new ApiError(400, "invalid_redirect_uri");
    const redirectUri = stateRow.redirectUri || cfg.redirectUri || `${params.originUrl ?? "http://127.0.0.1"}/api/v2/calendar/oauth/${providerRaw}/callback`;
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri,
      ...(stateRow.codeVerifier ? { code_verifier: stateRow.codeVerifier } : {}),
    });

    const tokenRes = await this.fetchImpl(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text().catch(() => "");
      throw new ApiError(502, "oauth_token_exchange_failed", `HTTP ${tokenRes.status}`);
    }
    const tok = (await tokenRes.json()) as Loose;
    if (typeof tok.access_token !== "string" || !tok.access_token) {
      throw new ApiError(502, "oauth_token_exchange_failed", "Missing access_token");
    }

    const expiresIn = typeof tok.expires_in === "number" && tok.expires_in > 0 ? tok.expires_in : 3600;
    const tokens: StoredTokens = {
      accessToken: tok.access_token,
      ...(typeof tok.refresh_token === "string" && tok.refresh_token ? { refreshToken: tok.refresh_token } : {}),
      expiresAtMs: nowMs + expiresIn * 1000,
      ...(typeof tok.token_type === "string" ? { tokenType: tok.token_type } : {}),
      ...(typeof tok.scope === "string" ? { scope: tok.scope } : {}),
    };

    // Best-effort user profile lookup
    let email = "";
    let displayName = "";
    if (cfg.userInfoUrl) {
      try {
        const profRes = await this.fetchImpl(cfg.userInfoUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
        });
        if (profRes.ok) {
          const p = (await profRes.json()) as Loose;
          email = String(p.email ?? p.mail ?? p.userPrincipalName ?? "");
          displayName = String(p.name ?? p.displayName ?? email);
        }
      } catch {
        // non-fatal; account still connects
      }
    }

    const tempAcc: StoredAccount = {
      id: newId(nowMs),
      provider: providerRaw,
      account: email || displayName || `${providerRaw}-${nowMs}`,
      ...(email ? { email } : {}),
      ...(displayName ? { displayName } : {}),
      itemType: itemTypeForProvider(providerRaw),
      status: "active",
      needsReauth: false,
      show: true,
      calendars: [],
      _tokens: tokens,
    };

    let calendars: CalendarInfo[] = [];
    try {
      calendars = await this.adapterFor(providerRaw).listCalendars(this.buildAdapterCtx(tempAcc));
    } catch {
      calendars = [];
    }

    const saved = this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(nowMs);
      const existing = email ? this.listStoredAccounts().find((a) => a.provider === providerRaw && (a.email === email || a.account === email)) : undefined;
      const finalAcc: StoredAccount = {
        ...(existing ?? {}),
        ...tempAcc,
        id: existing?.id ?? tempAcc.id,
        calendars: calendars.map((c) => {
          const prev = existing?.calendars.find((pc) => pc.id === c.id);
          return { ...c, show: prev?.show ?? c.show ?? true };
        }),
        _tokens: {
          ...tokens,
          ...(tokens.refreshToken ? {} : existing?._tokens?.refreshToken ? { refreshToken: existing._tokens.refreshToken } : {}),
        },
        createdTime: existing?.createdTime ?? now,
        modifiedTime: now,
        lastSyncAt: now,
        lastError: null,
      };
      this.saveStoredAccount(finalAcc, seq);
      return sanitizeAccount(finalAcc);
    });

    return { account: saved, redirectAfter: stateRow.redirectAfter };
  }

  async refreshAccountToken(accountId: string): Promise<CalendarAccount> {
    const acc = this.getStoredAccount(accountId);
    if (!acc) throw new ApiError(404, "account_not_found");
    if (acc.provider !== "google" && acc.provider !== "outlook") {
      throw new ApiError(400, "provider_does_not_use_oauth");
    }
    const cfg = this.oauthProviderConfig(acc.provider);
    const refreshToken = acc._tokens?.refreshToken;
    if (!refreshToken) {
      this.markAccountRevoked(acc, "missing_refresh_token");
      throw new ApiError(401, "oauth_token_revoked", "No refresh token available; reconnect account");
    }

    const nowMs = this.svc.now();
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      ...(acc.provider === "outlook" ? { scope: cfg.scopes.join(" ") } : {}),
    });

    const res = await this.fetchImpl(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    });

    if (!res.ok) {
      let errCode = `http_${res.status}`;
      try {
        const j = (await res.json()) as Loose;
        if (typeof j.error === "string") errCode = j.error;
      } catch {
        // ignore non-json error body
      }
      if (res.status === 400 || res.status === 401 || errCode === "invalid_grant") {
        this.markAccountRevoked(acc, errCode);
        throw new ApiError(401, "oauth_token_revoked", `Refresh token revoked or expired (${errCode})`);
      }
      throw new ApiError(502, "oauth_refresh_failed", `HTTP ${res.status}`);
    }

    const tok = (await res.json()) as Loose;
    if (typeof tok.access_token !== "string" || !tok.access_token) {
      throw new ApiError(502, "oauth_refresh_failed", "Missing access_token in refresh response");
    }
    const newAccessToken: string = tok.access_token;
    const expiresIn = typeof tok.expires_in === "number" && tok.expires_in > 0 ? tok.expires_in : 3600;

    return this.store.tx(() => {
      const seq = this.store.seq();
      const updated: StoredAccount = {
        ...acc,
        status: "active",
        needsReauth: false,
        lastError: null,
        modifiedTime: formatServerDate(nowMs),
        _tokens: {
          ...acc._tokens,
          accessToken: newAccessToken,
          refreshToken: typeof tok.refresh_token === "string" && tok.refresh_token ? tok.refresh_token : refreshToken,
          expiresAtMs: nowMs + expiresIn * 1000,
          ...(typeof tok.token_type === "string" ? { tokenType: tok.token_type } : {}),
          ...(typeof tok.scope === "string" ? { scope: tok.scope } : {}),
        },
      };
      this.saveStoredAccount(updated, seq);
      return sanitizeAccount(updated);
    });
  }

  private markAccountRevoked(acc: StoredAccount, reason: string): void {
    this.store.tx(() => {
      const seq = this.store.seq();
      const next: StoredAccount = {
        ...acc,
        status: "revoked",
        needsReauth: true,
        lastError: reason,
        modifiedTime: formatServerDate(this.svc.now()),
        _tokens: {},
      };
      this.saveStoredAccount(next, seq);
    });
  }

  private async ensureFreshAccess(acc: StoredAccount): Promise<StoredAccount> {
    if (acc.provider !== "google" && acc.provider !== "outlook") return acc;
    if (acc.needsReauth || acc.status === "revoked") {
      throw new ApiError(401, "oauth_token_revoked", "Account needs re-authentication");
    }
    const exp = acc._tokens?.expiresAtMs ?? 0;
    if (!acc._tokens?.accessToken || this.svc.now() >= exp - 60_000) {
      await this.refreshAccountToken(acc.id);
      return this.getStoredAccount(acc.id)!;
    }
    return acc;
  }

  private async withAdapter<T>(accountId: string, fn: (acc: StoredAccount, adapter: CalendarReadAdapter, ctx: AdapterContext) => Promise<T>): Promise<T> {
    const initial = this.getStoredAccount(accountId);
    if (!initial) throw new ApiError(404, "account_not_found");
    let acc = await this.ensureFreshAccess(initial);
    const adapter = this.adapterFor(acc.provider);

    try {
      return await fn(acc, adapter, this.buildAdapterCtx(acc));
    } catch (err) {
      if (err instanceof RemoteAuthError && (acc.provider === "google" || acc.provider === "outlook")) {
        await this.refreshAccountToken(acc.id);
        acc = this.getStoredAccount(acc.id)!;
        return await fn(acc, adapter, this.buildAdapterCtx(acc));
      }
      if (err instanceof RemoteAuthError) {
        this.store.tx(() => {
          const seq = this.store.seq();
          this.saveStoredAccount({ ...acc, status: "error", needsReauth: true, lastError: err.code }, seq);
        });
        throw new ApiError(401, err.code);
      }
      if (err instanceof RemoteApiError) {
        throw new ApiError(err.status >= 400 && err.status < 500 ? err.status : 502, err.code);
      }
      throw err;
    }
  }

  async bindCalDav(provider: "caldav" | "icloud", body: unknown): Promise<CalendarAccount> {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_caldav_config");
    const serverUrlRaw =
      typeof body.serverUrl === "string"
        ? body.serverUrl
        : typeof body.serverAddress === "string"
          ? body.serverAddress
          : typeof body.url === "string"
            ? body.url
            : provider === "icloud"
              ? ICLOUD_CALDAV_URL
              : "";
    const username = typeof body.username === "string" ? body.username : typeof body.account === "string" ? body.account : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!serverUrlRaw.trim()) throw new ApiError(400, "invalid_caldav_url");
    if (!username.trim() || !password) throw new ApiError(400, "invalid_caldav_credentials");

    const nowMs = this.svc.now();
    const now = formatServerDate(nowMs);
    const id = typeof body.id === "string" && body.id ? body.id : newId(nowMs);
    const acc: StoredAccount = {
      id,
      provider,
      account: username.trim(),
      displayName: typeof body.name === "string" && body.name.trim() ? body.name.trim() : username.trim(),
      serverUrl: serverUrlRaw.trim(),
      itemType: itemTypeForProvider(provider),
      status: "active",
      needsReauth: false,
      show: true,
      calendars: [],
      createdTime: now,
      modifiedTime: now,
      _credentials: { username: username.trim(), password },
    };

    try {
      const calendars = await this.caldavAdapter.listCalendars(this.buildAdapterCtx(acc));
      acc.calendars = calendars;
      acc.lastSyncAt = now;
      acc.lastError = null;
    } catch (err) {
      if (err instanceof RemoteAuthError) throw new ApiError(401, "caldav_auth_failed", err.message);
      if (err instanceof RemoteApiError) throw new ApiError(502, err.code);
      throw new ApiError(502, "caldav_connection_failed");
    }

    this.store.tx(() => {
      this.saveStoredAccount(acc, this.store.seq());
    });
    return sanitizeAccount(acc);
  }

  async updateAccount(id: string, body: unknown): Promise<CalendarAccount> {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_account");
    const acc = this.getStoredAccount(id);
    if (!acc) throw new ApiError(404, "account_not_found");

    const next: StoredAccount = {
      ...acc,
      ...(typeof body.name === "string" ? { displayName: body.name } : {}),
      ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}),
      ...(typeof body.show === "boolean" ? { show: body.show } : {}),
      ...(typeof body.serverUrl === "string" && body.serverUrl ? { serverUrl: body.serverUrl.trim() } : {}),
      ...(Array.isArray(body.calendars) ? { calendars: body.calendars as CalendarAccountCalendar[] } : {}),
      modifiedTime: formatServerDate(this.svc.now()),
    };

    if ((acc.provider === "caldav" || acc.provider === "icloud") && (typeof body.password === "string" || typeof body.username === "string" || typeof body.account === "string" || typeof body.serverUrl === "string")) {
      const u = typeof body.username === "string" ? body.username : typeof body.account === "string" ? body.account : acc._credentials?.username ?? acc.account;
      const p = typeof body.password === "string" ? body.password : acc._credentials?.password ?? "";
      next.account = u;
      next._credentials = { username: u, password: p };
      try {
        next.calendars = await this.caldavAdapter.listCalendars(this.buildAdapterCtx(next));
        next.status = "active";
        next.needsReauth = false;
        next.lastError = null;
      } catch (err) {
        if (err instanceof RemoteAuthError) throw new ApiError(401, "caldav_auth_failed", err.message);
        throw new ApiError(502, "caldav_connection_failed");
      }
    }

    this.store.tx(() => {
      this.saveStoredAccount(next, this.store.seq());
    });
    return sanitizeAccount(next);
  }

  async disconnectAccount(id: string): Promise<{ disconnected: boolean }> {
    const acc = this.getStoredAccount(id);
    if (!acc) throw new ApiError(404, "account_not_found");

    if (acc.provider === "google" || acc.provider === "outlook") {
      const cfg = resolveOAuthProviderConfig(this.opts.oauth, acc.provider);
      const token = acc._tokens?.refreshToken ?? acc._tokens?.accessToken;
      if (cfg?.revokeUrl && token) {
        try {
          await this.fetchImpl(`${cfg.revokeUrl}?token=${encodeURIComponent(token)}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
          });
        } catch {
          // best-effort remote revocation; local disconnect always completes
        }
      }
    }

    this.store.tx(() => {
      this.store.run("delete from calendar_accounts where id = ?", id);
      this.store.run("delete from calendar_project_bindings where accountId = ?", id);
      this.store.run("delete from calendar_event_task_links where accountId = ?", id);
      this.store.run("delete from calendar_account_cache where accountId = ?", id);
    });
    return { disconnected: true };
  }

  async createRemoteCalendar(accountId: string, body: unknown): Promise<CalendarAccountCalendar> {
    if (!isPlainObject(body) || typeof body.calendarName !== "string" || !body.calendarName.trim()) {
      throw new ApiError(400, "invalid_calendar_name");
    }
    const tz = typeof body.timeZone === "string" && isValidTimeZone(body.timeZone) ? body.timeZone : this.svc.userCtx().tz;
    const created = await this.withAdapter(accountId, async (_acc, adapter, ctx) => {
      if (!isReadWriteAdapter(adapter)) throw new ApiError(400, "read_only_provider");
      return await adapter.createCalendar(ctx, body.calendarName!.toString().trim(), tz);
    });

    this.store.tx(() => {
      const latest = this.getStoredAccount(accountId);
      if (!latest) return;
      latest.calendars = [...latest.calendars.filter((c) => c.id !== created.id), created];
      latest.modifiedTime = formatServerDate(this.svc.now());
      this.saveStoredAccount(latest, this.store.seq());
    });
    return created;
  }

  // ------------------------------------------------------------------ Two-way bindings & remote event CRUD

  listBindings(accountId?: string): CalendarProjectBinding[] {
    const rows = accountId
      ? this.store.all<{ json: string }>("select json from calendar_project_bindings where accountId = ?", accountId)
      : this.store.all<{ json: string }>("select json from calendar_project_bindings");
    return rows.map((r) => JSON.parse(r.json) as CalendarProjectBinding);
  }

  bindCalendarToProject(accountId: string, body: unknown): CalendarProjectBinding {
    if (!isPlainObject(body) || typeof body.calendarId !== "string" || !body.calendarId) {
      throw new ApiError(400, "invalid_binding");
    }
    const acc = this.getStoredAccount(accountId);
    if (!acc) throw new ApiError(404, "account_not_found");
    if (acc.provider === "caldav" || acc.provider === "icloud") {
      throw new ApiError(400, "read_only_provider");
    }
    const scope = body.syncProjectScope === "all" ? "all" : "project";
    const projectId = typeof body.syncProjectId === "string" && body.syncProjectId ? body.syncProjectId : this.svc.inboxId;
    if (scope === "project" && projectId !== this.svc.inboxId && !this.store.collGet("projects", projectId)) {
      throw new ApiError(404, "project_not_found");
    }
    const defaultTags = Array.isArray(body.defaultTags) ? body.defaultTags.filter((t): t is string => typeof t === "string" && !!t) : [];
    const now = formatServerDate(this.svc.now());
    const binding: CalendarProjectBinding = {
      id: typeof body.id === "string" && body.id ? body.id : newId(this.svc.now()),
      accountId,
      calendarId: body.calendarId,
      syncProjectScope: scope,
      syncProjectId: projectId,
      defaultTags,
      createdTime: now,
      modifiedTime: now,
    };
    this.store.tx(() => {
      this.store.run(
        "insert into calendar_project_bindings(id, accountId, calendarId, json) values (?,?,?,?) on conflict(id) do update set json=excluded.json",
        binding.id,
        accountId,
        binding.calendarId,
        JSON.stringify(binding),
      );
    });
    return binding;
  }

  updateProjectBinding(accountId: string, body: unknown): CalendarProjectBinding {
    if (!isPlainObject(body) || typeof body.id !== "string") throw new ApiError(400, "invalid_binding");
    const row = this.store.get<{ json: string }>("select json from calendar_project_bindings where id = ? and accountId = ?", body.id, accountId);
    if (!row) throw new ApiError(404, "binding_not_found");
    const prev = JSON.parse(row.json) as CalendarProjectBinding;
    const next: CalendarProjectBinding = {
      ...prev,
      ...(body.syncProjectScope === "all" || body.syncProjectScope === "project" ? { syncProjectScope: body.syncProjectScope } : {}),
      ...(typeof body.syncProjectId === "string" ? { syncProjectId: body.syncProjectId } : {}),
      ...(Array.isArray(body.defaultTags) ? { defaultTags: body.defaultTags.filter((t): t is string => typeof t === "string" && !!t) } : {}),
      modifiedTime: formatServerDate(this.svc.now()),
    };
    this.store.tx(() => {
      this.store.run("update calendar_project_bindings set json = ? where id = ?", JSON.stringify(next), next.id);
    });
    return next;
  }

  /** Unlink binding: removes link records while leaving both local tasks and remote events intact (CAL-070). */
  unbindProject(accountId: string, bindingId: string): { unlinked: boolean } {
    return this.store.tx(() => {
      const row = this.store.get("select id from calendar_project_bindings where id = ? and accountId = ?", bindingId, accountId);
      if (!row) throw new ApiError(404, "binding_not_found");
      this.store.run("delete from calendar_event_task_links where bindingId = ?", bindingId);
      this.store.run("delete from calendar_project_bindings where id = ?", bindingId);
      return { unlinked: true };
    });
  }

  async createRemoteEvent(accountId: string, body: unknown): Promise<RemoteCalendarEvent> {
    if (!isPlainObject(body) || typeof body.calendarId !== "string" || typeof body.title !== "string") {
      throw new ApiError(400, "invalid_event");
    }
    const { tz } = this.svc.userCtx();
    const isAllDay = body.isAllDay === true || body.allDay === true;
    const startMs = parseQueryMs(body.start ?? body.startDate ?? body.dueStart, NaN);
    const endMs = parseQueryMs(body.end ?? body.dueDate ?? body.dueEnd, isAllDay ? startMs + DAY_MS : startMs + 30 * 60_000);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) throw new ApiError(400, "invalid_date_range");

    return await this.withAdapter(accountId, async (_acc, adapter, ctx) => {
      if (!isReadWriteAdapter(adapter)) throw new ApiError(400, "read_only_provider");
      return await adapter.createEvent(ctx, {
        calendarId: body.calendarId as string,
        title: body.title as string,
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.location === "string" ? { location: body.location } : {}),
        startMs,
        endMs,
        isAllDay,
        timeZone: typeof body.timeZone === "string" && isValidTimeZone(body.timeZone) ? body.timeZone : tz,
      });
    });
  }

  async updateRemoteEvent(accountId: string, externalId: string, body: unknown): Promise<RemoteCalendarEvent> {
    if (!isPlainObject(body) || typeof body.calendarId !== "string") throw new ApiError(400, "invalid_event");
    const { tz } = this.svc.userCtx();
    const isAllDay = body.isAllDay !== undefined ? body.isAllDay === true : body.allDay !== undefined ? body.allDay === true : undefined;
    const startMs = body.start ?? body.startDate ?? body.dueStart ? parseQueryMs(body.start ?? body.startDate ?? body.dueStart, NaN) : undefined;
    const endMs = body.end ?? body.dueDate ?? body.dueEnd ? parseQueryMs(body.end ?? body.dueDate ?? body.dueEnd, NaN) : undefined;

    return await this.withAdapter(accountId, async (_acc, adapter, ctx) => {
      if (!isReadWriteAdapter(adapter)) throw new ApiError(400, "read_only_provider");
      return await adapter.updateEvent(ctx, {
        externalId,
        calendarId: body.calendarId as string,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
        ...(typeof body.description === "string" ? { description: body.description } : {}),
        ...(typeof body.location === "string" ? { location: body.location } : {}),
        ...(startMs !== undefined && Number.isFinite(startMs) ? { startMs } : {}),
        ...(endMs !== undefined && Number.isFinite(endMs) ? { endMs } : {}),
        ...(isAllDay !== undefined ? { isAllDay } : {}),
        timeZone: typeof body.timeZone === "string" && isValidTimeZone(body.timeZone) ? body.timeZone : tz,
      });
    });
  }

  async deleteRemoteEvent(accountId: string, calendarId: string, externalId: string): Promise<{ deleted: boolean }> {
    await this.withAdapter(accountId, async (_acc, adapter, ctx) => {
      if (!isReadWriteAdapter(adapter)) throw new ApiError(400, "read_only_provider");
      await adapter.deleteEvent(ctx, calendarId, externalId);
    });
    this.store.run("delete from calendar_event_task_links where accountId = ? and calendarId = ? and externalEventId = ?", accountId, calendarId, externalId);
    return { deleted: true };
  }

  /**
   * Two-way sync for a connected account's project bindings:
   * - Pull: remote events create/update/trash linked NoorTasks tasks (honoring defaultTags and inline #tag / ~list when scope === "all").
   * - Push: dirty linked tasks or unlinked dated tasks in bound projects create/update remote events.
   */
  async syncAccountBindings(accountId: string, window: { fromMs: number; toMs: number }): Promise<{ pulled: number; pushed: number; updated: number; deleted: number }> {
    const bindings = this.listBindings(accountId);
    if (bindings.length === 0) return { pulled: 0, pushed: 0, updated: 0, deleted: 0 };

    const { tz } = this.svc.userCtx();
    const nowMs = this.svc.now();
    const now = formatServerDate(nowMs);
    let pulled = 0;
    let pushed = 0;
    let updated = 0;
    let deleted = 0;

    for (const binding of bindings) {
      const remoteEvents = await this.withAdapter(accountId, async (_acc, adapter, ctx) =>
        adapter.fetchEvents(ctx, binding.calendarId, { fromMs: window.fromMs, toMs: window.toMs, timeZone: tz }),
      );

      // 1. Pull remote -> local tasks
      this.store.tx(() => {
        const seq = this.store.seq();
        const projects = this.store.collAll<Project>("projects");
        for (const ev of remoteEvents) {
          const link = this.store.get<{ id: string; taskId: string; externalEtag: string | null; taskEtag: string | null }>(
            "select id, taskId, externalEtag, taskEtag from calendar_event_task_links where accountId = ? and calendarId = ? and externalEventId = ?",
            accountId,
            binding.calendarId,
            ev.externalId,
          );

          if (ev.status === "cancelled") {
            if (link) {
              const t = this.store.getTask(link.taskId);
              if (t && !t.deleted) {
                t.deleted = 1;
                t.deletedTime = nowMs;
                t.etag = newEtag();
                t.modifiedTime = now;
                this.store.putTask(t, { seq });
                deleted++;
              }
              this.store.run("delete from calendar_event_task_links where id = ?", link.id);
            }
            continue;
          }

          if (link) {
            const existingTask = this.store.getTask(link.taskId);
            if (!existingTask) {
              this.store.run("delete from calendar_event_task_links where id = ?", link.id);
              continue;
            }
            const taskDirty = existingTask.etag !== link.taskEtag;
            const remoteChanged = (ev.etag ?? null) !== link.externalEtag;
            if (remoteChanged && !taskDirty && !existingTask.deleted) {
              existingTask.title = ev.title;
              if (ev.description !== undefined) existingTask.content = ev.description;
              existingTask.startDate = formatServerDate(ev.startMs);
              existingTask.dueDate = formatServerDate(ev.endMs);
              existingTask.isAllDay = ev.isAllDay;
              existingTask.timeZone = ev.timeZone ?? tz;
              existingTask.etag = newEtag();
              existingTask.modifiedTime = now;
              this.store.putTask(existingTask, { seq });
              this.store.run(
                "update calendar_event_task_links set externalEtag = ?, taskEtag = ?, lastSyncedMs = ? where id = ?",
                ev.etag ?? null,
                existingTask.etag,
                nowMs,
                link.id,
              );
              updated++;
            }
            continue;
          }

          // Parse inline #tag and ~list when bound to "all" (CAL-070)
          let targetProjectId = binding.syncProjectId || this.svc.inboxId;
          const tags = new Set<string>(binding.defaultTags.map((t) => t.toLowerCase()));
          if (binding.syncProjectScope === "all") {
            const listMatch = /(?:^|\s)~([^\s]+)/.exec(ev.title);
            if (listMatch) {
              const wanted = listMatch[1]!.toLowerCase();
              if (wanted === "inbox") targetProjectId = this.svc.inboxId;
              else {
                const found = projects.find((p) => p.name.toLowerCase() === wanted);
                if (found) targetProjectId = found.id;
              }
            }
            for (const m of ev.title.matchAll(/(?:^|\s)#([^\s#]+)/g)) {
              tags.add(m[1]!.toLowerCase());
            }
          }

          const taskId = newId(nowMs);
          const task: Task = {
            id: taskId,
            projectId: targetProjectId,
            title: ev.title,
            ...(ev.description ? { content: ev.description } : {}),
            kind: "TEXT",
            status: TaskStatus.Open,
            priority: 0,
            sortOrder: 0,
            startDate: formatServerDate(ev.startMs),
            dueDate: formatServerDate(ev.endMs),
            isAllDay: ev.isAllDay,
            isFloating: false,
            timeZone: ev.timeZone ?? tz,
            tags: [...tags],
            calendarId: binding.calendarId,
            accountId,
            externalEventId: ev.externalId,
            createdTime: now,
            modifiedTime: now,
            creator: this.svc.userId,
            etag: newEtag(),
          };
          this.store.putTask(task, { seq });
          this.store.run(
            `insert into calendar_event_task_links(id, bindingId, accountId, calendarId, externalEventId, taskId, externalEtag, taskEtag, lastSyncedMs)
             values (?,?,?,?,?,?,?,?,?)`,
            newId(nowMs),
            binding.id,
            accountId,
            binding.calendarId,
            ev.externalId,
            taskId,
            ev.etag ?? null,
            task.etag!,
            nowMs,
          );
          pulled++;
        }
      });

      // 2. Push local tasks -> remote events
      const links = this.store.all<{ id: string; externalEventId: string; taskId: string; externalEtag: string | null; taskEtag: string | null }>(
        "select id, externalEventId, taskId, externalEtag, taskEtag from calendar_event_task_links where bindingId = ?",
        binding.id,
      );
      const linkedTaskIds = new Set(links.map((l) => l.taskId));

      for (const link of links) {
        const task = this.store.getTask(link.taskId);
        if (!task || task.deleted) {
          await this.withAdapter(accountId, async (_acc, adapter, ctx) => {
            if (isReadWriteAdapter(adapter)) await adapter.deleteEvent(ctx, binding.calendarId, link.externalEventId);
          });
          this.store.run("delete from calendar_event_task_links where id = ?", link.id);
          deleted++;
          continue;
        }
        if (task.etag !== link.taskEtag) {
          const span = this.taskSpanForSync(task, tz);
          if (!span) continue;
          const remote = await this.withAdapter(accountId, async (_acc, adapter, ctx) => {
            if (!isReadWriteAdapter(adapter)) throw new ApiError(400, "read_only_provider");
            return adapter.updateEvent(ctx, {
              externalId: link.externalEventId,
              calendarId: binding.calendarId,
              title: task.title,
              ...(typeof task.content === "string" ? { description: task.content } : {}),
              startMs: span.startMs,
              endMs: span.endMs,
              isAllDay: span.isAllDay,
              timeZone: task.timeZone && isValidTimeZone(task.timeZone) ? task.timeZone : tz,
            });
          });
          this.store.run(
            "update calendar_event_task_links set externalEtag = ?, taskEtag = ?, lastSyncedMs = ? where id = ?",
            remote.etag ?? null,
            task.etag ?? null,
            nowMs,
            link.id,
          );
          updated++;
        }
      }

      // New unlinked dated tasks in bound list (or all lists when scope === "all")
      const candidateTasks = (
        binding.syncProjectScope === "all"
          ? this.store.all<{ json: string }>("select json from tasks where deleted = 0 order by pos").map((r) => JSON.parse(r.json) as Task)
          : binding.syncProjectId
            ? this.store.tasksOfProject(binding.syncProjectId, 0)
            : []
      ).filter((t) => !linkedTaskIds.has(t.id) && !t.externalEventId && (t.startDate || t.dueDate));

      for (const task of candidateTasks) {
        const span = this.taskSpanForSync(task, tz);
        if (!span || !overlaps(span.startMs, span.endMs, window.fromMs, window.toMs)) continue;
        const remote = await this.withAdapter(accountId, async (_acc, adapter, ctx) => {
          if (!isReadWriteAdapter(adapter)) throw new ApiError(400, "read_only_provider");
          return adapter.createEvent(ctx, {
            calendarId: binding.calendarId,
            title: task.title,
            ...(typeof task.content === "string" ? { description: task.content } : {}),
            startMs: span.startMs,
            endMs: span.endMs,
            isAllDay: span.isAllDay,
            timeZone: task.timeZone && isValidTimeZone(task.timeZone) ? task.timeZone : tz,
          });
        });
        this.store.tx(() => {
          const seq = this.store.seq();
          task.calendarId = binding.calendarId;
          task.accountId = accountId;
          task.externalEventId = remote.externalId;
          task.etag = newEtag();
          task.modifiedTime = now;
          this.store.putTask(task, { seq });
          this.store.run(
            `insert into calendar_event_task_links(id, bindingId, accountId, calendarId, externalEventId, taskId, externalEtag, taskEtag, lastSyncedMs)
             values (?,?,?,?,?,?,?,?,?)`,
            newId(nowMs),
            binding.id,
            accountId,
            binding.calendarId,
            remote.externalId,
            task.id,
            remote.etag ?? null,
            task.etag!,
            nowMs,
          );
        });
        pushed++;
      }

      this.store.run(
        "update calendar_project_bindings set json = ? where id = ?",
        JSON.stringify({ ...binding, lastSyncAt: now, modifiedTime: now }),
        binding.id,
      );
    }

    return { pulled, pushed, updated, deleted };
  }

  private taskSpanForSync(task: Task, userTz: string): { startMs: number; endMs: number; isAllDay: boolean } | null {
    const rawStart = task.startDate ?? task.dueDate;
    if (!rawStart) return null;
    const isAllDay = task.isAllDay !== false;
    const isFloating = task.isFloating === true;
    const srcTz = isValidTimeZone(task.timeZone) ? task.timeZone : userTz;
    const s = parseTaskInstant(rawStart, isAllDay, isFloating, srcTz, userTz);
    if (s === undefined) return null;
    const eRaw = parseTaskInstant(task.dueDate, isAllDay, isFloating, srcTz, userTz);
    let e: number;
    if (isAllDay) {
      if (eRaw !== undefined && eRaw > s) e = eRaw;
      else {
        const sp = zonedParts(s, userTz);
        const next = parseStamp(addDays(makeStamp(sp.y, sp.m, sp.d), 1));
        e = wallToInstant(next.y, next.m, next.d, 0, 0, 0, userTz);
      }
    } else {
      e = eRaw !== undefined && eRaw > s ? eRaw : s + 30 * 60_000;
    }
    return { startMs: s, endMs: e, isAllDay };
  }

  async getAccountEvents(
    fromMs: number,
    toMs: number,
    opts: { accountId?: string; provider?: string; showDeclined?: boolean; deduplicateLinkedTasks?: boolean } = {},
  ): Promise<CalendarEventItem[]> {
    const { tz } = this.svc.userCtx();
    const vc = this.viewConf();
    const showDeclined = opts.showDeclined ?? vc.showDeclinedEvents;
    const archived = this.archivedIds();

    let accounts = this.listStoredAccounts().filter((a) => a.show !== false);
    if (opts.accountId) {
      const one = this.getStoredAccount(opts.accountId);
      if (!one) throw new ApiError(404, "account_not_found");
      accounts = [one];
    } else if (opts.provider) {
      accounts = accounts.filter((a) => a.provider === opts.provider);
    }

    const linkedKeys = new Set<string>();
    if (opts.deduplicateLinkedTasks) {
      for (const l of this.store.all<{ accountId: string; calendarId: string; externalEventId: string; taskId: string }>(
        "select accountId, calendarId, externalEventId, taskId from calendar_event_task_links",
      )) {
        const t = this.store.getTaskRow(l.taskId);
        if (t && !t.deleted) linkedKeys.add(`${l.accountId}:${l.calendarId}:${l.externalEventId}`);
      }
    }

    const out: CalendarEventItem[] = [];
    for (const acc of accounts) {
      const visibleCals = (acc.calendars ?? []).filter((c) => c.show !== false);
      for (const cal of visibleCals) {
        let events: RemoteCalendarEvent[];
        try {
          events = await this.withAdapter(acc.id, async (_a, adapter, ctx) =>
            adapter.fetchEvents(ctx, cal.id, { fromMs, toMs, timeZone: tz }),
          );
          this.store.run(
            `insert into calendar_account_cache(cacheKey, accountId, calendarId, windowFromMs, windowToMs, fetchedAtMs, lastError, json)
             values (?,?,?,?,?,?,?,?)
             on conflict(cacheKey) do update set windowFromMs=excluded.windowFromMs, windowToMs=excluded.windowToMs,
               fetchedAtMs=excluded.fetchedAtMs, lastError=null, json=excluded.json`,
            `${acc.id}:${cal.id}`,
            acc.id,
            cal.id,
            fromMs,
            toMs,
            this.svc.now(),
            null,
            JSON.stringify(events),
          );
        } catch (err) {
          const msg = "calendar_upstream_failed";
          this.store.tx(() => {
            const latest = this.getStoredAccount(acc.id);
            if (latest) {
              this.saveStoredAccount({ ...latest, lastError: msg, modifiedTime: formatServerDate(this.svc.now()) }, this.store.seq());
            }
          });
          if (opts.accountId) throw err;
          continue;
        }

        for (const ev of events) {
          if (ev.status === "cancelled") continue;
          if (ev.partStat === "declined" && !showDeclined) continue;
          if (!overlaps(ev.startMs, ev.endMs, fromMs, toMs)) continue;
          if (linkedKeys.has(`${acc.id}:${cal.id}:${ev.externalId}`)) continue;
          const wireId = `${acc.id}:${cal.id}:${ev.externalId}`;
          if (archived.has(wireId) || archived.has(ev.externalId)) continue;

          out.push(
            toWireEvent({
              id: wireId,
              key: `acc:${wireId}`,
              uid: ev.externalId,
              kind: CalendarItemKind.Subscribe,
              sourceType: acc.provider,
              itemType: acc.itemType,
              sourceId: acc.id,
              calendarId: cal.id,
              accountId: acc.id,
              title: ev.title,
              ...(ev.description ? { description: ev.description } : {}),
              ...(ev.location ? { location: ev.location } : {}),
              color: cal.color ?? null,
              startMs: ev.startMs,
              endMs: ev.endMs,
              isAllDay: ev.isAllDay,
              ...(ev.timeZone ? { timeZone: ev.timeZone } : {}),
              completed: false,
              readOnly: cal.readOnly === true || acc.provider === "caldav" || acc.provider === "icloud",
              status: ev.status,
              ...(ev.partStat ? { partStat: ev.partStat } : {}),
              ...(ev.url ? { url: ev.url } : {}),
            }),
          );
        }
      }
    }

    out.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
    return out;
  }

  // ------------------------------------------------------------------ Archived events

  private archivedIds(): Set<string> {
    return new Set(this.store.all<{ id: string }>("select id from calendar_archived_events").map((r) => r.id));
  }

  listArchivedEvents(): Loose[] {
    return this.store.all<{ json: string }>("select json from calendar_archived_events").map((r) => JSON.parse(r.json) as Loose);
  }

  archiveEvents(body: unknown): Loose[] {
    const items = Array.isArray(body) ? body : isPlainObject(body) && Array.isArray(body.events) ? body.events : isPlainObject(body) ? [body] : [];
    const saved: Loose[] = [];
    this.store.tx(() => {
      for (const raw of items) {
        if (!isPlainObject(raw)) continue;
        const id = typeof raw.id === "string" ? raw.id : typeof raw.eventId === "string" ? raw.eventId : typeof raw.uid === "string" ? raw.uid : undefined;
        if (!id) continue;
        const obj = { ...raw, id };
        this.store.run("insert into calendar_archived_events(id, json) values (?, ?) on conflict(id) do update set json=excluded.json", id, JSON.stringify(obj));
        saved.push(obj);
      }
    });
    return saved;
  }

  // ------------------------------------------------------------------ 5. Unified GET across all sources

  getTaskCalendarEvents(
    fromMs: number,
    toMs: number,
    opts: { showCompleted?: boolean; showChecklist?: boolean; showFutureTask?: boolean; showRepeat?: boolean } = {},
  ): CalendarEventItem[] {
    const { tz, weekStart } = this.svc.userCtx();
    const wkCode = WEEKDAY_CODES[weekStart] ?? "SU";
    const holidays = this.holidayProvider();
    const vc = this.viewConf();
    const showCompleted = opts.showCompleted ?? vc.showCompleted;
    const showChecklist = opts.showChecklist ?? vc.showChecklist;
    const showFutureTask = opts.showFutureTask ?? vc.showFutureTask;
    const showRepeat = opts.showRepeat ?? true;

    const todayStamp = stampOf(this.svc.now(), tz);
    const nextDayP = parseStamp(addDays(todayStamp, 1));
    const todayEnd = wallToInstant(nextDayP.y, nextDayP.m, nextDayP.d, 0, 0, 0, tz);
    const futureOk = (s: number): boolean => showFutureTask || s < todayEnd;

    const settings = (this.store.getDoc<Loose>("settings")?.json ?? {}) as Loose;
    const projectColor = new Map<string, string | null>();
    if (typeof settings.inboxColor === "string" && settings.inboxColor) projectColor.set(this.svc.inboxId, settings.inboxColor);
    for (const p of this.store.collAll<Project>("projects")) {
      projectColor.set(p.id, p.color ?? null);
    }

    const out: CalendarEventItem[] = [];
    const tasks = this.store.all<{ json: string }>("select json from tasks where deleted = 0 order by pos").map((r) => JSON.parse(r.json) as Task);

    for (const t of tasks) {
      const completed = t.status !== TaskStatus.Open;
      if (completed && !showCompleted) continue;

      const span = this.taskSpanForSync(t, tz);
      const color = projectColor.get(t.projectId) ?? null;
      if (span) {
        if (overlaps(span.startMs, span.endMs, fromMs, toMs) && futureOk(span.startMs)) {
          out.push(
            toWireEvent({
              id: t.id,
              key: t.id,
              kind: CalendarItemKind.Task,
              sourceType: "task",
              sourceId: t.projectId,
              ...(typeof t.calendarId === "string" ? { calendarId: t.calendarId } : {}),
              ...(typeof t.accountId === "string" ? { accountId: t.accountId } : {}),
              taskId: t.id,
              projectId: t.projectId,
              title: t.title,
              ...(typeof t.content === "string" && t.content ? { description: t.content } : {}),
              color,
              startMs: span.startMs,
              endMs: span.endMs,
              isAllDay: span.isAllDay,
              timeZone: t.timeZone && isValidTimeZone(t.timeZone) ? t.timeZone : tz,
              completed,
              readOnly: false,
              status: completed ? "completed" : "confirmed",
              ...(typeof t.priority === "number" ? { priority: t.priority } : {}),
              ...(Array.isArray(t.tags) ? { tags: t.tags } : {}),
            }),
          );
        }

        if (showRepeat && t.repeatFlag && !completed && t.repeatFrom !== "1") {
          const len = span.endMs - span.startMs;
          const targetZone = t.isAllDay === false && !t.isFloating && isValidTimeZone(t.timeZone) ? t.timeZone! : tz;
          let occs: Date[] = [];
          try {
            occs = occurrencesBetween(
              {
                repeatFlag: t.repeatFlag,
                repeatFrom: t.repeatFrom ?? "2",
                startDate: span.startMs,
                timeZoneId: targetZone,
                exDates: Array.isArray(t.exDate) ? t.exDate : [],
              },
              fromMs - len - DAY_MS,
              toMs + DAY_MS,
              { deviceZone: tz, defaultWeekStart: wkCode, holidays },
            );
          } catch {
            occs = [];
          }
          for (const d of occs) {
            const s = d.getTime();
            if (s <= span.startMs) continue;
            const e = s + len;
            if (!overlaps(s, e, fromMs, toMs) || !futureOk(s)) continue;
            out.push(
              toWireEvent({
                id: `${t.id}@${s}`,
                key: `${t.id}@${s}`,
                kind: CalendarItemKind.Repeat,
                sourceType: "task",
                sourceId: t.projectId,
                taskId: t.id,
                projectId: t.projectId,
                title: t.title,
                ...(typeof t.content === "string" && t.content ? { description: t.content } : {}),
                color,
                startMs: s,
                endMs: e,
                isAllDay: span.isAllDay,
                timeZone: targetZone,
                completed: false,
                readOnly: false,
                status: "confirmed",
                isRecurring: true,
                occurrence: s,
                ...(typeof t.priority === "number" ? { priority: t.priority } : {}),
                ...(Array.isArray(t.tags) ? { tags: t.tags } : {}),
              }),
            );
          }
        }
      }

      if (showChecklist && Array.isArray(t.items)) {
        for (const it of t.items) {
          if (!it || typeof it.startDate !== "string" || !it.startDate) continue;
          const itemDone = !!it.status;
          if (itemDone && !showCompleted) continue;
          const itemAllDay = it.isAllDay !== false;
          const itemTz = isValidTimeZone(it.timeZone) ? it.timeZone : tz;
          const s = parseTaskInstant(it.startDate, itemAllDay, t.isFloating === true, itemTz, tz);
          if (s === undefined) continue;
          let e: number;
          if (itemAllDay) {
            const sp = zonedParts(s, tz);
            const next = parseStamp(addDays(makeStamp(sp.y, sp.m, sp.d), 1));
            e = wallToInstant(next.y, next.m, next.d, 0, 0, 0, tz);
          } else {
            e = s + 30 * 60_000;
          }
          if (!overlaps(s, e, fromMs, toMs) || !futureOk(s)) continue;
          out.push(
            toWireEvent({
              id: `${t.id}/${it.id}`,
              key: `${t.id}/${it.id}`,
              kind: CalendarItemKind.Subtask,
              sourceType: "subtask",
              sourceId: t.projectId,
              taskId: t.id,
              itemId: it.id,
              projectId: t.projectId,
              title: it.title || t.title,
              color,
              startMs: s,
              endMs: e,
              isAllDay: itemAllDay,
              timeZone: itemTz,
              completed: itemDone,
              readOnly: false,
              status: itemDone ? "completed" : "confirmed",
            }),
          );
        }
      }
    }

    return out;
  }

  async unifiedEvents(
    fromMs: number,
    toMs: number,
    opts: {
      sources?: string[];
      includeCompleted?: boolean;
      includeChecklist?: boolean;
      includeFutureTask?: boolean;
      showRepeat?: boolean;
      showDeclined?: boolean;
      forceRefresh?: boolean;
    } = {},
  ): Promise<CalendarEventItem[]> {
    const active = opts.sources && opts.sources.length > 0 ? new Set(opts.sources.map((s) => s.toLowerCase())) : null;
    const want = (key: string): boolean => !active || active.has(key) || active.has("all");

    const results: CalendarEventItem[] = [];

    if (want("tasks")) {
      results.push(
        ...this.getTaskCalendarEvents(fromMs, toMs, {
          ...(opts.includeCompleted !== undefined ? { showCompleted: opts.includeCompleted } : {}),
          ...(opts.includeChecklist !== undefined ? { showChecklist: opts.includeChecklist } : {}),
          ...(opts.includeFutureTask !== undefined ? { showFutureTask: opts.includeFutureTask } : {}),
          ...(opts.showRepeat !== undefined ? { showRepeat: opts.showRepeat } : {}),
        }),
      );
    }

    if (want("subscriptions") || want("holidays")) {
      const subEvents = await this.getSubscriptionEvents(fromMs, toMs, {
        ...(opts.forceRefresh !== undefined ? { forceRefresh: opts.forceRefresh } : {}),
        ...(opts.showDeclined !== undefined ? { showDeclined: opts.showDeclined } : {}),
      });
      for (const ev of subEvents) {
        if (!active) results.push(ev);
        else if (ev.sourceType === "holiday" && want("holidays")) results.push(ev);
        else if (ev.sourceType !== "holiday" && want("subscriptions")) results.push(ev);
      }
    }

    if (want("accounts")) {
      results.push(
        ...(await this.getAccountEvents(fromMs, toMs, {
          ...(opts.showDeclined !== undefined ? { showDeclined: opts.showDeclined } : {}),
          deduplicateLinkedTasks: true,
        })),
      );
    }

    results.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
    return results;
  }
}

// ------------------------------------------------------------------ Routes

function extractWindowFromReq(cal: CalendarService, req: { query?: unknown; body?: unknown }): { fromMs: number; toMs: number } {
  const q = isPlainObject(req.query) ? req.query : {};
  const b = isPlainObject(req.body) ? req.body : {};
  const from = q.from ?? q.begin ?? q.start ?? b.from ?? b.begin ?? b.start;
  const to = q.to ?? q.end ?? b.to ?? b.end;
  return cal.resolveWindow(from, to);
}

function originOfReq(req: { protocol?: string; headers?: Record<string, unknown> }): string {
  const fwdProto = typeof req.headers?.["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"].split(",")[0]!.trim() : "";
  const fwdHost = typeof req.headers?.["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"].split(",")[0]!.trim() : "";
  const proto = fwdProto || req.protocol || "http";
  const host = fwdHost || (typeof req.headers?.host === "string" && req.headers.host ? req.headers.host : "127.0.0.1");
  return `${proto}://${host}`;
}

export function registerCalendarRoutes(
  app: FastifyInstance,
  svc: Service,
  opts: CalendarServiceOptions = {},
): CalendarService {
  const cal = new CalendarService(svc, opts);

  // ---- Subscriptions & Holidays
  app.get("/api/v2/calendar/holidays/presets", async () => HOLIDAY_PRESETS);
  app.get("/pub/api/v1/calendar/holiday/cn/recent", async () => []);

  app.get("/api/v2/calendar/subscription", async () => cal.listSubscriptions());
  app.post("/api/v2/calendar/subscribe", async (req) => cal.subscribe(req.body));
  app.post("/api/v2/calendar/holiday/subscribe", async (req) => cal.subscribe(req.body));
  app.post("/api/v2/calendar/batch/subscribe", async (req) => cal.batchSubscribe(req.body));

  app.put<{ Params: { id: string } }>("/api/v2/calendar/subscription/:id", async (req) => cal.updateSubscription(req.params.id, req.body));
  app.patch<{ Params: { id: string } }>("/api/v2/calendar/subscription/:id", async (req) => cal.updateSubscription(req.params.id, req.body));
  app.put<{ Params: { id: string } }>("/api/v2/calendar/subscribe/:id", async (req) => cal.updateSubscription(req.params.id, req.body));
  app.post<{ Params: { id: string } }>("/api/v2/calendar/update/:id", async (req) => {
    if (cal.getSubscription(req.params.id)) return cal.updateSubscription(req.params.id, req.body);
    return cal.updateAccount(req.params.id, req.body);
  });

  app.put<{ Params: { id: string }; Querystring: { show?: string; isMobile?: string } }>(
    "/api/v2/calendar/batch/:id/show",
    async (req) => cal.setVisibility(req.params.id, req.body, req.query.show),
  );
  app.put<{ Params: { id: string } }>("/api/v2/calendar/:id/desc", async (req) => cal.setDescription(req.params.id, req.body));
  app.post("/api/v2/calendar/subscribe/sortOrder", async (req) => cal.sortSubscriptions(req.body));

  app.delete<{ Params: { id: string } }>("/api/v2/calendar/unsubscribe/:id", async (req) => cal.unsubscribe([req.params.id]));
  app.delete("/api/v2/calendar/unsubscribe", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const raw = b.data ?? b.ids ?? b.id;
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : typeof raw === "string" ? [raw] : [];
    return cal.unsubscribe(ids);
  });

  app.get<{ Querystring: { from?: string; to?: string; begin?: string; end?: string; refresh?: string; includeHidden?: string; showDeclined?: string } }>(
    "/api/v2/calendar/subscribe/events",
    async (req) => {
      const { fromMs, toMs } = extractWindowFromReq(cal, req);
      return cal.getSubscriptionEvents(fromMs, toMs, {
        forceRefresh: parseBoolParam(req.query.refresh) ?? false,
        includeHidden: parseBoolParam(req.query.includeHidden) ?? false,
        ...(parseBoolParam(req.query.showDeclined) !== undefined ? { showDeclined: parseBoolParam(req.query.showDeclined)! } : {}),
      });
    },
  );
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; begin?: string; end?: string; refresh?: string; showDeclined?: string } }>(
    "/api/v2/calendar/subscribe/events/:id",
    async (req) => {
      const { fromMs, toMs } = extractWindowFromReq(cal, req);
      return cal.getSubscriptionEvents(fromMs, toMs, {
        subId: req.params.id,
        includeHidden: true,
        forceRefresh: parseBoolParam(req.query.refresh) ?? false,
        ...(parseBoolParam(req.query.showDeclined) !== undefined ? { showDeclined: parseBoolParam(req.query.showDeclined)! } : {}),
      });
    },
  );
  app.get<{ Params: { id: string } }>("/api/v2/calendar/cache/:id", async (req) => cal.getCacheInfo(req.params.id));

  // ---- Outgoing private ICS feed
  app.get("/api/v2/calendar/feeds/code", async () => cal.getFeedCode());

  const handleNewFeed = async (req: { query: unknown; body: unknown }): Promise<CalendarFeedConfig> => {
    const q = isPlainObject(req.query) ? req.query : {};
    const b = isPlainObject(req.body) ? req.body : {};
    const includeDone = parseBoolParam(q.includeDone ?? b.includeDone);
    const includeHabits = parseBoolParam(q.includeHabits ?? b.includeHabits);
    let projectIds: string[] | null | undefined;
    if (b.projectIds === null) projectIds = null;
    else if (Array.isArray(b.projectIds)) projectIds = b.projectIds.filter((x): x is string => typeof x === "string" && !!x);
    else if (typeof q.projectIds === "string") projectIds = q.projectIds ? q.projectIds.split(",").filter(Boolean) : [];
    return cal.createOrResetFeedCode({
      ...(includeDone !== undefined ? { includeDone } : {}),
      ...(includeHabits !== undefined ? { includeHabits } : {}),
      ...(projectIds !== undefined ? { projectIds } : {}),
    });
  };
  app.post("/api/v2/calendar/feeds/code/new/:t", handleNewFeed);
  app.post("/api/v2/calendar/feeds/code/new", handleNewFeed);

  const handleUpdateFeedSettings = async (req: { body: unknown }): Promise<CalendarFeedConfig> => {
    const b = isPlainObject(req.body) ? req.body : {};
    const includeDone = parseBoolParam(b.includeDone);
    const includeHabits = parseBoolParam(b.includeHabits);
    let projectIds: string[] | null | undefined;
    if (b.projectIds === null) projectIds = null;
    else if (Array.isArray(b.projectIds)) projectIds = b.projectIds.filter((x): x is string => typeof x === "string" && !!x);
    return cal.updateFeedSettings({
      ...(includeDone !== undefined ? { includeDone } : {}),
      ...(includeHabits !== undefined ? { includeHabits } : {}),
      ...(projectIds !== undefined ? { projectIds } : {}),
    });
  };
  app.put("/api/v2/calendar/feeds/code", handleUpdateFeedSettings);
  app.put("/api/v2/calendar/feeds/settings", handleUpdateFeedSettings);

  app.delete<{ Params: { t: string } }>("/api/v2/calendar/feeds/cancel/:t", async (req) => cal.cancelFeedCode(req.params.t));
  app.delete("/api/v2/calendar/feeds/cancel", async () => cal.cancelFeedCode());

  // Public (token-authenticated) ICS feed endpoint
  app.get<{ Params: { tokenFile: string } }>("/feed/:tokenFile", async (req, reply) => {
    const raw = req.params.tokenFile;
    if (!raw.endsWith(".ics")) throw new ApiError(404, "feed_not_found");
    const token = raw.slice(0, -4);
    const ics = cal.renderPrivateFeed(token);
    return reply
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header("Cache-Control", "private, no-cache")
      .header("Content-Disposition", 'inline; filename="noortasks.ics"')
      .send(ics);
  });

  // ---- Third-party OAuth 2.0 (Google & Outlook) + CalDAV/iCloud
  app.get<{ Querystring: { state?: string; provider?: string; redirectUri?: string; redirectAfter?: string; redirect?: string } }>(
    "/api/v3/calendar/bind",
    async (req, reply) => {
      if (req.query.provider) {
        const res = cal.startOAuth(req.query.provider, {
          originUrl: originOfReq(req),
          ...(req.query.redirectUri ? { redirectUri: req.query.redirectUri } : {}),
          ...(req.query.redirectAfter ? { redirectAfter: req.query.redirectAfter } : {}),
        });
        if (parseBoolParam(req.query.redirect)) return reply.redirect(res.authorizationUrl);
        return res;
      }
      if (req.query.state) return cal.getOAuthStateStatus(req.query.state);
      throw new ApiError(400, "missing_state_or_provider");
    },
  );

  app.get<{ Params: { provider: string }; Querystring: { redirectUri?: string; redirectAfter?: string; redirect?: string } }>(
    "/api/v2/calendar/oauth/:provider/start",
    async (req, reply) => {
      const res = cal.startOAuth(req.params.provider, {
        originUrl: originOfReq(req),
        ...(req.query.redirectUri ? { redirectUri: req.query.redirectUri } : {}),
        ...(req.query.redirectAfter ? { redirectAfter: req.query.redirectAfter } : {}),
      });
      if (parseBoolParam(req.query.redirect)) return reply.redirect(res.authorizationUrl);
      return res;
    },
  );

  const handleOAuthCallback = async (
    req: { params: { provider: string }; query: unknown; body: unknown; protocol?: string; headers?: Record<string, unknown> },
    reply: { redirect: (u: string) => unknown },
  ) => {
    const q = isPlainObject(req.query) ? req.query : {};
    const b = isPlainObject(req.body) ? req.body : {};
    const out = await cal.completeOAuthCallback(req.params.provider, {
      ...(typeof (q.code ?? b.code) === "string" ? { code: String(q.code ?? b.code) } : {}),
      ...(typeof (q.state ?? b.state) === "string" ? { state: String(q.state ?? b.state) } : {}),
      ...(typeof (q.error ?? b.error) === "string" ? { error: String(q.error ?? b.error) } : {}),
      ...(typeof (q.error_description ?? b.error_description) === "string" ? { errorDescription: String(q.error_description ?? b.error_description) } : {}),
      originUrl: originOfReq(req),
      ...(typeof (q.redirectUri ?? b.redirectUri) === "string" ? { redirectUri: String(q.redirectUri ?? b.redirectUri) } : {}),
    });
    if (out.redirectAfter && !isPlainObject(req.body)) {
      return reply.redirect(out.redirectAfter);
    }
    return out.account;
  };
  app.get<{ Params: { provider: string } }>("/api/v2/calendar/oauth/:provider/callback", handleOAuthCallback);
  app.post<{ Params: { provider: string } }>("/api/v2/calendar/oauth/:provider/callback", handleOAuthCallback);

  app.post<{ Params: { provider: string } }>("/api/v2/calendar/oauth/:provider/refresh", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const id = typeof b.accountId === "string" ? b.accountId : typeof b.id === "string" ? b.id : "";
    if (!id) throw new ApiError(400, "missing_account_id");
    return cal.refreshAccountToken(id);
  });
  app.post<{ Params: { id: string } }>("/api/v2/calendar/accounts/:id/refresh", async (req) => cal.refreshAccountToken(req.params.id));

  app.post<{ Params: { provider: string } }>("/api/v2/calendar/oauth/:provider/disconnect", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const id = typeof b.accountId === "string" ? b.accountId : typeof b.id === "string" ? b.id : "";
    if (!id) throw new ApiError(400, "missing_account_id");
    return cal.disconnectAccount(id);
  });

  app.get("/api/v2/calendar/third/accounts", async () => cal.listAccounts());
  app.post("/api/v4/calendar/bind", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const provider = b.provider === "icloud" ? "icloud" : "caldav";
    return cal.bindCalDav(provider, req.body);
  });
  app.post("/api/v4/calendar/bind/icloud", async (req) => cal.bindCalDav("icloud", req.body));
  app.get("/api/v4/calendar/icloud/support/url", async () => ({ url: "https://support.apple.com/en-us/102654" }));

  app.post<{ Params: { id: string } }>("/api/v4/calendar/update/:id", async (req) => {
    if (cal.getSubscription(req.params.id)) return cal.updateSubscription(req.params.id, req.body);
    return cal.updateAccount(req.params.id, req.body);
  });
  app.post<{ Params: { id: string } }>("/api/v4/calendar/update/icloud/:id", async (req) => cal.updateAccount(req.params.id, req.body));

  app.delete<{ Params: { id: string } }>("/api/v2/calendar/bind/:id", async (req) => cal.disconnectAccount(req.params.id));
  app.delete<{ Params: { id: string } }>("/api/v2/calendar/connect/:id", async (req) => cal.disconnectAccount(req.params.id));
  app.delete<{ Params: { id: string } }>("/api/v2/calendar/accounts/:id", async (req) => cal.disconnectAccount(req.params.id));

  // ---- Two-way calendar-to-list bindings, sync & remote event writes
  app.post<{ Params: { id: string } }>("/api/v2/calendar/:id/create", async (req) => cal.createRemoteCalendar(req.params.id, req.body));
  app.get<{ Params: { id: string } }>("/api/v2/calendar/:id/bind/project", async (req) => cal.listBindings(req.params.id));
  app.post<{ Params: { id: string } }>("/api/v2/calendar/:id/bind/project", async (req) => cal.bindCalendarToProject(req.params.id, req.body));
  app.put<{ Params: { id: string } }>("/api/v2/calendar/:id/bind/project", async (req) => cal.updateProjectBinding(req.params.id, req.body));
  app.delete<{ Params: { id: string }; Querystring: { id?: string } }>("/api/v2/calendar/:id/bind/project", async (req) => {
    if (!req.query.id) throw new ApiError(400, "missing_binding_id");
    return cal.unbindProject(req.params.id, req.query.id);
  });

  app.post<{ Params: { id: string } }>("/api/v2/calendar/accounts/:id/sync", async (req) => {
    const win = extractWindowFromReq(cal, req);
    return cal.syncAccountBindings(req.params.id, win);
  });
  app.post<{ Params: { id: string } }>("/api/v2/calendar/accounts/:id/events", async (req) => cal.createRemoteEvent(req.params.id, req.body));
  app.put<{ Params: { id: string; eventId: string } }>("/api/v2/calendar/accounts/:id/events/:eventId", async (req) =>
    cal.updateRemoteEvent(req.params.id, req.params.eventId, req.body),
  );
  app.delete<{ Params: { id: string; eventId: string }; Querystring: { calendarId?: string } }>(
    "/api/v2/calendar/accounts/:id/events/:eventId",
    async (req) => {
      const b = isPlainObject(req.body) ? req.body : {};
      const calId = req.query.calendarId ?? (typeof b.calendarId === "string" ? b.calendarId : "");
      if (!calId) throw new ApiError(400, "missing_calendar_id");
      return cal.deleteRemoteEvent(req.params.id, calId, req.params.eventId);
    },
  );

  // Account event read / batch routes (CAL-062, CAL-901)
  app.get("/api/v2/calendar/bind/events/all", async (req) => {
    const { fromMs, toMs } = extractWindowFromReq(cal, req);
    return cal.getAccountEvents(fromMs, toMs);
  });
  app.post("/api/v2/calendar/bind/events/all", async (req) => {
    const { fromMs, toMs } = extractWindowFromReq(cal, req);
    return cal.getAccountEvents(fromMs, toMs);
  });
  app.post("/api/v2/calendar/bind/events/outlook", async (req) => {
    const { fromMs, toMs } = extractWindowFromReq(cal, req);
    return cal.getAccountEvents(fromMs, toMs, { provider: "outlook" });
  });
  app.post<{ Params: { id: string } }>("/api/v4/calendar/bind/events/:id", async (req) => {
    const { fromMs, toMs } = extractWindowFromReq(cal, req);
    return cal.getAccountEvents(fromMs, toMs, { accountId: req.params.id });
  });

  const handleBatchEvents = async (req: { body: unknown; query: unknown }) => {
    const b = isPlainObject(req.body) ? req.body : {};
    if (Array.isArray(b.add) || Array.isArray(b.update) || Array.isArray(b.delete)) {
      const created: RemoteCalendarEvent[] = [];
      const updated: RemoteCalendarEvent[] = [];
      const deletedIds: string[] = [];
      for (const item of Array.isArray(b.add) ? b.add : []) {
        if (isPlainObject(item) && typeof item.accountId === "string") {
          created.push(await cal.createRemoteEvent(item.accountId, item));
        }
      }
      for (const item of Array.isArray(b.update) ? b.update : []) {
        if (isPlainObject(item) && typeof item.accountId === "string" && typeof (item.externalId ?? item.id) === "string") {
          updated.push(await cal.updateRemoteEvent(item.accountId, String(item.externalId ?? item.id), item));
        }
      }
      for (const item of Array.isArray(b.delete) ? b.delete : []) {
        if (isPlainObject(item) && typeof item.accountId === "string" && typeof item.calendarId === "string" && typeof (item.externalId ?? item.id) === "string") {
          const eid = String(item.externalId ?? item.id);
          await cal.deleteRemoteEvent(item.accountId, item.calendarId, eid);
          deletedIds.push(eid);
        }
      }
      return { added: created, updated, deleted: deletedIds };
    }
    const { fromMs, toMs } = extractWindowFromReq(cal, req);
    return cal.getAccountEvents(fromMs, toMs);
  };
  app.post("/api/v2/calendar/bind/events/batch", handleBatchEvents);
  app.post("/api/v4/calendar/bind/events/batch", handleBatchEvents);

  // ---- Archived events
  app.get("/api/v2/calendar/archivedEvent", async () => cal.listArchivedEvents());
  app.post("/api/v2/calendar/archivedEvent", async (req) => cal.archiveEvents(req.body));

  // ---- 5. Unified GET for calendar events across all sources in a window
  app.get<{
    Querystring: {
      from?: string;
      to?: string;
      begin?: string;
      end?: string;
      start?: string;
      sources?: string;
      includeCompleted?: string;
      showCompleted?: string;
      includeChecklist?: string;
      showChecklist?: string;
      includeFutureTask?: string;
      showFutureTask?: string;
      showRepeat?: string;
      showDeclined?: string;
      refresh?: string;
    };
  }>("/api/v2/calendar/events", async (req) => {
    const { fromMs, toMs } = extractWindowFromReq(cal, req);
    const sources = typeof req.query.sources === "string" && req.query.sources.trim()
      ? req.query.sources.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    const includeCompleted = parseBoolParam(req.query.includeCompleted) ?? parseBoolParam(req.query.showCompleted);
    const includeChecklist = parseBoolParam(req.query.includeChecklist) ?? parseBoolParam(req.query.showChecklist);
    const includeFutureTask = parseBoolParam(req.query.includeFutureTask) ?? parseBoolParam(req.query.showFutureTask);
    const showRepeat = parseBoolParam(req.query.showRepeat);
    const showDeclined = parseBoolParam(req.query.showDeclined);
    const forceRefresh = parseBoolParam(req.query.refresh);
    return cal.unifiedEvents(fromMs, toMs, {
      ...(sources ? { sources } : {}),
      ...(includeCompleted !== undefined ? { includeCompleted } : {}),
      ...(includeChecklist !== undefined ? { includeChecklist } : {}),
      ...(includeFutureTask !== undefined ? { includeFutureTask } : {}),
      ...(showRepeat !== undefined ? { showRepeat } : {}),
      ...(showDeclined !== undefined ? { showDeclined } : {}),
      ...(forceRefresh !== undefined ? { forceRefresh } : {}),
    });
  });

  return cal;
}
