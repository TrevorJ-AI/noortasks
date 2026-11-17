import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "./service.js";

export const JSON_LIMIT = 2 * 1024 * 1024;
export const UPLOAD_LIMIT = 64 * 1024 * 1024;

/** Request paths can contain bearer credentials too, not just query parameters. */
export function requestLogPath(raw: string): string {
  const path = raw.split("?")[0]!;
  return path.startsWith("/feed/") ? "/feed/[redacted]" : path;
}

/** Browser-origin check also protects sign-in/setup, where no CSRF cookie exists yet. */
export function checkBrowserOrigin(req: FastifyRequest): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site") throw new ApiError(403, "origin_failed");
  const origin = req.headers.origin;
  if (origin === undefined) return; // native clients still need the session + CSRF check
  let expected: string;
  try {
    expected = new URL(`${req.protocol}://${req.host}`).origin;
    if (typeof origin !== "string" || new URL(origin).origin !== expected) throw new Error();
  } catch {
    throw new ApiError(403, "origin_failed");
  }
}

export function installHttpSecurity(app: FastifyInstance): void {
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (req.url.startsWith("/api/") || req.url.startsWith("/feed/") || req.url.startsWith("/files/")) reply.header("cache-control", "no-store");
    if (!(req.raw as { ntActor?: unknown }).ntActor) checkBrowserOrigin(req);
  });
  app.addHook("preValidation", async (req) => {
    // Iterative traversal avoids recursion exhaustion and prototype-key hazards in map-shaped APIs.
    const queue: Array<{ value: unknown; depth: number }> = [{ value: req.body, depth: 0 }];
    let nodes = 0;
    while (queue.length) {
      const { value, depth } = queue.pop()!;
      if (++nodes > 50_000 || depth > 32) throw new ApiError(400, "payload_too_complex");
      if (!value || typeof value !== "object") continue;
      if (Array.isArray(value) && value.length > 1000) throw new ApiError(400, "batch_too_large");
      for (const [key, child] of Object.entries(value)) {
        if (key === "password" && typeof child === "string" && child.length > 1024) throw new ApiError(400, "password_too_long");
        if (["__proto__", "constructor", "prototype"].includes(key) || typeof child === "string" && /(?:id|name|scope|key)$/i.test(key) && ["__proto__", "constructor", "prototype"].includes(child)) throw new ApiError(400, "invalid_key");
        queue.push({ value: child, depth: depth + 1 });
      }
    }
  });
}
