/** IANA zone helpers built on Intl only. A "wall time" is (epochDay, secondOfDay) in some zone. */
import { civilFromDays, daysFromCivil } from "./civil";

const cache = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string): Intl.DateTimeFormat {
  let f = cache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    cache.set(zone, f);
  }
  return f;
}

export interface Wall {
  day: number;
  sec: number;
}

export function offsetMs(zone: string, utcMs: number): number {
  if (zone === "UTC") return 0;
  const t = Math.floor(utcMs / 1000) * 1000;
  const o: Record<string, number> = {};
  for (const p of fmt(zone).formatToParts(new Date(t))) if (p.type !== "literal") o[p.type] = Number(p.value);
  const asUtc = Date.UTC(o.year!, o.month! - 1, o.day!, (o.hour as number) % 24, o.minute!, o.second!);
  return asUtc - t;
}

export function instantToWall(zone: string, ms: number): Wall {
  const local = ms + offsetMs(zone, ms);
  const day = Math.floor(local / 86400000);
  return { day, sec: Math.floor((local - day * 86400000) / 1000) };
}

/**
 * Wall time to instant. Ambiguous (clocks go back): the earlier instant. Nonexistent (clocks go forward):
 * shifted forward by the gap, so 02:30 in a spring-forward gap becomes 03:30.
 */
export function wallToInstant(zone: string, w: Wall): number {
  const wallMs = w.day * 86400000 + w.sec * 1000;
  if (zone === "UTC") return wallMs;
  const offA = offsetMs(zone, wallMs - 86400000);
  const offB = offsetMs(zone, wallMs + 86400000);
  const valid: number[] = [];
  for (const off of new Set([offA, offB])) {
    const t = wallMs - off;
    if (offsetMs(zone, t) === off) valid.push(t);
  }
  if (valid.length) return Math.min(...valid);
  return wallMs - offA;
}

export function isValidZone(zone: string): boolean {
  try {
    fmt(zone);
    return true;
  } catch {
    return false;
  }
}

export function wallParts(w: Wall) {
  const c = civilFromDays(w.day);
  return { ...c, h: Math.floor(w.sec / 3600), mi: Math.floor((w.sec % 3600) / 60), s: w.sec % 60 };
}
export { daysFromCivil };
