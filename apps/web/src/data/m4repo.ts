import { CheckinStatus, DEFAULT_HABIT_RULE, HabitStatus, HabitType, newId } from "../lib/core";
import { toServer } from "../lib/dates";
import type { NoorDb } from "./db";
import type { M4Entity } from "./m4sync";
import { clampPomo, type Checkin, type Countdown, type FocusRecord, type FocusTimer, type Habit, type HabitPrefs, type HabitRecord, type HabitSection, type PomoPrefs } from "./m4types";
import type { SyncEngine } from "./sync";

/** HAB-011: default fields for a new habit. */
export function newHabit(p: Partial<Habit> = {}): Habit {
  return {
    id: newId(),
    name: "",
    iconRes: "habit_daily_check_in",
    color: "#3fa66b",
    encouragement: "",
    goal: 1,
    step: 1,
    type: HabitType.Boolean,
    unit: "Count",
    status: HabitStatus.Normal,
    repeatRule: DEFAULT_HABIT_RULE,
    reminders: [],
    recordEnable: false,
    sectionId: "-1",
    style: 1,
    targetDays: 0,
    targetStartDate: null,
    completedCycles: 0,
    exDates: [],
    totalCheckIns: 0,
    currentStreak: 0,
    maxStreak: 0,
    ...p,
  };
}

/** Local-first writes of the M4 objects: IndexedDB first, then an outbox op, then a sync soon. */
export class M4Repo {
  onChange: () => void = () => {};
  constructor(
    readonly db: NoorDb,
    readonly engine: SyncEngine,
  ) {}

  private async put(entity: M4Entity, row: { id: string; [k: string]: unknown }, add: boolean): Promise<void> {
    const conf = { habit: this.db.habits, habitSection: this.db.habitSections, checkin: this.db.checkins, habitRecord: this.db.habitRecords, pomodoro: this.db.pomos, timing: this.db.pomos, timer: this.db.timers, countdown: this.db.countdowns }[entity];
    await this.db.transaction("rw", conf, this.db.outbox, async () => {
      const old = await conf.get(row.id);
      const base = (old as Record<string, unknown> | undefined)?._syncBase;
      await (conf as { put: (r: unknown) => Promise<unknown> }).put({ ...row, ...(base ? { _syncBase: base } : {}) });
      await this.engine.enqueue("m4", row.id, { entity, add: add || undefined });
    });
    this.onChange();
  }
  private async del(entity: M4Entity, id: string): Promise<void> {
    await this.engine.enqueue("m4Delete", id, { entity });
    this.onChange();
  }

  // ---------------------------------------------------------------- habits
  async saveHabit(h: Habit): Promise<Habit> {
    const old = await this.db.habits.get(h.id);
    const now = toServer(Date.now());
    const row: Habit = { ...h, modifiedTime: now, createdTime: h.createdTime ?? old?.createdTime ?? now };
    if (row.type !== HabitType.Real) row.goal = 1;
    if (!old && row.sortOrder === undefined) row.sortOrder = Math.max(0, ...(await this.db.habits.toArray()).map((x) => x.sortOrder ?? 0)) + 1;
    await this.put("habit", row, !old);
    return row;
  }
  async archiveHabit(id: string, archived: boolean): Promise<void> {
    const h = await this.db.habits.get(id);
    if (!h) return;
    await this.saveHabit({ ...h, status: archived ? HabitStatus.Archived : HabitStatus.Normal, archivedTime: archived ? toServer(Date.now()) : null });
  }
  /** HAB-027: the habit and all its check-ins and logs go for good (the server removes them with the habit). */
  async deleteHabit(id: string): Promise<void> {
    await this.db.transaction("rw", this.db.habits, this.db.checkins, this.db.habitRecords, async () => {
      await this.db.habits.delete(id);
      await this.db.checkins.where("habitId").equals(id).delete();
      await this.db.habitRecords.where("habitId").equals(id).delete();
    });
    await this.del("habit", id);
  }
  /** RPT-104 / HAB-036: skip a day = add it to exDates (YYYYMMDD strings); again = undo. */
  async toggleSkip(id: string, stamp: number): Promise<boolean> {
    const h = await this.db.habits.get(id);
    if (!h) return false;
    const key = String(stamp);
    const has = (h.exDates ?? []).includes(key);
    await this.saveHabit({ ...h, exDates: has ? (h.exDates ?? []).filter((x) => x !== key) : [...(h.exDates ?? []), key] });
    return !has;
  }

  async saveSection(s: HabitSection): Promise<void> {
    const old = await this.db.habitSections.get(s.id);
    if (!old && s.sortOrder === undefined) s = { ...s, sortOrder: Math.max(0, ...(await this.db.habitSections.toArray()).map((x) => x.sortOrder ?? 0)) + 1 };
    await this.put("habitSection", { ...s, modifiedTime: toServer(Date.now()), createdTime: s.createdTime ?? toServer(Date.now()) }, !old);
  }
  /** deleting a section moves its habits to "no section" (the server does the same) */
  async deleteSection(id: string): Promise<void> {
    await this.db.habitSections.delete(id);
    for (const h of await this.db.habits.filter((x) => x.sectionId === id).toArray()) await this.db.habits.put({ ...h, sectionId: "-1" });
    await this.del("habitSection", id);
  }

