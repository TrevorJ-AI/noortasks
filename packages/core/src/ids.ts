import { randomBytes } from "node:crypto";

/**
 * Client-minted ids: Mongo ObjectId layout, 24 lowercase hex chars:
 * 4 bytes seconds since epoch, 5 bytes per-process random,
 * 3 bytes counter that starts at a random value.
 */
const machine = randomBytes(5);
let counter = randomBytes(3).readUIntBE(0, 3);

export function newId(nowMs: number = Date.now()): string {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(Math.floor(nowMs / 1000) >>> 0, 0);
  machine.copy(buf, 4);
  counter = (counter + 1) & 0xffffff;
  buf.writeUIntBE(counter, 9, 3);
  return buf.toString("hex");
}

export function isObjectId(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{24}$/.test(s);
}

/** Seconds timestamp embedded in an id, as epoch ms. */
export function idTimestamp(id: string): number {
  return parseInt(id.slice(0, 8), 16) * 1000;
}

const ETAG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Short opaque etag (8 chars). */
export function newEtag(): string {
  const b = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ETAG_CHARS[b[i]! % ETAG_CHARS.length];
  return out;
}

export function inboxIdFor(userId: number | string): string {
  return `inbox${userId}`;
}
