import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session, shell, Tray } from "electron";
import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dataPath, readSettings, saveSettings, startHub } from "./hub.js";
import { allowedNavigation, safeExternal } from "./security.js";
import { detectTailscale, enableTailscale, serveState, type TailscaleState } from "./tailscale.js";

const here = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes("--hub-smoke-test");
app.setName("NoorTasks");
if (smoke && !process.env.NOORTASKS_SMOKE_DATA) throw new Error("Smoke tests require an isolated data directory.");
const root = smoke ? process.env.NOORTASKS_SMOKE_DATA! : dataPath(app.getPath("appData"));
mkdirSync(root, { recursive: true, mode: 0o700 });
app.setPath("userData", root);

let hub: Awaited<ReturnType<typeof startHub>> | undefined;
let main: BrowserWindow | undefined;
let phone: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;
let closed = false;
let stopping = false;
let exitStatus = 0;
let changingNetwork = false;
let sharedOrigin: string | undefined;
const phoneFile = join(here, "phone", "index.html");
const phoneUrl = pathToFileURL(phoneFile).href;
const tailscaleStatus = (): Promise<TailscaleState> => smoke
  ? Promise.resolve({ installed: false, ready: false, message: "Tailscale is disabled during the isolated smoke test." })
  : detectTailscale();

