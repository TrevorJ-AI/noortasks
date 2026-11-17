# NoorTasks desktop hub

The desktop app runs the existing Node server inside Electron and opens NoorTasks
in its own window. It supports Windows x64 (NSIS installer) and Linux x64
(AppImage). Electron supplies Node and SQLite; no separate Node installation is
needed by the person using the app.

## Install and start

Download the installer for your platform from the project's GitHub release.
Windows installers are currently unsigned, so Windows may ask you to confirm
the publisher before running them. On Linux:

```bash
chmod +x NoorTasks-*.AppImage
./NoorTasks-*.AppImage
```

If FUSE is unavailable, use `APPIMAGE_EXTRACT_AND_RUN=1 ./NoorTasks-*.AppImage`.
Launch as an ordinary user with Chromium's sandbox enabled. The headless CI smoke
test has an explicit sandbox override for constrained runners; it is not the
normal launch configuration.

Create the first admin account in the existing setup wizard. Setup locks after
that first account is created. NoorTasks initially listens only on loopback,
on an available port saved for future launches. If another program later takes
that port, quit NoorTasks, free the port or remove `desktop.json`, then restart.

Closing the main window hides it; the server keeps running. Use the tray menu to
open NoorTasks, choose **Use on my phone**, or quit. You can also find those actions
in the application menu. On Linux, your desktop environment needs tray/AppIndicator
support to show the icon. Launching NoorTasks again reopens the existing instance.
Phone sync requires this computer to stay awake and the desktop app to stay open.
The app does not install a background service or start at login.

## Use on my phone

Open **NoorTasks → Use on my phone** or the tray action.

### Tailscale HTTPS

1. Install and sign in to Tailscale on the computer and phone, using the same
   tailnet. Enable MagicDNS and HTTPS in the tailnet settings.
2. Choose **Refresh**, then **Enable Tailscale HTTPS**. This explicitly runs:

   ```bash
   tailscale serve --bg --https=8443 http://127.0.0.1:<saved-port>
   ```

3. Select the HTTPS address and choose **Show pairing QR**. You must have created
   an account and signed in in the main NoorTasks window first.
4. Scan with the NoorTasks Android app, or open the pairing link in the phone's
   browser. The same server setup and pairing routes used by the web app issue
   and redeem these tokens. Each token works once and expires in 10 minutes.

The phone screen uses a dedicated HTTPS port, 8443. It checks the existing Serve
configuration first and refuses to overwrite another proxy, extra handlers, a TCP
listener, or a public Funnel configuration on that port. It does not enable
Funnel. If Tailscale needs extra privileges or HTTPS approval, the screen shows
the next steps; it does not attempt elevation or open an interactive shell.

Tailscale Serve is persistent, independent of NoorTasks. Quitting stops the local
server but leaves the Tailscale proxy configured. To remove it explicitly:

```bash
tailscale serve --https=8443 off
```

The local server uses HTTP on loopback and does not trust forwarded client IPs.
Cookies are not marked `Secure` because the same server serves the desktop's
loopback HTTP session; the Tailscale connection itself is HTTPS. See
[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

### Local network alternative

Choose **Enable local network access**, then select the computer's home-network
address. This restarts the listener on `0.0.0.0` using the same saved port and data.
It requires both devices on a trusted network and a firewall rule allowing the
app. It uses unencrypted HTTP, including pairing links and session traffic.
Never forward this port on your router. The setting persists until you choose
**Turn off local network access**.

Phone browsers cannot install the PWA or use service workers or Web Push on a
plain HTTP LAN origin. The Android app or browser can connect while online, but
use HTTPS for the full web app experience. LAN addresses may change after a
reconnect. Tailscale HTTPS is the recommended connection.

## Data and backups

Everything lives under Electron's OS app-data directory, with a stable product
folder named `NoorTasks`:

| Platform | Default path |
| --- | --- |
| Windows | `%APPDATA%\NoorTasks` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/NoorTasks` |

This folder contains `noortasks.sqlite`, `system.sqlite`, attachments in `files/`,
additional accounts under `users/`, the saved port and LAN preference in
`desktop.json`, and Chromium's browser profile. No user data is written next to
the installer. Back up the whole folder with NoorTasks fully quit; use the web
app's backup controls for task exports. The Windows uninstaller preserves data.

Auto-update is off. There is no updater client, update check or update feed.
Quit the app and install a newer release manually. Keep the app-data folder to
retain accounts, task data and the saved port.

## Build from source

Use Node 22+ and the repository's pinned pnpm version:

```bash
pnpm install --frozen-lockfile
node apps/desktop/node_modules/electron/install.js
pnpm --filter @noortasks/desktop package:linux
# On Windows:
pnpm --filter @noortasks/desktop package:win
```

The build compiles the web app, bundles the server and desktop sources, and
packages runtime dependencies into the app archive. Installers go to
`apps/desktop/dist/installers/`. No installed application depends on the source
checkout or workspace symlinks. The checked-in 512px icon is rasterized from
`apps/web/public/icon.svg`.

For a disk-constrained Linux builder, put **both** Electron download caches and
builder helpers on a roomy volume. The installer uses lowercase
`electron_config_cache`; electron-builder accepts an explicit download cache:

```bash
export ELECTRON_CACHE=/path/on/large-volume/electron-cache
export electron_config_cache="$ELECTRON_CACHE"
export ELECTRON_BUILDER_CACHE="$ELECTRON_CACHE/builder"
node apps/desktop/node_modules/electron/install.js
pnpm --filter @noortasks/desktop package:linux --config.electronDownload.cache="$ELECTRON_CACHE"
```

After validating the AppImage, remove `apps/desktop/dist/installers/linux-unpacked/`
and temporary builder reports to recover space. Keep the `.AppImage` itself.

`.github/workflows/desktop-release.yml` builds the AppImage on Ubuntu and the
NSIS installer on Windows when a `v*` tag is pushed, sets the desktop version
from the tag, and attaches installers and SHA-256 checksums to the release. The
Linux job runs the packaged smoke test before uploading. No release workflow
needs to run during local development.

## Validation

```bash
pnpm --filter @noortasks/desktop build
pnpm --filter @noortasks/desktop test
pnpm --filter @noortasks/desktop typecheck
xvfb-run -a pnpm --filter @noortasks/desktop smoke "$PWD"/apps/desktop/dist/installers/*.AppImage
```

Only for CI environments that cannot provide Chromium sandbox support, prefix
the smoke command with `NOORTASKS_SMOKE_NO_SANDBOX=1`. The smoke runner extracts
the actual AppImage without FUSE, uses an isolated app-data directory, loads the
packaged web app, checks `/healthz` over HTTP from the in-process server, prints
the Electron and Node versions, and exercises authenticated pairing through the
sandboxed phone bridge, including rejection before sign-in and single-use token
redemption. It then shuts down and removes its temporary data. Tailscale is
disabled in smoke mode. Unit tests mock all Tailscale commands.

The runtime is pinned to Electron 45.3.3, which ships Node 24.22.3, above the
server's Node 22 minimum. The packaged smoke test verifies that this runtime can
open SQLite and start the server. See the
[Electron release table](https://releases.electronjs.org/).

Windows packaging is configured for the release runner; a Linux build does not
claim Windows runtime or physical phone validation.
