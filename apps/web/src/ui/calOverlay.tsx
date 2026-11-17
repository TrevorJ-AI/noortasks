import { useMemo } from "react";
import { CountdownType, HabitStatus } from "../lib/core";
import { addDays } from "../lib/dates";
import { localMsToStamp, recordActiveMs, toMs } from "../lib/m4core";
import { countdownStampsInRange } from "../model/countdown";
import { isDone } from "../model/habits";
import { useApp } from "./ctx";
import { countdownOn, habitOn, pomoOn, useM4 } from "./m4ctx";

/**
 * Calendar overlays (CAL-033, CAL-034, HAB-006, FOC-030, CNT-022): habit check-ins, focus records and countdown
 * dates drawn on the grids, each behind its calendar option and its feature switch. They are read-only marks.
 */
export interface DayMark {
  key: string;
  kind: "habit" | "focus" | "countdown";
  label: string;
  color: string;
}
export interface FocusBlock {
  key: string;
  start: number;
  end: number;
  label: string;
}
export interface Overlay {
  marks: (dayMs: number) => DayMark[];
  blocks: (dayMs: number) => FocusBlock[];
}

const ORDER = { countdown: 0, focus: 1, habit: 2 } as const;

export function useCalOverlay(from: number, to: number, conf: { showHabit: boolean; showFocusRecord: boolean; showCountdown: boolean }): Overlay {
  const app = useApp();
  const m = useM4();
  const showH = conf.showHabit && habitOn(app) && m.habitPrefs.showInCalendar !== false;
  const showF = conf.showFocusRecord && pomoOn(app);
  const showC = conf.showCountdown && countdownOn(app);
  return useMemo(() => {
    const byDay = new Map<number, DayMark[]>();
    const blocks = new Map<number, FocusBlock[]>();
    const add = (stamp: number, mk: DayMark): void => {
      byDay.set(stamp, [...(byDay.get(stamp) ?? []), mk]);
    };
    const fromS = localMsToStamp(from);
    const toS = localMsToStamp(addDays(to, -1));
    if (showH) {
      for (const c of m.checkins) {
        if (!isDone(c) || c.checkinStamp < fromS || c.checkinStamp > toS) continue;
        const h = m.habits.find((x) => x.id === c.habitId);
        if (!h || h.status === HabitStatus.Archived) continue;
        add(c.checkinStamp, { key: `h${c.id}`, kind: "habit", label: h.name, color: h.color || "var(--accent)" });
      }
    }
    if (showC) {
      for (const c of m.countdowns) {
        for (const s of countdownStampsInRange(c, fromS, toS)) add(s, { key: `c${c.id}${s}`, kind: "countdown", label: c.type === CountdownType.Birthday ? `${c.name} (birthday)` : c.name, color: c.color || "var(--p-med)" });
      }
    }
    if (showF) {
      const sums = new Map<number, number>();
      for (const r of m.pomos) {
        const s = toMs(r.startTime);
        const e = toMs(r.endTime);
        if (!(e > from && s < to)) continue;
        const day = localMsToStamp(s);
        sums.set(day, (sums.get(day) ?? 0) + recordActiveMs(r) / 60000);
        const title = (r.tasks ?? [])[0]?.title ?? "Focus";
        const d0 = new Date(s);
        d0.setHours(0, 0, 0, 0);
        const k = d0.getTime();
        blocks.set(k, [...(blocks.get(k) ?? []), { key: r.id, start: s, end: e, label: title }]);
      }
      for (const [day, min] of sums) add(day, { key: `f${day}`, kind: "focus", label: `Focus ${Math.round(min)}m`, color: "var(--text-3)" });
    }
    return {
      marks: (d) => [...(byDay.get(localMsToStamp(d)) ?? [])].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]),
      blocks: (d) => blocks.get(d) ?? [],
    };
  }, [from, to, showH, showF, showC, m.checkins, m.habits, m.countdowns, m.pomos]);
}

export function DayMarks({ marks, max = 3 }: { marks: DayMark[]; max?: number }): JSX.Element | null {
  if (!marks.length) return null;
  const shown = marks.slice(0, max);
  return (
    <div className="cal-marks" data-testid="cal-marks">
      {shown.map((mk) => (
        <span key={mk.key} className={`cal-mark ${mk.kind}`} data-testid={`cal-mark-${mk.kind}`} title={mk.label} style={{ "--mc": mk.color } as React.CSSProperties}>
          <i />
          <span>{mk.label}</span>
        </span>
      ))}
      {marks.length > max && <span className="cal-mark more">+{marks.length - max}</span>}
    </div>
  );
}
