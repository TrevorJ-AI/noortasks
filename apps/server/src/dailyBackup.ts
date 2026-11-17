import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BuiltApp } from "./app.js";
import { BackupService } from "./backup.js";
import { Service } from "./service.js";
import { Store } from "./store.js";
import type { SystemStore } from "./system.js";
import type { Tenants } from "./tenants.js";

export const DEFAULT_BACKUP_RETENTION = 7;
export const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000;
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC YYYY-MM-DD directory name for a backup snapshot. */
export function formatBackupDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Keeps at most `keep` dated backup directories (YYYY-MM-DD), removing the oldest first. */
export function rotateBackups(backupDir: string, keep = DEFAULT_BACKUP_RETENTION): string[] {
  if (!existsSync(backupDir)) return [];
  const limit = Math.max(0, Math.floor(keep));
  const dirs = readdirSync(backupDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && DATE_DIR_RE.test(d.name))
    .map((d) => d.name)
    .sort();
  const deleted: string[] = [];
  while (dirs.length > limit) {
    const oldest = dirs.shift()!;
    rmSync(join(backupDir, oldest), { recursive: true, force: true });
    deleted.push(oldest);
  }
  return deleted;
}

export interface DailyBackupRunOptions {
  backupDir: string;
  sys?: SystemStore;
  tenants?: Tenants;
  single?: BuiltApp;
  retention?: number;
  now?: number;
  serverName?: string;
}

export interface DailyBackupResult {
  date: string;
  dir: string;
  deleted: string[];
}

function vacuumSqlite(db: Store["db"], destPath: string): void {
  db.prepare("vacuum into ?").run(destPath);
  chmodSync(destPath, 0o600);
}

/** Writes one consistent daily backup snapshot (SQLite VACUUM INTO + 23-column CSV) and rotates old snapshots. */
export function runDailyBackup(opts: DailyBackupRunOptions): DailyBackupResult {
  const now = opts.now ?? Date.now();
  const date = formatBackupDate(now);
  const retention = opts.retention ?? DEFAULT_BACKUP_RETENTION;
  mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });

  const stageDir = join(opts.backupDir, `.tmp-${date}-${randomBytes(4).toString("hex")}`);
  const targetDir = join(opts.backupDir, date);
  mkdirSync(stageDir, { recursive: true, mode: 0o700 });

  try {
    const userManifest: Array<{ userId: number; email: string; role: string }> = [];
    if (opts.sys && opts.tenants) {
      vacuumSqlite(opts.sys.db, join(stageDir, "noortasks-system.sqlite"));
      const usersDir = join(stageDir, "users");
      mkdirSync(usersDir, { recursive: true, mode: 0o700 });

      for (const u of opts.sys.users()) {
        if (u.status === "removed") continue;
        const uDir = join(usersDir, String(u.id));
        mkdirSync(uDir, { recursive: true, mode: 0o700 });
        const dbDest = join(uDir, "noortasks.sqlite");
        const csvDest = join(uDir, "tasks.csv");

        if (opts.tenants.isOpen(u.id)) {
          const b = opts.tenants.get(u.id);
          vacuumSqlite(b.store.db, dbDest);
          writeFileSync(csvDest, new BackupService(b.svc).exportTasksCsv(), { mode: 0o600 });
        } else if (existsSync(u.dbFile)) {
          const st = new Store(u.dbFile);
          try {
            vacuumSqlite(st.db, dbDest);
            const svc = new Service(st, { dataDir: opts.tenants.dataDirOf(u.dbFile), now: () => now });
            writeFileSync(csvDest, new BackupService(svc).exportTasksCsv(), { mode: 0o600 });
          } finally {
            st.close();
          }
        }
        userManifest.push({ userId: u.id, email: u.email, role: u.role });
      }
    } else if (opts.single) {
      vacuumSqlite(opts.single.store.db, join(stageDir, "noortasks.sqlite"));
      writeFileSync(join(stageDir, "tasks.csv"), new BackupService(opts.single.svc).exportTasksCsv(), { mode: 0o600 });
    }

    writeFileSync(
      join(stageDir, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          date,
          createdAtMs: now,
          ...(opts.serverName ? { serverName: opts.serverName } : {}),
          users: userManifest,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const prevDir = existsSync(targetDir) ? join(opts.backupDir, `.prev-${date}-${randomBytes(4).toString("hex")}`) : null;
    if (prevDir) renameSync(targetDir, prevDir);
    try {
      renameSync(stageDir, targetDir);
      if (prevDir) rmSync(prevDir, { recursive: true, force: true });
    } catch (err) {
      if (prevDir && existsSync(prevDir) && !existsSync(targetDir)) {
        try {
          renameSync(prevDir, targetDir);
        } catch {
          /* ignore rollback failure */
        }
      }
      throw err;
    }
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }

  const deleted = rotateBackups(opts.backupDir, retention);
  return { date, dir: targetDir, deleted };
}

export interface DailyBackupSchedulerOptions extends Omit<DailyBackupRunOptions, "now" | "serverName"> {
  now?: () => number;
  serverName?: () => string | undefined;
  intervalMs?: number;
  isReady?: () => boolean;
  onError?: (err: unknown) => void;
}

export interface DailyBackupScheduler {
  tick: () => DailyBackupResult | null;
  stop: () => void;
}

/** Runs daily backups on the server's own clock without external cron jobs. */
export function startDailyBackup(opts: DailyBackupSchedulerOptions): DailyBackupScheduler {
  const nowFn = opts.now ?? (() => Date.now());
  const intervalMs = opts.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
  let lastDate: string | undefined;

  const tick = (): DailyBackupResult | null => {
    try {
      if (opts.isReady && !opts.isReady()) return null;
      const curNow = nowFn();
      const date = formatBackupDate(curNow);
      if (lastDate === date && existsSync(join(opts.backupDir, date))) return null;
      const name = opts.serverName?.();
      const res = runDailyBackup({
        backupDir: opts.backupDir,
        ...(opts.sys ? { sys: opts.sys } : {}),
        ...(opts.tenants ? { tenants: opts.tenants } : {}),
        ...(opts.single ? { single: opts.single } : {}),
        ...(opts.retention !== undefined ? { retention: opts.retention } : {}),
        now: curNow,
        ...(name ? { serverName: name } : {}),
      });
      lastDate = date;
      return res;
    } catch (err) {
      opts.onError?.(err);
      return null;
    }
  };

  if (!existsSync(join(opts.backupDir, formatBackupDate(nowFn())))) {
    tick();
  }

  const timer = setInterval(() => {
    tick();
  }, intervalMs);
  timer.unref();

  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
