# Calendar Server Integration Notes

## Overview

The NoorTasks server (`apps/server`) now implements calendar subscriptions, public holiday calendars, outgoing private ICS feeds, Google and Outlook OAuth 2.0 accounts with two-way project bindings, read-only CalDAV and iCloud calendar adapters, and the unified window query endpoint (`GET /api/v2/calendar/events`).

No background cron jobs or interval timers are registered anywhere. Upstream ICS feeds refresh lazily on read when uncached, when the subscription URL changes, when the cache is at least 15 minutes (`900000` ms) old, or when `?refresh=true` is supplied. Cached feeds send `If-None-Match` and `If-Modified-Since` conditional headers and keep stale cached events on transient upstream errors while recording `lastStatus` and `lastError` in `GET /api/v2/calendar/cache/:id`.

## Verified Public Holiday ICS URLs

All 5 built-in presets exposed by `GET /api/v2/calendar/holidays/presets` (and subscribable via `POST /api/v2/calendar/holiday/subscribe` with `presetId`, `holidayCode`, or `code`) were fetched over HTTPS and parsed with `node-ical@0.27.6` (`Apache-2.0`):

| Preset ID | Name | Verified ICS URL | Live Verification Notes |
| --- | --- | --- | --- |
| `nl` | Holidays in Netherlands | `https://calendar.google.com/calendar/ical/en.dutch%23holiday%40group.v.calendar.google.com/public/basic.ics` | HTTP 200, `text/calendar; charset=utf-8`, 200 VEVENTs (18 in 2026) |
| `be` | Holidays in Belgium | `https://calendar.google.com/calendar/ical/en.be%23holiday%40group.v.calendar.google.com/public/basic.ics` | HTTP 200, `text/calendar; charset=utf-8`, 275 VEVENTs (25 in 2026) |
| `uk` | UK Bank Holidays (England and Wales) | `https://www.gov.uk/bank-holidays/england-and-wales.ics` | HTTP 200, `text/calendar; charset=utf-8`, ETag returned, 83 VEVENTs (8 in 2026) |
| `us` | Holidays in United States | `https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics` | HTTP 200, `text/calendar; charset=utf-8`, 317 VEVENTs (28 in 2026) |
| `islamic` | Islamic Holidays | `https://calendar.google.com/calendar/ical/en.islamic%23holiday%40group.v.calendar.google.com/public/basic.ics` | HTTP 200, `text/calendar; charset=utf-8`, 91 VEVENTs (8 in 2026) |

`GET /pub/api/v1/calendar/holiday/cn/recent` is retained as a no-op compatibility endpoint returning `[]`.

## Assumptions and Implementation Choices

