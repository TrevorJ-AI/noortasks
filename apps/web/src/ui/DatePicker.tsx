import { describeRepeat, parseRepeatFlag } from "@noortasks/recurrence";
import { AlarmClock, CalendarPlus, ChevronDown, ChevronLeft, ChevronRight, Circle, Clock, Moon, Repeat, Sun, Sunrise, X } from "lucide-react";
import { useMemo, useState } from "react";
import { DAY, MONTHS_LONG, MONTHS_SHORT, WEEKDAYS_LONG, addDays, addMonths, deviceZone, formatTime, parseDate, startOfDay, toServer, weekStartIndex } from "../lib/dates";
import { useApp } from "./ctx";
import { Popover, Switch, anchorOf, type Anchor } from "./primitives";

export interface DateValue {
  startDate?: string;
  dueDate?: string;
  isAllDay?: boolean;
  reminders: string[];
  repeatFlag?: string;
  repeatFrom?: string;
  timeZone?: string;
  /** -1 = constant reminder (RMD-022) */
  annoyingAlert?: number;
}

const ORD = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]!);
};
const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export const ALLDAY_REMINDERS: Array<{ trigger: string; label: string }> = [
  { trigger: "TRIGGER:P0DT9H0M0S", label: "On the day (09:00)" },
  { trigger: "TRIGGER:-P0DT15H0M0S", label: "1 day early (09:00)" },
  { trigger: "TRIGGER:-P1DT15H0M0S", label: "2 days early (09:00)" },
  { trigger: "TRIGGER:-P2DT15H0M0S", label: "3 days early (09:00)" },
  { trigger: "TRIGGER:-P6DT15H0M0S", label: "1 week early (09:00)" },
];
export const TIMED_REMINDERS: Array<{ trigger: string; label: string }> = [
  { trigger: "TRIGGER:PT0S", label: "On time" },
  { trigger: "TRIGGER:-PT5M", label: "5 minutes early" },
  { trigger: "TRIGGER:-PT30M", label: "30 minutes early" },
  { trigger: "TRIGGER:-PT1H", label: "1 hour early" },
  { trigger: "TRIGGER:-P1D", label: "1 day early" },
];

export function reminderLabel(trigger: string, allDay: boolean): string {
  const known = [...ALLDAY_REMINDERS, ...TIMED_REMINDERS, { trigger: "TRIGGER;RELATED=END:PT0S", label: "At end time" }].find((r) => r.trigger === trigger);
  if (known) return known.label;
  const m = /(-)?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(trigger);
  if (!m) return trigger;
  const [, neg, w, d, h, mi] = m;
  const parts: string[] = [];
  if (w) parts.push(`${w} week${w === "1" ? "" : "s"}`);
  if (d && d !== "0") parts.push(`${d} day${d === "1" ? "" : "s"}`);
  if (!allDay && h) parts.push(`${h} hour${h === "1" ? "" : "s"}`);
  if (!allDay && mi) parts.push(`${mi} minute${mi === "1" ? "" : "s"}`);
  if (allDay) return `${parts.join(" ") || "On the day"}${neg ? " early" : ""}`;
  return parts.length ? `${parts.join(" ")} ${neg ? "early" : "after"}` : "On time";
}

/** Timed custom reminder from days, hours and minutes before (RMD-011): 0/0/15 is TRIGGER:-PT15M (RMD-009). */
export function timedTrigger(days: number, hours: number, minutes: number): string {
  const d = Math.max(0, Math.floor(days || 0));
  const h = Math.max(0, Math.floor(hours || 0));
  const m = Math.max(0, Math.floor(minutes || 0));
  if (!d && !h && !m) return "TRIGGER:PT0S";
  return `TRIGGER:-P${d ? `${d}D` : ""}${h || m ? `T${h ? `${h}H` : ""}${m ? `${m}M` : ""}` : ""}`;
}

/** RMD-012: an all-day reminder becomes its timed equivalent once a time is set ("On the day" = on time). */
export function toTimedReminder(trigger: string): string {
  const m = /^TRIGGER:(-)?P(\d+)DT(\d+)H(\d+)M0S$/.exec(trigger);
  if (!m) return trigger;
  const [, neg, d, h, mi] = m;
  if (!neg) return Number(d) === 0 ? "TRIGGER:PT0S" : trigger;
  // -P{d}DT{h}H{m}M0S from midnight: d + 1 days early when h:m is not 0:00
  const daysEarly = Number(d) + (Number(h) || Number(mi) ? 1 : 0);
  return daysEarly === 7 ? "TRIGGER:-P7D" : `TRIGGER:-P${daysEarly}D`;
}

