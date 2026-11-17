import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Minus } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { weekStartIndex } from "../lib/dates";
import { addStampDays, recordActiveMs, stampOf } from "../lib/m4core";
import { go, statisticsPath } from "../model/router";
import {
  BADGE_TRACKS,
  badgeProgress,
  cappedTotal,
  completionSeries,
  focusRange,
  formatMinutes,
  heatLevelMinutes,
  hourLabel,
  levelProgress,
  openDays,
  pct,
  peakHour,
  periodRange,
  rangeLabel,
  scorePoints,
  shiftFocusRange,
  shiftPeriod,
  stampLabel,
  stampWeekday,
  sumBuckets,
  sumTaskRows,
  topEntries,
  trendBuckets,
  yearGrid,
  type BadgeTrack,
  type FocusRange,
  type Period,
  type Point,
  type TaskStatRow,
} from "../model/stats";
import { useApp } from "./ctx";
import { habitOn, pomoOn, useM4 } from "./m4ctx";
import { Select } from "./primitives";

/**
 * Statistics overlay (STAT-001..034): route #statistics[/overview|task|pomo], Done returns to where it was opened.
 * Every number comes from the server's statistics endpoints except the badge tracks, which are counted here from
 * local data (the server has no badge endpoint; STAT-034 artwork is our own).
 */

// the screen the overlay was opened from (Done goes back there)
let prevPath = "";
if (typeof window !== "undefined") {
  const remember = (): void => {
    const h = location.hash.replace(/^#\/?/, "");
    if (h && !h.startsWith("statistics")) prevPath = h;
  };
  remember();
  window.addEventListener("hashchange", remember);
}

type Tab = "overview" | "task" | "pomo";
const SERIES = (i: number): string => `var(--series-${(i % 8) + 1})`;

// ------------------------------------------------------------------ data and chart helpers

interface Fetched<T> {
  data: T | null;
  error: string | null;
}
function useFetch<T>(path: string | null): Fetched<T> {
  const { engine } = useApp();
  const [st, setSt] = useState<Fetched<T>>({ data: null, error: null });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    engine.api.get<T>(path).then(
      (data) => alive && setSt({ data, error: null }),
      (e: unknown) => alive && setSt({ data: null, error: e instanceof Error && e.message.startsWith("http") ? "Could not load" : "Offline" }),
    );
    return () => {
      alive = false;
    };
  }, [path, engine]);
  return st;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

interface TipState {
  x: number;
  y: number;
  text: ReactNode;
}
function useTip(): { tip: JSX.Element | null; show: (e: { clientX: number; clientY: number }, text: ReactNode) => void; hide: () => void } {
  const [t, setT] = useState<TipState | null>(null);
  return {
    tip: t ? createPortal(<div className="chart-tip" style={{ left: Math.min(t.x + 12, window.innerWidth - 180), top: t.y - 34 }}>{t.text}</div>, document.body) : null,
    show: (e, text) => setT({ x: e.clientX, y: e.clientY, text }),
    hide: () => setT(null),
  };
}

const niceMax = (v: number): number => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
};

