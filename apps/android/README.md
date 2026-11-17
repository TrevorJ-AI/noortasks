# NoorTasks Android (`apps/android`)

Capacitor 8 Android shell around `apps/web/dist` (`appId`: `app.noortasks`, `appName`: `NoorTasks`).

## What is included

- **Adaptive & legacy icon + splash**: custom geometric "N" mark on `#e9b22e` amber background (`scripts/generate_icons.py`).
- **First-run server address screen**: prompts for your server address on first run (or pre-fills from `VITE_DEFAULT_SERVER_URL` at build time). Editable on first run, on the Sign-In screen, and in Settings > Account.
- **Cross-origin session & CSRF**: uses Capacitor's native `CapacitorHttp` and `CapacitorCookies` plugins plus `NoorNativeBridge.getCsrfToken(apiBase)` (reading Android `CookieManager`) so session (`t`) and CSRF (`_csrf_token`) cookies use the server's normal cookie-based API.
- **Local reminder notifications**: polls `/api/v2/reminder/instances` for the next 48 hours (including tasks, checklist items, habits, countdowns, and daily summary alerts) and schedules Android `AlarmManager` notifications via `@capacitor/local-notifications` so reminders fire with the app closed, with **Done** and **Snooze** notification actions.
- **Share target**: `ACTION_SEND` (`text/plain`) opens the Quick Add modal pre-filled with shared text/links.
- **Quick-Add home-screen shortcut & Quick Settings tile**: long-press launcher shortcut (`shortcuts.xml`) and notification-shade Quick Settings tile (`NoorQuickAddTileService`) both launch directly into Quick Add.
- **Today home-screen widget**: `TodayWidgetProvider` + `TodayWidgetService` displays Today + Overdue tasks, refreshes on task sync/changes, opens tasks or Quick Add, and supports ticking tasks complete directly from the home screen (synced back to Dexie & server on next app launch/resume).
- **Back button & system bars**: handles Android hardware/gesture back button (modal -> settings -> drawer -> task detail -> history -> minimize app) and updates status/navigation bar colors and icon contrast from the active NoorTasks theme.

## Google sign-in: system browser flow (option a)

Google sign-in opens the server's OIDC start URL using `@capacitor/browser`, which uses an Android Chrome Custom Tab. This reuses the existing Web application OAuth client, server code exchange, provider PKCE/state/nonce, verified email and invite/member rules. It avoids an additional Android OAuth client and keeps provider tokens out of the app. The regular web sign-in link still uses the existing browser flow.

The app creates a random verifier and separate state before opening the tab, storing them with the selected server origin and a ten-minute validity window so process restarts work. Only the SHA-256 verifier challenge and state go to the start URL. The server binds them to its existing browser state cookie. After checking the ID-token signature against JWKS, issuer, audience, expiry and nonce, the server redirects to the fixed `app.noortasks://auth` intent with a random one-time code and the app state. It creates no browser session for this handoff.

`POST /api/auth/oidc/native/redeem` accepts the code and verifier in its JSON body. The server stores only a code hash, expires codes after 60 seconds, consumes them atomically and rechecks account status. Only a successful redemption sets the normal HttpOnly session and CSRF cookies via CapacitorHttp/CookieManager. Protected writes retain the existing CSRF checks. No ID token, session cookie or verifier goes in a URL. Native bridge logging is disabled even in debug APKs; server request logs omit query strings.

Both `appUrlOpen` and `getLaunchUrl()` cover warm and cold app launches. Unsolicited links, state mismatches, changed servers, expired requests and duplicate intents cannot start a session. Android Google sign-in requires an HTTPS server origin. Browser cancellation can be retried using the same sign-in button.

Deploy this branch's server together with the APK. Older servers do not implement the redemption endpoint. Google Console setup is in [multi-user.md](../../docs/multi-user.md#android-google-sign-in-system-browser). No running server is changed by building this APK.

References: [Capacitor Browser](https://capacitorjs.com/docs/apis/browser), [Capacitor app deep links](https://capacitorjs.com/docs/apis/app), [openid-client signature checks](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md).

## Requirements

- Node 22+, pnpm 11+
- JDK 21 (e.g. `/mnt/data/home-trevor/jdk-21`) — required by Capacitor 8 / AGP 8.13.0 (`JavaVersion.VERSION_21`)
- Android SDK (`/mnt/data/home-trevor/android-sdk`) with:
  - `platform-tools`
  - `platforms;android-36`
  - `build-tools;36.0.0`
- Gradle home under `/mnt/data/home-trevor/gradle-home`

## How to rebuild the debug APK

```bash
# 1. Install workspace dependencies (from repo root)
pnpm install

# 2. Build the web bundle and sync assets into Android
pnpm --filter @noortasks/web build
pnpm --filter @noortasks/android cap:sync

# 3. Check available RAM before starting Gradle (require >= 1300 MB on a 4 GB VPS)
free -m

# 4. Build the debug APK with memory-capped, single-worker, non-daemon Gradle
export JAVA_HOME=/mnt/data/home-trevor/jdk-21
export ANDROID_HOME=/mnt/data/home-trevor/android-sdk
export ANDROID_USER_HOME=/mnt/data/home-trevor/android-sdk/.android
export GRADLE_USER_HOME=/mnt/data/home-trevor/gradle-home

cd apps/android/android
./gradlew assembleDebug --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1200m
```

The debug APK is written to:
`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`

Inspect badging and install on a USB/wireless ADB device:

```bash
"$ANDROID_HOME/build-tools/36.0.0/aapt2" dump badging apps/android/android/app/build/outputs/apk/debug/app-debug.apk | head -n 5
"$ANDROID_HOME/platform-tools/adb" install -r apps/android/android/app/build/outputs/apk/debug/app-debug.apk
```

To regenerate the adaptive icon and splash PNGs:

```bash
python3 apps/android/scripts/generate_icons.py
```

## Native networking

With `CapacitorHttp` + `CapacitorCookies` enabled in `capacitor.config.ts`, API calls and blob-fetched attachments/comments work against the current `apps/server` without CORS headers.

However, if you ever disable `CapacitorHttp` (to use standard WebView `fetch()`, native `<img src>` without blob proxying, or `<a download>` directly from the remote server origin `https://tasks.example.com` while the WebView origin is `https://localhost`), `apps/server/src/app.ts` needs:

1. **CORS middleware (`@fastify/cors`)**:
   - Allow origin `https://localhost` (Capacitor Android default scheme/host) and `capacitor://localhost` (or reflect allowed local origins).
   - Enable `credentials: true`.
   - Allow methods `GET, POST, PUT, DELETE, OPTIONS` and headers `Content-Type, X-Csrftoken, x-verify-id`.
2. **Cross-origin cookie attributes (`POST /api/v2/user/signon`)**:
   - Currently `app.ts` sets `sameSite: "lax"` on both `t` and `_csrf_token`. Standard WebView `fetch()` from `https://localhost` to `https://tasks.example.com` will withhold `SameSite=Lax` cookies on cross-site requests.
   - Change to `sameSite: "none"` with `secure: true` (over HTTPS) when serving Capacitor cross-origin clients.
3. **Cross-origin CSRF token visibility**:
   - `document.cookie` on `https://localhost` cannot read cookies scoped to `tasks.example.com`. Either keep `NoorNativeBridge.getCsrfToken(apiBase)` (already implemented here) or return `csrfToken` in the `/api/v2/user/signon` JSON response (or an `X-Csrf-Token` response header exposed via `Access-Control-Expose-Headers`) and accept Bearer/header auth as an alternative.
