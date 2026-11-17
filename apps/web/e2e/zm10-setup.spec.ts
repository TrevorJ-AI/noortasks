import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

async function waitHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/healthz`);
      if (r.ok) return;
    } catch {
      /* starting */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not become healthy at ${baseUrl}`);
}

test("first-run setup on empty data dir creates admin, shows pairing QR, locks setup, and pairs second browser", async ({ browser }) => {
  const dir = mkdtempSync(join(tmpdir(), "noortasks-e2e-setup-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const webRoot = resolve(import.meta.dirname, "..");
  const tsx = resolve(webRoot, "../server/node_modules/.bin/tsx");
  const mainTs = resolve(webRoot, "../server/src/main.ts");

  const proc: ChildProcess = spawn(tsx, [mainTs], {
    cwd: webRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NOORTASKS_DB: join(dir, "noortasks.sqlite"),
      NOORTASKS_DATA_DIR: join(dir, "files"),
      NOORTASKS_CONFIG: join(dir, "config.json"),
      NOORTASKS_STATIC_DIR: resolve(webRoot, "dist"),
    },
    stdio: "ignore",
  });

  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Amsterdam", locale: "en-US" });
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Amsterdam", locale: "en-US" });
  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Europe/Amsterdam", locale: "en-US" });

  try {
    await waitHealth(baseUrl);

    const a = await ctxA.newPage();
    await a.goto(`${baseUrl}/`);
    await expect(a.getByTestId("setup-card")).toBeVisible();

    await a.getByTestId("setup-server-name").fill("Home Tasks");
    await a.getByTestId("setup-email").fill("admin@example.com");
    await a.getByTestId("setup-name").fill("Trevor");
    await a.getByTestId("setup-password").fill("correct horse battery");
    await a.getByTestId("setup-password-confirm").fill("correct horse battery");
    await a.getByTestId("setup-submit").click();

    await expect(a.getByTestId("pairing-panel")).toBeVisible();
    const qr = a.getByTestId("pairing-qr");
    await expect(qr).toBeVisible();
    const qrPayload = await qr.getAttribute("data-qr-payload");
    expect(qrPayload).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=.+`));

    await a.getByTestId("setup-continue").click();
    await expect(a.getByTestId("app")).toBeVisible();
    await expect(a.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });

    // Create a task in Browser A
    await a.getByTestId("quick-add-input").fill("First-run task synced");
    await a.getByTestId("quick-add-input").press("Enter");
    await expect(a.getByText("First-run task synced")).toBeVisible();
    await expect(a.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });

    // Setup route and API must be unreachable once setup is complete
    const setupGet = await ctxB.request.get(`${baseUrl}/setup`);
    expect(setupGet.status()).toBe(404);
    const setupPost = await ctxB.request.post(`${baseUrl}/api/setup`, {
      data: { serverName: "Evil", email: "evil@example.com", password: "password123" },
    });
    expect(setupPost.status()).toBe(403);

    // Second browser profile pairs using the QR link and sees the task
    const b = await ctxB.newPage();
    await b.goto(qrPayload!);
    await expect(b.getByTestId("app")).toBeVisible({ timeout: 15_000 });
    await expect(b.getByTestId("rail-sync")).toHaveAttribute("data-sync-state", "idle", { timeout: 15_000 });
    await expect(b.getByText("First-run task synced")).toBeVisible();

    // Pairing token is single-use: a third browser profile using the same link is rejected
    const c = await ctxC.newPage();
    await c.goto(qrPayload!);
    await expect(c.getByTestId("signin-card")).toBeVisible();
    await expect(c.getByTestId("signin-error")).toContainText("invalid or expired");
  } finally {
    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
    rmSync(dir, { recursive: true, force: true });
  }
});
