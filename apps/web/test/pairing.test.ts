import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPairingQrPayload,
  consumeLaunchPairingParams,
  extractPairingToken,
  normalizeOriginUrl,
  parsePairingQr,
} from "../src/lib/pairing";

describe("QR pairing payload", () => {
  const origWindow = (globalThis as Record<string, unknown>).window;

  afterEach(() => {
    if (origWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = origWindow;
  });

  it("encodes an HTTPS server URL and one-time pairing token and round-trips cleanly", () => {
    const token = "abcDEF_123-4567890xyz";
    const payload = buildPairingQrPayload({ url: "https://tasks.example.com/", token });
    expect(payload).toBe(`https://tasks.example.com/#pair=${token}`);
    expect(parsePairingQr(payload)).toEqual({ url: "https://tasks.example.com", token });
  });

  it("normalizes bare hostnames and strips paths from QR payloads", () => {
    expect(normalizeOriginUrl("  tasks.example.com/some/path  ")).toBe("https://tasks.example.com");
    expect(normalizeOriginUrl("http://192.168.1.50:8099/setup")).toBe("http://192.168.1.50:8099");
    expect(buildPairingQrPayload({ url: "tasks.example.com:8443/extra", token: "tok123" })).toBe(
      "https://tasks.example.com:8443/#pair=tok123",
    );
  });

  it("parses JSON, custom scheme, and bare server URL fallbacks", () => {
    expect(parsePairingQr(JSON.stringify({ v: 1, url: "https://home.example.com/", token: "t1" }))).toEqual({
      url: "https://home.example.com",
      token: "t1",
    });
    expect(parsePairingQr("app.noortasks://pair?url=https%3A%2F%2Fhome.example.com&token=t2")).toEqual({
      url: "https://home.example.com",
      token: "t2",
    });
    expect(parsePairingQr("https://home.example.com")).toEqual({
      url: "https://home.example.com",
      token: null,
    });
  });

  it("rejects unsafe or malformed URLs and tokens", () => {
    for (const bad of [
      "",
      "javascript:alert(1)",
      "ftp://tasks.example.com",
      "https://user:pass@example.com",
      "https://tasks.example.com/#pair=has space",
      "not a url at all",
      "{bad json",
    ]) {
      expect(parsePairingQr(bad), bad).toBeNull();
    }
    expect(() => buildPairingQrPayload({ url: "javascript:alert(1)", token: "abc" })).toThrow("invalid_server_url");
    expect(() => buildPairingQrPayload({ url: "https://user:pass@example.com", token: "abc" })).toThrow("invalid_server_url");
    expect(() => buildPairingQrPayload({ url: "https://tasks.example.com", token: "   " })).toThrow("invalid_pairing_token");
    expect(() => buildPairingQrPayload({ url: "https://tasks.example.com", token: "a b" })).toThrow("invalid_pairing_token");
  });

  it("extracts pairing tokens from raw strings, fragments, and full QR URLs", () => {
    expect(extractPairingToken("  rawtoken123  ")).toBe("rawtoken123");
    expect(extractPairingToken("#pair=fragtoken")).toBe("fragtoken");
    expect(extractPairingToken("https://tasks.example.com/#pair=urltoken")).toBe("urltoken");
    expect(extractPairingToken('{"url":"https://tasks.example.com","token":"jsontoken"}')).toBe("jsontoken");
    expect(extractPairingToken("bad token with spaces")).toBe("");
  });

  it("captures and scrubs initial #pair= and ?setup_paired=1 params from window.location", () => {
    const replaceState = vi.fn();
    (globalThis as Record<string, unknown>).window = {
      location: {
        pathname: "/",
        search: "?setup_paired=1&keep=yes",
        hash: "#pair=oneTimeToken99",
      },
      history: { replaceState },
    };
    const res = consumeLaunchPairingParams();
    expect(res).toEqual({ pairToken: "oneTimeToken99", setupPaired: true });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?keep=yes");
  });
});
