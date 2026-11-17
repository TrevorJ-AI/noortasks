import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { Store } from "./store.js";

const scryptImpl = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

let passwordJobs = 0;
async function scrypt(...args: Parameters<typeof scryptImpl>): Promise<Buffer> {
  if (passwordJobs >= 4) throw Object.assign(new Error("password_busy"), { statusCode: 429, code: "password_busy" });
  passwordJobs++;
  try { return await scryptImpl(...args); } finally { passwordJobs--; }
}

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** `scrypt$N$r$p$salt(b64)$hash(b64)` */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scrypt(passphrase, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${h.toString("base64")}`;
}

export async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  if (passphrase.length > 1024) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const salt = Buffer.from(parts[4]!, "base64");
  const want = Buffer.from(parts[5]!, "base64");
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || want.length === 0) return false;
  const got = await scrypt(passphrase, salt, want.length, { N: n, r, p, maxmem: 128 * 1024 * 1024 });
  return got.length === want.length && timingSafeEqual(got, want);
}

export interface AuthConfig {
  passphraseHash: string;
}

export function loadAuthConfig(path: string): AuthConfig {
  const c = JSON.parse(readFileSync(path, "utf8")) as Partial<AuthConfig>;
  if (typeof c.passphraseHash !== "string" || !c.passphraseHash.startsWith("scrypt$")) throw new Error("config file needs a passphraseHash");
  return { passphraseHash: c.passphraseHash };
}

const SESSION_MS = 30 * 24 * 3600 * 1000;

export function newSessionToken(): string {
  return randomBytes(32).toString("hex");
}
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export class Sessions {
  constructor(private store: Store) {}
  create(): string {
    const token = newSessionToken();
    this.store.run("delete from sessions where expires < ?", Date.now());
    this.store.run("insert into sessions(hash, expires) values (?,?)", sha(token), Date.now() + SESSION_MS);
    return token;
  }
  valid(token: string | undefined): boolean {
    if (!token) return false;
    const r = this.store.get<{ expires: number }>("select expires from sessions where hash = ?", sha(token));
    return !!r && r.expires > Date.now();
  }
  destroy(token: string | undefined): void {
    if (token) this.store.run("delete from sessions where hash = ?", sha(token));
  }
}

/** Failed sign-ins per client: five in a minute locks that client out for the rest of the minute. */
export class Throttle {
  private fails = new Map<string, number[]>();
  constructor(private limit = 5) {}
  /** Reserve before awaiting password verification: concurrent requests count too. */
  take(key: string, now = Date.now()): boolean {
    if (this.blocked(key, now)) return false;
    this.fail(key, now);
    return true;
  }
  blocked(key: string, now = Date.now()): boolean {
    for (const [k, times] of this.fails) if (!times.length || now - times[times.length - 1]! >= 60_000) this.fails.delete(k);
    if (!this.fails.has(key) && this.fails.size >= 10_000) return true;
    const l = (this.fails.get(key) ?? []).filter((t) => now - t < 60_000);
    this.fails.set(key, l);
    return l.length >= this.limit;
  }
  fail(key: string, now = Date.now()): void {
    this.fails.set(key, [...(this.fails.get(key) ?? []).filter((t) => now - t < 60_000), now].slice(-this.limit));
  }
  clear(key: string): void {
    this.fails.delete(key);
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
