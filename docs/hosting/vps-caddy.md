# Deploy NoorTasks on a Plain VPS with Caddy (Automatic HTTPS)

This guide sets up NoorTasks on an Ubuntu or Debian VPS using Docker Compose bound strictly to `127.0.0.1:8099`, with [Caddy](https://caddyserver.com/) terminating automatic Let's Encrypt HTTPS on ports `80` and `443`, ending at first-run setup and phone QR pairing.

## Prerequisites

- An Ubuntu or Debian VPS with a public IPv4/IPv6 address and root or `sudo` access.
- A DNS `A` (and optional `AAAA`) record pointing your subdomain (for example `tasks.example.com`) to the VPS IP ([Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)).

## Step-by-Step Deployment

1. **Open only SSH, HTTP, and HTTPS in the firewall** ([Caddy Automatic HTTPS](https://caddyserver.com/docs/automatic-https)):

   ```bash
   sudo ufw allow 22/tcp
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw enable
   ```

   Do **not** open port `8099` publicly; Caddy will proxy local traffic over `127.0.0.1:8099`.

2. **Install Docker Engine and the Docker Compose plugin** ([Install Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Install Docker Compose](https://docs.docker.com/compose/install/)):

   Follow Docker's official `apt` repository steps for Ubuntu/Debian, then verify `docker compose version` works.

3. **Download `docker-compose.yml` and bind NoorTasks to loopback with proxy flags** ([Configuration Reference](../configuration.md), [Install Guide](../install.md)):

   ```bash
   mkdir -p ~/noortasks && cd ~/noortasks
   curl -O https://raw.githubusercontent.com/TrevorJ-AI/noortasks/main/docker-compose.yml
   ```

   Update `docker-compose.yml` so container port `8099` binds only to `127.0.0.1` and proxy flags are enabled (or use a `compose.override.yml` if running Docker Compose 2.24+ with `!override`):

   ```yaml
   # Inside services.noortasks in docker-compose.yml:
       ports:
         - "127.0.0.1:8099:8099"
       environment:
         NOORTASKS_SECURE_COOKIES: "true"
         NOORTASKS_TRUST_PROXY: "true"
         # Optional: daily SQLite + CSV snapshots in /data/backups (keeps 7 days)
         NOORTASKS_DAILY_BACKUP: "true"
   ```

   Start the container (leaving `NOORTASKS_PASSPHRASE` unset for browser first-run setup):

   ```bash
   docker compose up -d
   curl -fsS http://127.0.0.1:8099/healthz
   ```

4. **Install Caddy** ([Caddy Install docs](https://caddyserver.com/docs/install#debian-ubuntu-raspbian)):

   ```bash
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update
   sudo apt install -y caddy
   ```

   Installing the package registers and starts the `caddy` systemd service automatically.

5. **Configure `/etc/caddy/Caddyfile` for automatic HTTPS reverse proxy** ([Reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy), [`reverse_proxy` directive](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)):

   Replace `/etc/caddy/Caddyfile` (matching [`docs/hosting/Caddyfile`](Caddyfile) with your domain):

   ```caddyfile
   tasks.example.com {
       reverse_proxy 127.0.0.1:8099
   }
   ```

   Caddy forwards `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host` automatically and obtains/renews TLS certificates when ports `80` and `443` reach your server.

6. **Validate and reload Caddy** ([Caddy Install docs](https://caddyserver.com/docs/install#debian-ubuntu-raspbian), [Reverse proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy)):

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   curl -fsS https://tasks.example.com/healthz
   ```

## First-Run Setup & QR Phone Pairing

1. Open `https://tasks.example.com/` in your browser. With a fresh `noortasks_data` volume, NoorTasks opens the one-time **Set up NoorTasks** page.
2. Enter a **Server name** and create the first admin account (email and 8+ character password, or **Sign in with Google** if OIDC is configured in `/data/config.json`). Submitting locks `/setup` and `/api/setup` permanently.
3. NoorTasks shows the **Pair your phone** panel with a QR code encoding `https://tasks.example.com/#pair=<token>` (single-use, 10-minute expiry):
   - **Android app**: Open NoorTasks on Android, tap **Scan QR code**, and scan the QR ([Android Guide](../android.md)).
   - **Another browser / iPhone PWA**: Click **Copy link** and open it in Safari, then choose **Share -> Add to Home Screen** ([iPhone & iPad Guide](../iphone.md)).
   - To pair another device later, open **Settings -> Account -> Pair phone or browser**.
