import { withSyncBase } from "../data/fieldSync";
import { ChevronDown, Printer, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatQueryDate, type Task } from "../lib/core";
import { parseDate, weekStartIndex } from "../lib/dates";
import { completedRange, groupByCompletionDay, type CompletedRange, type ViewRef } from "../model/views";
import { useApp } from "./ctx";
import { EmptyState, ViewHeader, useRowClick } from "./ListView";
import { Menu, Modal, Popover, anchorOf, type Anchor } from "./primitives";
import { TaskRow } from "./TaskRow";

async function storeRows(app: ReturnType<typeof useApp>, rows: Task[]): Promise<void> {
  const pending = await app.engine.pendingKeys();
  for (const r of rows) if (!pending.has(`task:${r.id}`)) await app.db.tasks.put(withSyncBase(r));
}

const RANGE_LABEL: Record<CompletedRange, string> = { all: "All Dates", thisWeek: "This Week", lastWeek: "Last Week", thisMonth: "This Month", custom: "Other Date" };

/** Completed and Won't Do: grouped by completion day, All Dates and All Lists filters, paged from the closed endpoint. */
export function ClosedScreen({ wontDo }: { wontDo: boolean }): JSX.Element {
  const app = useApp();
  const { tasks, projects, inboxId, now, settings } = app;
  const view: ViewRef = { type: "smart", name: wontDo ? "abandoned" : "completed" };
  const [range, setRange] = useState<CompletedRange>("all");
  const [custom, setCustom] = useState<{ from: number; to: number } | undefined>();
  const [lists, setLists] = useState<Set<string> | null>(null);
  const [pop, setPop] = useState<{ kind: "dates" | "lists" | "custom"; anchor: Anchor } | null>(null);
  const [draftLists, setDraftLists] = useState<Set<string>>(new Set());
  const [more, setMore] = useState(true);
  const status = wontDo ? -1 : 2;
  const r = completedRange(range, now, weekStartIndex(settings.startDayOfWeek), custom);

  const fetchPage = async (to?: string): Promise<void> => {
    try {
      const q = new URLSearchParams({ status: wontDo ? "Abandoned" : "Completed", limit: "50" });
      if (r) q.set("from", formatQueryDate(r.from));
      if (to) q.set("to", to);
      else if (r) q.set("to", formatQueryDate(r.to));
      const ids = lists ? [...lists].join(",") : "all";
      const rows = await app.engine.api.get<Task[]>(`/api/v2/project/${ids}/closed?${q.toString()}`);
      await storeRows(app, rows ?? []);
      setMore((rows ?? []).length >= 50);
    } catch {
      setMore(false);
    }
  };
  useEffect(() => {
    void fetchPage();
  }, [range, custom, lists, wontDo]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(
    () =>
      tasks.filter((t) => {
        if (t.deleted || t.status !== status) return false;
        if (lists && !lists.has(t.projectId)) return false;
        if (r) {
          const c = parseDate(t.completedTime);
          if (Number.isNaN(c) || c < r.from || c > r.to) return false;
        }
        return true;
      }),
    [tasks, status, lists, r?.from, r?.to], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const groups = groupByCompletionDay(rows, now);
  const ordered = groups.flatMap((g) => g.tasks);
  const onRowClick = useRowClick(view, ordered);
  const allLists = [{ id: inboxId, name: "Inbox" }, ...projects];

  return (
    <div className="list-view" data-testid={wontDo ? "wontdo-screen" : "completed-screen"}>
      <ViewHeader title={wontDo ? "Won't Do" : "Completed"}>
        <button className="icon-btn" aria-label="Print" title="Print" onClick={() => app.setModal({ kind: "print", taskIds: ordered.map((t) => t.id), title: wontDo ? "Won't Do" : "Completed" })}>
          <Printer size={17} />
        </button>
      </ViewHeader>
      <div className="filter-chips">
        <button className="chip-btn" data-testid="chip-dates" onClick={(e) => setPop({ kind: "dates", anchor: anchorOf(e.currentTarget) })}>
          {range === "custom" && custom ? `${new Date(custom.from).toLocaleDateString()} - ${new Date(custom.to).toLocaleDateString()}` : RANGE_LABEL[range]} <ChevronDown size={13} />
        </button>
        <button
          className="chip-btn"
          data-testid="chip-lists"
          onClick={(e) => {
            setDraftLists(new Set(lists ?? allLists.map((l) => l.id)));
            setPop({ kind: "lists", anchor: anchorOf(e.currentTarget) });
          }}
        >
          {lists ? (lists.size === 1 ? app.projectName([...lists][0]!) : `${lists.size} Lists`) : "All Lists"} <ChevronDown size={13} />
        </button>
      </div>
      <div className="task-scroll">
        {rows.length === 0 && (wontDo ? <EmptyState title="Everything is in progress" sub="Keep it up :)" /> : <EmptyState title="No completed tasks" sub="Completed tasks show up here." />)}
        {groups.map((g) => (
          <section key={g.key} className="task-group">
            <div className="group-head">
              <span className="group-toggle static">
                <span className="group-label">{g.label}</span>
                <span className="group-count">{g.tasks.length}</span>
              </span>
            </div>
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} view={view} showList onRowClick={onRowClick} />
            ))}
          </section>
        ))}
        {more && rows.length >= 50 && (
          <button className="link-btn view-more" onClick={() => void fetchPage(formatQueryDate(Math.min(...rows.map((t) => parseDate(t.completedTime)).filter((x) => !Number.isNaN(x)))))}>
            Load more
          </button>
        )}
      </div>
      {pop?.kind === "dates" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} testId="dates-menu">
          <Menu
            onClose={() => setPop(null)}
            items={(Object.keys(RANGE_LABEL) as CompletedRange[]).map((k) => ({
              label: RANGE_LABEL[k],
              checked: range === k,
              onClick: () => {
                if (k === "custom") setTimeout(() => setPop({ kind: "custom", anchor: pop.anchor }), 0);
                else setRange(k);
              },
            }))}
          />
        </Popover>
      )}
      {pop?.kind === "custom" && <CustomRange onClose={() => setPop(null)} onOk={(v) => (setCustom(v), setRange("custom"), setPop(null))} />}
      {pop?.kind === "lists" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} testId="lists-menu" className="tag-picker">
          <label className="check-row">
            <input type="checkbox" checked={draftLists.size === allLists.length} onChange={(e) => setDraftLists(new Set(e.target.checked ? allLists.map((l) => l.id) : []))} /> All Lists
          </label>
          <div className="tag-list">
            {allLists.map((l) => (
              <label key={l.id} className="check-row">
                <input
                  type="checkbox"
                  checked={draftLists.has(l.id)}
                  onChange={() =>
                    setDraftLists((s) => {
                      const n = new Set(s);
                      if (n.has(l.id)) n.delete(l.id);
                      else n.add(l.id);
                      return n;
                    })
                  }
                />
                {l.name}
              </label>
            ))}
          </div>
          <div className="row gap end">
            <button className="btn" onClick={() => setPop(null)}>Cancel</button>
            <button className="btn primary" onClick={() => (setLists(draftLists.size === allLists.length || draftLists.size === 0 ? null : new Set(draftLists)), setPop(null))}>OK</button>
          </div>
        </Popover>
      )}
    </div>
  );
}

