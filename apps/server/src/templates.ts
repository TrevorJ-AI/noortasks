import {
  ActivityAction,
  BatchError,
  ORDER_STEP,
  TaskStatus,
  formatServerDate,
  isPlainObject,
  newEtag,
  newId,
  type BatchResponse,
  type Column,
  type Loose,
  type Project,
  type ProjectTemplate,
  type Task,
  type Template,
  type TemplatesResponse,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import type { ActivityService } from "./activity.js";
import { asList, emptyResult, numOr } from "./m4util.js";
import { ApiError, type Service } from "./service.js";

type TemplateKind = "taskTemplates" | "noteTemplates";

interface SeedProjectTemplate {
  id: string;
  name: string;
  keyword: string;
  viewMode: "list" | "kanban" | "timeline";
  kind: "TASK" | "NOTE";
  columns?: Array<{ key: string; name: string; sortOrder: number }>;
  tasks: Array<{
    key: string;
    title: string;
    content?: string;
    priority?: number;
    columnKey?: string;
    parentKey?: string;
    kind?: string;
    items?: Array<{ title: string; status: number }>;
  }>;
}

const SEED_TASK_TEMPLATES: Array<{ id: string; title: string; content: string; order: number }> = [
  {
    id: "000000000000000000000101",
    title: "Morning Routine",
    content: "- [ ] Hydrate and stretch\n- [ ] Review today's top three priorities\n- [ ] Clear urgent inbox messages",
    order: 0,
  },
  {
    id: "000000000000000000000102",
    title: "Weekly Planning",
    content: "- [ ] Review completed work from this week\n- [ ] Schedule upcoming deadlines\n- [ ] Tidy overdue and undated tasks",
    order: 1,
  },
  {
    id: "000000000000000000000103",
    title: "Trip Packing Checklist",
    content: "- [ ] Travel documents and wallet\n- [ ] Phone charger and power adapter\n- [ ] Weather-appropriate clothing",
    order: 2,
  },
];

const SEED_NOTE_TEMPLATES: Array<{ id: string; title: string; content: string }> = [
  {
    id: "000000000000000000000201",
    title: "Meeting Notes",
    content: "## Attendees\n-\n\n## Agenda\n-\n\n## Action Items\n- [ ] ",
  },
  {
    id: "000000000000000000000202",
    title: "Daily Reflection",
    content: "### Highlights\n-\n\n### Lessons Learned\n-\n\n### Tomorrow's Focus\n-",
  },
  {
    id: "000000000000000000000203",
    title: "Project Brief",
    content: "## Objective\n\n## Scope\n\n## Milestones\n-\n\n## Open Questions\n-",
  },
];

const SEED_PROJECT_TEMPLATES: SeedProjectTemplate[] = [
  {
    id: "000000000000000000000301",
    name: "Weekly Meal Plan",
    keyword: "meal,food,cooking,weekly",
    viewMode: "kanban",
    kind: "TASK",
    columns: [
      { key: "prep", name: "Shopping List", sortOrder: 0 },
      { key: "cook", name: "Weekday Meals", sortOrder: ORDER_STEP },
      { key: "done", name: "Prepped", sortOrder: ORDER_STEP * 2 },
    ],
    tasks: [
      { key: "t1", title: "Buy fresh produce and grains", columnKey: "prep" },
      { key: "t2", title: "Roast vegetables & grain bowls", columnKey: "cook" },
    ],
  },
  {
    id: "000000000000000000000302",
    name: "Sprint Board",
    keyword: "work,sprint,kanban,project",
    viewMode: "kanban",
    kind: "TASK",
    columns: [
      { key: "backlog", name: "Backlog", sortOrder: 0 },
      { key: "doing", name: "In Progress", sortOrder: ORDER_STEP },
      { key: "done", name: "Done", sortOrder: ORDER_STEP * 2 },
    ],
    tasks: [
      { key: "t1", title: "Define sprint goals", columnKey: "backlog", priority: 5 },
      { key: "t2", title: "Break down deliverables", columnKey: "doing", priority: 3 },
    ],
  },
  {
    id: "000000000000000000000303",
    name: "Reading List",
    keyword: "books,reading,study,learning",
    viewMode: "list",
    kind: "TASK",
    tasks: [
      { key: "t1", title: "Pick next non-fiction book" },
      { key: "t2", title: "Take chapter summary notes", parentKey: "t1" },
    ],
  },
];

function serializeTaskAsTemplateContent(task: Task): string {
  if (task.kind === "CHECKLIST" && Array.isArray(task.items) && task.items.length > 0) {
    const lines = task.items.map((it) => `- [${it.status ? "x" : " "}] ${it.title ?? ""}`);
    const prefix = typeof task.desc === "string" && task.desc ? `${task.desc}\n` : "";
    return `${prefix}${lines.join("\n")}`;
  }
  return typeof task.content === "string" ? task.content : typeof task.desc === "string" ? task.desc : "";
}

export class TemplateService {
  constructor(
    private svc: Service,
    private act?: ActivityService,
  ) {}

  private get store() {
    return this.svc.store;
  }

  /** Seed the 3+3 built-in templates and list gallery templates once on a fresh database. */
  ensureSeeded(): void {
    this.store.tx(() => {
      const now = formatServerDate(this.svc.now());
      if (!this.store.getMeta("templatesSeeded")) {
        if (this.store.get<{ n: number }>("select count(*) as n from templates")!.n === 0) {
          SEED_TASK_TEMPLATES.forEach((t, i) => {
            const obj: Template = { id: t.id, etag: newEtag(), createdTime: now, modifiedTime: now, title: t.title, content: t.content, order: t.order };
            this.store.run("insert into templates(id, kind, pos, json) values (?,?,?,?)", t.id, "taskTemplates", i + 1, JSON.stringify(obj));
          });
          SEED_NOTE_TEMPLATES.forEach((t, i) => {
            const obj: Template = { id: t.id, etag: newEtag(), createdTime: now, modifiedTime: now, title: t.title, content: t.content };
            this.store.run("insert into templates(id, kind, pos, json) values (?,?,?,?)", t.id, "noteTemplates", i + 1, JSON.stringify(obj));
          });
        }
        this.store.setMeta("templatesSeeded", "1");
      }
      if (!this.store.getMeta("projectTemplatesSeeded")) {
        if (this.store.get<{ n: number }>("select count(*) as n from project_templates")!.n === 0) {
          const seq = this.store.seq();
          SEED_PROJECT_TEMPLATES.forEach((pt, i) => {
            const obj = { ...pt, deleted: 0 };
            this.store.run("insert into project_templates(id, pos, seq, deleted, json) values (?,?,?,?,?)", pt.id, i + 1, seq, 0, JSON.stringify(obj));
          });
        }
        this.store.setMeta("projectTemplatesSeeded", "1");
      }
    });
  }

  list(): TemplatesResponse {
    const taskTemplates = this.store
      .all<{ json: string }>("select json from templates where kind = 'taskTemplates' order by pos asc")
      .map((r) => JSON.parse(r.json) as Template)
      .sort((a, b) => (typeof a.order === "number" ? a.order : 0) - (typeof b.order === "number" ? b.order : 0));
    const noteTemplates = this.store
      .all<{ json: string }>("select json from templates where kind = 'noteTemplates' order by pos asc")
      .map((r) => JSON.parse(r.json) as Template);
    return {
      taskTemplates,
      noteTemplates,
      merged: this.store.getMetaJson("templatesMerged") ?? null,
    };
  }

  private nextPos(kind: TemplateKind): number {
    return (this.store.get<{ m: number | null }>("select max(pos) as m from templates where kind = ?", kind)?.m ?? 0) + 1;
  }

  private nextOrder(kind: TemplateKind): number {
    if (kind !== "taskTemplates") return 0;
    const rows = this.store.all<{ json: string }>("select json from templates where kind = 'taskTemplates'").map((r) => JSON.parse(r.json) as Template);
    if (rows.length === 0) return 0;
    return Math.max(...rows.map((t) => (typeof t.order === "number" ? t.order : 0))) + 1;
  }

  private buildTemplate(kind: TemplateKind, raw: Loose, prev: Template | undefined, now: string): Template {
    const base: Loose = prev ? { ...prev, ...raw } : { ...raw };
    if (typeof raw.taskId === "string" && raw.taskId && !prev && raw.title === undefined) {
      const task = this.store.getTask(raw.taskId);
      if (!task) throw new ApiError(404, "task_not_found");
      base.title = task.title ?? "";
      if (raw.content === undefined) base.content = serializeTaskAsTemplateContent(task);
    }
    const id = prev ? prev.id : typeof base.id === "string" && base.id ? base.id : newId(this.svc.now());
    const out: Template = {
      ...base,
      id,
      etag: newEtag(),
      createdTime: prev?.createdTime ?? (typeof base.createdTime === "string" ? base.createdTime : now),
      modifiedTime: now,
      title: typeof base.title === "string" ? base.title : "",
      content: typeof base.content === "string" ? base.content : "",
    };
    if (kind === "taskTemplates") {
      out.order = typeof base.order === "number" ? Math.trunc(base.order) : prev && typeof prev.order === "number" ? prev.order : this.nextOrder(kind);
    } else if (raw.order === undefined && prev?.order === undefined) {
      delete out.order;
    }
    return out;
  }

  saveOrBatch(kind: TemplateKind, body: unknown): Template | BatchResponse {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_body");
    if (Array.isArray(body.add) || Array.isArray(body.update) || Array.isArray(body.delete)) {
      return this.batchKind(kind, body);
    }
    return this.store.tx(() => {
      const now = formatServerDate(this.svc.now());
      const id = typeof body.id === "string" && body.id ? body.id : undefined;
      const prevRow = id ? this.store.get<{ kind: string; pos: number; json: string }>("select kind, pos, json from templates where id = ?", id) : undefined;
      if (prevRow && prevRow.kind !== kind) throw new ApiError(409, "template_kind_mismatch");
      const prev = prevRow ? (JSON.parse(prevRow.json) as Template) : undefined;
      const tpl = this.buildTemplate(kind, body, prev, now);
      const pos = prevRow?.pos ?? this.nextPos(kind);
      this.store.run(
        "insert into templates(id, kind, pos, json) values (?,?,?,?) on conflict(id) do update set pos=excluded.pos, json=excluded.json",
        tpl.id,
        kind,
        pos,
        JSON.stringify(tpl),
      );
      return tpl;
    });
  }

  batchKind(kind: TemplateKind, body: unknown): BatchResponse {
    const res = emptyResult();
    const b = isPlainObject(body) ? body : {};
    this.store.tx(() => {
      const now = formatServerDate(this.svc.now());
      for (const raw of asList(b.add)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        if (this.store.get("select 1 from templates where id = ?", raw.id)) {
          res.id2error[raw.id] = BatchError.Existed;
          continue;
        }
        const tpl = this.buildTemplate(kind, raw, undefined, now);
        this.store.run("insert into templates(id, kind, pos, json) values (?,?,?,?)", tpl.id, kind, this.nextPos(kind), JSON.stringify(tpl));
        res.id2etag[tpl.id] = tpl.etag!;
      }
      for (const raw of asList(b.update)) {
        if (!isPlainObject(raw) || typeof raw.id !== "string" || !raw.id) continue;
        const row = this.store.get<{ kind: string; pos: number; json: string }>("select kind, pos, json from templates where id = ?", raw.id);
        if (!row || row.kind !== kind) {
          res.id2error[raw.id] = BatchError.NotExisted;
          continue;
        }
        const tpl = this.buildTemplate(kind, raw, JSON.parse(row.json) as Template, now);
        this.store.run("update templates set json = ? where id = ?", JSON.stringify(tpl), tpl.id);
        res.id2etag[tpl.id] = tpl.etag!;
      }
      for (const raw of asList(b.delete)) {
        const id = typeof raw === "string" ? raw : isPlainObject(raw) && typeof raw.id === "string" ? raw.id : undefined;
        if (!id) continue;
        const row = this.store.get<{ kind: string }>("select kind from templates where id = ?", id);
        if (!row || row.kind !== kind) {
          res.id2error[id] = BatchError.NotExisted;
          continue;
        }
        this.store.run("delete from templates where id = ?", id);
      }
    });
    return res;
  }

  updateById(kind: TemplateKind, id: string, body: unknown): Template {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_body");
    return this.store.tx(() => {
      const row = this.store.get<{ kind: string; json: string }>("select kind, json from templates where id = ?", id);
      if (!row || row.kind !== kind) throw new ApiError(404, "template_not_found");
      const now = formatServerDate(this.svc.now());
      const tpl = this.buildTemplate(kind, { ...body, id }, JSON.parse(row.json) as Template, now);
      this.store.run("update templates set json = ? where id = ?", JSON.stringify(tpl), id);
      return tpl;
    });
  }

  deleteById(kind: TemplateKind, id: string): void {
    const row = this.store.get<{ kind: string }>("select kind from templates where id = ?", id);
    if (!row || row.kind !== kind) throw new ApiError(404, "template_not_found");
    this.store.run("delete from templates where id = ?", id);
  }

  reorder(kind: TemplateKind, body: unknown): void {
    if (!isPlainObject(body)) throw new ApiError(400, "invalid_body");
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    const items = Array.isArray(body.templates) ? body.templates.filter(isPlainObject) : [];
    this.store.tx(() => {
      const now = formatServerDate(this.svc.now());
      if (ids.length > 0) {
        ids.forEach((id, idx) => {
          const row = this.store.get<{ kind: string; json: string }>("select kind, json from templates where id = ?", id);
          if (!row || row.kind !== kind) return;
          const tpl = JSON.parse(row.json) as Template;
          if (kind === "taskTemplates") tpl.order = idx;
          tpl.etag = newEtag();
          tpl.modifiedTime = now;
          this.store.run("update templates set pos = ?, json = ? where id = ?", idx + 1, JSON.stringify(tpl), id);
        });
      }
      for (const it of items) {
        if (typeof it.id !== "string") continue;
        const row = this.store.get<{ kind: string; json: string }>("select kind, json from templates where id = ?", it.id);
        if (!row || row.kind !== kind) continue;
        const tpl = JSON.parse(row.json) as Template;
        if (typeof it.order === "number") {
          if (kind === "taskTemplates") tpl.order = it.order;
          this.store.run("update templates set pos = ?, json = ? where id = ?", it.order + 1, JSON.stringify({ ...tpl, etag: newEtag(), modifiedTime: now }), it.id);
        }
      }
    });
  }

  // ------------------------------------------------------------------ project templates

  listProjectTemplates(timestamp = 0): { timestamp: number; projectTemplates: ProjectTemplate[] } {
    const doc = this.store.getDoc<{ timestamp?: number; projectTemplates?: ProjectTemplate[] }>("projectTemplates")?.json;
    const rows = this.store.all<{ seq: number; deleted: number; json: string }>("select seq, deleted, json from project_templates order by pos asc");
    if (rows.length === 0 && doc && Array.isArray(doc.projectTemplates)) {
      const ts = typeof doc.timestamp === "number" ? doc.timestamp : 0;
      return {
        timestamp: Math.max(ts, timestamp),
        projectTemplates: timestamp > 0 && ts <= timestamp ? [] : doc.projectTemplates,
      };
    }
    const maxSeq = rows.reduce((m, r) => Math.max(m, r.seq), 0);
    const filtered = timestamp > 0 ? rows.filter((r) => r.seq > timestamp) : rows;
    return {
      timestamp: Math.max(timestamp, maxSeq),
      projectTemplates: filtered.map((r) => {
        const o = JSON.parse(r.json) as Loose;
        return { id: String(o.id), name: String(o.name ?? ""), keyword: String(o.keyword ?? ""), deleted: r.deleted };
      }),
    };
  }

  upsertProjectTemplate(tpl: Loose): ProjectTemplate {
    return this.store.tx(() => {
      const seq = this.store.seq();
      const id = typeof tpl.id === "string" && tpl.id ? tpl.id : newId(this.svc.now());
      const deleted = typeof tpl.deleted === "number" ? tpl.deleted : 0;
      const obj: Loose = { ...tpl, id, deleted };
      const prev = this.store.get<{ pos: number }>("select pos from project_templates where id = ?", id);
      const pos = prev?.pos ?? (this.store.get<{ m: number | null }>("select max(pos) as m from project_templates")?.m ?? 0) + 1;
      this.store.run(
        "insert into project_templates(id, pos, seq, deleted, json) values (?,?,?,?,?) on conflict(id) do update set pos=excluded.pos, seq=excluded.seq, deleted=excluded.deleted, json=excluded.json",
        id,
        pos,
        seq,
        deleted,
        JSON.stringify(obj),
      );
      return { id, name: String(obj.name ?? ""), keyword: String(obj.keyword ?? ""), deleted };
    });
  }

  getProjectTemplate(id: string): Loose {
    const row = this.store.get<{ deleted: number; json: string }>("select deleted, json from project_templates where id = ?", id);
    if (!row || row.deleted) throw new ApiError(404, "template_not_found");
    return JSON.parse(row.json) as Loose;
  }

  applyProjectTemplate(id: string, body: unknown): { project: Project; columns: Column[]; tasks: Task[]; checkPoint: number } {
    const tpl = this.getProjectTemplate(id) as unknown as SeedProjectTemplate & Loose;
    const over = isPlainObject(body) ? body : {};
    return this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.svc.now());
      const projectId = newId(this.svc.now());
      const minOrder = this.store
        .collAll<Project>("projects")
        .reduce((m, p) => Math.min(m, typeof p.sortOrder === "number" ? p.sortOrder : 0), 0);

      const project: Project = {
        id: projectId,
        name: typeof over.name === "string" && over.name ? over.name : String(tpl.name ?? "Untitled"),
        color: typeof over.color === "string" || over.color === null ? over.color : null,
        groupId: typeof over.groupId === "string" || over.groupId === null ? over.groupId : null,
        sortOrder: minOrder - ORDER_STEP,
        viewMode: typeof tpl.viewMode === "string" ? tpl.viewMode : "list",
        kind: typeof tpl.kind === "string" ? tpl.kind : "TASK",
        inAll: true,
        isOwner: true,
        muted: false,
        closed: null,
        showType: 1,
        remindType: 1,
        etag: newEtag(),
        modifiedTime: now,
      };
      this.store.collPut("projects", projectId, project, { seq });
      this.act?.record({ projectId, action: ActivityAction.ProjectCreate, summary: `Created list "${project.name}" from template` });

      const colKeyToId = new Map<string, string>();
      const columns: Column[] = [];
      for (const rawCol of Array.isArray(tpl.columns) ? tpl.columns : []) {
        const colId = newId(this.svc.now());
        if (typeof rawCol.key === "string") colKeyToId.set(rawCol.key, colId);
        const col: Column = {
          id: colId,
          projectId,
          name: String(rawCol.name ?? "Section"),
          sortOrder: typeof rawCol.sortOrder === "number" ? rawCol.sortOrder : columns.length * ORDER_STEP,
          etag: newEtag(),
          createdTime: now,
          modifiedTime: now,
        };
        this.store.collPut("columns", colId, col, { seq });
        columns.push(col);
      }

      const taskKeyToId = new Map<string, string>();
      const rawTasks = Array.isArray(tpl.tasks) ? tpl.tasks : [];
      for (const rt of rawTasks) {
        const tid = newId(this.svc.now());
        if (typeof rt.key === "string") taskKeyToId.set(rt.key, tid);
      }

      const tasks: Task[] = [];
      rawTasks.forEach((rt, idx) => {
        const tid = (typeof rt.key === "string" && taskKeyToId.get(rt.key)) || newId(this.svc.now());
        const parentId = typeof rt.parentKey === "string" ? taskKeyToId.get(rt.parentKey) : undefined;
        const columnId = typeof rt.columnKey === "string" ? colKeyToId.get(rt.columnKey) : undefined;
        const t: Task = {
          id: tid,
          projectId,
          title: String(rt.title ?? ""),
          ...(typeof rt.content === "string" ? { content: rt.content } : {}),
          kind: typeof rt.kind === "string" ? rt.kind : "TEXT",
          status: TaskStatus.Open,
          priority: typeof rt.priority === "number" ? rt.priority : 0,
          sortOrder: idx * ORDER_STEP,
          creator: this.svc.userId,
          createdTime: now,
          modifiedTime: now,
          etag: newEtag(),
          deleted: 0,
          ...(columnId ? { columnId } : {}),
          ...(parentId ? { parentId } : {}),
          ...(Array.isArray(rt.items)
            ? {
                items: rt.items.map((it, j) => ({
                  id: newId(this.svc.now()),
                  title: String(it.title ?? ""),
                  status: typeof it.status === "number" ? it.status : 0,
                  sortOrder: j * ORDER_STEP,
                })),
              }
            : {}),
        };
        this.store.putTask(t, { seq });
        tasks.push(t);
      });

      // Populate parent childIds for created subtasks
      for (const t of tasks) {
        if (t.parentId) {
          const parent = this.store.getTask(t.parentId);
          if (parent) {
            parent.childIds = [...new Set([...(parent.childIds ?? []), t.id])];
            this.store.putTask(parent, { seq });
          }
        }
        this.act?.recordTaskCreated(t);
      }

      return { project, columns, tasks, checkPoint: seq };
    });
  }
}

