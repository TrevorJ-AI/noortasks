import { describe, expect, it } from "vitest";
import { completeRecurringTask, type RecurringTaskLike } from "../src/index";
import { AMS, NY, at, holidays, iso, wall } from "./helpers";

const ctx = { deviceZone: AMS };
const D = (s: string, z = AMS) => at(z, s);

function task(over: Partial<RecurringTaskLike> = {}): RecurringTaskLike {
  return {
    id: "t1",
    startDate: D("2026-11-10 09:00"),
    dueDate: D("2026-11-10 10:00"),
    isAllDay: false,
    timeZone: AMS,
    repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
    repeatFrom: "0",
    status: 0,
    progress: 60,
    remindTime: "x",
    reminders: [{ id: "r1", trigger: "TRIGGER:-PT15M" }],
    items: [
      { id: "i1", title: "a", status: 1, startDate: D("2026-11-10 09:30"), completedTime: D("2026-11-10 09:40") },
      { id: "i2", title: "b", status: 0 },
    ],
    ...over,
  };
}
const startOf = (r: { updates: Record<string, unknown> }) => wall(AMS, r.updates.startDate as Date);
const dueOf = (r: { updates: Record<string, unknown> }) => wall(AMS, r.updates.dueDate as Date);

describe("mode 0 (due date)", () => {
  const r = completeRecurringTask(task(), D("2026-11-15 14:00"), ctx);
  it("moves to the next occurrence after the current start, not to today", () => {
    expect(r.ended).toBe(false);
    expect(startOf(r)).toBe("2026-11-11 09:00");
    expect(r.dayDelta).toBe(1);
  });
  it("keeps the start-to-due span", () => expect(dueOf(r)).toBe("2026-11-11 10:00"));
  it("resets status, progress, remindTime, completion fields", () => {
    expect(r.updates).toMatchObject({ status: 0, progress: 0, remindTime: null, completedTime: null, completedUserId: null });
  });
  it("subtasks reset to open and shift by the same day delta", () => {
    const items = r.updates.items as { id: string; status: number; startDate?: Date; completedTime: unknown }[];
    expect(items.map((i) => i.status)).toEqual([0, 0]);
    expect(wall(AMS, items[0]!.startDate!)).toBe("2026-11-11 09:30");
    expect(items[0]!.completedTime).toBeNull();
    expect(items[1]!.startDate).toBeUndefined();
  });
  it("reminders are relative triggers and stay unchanged", () => {
    expect(r.updates.reminders).toEqual([{ id: "r1", trigger: "TRIGGER:-PT15M" }]);
  });
  it("creates a history copy of the finished instance", () => {
    expect(r.completedCopy).toMatchObject({ repeatFlag: null, status: 2, repeatTaskId: "t1", childIds: [] });
    expect(wall(AMS, r.completedCopy!.startDate as Date)).toBe("2026-11-10 09:00");
    expect(wall(AMS, r.completedCopy!.completedTime as Date)).toBe("2026-11-15 14:00");
  });
  it("does not mutate the input task", () => {
    const t = task();
    const snapshot = JSON.stringify(t);
    completeRecurringTask(t, D("2026-11-15 14:00"), ctx);
    expect(JSON.stringify(t)).toBe(snapshot);
  });
  it("the flag stays unchanged for an endless rule without COUNT", () => {
    expect(r.repeatFlag).toBe("RRULE:FREQ=DAILY;INTERVAL=1");
  });
});