function protect(window: BrowserWindow, origin?: string): void {
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, target) => {
    if (!(origin ? allowedNavigation(target, origin) : target === phoneUrl)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, target) => {
    if (!(origin ? allowedNavigation(target, origin) : target === phoneUrl)) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (safeExternal(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

async function showApp(): Promise<void> {
  if (!hub) return;
  if (!main || main.isDestroyed()) {
    main = new BrowserWindow({
      width: 1240, height: 820, minWidth: 800, minHeight: 600, title: "NoorTasks", show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    protect(main, hub.origin);
    main.on("close", (event) => { if (!quitting) { event.preventDefault(); main?.hide(); } });
    await main.loadURL(hub.origin);
  }
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
}

async function showPhone(): Promise<void> {
  if (!phone || phone.isDestroyed()) {
    phone = new BrowserWindow({
      width: 580, height: 820, minWidth: 420, minHeight: 560, title: "Use on my phone", show: false,
      webPreferences: { preload: join(here, "preload.cjs"), nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    protect(phone);
    await phone.loadFile(phoneFile);
  }
  phone.show();
  phone.focus();
}

function registerPhoneActions(): void {
  const handle = (name: string, action: () => Promise<unknown>) => {
    ipcMain.handle(`hub:${name}`, async (event) => {
      // Reject subframes, the web app, and every URL except the packaged phone page.
      if (!phone || event.sender !== phone.webContents || event.senderFrame !== phone.webContents.mainFrame || event.senderFrame.url !== phoneUrl) {
        throw new Error("Untrusted desktop request");
      }
      try { return { ok: true, value: await action() }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Request failed" }; }
    });
  };
  handle("status", async () => {
    const ts = await tailscaleStatus();
    sharedOrigin = undefined;
    if (ts.command && ts.origin) {
      try { if (await serveState(ts.command, ts.origin, hub!.port) === "ours") sharedOrigin = ts.origin; }
      catch { /* status UI still offers refresh and LAN */ }
    }
    const config = await (await fetch(`${hub!.origin}/api/auth/config`)).json() as { setupRequired?: boolean };
    return {
      tailscale: ts,
      sharedOrigin,
      setupRequired: !!config.setupRequired,
      lan: settings.lan,
      lanUrls: Object.values(networkInterfaces()).flatMap((entries) => (entries ?? [])
        .filter((entry) => entry.family === "IPv4" && !entry.internal)
        .map((entry) => `http://${entry.address}:${hub!.port}`)),
    };
  });
  handle("share", async () => {
    sharedOrigin = await enableTailscale(await tailscaleStatus(), hub!.port);
    return sharedOrigin;
  });
  handle("lan", async () => {
    if (changingNetwork) throw new Error("Network settings are already changing. Please wait.");
    changingNetwork = true;
    const previous = { ...settings };
    try {
      await hub!.stop();
      let replacement: Awaited<ReturnType<typeof startHub>> | undefined;
      try {
        const next = { ...settings, lan: !settings.lan };
        replacement = await startHub(root, staticDir, next);
        saveSettings(root, next);
        hub = replacement;
        settings = next;
      } catch (error) {
        await replacement?.stop();
        hub = await startHub(root, staticDir, previous);
        settings = previous;
        throw error;
      }
      return settings.lan;
    } finally { changingNetwork = false; }
  });
  handle("pair", async () => {
    const cookies = await session.defaultSession.cookies.get({ url: hub!.origin, name: "_csrf_token" });
    const csrf = cookies[0]?.value;
    if (!csrf) throw new Error("Create your account or sign in in NoorTasks first, then return here.");
    const response = await session.defaultSession.fetch(`${hub!.origin}/api/auth/pairing-token`, {
      method: "POST", credentials: "include", headers: { "x-csrftoken": csrf },
    });
    if (!response.ok) throw new Error("Sign in in NoorTasks first, then return here to show a pairing code.");
    // The existing server owns authentication, token generation, expiry and single-use redemption.
    return await response.json();
  });
  handle("open-app", showApp);
}

let settings = { port: 0, lan: false };
const staticDir = app.isPackaged ? join(process.resourcesPath, "web") : join(here, "../../web/dist");

async function boot(): Promise<void> {
  await app.whenReady();
  settings = readSettings(root);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "notifications"));
  hub = await startHub(root, staticDir, settings);
  settings.port = hub.port;
  saveSettings(root, settings);
  registerPhoneActions();
  const menu = [
    { label: "Open NoorTasks", click: () => void showApp() },
    { label: "Use on my phone", click: () => void showPhone() },
    { type: "separator" as const },
    { label: "Quit NoorTasks", click: () => app.quit() },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "NoorTasks", submenu: menu },
    { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }] },
  ]));
  // A PNG works on Linux and Windows tray implementations; keep a strong reference.
  const icon = nativeImage.createFromPath(join(staticDir, "apple-touch-icon.png")).resize({ width: 24, height: 24 });
  tray = new Tray(icon);
  tray.setToolTip("NoorTasks is running. Keep this computer awake for phone sync.");
  tray.setContextMenu(Menu.buildFromTemplate(menu));
  tray.on("click", () => void showApp());
  await showApp();
  if (smoke) {
    // A real packaged Electron main process, SQLite server and Chromium renderer must all work.
    const response = await fetch(`${hub.origin}/healthz`);
    if (response.status !== 200) throw new Error(`Health check returned ${response.status}`);
    if (!(await main!.webContents.executeJavaScript("!!document.querySelector('#root')"))) throw new Error("Web app root is missing");
    await showPhone();
    const beforeSignIn = await phone!.webContents.executeJavaScript("window.hub.pair()");
    if (beforeSignIn.ok) throw new Error("Pairing was allowed before sign-in");
    const setup = await session.defaultSession.fetch(`${hub.origin}/api/setup`, {
      method: "POST", credentials: "include", headers: { "content-type": "application/json" },
      body: JSON.stringify({ serverName: "Smoke hub", email: "smoke@example.test", password: "isolated-smoke-password" }),
    });
    if (!setup.ok) throw new Error(`Smoke account setup returned ${setup.status}`);
    await setup.json();
    // Exercise the actual sandboxed preload, sender validation, Chromium session cookies and CSRF.
    const pairing = await phone!.webContents.executeJavaScript("window.hub.pair()");
    if (!pairing.ok || !pairing.value?.token) throw new Error(`Packaged phone pairing failed: ${pairing.error}`);
    const redeem = () => fetch(`${hub!.origin}/api/auth/pair`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: pairing.value.token }),
    });
    if ((await redeem()).status !== 200 || (await redeem()).status !== 403) throw new Error("Packaged pairing token was not single-use");
    const bridgeExposed = await main!.webContents.executeJavaScript("typeof window.hub !== 'undefined'");
    if (bridgeExposed) throw new Error("Desktop bridge was exposed to the web app");
    console.log(`NOORTASKS_HUB_SMOKE ${JSON.stringify({ origin: hub.origin, node: process.versions.node, electron: process.versions.electron, health: response.status })}`);
    app.quit();
  }
}

app.on("window-all-closed", () => { /* server and tray stay alive */ });
app.on("activate", () => void showApp());
app.on("second-instance", () => void showApp());
app.on("before-quit", (event) => {
  quitting = true;
  if (closed) return;
  event.preventDefault();
  if (stopping) return;
  stopping = true;
  void (async () => {
    try { await hub?.stop(); }
    catch { console.error("The desktop server could not close cleanly."); exitStatus = 1; }
    closed = true;
    tray?.destroy();
    app.exit(exitStatus);
  })();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => app.quit());

if (!app.requestSingleInstanceLock()) app.quit();
else void boot().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  console.error(`NoorTasks startup failed: ${message}`);
  if (!smoke) dialog.showErrorBox("NoorTasks could not start", `${message}\n\nClose other NoorTasks instances. If the saved port is occupied, free it or remove desktop.json from your NoorTasks app-data folder.`);
  exitStatus = 1;
  app.quit();
});
