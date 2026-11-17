import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type Run = (file: string, args: string[]) => Promise<string>;
export const runCommand: Run = async (file, args) =>
  (await exec(file, args, { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout;

export interface TailscaleState {
  installed: boolean;
  command?: string;
  origin?: string;
  ready: boolean;
  message: string;
}

// Use a dedicated HTTPS port; never replace another application's Serve handler.
export const HTTPS_PORT = 8443;

export async function detectTailscale(run: Run = runCommand, platform = process.platform, programFiles = process.env.ProgramFiles): Promise<TailscaleState> {
  const candidates = ["tailscale"];
  if (platform === "win32" && programFiles) candidates.push(join(programFiles, "Tailscale", "tailscale.exe"));
  let command: string | undefined;
  for (const candidate of candidates) {
    try { await run(candidate, ["version"]); command = candidate; break; } catch { /* try installed path */ }
  }
  if (!command) return { installed: false, ready: false, message: "Tailscale is not installed. Install it on this computer and your phone, or use the local network option below." };
  try {
    const status = JSON.parse(await run(command, ["status", "--json"])) as { BackendState?: string; Self?: { DNSName?: string } };
    const dns = status.Self?.DNSName?.replace(/\.$/, "");
    if (status.BackendState !== "Running" || !dns || !/^[a-z0-9.-]+\.ts\.net$/i.test(dns)) {
      return { installed: true, command, ready: false, message: "Open Tailscale and sign in. Enable MagicDNS and HTTPS for your tailnet, then refresh." };
    }
    return { installed: true, command, origin: `https://${dns}:${HTTPS_PORT}`, ready: true, message: "Tailscale is ready. Your phone must be signed in to the same tailnet." };
  } catch {
    return { installed: true, command, ready: false, message: "Tailscale is installed but its status is unavailable. Start Tailscale and sign in, then refresh." };
  }
}

type ServeConfig = {
  TCP?: Record<string, unknown>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

export async function serveState(command: string, origin: string, port: number, run: Run = runCommand): Promise<"free" | "ours" | "occupied"> {
  const config = JSON.parse(await run(command, ["serve", "status", "--json"])) as ServeConfig;
  const host = new URL(origin).host;
  if (config.AllowFunnel?.[host]) return "occupied";
  if (Object.keys(config.Web ?? {}).some((key) => key.endsWith(`:${HTTPS_PORT}`) && key !== host)) return "occupied";
  const handlers = config.Web?.[host]?.Handlers;
  if (!handlers || Object.keys(handlers).length === 0) return config.TCP?.[String(HTTPS_PORT)] ? "occupied" : "free";
  return Object.keys(handlers).length === 1 && handlers["/"]?.Proxy === `http://127.0.0.1:${port}` ? "ours" : "occupied";
}

export async function enableTailscale(state: TailscaleState, port: number, run: Run = runCommand): Promise<string> {
  if (!state.ready || !state.command || !state.origin) throw new Error(state.message);
  if (await serveState(state.command, state.origin, port, run) === "occupied") {
    throw new Error(`Tailscale HTTPS port ${HTTPS_PORT} is already in use. Its existing configuration was left unchanged.`);
  }
  try {
    await run(state.command, ["serve", "--bg", `--https=${HTTPS_PORT}`, `http://127.0.0.1:${port}`]);
  } catch {
    throw new Error("Tailscale could not enable HTTPS. Check its permissions and enable HTTPS in the Tailscale admin console. Then refresh and try again.");
  }
  if (await serveState(state.command, state.origin, port, run) !== "ours") throw new Error("Tailscale did not confirm the HTTPS proxy. Refresh and check its configuration.");
  return state.origin;
}
