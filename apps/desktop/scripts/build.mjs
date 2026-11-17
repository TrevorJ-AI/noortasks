import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("dist/phone", { recursive: true });
await build({
  entryPoints: ["src/main.ts"], outfile: "dist/main.js", bundle: true,
  platform: "node", format: "esm", target: "node24",
  external: ["electron", ...Object.keys(pkg.dependencies)],
});
await build({ entryPoints: ["src/preload.ts"], outfile: "dist/preload.cjs", bundle: true, platform: "node", format: "cjs", external: ["electron"] });
await build({ entryPoints: ["src/phone.ts"], outfile: "dist/phone/phone.js", bundle: true, platform: "browser", target: "es2022" });
cpSync("phone/index.html", "dist/phone/index.html");
cpSync("phone/style.css", "dist/phone/style.css");
cpSync("../web/src/styles/tokens.css", "dist/phone/tokens.css");
