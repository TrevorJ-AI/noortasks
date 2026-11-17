import { describe, expect, test } from "vitest";
import { id, mk4 } from "./m4helpers.js";

const cd = (over: Record<string, unknown> = {}): any => ({ id: id("d"), name: "Trip", date: "2026-12-24T00:00:00.000+0000", ...over });

describe("countdown", () => {
  test("list is empty on a fresh account", async () => {
    expect((await (await mk4()).call("GET", "/api/v2/countdown/list")).json).toEqual([]);
  });
  test("add fills the defaults and returns an etag", async () => {
    const m = await mk4();
    const c = cd();
    const r = await m.call("POST", "/api/v2/countdown/batch", { add: [c] });
    expect(r.json.id2etag[c.id]).toBeTruthy();
    expect((await m.call("GET", "/api/v2/countdown/list")).json[0]).toMatchObject({ id: c.id, type: 4, status: 0, timerMode: 0, daysOption: 0, dateDisplayFormat: "day", style: "normal", reminders: ["TRIGGER:P0DT9H0M0S", "TRIGGER:-P2DT15H0M0S"] });
  });
  test("type values holiday 1, birthday 2, anniversary 3, countdown 4 are kept", async () => {
    const m = await mk4();
    const add = [1, 2, 3, 4].map((type) => cd({ type }));
    await m.call("POST", "/api/v2/countdown/batch", { add });
    expect((await m.call("GET", "/api/v2/countdown/list")).json.map((c: any) => c.type)).toEqual([1, 2, 3, 4]);
  });
  test("direction, day mode, unit, age and repeat fields are kept as sent", async () => {
    const m = await mk4();
    const c = cd({ timerMode: 1, daysOption: 1, dateDisplayFormat: "week", showAge: true, ignoreYear: true, repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=2", remark: "<p>note</p>", showRemark: true, zzFuture: [1] });
    await m.call("POST", "/api/v2/countdown/batch", { add: [c] });
    expect((await m.call("GET", "/api/v2/countdown/list")).json[0]).toMatchObject({ timerMode: 1, daysOption: 1, dateDisplayFormat: "week", showAge: true, ignoreYear: true, repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=2", remark: "<p>note</p>", showRemark: true, zzFuture: [1] });
  });
  test("error codes", async () => {
    const m = await mk4();
    const c = cd();
    await m.call("POST", "/api/v2/countdown/batch", { add: [c] });
    expect((await m.call("POST", "/api/v2/countdown/batch", { add: [c] })).json.id2error[c.id]).toBe("EXISTED");
    const ghost = id();
    expect((await m.call("POST", "/api/v2/countdown/batch", { update: [{ id: ghost }] })).json.id2error[ghost]).toBe("NOT_EXISTED");
    expect((await m.call("POST", "/api/v2/countdown/batch", { delete: [ghost] })).json.id2error[ghost]).toBe("NOT_EXISTED");
  });
  test("update and delete", async () => {
    const m = await mk4();
    const c = cd();
    await m.call("POST", "/api/v2/countdown/batch", { add: [c] });
    const u = await m.call("POST", "/api/v2/countdown/batch", { update: [{ ...c, name: "Renamed" }] });
    expect(u.json.id2etag[c.id]).toBeTruthy();
    expect((await m.call("GET", "/api/v2/countdown/list")).json[0].name).toBe("Renamed");
    await m.call("POST", "/api/v2/countdown/batch", { delete: [c.id] });
    expect((await m.call("GET", "/api/v2/countdown/list")).json).toEqual([]);
  });
  test("archive sets archivedTime and keeps the countdown listed", async () => {
    const m = await mk4();
    const c = cd();
    await m.call("POST", "/api/v2/countdown/batch", { add: [c] });
    await m.call("POST", "/api/v2/countdown/batch", { update: [{ ...c, status: 1 }] });
    const got = (await m.call("GET", "/api/v2/countdown/list")).json[0];
    expect(got.status).toBe(1);
    expect(got.archivedTime).toBeTruthy();
    await m.call("POST", "/api/v2/countdown/batch", { update: [{ ...got, status: 0 }] });
    expect((await m.call("GET", "/api/v2/countdown/list")).json[0].archivedTime).toBeNull();
  });
  test("only one countdown holds the pin", async () => {
    const m = await mk4();
    const a = cd();
    const b = cd();
    await m.call("POST", "/api/v2/countdown/batch", { add: [a, b] });
    await m.call("POST", "/api/v2/countdown/batch", { update: [{ ...a, pinnedTime: "2026-11-15T10:00:00.000+0000" }] });
    await m.call("POST", "/api/v2/countdown/batch", { update: [{ ...a, pinnedTime: "2026-11-15T10:00:00.000+0000" }, { ...b, pinnedTime: "2026-11-15T11:00:00.000+0000" }] });
    const list = (await m.call("GET", "/api/v2/countdown/list")).json;
    expect(list.find((c: any) => c.id === a.id).pinnedTime).toBeNull();
    expect(list.find((c: any) => c.id === b.id).pinnedTime).toBe("2026-11-15T11:00:00.000+0000");
  });
  test("a client resending an unchanged pin does not steal the slot", async () => {
    const m = await mk4();
    const a = cd({ pinnedTime: "2026-11-15T09:00:00.000+0000" });
    const b = cd();
    await m.call("POST", "/api/v2/countdown/batch", { add: [a, b] });
    await m.call("POST", "/api/v2/countdown/batch", { update: [{ ...b, pinnedTime: "2026-11-15T12:00:00.000+0000" }, { ...a }] });
    const list = (await m.call("GET", "/api/v2/countdown/list")).json;
    expect(list.filter((c: any) => c.pinnedTime).map((c: any) => c.id)).toEqual([b.id]);
  });
  test("more than 5 countdowns are allowed", async () => {
    const m = await mk4();
    const add = Array.from({ length: 12 }, () => cd());
    expect(Object.keys((await m.call("POST", "/api/v2/countdown/batch", { add })).json.id2etag)).toHaveLength(12);
  });
  test("limits table lists countdownNumber and timerNumber as unlimited", async () => {
    const m = await mk4();
    const l = (await m.call("GET", "/api/v2/configs/limits")).json;
    for (const t of ["free", "pro", "team"]) {
      expect(l[t].countdownNumber).toBeGreaterThan(1e8);
      expect(l[t].habitNumber).toBeGreaterThan(1e8);
      expect(l[t].habitSectionNumber).toBeGreaterThan(1e8);
      expect(l[t].timerNumber).toBeGreaterThan(1e8);
      expect(l[t].habitLogWordLimit).toBeGreaterThan(1e8);
    }
  });
});
