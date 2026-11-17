import { Check, Copy, KeyRound, QrCode, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { encode } from "uqr";
import { AUTH_ERROR_TEXT, type AuthConfig } from "../data/accounts";
import { HttpError } from "../data/api";
import { buildPairingQrPayload, normalizeOriginUrl } from "../lib/pairing";
import { useApp } from "./ctx";

export interface PairingState {
  serverName: string;
  token: string;
  expiresMs: number;
}

export function GoogleMark(): JSX.Element {
  return (
    <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

export function PairingQrCode({ payload }: { payload: string }): JSX.Element {
  const { size, path } = useMemo(() => {
    const qr = encode(payload, { border: 2, ecc: "M" });
    const parts: string[] = [];
    for (let y = 0; y < qr.size; y++) {
      const row = qr.data[y]!;
      for (let x = 0; x < qr.size; x++) {
        if (row[x]) parts.push(`M${x} ${y}h1v1h-1z`);
      }
    }
    return { size: qr.size, path: parts.join("") };
  }, [payload]);

  return (
    <div className="pairing-qr-box" data-testid="pairing-qr" data-qr-payload={payload}>
      <svg viewBox={`0 0 ${size} ${size}`} width="200" height="200" role="img" aria-label="Phone pairing QR code">
        <rect width={size} height={size} fill="#ffffff" />
        <path d={path} fill="#111111" />
      </svg>
    </div>
  );
}

export function PairingPanel({
  serverName,
  token,
  onRegenerate,
  onDone,
  doneLabel = "Continue to NoorTasks",
}: {
  serverName: string;
  token: string;
  onRegenerate: () => Promise<void>;
  onDone: () => void;
  doneLabel?: string;
}): JSX.Element {
  const defaultUrl = typeof window !== "undefined" ? window.location.origin : "https://tasks.example.com";
  const [urlInput, setUrlInput] = useState(defaultUrl);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const normalized = normalizeOriginUrl(urlInput);
  const qrPayload = useMemo(() => {
    if (!normalized || !token) return null;
    try {
      return buildPairingQrPayload({ url: normalized, token });
    } catch {
      return null;
    }
  }, [normalized, token]);

  const isHttp = !!normalized && normalized.startsWith("http://");

  const copyLink = async (): Promise<void> => {
    if (!qrPayload) return;
    try {
      await navigator.clipboard?.writeText(qrPayload);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked in insecure context */
    }
  };

  return (
    <div className="pairing-panel" data-testid="pairing-panel">
      <div className="pairing-head">
        <QrCode size={22} />
        <h2>Pair your phone</h2>
      </div>
      <p className="signin-sub">
        <strong>{serverName || "NoorTasks"}</strong> is ready. Scan this QR code in the NoorTasks Android app, or open the link in another browser.
      </p>

      {qrPayload ? (
        <PairingQrCode payload={qrPayload} />
      ) : (
        <div className="error">Enter a valid http:// or https:// server URL to generate the QR code.</div>
      )}

      <label className="col pairing-field">
        <span className="muted small">Server URL in QR</span>
        <input
          className="field full"
          type="url"
          data-testid="pairing-server-url"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="https://tasks.example.com"
        />
      </label>

      {isHttp && (
        <div className="pairing-hint muted small">
          Use an HTTPS address (via reverse proxy or Tailscale) so phones can install the web app and sync offline.
        </div>
      )}

      {qrPayload && (
        <div className="pairing-code-box">
          <code className="pairing-code-text" data-testid="pairing-url">{qrPayload}</code>
          <div className="row gap">
            <button type="button" className="btn sm" data-testid="pairing-copy" onClick={() => void copyLink()}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied ? "Copied" : "Copy link"}</span>
            </button>
            <button
              type="button"
              className="btn sm"
              data-testid="pairing-refresh"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onRegenerate();
                } finally {
                  setBusy(false);
                }
              }}
            >
              <RefreshCw size={14} />
              <span>New code</span>
            </button>
          </div>
        </div>
      )}

      <div className="muted small">Single-use pairing token, expires in 10 minutes.</div>

      <button type="button" className="btn primary full" data-testid="setup-continue" onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  );
}

