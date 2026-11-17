import type { DateInput } from "./model";

const p2 = (n: number) => String(n).padStart(2, "0");

export function toMs(d: DateInput): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === "number") return d;
  // Wire format: 2026-11-14T23:00:00.000+0000 (offset without colon; kept for backup/sync compatibility)
  const s = d.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new RangeError(`Unparseable date: ${d}`);
  return ms;
}

/** Format an epoch ms timestamp in wire ISO format: "2026-11-14T23:00:00.000+0000". */
export function formatWireDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, "0")}+0000`;
}

/** Return in the same shape the caller supplied. */
export function like(template: DateInput, ms: number): DateInput {
  if (typeof template === "string") return formatWireDate(ms);
  if (typeof template === "number") return ms;
  return new Date(ms);
}
