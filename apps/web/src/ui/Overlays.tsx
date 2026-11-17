import { Filter as FilterIcon, Hash, List as ListIcon, Search as SearchIcon, X } from "lucide-react";
import { builderToRule, cond } from "../model/filters";
import { useM5 } from "./m5ctx";
import { useEffect, useMemo, useState } from "react";
import { go, taskPath, viewPath } from "../model/router";
import { searchTasks } from "../model/views";
import { useApp } from "./ctx";
import { Modal, Checkbox } from "./primitives";

function Highlight({ text, q }: { text: string; q: string }): JSX.Element {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (!q || i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Search modal: field, Task / Tag / List chips, local results (5 then View more), history with Clear (SRCH-001..801). */
export function SearchModal(): JSX.Element {
  const app = useApp();
  const { tasks, tags, projects, setModal, local, setLocal, repo } = app;
  const [q, setQ] = useState(() => sessionStorage.getItem("searchKeyWords") ?? "");
  const [chip, setChip] = useState<"task" | "tag" | "list" | "filter" | null>(null);
  const [fPriority, setFPriority] = useState<string>("");
  const [fTag, setFTag] = useState<string>("");
  const [fList, setFList] = useState<string>("");
  const m5 = useM5();
  // SRCH-010: opening search reads the list template catalogue (projectTemplates/all?timestamp=0)
  useEffect(() => void m5.reloadTemplates(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [all, setAll] = useState(false);
  const [archived, setArchived] = useState(false);
  useEffect(() => sessionStorage.setItem("searchKeyWords", q), [q]);
  const closedIds = new Set(projects.filter((p) => p.closed).map((p) => p.id));
  const faceted = !!(fPriority || fTag || fList);
  const taskHits = useMemo(
    () =>
      (q ? searchTasks(tasks, q) : faceted ? tasks.filter((t) => !t.deleted) : [])
        .filter((t) => archived || !closedIds.has(t.projectId))
        .filter((t) => !fPriority || String(t.priority ?? 0) === fPriority)
        .filter((t) => !fTag || (t.tags ?? []).some((x) => x.toLowerCase() === fTag))
        .filter((t) => !fList || t.projectId === fList),
    [tasks, q, archived, fPriority, fTag, fList, faceted], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const filterHits = q ? app.filters.filter((f) => f.name.toLowerCase().includes(q.toLowerCase())) : [];
  // FILT-019: the current criteria as a saved filter
  const saveAsFilter = (): void => {
    const g = { kind: "group" as const, op: "and" as const, items: [] as Array<ReturnType<typeof cond>> };
    if (q.trim()) g.items.push(cond("keywords", [q.trim()]));
    if (fList) g.items.push(cond("listOrGroup", [fList]));
    if (fTag) g.items.push(cond("tag", [fTag]));
    if (fPriority) g.items.push(cond("priority", [Number(fPriority)]));
    setModal({ kind: "filter", rule: builderToRule(g), name: q.trim() || "Search" });
  };
  const tagHits = q ? tags.filter((t) => (t.label ?? t.name).toLowerCase().includes(q.toLowerCase())) : [];
  const listHits = q ? projects.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) && (archived || !p.closed)) : [];
  const remember = (): void => {
    if (q.trim()) setLocal("searchHistory", [q.trim(), ...local.searchHistory.filter((h) => h !== q.trim())].slice(0, 10));
  };
  const openPath = (path: string): void => {
    remember();
    sessionStorage.setItem("hashBeforeSearch", location.hash);
    setModal(null);
    go(path);
  };
  const showTasks = chip === null || chip === "task";
  return (
    <Modal onClose={() => setModal(null)} className="search-modal" testId="search-modal">
      <div className="search-field big">
        <SearchIcon size={16} />
        <input autoFocus placeholder="Search" value={q} data-testid="search-input" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && remember()} />
        {q && (
          <button className="icon-btn xs" aria-label="Clear" onClick={() => setQ("")}>
            <X size={13} />
          </button>
        )}
      </div>
      <div className="filter-chips">
        {/* three quick-filter chips; saved filters are listed in the results instead (SRCH-004) */}
        {(["task", "tag", "list"] as const).map((c) => (
          <button key={c} className={`chip-btn${chip === c ? " on" : ""}`} data-testid={`search-chip-${c}`} onClick={() => setChip(chip === c ? null : c)}>
            {c === "task" ? "Task" : c === "tag" ? "Tag" : "List"}
          </button>
        ))}
      </div>
      <div className="search-facets">
        <select className="field" aria-label="Priority" data-testid="search-facet-priority" value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
          <option value="">Any priority</option>
          <option value="5">High</option>
          <option value="3">Medium</option>
          <option value="1">Low</option>
          <option value="0">None</option>
        </select>
        <select className="field" aria-label="Tag" data-testid="search-facet-tag" value={fTag} onChange={(e) => setFTag(e.target.value)}>
          <option value="">Any tag</option>
          {tags.map((t) => <option key={t.name} value={t.name}>#{t.label ?? t.name}</option>)}
        </select>
        <select className="field" aria-label="List" data-testid="search-facet-list" value={fList} onChange={(e) => setFList(e.target.value)}>
          <option value="">Any list</option>
          <option value={app.inboxId}>Inbox</option>
          {projects.filter((p) => !p.closed).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {(q.trim() || faceted) && (
          <button className="btn sm" data-testid="search-save-filter" onClick={saveAsFilter}>
            <FilterIcon size={13} /> Save as Filter
          </button>
        )}
      </div>
      <div className="search-results" data-testid="search-results">
        {!q && !faceted && (
          <>
            {local.searchHistory.length > 0 ? (
              <div className="search-history">
                <div className="row between">
                  <span className="muted small">Search History</span>
                  <button className="link-btn" onClick={() => setLocal("searchHistory", [])}>Clear History</button>
                </div>
                {local.searchHistory.map((h) => (
                  <button key={h} className="menu-item" onClick={() => setQ(h)}>
                    <span className="menu-label">{h}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-note">Enter keywords to search</div>
            )}
          </>
        )}
        {(q || faceted) && showTasks && taskHits.length > 0 && (
          <section>
            <div className="muted small">Tasks</div>
            {(all ? taskHits : taskHits.slice(0, 5)).map((t) => (
              <div key={t.id} className="search-row" data-testid="search-hit" onClick={() => openPath(taskPath(t.projectId === app.inboxId ? { type: "project", id: app.inboxId } : { type: "project", id: t.projectId }, t.id))}>
                <Checkbox checked={t.status !== 0} priority={t.priority ?? 0} kind={t.kind} onChange={() => void repo.toggleComplete(t.id)} />
                <span className="search-title">
                  <Highlight text={t.title} q={q} />
                </span>
                <span className="list-chip">{app.projectName(t.projectId)}</span>
              </div>
            ))}
            {!all && taskHits.length > 5 && (
              <button className="link-btn" onClick={() => setAll(true)}>
                View more
              </button>
            )}
          </section>
        )}
        {q && (chip === null || chip === "tag") && tagHits.length > 0 && (
          <section>
            <div className="muted small">Tags</div>
            {tagHits.map((t) => (
              <button key={t.name} className="menu-item" onClick={() => openPath(viewPath({ type: "tag", name: t.name }))}>
                <span className="menu-icon"><Hash size={14} color={t.color ?? undefined} /></span>
                <span className="menu-label"><Highlight text={t.label ?? t.name} q={q} /></span>
              </button>
            ))}
          </section>
        )}
        {q && (chip === null || chip === "filter") && filterHits.length > 0 && (
          <section>
            <div className="muted small">Filters</div>
            {filterHits.map((f) => (
              <button key={f.id} className="menu-item" data-testid="search-filter-hit" onClick={() => openPath(viewPath({ type: "filter", id: f.id }))}>
                <span className="menu-icon"><FilterIcon size={14} /></span>
                <span className="menu-label"><Highlight text={f.name} q={q} /></span>
              </button>
            ))}
          </section>
        )}
        {q && (chip === null || chip === "list") && listHits.length > 0 && (
          <section>
            <div className="muted small">Lists</div>
            {listHits.map((p) => (
              <button key={p.id} className="menu-item" onClick={() => openPath(viewPath({ type: "project", id: p.id }))}>
                <span className="menu-icon"><ListIcon size={14} /></span>
                <span className="menu-label"><Highlight text={p.name} q={q} /></span>
              </button>
            ))}
          </section>
        )}
        {q && !taskHits.length && !tagHits.length && !listHits.length && !filterHits.length && (
          <div className="empty-note">
            No results.{" "}
            {!archived && projects.some((p) => p.closed) && (
              <button className="link-btn" onClick={() => setArchived(true)}>
                Search in Archived
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

interface Command {
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

/** Ctrl+K: New task first, then Navigation and Help groups; typing filters (KEYS-053..055). */
export function CommandMenu(): JSX.Element {
  const app = useApp();
  const { setModal } = app;
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const nav = (p: string) => () => (setModal(null), go(p));
  const cmds: Command[] = [
    { label: "New task", hint: "Tab+N / N", group: "", run: () => (setModal(null), setTimeout(() => (document.querySelector("[data-testid=quick-add-input]") as HTMLInputElement | null)?.focus(), 30)) },
    { label: "Task", group: "Navigation", run: nav("q/today/tasks") },
    { label: "Calendar", group: "Navigation", run: () => (setModal(null), app.toast("Calendar arrives in M3")) },
    { label: "Search", hint: "/", group: "Navigation", run: () => setModal({ kind: "search" }) },
    { label: "Go to Settings", hint: "G then S", group: "Navigation", run: () => (setModal(null), go(app.route.path, { modalType: "settings", tabs: "profile" })) },
    { label: "All", hint: "G then A", group: "Navigation", run: nav("q/all/tasks") },
    { label: "Today", hint: "G then T", group: "Navigation", run: nav("q/today/tasks") },
    { label: "Tomorrow", hint: "G then R", group: "Navigation", run: nav("q/tomorrow/tasks") },
    { label: "Next 7 Days", hint: "G then N", group: "Navigation", run: nav("q/week/tasks") },
    { label: "Assigned to Me", hint: "G then M", group: "Navigation", run: nav("q/all/assignedme") },
    { label: "Inbox", hint: "G then I", group: "Navigation", run: nav(`p/${app.inboxId}/tasks`) },
    { label: "Completed", hint: "G then C", group: "Navigation", run: nav("q/all/completed") },
    { label: "Won't do", hint: "G then W", group: "Navigation", run: nav("q/all/abandoned") },
    { label: "Summary", hint: "G then B", group: "Navigation", run: nav("q/all/summary") },
    { label: "Trash", hint: "G then G", group: "Navigation", run: nav("q/all/trash") },
    { label: "Shortcuts", hint: "?", group: "Help", run: () => setModal({ kind: "shortcuts" }) },
    { label: "Help Center", group: "Help", run: () => (setModal(null), go(app.route.path, { modalType: "settings", tabs: "about" })) },
  ];
  const shown = cmds.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  let lastGroup = "";
  return (
    <Modal onClose={() => setModal(null)} className="command-menu" testId="command-menu">
      <div className="search-field big">
        <SearchIcon size={16} />
        <input
          autoFocus
          placeholder="Type a command or search"
          value={q}
          onChange={(e) => (setQ(e.target.value), setIdx(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setIdx((i) => Math.min(shown.length - 1, i + 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
            if (e.key === "Enter") shown[idx]?.run();
          }}
        />
      </div>
      <div className="menu">
        {shown.map((c, i) => {
          const head = c.group !== lastGroup && c.group ? <div className="menu-heading" key={`h${c.group}`}>{c.group}</div> : null;
          lastGroup = c.group;
          return (
            <div key={c.label}>
              {head}
              <button className={`menu-item${i === idx ? " hover" : ""}`} onMouseEnter={() => setIdx(i)} onClick={c.run}>
                <span className="menu-label">{c.label}</span>
                {c.hint && <span className="menu-hint">{c.hint}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function Toasts(): JSX.Element {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" data-testid="toast">
          <span>{t.text}</span>
          {t.undo && (
            <button
              className="link-btn"
              data-testid={t.action ? "toast-action" : "toast-undo"}
              onClick={() => {
                t.undo!();
                dismissToast(t.id);
              }}
            >
              {t.action ?? "Undo"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