export function registerTemplateRoutes(app: FastifyInstance, svc: Service, act?: ActivityService): TemplateService {
  const ts = new TemplateService(svc, act);
  ts.ensureSeeded();

  app.get("/api/v2/templates", async () => ts.list());
  app.post("/api/v2/templates/task", async (req) => ts.saveOrBatch("taskTemplates", req.body));
  app.post("/api/v2/templates/note", async (req) => ts.saveOrBatch("noteTemplates", req.body));
  app.put<{ Params: { id: string } }>("/api/v2/templates/task/:id", async (req) => ts.updateById("taskTemplates", req.params.id, req.body));
  app.put<{ Params: { id: string } }>("/api/v2/templates/note/:id", async (req) => ts.updateById("noteTemplates", req.params.id, req.body));
  app.delete<{ Params: { id: string } }>("/api/v2/templates/task/:id", async (req) => {
    ts.deleteById("taskTemplates", req.params.id);
    return {};
  });
  app.delete<{ Params: { id: string } }>("/api/v2/templates/note/:id", async (req) => {
    ts.deleteById("noteTemplates", req.params.id);
    return {};
  });
  app.post("/api/v2/templates/task/order", async (req) => {
    ts.reorder("taskTemplates", req.body);
    return {};
  });
  app.post("/api/v2/templates/note/order", async (req) => {
    ts.reorder("noteTemplates", req.body);
    return {};
  });

  app.get<{ Querystring: { timestamp?: string } }>("/api/v2/projectTemplates/all", async (req) =>
    ts.listProjectTemplates(numOr(req.query.timestamp, 0)),
  );
  app.get<{ Params: { id: string } }>("/pub/api/v2/templates/project/:id", async (req) => ts.getProjectTemplate(req.params.id));
  app.get<{ Params: { id: string } }>("/api/v2/templates/project/:id", async (req) => ts.getProjectTemplate(req.params.id));
  app.post<{ Params: { id: string } }>("/api/v2/templates/project/:id/apply", async (req) => ts.applyProjectTemplate(req.params.id, req.body));

  return ts;
}
