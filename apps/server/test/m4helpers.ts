import { mk } from "./helpers.js";

export const T0 = Date.UTC(2026, 10, 15, 12, 0, 0); // Sunday 2026-11-15 12:00 UTC

export type M = ReturnType<typeof mk> & { clock: { t: number } };

/** An app with an injectable clock and a stored time zone. */
export async function mk4(tz = "UTC", t = T0): Promise<M> {
  const clock = { t };
  const m = mk({ now: () => clock.t });
  if (tz !== "UTC") await m.call("PUT", "/api/v2/user/preferences/settings", { timeZone: tz });
  else await m.call("PUT", "/api/v2/user/preferences/settings", { timeZone: "UTC", startDayOfWeek: "SUN" });
  return Object.assign(m, { clock });
}

let n = 0;
export const id = (p = "a"): string => `${p}${(++n).toString(16).padStart(23, "0")}`.slice(0, 24);

export const habit = (over: Record<string, unknown> = {}): any => ({ id: id("b"), name: "Read", ...over });
export const checkin = (habitId: string, stamp: number, over: Record<string, unknown> = {}): any => ({ id: id("c"), habitId, checkinStamp: stamp, ...over });

export async function addHabit(m: M, over: Record<string, unknown> = {}): Promise<any> {
  const h = habit(over);
  const r = await m.call("POST", "/api/v2/habits/batch", { add: [h] });
  if (r.json.id2error[h.id]) throw new Error(`habit add failed: ${r.json.id2error[h.id]}`);
  return h;
}
export async function checkIn(m: M, habitId: string, stamp: number, over: Record<string, unknown> = {}): Promise<any> {
  const c = checkin(habitId, stamp, over);
  const r = await m.call("POST", "/api/v2/habitCheckins/batch", { add: [c] });
  if (r.json.id2error[c.id]) throw new Error(`checkin failed: ${r.json.id2error[c.id]}`);
  return c;
}
export const getHabit = async (m: M, hid: string): Promise<any> => (await m.call("GET", "/api/v2/habits")).json.find((h: any) => h.id === hid);

export const isoWire = (ms: number): string => new Date(ms).toISOString().replace("Z", "+0000");
