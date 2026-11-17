# Quick-Add Parser Rules and Architecture

## Runtime Dependency Rationale

`@noortasks/quickadd` uses **`chrono-node` (`^2.10.3`, MIT license, zero transitive dependencies)** as its sole runtime dependency. Using `chrono-node` provides English calendar, month/day, weekday, meridiem, and range extraction on top of which custom parsers (`tod`/`tom`/`day after tomorrow`, `H.mm` dot times, `at <meal>` anchors, `on the Nth`, `weekStart`-aware `this`/`next`/`last`) and refiners operate.

All other modules are zero-dependency pure TypeScript:
- **Timezones & calendar math (`src/timezone.ts`)**: Built on `Intl.DateTimeFormat` two-pass wall-clock resolution with DST offset accuracy.
- **Recurrences (`src/repeat.ts`)**: Generates `RRULE:` strings (`TT_SKIP`, `TT_WORKDAY`, `COUNT`, `UNTIL=YYYYMMDD`; `TT_*` extensions kept for import compatibility) directly without pulling in `rrule` at runtime.
- **Reminders (`src/reminders.ts`)**: Formats canonical iCalendar `TRIGGER:` strings directly.
- **Symbol triggers & masking (`src/triggers.ts`, `src/masking.ts`)**: Single-pass index-preserving masking for URLs, emails, serials, phones, long digit runs, and `disabledSpans`.

## Implemented Rules

