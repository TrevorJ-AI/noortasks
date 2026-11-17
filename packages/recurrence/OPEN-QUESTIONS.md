# Open questions: recurrence edge cases

Each item says what the engine does today, why it is a guess, and an experiment. "Set up" is the exact task/rule,
"Verify" describes the concrete case to check. Dates assume tests run on a fixed reference day; adjust the dates but keep the shape.
Unless stated, use a timed task in a fixed time zone, due 09:00.

## A. Completion and COUNT

**Q1. Who writes TK_COMPLETEDCOUNT, and does completing decrement COUNT instead?**
Engine: COUNT is the total; remaining = COUNT - TK_COMPLETEDCOUNT (dtstart counts as occurrence 1); on completion the flag gets
`TK_COMPLETEDCOUNT=n+1`, only when the rule has COUNT (alternatively COUNT could be decremented directly, since clients strip TK_COMPLETEDCOUNT on load).
Set up: daily, due today 09:00, "Ends after 3 times" (flag `...;COUNT=3`), repeat by due date.
Check: does `repeatFlag` in the updated task JSON keep `COUNT=3;TK_COMPLETEDCOUNT=1`, rewrite to `COUNT=2`, or remain unchanged across 3 completions?

**Q2. Mode "2" late completion: next date today or after today?**
Engine: next = first pattern date that is > current start AND on/after today 00:00 in the task zone (today counts even if its time has passed).
Set up: daily 09:00 task whose due date is 5 days ago (repeatFrom default, i.e. "Repeat" not "Repeat from completion").
Observe: complete it at 14:00 today. New due = today 09:00 (engine), tomorrow 09:00, or yesterday+1?

**Q3. Mode "2" overdue skips and COUNT.**
Engine: skipped overdue pattern dates consume COUNT, so TK_COMPLETEDCOUNT jumps by more than 1.
Set up: daily, ends after 10 times, due 5 days ago. Complete it today.
Question: how many occurrences should remain ("Ends after N") after late completion; engine counts 5 more (today + 4).

**Q4. "Ends On" vs "Ends After" when completing late.**
Engine: both modes behave identically for date selection (UNTIL is a hard stop, COUNT consumed by skipped dates in mode 2).
Set up: two daily tasks due 3 days ago, one "Ends on <today+10>", one "Ends after 5 times". Complete each now.
Question: whether an Ends On task should keep the next Due anchor while Ends After advances on late completion.

**Q5. Mode "1": which time zone defines the completion day?**
Engine: the task's zone (device zone for all-day/floating tasks).
Set up: task in Pacific/Auckland (enable the time zone option), repeat by completion, daily. Complete it at a moment when the device zone date and the Auckland date differ (for example 23:30 device time in a zone 10+ hours behind).
Observe: new due date = Auckland day + 1 or device day + 1.

**Q6. Mode "1" keeps the due time of day; what happens to the date-only (all-day) case and to the due span?**
Engine: new start time of day = old start time of day; due keeps the old start-to-due span (all-day: same number of days).
Set up: timed task 09:00-11:00 weekly "by completion"; complete it on a different weekday and hour.
Observe: new start and due times.

**Q7. Mode "1" and monthly clamp.**
Engine: completed on Jan 31 with "every 1 month by completion" gives Feb 28.
Set up: monthly by completion; complete it on 31 January of a non-leap year.
Observe: new due date (Feb 28, Mar 3 or Mar 2).

**Q8. After completion, are snoozeReminderTime, progress, checklist completedTime and `remindTime` all cleared?**
Engine: status 0, progress 0, remindTime null, reminder null, snoozeReminderTime null (task and items), items status 0 + completedTime null, completedTime/completedUserId null. Relative reminders unchanged.
Set up: task with a checklist (2 items, one done, one with a start date), progress slider at 60% if available, a reminder, and a snoozed reminder. Complete the task.
Observe: the task JSON of the live (master) task, then the item dates (shift by the same day delta?).

**Q9. When the series ends on completion, is the repeatFlag kept or cleared, and is a history copy created?**
Engine: no copy, the task just becomes status 2 with its flag untouched.
Set up: daily, "Ends after 2 times". Complete it twice.
Observe: the final task JSON (`repeatFlag`, `repeatTaskId`, number of completed copies in the completed list).

## B. Rule expansion

**Q10. BYMONTHDAY 29-31 in short months: fall back to the last day, or extra hit?**
Engine: day > month length and >= 29 clamps to the last day, deduplicated (BYMONTHDAY=29 in a 31-day month gives only the 29th). An alternative design adds `-1` and skips candidates above max (which would also allow firing on the 31st).
Set up: monthly, "On day 29", start 29 Jan; also "On day 31".
Observe: the next 4 due dates in the calendar "show all repeat cycles" (expect Feb 28, Mar 29, Apr 29; check Mar 31 does not appear for day 29).

