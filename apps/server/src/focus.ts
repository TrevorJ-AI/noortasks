import { LEGACY_FIELDS, mergeUpdate } from "./fieldSync.js";
import {
  BatchError,
  FocusType,
  HabitStatus,
  applyFocusOp,
  activeMsOf,
  finishedSummary,
  formatServerDate,
  isPlainObject,
  newEtag,
  newId,
  recordActiveMs,
  recordBindings,
  toMs,
  type BatchResponse,
  type FocusOp,
  type FocusState,
  type Loose,
  type Task,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import { ApiError, type Service } from "./service.js";
import { asList, batchSimple, emptyResult, numOr } from "./m4util.js";

export const TIMELINE_PAGE = 50;

interface PomoRow {
  id: string;
  type: number;
  startMs: number;
  endMs: number;
  seq: number;
  createSeq: number;
  json: string;
}

/** Query number: epoch ms, or any date string the focus records use. NaN when absent or unparsable. */
function qms(v: unknown): number {
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
  return toMs(v);
}

export interface FocusFilter {
  from?: number;
  to?: number;
  minMinutes?: number;
  maxMinutes?: number;
  linked?: "linked" | "unlinked";
  type?: number;
  taskId?: string;
  habitId?: string;
  timerId?: string;
  projectId?: string;
}

export class FocusService {
  constructor(private svc: Service) {}
  private get store() {
    return this.svc.store;
  }

  // ---------------------------------------------------------------- records
  private rows(where = "1=1", ...args: Array<string | number>): PomoRow[] {
    return this.store.all<PomoRow>(`select * from pomodoros where ${where} order by startMs desc, id`, ...args);
  }
  get(id: string, type?: number): Loose | undefined {
    const r = this.store.get<PomoRow>("select * from pomodoros where id = ?", id);
    if (!r || (type !== undefined && r.type !== type)) return undefined;
    return JSON.parse(r.json) as Loose;
  }
  /** Records of one type with a start in [from, to]; ascending by start. */
  list(type: number | undefined, from = NaN, to = NaN): Loose[] {
    const lo = Number.isNaN(from) ? -Infinity : from;
    const hi = Number.isNaN(to) ? Infinity : to;
    return this.rows()
      .filter((r) => (type === undefined || r.type === type) && r.startMs >= lo && r.startMs <= hi)
      .reverse()
      .map((r) => JSON.parse(r.json) as Loose);
  }
  all(): Array<{ id: string; type: number; rec: Loose }> {
    return this.rows().map((r) => ({ id: r.id, type: r.type, rec: JSON.parse(r.json) as Loose }));
  }

  filter(f: FocusFilter): Loose[] {
    const out: Loose[] = [];
    for (const r of this.rows()) {
      if (f.type !== undefined && r.type !== f.type) continue;
      if (f.from !== undefined && !Number.isNaN(f.from) && r.startMs < f.from) continue;
      if (f.to !== undefined && !Number.isNaN(f.to) && r.startMs > f.to) continue;
      const rec = JSON.parse(r.json) as Loose;
      const mins = recordActiveMs(rec) / 60000;
      if (f.minMinutes !== undefined && mins < f.minMinutes) continue;
      if (f.maxMinutes !== undefined && mins > f.maxMinutes) continue;
      const binds = recordBindings(rec);
      if (f.linked === "linked" && binds.length === 0) continue;
      if (f.linked === "unlinked" && binds.length > 0) continue;
      if (f.taskId && !binds.some((b) => b.owner === 0 && b.id === f.taskId)) continue;
      if (f.habitId && !binds.some((b) => b.owner === 1 && b.id === f.habitId)) continue;
      if (f.timerId && !binds.some((b) => b.owner === 2 && b.id === f.timerId)) continue;
      if (f.projectId && !binds.some((b) => b.projectId === f.projectId)) continue;
      out.push(rec);
    }
    return out;
  }

  private validate(o: Loose): string | undefined {
    const s = toMs(o.startTime);
    const e = toMs(o.endTime);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s || e - s > 7 * 86_400_000 || Math.abs(s) > 8.64e15 || Math.abs(e) > 8.64e15) return BatchError.Unknown;
    return undefined;
  }

  batchRecords(type: number, body: unknown): BatchResponse {
    const res = emptyResult();
    const b = isPlainObject(body) ? body : {};
    const touchedTasks = new Set<string>();
    const noteBindings = (rec: Loose | undefined): void => {
      if (rec) for (const x of recordBindings(rec)) if (x.owner === 0) touchedTasks.add(x.id);
    };
    this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.svc.now());
      for (const raw of asList(b.add)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        if (this.store.get("select 1 from pomodoros where id = ?", raw.id)) {
          res.id2error[raw.id] = BatchError.Existed;
          continue;
        }
        const err = this.validate(raw);
        if (err) {
          res.id2error[raw.id] = err;
          continue;
        }
        const o: Loose = { ...raw, etag: newEtag() };
        this.store.run("insert into pomodoros(id, type, startMs, endMs, seq, createSeq, json) values (?,?,?,?,?,?,?)", raw.id, type, toMs(o.startTime), toMs(o.endTime), seq, seq, JSON.stringify(o));
        this.store.clearTombstone("pomodoro", raw.id);
        res.id2etag[raw.id] = o.etag as string;
        noteBindings(o);
      }
      for (const raw of asList(b.update)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        const row = this.store.get<PomoRow>("select * from pomodoros where id = ? and type = ?", raw.id, type);
        if (!row) {
          res.id2error[raw.id] = BatchError.NotExisted;
          continue;
        }
        const merged = mergeUpdate(JSON.parse(row.json) as Loose, raw, LEGACY_FIELDS.focus);
        const err = this.validate(merged);
        if (err) {
          res.id2error[raw.id] = err;
          continue;
        }
        const o: Loose = { ...merged, etag: newEtag() };
        noteBindings(JSON.parse(row.json) as Loose);
        this.store.run("update pomodoros set startMs = ?, endMs = ?, seq = ?, json = ? where id = ?", toMs(o.startTime), toMs(o.endTime), seq, JSON.stringify(o), raw.id);
        res.id2etag[raw.id] = o.etag as string;
        noteBindings(o);
      }
      for (const raw of asList(b.delete)) {
        const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
        if (!id) continue;
        const row = this.store.get<PomoRow>("select * from pomodoros where id = ? and type = ?", id, type);
        if (!row) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        noteBindings(JSON.parse(row.json) as Loose);
        this.removeRow(id, row.type);
      }
      void now;
      this.refreshSummaries(touchedTasks, seq);
    });
    return res;
  }

  private removeRow(id: string, type: number): void {
    this.store.run("delete from pomodoros where id = ?", id);
    this.store.addTombstone("pomodoro", id, { type });
  }

  deleteMany(ids: string[]): { deleted: number; id2error: Record<string, string> } {
    const id2error: Record<string, string> = {};
    let deleted = 0;
    const touched = new Set<string>();
    this.store.tx(() => {
      const seq = this.store.seq();
      for (const id of ids) {
        const row = this.store.get<PomoRow>("select * from pomodoros where id = ?", id);
        if (!row) {
          id2error[id] = BatchError.NotExisted;
          continue;
        }
        for (const x of recordBindings(JSON.parse(row.json) as Loose)) if (x.owner === 0) touched.add(x.id);
        this.removeRow(id, row.type);
        deleted++;
      }
      this.refreshSummaries(touched, seq);
    });
    return { deleted, id2error };
  }
  deleteAll(): { deleted: number } {
    const ids = this.rows().map((r) => r.id);
    return { deleted: this.deleteMany(ids).deleted };
  }

  /** `GET /pomodoro/record/{cp}`: records changed since a checkpoint (deleted ones come as `{id, deleted: 1}`); null when nothing changed. */
  recordDelta(cp: number): { checkPoint: number; pomodoroRecords: Loose[] | null } {
    const changed = this.store.all<{ json: string }>("select json from pomodoros where seq > ? order by startMs", cp).map((r) => JSON.parse(r.json) as Loose);
    const gone = this.store.tombstonesSince("pomodoro", cp).map((t) => ({ id: t.id, type: t.extra?.type ?? 0, deleted: 1 }) as Loose);
    const all = [...changed, ...gone];
    // the checkpoint moves only when focus records changed, so a fresh database answers `{checkPoint: <asked>, pomodoroRecords: null}`
    const last = Math.max(this.store.get<{ m: number | null }>("select max(seq) as m from pomodoros")?.m ?? 0, ...this.store.all<{ seq: number }>("select seq from tombstones where kind = 'pomodoro' order by seq desc limit 1").map((r) => r.seq));
    return { checkPoint: Math.max(cp, last), pomodoroRecords: all.length ? all : null };
  }

  /** Newest first, both types, records that started before `to` (0 or absent = no bound). */
  timeline(to: number, ownerFilter?: { owner: 0 | 1 | 2; id: string }): Loose[] {
    const hi = !Number.isFinite(to) || to <= 0 ? Infinity : to;
    const out: Loose[] = [];
    for (const r of this.rows()) {
      if (r.startMs >= hi) continue;
      const rec = JSON.parse(r.json) as Loose;
      if (ownerFilter && !recordBindings(rec).some((b) => b.owner === ownerFilter.owner && b.id === ownerFilter.id)) continue;
      out.push(rec);
      if (out.length >= TIMELINE_PAGE) break;
    }
    return out;
  }

  /** Recently bound tasks, habits and timers, newest first, ten distinct owners. */
  recentBind(): Loose[] {
    const seen = new Set<string>();
    const out: Loose[] = [];
    for (const r of this.rows()) {
      for (const b of recordBindings(JSON.parse(r.json) as Loose)) {
        const key = `${b.owner}:${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ type: b.owner, id: b.id, ...(b.title !== undefined ? { title: b.title } : {}), ...(b.projectId !== undefined ? { projectId: b.projectId } : {}), lastFocusTime: r.startMs });
        if (out.length >= 10) return out;
      }
    }
    return out;
  }

  /** Per-task `focusSummaries` (FOC-017): counts and minutes of focus bound to the task. */
  private refreshSummaries(taskIds: Set<string>, seq: number): void {
    for (const id of taskIds) {
      const task = this.store.getTask(id);
      if (!task) continue;
      let pomoCount = 0;
      let pomoMin = 0;
      let swMin = 0;
      const focuses: unknown[][] = [];
      for (const r of this.rows().reverse()) {
        const rec = JSON.parse(r.json) as Loose;
        const mine = recordBindings(rec).filter((b) => b.owner === 0 && b.id === id);
        if (mine.length === 0) continue;
        const mins = Math.round((recordActiveMs(rec) / 60000) * 100) / 100;
        if (r.type === FocusType.Pomodoro) {
          pomoCount++;
          pomoMin += mins;
        } else swMin += mins;
        focuses.push([r.id, r.startMs, mins]);
      }
      const prev = Array.isArray(task.focusSummaries) && isPlainObject(task.focusSummaries[0]) ? (task.focusSummaries[0] as Loose) : {};
      const estimatedDuration = typeof prev.estimatedDuration === "number" ? prev.estimatedDuration : 0;
      const estimatedPomo = typeof prev.estimatedPomo === "number" ? prev.estimatedPomo : 0;
      const hasEstimate = estimatedDuration > 0 || estimatedPomo > 0;
      const next: Task = { ...task };
      if (focuses.length === 0 && !hasEstimate) delete next.focusSummaries;
      else
        next.focusSummaries = [
          { ...prev, userId: this.svc.userId, estimatedDuration, estimatedPomo, pomoCount, pomoDuration: Math.round(pomoMin * 100) / 100, stopwatchDuration: Math.round(swMin * 100) / 100, focuses },
        ];
      if (JSON.stringify(next.focusSummaries) !== JSON.stringify(task.focusSummaries)) this.store.putTask(next, { seq });
    }
  }

  // ---------------------------------------------------------------- timers (standalone focus timers)
  listTimers(): Loose[] {
    return this.store.collAll<Loose>("timers");
  }
  batchTimers(body: unknown): BatchResponse {
    return batchSimple(this.svc, "timers", body, {
      add: (o, ctx) => {
        if (typeof o.name !== "string") o.name = "";
        o.status ??= HabitStatus.Normal;
        if (o.status === HabitStatus.Archived) o.archivedTime ??= ctx.now;
        if (o.sortOrder === undefined) o.sortOrder = (this.store.get<{ m: number | null }>("select max(pos) as m from timers")?.m ?? 0) + 1;
      },
      update: (o, old, ctx) => {
        if (o.status === HabitStatus.Archived && old.status !== HabitStatus.Archived) o.archivedTime = ctx.now;
        if (o.status === HabitStatus.Normal && old.status === HabitStatus.Archived) o.archivedTime = null;
      },
    });
  }
  /** `POST /timer`: one timer object (upsert; an id is minted when absent) or a `{add, update, delete}` batch. */
  postTimer(body: unknown): Loose {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_timer");
    if ("add" in body || "update" in body || "delete" in body) return this.batchTimers(body) as unknown as Loose;
    const id = typeof body.id === "string" && body.id ? body.id : newId(this.svc.now());
    const exists = this.store.collGet("timers", id) !== undefined;
    const res = this.batchTimers(exists ? { update: [{ ...body, id }] } : { add: [{ ...body, id }] });
    const err = res.id2error[id];
    if (err) throw new ApiError(400, err);
    return this.store.collGet<Loose>("timers", id)!;
  }
  deleteTimer(id: string): Record<string, never> {
    const res = batchSimple(this.svc, "timers", { delete: [id] });
    if (res.id2error[id]) throw new ApiError(404, "timer_not_found");
    return {};
  }
  timerOverview(id: string): Loose {
    const timer = this.store.collGet<Loose>("timers", id);
    if (!timer) throw new ApiError(404, "timer_not_found");
    const { tz } = this.svc.userCtx();
    const recs = this.filter({ timerId: id });
    let total = 0;
    let today = 0;
    let todayCount = 0;
    const nowMs = this.svc.now();
    const day = (ms: number): string => new Date(ms + 0).toLocaleDateString("en-CA", { timeZone: tz });
    const todayKey = day(nowMs);
    let last = 0;
    for (const r of recs) {
      const m = recordActiveMs(r) / 60000;
      total += m;
      const s = toMs(r.startTime);
      last = Math.max(last, s);
      if (day(s) === todayKey) {
        today += m;
        todayCount++;
      }
    }
    return { id, name: timer.name, totalCount: recs.length, totalDuration: Math.round(total), todayCount, todayDuration: Math.round(today), lastFocusTime: last || null };
  }

  // ---------------------------------------------------------------- focus ops (live timer sync across devices)
  state(): FocusState | null {
    return this.store.getDoc<{ state: FocusState | null }>("focusState")?.json.state ?? null;
  }
  private logRows(since: number): Array<{ n: number; json: string }> {
    return this.store.all<{ n: number; json: string }>("select n, json from focus_ops where n > ? order by n", since);
  }
  lastOpN(): number {
    return this.store.get<{ m: number | null }>("select max(n) as m from focus_ops")?.m ?? 0;
  }
  /** Live view: running timers report the active time up to now. */
  current(): FocusState | null {
    const s = this.state();
    if (!s) return null;
    return s.status === "running" ? { ...s, duration: activeMsOf(s, this.svc.now()) } : s;
  }
  snapshot(since: number): { checkPoint: number; current: FocusState | null; ops: Loose[] } {
    return {
      checkPoint: this.lastOpN(),
      current: this.current(),
      ops: this.logRows(since).map((r) => ({ ...(JSON.parse(r.json) as Loose), n: r.n })),
    };
  }

  postOps(body: unknown, sinceQuery?: number): { checkPoint: number; current: FocusState | null; ops: Loose[]; finished: Loose[] } {
    const list: unknown[] = Array.isArray(body) ? body : isPlainObject(body) ? asList(body.ops ?? body.opList ?? body.add) : [];
    const since = isPlainObject(body) && Number.isFinite(Number(body.since)) ? Number(body.since) : (sinceQuery ?? 0);
    const finished: Loose[] = [];
    this.store.tx(() => {
      const seq = this.store.seq();
      const nowMs = this.svc.now();
      const ops: FocusOp[] = [];
      for (const raw of list) {
        if (!isPlainObject(raw) || typeof raw.op !== "string") continue;
        const id = typeof raw.id === "string" && raw.id ? raw.id : newId(nowMs);
        const time = Number.isFinite(toMs(raw.time)) ? toMs(raw.time) : nowMs;
        ops.push({ ...raw, id, op: raw.op, time });
      }
      // ops of one batch apply in time order; the log keeps arrival order
      const ordered = [...ops].sort((a, b) => a.time - b.time);
      let state = this.state();
      for (const op of ordered) {
        if (this.store.get("select 1 from focus_ops where id = ?", op.id)) continue; // idempotent: a retried push changes nothing
        const sid = String(op.oId ?? op.focusId ?? op.firstId ?? op.firstFocusId ?? op.id);
        this.store.run("insert into focus_ops(id, deviceId, sessionId, opTime, seq, json) values (?,?,?,?,?,?)", op.id, typeof op.deviceId === "string" ? op.deviceId : null, sid, op.time, seq, JSON.stringify(op));
        const out = applyFocusOp(state, op);
        if (out.replaced) {
          // a new timer started while another ran: the old one is ended for every device (FOC-801)
          const ex: FocusOp = { id: `${op.id}:replaced`, oId: out.replaced.id, op: "exit", time: op.time, reason: "replaced", deviceId: "server" };
          this.store.run("insert into focus_ops(id, deviceId, sessionId, opTime, seq, json) values (?,?,?,?,?,?)", ex.id, "server", out.replaced.id, op.time, seq, JSON.stringify(ex));
        }
        if ((op.op === "finish") && state && state.id === sid) finished.push(finishedSummary(state, op.time));
        state = out.state;
      }
      this.store.putDoc("focusState", { state });
    });
    return { ...this.snapshot(since), finished };
  }
}

export function registerFocusRoutes(app: FastifyInstance, svc: Service): FocusService {
  const fs = new FocusService(svc);
  const rangeQ = (q: Record<string, unknown>): { from: number; to: number } => ({ from: qms(q.from), to: qms(q.to) });

  app.get("/api/v2/pomodoros", async (req) => {
    const { from, to } = rangeQ(req.query as Record<string, unknown>);
    return fs.list(FocusType.Pomodoro, from, to);
  });
  app.get("/api/v2/pomodoros/timing", async (req) => {
    const { from, to } = rangeQ(req.query as Record<string, unknown>);
    return fs.list(FocusType.Timing, from, to);
  });
  app.get("/api/v2/pomodoros/timeline", async (req) => fs.timeline(qms((req.query as Record<string, unknown>).to)));
  app.get("/api/v2/pomodoros/task", async (req) => {
    const q = req.query as Record<string, unknown>;
    if (typeof q.taskId !== "string") throw new ApiError(400, "invalid_task");
    return fs.filter({ taskId: q.taskId }); // taskId already uniquely identifies the task
  });
  app.get<{ Params: { cp: string } }>("/api/v2/pomodoro/record/:cp", async (req) => fs.recordDelta(numOr(req.params.cp, 0)));
  app.get("/api/v2/pomodoro/bind/recent", async () => fs.recentBind());
  app.get<{ Params: { id: string } }>("/api/v2/pomodoro/:id", async (req) => {
    const r = fs.get(req.params.id, FocusType.Pomodoro);
    if (!r) throw new ApiError(404, "pomodoro_not_found");
    return r;
  });
  app.get<{ Params: { id: string } }>("/api/v2/pomodoro/timing/:id", async (req) => {
    const r = fs.get(req.params.id, FocusType.Timing);
    if (!r) throw new ApiError(404, "pomodoro_not_found");
    return r;
  });
  app.delete("/api/v2/pomodoro", async (req) => {
    const b = req.body;
    const data = Array.isArray(b) ? b : isPlainObject(b) ? asList(b.data ?? b.ids) : [];
    return fs.deleteMany(data.filter((x): x is string => typeof x === "string"));
  });
  app.delete("/api/v2/pomodoro/all", async () => fs.deleteAll());
  app.delete<{ Params: { id: string } }>("/api/v2/pomodoro/timing/:id", async (req) => {
    if (!fs.get(req.params.id, FocusType.Timing)) throw new ApiError(404, "pomodoro_not_found");
    fs.deleteMany([req.params.id]);
    return {};
  });
  app.delete<{ Params: { id: string } }>("/api/v2/pomodoro/:id", async (req) => {
    if (!fs.get(req.params.id, FocusType.Pomodoro)) throw new ApiError(404, "pomodoro_not_found");
    fs.deleteMany([req.params.id]);
    return {};
  });
  app.post("/api/v2/pomodoro/filter", async (req) => {
    const b = isPlainObject(req.body) ? req.body : {};
    const f: FocusFilter = {};
    const from = qms(b.from ?? b.startTime);
    const to = qms(b.to ?? b.endTime);
    if (!Number.isNaN(from)) f.from = from;
    if (!Number.isNaN(to)) f.to = to;
    const mn = numOr(b.minDuration, NaN);
    const mx = numOr(b.maxDuration, NaN);
    if (!Number.isNaN(mn)) f.minMinutes = mn;
    if (!Number.isNaN(mx)) f.maxMinutes = mx;
    if (b.linked === "linked" || b.linked === true) f.linked = "linked";
    if (b.linked === "unlinked" || b.linked === false) f.linked = "unlinked";
    if (typeof b.type === "number") f.type = b.type;
    for (const k of ["taskId", "habitId", "timerId", "projectId"] as const) if (typeof b[k] === "string") f[k] = b[k] as string;
    return fs.filter(f);
  });
  app.post("/api/v2/batch/pomodoro", async (req) => fs.batchRecords(FocusType.Pomodoro, req.body));
  app.post("/api/v2/batch/pomodoro/timing", async (req) => fs.batchRecords(FocusType.Timing, req.body));

  app.get("/api/v2/timer", async () => fs.listTimers());
  app.post("/api/v2/timer", async (req) => fs.postTimer(req.body));
  app.delete<{ Params: { id: string } }>("/api/v2/timer/:id", async (req) => fs.deleteTimer(req.params.id));
  app.get<{ Params: { id: string } }>("/api/v2/timer/overview/:id", async (req) => fs.timerOverview(req.params.id));
  app.get<{ Params: { id: string }; Querystring: { to?: string } }>("/api/v2/timer/timeline/:id", async (req) => fs.timeline(qms(req.query.to), { owner: 2, id: req.params.id }));

  // Focus endpoints are served on the same host (compat alias under /focus/batch/focusOp).
  app.post<{ Querystring: { since?: string } }>("/api/v2/batch/focusOp", async (req) => fs.postOps(req.body, numOr(req.query.since, 0)));
  app.post<{ Querystring: { since?: string } }>("/focus/batch/focusOp", async (req) => fs.postOps(req.body, numOr(req.query.since, 0)));
  app.get<{ Querystring: { since?: string } }>("/api/v2/batch/focusOp", async (req) => fs.snapshot(numOr(req.query.since, 0)));
  return fs;
}
