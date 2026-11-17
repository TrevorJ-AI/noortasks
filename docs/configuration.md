# Configuration Reference

NoorTasks reads configuration from environment variables and private JSON files stored outside the repository.

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `NOORTASKS_DB` | Yes | - | Path to the SQLite database file (created automatically in WAL mode). |
| `NOORTASKS_DATA_DIR` | Yes | - | Directory for uploaded task attachments (`0700` permissions). |
| `NOORTASKS_CONFIG` | Unless `--no-auth` or browser setup | - | Path to the sign-in config JSON (OIDC / Google, admins, member limit, optional `passphraseHash`). Optional when using the first-run browser setup page. |
| `NOORTASKS_SETUP_TOKEN` | Browser first-run setup | - | Operator-held random token of at least 32 characters, required to claim the first admin through `/setup` (password or OIDC). No token means browser admin creation is refused. Not needed when `admins` or a legacy passphrase already bootstrap an account. |
| `NOORTASKS_SYSTEM_DB` | No | next to `NOORTASKS_DB` (`noortasks-system.sqlite`) | Accounts, sessions, invite allowlist and list shares. |
| `NOORTASKS_USERS_DIR` | No | next to `NOORTASKS_DB` (`noortasks-users/`) | One folder per additional account (`<id>/data.sqlite` and `<id>/files`). |
| `NOORTASKS_DAILY_BACKUP` | No | `false` | If `true`, the running server writes a daily SQLite + CSV backup snapshot on its own clock (keeps 7 days). |
| `NOORTASKS_BACKUP_DIR` | No | `backups/` next to `NOORTASKS_DB` | Directory for scheduled daily backups when `NOORTASKS_DAILY_BACKUP=true`. |
| `NOORTASKS_OIDC_CLIENT_SECRET` | No | - | Overrides `oidc.clientSecret` from the config file (keeps the secret out of the file). |
| `NOORTASKS_STATIC_DIR` | Docker / single-port | - | Path to `apps/web/dist` when serving the web UI from the Node server. |
| `HOST` | No | `127.0.0.1` | Bind address (`0.0.0.0` in Docker). |
| `PORT` | No | `8099` | HTTP listen port (`0` selects an ephemeral port). |
| `NOORTASKS_VAPID_FILE` | No | - | Path to JSON file with `{ "publicKey", "privateKey", "subject" }` for Web Push. |
| `NOORTASKS_CALENDAR_OAUTH_FILE` | No | - | Path to JSON file with Google and/or Outlook OAuth 2.0 client credentials. |
| `NOORTASKS_GROQ_API_KEY` | No | - | Groq API key for audio attachment transcription and summarization (overrides `ai.apiKey` in config). |
| `NOORTASKS_AI_PROVIDER` | No | `groq` | AI provider name (`groq`). |
| `NOORTASKS_AI_TRANSCRIBE_MODEL` | No | `whisper-large-v3-turbo` | Overrides `ai.transcribeModel` in config. |
| `NOORTASKS_AI_SUMMARIZE_MODEL` | No | `openai/gpt-oss-120b` | Overrides `ai.summarizeModel` in config. |
| `NOORTASKS_SECURE_COOKIES` | No | `false` | Set `true` when serving exclusively over HTTPS. Cookies are also marked `Secure` automatically when a trusted proxy reports HTTPS. |
| `NOORTASKS_TRUST_PROXY` | No | `false` | Set `true` behind Caddy on the same host. Only loopback proxies are trusted; the rightmost untrusted address determines the client IP. Keep Node inaccessible from the public network. |
| `NOORTASKS_PASSPHRASE` | Docker first-run | - | Used by `docker-entrypoint.sh` only if `NOORTASKS_CONFIG` does not exist yet. |
| `NOORTASKS_PASSPHRASE_FILE` | Docker first-run | - | Path to a secret file containing the initial passphrase (preferred over env var). |
| `NOORTASKS_AUTO_VAPID` | Docker optional | `false` | If `true` and `NOORTASKS_VAPID_FILE` does not exist, generates VAPID keys on start. |
| `NOORTASKS_VAPID_SUBJECT` | Docker optional | `mailto:noortasks@localhost` | Subject claim used when `NOORTASKS_AUTO_VAPID=true` creates keys. |
| `NOORTASKS_NO_AUTH` | Docker dev only | `false` | If `true`, passes `--no-auth` (never enable on an untrusted network). |

## CLI Subcommands

Run server utilities with:

```bash
pnpm --filter @noortasks/server cli -- <command> [args]
```

- `hash-passphrase <config-file>`: Reads a passphrase (minimum 8 characters) from stdin and writes its `passphraseHash` into the config file with `0600` permissions (other keys in an existing file are kept).
- `generate-vapid <vapid-file> [--subject mailto:...]`: Generates a Web Push P-256 VAPID keypair and writes JSON with `0600` permissions.

