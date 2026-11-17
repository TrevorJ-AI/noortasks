# Deploy NoorTasks on Railway

This guide deploys NoorTasks on [Railway](https://railway.com/) with persistent SQLite storage, HTTPS, the one-time browser setup page, and phone QR pairing.

> [!NOTE]
> **Config format status (verified against Railway docs):** Railway deprecated `railway.json` / `railway.toml` ("Config as Code") in favor of **Infrastructure as Code** (`.railway/railway.ts`). New services cannot opt into Config as Code, and legacy `railway.json` support ends on **December 1, 2026** ([Config as Code docs](https://docs.railway.com/config-as-code), [Infrastructure as Code docs](https://docs.railway.com/iac)). This repository ships [`.railway/railway.ts`](../../.railway/railway.ts) instead of `railway.json`.

## Plans & Storage Limits

Railway's Free trial gives a one-time $5 credit for 30 days, and the Free plan includes $1/month of usage credit with up to 0.5 GB of volume storage (Hobby is $5/month including $5 usage credit and up to 5 GB volume storage) ([Railway Plans](https://docs.railway.com/pricing/plans), [Volumes](https://docs.railway.com/volumes)).

## Option A: Deploy via Railway IaC (`.railway/railway.ts`)

1. **Install and authenticate the Railway CLI** ([Railway IaC](https://docs.railway.com/iac)):

   ```bash
   git clone https://github.com/TrevorJ-AI/noortasks.git
   cd noortasks
   railway login
   ```

2. **Initialize and link a Railway project** ([Railway IaC](https://docs.railway.com/iac)):

   ```bash
   railway init
   ```

   Inspect [`.railway/railway.ts`](../../.railway/railway.ts) and adjust `region` (for example `"us-west2"` or `"europe-west4"`) and `sizeMB` (up to `512` on the Free plan) if needed. The file sets:
   - `source: image("ghcr.io/trevorj-ai/noortasks:latest")`
   - `volumeMounts: { "/data": dataVolume }` ([Volumes](https://docs.railway.com/volumes))
   - `RAILWAY_RUN_UID: "0"` so the container can write to Railway's root-mounted volume ([Volumes & Permissions](https://docs.railway.com/volumes))
   - `healthcheckPath: "/healthz"` ([Deployments & Healthchecks](https://docs.railway.com/config-as-code))
   - `NOORTASKS_SECURE_COOKIES: "true"` and `NOORTASKS_TRUST_PROXY: "true"` behind Railway's HTTPS edge proxy ([Configuration Reference](../configuration.md))

3. **Preview and apply the configuration** ([Railway IaC](https://docs.railway.com/iac)):

   ```bash
   railway config plan
   railway config apply
   ```

4. **Generate a public HTTPS domain** ([Public Networking](https://docs.railway.com/public-networking)):

   In the Railway dashboard, open the `noortasks` service -> **Settings -> Networking -> Public Networking**, click **Generate Domain** (for a `*.up.railway.app` HTTPS URL) or attach a custom domain, and select port `8099`. Railway provisions TLS automatically.

## Option B: Deploy from the Railway Dashboard (No CLI)

1. **Create a service from Docker image or GitHub** ([Railway Templates & Services](https://docs.railway.com/templates)):
   - In a new Railway project, choose **Deploy -> Docker Image** and enter `ghcr.io/trevorj-ai/noortasks:latest` (or choose **GitHub Repo** pointing to `TrevorJ-AI/noortasks`, which builds [`Dockerfile`](../../Dockerfile) automatically).

2. **Attach a persistent volume at `/data`** ([Volumes](https://docs.railway.com/volumes)):
   - Right-click the service on the canvas -> **Attach Volume**, and set the mount path to `/data`.

3. **Set service environment variables** ([Variables](https://docs.railway.com/build-and-deploy/variables), [Volumes](https://docs.railway.com/volumes), [Configuration Reference](../configuration.md)):

   ```text
   HOST=0.0.0.0
   PORT=8099
   RAILWAY_RUN_UID=0
   NOORTASKS_DB=/data/noortasks.sqlite
   NOORTASKS_DATA_DIR=/data/files
   NOORTASKS_CONFIG=/data/config.json
   NOORTASKS_STATIC_DIR=/app/apps/web/dist
   NOORTASKS_SECURE_COOKIES=true
   NOORTASKS_TRUST_PROXY=true
   TZ=UTC
   ```

   Optional extras inside `/data`:
   - `NOORTASKS_DAILY_BACKUP=true` for automatic daily SQLite + CSV snapshots in `/data/backups` (keeps 7 days; [Backup & Restore](../backup.md)).
   - `NOORTASKS_AUTO_VAPID=true`, `NOORTASKS_VAPID_FILE=/data/vapid.json`, and `NOORTASKS_VAPID_SUBJECT=mailto:admin@example.com` for Web Push reminders.

   Leave `NOORTASKS_PASSPHRASE` unset so the container boots into the browser first-run setup page.

4. **Set the health check and public HTTPS domain** ([Public Networking](https://docs.railway.com/public-networking)):
   - Under **Settings -> Deploy**, set **Healthcheck Path** to `/healthz`.
   - Under **Settings -> Networking -> Public Networking**, click **Generate Domain** targeting port `8099`.

## Optional: Save as a Personal Railway Template

If you want a one-click clone button for your own workspace, run `railway templates create` from the linked project or open **Workspace Settings -> Templates** in the Railway dashboard ([Templates docs](https://docs.railway.com/templates)).

## First-Run Setup & QR Phone Pairing

1. Open `https://<your-railway-domain>/healthz` and confirm it returns `{"ok":true}`.
2. Open `https://<your-railway-domain>/` in your browser. Because `/data/config.json` does not exist yet, NoorTasks opens the one-time **Set up NoorTasks** page.
3. Enter a **Server name** and create the first admin account (email and 8+ character password, or **Sign in with Google** if OIDC is configured in `/data/config.json`). Once submitted, `/setup` and `/api/setup` are permanently locked.
4. NoorTasks displays the **Pair your phone** panel with a QR code encoding `https://<your-railway-domain>/#pair=<token>` (single-use, valid for 10 minutes):
   - **Android app**: Open NoorTasks on Android, tap **Scan QR code**, and scan the screen to configure the server URL and sign in ([Android Guide](../android.md)).
   - **Another browser / iPhone PWA**: Click **Copy link** (or scan the link) to open it in Safari, then choose **Share -> Add to Home Screen** ([iPhone & iPad Guide](../iphone.md)).
   - To pair another device later, open **Settings -> Account -> Pair phone or browser**.