function CustomRange({ onClose, onOk }: { onClose: () => void; onOk: (v: { from: number; to: number }) => void }): JSX.Element {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  return (
    <Modal onClose={onClose} testId="custom-range">
      <h3>Other Date</h3>
      <div className="row gap">
        <label className="col">From <input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="col">To <input className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="row gap end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onOk({ from: new Date(`${from}T00:00`).getTime(), to: new Date(`${to}T00:00`).getTime() })}>OK</button>
      </div>
    </Modal>
  );
}

export function TrashScreen(): JSX.Element {
  const app = useApp();
  const { tasks, repo } = app;
  const view: ViewRef = { type: "smart", name: "trash" };
  const [next, setNext] = useState<number | null>(0);
  const load = async (offset: number): Promise<void> => {
    try {
      const page = await app.engine.api.get<{ tasks: Task[]; next: number }>(`/api/v2/project/all/trash/page?limit=50&type=1${offset ? `&next=${offset}` : ""}`);
      await storeRows(app, page.tasks ?? []);
      setNext(page.tasks.length < 50 ? null : page.next);
    } catch {
      setNext(null);
    }
  };
  useEffect(() => {
    void load(0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = tasks.filter((t) => t.deleted).sort((a, b) => (Number(b.deletedTime) || 0) - (Number(a.deletedTime) || 0));
  const onRowClick = useRowClick(view, rows);
  return (
    <div className="list-view" data-testid="trash-screen">
      <ViewHeader title="Trash">
        <button
          className="icon-btn"
          aria-label="Empty trash"
          title="Empty trash"
          data-testid="empty-trash"
          onClick={() => app.setModal({ kind: "confirm", title: "Empty trash", body: "All tasks in the Trash will be deleted permanently. This cannot be undone.", ok: "Delete all", danger: true, onOk: () => void repo.emptyTrash() })}
        >
          <Trash2 size={17} />
        </button>
      </ViewHeader>
      <div className="task-scroll">
        {rows.length === 0 && <EmptyState title="Trash is empty" sub="Deleted tasks wait here until you clear them." />}
        {rows.map((t) => (
          <div key={t.id} className="trash-row">
            <TaskRow task={t} view={view} showList trash readOnly onRowClick={onRowClick} />
            <div className="trash-actions">
              <button className="icon-btn xs" title="Restore" aria-label="Restore" data-testid="trash-restore" onClick={() => void repo.restoreFromTrash([t.id]).then(() => app.toast("Task restored"))}>
                <RotateCcw size={14} />
              </button>
              <button
                className="icon-btn xs"
                title="Delete forever"
                aria-label="Delete forever"
                onClick={() => app.setModal({ kind: "confirm", title: "Delete forever", body: "This task will be deleted permanently.", ok: "Delete", danger: true, onOk: () => void repo.deleteForever([t.id]) })}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
        {next !== null && rows.length >= 50 && (
          <button className="link-btn view-more" onClick={() => void load(next)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

export function PlaceholderScreen({ title, text }: { title: string; text: string }): JSX.Element {
  return (
    <div className="list-view" data-testid="placeholder-screen">
      <ViewHeader title={title} />
      <EmptyState title={title} sub={text} />
    </div>
  );
}
