import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useLiveQuery } from "dexie-react-hooks";
import { ArrowDown, ArrowUp, ChevronDown, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  QUADRANT_IDS, QUADRANT_LABELS, complexMatrixRules, defaultMatrixPrefs, newId, orderBetween, patchForRule, quadrantIndexOf, ruleConditions, ruleFromConditions, simpleMatrixRules,
  type MatrixPrefs, type Quadrant, type RuleCond, type Task,
} from "../lib/core";
import { addDays, startOfDay, weekStartIndex } from "../lib/dates";
import { go, matrixPath, routeTaskPath } from "../model/router";
import { compareTasks, inAllSet } from "../model/views";
import { useApp, type App } from "./ctx";
import { dragModel } from "./dnd";
import { Menu, Modal, Popover, anchorOf, type Anchor } from "./primitives";
import { matrixEnabled } from "./Sidebar";
import { TaskRow } from "./TaskRow";
import { moveToDay } from "./taskutil";

export const DEFAULT_PROFILE = "default";
const Q_COLORS = ["var(--p-high)", "var(--p-med)", "var(--p-low)", "#3fa66b"];

/** profile writes are read-modify-write on one ext section: run them one after another */
let writeChain: Promise<unknown> = Promise.resolve();
const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
};

export interface MatrixProfile {
  id: string;
  name: string;
  sortOrder: number;
  quadrants: Quadrant[];
}

/**
 * Matrix profiles. The default profile is ext.matrix (sync wire shape); extra named views live in
 * ext.matrixProfiles until the server has /api/v2/matrixProfiles (MTRX-011). No count limit (PREM-056).
 */
export function useProfiles(app: App): { profiles: MatrixProfile[]; prefs: MatrixPrefs; save: (p: MatrixProfile) => Promise<void>; remove: (id: string) => Promise<void>; reorder: (ids: string[]) => Promise<void> } {
  const prefs: MatrixPrefs = { ...defaultMatrixPrefs(), ...((app.ext.matrix ?? {}) as Partial<MatrixPrefs>) };
  const extra = (((app.ext.matrixProfiles ?? {}) as { profiles?: MatrixProfile[] }).profiles ?? []).slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const profiles: MatrixProfile[] = [{ id: DEFAULT_PROFILE, name: ((app.ext.matrix ?? {}) as { name?: string }).name ?? "Eisenhower Matrix", sortOrder: -Infinity, quadrants: prefs.quadrants }, ...extra];
  // writes read the stored sections fresh, so quick successive edits never work on a stale render
  const fresh = async (): Promise<{ prefs: MatrixPrefs; extra: MatrixProfile[] }> => {
    const ext = await app.repo.ext();
    return { prefs: { ...defaultMatrixPrefs(), ...((ext.matrix ?? {}) as Partial<MatrixPrefs>) }, extra: ((ext.matrixProfiles ?? {}) as { profiles?: MatrixProfile[] }).profiles ?? [] };
  };
  const save = (p: MatrixProfile): Promise<void> => serial(async () => {
    const f = await fresh();
    if (p.id === DEFAULT_PROFILE) {
      await app.repo.setExt("matrix", { ...f.prefs, quadrants: p.quadrants, name: p.name });
      return;
    }
    const list = f.extra.some((x) => x.id === p.id) ? f.extra.map((x) => (x.id === p.id ? p : x)) : [...f.extra, p];
    await app.repo.setExt("matrixProfiles", { profiles: list });
  });
  const remove = (id: string): Promise<void> => serial(async () => {
    const f = await fresh();
    await app.repo.setExt("matrixProfiles", { profiles: f.extra.filter((x) => x.id !== id) });
  });
  const reorder = (ids: string[]): Promise<void> => serial(async () => {
    const f = await fresh();
    await app.repo.setExt("matrixProfiles", { profiles: ids.map((id, i) => ({ ...f.extra.find((x) => x.id === id)!, sortOrder: i })).filter((x) => x.id) });
  });
  return { profiles, prefs, save, remove, reorder };
}

