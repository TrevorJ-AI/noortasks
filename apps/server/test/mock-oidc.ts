import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";

/**
 * A small local OpenID Connect provider for tests (no network): discovery, JWKS, an authorize page with an
 * email field (for the browser tests), a token endpoint that checks the client secret, redirect URI and PKCE
 * verifier, and RS256 ID tokens. `overrides` per code lets a test hand out a token with a wrong audience,
 * an expired token, an unverified email, and so on.
 */
export interface MockOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Simulates the user approving at the provider: returns the code the provider would redirect back with. */
  approve(p: { state: string; nonce: string; challenge: string; redirectUri: string; email: string; name?: string; sub?: string; overrides?: Record<string, unknown> }): string;
  close(): Promise<void>;
}

const b64url = (b: Buffer): string => b.toString("base64url");

export async function startMockOidc(opts: { port?: number; host?: string; clientId?: string; clientSecret?: string } = {}): Promise<MockOidc> {
  const clientId = opts.clientId ?? "noortasks-test-client";
  const clientSecret = opts.clientSecret ?? "test-secret";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const wrongKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; email: string; name: string; sub: string; overrides: Record<string, unknown> }>();
  let issuer = "";

  const approve: MockOidc["approve"] = (p) => {
    const code = b64url(randomBytes(16));
    codes.set(code, { nonce: p.nonce, challenge: p.challenge, redirectUri: p.redirectUri, email: p.email, name: p.name ?? p.email.split("@")[0]!, sub: p.sub ?? `sub-${p.email}`, overrides: p.overrides ?? {} });
    return code;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const send = (status: number, body: unknown, type = "application/json"): void => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      void (async () => {
        if (url.pathname === "/.well-known/openid-configuration") {
          return send(200, {
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
            scopes_supported: ["openid", "email", "profile"],
          });
        }
        if (url.pathname === "/jwks") return send(200, { keys: [jwk] });
        if (url.pathname === "/authorize" && req.method === "GET") {
          const q = url.searchParams;
          if (q.get("client_id") !== clientId) return send(400, "unknown client", "text/plain");
          const hidden = ["state", "nonce", "code_challenge", "redirect_uri"].map((k) => `<input type="hidden" name="${k}" value="${(q.get(k) ?? "").replace(/"/g, "&quot;")}">`).join("");
          return send(200, `<!doctype html><title>Mock provider</title><form method="post" action="/authorize">${hidden}<label>Email <input name="email" data-testid="mock-email"></label><label>Name <input name="name" data-testid="mock-name"></label><button type="submit" data-testid="mock-approve">Continue</button></form>`, "text/html");
        }
        if (url.pathname === "/authorize" && req.method === "POST") {
          const f = new URLSearchParams(raw);
          const redirectUri = f.get("redirect_uri") ?? "";
          const code = approve({ state: f.get("state") ?? "", nonce: f.get("nonce") ?? "", challenge: f.get("code_challenge") ?? "", redirectUri, email: f.get("email") ?? "", ...(f.get("name") ? { name: f.get("name")! } : {}) });
          const back = new URL(redirectUri);
          back.searchParams.set("code", code);
          back.searchParams.set("state", f.get("state") ?? "");
          back.searchParams.set("iss", issuer);
          res.writeHead(302, { location: back.href });
          return res.end();
        }
        if (url.pathname === "/token" && req.method === "POST") {
          const f = new URLSearchParams(raw);
          let id = f.get("client_id");
          let secret = f.get("client_secret");
          const auth = req.headers.authorization;
          if (auth?.startsWith("Basic ")) {
            const [u, s] = Buffer.from(auth.slice(6), "base64").toString().split(":");
            id = decodeURIComponent(u ?? "");
            secret = decodeURIComponent(s ?? "");
          }
          if (id !== clientId || secret !== clientSecret) return send(401, { error: "invalid_client" });
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          if (!c) return send(400, { error: "invalid_grant" });
          if (c.redirectUri !== f.get("redirect_uri")) return send(400, { error: "invalid_grant", error_description: "redirect_uri" });
          const verifier = f.get("code_verifier") ?? "";
          if (b64url(createHash("sha256").update(verifier).digest()) !== c.challenge) return send(400, { error: "invalid_grant", error_description: "pkce" });
          const now = Math.floor(Date.now() / 1000);
          const claims: Record<string, unknown> = { email: c.email, email_verified: true, name: c.name, nonce: c.nonce, ...c.overrides };
          const jwt = await new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer((c.overrides.iss as string | undefined) ?? issuer)
            .setSubject(c.sub)
            .setAudience((c.overrides.aud as string | undefined) ?? clientId)
            .setIssuedAt((c.overrides.iat as number | undefined) ?? now)
            .setExpirationTime((c.overrides.exp as number | undefined) ?? now + 600)
            .sign(c.overrides.badSignature ? wrongKey : privateKey);
          return send(200, { access_token: b64url(randomBytes(16)), token_type: "Bearer", expires_in: 600, id_token: jwt });
        }
        send(404, { error: "not_found" });
      })().catch((e: unknown) => send(500, { error: String(e) }));
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", r));
  issuer = `http://${opts.host ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    clientId,
    clientSecret,
    approve,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
