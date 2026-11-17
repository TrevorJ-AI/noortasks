# Deploy NoorTasks on Coolify

This guide deploys NoorTasks on a self-hosted [Coolify](https://coolify.io/) server using Docker Compose, Coolify's built-in Traefik HTTPS proxy, a persistent `/data` volume, the one-time setup page, and QR phone pairing.

## Prerequisites

- A running Coolify v4 instance ([Coolify Installation docs](https://coolify.io/docs/get-started/installation)).
- Inbound TCP ports `80` and `443` open on the server firewall, and a DNS `A` / `AAAA` record (for example `tasks.example.com`) pointing to your Coolify server ([Coolify Domains docs](https://coolify.io/docs/core/networking/domains)).

## Why Use `coolify.compose.yml` Instead of Publishing `ports:`

Coolify's Docker Compose docs recommend **not** publishing `ports:` on proxy-routed services so traffic flows through Traefik over HTTPS instead of exposing plain HTTP port `8099` on the host ([Coolify Docker Compose docs](https://coolify.io/docs/services/configuration/docker-compose)). The repository provides [`docs/hosting/coolify.compose.yml`](coolify.compose.yml) with `expose: ["8099"]`, `NOORTASKS_SECURE_COOKIES: "true"`, and `NOORTASKS_TRUST_PROXY: "true"`.

## Step-by-Step Deployment

1. **Create a Docker Compose resource** ([Coolify Docker Compose docs](https://coolify.io/docs/services/configuration/docker-compose)):
   - In Coolify, open your **Project -> Environment**, click **+ New**, and choose **Docker Compose** (either paste [`docs/hosting/coolify.compose.yml`](coolify.compose.yml), or connect your fork/repository and point to `docs/hosting/coolify.compose.yml` as the Compose file).

2. **Verify persistent storage** ([Coolify Persistent Storage](https://coolify.io/docs/core/persistent-storage/storage-mounts/overview)):
   - Coolify parses `noortasks_data:/data` automatically under **Configuration -> Persistent Storage** and prefixes the Docker volume name per resource.
   - `user: "1000:1000"` in [`coolify.compose.yml`](coolify.compose.yml) matches the `node` user inside [`Dockerfile`](../../Dockerfile), so `/data` is writable immediately.

3. **Configure the HTTPS domain** ([Coolify Domains docs](https://coolify.io/docs/core/networking/domains), [Environment & Magic Variables](https://coolify.io/docs/services/configuration/docker-compose)):
   - Open the `noortasks` service settings in Coolify and set **Domains** to `https://tasks.example.com:8099` (the `:8099` suffix tells Traefik to proxy HTTPS to container port `8099`).
   - Confirm `NOORTASKS_SECURE_COOKIES=true` and `NOORTASKS_TRUST_PROXY=true` are present in **Environment Variables** ([Configuration Reference](../configuration.md)).
   - Optionally enable `NOORTASKS_DAILY_BACKUP=true` ([Backup & Restore](../backup.md)) or `NOORTASKS_AUTO_VAPID=true` + `NOORTASKS_VAPID_FILE=/data/vapid.json` + `NOORTASKS_VAPID_SUBJECT=mailto:admin@example.com` for Web Push.
   - Leave `NOORTASKS_PASSPHRASE` unset so first boot opens the browser setup wizard.

4. **Deploy and verify health** ([Coolify Docker Compose docs](https://coolify.io/docs/applications/builds/docker-compose)):
   - Click **Deploy**. Coolify pulls `ghcr.io/trevorj-ai/noortasks:latest`, waits for the container `/healthz` check, and provisions a Let's Encrypt TLS certificate via Traefik.
   - Confirm `https://tasks.example.com/healthz` returns `{"ok":true}`.

## First-Run Setup & QR Phone Pairing

1. Open `https://tasks.example.com/` in your browser. On an empty `/data` volume, NoorTasks opens the one-time **Set up NoorTasks** page.
2. Enter a **Server name** and create the first admin account (email and 8+ character password, or **Sign in with Google** when `/data/config.json` provides OIDC). Submitting locks `/setup` and `/api/setup` permanently.
3. NoorTasks shows the **Pair your phone** panel with a QR code encoding `https://tasks.example.com/#pair=<token>` (single-use, 10-minute expiry):
   - **Android app**: Open NoorTasks on Android, tap **Scan QR code**, and scan the QR ([Android Guide](../android.md)).
   - **Another browser / iPhone PWA**: Click **Copy link** and open it in Safari, then choose **Share -> Add to Home Screen** ([iPhone & iPad Guide](../iphone.md)).
   - To generate another pairing code later, open **Settings -> Account -> Pair phone or browser**.