/** Custom reminder: N units before (timed) or N days before at HH:mm (all-day). */
function customTrigger(allDay: boolean, amount: number, unit: "m" | "h" | "d", hhmm: string): string {
  if (allDay) {
    const [h, m] = hhmm.split(":").map(Number);
    if (amount === 0) return `TRIGGER:P0DT${h}H${m}M0S`;
    const mins = amount * 1440 - (h! * 60 + m!);
    const dd = Math.floor(mins / 1440);
    const rem = mins - dd * 1440;
    return `TRIGGER:-P${dd}DT${Math.floor(rem / 60)}H${rem % 60}M0S`;
  }
  if (amount === 0) return "TRIGGER:PT0S";
  return unit === "d" ? `TRIGGER:-P${amount}D` : unit === "h" ? `TRIGGER:-PT${amount}H` : `TRIGGER:-PT${amount}M`;
}

export function repeatPresets(dayMs: number, weekStart: number): Array<{ label: string; hint: string; flag: string; repeatFrom?: string }> {
  const d = new Date(dayMs);
  const wkst = WD[weekStart]!;
  return [
    { label: "Daily", hint: "", flag: "RRULE:FREQ=DAILY;INTERVAL=1" },
    { label: "Weekly", hint: `(${WEEKDAYS_LONG[d.getDay()]})`, flag: `RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=${wkst};BYDAY=${WD[d.getDay()]}` },
    { label: "Monthly", hint: `(${ORD(d.getDate())})`, flag: `RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=${d.getDate()}` },
    { label: "Yearly", hint: `(${MONTHS_SHORT[d.getMonth()]} ${ORD(d.getDate())})`, flag: `RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=${d.getMonth() + 1};BYMONTHDAY=${d.getDate()}` },
    { label: "Every Weekday", hint: "(Mon - Fri)", flag: `RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=${wkst};BYDAY=MO,TU,WE,TH,FR`, repeatFrom: "2" },
  ];
}

export function repeatSummary(flag: string | undefined | null): string {
  if (!flag) return "";
  try {
    return describeRepeat(flag);
  } catch {
    return "Repeat";
  }
}

interface Draft {
  day: number | null; // local midnight of the start day
  minutes: number | null; // start time, null = all day
  endDay: number | null;
  endMinutes: number | null;
  reminders: string[];
  repeatFlag?: string;
  repeatFrom?: string;
  timeZone: string;
  annoyingAlert?: number;
}

function toDraft(v: DateValue): Draft {
  const s = parseDate(v.startDate ?? v.dueDate);
  const e = parseDate(v.dueDate);
  const timed = v.isAllDay === false;
  const mins = (ms: number): number => new Date(ms).getHours() * 60 + new Date(ms).getMinutes();
  return {
    day: Number.isNaN(s) ? null : startOfDay(s),
    minutes: !Number.isNaN(s) && timed ? mins(s) : null,
    endDay: !Number.isNaN(e) && e !== s ? startOfDay(timed ? e : e) : null,
    endMinutes: !Number.isNaN(e) && e !== s && timed ? mins(e) : null,
    reminders: v.reminders,
    repeatFlag: v.repeatFlag,
    repeatFrom: v.repeatFrom,
    timeZone: v.timeZone ?? deviceZone(),
    annoyingAlert: v.annoyingAlert,
  };
}

function fromDraft(d: Draft): DateValue {
  if (d.day === null) return { reminders: [] };
  const timed = d.minutes !== null;
  const start = d.day + (d.minutes ?? 0) * 60_000;
  const out: DateValue = { isAllDay: !timed, reminders: d.reminders, repeatFlag: d.repeatFlag, repeatFrom: d.repeatFrom, timeZone: d.timeZone, annoyingAlert: d.annoyingAlert };
  out.startDate = toServer(timed ? new Date(d.day).setHours(0, d.minutes!, 0, 0) : start);
  if (d.endDay !== null) {
    const end = timed ? new Date(d.endDay).setHours(0, d.endMinutes ?? d.minutes!, 0, 0) : d.endDay;
    out.dueDate = toServer(end);
  } else out.dueDate = out.startDate;
  return out;
}

const timeList = (): number[] => Array.from({ length: 48 }, (_, i) => i * 30);
const mm = (mins: number): string => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

