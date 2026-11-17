import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local, synthetic ICS feed (and a CalDAV endpoint that refuses every login) served by the test process on a
 * free port. The NoorTasks server fetches it over loopback; nothing leaves the machine.
 */
export interface MockCal {
  base: string;
  close: () => Promise<void>;
  hits: () => number;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const utcStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};
const dateOnly = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
};
/** local wall time `days` from today at h:m, as an instant */
export const at = (days: number, h: number, m = 0): number => {
  const x = new Date();
  x.setHours(h, m, 0, 0);
  x.setDate(x.getDate() + days);
  return x.getTime();
};

export interface MockEvent {
  uid: string;
  title: string;
  /** timed: start and end instants; all-day: first local day and day count */
  start?: number;
  end?: number;
  day?: number;
  days?: number;
  location?: string;
  description?: string;
}

export function icsOf(name: string, events: MockEvent[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//NoorTasks e2e//Synthetic//EN", `X-WR-CALNAME:${name}`, "CALSCALE:GREGORIAN"];
  for (const e of events) {
    lines.push("BEGIN:VEVENT", `UID:${e.uid}`, `DTSTAMP:${utcStamp(Date.now())}`, `SUMMARY:${e.title}`);
    if (e.day !== undefined) {
      const first = at(e.day, 0);
      lines.push(`DTSTART;VALUE=DATE:${dateOnly(first)}`, `DTEND;VALUE=DATE:${dateOnly(at(e.day + (e.days ?? 1), 0))}`);
    } else lines.push(`DTSTART:${utcStamp(e.start!)}`, `DTEND:${utcStamp(e.end!)}`);
    if (e.location) lines.push(`LOCATION:${e.location}`);
    if (e.description) lines.push(`DESCRIPTION:${e.description}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** Serve `feeds` (path -> ICS text) on 127.0.0.1 at a free port; any /dav path answers 401. */
export async function startMockCal(feeds: Record<string, () => string>): Promise<MockCal> {
  let hits = 0;
  const srv: Server = createServer((req, res) => {
    hits++;
    const path = (req.url ?? "/").split("?")[0]!;
    if (path.startsWith("/dav")) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="synthetic"', "Content-Type": "text/plain" });
      res.end("unauthorized");
      return;
    }
    const f = feeds[path];
    if (!f) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/calendar; charset=utf-8" });
    res.end(f());
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const { port } = srv.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((ok) => srv.close(() => ok())),
  };
}
