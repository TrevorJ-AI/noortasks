# Android sign-in validation, 2026-11-16

Flow: system browser (option a), with a PKCE-bound one-time-code handoff. See [README](README.md#google-sign-in-system-browser-flow-option-a) and [Google console setup](../../docs/multi-user.md#android-google-sign-in-system-browser).

- `pnpm -r --workspace-concurrency=1 test`: passed. Android 4, core 105, quickadd 272, recurrence 372, server 641, web 210 unit tests; Playwright 72 passed, 12 opt-in screenshot tests skipped. Browser tests include the existing web OIDC sign-in, invites and sharing. Isolated ports: API 19731/19733, multi-user 19736, mock OIDC 19737, web 4373/4374.
- `cd apps/web && npx vitest run` (via workspace exec): 210 passed, including six native handoff tests for challenge creation, server/state binding, HTTPS, failures, expiry and cold/warm launches.
- `pnpm -r --workspace-concurrency=1 exec tsc --noEmit`: passed.
- New server suite: 15 passed. Covers valid signed tokens, wrong audience/issuer/signature, expired tokens, code replay/expiry, verifier theft protection, invite/account/member-limit rules, browser cookie, provider PKCE/nonce, errors, malformed requests and retained CSRF enforcement.
- Web bundle built by the workspace suite, then `pnpm --filter @noortasks/android cap:sync` succeeded.
- Gradle `assembleDebug --no-daemon --max-workers=1 -Dorg.gradle.jvmargs=-Xmx1200m`: successful, 304 tasks, with 2001 MB available before starting. JDK, SDK, Android user home and Gradle home were the brief's `/mnt/data/home-trevor` paths. No Gradle daemon remained after the build.
- `aapt2 dump badging`: package `app.noortasks`, min SDK 24, target SDK 36. Compiled manifest includes `app.noortasks://auth` and BrowserControllerActivity. Resources include launcher background `#e9b22e`. APK assets contain the Browser plugin, native sign-in/redemption bundle and disabled bridge logging.

APK: `/mnt/data/home-trevor/noortasks-apk/noortasks-debug-2026-11-16-v2.apk` (4,771,171 bytes).

SHA-256: `3734ca8dea850e50f97608389657411596cd3179af282015fd3e6a20ea311f0b`.

This was tested against a local signed-token OIDC provider, not a live Google account or physical Android device. Deploy the matching server changes with this APK. A real-device smoke test should cover sign-in, browser cancellation/retry, app process death during sign-in, and the first authenticated write. No running server was deployed or restarted.
