import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const quickadd = fileURLToPath(new URL("../../packages/quickadd/src/index.ts", import.meta.url));
const target = process.env.NOORTASKS_API ?? "http://127.0.0.1:18731";
// /feed serves the private ICS feed (token in the path, no session); the settings link points at this origin
const proxy = { "/api": { target, changeOrigin: false }, "/files": { target, changeOrigin: false }, "/feed": { target, changeOrigin: false } };

const allowedHosts = (process.env.NOORTASKS_PREVIEW_HOSTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@noortasks/quickadd": quickadd } },
  server: { host: "127.0.0.1", port: 5273, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4273, strictPort: true, proxy, ...(allowedHosts.length ? { allowedHosts } : {}) },
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: { include: ["test/**/*.test.ts"], environment: "node", testTimeout: 20000 },
});
