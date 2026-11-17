# Contributing to NoorTasks

Thanks for your interest in contributing to NoorTasks. Bug reports, documentation improvements, translations/tests, and code pull requests are all welcome.

## Code of Conduct

All contributors and maintainers follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Workspace Layout

NoorTasks is a pnpm TypeScript monorepo:

- `packages/core`: shared entity types, sort-order math, filter rule engine, date helpers, preferences, reminder trigger utilities (`@noortasks/core`)
- `packages/recurrence`: recurring schedule expansion, completion, skip/exception handling (`@noortasks/recurrence`)
- `packages/quickadd`: natural-language task parser for dates, times, priorities, tags, reminders, and repeats (`@noortasks/quickadd`)
- `apps/server`: Node 22 + Fastify + `node:sqlite` backend, sync API, Web Push, ICS/CalDAV/OAuth calendar sync, backup/import (`@noortasks/server`)
- `apps/web`: React + Vite + Dexie (IndexedDB) local-first PWA (`@noortasks/web`)
- `apps/android`: Capacitor 8 Android shell, local alarms, home-screen widget, share target, Quick Settings tile (`@noortasks/android`)

## Prerequisites

- Node.js 22+ (required for built-in `node:sqlite`)
- pnpm 11+ (`corepack enable`)
- For Android builds: JDK 21 and Android SDK 36 (see [docs/android.md](docs/android.md))

## Local Development Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Build @noortasks/quickadd (required before some package consumers)
pnpm --filter @noortasks/quickadd build

# 3. Start the API server in development mode (no passphrase required)
mkdir -p .dev-data/files
NOORTASKS_DB=.dev-data/noortasks.sqlite \
NOORTASKS_DATA_DIR=.dev-data/files \
PORT=18731 \
pnpm --filter @noortasks/server start -- --no-auth

# 4. In a second terminal, start the Vite web dev server (proxies /api, /files, /feed)
pnpm --filter @noortasks/web dev
```

Open `http://127.0.0.1:5273` in your browser.

## Running Checks Before Opening a PR

Run unit tests, type checks, and the web build:

```bash
pnpm --filter @noortasks/core test
pnpm --filter @noortasks/recurrence test
pnpm --filter @noortasks/quickadd test
pnpm --filter @noortasks/server test
pnpm --filter @noortasks/web test:unit
pnpm --filter @noortasks/android test

pnpm -r typecheck
pnpm --filter @noortasks/quickadd build
pnpm --filter @noortasks/web build
```

For browser end-to-end tests in `apps/web`:

```bash
pnpm --filter @noortasks/web test:e2e
```

## Coding & Contribution Guidelines

- **Keep changes focused**: avoid unrelated edits across packages in the same PR.
- **Add tests**: include unit tests for parser, recurrence, core, or server changes and E2E tests when changing UI workflows.
- **Preserve privacy & clean licensing**: only submit original work or MIT-compatible code, and use synthetic fixtures (`example.com` / `example.test`) in tests.
- **AI-assisted contributions**: disclose in the PR template whether AI tools assisted with your code, and verify all code and tests yourself before submitting.
- **No external brand assets**: do not copy proprietary icons, strings, stylesheets, or bundled assets from third-party products.

## Opening a Pull Request

1. Fork the repository and branch from `main`.
2. Fill out the [Pull Request Template](.github/PULL_REQUEST_TEMPLATE.md).
3. Ensure all CI checks pass.
