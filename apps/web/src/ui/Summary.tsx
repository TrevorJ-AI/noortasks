import { ArrowDownUp, Bookmark, CalendarRange, ChevronDown, Download, Filter, List as ListIcon, Pencil, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatQueryDate, newId, type Task } from "../lib/core";
import { dayKey, weekStartIndex } from "../lib/dates";
import {
  DEFAULT_DISPLAY,
  DEFAULT_FILTER,
  RANGE_LABEL,
  defaultTitle,
  detailParts,
  filterTasks,
  groupTasks,
  rangeOf,
  sortTasks,
  toHtml,
  toMarkdown,
  toPlainText,
  withDepth,
  type GroupBy,
  type RangePreset,
  type SortBy,
  type StatusFilter,
  type SummaryDisplay,
  type SummaryFields,
  type SummaryFilter,
  type SummaryTemplate,
} from "../model/summary";
import { useApp } from "./ctx";
import { Menu, MenuButton, Popover, PRIORITIES, PriorityFlag, Select, Switch, anchorOf, type Anchor } from "./primitives";
import { tagLabel } from "./taskutil";

/** Summary keeps its last choices on this device (NOTE-022, SET-286/287: compatibility localStorage key names). */
function readLS<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : ({ ...(typeof d === "object" && d && !Array.isArray(d) ? d : {}), ...JSON.parse(v) } as T);
  } catch {
    return d;
  }
}
function readStr(k: string, d: string): string {
  try {
    const v = localStorage.getItem(k);
    return v === null ? d : (JSON.parse(v) as string);
  } catch {
    return d;
  }
}
const writeLS = (k: string, v: unknown): void => localStorage.setItem(k, JSON.stringify(v));

const FIELD_LABEL: Record<keyof SummaryFields, string> = { status: "Status", date: "Date and time", list: "List", tags: "Tags", parent: "Parent and subtasks", progress: "Progress", focus: "Focus time" };
const SORT_LABEL: Record<SortBy, string> = { completedTime: "Completion date", taskDate: "Task date", status: "Completion status" };
const MAX_IMAGE_HEIGHT = 16000;

