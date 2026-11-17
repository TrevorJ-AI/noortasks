import { describe, expect, test } from "vitest";
import { PREFERENCE_KEYS } from "@noortasks/core";
import { mk } from "./helpers.js";

describe("user and settings", () => {
  test("status is always pro", async () => {
    const { call, svc } = mk();
    const s = (await call("GET", "/api/v2/user/status")).json;
    expect(s).toMatchObject({ pro: true, needSubscribe: false, freeTrial: false, inboxId: svc.inboxId });
    expect(s.timeStamp).toBeGreaterThan(1.7e12);
    expect(new Date(s.proEndDate).getFullYear()).toBeGreaterThan(2090);
  });
  test("profile has a default", async () => {
    expect((await mk().call("GET", "/api/v2/user/profile")).json.username).toBeTruthy();
  });
  test("settings default to the 51 known keys", async () => {
    const r = (await mk().call("GET", "/api/v2/user/preferences/settings?includeWeb=true")).json;
    expect(Object.keys(r).sort()).toEqual([...PREFERENCE_KEYS].sort());
  });
  test("settings PUT merges and keeps unknown keys", async () => {
    const { call } = mk();
    await call("PUT", "/api/v2/user/preferences/settings?includeWeb=true", { theme: "light", futureKey: [1] });
    const r = (await call("GET", "/api/v2/user/preferences/settings?includeWeb=true")).json;
    expect(r.theme).toBe("light");
    expect(r.futureKey).toEqual([1]);
    expect(r.locale).toBe("en_US");
  });
  test.each(["pomodoro", "habit", "dailyReminder", "featurePrompt", "ext", "pluginSettings", "apps"])("preferences/%s reads and writes", async (name) => {
    const { call } = mk();
    const url = `/api/v2/user/preferences/${name}`;
    const first = (await call("GET", url)).json;
    expect(first).toBeDefined();
    const payload = Array.isArray(first) ? [{ k: 1 }] : { zzProbe: 1 };
    await call("POST", url, payload);
    const after = (await call("GET", url)).json;
    if (Array.isArray(first)) expect(after).toEqual([{ k: 1 }]);
    else expect(after.zzProbe).toBe(1);
  });
  test("limits are unlimited for every tier", async () => {
    const r = (await mk().call("GET", "/api/v2/configs/limits")).json;
    for (const t of ["free", "pro", "team"]) {
      expect(r[t].projectNumber).toBeGreaterThan(1e8);
      expect(r[t].attachmentSize).toBeGreaterThan(2 ** 40);
      expect(r[t].taskAttachmentNumber).toBeGreaterThan(1e8);
    }
  });
  test.each([
    ["/api/v2/habits", []], ["/api/v2/habitSections", []], ["/api/v2/pomodoros/timeline?to=0", []], ["/api/v2/pomodoros/timing?from=0", []],
    ["/api/v2/calendar/subscription", []], ["/api/v2/column?from=0", {}], ["/api/v2/notification/unread", { notification: 0, activity: 0 }],
    ["/api/v2/pomodoro/record/0", { checkPoint: 0, pomodoroRecords: null }], ["/api/v2/user/mfa", false], ["/api/v2/chatmind/bind/check", false],
    ["/api/v1/attachment/isUnderQuota", true], ["/api/v2/statistics/color", { project2color: {}, tag2color: {} }],
    ["/api/v2/project/share/recentProjectUsers", []],
  ])("stub %s", async (url, body) => {
    const r = await mk().call("GET", url as string);
    expect(r.status).toBe(200);
    expect(r.json).toEqual(body);
  });
  test("templates and projectTemplates are seeded on a fresh account", async () => {
    const { call } = mk();
    const tpl = (await call("GET", "/api/v2/templates")).json;
    expect(tpl.taskTemplates).toHaveLength(3);
    expect(tpl.noteTemplates).toHaveLength(3);
    expect(tpl.merged).toBeNull();
    const pt = (await call("GET", "/api/v2/projectTemplates/all?timestamp=0")).json;
    expect(pt.projectTemplates.length).toBeGreaterThanOrEqual(3);
  });
  test("week/current has seven zero-filled day keys on an empty account", async () => {
    const r = (await mk().call("GET", "/api/v2/habits/statistics/week/current")).json;
    expect(Object.keys(r)).toHaveLength(7);
    for (const v of Object.values(r)) expect(v).toEqual({ totalHabitCount: 0, completedHabitCount: 0 });
  });
  test("statistics general and ranking have the right keys", async () => {
    const { call } = mk();
    expect(Object.keys((await call("GET", "/api/v2/statistics/general")).json)).toContain("totalCompleted");
    expect(Object.keys((await call("GET", "/api/v3/user/ranking")).json).sort()).toEqual(["completedCount", "dayCount", "level", "projectCount", "ranking", "score", "taskCount"]);
  });
  test("push register echoes a record", async () => {
    const r = (await mk().call("POST", "/api/v2/push/register", { pushToken: "x", osType: 3, hl: "en_US" })).json;
    expect(r).toMatchObject({ pushToken: "x", osType: 3, version: 1 });
  });
  test("unknown routes are 404 with the error shape", async () => {
    const r = await mk().call("GET", "/api/v2/nope");
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("not_found");
  });
  test("invalid JSON is 400", async () => {
    const m = mk();
    const r = await m.app.inject({ method: "POST", url: "/api/v2/batch/task", payload: "{bad", headers: { "content-type": "application/json" } });
    expect(r.statusCode).toBe(400);
  });
  test("empty JSON bodies are accepted on DELETE", async () => {
    const m = mk();
    const r = await m.app.inject({ method: "DELETE", url: "/api/v2/trash/cleanUp", headers: { "content-type": "application/json" } });
    expect(r.statusCode).toBe(200);
  });
  test("trailing slashes are tolerated", async () => {
    expect((await mk().call("GET", "/api/v2/project/all/completedInAll/?limit=5")).status).toBe(200);
  });
});
