import { ArrowLeft, GripVertical, LayoutTemplate, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ORDER_STEP, newId, type ChecklistItem, type ProjectTemplate, type Task, type Template } from "../lib/core";
import { go } from "../model/router";
import { useApp, type App } from "./ctx";
import { useM5 } from "./m5ctx";
import { Modal, Popover, type Anchor } from "./primitives";

/**
 * Templates (TPL rows): task and note templates (Add from Template, Save as Template, the managers) and the
 * list template gallery. Template content follows the server's Save as Template format: an optional text
 * block followed by "- [ ]" / "- [x]" checklist lines (TPL-009: such a template makes a checklist task).
 */

const CHECK_LINE = /^\s*[-*]\s+\[( |x|X)\]\s?(.*)$/;

export function templateToFields(tpl: Template, kind?: "NOTE" | "TEXT"): Partial<Task> & { title: string } {
  const content = tpl.content ?? "";
  if (kind === "NOTE") return { title: tpl.title ?? "", content, kind: "NOTE" };
  const lines = content.split("\n");
  let cut = lines.length;
  while (cut > 0 && (CHECK_LINE.test(lines[cut - 1]!) || lines[cut - 1]!.trim() === "")) cut--;
  const checks = lines.slice(cut).filter((l) => CHECK_LINE.test(l));
  if (checks.length === 0) return { title: tpl.title ?? "", content, kind: "TEXT" };
  const items: ChecklistItem[] = checks.map((l, i) => {
    const m = CHECK_LINE.exec(l)!;
    return { id: newId(), title: m[2] ?? "", status: m[1] === " " ? 0 : 2, sortOrder: i * ORDER_STEP };
  });
  return { title: tpl.title ?? "", kind: "CHECKLIST", content: "", desc: lines.slice(0, cut).join("\n").trim(), items };
}

export async function createFromTemplate(app: App, tpl: Template, ctx: Partial<Task> & { kind?: "NOTE" | "TEXT" }): Promise<Task> {
  const f = templateToFields(tpl, ctx.kind === "NOTE" ? "NOTE" : undefined);
  const { kind: _k, ...rest } = ctx;
  void _k;
  const t = await app.repo.createTask({ ...rest, ...f });
  app.toast(`Created from "${tpl.title || "template"}"`);
  return t;
}

/** Save as Template (TASK-056, TPL-006): the server extracts title and content from the task. */
export async function saveAsTemplate(app: App, task: Task): Promise<void> {
  try {
    await app.engine.sync(); // the task must exist on the server first
    if (task.kind === "NOTE") await app.engine.api.post("/api/v2/templates/note", { title: task.title, content: task.content ?? "" });
    else await app.engine.api.post("/api/v2/templates/task", { taskId: task.id });
    window.dispatchEvent(new Event("noor-templates"));
    app.toast(task.kind === "NOTE" ? "Saved as a note template" : "Saved as a task template");
  } catch {
    app.toast("Could not save the template while offline");
  }
}

function snippet(t: Template): string {
  return (t.content ?? "").replace(CHECK_LINE, "$2").split("\n").map((l) => l.replace(CHECK_LINE, "$2")).filter(Boolean).slice(0, 3).join(" · ");
}

/** Add from Template popover (QADD-008, TPL-008): header Task Template (or Note Template), the list, search. */
export function TemplatePicker({ anchor, kind, onPick, onClose }: { anchor: Anchor; kind: "task" | "note"; onPick: (t: Template) => void; onClose: () => void }): JSX.Element {
  const m5 = useM5();
  const app = useApp();
  const [q, setQ] = useState("");
  useEffect(() => void m5.reloadTemplates(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = (kind === "task" ? m5.taskTemplates : m5.noteTemplates).filter((t) => !q || (t.title ?? "").toLowerCase().includes(q.toLowerCase()));
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" className="tpl-pop" testId="template-picker">
      <div className="tpl-pop-head">{kind === "task" ? "Task Template" : "Note Template"}</div>
      <div className="tpl-search">
        <Search size={13} className="muted" />
        <input placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} data-testid="template-picker-search" />
      </div>
      <div className="tpl-pop-list">
        {list.length === 0 && <div className="empty-note">{q ? "No match" : "No templates yet"}</div>}
        {list.map((t) => (
          <button key={t.id} className="tpl-pop-row" data-testid="template-option" onClick={() => onPick(t)}>
            <span className="tpl-title">{t.title || "Untitled"}</span>
            <span className="tpl-snippet">{snippet(t)}</span>
          </button>
        ))}
      </div>
      <button className="tpl-pop-foot" onClick={() => (onClose(), go(app.route.path, { modalType: "settings", tabs: "more" }))}>Manage templates</button>
    </Popover>
  );
}

