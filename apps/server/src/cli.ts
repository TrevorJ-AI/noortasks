#!/usr/bin/env -S npx tsx
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateVAPIDKeys } from "web-push";
import { diffExports, exportBackup, formatDiff, importBackup } from "./importExport.js";
import { hashPassphrase } from "./auth.js";
import { attachFiles } from "./attachments.js";

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i]!.startsWith("--")) i++;
    else out.push(args[i]!);
  }
  return out;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "import-backup":
    case "import-ticktick": {
      const [dir] = positional(args);
      const db = opt(args, "--db");
      if (!dir || !db) return usage();
      const r = importBackup(dir, db);
      console.log(JSON.stringify(r.counts, null, 1));
      console.log(`passthrough documents: ${r.blobs}, unparsable files: ${r.skippedFiles}, duplicate task ids skipped: ${r.duplicates}`);
      return 0;
    }
    case "export-backup":
    case "export-ticktick": {
      const [out] = positional(args);
      const db = opt(args, "--db");
      if (!out || !db) return usage();
      console.log(JSON.stringify(exportBackup(db, out), null, 1));
      return 0;
    }
    case "attach-files": {
      const [dir] = positional(args);
      const db = opt(args, "--db");
      const dataDir = opt(args, "--data-dir");
      if (!dir || !db || !dataDir) return usage();
      const r = attachFiles(dir, db, dataDir);
      console.log(`pending: ${r.pending}, attached: ${r.attached}, missing file: ${r.missing}, failed verification: ${r.failed}`);
      return r.failed === 0 ? 0 : 1;
    }
    case "diff-export": {
      const [a, b] = positional(args);
      if (!a || !b) return usage();
      const rep = diffExports(a, b);
      console.log(formatDiff(rep));
      return rep.mismatches === 0 ? 0 : 1;
    }
    case "hash-passphrase": {
      // reads the passphrase from stdin (never from argv) and writes {passphraseHash} to the config file
      const cfg = positional(args)[0];
      if (!cfg) return usage();
      const pass = readFileSync(0, "utf8").replace(/\r?\n$/, "");
      if (pass.length < 8) {
        console.error("passphrase must be at least 8 characters");
        return 2;
      }
      // keeps the other settings (oidc, admins, ...) when the file already exists
      let prev: Record<string, unknown> = {};
      if (existsSync(cfg)) prev = JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>;
      writeFileSync(cfg, JSON.stringify({ ...prev, passphraseHash: await hashPassphrase(pass) }, null, 2), { mode: 0o600 });
      console.log(`wrote ${cfg}`);
      return 0;
    }
    case "generate-vapid": {
      const out = positional(args)[0];
      if (!out) return usage();
      const subject = opt(args, "--subject") ?? "mailto:noortasks@localhost";
      const keys = generateVAPIDKeys();
      writeFileSync(out, JSON.stringify({ ...keys, subject }, null, 2), { mode: 0o600 });
      console.log(`wrote ${out}`);
      return 0;
    }
    default:
      return usage();
  }
}

function usage(): number {
  console.error(
    "usage:\n  import-backup <export dir> --db <path>     (alias: import-ticktick)\n  export-backup --db <path> <out dir>        (alias: export-ticktick)\n  attach-files <attachments dir> --db <path> --data-dir <path>\n  diff-export <dirA> <dirB>\n  hash-passphrase <config file>   (passphrase on stdin)\n  generate-vapid <vapid file> [--subject mailto:...]",
  );
  return 2;
}

process.exitCode = await main();