**Q11. Implicit day 29-31 (no BYMONTHDAY in the flag) in short months.**
Engine: same clamp as Q10.
Set up: a monthly task with flag `RRULE:FREQ=MONTHLY;INTERVAL=1` and due Jan 31 (create through the API or the "Monthly" preset).
Observe: Feb due date and Mar due date (28 Feb, 31 Mar; or skipped months).

**Q12. Yearly Feb 29.**
Engine: non-leap years land on Feb 28, leap years on Feb 29.
Set up: yearly task due 29 Feb 2028; "show all repeat cycles" or complete it repeatedly.
Observe: 2029 date (Feb 28 vs Mar 1 vs skipped).

**Q13. Default week start when the flag has no WKST.**
Engine: Monday (RFC). The real default may follow the account's `startDayOfWeek` (default SUN).
Set up: `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,MO` due on a Sunday, account week start Monday, then again with Sunday.
Observe: the second due date. WKST=MO gives Monday of the week after next first; WKST=SU gives the next day (Mon) first.

**Q14. BYSETPOS and ordinal BYDAY combinations the editor never builds.**
Engine: standard RFC 5545 semantics (BYSETPOS applied to the per-period sorted set, BYMONTHDAY x BYDAY intersect).
Set up: via API write `RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1` and `RRULE:FREQ=MONTHLY;BYMONTHDAY=13;BYDAY=FR`.
Observe: the next due dates in the calendar (last weekday of month; Friday the 13th).

**Q15. Candidate cap of 3000 and windows.**
Engine: 3000 examined candidates per call, counted from the series start (or from the fast-forward point when there is no COUNT).
Set up: daily task, due date 2018-01-01, no end. Open the calendar on 2026-11 with "show all repeat cycles"; then a task with COUNT=9000.
Observe: whether cycles still render in 2026 (engine: yes, no COUNT), and where the COUNT=9000 series stops showing (engine: exactly 3000 occurrences, counting the start).

**Q16. Rules the editor cannot produce.**
Engine throws UnsupportedRuleError for FREQ=HOURLY/MINUTELY/SECONDLY, BYHOUR/BYMINUTE/BYSECOND and BYEASTER; BYYEARDAY and BYWEEKNO are implemented per RFC 5545.
Set up: write each flag through the API on a test task.
Question: when a rule is outside editor presets, should it be preserved as parsed, ignored, or rejected?

## C. UNTIL and time zones

**Q17. UNTIL semantics: date, datetime with hour != 0, hour == 0, floating datetime.**
Engine: `YYYYMMDD` = end of that day in the task zone; datetime with hour != 0 = start of the task-zone day containing it, minus 1 s (so that day is excluded, as written by "this and all future" delete); datetime with hour 0 = that whole day; no-Z datetime read as wall time.
Set up: daily Europe/Amsterdam tasks with `UNTIL=20261118`, `UNTIL=20261117T230000Z`, `UNTIL=20261118T000000Z`; set via the API.
Observe: the last occurrence shown for each (expect 18 Nov, 17 Nov, 18 Nov).

**Q18. Which zone does each mode evaluate in?**
Engine: the task zone for all modes (device zone for floating/all-day). An alternative is applying the task zone only in mode "2".
Set up: a task with a different zone than the device, due 23:30 in the task zone, weekly BYDAY=MO, once with repeat-by-due-date, once by completion, once default.
Observe: whether the next due keeps 23:30 task-zone wall time and which weekday it lands on.

**Q19. DST: nonexistent and ambiguous local times.**
Engine: a time inside a spring-forward gap moves forward by the gap (02:30 -> 03:30); an ambiguous time takes the first occurrence. Wall time is preserved on other days.
Set up: daily task 02:30 in Europe/Amsterdam, due 2027-03-27; and 02:30 daily due 2026-10-24.
Observe: due times of 2027-03-28 (03:30? 02:30 skipped?) and 2026-10-25 (first or second 02:30; compare the UTC value in the JSON).

**Q20. Absolute vs wall-clock due span across DST.**
Engine: timed tasks keep their absolute duration; all-day tasks keep the day count.
Set up: task 23:30 to 00:30 (1 h) daily in Amsterdam, due 2027-03-27; complete it on the 27th.
Observe: the new due minus start (1 h or 2 h/0 h).

## D. Skip rules

**Q21. HOLIDAY,WEEKEND and make-up workdays; non-mode-2 behaviour.**
Engine: with both flags the candidate is kept iff the provider says it is an official workday (this includes make-up Saturdays), in every repeatFrom mode. Modes 0/1 ("not rest and not Sat/Sun") could alternatively exclude make-up Saturdays.
Set up: account with a country calendar that has a make-up Saturday (for example CN); daily "Every workday" by due date, and the same by completion, with the due date the Friday before a make-up Saturday.
Observe: whether the Saturday occurrence appears in each mode.

**Q22. Do skipped (holiday/weekend) days consume COUNT?**
Engine: no (same as exDates).
Set up: daily, skip weekends, ends after 5 times, due on a Friday.
Observe: the final due date (engine: the Friday of the next week; if skipped days count it would be Tue).

