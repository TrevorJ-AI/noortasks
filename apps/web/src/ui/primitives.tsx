import { Check, ChevronRight, ChevronsUpDown, Flag } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const PRIORITY_COLOR: Record<number, string> = { 5: "var(--p-high)", 3: "var(--p-med)", 1: "var(--p-low)", 0: "var(--text-3)" };
export const PRIORITIES: Array<{ value: 0 | 1 | 3 | 5; label: string }> = [
  { value: 5, label: "High" },
  { value: 3, label: "Medium" },
  { value: 1, label: "Low" },
  { value: 0, label: "None" },
];

export type Anchor = DOMRect | { left: number; top: number; bottom: number; right: number; width: number; height: number };

export function anchorOf(el: Element | null | undefined): Anchor {
  return el ? el.getBoundingClientRect() : { left: 200, top: 200, bottom: 200, right: 200, width: 0, height: 0 };
}

/** Positioned layer in a portal: below the anchor, flipped and clamped to the viewport. Esc / outside click close it. */
export function Popover({
  anchor,
  onClose,
  children,
  placement = "bottom-start",
  className = "",
  testId,
}: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  placement?: "bottom-start" | "bottom-end" | "right-start";
  className?: string;
  testId?: string;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = placement === "bottom-end" ? anchor.right - r.width : placement === "right-start" ? anchor.right + 4 : anchor.left;
    let top = placement === "right-start" ? anchor.top - 6 : anchor.bottom + 4;
    if (placement === "right-start" && left + r.width > vw - 8) left = anchor.left - r.width - 4;
    if (top + r.height > vh - 8) top = Math.max(8, placement === "right-start" ? vh - r.height - 8 : anchor.top - r.height - 4);
    left = Math.max(8, Math.min(left, vw - r.width - 8));
    top = Math.max(8, top);
    setStyle({ left, top });
  }, [anchor, placement]);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      // clicks inside a nested popover (later in the DOM) do not close this one
      const layers = Array.from(document.querySelectorAll(".popover"));
      const mine = layers.indexOf(ref.current!);
      if (layers.slice(mine + 1).some((l) => l.contains(t))) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        const layers = Array.from(document.querySelectorAll(".popover"));
        if (layers[layers.length - 1] === ref.current) {
          e.stopPropagation();
          onClose();
        }
      }
    };
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={style} data-testid={testId} onMouseDown={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  submenu?: () => ReactNode;
  hint?: string;
  divider?: boolean;
  testId?: string;
}

export function Menu({ items, onClose }: { items: MenuItem[]; onClose: () => void }): JSX.Element {
  const [sub, setSub] = useState<{ i: number; anchor: Anchor } | null>(null);
  return (
    <div className="menu" role="menu">
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} className="menu-divider" />
        ) : (
          <button
            key={i}
            role="menuitem"
            data-testid={it.testId}
            className={`menu-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}`}
            disabled={it.disabled}
            onMouseEnter={(e) => (it.submenu ? setSub({ i, anchor: anchorOf(e.currentTarget) }) : setSub(null))}
            onClick={(e) => {
              if (it.submenu) {
                setSub({ i, anchor: anchorOf(e.currentTarget) });
                return;
              }
              it.onClick?.();
              onClose();
            }}
          >
            <span className="menu-icon">{it.icon}</span>
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
            {it.checked && <Check size={14} className="menu-check" />}
            {it.submenu && <ChevronRight size={14} className="menu-arrow" />}
          </button>
        ),
      )}
      {sub && items[sub.i]?.submenu && (
        <Popover anchor={sub.anchor} placement="right-start" onClose={() => setSub(null)}>
          {items[sub.i]!.submenu!()}
        </Popover>
      )}
    </div>
  );
}

