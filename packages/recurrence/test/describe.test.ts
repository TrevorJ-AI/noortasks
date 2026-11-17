import { describe, expect, it } from "vitest";
import { describeRepeat, parseRepeatFlag } from "../src/index";

const rows: [string, string][] = [
  ["RRULE:FREQ=DAILY;INTERVAL=1", "Daily"],
  ["RRULE:FREQ=DAILY;INTERVAL=3", "Every 3 days"],
  ["RRULE:FREQ=WEEKLY;INTERVAL=1", "Weekly"],
  ["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "Every 2 weeks on Mon, Wed"],
  ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", "Weekly on Mon"],
  ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR", "Every workday"],
  ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA,SU", "Every weekend"],
  ["RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND", "Official working days"],
  ["RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=OFFICIAL_WORKDAY", "Official holidays"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1", "Monthly"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15", "Monthly on the 15th"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1", "Monthly on the 1st"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=22", "Monthly on the 22nd"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=23", "Monthly on the 23rd"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=11", "Monthly on the 11th"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1", "Monthly on the last day"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1", "Every 3 months on the 1st"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=2SU", "Monthly on the 2nd Sun"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR", "Monthly on the last Fri"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=1", "Monthly on the first workday"],
  ["RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=-1", "Monthly on the last workday"],
  ["RRULE:FREQ=YEARLY;INTERVAL=1", "Yearly"],
  ["RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=4", "Yearly on March 4th"],
  ["RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=3;BYMONTHDAY=4", "Every 2 years on March 4th"],
  ["RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=5;BYDAY=2SU", "Yearly on the 2nd Sun of May"],
  ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;COUNT=10", "Weekly on Mon; In 10 times"],
  ["RRULE:FREQ=DAILY;INTERVAL=1;COUNT=1", "Daily; In 1 time"],
  ["RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261231", "Daily; Until December 31, 2026"],
  ["RRULE:FREQ=DAILY;INTERVAL=1;COUNT=2;UNTIL=20261231", "Daily; In 2 times; Until December 31, 2026"],
  ["RRULE:FREQ=DAILY;INTERVAL=2;TT_SKIP=WEEKEND", "Every 2 days, skipping weekends"],
  ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR;TT_SKIP=HOLIDAY", "Weekly on Fri, skipping holidays"],
  ["ERULE:NAME=CUSTOM;BYDATE=20260101,20260215;COUNT=3", "Custom dates (2 dates); In 3 times"],
  ["ERULE:NAME=CUSTOM;BYDATE=20260101", "Custom dates (1 date)"],
  ["ERULE:NAME=FORGETTINGCURVE;CYCLE=2;COUNT=5", "Forgetting curve; 3rd; In 5 times"],
  ["LUNAR:FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=4", "Lunar: Yearly on March 4th"],
  ["HIJRI:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=1", "Hijri: Monthly on the 1st"],
];

describe("describeRepeat", () => {
  it.each(rows)("%s -> %s", (flag, text) => {
    expect(describeRepeat(parseRepeatFlag(flag)!, "en")).toBe(text);
  });
  it("accepts the raw string too", () => {
    expect(describeRepeat("RRULE:FREQ=DAILY;INTERVAL=1")).toBe("Daily");
  });
  it("empty for no rule", () => {
    expect(describeRepeat(null)).toBe("");
    expect(describeRepeat("")).toBe("");
  });
});
