import { formatServerDate, parseWireDate } from "./core";

export const DAY = 86_400_000;
export const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function toServer(d: Date | number): string {
  const ms = typeof d === "number" ? d : d.getTime();
  return formatServerDate(Math.floor(ms / 1000) * 1000);
}

/** Server dates (+0000), query dates and ISO strings with a colon offset (quick-add output). */
export function parseDate(s: string | null | undefined): number {
  if (!s) return NaN;
  const w = parseWireDate(s);
  return Number.isNaN(w) ? Date.parse(s) : w;
}

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  return d.getTime();
}
export function addMonths(ms: number, n: number): number {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + n);
  return d.getTime();
}
/** Whole local calendar days from a to b. */
export function dayDiff(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
}
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
/** 0 = Sunday. Week start setting values: SUN, MON, SAT. */
export function weekStartIndex(startDayOfWeek: string | undefined): 0 | 1 | 6 {
  return startDayOfWeek === "MON" ? 1 : startDayOfWeek === "SAT" ? 6 : 0;
}
export function startOfWeek(ms: number, weekStart: number): number {
  const s = startOfDay(ms);
  const dow = new Date(s).getDay();
  return addDays(s, -((dow - weekStart + 7) % 7));
}

export function formatTime(ms: number, meridiem: boolean): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  if (!meridiem) return `${String(h).padStart(2, "0")}:${m}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export type DateFormat = "MM/DD/YYYY" | "DD/MM/YYYY" | "YYYY/MM/DD";
export function formatNumericDate(ms: number, fmt: DateFormat): string {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const y = d.getFullYear();
  return fmt === "DD/MM/YYYY" ? `${dd}/${mm}/${y}` : fmt === "YYYY/MM/DD" ? `${y}/${mm}/${dd}` : `${mm}/${dd}/${y}`;
}

/** Short relative date label as used on chips: Today, Tomorrow, Yesterday, weekday within a week, else "Nov 27" (year when different). */
export function relativeDayLabel(ms: number, now: number): string {
  const diff = dayDiff(now, ms);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  const d = new Date(ms);
  if (diff > 1 && diff < 7) return WEEKDAYS_SHORT[d.getDay()]!;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}${sameYear ? "" : `, ${d.getFullYear()}`}`;
}

export interface DatedLike {
  startDate?: string | null;
  dueDate?: string | null;
  isAllDay?: boolean | null;
}

/** The instant a task is "on": startDate, else dueDate. NaN when undated. */
export function taskStart(t: DatedLike): number {
  const s = parseDate(t.startDate ?? undefined);
  return Number.isNaN(s) ? parseDate(t.dueDate ?? undefined) : s;
}
/** End instant for spans (dueDate when it differs from startDate). */
export function taskEnd(t: DatedLike): number {
  const d = parseDate(t.dueDate ?? undefined);
  return Number.isNaN(d) ? taskStart(t) : d;
}
export const isTimed = (t: DatedLike): boolean => t.isAllDay === false;

export function isOverdue(t: DatedLike & { status?: number }, now: number): boolean {
  if (t.status !== undefined && t.status !== 0) return false;
  const s = taskStart(t);
  if (Number.isNaN(s)) return false;
  const end = taskEnd(t);
  if (isTimed(t)) return end < now;
  // all-day: overdue once its last day is before today (an exclusive all-day end counts as the previous day)
  const lastDay = end > s ? addDays(startOfDay(end), startOfDay(end) === end ? -1 : 0) : startOfDay(s);
  return lastDay < startOfDay(now);
}

export function chipLabel(t: DatedLike, now: number, meridiem: boolean): string {
  const s = taskStart(t);
  if (Number.isNaN(s)) return "";
  let label = relativeDayLabel(s, now);
  if (isTimed(t)) label += `, ${formatTime(s, meridiem)}`;
  const e = parseDate(t.dueDate ?? undefined);
  if (!Number.isNaN(e) && e > s) {
    if (isTimed(t) && dayDiff(s, e) === 0) label += ` - ${formatTime(e, meridiem)}`;
    else if (!isTimed(t) && dayDiff(s, e) > 1) label += ` - ${relativeDayLabel(addDays(e, -1), now)}`;
    else if (isTimed(t)) label += ` - ${relativeDayLabel(e, now)}, ${formatTime(e, meridiem)}`;
  }
  return label;
}

export function localMidnightServer(ms: number): string {
  return toServer(startOfDay(ms));
}
