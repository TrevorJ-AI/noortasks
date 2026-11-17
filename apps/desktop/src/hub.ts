import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../../server/src/server.js";

export interface HubSettings { port: number; lan: boolean }

/** Electron supplies app.getPath('appData'); the name stays stable across releases. */
export function dataPath(appData: string): string {
  return join(appData, "NoorTasks");
}

export function readSettings(root: string): HubSettings {
  const path = join(root, "desktop.json");
  if (!existsSync(path)) return { port: 0, lan: false };
  const value = JSON.parse(readFileSync(path, "utf8")) as HubSettings;
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || typeof value.lan !== "boolean") {
    throw new Error("Invalid desktop.json. Restore it from backup or remove it to choose a new local port.");
  }
  return { port: value.port, lan: value.lan };
}

export function saveSettings(root: string, settings: HubSettings): void {
  writeFileSync(join(root, "desktop.json"), JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

export async function startHub(root: string, staticDir: string, settings: HubSettings) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const server = await buildServer({
    dbPath: join(root, "noortasks.sqlite"),
    dataDir: join(root, "files"),
    systemDbPath: join(root, "system.sqlite"),
    usersDir: join(root, "users"),
    staticDir,
    // Local HTTP and Tailscale HTTPS use separate host cookies. LAN remains explicitly opt-in.
    secureCookies: false,
    trustProxy: false,
  });
  try {
    await server.app.listen({ host: settings.lan ? "0.0.0.0" : "127.0.0.1", port: settings.port });
  } catch (error) {
    await server.app.close();
    throw error;
  }
  const address = server.app.server.address();
  if (!address || typeof address === "string") {
    await server.app.close();
    throw new Error("The desktop server did not open a TCP port.");
  }
  return {
    server,
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => server.app.close(),
  };
}
