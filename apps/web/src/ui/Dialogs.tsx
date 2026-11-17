import { Columns3, GanttChart, Hash, List as ListIcon, Menu as MenuGlyph, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { cleanListName, cleanTagName } from "../data/repo";
import { go } from "../model/router";
import { useApp, type ModalState } from "./ctx";
import { ColorSwatches, Modal, Select, Switch } from "./primitives";
import { renderMarkdown } from "./Detail";
import { SHORTCUT_GROUPS, keyLabel } from "./shortcuts";

export function ListDialog({ projectId, groupId }: { projectId?: string; groupId?: string }): JSX.Element {
  const app = useApp();
  const { projects, groups, repo, setModal } = app;
  const existing = projects.find((p) => p.id === projectId);
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState<string | null>(existing?.color ?? null);
  const [viewMode, setViewMode] = useState(existing?.viewMode ?? "list");
  const [folder, setFolder] = useState<string>(existing?.groupId ?? groupId ?? "");
  const [newFolder, setNewFolder] = useState("");
  const [kind, setKind] = useState(existing?.kind ?? "TASK");
  const [inAll, setInAll] = useState(existing?.inAll !== false);
  const close = (): void => setModal(null);
  const save = async (): Promise<void> => {
    const clean = cleanListName(name);
    if (!clean) return;
    let gid: string | null = folder || null;
    if (folder === "__new") gid = newFolder.trim() ? (await repo.createGroup(newFolder)).id : null;
    if (existing) {
      await repo.updateProject(existing.id, { name: clean, color, viewMode, groupId: gid, kind, inAll });
      close();
    } else {
      const p = await repo.createProject({ name: clean, color, viewMode, groupId: gid, kind, inAll });
      close();
      go(`p/${p.id}/${viewMode === "list" ? "tasks" : viewMode}`);
    }
  };
  return (
    <Modal onClose={close} testId="list-dialog" wide>
      <div className="list-dialog">
        <div className="list-form">
          <h3>{existing ? "Edit List" : "Add List"}</h3>
          <div className="name-field">
            <MenuGlyph size={16} className="muted" />
            <input autoFocus placeholder="Name" value={name} data-testid="list-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
          </div>
          <div className="form-row">
            <span>List Color</span>
            <ColorSwatches value={color} onChange={setColor} />
          </div>
          <div className="form-row">
            <span>View Type</span>
            <div className="seg icons">
              <button className={viewMode === "list" ? "on" : ""} aria-label="List" onClick={() => setViewMode("list")}><ListIcon size={16} /></button>
              <button className={viewMode === "kanban" ? "on" : ""} aria-label="Kanban" onClick={() => setViewMode("kanban")}><Columns3 size={16} /></button>
              <button className={viewMode === "timeline" ? "on" : ""} aria-label="Timeline" onClick={() => setViewMode("timeline")}><GanttChart size={16} /></button>
            </div>
          </div>
          <div className="form-row">
            <span>Folder</span>
            <Select value={folder} onChange={setFolder} options={[{ value: "", label: "None" }, ...groups.map((g) => ({ value: g.id, label: g.name })), { value: "__new", label: "New Folder" }]} testId="list-folder" />
          </div>
          {folder === "__new" && (
            <div className="form-row">
              <span />
              <input className="field" placeholder="Folder name" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
            </div>
          )}
          <div className="form-row">
            <span>List Type</span>
            <Select value={kind} onChange={setKind} options={[{ value: "TASK", label: "Task List" }, { value: "NOTE", label: "Note List" }]} testId="list-kind" />
          </div>
          <div className="form-row">
            <span>Show in Smart List</span>
            <Select value={inAll ? "all" : "none"} onChange={(v) => setInAll(v === "all")} options={[{ value: "all", label: "All tasks" }, { value: "none", label: "Do not show" }]} testId="list-inall" />
          </div>
          <div className="row gap end">
            {!existing && (
              <button className="btn ghost" data-testid="list-from-template" onClick={() => setModal({ kind: "templates", mode: "gallery" })}>
                From Template
              </button>
            )}
            <span className="grow" />
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn primary" disabled={!cleanListName(name)} data-testid="list-save" onClick={() => void save()}>
              {existing ? "Save" : "Add"}
            </button>
          </div>
        </div>
        <div className="list-preview" aria-label="Preview">
          <div className="preview-title">
            {color && <span className="color-dot" style={{ background: color }} />}
            {cleanListName(name) || "Name"}
          </div>
          {viewMode === "kanban" ? (
            <div className="preview-kanban">
              {[0, 1, 2].map((c) => (
                <div key={c} className="pk-col">
                  {[0, 1].map((r) => <div key={r} className="pk-card" />)}
                </div>
              ))}
            </div>
          ) : viewMode === "timeline" ? (
            <div className="preview-timeline">
              {[40, 70, 55].map((w, i) => <div key={i} className="pt-bar" style={{ width: `${w}%`, marginLeft: `${i * 12}%`, background: color ?? "var(--accent)" }} />)}
            </div>
          ) : (
            <div className="preview-list">
              {[80, 60, 70, 45].map((w, i) => (
                <div key={i} className="pl-row">
                  <span className="pl-box" />
                  <span className="pl-line" style={{ width: `${w}%` }} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function FolderDialog({ groupId, projectIds }: { groupId?: string; projectIds?: string[] }): JSX.Element {
  const { groups, repo, setModal } = useApp();
  const g = groups.find((x) => x.id === groupId);
  const [name, setName] = useState(g?.name ?? "");
  const save = async (): Promise<void> => {
    if (!cleanListName(name)) return;
    if (g) await repo.updateGroup(g.id, { name: cleanListName(name) });
    else {
      const ng = await repo.createGroup(name);
      for (const id of projectIds ?? []) await repo.updateProject(id, { groupId: ng.id });
    }
    setModal(null);
  };
  return (
    <Modal onClose={() => setModal(null)} testId="folder-dialog">
      <h3>{g ? "Rename Folder" : "New Folder"}</h3>
      <input className="field full" autoFocus placeholder="Folder name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      <div className="row gap end">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

export function TagDialog({ name, parent }: { name?: string; parent?: string }): JSX.Element {
  const { tags, repo, setModal, toast } = useApp();
  const t = tags.find((x) => x.name === name);
  const [label, setLabel] = useState(t?.label ?? t?.name ?? "");
  const [color, setColor] = useState<string | null>(t?.color ?? null);
  const [par, setPar] = useState<string>(t?.parent ?? parent ?? "");
  const save = async (): Promise<void> => {
    const clean = cleanTagName(label);
    if (!clean) return;
    if (t) {
      if (clean.toLowerCase() !== t.name || clean !== (t.label ?? t.name)) {
        const exists = tags.some((x) => x.name === clean.toLowerCase() && x.name !== t.name);
        if (exists) toast(`Merged into ${clean}`);
        await repo.renameTag(t.name, clean, exists);
      }
      await repo.updateTag(clean.toLowerCase(), { color, parent: par || null });
    } else await repo.createTag(clean, { color, parent: par || null });
    setModal(null);
  };
  return (
    <Modal onClose={() => setModal(null)} testId="tag-dialog">
      <h3>{t ? "Edit Tag" : "New Tag"}</h3>
      <div className="name-field">
        <Hash size={16} className="muted" />
        <input autoFocus placeholder="Name" value={label} data-testid="tag-name" onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </div>
      <div className="form-row">
        <span>Color</span>
        <ColorSwatches value={color} onChange={setColor} />
      </div>
      <div className="form-row">
        <span>Parent Tag</span>
        <Select value={par} onChange={setPar} options={[{ value: "", label: "None" }, ...tags.filter((x) => x.name !== t?.name && !x.parent).map((x) => ({ value: x.name, label: x.label ?? x.name }))]} />
      </div>
      <div className="row gap end">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" data-testid="tag-save" onClick={() => void save()}>Save</button>
      </div>
    </Modal>
  );
}

export function ConfirmDialog({ m }: { m: Extract<ModalState, { kind: "confirm" }> }): JSX.Element {
  const { setModal } = useApp();
  return (
    <Modal onClose={() => setModal(null)} testId="confirm-dialog">
      <h3>{m.title}</h3>
      {m.body && <p className="muted">{m.body}</p>}
      <div className="row gap end">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        {m.alt && (
          <button className="btn" onClick={() => (m.alt!.onClick(), setModal(null))}>
            {m.alt.label}
          </button>
        )}
        <button className={`btn ${m.danger ? "danger" : "primary"}`} data-testid="confirm-ok" onClick={() => (m.onOk(), setModal(null))}>
          {m.ok}
        </button>
      </div>
    </Modal>
  );
}

export function DuplicateListDialog({ projectId }: { projectId: string }): JSX.Element {
  const { repo, setModal, toast } = useApp();
  const [mode, setMode] = useState<"open" | "all" | "allReset">("open");
  return (
    <Modal onClose={() => setModal(null)} testId="duplicate-list">
      <h3>Duplicate List</h3>
      {(
        [
          ["open", "Only uncompleted tasks"],
          ["all", "All tasks, keep completed state"],
          ["allReset", "All tasks, clear completed state"],
        ] as const
      ).map(([v, l]) => (
        <label key={v} className="check-row">
          <input type="radio" checked={mode === v} onChange={() => setMode(v)} /> {l}
        </label>
      ))}
      <div className="row gap end">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" onClick={() => void repo.duplicateProject(projectId, mode).then((p) => (setModal(null), toast("List duplicated"), p && go(`p/${p.id}/tasks`)))}>
          Duplicate
        </button>
      </div>
    </Modal>
  );
}

export function BatchAddDialog({ m }: { m: Extract<ModalState, { kind: "batchAdd" }> }): JSX.Element {
  const { setModal } = useApp();
  return (
    <Modal onClose={() => setModal(null)} testId="batch-add">
      <h3>Batch Add Tasks</h3>
      <p className="muted">Add {m.lines.length} tasks, one per line?</p>
      <ul className="batch-list">
        {m.lines.slice(0, 8).map((l, i) => <li key={i}>{l}</li>)}
        {m.lines.length > 8 && <li className="muted">and {m.lines.length - 8} more</li>}
      </ul>
      <div className="row gap end">
        <button className="btn" onClick={() => setModal(null)}>Cancel</button>
        <button className="btn primary" data-testid="batch-ok" onClick={() => (m.onOk(), setModal(null))}>Add</button>
      </div>
    </Modal>
  );
}

export function ViewOptionsDialog(): JSX.Element {
  const { local, setLocal, setModal } = useApp();
  return (
    <Modal onClose={() => setModal(null)} testId="view-options">
      <h3>View Options</h3>
      <div className="form-row">
        <span>Show Date by</span>
        <Select value={local.showDateBy} onChange={(v) => setLocal("showDateBy", v)} options={[{ value: "taskTime", label: "Task Time" }, { value: "dueDate", label: "Due Date" }]} />
      </div>
      <div className="form-row top">
        <span>Task Detail Layout</span>
        <div className="style-options">
          {(
            [
              ["side", "Side peek"],
              ["popup", "Pop-up"],
            ] as const
          ).map(([v, l]) => (
            <label key={v} className={`style-card${local.taskDetailLayout === v ? " on" : ""}`}>
              <div className={`style-art layout-${v}`}>
                <span />
                <span className="pane" />
              </div>
              <span>
                <input type="radio" checked={local.taskDetailLayout === v} onChange={() => setLocal("taskDetailLayout", v)} /> {l}
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="form-row">
        <span>Sync View Across Devices</span>
        <Switch checked={local.viewModeSync} onChange={(v) => setLocal("viewModeSync", v)} />
      </div>
      <div className="row end">
        <button className="btn primary" onClick={() => setModal(null)}>Done</button>
      </div>
    </Modal>
  );
}

export function LinkParentDialog({ taskIds }: { taskIds: string[] }): JSX.Element {
  const { tasks, repo, setModal, toast } = useApp();
  const first = tasks.find((t) => t.id === taskIds[0]);
  const [q, setQ] = useState("");
  const candidates = useMemo(
    () => tasks.filter((t) => !t.deleted && t.status === 0 && t.kind !== "NOTE" && first && t.projectId === first.projectId && !taskIds.includes(t.id) && t.title.toLowerCase().includes(q.toLowerCase())).slice(0, 30),
    [tasks, q, first, taskIds],
  );
  return (
    <Modal onClose={() => setModal(null)} testId="link-parent">
      <h3>Link Parent Task</h3>
      <div className="search-field">
        <Search size={14} />
        <input autoFocus placeholder="Search tasks in this list" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="menu scroll">
        {candidates.map((c) => (
          <button
            key={c.id}
            className="menu-item"
            onClick={async () => {
              for (const id of taskIds) {
                const err = await repo.setParent(id, c.id);
                if (err) toast(err);
              }
              setModal(null);
            }}
          >
            <span className="menu-label">{c.title}</span>
          </button>
        ))}
        {!candidates.length && <div className="empty-note">No tasks</div>}
      </div>
    </Modal>
  );
}

export function PrintDialog({ taskIds, title }: { taskIds: string[]; title: string }): JSX.Element {
  const { tasks, setModal, projectName, settings } = useApp();
  const [name, details] = title.split("|");
  const withDetails = details === "details" || taskIds.length === 1;
  const list = taskIds.map((id) => tasks.find((t) => t.id === id)).filter(Boolean) as typeof tasks;
  return (
    <Modal onClose={() => setModal(null)} testId="print-dialog" wide>
      <div className="print-area">
        <h2>{name}</h2>
        {list.map((t) => (
          <div key={t.id} className="print-task">
            <div className="print-title">
              {t.status ? "[x]" : "[ ]"} {t.title} <span className="muted small">{projectName(t.projectId)}</span>
            </div>
            {withDetails && (t.content || t.desc) && <div className="md-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.content || t.desc || "") }} />}
            {withDetails &&
              tasks
                .filter((k) => k.parentId === t.id && !k.deleted)
                .map((k) => (
                  <div key={k.id} className="print-sub">
                    {k.status ? "[x]" : "[ ]"} {k.title} {k.startDate && <span className="muted small">{new Date(k.startDate.replace("+0000", "Z")).toLocaleString(undefined, { hour12: settings.showMeridiem })}</span>}
                  </div>
                ))}
          </div>
        ))}
      </div>
      <div className="row gap end no-print">
        <button className="btn" onClick={() => setModal(null)}>Close</button>
        <button className="btn primary" onClick={() => window.print()}>Print</button>
      </div>
    </Modal>
  );
}

export function ShortcutsDialog(): JSX.Element {
  const { setModal, local } = useApp();
  return (
    <Modal onClose={() => setModal(null)} testId="shortcuts-dialog" wide>
      <h3>Shortcuts</h3>
      <div className="shortcut-cols">
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.title} className="shortcut-group">
            <h4>{g.title}</h4>
            {g.items.map((it) => (
              <div key={it.id} className={`shortcut-row${it.locked ? " locked" : ""}`}>
                <span>{it.label}</span>
                <kbd>{keyLabel(local.customShortcuts[it.id] ?? it.keys)}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}
