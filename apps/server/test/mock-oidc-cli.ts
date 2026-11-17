// Local mock OIDC provider for the browser tests: tsx test/mock-oidc-cli.ts <port>
import { startMockOidc } from "./mock-oidc.js";

const port = Number(process.argv[2] ?? 0);
const p = await startMockOidc({ port });
console.log(`mock oidc at ${p.issuer}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void p.close().finally(() => process.exit(0)));