export function SummaryScreen(): JSX.Element {
  const app = useApp();
  const { projects, inboxId, tasks, tags, settings, engine, repo } = app;
  const [filter, setFilterState] = useState<SummaryFilter>(() => readLS("summaryFilterRule", DEFAULT_FILTER));
  const [display, setDisplayState] = useState<SummaryDisplay>(() => {
    const d = readLS<SummaryDisplay>("summaryDisplayItems", DEFAULT_DISPLAY);
    return { ...d, fields: { ...DEFAULT_DISPLAY.fields, ...(d.fields ?? {}) } };
  });
  const [sort, setSortState] = useState<SortBy>(() => readStr("summarySortType", "completedTime") as SortBy);
  const [templateId, setTemplateIdState] = useState<string>(() => readStr("summaryTemplateId", ""));
  const [title, setTitleState] = useState<string>(() => readStr("summaryCurrentSummaryTitle", ""));
  const [rows, setRows] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

  const setFilter = (f: SummaryFilter): void => (setFilterState(f), writeLS("summaryFilterRule", f));
  const setDisplay = (d: SummaryDisplay): void => (setDisplayState(d), writeLS("summaryDisplayItems", d));
  const setSort = (s: SortBy): void => (setSortState(s), writeLS("summarySortType", s));
  const setTemplateId = (id: string): void => (setTemplateIdState(id), writeLS("summaryTemplateId", id));
  const setTitle = (t: string): void => (setTitleState(t), writeLS("summaryCurrentSummaryTitle", t));

  const ws = weekStartIndex(settings.startDayOfWeek);
  const range = useMemo(() => rangeOf(filter, app.now, ws), [filter.range, filter.from, filter.to, ws, dayKey(app.now)]); // eslint-disable-line react-hooks/exhaustive-deps

  // NOTE-020 / SMART-046: completed tasks of the period and the recent project users
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const [done] = await Promise.all([
          engine.api.get<Task[]>(`/api/v2/project/all/completed/?from=${encodeURIComponent(formatQueryDate(range.from))}&to=${encodeURIComponent(formatQueryDate(range.to))}&limit=1000`),
          engine.api.get<unknown[]>("/api/v2/project/share/recentProjectUsers").catch(() => []),
        ]);
        if (alive) setRows(Array.isArray(done) ? done : []);
      } catch {
        if (alive) setRows([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [range.from, range.to, engine]);

  const listName = (id: string): string => (id === inboxId ? "Inbox" : (projects.find((p) => p.id === id)?.name ?? ""));
  const ctxR = { listName, tagLabel: (n: string) => tagLabel(tags, n), meridiem: settings.showMeridiem !== false };
  const pool = useMemo(() => {
    const byId = new Map<string, Task>();
    for (const r of rows) byId.set(r.id, r);
    for (const t of tasks) byId.set(t.id, t); // local copies win (fresher, carry pending edits)
    return [...byId.values()];
  }, [rows, tasks]);
  const picked = useMemo(() => sortTasks(filterTasks(pool, filter, range), sort), [pool, filter, range, sort]);
  const groups = useMemo(() => groupTasks(picked, display.groupBy, listName), [picked, display.groupBy, projects, inboxId]); // eslint-disable-line react-hooks/exhaustive-deps
  const shownTitle = title || defaultTitle(range);

  const templates = ((app.ext.summaryTemplates ?? {}) as { templates?: SummaryTemplate[] }).templates ?? [];
  const saveTemplates = (list: SummaryTemplate[]): void => void repo.setExt("summaryTemplates", { ...((app.ext.summaryTemplates ?? {}) as object), templates: list });

  // ------------------------------------------------------------ export (NOTE-027, NOTE-801)
  const copy = async (text: string, html?: string): Promise<void> => {
    try {
      if (html && typeof ClipboardItem !== "undefined") {
        await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
      } else await navigator.clipboard.writeText(text);
      app.toast("Copied");
    } catch {
      app.toast("The browser refused clipboard access");
    }
  };
  const download = (name: string, blob: Blob): void => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  const fileBase = shownTitle.replace(/[\\/:*?"<>|]+/g, "").replace(/\s+/g, " ").trim() || "Summary";
  const saveImage = async (): Promise<void> => {
    const el = reportRef.current;
    if (!el) return;
    const height = el.scrollHeight;
    if (height > MAX_IMAGE_HEIGHT) {
      app.toast("This summary is too long to save as an image");
      return;
    }
    const width = 820;
    const html = toHtml(shownTitle, groups, display, ctxR);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 80}"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Inter,Segoe UI,system-ui,sans-serif;color:#1f1f1f;background:#fff;padding:32px 40px;font-size:14px;line-height:1.55">${html}</div></foreignObject></svg>`;
    try {
      const img = new Image();
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      });
      const canvas = document.createElement("canvas");
      canvas.width = width * 2;
      canvas.height = (height + 80) * 2;
      const g = canvas.getContext("2d")!;
      g.scale(2, 2);
      g.fillStyle = "#fff";
      g.fillRect(0, 0, width, height + 80);
      g.drawImage(img, 0, 0);
      canvas.toBlob((b) => b && download(`${fileBase}.png`, b), "image/png");
    } catch {
      app.toast("The image could not be made in this browser");
    }
  };
  const email = (): void => {
    let body = toPlainText(shownTitle, groups, display, ctxR);
    if (body.length > 1800) body = `${body.slice(0, 1800)}\n\n(The summary was shortened for email. Use Copy or Download for the full text.)`;
    location.href = `mailto:?subject=${encodeURIComponent(shownTitle)}&body=${encodeURIComponent(body)}`;
  };
  const printIt = (): void => {
    document.body.classList.add("print-summary");
    const done = (): void => {
      document.body.classList.remove("print-summary");
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    window.print();
    setTimeout(done, 1500);
  };

  const applyTemplate = (t: SummaryTemplate): void => {
    setFilter({ ...DEFAULT_FILTER, ...t.filter });
    setDisplay({ ...DEFAULT_DISPLAY, ...t.display, fields: { ...DEFAULT_DISPLAY.fields, ...(t.display?.fields ?? {}) } });
    setSort(t.sort ?? "completedTime");
    setTemplateId(t.id);
  };
  const currentTemplate = templates.find((t) => t.id === templateId);

  return (
    <div className="sum-screen" data-testid="summary-screen">
      <div className="sum-toolbar">
        <div className="view-header sum-head">
          <h1 className="view-title">Summary</h1>
          <TemplatesButton templates={templates} current={currentTemplate} onApply={applyTemplate} onSave={(name) => {
            const t: SummaryTemplate = { id: newId(), name, filter, display, sort };
            saveTemplates([...templates, t]);
            setTemplateId(t.id);
          }} onRename={(id, name) => saveTemplates(templates.map((t) => (t.id === id ? { ...t, name } : t)))} onDelete={(id) => {
            saveTemplates(templates.filter((t) => t.id !== id));
            if (templateId === id) setTemplateId("");
          }} />
          <MenuButton
            className="btn sm sum-export-btn"
            title="Save As"
            testId="summary-export"
            placement="bottom-end"
            items={() => [
              { label: "Copy as Markdown", testId: "export-md-copy", onClick: () => void copy(toMarkdown(shownTitle, groups, display)) },
              { label: "Copy as plain text", testId: "export-text-copy", onClick: () => void copy(toPlainText(shownTitle, groups, display, ctxR)) },
              { label: "Copy as rich text", testId: "export-rich-copy", onClick: () => void copy(toPlainText(shownTitle, groups, display, ctxR), toHtml(shownTitle, groups, display, ctxR)) },
              { divider: true, label: "" },
              { label: "Download Markdown (.md)", testId: "export-md", onClick: () => download(`${fileBase}.md`, new Blob([toMarkdown(shownTitle, groups, display)], { type: "text/markdown" })) },
              { label: "Download plain text (.txt)", testId: "export-txt", onClick: () => download(`${fileBase}.txt`, new Blob([toPlainText(shownTitle, groups, display, ctxR)], { type: "text/plain" })) },
              { label: "Save as image (.png)", testId: "export-image", onClick: () => void saveImage() },
              { label: "Print or save as PDF", testId: "export-pdf", onClick: printIt },
              { label: "Send by email", testId: "export-email", onClick: email },
            ]}
          >
            <Download size={14} /> <span className="sum-btn-label">Save As</span>
          </MenuButton>
        </div>
        <div className="sum-filters">
          <RangeButton filter={filter} onChange={setFilter} label={filter.range === "custom" ? `${dayKey(range.from)} to ${dayKey(range.to)}` : RANGE_LABEL[filter.range]} />
          <ListsButton value={filter.lists} onChange={(lists) => setFilter({ ...filter, lists })} />
          <Select
            testId="summary-status"
            value={filter.status}
            onChange={(v: StatusFilter) => setFilter({ ...filter, status: v })}
            options={[
              { value: "completed", label: "Completed" },
              { value: "uncompleted", label: "Uncompleted" },
              { value: "all", label: "All statuses" },
            ]}
          />
          <MoreButton value={filter.priorities} onChange={(priorities) => setFilter({ ...filter, priorities })} />
          <span className="grow" />
          <DisplayButton value={display} onChange={setDisplay} />
          <SortButton value={sort} onChange={setSort} />
        </div>
      </div>
      <div className="sum-scroll">
        <article className="sum-report" ref={reportRef} data-testid="summary-report">
          <input className="sum-title" value={shownTitle} onChange={(e) => setTitle(e.target.value)} aria-label="Summary title" data-testid="summary-title" />
          <div className="sum-meta">
            {picked.length} {picked.length === 1 ? "task" : "tasks"} · {new Date(range.from).toLocaleDateString("en-US", { month: "long", day: "numeric" })} to {new Date(range.to).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            {loading && <span className="muted"> · loading</span>}
            {title && (
              <button className="link-btn sum-reset-title" onClick={() => setTitle("")}>Reset title</button>
            )}
          </div>
          {groups.length === 0 && !loading && <div className="sum-empty">Nothing matches this period and these filters.</div>}
          {groups.map((g) => (
            <section key={g.key} className="sum-group" data-testid="summary-group" data-label={g.label}>
              {g.label && (
                <h2 className="sum-group-title">
                  {g.label} <span className="sum-count">{g.tasks.length}</span>
                </h2>
              )}
              <ul className="sum-list">
                {withDepth(g.tasks, display.fields.parent).map(({ task, depth }) => {
                  const parts = detailParts(task, display.fields, ctxR);
                  return (
                    <li key={task.id} className={`sum-item${task.status === 2 ? " done" : ""}`} style={{ paddingLeft: depth * 22 }} data-testid="summary-item" data-title={task.title}>
                      {display.fields.status && <span className={`sum-mark${task.status === 2 ? " done" : ""}`} aria-label={task.status === 2 ? "Completed" : "Open"} />}
                      <span className="sum-item-title">{task.title || "Untitled"}</span>
                      {parts.length > 0 && <span className="sum-item-meta">{parts.join("  ·  ")}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

function RangeButton({ filter, onChange, label }: { filter: SummaryFilter; onChange: (f: SummaryFilter) => void; label: string }): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  const presets: RangePreset[] = ["today", "thisWeek", "lastWeek", "thisMonth", "lastMonth", "next7"];
  return (
    <>
      <button className="chip-btn sum-chip" data-testid="summary-range" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <CalendarRange size={14} /> {label} <ChevronDown size={13} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} testId="summary-range-menu">
          <div className="menu">
            {presets.map((p) => (
              <button key={p} className={`menu-item${filter.range === p ? " on" : ""}`} onClick={() => (onChange({ ...filter, range: p }), setA(null))}>
                <span className="menu-label">{RANGE_LABEL[p]}</span>
              </button>
            ))}
            <div className="menu-divider" />
            <div className="sum-custom">
              <span className="m4-label">Custom</span>
              <input className="field" type="date" data-testid="summary-from" value={filter.from ?? ""} onChange={(e) => onChange({ ...filter, range: "custom", from: e.target.value, to: filter.to || e.target.value })} />
              <input className="field" type="date" data-testid="summary-to" value={filter.to ?? ""} onChange={(e) => onChange({ ...filter, range: "custom", to: e.target.value, from: filter.from || e.target.value })} />
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

function ListsButton({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }): JSX.Element {
  const { projects, inboxId } = useApp();
  const [a, setA] = useState<Anchor | null>(null);
  const lists = [{ id: inboxId, name: "Inbox", color: null as string | null | undefined }, ...projects.filter((p) => !p.closed).sort((x, y) => x.sortOrder - y.sortOrder)];
  const toggle = (id: string): void => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <>
      <button className={`chip-btn sum-chip${value.length ? " on" : ""}`} data-testid="summary-lists" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <ListIcon size={14} /> {value.length ? `${value.length} ${value.length === 1 ? "list" : "lists"}` : "All lists"} <ChevronDown size={13} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} testId="summary-lists-menu" className="sum-pop">
          <div className="sum-pop-head">
            <span className="m4-label">Lists</span>
            {value.length > 0 && <button className="link-btn" onClick={() => onChange([])}>All lists</button>}
          </div>
          {lists.map((p) => (
            <label key={p.id} className="check-row" data-testid="summary-list-option" data-name={p.name}>
              <input type="checkbox" checked={value.includes(p.id)} onChange={() => toggle(p.id)} />
              <span className="color-dot" style={{ background: p.color || "var(--text-3)" }} />
              {p.name}
            </label>
          ))}
        </Popover>
      )}
    </>
  );
}

function MoreButton({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  return (
    <>
      <button className={`chip-btn sum-chip${value.length ? " on" : ""}`} data-testid="summary-more" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <Filter size={14} /> {value.length ? `Priority (${value.length})` : "More"} <ChevronDown size={13} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} testId="summary-more-menu" className="sum-pop">
          <div className="sum-pop-head"><span className="m4-label">Priority</span></div>
          {PRIORITIES.map((p) => (
            <label key={p.value} className="check-row" data-testid={`summary-priority-${p.value}`}>
              <input type="checkbox" checked={value.includes(p.value)} onChange={() => onChange(value.includes(p.value) ? value.filter((x) => x !== p.value) : [...value, p.value])} />
              <PriorityFlag value={p.value} size={14} /> {p.label}
            </label>
          ))}
        </Popover>
      )}
    </>
  );
}

function DisplayButton({ value, onChange }: { value: SummaryDisplay; onChange: (v: SummaryDisplay) => void }): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  const groupOpts: Array<{ v: GroupBy; l: string }> = [
    { v: "status", l: "Status" },
    { v: "list", l: "List" },
    { v: "none", l: "None" },
  ];
  return (
    <>
      <button className="icon-btn" title="Display options" aria-label="Display options" data-testid="summary-display" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <SlidersHorizontal size={16} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="summary-display-menu" className="sum-pop sum-display">
          <div className="sum-pop-head"><span className="m4-label">Group by</span></div>
          <div className="seg small">
            {groupOpts.map((g) => (
              <button key={g.v} className={value.groupBy === g.v ? "on" : ""} data-testid={`summary-group-${g.v}`} onClick={() => onChange({ ...value, groupBy: g.v })}>
                {g.l}
              </button>
            ))}
          </div>
          <div className="sum-pop-head"><span className="m4-label">Fields</span></div>
          {(Object.keys(FIELD_LABEL) as Array<keyof SummaryFields>).map((k) => (
            <div key={k} className="sum-field-row">
              <span>{FIELD_LABEL[k]}</span>
              <Switch testId={`summary-field-${k}`} checked={value.fields[k]} onChange={(v) => onChange({ ...value, fields: { ...value.fields, [k]: v } })} />
            </div>
          ))}
        </Popover>
      )}
    </>
  );
}

function SortButton({ value, onChange }: { value: SortBy; onChange: (v: SortBy) => void }): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  return (
    <>
      <button className="icon-btn" title={`Sort: ${SORT_LABEL[value]}`} aria-label="Sort" data-testid="summary-sort" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <ArrowDownUp size={16} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" testId="summary-sort-menu">
          <Menu
            onClose={() => setA(null)}
            items={[
              ...(Object.keys(SORT_LABEL) as SortBy[]).map((k) => ({ label: SORT_LABEL[k], checked: value === k, testId: `summary-sort-${k}`, onClick: () => onChange(k) })),
              { label: "Assignee (single user, no effect)", disabled: true },
            ]}
          />
        </Popover>
      )}
    </>
  );
}

function TemplatesButton({ templates, current, onApply, onSave, onRename, onDelete }: { templates: SummaryTemplate[]; current?: SummaryTemplate; onApply: (t: SummaryTemplate) => void; onSave: (name: string) => void; onRename: (id: string, name: string) => void; onDelete: (id: string) => void }): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  return (
    <>
      <button className="btn sm sum-template-btn" data-testid="summary-templates" onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <Bookmark size={14} /> <span className="sum-btn-label">{current ? current.name : "Templates"}</span> <ChevronDown size={13} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => (setA(null), setEditing(null))} placement="bottom-end" testId="summary-templates-menu" className="sum-pop sum-templates">
          <div className="sum-pop-head"><span className="m4-label">Templates</span><span className="muted small">{templates.length}</span></div>
          {templates.length === 0 && <div className="empty-note">No templates yet</div>}
          {templates.map((t) =>
            editing?.id === t.id ? (
              <form key={t.id} className="sum-tpl-row" onSubmit={(e) => {
                e.preventDefault();
                if (editing.name.trim()) onRename(t.id, editing.name.trim());
                setEditing(null);
              }}>
                <input className="field grow" autoFocus data-testid="summary-template-rename-input" value={editing.name} onChange={(e) => setEditing({ id: t.id, name: e.target.value })} />
                <button className="btn sm" type="submit">OK</button>
              </form>
            ) : (
              <div key={t.id} className={`sum-tpl-row${current?.id === t.id ? " on" : ""}`} data-testid="summary-template" data-name={t.name}>
                <button className="sum-tpl-name" onClick={() => (onApply(t), setA(null))}>{t.name}</button>
                <button className="icon-btn xs" title="Rename" aria-label="Rename" data-testid="summary-template-rename" onClick={() => setEditing({ id: t.id, name: t.name })}><Pencil size={13} /></button>
                <button className="icon-btn xs" title="Delete" aria-label="Delete" data-testid="summary-template-delete" onClick={() => onDelete(t.id)}><Trash2 size={13} /></button>
              </div>
            ),
          )}
          <form className="sum-tpl-new" onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onSave(name.trim());
            setName("");
          }}>
            <input className="field grow" placeholder="Save current as..." data-testid="summary-template-name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn sm primary" type="submit" data-testid="summary-save-template" disabled={!name.trim()}>Save</button>
          </form>
        </Popover>
      )}
    </>
  );
}
