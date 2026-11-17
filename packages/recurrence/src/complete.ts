import { toMs, like } from "./dates";
import { parseRepeatFlag, serializeRepeatFlag } from "./flag";
import type { DateInput, RecurrenceContext } from "./model";
import { effectiveMode, followingOccurrences } from "./recurrence";
import { instantToWall, wallToInstant } from "./zone";

export interface ChecklistItemLike {
  id?: string;
  title?: string;
  status?: number;
  startDate?: DateInput | null;
  isAllDay?: boolean;
  completedTime?: DateInput | null;
  snoozeReminderTime?: DateInput | null;
  [k: string]: unknown;
}

export interface RecurringTaskLike {
  id?: string;
  startDate?: DateInput | null;
  dueDate?: DateInput | null;
  isAllDay?: boolean;
  isFloating?: boolean;
  timeZone?: string | null;
  repeatFlag?: string | null;
  repeatFrom?: string | null;
  exDate?: string[] | null;
  items?: ChecklistItemLike[] | null;
  reminders?: { id?: string; trigger: string }[] | null;
  status?: number;
  progress?: number;
  [k: string]: unknown;
}

export interface CompleteResult {
  /** true: this was the last occurrence, the task is simply completed and no new date is produced */
  ended: boolean;
  /** fields to merge into the live (master) task */
  updates: Record<string, unknown>;
  /** history copy of the finished instance (caller mints its id); null when the series ended */
  completedCopy: Record<string, unknown> | null;
  /** calendar days the start moved in the task zone */
  dayDelta: number;
  /** pattern occurrences consumed by this completion (1 normally, more when mode "2" skipped overdue ones) */
  consumed: number;
  repeatFlag: string | null;
}

/**
 * What happens when a repeating task is completed (completion step and due/start advancement).
 * Pure: returns the fields to write, mutates nothing.
 */
export function completeRecurringTask(task: RecurringTaskLike, completedAt: DateInput, ctx: RecurrenceContext = {}): CompleteResult {
  const startIn = task.startDate ?? task.dueDate;
  if (startIn == null) throw new RangeError("Recurring task needs a startDate or dueDate");
  const floatingLike = task.isAllDay === true || task.isFloating === true;
  const zone = (!floatingLike && task.timeZone) || ctx.deviceZone || "UTC";
  const startMs = toMs(startIn);
  const obj = {
    repeatFlag: task.repeatFlag,
    repeatFrom: task.repeatFrom ?? "2",
    startDate: startIn,
    completedTime: completedAt,
    timeZoneId: floatingLike ? null : task.timeZone ?? null,
    exDates: task.exDate ?? null,
  };
  const fctx: RecurrenceContext = { ...ctx, now: completedAt };
  const completedMs = toMs(completedAt);
  const model = parseRepeatFlag(task.repeatFlag);
  const next = model ? followingOccurrences(obj, 1, fctx).items[0] : undefined;

  if (!model || !next) {
    return {
      ended: true,
      updates: { status: 2, completedTime: like(completedAt, completedMs) },
      completedCopy: null,
      dayDelta: 0,
      consumed: 0,
      repeatFlag: task.repeatFlag ?? null,
    };
  }

  const consumed = next.index; // index 1 = the very next pattern date
  if (model.count !== undefined) model.completedCount = Math.max(0, model.completedCount) + consumed;
  if (model.erule?.name === "FORGETTINGCURVE") model.erule.cycle += consumed;
  const repeatFlag = serializeRepeatFlag(model);

  const newStartMs = next.date.getTime();
  const sWall = instantToWall(zone, startMs);
  const nWall = instantToWall(zone, newStartMs);
  const dayDelta = nWall.day - sWall.day;

  const shift = (d: DateInput, allDay = false): DateInput => {
    const w = instantToWall(zone, toMs(d));
    void allDay;
    return like(d, wallToInstant(zone, { day: w.day + dayDelta, sec: w.sec }));
  };

  const updates: Record<string, unknown> = {
    startDate: like(startIn, newStartMs),
    repeatFlag,
    status: 0,
    progress: 0,
    remindTime: null,
    reminder: null,
    snoozeReminderTime: null,
    completedTime: null,
    completedUserId: null,
  };
  if (task.startDate == null) delete updates.startDate;

  if (task.dueDate != null) {
    const dueMs = toMs(task.dueDate);
    let newDue: number;
    if (task.isAllDay) {
      const dw = instantToWall(zone, dueMs);
      newDue = wallToInstant(zone, { day: nWall.day + (dw.day - sWall.day), sec: dw.sec });
    } else {
      newDue = newStartMs + (dueMs - startMs);
    }
    updates.dueDate = like(task.dueDate, task.startDate == null ? newStartMs : newDue);
  }

  if (task.items) {
    updates.items = task.items.map((it) => {
      const out: ChecklistItemLike = { ...it, status: 0, completedTime: null, snoozeReminderTime: null };
      if (it.startDate != null) out.startDate = shift(it.startDate, it.isAllDay === true);
      return out;
    });
  }
  // Reminders are relative triggers ("TRIGGER:-PT15M"): they follow the new date unchanged.
  if (task.reminders) updates.reminders = task.reminders.map((r) => ({ ...r }));

  const completedCopy: Record<string, unknown> = {
    repeatFlag: null,
    status: 2,
    completedTime: like(completedAt, completedMs),
    repeatTaskId: task.id ?? null,
    childIds: [],
    startDate: task.startDate ?? null,
    dueDate: task.dueDate ?? null,
  };
  if (task.items) completedCopy.items = task.items.map((it) => ({ ...it }));

  void effectiveMode;
  return { ended: false, updates, completedCopy, dayDelta, consumed, repeatFlag };
}
