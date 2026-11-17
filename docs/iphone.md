# iPhone & iPad (PWA) Guide

NoorTasks does not ship a separate App Store binary. Instead, the web app is a Progressive Web App (`apps/web`) designed to run full-screen from your iOS/iPadOS Home Screen.

## Installing on Your Home Screen

1. Serve your NoorTasks instance over **HTTPS** (required by iOS for service workers, offline caching, and Web Push).
2. Open your NoorTasks URL in **Safari**.
3. Tap the **Share** button, then choose **Add to Home Screen**.
4. Open **NoorTasks** from your Home Screen icon. It launches in standalone mode (`display: standalone`) without browser chrome.

## Enabling Push Notifications on iOS / iPadOS

Web Push on iOS requires **iOS/iPadOS 16.4 or later** and only works when launched from the **Home Screen** icon over HTTPS:

1. Configure `NOORTASKS_VAPID_FILE` on your NoorTasks server (see [docs/configuration.md](configuration.md)).
2. Open NoorTasks from your **Home Screen**.
3. Go to **Settings -> Notifications** and enable push notifications, then accept the iOS permission prompt.

## Current Limitations on iOS vs. Android

- **No home-screen widget or Share Sheet extension**: iOS Home Screen PWAs cannot provide native widgets or OS-level share extensions.
- **Reminder delivery**: Background notifications rely on Web Push (APNs via your server's VAPID dispatch loop) rather than local `AlarmManager` alarms, so your device needs network connectivity to receive reminders while the app is closed.
- **Offline data**: Local edits, tasks, habits, and focus timers remain usable offline via `IndexedDB` and sync back once your server is reachable.
