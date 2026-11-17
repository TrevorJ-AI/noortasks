import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildApp, type AppOptions, type BuiltApp, type TenantHooks } from "./app.js";
import { Store } from "./store.js";
import type { SystemStore } from "./system.js";

/**
 * One app (store + services + routes) per account. Every account's data lives in its own SQLite file and
 * attachments folder, so a query in any of the ~250 single-user routes can only ever see that account's rows.
 * The migrated single-user database keeps its path and becomes the first admin's file.
 */
export interface TenantsOptions {
  sys: SystemStore;
  /** Folder for new accounts: <usersDir>/<id>/data.sqlite and <usersDir>/<id>/files. */
  usersDir: string;
  /** The single-user database and attachments folder (become the bootstrap admin's). */
  legacyDbPath: string;
  legacyDataDir: string;
  /** Options shared by every account's app (VAPID, calendar OAuth, clock, ...). */
  common: Omit<AppOptions, "store" | "dbPath" | "dataDir" | "noAuth" | "auth" | "tenant">;
  hooksFor?: (userId: number) => TenantHooks;
}

export class Tenants {
  private open = new Map<number, BuiltApp>();
  private readyP = new Map<number, Promise<void>>();

  constructor(private o: TenantsOptions) {
    mkdirSync(o.usersDir, { recursive: true, mode: 0o700 });
  }

  /** Paths for a brand-new account. */
  newPaths(id: number): { dbFile: string; dataDir: string } {
    const dir = join(this.o.usersDir, String(id));
    return { dbFile: join(dir, "data.sqlite"), dataDir: join(dir, "files") };
  }

  dataDirOf(dbFile: string): string {
    return dbFile === this.o.legacyDbPath ? this.o.legacyDataDir : join(dirname(dbFile), "files");
  }

  /** Creates the store for a new account with its user id fixed before the services start. */
  initStore(id: number, dbFile: string): void {
    mkdirSync(dirname(dbFile), { recursive: true, mode: 0o700 });
    const st = new Store(dbFile);
    try {
      if (!st.getMeta("userId")) st.setMeta("userId", String(id));
    } finally {
      st.close();
    }
  }

  /** The account's app, opened on first use (sync: services are usable at once; call ready() before routing). */
  get(userId: number): BuiltApp {
    let b = this.open.get(userId);
    if (b) return b;
    const u = this.o.sys.user(userId);
    if (!u) throw new Error(`no account ${userId}`);
    const store = new Store(u.dbFile);
    if (Number(store.getMeta("userId")) !== userId) {
      store.close();
      throw new Error(`account ${userId}: database belongs to another user id`);
    }
    b = buildApp({
      ...this.o.common,
      store,
      dataDir: this.dataDirOf(u.dbFile),
      // the front signs requests in; the account app trusts it (it is never reachable on its own)
      noAuth: true,
      ...(this.o.hooksFor ? { tenant: this.o.hooksFor(userId) } : {}),
    });
    this.open.set(userId, b);
    return b;
  }

  async ready(userId: number): Promise<BuiltApp> {
    const b = this.get(userId);
    let p = this.readyP.get(userId);
    if (!p) {
      p = Promise.resolve(b.app.ready()).then(() => undefined);
      this.readyP.set(userId, p);
    }
    await p;
    return b;
  }

  isOpen(userId: number): boolean {
    return this.open.has(userId);
  }
  openIds(): number[] {
    return [...this.open.keys()];
  }

  async close(userId: number): Promise<void> {
    const b = this.open.get(userId);
    if (!b) return;
    this.open.delete(userId);
    this.readyP.delete(userId);
    await b.app.close();
    b.store.close();
  }

  async closeAll(): Promise<void> {
    for (const id of [...this.open.keys()]) await this.close(id);
  }

  /** Deletes an account's database and attachments (admin, after a confirm step). Never the legacy paths' parents. */
  async deleteData(userId: number): Promise<void> {
    const u = this.o.sys.user(userId);
    if (!u) return;
    await this.close(userId);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(u.dbFile + suffix, { force: true });
    rmSync(this.dataDirOf(u.dbFile), { recursive: true, force: true });
  }
}
