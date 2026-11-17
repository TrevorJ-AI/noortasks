import { useLiveQuery } from "dexie-react-hooks";
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { FocusController, defaultPrefs } from "../data/focusController";
import { M4Repo } from "../data/m4repo";
import { HABIT_PREF_DEFAULTS, type Checkin, type Countdown, type FocusRecord, type FocusTimer, type Habit, type HabitPrefs, type HabitRecord, type HabitSection, type PomoPrefs } from "../data/m4types";
import { userZone } from "../lib/m4core";
import type { TimerState } from "../model/timer";
import { useApp } from "./ctx";

/** M4 data next to the task data: habits, focus, countdowns, their preferences, and the live focus timer. */
export interface M4 {
  m4: M4Repo;
  focus: FocusController;
  habits: Habit[];
  sections: HabitSection[];
  checkins: Checkin[];
  records: HabitRecord[];
  pomos: FocusRecord[];
  timers: FocusTimer[];
  countdowns: Countdown[];
  pomoPrefs: PomoPrefs;
  habitPrefs: HabitPrefs;
  /** zone of habit stamps and statistics days */
  tz: string;
  /** ext.focusConf */
  focusConf: { keepInSync?: boolean; showTabFocusTime?: boolean; autoFullScreen?: boolean; antiBurnIn?: boolean; whiteNoise?: string; strict?: boolean };
}

const Ctx = createContext<M4 | null>(null);
export const useM4 = (): M4 => {
  const c = useContext(Ctx);
  if (!c) throw new Error("no m4 context");
  return c;
};

/** Settings > Features (HAB-001, FOC-001, CNT-001): tabBars HABIT and POMO, setting enableCountdown. */
type Bars = { settings: { tabBars?: Array<{ name: string; enabled?: boolean }>; enableCountdown?: boolean } };
export const habitOn = (a: Bars): boolean => (a.settings.tabBars ?? []).find((t) => t.name === "HABIT")?.enabled === true;
export const pomoOn = (a: Bars): boolean => (a.settings.tabBars ?? []).find((t) => t.name === "POMO")?.enabled === true;
export const countdownOn = (a: Bars): boolean => !!a.settings.enableCountdown;

export function M4Provider({ children }: { children: ReactNode }): JSX.Element {
  const app = useApp();
  const { db, engine, repo } = app;
  const confRef = useRef<M4["focusConf"]>({});
  const prefsRef = useRef<PomoPrefs>(defaultPrefs(null));
  const [{ m4, focus }] = useState(() => {
    const m4 = new M4Repo(db, engine);
    m4.onChange = () => repo.onChange();
    const focus = new FocusController(engine, m4, { prefs: () => prefsRef.current, keepInSync: () => !!confRef.current.keepInSync, onPhaseEnd: (s) => window.dispatchEvent(new CustomEvent("noor-focus-end", { detail: s })) });
    return { m4, focus };
  });
  const habits = useLiveQuery(() => db.habits.toArray(), [], []);
  const sections = useLiveQuery(() => db.habitSections.toArray(), [], []);
  const checkins = useLiveQuery(() => db.checkins.toArray(), [], []);
  const records = useLiveQuery(() => db.habitRecords.toArray(), [], []);
  const pomos = useLiveQuery(() => db.pomos.toArray(), [], []);
  const timers = useLiveQuery(() => db.timers.toArray(), [], []);
  const countdowns = useLiveQuery(() => db.countdowns.toArray(), [], []);
  const pomoRaw = useLiveQuery(() => db.getKV<Partial<PomoPrefs> | null>("pomoPrefs", null), [], null);
  const habitRaw = useLiveQuery(() => db.getKV<Partial<HabitPrefs> | null>("habitPrefs", null), [], null);
  const pomoPrefs = useMemo(() => defaultPrefs(pomoRaw), [pomoRaw]);
  const habitPrefs = useMemo(() => ({ ...HABIT_PREF_DEFAULTS, ...(habitRaw ?? {}) }) as HabitPrefs, [habitRaw]);
  const focusConf = (app.ext.focusConf ?? {}) as M4["focusConf"];
  confRef.current = focusConf;
  prefsRef.current = pomoPrefs;
  useEffect(() => focus.run(), [focus]);
  // a newly switched on sync pulls the live timer right away
  useEffect(() => {
    if (focusConf.keepInSync) void focus.poll();
  }, [focusConf.keepInSync, focus]);
  const value: M4 = { m4, focus, habits, sections, checkins, records, pomos, timers, countdowns, pomoPrefs, habitPrefs, tz: userZone(app.settings.timeZone), focusConf };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The live timer; re-renders every half second while it runs. */
export function useTimer(): { state: TimerState | null; now: number } {
  const { focus } = useM4();
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => focus.subscribe(bump), [focus]);
  const running = focus.state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const i = setInterval(bump, 500);
    return () => clearInterval(i);
  }, [running]);
  return { state: focus.state, now: Date.now() };
}