function MonthGrid({ month, setMonth, selected, rangeEnd, onPick, weekStart, now, highlight }: { month: number; setMonth: (m: number) => void; selected: number | null; rangeEnd?: number | null; onPick: (day: number) => void; weekStart: number; now: number; highlight?: Set<number> }): JSX.Element {
  const first = new Date(month);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const gridStart = addDays(month, -lead);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const today = startOfDay(now);
  return (
    <div className="dp-month">
      <div className="dp-month-head">
        <span className="dp-month-title">
          {MONTHS_LONG[first.getMonth()]} {first.getFullYear()}
        </span>
        <span className="dp-month-nav">
          <button className="icon-btn sm" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
            <ChevronLeft size={14} />
          </button>
          <button className="icon-btn sm" aria-label="This month" onClick={() => setMonth(new Date(new Date(today).getFullYear(), new Date(today).getMonth(), 1).getTime())}>
            <Circle size={9} />
          </button>
          <button className="icon-btn sm" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
            <ChevronRight size={14} />
          </button>
        </span>
      </div>
      <div className="dp-week">
        {Array.from({ length: 7 }, (_, i) => (
          <span key={i}>{"SMTWTFS"[(i + weekStart) % 7]}</span>
        ))}
      </div>
      <div className="dp-days">
        {days.map((d) => {
          const out = new Date(d).getMonth() !== first.getMonth();
          const sel = selected !== null && d === selected;
          const inRange = selected !== null && rangeEnd != null && d > selected && d <= rangeEnd;
          return (
            <button
              key={d}
              data-day={new Date(d).getDate()}
              data-testid={out ? undefined : `dp-day-${new Date(d).getDate()}`}
              className={`dp-day${out ? " out" : ""}${sel ? " sel" : ""}${inRange || highlight?.has(d) ? " range" : ""}${d === today ? " today" : ""}`}
              onClick={() => onPick(d)}
            >
              {new Date(d).getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Custom repeat editor (By Due Dates / By Completion Date / By Specific Dates, Every N unit, weekdays, month and year options, ends, skips). */
function CustomRepeat({ dayMs, flag, repeatFrom, weekStart, now, onCancel, onOk }: { dayMs: number; flag?: string; repeatFrom?: string; weekStart: number; now: number; onCancel: () => void; onOk: (flag: string, repeatFrom: string) => void }): JSX.Element {
  const init = useMemo(() => {
    try {
      return flag ? parseRepeatFlag(flag) : null;
    } catch {
      return null;
    }
  }, [flag]);
  const d = new Date(dayMs);
  const [mode, setMode] = useState<"0" | "1" | "custom">(init?.erule?.name === "CUSTOM" ? "custom" : repeatFrom === "1" ? "1" : "0");
  const [interval, setIntervalN] = useState(init?.interval ?? 1);
  const [unit, setUnit] = useState<"DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY">((init?.freq as never) && ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(init!.freq!) ? (init!.freq as never) : "WEEKLY");
  const [days, setDays] = useState<Set<string>>(new Set(init?.byDay?.filter((b) => b.n === undefined).map((b) => b.day) ?? [WD[d.getDay()]!]));
  const nth = init?.byDay?.find((b) => b.n !== undefined);
  const [monthMode, setMonthMode] = useState<"date" | "week" | "last">(init?.byMonthDay?.[0] === -1 ? "last" : nth ? "week" : "date");
  const [monthDays, setMonthDays] = useState<number[]>(init?.byMonthDay?.filter((x) => x > 0) ?? [d.getDate()]);
  const [nthN, setNthN] = useState<number>(nth?.n ?? Math.min(5, Math.ceil(d.getDate() / 7)));
  const [nthDay, setNthDay] = useState<string>(nth?.day ?? WD[d.getDay()]!);
  const [ends, setEnds] = useState<"never" | "count" | "until">(init?.count ? "count" : init?.until ? "until" : "never");
  const [count, setCount] = useState(init?.count ?? 5);
  const [until, setUntil] = useState(init?.until ? `${init.until.slice(0, 4)}-${init.until.slice(4, 6)}-${init.until.slice(6, 8)}` : new Date(addMonths(dayMs, 1)).toISOString().slice(0, 10));
  const [skipH, setSkipH] = useState(init?.skip?.includes("HOLIDAY") ?? false);
  const [skipW, setSkipW] = useState(init?.skip?.includes("WEEKEND") ?? false);
  const [dates, setDates] = useState<Set<number>>(new Set((init?.erule?.name === "CUSTOM" ? init.erule.byDate : []).map((s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getTime())));
  const [month, setMonth] = useState(new Date(d.getFullYear(), d.getMonth(), 1).getTime());

  const build = (): string => {
    if (mode === "custom") {
      const list = [...dates].sort((a, b) => a - b).map((ms) => {
        const x = new Date(ms);
        return `${x.getFullYear()}${String(x.getMonth() + 1).padStart(2, "0")}${String(x.getDate()).padStart(2, "0")}`;
      });
      return `ERULE:NAME=CUSTOM;BYDATE=${list.join(",")}`;
    }
    const parts = [`FREQ=${unit}`, `INTERVAL=${Math.max(1, interval || 1)}`];
    if (unit === "WEEKLY") {
      parts.push(`WKST=${WD[weekStart]}`);
      if (mode === "0" && days.size) parts.push(`BYDAY=${WD.filter((w) => days.has(w)).join(",")}`);
    }
    if (unit === "MONTHLY" && mode === "0") {
      if (monthMode === "last") parts.push("BYMONTHDAY=-1");
      else if (monthMode === "week") parts.push(`BYDAY=${nthN}${nthDay}`);
      else parts.push(`BYMONTHDAY=${[...monthDays].sort((a, b) => a - b).join(",")}`);
    }
    if (unit === "YEARLY" && mode === "0") parts.push(`BYMONTH=${d.getMonth() + 1}`, `BYMONTHDAY=${d.getDate()}`);
    if (ends === "count") parts.push(`COUNT=${Math.max(1, count)}`);
    if (ends === "until") parts.push(`UNTIL=${until.replace(/-/g, "")}`);
    const skips = [skipH && "HOLIDAY", skipW && "WEEKEND"].filter(Boolean);
    if (skips.length) parts.push(`TT_SKIP=${skips.join(",")}`);
    return `RRULE:${parts.join(";")}`;
  };

  return (
    <div className="custom-repeat" data-testid="custom-repeat">
      <select className="field" value={mode} onChange={(e) => setMode(e.target.value as never)} aria-label="Repeat mode">
        <option value="0">By Due Dates</option>
        <option value="1">By Completion Date</option>
        <option value="custom">By Specific Dates</option>
      </select>
      {mode === "custom" ? (
        <MonthGrid
          month={month}
          setMonth={setMonth}
          selected={null}
          weekStart={weekStart}
          now={now}
          highlight={dates}
          onPick={(day) => {
            const n = new Set(dates);
            if (n.has(day)) n.delete(day);
            else n.add(day);
            setDates(n);
          }}
        />
      ) : (
        <>
          <div className="row gap">
            <label className="every">
              Every
              <input className="field num" type="number" min={1} value={interval} onChange={(e) => setIntervalN(Number(e.target.value))} aria-label="Interval" />
            </label>
            <select className="field" value={unit} onChange={(e) => setUnit(e.target.value as never)} aria-label="Unit">
              <option value="DAILY">Day</option>
              <option value="WEEKLY">Week</option>
              <option value="MONTHLY">Month</option>
              <option value="YEARLY">Year</option>
            </select>
          </div>
          {unit === "WEEKLY" && mode === "0" && (
            <div className="weekday-toggles">
              {Array.from({ length: 7 }, (_, i) => WD[(i + weekStart) % 7]!).map((w) => (
                <button key={w} className={`wd${days.has(w) ? " on" : ""}`} onClick={() => setDays((s) => { const n = new Set(s); if (n.has(w)) n.delete(w); else n.add(w); return n; })}>
                  {"SMTWTFS"[WD.indexOf(w)]}
                </button>
              ))}
            </div>
          )}
          {unit === "MONTHLY" && mode === "0" && (
            <div className="col gap-s">
              <select className="field" value={monthMode} onChange={(e) => setMonthMode(e.target.value as never)} aria-label="Monthly on">
                <option value="date">On date</option>
                <option value="week">On week</option>
                <option value="last">Last day of the month</option>
              </select>
              {monthMode === "date" && (
                <div className="monthday-grid">
                  {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                    <button key={n} className={`wd sm${monthDays.includes(n) ? " on" : ""}`} onClick={() => setMonthDays((s) => (s.includes(n) ? (s.length > 1 ? s.filter((x) => x !== n) : s) : [...s, n]))}>
                      {n}
                    </button>
                  ))}
                </div>
              )}
              {monthMode === "week" && (
                <div className="row gap">
                  <select className="field" value={nthN} onChange={(e) => setNthN(Number(e.target.value))} aria-label="Ordinal">
                    {[1, 2, 3, 4, 5, -1].map((n) => (
                      <option key={n} value={n}>{n === -1 ? "Last" : ["First", "Second", "Third", "Fourth", "Fifth"][n - 1]}</option>
                    ))}
                  </select>
                  <select className="field" value={nthDay} onChange={(e) => setNthDay(e.target.value)} aria-label="Weekday">
                    {WD.map((w, i) => (
                      <option key={w} value={w}>{WEEKDAYS_LONG[i]}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          <div className="row gap">
            <span className="muted">Ends</span>
            <select className="field" value={ends} onChange={(e) => setEnds(e.target.value as never)} aria-label="Ends">
              <option value="never">Endless</option>
              <option value="count">After N times</option>
              <option value="until">On a date</option>
            </select>
            {ends === "count" && <input className="field num" type="number" min={1} value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="Times" />}
            {ends === "until" && <input className="field" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Until" />}
          </div>
          <label className="check-row">
            <input type="checkbox" checked={skipH} disabled={unit === "YEARLY"} onChange={(e) => setSkipH(e.target.checked)} /> Skip Official Holidays
          </label>
          <label className="check-row">
            <input type="checkbox" checked={skipW} onChange={(e) => setSkipW(e.target.checked)} /> Skip weekends
          </label>
        </>
      )}
      <div className="row gap end">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" data-testid="custom-repeat-ok" onClick={() => onOk(build(), mode === "1" ? "1" : mode === "custom" ? "0" : "0")}>
          OK
        </button>
      </div>
    </div>
  );
}

export function DatePicker({ value, onChange, onClose, anchor }: { value: DateValue; onChange: (v: DateValue) => void; onClose: () => void; anchor: Anchor }): JSX.Element {
  const { settings, now } = useApp();
  const weekStart = weekStartIndex(settings.startDayOfWeek);
  const meridiem = settings.showMeridiem;
  const [d, setD] = useState<Draft>(() => toDraft(value));
  const [tab, setTab] = useState<"date" | "duration">(d.endDay !== null && d.minutes !== null ? "duration" : "date");
  const [month, setMonth] = useState(() => {
    const base = new Date(d.day ?? now);
    return new Date(base.getFullYear(), base.getMonth(), 1).getTime();
  });
  const [sub, setSub] = useState<{ kind: "time" | "reminder" | "repeat" | "custom" | "endTime"; anchor: Anchor } | null>(null);
  const [customRem, setCustomRem] = useState(false);
  const [remDraft, setRemDraft] = useState<string[] | null>(null);
  const [constDraft, setConstDraft] = useState<number | null>(null);
  const [cr, setCr] = useState({ amount: 0, unit: "m" as "m" | "h" | "d", hhmm: "09:00", d: 0, h: 0, m: 0 });
  const today = startOfDay(now);
  const allDay = d.minutes === null;

  const setDay = (day: number): void => setD((x) => ({ ...x, day, endDay: x.endDay !== null && x.endDay < day ? null : x.endDay }));
  const quick = (day: number, minutes: number | null = d.minutes): void => setD((x) => ({ ...x, day, minutes, endDay: null, endMinutes: null }));
  const commit = (): void => {
    onChange(fromDraft({ ...d, day: d.day ?? (d.minutes !== null || d.repeatFlag || d.reminders.length ? today : null) }));
    onClose();
  };
  // RMD-007, RMD-008: six rows each with Custom; At end time only for a task with an end time
  const remOptions = allDay ? ALLDAY_REMINDERS : d.endDay !== null || d.endMinutes !== null ? [...TIMED_REMINDERS, { trigger: "TRIGGER;RELATED=END:PT0S", label: "At end time" }] : TIMED_REMINDERS;
  const rems = remDraft ?? d.reminders;

  return (
    <Popover anchor={anchor} onClose={onClose} className="datepicker" testId="date-picker">
      <div className="seg">
        <button className={tab === "date" ? "on" : ""} onClick={() => setTab("date")}>Date</button>
        <button
          className={tab === "duration" ? "on" : ""}
          data-testid="dp-duration-tab"
          onClick={() => {
            setTab("duration");
            setD((x) => {
              const day = x.day ?? today;
              const minutes = x.minutes ?? Math.ceil((new Date(now).getHours() * 60 + new Date(now).getMinutes()) / 30) * 30 % 1440;
              const dur = settings.defaultTimeDuration || 60;
              const endAbs = minutes + dur;
              return { ...x, day, minutes, endDay: x.endDay ?? addDays(day, Math.floor(endAbs / 1440)), endMinutes: x.endMinutes ?? endAbs % 1440 };
            });
          }}
        >
          Duration
        </button>
      </div>
      {tab === "date" && (
        <div className="dp-quick">
          <button title="Today" aria-label="Today" data-testid="dp-today" onClick={() => quick(today)}><Sun size={20} /></button>
          <button title="Tomorrow" aria-label="Tomorrow" data-testid="dp-tomorrow" onClick={() => quick(addDays(today, 1))}><Sunrise size={20} /></button>
          <button title="Next week" aria-label="Next week" data-testid="dp-nextweek" onClick={() => quick(addDays(today, 7))}><CalendarPlus size={20} /></button>
          <button title="Tonight (20:00)" aria-label="Tonight" data-testid="dp-tonight" onClick={() => quick(today, 20 * 60)}><Moon size={20} /></button>
        </div>
      )}
      {tab === "duration" && (
        <div className="dp-duration">
          <div className="dur-row">
            <span className="muted">Start</span>
            <button className="chip-btn" onClick={() => setD((x) => ({ ...x }))}>{d.day !== null ? new Date(d.day).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "-"}</button>
            <button className="chip-btn" data-testid="dur-start-time" onClick={(e) => setSub({ kind: "time", anchor: anchorOf(e.currentTarget) })}>{d.minutes !== null ? formatTime(new Date(d.day ?? today).setHours(0, d.minutes, 0, 0), meridiem) : "Time"}</button>
          </div>
          <div className="dur-row">
            <span className="muted">End</span>
            <button className="chip-btn">{d.endDay !== null ? new Date(d.endDay).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "-"}</button>
            <button className="chip-btn" data-testid="dur-end-time" onClick={(e) => setSub({ kind: "endTime", anchor: anchorOf(e.currentTarget) })}>{d.endMinutes !== null ? formatTime(new Date(d.endDay ?? today).setHours(0, d.endMinutes, 0, 0), meridiem) : "Time"}</button>
          </div>
        </div>
      )}
      <MonthGrid
        month={month}
        setMonth={setMonth}
        selected={d.day}
        rangeEnd={tab === "duration" ? d.endDay : null}
        weekStart={weekStart}
        now={now}
        onPick={(day) => {
          if (tab === "duration" && d.day !== null && day > d.day && d.endDay === null) setD((x) => ({ ...x, endDay: day }));
          else if (tab === "duration" && d.day !== null && day >= d.day) setD((x) => ({ ...x, endDay: day }));
          else setDay(day);
        }}
      />
      <div className="dp-rows">
        {tab === "date" && (
          <div className={`dp-row${d.minutes !== null ? " set" : ""}`}>
            <button className="dp-row-main" data-testid="dp-time" onClick={(e) => setSub({ kind: "time", anchor: anchorOf(e.currentTarget) })}>
              <Clock size={16} />
              <span>{d.minutes !== null ? formatTime(new Date(today).setHours(0, d.minutes, 0, 0), meridiem) : "Time"}</span>
            </button>
            {d.minutes !== null ? (
              <button className="icon-btn sm" aria-label="Clear time" onClick={() => setD((x) => ({ ...x, minutes: null, endMinutes: null, reminders: [] }))}><X size={13} /></button>
            ) : (
              <ChevronRight size={14} className="muted" />
            )}
          </div>
        )}
        <div className={`dp-row${d.reminders.length ? " set" : ""}`}>
          <button className="dp-row-main" data-testid="dp-reminder" onClick={(e) => { setRemDraft(null); setConstDraft(null); setSub({ kind: "reminder", anchor: anchorOf(e.currentTarget) }); }}>
            <AlarmClock size={16} />
            <span>{d.reminders.length ? d.reminders.map((r) => reminderLabel(r, allDay)).join(", ") : "Reminder"}</span>
          </button>
          {d.reminders.length ? (
            <button className="icon-btn sm" aria-label="Clear reminders" onClick={() => setD((x) => ({ ...x, reminders: [] }))}><X size={13} /></button>
          ) : (
            <ChevronRight size={14} className="muted" />
          )}
        </div>
        <div className={`dp-row${d.repeatFlag ? " set" : ""}`}>
          <button className="dp-row-main" data-testid="dp-repeat" onClick={(e) => setSub({ kind: "repeat", anchor: anchorOf(e.currentTarget) })}>
            <Repeat size={16} />
            <span>{d.repeatFlag ? repeatSummary(d.repeatFlag) : "Repeat"}</span>
          </button>
          {d.repeatFlag ? (
            <button className="icon-btn sm" aria-label="Clear repeat" onClick={() => setD((x) => ({ ...x, repeatFlag: undefined, repeatFrom: undefined }))}><X size={13} /></button>
          ) : (
            <ChevronRight size={14} className="muted" />
          )}
        </div>
      </div>
      <div className="dp-actions">
        <button className="btn" data-testid="dp-clear" onClick={() => { onChange({ reminders: [] }); onClose(); }}>Clear</button>
        <button className="btn primary" data-testid="dp-ok" onClick={commit}>OK</button>
      </div>

      {sub && (sub.kind === "time" || sub.kind === "endTime") && (
        <Popover anchor={sub.anchor} placement="bottom-start" onClose={() => setSub(null)} className="time-list" testId="time-list">
          {settings.isTimeZoneOptionEnabled && sub.kind === "time" && (
            <div className="tz-row">
              <select className="field" aria-label="Time zone" value={d.timeZone} onChange={(e) => setD((x) => ({ ...x, timeZone: e.target.value }))}>
                {[...new Set([deviceZone(), d.timeZone, ...((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"])])].map((z) => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </div>
          )}
          <div className="time-scroll">
            {timeList().map((m) => (
              <button
                key={m}
                className={`time-opt${(sub.kind === "time" ? d.minutes : d.endMinutes) === m ? " on" : ""}`}
                data-testid={`time-${mm(m)}`}
                onClick={() => {
                  if (sub.kind === "time") {
                    setD((x) => {
                      const keepDur = x.endDay !== null && x.minutes !== null && x.endMinutes !== null;
                      const dur = keepDur ? (x.endDay! - x.day!) / 60000 + x.endMinutes! - x.minutes! : 0;
                      const reminders = x.minutes === null && x.reminders.length === 0 ? [...(settings.defaultReminds ?? [])] : x.minutes === null ? [...new Set(x.reminders.map(toTimedReminder))] : x.reminders;
                      if (keepDur) {
                        const endAbs = m + dur;
                        return { ...x, day: x.day ?? today, minutes: m, endDay: addDays(x.day ?? today, Math.floor(endAbs / 1440)), endMinutes: ((endAbs % 1440) + 1440) % 1440, reminders };
                      }
                      return { ...x, day: x.day ?? today, minutes: m, reminders };
                    });
                  } else setD((x) => ({ ...x, endDay: x.endDay ?? x.day ?? today, endMinutes: m }));
                  setSub(null);
                }}
              >
                {formatTime(new Date(today).setHours(0, m, 0, 0), meridiem)}
              </button>
            ))}
          </div>
        </Popover>
      )}

      {sub?.kind === "reminder" && (
        <Popover anchor={sub.anchor} onClose={() => setSub(null)} className="rem-list" testId="reminder-list">
          {!customRem ? (
            <>
              {remOptions.map((r) => (
                <label key={r.trigger} className="check-row">
                  <input type="checkbox" checked={rems.includes(r.trigger)} onChange={() => setRemDraft(rems.includes(r.trigger) ? rems.filter((x) => x !== r.trigger) : [...rems, r.trigger])} />
                  {r.label}
                </label>
              ))}
              {rems.filter((r) => !remOptions.some((o) => o.trigger === r)).map((r) => (
                <label key={r} className="check-row">
                  <input type="checkbox" checked onChange={() => setRemDraft(rems.filter((x) => x !== r))} />
                  {reminderLabel(r, allDay)}
                </label>
              ))}
              <button className="menu-item" data-testid="reminder-custom" onClick={() => setCustomRem(true)}>Custom</button>
              <div className="rem-constant">
                <span>Constant Reminder</span>
                <Switch testId="reminder-constant" checked={(constDraft ?? d.annoyingAlert) === -1} onChange={(v) => setConstDraft(v ? -1 : 0)} />
              </div>
              <div className="row gap end">
                <button className="btn" onClick={() => setSub(null)}>Cancel</button>
                <button
                  className="btn primary"
                  data-testid="reminder-ok"
                  onClick={() => {
                    setD((x) => ({ ...x, day: x.day ?? today, reminders: rems, annoyingAlert: constDraft ?? x.annoyingAlert }));
                    try {
                      localStorage.setItem(allDay ? "recentDateReminderSet" : "recentTimeReminderSet", JSON.stringify(rems));
                    } catch {
                      /* quota */
                    }
                    setSub(null);
                  }}
                >
                  OK
                </button>
              </div>
            </>
          ) : (
            <div className="col gap-s">
              <div className="strong small">Custom reminder</div>
              {allDay ? (
                <div className="row gap">
                  <input className="field num" type="number" min={0} value={cr.amount} onChange={(e) => setCr({ ...cr, amount: Number(e.target.value) })} aria-label="Days early" data-testid="custom-days-early" />
                  <span>days early at</span>
                  <input className="field" type="time" value={cr.hhmm} onChange={(e) => setCr({ ...cr, hhmm: e.target.value })} aria-label="Time" data-testid="custom-time" />
                </div>
              ) : (
                <div className="rem-dhm">
                  <label><input className="field num" type="number" min={0} value={cr.d} onChange={(e) => setCr({ ...cr, d: Number(e.target.value) })} data-testid="custom-d" /> days</label>
                  <label><input className="field num" type="number" min={0} max={23} value={cr.h} onChange={(e) => setCr({ ...cr, h: Number(e.target.value) })} data-testid="custom-h" /> hours</label>
                  <label><input className="field num" type="number" min={0} max={59} value={cr.m} onChange={(e) => setCr({ ...cr, m: Number(e.target.value) })} data-testid="custom-m" /> minutes</label>
                  <span className="muted small">before</span>
                </div>
              )}
              <div className="row gap end">
                <button className="btn" onClick={() => setCustomRem(false)}>Cancel</button>
                <button className="btn primary" data-testid="custom-ok" onClick={() => { setRemDraft([...new Set([...rems, allDay ? customTrigger(true, cr.amount, cr.unit, cr.hhmm) : timedTrigger(cr.d, cr.h, cr.m)])]); setCustomRem(false); }}>OK</button>
              </div>
            </div>
          )}
        </Popover>
      )}

      {sub?.kind === "repeat" && (
        <Popover anchor={sub.anchor} onClose={() => setSub(null)} className="repeat-list" testId="repeat-list">
          <div className="menu">
            {repeatPresets(d.day ?? today, weekStart).map((p, i) => (
              <div key={p.label}>
                {i === 4 && <div className="menu-divider" />}
                <button
                  className={`menu-item${d.repeatFlag === p.flag ? " on" : ""}`}
                  data-testid={`repeat-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
                  onClick={() => { setD((x) => ({ ...x, day: x.day ?? today, repeatFlag: p.flag, repeatFrom: p.repeatFrom ?? "2" })); setSub(null); }}
                >
                  <span className="menu-label">{p.label} <span className="muted">{p.hint}</span></span>
                </button>
              </div>
            ))}
            <div className="menu-divider" />
            <button className="menu-item" data-testid="repeat-custom" onClick={(e) => setSub({ kind: "custom", anchor: anchorOf(e.currentTarget) })}>
              <span className="menu-label">Custom</span>
            </button>
          </div>
        </Popover>
      )}
      {sub?.kind === "custom" && (
        <Popover anchor={sub.anchor} onClose={() => setSub(null)} className="custom-pop">
          <CustomRepeat
            dayMs={d.day ?? today}
            flag={d.repeatFlag}
            repeatFrom={d.repeatFrom}
            weekStart={weekStart}
            now={now}
            onCancel={() => setSub(null)}
            onOk={(flag, rf) => { setD((x) => ({ ...x, day: x.day ?? today, repeatFlag: flag, repeatFrom: rf })); setSub(null); }}
          />
        </Popover>
      )}
    </Popover>
  );
}

export function taskDateValue(t: { startDate?: string | null; dueDate?: string | null; isAllDay?: boolean | null; reminders?: Array<{ trigger: string }>; repeatFlag?: string | null; repeatFrom?: string | null; timeZone?: string; annoyingAlert?: number | null }): DateValue {
  return {
    startDate: t.startDate ?? undefined,
    dueDate: t.dueDate ?? undefined,
    isAllDay: t.isAllDay ?? undefined,
    reminders: (t.reminders ?? []).map((r) => r.trigger),
    repeatFlag: t.repeatFlag ?? undefined,
    repeatFrom: t.repeatFrom ?? undefined,
    timeZone: t.timeZone,
    annoyingAlert: t.annoyingAlert ?? undefined,
  };
}

export { DAY };
