import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Agent as HttpsAgent } from "node:https";
import {
  ActivityAction,
  BatchError,
  CONSTANT_REMINDER_CYCLE_MS,
  CONSTANT_REMINDER_FLAG,
  NotificationCategory,
  TaskStatus,
  WEEKDAY_CODES,
  addDays,
  computeTriggerInstant,
  formatServerDate,
  isPlainObject,
  isScheduled,
  isValidStamp,
  isValidTimeZone,
  newEtag,
  newId,
  parseHabitRule,
  parseStamp,
  parseTrigger,
  parseWireDate,
  stampOf,
  stampRange,
  wallToInstant,
  weekdayOf,
  zonedParts,
  type BatchResponse,
  type DailyReminderConfig,
  type Loose,
  type NotificationItem,
  type ParsedTrigger,
  type PushRegistration,
  type ReminderInstance,
  type Task,
} from "@noortasks/core";
import { occurrencesBetween, weekendOnlyProvider, type HolidayProvider } from "@noortasks/recurrence";
import type { FastifyInstance } from "fastify";
import { WebPushError, generateRequestDetails, sendNotification, type PushSubscription } from "web-push";
import type { ActivityService } from "./activity.js";
import { publicUrl, safeFetch } from "./network.js";
import { numOr } from "./m4util.js";
import { ApiError, type Service } from "./service.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function loadVapidKeys(filePath: string): VapidConfig {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<VapidConfig>;
  if (typeof raw.publicKey !== "string" || !raw.publicKey || typeof raw.privateKey !== "string" || !raw.privateKey) {
    throw new Error("VAPID file must contain publicKey and privateKey strings");
  }
  const subject = typeof raw.subject === "string" && raw.subject ? raw.subject : "mailto:noortasks@localhost";
  return { publicKey: raw.publicKey, privateKey: raw.privateKey, subject };
}

interface StoredPushRecord extends PushRegistration {
  hl?: string;
  subscription?: PushSubscription;
}

function parseSubscription(pushToken: string, explicit?: unknown): PushSubscription | undefined {
  const candidate = isPlainObject(explicit) ? explicit : (() => {
    try {
      const j = JSON.parse(pushToken);
      return isPlainObject(j) ? j : undefined;
    } catch {
      return undefined;
    }
  })();
  if (!candidate) return undefined;
  const endpoint = candidate.endpoint;
  const keys = candidate.keys;
  if (
    typeof endpoint === "string" &&
    endpoint &&
    isPlainObject(keys) &&
    typeof keys.p256dh === "string" &&
    keys.p256dh &&
    typeof keys.auth === "string" &&
    keys.auth
  ) {
    return {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      ...(typeof candidate.expirationTime === "number" || candidate.expirationTime === null
        ? { expirationTime: candidate.expirationTime }
        : {}),
    };
  }
  return undefined;
}

function parseAnchorMs(
  raw: string | null | undefined,
  isAllDay: boolean,
  isFloating: boolean,
  srcTz: string,
  targetTz: string,
): number | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const hasZone = /(?:Z|[+-]\d{4}|[+-]\d{2}:\d{2})$/.test(raw);
  if (!hasZone) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
    if (!m) return undefined;
    const [, y, mo, d, h, mi, s] = m;
    return wallToInstant(
      Number(y),
      Number(mo),
      Number(d),
      isAllDay ? 0 : Number(h ?? 0),
      isAllDay ? 0 : Number(mi ?? 0),
      isAllDay ? 0 : Number(s ?? 0),
      targetTz,
    );
  }
  const w = parseWireDate(raw);
  const utcMs = Number.isNaN(w) ? Date.parse(raw) : w;
  if (Number.isNaN(utcMs)) return undefined;
  if (isAllDay) {
    const p = zonedParts(utcMs, isFloating ? srcTz : targetTz);
    return wallToInstant(p.y, p.m, p.d, 0, 0, 0, targetTz);
  }
  if (isFloating) {
    const p = zonedParts(utcMs, srcTz);
    return wallToInstant(p.y, p.m, p.d, p.h, p.min, p.s, targetTz);
  }
  return utcMs;
}

function maxShiftMs(triggers: ParsedTrigger[]): { before: number; after: number } {
  let before = 0;
  let after = 0;
  for (const t of triggers) {
    const ms =
      (t.years * 366 + t.months * 31 + t.weeks * 7 + t.days) * 86_400_000 +
      (t.hours * 3600 + t.minutes * 60 + t.seconds) * 1000;
    if (t.negative) before = Math.max(before, ms);
    else after = Math.max(after, ms);
  }
  return { before, after };
}

function parseQueryMs(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    if (/^-?\d+$/.test(v.trim())) return Number(v);
    const w = parseWireDate(v);
    if (!Number.isNaN(w)) return w;
    const d = Date.parse(v);
    if (!Number.isNaN(d)) return d;
  }
  return NaN;
}

