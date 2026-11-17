import { Apple, BedDouble, Bike, BookOpen, Check, CircleCheck, Code, Dumbbell, Flower2, Footprints, GlassWater, HandHeart, Heart, Languages, Leaf, Moon, Music, PenLine, PiggyBank, Plus, Smartphone, Sun } from "lucide-react";
import { useState } from "react";
import type { Habit } from "../data/m4types";
import { CheckinStatus } from "../lib/core";
import { todayStamp } from "../lib/m4core";
import { badgeText, iconKeyOf, isDone, isReal, type IconKey } from "../model/habits";
import { useApp } from "./ctx";
import { useM4 } from "./m4ctx";
import { Menu, Popover, anchorOf, type Anchor } from "./primitives";
import { inkOn } from "./theme";

const ICONS: Record<IconKey, (p: { size: number }) => JSX.Element> = {
  check: (p) => <CircleCheck {...p} />,
  water: (p) => <GlassWater {...p} />,
  run: (p) => <Footprints {...p} />,
  book: (p) => <BookOpen {...p} />,
  meditate: (p) => <Flower2 {...p} />,
  sleep: (p) => <BedDouble {...p} />,
  food: (p) => <Apple {...p} />,
  dumbbell: (p) => <Dumbbell {...p} />,
  pen: (p) => <PenLine {...p} />,
  music: (p) => <Music {...p} />,
  code: (p) => <Code {...p} />,
  sun: (p) => <Sun {...p} />,
  moon: (p) => <Moon {...p} />,
  heart: (p) => <Heart {...p} />,
  leaf: (p) => <Leaf {...p} />,
  bike: (p) => <Bike {...p} />,
  language: (p) => <Languages {...p} />,
  pray: (p) => <HandHeart {...p} />,
  money: (p) => <PiggyBank {...p} />,
  phone: (p) => <Smartphone {...p} />,
};

export function IconGlyph({ k, size }: { k: IconKey; size: number }): JSX.Element {
  return ICONS[k]({ size });
}

/** Habit icon: drawn preset, emoji or text badge on the habit colour (HAB-021). */
export function HabitIcon({ habit, size = "md", onClick, testId }: { habit: Pick<Habit, "iconRes" | "color" | "name">; size?: "sm" | "md" | "lg"; onClick?: (e: React.MouseEvent) => void; testId?: string }): JSX.Element {
  const k = iconKeyOf(habit.iconRes);
  const badge = badgeText(habit.iconRes);
  const px = size === "lg" ? 26 : size === "sm" ? 15 : 18;
  const cls = `m4-icon-badge${size === "md" ? "" : ` ${size}`}`;
  const body = k ? <IconGlyph k={k} size={px} /> : <span className={badge && /\p{Extended_Pictographic}/u.test(badge) ? "emoji" : ""}>{badge}</span>;
  const style = { background: habit.color || "var(--accent)", "--ink": inkOn(habit.color) } as React.CSSProperties;
  return onClick ? (
    <button className={`${cls} clickable`} style={style} onClick={onClick} aria-label={`Check in ${habit.name}`} data-testid={testId}>
      {body}
    </button>
  ) : (
    <span className={cls} style={style}>
      {body}
    </span>
  );
}

/**
 * One tap check-in (HAB-014): a yes/no habit toggles done; an amount habit adds one step per tap and is done at the
 * goal. The menu has Achieve it all, Undo and Skip. After a check-in that completes the day, the log popup opens when
 * the habit has it on (HAB-801).
 */
