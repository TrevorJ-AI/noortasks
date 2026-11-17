# Importing Your Data

NoorTasks imports tasks directly in your browser using a shared client-side pipeline. Before anything is written, you see a **preview screen** with item counts (tasks, open, completed, won't do, checklists, subtasks, lists, folders, tags, and sections) and an explicit **loss report** listing anything in the source file that could not be carried over.

Imports create local tasks in IndexedDB with **deterministic IDs** derived from the source name and source ID, then sync through the normal outbox to your self-hosted server (even if you start an import offline). Re-importing the same file skips already-imported tasks so nothing duplicates. Except when you explicitly paste a temporary Microsoft Graph access token in your browser for Microsoft To Do, NoorTasks never asks for third-party account credentials or makes server-side calls to external services.

Open **Settings -> Integrations & Import** (or **Settings -> Account -> Import Backups**) to run any importer.

---

## 1. NoorTasks / TickTick Backup CSV

### How to Export
- **NoorTasks**: Open **Settings -> Account** (or **Settings -> Integrations & Import**), click **Generate Backup**, verify your passphrase if prompted, and save the `.csv` file.
- **TickTick**: Open **Settings -> Backup -> Generate Backup** in TickTick Web or Desktop and save the `.csv` file.

### What Carries Over
- Folders (`Folder Name`), lists (`List Name`, `View Mode`: `list`, `kanban`, `timeline`; `Inbox` maps to Inbox), and Kanban sections (`Column Name`, `Column Order`).
- Tasks and nested subtasks (`parentId`, up to 5 levels deep), sort order (`Order`), created/completed timestamps, priority (`0`, `1`, `3`, `5` or `Low`/`Medium`/`High`), and status (`Open`, `Completed`, `Won't Do` including legend `0 Normal, 1 Completed, 2 Archived`).
- Checklists (`Is Check list = Y` or `Kind = CHECKLIST`) and notes (`Kind = NOTE` when present).
- Dates, times, `Is All Day`, `Is Floating`, `Timezone`, valid `TRIGGER` reminders, valid `Repeat` (`RRULE` / `LUNAR` / `ERULE`) strings, and normalized tags.
- Existing `taskId` values are preserved so re-importing skips existing tasks cleanly.

### What Is Lost
- Binary attachments, comments, activity history, habits, focus timer sessions, countdowns, smart filters, and external calendar bindings (not included in backup CSV files).
- Standard 23-column exports without a `Kind` column flatten `NOTE` rows to `TEXT`.
- Any invalid reminder trigger strings, unsupported recurrence rules, or subtask links deeper than 5 levels / crossing lists are listed in the loss report.

### Scripting API Endpoint
Authenticated sessions can also upload a backup CSV directly to `POST /api/v1/import/restore` as `multipart/form-data` (field `file`), `text/csv` raw body, or JSON `{ "csv": "..." }` (requires session cookie `t` and `X-Csrftoken` header).

---

## 2. Todoist

### How to Export
- **Project CSV**: Open a project in Todoist, open the project menu (`...`), and choose **Import & export -> Export to CSV** (paid plans also include per-project CSVs inside ZIP backups).
- **JSON backup (Sync API)**: If you exported a Sync API JSON snapshot (`{ projects, sections, items, labels, notes }`), select that `.json` file directly.

### What Carries Over
- **Lists & sections**: Project CSV creates a list named from the filename (stripping any trailing `[id]` suffix; `Inbox` maps to Inbox) and imports `TYPE=section` rows as Kanban sections. JSON backups import all active projects, sections, and colors.
- **Tasks & subtasks**: `INDENT` levels (`1`, `2`, ...) in CSV and `parent_id` in JSON reconstruct subtask hierarchy (up to 5 levels).
- **Priorities**: CSV priorities (`1` urgent -> High, `2` -> Medium, `3` -> Low, `4` -> None) and JSON API priorities (`4` -> High, `3` -> Medium, `2` -> Low, `1` -> None).
- **Dates, timezones, and duration**: `DATE` + `TIMEZONE` (`America/New_York`, `Europe/Amsterdam`, etc.) and `DURATION` (minutes or days on timed/all-day tasks) map to `startDate`, `dueDate`, `isAllDay`, and `timeZone`.
- **Recurrence**: English recurrence phrases (`every day`, `every! 3 days`, `every 2 weeks on Monday, Wednesday at 9am`, `every 2nd Tuesday`, `every last day`, `every workday`, `every year on March 4`, etc.) convert via `packages/recurrence` to `RRULE` strings (`every!` sets completion-based mode).
- **Tags & notes**: Inline `@label` tokens and `LABELS` / `labels` arrays create normalized tags; `DESCRIPTION` / `description` maps to task notes.

### What Is Lost
- **Completed tasks in CSV**: Todoist project CSV exports do not include completed tasks (JSON backups do carry `checked` items).
- **Recurrence original start dates in CSV**: CSV exports omit the original start date of repeating tasks, so recurring tasks without `starting ...` are anchored to the import date and noted in the loss report.
- **Comments (`TYPE=note` / `notes`)**: Merged into task notes as plain text; comment timestamps and authors are not preserved separately.
- **Attachments, assignees, and separate deadlines**: File attachments on comments and `RESPONSIBLE` / `AUTHOR` assignee fields cannot be carried over. Separate `DEADLINE` values (when `DATE` is also present) are appended to task notes.
- **Unsupported recurrences**: Sub-day repeats (`every 3 hours`), non-English recurrence expressions (`DATE_LANG` other than English), or unrecognized patterns are skipped and listed in the loss report.

---

## 3. Generic CSV

### How to Export
Export a `.csv` file from any spreadsheet or task tracker with a header row in the first line.

### What Carries Over
- Interactive column mapping auto-detects common column names (`Title`, `Notes`, `List`, `Section`, `Tags`, `Priority`, `Status`, `Start Date`, `Due Date`, `Time Zone`, `Repeat`, `Parent`, `ID`) and lets you remap any column before importing.
- Lists, Kanban sections, tags, priorities (`High`/`Medium`/`Low`/`None` or `p1`-`p4`), statuses (`Open`, `Completed`, `Won't Do`), dates/times with IANA or Windows timezones, parent-child links (by ID or title within the same list), and `RRULE` or English natural-language repeat expressions.

### What Is Lost
- Any CSV columns left unmapped (`(None)`) that contain non-empty cells are reported by column name and value count in the loss report.
- Unrecognized date strings, unknown priority/status tokens, unsupported repeat rules, or missing parent references are listed per row.

---

## 4. todo.txt

### How to Export
Select any plain-text `.txt` file formatted according to the `todo.txt` specification.

### What Carries Over
- Completion marker `x` (`Completed`), optional completion date and creation date (`YYYY-MM-DD`).
- Priorities `(A)` -> High, `(B)` -> Medium, `(C)` -> Low, plus `pri:A/B/C` on completed tasks.
- `+project` maps the task to a list (creating it if missing; `+Inbox` maps to Inbox), and `@context` tokens become tags.
- `due:YYYY-MM-DD` and threshold/start `t:YYYY-MM-DD` set task start and due dates.
- `rec:` recurrence tokens (`rec:1d`, `rec:+1w`, `rec:2m`, `rec:1y`, `rec:1b`) convert via `packages/recurrence` (`+` uses schedule mode; without `+` uses completion mode).

### What Is Lost
- Priorities `(D)` through `(Z)` map to `None` because NoorTasks supports High, Medium, Low, and None.
- When a task lists multiple `+project` tokens, it is placed in the first `+project` and extra projects are added as tags.
- Custom `key:value` metadata tokens other than `due:`, `t:`, `rec:`, and `pri:` are saved in task notes and noted in the loss report.
- Unsupported `rec:` expressions (such as `rec:2b`) are reported in the loss report.

---

## 5. Markdown Checklists

### How to Export
Select any `.md` or `.markdown` file containing Markdown task lists (`- [ ]`, `- [x]`, `* [ ]`, `1. [ ]`).

### What Carries Over
- `# H1` headings set the target list (`# Inbox` maps to Inbox); `## H2` headings create Kanban sections inside that list.
- Checkbox states: `[ ]` -> Open, `[x]`/`[X]` -> Completed, `[-]`/`[~]` -> Won't Do.
- Nested checkbox indentation creates subtasks (up to 5 levels).
- Inline `#tag` tokens become tags; `⏫`/`🔺`/`[p1]`, `🔼`/`[p2]`, `🔽`/`[p3]` map to High/Medium/Low priorities; `📅 YYYY-MM-DD` / `@due(...)` / `due:...`, `🛫 YYYY-MM-DD` / `start:...`, and `✅ YYYY-MM-DD` map to due, start, and completed dates; `🔁 <phrase>` and `rec:<token>` convert through `packages/recurrence`.
- Indented plain lines or blockquotes directly beneath a checkbox item attach to that task's notes.

### What Is Lost
- Deep headings (`###` and below) flatten into sections; headings inside `Inbox` flatten since Inbox has no sections.
- Non-task prose paragraphs or standalone text outside checklist items are skipped and counted in the loss report.
- Unconvertible recurrence expressions or subtask nesting beyond 5 levels are listed in the loss report.

---

## 6. Microsoft To Do

### How to Export
Microsoft To Do has no built-in file export in the app UI. You can import either:
- **Graph JSON export**: Export lists and tasks (`todoTaskList` / `todoTask` JSON, including `checklistItems` and `linkedResources`) using Microsoft Graph Explorer, Power Automate, or a local export script and choose the `.json` file.
- **Browser Graph token flow**: Paste a temporary Microsoft Graph Bearer access token (with `Tasks.Read` permission) directly into the import dialog. Your browser fetches `/me/todo/lists` and task items directly from `graph.microsoft.com`; the token is never sent to or stored on your NoorTasks server.

### What Carries Over
- Lists (`defaultList` maps to Inbox; custom lists are created by name).
- Task titles, notes (`body`, converting HTML to plain text when needed), `importance` (`high`/`normal`/`low`), `status`, `categories` (as tags), `completedDateTime`, and `createdDateTime`.
- Steps (`checklistItems`) map to NoorTasks checklist items (`CHECKLIST` tasks), preserving both step status and task description (`desc`).
- `dueDateTime` and `startDateTime` with both IANA and Windows timezone names (such as `Eastern Standard Time` or `W. Europe Standard Time`).
- `reminderDateTime` (when `isReminderOn` is true) converts to relative `TRIGGER` reminders when the task has a date.
- `recurrence` (`daily`, `weekly`, `absoluteMonthly`, `relativeMonthly`, `absoluteYearly`, `relativeYearly`, `endDate`, `numbered`) converts via `packages/recurrence` to `RRULE` strings.
- `linkedResources` URLs are preserved as Markdown links inside task notes.

### What Is Lost
- File attachments (`attachments` / `hasAttachments`) cannot be carried over.
- HTML formatting in `body` is simplified to plain text.
- Non-binary To Do statuses (`inProgress`, `waitingOnOthers`, `deferred`) map to Open.
- Reminders on undated tasks, out-of-range alarm offsets, and unsupported recurrence pattern types are listed in the loss report.

---

## 7. Google Tasks

### How to Export
1. Open [Google Takeout](https://takeout.google.com/).
2. Deselect all products, then select **Tasks**.
3. Download and extract the archive, and select the `Tasks.json` file.

### What Carries Over
- Every task list (`tasks#taskLists`), task title, notes (`notes`), completion status (`needsAction` / `completed`), completion timestamp (`completed`), list position order (`position`), and one-level subtasks (`parent`).
- Due dates (`due`): Google Tasks exports date-only due values at UTC midnight (`YYYY-MM-DDT00:00:00.000Z`), which NoorTasks imports as all-day tasks on that exact calendar date in your timezone without off-by-one shifts.
- Linked item references (`links`) are appended as Markdown links inside task notes.

### What Is Lost
- Deleted tasks (`deleted: true`) in the Takeout export are skipped and listed in the loss report.
- Priorities, tags, due times of day, reminders, and recurrence do not exist in Google Tasks Takeout exports.

---

## 8. Apple Reminders

### How to Export
1. Open **Reminders** on macOS.
2. Select a reminder list and choose **File -> Export...** to save an `.ics` file (or drag reminders onto the desktop).

### What Carries Over
- List name from `X-WR-CALNAME` (or filename).
- `VTODO` tasks (and `VEVENT` entries when present in `.ics` files): `SUMMARY` (title), `DESCRIPTION` / `URL` / `LOCATION` (notes), `CATEGORIES` (tags), `PRIORITY` (`1`-`4` High, `5` Medium, `6`-`9` Low, `0` None), `STATUS` (`NEEDS-ACTION`, `COMPLETED`, `CANCELLED`), and `COMPLETED` timestamp.
- Dates and timezones (`DTSTART`, `DUE`, `VALUE=DATE` all-day, UTC `Z`, `TZID`, and `VTIMEZONE` definitions).
- `RRULE` recurrence rules (converted via `packages/recurrence`) and `EXDATE` exclusions.
- `VALARM` relative triggers (`-PT15M`, etc.) and absolute `DATE-TIME` triggers anchored to the reminder date.
- `RELATED-TO` subtask relationships when present.

### What Is Lost
- Location-based proximity triggers (`X-APPLE-STRUCTURED-LOCATION`, `X-APPLE-PROXIMITY`) cannot trigger location alerts; the place name is saved in notes and noted in the loss report.
- `ATTACH` file references, `RDATE` extra dates, multiple `RRULE` lines on one item, `RECURRENCE-ID` single-occurrence overrides, `VALARM` repeat/snooze counts, `EMAIL`/`PROCEDURE` alarms, undated alarms, and sub-day (`HOURLY`/`MINUTELY`/`SECONDLY`) or `BYHOUR`/`BYMINUTE`/`BYSECOND` rules are listed in the loss report.

---

## 9. Trello

### How to Export
1. Open the Trello board you want to export ([Atlassian Trello export guide](https://support.atlassian.com/trello/docs/exporting-data-from-trello/)).
2. Open the board menu (`...` in the top-right corner) -> **Print, Export, and Share** -> **Export to JSON**.
3. Save the `.json` file and select it in **Import from Trello** (note: CSV export in Trello is paid-only; JSON works on all plans).

### What Carries Over
- **Board & Kanban columns**: The board creates a Kanban list (`viewMode: "kanban"`) and each active Trello list becomes a Kanban section in board order (`pos`).
- **Cards, dates, and status**: Card titles (`name`), descriptions (`desc`), start/due dates (`start`, `due`), `dueComplete` -> Completed, and archived (`closed: true`) non-completed cards -> Won't Do.
- **Checklists**: Card checklists (`checklists` / `checkItems`) convert into NoorTasks `CHECKLIST` tasks with item completion state (`complete` / `incomplete`) and card description (`desc`).
- **Labels**: Board and card `labels` become tags preserving label colors (unnamed color-only labels fall back to their color name and are noted in the loss report).
- **Comments & attachment links**: `commentCard` actions merge into task notes, and attachment URLs are appended as Markdown links inside task notes.

### What Is Lost
- **1,000-action board cap & activity history**: Single-board Trello JSON exports only include the **1,000 most recent actions**; non-comment board activity history and comment authors/timestamps are not preserved separately.
- **Uploaded attachment binaries**: Binary attachment files stay on Trello; only external links (`url`) are appended to notes.
- **Members, custom fields, covers & extra board metadata**: Assigned members (`idMembers`), Power-Up / `customFieldItems`, card covers, and archived list column groupings are omitted and listed in the loss report.
- **Multiple checklists per card**: When a card has more than one checklist, items flatten into one NoorTasks checklist prefixed with `[Checklist Name]`.

---

## 10. Notion

### How to Export
1. Open your Notion database and make sure the active view shows every property column you want exported ([Notion export guide](https://www.notion.com/help/export-your-content)).
2. Click `...` in the top-right corner -> **Export** -> choose **Markdown & CSV**, then extract the downloaded `.zip` archive.
3. Select the database `.csv` file in **Import from Notion** (NoorTasks strips Notion's trailing 32-character hex ID from the filename automatically when naming the list).

### What Carries Over
- **Titles, lists, and sections**: `Name` / `Title` maps to task title, optional `List` / `Project` / `Area` columns map to lists (otherwise the cleaned filename is used), and `Section` / `Stage` / `Group` maps to Kanban sections.
- **Properties**: `Tags` / `Labels` / `Category`, `Priority`, `Notes` / `Description`, `Status` / `Done` checkboxes (`Done`/`Completed` -> Completed, `Won't do`/`Cancelled` -> Won't Do), and `Due` / `Date` / `Start` (including Notion date ranges formatted with `→`).
- **Sub-items**: `Parent item` / `Parent task` links (including Notion's `Title (https://www.notion.so/...)` relation format) reconstruct parent-child subtasks within the same list.
- **Files & media URLs**: External or exported URLs in `Files & media` are appended as Markdown links inside task notes.

### What Is Lost
- **Active view only**: Notion only exports the currently selected view's visible rows and unhidden columns; filtered-out rows and hidden properties are absent from the CSV.
- **Page body blocks & comments**: Database item body content lives in separate `.md` files inside Notion's `.zip` export rather than the `.csv`, and Notion page comments are omitted.
- **Formulas, rollups & relations**: Notion exports formulas and rollups as static text values and relations as plain page titles; extra property columns that do not map to task fields are listed under unmapped columns in the loss report.
- **Assignees & multi-parent relations**: `Assignee` / `Person` values cannot carry over; multi-value statuses like `In progress` simplify to Open; if a row lists multiple `Parent item` entries, only the first matching parent in the same list is linked.

---

## 11. Any.do

### How to Export
1. Open Any.do on the Web or Desktop ([Any.do export guide](https://support.any.do/en/articles/8635961-printing-and-exporting-items)).
2. Open **Settings -> Archived Tasks** and click **Export**.
3. Any.do emails a `.zip` containing your archived tasks as a `.csv` file. Extract the `.csv` and select it in **Import from Any.do**.
   *(Active personal lists and boards in Any.do can only be printed or saved as PDF natively, which is not a structured task export.)*

### What Carries Over
- **Archived tasks & lists**: Task titles, `Category` / `List` names, `Notes`, `Due Date` (dates, times, or timestamps), `Priority` (`High`/`Low`/`Normal`), `Status` / `Archived Date`, `Tags`, `Parent` links, `Subtasks` (converted into checklist items), and valid `Repeat` expressions.

### What Is Lost
- **Active personal tasks & boards**: Any.do's documented CSV export includes **archived tasks only**; active lists and boards are not exported as CSV or JSON by Any.do.
- **Assignees & unmapped columns**: `Assigned To` values and any non-standard columns without matching task fields are omitted and reported in the loss report.
- **Unsupported recurrences**: Any recurrence pattern not supported by `packages/recurrence` is listed in the loss report.

---

## 12. Things 3

### How to Export
Things 3 has **no built-in CSV, JSON, or todo.txt export button** in its menus ([Cultured Code: Exporting Your Data](https://culturedcode.com/things/support/articles/5766205/)). Cultured Code documents local SQLite database access (`main.sqlite` on Mac or GDPR diagnostics export on iOS), **Print to PDF**, **Share -> Copy as Text**, **Apple Shortcuts**, and **AppleScript** on macOS ([Using AppleScript](https://culturedcode.com/things/support/articles/2803572/)).

Use one of these routes to export a file that **Import from Things 3** reads directly:
- **Markdown / Copy as Text / Apple Shortcuts**: Save a `.md` checklist file (`# Project`, `## Heading`, `- [ ] Task`, nested `- [ ] Subtask`, `#tag`, `📅 YYYY-MM-DD`).
- **todo.txt via macOS AppleScript**: Export a `.txt` file using standard `todo.txt` lines (`+Project`, `@tag`, `due:YYYY-MM-DD`, `t:YYYY-MM-DD`, `rec:...`, `x ...`).
- **CSV via macOS AppleScript**: Export a `.csv` with headers `Title,Notes,Area,Project,Heading,Tags,When,Deadline,Status,Checklist`.

### What Carries Over
- **todo.txt / Markdown exports**: All fields supported by the [todo.txt](#4-todotxt) and [Markdown Checklists](#5-markdown-checklists) routes (`+Project` / `# Heading` lists, `## Heading` sections, subtasks, `@tag` / `#tag`, start/due/completion dates, checklists, and `rec:` / `🔁` repeats).
- **Things CSV exports**: `Area` (as folder when paired with `Project`, otherwise list), `Project` (as list), `Heading` (as Kanban section), `Tags`, `When` (calendar date -> start date), `Deadline` -> due date, `Status` (`open`, `completed`, `canceled` -> Won't Do), `Notes`, and `Checklist` items.

### What Is Lost
- **Direct `.thingsdatabase` / `main.sqlite` files**: NoorTasks runs importers strictly in the browser and does not read binary `main.sqlite` bundles directly.
- **`When` scheduling buckets**: Non-date Things buckets such as `Today`, `This Evening`, `Anytime`, and `Someday` cannot be stored separately and are listed in the loss report when encountered in CSV.
- **Internal Things repeats & priorities**: Things does not expose its internal SQLite recurrence rules or time-of-day reminders via Copy as Text / basic AppleScript unless written explicitly as `rec:` / `🔁` tokens, and Things has no High/Medium/Low priority field.
- **Unchecked text exports**: Plain **Copy as Text** omits notes, tags, deadlines, checklist completion states, and areas unless included by an AppleScript or Shortcut export.
