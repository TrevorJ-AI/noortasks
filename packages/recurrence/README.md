# @noortasks/recurrence

Pure TypeScript repeat-rule engine for NoorTasks: parses and serialises `repeatFlag` strings, expands
occurrences, applies skip rules and computes what a completion does to a repeating task. No DOM, network or
filesystem; ambient inputs (`now`, device zone, holiday data) are always passed in.

## Library choice: own expander, no runtime dependencies

1. `rrule` 2.8.1 was last published 2023-11 (unmaintained) and its time zone support (`tzid`) is the known source of DST bugs.
2. `rrule-temporal` 2.2.9 is maintained but needs a Temporal polyfill at runtime (Node 22 has no `Temporal`), a heavy dependency for an Android-bound core.
3. Neither expresses the extended `repeatFlag` rules: month-end fallback for BYMONTHDAY 29-31, COUNT that excludes exDates and skipped days, completion mode that drops BYDAY/BYMONTHDAY, `TT_WORKDAY`, ERULE, and generic expansion over `Intl` lunar/Hijri calendars.
4. So expansion works on integer epoch days of the rule's calendar (no instants, so DST cannot touch the date maths), and the time of day is applied last with a small `Intl`-based `wallToInstant` (gap: shift forward, overlap: earlier instant).
5. Everything is covered by table tests plus a mutation spot check (see `test/`).

## API (src/index.ts)

`parseRepeatFlag`, `serializeRepeatFlag` (lossless, byte-stable), `normalizeStoredRepeatFlag` (the legacy rewrite as a separate step),
`nextOccurrence`, `occurrences(obj, limit, ctx)`, `occurrencesBetween(obj, from, to, ctx)`, `willRepeatAgain`,
`completeRecurringTask(task, completedAt, ctx)`, `describeRepeat(model, 'en')`, errors `UnsupportedCalendarError`,
`UnsupportedRuleError`, `InvalidRepeatRuleError`, `RepeatFlagParseError`.

Holiday provider dates are `"YYYY-MM-DD"` strings in the task zone. `isHoliday` = statutory day off, `isWorkday` = official working day
(includes make-up weekend workdays, excludes holidays). Default provider: only Sat/Sun are rest days.

Calendars: `RRULE` (Gregorian), `LUNAR` (Intl chinese), `HIJRI` (islamic-civil), `SAUDI` (islamic-umalqura). `KOREAN`, `HEBCAL`, `SHAKA`,
`PERSIAN`, `VIETNAM`, `KUWAITI` parse and round-trip but generation throws `UnsupportedCalendarError`. Known platform defect: Node's ICU
(78.3) puts Chinese New Year 2027 on Feb 7 and 2030 on Feb 2 (published: Feb 6 and Feb 3). See OPEN-QUESTIONS.md.

Not supported for generation (throws `UnsupportedRuleError`): FREQ below DAILY, BYHOUR/BYMINUTE/BYSECOND, BYEASTER.

Open design edge cases and trade-offs are listed in OPEN-QUESTIONS.md.