export function useCheck(): { tap: (h: Habit, stamp: number) => Promise<void>; achieve: (h: Habit, stamp: number) => Promise<void>; clear: (h: Habit, stamp: number) => Promise<void> } {
  const { m4 } = useM4();
  const openLog = (h: Habit, stamp: number): void => {
    if (h.recordEnable) window.dispatchEvent(new CustomEvent("noor-habit-log", { detail: { habitId: h.id, stamp } }));
  };
  return {
    tap: async (h, stamp) => {
      const c = await m4.checkinOf(h.id, stamp);
      if (isReal(h)) {
        if (isDone(c)) {
          await m4.setCheckin(h, stamp, { value: 0, status: CheckinStatus.Unlabeled });
          return;
        }
        const next = (c?.value ?? 0) + (h.step || 1);
        const row = await m4.setCheckin(h, stamp, { value: next });
        if (isDone(row)) openLog(h, stamp);
        return;
      }
      if (isDone(c)) await m4.setCheckin(h, stamp, { status: CheckinStatus.Undone });
      else {
        await m4.setCheckin(h, stamp, { status: CheckinStatus.Done });
        openLog(h, stamp);
      }
    },
    achieve: async (h, stamp) => {
      await m4.setCheckin(h, stamp, isReal(h) ? { value: Math.max(h.goal ?? 1, 1) } : { status: CheckinStatus.Done });
      openLog(h, stamp);
    },
    clear: async (h, stamp) => {
      const c = await m4.checkinOf(h.id, stamp);
      if (c) await m4.deleteCheckin(c.id);
    },
  };
}

/** The check button of a habit row: a ring that fills with the day's progress. */
export function CheckButton({ habit, stamp, testId }: { habit: Habit; stamp?: number; testId?: string }): JSX.Element {
  const { checkins, tz, m4 } = useM4();
  const { now } = useApp();
  const day = stamp ?? todayStamp(now, tz);
  const c = checkins.find((x) => x.habitId === habit.id && x.checkinStamp === day);
  const done = isDone(c);
  const real = isReal(habit);
  const goal = real ? Math.max(1, habit.goal ?? 1) : 1;
  const value = real ? (c?.value ?? 0) : done ? 1 : 0;
  const frac = Math.min(1, value / goal);
  const check = useCheck();
  const [menu, setMenu] = useState<Anchor | null>(null);
  const r = 13;
  const len = 2 * Math.PI * r;
  const skipped = (habit.exDates ?? []).includes(String(day));
  return (
    <>
      <button
        className={`habit-check${done ? " done" : ""}${skipped ? " skipped" : ""}`}
        style={{ color: habit.color || "var(--accent)", "--ink": inkOn(habit.color) } as React.CSSProperties}
        aria-label={done ? `Undo ${habit.name}` : real ? `Add ${habit.step || 1} ${habit.unit ?? ""} to ${habit.name}` : `Check in ${habit.name}`}
        title={real ? `${value}/${goal} ${habit.unit ?? ""}` : done ? "Done" : "Check in"}
        data-testid={testId ?? "habit-check"}
        data-done={done ? "1" : "0"}
        onClick={(e) => {
          e.stopPropagation();
          void check.tap(habit, day);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu(anchorOf(e.currentTarget));
        }}
      >
        <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
          <circle cx="15" cy="15" r={r} className="ring-bg" />
          {frac > 0 && !done && <circle cx="15" cy="15" r={r} className="ring" strokeDasharray={`${frac * len} ${len}`} transform="rotate(-90 15 15)" />}
          {done && <circle cx="15" cy="15" r={r + 1} className="ring-fill" />}
        </svg>
        <span className="habit-check-glyph">{done ? <Check size={15} strokeWidth={3} /> : real ? (value > 0 ? <span className="habit-check-num">{value}</span> : <Plus size={14} />) : null}</span>
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)} testId="habit-check-menu">
          <Menu
            onClose={() => setMenu(null)}
            items={[
              { label: "Achieve it all", onClick: () => void check.achieve(habit, day) },
              { label: "Clear today", onClick: () => void check.clear(habit, day) },
              { label: skipped ? "Unskip today" : "Skip today", onClick: () => void m4.toggleSkip(habit.id, day) },
              { label: "Add log", onClick: () => window.dispatchEvent(new CustomEvent("noor-habit-log", { detail: { habitId: habit.id, stamp: day, force: true } })) },
            ]}
          />
        </Popover>
      )}
    </>
  );
}
