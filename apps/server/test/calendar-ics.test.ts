import { describe, expect, test } from "vitest";
import ical, { type VEvent } from "node-ical";
import { TaskStatus, wallToInstant, zonedParts, type Loose, type Task } from "@noortasks/core";
import { weekendOnlyProvider } from "@noortasks/recurrence";
import {
  generateIcsFeed,
  isValidIcsDocument,
  parseAndExpandIcs,
  preprocessFloatingTimes,
} from "../src/calendar-ics.js";
import { findAll, findFirst, parseXml, textOf } from "../src/calendar-xml.js";

const utc = (y: number, m: number, d: number, h = 0, mi = 0, s = 0): number => Date.UTC(y, m - 1, d, h, mi, s);

describe("calendar ICS parser and recurrence expansion", () => {
  test("parses non-recurring UTC VEVENT inside window and excludes outside", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "X-WR-CALNAME:Team Sync",
      "BEGIN:VEVENT",
      "UID:ev-in",
      "DTSTART:20260510T140000Z",
      "DTEND:20260510T153000Z",
      "SUMMARY:Design Review",
      "LOCATION:Room 4B",
      "DESCRIPTION:Bring notes",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ev-out",
      "DTSTART:20260601T100000Z",
      "DTEND:20260601T110000Z",
      "SUMMARY:Next Month",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, {
      fromMs: utc(2026, 5, 1),
      toMs: utc(2026, 5, 31),
      userTz: "UTC",
      sourceId: "sub1",
    });
    expect(res.calendarName).toBe("Team Sync");
    expect(res.events).toHaveLength(1);
    expect(res.events[0]).toMatchObject({
      uid: "ev-in",
      title: "Design Review",
      location: "Room 4B",
      description: "Bring notes",
      startMs: utc(2026, 5, 10, 14, 0),
      endMs: utc(2026, 5, 10, 15, 30),
      isAllDay: false,
      isRecurring: false,
    });
  });

  test("handles zero-duration event without DTEND and DURATION property", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:zero-1",
      "DTSTART:20260512T000000Z",
      "SUMMARY:Midnight Ping",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:dur-1",
      "DTSTART:20260512T100000Z",
      "DURATION:PT1H30M",
      "SUMMARY:Workshop",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, {
      fromMs: utc(2026, 5, 12, 0, 0),
      toMs: utc(2026, 5, 13, 0, 0),
      userTz: "UTC",
      sourceId: "s",
    });
    expect(res.events).toHaveLength(2);
    expect(res.events[0]).toMatchObject({ uid: "zero-1", startMs: utc(2026, 5, 12, 0, 0), endMs: utc(2026, 5, 12, 0, 0) });
    expect(res.events[1]).toMatchObject({ uid: "dur-1", startMs: utc(2026, 5, 12, 10, 0), endMs: utc(2026, 5, 12, 11, 30) });
  });

  test("excludes standalone VEVENT with STATUS:CANCELLED", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:c1",
      "DTSTART:20260510T090000Z",
      "DTEND:20260510T100000Z",
      "SUMMARY:Cancelled Call",
      "STATUS:CANCELLED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ok1",
      "DTSTART:20260510T110000Z",
      "DTEND:20260510T120000Z",
      "SUMMARY:Active Call",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 31), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => e.uid)).toEqual(["ok1"]);
  });

  test("expands all-day single-day and multi-day events in user timezone without boundary leaks", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ad-before",
      "DTSTART;VALUE=DATE:20260430",
      "DTEND;VALUE=DATE:20260501",
      "SUMMARY:April Last Day",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ad-single",
      "DTSTART;VALUE=DATE:20260501",
      "DTEND;VALUE=DATE:20260502",
      "SUMMARY:May Day",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ad-multi",
      "DTSTART;VALUE=DATE:20260503",
      "DTEND;VALUE=DATE:20260506",
      "SUMMARY:Offsite",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    // America/New_York is UTC-4 in May: May 1 starts 04:00Z
    const res = parseAndExpandIcs(ics, {
      fromMs: utc(2026, 5, 1, 4, 0),
      toMs: utc(2026, 5, 4, 4, 0),
      userTz: "America/New_York",
      sourceId: "s",
    });
    expect(res.events.map((e) => e.uid)).toEqual(["ad-single", "ad-multi"]);
    expect(res.events[0]).toMatchObject({
      isAllDay: true,
      startMs: utc(2026, 5, 1, 4, 0),
      endMs: utc(2026, 5, 2, 4, 0),
    });
    expect(res.events[1]).toMatchObject({
      isAllDay: true,
      startMs: utc(2026, 5, 3, 4, 0),
      endMs: utc(2026, 5, 6, 4, 0),
    });
  });

  test("expands all-day event without DTEND as 1 full day", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ad-nodtend",
      "DTSTART;VALUE=DATE:20260515",
      "SUMMARY:Single Day",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 15), toMs: utc(2026, 5, 16), userTz: "UTC", sourceId: "s" });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.endMs - res.events[0]!.startMs).toBe(86_400_000);
  });

  test("expands recurring all-day event in Asia/Tokyo across date line", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:tokyo-ad",
      "DTSTART;VALUE=DATE:20260501",
      "DTEND;VALUE=DATE:20260502",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Golden Week",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    // May 2 in Tokyo is May 1 15:00Z .. May 2 15:00Z
    const res = parseAndExpandIcs(ics, {
      fromMs: utc(2026, 5, 1, 15, 0),
      toMs: utc(2026, 5, 2, 15, 0),
      userTz: "Asia/Tokyo",
      sourceId: "s",
    });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.startMs).toBe(utc(2026, 5, 1, 15, 0));
    expect(res.events[0]!.endMs).toBe(utc(2026, 5, 2, 15, 0));
  });

  test("preserves local wall clock across spring-forward DST (America/New_York 2026-03-08)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:dst-spring",
      "DTSTART;TZID=America/New_York:20260307T090000",
      "DTEND;TZID=America/New_York:20260307T100000",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, {
      fromMs: utc(2026, 3, 7),
      toMs: utc(2026, 3, 10),
      userTz: "UTC",
      sourceId: "s",
    });
    expect(res.events.map((e) => e.startMs)).toEqual([
      utc(2026, 3, 7, 14, 0), // EST (UTC-5)
      utc(2026, 3, 8, 13, 0), // EDT (UTC-4)
      utc(2026, 3, 9, 13, 0), // EDT (UTC-4)
    ]);
  });

  test("preserves local wall clock across fall-back DST (America/New_York 2026-11-01)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:dst-fall",
      "DTSTART;TZID=America/New_York:20261031T090000",
      "DTEND;TZID=America/New_York:20261031T100000",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Morning Sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, {
      fromMs: utc(2026, 10, 31),
      toMs: utc(2026, 11, 3),
      userTz: "UTC",
      sourceId: "s",
    });
    expect(res.events.map((e) => e.startMs)).toEqual([
      utc(2026, 10, 31, 13, 0), // EDT (UTC-4)
      utc(2026, 11, 1, 14, 0), // EST (UTC-5)
      utc(2026, 11, 2, 14, 0), // EST (UTC-5)
    ]);
  });

  test("handles nonexistent spring-forward gap hour (02:30 on 2026-03-08 America/New_York) for single and RRULE events", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:gap-single",
      "DTSTART;TZID=America/New_York:20260308T023000",
      "DTEND;TZID=America/New_York:20260308T030000",
      "SUMMARY:Single Gap",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:gap-rrule",
      "DTSTART;TZID=America/New_York:20260307T023000",
      "DTEND;TZID=America/New_York:20260307T030000",
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:Recurring Gap",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 3, 7), toMs: utc(2026, 3, 10), userTz: "UTC", sourceId: "s" });
    const single = res.events.filter((e) => e.uid === "gap-single");
    const rec = res.events.filter((e) => e.uid === "gap-rrule");
    // Single nonexistent 02:30 disambiguates forward to 03:30 EDT = 07:30Z
    expect(single.map((e) => e.startMs)).toEqual([utc(2026, 3, 8, 7, 30)]);
    // Per RFC 5545, RRULE skips nonexistent local wall time on 2026-03-08 and emits 2026-03-07 + 2026-03-09
    expect(rec.map((e) => e.startMs)).toEqual([utc(2026, 3, 7, 7, 30), utc(2026, 3, 9, 6, 30)]);
  });

  test("handles ambiguous fall-back hour (01:30 on 2026-11-01 America/New_York)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:fold-1",
      "DTSTART;TZID=America/New_York:20261101T013000",
      "DTEND;TZID=America/New_York:20261101T020000",
      "SUMMARY:Early Check",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 11, 1), toMs: utc(2026, 11, 2), userTz: "UTC", sourceId: "s" });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.startMs).toBe(utc(2026, 11, 1, 5, 30)); // earlier EDT instant
  });

  test("resolves custom VTIMEZONE block and Windows TZID alias", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:W. Europe Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16011028T030000",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0100",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:16010325T020000",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
      "TZOFFSETFROM:+0100",
      "TZOFFSETTO:+0200",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:win-tz",
      'DTSTART;TZID="W. Europe Standard Time":20260328T100000',
      'DTEND;TZID="W. Europe Standard Time":20260328T110000',
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:Amsterdam Crossing",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 3, 28), toMs: utc(2026, 3, 30), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => e.startMs)).toEqual([
      utc(2026, 3, 28, 9, 0), // CET (+01:00)
      utc(2026, 3, 29, 8, 0), // CEST (+02:00)
    ]);
  });

  test("resolves Microsoft Customized Time Zone VTIMEZONE", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Customized Time Zone",
      "BEGIN:STANDARD",
      "DTSTART:16010101T000000",
      "TZOFFSETFROM:+0530",
      "TZOFFSETTO:+0530",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:cust-tz",
      "DTSTART;TZID=Customized Time Zone:20260601T103000",
      "DTEND;TZID=Customized Time Zone:20260601T113000",
      "SUMMARY:India Call",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 6, 1), toMs: utc(2026, 6, 2), userTz: "UTC", sourceId: "s" });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.startMs).toBe(utc(2026, 6, 1, 5, 0));
  });

  test("excludes single, comma-separated, and date-only EXDATEs from recurring events", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ex-timed",
      "DTSTART;TZID=Europe/Amsterdam:20260501T090000",
      "DTEND;TZID=Europe/Amsterdam:20260501T100000",
      "RRULE:FREQ=DAILY;COUNT=5",
      "EXDATE;TZID=Europe/Amsterdam:20260502T090000,20260504T090000",
      "SUMMARY:Daily",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ex-allday",
      "DTSTART;VALUE=DATE:20260510",
      "DTEND;VALUE=DATE:20260511",
      "RRULE:FREQ=DAILY;COUNT=3",
      "EXDATE;VALUE=DATE:20260511",
      "SUMMARY:AllDay",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 15), userTz: "UTC", sourceId: "s" });
    const timed = res.events.filter((e) => e.uid === "ex-timed");
    const allday = res.events.filter((e) => e.uid === "ex-allday");
    expect(timed.map((e) => new Date(e.startMs).getUTCDate())).toEqual([1, 3, 5]);
    expect(allday.map((e) => new Date(e.startMs).getUTCDate())).toEqual([10, 12]);
  });

  test("applies RECURRENCE-ID override changing title and time", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ov-1",
      "DTSTART:20260501T100000Z",
      "DTEND:20260501T110000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Regular Sync",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ov-1",
      "RECURRENCE-ID:20260502T100000Z",
      "DTSTART:20260502T150000Z",
      "DTEND:20260502T163000Z",
      "SUMMARY:Moved Sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 4), userTz: "UTC", sourceId: "s" });
    expect(res.events).toHaveLength(3);
    expect(res.events[1]).toMatchObject({
      title: "Moved Sync",
      startMs: utc(2026, 5, 2, 15, 0),
      endMs: utc(2026, 5, 2, 16, 30),
      isOverride: true,
    });
  });

  test("includes RECURRENCE-ID override moved from outside window into window and excludes moved out", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ov-move",
      "DTSTART:20260501T100000Z",
      "DTEND:20260501T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=4",
      "SUMMARY:Weekly",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ov-move",
      "RECURRENCE-ID:20260501T100000Z",
      "DTSTART:20260512T100000Z",
      "DTEND:20260512T110000Z",
      "SUMMARY:May 1 moved into May 10-14",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ov-move",
      "RECURRENCE-ID:20260508T100000Z",
      "DTSTART:20260525T100000Z",
      "DTEND:20260525T110000Z",
      "SUMMARY:May 8 moved out",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 8), toMs: utc(2026, 5, 14), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => e.title)).toEqual(["May 1 moved into May 10-14"]);
  });

  test("suppresses cancelled RECURRENCE-ID instance (STATUS:CANCELLED)", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ov-cancel",
      "DTSTART:20260501T100000Z",
      "DTEND:20260501T110000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "SUMMARY:Class",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ov-cancel",
      "RECURRENCE-ID:20260502T100000Z",
      "DTSTART:20260502T100000Z",
      "DTEND:20260502T110000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Class",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 4), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => new Date(e.startMs).getUTCDate())).toEqual([1, 3]);
  });

  test("handles override appearing before base VEVENT and respects higher SEQUENCE", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ord-1",
      "SEQUENCE:2",
      "RECURRENCE-ID:20260502T100000Z",
      "DTSTART:20260502T140000Z",
      "DTEND:20260502T150000Z",
      "SUMMARY:Updated Slot",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ord-1",
      "SEQUENCE:1",
      "RECURRENCE-ID:20260502T100000Z",
      "DTSTART:20260502T120000Z",
      "DTEND:20260502T130000Z",
      "SUMMARY:Stale Slot",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ord-1",
      "DTSTART:20260501T100000Z",
      "DTEND:20260501T110000Z",
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:Base",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 3), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => [e.title, e.startMs])).toEqual([
      ["Base", utc(2026, 5, 1, 10, 0)],
      ["Updated Slot", utc(2026, 5, 2, 14, 0)],
    ]);
  });

  test("interprets floating DATE-TIME and floating RRULE UNTIL in userTz across DST", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:float-1",
      "DTSTART:20260307T090000",
      "DTEND:20260307T100000",
      "RRULE:FREQ=DAILY;UNTIL=20260309T090000",
      "SUMMARY:Floating Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const ny = parseAndExpandIcs(ics, { fromMs: utc(2026, 3, 7), toMs: utc(2026, 3, 10), userTz: "America/New_York", sourceId: "s" });
    expect(ny.events.map((e) => e.startMs)).toEqual([
      utc(2026, 3, 7, 14, 0),
      utc(2026, 3, 8, 13, 0),
      utc(2026, 3, 9, 13, 0),
    ]);

    const tokyo = parseAndExpandIcs(ics, { fromMs: utc(2026, 3, 6), toMs: utc(2026, 3, 10), userTz: "Asia/Tokyo", sourceId: "s" });
    expect(tokyo.events.map((e) => e.startMs)).toEqual([
      utc(2026, 3, 7, 0, 0),
      utc(2026, 3, 8, 0, 0),
      utc(2026, 3, 9, 0, 0),
    ]);
  });

  test("floating preprocessor does not alter Z, TZID, or VALUE=DATE lines", () => {
    const raw = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "DTSTART:20260501T090000Z",
      "DTSTART;TZID=Europe/Paris:20260501T090000",
      "DTSTART;VALUE=DATE:20260501",
      "DTSTART:20260501T090000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const out = preprocessFloatingTimes(raw, "America/Chicago");
    expect(out).toContain("DTSTART:20260501T090000Z");
    expect(out).toContain("DTSTART;TZID=Europe/Paris:20260501T090000");
    expect(out).toContain("DTSTART;VALUE=DATE:20260501");
    expect(out).toContain("DTSTART;TZID=America/Chicago:20260501T090000");
  });

  test("handles folded multi-byte UTF-8 lines, escaped text, and PARTSTAT extraction", () => {
    const longDesc = "Plan \\, build\\; test\\n" + "🎉".repeat(30);
    const rawLine = `DESCRIPTION:${longDesc}`;
    const folded = rawLine.slice(0, 40) + "\r\n " + rawLine.slice(40);
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:fold-utf8",
      "DTSTART:20260510T100000Z",
      "DTEND:20260510T110000Z",
      "SUMMARY:Launch\\, Phase 1",
      folded,
      "ATTENDEE;PARTSTAT=DECLINED;CN=Trevor:mailto:t@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 31), userTz: "UTC", sourceId: "s" });
    expect(res.events).toHaveLength(1);
    expect(res.events[0]!.title).toBe("Launch, Phase 1");
    expect(res.events[0]!.description).toContain("🎉".repeat(30));
    expect(res.events[0]!.partStat).toBe("declined");
  });

  test("includes ongoing multi-day event starting before window and skips non-overlapping boundary", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:ongoing",
      "DTSTART:20260501T120000Z",
      "DTEND:20260505T120000Z",
      "SUMMARY:Conference",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:edge-before",
      "DTSTART:20260502T090000Z",
      "DTEND:20260503T000000Z",
      "SUMMARY:Ends At From",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:edge-after",
      "DTSTART:20260504T000000Z",
      "DTEND:20260504T010000Z",
      "SUMMARY:Starts At To",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 3), toMs: utc(2026, 5, 4), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => e.uid)).toEqual(["ongoing"]);
  });

  test("validates ICS documents and rejects HTML or malformed payloads", () => {
    expect(isValidIcsDocument("<html><body>404</body></html>")).toBe(false);
    expect(isValidIcsDocument("")).toBe(false);
    expect(isValidIcsDocument("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR")).toBe(true);
  });

  test("rejects excessive FREQ=SECONDLY rules before synchronous expansion", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:runaway",
      "DTSTART:20260501T000000Z",
      "DTEND:20260501T000010Z",
      "RRULE:FREQ=SECONDLY",
      "SUMMARY:Too Fast",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:normal",
      "DTSTART:20260505T100000Z",
      "DTEND:20260505T110000Z",
      "SUMMARY:Safe Event",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    expect(() => parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 10), userTz: "UTC", sourceId: "s" })).toThrow("calendar_too_complex");
  });
});