describe('mode "2" (default): completion jumps to today', () => {
  const r = completeRecurringTask(task({ repeatFrom: "2" }), D("2026-11-15 14:00"), ctx);
  it("lands on today at the original time", () => expect(startOf(r)).toBe("2026-11-15 09:00"));
  it("shifts due and subtasks by the same 5 days", () => {
    expect(r.dayDelta).toBe(5);
    expect(dueOf(r)).toBe("2026-11-15 10:00");
    expect(wall(AMS, (r.updates.items as { startDate?: Date }[])[0]!.startDate!)).toBe("2026-11-15 09:30");
  });
  it("on time: next day", () => {
    const x = completeRecurringTask(task({ repeatFrom: "2", startDate: D("2026-11-15 09:00"), dueDate: D("2026-11-15 10:00") }), D("2026-11-15 09:30"), ctx);
    expect(startOf(x)).toBe("2026-11-16 09:00");
  });
  it("COUNT: skipped overdue occurrences are consumed", () => {
    const x = completeRecurringTask(task({ repeatFrom: "2", repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=10" }), D("2026-11-15 14:00"), ctx);
    expect(x.consumed).toBe(5);
    expect(x.repeatFlag).toBe("RRULE:FREQ=DAILY;INTERVAL=1;COUNT=10;TK_COMPLETEDCOUNT=5");
  });
  it("weekly pattern is honoured", () => {
    const x = completeRecurringTask(
      task({ repeatFrom: "2", repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,FR", startDate: D("2026-11-02 09:00"), dueDate: null }),
      D("2026-11-18 20:00"),
      ctx,
    );
    expect(startOf(x)).toBe("2026-11-20 09:00");
    expect(x.updates.dueDate).toBeUndefined();
  });
});

describe('mode "1" (completion): schedule restarts from the completion day', () => {
  it("weekly, BYDAY ignored, time of day kept", () => {
    const r = completeRecurringTask(task({ repeatFrom: "1", repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", startDate: D("2026-11-09 09:00"), dueDate: D("2026-11-09 11:00") }), D("2026-11-18 20:00"), ctx);
    expect(startOf(r)).toBe("2026-11-25 09:00");
    expect(dueOf(r)).toBe("2026-11-25 11:00");
  });
  it("monthly BYMONTHDAY ignored", () => {
    const r = completeRecurringTask(task({ repeatFrom: "1", repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1" }), D("2026-11-18 20:00"), ctx);
    expect(startOf(r)).toBe("2026-12-18 09:00");
  });
  it("completion day is the zone-local day", () => {
    const r = completeRecurringTask(task({ repeatFrom: "1" }), new Date("2026-11-18T23:30:00Z"), ctx);
    expect(startOf(r)).toBe("2026-11-20 09:00");
  });
  it("COUNT is consumed one per completion", () => {
    const r = completeRecurringTask(task({ repeatFrom: "1", repeatFlag: "RRULE:FREQ=DAILY;COUNT=2" }), D("2026-11-18 20:00"), ctx);
    expect(r.repeatFlag).toBe("RRULE:FREQ=DAILY;COUNT=2;TK_COMPLETEDCOUNT=1");
    const t2 = task({ repeatFrom: "1", repeatFlag: r.repeatFlag, startDate: r.updates.startDate as Date });
    expect(completeRecurringTask(t2, D("2026-11-20 20:00"), ctx).ended).toBe(true);
  });
});

describe("series end", () => {
  it("COUNT=3 ends on the third completion", () => {
    let t = task({ repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=3" });
    const flags: string[] = [];
    let ended = false;
    for (let i = 0; i < 3 && !ended; i++) {
      const r = completeRecurringTask(t, D("2026-11-20 20:00"), ctx);
      ended = r.ended;
      if (!ended) {
        flags.push(r.repeatFlag!);
        t = { ...t, ...r.updates } as RecurringTaskLike;
      }
    }
    expect(flags).toEqual(["RRULE:FREQ=DAILY;INTERVAL=1;COUNT=3;TK_COMPLETEDCOUNT=1", "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=3;TK_COMPLETEDCOUNT=2"]);
    expect(ended).toBe(true);
  });
  it("COUNT=1 ends immediately and just completes the task", () => {
    const r = completeRecurringTask(task({ repeatFlag: "RRULE:FREQ=DAILY;COUNT=1" }), D("2026-11-10 12:00"), ctx);
    expect(r.ended).toBe(true);
    expect(r.updates.status).toBe(2);
    expect(wall(AMS, r.updates.completedTime as Date)).toBe("2026-11-10 12:00");
    expect(r.completedCopy).toBeNull();
  });
  it("UNTIL ends the series", () => {
    expect(completeRecurringTask(task({ repeatFlag: "RRULE:FREQ=DAILY;UNTIL=20261110" }), D("2026-11-10 12:00"), ctx).ended).toBe(true);
    expect(completeRecurringTask(task({ repeatFlag: "RRULE:FREQ=DAILY;UNTIL=20261111" }), D("2026-11-10 12:00"), ctx).ended).toBe(false);
  });
  it("a task without a repeat flag just completes", () => {
    expect(completeRecurringTask(task({ repeatFlag: null }), D("2026-11-10 12:00"), ctx).ended).toBe(true);
  });
  it("exDate is honoured when picking the next date", () => {
    const r = completeRecurringTask(task({ exDate: ["20261111"] }), D("2026-11-10 12:00"), ctx);
    expect(startOf(r)).toBe("2026-11-12 09:00");
  });
  it("needs a start or due date", () => {
    expect(() => completeRecurringTask(task({ startDate: null, dueDate: null }), D("2026-11-10 12:00"), ctx)).toThrow(RangeError);
  });
});

describe("flag bookkeeping", () => {
  it("TK_COMPLETEDCOUNT accumulates across completions", () => {
    const r = completeRecurringTask(task({ repeatFlag: "RRULE:FREQ=DAILY;COUNT=9;TK_COMPLETEDCOUNT=4" }), D("2026-11-10 12:00"), ctx);
    expect(r.repeatFlag).toBe("RRULE:FREQ=DAILY;COUNT=9;TK_COMPLETEDCOUNT=5");
  });
  it("forgetting curve: CYCLE advances with the date", () => {
    const r = completeRecurringTask(task({ repeatFlag: "ERULE:NAME=FORGETTINGCURVE;CYCLE=0;COUNT=5" }), D("2026-11-10 12:00"), ctx);
    expect(startOf(r)).toBe("2026-11-11 09:00");
    expect(r.repeatFlag).toBe("ERULE:NAME=FORGETTINGCURVE;CYCLE=1;COUNT=5;TK_COMPLETEDCOUNT=1");
    const r2 = completeRecurringTask({ ...task(), repeatFlag: r.repeatFlag, startDate: r.updates.startDate as Date, dueDate: null }, D("2026-11-11 12:00"), ctx);
    expect(startOf(r2)).toBe("2026-11-12 09:00");
    expect(r2.repeatFlag).toContain("CYCLE=2");
  });
  it("forgetting curve without COUNT does not grow a counter", () => {
    const r = completeRecurringTask(task({ repeatFlag: "ERULE:NAME=FORGETTINGCURVE;CYCLE=2" }), D("2026-11-10 12:00"), ctx);
    expect(r.repeatFlag).toBe("ERULE:NAME=FORGETTINGCURVE;CYCLE=3");
    expect(startOf(r)).toBe("2026-11-12 09:00"); // gap[2] = 2
  });
  it("custom dates", () => {
    const r = completeRecurringTask(task({ repeatFlag: "ERULE:NAME=CUSTOM;BYDATE=20261112,20261120;COUNT=3" }), D("2026-11-10 12:00"), ctx);
    expect(startOf(r)).toBe("2026-11-12 09:00");
    expect(r.repeatFlag).toBe("ERULE:NAME=CUSTOM;BYDATE=20261112,20261120;COUNT=3;TK_COMPLETEDCOUNT=1");
  });
  it("skip rules are kept on the flag and applied", () => {
    const r = completeRecurringTask(task({ repeatFlag: "RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY,WEEKEND", startDate: D("2026-12-24 09:00"), dueDate: null }), D("2026-12-24 12:00"), { ...ctx, holidays });
    expect(startOf(r)).toBe("2026-12-28 09:00");
    expect(r.dayDelta).toBe(4);
  });
});

describe("all-day, floating, time zones", () => {
  it("all-day: due keeps the day span (exclusive end) and DST does not move midnight", () => {
    const t = task({ isAllDay: true, timeZone: null, startDate: D("2026-10-24 00:00"), dueDate: D("2026-10-25 00:00"), items: [{ id: "i", status: 1, startDate: D("2026-10-24 00:00") }] });
    const r = completeRecurringTask(t, D("2026-10-24 12:00"), ctx);
    expect(iso(r.updates.startDate as Date)).toBe("2026-10-24T22:00:00.000Z"); // 25 Oct 00:00 CEST
    expect(iso(r.updates.dueDate as Date)).toBe("2026-10-25T23:00:00.000Z"); // 26 Oct 00:00 CET
    expect(iso((r.updates.items as { startDate: Date }[])[0]!.startDate)).toBe("2026-10-24T22:00:00.000Z");
  });
  it("all-day tasks ignore a stray timeZone field", () => {
    const t = task({ isAllDay: true, timeZone: NY, startDate: D("2026-11-10 00:00"), dueDate: D("2026-11-11 00:00") });
    const r = completeRecurringTask(t, D("2026-11-10 12:00"), ctx);
    expect(startOf(r)).toBe("2026-11-11 00:00");
    expect(dueOf(r)).toBe("2026-11-12 00:00");
  });
  it("timed task keeps its absolute duration over a DST change", () => {
    const t = task({ startDate: D("2027-03-27 23:30"), dueDate: D("2027-03-28 00:30"), repeatFlag: "RRULE:FREQ=DAILY" });
    const r = completeRecurringTask(t, D("2027-03-27 23:40"), ctx);
    expect(startOf(r)).toBe("2027-03-28 23:30");
    expect((r.updates.dueDate as Date).getTime() - (r.updates.startDate as Date).getTime()).toBe(3600000);
  });
  it("New York task evaluated in New York", () => {
    const t = task({ timeZone: NY, startDate: D("2026-10-31 20:00", NY), dueDate: null });
    const r = completeRecurringTask(t, D("2026-10-31 21:00", NY), ctx);
    expect(wall(NY, r.updates.startDate as Date)).toBe("2026-11-01 20:00");
  });
  it("floating task uses the device zone", () => {
    const t = task({ isFloating: true, timeZone: NY, startDate: D("2026-11-10 09:00"), dueDate: null });
    const r = completeRecurringTask(t, D("2026-11-10 10:00"), ctx);
    expect(startOf(r)).toBe("2026-11-11 09:00");
  });
  it("wire ISO date strings in, wire ISO date strings out", () => {
    const t = task({ startDate: "2026-11-10T08:00:00.000+0000", dueDate: "2026-11-10T09:00:00.000+0000" });
    const r = completeRecurringTask(t, "2026-11-10T12:00:00.000+0000", ctx);
    expect(r.updates.startDate).toBe("2026-11-11T08:00:00.000+0000");
    expect(r.updates.dueDate).toBe("2026-11-11T09:00:00.000+0000");
    expect((r.completedCopy as { completedTime: string }).completedTime).toBe("2026-11-10T12:00:00.000+0000");
  });
  it("month-end: Jan 31 monthly goes to Feb 28 then back to Mar 31 pattern", () => {
    const t = task({ repeatFlag: "RRULE:FREQ=MONTHLY;BYMONTHDAY=31", startDate: D("2027-01-31 09:00"), dueDate: null });
    const r = completeRecurringTask(t, D("2027-01-31 10:00"), ctx);
    expect(startOf(r)).toBe("2027-02-28 09:00");
    const r2 = completeRecurringTask({ ...t, startDate: r.updates.startDate as Date }, D("2027-02-28 10:00"), ctx);
    expect(startOf(r2)).toBe("2027-03-31 09:00");
  });
  it("only a dueDate: it is treated as the start and moves", () => {
    const t = task({ startDate: null, dueDate: D("2026-11-10 09:00") });
    const r = completeRecurringTask(t, D("2026-11-10 12:00"), ctx);
    expect(dueOf(r)).toBe("2026-11-11 09:00");
    expect(r.updates.startDate).toBeUndefined();
  });
});
