import { join } from "node:path";
import { buildServer, type BuiltServer, type ServerConfig, type ServerOptions } from "../src/server.js";
import { tmp } from "./helpers.js";

export type Call = (m: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any; headers: Record<string, unknown> }>;
export interface TestUser {
  id: number;
  email: string;
  call: Call;
}

/** A multi-user server on temp files with a bootstrap admin (admin@example.com) owning the "legacy" database. */
export async function mkMulti(over: { config?: ServerConfig; opts?: Partial<ServerOptions>; dir?: string } = {}): Promise<
  BuiltServer & { dir: string; admin: TestUser; addUser: (email: string, name?: string) => TestUser; as: (id: number) => TestUser; anon: Call }
> {
  const dir = over.dir ?? tmp();
  const srv = await buildServer({
    dbPath: join(dir, "legacy.sqlite"),
    dataDir: join(dir, "files"),
    config: { admins: ["admin@example.com"], passwordLogin: true, ...(over.config ?? {}) },
    ...(over.opts ?? {}),
  });
  const sys = srv.sys!;
  const tenants = srv.tenants!;
  const mkCall =
    (cookie?: { t: string; csrf: string }): Call =>
    async (m, url, body, headers = {}) => {
      const r = await srv.app.inject({
        method: m as "GET",
        url,
        ...(body !== undefined ? { payload: body as object } : {}),
        headers: { ...(cookie ? { cookie: `t=${cookie.t}; _csrf_token=${cookie.csrf}`, "x-csrftoken": cookie.csrf } : {}), ...headers },
      });
      let json: any;
      try {
        json = r.json();
      } catch {
        json = r.body;
      }
      return { status: r.statusCode, json, headers: r.headers as Record<string, unknown> };
    };
  const as = (id: number): TestUser => {
    const u = sys.user(id)!;
    return { id, email: u.email, call: mkCall({ t: sys.createSession(id), csrf: "csrf-" + id }) };
  };
  let n = 0;
  const addUser = (email: string, name?: string): TestUser => {
    const id = 1000 + ++n;
    const paths = tenants.newPaths(id);
    tenants.initStore(id, paths.dbFile);
    sys.insertUser({ id, email, name: name ?? email.split("@")[0]!, role: "member", status: "active", issuer: null, subject: null, passwordHash: null, dbFile: paths.dbFile, createdMs: Date.now() });
    sys.allow(email, null);
    return as(id);
  };
  const adminId = Number(sys.getMeta("legacyAdminId"));
  return { ...srv, dir, admin: adminId ? as(adminId) : (undefined as unknown as TestUser), addUser, as, anon: mkCall() };
}
