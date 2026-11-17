import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { hashPassphrase } from "../src/auth.js";
import { diffExports, exportBackup, importBackup } from "../src/importExport.js";
import { buildServer, loadServerConfig } from "../src/server.js";
import { Store } from "../src/store.js";
import { makeExport, task, tmp } from "./helpers.js";
import { mkMulti } from "./multi-helpers.js";

function tablesHash(path: string): Record<string, string> {
  const st = new Store(path);
  const out: Record<string, string> = {};
  for (const { name } of st.all<{ name: string }>("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name")) {
    out[name] = createHash("sha256").update(JSON.stringify(st.all(`select * from ${name}`))).digest("hex");
  }
  st.close();
  return out;
}

describe("migration: the single-user database becomes the admin's account", () => {
  test("real-shaped backup: import, first multi-user start, sign in with the old passphrase, export round trip is lossless", async () => {
    const dir = tmp();
    const src = join(dir, "export");
    makeExport(src, { completed: 40, trash: 20 });
    const legacy = join(dir, "legacy.sqlite");
    importBackup(src, legacy);
    const before = tablesHash(legacy);

    const m = await mkMulti({ dir, config: { passphraseHash: await hashPassphrase("old passphrase 1"), admins: ["owner@example.com"], passwordLogin: true } });
    const admin = m.sys!.user(Number(m.sys!.getMeta("legacyAdminId")))!;
    expect(admin).toMatchObject({ email: "owner@example.com", role: "admin", dbFile: legacy });
    // the account id is the user id the data already carried
    expect(admin.id).toBe(Number(new Store(legacy).getMeta("userId")));
    // the old sign-in form (bare passphrase) still signs in, as the admin
    const s = await m.anon("POST", "/api/v2/user/signon", { username: "noortasks", password: "old passphrase 1" });
    expect(s.status).toBe(200);
    expect((await m.anon("POST", "/api/v2/user/signon", { username: "noortasks", password: "wrong one" })).status).toBe(401);
    const check = (await m.admin.call("GET", "/api/v3/batch/check/0")).json;
    expect(check.syncTaskBean.update.map((t: any) => t.title).sort()).toEqual(["synthetic 1", "synthetic 2", "synthetic 3"]);
    expect(check.inboxId).toBe("inbox424242");
    const trash = (await m.admin.call("GET", "/api/v2/project/all/trash/page?limit=100")).json;
    expect(trash.tasks.length).toBe(20);
    await m.app.close();

    // nothing in the legacy database changed by starting and reading
    const after = tablesHash(legacy);
    for (const k of Object.keys(before)) if (k !== "meta" && k !== "sessions") expect(after[k], k).toBe(before[k]);
    // and the importer round trip from the migrated account is still exact
    const out = join(dir, "out");
    exportBackup(legacy, out);
    const d = diffExports(src, out);
    expect(d.mismatches).toBe(0);
  });

  test("an OIDC-only config also hands the existing data to the configured admin, and a restart changes nothing", async () => {
    const dir = tmp();
    const legacy = join(dir, "legacy.sqlite");
    const m0 = await mkMulti({ dir, config: { admins: ["owner@example.com"] } });
    const inbox = (await m0.admin.call("GET", "/api/v3/batch/check/0")).json.inboxId;
    await m0.admin.call("POST", "/api/v2/batch/task", { add: [task({ projectId: inbox, title: "kept" })] });
    const id0 = m0.admin.id;
    await m0.app.close();
    const m1 = await mkMulti({ dir, config: { admins: ["owner@example.com"] } });
    expect(m1.admin.id).toBe(id0);
    expect(m1.sys!.users().length).toBe(1);
    expect(m1.sys!.user(id0)!.dbFile).toBe(legacy);
    expect(JSON.stringify((await m1.admin.call("GET", "/api/v3/batch/check/0")).json)).toContain("kept");
    await m1.app.close();
  });

  test("config loading: oidc needs every field and an https redirect", () => {
    const dir = tmp();
    const p = join(dir, "c.json");
    writeFileSync(p, JSON.stringify({ oidc: { issuer: "https://accounts.google.com", clientId: "x", clientSecret: "y", redirectUri: "http://tasks.example.com/api/auth/oidc/callback" } }));
    expect(() => loadServerConfig(p)).toThrow(/https/);
    writeFileSync(p, JSON.stringify({ oidc: { issuer: "https://accounts.google.com", clientId: "x", redirectUri: "https://tasks.example.com/api/auth/oidc/callback" } }));
    expect(() => loadServerConfig(p)).toThrow(/clientSecret/);
    writeFileSync(p, JSON.stringify({}));
    expect(() => loadServerConfig(p)).toThrow(/oidc/);
    writeFileSync(p, JSON.stringify({ oidc: { issuer: "https://accounts.google.com", clientId: "x", clientSecret: "y", redirectUri: "https://tasks.example.com/api/auth/oidc/callback" }, admins: ["a@example.com"] }));
    expect(loadServerConfig(p).oidc!.clientId).toBe("x");
  });
});

describe("production serving", () => {
  async function mkStatic(noAuth: boolean) {
    const dir = tmp();
    const web = join(dir, "dist");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>NoorTasks</title>");
    writeFileSync(join(web, "assets", "app-abc.js"), "console.log(1)");
    writeFileSync(join(dir, "secret.txt"), "do not serve");
    const srv = await buildServer({
      dbPath: join(dir, "db.sqlite"),
      dataDir: join(dir, "files"),
      staticDir: web,
      noAuth,
      ...(noAuth ? {} : { config: { passphraseHash: await hashPassphrase("passphrase!"), passwordLogin: true } }),
    });
    return srv;
  }

  for (const noAuth of [false, true]) {
    test(`static files, SPA fallback and /healthz (${noAuth ? "single-user" : "multi-user"})`, async () => {
      const { app } = await mkStatic(noAuth);
      const h = await app.inject({ method: "GET", url: "/healthz" });
      expect(h.statusCode).toBe(200);
      expect(h.json()).toEqual({ ok: true });
      const idx = await app.inject({ method: "GET", url: "/" });
      expect(idx.statusCode).toBe(200);
      expect(idx.body).toContain("<title>NoorTasks</title>");
      expect(idx.headers["cache-control"]).toBe("no-cache");
      const deep = await app.inject({ method: "GET", url: "/q/today/tasks" });
      expect(deep.body).toContain("<title>NoorTasks</title>");
      const asset = await app.inject({ method: "GET", url: "/assets/app-abc.js" });
      expect(asset.body).toBe("console.log(1)");
      expect(asset.headers["cache-control"]).toContain("immutable");
      expect((await app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode).toBe(404);
      for (const evil of ["/../secret.txt", "/%2e%2e/secret.txt", "/assets/..%2f..%2fsecret.txt"]) {
        const r = await app.inject({ method: "GET", url: evil });
        expect(r.body, evil).not.toContain("do not serve");
      }
      if (!noAuth) {
        // API paths never fall back to the web app: no session, no data
        expect((await app.inject({ method: "GET", url: "/api/v2/user/status" })).statusCode).toBe(401);
        expect((await app.inject({ method: "GET", url: "/api/unknown/thing" })).statusCode).toBe(401);
      } else {
        expect((await app.inject({ method: "GET", url: "/api/v2/user/status" })).statusCode).toBe(200);
      }
      await app.close();
    });
  }
});