| Rule | Example |
| --- | --- |
| ISO-8601 output timestamp with timezone offset | `2026-11-16T09:00:00.000+00:00` |
| Task priority numeric mapping (`High=5`, `Medium=3`, `Low=1`, `None=0`) | `!high` -> `5`, `!2` -> `3` |
| All-day boolean and exclusive +1 day `dueDate` on multi-day NLP ranges | `Nov 20 to Nov 22` -> due `2026-11-23` |
| Hash tag trigger (`#` and fullwidth `＃`), lowercase canonical tag name, forbidden char stopping | `Docs #Work` -> `tags: ["work"]` |
| Exclamation priority trigger words & digits (`!` and `！`, `!high`/`!1`..`!none`/`!4`) | `Fix bug !1` -> `priority: 5` |
| Repeated exclamation shorthands (`!!` = Medium 3, `!!!` = High 5) | `Deploy !!` -> `priority: 3` |
| List triggers (`~`, `^`, fullwidth `～`, `＾`), latest wins | `Buy milk ~Groceries` |
| Assignee trigger (`@` and fullwidth `＠`), ignoring email local parts | `Review @alice` |
| Autocomplete longest-first matching for multi-word `lists`, `tags`, `assignees` | `~Home Renovations` |
| Chained adjacent symbol triggers without intervening spaces | `#work!high~Team@alice` |
| Forced explicit date prefix (`*` and `＊`), forces ambiguous words and overrides `dateParsing: false` | `Prep *may`, `Call＊next friday` |
| `dateParsing` toggle (`nlpEnabled`); `false` disables natural dates/times/repeats/reminders | `dateParsing: false` keeps `"tomorrow"` |
| `removeRecognizedText` toggle (`removeDate`); `false` keeps NLP spans, strips triggers | `removeRecognizedText: false` |
| `disabledSpans` exclusion including compound-token seam rejection | Disabling `"2026-"` disables `"2026-12-01"` |
| Case-insensitive NLP parsing for mixed-case date/repeat phrases | `TOMORROW AT 3PM` |
| Relative day keywords (`today`, `tod`, `tomorrow`, `tom`, `tmr`, `tmrw`, `yesterday`, `day after tomorrow`) | `Send draft tmrw` |
| Person-name guard on capitalized `Tom` after person verbs | `Call Tom tomorrow` -> date is tomorrow |
| Part-of-day default hours (`morning` 09:00, `afternoon` 13:00, `evening` 17:00, `night`/`tonight` 20:00) | `Read tonight` -> `20:00` |
| Prepositional meal anchors (`at breakfast` 08:00, `at brunch` 10:00, `at lunch` 12:00, `at supper` 18:00, `at dinner` 19:00) | `Call parents at dinner` -> `19:00` |
| Relative time and date offsets (`in`/`after N units`, `N units later`, `half an hour`) | `in 30 minutes`, `after 2 weeks` |
| Absolute ISO, slash, dot, and month-name dates (`YYYY-MM-DD`, `MM/DD`, `DD/MM` when day > 12, `D.M.YYYY`, `Nov 20`, `1st of May`, `on the 20th`, `in March`) | `Submit taxes 2026-12-25` |
| Period boundary dates (`beginning/end of week/month/year`, `last day of the month`, `next week/month/year`) | `end of month` -> `2026-11-30` |
| `weekStart`-aware weekday parsing (`0` Sun, `1` Mon, `6` Sat) for `this`/`next`/`last`/weekend | `next Monday` with `weekStart: 1` |
| Time formats (`12h`, `24h`, `o'clock`, `noon`, `midnight`, `H.mm` dot separator, bare hour disambiguation, `tonight`/`evening` PM propagation) | `Read book 21.30`, `tonight at 7` -> `19:00` |
| Forward-date rollover (`ForwardDateRefiner`) when time or month/day already passed | `9am` at `14:00` -> tomorrow `09:00` |
| Time ranges (`from X to Y`, `X-Y`, `X ~ Y`, `X until Y`) with meridiem propagation (preserving morning starts like `10-11:30am`) & midnight rollover | `from 10pm to 2am`, `2 - 4pm`, `10-11:30am` |
| Duration attachment (`for N units`) & standalone time-unit duration (`for N minutes/hours`) | `at 3pm for 1 hour`, `Nov 20 for 3 days` |
| Exclusion of URLs, emails, phone numbers (`123-456-789`), issue codes (`P12-3`, `AAAA-BBBB`), semver, IPv4, 5+ digit numbers, chapter/currency decimals | `https://example.com/2026-05-01`, `chapter 14.30` |
| False-positive filters for invalid dates (`May 32`, `2026-13-01`), fractions (`1/2 cup`), bare months & `of`/`for`/`to`/verb uses (`may`, `march`), idioms (`friday the 13th`, `all afternoon`, `movie night`), ambiguous weekdays, `a second` | `"read march of the penguins"`, `"may need help"`, `"friday the 13th movie night"` |
| Default reminder phrase `remind me` / `reminds me` (including leading `remind me to ...` cleanup) & possessive `'s` absorption on day spans | `remind me to call mom tomorrow`, `tomorrow's release` |
| Relative reminder offsets (`before`, `early`, `earlier`, `ahead`, `beforehand`, `in advance`), all-day 09:00 shift, dedup | `15m before`, all-day `1 day before` -> `TRIGGER:-P0DT15H0M0S` |
| Half-unit reminder mappings (`0.5m->30s`, `0.5h->30m`, `0.5d->12h`, `0.5w->3d`, `0.5mo->15d`) | `half a week before` -> `TRIGGER:-P3D` |
| Daily, weekly, monthly, yearly recurrence & `every N units` / frequency adverbs (`biweekly`, `bimonthly`, `quarterly`, `semi-annually`) | `every 3 days` -> `RRULE:FREQ=DAILY;INTERVAL=3` |
| Workday skipping (`every workday` / `working day` -> `TT_SKIP=HOLIDAY,WEEKEND`) & monthly workdays (`TT_WORKDAY=1\|-1`) | `every workday`, `last workday of every month` |
| Weekday lists (spaces, `,`, `/`, `&`, `and`, plurals), `weekly`/`biweekly` lists, weekdays (`MO..FR`), weekends (`SA,SU`), monthly Nth/last day (`BYMONTHDAY=-1`), ordinal weekdays (`BYDAY=1MO`) | `every mon wed fri at 7am`, `on mondays and thursdays`, `every 2nd Sunday of May` |
| Recurrence end conditions (`UNTIL=YYYYMMDD` date-only, `COUNT=n`, `for N times`, `xN`, `for N weeks`), first-occurrence anchoring & `starting <date>` | `every day until 2026-12-31`, `every weekday at 9:30am` |

## Open Edge Cases

Design edge cases to refine or confirm through parser tests:

1. **Single-date / single-time `dueDate` field**: Whether quick-add sets `dueDate` equal to `startDate` or leaves `dueDate` unset when only one date or time is entered.
   - Test phrases: `"Standup at 9am"` and `"Submit taxes 2026-12-25"`
2. **Exact default hours for meal keywords and part-of-day variants**: Hours for `breakfast` (08:00), `brunch` (10:00), `lunch` (12:00), `supper` (18:00), `dinner` (19:00), and whether bare `morning`/`night` without prepositions trigger on title nouns.
   - Test phrases: `"Take vitamins tomorrow at breakfast"`, `"Meet Sarah tomorrow at lunch"`, `"Call parents at dinner"`, `"Night watch from 10pm to 2am"`, `"Morning coffee"`
