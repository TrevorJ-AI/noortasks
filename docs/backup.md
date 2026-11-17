# Backup & Restore

NoorTasks supports both portable in-app exports (CSV, XLSX, Markdown) and full filesystem backups of the SQLite database and attachment files.

## In-App Exports

### Tasks Backup (23-Column CSV)

1. Open **Settings -> Account** (or **Settings -> Integrations & Import**).
2. Click **Generate Backup**.
3. Enter your passphrase if prompted for verification.
4. Your browser downloads `NoorTasks-backup-YYYYMMDD.csv`.

The exported CSV includes 23 columns:
`Folder Name`, `List Name`, `Title`, `Tags`, `Content`, `Is Check list`, `Start Date`, `Due Date`, `Reminder`, `Repeat`, `Priority`, `Status`, `Created Time`, `Completed Time`, `Order`, `Timezone`, `Is All Day`, `Is Floating`, `Column Name`, `Column Order`, `View Mode`, `taskId`, `parentId`.

### Habit & Focus Exports

In **Settings -> Integrations & Import -> Export**:

- **Habit records**: Download as `.xlsx` or `.csv` (`GET /api/v2/data/export/habits`).
- **Focus records**: Download as `.csv` or `.xlsx` (`GET /api/v2/data/export/pomodoro`).

### Single-Task Markdown Export

Individual tasks can be exported as `.md` files from the task detail/menu (`GET /api/v2/task/:id/export`).

## Restoring from a CSV Backup

1. Open **Settings -> Account** (or **Settings -> Integrations & Import**).
2. Click **Import Backups** and choose your `.csv` file.
3. Review the parsed preview counts (tasks, checklists, subtasks, lists, folders, tags, sections).
4. Click **Import**.

Tasks whose `taskId` already exists in the database are skipped safely; missing lists, folders, Kanban columns, and tags are created by name.

## Full Server Backup (SQLite + Attachments)

CSV backups cover tasks, checklists, subtasks, lists, folders, Kanban sections, and tags, **not** binary attachments, habit history, focus sessions, countdowns, calendar credentials, or comments. For complete backups, snapshot the `/data` directory.

### Scheduled Daily Backups (`NOORTASKS_DAILY_BACKUP=true`)

Automatic daily backups are **off by default**. When `NOORTASKS_DAILY_BACKUP=true` is set, the running server checks its own clock once per hour and writes one snapshot per UTC day into `NOORTASKS_BACKUP_DIR` (by default `backups/YYYY-MM-DD/` inside the data volume next to `NOORTASKS_DB`):

- Consistent online SQLite snapshots (`VACUUM INTO`) of `noortasks-system.sqlite` and each active user's database.
- A 23-column portable `tasks.csv` export per user.
- Automatic rotation keeping the **7 most recent** dated snapshots (`0700` directories, `0600` files).
- Attachment files remain in `NOORTASKS_DATA_DIR` (`/data/files`); use Option B below if you also want attachment binaries archived together.

### Option A: Online SQLite Backup (No Downtime for DB)

```bash
# Create a consistent SQLite snapshot even while WAL mode is active
sqlite3 /path/to/noortasks.sqlite ".backup '/path/to/backups/noortasks-2026-11-16.sqlite'"

# Sync attachment files
rsync -a /path/to/files/ /path/to/backups/files/
```

### Option B: Docker Volume Snapshot (Recommended)

```bash
# Stop the container briefly to flush SQLite WAL cleanly
docker compose stop noortasks

# Archive the named volume
docker run --rm \
  -v noortasks_data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine tar czf "/backup/noortasks-$(date +%F).tar.gz" -C /data .

docker compose start noortasks
```

To restore a Docker volume archive:

```bash
docker compose down
docker run --rm \
  -v noortasks_data:/data \
  -v "$PWD/backups:/backup:ro" \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/noortasks-2026-11-16.tar.gz -C /data"
docker compose up -d
```
