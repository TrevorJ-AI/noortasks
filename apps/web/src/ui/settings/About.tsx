import { Command, Download, Keyboard, Laptop, Monitor, RefreshCw, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { getStoredServerUrl, isCapacitor } from "../../lib/capacitor";
import { useApp } from "../ctx";
import { PairingQrCode } from "../Setup";
import { StDialog } from "./kit";

type InstallEvent = Event & { prompt: () => Promise<void> };

/** Settings > About: welcome, quick actions, getting the app on other devices, credits. */
export function AboutTab({ onTab }: { onTab: (k: string) => void }): JSX.Element {
  const app = useApp();
  const [dialog, setDialog] = useState<"phone" | "desktop" | null>(null);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  useEffect(() => {
    const on = (e: Event): void => {
      e.preventDefault();
      setInstall(e as InstallEvent);
    };
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);
  // inside the app shell the page origin is local; the phone needs the server address
  const origin = isCapacitor() ? getStoredServerUrl() || location.origin : location.origin;
  return (
    <div className="st-about">
      <h2 className="ab-hello">Hi, welcome to NoorTasks!</h2>
      <p className="ab-text">
        Every feature is unlocked and your tasks live on your own server. New here? The{" "}
        <button className="ab-link" onClick={() => onTab("shortcuts")}>keyboard shortcuts</button> and the{" "}
        <button className="ab-link" onClick={() => app.setModal({ kind: "command" })}>command menu</button> (Ctrl+K) are the fastest way around.
      </p>
      <div className="ab-tiles">
        <button className="ab-tile" data-testid="about-shortcuts" onClick={() => onTab("shortcuts")}>
          <Keyboard size={22} />
          <span>Shortcuts</span>
        </button>
        <button className="ab-tile" data-testid="about-command" onClick={() => app.setModal({ kind: "command" })}>
          <Command size={22} />
          <span>Command Menu</span>
        </button>
        <button className="ab-tile" data-testid="about-sync" onClick={() => void app.engine.sync().then(() => app.toast("Synced"), () => app.toast("Could not reach the server"))}>
          <RefreshCw size={22} />
          <span>Sync Now</span>
        </button>
        <button className="ab-tile" data-testid="about-backup" onClick={() => onTab("profile")}>
          <Download size={22} />
          <span>Backup</span>
        </button>
      </div>

      <h2 className="ab-h">Get App</h2>
      <p className="ab-text">Use the same server on your phone, your computer and in any browser; everything stays in sync.</p>
      <div className="ab-tiles">
        <button className="ab-tile" data-testid="about-phone" onClick={() => setDialog("phone")}>
          <Smartphone size={22} />
          <span>Phone</span>
        </button>
        <button className="ab-tile" data-testid="about-desktop" onClick={() => (install ? void install.prompt().then(() => setInstall(null)) : setDialog("desktop"))}>
          <Laptop size={22} />
          <span>Desktop</span>
        </button>
        <button className="ab-tile" data-testid="about-web" onClick={() => (navigator.clipboard ? void navigator.clipboard.writeText(origin).then(() => app.toast("Address copied"), () => app.toast(origin)) : app.toast(origin))}>
          <Monitor size={22} />
          <span>Web</span>
        </button>
      </div>

      <h2 className="ab-h">Thanks</h2>
      <p className="ab-text ab-small">
        Built on open-source work: React, Dexie, Fastify, SQLite, Vite, Lucide icons and Simple Icons brand marks. Version {APP_VERSION}.
      </p>

      {dialog === "phone" && (
        <StDialog title="On your phone" sub="Scan with the camera, open the link, then use Add to Home Screen in the browser menu." onClose={() => setDialog(null)} testId="about-phone-dialog">
          <div className="ab-qr">
            <PairingQrCode payload={origin} />
            <code>{origin}</code>
          </div>
        </StDialog>
      )}
      {dialog === "desktop" && (
        <StDialog title="On your computer" sub="Open this address in Chrome or Edge and choose Install in the address bar to get a window of its own." onClose={() => setDialog(null)} testId="about-desktop-dialog">
          <div className="ab-qr">
            <code>{origin}</code>
          </div>
        </StDialog>
      )}
    </div>
  );
}

const APP_VERSION = "0.1.0";