## Authentication & Security

The config file (`NOORTASKS_CONFIG`, keep it outside the repository, `chmod 600`):

```json
{
  "oidc": {
    "issuer": "https://accounts.google.com",
    "clientId": "1234-abc.apps.googleusercontent.com",
    "clientSecret": "GOCSPX-...",
    "redirectUri": "https://tasks.example.com/api/auth/oidc/callback",
    "label": "Google"
  },
  "admins": ["you@example.com"],
  "maxUsers": 10,
  "passwordLogin": false,
  "collaboration": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `oidc` | - | OpenID Connect provider. Google, Authentik, Keycloak and any standard provider work through the same code (authorization code + PKCE, ID token checked for signature, issuer, audience, expiry and nonce; `email_verified` required). `redirectUri` must be https except for localhost. |
| `admins` | `[]` | Emails that are admins. The first one owns the existing single-user data. With OIDC and no admin, nobody can sign in (`setup_required`). |
| `maxUsers` | `10` | Account limit (admins included). Admins can change it in Settings > Members. |
| `passwordLogin` | off with `oidc`, on without | Local email + password sign-in (invite codes) as a fallback for self-hosters. |
| `passphraseHash` | - | Single-user passphrase from earlier versions: becomes the first admin's password. |
| `collaboration` | `true` | Initial state of the collaboration switch (the admin switch in Settings wins once used). |

- Sessions are SHA-256 hashed in the system database and valid for 30 days via an `HttpOnly` cookie (`t`) plus a CSRF double-submit cookie (`_csrf_token`) checked via `X-Csrftoken`. A disabled or removed member is signed out on the next request.
- Password, invite, pairing and native-code attempts reserve their rate-limit slot before work starts (5 attempts per minute per client IP; a successful sign-in resets its counter). OIDC starts allow 20 per minute per IP. At most four password derivations run concurrently.
- For browser setup, set `NOORTASKS_SETUP_TOKEN` to a random value of at least 32 characters before starting the server, then enter it in the setup form. Keep it in the deployment environment, outside the repository. Remove it after setup. Setup remains locked across restarts. If `admins` already bootstraps the account, use ordinary sign-in instead.
- Cross-site browser writes, including sign-in and setup, are rejected. Authenticated writes require the CSRF cookie/header pair. The legacy `GET /api/v2/notification?autoMarkRead=true` side effect requires it too. A new sign-in invalidates that browser's previous session; disabling/removing an account also revokes unused pairing and native login codes.
- Responses set CSP, `nosniff`, frame protection, and a no-referrer policy. Account API responses use `Cache-Control: no-store`. Uploaded files are forced downloads with a sandbox CSP; SVG files use `application/octet-stream`.
- JSON and CSV restore inputs are capped at 2 MiB. JSON nesting is limited to 32 levels, arrays to 1,000 items, and traversal to 50,000 values. CSV restore accepts at most 10,000 rows and 64 columns. Larger restores must be split.
- Each attachment is capped at 64 MiB; an account may store up to 1 GiB / 10,000 files, with at most two uploads in flight. Uploads stop at the existing low-disk threshold. Server-measured byte counts cannot be lowered by changing attachment metadata. SQLite database files use `0600` permissions.
- `GET /healthz` answers `{ "ok": true }` without a session (container health checks).

## Web Push Notifications

When `NOORTASKS_VAPID_FILE` is configured, the server starts a background 30-second dispatch loop (`reminders.dispatchDue()`) and sends Web Push alerts for task reminders, checklist item reminders, habit reminders, countdown reminders, and daily summaries.

## External Calendar Integrations

### Public ICS Subscriptions & Holiday Presets

No credentials file is needed to subscribe to `.ics` URLs or built-in holiday presets (`nl`, `be`, `uk`, `us`, `islamic`). Outbound calendar, CalDAV, OIDC and Web Push connections permit only public IP addresses. Loopback, private, link-local, multicast, reserved, IPv4-mapped IPv6, and Tailscale addresses are refused, including DNS answers. DNS answers are validated once and pinned to the connection, with ordinary HTTPS hostname/certificate verification. Redirects are refused; subscribe to the final URL directly. Responses are limited to 2 MiB with a 10-second total deadline and at most eight outbound requests in flight. Compressed responses are refused (the server requests identity encoding). The explicit `oidc.allowInsecure=true` and injected transports are for local tests only and bypass this transport policy; never enable that OIDC option on a public instance.

Calendar/reminder query windows are capped at 366 days. ICS inputs permit at most 1,000 VEVENTs and 100 RRULEs; sub-daily recurrence is refused and recurrence expansion has a finite iteration limit. Calendar provider pagination stops after 20 pages. Focus records may span at most seven days; habit histories may span at most 100 years.

Upstream ICS feeds refresh lazily on read when cached entries are older than 15 minutes or when `?refresh=true` is requested.

### iCloud & Read-Only CalDAV

Use **Settings -> Calendar -> Add Account -> iCloud / CalDAV** (or `POST /api/v4/calendar/bind/icloud` / `POST /api/v4/calendar/bind`) with an app-specific password. CalDAV and iCloud accounts are read-only. Generic CalDAV discovery and calendar URLs must stay on the configured origin. iCloud additionally permits HTTPS `p<number>-caldav.icloud.com` shards. This prevents discovered URLs from forwarding app passwords to another origin. Private-network CalDAV servers are intentionally unavailable through the public server.

### Google Calendar & Outlook Two-Way Sync

Create a private `calendar-oauth.json` (`chmod 600`) and point `NOORTASKS_CALENDAR_OAUTH_FILE` to it:

```json
{
  "google": {
    "clientId": "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
    "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET",
    "redirectUri": "https://tasks.example.com/api/v2/calendar/oauth/google/callback"
  },
  "outlook": {
    "clientId": "YOUR_AZURE_APP_CLIENT_ID",
    "clientSecret": "YOUR_AZURE_APP_CLIENT_SECRET",
    "tenant": "common",
    "redirectUri": "https://tasks.example.com/api/v2/calendar/oauth/outlook/callback"
  }
}
```

Calendar OAuth callback URLs come from the server configuration (or the original request origin when omitted). A request cannot substitute a different callback URL. `redirectAfter` accepts only a local path. Outlook pagination links must remain on the configured API origin.

- **Google Cloud Console**: Enable the Google Calendar API, add scope `https://www.googleapis.com/auth/calendar`, and configure the Web application redirect URI above.
- **Microsoft Entra ID**: Register an app with delegated permissions `offline_access`, `Calendars.ReadWrite`, and `User.Read`, and configure the Web redirect URI above.

