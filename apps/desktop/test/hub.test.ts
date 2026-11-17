import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataPath, readSettings, saveSettings, startHub } from "../src/hub";
import { allowedNavigation, safeExternal } from "../src/security";

const roots: string[] = [];
const hubs: Awaited<ReturnType<typeof startHub>>[] = [];
function temporary(): string {
  mkdirSync("dist", { recursive: true });
  const root = mkdtempSync(resolve("dist/unit-"));
  mkdirSync(join(root, "static"));
  writeFileSync(join(root, "static/index.html"), '<!doctype html><div id="root"></div>');
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop hub", () => {
  it("keeps data under the OS app-data directory with a stable product name", () => {
    expect(dataPath("/home/example/.config")).toBe(join("/home/example/.config", "NoorTasks"));
    const root = temporary();
    expect(readSettings(root)).toEqual({ port: 0, lan: false });
    saveSettings(root, { port: 12345, lan: true });
    expect(readSettings(root)).toEqual({ port: 12345, lan: true });
    expect(readFileSync(join(root, "desktop.json"), "utf8")).toContain("12345");
  });

  it("serves health and the web app on loopback, then closes the listener", async () => {
    const root = temporary();
    const hub = await startHub(root, join(root, "static"), { port: 0, lan: false });
    hubs.push(hub);
    expect(hub.server.app.server.address()).toMatchObject({ address: "127.0.0.1" });
    expect((await fetch(`${hub.origin}/healthz`)).status).toBe(200);
    expect((await (await fetch(hub.origin)).text())).toContain('<div id="root">');
    expect(existsSync(join(root, "system.sqlite"))).toBe(true);
    expect((await (await fetch(`${hub.origin}/api/auth/config`)).json()).setupRequired).toBe(true);
    expect((await fetch(`${hub.origin}/api/v2/projects`)).status).toBe(401);
    await hub.stop();
    await expect(fetch(`${hub.origin}/healthz`)).rejects.toThrow();
  });

  it("preserves setup, account data and the port after a restart; issues single-use pairing", async () => {
    const root = temporary();
    let hub = await startHub(root, join(root, "static"), { port: 0, lan: false });
    hubs.push(hub);
    const setup = await fetch(`${hub.origin}/api/setup`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "Desktop test", email: "owner@example.test", password: "test-password-123" }),
    });
    expect(setup.status).toBe(200);
    const body = await setup.json();
    expect(body.pairingToken).toBeTruthy();
    const port = hub.port;
    await hub.stop();
    hub = await startHub(root, join(root, "static"), { port, lan: false });
    hubs.push(hub);
    expect(hub.port).toBe(port);
    const config = await (await fetch(`${hub.origin}/api/auth/config`)).json();
    expect(config.setupRequired).not.toBe(true);
    expect(config.serverName).toBe("Desktop test");
    expect((await fetch(`${hub.origin}/api/setup/status`)).status).toBe(404);
    const pair = () => fetch(`${hub.origin}/api/auth/pair`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: body.pairingToken }),
    });
    expect((await pair()).status).toBe(200);
    expect((await pair()).status).toBe(403);
  });

  it("only binds other interfaces when LAN is explicitly enabled", async () => {
    const root = temporary();
    const hub = await startHub(root, join(root, "static"), { port: 0, lan: true });
    hubs.push(hub);
    expect(hub.server.app.server.address()).toMatchObject({ address: "0.0.0.0" });
  });

  it("rejects corrupt network settings", () => {
    const root = temporary();
    saveSettings(root, { port: -5, lan: false });
    expect(() => readSettings(root)).toThrow("Invalid desktop.json");
  });
});

it("keeps navigation local and rejects unsafe external protocols", () => {
  const origin = "http://127.0.0.1:12345";
  expect(allowedNavigation(`${origin}/setup`, origin)).toBe(true);
  expect(allowedNavigation("https://example.com", origin)).toBe(false);
  expect(allowedNavigation("http://127.0.0.1:54321", origin)).toBe(false);
  expect(allowedNavigation("file:///etc/passwd", origin)).toBe(false);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hi", "noortasks://pair"]) expect(safeExternal(url)).toBe(false);
  expect(safeExternal("https://example.com")).toBe(true);
});