describe("outgoing ICS feed generation and round-trip re-parse validation", () => {
  const mkTask = (over: Partial<Task>): Task => ({
    id: "t1",
    projectId: "inbox1",
    title: "Task",
    status: TaskStatus.Open,
    priority: 0,
    sortOrder: 0,
    ...over,
  });

  test("generates valid RFC 5545 feed for timed, single all-day, and multi-day tasks and re-parses identically", () => {
    const tasks: Task[] = [
      mkTask({
        id: "timed1",
        title: "Dentist; Checkup, Yearly",
        content: "Bring card\nArrive 10m early",
        priority: 5,
        tags: ["health", "errand"],
        startDate: "2026-05-10T14:00:00.000+0000",
        dueDate: "2026-05-10T15:00:00.000+0000",
        isAllDay: false,
        items: [{ id: "i1", title: "Brush", status: 1, sortOrder: 0 }, { id: "i2", title: "ID", status: 0, sortOrder: 1 }],
      }),
      mkTask({
        id: "ad1",
        title: "Pay Rent",
        startDate: "2026-05-12T00:00:00.000+0000",
        dueDate: "2026-05-12T00:00:00.000+0000",
        isAllDay: true,
      }),
      mkTask({
        id: "ad-multi",
        title: "Trip",
        startDate: "2026-05-14T00:00:00.000+0000",
        dueDate: "2026-05-17T00:00:00.000+0000",
        isAllDay: true,
      }),
      mkTask({
        id: "nodate",
        title: "Backlog",
      }),
    ];

    const ics = generateIcsFeed({
      calName: "NoorTasks",
      timeZone: "UTC",
      tasks,
      includeHabits: false,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "SU",
    });

    // Verify CRLF line endings & 75-octet fold rule
    expect(ics).toContain("\r\n");
    for (const line of ics.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }

    // Re-parse with node-ical directly and with our expander
    const rawParsed = ical.sync.parseICS(ics);
    expect(rawParsed.vcalendar?.["WR-CALNAME"]).toBe("NoorTasks");

    const expanded = parseAndExpandIcs(ics, {
      fromMs: utc(2026, 5, 1),
      toMs: utc(2026, 5, 31),
      userTz: "UTC",
      sourceId: "feed",
    });
    expect(expanded.events).toHaveLength(3);
    expect(expanded.events[0]).toMatchObject({
      uid: "timed1@noortasks",
      title: "Dentist; Checkup, Yearly",
      startMs: utc(2026, 5, 10, 14, 0),
      endMs: utc(2026, 5, 10, 15, 0),
      isAllDay: false,
    });
    expect(expanded.events[0]!.description).toContain("[x] Brush");
    expect(expanded.events[0]!.description).toContain("[ ] ID");
    expect(expanded.events[1]).toMatchObject({
      uid: "ad1@noortasks",
      isAllDay: true,
      startMs: utc(2026, 5, 12),
      endMs: utc(2026, 5, 13),
    });
    expect(expanded.events[2]).toMatchObject({
      uid: "ad-multi@noortasks",
      isAllDay: true,
      startMs: utc(2026, 5, 14),
      endMs: utc(2026, 5, 17),
    });
  });

  test("preserves standard RRULE + EXDATE and expands TT_SKIP rules cleanly on re-parse", () => {
    const tasks: Task[] = [
      mkTask({
        id: "rec-std",
        title: "Weekly Review",
        startDate: "2026-05-01T16:00:00.000+0000",
        dueDate: "2026-05-01T17:00:00.000+0000",
        isAllDay: false,
        timeZone: "Europe/Amsterdam",
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=4",
        exDate: ["20260502"],
      }),
      mkTask({
        id: "rec-skip",
        title: "Workday Check",
        startDate: "2026-05-01T00:00:00.000+0000",
        isAllDay: true,
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=WEEKEND",
      }),
    ];

    const ics = generateIcsFeed({
      calName: "NoorTasks",
      timeZone: "Europe/Amsterdam",
      tasks,
      includeHabits: false,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "MO",
    });

    const expanded = parseAndExpandIcs(ics, {
      fromMs: wallToInstant(2026, 5, 1, 0, 0, 0, "Europe/Amsterdam"),
      toMs: wallToInstant(2026, 5, 6, 0, 0, 0, "Europe/Amsterdam"),
      userTz: "Europe/Amsterdam",
      sourceId: "feed",
    });
    const stdOccs = expanded.events.filter((e) => e.title === "Weekly Review");
    const skipOccs = expanded.events.filter((e) => e.title === "Workday Check");
    expect(stdOccs.map((e) => zonedParts(e.startMs, "Europe/Amsterdam").d)).toEqual([1, 3, 4]);
    // May 1 (Fri), May 4 (Mon), May 5 (Tue) — skips Sat May 2 & Sun May 3
    expect(skipOccs.map((e) => zonedParts(e.startMs, "Europe/Amsterdam").d)).toEqual([1, 4, 5]);
  });

  test("skips deleted and undated tasks while serializing explicit non-open tasks supplied by caller", () => {
    const tasks: Task[] = [
      mkTask({ id: "del", title: "Deleted", deleted: 1, startDate: "2026-05-10T00:00:00.000+0000", isAllDay: true }),
      mkTask({ id: "nodate", title: "NoDate" }),
      mkTask({ id: "wd", title: "WontDo", status: TaskStatus.WontDo, startDate: "2026-05-10T00:00:00.000+0000", isAllDay: true }),
    ];
    const out = generateIcsFeed({ calName: "N", timeZone: "UTC", tasks, includeHabits: false, holidays: weekendOnlyProvider, nowMs: utc(2026, 5, 1), weekStart: "SU" });
    const parsed = parseAndExpandIcs(out, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 31), userTz: "UTC", sourceId: "f" }).events;
    expect(parsed.map((e) => e.title)).toEqual(["WontDo"]);
  });

  test("timed task without dueDate defaults to 30 minutes duration in outgoing feed", () => {
    const ics = generateIcsFeed({
      calName: "N",
      timeZone: "UTC",
      tasks: [mkTask({ id: "td", title: "30m Default", startDate: "2026-05-10T10:00:00.000+0000", isAllDay: false })],
      includeHabits: false,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "SU",
    });
    const ev = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 31), userTz: "UTC", sourceId: "f" }).events[0]!;
    expect(ev.endMs - ev.startMs).toBe(30 * 60_000);
  });

  test("floating timed task shifts to userTz when generating outgoing ICS feed", () => {
    const ics = generateIcsFeed({
      calName: "N",
      timeZone: "America/New_York",
      tasks: [mkTask({ id: "flt", title: "Morning Alarm", startDate: "2026-05-10T08:00:00.000+0000", timeZone: "UTC", isFloating: true, isAllDay: false })],
      includeHabits: false,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "SU",
    });
    const ev = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 31), userTz: "America/New_York", sourceId: "f" }).events[0]!;
    expect(ev.startMs).toBe(utc(2026, 5, 10, 12, 0)); // 08:00 EDT = 12:00Z
  });

  test("expands ERULE repeating task into discrete VEVENTs in outgoing ICS feed", () => {
    const ics = generateIcsFeed({
      calName: "N",
      timeZone: "UTC",
      tasks: [mkTask({ id: "er1", title: "Custom ERULE", startDate: "2026-05-01T00:00:00.000+0000", isAllDay: true, repeatFlag: "ERULE:NAME=CUSTOM;BYDATE=20260501,20260504,20260505" })],
      includeHabits: false,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "MO",
    });
    const evs = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 6), userTz: "UTC", sourceId: "f" }).events;
    expect(evs.map((e) => new Date(e.startMs).getUTCDate())).toEqual([1, 4, 5]);
  });

  test("maps task priorities and tags into valid RFC 5545 PRIORITY and CATEGORIES", () => {
    const ics = generateIcsFeed({
      calName: "N",
      timeZone: "UTC",
      tasks: [
        mkTask({ id: "p5", title: "High", priority: 5, tags: ["urgent", "ops"], startDate: "2026-05-10T00:00:00.000+0000", isAllDay: true }),
        mkTask({ id: "p3", title: "Med", priority: 3, startDate: "2026-05-11T00:00:00.000+0000", isAllDay: true }),
        mkTask({ id: "p1", title: "Low", priority: 1, startDate: "2026-05-12T00:00:00.000+0000", isAllDay: true }),
      ],
      includeHabits: false,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "SU",
    });
    const raw = Object.values(ical.sync.parseICS(ics)).filter((v): v is VEvent => Boolean(v && v.type === "VEVENT"));
    expect(raw.find((e) => e.summary === "High")?.priority).toBe("1");
    expect(raw.find((e) => e.summary === "High")?.categories).toEqual(["urgent", "ops"]);
    expect(raw.find((e) => e.summary === "Med")?.priority).toBe("5");
    expect(raw.find((e) => e.summary === "Low")?.priority).toBe("9");
  });

  test("folds long UTF-8 emoji titles safely without corrupting surrogate pairs", () => {
    const longTitle = "🚀 Launch Check — " + "αβγδεζηθικλμνξοπρστυφχψω".repeat(3);
    const ics = generateIcsFeed({
      calName: "NoorTasks",
      timeZone: "UTC",
      tasks: [mkTask({ id: "u1", title: longTitle, startDate: "2026-05-10T00:00:00.000+0000", isAllDay: true })],
      includeHabits: false,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "SU",
    });
    for (const line of ics.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    const expanded = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 20), userTz: "UTC", sourceId: "f" });
    expect(expanded.events[0]!.title).toBe(longTitle);
  });

  test("includes scheduled habits (both timed reminder and all-day) when includeHabits is true", () => {
    const habits: Loose[] = [
      { id: "h1", name: "Meditate", status: 0, repeatRule: "FREQ=DAILY", targetStartDate: 20260501, reminders: ["07:30"], exDates: [20260502] },
      { id: "h2", name: "Read", status: 0, repeatRule: "FREQ=WEEKLY;BYDAY=MO,WE,FR", targetStartDate: 20260501, reminders: [] },
      { id: "h3", name: "Archived", status: 1, repeatRule: "FREQ=DAILY", targetStartDate: 20260501, reminders: [] },
    ];
    const ics = generateIcsFeed({
      calName: "NoorTasks",
      timeZone: "UTC",
      tasks: [],
      habits,
      includeHabits: true,
      holidays: weekendOnlyProvider,
      nowMs: utc(2026, 5, 1),
      weekStart: "SU",
    });
    const expanded = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 5), userTz: "UTC", sourceId: "f" });
    expect(expanded.events.some((e) => e.title === "Archived")).toBe(false);
    const med = expanded.events.filter((e) => e.title === "Meditate");
    expect(med.map((e) => new Date(e.startMs).getUTCDate())).toEqual([1, 3, 4]);
    expect(med[0]!.isAllDay).toBe(false);
    expect(med[0]!.startMs).toBe(utc(2026, 5, 1, 7, 30));
    const read = expanded.events.filter((e) => e.title === "Read");
    // May 1 Fri, May 4 Mon
    expect(read.map((e) => new Date(e.startMs).getUTCDate())).toEqual([1, 4]);
    expect(read[0]!.isAllDay).toBe(true);
  });
});

