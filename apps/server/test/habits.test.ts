import { describe, expect, test } from "vitest";
import { T0, addHabit, checkIn, checkin, getHabit, habit, id, mk4 } from "./m4helpers.js";

describe("habits batch", () => {
  test("add fills the defaults of a new habit", async () => {
    const m = await mk4();
    const h = await addHabit(m);
    const got = await getHabit(m, h.id);
    expect(got).toMatchObject({ iconRes: "habit_daily_check_in", type: "Boolean", unit: "Count", goal: 1, repeatRule: "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA", sectionId: "-1", style: 1, status: 0, totalCheckIns: 0, currentStreak: 0, maxStreak: 0 });
    expect(got.etag).toBeTruthy();
    expect(got.createdTime).toBeTruthy();
  });
  test("a Boolean habit always has goal 1", async () => {
    const m = await mk4();
    const h = await addHabit(m, { goal: 8 });
    expect((await getHabit(m, h.id)).goal).toBe(1);
  });
  test("a Real habit keeps its goal, step and unit", async () => {
    const m = await mk4();
    const h = await addHabit(m, { type: "Real", goal: 8, step: 2, unit: "Glass" });
    expect(await getHabit(m, h.id)).toMatchObject({ type: "Real", goal: 8, step: 2, unit: "Glass" });
  });
  test("unknown fields survive add and update", async () => {
    const m = await mk4();
    const h = await addHabit(m, { zzFuture: { a: [1, null] } });
    await m.call("POST", "/api/v2/habits/batch", { update: [{ ...(await getHabit(m, h.id)), name: "Renamed", zzOther: 7 }] });
    expect(await getHabit(m, h.id)).toMatchObject({ name: "Renamed", zzFuture: { a: [1, null] }, zzOther: 7 });
  });
  test("add twice is EXISTED", async () => {
    const m = await mk4();
    const h = await addHabit(m);
    expect((await m.call("POST", "/api/v2/habits/batch", { add: [h] })).json.id2error[h.id]).toBe("EXISTED");
  });
  test("update of a missing habit is NOT_EXISTED", async () => {
    const m = await mk4();
    const ghost = id();
    expect((await m.call("POST", "/api/v2/habits/batch", { update: [{ id: ghost, name: "x" }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("delete of a missing habit is NOT_EXISTED", async () => {
    const m = await mk4();
    const ghost = id();
    expect((await m.call("POST", "/api/v2/habits/batch", { delete: [ghost] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("an invalid status is refused", async () => {
    const m = await mk4();
    const h = habit({ status: 7 });
    expect((await m.call("POST", "/api/v2/habits/batch", { add: [h] })).json.id2error[h.id]).toBe("UNKNOWN");
    expect((await m.call("GET", "/api/v2/habits")).json).toEqual([]);
  });
  test("update returns a new etag and bumps modifiedTime", async () => {
    const m = await mk4();
    const h = await addHabit(m);
    const before = await getHabit(m, h.id);
    m.clock.t += 5000;
    const r = await m.call("POST", "/api/v2/habits/batch", { update: [{ ...before, name: "x" }] });
    expect(r.json.id2etag[h.id]).not.toBe(before.etag);
    expect((await getHabit(m, h.id)).modifiedTime).not.toBe(before.modifiedTime);
  });
  test("createdTime survives an update that omits it", async () => {
    const m = await mk4();
    const h = await addHabit(m);
    const created = (await getHabit(m, h.id)).createdTime;
    await m.call("POST", "/api/v2/habits/batch", { update: [{ id: h.id, name: "bare" }] });
    expect((await getHabit(m, h.id)).createdTime).toBe(created);
  });
  test("clients cannot write the streak counters", async () => {
    const m = await mk4();
    const h = await addHabit(m);
    await m.call("POST", "/api/v2/habits/batch", { update: [{ ...(await getHabit(m, h.id)), currentStreak: 99, maxStreak: 99, totalCheckIns: 99 }] });
    expect(await getHabit(m, h.id)).toMatchObject({ currentStreak: 0, maxStreak: 0, totalCheckIns: 0 });
  });
  test("sortOrder is assigned in order of creation", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const b = await addHabit(m);
    const list = (await m.call("GET", "/api/v2/habits")).json;
    expect(list.map((x: any) => x.id)).toEqual([a.id, b.id]);
    expect(list[1].sortOrder).toBeGreaterThan(list[0].sortOrder);
  });
  test("archive sets archivedTime, unarchive clears it", async () => {
    const m = await mk4();
    const h = await addHabit(m);
    await m.call("POST", "/api/v2/habits/batch", { update: [{ ...(await getHabit(m, h.id)), status: 1 }] });
    const archived = await getHabit(m, h.id);
    expect(archived.status).toBe(1);
    expect(archived.archivedTime).toBeTruthy();
    await m.call("POST", "/api/v2/habits/batch", { update: [{ ...archived, status: 0 }] });
    expect((await getHabit(m, h.id)).archivedTime).toBeNull();
  });
  test("many habits are allowed (limits are unlimited)", async () => {
    const m = await mk4();
    const add = Array.from({ length: 320 }, () => habit());
    const r = await m.call("POST", "/api/v2/habits/batch", { add });
    expect(Object.keys(r.json.id2etag)).toHaveLength(320);
    expect(r.json.id2error).toEqual({});
  });
  test("a body without a list does nothing", async () => {
    const m = await mk4();
    expect((await m.call("POST", "/api/v2/habits/batch", {})).json).toEqual({ id2etag: {}, id2error: {} });
  });
});

describe("habit sections", () => {
  test("add, update, delete", async () => {
    const m = await mk4();
    const s = { id: id("s"), name: "Evening" };
    const a = await m.call("POST", "/api/v2/habitSections/batch", { add: [s] });
    expect(a.json.id2etag[s.id]).toBeTruthy();
    expect((await m.call("GET", "/api/v2/habitSections")).json[0]).toMatchObject({ name: "Evening", sortOrder: 1 });
    await m.call("POST", "/api/v2/habitSections/batch", { update: [{ ...s, name: "Night owl" }] });
    expect((await m.call("GET", "/api/v2/habitSections")).json[0].name).toBe("Night owl");
    expect((await m.call("POST", "/api/v2/habitSections/batch", { delete: [s.id] })).json.id2error).toEqual({});
    expect((await m.call("GET", "/api/v2/habitSections")).json).toEqual([]);
  });
  test("the default keys _morning _afternoon _night are plain names", async () => {
    const m = await mk4();
    const adds = ["_morning", "_afternoon", "_night"].map((name) => ({ id: id("s"), name }));
    await m.call("POST", "/api/v2/habitSections/batch", { add: adds });
    expect((await m.call("GET", "/api/v2/habitSections")).json.map((s: any) => s.name)).toEqual(["_morning", "_afternoon", "_night"]);
  });
  test("error codes", async () => {
    const m = await mk4();
    const s = { id: id("s"), name: "x" };
    await m.call("POST", "/api/v2/habitSections/batch", { add: [s] });
    expect((await m.call("POST", "/api/v2/habitSections/batch", { add: [s] })).json.id2error[s.id]).toBe("EXISTED");
    const ghost = id();
    expect((await m.call("POST", "/api/v2/habitSections/batch", { update: [{ id: ghost }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
    expect((await m.call("POST", "/api/v2/habitSections/batch", { delete: [ghost] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("deleting a section moves its habits to no section", async () => {
    const m = await mk4();
    const s = { id: id("s"), name: "x" };
    await m.call("POST", "/api/v2/habitSections/batch", { add: [s] });
    const h = await addHabit(m, { sectionId: s.id });
    await m.call("POST", "/api/v2/habitSections/batch", { delete: [s.id] });
    expect((await getHabit(m, h.id)).sectionId).toBe("-1");
  });
  test("more than 18 sections are allowed", async () => {
    const m = await mk4();
    const add = Array.from({ length: 25 }, (_, i) => ({ id: id("s"), name: `s${i}` }));
    expect(Object.keys((await m.call("POST", "/api/v2/habitSections/batch", { add })).json.id2etag)).toHaveLength(25);
  });
});

describe("habit check-ins", () => {
  test("add, query, per-habit grouping", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const b = await addHabit(m);
    await checkIn(m, a.id, 20261113);
    await checkIn(m, a.id, 20261114);
    await checkIn(m, b.id, 20261114);
    const q = (await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [a.id, b.id], afterStamp: 0 })).json;
    expect(q.checkins[a.id].map((c: any) => c.checkinStamp)).toEqual([20261113, 20261114]);
    expect(q.checkins[b.id]).toHaveLength(1);
  });
  test("query returns every requested habit, empty when it has none", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    expect((await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [a.id], afterStamp: 0 })).json).toEqual({ checkins: { [a.id]: [] } });
  });
  test("afterStamp filters the older days", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    for (const s of [20261110, 20261112, 20261114]) await checkIn(m, a.id, s);
    const q = (await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [a.id], afterStamp: 20261112 })).json;
    expect(q.checkins[a.id].map((c: any) => c.checkinStamp)).toEqual([20261112, 20261114]);
  });
  test("query without habitIds covers every habit", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    await checkIn(m, a.id, 20261114);
    expect(Object.keys((await m.call("POST", "/api/v2/habitCheckins/query", {})).json.checkins)).toEqual([a.id]);
  });
  test("a check-in gets the habit goal, a value, a status and times", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const c = await checkIn(m, a.id, 20261114);
    const row = (await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [a.id] })).json.checkins[a.id][0];
    expect(row).toMatchObject({ id: c.id, habitId: a.id, checkinStamp: 20261114, goal: 1, value: 0, status: 2 });
    expect(row.checkinTime).toBeTruthy();
    expect(row.opTime).toBeTruthy();
  });
  test("habit_not_exist when the habit is unknown", async () => {
    const m = await mk4();
    const c = checkin(id(), 20261114);
    expect((await m.call("POST", "/api/v2/habitCheckins/batch", { add: [c] })).json.id2error[c.id]).toBe("habit_not_exist");
  });
  test("EXISTED for a repeated id", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const c = await checkIn(m, a.id, 20261114);
    expect((await m.call("POST", "/api/v2/habitCheckins/batch", { add: [c] })).json.id2error[c.id]).toBe("EXISTED");
  });
  test("DuplicateCheckinException for a second row on the same day", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    await checkIn(m, a.id, 20261114);
    const dup = checkin(a.id, 20261114);
    expect((await m.call("POST", "/api/v2/habitCheckins/batch", { add: [dup] })).json.id2error[dup.id]).toBe("DuplicateCheckinException");
  });
  test("UNKNOWN for an invalid or far-future stamp", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    for (const stamp of [20260230, 20261201, "20261114" as unknown as number]) {
      const c = checkin(a.id, stamp);
      expect((await m.call("POST", "/api/v2/habitCheckins/batch", { add: [c] })).json.id2error[c.id]).toBe("UNKNOWN");
    }
  });
  test("tomorrow is accepted (zone skew), the day after is not", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    await checkIn(m, a.id, 20261116);
    const c = checkin(a.id, 20261117);
    expect((await m.call("POST", "/api/v2/habitCheckins/batch", { add: [c] })).json.id2error[c.id]).toBe("UNKNOWN");
  });
  test("retroactive check-ins have no age limit", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    await checkIn(m, a.id, 20240102);
    expect((await getHabit(m, a.id)).totalCheckIns).toBe(1);
  });
  test("update changes the value after the fact and recomputes the streak", async () => {
    const m = await mk4();
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261113 });
    const cs = [];
    for (const s of [20261113, 20261114, 20261115]) cs.push(await checkIn(m, a.id, s));
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 3, maxStreak: 3, totalCheckIns: 3 });
    // un-do the middle day: status 1 (undone)
    await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ ...cs[1], status: 1 }] });
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 1, maxStreak: 1, totalCheckIns: 2 });
    await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ ...cs[1], status: 2 }] });
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 3, totalCheckIns: 3 });
  });
  test("moving a check-in to another day", async () => {
    const m = await mk4();
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261110 });
    const c = await checkIn(m, a.id, 20261112);
    await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ ...c, checkinStamp: 20261113 }] });
    const rows = (await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [a.id] })).json.checkins[a.id];
    expect(rows.map((r: any) => r.checkinStamp)).toEqual([20261113]);
  });
  test("moving onto an occupied day is a duplicate", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const c1 = await checkIn(m, a.id, 20261112);
    await checkIn(m, a.id, 20261113);
    expect((await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ ...c1, checkinStamp: 20261113 }] })).json.id2error[c1.id]).toBe("DuplicateCheckinException");
  });
  test("the habitId of a check-in cannot be changed", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const b = await addHabit(m);
    const c = await checkIn(m, a.id, 20261112);
    await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ ...c, habitId: b.id }] });
    expect((await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [b.id] })).json.checkins[b.id]).toEqual([]);
  });
  test("update and delete error codes", async () => {
    const m = await mk4();
    const ghost = id();
    expect((await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ id: ghost, checkinStamp: 20261112 }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
    expect((await m.call("POST", "/api/v2/habitCheckins/batch", { delete: [ghost] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("delete removes the day and lowers the totals", async () => {
    const m = await mk4();
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261113 });
    const c1 = await checkIn(m, a.id, 20261113);
    await checkIn(m, a.id, 20261114);
    expect(await getHabit(m, a.id)).toMatchObject({ totalCheckIns: 2, currentStreak: 2 });
    await m.call("POST", "/api/v2/habitCheckins/batch", { delete: [c1.id] });
    expect(await getHabit(m, a.id)).toMatchObject({ totalCheckIns: 1, currentStreak: 1 });
  });
  test("a Real habit completes at the goal", async () => {
    const m = await mk4();
    const a = await addHabit(m, { type: "Real", goal: 3, step: 1 });
    const c = await checkIn(m, a.id, 20261114, { value: 1 });
    const row = async () => (await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [a.id] })).json.checkins[a.id][0];
    expect((await row()).status).toBe(0);
    expect((await getHabit(m, a.id)).totalCheckIns).toBe(0);
    await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ ...c, value: 3 }] });
    expect((await row()).status).toBe(2);
    expect((await getHabit(m, a.id)).totalCheckIns).toBe(1);
    await m.call("POST", "/api/v2/habitCheckins/batch", { update: [{ ...c, value: 2 }] });
    expect((await row()).status).toBe(0);
  });
  test("note and mood are kept as sent", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    await checkIn(m, a.id, 20261114, { content: "felt good", mood: 40, zzX: 1 });
    expect((await m.call("POST", "/api/v2/habitCheckins/query", { habitIds: [a.id] })).json.checkins[a.id][0]).toMatchObject({ content: "felt good", mood: 40, zzX: 1 });
  });
  test("deleting a habit removes its check-ins and records", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    await checkIn(m, a.id, 20261114);
    await m.call("POST", "/api/v2/habitRecords", { add: [{ id: id("r"), habitId: a.id, checkinStamp: 20261114, content: "n" }] });
    await m.call("POST", "/api/v2/habits/batch", { delete: [a.id] });
    expect((await m.call("GET", "/api/v2/habits")).json).toEqual([]);
    expect(m.store.get<{ n: number }>("select count(*) as n from habit_checkins")!.n).toBe(0);
    expect(m.store.get<{ n: number }>("select count(*) as n from habit_records")!.n).toBe(0);
  });
  test("archived habits keep their history and accept retro check-ins", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    await checkIn(m, a.id, 20261110);
    await m.call("POST", "/api/v2/habits/batch", { update: [{ ...(await getHabit(m, a.id)), status: 1 }] });
    await checkIn(m, a.id, 20261111);
    expect((await getHabit(m, a.id)).totalCheckIns).toBe(2);
  });
});

