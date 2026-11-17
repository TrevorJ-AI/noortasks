# Android App Guide (`apps/android`)

NoorTasks provides a Capacitor 8 Android app (`app.noortasks`) wrapping the offline-first web client with native Android integrations.

## Installing the Pre-Built APK

1. Download `noortasks-<version>-debug.apk` (and verify its `.sha256` checksum) from [GitHub Releases](https://github.com/TrevorJ-AI/noortasks/releases).
2. Enable **Install unknown apps** for your browser or file manager on Android.
3. Install and open **NoorTasks**.

## First-Run Setup

1. Tap **Scan QR code** on the first-run screen to scan the pairing QR shown by the web setup wizard (or in **Settings -> Account -> Pair phone or browser**). This configures the server address and signs the app in using the one-time 10-minute pairing token.
2. To connect manually instead, type the full base URL of your NoorTasks server (for example `https://tasks.example.com` or a private LAN/VPN HTTPS URL, without a trailing slash), tap **Continue**, and sign in with your account credentials or Google.
3. You can change the server address anytime from the Sign-In screen (**Change**) or in **Settings -> Account -> Server address**.

> [!NOTE]
> Plain HTTP URLs work on private LANs (`allowMixedContent: true`), while HTTPS via reverse proxy or private VPN certificates is strongly recommended whenever traffic leaves a trusted local network.

## Android-Specific Features

- **Native Reminder Alarms**: Polls `/api/v2/reminder/instances` for the next 48 hours (tasks, checklist items, habits, countdowns, daily summary alerts) and schedules `AlarmManager` local notifications so reminders fire even when the app is closed, with **Done** and **Snooze** actions.
- **Today Home-Screen Widget**: Add the NoorTasks Today widget to view Today + Overdue tasks and check items off directly from your launcher.
- **Android Share Target**: Share text or links from any app (`ACTION_SEND`) to open Quick Add pre-filled.
- **Quick-Add Launcher Shortcut & Quick Settings Tile**: Long-press the app icon or add the NoorTasks Quick Settings tile in your notification shade for one-tap task capture.

## Building from Source

### Requirements

- Node.js 22+ and pnpm 11+
- JDK 21 (required by Capacitor 8 / AGP 8.13.0)
- Android SDK with `platform-tools`, `platforms;android-36`, and `build-tools;36.0.0`

### Build Commands

```bash
pnpm install --frozen-lockfile
pnpm --filter @noortasks/quickadd build
pnpm --filter @noortasks/web build
pnpm --filter @noortasks/android cap:sync

cd apps/android/android
./gradlew assembleDebug --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1200m
```

The debug APK is written to `apps/android/android/app/build/outputs/apk/debug/app-debug.apk`.