3. **Weekday definition of `"this <weekday>"` vs `"next <weekday>"` across `weekStart` values**: Whether `"next Monday"` on Sunday (with Monday `weekStart` vs Sunday `weekStart`) always means week `w+1` or next occurrence > 7 days away.
   - Test phrases (with `startDayOfWeek = 0`, `1`, `6`): `"Meet this Monday"`, `"Meet next Monday"`, `"Call next weekend"`
4. **Preposition stripping on dates and deadlines**: Whether `"on"`, `"in"`, `"by"`, and `"from"` are included in the recognized date span and removed from the task title.
   - Test phrases: `"Launch on 2026-12-01 at 10am"`, `"Submit report by Friday"`, `"Vacation from Nov 20 to Nov 22"`, `"Drop by tomorrow"`
5. **US vs UK slash date disambiguation**: How ambiguous `04/05/2027` should behave when `ParseQuickAddOptions` is extended with a date-format preference.
   - Test phrases: `"Dentist 04/05/2027"` and `"Dentist 20/05/2027"`
6. **Reminder trigger formatting for hours, seconds, months, and all-day half-days**: Whether `"1 hour before"` emits `TRIGGER:-PT60M` or `TRIGGER:-PT1H`, whether `< 60s` emits `TRIGGER:-PT30S`, whether `"15 minutes before"` on all-day emits `TRIGGER:P0DT8H45M0S`, and how `"half a day before"` on an all-day task is shifted.
   - Test phrases: `"Flight tomorrow 3pm 1 hour before"`, `"Auction tomorrow 8pm 30 seconds before"`, `"Bills tomorrow 15 minutes before"`, `"Bills tomorrow half a day before"`, `"Lease Dec 30 at 9am 0.5 month before"`
7. **`remind me` without any date or time in the phrase**: Whether `"remind me"` with no date/time anchors onto `now`, today all-day, or produces no reminder until a date is present.
   - Test phrase: `"Buy milk remind me"`
8. **Workday recurrences (`TT_SKIP=HOLIDAY,WEEKEND`, `TT_WORKDAY`)**: Confirm consistent behavior across `every workday` and `first/last workday of every month`.
   - Test phrases: `"Check inbox every workday"`, `"Timesheet first workday of every month"`, `"Payroll every month on the last workday"`
9. **Daily repeat with week duration end condition (`for N weeks`)**: Whether `"every day for 2 weeks"` produces inclusive `UNTIL` at `+13` days (14 daily occurrences) or `+14` days.
   - Test phrase: `"Antibiotics every day for 2 weeks"`
10. **Standalone time duration vs long unit duration without start date**: Whether `"for 45 minutes"` anchors `[now, now+45m]` while `"for 6 months"` is ignored as a non-date title phrase.
    - Test phrases: `"Run for 45 minutes"`, `"Save for 6 months"`
11. **Multiple triggers of the same single-valued field**: Latest-wins vs first-wins when multiple priorities, lists, assignees, or `*` forced dates appear in one input.
    - Test phrases: `"Task !low !high ~Inbox ~Work @alice @bob"`, `"Task *tomorrow *friday"`
12. **Mixed-script fullwidth trigger without leading space**: Whether fullwidth `＊` / `＃` / `！` should strip when typed directly adjacent to Latin letters as well as CJK characters.
    - Test phrase: `"Call＊next friday"`
13. **Bare month names without day numbers inside titles, verbs, or prepositional phrases**: Whether standalone month names without a day number (preceded by `"in"` or followed by `"of"`/`"for"`/`"to"` or used as verbs) should ever trigger a 1st-of-month date.
    - Test phrases: `"read march of the penguins"`, `"march to the store"`, `"may need help"`, `"Trip in March"`
14. **Multi-weekday list separators and plural lists**: Support for space-separated days, Oxford comma lists, `weekly` / `biweekly` + day lists, and plural `on Mondays and Thursdays`.
    - Test phrases: `"gym every mon wed fri at 7am"`, `"trash out every mon, wed, and fri"`, `"standup weekly mon wed fri at 9am"`, `"review on mondays and thursdays"`
15. **Title cleanup around idioms, possessives, `'s`, `remind me to`, and decimal section numbers**: Whether these phrases should stay untouched or absorb surrounding glue words (`before`, `'s`, `to`).
    - Test phrases: `"dinner with Tom and Sue tonight at 7"`, `"deep work 10-11:30am"`, `"meeting from 9 to 11 tomorrow"`, `"remind me to call mom tomorrow"`, `"email bob@example.com about tomorrow's release"`, `"read chapter 14.30 in textbook"`, `"in the sun all afternoon"`, `"friday the 13th movie night"`, `"pick up dry cleaning before 6pm"`