function isoOfStamp(stamp: number): string {
  const { y, m, d } = parseStamp(stamp);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseTriggerList(rawList: unknown, fallbackSingle?: unknown): Array<{ id?: string; parsed: ParsedTrigger }> {
  const out: Array<{ id?: string; parsed: ParsedTrigger }> = [];
  if (Array.isArray(rawList)) {
    for (const r of rawList) {
      if (!isPlainObject(r) || typeof r.trigger !== "string") continue;
      const p = parseTrigger(r.trigger);
      if (!p) continue;
      const parsed: ParsedTrigger =
        r.isBeforeStart === false || r.related === "END" ? { ...p, related: "END" } : p;
      out.push({ ...(typeof r.id === "string" ? { id: r.id } : {}), parsed });
    }
  }
  if (out.length === 0 && typeof fallbackSingle === "string" && fallbackSingle) {
    const p = parseTrigger(fallbackSingle);
    if (p) out.push({ parsed: p });
  }
  return out;
}

export interface DispatchReport {
  due: number;
  sent: number;
  failed: number;
  removed: number;
  skipped?: string;
}

export class ReminderService {
  private vapid: VapidConfig | undefined;

  constructor(
    private svc: Service,
    private act?: ActivityService,
    vapid?: VapidConfig,
    private pushAgent?: HttpsAgent,
  ) {
    this.vapid = vapid;
  }

  private get store() {
    return this.svc.store;
  }

  setVapid(vapid: VapidConfig | undefined): void {
    this.vapid = vapid;
  }
  getVapidPublicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  holidayProvider(): HolidayProvider {
    const doc = this.store.getDoc<{ restDays?: unknown[]; workDays?: unknown[] }>("holidays")?.json;
    if (!doc) return weekendOnlyProvider;
    const rest = new Set(Array.isArray(doc.restDays) ? doc.restDays.filter((x): x is string => typeof x === "string") : []);
    const work = new Set(Array.isArray(doc.workDays) ? doc.workDays.filter((x): x is string => typeof x === "string") : []);
    return {
      isHoliday: (d) => rest.has(d),
      isWorkday: (d) => {
        if (work.has(d)) return true;
        if (rest.has(d)) return false;
        return weekendOnlyProvider.isWorkday(d);
      },
    };
  }

  private ackAt(key: string): number {
    return this.store.get<{ ackMs: number }>("select ackMs from reminder_acks where key = ?", key)?.ackMs ?? -Infinity;
  }

  private setAck(key: string, ackMs: number): void {
    this.store.run(
      "insert into reminder_acks(key, ackMs) values (?, ?) on conflict(key) do update set ackMs = max(reminder_acks.ackMs, excluded.ackMs)",
      key,
      ackMs,
    );
  }

  private isConstantFor(kind: "task" | "habit" | "countdown", entity: Loose): boolean {
    if (entity.annoyingAlert === CONSTANT_REMINDER_FLAG) return true;
    const ext = this.store.getDoc<Loose>("ext")?.json;
    const rem = isPlainObject(ext?.reminder) ? ext.reminder : undefined;
    if (rem?.annoyingAlertEnabled !== true) return false;
    const items = rem.annoyingRemindItems;
    if (Array.isArray(items)) return items.includes(kind);
    return true;
  }

  /** Compute all due reminder instances in [fromMs, toMs] inclusive. */
  computeInstances(fromMs: number, toMs: number): ReminderInstance[] {
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs || toMs - fromMs > 366 * 86_400_000 || Math.abs(fromMs) > 8.64e15 || Math.abs(toMs) > 8.64e15) {
      throw new ApiError(400, "invalid_date_range");
    }
    const { tz, weekStart } = this.svc.userCtx();
    const wkCode = WEEKDAY_CODES[weekStart] ?? "SU";
    const holidays = this.holidayProvider();
    const out: ReminderInstance[] = [];

    const pushWithConstant = (inst: Omit<ReminderInstance, "fireAt">, ackKeys: string[]): void => {
      const acked = ackKeys.some((k) => this.ackAt(k) >= inst.fireAtMs);
      if (acked) return;
      if (!inst.constant) {
        if (inst.fireAtMs >= fromMs && inst.fireAtMs <= toMs) {
          out.push({ ...inst, fireAt: formatServerDate(inst.fireAtMs) });
        }
        return;
      }
      if (inst.fireAtMs > toMs) return;
      const kStart = Math.max(0, Math.ceil((fromMs - inst.fireAtMs) / CONSTANT_REMINDER_CYCLE_MS));
      const kEnd = Math.min(kStart + 1000, Math.floor((toMs - inst.fireAtMs) / CONSTANT_REMINDER_CYCLE_MS));
      for (let k = kStart; k <= kEnd; k++) {
        const t = inst.fireAtMs + k * CONSTANT_REMINDER_CYCLE_MS;
        out.push({ ...inst, fireAtMs: t, fireAt: formatServerDate(t) });
      }
    };

    // 1. Open tasks + checklist items
    const openTasks = this.store
      .all<{ json: string }>("select json from tasks where deleted = 0 and status = ?", TaskStatus.Open)
      .map((r) => JSON.parse(r.json) as Task);

    for (const task of openTasks) {
      const isAllDay = task.isAllDay === true;
      const isFloating = task.isFloating === true;
      const srcTz = isValidTimeZone(task.timeZone) ? task.timeZone : tz;
      const targetZone = isFloating || !isValidTimeZone(task.timeZone) ? tz : task.timeZone;
      const constant = this.isConstantFor("task", task);

      const triggerEntries = parseTriggerList(task.reminders, task.reminder);

      const startMs = parseAnchorMs(task.startDate ?? task.dueDate, isAllDay, isFloating, srcTz, targetZone);
      const dueMs = parseAnchorMs(task.dueDate ?? task.startDate, isAllDay, isFloating, srcTz, targetZone);

      if (triggerEntries.length > 0 && startMs !== undefined) {
        const endBase = dueMs ?? startMs;
        let occStarts: number[];
        if (task.repeatFlag && task.repeatFrom !== "1") {
          const pad = maxShiftMs(triggerEntries.map((x) => x.parsed));
          try {
            const dates = occurrencesBetween(
              {
                repeatFlag: task.repeatFlag,
                repeatFrom: task.repeatFrom ?? "2",
                startDate: startMs,
                timeZoneId: targetZone,
                exDates: Array.isArray(task.exDate) ? task.exDate : [],
              },
              fromMs - pad.after - 2 * 86_400_000,
              toMs + pad.before + 2 * 86_400_000,
              { deviceZone: targetZone, defaultWeekStart: wkCode, holidays },
            );
            occStarts = dates.map((d) => d.getTime());
          } catch {
            occStarts = [startMs];
          }
        } else {
          occStarts = [startMs];
        }

        const spanMs = endBase - startMs;
        for (const occStart of occStarts) {
          const occEnd = occStart + spanMs;
          for (const te of triggerEntries) {
            const anchor = te.parsed.related === "END" ? occEnd : occStart;
            const fireAtMs = computeTriggerInstant(anchor, te.parsed, targetZone, isAllDay);
            const ackKeys = [`task:${task.id}`];
            if (te.id) ackKeys.push(`task:${task.id}:rem:${te.id}`);
            pushWithConstant(
              {
                kind: "task",
                targetId: task.id,
                taskId: task.id,
                projectId: task.projectId,
                title: task.title ?? "",
                ...(te.id ? { reminderId: te.id } : {}),
                trigger: te.parsed.raw,
                occurrenceMs: occStart,
                fireAtMs,
                constant,
              },
              ackKeys,
            );
          }
        }
      }

      if (typeof task.snoozeReminderTime === "string" && task.snoozeReminderTime) {
        const snoozeMs = parseAnchorMs(task.snoozeReminderTime, false, isFloating, srcTz, targetZone);
        if (snoozeMs !== undefined) {
          pushWithConstant(
            {
              kind: "task",
              targetId: task.id,
              taskId: task.id,
              projectId: task.projectId,
              title: task.title ?? "",
              fireAtMs: snoozeMs,
              isSnooze: true,
              constant,
            },
            [`task:${task.id}`, `task:${task.id}:snooze`],
          );
        }
      }

      // Checklist items with their own date/reminder or snooze
      for (const item of Array.isArray(task.items) ? task.items : []) {
        if (!item || typeof item.id !== "string" || (item.status ?? 0) !== 0) continue;
        const itemAllDay = item.isAllDay === true;
        const itemZone = isValidTimeZone(item.timeZone) ? item.timeZone : targetZone;
        if (typeof item.snoozeReminderTime === "string" && item.snoozeReminderTime) {
          const sm = parseAnchorMs(item.snoozeReminderTime, false, isFloating, itemZone, itemZone);
          if (sm !== undefined) {
            pushWithConstant(
              {
                kind: "checklist",
                targetId: item.id,
                taskId: task.id,
                itemId: item.id,
                projectId: task.projectId,
                title: item.title || task.title || "",
                fireAtMs: sm,
                isSnooze: true,
                constant,
              },
              [`task:${task.id}`, `task:${task.id}:item:${item.id}`],
            );
          }
        }
        const itemStart = parseAnchorMs(item.startDate, itemAllDay, isFloating, itemZone, itemZone);
        if (itemStart !== undefined) {
          const itemTriggers = parseTriggerList(item.reminders, item.reminder);
          for (const te of itemTriggers) {
            const fireAtMs = computeTriggerInstant(itemStart, te.parsed, itemZone, itemAllDay);
            pushWithConstant(
              {
                kind: "checklist",
                targetId: item.id,
                taskId: task.id,
                itemId: item.id,
                projectId: task.projectId,
                title: item.title || task.title || "",
                ...(te.id ? { reminderId: te.id } : {}),
                trigger: te.parsed.raw,
                fireAtMs,
                constant,
              },
              [`task:${task.id}`, `task:${task.id}:item:${item.id}`],
            );
          }
        }
      }
    }

    // 2. Habits (HAB-022)
    const fromStamp = stampOf(fromMs, tz);
    const toStamp = stampOf(toMs, tz);
    const days = stampRange(fromStamp, toStamp);
    for (const h of this.store.collAll<Loose>("habits")) {
      if (h.status === 1 || !Array.isArray(h.reminders) || h.reminders.length === 0) continue;
      const hid = String(h.id);
      const constant = this.isConstantFor("habit", h);
      const anchor = isValidStamp(h.targetStartDate) ? h.targetStartDate : fromStamp;
      const rule = parseHabitRule(h.repeatRule);
      const doneDays = new Set(
        this.store
          .all<{ stamp: number; json: string }>("select stamp, json from habit_checkins where habitId = ? and stamp >= ? and stamp <= ?", hid, fromStamp, toStamp)
          .filter((r) => (JSON.parse(r.json) as Loose).status === 2)
          .map((r) => r.stamp),
      );
      for (const d of days) {
        if (doneDays.has(d)) continue;
        if (!isScheduled(rule, anchor, d, h.exDates)) continue;
        const dp = parseStamp(d);
        for (const rem of h.reminders) {
          if (typeof rem !== "string") continue;
          const hm = /^(\d{1,2}):(\d{2})$/.exec(rem.trim());
          let fireAtMs: number | undefined;
          if (hm) {
            fireAtMs = wallToInstant(dp.y, dp.m, dp.d, Number(hm[1]), Number(hm[2]), 0, tz);
          } else {
            const p = parseTrigger(rem);
            if (p) fireAtMs = computeTriggerInstant(wallToInstant(dp.y, dp.m, dp.d, 0, 0, 0, tz), p, tz, true);
          }
          if (fireAtMs !== undefined) {
            pushWithConstant(
              {
                kind: "habit",
                targetId: hid,
                title: String(h.name ?? ""),
                trigger: rem,
                fireAtMs,
                constant,
              },
              [`habit:${hid}`],
            );
          }
        }
      }
    }

    // 3. Countdowns (CNT-017)
    for (const c of this.store.collAll<Loose>("countdowns")) {
      if (c.status === 1 || c.deleted || typeof c.date !== "string") continue;
      const cid = String(c.id);
      const constant = this.isConstantFor("countdown", c);
      const dateMs = parseAnchorMs(c.date, true, false, tz, tz);
      if (dateMs === undefined) continue;
      const rems = Array.isArray(c.reminders) ? c.reminders.filter((x): x is string => typeof x === "string") : [];
      for (const rem of rems) {
        const p = parseTrigger(rem);
        if (!p) continue;
        const fireAtMs = computeTriggerInstant(dateMs, p, tz, true);
        pushWithConstant(
          {
            kind: "countdown",
            targetId: cid,
            title: String(c.name ?? ""),
            trigger: p.raw,
            fireAtMs,
            constant,
          },
          [`countdown:${cid}`],
        );
      }
    }

    // 4. Daily Summary (RMD-030, RMD-031)
    const dr = (this.store.getDoc<DailyReminderConfig>("dailyReminder")?.json ??
      this.store.getDoc<Loose>("settings")?.json?.dailyRemindTimeConfig) as Partial<DailyReminderConfig> | undefined;
    if (dr?.enable === true && Array.isArray(dr.dailyReminders) && dr.dailyReminders.length > 0) {
      const allowedDays =
        Array.isArray(dr.weekDays) && dr.weekDays.length > 0
          ? new Set(dr.weekDays.map((w) => String(w).trim().toUpperCase().slice(0, 2)))
          : null;
      const opts = Array.isArray(dr.notifyOptions) && dr.notifyOptions.length > 0 ? new Set(dr.notifyOptions) : new Set(["TODAY", "OVERDUE"]);
      for (const d of days) {
        const code = WEEKDAY_CODES[weekdayOf(d)]!;
        if (allowedDays && !allowedDays.has(code)) continue;
        if (dr.holidayNotify === false && holidays.isHoliday(isoOfStamp(d))) continue;
        const dp = parseStamp(d);
        for (const hhmm of dr.dailyReminders) {
          if (typeof hhmm !== "string") continue;
          const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
          if (!m) continue;
          const fireAtMs = wallToInstant(dp.y, dp.m, dp.d, Number(m[1]), Number(m[2]), 0, tz);
          if (fireAtMs < fromMs || fireAtMs > toMs) continue;
          const { todayCount, overdueCount } = this.dailyCounts(openTasks, d, tz);
          const includeToday = opts.has("TODAY");
          const includeOverdue = opts.has("OVERDUE");
          const parts: string[] = [];
          if (includeToday) parts.push(`${todayCount} today`);
          if (includeOverdue) parts.push(`${overdueCount} overdue`);
          pushWithConstant(
            {
              kind: "dailySummary",
              targetId: `daily:${d}:${hhmm}`,
              title: `Daily Summary: ${parts.join(", ") || "No pending tasks"}`,
              fireAtMs,
              ...(includeToday ? { todayCount } : {}),
              ...(includeOverdue ? { overdueCount } : {}),
              constant: false,
            },
            [`daily:${d}:${hhmm}`],
          );
        }
      }
    }

    return out.sort((a, b) => a.fireAtMs - b.fireAtMs || a.targetId.localeCompare(b.targetId));
  }

  private dailyCounts(openTasks: Task[], dayStamp: number, tz: string): { todayCount: number; overdueCount: number } {
    let todayCount = 0;
    let overdueCount = 0;
    for (const t of openTasks) {
      if (t.kind === "NOTE") continue;
      const raw = t.dueDate ?? t.startDate;
      if (!raw) continue;
      const isAllDay = t.isAllDay === true;
      const zone = isAllDay && !t.isFloating && isValidTimeZone(t.timeZone) ? t.timeZone : tz;
      const ms = parseAnchorMs(raw, isAllDay, t.isFloating === true, zone, zone);
      if (ms === undefined) continue;
      const startRaw = t.startDate ? parseAnchorMs(t.startDate, isAllDay, t.isFloating === true, zone, zone) : ms;
      const sStamp = stampOf(startRaw ?? ms, zone);
      let dStamp = stampOf(ms, zone);
      if (isAllDay && ms > (startRaw ?? ms)) {
        const p = zonedParts(ms, zone);
        if (p.h === 0 && p.min === 0 && p.s === 0) dStamp = addDays(dStamp, -1);
      }
      if (dStamp < dayStamp) overdueCount++;
      else if (sStamp <= dayStamp && dayStamp <= dStamp) todayCount++;
    }
    return { todayCount, overdueCount };
  }

  // ------------------------------------------------------------------ dismiss & snooze

  closeRemind(body: unknown): BatchResponse | { id2etag: Record<string, string>; id2error: Record<string, string> } {
    const isArray = Array.isArray(body);
    const items = isArray ? body : isPlainObject(body) && Array.isArray(body.tasks) ? body.tasks : isPlainObject(body) ? [body] : [];
    if (!isArray && (!isPlainObject(body) || items.length === 0)) throw new ApiError(400, "invalid_body");

    const res: BatchResponse = { id2etag: {}, id2error: {} };
    this.store.tx(() => {
      const seq = this.store.seq();
      const nowMs = this.svc.now();
      const now = formatServerDate(nowMs);
      for (const raw of items) {
        if (!isPlainObject(raw)) continue;
        const taskId = typeof raw.taskId === "string" ? raw.taskId : typeof raw.id === "string" ? raw.id : undefined;
        if (!taskId) {
          if (!isArray) throw new ApiError(400, "invalid_task_id");
          continue;
        }
        const task = this.store.getTask(taskId);
        if (!task) {
          if (!isArray && !Array.isArray((body as Loose).tasks)) throw new ApiError(404, "task_not_found");
          res.id2error[taskId] = BatchError.NotExisted;
          continue;
        }
        const trigMs = raw.triggerTime !== undefined ? parseQueryMs(raw.triggerTime, nowMs) : nowMs;
        const ackMs = Number.isFinite(trigMs) ? Math.max(nowMs, trigMs) : nowMs;

        if (typeof raw.itemId === "string" && raw.itemId) {
          const item = (task.items ?? []).find((it) => it.id === raw.itemId);
          if (!item && !isArray) throw new ApiError(404, "item_not_found");
          if (item) {
            item.snoozeReminderTime = null;
            this.setAck(`task:${taskId}:item:${raw.itemId}`, ackMs);
          }
        } else if (typeof raw.reminderId === "string" && raw.reminderId) {
          this.setAck(`task:${taskId}:rem:${raw.reminderId}`, ackMs);
          task.snoozeReminderTime = null;
          task.remindTime = null;
        } else {
          this.setAck(`task:${taskId}`, ackMs);
          task.snoozeReminderTime = null;
          task.remindTime = null;
        }
        task.etag = newEtag();
        task.modifiedTime = now;
        this.store.putTask(task, { seq });
        res.id2etag[task.id] = task.etag;
      }
    });
    return res;
  }

  delayReminder(body: unknown): { snoozeReminderTime?: string; id2etag: Record<string, string>; id2error: Record<string, string> } {
    const isArray = Array.isArray(body);
    const items = isArray ? body : isPlainObject(body) ? [body] : [];
    if (items.length === 0) throw new ApiError(400, "invalid_body");

    const res: { snoozeReminderTime?: string; id2etag: Record<string, string>; id2error: Record<string, string> } = {
      id2etag: {},
      id2error: {},
    };
    this.store.tx(() => {
      const seq = this.store.seq();
      const nowMs = this.svc.now();
      const now = formatServerDate(nowMs);
      for (const raw of items) {
        if (!isPlainObject(raw)) continue;
        const taskId = typeof raw.taskId === "string" ? raw.taskId : typeof raw.id === "string" ? raw.id : undefined;
        if (!taskId) {
          if (!isArray) throw new ApiError(400, "invalid_task_id");
          continue;
        }
        const task = this.store.getTask(taskId);
        if (!task) {
          if (!isArray) throw new ApiError(404, "task_not_found");
          res.id2error[taskId] = BatchError.NotExisted;
          continue;
        }
        let targetMs = NaN;
        const explicit = raw.snoozeReminderTime ?? raw.snoozeTime ?? raw.delayUntil;
        if (explicit !== undefined && explicit !== null) {
          targetMs = parseQueryMs(explicit, NaN);
        } else {
          const minsRaw = raw.delayMinutes ?? raw.minutes ?? raw.snoozeMinutes;
          const mins = typeof minsRaw === "number" ? minsRaw : typeof minsRaw === "string" && minsRaw.trim() !== "" ? Number(minsRaw) : NaN;
          if (Number.isFinite(mins) && mins > 0) targetMs = nowMs + mins * 60_000;
        }
        if (!Number.isFinite(targetMs)) {
          if (!isArray) throw new ApiError(400, "invalid_delay");
          res.id2error[taskId] = BatchError.Unknown;
          continue;
        }
        const targetIso = formatServerDate(targetMs);
        if (typeof raw.itemId === "string" && raw.itemId) {
          const item = (task.items ?? []).find((it) => it.id === raw.itemId);
          if (!item) {
            if (!isArray) throw new ApiError(404, "item_not_found");
            res.id2error[taskId] = BatchError.NotExisted;
            continue;
          }
          item.snoozeReminderTime = targetIso;
          // Ack prior firing before the new snooze moment (not the snooze moment itself)
          this.setAck(`task:${taskId}:item:${raw.itemId}`, Math.min(nowMs, targetMs - 1));
        } else {
          task.snoozeReminderTime = targetIso;
          // Ack prior firing before targetMs so constant reminder stops until snooze fires
          this.setAck(`task:${taskId}`, Math.min(nowMs, targetMs - 1));
        }
        task.etag = newEtag();
        task.modifiedTime = now;
        this.store.putTask(task, { seq });
        res.id2etag[task.id] = task.etag;
        res.snoozeReminderTime = targetIso;
        this.act?.record({
          taskId: task.id,
          projectId: task.projectId,
          action: ActivityAction.Reminder,
          field: "snoozeReminderTime",
          newValue: targetIso,
          summary: `Snoozed reminder to ${targetIso}`,
          taskTitle: task.title ?? "",
        });
      }
    });
    return res;
  }

  // ------------------------------------------------------------------ push & delivery

  registerPush(body: unknown): StoredPushRecord {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_body");
    const explicitSub = body.subscription;
    const rawToken =
      typeof body.pushToken === "string" && body.pushToken
        ? body.pushToken
        : isPlainObject(explicitSub) && typeof explicitSub.endpoint === "string"
          ? JSON.stringify(explicitSub)
          : "";
    if (!rawToken) throw new ApiError(400, "invalid_push_token");
    const osType = typeof body.osType === "number" ? body.osType : 0;
    const hl = typeof body.hl === "string" ? body.hl : undefined;
    const subscription = parseSubscription(rawToken, explicitSub);
    if (subscription && !this.pushAgent) {
      try { if (publicUrl(subscription.endpoint).protocol !== "https:") throw new Error(); }
      catch { throw new ApiError(400, "invalid_push_endpoint"); }
    }

    return this.store.tx(() => {
      const existing = this.store.get<{ id: string; version: number }>(
        "select id, version from push_subscriptions where pushToken = ?",
        rawToken,
      );
      const id = existing?.id ?? randomBytes(12).toString("hex");
      const version = existing ? existing.version + 1 : 1;
      const nowMs = this.svc.now();
      const rec: StoredPushRecord = {
        id,
        pushToken: rawToken,
        osType,
        version,
        ...(hl !== undefined ? { hl } : {}),
        ...(subscription ? { subscription } : {}),
      };
      this.store.run(
        `insert into push_subscriptions(id, pushToken, osType, version, updatedMs, json) values (?,?,?,?,?,?)
         on conflict(pushToken) do update set osType=excluded.osType, version=excluded.version, updatedMs=excluded.updatedMs, json=excluded.json`,
        id,
        rawToken,
        osType,
        version,
        nowMs,
        JSON.stringify(rec),
      );
      return { id, pushToken: rawToken, osType, version };
    });
  }

  listPushSubscriptions(): StoredPushRecord[] {
    return this.store.all<{ json: string }>("select json from push_subscriptions order by updatedMs desc").map((r) => JSON.parse(r.json) as StoredPushRecord);
  }

  /** Send Web Push notifications for due reminders in [fromMs, nowMs]. Deduplicates by cycle. */
  async dispatchDue(nowMs = this.svc.now(), fromMs?: number): Promise<DispatchReport> {
    const settings = this.store.getDoc<Loose>("settings")?.json;
    if (settings && (settings.notificationEnabled === false || settings.isNotificationEnabled === false)) {
      return { due: 0, sent: 0, failed: 0, removed: 0, skipped: "disabled" };
    }
    if (!this.vapid) {
      return { due: 0, sent: 0, failed: 0, removed: 0, skipped: "no_vapid" };
    }
    const lastRun = Number(this.store.getMeta("lastPushDispatchMs") ?? 0);
    const windowStart = fromMs !== undefined ? fromMs : lastRun > 0 ? Math.min(lastRun, nowMs) : nowMs - 5 * 60_000;
    const due = this.computeInstances(windowStart, nowMs);

    const subs = this.listPushSubscriptions().filter((s): s is StoredPushRecord & { subscription: PushSubscription } => !!s.subscription);
    let sent = 0;
    let failed = 0;
    let removed = 0;

    for (const inst of due) {
      const delivKey = `${inst.kind}:${inst.targetId}:${inst.reminderId ?? ""}:${inst.fireAtMs}`;
      if (this.store.get("select 1 from reminder_deliveries where key = ?", delivKey)) continue;
      if (subs.length === 0) continue;

      const payload = JSON.stringify({
        type: inst.kind === "dailySummary" ? "dailyReminder" : "reminder",
        kind: inst.kind,
        title: inst.title,
        taskId: inst.taskId,
        itemId: inst.itemId,
        projectId: inst.projectId,
        fireAt: inst.fireAt,
        constant: !!inst.constant,
        url: inst.taskId && inst.projectId ? `#p/${inst.projectId}/tasks/${inst.taskId}` : "#q/today/tasks",
        ...(inst.todayCount !== undefined ? { todayCount: inst.todayCount } : {}),
        ...(inst.overdueCount !== undefined ? { overdueCount: inst.overdueCount } : {}),
      });

      let deliveredAny = false;
      for (const rec of subs) {
        try {
          if (this.pushAgent) {
            // Explicitly injected transport is used by local TLS fixtures only.
            await sendNotification(rec.subscription, payload, { vapidDetails: this.vapid, agent: this.pushAgent, timeout: 10_000 });
          } else {
            const details = generateRequestDetails(rec.subscription, payload, { vapidDetails: this.vapid });
            const res = await safeFetch(details.endpoint, { method: details.method, headers: details.headers as Record<string, string>, body: new Uint8Array(details.body) });
            if (!res.ok) {
              if (res.status === 404 || res.status === 410) {
                this.store.run("delete from push_subscriptions where id = ?", rec.id);
                removed++;
              }
              throw new Error("push_failed");
            }
          }
          sent++;
          deliveredAny = true;
        } catch (err) {
          failed++;
          if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
            this.store.run("delete from push_subscriptions where id = ?", rec.id);
            removed++;
          }
        }
      }
      if (deliveredAny) {
        this.store.run("insert or ignore into reminder_deliveries(key, sentMs) values (?, ?)", delivKey, nowMs);
        const baseStamp = inst.occurrenceMs ?? (inst.constant ? undefined : inst.fireAtMs);
        const notifId = `notif:${inst.kind}:${inst.targetId}:${inst.itemId ?? ""}:${inst.reminderId ?? ""}:${baseStamp ?? "const"}`;
        if (!this.store.get("select 1 from notifications where id = ?", notifId)) {
          this.addNotification({
            id: notifId,
            title: inst.title,
            type: inst.kind === "dailySummary" ? "dailyReminder" : "reminder",
            category: NotificationCategory.Notification,
            data: {
              kind: inst.kind,
              ...(inst.taskId ? { taskId: inst.taskId } : {}),
              ...(inst.itemId ? { itemId: inst.itemId } : {}),
              ...(inst.projectId ? { projectId: inst.projectId } : {}),
              fireAt: inst.fireAt,
            },
          });
        }
      }
    }

    this.store.setMeta("lastPushDispatchMs", String(nowMs));
    return { due: due.length, sent, failed, removed };
  }

  // ------------------------------------------------------------------ notification centre

  addNotification(input: {
    id?: string;
    title: string;
    type?: string;
    data?: Loose;
    actionStatus?: number;
    category?: string | null;
    unread?: boolean;
    createdTime?: string;
  }): NotificationItem {
    const when = this.svc.now();
    const id = input.id ?? newId(when);
    const createdTime = input.createdTime ?? formatServerDate(when);
    const item: NotificationItem = {
      id,
      title: input.title,
      type: input.type ?? "system",
      data: input.data ?? {},
      actionStatus: input.actionStatus ?? 0,
      createdTime,
      category: input.category ?? NotificationCategory.Notification,
      unread: input.unread ?? true,
    };
    this.store.run(
      "insert into notifications(id, category, unread, whenMs, json) values (?,?,?,?,?) on conflict(id) do update set category=excluded.category, unread=excluded.unread, whenMs=excluded.whenMs, json=excluded.json",
      id,
      item.category,
      item.unread ? 1 : 0,
      when,
      JSON.stringify(item),
    );
    return item;
  }

  listNotifications(autoMarkRead = false): NotificationItem[] {
    return this.store.tx(() => {
      const rows = this.store
        .all<{ id: string; json: string }>("select id, json from notifications order by whenMs desc, rowid desc")
        .map((r) => JSON.parse(r.json) as NotificationItem);
      if (autoMarkRead) {
        for (const r of rows) {
          if (r.unread) {
            r.unread = false;
            this.store.run("update notifications set unread = 0, json = ? where id = ?", JSON.stringify(r), r.id);
          }
        }
      }
      return rows;
    });
  }

  unreadCounts(): { notification: number; activity: number } {
    const activity = this.store.get<{ n: number }>("select count(*) as n from notifications where unread = 1 and category = ?", NotificationCategory.Activity)!.n;
    const notification = this.store.get<{ n: number }>(
      "select count(*) as n from notifications where unread = 1 and (category is null or category != ?)",
      NotificationCategory.Activity,
    )!.n;
    return { notification, activity };
  }

  markRead(category?: string): { notification: number; activity: number } {
    this.store.tx(() => {
      const cat = typeof category === "string" ? category.trim() : "";
      const where =
        cat === NotificationCategory.Activity
          ? "unread = 1 and category = 'activity'"
          : cat && cat !== "all"
            ? "unread = 1 and (category is null or category != 'activity')"
            : "unread = 1";
      for (const r of this.store.all<{ id: string; json: string }>(`select id, json from notifications where ${where}`)) {
        const item = JSON.parse(r.json) as NotificationItem;
        item.unread = false;
        this.store.run("update notifications set unread = 0, json = ? where id = ?", JSON.stringify(item), r.id);
      }
    });
    return this.unreadCounts();
  }
}