  async checkinOf(habitId: string, stamp: number): Promise<Checkin | undefined> {
    return this.db.checkins.where("[habitId+checkinStamp]").equals([habitId, stamp]).first();
  }
  /**
   * Set the check-in of a day (HAB-014, HAB-017, HAB-025). Boolean habits: done = status 2 with value 1; undone keeps
   * the row with status 1 rather than deleting it. Real habits: value accumulates, done when
   * value >= goal.
   */
  async setCheckin(h: Habit, stamp: number, patch: { value?: number; status?: number }): Promise<Checkin> {
    const old = await this.checkinOf(h.id, stamp);
    const goal = h.type === HabitType.Real ? (h.goal ?? 1) : 1;
    const value = patch.value ?? old?.value ?? 0;
    let status = patch.status ?? old?.status ?? CheckinStatus.Unlabeled;
    if (h.type === HabitType.Real && patch.value !== undefined && patch.status === undefined) status = value >= goal ? CheckinStatus.Done : status === CheckinStatus.Undone ? CheckinStatus.Undone : CheckinStatus.Unlabeled;
    const now = toServer(Date.now());
    const row: Checkin = { ...(old ?? { id: newId(), habitId: h.id, checkinStamp: stamp }), goal, value: h.type === HabitType.Real ? value : status === CheckinStatus.Done ? 1 : 0, status, checkinTime: old?.checkinTime ?? now, opTime: now };
    await this.put("checkin", row, !old);
    return row;
  }
  async deleteCheckin(id: string): Promise<void> {
    await this.db.checkins.delete(id);
    await this.del("checkin", id);
  }

  async recordOf(habitId: string, stamp: number): Promise<HabitRecord | undefined> {
    return this.db.habitRecords.where("habitId").equals(habitId).filter((r) => (r.checkinStamp ?? r.stamp) === stamp).first();
  }
  /** HAB-801 / HAB-018: daily log with note and mood (emoji 10..50). No length cap (PREM-043). */
  async saveRecord(habitId: string, stamp: number, content: string, emoji?: number): Promise<void> {
    const old = await this.recordOf(habitId, stamp);
    await this.put("habitRecord", { ...(old ?? { id: newId(), habitId, checkinStamp: stamp, stamp }), content, emoji, opTime: toServer(Date.now()) }, !old);
  }
  async deleteRecord(id: string): Promise<void> {
    await this.db.habitRecords.delete(id);
    await this.del("habitRecord", id);
  }

  // ---------------------------------------------------------------- focus
  async saveFocus(r: FocusRecord): Promise<void> {
    const old = await this.db.pomos.get(r.id);
    const entity: M4Entity = r.type === 1 ? "timing" : "pomodoro";
    if (old && old.type !== r.type) {
      // a record never changes type on the server: delete and add under the other endpoint
      await this.del(old.type === 1 ? "timing" : "pomodoro", r.id);
      await this.put(entity, r, true);
      return;
    }
    await this.put(entity, r, !old);
  }
  async deleteFocus(ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = await this.db.pomos.get(id);
      if (!r) continue;
      await this.db.pomos.delete(id);
      await this.del(r.type === 1 ? "timing" : "pomodoro", id);
    }
  }
  /** FOC-022: DELETE /pomodoro/all, online only (a sweeping delete is not queued). */
  async deleteAllFocus(): Promise<void> {
    await this.engine.api.del("/api/v2/pomodoro/all");
    await this.db.pomos.clear();
    await this.db.outbox.filter((o) => (o.kind === "m4" || o.kind === "m4Delete") && (o.payload.entity === "pomodoro" || o.payload.entity === "timing")).delete();
    this.onChange();
  }

  async saveTimer(t: FocusTimer): Promise<void> {
    const old = await this.db.timers.get(t.id);
    const now = toServer(Date.now());
    if (!old && t.sortOrder === undefined) t = { ...t, sortOrder: Math.max(0, ...(await this.db.timers.toArray()).map((x) => x.sortOrder ?? 0)) + 1 };
    await this.put("timer", { ...t, createdTime: t.createdTime ?? now, modifiedTime: now }, !old);
  }
  async deleteTimer(id: string): Promise<void> {
    await this.db.timers.delete(id);
    await this.del("timer", id);
  }

  // ---------------------------------------------------------------- countdown
  async saveCountdown(c: Countdown): Promise<void> {
    const old = await this.db.countdowns.get(c.id);
    const now = toServer(Date.now());
    if (!old && c.sortOrder === undefined) c = { ...c, sortOrder: Math.max(0, ...(await this.db.countdowns.toArray()).map((x) => x.sortOrder ?? 0)) + 1 };
    // one pin slot (CNT-019): pinning this one unpins the others locally too
    if (c.pinnedTime && c.pinnedTime !== old?.pinnedTime) for (const o of await this.db.countdowns.filter((x) => !!x.pinnedTime && x.id !== c.id).toArray()) await this.db.countdowns.put({ ...o, pinnedTime: null });
    await this.put("countdown", { ...c, createdTime: (c.createdTime as string | undefined) ?? now, modifiedTime: now }, !old);
  }
  async deleteCountdown(id: string): Promise<void> {
    await this.db.countdowns.delete(id);
    await this.del("countdown", id);
  }

  // ---------------------------------------------------------------- preferences
  async setPomoPrefs(patch: Partial<PomoPrefs>): Promise<void> {
    const p = { ...patch };
    if (p.pomoDuration !== undefined) p.pomoDuration = clampPomo(p.pomoDuration);
    const cur = await this.db.getKV<Record<string, unknown>>("pomoPrefs", {});
    await this.db.setKV("pomoPrefs", { ...cur, ...p });
    await this.engine.enqueue("pref", "pomodoro", p);
    this.onChange();
  }
  async setHabitPrefs(patch: Partial<HabitPrefs>): Promise<void> {
    const cur = await this.db.getKV<Record<string, unknown>>("habitPrefs", {});
    await this.db.setKV("habitPrefs", { ...cur, ...patch });
    await this.engine.enqueue("pref", "habit", patch);
    this.onChange();
  }
}
