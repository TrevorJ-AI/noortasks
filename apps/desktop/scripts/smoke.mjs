import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const binary = process.argv[2];
if (!binary) throw new Error("Usage: pnpm smoke /path/to/NoorTasks.AppImage (or unpacked executable)");
const data = mkdtempSync(resolve("dist/smoke-"));
const args = ["--hub-smoke-test", ...(process.env.NOORTASKS_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])];
const child = spawn(resolve(binary), args, {
  env: { ...process.env, TMPDIR: data, APPIMAGE_EXTRACT_AND_RUN: "1", NOORTASKS_SMOKE_DATA: data },
  stdio: ["ignore", "pipe", "pipe"],
});
let checked = false;
let diagnostics = "";
for (const stream of [child.stdout, child.stderr]) {
  let pending = "";
  stream.on("data", (chunk) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-16_000);
    pending += chunk.toString();
    const lines = pending.split("\n");
    pending = lines.pop();
    for (const line of lines) {
      const marker = line.indexOf("NOORTASKS_HUB_SMOKE ");
      if (marker === -1) continue;
      const result = JSON.parse(line.slice(marker + "NOORTASKS_HUB_SMOKE ".length));
      checked = result.health === 200 && Number(result.node.split(".")[0]) >= 22;
      // AppRun may redirect Electron's stdout to stderr; accept the marker from either.
      console.log(`Packaged hub verified: Electron ${result.electron}, Node ${result.node}, /healthz ${result.health}`);
    }
  });
}
const timer = setTimeout(() => { child.kill("SIGKILL"); }, 60_000);
try {
  const code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
  if (code !== 0 || !checked) {
    console.error(diagnostics);
    throw new Error(`Packaged hub smoke failed (exit ${code}, health marker ${checked})`);
  }
} finally {
  clearTimeout(timer);
  rmSync(data, { recursive: true, force: true });
}
