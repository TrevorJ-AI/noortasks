import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { LookupAddress } from "node:dns";

const blocked = new BlockList();
for (const [ip, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3], ["192.88.99.0", 24],
] as const) blocked.addSubnet(ip, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [ip, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(ip, bits, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function publicUrl(input: string | URL): URL {
  const url = new URL(input);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (isIP(host) && !isPublicAddress(host)) || host === "localhost" || host.endsWith(".localhost") ||
      !host.includes(".") && !isIP(host)) throw new Error("outbound_url_blocked");
  return url;
}

/** Resolve once, validate every answer, and use only that answer for the connection. */
export async function publicAddresses(host: string, resolve = lookup): Promise<LookupAddress[]> {
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) throw new Error("outbound_address_blocked");
  return addresses;
}

export const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
const OUTBOUND_TIMEOUT_MS = 10_000;
let active = 0;

/** Bounded, DNS-pinned HTTP transport. Redirects are refused, so credentials never move to another host. */
export const safeFetch: typeof fetch = async (input, init) => {
  if (active >= 8) throw new Error("outbound_busy");
  active++;
  try {
    const req = new Request(input, init);
    const url = publicUrl(req.url);
    if (url.protocol !== "https:" && req.headers.has("authorization")) throw new Error("outbound_credentials_require_https");
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(OUTBOUND_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const addresses = await Promise.race([
      publicAddresses(url.hostname.replace(/^\[|\]$/g, "")),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("outbound_timeout")), { once: true })),
    ]);
    signal.throwIfAborted();
    const body = req.body ? Buffer.from(await req.arrayBuffer()) : undefined;
    if (body && body.length > MAX_REMOTE_BYTES) throw new Error("outbound_body_too_large");
    const headers = Object.fromEntries(req.headers);
    headers["accept-encoding"] = "identity";
    delete headers.host;
    return await new Promise<Response>((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: req.method, headers, signal, agent: false,
        // Preserve hostname/SNI/certificate validation while eliminating the second DNS lookup.
        lookup: (_host, options, callback) => {
          const selected = addresses[0]!;
          if (options.all) callback(null, addresses);
          else callback(null, selected.address, selected.family);
        },
      }, (res) => {
        const status = res.statusCode ?? 502;
        if (status >= 300 && status < 400 && status !== 304) {
          res.destroy();
          reject(new Error("outbound_redirect_blocked"));
          return;
        }
        if (Number(res.headers["content-length"]) > MAX_REMOTE_BYTES ||
            res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
          res.destroy();
          reject(new Error("outbound_response_too_large"));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_REMOTE_BYTES) res.destroy(new Error("outbound_response_too_large"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          resolve(new Response([101, 204, 205, 304].includes(status) || req.method === "HEAD" ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
        });
      });
      request.on("error", reject);
      request.end(body);
    });
  } finally {
    active--;
  }
};