function TemplateEditor({ t, onSave, onCancel }: { t: Partial<Template>; onSave: (title: string, content: string) => void; onCancel: () => void }): JSX.Element {
  const [title, setTitle] = useState(t.title ?? "");
  const [content, setContent] = useState(t.content ?? "");
  return (
    <div className="tpl-edit" data-testid="template-editor">
      <input className="field full" placeholder="Template name" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} data-testid="template-title" />
      <textarea className="field full tpl-content" placeholder={"Notes, or a checklist:\n- [ ] first step\n- [ ] second step"} value={content} onChange={(e) => setContent(e.target.value)} data-testid="template-content" />
      <div className="row gap end">
        <button className="btn sm" onClick={onCancel}>Cancel</button>
        <button className="btn sm primary" disabled={!title.trim()} data-testid="template-save" onClick={() => onSave(title.trim(), content)}>Save</button>
      </div>
    </div>
  );
}

/** Settings > More: Task Template and Note Template managers (TPL-011, TPL-012, TPL-013, SET-166). */
export function TemplateManager(): JSX.Element {
  const app = useApp();
  const m5 = useM5();
  const api = app.engine.api;
  const [kind, setKind] = useState<"task" | "note">("task");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  useEffect(() => void m5.reloadTemplates(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const all = kind === "task" ? m5.taskTemplates : m5.noteTemplates;
  const list = all.filter((t) => !q || (t.title ?? "").toLowerCase().includes(q.toLowerCase()));
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await m5.reloadTemplates();
    } catch {
      app.toast("Templates need the server: try again when online");
    }
  };
  const drop = (target: string): void => {
    if (!drag || drag === target) return;
    const ids = all.map((t) => t.id).filter((id) => id !== drag);
    ids.splice(ids.indexOf(target), 0, drag);
    setDrag(null);
    void run(() => api.post(`/api/v2/templates/${kind}/order`, { ids }));
  };
  return (
    <div className="tpl-manager" data-testid="template-manager">
      <div className="row gap">
        <div className="seg small">
          <button className={kind === "task" ? "on" : ""} data-testid="tpl-kind-task" onClick={() => setKind("task")}>Task Template</button>
          <button className={kind === "note" ? "on" : ""} data-testid="tpl-kind-note" onClick={() => setKind("note")}>Note Template</button>
        </div>
        <div className="tpl-search grow">
          <Search size={13} className="muted" />
          <input placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} data-testid="template-search" />
        </div>
        <button className="btn sm" data-testid="template-add" onClick={() => setEditing("new")}>
          <Plus size={13} /> New
        </button>
      </div>
      {editing === "new" && <TemplateEditor t={{}} onCancel={() => setEditing(null)} onSave={(title, content) => void run(() => api.post(`/api/v2/templates/${kind}`, { title, content })).then(() => setEditing(null))} />}
      <div className="tpl-rows">
        {list.length === 0 && <div className="empty-note">{q ? "No template matches" : "No templates"}</div>}
        {list.map((t) =>
          editing === t.id ? (
            <TemplateEditor key={t.id} t={t} onCancel={() => setEditing(null)} onSave={(title, content) => void run(() => api.put(`/api/v2/templates/${kind}/${t.id}`, { ...t, title, content })).then(() => setEditing(null))} />
          ) : (
            <div
              key={t.id}
              className={`tpl-row${drag === t.id ? " dragging" : ""}`}
              data-testid="template-row"
              draggable={!q}
              onDragStart={() => setDrag(t.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(t.id)}
            >
              {!q && <GripVertical size={14} className="muted grip" />}
              <LayoutTemplate size={15} className="muted" />
              <div className="tpl-row-text">
                <span className="tpl-title">{t.title || "Untitled"}</span>
                <span className="tpl-snippet">{snippet(t)}</span>
              </div>
              <button className="icon-btn xs" aria-label="Edit template" onClick={() => setEditing(t.id)}><Pencil size={13} /></button>
              <button
                className="icon-btn xs"
                aria-label="Delete template"
                data-testid="template-delete"
                onClick={() => app.setModal({ kind: "confirm", title: "Delete template", body: `"${t.title}" will be deleted.`, ok: "Delete", danger: true, onOk: () => void run(() => api.del(`/api/v2/templates/${kind}/${t.id}`)) })}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

interface ProjectTemplateFull extends ProjectTemplate {
  viewMode?: string;
  kind?: string;
  columns?: Array<{ key: string; name: string }>;
  tasks?: Array<{ key: string; title: string; content?: string; columnKey?: string; parentKey?: string; items?: Array<{ title: string }> }>;
}

/** List template gallery (TPL-020, TPL-021, TPL-023, LIST-032): search, preview, Use Template. */
export function TemplateGallery(): JSX.Element {
  const app = useApp();
  const m5 = useM5();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<ProjectTemplateFull | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void m5.reloadTemplates(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useMemo(() => m5.projectTemplates.filter((t) => !q || `${t.name} ${t.keyword ?? ""}`.toLowerCase().includes(q.toLowerCase())), [m5.projectTemplates, q]);
  const open = async (t: ProjectTemplate): Promise<void> => {
    try {
      setSel(await app.engine.api.get<ProjectTemplateFull>(`/api/v2/templates/project/${t.id}`));
    } catch {
      setSel(t as ProjectTemplateFull);
    }
  };
  const use = async (): Promise<void> => {
    if (!sel) return;
    setBusy(true);
    try {
      const res = await app.engine.api.post<{ project: { id: string } }>(`/api/v2/templates/project/${sel.id}/apply`, {});
      await app.engine.sync();
      app.setModal(null);
      go(`p/${res.project.id}/${sel.viewMode === "kanban" ? "kanban" : sel.viewMode === "timeline" ? "timeline" : "tasks"}`);
      app.toast(`List "${sel.name}" created`);
    } catch {
      app.toast("The gallery needs the server: try again when online");
    } finally {
      setBusy(false);
    }
  };
  const setModal = app.setModal;
  const close = useCallback((): void => setModal(null), [setModal]);
  return (
    <Modal onClose={close} wide className="gallery-modal" testId="template-gallery">
      <div className="gallery-head">
        {sel ? (
          <button className="icon-btn sm" aria-label="Back to templates" onClick={() => setSel(null)}><ArrowLeft size={16} /></button>
        ) : (
          <LayoutTemplate size={18} />
        )}
        <h3>{sel ? sel.name : "List Templates"}</h3>
        <span className="grow" />
        <button className="icon-btn sm" aria-label="Close" onClick={close}><X size={16} /></button>
      </div>
      {!sel && (
        <>
          <div className="tpl-search">
            <Search size={13} className="muted" />
            <input placeholder="Search list templates" value={q} onChange={(e) => setQ(e.target.value)} data-testid="gallery-search" />
          </div>
          <div className="gallery-grid">
            {list.length === 0 && <div className="empty-note">{m5.projectTemplates.length ? "No template matches" : "No list templates are available offline yet"}</div>}
            {list.map((t) => (
              <button key={t.id} className="gallery-card" data-testid="gallery-card" onClick={() => void open(t)}>
                <span className="gallery-art" aria-hidden>
                  <span /><span /><span />
                </span>
                <span className="gallery-name">{t.name}</span>
                {t.keyword && <span className="muted small">{t.keyword}</span>}
              </button>
            ))}
          </div>
        </>
      )}
      {sel && (
        <div className="gallery-preview" data-testid="gallery-preview">
          <div className="muted small">{sel.viewMode === "kanban" ? "Kanban" : sel.viewMode === "timeline" ? "Timeline" : "List"} · {(sel.tasks ?? []).length} tasks{sel.columns?.length ? ` in ${sel.columns.length} sections` : ""}</div>
          <div className={`gallery-cols${sel.columns?.length ? " kanban" : ""}`}>
            {(sel.columns?.length ? sel.columns : [{ key: "", name: "" }]).map((c) => (
              <div key={c.key} className="gallery-col">
                {c.name && <div className="gallery-col-name">{c.name}</div>}
                {(sel.tasks ?? []).filter((t) => !t.parentKey && (!c.key || t.columnKey === c.key)).map((t) => (
                  <div key={t.key} className="gallery-task">
                    <span className="checkbox" aria-hidden />
                    <span>{t.title}</span>
                    {(sel.tasks ?? []).some((k) => k.parentKey === t.key) && <span className="muted small"> +{(sel.tasks ?? []).filter((k) => k.parentKey === t.key).length}</span>}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="row gap end">
            <button className="btn" onClick={() => setSel(null)}>Back</button>
            <button className="btn primary" disabled={busy} data-testid="gallery-use" onClick={() => void use()}>Use Template</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