/** Single-series line with point markers and a crosshair tooltip. */
function LineChart({ points, height = 150, format = (v) => String(v), testId }: { points: Point[]; height?: number; format?: (v: number) => string; testId?: string }): JSX.Element {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 34;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const vals = points.map((p) => p.value ?? 0);
  const max = niceMax(Math.max(1, ...vals));
  const iw = Math.max(10, w - padL - padR);
  const ih = height - padT - padB;
  const x = (i: number): number => padL + (points.length <= 1 ? iw / 2 : (i * iw) / (points.length - 1));
  const y = (v: number): number => padT + ih - (v / max) * ih;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value ?? 0)}`).join(" ");
  return (
    <div ref={ref} className="chart-wrap" data-testid={testId}>
      {w > 0 && (
        <svg className="chart" width={w} height={height} onMouseLeave={() => (setHover(null), hide())}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={padL} x2={w - padR} y1={y(max * f)} y2={y(max * f)} />
              <text className="axis-label" x={padL - 6} y={y(max * f) + 4} textAnchor="end">{format(Math.round(max * f))}</text>
            </g>
          ))}
          {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} />}
          <path d={path} fill="none" stroke="var(--series-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {points.map((p, i) => (
            <g key={p.key}>
              <circle className="pt" cx={x(i)} cy={y(p.value ?? 0)} r={hover === i ? 5 : 4} fill="var(--surface)" stroke="var(--series-1)" strokeWidth={2} data-testid={testId ? `${testId}-pt` : undefined} />
              <text className="axis-label" x={x(i)} y={height - 6} textAnchor="middle">{p.label}</text>
              <rect
                className="hit"
                x={x(i) - iw / Math.max(1, points.length - 1) / 2}
                y={padT}
                width={iw / Math.max(1, points.length - 1)}
                height={ih}
                onMouseMove={(e) => {
                  setHover(i);
                  show(e, <><b>{p.label}</b> {p.value === null ? "-" : format(p.value)}</>);
                }}
              />
            </g>
          ))}
        </svg>
      )}
      {tip}
    </div>
  );
}

/** Vertical bars; null values draw nothing and read "-" (no data). */
function BarChart({
  points,
  height = 150,
  max: fixedMax,
  format = (v) => String(v),
  axisFormat,
  highlight,
  everyLabel = 1,
  testId,
}: {
  points: Point[];
  height?: number;
  max?: number;
  format?: (v: number) => string;
  axisFormat?: (v: number) => string;
  highlight?: number | null;
  everyLabel?: number;
  testId?: string;
}): JSX.Element {
  const [ref, w] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTip();
  const padL = 38;
  const padR = 6;
  const padT = 10;
  const padB = 22;
  const max = fixedMax ?? niceMax(Math.max(1, ...points.map((p) => p.value ?? 0)));
  const iw = Math.max(10, w - padL - padR);
  const ih = height - padT - padB;
  const slot = iw / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(28, slot - 2));
  const y = (v: number): number => padT + ih - (Math.min(v, max) / max) * ih;
  const af = axisFormat ?? format;
  return (
    <div ref={ref} className="chart-wrap" data-testid={testId}>
      {w > 0 && (
        <svg className="chart" width={w} height={height} onMouseLeave={hide}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid" x1={padL} x2={w - padR} y1={y(max * f)} y2={y(max * f)} />
              <text className="axis-label" x={padL - 6} y={y(max * f) + 4} textAnchor="end">{af(max * f)}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const cx = padL + slot * i + slot / 2;
            const v = p.value;
            const hgt = v === null ? 0 : Math.max(v > 0 ? 2 : 0, padT + ih - y(v));
            const fill = highlight === undefined || highlight === null ? "var(--series-1)" : i === highlight ? "var(--series-1)" : "var(--seq-2)";
            return (
              <g key={p.key}>
                {hgt > 0 && <path d={roundTop(cx - bw / 2, padT + ih - hgt, bw, hgt, Math.min(4, bw / 2))} fill={fill} />}
                {i % everyLabel === 0 && <text className="axis-label" x={cx} y={height - 6} textAnchor="middle">{p.label}</text>}
                <rect className="hit" x={cx - slot / 2} y={padT} width={slot} height={ih} onMouseMove={(e) => show(e, <><b>{p.label}</b> {v === null ? "-" : format(v)}</>)} />
              </g>
            );
          })}
        </svg>
      )}
      {tip}
    </div>
  );
}
function roundTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/** Horizontal labelled bars (classified and distribution lists). */
function HBars({ entries, colorOf, format = (v) => String(v), testId }: { entries: Array<{ key: string; label: string; value: number }>; colorOf: (key: string, i: number) => string; format?: (v: number) => string; testId?: string }): JSX.Element {
  const { tip, show, hide } = useTip();
  const max = Math.max(1, ...entries.map((e) => e.value));
  const total = entries.reduce((n, e) => n + e.value, 0);
  if (entries.length === 0) return <div className="stats-none">No data in this range</div>;
  return (
    <div className="hbars" data-testid={testId} onMouseLeave={hide}>
      {entries.map((e, i) => (
        <div key={e.key} className="hbar" onMouseMove={(ev) => show(ev, <><b>{e.label}</b> {format(e.value)} ({Math.round((e.value / Math.max(1, total)) * 100)}%)</>)}>
          <span className="hbar-label">
            <span className="sw" style={{ background: colorOf(e.key, i) }} />
            {e.label}
          </span>
          <span className="hbar-track">
            <span className="hbar-fill" style={{ width: `${(e.value / max) * 100}%`, background: colorOf(e.key, i) }} />
          </span>
          <span className="hbar-value">{format(e.value)}</span>
        </div>
      ))}
      {tip}
    </div>
  );
}

function Card({ title, children, action, className = "", testId }: { title: ReactNode; children: ReactNode; action?: ReactNode; className?: string; testId?: string }): JSX.Element {
  return (
    <section className={`m4-card stats-card ${className}`} data-testid={testId}>
      <div className="m4-card-title">
        <span>{title}</span>
        <span className="grow" />
        {action}
      </div>
      {children}
    </section>
  );
}
const Note = ({ error }: { error: string | null }): JSX.Element | null => (error ? <div className="stats-none">{error}</div> : null);

function Kpi({ label, value, unit, testId }: { label: string; value: ReactNode; unit?: string; testId?: string }): JSX.Element {
  return (
    <div className="m4-kpi" data-testid={testId}>
      <div className="k-label">{label}</div>
      <div className="k-value">
        {value}
        {unit && <span className="k-unit">{unit}</span>}
      </div>
    </div>
  );
}

function useToday(): { today: number; weekStart: number } {
  const { now, settings } = useApp();
  const { tz } = useM4();
  return { today: stampOf(now, tz), weekStart: weekStartIndex(settings.startDayOfWeek) };
}

// ------------------------------------------------------------------ screen

export function StatisticsScreen(): JSX.Element {
  const app = useApp();
  const pomo = pomoOn(app);
  const raw = (app.route.itemId ?? "overview") as Tab;
  const tab: Tab = raw === "pomo" && !pomo ? "overview" : raw;
  const tabs: Array<[Tab, string]> = [["overview", "Overview"], ["task", "Task"], ...(pomo ? [["pomo", "Focus"] as [Tab, string]] : [])];
  const done = (): void => go(prevPath || localStorage.getItem("lastTaskPath") || "q/today/tasks");
  return (
    <div className="stats" data-testid="statistics">
      <header className="stats-head">
        <h1 className="view-title">Statistics</h1>
        <div className="seg stats-tabs" role="tablist">
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} data-testid={`stats-tab-${k}`} onClick={() => go(statisticsPath(k))}>
              {label}
            </button>
          ))}
        </div>
        <button className="btn primary sm stats-done" data-testid="stats-done" onClick={done}>Done</button>
      </header>
      <div className="stats-scroll">
        <div className="stats-body">
          {tab === "overview" && <OverviewTab />}
          {tab === "task" && <TaskTab />}
          {tab === "pomo" && <FocusTab />}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ overview

interface General {
  score: number;
  level: number;
  todayCompleted: number;
  yesterdayCompleted: number;
  totalCompleted: number;
  todayPomoCount: number;
  todayPomoDuration: number;
  totalPomoCount: number;
  totalPomoDuration: number;
  pomoGoal: number;
  pomoDurationGoal: number;
  scoreByDay: Record<string, number>;
  taskByDay: Record<string, { completeCount: number; notCompleteCount: number }>;
  taskByWeek: Record<string, { completeCount: number; notCompleteCount: number }>;
  taskByMonth: Record<string, { completeCount: number; notCompleteCount: number }>;
}
interface Ranking {
  ranking: number;
  taskCount: number;
  completedCount: number;
  projectCount: number;
  dayCount: number;
}
const UNITS: Array<{ value: Period; label: string }> = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

function OverviewTab(): JSX.Element {
  const app = useApp();
  const general = useFetch<General>("/api/v2/statistics/general");
  const ranking = useFetch<Ranking>("/api/v3/user/ranking");
  const [curve, setCurve] = useState<Period>("day");
  const [rateUnit, setRateUnit] = useState<Period>("day");
  const g = general.data;
  const r = ranking.data;
  const mapOf = (u: Period): General["taskByDay"] | undefined => (u === "day" ? g?.taskByDay : u === "week" ? g?.taskByWeek : g?.taskByMonth);
  const counts = completionSeries(mapOf(curve), curve).counts;
  const rates = completionSeries(mapOf(rateUnit), rateUnit).rates;
  const lp = levelProgress(g?.score ?? 0);
  return (
    <>
      <section className="stats-strip" data-testid="stats-strip">
        <div className="m4-kpis">
          <Kpi label="Tasks" value={r?.taskCount ?? "-"} testId="strip-tasks" />
          <Kpi label="Completed" value={r?.completedCount ?? "-"} testId="strip-completed" />
          <Kpi label="Lists" value={r?.projectCount ?? "-"} testId="strip-lists" />
          <Kpi label="Days" value={r?.dayCount ?? "-"} testId="strip-days" />
        </div>
        <p className="stats-sentence">
          {ranking.error
            ? ranking.error
            : r && r.ranking > 0
              ? `You are more productive than ${Math.round(r.ranking * 100)}% of people.`
              : r
                ? `${r.dayCount} ${r.dayCount === 1 ? "day" : "days"} of planning, ${r.completedCount} tasks done. NoorTasks is single-user, so there is no ranking against others.`
                : " "}
        </p>
      </section>
      <div className="m4-cards">
        <Card title="Overview" testId="card-overview">
          <Note error={general.error} />
          <div className="m4-kpis">
            <Kpi label="Today" value={g?.todayCompleted ?? "-"} testId="ov-today" />
            <Kpi label="Yesterday" value={g?.yesterdayCompleted ?? "-"} testId="ov-yesterday" />
            <Kpi label="Total" value={g?.totalCompleted ?? "-"} testId="ov-total" />
          </div>
          <p className="muted small stats-foot">Completed tasks</p>
        </Card>
        <Card title="My Achievement Score" testId="card-score" action={<span className="stats-level" data-testid="score-level">Level {g?.level ?? lp.level}</span>}>
          <Note error={general.error} />
          <div className="score-row">
            <span className="score-big" data-testid="score-value">{g?.score ?? "-"}</span>
            <span className="score-next muted small">{lp.to === null ? "Top level reached" : `${lp.to - (g?.score ?? 0)} points to level ${lp.level + 1}`}</span>
          </div>
          <div className="level-track" aria-hidden>
            <span style={{ width: `${lp.share * 100}%` }} />
          </div>
          <LineChart points={scorePoints(g?.scoreByDay)} height={120} testId="score-line" />
        </Card>
        <Card title="Recent Completion Curve" testId="card-curve" action={<Select testId="curve-unit" value={curve} options={UNITS} onChange={setCurve} />}>
          <LineChart points={counts} testId="curve-line" />
        </Card>
        <Card title="Recent Completion Rate Curve" testId="card-rate" action={<Select testId="rate-unit" value={rateUnit} options={UNITS} onChange={setRateUnit} />}>
          <BarChart points={rates} max={1} format={(v) => pct(v)} axisFormat={(v) => `${Math.round(v * 100)}%`} testId="rate-bars" />
        </Card>
        {habitOn(app) && <HabitWeekCard />}
        {pomoOn(app) && (
          <Card title="Focus" testId="card-focus-overview" action={<button className="link-btn" onClick={() => go(statisticsPath("pomo"))}>Details</button>}>
            <div className="m4-kpis">
              <Kpi label="Today's pomos" value={g?.todayPomoCount ?? "-"} />
              <Kpi label="Today's focus" value={g ? formatMinutes(g.todayPomoDuration) : "-"} />
              <Kpi label="Total focus" value={g ? formatMinutes(g.totalPomoDuration) : "-"} />
            </div>
            {g && <GoalBar done={g.todayPomoCount} goal={g.pomoGoal} label="pomos today" />}
          </Card>
        )}
        <AchievementsCard />
      </div>
    </>
  );
}

function GoalBar({ done, goal, label }: { done: number; goal: number; label: string }): JSX.Element {
  const share = goal > 0 ? Math.min(1, done / goal) : 0;
  return (
    <div className="goal" data-testid="goal-progress">
      <div className="goal-text small">
        <b>{done}</b> of {goal} {label}
      </div>
      <div className="level-track">
        <span style={{ width: `${share * 100}%`, background: share >= 1 ? "var(--good)" : undefined }} />
      </div>
    </div>
  );
}

function HabitWeekCard(): JSX.Element {
  const week = useFetch<Record<string, { totalHabitCount: number; completedHabitCount: number }>>("/api/v2/habits/statistics/week/current");
  const days = Object.keys(week.data ?? {}).sort();
  const done = days.reduce((n, d) => n + (week.data![d]!.completedHabitCount ?? 0), 0);
  const total = days.reduce((n, d) => n + (week.data![d]!.totalHabitCount ?? 0), 0);
  return (
    <Card title="Habits this week" testId="card-habit-week" action={<span className="muted small">{total ? `${done}/${total} check-ins` : ""}</span>}>
      <Note error={week.error} />
      <div className="habit-week">
        {days.map((d) => {
          const x = week.data![d]!;
          const share = x.totalHabitCount ? x.completedHabitCount / x.totalHabitCount : 0;
          return (
            <div key={d} className="hw-day" title={`${stampLabel(Number(d))}: ${x.completedHabitCount} of ${x.totalHabitCount}`}>
              <svg viewBox="0 0 36 36" className="hw-ring" aria-hidden>
                <circle cx="18" cy="18" r="15" fill="none" stroke="var(--surface-3)" strokeWidth="4" />
                {share > 0 && <circle cx="18" cy="18" r="15" fill="none" stroke="var(--series-3)" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${share * 94.25} 94.25`} transform="rotate(-90 18 18)" />}
              </svg>
              <span className="hw-count small">{x.completedHabitCount}/{x.totalHabitCount}</span>
              <span className="muted small">{stampWeekday(Number(d))}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ badges