describe("CalDAV XML parser", () => {
  test("parses Multi-Status responses across arbitrary prefixes, CDATA, and entities", () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
      <!-- comment -->
      <d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
        <d:response>
          <d:href>/dav/user/cals/work/</d:href>
          <d:propstat>
            <d:prop>
              <d:displayname>Work &amp; Projects</d:displayname>
              <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
              <cal:calendar-data><![CDATA[BEGIN:VCALENDAR
BEGIN:VEVENT
UID:x1
SUMMARY:Test
END:VEVENT
END:VCALENDAR]]></cal:calendar-data>
            </d:prop>
            <d:status>HTTP/1.1 200 OK</d:status>
          </d:propstat>
        </d:response>
      </d:multistatus>`;

    const doc = parseXml(xml);
    const responses = findAll(doc, "response");
    expect(responses).toHaveLength(1);
    expect(textOf(findFirst(responses[0]!, "displayname"))).toBe("Work & Projects");
    expect(textOf(findFirst(responses[0]!, "calendar-data"))).toContain("UID:x1");
  });

  test("decodes numeric XML entities, ignores processing instructions, and reads attributes", () => {
    const xml = `<?xml version="1.0"?><?custom pi?>
      <multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <response><propstat><prop>
          <displayname>Team&#39;s &quot;Cal&quot;&#x21;</displayname>
          <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
        </prop></propstat></response>
      </multistatus>`;
    const doc = parseXml(xml);
    expect(textOf(findFirst(doc, "displayname"))).toBe(`Team's "Cal"!`);
    expect(findFirst(doc, "comp")?.attrs.name).toBe("VEVENT");
  });
});

