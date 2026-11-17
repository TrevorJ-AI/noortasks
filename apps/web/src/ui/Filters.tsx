import { ChevronDown, Folder, Hash, List as ListIcon, Plus, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { weekStartIndex } from "../lib/dates";
import type { Task } from "../lib/core";
import {
  ADVANCED_CONDS,
  ASSIGNEE_VALUES,
  COND_LABEL,
  DATE_TOKENS,
  NORMAL_CONDS,
  PAST_TOKENS,
  PRIORITY_VALUES,
  TYPE_VALUES,
  builderToRule,
  cond,
  describeRule,
  emptyGroup,
  filterMatches,
  isNormal,
  previewSort,
  ruleToBuilder,
  type BCond,
  type BGroup,
} from "../model/filters";
import { go } from "../model/router";
import { useApp, type App } from "./ctx";
import { Modal, Popover, PriorityFlag, anchorOf, type Anchor } from "./primitives";

type Opt = { value: string | number; label: string; icon?: JSX.Element };

/** Values a condition can take, with labels (FILT-009). */
export function condOptions(app: App, name: string): Opt[] | null {
  switch (name) {
    case "listOrGroup":
    case "list":
      return [
        { value: app.inboxId, label: "Inbox", icon: <ListIcon size={14} /> },
        ...app.groups.map((g) => ({ value: g.id, label: g.name, icon: <Folder size={14} /> })),
        ...app.projects.filter((p) => !p.closed).map((p) => ({ value: p.id, label: p.name, icon: <ListIcon size={14} /> })),
      ];
    case "group":
      return app.groups.map((g) => ({ value: g.id, label: g.name, icon: <Folder size={14} /> }));
    case "tag":
      return [{ value: "!tag", label: "No Tags" }, ...app.tags.map((t) => ({ value: t.name, label: t.label ?? t.name, icon: <Hash size={14} color={t.color ?? undefined} /> }))];
    case "dueDate":
    case "date":
      return DATE_TOKENS;
    case "createdTime":
    case "completedTime":
      return PAST_TOKENS;
    case "priority":
      return PRIORITY_VALUES.map((p) => ({ ...p, icon: <PriorityFlag value={p.value} size={14} /> }));
    case "assignee":
      return ASSIGNEE_VALUES;
    case "taskType":
      return TYPE_VALUES;
    default:
      return null; // free text (keywords, title)
  }
}

export function valueLabel(app: App, name: string, v: string | number): string {
  const s = String(v);
  const m = /^custom\((.*)~(.*)\)$/.exec(s);
  if (m) return `${m[1] || "..."} to ${m[2] || "..."}`;
  return condOptions(app, name)?.find((o) => String(o.value) === s)?.label ?? s;
}

function ValuePicker({ c, onChange, testId }: { c: BCond; onChange: (values: Array<string | number>) => void; testId?: string }): JSX.Element {
  const app = useApp();
  const opts = condOptions(app, c.name);
  const [a, setA] = useState<Anchor | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  if (!opts) {
    return (
      <input
        className="field grow"
        data-testid={testId}
        placeholder="Words, separated by commas"
        defaultValue={c.values.join(", ")}
        onChange={(e) => onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean))}
      />
    );
  }
  const has = (v: string | number): boolean => c.values.some((x) => String(x) === String(v));
  const toggle = (v: string | number): void => onChange(has(v) ? c.values.filter((x) => String(x) !== String(v)) : [...c.values, v]);
  return (
    <>
      <button className="flt-values" data-testid={testId} onClick={(e) => setA(anchorOf(e.currentTarget))}>
        {c.values.length === 0 ? <span className="muted">Any</span> : c.values.map((v) => <span key={String(v)} className="flt-chip">{valueLabel(app, c.name, v)}</span>)}
        <ChevronDown size={14} className="muted" />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} className="flt-pop" testId={testId ? `${testId}-menu` : undefined}>
          <div className="menu tag-list">
            {opts.map((o) => (
              <label key={String(o.value)} className="check-row">
                <input type="checkbox" checked={has(o.value)} onChange={() => toggle(o.value)} />
                {o.icon}
                <span>{o.label}</span>
              </label>
            ))}
            {(c.name === "dueDate" || c.name === "date") && (
              <div className="flt-range">
                <span className="muted small">Custom range</span>
                <input className="field" type="date" aria-label="From" value={from} onChange={(e) => setFrom(e.target.value)} />
                <input className="field" type="date" aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} />
                <button className="btn sm" disabled={!from && !to} onClick={() => onChange([...c.values.filter((x) => !String(x).startsWith("custom(")), `custom(${from}~${to})`])}>Add</button>
              </div>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

function CondRow({ c, onChange, onRemove, names, idx }: { c: BCond; onChange: (c: BCond) => void; onRemove?: () => void; names: string[]; idx: string }): JSX.Element {
  return (
    <div className="flt-cond" data-testid={`flt-cond-${idx}`}>
      <select className="field flt-name" aria-label="Condition" data-testid={`flt-cond-${idx}-name`} value={c.name} onChange={(e) => onChange(cond(e.target.value))}>
        {/* a condition this editor does not offer (team, calendar, a migrated rule) keeps its own name */}
        {(names.includes(c.name) ? names : [c.name, ...names]).map((n) => (
          <option key={n} value={n}>{COND_LABEL[n] ?? n}</option>
        ))}
      </select>
      <ValuePicker c={c} onChange={(values) => onChange({ ...c, values })} testId={`flt-cond-${idx}-values`} />
      {onRemove && (
        <button className="icon-btn xs" aria-label="Remove condition" onClick={onRemove}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** Advanced tab: nested groups joined by AND or OR, each can be negated (FILT-011, FILT-012). */
function GroupEditor({ g, onChange, onRemove, depth, idx }: { g: BGroup; onChange: (g: BGroup) => void; onRemove?: () => void; depth: number; idx: string }): JSX.Element {
  const set = (i: number, it: BCond | BGroup): void => onChange({ ...g, items: g.items.map((x, k) => (k === i ? it : x)) });
  const del = (i: number): void => onChange({ ...g, items: g.items.filter((_, k) => k !== i) });
  return (
    <div className={`flt-group d${depth}${g.not ? " not" : ""}`} data-testid={`flt-group-${idx}`}>
      <div className="flt-group-head">
        <div className="seg small flt-op">
          <button className={g.op === "and" ? "on" : ""} data-testid={`flt-group-${idx}-and`} onClick={() => onChange({ ...g, op: "and" })}>AND</button>
          <button className={g.op === "or" ? "on" : ""} data-testid={`flt-group-${idx}-or`} onClick={() => onChange({ ...g, op: "or" })}>OR</button>
        </div>
        <label className="check-row inline small">
          <input type="checkbox" checked={!!g.not} data-testid={`flt-group-${idx}-not`} onChange={(e) => onChange({ ...g, not: e.target.checked })} /> NOT
        </label>
        <span className="muted small">{g.not ? "none of these" : g.op === "and" ? "all of these" : "any of these"}</span>
        <span className="grow" />
        {onRemove && (
          <button className="icon-btn xs" aria-label="Remove group" onClick={onRemove}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {g.items.map((it, i) => (
        <div key={i} className="flt-item">
          {i > 0 && <span className="flt-join">{g.op.toUpperCase()}</span>}
          {it.kind === "cond" ? (
            <CondRow c={it} names={ADVANCED_CONDS} idx={`${idx}-${i}`} onChange={(c) => set(i, c)} onRemove={() => del(i)} />
          ) : (
            <GroupEditor g={it} depth={depth + 1} idx={`${idx}-${i}`} onChange={(x) => set(i, x)} onRemove={() => del(i)} />
          )}
        </div>
      ))}
      <div className="row gap-s">
        <button className="btn sm" data-testid={`flt-group-${idx}-add`} onClick={() => onChange({ ...g, items: [...g.items, cond("priority")] })}>
          <Plus size={13} /> Condition
        </button>
        {depth < 3 && (
          <button className="btn sm" data-testid={`flt-group-${idx}-addgroup`} onClick={() => onChange({ ...g, items: [...g.items, { ...emptyGroup(g.op === "and" ? "or" : "and"), items: [cond("tag")] }] })}>
            <Plus size={13} /> Group
          </button>
        )}
      </div>
    </div>
  );
}

function PreviewPane({ rule }: { rule: string }): JSX.Element {
  const app = useApp();
  const rows = useMemo(() => {
    const projectGroup: Record<string, string | null | undefined> = {};
    for (const p of app.projects) projectGroup[p.id] = p.groupId;
    const hit = filterMatches(rule, app.tasks, { now: app.now, projectGroup, weekStart: weekStartIndex(app.settings.startDayOfWeek) });
    const order = new Map<string, number>([[app.inboxId, -Infinity], ...app.projects.map((p) => [p.id, p.sortOrder] as [string, number])]);
    return previewSort(hit, (id) => order.get(id) ?? 0);
  }, [rule, app.tasks, app.projects, app.now, app.inboxId, app.settings.startDayOfWeek]);
  return (
    <div className="flt-preview" data-testid="filter-preview">
      <div className="flt-preview-head">
        Preview <span className="muted" data-testid="filter-preview-count">{rows.length} {rows.length === 1 ? "task" : "tasks"}</span>
      </div>
      <div className="flt-preview-list">
        {rows.length === 0 && <div className="muted small pad">No tasks match yet</div>}
        {rows.slice(0, 200).map((t: Task) => (
          <div key={t.id} className="flt-preview-row" data-testid="filter-preview-row">
            <PriorityFlag value={t.priority ?? 0} size={13} />
            <span className="grow ellipsis">{t.title || "Untitled"}</span>
            <span className="muted small ellipsis">{app.projectName(t.projectId)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Add or edit a custom filter (FILT-003): Normal and Advanced tabs, name, live preview, Cancel and Save. */
export function FilterEditor({ filterId, rule: initialRule, name: initialName }: { filterId?: string; rule?: string; name?: string }): JSX.Element {
  const app = useApp();
  const existing = filterId ? app.filters.find((f) => f.id === filterId) : undefined;
  const [name, setName] = useState(existing?.name ?? initialName ?? "");
  const [tree, setTree] = useState<BGroup>(() => {
    const g = ruleToBuilder(existing?.rule ?? initialRule ?? "");
    return g.items.length ? g : { ...g, items: [cond("listOrGroup"), cond("dueDate"), cond("priority")] };
  });
  const [tab, setTab] = useState<"normal" | "advanced">(isNormal(tree) ? "normal" : "advanced");
  const rule = builderToRule(tree);
  const setModal = app.setModal;
  const close = useCallback((): void => setModal(null), [setModal]);
  const save = async (): Promise<void> => {
    const n = name.trim() || describeRule(tree, (c, v) => valueLabel(app, c, v)).slice(0, 40) || "Filter";
    if (existing) {
      await app.repo.updateFilter(existing.id, { name: n, rule });
      close();
    } else {
      const f = await app.repo.createFilter(n, rule);
      close();
      go(`f/${f.id}/tasks`);
    }
  };
  const normal = isNormal(tree);
  const normalItems = tree.items as BCond[];
  const used = new Set(normalItems.map((c) => c.name));
  return (
    <Modal onClose={close} wide className="flt-modal" testId="filter-editor">
      <div className="flt-layout">
        <div className="flt-main">
          <h3>{existing ? "Edit Filter" : "Add Filter"}</h3>
          <input className="field full" placeholder="Name" data-testid="filter-name" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
          <div className="seg flt-tabs" role="tablist">
            <button role="tab" className={tab === "normal" ? "on" : ""} data-testid="filter-tab-normal" onClick={() => setTab("normal")}>Normal</button>
            <button role="tab" className={tab === "advanced" ? "on" : ""} data-testid="filter-tab-advanced" onClick={() => setTab("advanced")}>Advanced</button>
          </div>
          {tab === "normal" && !normal && (
            <div className="banner small">
              This filter uses grouped AND, OR or NOT logic. Edit it in Advanced, or
              <button className="link-btn" onClick={() => setTree({ kind: "group", op: "and", items: tree.items.flatMap((i) => (i.kind === "cond" ? [i] : [])) })}>keep only the top-level conditions</button>.
            </div>
          )}
          {tab === "normal" && normal && (
            <div className="flt-normal" data-testid="filter-normal">
              {normalItems.map((c, i) => (
                <CondRow
                  key={i}
                  c={c}
                  idx={`n${i}`}
                  names={NORMAL_CONDS.filter((n) => n === c.name || !used.has(n))}
                  onChange={(x) => setTree({ ...tree, items: normalItems.map((y, k) => (k === i ? x : y)) })}
                  onRemove={() => setTree({ ...tree, items: normalItems.filter((_, k) => k !== i) })}
                />
              ))}
              {NORMAL_CONDS.some((n) => !used.has(n)) && (
                <button className="btn sm" data-testid="filter-add-cond" onClick={() => setTree({ ...tree, items: [...normalItems, cond(NORMAL_CONDS.find((n) => !used.has(n))!)] })}>
                  <Plus size={13} /> Add condition
                </button>
              )}
              <div className="muted small">Conditions are joined with AND; the values of one condition with OR.</div>
            </div>
          )}
          {tab === "advanced" && <GroupEditor g={tree} depth={0} idx="r" onChange={setTree} />}
          <div className="flt-rule muted small" data-testid="filter-rule-text">{describeRule(tree, (c, v) => valueLabel(app, c, v)) || "Every open task"}</div>
          <div className="row gap end">
            <button className="btn" onClick={close}>Cancel</button>
            <button className="btn primary" data-testid="filter-save" onClick={() => void save()}>Save</button>
          </div>
        </div>
        <PreviewPane rule={rule} />
      </div>
    </Modal>
  );
}
