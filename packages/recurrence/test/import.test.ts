import { describe, expect, it } from "vitest";
import {
  convertMsTodoRecurrenceToRepeatFlag,
  convertRruleToRepeatFlag,
  convertTodoTxtRepeatToRepeatFlag,
  convertTodoistRepeatToRepeatFlag,
} from "../src/index";

describe("recurrence import conversions", () => {
  describe("RRULE / ICS", () => {
    it("normalizes standard RRULE strings", () => {
      expect(convertRruleToRepeatFlag("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2")).toEqual({
        repeatFlag: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2",
      });
      expect(convertRruleToRepeatFlag("rrule:freq=monthly;bymonthday=-1;count=6")).toEqual({
        repeatFlag: "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=6;INTERVAL=1",
      });
    });

    it("rejects unsupported frequencies, sub-day rules, BYEASTER, and malformed rules", () => {
      expect(convertRruleToRepeatFlag("FREQ=HOURLY;INTERVAL=2").lostReason).toMatch(/HOURLY/);
      expect(convertRruleToRepeatFlag("FREQ=DAILY;BYHOUR=9").lostReason).toMatch(/BYHOUR/);
      expect(convertRruleToRepeatFlag("FREQ=YEARLY;BYEASTER=0").lostReason).toMatch(/BYEASTER/);
      expect(convertRruleToRepeatFlag("NOT_A_RULE").lostReason).toBeTruthy();
    });
  });

  describe("todo.txt rec:", () => {
    it("converts relative and strict rec tokens", () => {
      expect(convertTodoTxtRepeatToRepeatFlag("1d")).toEqual({
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        repeatFrom: "1",
      });
      expect(convertTodoTxtRepeatToRepeatFlag("+2w")).toEqual({
        repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=2",
        repeatFrom: "0",
      });
      expect(convertTodoTxtRepeatToRepeatFlag("rec:3m")).toEqual({
        repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=3",
        repeatFrom: "1",
      });
      expect(convertTodoTxtRepeatToRepeatFlag("1b")).toEqual({
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND",
        repeatFrom: "1",
      });
    });

    it("reports unsupported rec tokens", () => {
      expect(convertTodoTxtRepeatToRepeatFlag("2b").lostReason).toBeTruthy();
      expect(convertTodoTxtRepeatToRepeatFlag("custom").lostReason).toBeTruthy();
    });
  });

  describe("Microsoft To Do PatternedRecurrence", () => {
    it("converts daily, weekly, relativeMonthly, and numbered/endDate ranges", () => {
      expect(
        convertMsTodoRecurrenceToRepeatFlag({
          pattern: { type: "weekly", interval: 2, daysOfWeek: ["monday", "friday"], firstDayOfWeek: "monday" },
          range: { type: "endDate", startDate: "2026-11-20", endDate: "2027-01-31" },
        }),
      ).toEqual({
        repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;WKST=MO;UNTIL=20270131",
        repeatFrom: "2",
        startDateIso: "2026-11-20",
      });

      expect(
        convertMsTodoRecurrenceToRepeatFlag({
          pattern: { type: "relativeMonthly", interval: 1, daysOfWeek: ["tuesday"], index: "second" },
          range: { type: "numbered", numberOfOccurrences: 5 },
        }),
      ).toEqual({
        repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU;COUNT=5",
        repeatFrom: "2",
      });

      expect(
        convertMsTodoRecurrenceToRepeatFlag({
          pattern: { type: "absoluteYearly", interval: 1, month: 3, dayOfMonth: 15 },
          range: { type: "noEnd" },
        }),
      ).toEqual({
        repeatFlag: "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=15",
        repeatFrom: "2",
      });
    });

    it("reports unsupported pattern types", () => {
      expect(convertMsTodoRecurrenceToRepeatFlag({ pattern: { type: "lunarCustom" } }).lostReason).toBeTruthy();
    });
  });

  describe("Todoist / natural language expressions", () => {
    it("converts every, every!, weekdays, monthly ordinals, yearly dates, times, starting, and end bounds", () => {
      expect(convertTodoistRepeatToRepeatFlag("every day")).toEqual({
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        repeatFrom: "2",
      });
      expect(convertTodoistRepeatToRepeatFlag("every! 3 days")).toEqual({
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=3",
        repeatFrom: "1",
      });
      expect(convertTodoistRepeatToRepeatFlag("every 2 weeks on mon, wed at 9:30am")).toEqual({
        repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
        repeatFrom: "2",
        time: { hour: 9, minute: 30 },
      });
      expect(convertTodoistRepeatToRepeatFlag("every 2nd Tuesday")).toEqual({
        repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2TU",
        repeatFrom: "2",
      });
      expect(convertTodoistRepeatToRepeatFlag("every last day of the month")).toEqual({
        repeatFlag: "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1",
        repeatFrom: "2",
      });
      expect(convertTodoistRepeatToRepeatFlag("every year on March 4 until 2027-12-31")).toEqual({
        repeatFlag: "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=4;UNTIL=20271231",
        repeatFrom: "2",
      });
      expect(convertTodoistRepeatToRepeatFlag("every weekday starting 2026-12-01 at 8am for 5 times")).toEqual({
        repeatFlag: "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;COUNT=5",
        repeatFrom: "2",
        time: { hour: 8, minute: 0 },
        startDateIso: "2026-12-01",
      });
      expect(convertTodoistRepeatToRepeatFlag("every workday")).toEqual({
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND",
        repeatFrom: "2",
      });
      expect(convertTodoistRepeatToRepeatFlag("every morning")).toEqual({
        repeatFlag: "RRULE:FREQ=DAILY;INTERVAL=1",
        repeatFrom: "2",
        time: { hour: 9, minute: 0 },
      });
    });

    it("reports unsupported or non-English expressions", () => {
      expect(convertTodoistRepeatToRepeatFlag("every 3 hours").lostReason).toBeTruthy();
      expect(convertTodoistRepeatToRepeatFlag("cada día", { dateLang: "es" }).lostReason).toMatch(/non-English/);
    });
  });
});
