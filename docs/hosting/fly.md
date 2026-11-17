# Deploy NoorTasks on Fly.io

This guide deploys NoorTasks on [Fly.io](https://fly.io/) with a persistent Fly Volume for SQLite and attachments, forced HTTPS, health checks, the one-time setup page, and phone QR pairing.

## Pricing Note

Fly.io discontinued its Hobby, Launch, and Scale plans for new organizations on **October 7, 2024**; new accounts use **Pay As You Go** with a short introductory trial and no ongoing free tier ([Fly.io Pricing](https://fly.io/docs/about/pricing/)).

## Step-by-Step Deployment

1. **Install `flyctl` and sign in** ([Install flyctl](https://fly.io/docs/flyctl/install/)):

   ```bash
   curl -L https://fly.io/install.sh | sh
   fly auth login
   ```

2. **Copy [`docs/hosting/fly.toml`](fly.toml) and choose a unique app name and region** ([App Configuration (`fly.toml`)](https://fly.io/docs/reference/configuration/)):

   ```bash
   mkdir -p ~/noortasks-fly && cd ~/noortasks-fly
   curl -o fly.toml https://raw.githubusercontent.com/TrevorJ-AI/noortasks/main/docs/hosting/fly.toml
   ```

   Edit `fly.toml`:
   - Set `app` to a globally unique Fly app name (for example `"noortasks-example"`).
   - Set `primary_region` to a nearby Fly region (such as `ams`, `iad`, `fra`, or `lhr`).
   - Decide on `min_machines_running` inside `[http_service]`:
     - Keep `min_machines_running = 1` if you want Web Push reminders (`NOORTASKS_VAPID_FILE`) or scheduled daily backups (`NOORTASKS_DAILY_BACKUP=true`) to fire while no browser is open.
     - Set `min_machines_running = 0` to let Fly Proxy stop the Machine when idle and wake it on incoming requests ([App Configuration (`fly.toml`)](https://fly.io/docs/reference/configuration/)).

   > [!NOTE]
   > Fly Volumes are bound 1:1 to a single Machine in `primary_region`, and Fly sets mount ownership based on the `USER node` directive in [`Dockerfile`](../../Dockerfile) ([Fly Volumes Overview](https://fly.io/docs/volumes/overview/)). The `[[vm]]` block allocates `512mb` RAM so Node.js 22 and SQLite online backups have comfortable headroom.

3. **Launch the app without deploying yet, or deploy directly** ([Fly Launch](https://fly.io/docs/launch/), [App Configuration (`fly.toml`)](https://fly.io/docs/reference/configuration/)):

   ```bash
   fly apps create <your-app-name>
   ```

   Optionally set Web Push or daily backup flags before deploying ([Configuration Reference](../configuration.md)):

   ```bash
   fly secrets set NOORTASKS_DAILY_BACKUP=true NOORTASKS_AUTO_VAPID=true NOORTASKS_VAPID_FILE=/data/vapid.json NOORTASKS_VAPID_SUBJECT=mailto:admin@example.com
   ```

   Leave `NOORTASKS_PASSPHRASE` unset so first boot opens the browser setup wizard.

4. **Deploy the container and initialize the `/data` volume** ([Fly Launch](https://fly.io/docs/launch/), [Fly Volumes](https://fly.io/docs/volumes/overview/)):

   ```bash
   fly deploy
   ```

   On the first deploy, `initial_size = "1gb"` in `[[mounts]]` provisions the `noortasks_data` volume at `/data`, pulls `ghcr.io/trevorj-ai/noortasks:latest`, and waits for `GET /healthz` before routing traffic. Check status with `fly status` and `https://<your-app-name>.fly.dev/healthz`.

## First-Run Setup & QR Phone Pairing

1. Open `https://<your-app-name>.fly.dev/` in your browser. On a fresh `/data` volume, NoorTasks opens the one-time **Set up NoorTasks** page.
2. Enter a **Server name** and create the first admin account (email and 8+ character password, or **Sign in with Google** if configured in `/data/config.json`). Submitting permanently locks `/setup` and `/api/setup`.
3. NoorTasks shows the **Pair your phone** panel with a QR code encoding `https://<your-app-name>.fly.dev/#pair=<token>` (single-use, expires in 10 minutes):
   - **Android app**: Open NoorTasks on Android, tap **Scan QR code**, and scan the QR ([Android Guide](../android.md)).
   - **Another browser / iPhone PWA**: Click **Copy link** and open it in Safari, then choose **Share -> Add to Home Screen** ([iPhone & iPad Guide](../iphone.md)).
   - To pair additional devices later, open **Settings -> Account -> Pair phone or browser**.
