# Changelog

All notable changes to NoorTasks will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-16

### Added

- **Local-first PWA (`apps/web`)**: React + Vite + Dexie IndexedDB client with offline queueing, sync checkpoints, keyboard shortcuts, command palette, and desktop/mobile layouts.
- **Task management & views**: Inbox, Today, Tomorrow, Next 7 Days, All, Completed, Won't Do, Trash, lists, folders, nested subtasks, checklists, tags, advanced rule-based filters, custom sort/group options, Kanban boards, Timeline view, and Eisenhower Matrix.
- **Natural-language quick add & recurrence (`@noortasks/quickadd`, `@noortasks/recurrence`)**: Inline parsing for dates, times, date ranges, priorities, tags, reminders, and flexible recurring schedules including completion-date repeats and skip rules.
- **Calendar & external feeds**: Day, Multi-day, Week, Multi-week, Month, Agenda, and Year calendar views; outgoing private ICS feeds (`/feed/<token>.ics`); incoming ICS URL subscriptions and holiday presets; Google and Outlook OAuth 2.0 two-way project bindings; read-only CalDAV and iCloud calendar support.
- **Habits, focus, stats & countdowns**: Habit tracker with schedules, streaks, check-ins, and mood notes; Pomodoro and stopwatch focus timer with Web Audio ambient sounds; statistics and periodic summaries; date countdowns.
- **Reminders & notifications**: In-app notification center, Web Push VAPID notifications, and recurring reminder evaluation.
- **Attachments, comments, templates & activity**: Disk-backed task attachments with preview, task comments, reusable task/list templates, and activity history.
- **Backup & import/export**: 23-column CSV task backup and restore, Markdown single-task export, and CSV/XLSX exports for habits and focus logs.
- **Android app (`apps/android`)**: Capacitor 8 wrapper with configurable server URL, AlarmManager local reminder notifications (Done/Snooze), Today home-screen widget, share target, launcher shortcut, and Quick Settings tile.
- **Server (`apps/server`)**: Node 22 + Fastify + built-in `node:sqlite` (WAL mode) single-user server with scrypt passphrase authentication, HTTP-only session cookies, and CSRF protection.
