import { newId, type Preferences, type Reminder, type Task } from "../lib/core";
import { addDays, parseDate, startOfDay, toServer } from "../lib/dates";
import type { DateValue } from "./DatePicker";

/** Date picker result to task fields. Clear removes the date, time, reminders and repeat (TASK-088 decision). */
export function datePatch(v: DateValue, existing?: Pick<Task, "reminders">): Partial<Task> {
  if (!v.startDate) return { startDate: undefined, dueDate: undefined, isAllDay: undefined, reminders: [], repeatFlag: undefined, repeatFrom: undefined, exDate: [], reminder: undefined };
  const old = existing?.reminders ?? [];
  const reminders: Reminder[] = v.reminders.map((trigger) => old.find((r) => r.trigger === trigger) ?? { id: newId(), trigger });
  return {
    startDate: v.startDate,
    dueDate: v.dueDate ?? v.startDate,
    isAllDay: v.isAllDay ?? true,
    reminders,
    repeatFlag: v.repeatFlag,
    repeatFrom: v.repeatFlag ? (v.repeatFrom ?? "2") : undefined,
    repeatFirstDate: v.repeatFlag ? v.startDate : undefined,
    timeZone: v.timeZone,
    ...(v.annoyingAlert !== undefined ? { annoyingAlert: v.annoyingAlert === -1 ? -1 : 0 } : {}),
  };
}

/** Shift a task to a given day keeping its time of day (Tab+1/2/3, drag onto Today/Tomorrow, Postpone). */
export function moveToDay(t: Task, dayMs: number): Partial<Task> {
  const s = parseDate(t.startDate ?? t.dueDate ?? undefined);
  const day = startOfDay(dayMs);
  if (Number.isNaN(s)) return { startDate: toServer(day), dueDate: toServer(day), isAllDay: true };
  const delta = day - startOfDay(s);
  const e = parseDate(t.dueDate ?? undefined);
  const shift = (ms: number): number => {
    // keep the wall-clock time across DST changes
    const d = new Date(ms);
    const n = new Date(day + (startOfDay(ms) - startOfDay(s)));
    n.setHours(d.getHours(), d.getMinutes(), 0, 0);
    return n.getTime();
  };
  void delta;
  return { startDate: toServer(shift(s)), dueDate: toServer(Number.isNaN(e) ? shift(s) : shift(e)) };
}

export function defaultDueFor(prefs: Preferences, now: number): Partial<Task> {
  const map: Record<number, number> = { 1: 0, 2: 1, 3: 2, 4: 7 };
  const off = map[prefs.defaultDueDate];
  if (off === undefined) return {};
  const day = addDays(startOfDay(now), off);
  return { startDate: toServer(day), dueDate: toServer(day), isAllDay: true, reminders: (prefs.defaultADReminders ?? []).map((trigger) => ({ id: newId(), trigger })) };
}

export function tagLabel(tags: Array<{ name: string; label?: string }>, name: string): string {
  return tags.find((t) => t.name === name.toLowerCase())?.label ?? name;
}
