import { describe, expect, test } from "vitest";
import {
  canonicalizeTriggers,
  computeTriggerInstant,
  parseTrigger,
  wallToInstant,
} from "../src/index.js";

describe("reminder triggers (RMD-002..006)", () => {
  test("parseTrigger handles START, END, negative, positive and rejects invalid", () => {
    expect(parseTrigger("TRIGGER:PT0S")).toMatchObject({ related: "START", negative: false, seconds: 0 });
    expect(parseTrigger("TRIGGER:-PT15M")).toMatchObject({ related: "START", negative: true, minutes: 15 });
    expect(parseTrigger("TRIGGER;RELATED=END:-PT5M")).toMatchObject({ related: "END", negative: true, minutes: 5 });
    expect(parseTrigger("TRIGGER;RELATED=START:-P1DT15H0M0S")).toMatchObject({
      related: "START", negative: true, days: 1, hours: 15, minutes: 0, seconds: 0,
    });
    expect(parseTrigger("TRIGGER:P")).toBeNull();
    expect(parseTrigger("TRIGGER:PT")).toBeNull();
    expect(parseTrigger("INVALID")).toBeNull();
  });

  test("canonicalizeTriggers normalizes timed offsets and removes duplicates", () => {
    expect(canonicalizeTriggers(["TRIGGER:-PT60M", "TRIGGER:-PT1H", "TRIGGER:PT0S", "TRIGGER:-P0D"], false)).toEqual([
      "TRIGGER:-PT60M",
      "TRIGGER:PT0S",
    ]);
    expect(canonicalizeTriggers(["TRIGGER:-PT1440M", "TRIGGER:-P1D"], false)).toEqual(["TRIGGER:-P1D"]);
    expect(canonicalizeTriggers(["TRIGGER:P0DT9H0M0S", "TRIGGER:P0DT9H0M0S"], true)).toEqual(["TRIGGER:P0DT9H0M0S"]);
  });

  test("timed triggers compute exact fire instants in task timezone", () => {
    // 2026-12-10 09:00 Asia/Tokyo = 2026-12-10T00:00:00.000Z
    const anchor = Date.UTC(2026, 11, 10, 0, 0, 0);
    expect(computeTriggerInstant(anchor, parseTrigger("TRIGGER:PT0S")!, "Asia/Tokyo", false)).toBe(anchor);
    expect(computeTriggerInstant(anchor, parseTrigger("TRIGGER:-PT15M")!, "Asia/Tokyo", false)).toBe(anchor - 15 * 60_000);
    expect(computeTriggerInstant(anchor, parseTrigger("TRIGGER;RELATED=END:-PT5M")!, "Asia/Tokyo", false)).toBe(anchor - 5 * 60_000);
    // -P1D keeps 09:00 local on the day before
    expect(computeTriggerInstant(anchor, parseTrigger("TRIGGER:-P1D")!, "Asia/Tokyo", false)).toBe(Date.UTC(2026, 11, 9, 0, 0, 0));
  });

  test("all-day triggers anchor to local midnight and wall-clock time", () => {
    // 2026-12-10 midnight in UTC
    const mid = Date.UTC(2026, 11, 10, 0, 0, 0);
    expect(computeTriggerInstant(mid, parseTrigger("TRIGGER:P0DT9H0M0S")!, "UTC", true)).toBe(Date.UTC(2026, 11, 10, 9, 0, 0));
    expect(computeTriggerInstant(mid, parseTrigger("TRIGGER:-P0DT15H0M0S")!, "UTC", true)).toBe(Date.UTC(2026, 11, 9, 9, 0, 0));
    expect(computeTriggerInstant(mid, parseTrigger("TRIGGER:-P1DT15H0M0S")!, "UTC", true)).toBe(Date.UTC(2026, 11, 8, 9, 0, 0));
  });

  test("DST transitions preserve local wall clock for calendar offsets and elapsed ms for timed offsets", () => {
    // Europe/Amsterdam springs forward on 2026-03-29 at 02:00 CET (+1) -> 03:00 CEST (+2)
    const springDayMid = wallToInstant(2026, 3, 29, 0, 0, 0, "Europe/Amsterdam");
    expect(springDayMid).toBe(Date.UTC(2026, 2, 28, 23, 0, 0));
    // All-day 09:00 on spring-forward day is 09:00 CEST = 07:00 UTC (9 real hours? No, 8 real hours after 23:00Z!)
    expect(computeTriggerInstant(springDayMid, parseTrigger("TRIGGER:P0DT9H0M0S")!, "Europe/Amsterdam", true)).toBe(
      Date.UTC(2026, 2, 29, 7, 0, 0),
    );
    // Timed 03:15 CEST (01:15Z) minus 30 minutes = 00:45Z (01:45 CET)
    const afterGap = wallToInstant(2026, 3, 29, 3, 15, 0, "Europe/Amsterdam");
    expect(afterGap).toBe(Date.UTC(2026, 2, 29, 1, 15, 0));
    expect(computeTriggerInstant(afterGap, parseTrigger("TRIGGER:-PT30M")!, "Europe/Amsterdam", false)).toBe(
      Date.UTC(2026, 2, 29, 0, 45, 0),
    );
    // Timed 10:00 CEST on 2026-03-29 minus 1 day = 10:00 CET on 2026-03-28 (09:00Z)
    const tenAmSpring = wallToInstant(2026, 3, 29, 10, 0, 0, "Europe/Amsterdam");
    expect(computeTriggerInstant(tenAmSpring, parseTrigger("TRIGGER:-P1D")!, "Europe/Amsterdam", false)).toBe(
      Date.UTC(2026, 2, 28, 9, 0, 0),
    );

    // Europe/Amsterdam falls back on 2026-10-25 at 03:00 CEST (+2) -> 02:00 CET (+1)
    const fallDayMid = wallToInstant(2026, 10, 25, 0, 0, 0, "Europe/Amsterdam");
    expect(fallDayMid).toBe(Date.UTC(2026, 9, 24, 22, 0, 0));
    // All-day 09:00 on fall-back day is 09:00 CET = 08:00 UTC
    expect(computeTriggerInstant(fallDayMid, parseTrigger("TRIGGER:P0DT9H0M0S")!, "Europe/Amsterdam", true)).toBe(
      Date.UTC(2026, 9, 25, 8, 0, 0),
    );
  });
});
