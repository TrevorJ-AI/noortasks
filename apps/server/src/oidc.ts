import * as client from "openid-client";
import { safeFetch } from "./network.js";

/**
 * OpenID Connect sign-in (authorization-code flow with PKCE, state and nonce) through `openid-client`.
 * Google is a regular OIDC provider (issuer https://accounts.google.com); Authentik, Keycloak and others use
 * the same code with their own issuer URL. The library checks the ID token signature against the provider's
 * JWKS, the issuer, the audience (our client id), expiry, and the nonce; we add `email_verified`.
 */
export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** The one redirect URL registered at the provider, e.g. https://tasks.example.com/api/auth/oidc/callback. */
  redirectUri: string;
  /** Button label ("Google" gives "Sign in with Google"). */
  label?: string;
  scopes?: string;
  /** Development and tests only: allow an http:// issuer. */
  allowInsecure?: boolean;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string;
  picture: string | null;
}

export class OidcError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class OidcClient {
  private cfg: Promise<client.Configuration> | undefined;
  constructor(readonly conf: OidcConfig) {}

  private config(): Promise<client.Configuration> {
    if (!this.cfg) {
      this.cfg = client
        .discovery(new URL(this.conf.issuer), this.conf.clientId, this.conf.clientSecret, undefined, { ...(this.conf.allowInsecure === true ? {} : { [client.customFetch]: (url, options) => safeFetch(url, options as RequestInit) }), execute: [...(this.conf.allowInsecure === true ? [client.allowInsecureRequests] : []), client.enableNonRepudiationChecks] })
        .catch((e: unknown) => {
          // retry discovery on the next sign-in instead of caching the failure
          this.cfg = undefined;
          throw e;
        });
    }
    return this.cfg;
  }

  /** Builds the provider URL and the secrets that must come back with the callback (kept server-side). */
  async start(): Promise<{ url: string; state: string; verifier: string; nonce: string }> {
    const config = await this.config();
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    const state = client.randomState();
    const nonce = client.randomNonce();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.conf.redirectUri,
      scope: this.conf.scopes ?? "openid email profile",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
      prompt: "select_account",
    });
    return { url: url.href, state, verifier, nonce };
  }

  /**
   * Exchanges the code. `callbackQuery` is the raw query string of the callback request; the URL it is checked
   * against is always the configured redirect URI, never the request's Host header.
   */
  async finish(callbackQuery: string, checks: { state: string; verifier: string; nonce: string }): Promise<OidcIdentity> {
    const config = await this.config();
    const current = new URL(this.conf.redirectUri);
    current.search = callbackQuery;
    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(config, current, {
        pkceCodeVerifier: checks.verifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
    } catch (e) {
      throw new OidcError(e instanceof Error && /access_denied/.test(e.message) ? "access_denied" : "token_rejected");
    }
    const c = tokens.claims();
    if (!c || typeof c.sub !== "string") throw new OidcError("token_rejected");
    const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
    if (!email) throw new OidcError("no_email");
    return {
      issuer: String(c.iss),
      subject: c.sub,
      email,
      emailVerified: c.email_verified === true,
      name: typeof c.name === "string" ? c.name : email.split("@")[0]!,
      picture: typeof c.picture === "string" ? c.picture : null,
    };
  }
}
