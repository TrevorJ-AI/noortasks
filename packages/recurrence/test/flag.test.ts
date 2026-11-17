import { describe, expect, it } from "vitest";
import {
  RepeatFlagParseError,
  normalizeStoredRepeatFlag,
  parseRepeatFlag,
  serializeRepeatFlag,
  validateRepeatModel,
} from "../src/index";

/** Canonical repeatFlag round-trip cases (RFC rules, lunar/calendar extensions, ERULE, skip/workday flags) */
const CANONICAL_LITERALS = [
  "RRULE:FREQ=DAILY;INTERVAL=1",
  "RRULE:FREQ=WEEKLY;INTERVAL=1",
  "RRULE:FREQ=MONTHLY;INTERVAL=1",
  "RRULE:FREQ=YEARLY;INTERVAL=1",
  "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=5;BYDAY=2SU",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=11;BYDAY=4TH",
  "LUNAR:FREQ=YEARLY;INTERVAL=1;BYMONTH=3;BYMONTHDAY=4",
  "LUNAR:FREQ=YEARLY;INTERVAL=1;BYMONTH=12;BYMONTHDAY=-1",
  "ERULE:NAME=CUSTOM;BYDATE=20260101,20260215;COUNT=3",
  "ERULE:NAME=FORGETTINGCURVE;CYCLE=2;COUNT=5",
  "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10",
  "RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=-1",
  "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=OFFICIAL_WORKDAY",
  // extra shapes from 4.5 / B2 / B7
  "RRULE:FREQ=MONTHLY;INTERVAL=1;TT_WORKDAY=1",
  "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR",
  "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=SA,SU",
  "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=-1",
  "RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;COUNT=4",
  "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=-1FR",
  "RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1",
  "RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;WKST=SU",
  "RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261231",
  "RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261231T160000Z",
  "RRULE:FREQ=DAILY;INTERVAL=1;UNTIL=20261231T160000",
  "RRULE:FREQ=DAILY;INTERVAL=2;TK_COMPLETEDCOUNT=3",
  "RRULE:FREQ=DAILY;INTERVAL=1;COUNT=5;TK_COMPLETEDCOUNT=2;TT_SKIP=HOLIDAY;TT_WORKDAY=1",
  "RRULE:FREQ=DAILY;INTERVAL=1;TK_SKIP=HOLIDAY",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYYEARDAY=100,-1",
  "RRULE:FREQ=YEARLY;INTERVAL=1;BYWEEKNO=20;BYDAY=MO",
  "RRULE:FREQ=DAILY;INTERVAL=1;X-FOO=bar",
  "FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA",
  "FREQ=DAILY;INTERVAL=2",
  "FREQ=WEEKLY;INTERVAL=1;TT_TIMES=3",
  "ERULE:NAME=CUSTOM;BYDATE=20260101;UNTIL=20261231;TT_SKIP=HOLIDAY",
  "ERULE:NAME=FORGETTINGCURVE;CYCLE=0;UNTIL=20261231",
  "RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15;INTERVAL=1",
];

describe("round trip, byte stable", () => {
  it.each(CANONICAL_LITERALS)("%s", (s) => {
    const m = parseRepeatFlag(s)!;
    expect(m).not.toBeNull();
    expect(serializeRepeatFlag(m)).toBe(s);
  });
  it.each(["LUNAR", "KOREAN", "HEBCAL", "SHAKA", "PERSIAN", "VIETNAM", "HIJRI", "KUWAITI", "SAUDI"])("calendar prefix %s", (p) => {
    const s = `${p}:FREQ=YEARLY;INTERVAL=1;BYMONTH=9;BYMONTHDAY=1`;
    const m = parseRepeatFlag(s)!;
    expect(m.prefix).toBe(p);
    expect(serializeRepeatFlag(m)).toBe(s);
  });
  it("parse of the serialised model is stable (idempotent)", () => {
    for (const s of CANONICAL_LITERALS) {
      const once = serializeRepeatFlag(parseRepeatFlag(s)!);
      expect(serializeRepeatFlag(parseRepeatFlag(once)!)).toBe(once);
    }
  });
});