describe("additional ICS parser edge cases", () => {
  test("expands BYDAY=MO,WE,FR across month boundary", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:mwf\r\nDTSTART:20260427T090000Z\r\nDTEND:20260427T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=5\r\nSUMMARY:MWF\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 4, 27), toMs: utc(2026, 5, 10), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => new Date(e.startMs).toISOString().slice(0, 10))).toEqual([
      "2026-04-27",
      "2026-04-29",
      "2026-05-01",
      "2026-05-04",
      "2026-05-06",
    ]);
  });

  test("expands BYMONTHDAY=-1 across leap Feb 2024 and non-leap Feb 2025", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:eom\r\nDTSTART;VALUE=DATE:20240131\r\nDTEND;VALUE=DATE:20240201\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3\r\nSUMMARY:EOM\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const res = parseAndExpandIcs(ics, { fromMs: utc(2024, 1, 1), toMs: utc(2024, 4, 5), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => new Date(e.startMs).toISOString().slice(0, 10))).toEqual(["2024-01-31", "2024-02-29", "2024-03-31"]);
  });

  test("handles RRULE UNTIL in Z on TZID series across DST", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u-dst\r\nDTSTART;TZID=America/New_York:20260307T090000\r\nDTEND;TZID=America/New_York:20260307T100000\r\nRRULE:FREQ=DAILY;UNTIL=20260309T130000Z\r\nSUMMARY:Until DST\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 3, 7), toMs: utc(2026, 3, 12), userTz: "UTC", sourceId: "s" });
    expect(res.events).toHaveLength(3);
  });

  test("handles EXDATE across spring-forward DST transition", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:ex-dst\r\nDTSTART;TZID=America/New_York:20260307T090000\r\nDTEND;TZID=America/New_York:20260307T100000\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;TZID=America/New_York:20260308T090000\r\nEXDATE;TZID=America/New_York:20260309T090000\r\nSUMMARY:Ex DST\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 3, 7), toMs: utc(2026, 3, 12), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => e.startMs)).toEqual([utc(2026, 3, 7, 14, 0), utc(2026, 3, 10, 13, 0)]);
  });

  test("handles RECURRENCE-ID with TZID and all-day VALUE=DATE override", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:tz-ov",
      "DTSTART;TZID=Europe/Amsterdam:20260501T100000",
      "DTEND;TZID=Europe/Amsterdam:20260501T110000",
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:Normal",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:tz-ov",
      "RECURRENCE-ID;TZID=Europe/Amsterdam:20260502T100000",
      "DTSTART;TZID=Europe/Amsterdam:20260502T120000",
      "DTEND;TZID=Europe/Amsterdam:20260502T130000",
      "SUMMARY:Overridden",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ad-ov",
      "DTSTART;VALUE=DATE:20260510",
      "DTEND;VALUE=DATE:20260511",
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:Base AD",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:ad-ov",
      "RECURRENCE-ID;VALUE=DATE:20260511",
      "DTSTART;VALUE=DATE:20260512",
      "DTEND;VALUE=DATE:20260513",
      "SUMMARY:Moved AD",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 15), userTz: "UTC", sourceId: "s" });
    expect(res.events.find((e) => e.title === "Overridden")?.startMs).toBe(utc(2026, 5, 2, 10, 0));
    expect(res.events.find((e) => e.title === "Moved AD")?.startMs).toBe(utc(2026, 5, 12));
  });

  test("handles orphan RECURRENCE-ID VEVENT without master VEVENT", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:orphan\r\nRECURRENCE-ID:20260510T090000Z\r\nDTSTART:20260510T110000Z\r\nDTEND:20260510T120000Z\r\nSUMMARY:Invite Instance\r\nEND:VEVENT\r\nEND:VCALENDAR";
    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 20), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => e.title)).toEqual(["Invite Instance"]);
  });

  test("handles LF line endings and sorts mixed events chronologically", () => {
    const ics = "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:b\nDTSTART:20260510T150000Z\nDTEND:20260510T160000Z\nSUMMARY:Later\nEND:VEVENT\nBEGIN:VEVENT\nUID:a\nDTSTART:20260510T090000Z\nDTEND:20260510T100000Z\nSUMMARY:Earlier\nEND:VEVENT\nEND:VCALENDAR";
    const res = parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 1), toMs: utc(2026, 5, 20), userTz: "UTC", sourceId: "s" });
    expect(res.events.map((e) => e.title)).toEqual(["Earlier", "Later"]);
  });

  test("point query fromMs === toMs matches enclosing event only", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:pt\r\nDTSTART:20260510T100000Z\r\nDTEND:20260510T110000Z\r\nSUMMARY:Active\r\nEND:VEVENT\r\nEND:VCALENDAR";
    expect(parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 10, 10, 30), toMs: utc(2026, 5, 10, 10, 30), userTz: "UTC", sourceId: "s" }).events).toHaveLength(1);
    expect(parseAndExpandIcs(ics, { fromMs: utc(2026, 5, 10, 11, 0), toMs: utc(2026, 5, 10, 11, 0), userTz: "UTC", sourceId: "s" }).events).toHaveLength(0);
  });

  test("isValidIcsDocument rejects missing END:VCALENDAR and non-string input", () => {
    expect(isValidIcsDocument("BEGIN:VCALENDAR\r\nVERSION:2.0")).toBe(false);
    expect(isValidIcsDocument(null as unknown as string)).toBe(false);
  });
});