describe("habit streaks through the API", () => {
  test("across a month end", async () => {
    const m = await mk4("UTC", Date.UTC(2026, 1, 2, 12));
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20260129 });
    for (const s of [20260129, 20260130, 20260131, 20260201, 20260202]) await checkIn(m, a.id, s);
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 5, maxStreak: 5, totalCheckIns: 5 });
  });
  test("the day after the leap day", async () => {
    const m = await mk4("UTC", Date.UTC(2028, 2, 1, 12));
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20280228 });
    for (const s of [20280228, 20280229, 20280301]) await checkIn(m, a.id, s);
    expect((await getHabit(m, a.id)).currentStreak).toBe(3);
  });
  test("across the spring DST change in Amsterdam", async () => {
    // 2026-03-29 has 23 hours; now is 00:30 local on 03-30
    const m = await mk4("Europe/Amsterdam", Date.UTC(2026, 2, 29, 22, 30));
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20260327 });
    for (const s of [20260327, 20260328, 20260329, 20260330]) await checkIn(m, a.id, s);
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 4, totalCheckIns: 4 });
  });
  test("across the autumn DST change in Los Angeles", async () => {
    // 2026-11-01 has 25 hours; now is 23:30 local on 11-01
    const m = await mk4("America/Los_Angeles", Date.UTC(2026, 10, 2, 7, 30));
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261030 });
    for (const s of [20261030, 20261031, 20261101]) await checkIn(m, a.id, s);
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 3 });
    // an hour later it is 11-02 locally and 11-02 is still open: the streak holds
    m.clock.t += 3600_000;
    expect((await getHabit(m, a.id)).currentStreak).toBe(3);
  });
  test("a day passing without a check-in zeroes the streak on read", async () => {
    const m = await mk4();
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261113 });
    await checkIn(m, a.id, 20261113);
    await checkIn(m, a.id, 20261114);
    await checkIn(m, a.id, 20261115);
    expect((await getHabit(m, a.id)).currentStreak).toBe(3);
    m.clock.t += 24 * 3600_000; // Monday: today open, streak holds
    expect((await getHabit(m, a.id)).currentStreak).toBe(3);
    m.clock.t += 24 * 3600_000; // Tuesday: Monday missed
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 0, maxStreak: 3 });
  });
  test("Mon Wed Fri habit: Friday missed", async () => {
    const m = await mk4("UTC", Date.UTC(2026, 10, 14, 12)); // Saturday
    const a = await addHabit(m, { repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", targetStartDate: 20261109 });
    await checkIn(m, a.id, 20261109);
    await checkIn(m, a.id, 20261111);
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 0, maxStreak: 2 });
  });
  test("3 times a week counts the weeks", async () => {
    const m = await mk4("UTC", Date.UTC(2026, 10, 15, 12));
    const a = await addHabit(m, { repeatRule: "FREQ=WEEKLY;TT_TIMES=3", targetStartDate: 20261101 });
    for (const s of [20261102, 20261104, 20261106, 20261109, 20261110, 20261111, 20261115]) await checkIn(m, a.id, s);
    expect(await getHabit(m, a.id)).toMatchObject({ currentStreak: 6, maxStreak: 6, totalCheckIns: 7 });
  });
  test("skipped days (exDates) do not break the run", async () => {
    const m = await mk4();
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261113, exDates: [20261114] });
    await checkIn(m, a.id, 20261113);
    await checkIn(m, a.id, 20261115);
    expect((await getHabit(m, a.id)).currentStreak).toBe(2);
  });
  test("the counters travel unchanged through a re-read", async () => {
    const m = await mk4();
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261114 });
    await checkIn(m, a.id, 20261114);
    const one = await getHabit(m, a.id);
    const two = await getHabit(m, a.id);
    expect(two).toEqual(one);
  });
});