export function SetupCard({
  cfg,
  onComplete,
}: {
  cfg: AuthConfig;
  onComplete: (pairing: PairingState) => void;
}): JSX.Element {
  const { engine } = useApp();
  const [setupToken, setSetupToken] = useState("");
  const [serverName, setServerName] = useState("NoorTasks");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const cleanServerName = serverName.trim();

  return (
    <div className="signin">
      <div className="signin-card setup-card" data-testid="setup-card">
        <img src="/icon.svg" width={44} height={44} alt="" />
        <h2>Set up NoorTasks</h2>
        <p className="signin-sub">Choose a server name and create the first admin account.</p>

        <label className="col pairing-field">
          <span className="muted small">Server name</span>
          <input
            className="field full"
            type="text"
            maxLength={80}
            required
            placeholder="My NoorTasks"
            aria-label="Server name"
            data-testid="setup-server-name"
            value={serverName}
            onChange={(e) => setServerName(e.target.value)}
          />
        </label>

        <label className="col pairing-field">
          <span className="muted small">Setup token from your server configuration</span>
          <input className="field full" type="password" required autoComplete="off" aria-label="Setup token" data-testid="setup-token" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} />
        </label>

        {cfg.oidc && (
          <a
            className="btn full signin-oidc"
            data-testid="setup-oidc"
            href={engine.api.url(`/api/setup/oidc/start?setupToken=${encodeURIComponent(setupToken)}&serverName=${encodeURIComponent(cleanServerName || "NoorTasks")}`)}
            onClick={(e) => {
              if (!cleanServerName) {
                e.preventDefault();
                setErr("Enter a server name first.");
              }
            }}
          >
            {cfg.oidc.label === "Google" ? <GoogleMark /> : <KeyRound size={16} />}
            <span>Sign in with {cfg.oidc.label}</span>
          </a>
        )}

        {cfg.oidc && cfg.password && <div className="signin-or">or</div>}

        {cfg.password && (
          <form
            className="signin-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setErr("");
              if (!cleanServerName) {
                setErr("Enter a server name.");
                return;
              }
              if (pw.length < 8) {
                setErr("Password must be at least 8 characters.");
                return;
              }
              if (pw !== confirmPw) {
                setErr("Passwords do not match.");
                return;
              }
              setBusy(true);
              try {
                const res = await engine.api.post<{
                  ok: boolean;
                  serverName: string;
                  pairingToken: string;
                  pairingExpiresMs: number;
                }>("/api/setup", {
                  setupToken,
                  serverName: cleanServerName,
                  email,
                  name,
                  password: pw,
                });
                onComplete({
                  serverName: res.serverName,
                  token: res.pairingToken,
                  expiresMs: res.pairingExpiresMs,
                });
              } catch (x) {
                const c = x instanceof HttpError ? String((x.body as { errorCode?: string } | undefined)?.errorCode ?? "") : "";
                setErr(
                  c === "setup_token_required"
                    ? "Enter the setup token configured by the server owner."
                    : c === "setup_locked"
                    ? AUTH_ERROR_TEXT.setup_locked!
                    : c === "invalid_email"
                      ? "Enter a valid email address."
                      : c === "password_too_short"
                        ? "Password must be at least 8 characters."
                        : c === "invalid_server_name"
                          ? "Enter a server name (up to 80 characters)."
                          : "Could not complete setup. Try again.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <input
              className="field full"
              type="email"
              required
              autoComplete="username"
              placeholder="Admin email"
              aria-label="Admin email"
              data-testid="setup-email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              className="field full"
              type="text"
              maxLength={80}
              placeholder="Your name (optional)"
              aria-label="Your name"
              data-testid="setup-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="field full"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Password (8+ characters)"
              aria-label="Password"
              data-testid="setup-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            <input
              className="field full"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="Confirm password"
              aria-label="Confirm password"
              data-testid="setup-password-confirm"
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
            />
            <button className="btn primary full" type="submit" disabled={busy} data-testid="setup-submit">
              {busy ? "Creating account..." : "Create admin & continue"}
            </button>
          </form>
        )}

        {err && (
          <div className="error" role="alert" data-testid="setup-error">
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
