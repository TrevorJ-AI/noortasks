import { encode } from "uqr";
import { buildPairingQrPayload } from "../../web/src/lib/pairing";

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
interface State {
  tailscale: { ready: boolean; message: string };
  sharedOrigin?: string;
  setupRequired: boolean;
  lan: boolean;
  lanUrls: string[];
}
declare global {
  interface Window {
    hub: {
      status(): Promise<Result<State>>;
      share(): Promise<Result<string>>;
      lan(): Promise<Result<boolean>>;
      pair(): Promise<Result<{ token: string; expiresMs: number }>>;
      openApp(): Promise<Result<void>>;
    };
  }
}
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const el = (id: string) => document.getElementById(id)!;
const address = el("address") as HTMLSelectElement;
const error = el("error");
let busy = false;
let expires = 0;
let token = "";

async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function clearPairing(): void {
  token = "";
  expires = 0;
  el("pairing").hidden = true;
  el("qr").replaceChildren();
  (el("pair-link") as HTMLInputElement).value = "";
}

async function refresh(): Promise<void> {
  const state = await unwrap(window.hub.status());
  el("setup").hidden = !state.setupRequired;
  el("ts-status").textContent = state.sharedOrigin ? `HTTPS is ready: ${state.sharedOrigin}` : state.tailscale.message;
  button("share").disabled = !state.tailscale.ready || !!state.sharedOrigin;
  button("share").textContent = state.sharedOrigin ? "HTTPS enabled" : "Enable Tailscale HTTPS";
  button("lan").textContent = state.lan ? "Turn off local network access" : "Enable local network access";
  const previous = address.value;
  address.replaceChildren();
  const urls = [...(state.sharedOrigin ? [state.sharedOrigin] : []), ...(state.lan ? state.lanUrls : [])];
  for (const url of urls) address.add(new Option(url, url));
  if (!urls.length) address.add(new Option("Enable a connection above first", ""));
  if (urls.includes(previous)) address.value = previous;
  if (previous !== address.value) clearPairing();
  button("pair").disabled = !address.value || state.setupRequired;
}

async function act(action: () => Promise<unknown> = async () => {}): Promise<void> {
  if (busy) return;
  busy = true;
  error.hidden = true;
  const buttons = [...document.querySelectorAll("button")];
  const disabled = buttons.map((b) => b.disabled);
  buttons.forEach((b) => { b.disabled = true; });
  try { await action(); }
  catch (cause) { error.textContent = cause instanceof Error ? cause.message : "Could not complete this action."; error.hidden = false; }
  finally {
    buttons.forEach((b, i) => { b.disabled = disabled[i]!; });
    try { await refresh(); } catch (cause) { error.textContent = String(cause); error.hidden = false; }
    busy = false;
  }
}

function renderQr(): void {
  if (!token || !address.value) return;
  const payload = buildPairingQrPayload({ url: address.value, token });
  const qr = encode(payload, { border: 4, ecc: "M" });
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${qr.size} ${qr.size}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Phone pairing QR code");
  const background = document.createElementNS(ns, "rect");
  background.setAttribute("width", "100%"); background.setAttribute("height", "100%"); background.setAttribute("fill", "white");
  const path = document.createElementNS(ns, "path");
  const points: string[] = [];
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.data[y]![x]) points.push(`M${x} ${y}h1v1h-1z`);
  path.setAttribute("d", points.join("")); path.setAttribute("fill", "#111");
  svg.append(background, path);
  el("qr").replaceChildren(svg);
  (el("pair-link") as HTMLInputElement).value = payload;
  el("pairing").hidden = false;
}

button("open-app").onclick = () => void act(() => unwrap(window.hub.openApp()));
button("refresh").onclick = () => void act();
button("share").onclick = () => void act(async () => { await unwrap(window.hub.share()); clearPairing(); });
button("lan").onclick = () => void act(async () => { await unwrap(window.hub.lan()); clearPairing(); });
button("pair").onclick = () => void act(async () => {
  const pairing = await unwrap(window.hub.pair());
  token = pairing.token;
  expires = pairing.expiresMs;
  renderQr();
});
address.onchange = renderQr;
setInterval(() => {
  if (!token) return;
  const seconds = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
  el("expiry").textContent = `Code expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  if (!seconds) { clearPairing(); error.textContent = "Pairing code expired. Choose Show pairing QR to create a new one."; error.hidden = false; }
}, 1000);
void act();
