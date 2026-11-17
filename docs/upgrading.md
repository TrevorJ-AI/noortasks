# Upgrading NoorTasks

Always back up your SQLite database and attachments before upgrading (`docs/backup.md`).

## Schema & Data Compatibility

On startup, `apps/server` runs `CREATE TABLE IF NOT EXISTS` statements across its SQLite store (`apps/server/src/store.ts`). Because data is stored in persistent volumes (`/data/noortasks.sqlite` and `/data/files`), upgrading the container or code preserves your existing records.

Review [CHANGELOG.md](../CHANGELOG.md) and release notes before jumping across minor or major versions for any new environment variables or breaking changes.

## Upgrading Docker Compose

1. Create a pre-upgrade snapshot of `noortasks_data` (see [docs/backup.md](backup.md)).
2. Pull the new image tag (pinned tags like `ghcr.io/TrevorJ-AI/noortasks:0.1.1` are safer than `:latest`):

   ```bash
   docker compose pull
   docker compose up -d
   ```

3. Verify the container passes its healthcheck:

   ```bash
   docker compose ps
   docker compose logs --tail=50 noortasks
   ```

## Upgrading Bare Node.js Installs

1. Back up `NOORTASKS_DB` and `NOORTASKS_DATA_DIR`.
2. Stop the running NoorTasks service.
3. Pull the target release tag and rebuild:

   ```bash
   git fetch --tags
   git checkout v0.1.1
   pnpm install --frozen-lockfile
   pnpm --filter @noortasks/quickadd build
   pnpm --filter @noortasks/web build
   ```

4. Restart the server (`systemctl restart noortasks` or your process manager) and verify logs.

## Upgrading the Android APK

1. Download the matching release APK from [GitHub Releases](https://github.com/TrevorJ-AI/noortasks/releases).
2. Install it over the existing app (`adb install -r ...` or tap the APK on your device). Your saved server URL and offline IndexedDB cache remain intact across same-key debug builds.