export function registerReminderRoutes(
  app: FastifyInstance,
  svc: Service,
  act?: ActivityService,
  vapid?: VapidConfig,
  pushAgent?: HttpsAgent,
): ReminderService {
  const rs = new ReminderService(svc, act, vapid, pushAgent);

  app.post("/api/v2/task/closeRemind", async (req) => rs.closeRemind(req.body));
  app.post("/api/v2/reminder/delay", async (req) => rs.delayReminder(req.body));
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/v2/reminder/instances", async (req) => {
    const now = svc.now();
    const fromMs = parseQueryMs(req.query.from, now - 60_000);
    const toMs = parseQueryMs(req.query.to, now + 24 * 3600_000);
    return rs.computeInstances(fromMs, toMs);
  });

  app.post("/api/v2/push/register", async (req) => rs.registerPush(req.body));
  app.post("/api/v2/push/stats/arrive", async () => ({}));
  app.get("/api/v2/push/vapidPublicKey", async () => ({ publicKey: rs.getVapidPublicKey() }));

  app.get<{ Querystring: { autoMarkRead?: string } }>("/api/v2/notification", async (req) =>
    rs.listNotifications(req.query.autoMarkRead === "true" || req.query.autoMarkRead === "1"),
  );
  app.get("/api/v2/notification/unread", async () => rs.unreadCounts());
  app.put<{ Querystring: { category?: string } }>("/api/v2/notification/markRead", async (req) => rs.markRead(req.query.category));

  return rs;
}
