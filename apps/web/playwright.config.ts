import { defineConfig, devices } from "@playwright/test";

// the browser runs in this zone; the test process computes expected dates in the same zone
process.env.TZ = "Europe/Amsterdam";

// ports can be moved when another checkout runs its own suite on the defaults
const API_PORT = Number(process.env.E2E_API_PORT ?? 18731);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4273);
// a second, empty server: the M5 import test restores a backup into a fresh account
const API2_PORT = Number(process.env.E2E_API2_PORT ?? API_PORT + 2);
process.env.NOORTASKS_API ??= `http://127.0.0.1:${API_PORT}`;
process.env.NOORTASKS_API2 ??= `http://127.0.0.1:${API2_PORT}`;
const WEB2_PORT = Number(process.env.E2E_WEB2_PORT ?? WEB_PORT + 1);
process.env.NOORTASKS_WEB2 ??= `http://127.0.0.1:${WEB2_PORT}`;
const tsx = "../server/node_modules/.bin/tsx";
// M8: the multi-user production server (serves dist itself) and a local mock OIDC provider
const MULTI_PORT = Number(process.env.E2E_MULTI_PORT ?? API_PORT + 5);
const MOCK_PORT = Number(process.env.E2E_MOCK_OIDC_PORT ?? API_PORT + 6);
process.env.NOORTASKS_MULTI ??= `http://127.0.0.1:${MULTI_PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    timezoneId: "Europe/Amsterdam",
    locale: "en-US",
    viewport: { width: 1440, height: 900 },
    trace: "off",
    video: "off",
    screenshot: "off",
  },
  projects: [{ name: "chromium", use: { viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: `${tsx} ../server/test/mock-oidc-cli.ts ${MOCK_PORT}`,
      url: `http://127.0.0.1:${MOCK_PORT}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
    },
    {
      command: `bash e2e/start-multi.sh ${MULTI_PORT} ${MOCK_PORT}`,
      url: `http://127.0.0.1:${MULTI_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
    },
    {
      // VAPID keys so the push key route answers (M5 push registration test)
      command: `rm -rf .e2e-tmp && mkdir -p .e2e-tmp && ${tsx} ../server/src/cli.ts generate-vapid .e2e-tmp/vapid.json --subject mailto:e2e@example.invalid && NOORTASKS_VAPID_FILE=.e2e-tmp/vapid.json NOORTASKS_DB=.e2e-tmp/db.sqlite NOORTASKS_DATA_DIR=.e2e-tmp/files PORT=${API_PORT} ${tsx} ../server/src/main.ts --no-auth`,
      url: `http://127.0.0.1:${API_PORT}/api/v2/user/status`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
    },
    {
      command: `rm -rf .e2e-tmp2 && mkdir -p .e2e-tmp2 && NOORTASKS_DB=.e2e-tmp2/db.sqlite NOORTASKS_DATA_DIR=.e2e-tmp2/files PORT=${API2_PORT} ${tsx} ../server/src/main.ts --no-auth`,
      url: `http://127.0.0.1:${API2_PORT}/api/v2/user/status`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: "ignore",
    },
    {
      command: `NOORTASKS_API=http://127.0.0.1:${API_PORT} npx vite preview --port ${WEB_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `NOORTASKS_API=http://127.0.0.1:${API2_PORT} npx vite preview --port ${WEB2_PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${WEB2_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
