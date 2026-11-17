import { CountdownType, HabitStatus, newEtag, type BatchResponse, type Loose } from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import { batchSimple } from "./m4util.js";
import type { Service } from "./service.js";

const DEFAULT_REMINDERS = (): string[] => ["TRIGGER:P0DT9H0M0S", "TRIGGER:-P2DT15H0M0S"];

export function listCountdowns(svc: Service): Loose[] {
  return svc.store.collAll<Loose>("countdowns");
}

/** `POST /countdown/batch`. Pinning one countdown unpins the others (one pin slot). */
export function batchCountdowns(svc: Service, body: unknown): BatchResponse {
  const pinned = new Set<string>();
  const normalize = (o: Loose, ctx: { now: string }, isNew: boolean, old?: Loose): void => {
    if (isNew) {
      o.type ??= CountdownType.Countdown;
      o.status ??= HabitStatus.Normal;
      o.deleted ??= 0;
      o.timerMode ??= 0;
      o.daysOption ??= 0;
      o.dateDisplayFormat ??= "day";
      o.style ??= "normal";
      o.ignoreYear ??= false;
      o.showAge ??= false;
      o.showRemark ??= false;
      o.reminders ??= DEFAULT_REMINDERS();
      if (o.sortOrder === undefined) o.sortOrder = (svc.store.get<{ m: number | null }>("select max(pos) as m from countdowns")?.m ?? 0) + 1;
    }
    if (o.status === HabitStatus.Archived && (o.archivedTime == null || old?.status !== HabitStatus.Archived)) o.archivedTime = ctx.now;
    if (o.status === HabitStatus.Normal) o.archivedTime = null;
    // only a pin that is new or changed claims the slot; an unchanged pinnedTime sent back by a client does not
    if (o.pinnedTime && o.pinnedTime !== old?.pinnedTime) pinned.add(o.id as string);
  };
  return batchSimple(svc, "countdowns", body, {
    add: (o, ctx) => normalize(o, ctx, true),
    update: (o, old, ctx) => normalize(o, ctx, false, old),
    after: (ctx) => {
      if (pinned.size === 0) return;
      // the pin goes to the last pinned item of the batch; every other countdown is unpinned
      const keep = [...pinned].pop()!;
      for (const c of svc.store.collAll<Loose>("countdowns")) {
        if (c.id !== keep && c.pinnedTime) svc.store.collPut("countdowns", c.id as string, { ...c, pinnedTime: null, etag: newEtag(), modifiedTime: ctx.now }, { seq: ctx.seq });
      }
    },
  });
}

export function registerCountdownRoutes(app: FastifyInstance, svc: Service): void {
  app.get("/api/v2/countdown/list", async () => listCountdowns(svc));
  app.post("/api/v2/countdown/batch", async (req) => batchCountdowns(svc, req.body));
}