describe("parse", () => {
  it("null and empty give null", () => {
    expect(parseRepeatFlag(null)).toBeNull();
    expect(parseRepeatFlag(undefined)).toBeNull();
    expect(parseRepeatFlag("  ")).toBeNull();
  });
  it("reads the standard fields", () => {
    const m = parseRepeatFlag("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10;WKST=SU")!;
    expect(m.freq).toBe("WEEKLY");
    expect(m.interval).toBe(2);
    expect(m.byDay).toEqual([{ day: "MO" }, { day: "WE" }]);
    expect(m.count).toBe(10);
    expect(m.wkst).toBe("SU");
    expect(m.prefix).toBe("RRULE");
  });
  it("ordinal BYDAY", () => {
    expect(parseRepeatFlag("RRULE:FREQ=MONTHLY;BYDAY=2SU,-1FR")!.byDay).toEqual([{ n: 2, day: "SU" }, { n: -1, day: "FR" }]);
  });
  it("BYDAY=+2MO is written back as 2MO", () => {
    const m = parseRepeatFlag("RRULE:FREQ=MONTHLY;BYDAY=+2MO")!;
    expect(m.byDay).toEqual([{ n: 2, day: "MO" }]);
    expect(serializeRepeatFlag(m)).toBe("RRULE:FREQ=MONTHLY;BYDAY=2MO");
  });
  it("trailing semicolon is stripped", () => {
    expect(serializeRepeatFlag(parseRepeatFlag("RRULE:FREQ=DAILY;INTERVAL=1;")!)).toBe("RRULE:FREQ=DAILY;INTERVAL=1");
  });
  it.each([["20261231", true], ["20261231T160000Z", true], ["20261231T160000", true], ["2026123", false], ["20261231T1600", false], ["202612310", false]])(
    "UNTIL length rule %s kept=%s",
    (u, kept) => {
      const m = parseRepeatFlag(`RRULE:FREQ=DAILY;UNTIL=${u}`)!;
      expect(m.until).toBe(kept ? u : undefined);
    },
  );
  it("TK_COMPLETEDCOUNT is read and defaults to -1", () => {
    expect(parseRepeatFlag("RRULE:FREQ=DAILY;TK_COMPLETEDCOUNT=4")!.completedCount).toBe(4);
    expect(parseRepeatFlag("RRULE:FREQ=DAILY")!.completedCount).toBe(-1);
  });
  it("TK_COMPLETEDCOUNT=0 is serialised (only negative is hidden)", () => {
    expect(serializeRepeatFlag(parseRepeatFlag("RRULE:FREQ=DAILY;COUNT=2;TK_COMPLETEDCOUNT=0")!)).toContain("TK_COMPLETEDCOUNT=0");
  });
  it("TT_SKIP list", () => {
    expect(parseRepeatFlag("RRULE:FREQ=DAILY;TT_SKIP=HOLIDAY,WEEKEND")!.skip).toEqual(["HOLIDAY", "WEEKEND"]);
    expect(parseRepeatFlag("RRULE:FREQ=DAILY;TT_SKIP=OFFICIAL_WORKDAY")!.skip).toEqual(["OFFICIAL_WORKDAY"]);
  });
  it("legacy TK_SKIP=HOLIDAY means holiday + weekend, and is written back as TK_SKIP", () => {
    const m = parseRepeatFlag("RRULE:FREQ=DAILY;TK_SKIP=HOLIDAY")!;
    expect(m.skip).toEqual(["HOLIDAY", "WEEKEND"]);
    expect(serializeRepeatFlag(m)).toBe("RRULE:FREQ=DAILY;TK_SKIP=HOLIDAY");
  });
  it("TT_WORKDAY", () => {
    expect(parseRepeatFlag("RRULE:FREQ=MONTHLY;TT_WORKDAY=1")!.workday).toBe(1);
    expect(parseRepeatFlag("RRULE:FREQ=MONTHLY;TT_WORKDAY=-1")!.workday).toBe(-1);
  });
  it("ERULE CUSTOM", () => {
    const m = parseRepeatFlag("ERULE:NAME=CUSTOM;BYDATE=20260101,20260215;COUNT=3")!;
    expect(m.prefix).toBe("ERULE");
    expect(m.erule).toEqual({ name: "CUSTOM", byDate: ["20260101", "20260215"] });
    expect(m.count).toBe(3);
  });
  it("ERULE FORGETTINGCURVE", () => {
    const m = parseRepeatFlag("ERULE:NAME=FORGETTINGCURVE;CYCLE=2;COUNT=5")!;
    expect(m.erule).toEqual({ name: "FORGETTINGCURVE", cycle: 2 });
  });
  it("unknown parts are preserved", () => {
    const m = parseRepeatFlag("RRULE:FREQ=DAILY;X-A=1;INTERVAL=2")!;
    expect(m.extras).toEqual({ "X-A": "1" });
    expect(serializeRepeatFlag(m)).toBe("RRULE:FREQ=DAILY;X-A=1;INTERVAL=2");
  });
  it("bare habit rule has no prefix", () => {
    expect(parseRepeatFlag("FREQ=WEEKLY;TT_TIMES=3")!.prefix).toBeNull();
  });
});