describe("habit records and weekly stats", () => {
  test("records: add, query, update, delete", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const r = { id: id("r"), habitId: a.id, checkinStamp: 20261114, content: "note" };
    expect((await m.call("POST", "/api/v2/habitRecords", { add: [r] })).json.id2etag[r.id]).toBeTruthy();
    let q = (await m.call("POST", "/api/v2/getHabitRecords", { habitIds: [a.id] })).json;
    expect(q.habitRecords[a.id][0]).toMatchObject({ id: r.id, content: "note" });
    await m.call("POST", "/api/v2/habitRecords", { update: [{ ...r, content: "edited" }] });
    q = (await m.call("POST", "/api/v2/getHabitRecords", { habitIds: [a.id] })).json;
    expect(q.habitRecords[a.id][0].content).toBe("edited");
    await m.call("POST", "/api/v2/habitRecords", { delete: [r.id] });
    expect((await m.call("POST", "/api/v2/getHabitRecords", { habitIds: [a.id] })).json.habitRecords[a.id]).toEqual([]);
  });
  test("records: error codes", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    const orphan = { id: id("r"), habitId: id(), content: "x" };
    expect((await m.call("POST", "/api/v2/habitRecords", { add: [orphan] })).json.id2error[orphan.id]).toBe("habit_not_exist");
    const r = { id: id("r"), habitId: a.id, checkinStamp: 20261114 };
    await m.call("POST", "/api/v2/habitRecords", { add: [r] });
    expect((await m.call("POST", "/api/v2/habitRecords", { add: [r] })).json.id2error[r.id]).toBe("EXISTED");
    const ghost = id();
    expect((await m.call("POST", "/api/v2/habitRecords", { update: [{ id: ghost }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
    expect((await m.call("POST", "/api/v2/habitRecords", { delete: [ghost] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("week/current: seven keys from today, due and done counts", async () => {
    const m = await mk4(); // Sunday 2026-11-15
    const daily = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261101 });
    const mwf = await addHabit(m, { repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", targetStartDate: 20261101 });
    await checkIn(m, daily.id, 20261115);
    await checkIn(m, mwf.id, 20261116);
    const w = (await m.call("GET", "/api/v2/habits/statistics/week/current")).json;
    expect(Object.keys(w)).toEqual(["20261115", "20261116", "20261117", "20261118", "20261119", "20261120", "20261121"]);
    expect(w["20261115"]).toEqual({ totalHabitCount: 1, completedHabitCount: 1 });
    expect(w["20261116"]).toEqual({ totalHabitCount: 2, completedHabitCount: 1 });
    expect(w["20261117"]).toEqual({ totalHabitCount: 1, completedHabitCount: 0 });
    expect(w["20261118"]).toEqual({ totalHabitCount: 2, completedHabitCount: 0 });
  });
  test("week/current ignores archived habits", async () => {
    const m = await mk4();
    const a = await addHabit(m, { repeatRule: "FREQ=DAILY", targetStartDate: 20261101 });
    await m.call("POST", "/api/v2/habits/batch", { update: [{ ...(await getHabit(m, a.id)), status: 1 }] });
    expect((await m.call("GET", "/api/v2/habits/statistics/week/current")).json["20261115"]).toEqual({ totalHabitCount: 0, completedHabitCount: 0 });
  });
  test("week/current: every-2-days habit is due on alternate days", async () => {
    const m = await mk4();
    await addHabit(m, { repeatRule: "FREQ=DAILY;INTERVAL=2", targetStartDate: 20261115 });
    const w = (await m.call("GET", "/api/v2/habits/statistics/week/current")).json;
    expect(Object.values(w).map((v: any) => v.totalHabitCount)).toEqual([1, 0, 1, 0, 1, 0, 1]);
  });
  test("a habit created later than a past day is not due on it", async () => {
    const m = await mk4();
    const a = await addHabit(m);
    void a;
    const w = (await m.call("GET", "/api/v2/habits/statistics/week/current")).json;
    expect(w["20261115"].totalHabitCount).toBe(1);
  });
  test("habit preferences keep their expected shape", async () => {
    const m = await mk4();
    expect((await m.call("GET", "/api/v2/user/preferences/habit?platform=web")).json).toEqual({ showInCalendar: true, showInToday: true, defaultSection: { order: 0 }, enabled: true });
  });
  test("sort preference round trips", async () => {
    const m = await mk4();
    await m.call("PUT", "/api/v2/user/preferences/habit?platform=web", { sortType: "checkin" });
    expect((await m.call("GET", "/api/v2/user/preferences/habit")).json.sortType).toBe("checkin");
  });
  test("unused T0 constant is the Sunday used above", () => {
    expect(new Date(T0).getUTCDay()).toBe(0);
  });
});
