import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { detectTailscale, enableTailscale, HTTPS_PORT, serveState } from "../src/tailscale";

const dns = "desktop.example-tail.ts.net";
const origin = `https://${dns}:${HTTPS_PORT}`;
const ready = { installed: true, ready: true, command: "tailscale", origin, message: "Ready" };
const proxy = (port = 12345) => JSON.stringify({ Web: { [`${dns}:${HTTPS_PORT}`]: { Handlers: { "/": { Proxy: `http://127.0.0.1:${port}` } } } } });

describe("Tailscale commands (always mocked)", () => {
  it("reports a missing executable without running Serve", async () => {
    const run = vi.fn().mockRejectedValue(new Error("ENOENT"));
    expect(await detectTailscale(run, "linux")).toMatchObject({ installed: false, ready: false });
    expect(run.mock.calls).toEqual([["tailscale", ["version"]]]);
  });

  it("finds Windows installations outside PATH", async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce("1.90.0").mockResolvedValueOnce(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${dns}.` } }));
    expect(await detectTailscale(run, "win32", "C:/Program Files")).toMatchObject({ ready: true, command: join("C:/Program Files", "Tailscale", "tailscale.exe"), origin });
  });

  it("detects a signed-in daemon without ever configuring sharing", async () => {
    const run = vi.fn().mockResolvedValueOnce("1.90.0").mockResolvedValueOnce(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${dns}.` } }));
    expect(await detectTailscale(run, "linux")).toMatchObject({ ready: true, origin });
    expect(run.mock.calls.map((call) => call[1])).toEqual([["version"], ["status", "--json"]]);
  });

  it("explains login, stopped daemon and invalid status failures", async () => {
    for (const status of ["not json", JSON.stringify({ BackendState: "NeedsLogin" }), JSON.stringify({ BackendState: "Running", Self: { DNSName: "evil.example.com/path" } })]) {
      const run = vi.fn().mockResolvedValueOnce("1.90.0").mockResolvedValueOnce(status);
      expect(await detectTailscale(run)).toMatchObject({ installed: true, ready: false });
    }
    const run = vi.fn().mockResolvedValueOnce("1.90.0").mockRejectedValueOnce(new Error("daemon unavailable"));
    expect(await detectTailscale(run)).toMatchObject({ installed: true, ready: false });
  });

  it("starts HTTPS only on explicit enable and verifies its handler", async () => {
    const run = vi.fn().mockResolvedValueOnce("{}").mockResolvedValueOnce("Serving").mockResolvedValueOnce(proxy());
    expect(await enableTailscale(ready, 12345, run)).toBe(origin);
    expect(run.mock.calls).toEqual([
      ["tailscale", ["serve", "status", "--json"]],
      ["tailscale", ["serve", "--bg", "--https=8443", "http://127.0.0.1:12345"]],
      ["tailscale", ["serve", "status", "--json"]],
    ]);
  });

  it("refuses to replace another app's proxy", async () => {
    const run = vi.fn().mockResolvedValue(proxy(54321));
    await expect(enableTailscale(ready, 12345, run)).rejects.toThrow("already in use");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses to change a shared port with additional handlers", async () => {
    const config = JSON.parse(proxy());
    config.Web[`${dns}:${HTTPS_PORT}`].Handlers["/other"] = { Proxy: "http://127.0.0.1:54321" };
    expect(await serveState("tailscale", origin, 12345, vi.fn().mockResolvedValue(JSON.stringify(config)))).toBe("occupied");
  });

  it("preserves raw TCP listeners, other hosts and public Funnel settings", async () => {
    for (const config of [
      { TCP: { "8443": { TCPForward: "127.0.0.1:5555" } } },
      { Web: { "other.example-tail.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5555" } } } } },
      { ...JSON.parse(proxy()), AllowFunnel: { [`${dns}:8443`]: true } },
    ]) {
      const run = vi.fn().mockResolvedValue(JSON.stringify(config));
      await expect(enableTailscale(ready, 12345, run)).rejects.toThrow("already in use");
      expect(run).toHaveBeenCalledTimes(1);
    }
  });

  it("propagates permission/HTTPS errors and rejects unconfirmed sharing", async () => {
    const denied = vi.fn().mockResolvedValueOnce("{}").mockRejectedValueOnce(new Error("permission denied"));
    await expect(enableTailscale(ready, 12345, denied)).rejects.toThrow("permissions");
    const unconfirmed = vi.fn().mockResolvedValue("{}");
    await expect(enableTailscale(ready, 12345, unconfirmed)).rejects.toThrow("did not confirm");
    await expect(enableTailscale({ installed: false, ready: false, message: "Missing" }, 12345, vi.fn())).rejects.toThrow("Missing");
  });
});