describe("serialiser ordering", () => {
  it("tail order is COMPLETEDCOUNT, SKIP, WORKDAY regardless of input order", () => {
    const m = parseRepeatFlag("RRULE:FREQ=MONTHLY;TT_WORKDAY=1;TT_SKIP=HOLIDAY;TK_COMPLETEDCOUNT=2;INTERVAL=1")!;
    expect(serializeRepeatFlag(m)).toBe("RRULE:FREQ=MONTHLY;INTERVAL=1;TK_COMPLETEDCOUNT=2;TT_SKIP=HOLIDAY;TT_WORKDAY=1");
  });
  it("parts added after parse follow the canonical order", () => {
    const m = parseRepeatFlag("RRULE:FREQ=WEEKLY;INTERVAL=1")!;
    m.byDay = [{ day: "MO" }];
    m.count = 3;
    m.wkst = "SU";
    expect(serializeRepeatFlag(m)).toBe("RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO;WKST=SU;COUNT=3");
  });
  it("completedCount -1 is not written", () => {
    const m = parseRepeatFlag("RRULE:FREQ=DAILY;INTERVAL=1")!;
    expect(serializeRepeatFlag(m)).not.toContain("TK_COMPLETEDCOUNT");
  });
});

describe("errors", () => {
  it.each(["BOGUS:FREQ=DAILY", "RRULE:INTERVAL=2", "RRULE:FREQ=SOMETIMES", "RRULE:FREQ=DAILY;INTERVAL=x", "ERULE:NAME=NOPE", "RRULE:FREQ=DAILY;BYDAY=XX", "RRULE:FREQ=DAILY;TT_SKIP=NOPE", "RRULE:FREQ=DAILY;TT_WORKDAY=2", "RRULE:FREQ=DAILY;oops"])(
    "rejects %s",
    (s) => {
      expect(() => parseRepeatFlag(s)).toThrow(RepeatFlagParseError);
    },
  );
});

describe("normalizeStoredRepeatFlag", () => {
  it.each([
    ["RRULE:FREQ=DAILY;INTERVAL=1;TK_SKIP=HOLIDAY", "2", "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY,WEEKEND"],
    ["RRULE:FREQ=DAILY;INTERVAL=1;TK_SKIP=HOLIDAY", "0", "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY"],
    ["RRULE:FREQ=DAILY;INTERVAL=1;TK_SKIP=HOLIDAY", "1", "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY"],
    ["RRULE:FREQ=DAILY;INTERVAL=1;TK_SKIP=OTHER", "2", "RRULE:FREQ=DAILY;INTERVAL=1"],
    ["RRULE:FREQ=DAILY;INTERVAL=1;TK_COMPLETEDCOUNT=3", "2", "RRULE:FREQ=DAILY;INTERVAL=1"],
    ["RRULE:FREQ=DAILY;INTERVAL=1;", "2", "RRULE:FREQ=DAILY;INTERVAL=1"],
    ["RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY", "2", "RRULE:FREQ=DAILY;INTERVAL=1;TT_SKIP=HOLIDAY"],
  ])("%s (%s)", (flag, from, out) => {
    expect(normalizeStoredRepeatFlag(flag, from)).toBe(out);
  });
  it("weekend skip with only SA/SU BYDAY is invalid -> null", () => {
    expect(normalizeStoredRepeatFlag("RRULE:FREQ=WEEKLY;BYDAY=SA,SU;TT_SKIP=WEEKEND", "2")).toBeNull();
  });
  it("weekend skip with mixed BYDAY stays", () => {
    expect(normalizeStoredRepeatFlag("RRULE:FREQ=WEEKLY;BYDAY=FR,SA;TT_SKIP=WEEKEND", "2")).not.toBeNull();
  });
  it("null in, null out", () => expect(normalizeStoredRepeatFlag(null, "2")).toBeNull());
});

describe("validateRepeatModel", () => {
  it("lunar day 31 and 0 are rejected", () => {
    expect(validateRepeatModel(parseRepeatFlag("LUNAR:FREQ=MONTHLY;BYMONTHDAY=31")!)).toHaveLength(1);
    expect(validateRepeatModel(parseRepeatFlag("LUNAR:FREQ=MONTHLY;BYMONTHDAY=0")!)).toHaveLength(1);
  });
  it("lunar day 30 and -1 are fine", () => {
    expect(validateRepeatModel(parseRepeatFlag("LUNAR:FREQ=MONTHLY;BYMONTHDAY=30,-1")!)).toHaveLength(0);
  });
  it("gregorian day 31 is fine", () => {
    expect(validateRepeatModel(parseRepeatFlag("RRULE:FREQ=MONTHLY;BYMONTHDAY=31")!)).toHaveLength(0);
  });
});