function Quad({ i, profile, tasks, app, sortType, setSort }: { i: number; profile: MatrixProfile; tasks: Task[]; app: App; sortType: string; setSort: (s: string) => void }): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `drop:quad:${i}` });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [menu, setMenu] = useState<Anchor | null>(null);
  const q = profile.quadrants[i]!;
  const add = async (): Promise<void> => {
    const t = title.trim();
    if (!t) return setAdding(false);
    // the new task takes the attributes the quadrant rule asks for (MTRX-016)
    const p = patchForRule(q.rule, { projectId: app.inboxId, priority: 0, tags: [] }, { now: app.now, weekStart: weekStartIndex(app.settings.startDayOfWeek) });
    const fields: Partial<Task> & { title: string } = { title: t, priority: p.priority ?? 0 };
    if (p.projectId) fields.projectId = p.projectId;
    if (p.addTag) fields.tags = [p.addTag];
    if (typeof p.dayOffset === "number") Object.assign(fields, moveToDay({ id: "", projectId: "", title: "", sortOrder: 0 } as Task, addDays(startOfDay(app.now), p.dayOffset)), { isAllDay: true });
    await app.repo.createTask(fields);
    setTitle("");
  };
  const open = tasks.filter((t) => t.status === 0);
  return (
    <section ref={setNodeRef} className={`mx-quad${isOver ? " over" : ""}`} data-testid={`quadrant-${i + 1}`} data-quadrant={QUADRANT_IDS[i]}>
      <header className="mx-head">
        <span className="mx-badge" style={{ background: Q_COLORS[i], color: i === 1 ? "var(--on-accent)" : undefined }}>{["I", "II", "III", "IV"][i]}</span>
        <span className="mx-label" style={{ color: Q_COLORS[i] }}>{q.name || QUADRANT_LABELS[i]}</span>
        <span className="group-count">{open.length}</span>
        <span className="grow" />
        <button className="icon-btn xs" aria-label="Add task" data-testid={`quad-add-${i + 1}`} onClick={() => setAdding(true)}><Plus size={15} /></button>
        <button className="icon-btn xs" aria-label="Quadrant menu" data-testid={`quad-menu-${i + 1}`} onClick={(e) => setMenu(anchorOf(e.currentTarget))}><MoreHorizontal size={15} /></button>
      </header>
      <div className="mx-list">
        {adding && <input className="field full mx-add" autoFocus placeholder={`Add task to "${q.name || QUADRANT_LABELS[i]}"`} value={title} data-testid="quad-add-input" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => (e.key === "Enter" ? void add() : e.key === "Escape" && setAdding(false))} onBlur={() => !title.trim() && setAdding(false)} />}
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} view={app.route.view} sortable={t.status === 0} showList onRowClick={(_e, x) => (location.hash = routeTaskPath(app.route, x.id))} />
          ))}
        </SortableContext>
        {tasks.length === 0 && !adding && <div className="mx-empty">No tasks</div>}
      </div>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} placement="bottom-end" testId="quad-popover">
          <Menu
            onClose={() => setMenu(null)}
            items={[
              { label: "Sort by", hint: { dueDate: "Date", priority: "Priority", title: "Title", sortOrder: "Custom" }[sortType] ?? "Date", submenu: () => <Menu onClose={() => setMenu(null)} items={[["dueDate", "Date"], ["priority", "Priority"], ["title", "Title"], ["sortOrder", "Custom"]].map(([v, l]) => ({ label: l!, checked: sortType === v, testId: `quad-sort-${v}`, onClick: () => setSort(v!) }))} /> },
              { label: "Edit Rules", testId: "quad-edit-rules", onClick: () => app.setModal({ kind: "matrixRules", profileId: profile.id, quadrant: i }) },
            ]}
          />
        </Popover>
      )}
    </section>
  );
}

