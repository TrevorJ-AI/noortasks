/** Mongo ObjectId layout (24 hex): 4 bytes seconds, 5 bytes cached machine id, 3 bytes counter. Web Crypto. */
const rand = (n: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(n));

function loadMachine(): Uint8Array {
  try {
    const cached = globalThis.localStorage?.getItem("mongoMachineId");
    if (cached && /^[0-9a-f]{10}$/.test(cached)) return Uint8Array.from(cached.match(/../g)!.map((h) => parseInt(h, 16)));
    const m = rand(5);
    globalThis.localStorage?.setItem("mongoMachineId", hex(m));
    return m;
  } catch {
    return rand(5);
  }
}
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const machine = loadMachine();
let counter = (rand(3)[0]! << 16) | (rand(1)[0]! << 8) | rand(1)[0]!;

export function newId(nowMs: number = Date.now()): string {
  counter = (counter + 1) & 0xffffff;
  const secs = Math.floor(nowMs / 1000) >>> 0;
  return secs.toString(16).padStart(8, "0") + hex(machine) + counter.toString(16).padStart(6, "0");
}

export function isObjectId(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{24}$/.test(s);
}

const ETAG_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
export function newEtag(): string {
  return Array.from(rand(8), (b) => ETAG_CHARS[b % ETAG_CHARS.length]).join("");
}