1. **Single-user VPS store & sync compatibility**: Matches the existing `apps/server` SQLite store (`store.ts`). Subscriptions are stored in the `calendar_subscriptions` collection (with `"calendarSubscription"` tombstones added in `service.ts`), while OAuth/CalDAV credentials, OAuth PKCE states (15-minute TTL), feed caches, project bindings, event-to-task links, and archived events live in dedicated SQLite tables so secrets and tokens are never leaked onto sync responses.
2. **Outgoing ICS feed security & compatibility**:
   - `POST /api/v2/calendar/feeds/code/new` (and `.../new/:t`) mints a random 48-char hex secret token (24 bytes from `crypto.randomBytes`).
   - `GET /feed/<token>.ics` is on `PUBLIC_PREFIXES` (no session cookie required) and validates `<token>` with constant-time comparison (`crypto.timingSafeEqual` on equal-length digests). It honors `includeDone`, `includeHabits`, and `projectIds` (supporting both real project IDs and `"inbox"` as an alias for the user's inbox ID), and emits `Cache-Control: private, no-cache`.
   - Standard RFC 5545 `RRULE` (with optional `EXDATE` via completed/ignored dates) is emitted for simple repeating tasks, while extended `ERULE` and `TT_SKIP` rules are expanded into concrete `VEVENT` occurrences.
   - `PREFERENCE_KEYS` in `@noortasks/core` is kept (51 keys) to preserve user preference validation compatibility.
3. **Recurring & timezone rules (`calendar-ics.ts`)**:
   - Uses `node-ical@0.27.6` (`rrule-temporal`) with pre-expansion padding so DST shifts near window edges are never dropped.
   - Cancelled instances (`STATUS:CANCELLED`, including cancelled `RECURRENCE-ID` overrides) and declined attendee instances (`PARTSTAT=DECLINED`, unless `showDeclined=true`) are filtered out cleanly.
   - Floating `DATE-TIME` values in feeds without `VTIMEZONE` definitions are evaluated in the user's `settings.timeZone`, so changing user timezone updates event timestamps on cached feeds without re-fetching HTTP.
4. **Two-way sync & conflict behavior (`calendar.ts`)**:
   - Connected Google and Outlook calendars support optional project bindings (`POST /api/v2/calendar/:id/bind/project`) in either `"all"` scope (routing `~ListName` tokens and falling back to Inbox) or `"project"` scope, preserving `~List`, `#tag`, `defaultTags`, reminders, and local-to-remote/remote-to-local edits and cancellations.
   - Deleting a project binding (`DELETE /api/v2/calendar/:id/bind/project?id=...`) unlinks the sync mapping while keeping tasks/events intact on both sides.
   - Connected-account events linked to live NoorTasks tasks are deduplicated in `GET /api/v2/calendar/events` (`deduplicateLinkedTasks: true`) so linked items render once cleanly.
5. **Token refresh & failure isolation**:
   - OAuth access tokens auto-refresh within 60 seconds of expiry and retry once on HTTP 401. An `invalid_grant` (or HTTP 400/401 refresh rejection) marks the account `status: "revoked"` / `needsReauth: true`.
   - Single-source endpoints (`GET /api/v2/calendar/subscribe/events/:id`, account sync, manual refresh) propagate errors (`502` / `401`), while the multi-source `GET /api/v2/calendar/events` endpoint isolates per-source failures so one broken feed or revoked account does not break the rest of your calendar.
6. **Client-side error resilience**:
   - Google OAuth revocation is attempted best-effort on disconnect (`POST /api/v2/calendar/oauth/:provider/disconnect`, `DELETE /api/v2/calendar/bind/:id`, `DELETE /api/v2/calendar/connect/:id`), removing local credentials and bindings even if remote revocation fails.
   - CalDAV and iCloud accounts are strictly read-only (`400 read_only_provider` on write/bind attempts).

## How to Connect Google Calendar and Outlook

### 1. Create the OAuth config JSON file

Create a private JSON file readable only by your server user (for example `~/.secrets/calendar-oauth.json` with `chmod 600`):

```json
{
  "google": {
    "clientId": "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
    "clientSecret": "YOUR_GOOGLE_CLIENT_SECRET",
    "redirectUri": "https://YOUR_DOMAIN/api/v2/calendar/oauth/google/callback"
  },
  "outlook": {
    "clientId": "YOUR_AZURE_APP_CLIENT_ID",
    "clientSecret": "YOUR_AZURE_APP_CLIENT_SECRET",
    "tenant": "common",
    "redirectUri": "https://YOUR_DOMAIN/api/v2/calendar/oauth/outlook/callback"
  }
}
```

Optional overrides (`authUrl`, `tokenUrl`, `revokeUrl`, `userInfoUrl`, `apiBaseUrl`, `scopes`) are also read per provider if needed.

Point the server to this file via the environment variable before starting `apps/server`:

```bash
export NOORTASKS_CALENDAR_OAUTH_FILE="$HOME/.secrets/calendar-oauth.json"
```

Note: Do not commit this file or store secrets inside the repository.

### 2. Google Cloud Console Setup

1. Open Google Cloud Console and select or create a project.
2. Enable the **Google Calendar API** (APIs & Services -> Library).
3. Configure the **OAuth consent screen**:
   - Choose External (or Internal if using Google Workspace).
   - Add yourself as a test user while in Testing mode (or publish the app so refresh tokens do not expire after 7 days).
   - Add scope: `https://www.googleapis.com/auth/calendar`.
4. Go to **Credentials -> Create Credentials -> OAuth client ID** -> **Web application**:
   - Under **Authorized redirect URIs**, add:
     - Local testing: `http://127.0.0.1:PORT/api/v2/calendar/oauth/google/callback`
     - Production behind reverse proxy / Tailscale: `https://YOUR_DOMAIN/api/v2/calendar/oauth/google/callback`
5. Copy **Client ID** and **Client Secret** into the `"google"` block of `NOORTASKS_CALENDAR_OAUTH_FILE`.

### 3. Microsoft Entra ID / Azure Portal Setup (Outlook / Microsoft 365)

1. Open Azure Portal -> **Microsoft Entra ID -> App registrations -> New registration**.
2. Set **Supported account types** to **Accounts in any organizational directory and personal Microsoft accounts** (matches default `"tenant": "common"`).
3. Under **Redirect URI**, choose **Web** and enter:
   - Local testing: `http://127.0.0.1:PORT/api/v2/calendar/oauth/outlook/callback`
   - Production: `https://YOUR_DOMAIN/api/v2/calendar/oauth/outlook/callback`
4. Under **Certificates & secrets -> Client secrets**, create a new secret and copy its **Value** (not the Secret ID) into `"clientSecret"`.
5. Under **API permissions -> Add a permission -> Microsoft Graph -> Delegated permissions**, add:
   - `offline_access`
   - `Calendars.ReadWrite`
   - `User.Read`
6. Copy **Application (client) ID** and the secret value into the `"outlook"` block of `NOORTASKS_CALENDAR_OAUTH_FILE`.

### 4. Starting an OAuth Flow & Connecting iCloud CalDAV

- **Google / Outlook**: Call `GET /api/v2/calendar/oauth/google/start` or `GET /api/v2/calendar/oauth/outlook/start` (optionally pass `?redirect=true` and `&redirectAfter=/settings/calendars`). The server generates a single-use CSRF `state` and PKCE `S256` verifier (`access_type=offline&prompt=consent` on Google) and completes the exchange at `/api/v2/calendar/oauth/:provider/callback`.
- **iCloud / Generic CalDAV**: Generate an app-specific password at `https://appleid.apple.com` (Apple support URL is also served via `GET /api/v4/calendar/icloud/support/url`), then bind via `POST /api/v4/calendar/bind/icloud` (default iCloud CalDAV host `https://caldav.icloud.com/`) or `POST /api/v4/calendar/bind` with `{ serverUrl, username, password }`.
