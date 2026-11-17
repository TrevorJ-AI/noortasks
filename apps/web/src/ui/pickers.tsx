import { Hash, Inbox, List as ListIcon, Search } from "lucide-react";
import { useState } from "react";
import { cleanTagName } from "../data/repo";
import { useApp } from "./ctx";
import { Menu, Popover, PRIORITIES, PriorityFlag, type Anchor } from "./primitives";

/** Tag popover: "Type in a tag" field, checkable list of all tags, Cancel / OK. Typing a new name creates it on OK or Enter. */
export function TagPicker({ anchor, value, onChange, onClose }: { anchor: Anchor; value: string[]; onChange: (v: string[]) => void; onClose: () => void }): JSX.Element {
  const { tags, repo } = useApp();
  const [sel, setSel] = useState<Set<string>>(new Set(value.map((v) => v.toLowerCase())));
  const [q, setQ] = useState("");
  const clean = cleanTagName(q);
  const shown = tags.filter((t) => (t.label ?? t.name).toLowerCase().includes(q.toLowerCase())).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const isNew = !!clean && !tags.some((t) => t.name === clean.toLowerCase());
  const ok = async (): Promise<void> => {
    const out = new Set(sel);
    if (isNew) {
      await repo.createTag(clean);
      out.add(clean.toLowerCase());
    }
    onChange([...out]);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} className="tag-picker" testId="tag-picker">
      <div className="search-field">
        <Search size={14} />
        <input
          autoFocus
          placeholder="Type in a tag"
          value={q}
          data-testid="tag-picker-input"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void ok();
            }
          }}
        />
      </div>
      <div className="tag-list">
        {isNew && (
          <button className="menu-item" onClick={() => void ok()}>
            <Hash size={14} /> <span className="menu-label">Create &quot;{clean}&quot;</span>
          </button>
        )}
        {shown.map((t) => (
          <label key={t.name} className="check-row">
            <input
              type="checkbox"
              checked={sel.has(t.name)}
              onChange={() =>
                setSel((s) => {
                  const n = new Set(s);
                  if (n.has(t.name)) n.delete(t.name);
                  else n.add(t.name);
                  return n;
                })
              }
            />
            <Hash size={13} color={t.color ?? undefined} />
            {t.label ?? t.name}
          </label>
        ))}
        {!shown.length && !isNew && <div className="empty-note">No tags</div>}
      </div>
      <div className="row gap end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" data-testid="tag-picker-ok" onClick={() => void ok()}>OK</button>
      </div>
    </Popover>
  );
}

/** Inbox first, then every open list; folders are headings, not targets (LIST-043). */
export function ListPicker({ anchor, value, onPick, onClose }: { anchor: Anchor; value?: string; onPick: (id: string) => void; onClose: () => void }): JSX.Element {
  const { projects, groups, inboxId } = useApp();
  const [q, setQ] = useState("");
  const open = projects.filter((p) => !p.closed && p.name.toLowerCase().includes(q.toLowerCase()));
  const loose = open.filter((p) => !p.groupId || !groups.some((g) => g.id === p.groupId)).sort((a, b) => a.sortOrder - b.sortOrder);
  return (
    <Popover anchor={anchor} onClose={onClose} className="list-picker" testId="list-picker">
      <div className="search-field">
        <Search size={14} />
        <input autoFocus placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="menu">
        {"inbox".includes(q.toLowerCase()) && (
          <button className={`menu-item${value === inboxId ? " on" : ""}`} onClick={() => (onPick(inboxId), onClose())}>
            <span className="menu-icon"><Inbox size={14} /></span>
            <span className="menu-label">Inbox</span>
          </button>
        )}
        {loose.map((p) => (
          <button key={p.id} className={`menu-item${value === p.id ? " on" : ""}`} onClick={() => (onPick(p.id), onClose())}>
            <span className="menu-icon"><ListIcon size={14} color={p.color ?? undefined} /></span>
            <span className="menu-label">{p.name}</span>
          </button>
        ))}
        {[...groups].sort((a, b) => a.sortOrder - b.sortOrder).map((g) => {
          const kids = open.filter((p) => p.groupId === g.id).sort((a, b) => a.sortOrder - b.sortOrder);
          if (!kids.length) return null;
          return (
            <div key={g.id}>
              <div className="menu-heading">{g.name}</div>
              {kids.map((p) => (
                <button key={p.id} className={`menu-item indent${value === p.id ? " on" : ""}`} onClick={() => (onPick(p.id), onClose())}>
                  <span className="menu-icon"><ListIcon size={14} color={p.color ?? undefined} /></span>
                  <span className="menu-label">{p.name}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </Popover>
  );
}

export function PriorityMenu({ anchor, value, onPick, onClose }: { anchor: Anchor; value: number; onPick: (v: 0 | 1 | 3 | 5) => void; onClose: () => void }): JSX.Element {
  return (
    <Popover anchor={anchor} onClose={onClose} placement="bottom-end" testId="priority-menu">
      <Menu
        onClose={onClose}
        items={PRIORITIES.map((p) => ({ label: p.label, icon: <PriorityFlag value={p.value} />, checked: value === p.value, onClick: () => onPick(p.value), testId: `priority-${p.label.toLowerCase()}` }))}
      />
    </Popover>
  );
}