function Medal({ tier, unlocked, track }: { tier: number; unlocked: boolean; track: BadgeTrack["id"] }): JSX.Element {
  const hue = { perseverance: 1, gtd: 3, mindfulness: 7, discipline: 2 }[track];
  const c = unlocked ? `var(--series-${hue})` : "var(--surface-3)";
  const ink = unlocked ? "#fff" : "var(--text-3)";
  return (
    <svg viewBox="0 0 40 46" className={`medal${unlocked ? " on" : ""}`} aria-label={`Medal ${tier}${unlocked ? " unlocked" : " locked"}`}>
      <path d="M12 2 L18 16 L13 18 L7 4 Z" fill={unlocked ? "var(--text-3)" : "var(--surface-3)"} opacity={0.7} />
      <path d="M28 2 L22 16 L27 18 L33 4 Z" fill={unlocked ? "var(--text-3)" : "var(--surface-3)"} opacity={0.7} />
      <circle cx="20" cy="29" r="14" fill={c} />
      <circle cx="20" cy="29" r="10.5" fill="none" stroke={ink} strokeOpacity={0.55} strokeWidth="1.2" />
      <text x="20" y="33.5" textAnchor="middle" fontSize="12" fontWeight="700" fill={ink}>{tier}</text>
    </svg>
  );
}