export function MatrixScreen(): JSX.Element {
  const app = useApp();
  const { tasks, projects, inboxId, now, settings, local, setLocal, route, repo } = app;
  const { profiles, prefs, save } = useProfiles(app);
  const activeId = route.matrixId && profiles.some((p) => p.id === route.matrixId) ? route.matrixId : profiles.some((p) => p.id === local.matrixActiveViewId) ? local.matrixActiveViewId : DEFAULT_PROFILE;
  const profile = profiles.find((p) => p.id === activeId)!;
  const orders = useLiveQuery(() => app.db.getKV<Record<string, Record<string, number>>>("matrixOrders", {}), [], {} as Record<string, Record<string, number>>);
  const [pick, setPick] = useState<Anchor | null>(null);
  const [more, setMore] = useState<Anchor | null>(null);
  const on = matrixEnabled(app);

  const rctx = useMemo(() => ({ now, projectGroup: Object.fromEntries(projects.map((p) => [p.id, p.groupId])), weekStart: weekStartIndex(settings.startDayOfWeek) }), [now, projects, settings.startDayOfWeek]);
  const rules = profile.quadrants.map((q) => q.rule);
  const quads = useMemo(() => {
    const allowed = inAllSet(projects, inboxId);
    const out: Task[][] = [[], [], [], []];
    for (const t of tasks) {
      if (t.deleted || !allowed.has(t.projectId) || t.kind === "NOTE") continue;
      if (t.status !== 0 && !(prefs.show_completed && t.status === 2)) continue;
      if (t.status === 2 && startOfDay(Date.parse(String(t.completedTime ?? "").replace("+0000", "Z"))) < addDays(startOfDay(now), -1)) continue; // recent completions only
      const qi = quadrantIndexOf(t.status === 0 ? t : { ...t, status: 0 }, rules, rctx);
      if (qi >= 0) out[qi]!.push(t);
    }
    return out.map((l, i) => {
      const st = profile.quadrants[i]!.sortType || "dueDate";
      const scope = `${QUADRANT_IDS[i]}_${profile.id}`;
      const ord = orders[scope] ?? {};
      const cmp = st === "sortOrder" ? (a: Task, b: Task) => (ord[a.id] ?? a.sortOrder) - (ord[b.id] ?? b.sortOrder) : compareTasks(st, st === "priority" ? "desc" : "asc", { now, inboxId, projects });
      return [...l.filter((t) => t.status === 0).sort(cmp), ...l.filter((t) => t.status !== 0)];
    });
  }, [tasks, projects, inboxId, rules.join("|"), rctx, prefs.show_completed, profile, orders, now]); // eslint-disable-line react-hooks/exhaustive-deps

  dragModel.ids = quads.flat().map((t) => t.id);
  dragModel.view = route.view;
  dragModel.onDrop = async (activeId2, overId) => {
    const t = tasks.find((x) => x.id === activeId2);
    if (!t) return;
    const from = quads.findIndex((l) => l.some((x) => x.id === activeId2));
    const to = overId.startsWith("drop:quad:") ? Number(overId.slice(10)) : quads.findIndex((l) => l.some((x) => x.id === overId));
    if (to < 0) return;
    if (from === to) {
      // manual order inside a quadrant (MTRX-018) switches the quadrant to Custom sort
      if (overId.startsWith("drop:quad:")) return;
      const scope = `${QUADRANT_IDS[to]}_${profile.id}`;
      const ord = orders[scope] ?? {};
      const list = quads[to]!.filter((x) => x.status === 0 && x.id !== activeId2);
      const oi = list.findIndex((x) => x.id === overId);
      const val = (x: Task): number => ord[x.id] ?? x.sortOrder;
      const fromIdx = quads[to]!.findIndex((x) => x.id === activeId2);
      const overIdx = quads[to]!.findIndex((x) => x.id === overId);
      const idx = fromIdx < overIdx ? oi + 1 : oi;
      const r = orderBetween(idx > 0 ? val(list[idx - 1]!) : undefined, idx < list.length ? val(list[idx]!) : undefined);
      if (profile.quadrants[to]!.sortType !== "sortOrder") {
        for (let k = 0; k < list.length; k++) await repo.setMatrixOrder(scope, list[k]!.id, val(list[k]!));
        await save({ ...profile, quadrants: profile.quadrants.map((q, k) => (k === to ? { ...q, sortType: "sortOrder" } : q)) });
      }
      await repo.setMatrixOrder(scope, activeId2, r.order);
      return;
    }
    // drag between quadrants rewrites the fields the target rule needs (MTRX-017)
    const p = patchForRule(rules[to]!, t, rctx);
    const patch: Partial<Task> = {};
    if (p.priority !== undefined) patch.priority = p.priority;
    if (p.dayOffset === null) Object.assign(patch, { startDate: undefined, dueDate: undefined, isAllDay: undefined, reminders: [] });
    else if (typeof p.dayOffset === "number") Object.assign(patch, moveToDay(t, addDays(startOfDay(now), p.dayOffset)));
    if (p.addTag) patch.tags = [...new Set([...(t.tags ?? []), p.addTag])];
    if (p.projectId) await repo.moveTasks([t.id], p.projectId);
    if (Object.keys(patch).length) await repo.updateTask(t.id, patch, { undo: "Moved to another quadrant" });
    app.toast(`Moved to ${profile.quadrants[to]!.name || QUADRANT_LABELS[to]}`, () => void repo.undo());
  };

  if (!on)
    return (
      <div className="mx-off" data-testid="matrix-off">
        <span className="muted small">Eisenhower Matrix is switched off. Turn it on in Settings, Features.</span>
      </div>
    );

  const setSort = (i: number, s: string): void => void save({ ...profile, quadrants: profile.quadrants.map((q, k) => (k === i ? { ...q, sortType: s } : q)) });
  const switchTo = (id: string): void => {
    setLocal("matrixActiveViewId", id);
    go(matrixPath(id === DEFAULT_PROFILE ? undefined : id));
  };

  return (
    <div className="mx-screen" data-testid="matrix">
      <div className="mx-top">
        <button className="mx-title" data-testid="matrix-title" onClick={(e) => setPick(anchorOf(e.currentTarget))}>
          {profile.name} <ChevronDown size={15} />
        </button>
        <span className="grow" />
        <button className="icon-btn" aria-label="Matrix menu" data-testid="matrix-more" onClick={(e) => setMore(anchorOf(e.currentTarget))}><MoreHorizontal size={18} /></button>
      </div>
      <div className="mx-grid">
        {[0, 1, 2, 3].map((i) => (
          <Quad key={i} i={i} profile={profile} tasks={quads[i]!} app={app} sortType={profile.quadrants[i]!.sortType || "dueDate"} setSort={(s) => setSort(i, s)} />
        ))}
      </div>
      {pick && (
        <Popover anchor={pick} onClose={() => setPick(null)} testId="matrix-views">
          <Menu onClose={() => setPick(null)} items={[...profiles.map((p) => ({ label: p.name, checked: p.id === profile.id, testId: `matrix-view-${p.name}`, onClick: () => switchTo(p.id) })), { divider: true, label: "" }, { label: "Manage Views", testId: "matrix-manage", onClick: () => app.setModal({ kind: "matrixViews" }) }]} />
        </Popover>
      )}
      {more && (
        <Popover anchor={more} onClose={() => setMore(null)} placement="bottom-end" testId="matrix-menu">
          <Menu
            onClose={() => setMore(null)}
            items={[
              { label: "Edit Rules", testId: "matrix-edit-rules", onClick: () => app.setModal({ kind: "matrixRules", profileId: profile.id }) },
              { label: "Manage Views", onClick: () => app.setModal({ kind: "matrixViews" }) },
              { label: prefs.show_completed ? "Hide Completed" : "Show Completed", testId: "matrix-completed", onClick: () => void repo.ext().then((e) => repo.setExt("matrix", { ...defaultMatrixPrefs(), ...((e.matrix ?? {}) as object), show_completed: !prefs.show_completed })) },
            ]}
          />
        </Popover>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- rule editor (MTRX-004..009, PREM-096)

const DATE_TOKENS: Array<[string, string]> = [["overdue", "Overdue"], ["today", "Today"], ["tomorrow", "Tomorrow"], ["thisweek", "This Week"], ["7days", "Next 7 Days"], ["nextweek", "Next Week"], ["thismonth", "This Month"], ["2dayslater", "Day after tomorrow and later"], ["nodue", "No Date"], ["recurring", "Repeat"]];
const PRIOS: Array<[number, string]> = [[5, "High"], [3, "Medium"], [1, "Low"], [0, "None"]];

function condValues(rule: string, name: string): string[] {
  return ruleConditions(rule).find((c) => c.conditionName === name)?.or.map(String) ?? [];
}

export function MatrixRulesDialog({ profileId, quadrant }: { profileId: string; quadrant?: number }): JSX.Element {
  const app = useApp();
  const { profiles, save } = useProfiles(app);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0]!;
  const [quads, setQuads] = useState<Quadrant[]>(() => profile.quadrants.map((q) => ({ ...q })));
  const [qi, setQi] = useState(quadrant ?? 0);
  const q = quads[qi]!;
  const setCond = (name: string, values: Array<string | number>): void => {
    const conds: RuleCond[] = ruleConditions(q.rule).filter((c) => c.conditionName !== name);
    if (values.length) conds.push({ conditionName: name, conditionType: 1, or: values });
    setQuads(quads.map((x, k) => (k === qi ? { ...x, rule: ruleFromConditions(conds) } : x)));
  };
  const toggle = (name: string, v: string | number, numeric = false): void => {
    const cur = condValues(q.rule, name);
    const key = String(v);
    const next = cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key];
    setCond(name, numeric ? next.map(Number) : next);
  };
  const preset = (rules: string[]): void => setQuads(quads.map((x, k) => ({ ...x, rule: rules[k]! })));
  const tagsSel = condValues(q.rule, "tag");
  const listsSel = condValues(q.rule, "list");
  return (
    <Modal onClose={() => app.setModal(null)} testId="matrix-rules" wide>
      <h3>Edit Rules · {profile.name}</h3>
      <div className="seg small mx-qtabs">
        {quads.map((x, k) => (
          <button key={k} className={k === qi ? "on" : ""} data-testid={`rules-q${k + 1}`} onClick={() => setQi(k)}>{x.name || QUADRANT_LABELS[k]}</button>
        ))}
      </div>
      <div className="mx-rules">
        <label className="form-row"><span>Name</span><input className="field" value={q.name ?? ""} placeholder={QUADRANT_LABELS[qi]} data-testid="rules-name" onChange={(e) => setQuads(quads.map((x, k) => (k === qi ? { ...x, name: e.target.value || undefined } : x)))} /></label>
        <div className="mx-rule-group"><b>Date</b>{DATE_TOKENS.map(([v, l]) => <label key={v} className="mx-chk"><input type="checkbox" data-testid={`rule-date-${v}`} checked={condValues(q.rule, "dueDate").includes(v)} onChange={() => toggle("dueDate", v)} /> {l}</label>)}</div>
        <div className="mx-rule-group"><b>Priority</b>{PRIOS.map(([v, l]) => <label key={v} className="mx-chk"><input type="checkbox" data-testid={`rule-prio-${v}`} checked={condValues(q.rule, "priority").includes(String(v))} onChange={() => toggle("priority", v, true)} /> {l}</label>)}</div>
        <div className="mx-rule-group"><b>Lists</b>
          {[{ id: app.inboxId, name: "Inbox" }, ...app.projects.filter((p) => !p.closed)].map((p) => <label key={p.id} className="mx-chk"><input type="checkbox" data-testid={`rule-list-${p.name}`} checked={listsSel.includes(p.id)} onChange={() => toggle("list", p.id)} /> {p.name}</label>)}
        </div>
        <div className="mx-rule-group"><b>Tags</b>
          {app.tags.map((t) => <label key={t.name} className="mx-chk"><input type="checkbox" data-testid={`rule-tag-${t.name}`} checked={tagsSel.includes(t.name)} onChange={() => toggle("tag", t.name)} /> #{t.label ?? t.name}</label>)}
          <label className="mx-chk"><input type="checkbox" checked={tagsSel.includes("!tag")} onChange={() => toggle("tag", "!tag")} /> No Tags</label>
        </div>
        <div className="mx-rule-group"><b>Assignee</b><label className="mx-chk"><input type="checkbox" checked={condValues(q.rule, "assignee").includes("me")} onChange={() => toggle("assignee", "me")} /> Assigned to Me</label></div>
      </div>
      <div className="row gap mx-presets">
        <span className="muted small">Presets</span>
        <button className="btn sm" data-testid="preset-priority" onClick={() => preset(simpleMatrixRules())}>Priority</button>
        <button className="btn sm" data-testid="preset-time-priority" onClick={() => preset(complexMatrixRules())}>Time + Priority</button>
        <button className="btn sm" data-testid="restore-defaults" onClick={() => setQuads(defaultMatrixPrefs().quadrants)}>Restore Defaults</button>
      </div>
      <div className="row end">
        <button className="btn" onClick={() => app.setModal(null)}>Cancel</button>
        <button className="btn primary" data-testid="rules-save" onClick={() => void save({ ...profile, quadrants: quads }).then(() => app.setModal(null))}>Save</button>
      </div>
    </Modal>
  );
}

/** Manage View: add (inherits the current rules), rename, reorder, delete (MTRX-011, PREM-056, PREM-068). */
export function MatrixViewsDialog(): JSX.Element {
  const app = useApp();
  const { profiles, save, remove, reorder } = useProfiles(app);
  const [name, setName] = useState("");
  const current = profiles.find((p) => p.id === app.local.matrixActiveViewId) ?? profiles[0]!;
  const extra = profiles.filter((p) => p.id !== DEFAULT_PROFILE);
  const add = async (): Promise<void> => {
    const n = name.trim();
    if (!n) return;
    setName("");
    await save({ id: newId(), name: n, sortOrder: Date.now(), quadrants: current.quadrants.map((q) => ({ ...q })) });
  };
  const move = (id: string, dir: -1 | 1): void => {
    const ids = extra.map((p) => p.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void reorder(ids);
  };
  return (
    <Modal onClose={() => app.setModal(null)} testId="matrix-views-dialog">
      <h3>Manage Views</h3>
      {profiles.map((p) => (
        <div key={p.id} className="row gap mx-view-row" data-testid="matrix-view-row">
          <input className="field grow" defaultValue={p.name} onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && void save({ ...p, name: e.target.value.trim() })} />
          {p.id !== DEFAULT_PROFILE && (
            <>
              <button className="icon-btn xs" aria-label="Move up" onClick={() => move(p.id, -1)}><ArrowUp size={13} /></button>
              <button className="icon-btn xs" aria-label="Move down" onClick={() => move(p.id, 1)}><ArrowDown size={13} /></button>
              <button className="icon-btn xs" aria-label="Delete view" data-testid="matrix-view-delete" onClick={() => void remove(p.id)}><Trash2 size={13} /></button>
            </>
          )}
        </div>
      ))}
      <div className="row gap" style={{ marginTop: 10 }}>
        <input className="field grow" placeholder="New view name" value={name} data-testid="matrix-view-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        <button className="btn primary" data-testid="matrix-view-add" onClick={() => void add()}>Add</button>
      </div>
      <div className="row end">
        <button className="btn" onClick={() => app.setModal(null)}>Done</button>
      </div>
    </Modal>
  );
}