## AI Audio Transcription & Summarization

NoorTasks can transcribe audio task attachments (`m4a`, `mp3`, `wav`, `ogg`, `webm`, `aac`, `flac`, `opus`) and summarize transcripts into key points, decisions, and action items. When no API key is configured, `GET /api/v2/ai/status` returns `configured: false` and the AI controls stay hidden in the web UI.

Add an optional `ai` block to `NOORTASKS_CONFIG`, or keep the secret out of disk JSON by setting `NOORTASKS_GROQ_API_KEY` (also works with `--no-auth`):

```json
{
  "ai": {
    "provider": "groq",
    "apiKey": "gsk_your_key_or_use_NOORTASKS_GROQ_API_KEY",
    "transcribeModel": "whisper-large-v3-turbo",
    "summarizeModel": "openai/gpt-oss-120b",
    "maxFileBytes": 26214400,
    "rateLimitPerHour": 20
  }
}
```

- **Models**: `transcribeModel` defaults to `whisper-large-v3-turbo`. `summarizeModel` defaults to `openai/gpt-oss-120b` because Groq retired free/dev Llama 3.1/3.3 and Llama 4 chat models in 2026 and designates `openai/gpt-oss-120b` as the active non-deprecated Production replacement.
- **Environment overrides**: `NOORTASKS_GROQ_API_KEY` (or generic `NOORTASKS_AI_API_KEY`), `NOORTASKS_AI_PROVIDER`, `NOORTASKS_AI_BASE_URL`, `NOORTASKS_AI_TRANSCRIBE_MODEL`, `NOORTASKS_AI_SUMMARIZE_MODEL`, `NOORTASKS_AI_MAX_FILE_BYTES`, and `NOORTASKS_AI_RATE_LIMIT`.
- **Large files and container formats**: Groq's free tier limits uploads to 25 MB (`maxFileBytes`, default `26214400` bytes). If an audio file exceeds `maxFileBytes`, or uses a container not directly accepted by Groq Whisper (`.aac`, `.opus`), the server uses `ffmpeg` (when installed on `PATH`) to transcode to mono 16 kHz Opus `.ogg` (and segments by duration if still above `maxFileBytes`). If `ffmpeg` is not installed, oversized files are split into chunks under `maxFileBytes` and the transcripts are joined in order.
- **Caching, permissions & privacy**: Transcripts and summaries are saved directly on the attachment metadata so every device receives them over sync without recomputing unless the user asks again (`force: true`). Only the task owner or shared-list members with access to the task may trigger AI actions, requests are rate-limited per user (`20` per hour by default), and audio bytes or transcript text are never logged.