/** Menu opened from a button: renders the trigger and the popover. */
export function MenuButton({
  children,
  items,
  className = "icon-btn",
  title,
  placement,
  testId,
}: {
  children: ReactNode;
  items: () => MenuItem[];
  className?: string;
  title?: string;
  placement?: "bottom-start" | "bottom-end";
  testId?: string;
}): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  return (
    <>
      <button className={className} title={title} aria-label={title} data-testid={testId} onClick={(e) => setA(anchorOf(e.currentTarget))}>
        {children}
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement={placement}>
          <Menu items={items()} onClose={() => setA(null)} />
        </Popover>
      )}
    </>
  );
}

export function PriorityFlag({ value, size = 16 }: { value: number; size?: number }): JSX.Element {
  return <Flag size={size} color={PRIORITY_COLOR[value] ?? PRIORITY_COLOR[0]} fill={value ? PRIORITY_COLOR[value] : "none"} />;
}

export function Checkbox({
  checked,
  priority = 0,
  onChange,
  kind,
  wontDo,
  testId,
}: {
  checked: boolean;
  priority?: number;
  onChange: () => void;
  kind?: string;
  wontDo?: boolean;
  testId?: string;
}): JSX.Element {
  if (kind === "NOTE") return <span className="checkbox note-mark" aria-hidden />;
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      data-testid={testId}
      className={`checkbox${checked ? " checked" : ""}${wontDo ? " wontdo" : ""} pr-${priority}`}
      style={{ borderColor: checked ? undefined : PRIORITY_COLOR[priority] }}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
    >
      {checked && !wontDo && <Check size={11} strokeWidth={3} />}
      {wontDo && <span className="x">x</span>}
    </button>
  );
}

export function Switch({ checked, onChange, testId }: { checked: boolean; onChange: (v: boolean) => void; testId?: string }): JSX.Element {
  return <button role="switch" aria-checked={checked} data-testid={testId} className={`switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)} />;
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  testId,
  compact,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  testId?: string;
  /** settings style: plain value text with an up/down mark, no box */
  compact?: boolean;
}): JSX.Element {
  const [a, setA] = useState<Anchor | null>(null);
  const cur = options.find((o) => o.value === value);
  return (
    <>
      <button className={`select${compact ? " compact" : ""}${a ? " open" : ""}`} data-testid={testId} onClick={(e) => setA(anchorOf(e.currentTarget))}>
        <span>{cur?.label ?? String(value)}</span>
        {compact ? <ChevronsUpDown size={12} /> : <ChevronRight size={14} style={{ transform: "rotate(90deg)" }} />}
      </button>
      {a && (
        <Popover anchor={a} onClose={() => setA(null)} placement="bottom-end" className={compact ? "set-pop" : ""}>
          <Menu items={options.map((o) => ({ label: o.label, checked: o.value === value, onClick: () => onChange(o.value) }))} onClose={() => setA(null)} />
        </Popover>
      )}
    </>
  );
}

export function Modal({ onClose, children, className = "", testId, wide }: { onClose: () => void; children: ReactNode; className?: string; testId?: string; wide?: boolean }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !document.querySelector(".popover")) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""} ${className}`} role="dialog" data-testid={testId}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Colour swatches used by list, tag and folder dialogs: none, 7 presets (own palette), custom wheel. */
export const LIST_COLORS = ["#e5484d", "#f08c2e", "#e2b714", "#3fa66b", "#2f8fbf", "#5b6ee1", "#a35bd6"];
export function ColorSwatches({ value, onChange }: { value: string | null | undefined; onChange: (c: string | null) => void }): JSX.Element {
  return (
    <div className="swatches">
      <button className={`swatch none${!value ? " on" : ""}`} title="No color" onClick={() => onChange(null)} />
      {LIST_COLORS.map((c) => (
        <button key={c} className={`swatch${value === c ? " on" : ""}`} style={{ background: c }} title={c} onClick={() => onChange(c)} />
      ))}
      <label className={`swatch custom${value && !LIST_COLORS.includes(value) ? " on" : ""}`} title="Custom color">
        <input type="color" value={value ?? "#888888"} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
