import { occurrencesBetween } from "@noortasks/recurrence";
import type { Task } from "../lib/core";
import { DAY, addDays, deviceZone, parseDate, startOfDay, taskEnd, taskStart, toServer } from "../lib/dates";
import type { ExtEvent } from "./extCal";

// ------------------------------------------------------------------ item model (CAL-059)

/** Calendar item kinds on the sync wire: task 1, subtask (checklist item) 2, subscribe 3, repeat 4, course 10. */
export const ItemKind = { Task: 1, Subtask: 2, Subscribe: 3, Repeat: 4, Course: 10 } as const;
export type ItemKindValue = (typeof ItemKind)[keyof typeof ItemKind];

export interface CalItem {
  /** unique per drawn item: task id, task id + "@" + occurrence ms, task id + "/" + item id */
  key: string;
  kind: ItemKindValue;
  taskId: string;
  itemId?: string;
  title: string;
  start: number;
  /** exclusive end; all-day items end at a local midnight */
  end: number;
  allDay: boolean;
  completed: boolean;
  task: Task;
  /** occurrence start for repeat items */
  occurrence?: number;
  /** subscribed or account event (kind 3): its source, colour and wire fields */
  ext?: ExtEvent;
}

export interface SubscribedEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  color?: string;
}

export interface ItemOpts {
  from: number;
  to: number;
  showCompleted: boolean;
  showChecklist: boolean;
  showFutureTask: boolean;
  showRepeat: boolean;
  now: number;
  weekStart?: "SU" | "MO" | "SA";
}

/** Start and exclusive end of a task as drawn on a calendar. Timed tasks without an end take 30 minutes on screen. */
export function taskSpan(t: { startDate?: string | null; dueDate?: string | null; isAllDay?: boolean | null }): { start: number; end: number; allDay: boolean } | null {
  const s = taskStart(t);
  if (Number.isNaN(s)) return null;
  const e = taskEnd(t);
  if (t.isAllDay === false) return { start: s, end: e > s ? e : s + 30 * 60_000, allDay: false };
  const first = startOfDay(s);
  const end = e > s ? (startOfDay(e) === e ? e : addDays(startOfDay(e), 1)) : addDays(first, 1);
  return { start: first, end, allDay: true };
}

const overlaps = (a: number, b: number, from: number, to: number): boolean => a < to && b > from;