**Q23. TT_SKIP=WEEKEND on non-daily rules.**
Engine: skip is a pure filter on every candidate in all frequencies; mode "1" is not special-cased.
Set up: weekly by completion with skip weekends, complete on a Friday so the next lands on Friday (fine), and every 7 days by completion where the date lands on a Saturday (complete on a Saturday).
Observe: next due date (Saturday, Monday or skipped a week).

**Q24. TT_WORKDAY and holidays.**
Engine: first/last day of every INTERVAL-th month for which `isWorkday` is true, anchored at the start's month; the start month itself is not repeated.
Set up: "Monthly, last workday" with CN holiday data on; start on the last workday of a month that is followed by a holiday-ending month (for example Sep 2026 with the Golden Week).
Observe: the next due date vs the engine's last workday of the next month.

## E. Alternate calendars

**Q25. ICU lunar calendar defect.**
Node's ICU 78.3 returns Chinese New Year 2027 = Feb 7 (published: Feb 6) and 2030 = Feb 2 (published: Feb 3). The engine uses whatever Intl returns.
Set up: `LUNAR:FREQ=YEARLY;INTERVAL=1;BYMONTH=1;BYMONTHDAY=1` due 2026-02-17.
Question: next two due dates against the engine (2027-02-07, 2028-01-26) if astronomical new-moon tables are used instead of `Intl` chinese.

**Q26. Lunar leap months.**
Engine (isLunarLeapMonthRepeat default true): BYMONTH=m also fires in leap month m (2023 had a leap month 2).
Set up: `LUNAR:FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=1` due 2022-03-03.
Observe: the next due dates: 2023-02-20 then 2023-03-22 (leap) then 2024-03-10, or without the leap hit.

**Q27. Lunar day 30 / -1 in 29-day months and "|BYMONTHDAY| > 30 rejected".**
Engine: positive days >= 29 beyond the month length clamp to the last day; 31 and 0 raise InvalidRepeatRuleError for LUNAR.
Set up: lunar monthly "day 30" (the editor stores -1), lunar monthly day 29.
Observe: due dates in a 29-day lunar month.

**Q28. HIJRI and SAUDI mapping, KUWAITI unsupported.**
Engine: HIJRI = ICU islamic-civil, SAUDI = islamic-umalqura, KUWAITI/KOREAN/HEBCAL/SHAKA/PERSIAN/VIETNAM throw UnsupportedCalendarError (assuming western islamic-civil for HIJRI).
Set up: `HIJRI:FREQ=YEARLY;INTERVAL=1;BYMONTH=9;BYMONTHDAY=1` due 2026-02-18, and the same with `SAUDI:`.
Observe: due dates for 1 Ramadan 1448 and 1449 against the engine (civil: 1 Ramadan 1448 = 2027-02-08 +/- 1 day; umalqura differs by a day or two).

## F. Misc

**Q29. exDates consume COUNT?**
Engine: no (exDates do not consume COUNT by default).
Set up: daily, due Mon, ends after 3 times; delete "only this recurrence" for Tuesday.
Observe: the occurrences listed (Mon, Wed, Thu, or Mon, Wed).

**Q30. ERULE CUSTOM: first date, past dates, repeatFrom.**
Engine: dates > current start, in order, at the start's time; mode "2" skips dates before today; COUNT includes the current start.
Set up: "By specific dates" with 4 dates, one in the past; complete the task.
Observe: the new due date, and what happens when the last date is completed (flag kept, task completed).

**Q31. Forgetting curve: CYCLE meaning and COUNT.**
Engine: CYCLE = index into the gap table [1,1,2,3,8,15,...] used for the NEXT date; completion adds 1 to CYCLE; COUNT includes the current date.
Set up: Ebbinghaus repeat, "Ends after 5", due today; complete 3 times.
Observe: due dates (+1, +1, +2) and the stored `CYCLE`/`COUNT` after each completion.

**Q32. describeRepeat strings.**
Engine strings are natural-language phrases for workday, official working day, repeat count, and end-date rules.
Set up: create one task for each preset in the repeat picker (daily, workday, weekly Mon+Wed every 2 weeks, monthly last day, yearly March 4, ends after 5, ends on a date, forgetting curve, custom dates).
Observe: the summary line under "Repeat" in the task detail, character for character, and fix `src/describe.ts`.

**Q33. UNTIL kept as-is on serialise.**
Engine: UNTIL is written back exactly as parsed rather than dropping the time part or normalising to `YYYYMMDDT...Z`.
Set up: set "Ends on" in the repeat editor, open the task via the API.
Observe: the exact UNTIL string stored (8 chars or 16 chars with Z) and in which zone it is expressed.

**Q34. BYDAY serialisation order of parts.**
Engine: parsed order is kept, new parts follow FREQ, INTERVAL, BYMONTH, BYWEEKNO, BYYEARDAY, BYMONTHDAY, BYDAY, BYSETPOS, WKST, COUNT, UNTIL.
Set up: create weekly Mon/Wed every 2 weeks, ends after 10 with week start Sunday in the editor; read `repeatFlag`.
Observe: the exact part order and whether WKST is written at all.