function AchievementsCard(): JSX.Element {
  const { tasks, engine, now } = useApp();
  const { pomos, checkins, tz } = useM4();
  // completed tasks mostly live on the server only (the local store keeps open ones): read the daily rows, 10 years back
  const [serverDays, setServerDays] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    const to = stampOf(now, tz);
    const from = stampOf(now - 3650 * 86400000, tz);
    engine.api.get<Array<{ day: string | number; overdueCompleteCount?: number; onTimeCompleteCount?: number; noTimeCompleteCount?: number }>>(`/api/v2/task/statistics/${from}/${to}`).then(
      (rows) => {
        const m = new Map<number, number>();
        for (const r of rows ?? []) {
          const n = (r.overdueCompleteCount ?? 0) + (r.onTimeCompleteCount ?? 0) + (r.noTimeCompleteCount ?? 0);
          if (n) m.set(Number(r.day), n);
        }
        setServerDays(m);
      },
      () => {},
    );
  }, [engine, tz, Math.floor(now / 3600000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = useMemo(() => {
    const perDayDone = new Map<number, number>(serverDays);
    const localDays = new Map<number, number>();
    for (const t of tasks) {
      if (t.deleted || t.status !== 2 || !t.completedTime) continue;
      const ms = Date.parse(String(t.completedTime).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
      if (Number.isNaN(ms)) continue;
      const d = stampOf(ms, tz);
      localDays.set(d, (localDays.get(d) ?? 0) + 1);
    }
    for (const [d, n] of localDays) perDayDone.set(d, Math.max(n, perDayDone.get(d) ?? 0));
    const perDayCheck = new Map<number, number>();
    for (const c of checkins) if (c.status === 2) perDayCheck.set(c.checkinStamp, (perDayCheck.get(c.checkinStamp) ?? 0) + 1);
    const minutes = pomos.reduce((n, r) => n + recordActiveMs(r), 0) / 60000;
    return {
      perseverance: openDays().length,
      gtd: cappedTotal(perDayDone, 50),
      mindfulness: Math.floor(minutes),
      discipline: cappedTotal(perDayCheck, 10),
    };
  }, [tasks, pomos, checkins, tz, serverDays]);
  return (
    <Card title="Achievements" className="span-all" testId="card-badges">
      <div className="badges">
        {BADGE_TRACKS.map((t) => {
          const p = badgeProgress(t, values[t.id]);
          return (
            <div key={t.id} className="badge-track" data-testid={`badge-${t.id}`} data-level={p.level}>
              <div className="badge-head">
                <b>{t.name}</b>
                <span className="muted small">
                  {p.value} {p.value === 1 ? t.unit.replace(/s$/, "").replace(/-ins$/, "-in") : t.unit}
                  {p.next !== null ? ` · next at ${p.next}` : " · all unlocked"}
                </span>
              </div>
              <div className="medals">
                {t.thresholds.map((th, i) => (
                  <div key={th} className="medal-cell" title={`${th} ${t.unit}${t.dailyCap ? `, at most ${t.dailyCap} a day count` : ""}`}>
                    <Medal tier={i + 1} unlocked={p.level > i} track={t.id} />
                    <span className="small muted">{th >= 1000 ? `${th / 1000}k` : th}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ task tab

const PERIODS: Array<{ value: Period; label: string }> = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
];

function DateNav({ label, onPrev, onNext, onToday, testId }: { label: string; onPrev: () => void; onNext: () => void; onToday?: () => void; testId?: string }): JSX.Element {
  return (
    <div className="date-nav" data-testid={testId}>
      <button className="icon-btn sm" aria-label="Previous" data-testid={testId ? `${testId}-prev` : undefined} onClick={onPrev}><ChevronLeft size={16} /></button>
      <span className="date-nav-label" data-testid={testId ? `${testId}-label` : undefined}>{label}</span>
      <button className="icon-btn sm" aria-label="Next" data-testid={testId ? `${testId}-next` : undefined} onClick={onNext}><ChevronRight size={16} /></button>
      {onToday && <button className="btn sm" data-testid={testId ? `${testId}-today` : undefined} onClick={onToday}>Today</button>}
    </div>
  );
}

function Delta({ value, unit = "", testId }: { value: number | null; unit?: string; testId?: string }): JSX.Element {
  if (value === null) return <span className="delta muted small" data-testid={testId}>-</span>;
  const up = value > 0;
  const flat = Math.abs(value) < 1e-9;
  return (
    <span className={`delta small${flat ? " flat" : up ? " up" : " down"}`} data-testid={testId} data-dir={flat ? "flat" : up ? "up" : "down"}>
      {flat ? <Minus size={12} /> : up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
      {flat ? "no change" : `${Math.abs(Math.round(value * 10) / 10)}${unit}`}
    </span>
  );
}

const ymd = (s: number): string => String(s);

function TaskTab(): JSX.Element {
  const { today, weekStart } = useToday();
  const { projects, tags } = useApp();
  const [period, setPeriod] = useState<Period>("day");
  const [anchor, setAnchor] = useState(today);
  const [by, setBy] = useState<"list" | "tag">("list");
  const r = periodRange(period, anchor, weekStart);
  const prev = periodRange(period, shiftPeriod(period, anchor, -1), weekStart);
  const cur = useFetch<TaskStatRow[]>(`/api/v2/task/statistics/${ymd(r.from)}/${ymd(r.to)}`);
  const before = useFetch<TaskStatRow[]>(`/api/v2/task/statistics/${ymd(prev.from)}/${ymd(prev.to)}`);
  const colors = useFetch<{ project2color: Record<string, string | null>; tag2color: Record<string, string | null> }>("/api/v2/statistics/color");
  const t = sumTaskRows(cur.data);
  const p = sumTaskRows(before.data);
  const vsLabel = period === "day" ? "vs the day before" : period === "week" ? "vs last week" : "vs last month";
  const slices = [
    { key: "onTime", label: "On-Time", value: t.onTime, color: "var(--series-3)" },
    { key: "overdue", label: "Overdue", value: t.overdue, color: "var(--series-2)" },
    { key: "undated", label: "Undated", value: t.undated, color: "var(--series-1)" },
    { key: "uncompleted", label: "Uncompleted", value: t.uncompleted, color: "var(--text-3)" },
  ];
  const total = slices.reduce((n, s) => n + s.value, 0);
  const classified = topEntries(by === "list" ? t.byList : t.byTag).map((e) => ({ key: e.key, label: e.key === "UNKNOWN_CATEGORY" ? "No tag" : e.key, value: e.value }));
  const colorOf = (key: string, i: number): string => {
    if (key === "Other") return "var(--text-3)";
    if (key === "UNKNOWN_CATEGORY") return "var(--surface-3)";
    const c = by === "list" ? (colors.data?.project2color[key] ?? projects.find((x) => x.name === key)?.color) : (colors.data?.tag2color[key] ?? tags.find((x) => x.name === key)?.color);
    return c || SERIES(i);
  };
  return (
    <>
      <div className="stats-controls">
        <Select testId="task-period" value={period} options={PERIODS} onChange={(v) => setPeriod(v)} />
        <DateNav testId="task-nav" label={rangeLabel(period, r, today)} onPrev={() => setAnchor(shiftPeriod(period, anchor, -1))} onNext={() => setAnchor(shiftPeriod(period, anchor, 1))} onToday={() => setAnchor(today)} />
      </div>
      <div className="m4-cards">
        <Card title="Overview" testId="task-overview">
          <Note error={cur.error} />
          <div className="m4-kpis">
            <div className="m4-kpi">
              <div className="k-label">Completed</div>
              <div className="k-value" data-testid="task-completed">{t.completed}</div>
              <Delta value={before.data ? t.completed - p.completed : null} testId="task-completed-delta" />
            </div>
            <div className="m4-kpi">
              <div className="k-label">Completion rate</div>
              <div className="k-value" data-testid="task-rate">{pct(t.rate)}</div>
              <Delta value={t.rate !== null && p.rate !== null ? (t.rate - p.rate) * 100 : null} unit=" pts" testId="task-rate-delta" />
            </div>
          </div>
          <p className="muted small stats-foot">{vsLabel}</p>
        </Card>
        <Card title="Completion Rate Distribution" testId="task-distribution">
          {total === 0 ? (
            <div className="stats-none">No tasks in this range</div>
          ) : (
            <>
              <StackedBar slices={slices} testId="dist-bar" />
              <div className="dist-legend">
                {slices.map((s) => (
                  <div key={s.key} className="dist-row" data-testid={`dist-${s.key}`}>
                    <span className="sw" style={{ background: s.color }} />
                    <span className="grow">{s.label}</span>
                    <b>{s.value}</b>
                    <span className="muted small dist-pct">{Math.round((s.value / total) * 100)}%</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
        <Card
          title="Classified Completion Statistics"
          className="span-all"
          testId="task-classified"
          action={
            <div className="seg small">
              <button className={by === "list" ? "on" : ""} data-testid="classified-list" onClick={() => setBy("list")}>List</button>
              <button className={by === "tag" ? "on" : ""} data-testid="classified-tag" onClick={() => setBy("tag")}>Tag</button>
            </div>
          }
        >
          <HBars entries={classified} colorOf={colorOf} testId="classified-bars" />
        </Card>
      </div>
    </>
  );
}

function StackedBar({ slices, testId }: { slices: Array<{ key: string; label: string; value: number; color: string }>; testId?: string }): JSX.Element {
  const { tip, show, hide } = useTip();
  const total = slices.reduce((n, s) => n + s.value, 0);
  return (
    <div className="stacked" data-testid={testId} onMouseLeave={hide}>
      {slices
        .filter((s) => s.value > 0)
        .map((s) => (
          <span key={s.key} className="stacked-seg" style={{ flexGrow: s.value, background: s.color }} onMouseMove={(e) => show(e, <><b>{s.label}</b> {s.value} ({Math.round((s.value / total) * 100)}%)</>)} />
        ))}
      {tip}
    </div>
  );
}

// ------------------------------------------------------------------ focus tab

interface DesktopGeneral {
  todayPomoCount: number;
  yesterdayPomoCount: number;
  totalPomoCount: number;
  todayPomoDuration: number;
  totalPomoDuration: number;
  todayTimingCount: number;
  totalTimingCount: number;
  pomoGoal: number;
  pomoDurationGoal: number;
}
interface Dist {
  totalDuration: number;
  unboundDuration: number;
  projectDurations: Record<string, number>;
  tagDurations: Record<string, number>;
  taskDurations: Record<string, { title?: string; duration: number }>;
  habitDurations: Record<string, { title?: string; duration: number }>;
  timerDurations: Record<string, { title?: string; duration: number }>;
}
const RANGES: Array<{ value: FocusRange; label: string }> = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

function FocusTab(): JSX.Element {
  const { today, weekStart } = useToday();
  const app = useApp();
  const { habits, timers, pomoPrefs } = useM4();
  const [kind, setKind] = useState<FocusRange>("week");
  const [anchor, setAnchor] = useState(today);
  const [by, setBy] = useState<"task" | "list" | "tag">("task");
  const r = focusRange(kind, anchor, weekStart);
  const g = useFetch<DesktopGeneral>("/api/v2/pomodoros/statistics/generalForDesktop");
  const dist = useFetch<Dist>(`/api/v2/pomodoros/statistics/dist/${ymd(r.from)}/${ymd(r.to)}`);
  const clock = useFetch<Record<string, number>>(`/api/v2/pomodoros/statistics/dist/clock/${ymd(r.from)}/${ymd(r.to)}`);
  const days = useFetch<Record<string, number>>(`/api/v2/pomodoros/statistics/heatmap/${ymd(r.from)}/${ymd(r.to)}`);
  const wk = focusRange("week", anchor, weekStart);
  const byDay = useFetch<Record<string, Record<string, number>>>(`/api/v2/pomodoros/statistics/dist/clockByDay/${ymd(wk.from)}/${ymd(wk.to)}`);
  const year = Math.floor(anchor / 10000);
  const heat = useFetch<Record<string, number>>(`/api/v2/pomodoros/statistics/heatmap/${year}0101/${year}1231`);
  const d = g.data;
  const trend = sumBuckets(days.data, trendBuckets(kind, r));
  const peak = peakHour(clock.data);
  const clockPts: Point[] = Array.from({ length: 24 }, (_, h) => ({ key: String(h), label: String(h), value: clock.data?.[String(h)] ?? 0 }));
  const durationGoal = d?.pomoDurationGoal || pomoPrefs.focusDuration || 0;

  const distEntries = useMemo(() => {
    const x = dist.data;
    if (!x) return [];
    if (by === "list") return topEntries(x.projectDurations).map((e) => ({ key: e.key, label: e.key, value: e.value }));
    if (by === "tag") return topEntries(x.tagDurations).map((e) => ({ key: e.key, label: e.key, value: e.value }));
    const titled: Record<string, number> = {};
    const name = (id: string, rec: { title?: string }, kindName: "task" | "habit" | "timer"): string =>
      rec.title ?? (kindName === "task" ? app.tasks.find((t) => t.id === id)?.title : kindName === "habit" ? habits.find((h) => h.id === id)?.name : timers.find((t) => t.id === id)?.name) ?? "Untitled";
    for (const [id, v] of Object.entries(x.taskDurations)) titled[name(id, v, "task")] = (titled[name(id, v, "task")] ?? 0) + v.duration;
    for (const [id, v] of Object.entries(x.habitDurations)) titled[name(id, v, "habit")] = (titled[name(id, v, "habit")] ?? 0) + v.duration;
    for (const [id, v] of Object.entries(x.timerDurations)) titled[name(id, v, "timer")] = (titled[name(id, v, "timer")] ?? 0) + v.duration;
    if (x.unboundDuration > 0) titled["Unlinked"] = x.unboundDuration;
    return topEntries(titled).map((e) => ({ key: e.key, label: e.key, value: e.value }));
  }, [dist.data, by, app.tasks, habits, timers]);

  return (
    <>
      <section className="m4-card stats-card" data-testid="focus-overview">
        <Note error={g.error} />
        <div className="m4-kpis">
          <Kpi label="Today's pomos" value={d?.todayPomoCount ?? "-"} testId="focus-today-pomos" />
          <Kpi label="Today's focus" value={d ? formatMinutes(d.todayPomoDuration) : "-"} testId="focus-today-duration" />
          <Kpi label="Total pomos" value={d?.totalPomoCount ?? "-"} testId="focus-total-pomos" />
          <Kpi label="Total focus" value={d ? formatMinutes(d.totalPomoDuration) : "-"} testId="focus-total-duration" />
          <Kpi label="Stopwatch sessions" value={d?.totalTimingCount ?? "-"} />
        </div>
        {d && (
          <div className="goals-row">
            <GoalBar done={d.todayPomoCount} goal={d.pomoGoal} label="pomos today" />
            {durationGoal > 0 && <GoalBar done={Math.round(d.todayPomoDuration)} goal={durationGoal} label="minutes today" />}
          </div>
        )}
      </section>
      <div className="stats-controls">
        <div className="seg small" role="tablist">
          {RANGES.map((x) => (
            <button key={x.value} className={kind === x.value ? "on" : ""} data-testid={`focus-range-${x.value}`} onClick={() => setKind(x.value)}>{x.label}</button>
          ))}
        </div>
        <DateNav
          testId="focus-nav"
          label={kind === "year" ? String(year) : rangeLabel(kind === "week" ? "week" : "month", r, today)}
          onPrev={() => setAnchor(shiftFocusRange(kind, anchor, -1))}
          onNext={() => setAnchor(shiftFocusRange(kind, anchor, 1))}
          onToday={() => setAnchor(today)}
        />
      </div>
      <div className="m4-cards">
        <Card title="Focus trend" testId="focus-trend" action={<span className="muted small">{dist.data ? formatMinutes(dist.data.totalDuration) : ""}</span>}>
          <Note error={days.error} />
          <BarChart points={trend} format={formatMinutes} axisFormat={(v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${Math.round(v)}m`)} everyLabel={kind === "month" ? 5 : 1} testId="focus-trend-bars" />
        </Card>
        <Card
          title="Focus distribution"
          testId="focus-dist"
          action={
            <div className="seg small">
              {(["task", "list", "tag"] as const).map((k) => (
                <button key={k} className={by === k ? "on" : ""} data-testid={`focus-dist-${k}`} onClick={() => setBy(k)}>{k === "task" ? "Task" : k === "list" ? "List" : "Tag"}</button>
              ))}
            </div>
          }
        >
          <Note error={dist.error} />
          <HBars entries={distEntries} colorOf={(k, i) => (k === "Unlinked" || k === "Other" ? "var(--text-3)" : SERIES(i))} format={formatMinutes} testId="focus-dist-bars" />
        </Card>
        <Card title="Most focused time" testId="focus-clock" action={<span className="muted small" data-testid="focus-peak">{peak === null ? "" : `${hourLabel(peak)} - ${hourLabel((peak + 1) % 24)}`}</span>}>
          <Note error={clock.error} />
          <BarChart points={clockPts} highlight={peak} format={formatMinutes} axisFormat={(v) => `${Math.round(v)}m`} everyLabel={3} testId="focus-clock-bars" />
        </Card>
        <Card title={`Daily focus timeline · ${rangeLabel("week", wk, today)}`} className="span-all" testId="focus-timeline">
          <Note error={byDay.error} />
          <DayTimeline from={wk.from} data={byDay.data} />
        </Card>
        <Card title={`Focus heatmap · ${year}`} className="span-all" testId="focus-heatmap">
          <Note error={heat.error} />
          <YearHeatmap year={year} weekStart={weekStart} data={heat.data} />
        </Card>
      </div>
    </>
  );
}

function DayTimeline({ from, data }: { from: number; data: Record<string, Record<string, number>> | null }): JSX.Element {
  const { tip, show, hide } = useTip();
  const rows = Array.from({ length: 7 }, (_, i) => addStampDays(from, i));
  return (
    <div className="day-timeline" onMouseLeave={hide}>
      {rows.map((d) => (
        <div key={d} className="dt-row">
          <span className="dt-label small muted">{stampWeekday(d)}</span>
          <div className="dt-cells">
            {Array.from({ length: 24 }, (_, h) => {
              const m = data?.[String(d)]?.[String(h)] ?? 0;
              const lvl = m <= 0 ? 0 : m < 15 ? 2 : m < 40 ? 3 : 4;
              return <span key={h} className="dt-cell" style={{ background: lvl ? `var(--seq-${lvl})` : undefined }} onMouseMove={(e) => show(e, <><b>{stampLabel(d)} {hourLabel(h)}</b> {formatMinutes(m)}</>)} />;
            })}
          </div>
        </div>
      ))}
      <div className="dt-row">
        <span className="dt-label" />
        <div className="dt-cells dt-axis small muted">
          {[0, 6, 12, 18].map((h) => (
            <span key={h} style={{ gridColumn: `${h + 1} / span 6` }}>{hourLabel(h)}</span>
          ))}
        </div>
      </div>
      {tip}
    </div>
  );
}

function YearHeatmap({ year, weekStart, data }: { year: number; weekStart: number; data: Record<string, number> | null }): JSX.Element {
  const { tip, show, hide } = useTip();
  const cols = useMemo(() => yearGrid(year, weekStart), [year, weekStart]);
  const cell = 11;
  const gap = 2;
  const w = cols.length * (cell + gap);
  const h = 7 * (cell + gap) + 14;
  const total = Object.values(data ?? {}).reduce((n, v) => n + v, 0);
  return (
    <div className="heatmap" data-testid="heatmap-grid">
      <div className="heatmap-scroll">
        <svg className="chart" width={w} height={h} onMouseLeave={hide}>
          {cols.map((col, ci) => (
            <g key={ci} transform={`translate(${ci * (cell + gap)},14)`}>
              {col[0] !== null && col[0]! % 100 <= 7 && <text className="axis-label" x={0} y={-4}>{stampLabel(col[0]!).split(" ")[0]}</text>}
              {col.map((d, ri) => {
                if (d === null) return null;
                const m = data?.[String(d)] ?? 0;
                const lvl = heatLevelMinutes(m);
                return <rect key={ri} y={ri * (cell + gap)} width={cell} height={cell} rx={2} fill={lvl ? `var(--seq-${lvl})` : "var(--surface-2)"} data-level={lvl} onMouseMove={(e) => show(e, <><b>{stampLabel(d, true)}</b> {formatMinutes(m)}</>)} />;
              })}
            </g>
          ))}
        </svg>
      </div>
      <div className="heatmap-foot small muted">
        <span>{formatMinutes(total)} in {year}</span>
        <span className="grow" />
        <span>Less</span>
        {[0, 1, 2, 3, 4, 5].map((l) => (
          <span key={l} className="heat-key" style={{ background: l ? `var(--seq-${l})` : "var(--surface-2)" }} />
        ))}
        <span>More</span>
      </div>
      {tip}
    </div>
  );
}

// ------------------------------------------------------------------ timer card (STAT-024), embedded in the Focus screen

interface TimerOverview {
  id: string;
  name: string;
  totalCount: number;
  totalDuration: number;
  todayCount: number;
  todayDuration: number;
  lastFocusTime: string | number | null;
}

export function TimerStatsCard({ timerId }: { timerId: string }): JSX.Element {
  const { today, weekStart } = useToday();
  const [kind, setKind] = useState<FocusRange>("week");
  const [anchor, setAnchor] = useState(today);
  const r = focusRange(kind, anchor, weekStart);
  const unit = kind === "year" ? "month" : "day";
  const ov = useFetch<TimerOverview>(`/api/v2/timer/overview/${timerId}`);
  const st = useFetch<{ buckets: Record<string, { count: number; duration: number }>; totalDuration: number; totalCount: number }>(`/api/v2/timer/statistics/${timerId}/${ymd(r.from)}/${ymd(r.to)}/${unit}`);
  const pts: Point[] = trendBuckets(kind, r).map((b) => ({ key: String(b.key), label: b.label, value: st.data?.buckets?.[String(b.key)]?.duration ?? 0 }));
  const o = ov.data;
  return (
    <section className="m4-card stats-card timer-stats" data-testid="timer-stats">
      <div className="m4-card-title">
        <span>Statistics</span>
        <span className="grow" />
        <div className="seg small">
          {RANGES.map((x) => (
            <button key={x.value} className={kind === x.value ? "on" : ""} data-testid={`timer-range-${x.value}`} onClick={() => setKind(x.value)}>{x.label}</button>
          ))}
        </div>
      </div>
      <Note error={ov.error} />
      <div className="m4-kpis">
        <Kpi label="Today" value={o ? formatMinutes(o.todayDuration) : "-"} testId="timer-today" />
        <Kpi label="Total" value={o ? formatMinutes(o.totalDuration) : "-"} testId="timer-total" />
        <Kpi label="Sessions" value={o?.totalCount ?? "-"} testId="timer-count" />
      </div>
      <div className="stats-controls tight">
        <DateNav
          testId="timer-nav"
          label={kind === "year" ? String(Math.floor(anchor / 10000)) : rangeLabel(kind === "week" ? "week" : "month", r, today)}
          onPrev={() => setAnchor(shiftFocusRange(kind, anchor, -1))}
          onNext={() => setAnchor(shiftFocusRange(kind, anchor, 1))}
          onToday={() => setAnchor(today)}
        />
        <span className="muted small">{st.data ? `${formatMinutes(st.data.totalDuration)} in range` : ""}</span>
      </div>
      <BarChart points={pts} format={formatMinutes} axisFormat={(v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${Math.round(v)}m`)} everyLabel={kind === "month" ? 5 : 1} height={140} testId="timer-bars" />
    </section>
  );
}
