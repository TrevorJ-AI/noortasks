# Installing NoorTasks

You can run NoorTasks using Docker (recommended for self-hosting) or directly with Node.js 22+.

For a server on your own Windows or Linux computer with a tray app and phone
pairing, see the [desktop hub guide](desktop.md).

## Option 1: Docker Compose (Recommended)

1. Download [docker-compose.yml](../docker-compose.yml) into an empty directory:

   ```bash
   mkdir -p ~/noortasks && cd ~/noortasks
   curl -O https://raw.githubusercontent.com/TrevorJ-AI/noortasks/main/docker-compose.yml
   ```

2. Start the container:

   ```bash
   docker compose up -d
   ```

3. Open `http://localhost:8099` (or your HTTPS reverse-proxy URL) to complete the one-time first-run setup:

   - Enter a server name and create the first admin account (email and password, or **Sign in with Google** when `/data/config.json` configures OIDC).
   - Scan the pairing QR code from the NoorTasks Android app (or open the pairing link in another browser). The pairing token works once and expires after 10 minutes.
   - Once setup completes, the `/setup` page is permanently locked and unreachable.

   For headless first boot instead of browser setup, set `NOORTASKS_PASSPHRASE` (at least 8 characters) on the first start; the entrypoint hashes it with `scrypt` into `/data/config.json` (`0600` permissions) inside `noortasks_data`, and you can unset it afterwards.

### Optional Web Push inside Docker

Uncomment these lines in `docker-compose.yml` to generate VAPID keys automatically on first start:

```yaml
NOORTASKS_VAPID_FILE: "/data/vapid.json"
NOORTASKS_AUTO_VAPID: "true"
NOORTASKS_VAPID_SUBJECT: "mailto:admin@example.com"
```

### Optional Daily Backups inside Docker

Automatic daily backups are off by default. Set `NOORTASKS_DAILY_BACKUP: "true"` in `docker-compose.yml` (or `-e NOORTASKS_DAILY_BACKUP=true` with `docker run`) to have the running server write a daily snapshot on its own clock into `/data/backups/YYYY-MM-DD/` (consistent SQLite copies plus 23-column CSV exports) and keep the 7 most recent days. See [backup.md](backup.md) for details.

## Option 2: `docker run`

```bash
docker run -d \
  --name noortasks \
  --restart unless-stopped \
  -p 8099:8099 \
  -v noortasks_data:/data \
  ghcr.io/TrevorJ-AI/noortasks:latest
```

Then open `http://localhost:8099` (or your HTTPS URL) to run the one-time setup wizard.

## Option 3: Bare Node.js 22+

### Prerequisites

- Node.js 22+ (required for built-in `node:sqlite`)
- pnpm 11+ (`corepack enable && corepack prepare pnpm@11.12.0 --activate`)

### Build & Configure

```bash
git clone https://github.com/TrevorJ-AI/noortasks.git
cd noortasks

pnpm install --frozen-lockfile
pnpm --filter @noortasks/quickadd build
pnpm --filter @noortasks/web build

mkdir -p /var/lib/noortasks/files
chmod 700 /var/lib/noortasks /var/lib/noortasks/files

# Optional: generate Web Push VAPID keys
pnpm --filter @noortasks/server cli -- generate-vapid /var/lib/noortasks/vapid.json --subject mailto:admin@example.com
```

If you prefer headless configuration instead of the browser setup page, create `/var/lib/noortasks/config.json` beforehand with `hash-passphrase` or OIDC settings (see [multi-user.md](multi-user.md)):

```bash
pnpm --filter @noortasks/server cli -- hash-passphrase /var/lib/noortasks/config.json
```

### Run

```bash
NOORTASKS_DB=/var/lib/noortasks/noortasks.sqlite \
NOORTASKS_DATA_DIR=/var/lib/noortasks/files \
NOORTASKS_CONFIG=/var/lib/noortasks/config.json \
NOORTASKS_VAPID_FILE=/var/lib/noortasks/vapid.json \
NOORTASKS_STATIC_DIR="$PWD/apps/web/dist" \
HOST=127.0.0.1 \
PORT=8099 \
pnpm --filter @noortasks/server start
```

For local development without authentication, pass `--no-auth`:

```bash
NOORTASKS_DB=/tmp/noortasks-dev/db.sqlite \
NOORTASKS_DATA_DIR=/tmp/noortasks-dev/files \
PORT=8099 \
pnpm --filter @noortasks/server start -- --no-auth
```

## Reverse Proxy & TLS

Service workers, Web Push notifications, and `Secure` cookies require HTTPS outside `localhost`. Place NoorTasks behind Caddy, Nginx, or Traefik, or access it over a private VPN with HTTPS certificates.

Example Caddyfile:

```caddyfile
tasks.example.com {
    reverse_proxy 127.0.0.1:8099
}
```

When serving over HTTPS behind a reverse proxy, set `NOORTASKS_SECURE_COOKIES=true` and `NOORTASKS_TRUST_PROXY=true`. See [docs/configuration.md](configuration.md) for all options, or follow a platform guide under `docs/hosting/`:

- [Railway](hosting/railway.md)
- [Coolify](hosting/coolify.md)
- [Fly.io](hosting/fly.md)
- [Plain VPS with Caddy](hosting/vps-caddy.md)
