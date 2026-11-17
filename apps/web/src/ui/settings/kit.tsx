import { Check, ChevronRight, ChevronsUpDown, CircleHelp, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Popover, Select, anchorOf, type Anchor } from "../primitives";

/** Small pane title at the top of a tab (the tabs that have one). */
export function SetTitle({ children }: { children: ReactNode }): JSX.Element {
  return <h3 className="st-title">{children}</h3>;
}

/** Heading above a group of cards, with an optional help mark (hover text). */
export function SetSection({ title, help, children, testId }: { title: ReactNode; help?: string; children?: ReactNode; testId?: string }): JSX.Element {
  return (
    <div className="st-section" data-testid={testId}>
      <h4>
        {title}
        {help && (
          <span className="st-help" title={help} aria-label={help}>
            <CircleHelp size={13} />
          </span>
        )}
      </h4>
      {children && <div className="st-section-note">{children}</div>}
    </div>
  );
}

/** A rounded group of rows. */
export function Card({ children, className = "", testId }: { children: ReactNode; className?: string; testId?: string }): JSX.Element {
  return (
    <div className={`st-card ${className}`} data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * One settings row: label (and helper text under it) on the left, the control on the right.
 * Keeps the `.set-row`, `.set-label`, `.set-control` classes the other settings panels and tests rely on.
 */
export function Row({ label, hint, icon, children, testId, className = "" }: { label: ReactNode; hint?: ReactNode; icon?: ReactNode; children?: ReactNode; testId?: string; className?: string }): JSX.Element {
  return (
    <div className={`set-row${hint ? " has-hint" : ""}${icon ? " has-icon" : ""} ${className}`} data-testid={testId}>
      {icon && <span className="set-icon">{icon}</span>}
      <div className="set-label">
        <span>{label}</span>
        {hint && <span className="muted small">{hint}</span>}
      </div>
      {children !== undefined && <div className="set-control">{children}</div>}
    </div>
  );
}

/** Row contract other panels receive as a prop. */
export type RowC = (p: { label: string; children: ReactNode; hint?: string }) => JSX.Element;

/** Value dropdown in the settings style: grey value text plus an up/down mark. */
export function Drop<T extends string | number>(p: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; testId?: string }): JSX.Element {
  return <Select {...p} compact />;
}

/** Text action at the right of a row (accent, or red for destructive). */
export function LinkBtn({ children, onClick, danger, testId, disabled, title }: { children: ReactNode; onClick: () => void; danger?: boolean; testId?: string; disabled?: boolean; title?: string }): JSX.Element {
  return (
    <button className={`set-link${danger ? " danger" : ""}`} onClick={onClick} data-testid={testId} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/** Value plus a chevron that opens a dialog (Interface Style, Follow System Dark Mode). */
export function NavValue({ children, onClick, testId }: { children: ReactNode; onClick: () => void; testId?: string }): JSX.Element {
  return (
    <button className="set-navvalue" onClick={onClick} data-testid={testId}>
      <span>{children}</span>
      <ChevronRight size={13} />
    </button>
  );
}

/** Checkbox line inside a card (sub-option of a toggle). */
export function CheckLine({ label, checked, onChange, testId }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; testId?: string }): JSX.Element {
  return (
    <label className="st-check">
      <input type="checkbox" checked={checked} data-testid={testId} onChange={(e) => onChange(e.target.checked)} />
      <span className="st-box" aria-hidden>{checked && <Check size={11} strokeWidth={3} />}</span>
      <span>{label}</span>
    </label>
  );
}

/** The round check badge on a selected picker card. */
export function PickBadge(): JSX.Element {
  return (
    <span className="pick-badge" aria-hidden>
      <Check size={11} strokeWidth={3} />
    </span>
  );
}

/** Row of preview cards with a caption under each; the chosen one carries the check badge. */
export function Picker<T extends string>({ value, options, onChange, testId, cols }: { value: T; options: Array<{ value: T; label: string; preview: ReactNode }>; onChange: (v: T) => void; testId?: string; cols?: number }): JSX.Element {
  return (
    <div className="pick-row" role="radiogroup" data-testid={testId} style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={`pick-card${value === o.value ? " on" : ""}`} data-testid={testId ? `${testId}-${o.value}` : undefined} onClick={() => onChange(o.value)}>
          <span className="pick-preview">
            {o.preview}
            {value === o.value && <PickBadge />}
          </span>
          <span className="pick-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Small dialog on top of Settings. Escape closes only this dialog: the listener sits on window in the capture
 * phase, which runs before the Settings modal's own document listener.
 */
export function StDialog({ title, sub, onClose, children, testId }: { title: string; sub?: string; onClose: () => void; children: ReactNode; testId?: string }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || document.querySelector(".popover")) return;
      e.stopImmediatePropagation();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop st-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal st-dialog" role="dialog" aria-label={title} data-testid={testId}>
        <div className="st-dialog-head">
          <h3>{title}</h3>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {sub && <p className="st-dialog-sub">{sub}</p>}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Multi-choice dropdown (default reminders, default tags): tick several options, then OK. Cancel or a click
 * outside keeps the stored value.
 */
export function MultiDrop({ value, options: base, onChange, testId, empty = "None", search, labelOf }: { value: string[]; options: Array<{ value: string; label: string }>; onChange: (v: string[]) => void; testId?: string; empty?: string; search?: boolean; labelOf?: (v: string) => string }): JSX.Element {
  // stored values that are not in the list (custom reminders, removed tags) stay listed and are kept on OK
  const options = [...base, ...value.filter((v) => !base.some((o) => o.value === v)).map((v) => ({ value: v, label: labelOf ? labelOf(v) : v }))];
  const [a, setA] = useState<Anchor | null>(null);
  const [draft, setDraft] = useState<string[]>(value);
  const [q, setQ] = useState("");
  const label = value.length === 0 ? empty : value.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ");
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <>
      <button className={`select compact${a ? " open" : ""}`} data-testid={testId} title={label} onClick={(e) => (setDraft(value), setQ(""), setA(anchorOf(e.currentTarget)))}>
        <span className="drop-text">{label}</span>
        <ChevronsUpDown size={12} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" className="set-pop multi-pop" testId={testId ? `${testId}-pop` : undefined}>
          {search && (
            <input className="field pop-search" placeholder="Search" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
          )}
          <div className="menu" role="menu">
            {shown.length === 0 && <div className="empty-note">Nothing here yet</div>}
            {shown.map((o) => {
              const on = draft.includes(o.value);
              return (
                <button key={o.value} role="menuitemcheckbox" aria-checked={on} className={`menu-item${on ? " on" : ""}`} onClick={() => setDraft(on ? draft.filter((x) => x !== o.value) : [...draft, o.value])}>
                  <span className="menu-label">{o.label}</span>
                  {on && <Check size={14} className="menu-check" />}
                </button>
              );
            })}
          </div>
          <div className="pop-actions">
            <button className="btn sm" onClick={() => setA(null)}>Cancel</button>
            <button className="btn sm primary" data-testid={testId ? `${testId}-ok` : undefined} onClick={() => (onChange(options.map((o) => o.value).filter((v) => draft.includes(v))), setA(null))}>OK</button>
          </div>
        </Popover>
      )}
    </>
  );
}

/** Single choice with a search box on top (Default List). */
export function SearchDrop({ value, options, onChange, testId }: { value: string; options: Array<{ value: string; label: string }>; onChange: (v: string) => void; testId?: string }): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  const [q, setQ] = useState("");
  const cur = options.find((o) => o.value === value);
  const shown = q ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;
  return (
    <>
      <button className={`select compact${a ? " open" : ""}`} data-testid={testId} onClick={(e) => (setQ(""), setA(anchorOf(e.currentTarget)))}>
        <span className="drop-text">{cur?.label ?? value}</span>
        <ChevronsUpDown size={12} />
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" className="set-pop search-pop">
          <input className="field pop-search" placeholder="Search" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />
          <div className="menu" role="menu">
            {shown.length === 0 && <div className="empty-note">No list matches</div>}
            {shown.map((o) => (
              <button key={o.value} role="menuitem" className={`menu-item${o.value === value ? " on" : ""}`} onClick={() => (onChange(o.value), setA(null))}>
                <span className="menu-label">{o.label}</span>
                {o.value === value && <Check size={14} className="menu-check" />}
              </button>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
