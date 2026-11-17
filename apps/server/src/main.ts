import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateAiConfig, type AiConfig } from "./ai.js";
import { loadCalendarOAuthConfig } from "./calendar-adapters.js";
import { loadVapidKeys } from "./reminders.js";
import { buildServer, loadServerConfig } from "./server.js";

/**
 * Environment:
 *   NOORTASKS_DB            sqlite file of the single-user data (multi-user: becomes the first admin's account)
 *   NOORTASKS_DATA_DIR      attachments folder of that account
 *   NOORTASKS_CONFIG        json config outside the repo: oidc, admins, maxUsers, passwordLogin, passphraseHash (optional on first run)
 *   NOORTASKS_SYSTEM_DB     accounts/sessions/shares database (default: next to NOORTASKS_DB)
 *   NOORTASKS_USERS_DIR     databases and files of further accounts (default: next to NOORTASKS_DB)
 *   NOORTASKS_STATIC_DIR    built web app to serve (index.html fallback for client routes)
 *   NOORTASKS_SECURE_COOKIES=true   mark cookies Secure (behind https)
 *   NOORTASKS_TRUST_PROXY=true      trust X-Forwarded-For (sign-in throttling behind a reverse proxy)
 *   NOORTASKS_DAILY_BACKUP=true     write a daily backup snapshot into NOORTASKS_BACKUP_DIR (keep 7, default off)
 *   NOORTASKS_BACKUP_DIR            folder for daily backup snapshots (default: backups/ next to NOORTASKS_DB)
 *   NOORTASKS_VAPID_FILE, NOORTASKS_CALENDAR_OAUTH_FILE, HOST (default 127.0.0.1), PORT (default 8099)
 * `--no-auth` runs one account without sign-in (local development and the end-to-end suite).
 */
const noAuth = process.argv.includes("--no-auth");
const env = process.env;
const flag = (v: string | undefined): boolean => v === "true" || v === "1";
const dbPath = env.NOORTASKS_DB;
const dataDir = env.NOORTASKS_DATA_DIR;
if (!dbPath || !dataDir) {
  console.error("set NOORTASKS_DB and NOORTASKS_DATA_DIR");
  process.exit(2);
}
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
const configPath = env.NOORTASKS_CONFIG ?? "";
const config = noAuth || !configPath || !existsSync(configPath) ? undefined : loadServerConfig(configPath);
let noAuthAi: AiConfig | undefined;
if (noAuth && configPath && existsSync(configPath)) {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { ai?: unknown };
  if (parsed.ai !== undefined) noAuthAi = validateAiConfig(parsed.ai);
}
const vapid = env.NOORTASKS_VAPID_FILE ? loadVapidKeys(env.NOORTASKS_VAPID_FILE) : undefined;
const calendarOAuth = env.NOORTASKS_CALENDAR_OAUTH_FILE ? loadCalendarOAuthConfig(env.NOORTASKS_CALENDAR_OAUTH_FILE) : undefined;
const secureCookies = flag(env.NOORTASKS_SECURE_COOKIES);

const srv = await buildServer({
  dbPath,
  dataDir,
  noAuth,
  ...(env.NOORTASKS_SETUP_TOKEN ? { setupToken: env.NOORTASKS_SETUP_TOKEN } : {}),
  ...(config ? { config } : {}),
  ...(env.NOORTASKS_SYSTEM_DB ? { systemDbPath: env.NOORTASKS_SYSTEM_DB } : {}),
  ...(env.NOORTASKS_USERS_DIR ? { usersDir: env.NOORTASKS_USERS_DIR } : {}),
  ...(env.NOORTASKS_STATIC_DIR ? { staticDir: env.NOORTASKS_STATIC_DIR } : {}),
  ...(flag(env.NOORTASKS_DAILY_BACKUP)
    ? {
        dailyBackup: {
          enabled: true,
          ...(env.NOORTASKS_BACKUP_DIR ? { backupDir: env.NOORTASKS_BACKUP_DIR } : {}),
        },
      }
    : {}),
  secureCookies,
  trustProxy: flag(env.NOORTASKS_TRUST_PROXY),
  logger: true,
  common: {
    secureCookies,
    ...(vapid ? { vapid } : {}),
    ...(calendarOAuth ? { calendarOAuth } : {}),
    ...(noAuthAi ? { ai: noAuthAi } : {}),
  },
});
const { app } = srv;
if (vapid) {
  const timer = setInterval(() => {
    for (const b of srv.apps()) void b.reminders.dispatchDue().catch((err) => app.log.error({ err }, "push dispatch failed"));
  }, 30_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}
await app.listen({ host: env.HOST ?? "127.0.0.1", port: Number(env.PORT ?? 8099) });
