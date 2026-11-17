import { DAY, addDays, dayDiff, startOfDay, toServer } from "../lib/dates";
import { taskSpan } from "./calendar";

/**
 * Timeline (gantt) geometry. Positions are measured in local calendar days plus the wall-clock fraction of the
 * day, so a 23 or 25 hour DST day is as wide as any other day and a bar never drifts across a DST change.
 */
export type Zoom = "day" | "week" | "month";
export const PX_PER_DAY: Record<Zoom, number> = { day: 960, week: 120, month: 36 };
/** drag snapping in minutes per zoom */
export const SNAP_MIN: Record<Zoom, number> = { day: 15, week: 24 * 60, month: 24 * 60 };

const minutesOfDay = (ms: number): number => {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

/** x in pixels of an instant relative to the origin day. */
export function xOf(ms: number, origin: number, pxPerDay: number): number {
  return (dayDiff(origin, ms) + minutesOfDay(ms) / 1440) * pxPerDay;
}

/** Instant at pixel x, snapped to `snap` minutes, built from the local calendar (DST safe). */
export function timeAt(x: number, origin: number, pxPerDay: number, snap: number): number {
  const days = x / pxPerDay;
  let dayIndex = Math.floor(days);
  let minutes = Math.round(((days - dayIndex) * 1440) / snap) * snap;
  if (minutes >= 1440) {
    dayIndex += 1;
    minutes = 0;
  }
  const base = new Date(addDays(startOfDay(origin), dayIndex));
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minutes).getTime();
}

export interface Bar {
  start: number;
  end: number;
  allDay: boolean;
}

export function barOf(t: { startDate?: string | null; dueDate?: string | null; isAllDay?: boolean | null }): Bar | null {
  return taskSpan(t);
}

/** Shift a bar by whole calendar days plus minutes, keeping wall-clock times across DST. */
export function moveBar(b: Bar, deltaDays: number, deltaMinutes = 0): Bar {
  const shift = (ms: number): number => {
    const d = new Date(addDays(ms, deltaDays));
    if (deltaMinutes) d.setMinutes(d.getMinutes() + deltaMinutes);
    return d.getTime();
  };
  if (b.allDay) return { start: addDays(b.start, deltaDays), end: addDays(b.end, deltaDays), allDay: true };
  return { start: shift(b.start), end: shift(b.end), allDay: false };
}

/** Move one edge to an instant; all-day edges snap to midnights (end exclusive), at least one day / 15 minutes long. */
export function resizeBar(b: Bar, edge: "start" | "end", to: number): Bar {
  if (b.allDay) {
    const day = startOfDay(to);
    if (edge === "end") return { ...b, end: Math.max(addDays(b.start, 1), to - day > DAY / 2 ? addDays(day, 1) : day) };
    return { ...b, start: Math.min(addDays(b.end, -1), day) };
  }
  if (edge === "end") return { ...b, end: Math.max(b.start + 15 * 60_000, to) };
  return { ...b, start: Math.min(b.end - 15 * 60_000, to) };
}

/** Wire fields for a bar. A one-day all-day bar is stored with start = due. */
export function barFields(b: Bar): { startDate: string; dueDate: string; isAllDay: boolean } {
  if (b.allDay) {
    const one = Math.round((b.end - b.start) / DAY) <= 1;
    return { startDate: toServer(b.start), dueDate: toServer(one ? b.start : b.end), isAllDay: true };
  }
  return { startDate: toServer(b.start), dueDate: toServer(b.end), isAllDay: false };
}

/** Header ticks: one per day (week, month zoom) or per hour (day zoom). */
export function ticks(origin: number, days: number, zoom: Zoom): Array<{ ms: number; x: number; major: boolean }> {
  const px = PX_PER_DAY[zoom];
  const out: Array<{ ms: number; x: number; major: boolean }> = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(startOfDay(origin), i);
    if (zoom === "day") {
      for (let h = 0; h < 24; h++) {
        const ms = new Date(new Date(d).getFullYear(), new Date(d).getMonth(), new Date(d).getDate(), h).getTime();
        out.push({ ms, x: (i + h / 24) * px, major: h === 0 });
      }
    } else out.push({ ms: d, x: i * px, major: zoom === "week" ? new Date(d).getDay() === 1 : new Date(d).getDate() === 1 });
  }
  return out;
}