/** Map tasks (and subscribed events) to calendar items inside [from, to). */
export function calendarItems(tasks: readonly Task[], opts: ItemOpts, events: readonly SubscribedEvent[] = []): CalItem[] {
  const out: CalItem[] = [];
  const todayEnd = addDays(startOfDay(opts.now), 1);
  for (const t of tasks) {
    if (t.deleted) continue;
    const done = t.status !== 0;
    if (done && !opts.showCompleted) continue;
    const span = taskSpan(t);
    if (span) {
      const futureOk = (s: number): boolean => opts.showFutureTask || s < todayEnd;
      if (overlaps(span.start, span.end, opts.from, opts.to) && futureOk(span.start))
        out.push({ key: t.id, kind: ItemKind.Task, taskId: t.id, title: t.title, start: span.start, end: span.end, allDay: span.allDay, completed: done, task: t });
      if (opts.showRepeat && t.repeatFlag && !done) {
        const len = span.end - span.start;
        let occ: Date[] = [];
        try {
          occ = occurrencesBetween(
            { repeatFlag: t.repeatFlag, repeatFrom: t.repeatFrom, startDate: t.startDate ?? t.dueDate!, timeZoneId: t.isAllDay === false && !t.isFloating ? (t.timeZone ?? deviceZone()) : null, exDates: t.exDate ?? [] },
            opts.from - len,
            opts.to,
            { deviceZone: deviceZone(), defaultWeekStart: opts.weekStart ?? "SU" },
          );
        } catch {
          occ = [];
        }
        for (const d of occ) {
          const s = span.allDay ? startOfDay(d.getTime()) : d.getTime();
          if (s <= span.start) continue; // the live instance is drawn already
          const e = span.allDay ? addDays(s, Math.max(1, Math.round(len / DAY))) : s + len;
          if (!overlaps(s, e, opts.from, opts.to) || !futureOk(s)) continue;
          out.push({ key: `${t.id}@${s}`, kind: ItemKind.Repeat, taskId: t.id, title: t.title, start: s, end: e, allDay: span.allDay, completed: false, task: t, occurrence: s });
        }
      }
    }
    if (opts.showChecklist) {
      for (const it of t.items ?? []) {
        const is = taskSpan({ startDate: it.startDate as string | undefined, dueDate: it.startDate as string | undefined, isAllDay: it.isAllDay as boolean | undefined });
        if (!is || !overlaps(is.start, is.end, opts.from, opts.to)) continue;
        if (it.status && !opts.showCompleted) continue;
        out.push({ key: `${t.id}/${it.id}`, kind: ItemKind.Subtask, taskId: t.id, itemId: it.id, title: it.title, start: is.start, end: is.end, allDay: is.allDay, completed: !!it.status, task: t });
      }
    }
  }
  for (const e of events) {
    if (!overlaps(e.start, e.end, opts.from, opts.to)) continue;
    const ext = "source" in e ? (e as ExtEvent) : undefined;
    out.push({ key: e.id.includes(":") ? e.id : `sub:${e.id}`, kind: ItemKind.Subscribe, taskId: "", title: e.title, start: e.start, end: e.end, allDay: e.allDay, completed: false, task: { id: "", projectId: "", title: e.title, sortOrder: 0 } as Task, ...(ext ? { ext } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ layout

export interface Placed {
  key: string;
  /** column inside the overlap cluster and the cluster's column count */
  col: number;
  cols: number;
}

/**
 * Overlap layout for timed blocks in one day column: blocks that overlap share the width. Sorted by start,
 * longer first; each block takes the first free column; a cluster ends when no block overlaps the next one.
 */
export function layoutDayEvents(events: ReadonlyArray<{ key: string; start: number; end: number }>): Map<string, Placed> {
  const sorted = [...events].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.key.localeCompare(b.key));
  const out = new Map<string, Placed>();
  let cluster: Array<{ key: string; col: number }> = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = (): void => {
    const cols = colEnds.length;
    for (const c of cluster) out.set(c.key, { key: c.key, col: c.col, cols });
    cluster = [];
    colEnds = [];
  };
  for (const e of sorted) {
    const end = Math.max(e.end, e.start + 1);
    if (e.start >= clusterEnd && cluster.length) flush();
    let col = colEnds.findIndex((ce) => ce <= e.start);
    if (col < 0) {
      col = colEnds.length;
      colEnds.push(end);
    } else colEnds[col] = end;
    cluster.push({ key: e.key, col });
    clusterEnd = Math.max(clusterEnd === -Infinity ? end : clusterEnd, end);
  }
  if (cluster.length) flush();
  return out;
}

export interface SpanPlaced {
  key: string;
  lane: number;
  startCol: number;
  endCol: number;
  /** continues before or after the visible range */
  clipStart: boolean;
  clipEnd: boolean;
}

/**
 * Lanes for day-spanning bars across a row of `days` columns starting at `rowStart` (all-day row, month week row).
 * Longer bars first, then earlier; each takes the lowest lane free over its columns.
 */
export function layoutSpans(items: ReadonlyArray<{ key: string; start: number; end: number }>, rowStart: number, days: number): SpanPlaced[] {
  const colOf = (ms: number): number => Math.round((startOfDay(ms) - rowStart) / DAY);
  const rows: SpanPlaced[] = [];
  const prepared = items
    .map((i) => {
      const first = colOf(i.start);
      const lastRaw = startOfDay(i.end) === i.end ? colOf(i.end) - 1 : colOf(i.end);
      const last = Math.max(first, lastRaw);
      return { key: i.key, first, last };
    })
    .filter((i) => i.last >= 0 && i.first <= days - 1)
    .sort((a, b) => b.last - b.first - (a.last - a.first) || a.first - b.first || a.key.localeCompare(b.key));
  const lanes: boolean[][] = [];
  for (const i of prepared) {
    const s = Math.max(0, i.first);
    const e = Math.min(days - 1, i.last);
    let lane = 0;
    for (;; lane++) {
      const l = (lanes[lane] ??= []);
      let free = true;
      for (let c = s; c <= e; c++) if (l[c]) free = false;
      if (free) {
        for (let c = s; c <= e; c++) l[c] = true;
        break;
      }
    }
    rows.push({ key: i.key, lane, startCol: s, endCol: e, clipStart: i.first < 0, clipEnd: i.last > days - 1 });
  }
  return rows;
}

// ------------------------------------------------------------------ grids and numbers

/** Day starts of a month grid: whole weeks covering the month (or `weeks` weeks from the week of `anchor`). */
export function monthGridDays(anchor: number, weekStart: number, weeks?: number): number[] {
  const d = new Date(anchor);
  const first = weeks ? startOfDay(anchor) : new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const dow = new Date(first).getDay();
  const start = addDays(first, -((dow - weekStart + 7) % 7));
  let n = weeks ?? 0;
  if (!weeks) {
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getTime();
    n = Math.ceil((Math.round((last - start) / DAY) + 1) / 7);
  }
  return Array.from({ length: n * 7 }, (_, i) => addDays(start, i));
}

/** ISO 8601 week number (weeks start Monday, week 1 holds the first Thursday). */
export function isoWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThu = new Date(d.getFullYear(), 0, 4);
  const fday = (firstThu.getDay() + 6) % 7;
  firstThu.setDate(firstThu.getDate() - fday + 3);
  return 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * DAY));
}

/** Wire fields for a timed block (start .. end) or an all-day span (first day .. exclusive end). */
export function spanFields(start: number, end: number, allDay: boolean): { startDate: string; dueDate: string; isAllDay: boolean } {
  if (allDay) {
    const s = startOfDay(start);
    let e = startOfDay(end) === end ? end : addDays(startOfDay(end), 1);
    if (e <= s) e = addDays(s, 1);
    // a single all-day date is stored with start = due; longer spans keep the exclusive end
    return { startDate: toServer(s), dueDate: toServer(Math.round((e - s) / DAY) === 1 ? s : e), isAllDay: true };
  }
  return { startDate: toServer(start), dueDate: toServer(Math.max(end, start)), isAllDay: false };
}

/** Day density 0..4 for the year heatmap from a count (0 none). */
export function heatLevel(n: number): number {
  return n <= 0 ? 0 : n === 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4;
}

/** Completed counts per local day key from completed tasks. */
export function completionsByDay(tasks: readonly Task[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const t of tasks) {
    if (t.deleted || t.status !== 2) continue;
    const c = parseDate(t.completedTime);
    if (Number.isNaN(c)) continue;
    const k = startOfDay(c);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/** Secondary calendar label under a day number (CAL-049): Intl calendars, day of month plus month on day 1. */
export function altCalendarLabel(ms: number, calendar: string): string {
  const cal = ({ lunar: "chinese", chinese: "chinese", islamic: "islamic-umalqura", hijri: "islamic-umalqura", "islamic-civil": "islamic-civil", "islamic-tbla": "islamic-tbla", korean: "dangi", persian: "persian", hebrew: "hebrew", indian: "indian", ethiopic: "ethiopic", buddhist: "buddhist" } as Record<string, string>)[calendar];
  if (!cal) return "";
  try {
    const parts = new Intl.DateTimeFormat(`en-u-ca-${cal}`, { day: "numeric", month: "short" }).formatToParts(new Date(ms));
    const day = parts.find((p) => p.type === "day")?.value ?? "";
    const month = parts.find((p) => p.type === "month")?.value ?? "";
    return day === "1" ? month : day;
  } catch {
    return "";
  }
}
export const ALT_CALENDARS: Array<{ value: string; label: string }> = [
  { value: "", label: "None" },
  { value: "lunar", label: "Chinese Lunar" },
  { value: "hebrew", label: "Hebrew" },
  { value: "islamic-civil", label: "Hijri (Civil)" },
  { value: "islamic-tbla", label: "Hijri (Kuwaiti)" },
  // the stored "islamic" value predates the three Hijri variants and keeps rendering Umm al-Qura
  { value: "islamic", label: "Hijri (Saudi)" },
  { value: "indian", label: "Indian" },
  { value: "korean", label: "Korean Lunar" },
  { value: "persian", label: "Persian Calendar" },
  { value: "ethiopic", label: "Ethiopic" },
  { value: "buddhist", label: "Buddhist" },
];
