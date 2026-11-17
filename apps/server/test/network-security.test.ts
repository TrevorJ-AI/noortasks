import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ port: 0, requests: 0, lookup: vi.fn(), pinned: [] as string[] }));
vi.mock("node:dns/promises", () => ({ lookup: fixture.lookup }));
vi.mock("node:https", async () => {
  const http = await import("node:http");
  return { request: (url: URL, options: any, cb: any) => {
    fixture.requests++;
    options.lookup(url.hostname, { all: true }, (_err: unknown, answers: Array<{ address: string }>) => {
      fixture.pinned = answers.map((a) => a.address);
    });
    // The fixture is the sole network target. Production URL/DNS validation runs before this adapter.
    return http.request(`http://127.0.0.1:${fixture.port}${url.pathname}`, { ...options, lookup: undefined }, cb);
  } };
});
import { MAX_REMOTE_BYTES, isPublicAddress, publicAddresses, safeFetch } from "../src/network.js";

let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.1/private" }); return res.end(); }
    if (req.url === "/big") return res.end(Buffer.alloc(MAX_REMOTE_BYTES + 1));
    if (req.url === "/chunked") { res.write(Buffer.alloc(MAX_REMOTE_BYTES)); return res.end(Buffer.alloc(1)); }
    if (req.url === "/gzip") { res.setHeader("content-encoding", "gzip"); return res.end("compressed"); }
    if (req.url === "/hang") return;
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.port = (server.address() as { port: number }).port;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  fixture.requests = 0;
  fixture.pinned = [];
  fixture.lookup.mockReset().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});

describe("outbound SSRF and resource boundary", () => {
  test.each(["0.0.0.0", "10.1.2.3", "127.0.0.1", "100.100.100.100", "169.254.169.254", "172.16.0.1", "192.168.1.1", "198.18.0.1", "224.0.0.1", "::", "::1", "::ffff:127.0.0.1", "fc00::1", "fd7a:115c:a1e0::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"])("rejects non-public address %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
  test.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("permits public address %s", (ip) => expect(isPublicAddress(ip)).toBe(true));
  test.each(["http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://[::1]/", "file:///etc/passwd", "https://user:secret@example.com/", "http://100.64.1.2/"])("blocks URL before opening a socket: %s", async (url) => {
    await expect(safeFetch(url)).rejects.toThrow();
    expect(fixture.requests).toBe(0);
  });
  test("rejects mixed public/private DNS answers and a rebinding response", async () => {
    fixture.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(publicAddresses("public.example")).rejects.toThrow("outbound_address_blocked");
    expect(await (await safeFetch("https://public.example/ok")).text()).toBe("ok");
    expect(fixture.pinned).toEqual(["8.8.8.8"]);
    expect(fixture.lookup).toHaveBeenCalledTimes(2); // one per attempt, never a separate connection lookup
    fixture.lookup.mockResolvedValueOnce([{ address: "100.64.0.1", family: 4 }]);
    await expect(safeFetch("https://public.example/ok")).rejects.toThrow("outbound_address_blocked");
    expect(fixture.requests).toBe(1);
  });
  test("refuses redirects rather than forwarding credentials or following into a private network", async () => {
    await expect(safeFetch("https://public.example/redirect", { headers: { authorization: "Bearer fixture" } })).rejects.toThrow("outbound_redirect_blocked");
    expect(fixture.requests).toBe(1);
  });
  test.each(["big", "chunked", "gzip"])("bounds upstream %s responses", async (path) => {
    await expect(safeFetch(`https://public.example/${path}`)).rejects.toThrow("outbound_response_too_large");
  });
  test("aborts stalled responses and disallows cleartext credentials", async () => {
    await expect(safeFetch("https://public.example/", { signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(safeFetch("https://public.example/hang", { signal: AbortSignal.timeout(30) })).rejects.toThrow();
    await expect(safeFetch("http://public.example/", { headers: { authorization: "Basic fixture" } })).rejects.toThrow("outbound_credentials_require_https");
  });
});
