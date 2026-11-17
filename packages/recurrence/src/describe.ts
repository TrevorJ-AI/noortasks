import { civilFromDays } from "./civil";
import { parseRepeatFlag } from "./flag";
import type { RepeatModel } from "./model";

const DOW: Record<string, string> = { SU: "Sun", MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CAL_LABEL: Record<string, string> = {
  LUNAR: "Lunar", KOREAN: "Korean lunar", HEBCAL: "Hebrew", SHAKA: "Indian", PERSIAN: "Persian",
  VIETNAM: "Vietnamese lunar", HIJRI: "Hijri", KUWAITI: "Hijri (Kuwaiti)", SAUDI: "Hijri (Saudi)",
};

export function ordinal(n: number): string {
  const a = Math.abs(n);
  const s = a % 100 >= 11 && a % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][a % 10] ?? "th");
  return `${a}${a % 10 > 3 ? "th" : s}`;
}
const ordWord = (n: number) => (n === -1 ? "last" : n < 0 ? `${ordinal(n)} last` : ordinal(n));

function untilText(u: string): string {
  const d = civilFromDays(Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8)) / 86400000);
  return `${MONTHS[d.m - 1]} ${d.d}, ${d.y}`;
}

const listDays = (m: RepeatModel) => m.byDay.map((b) => DOW[b.day]).join(", ");
const isWeekdaySet = (m: RepeatModel, want: string[]) =>
  m.byDay.length === want.length && want.every((w) => m.byDay.some((b) => b.day === w && b.n === undefined));

/** Human summary for the repeat picker, English only (see OPEN-QUESTIONS). */
export function describeRepeat(input: RepeatModel | string | null | undefined, locale: "en" = "en"): string {
  void locale;
  const m = typeof input === "string" || input == null ? parseRepeatFlag(input) : input;
  if (!m) return "";
  const interval = m.interval ?? 1;
  let text: string;

  if (m.prefix === "ERULE" && m.erule) {
    if (m.erule.name === "CUSTOM") {
      const n = m.erule.byDate.length;
      text = `Custom dates (${n} ${n === 1 ? "date" : "dates"})`;
    } else {
      text = `Forgetting curve; ${ordinal(m.erule.cycle + 1)}`;
    }
  } else {
    const has = (k: string) => m.skip.includes(k as never);
    const every = (unit: string, plural: string) => (interval === 1 ? null : `Every ${interval} ${plural}`) ?? unit;
    void every;
    const bySet = m.bySetPos.length ? m.bySetPos : null;
    switch (m.freq) {
      case "DAILY":
        if (has("OFFICIAL_WORKDAY") && interval === 1) text = "Official holidays";
        else if (has("HOLIDAY") && has("WEEKEND") && interval === 1) text = "Official working days";
        else text = interval === 1 ? "Daily" : `Every ${interval} days`;
        break;
      case "WEEKLY": {
        if (interval === 1 && isWeekdaySet(m, ["MO", "TU", "WE", "TH", "FR"])) text = "Every workday";
        else if (interval === 1 && isWeekdaySet(m, ["SA", "SU"])) text = "Every weekend";
        else {
          text = interval === 1 ? "Weekly" : `Every ${interval} weeks`;
          if (m.byDay.length) text += ` on ${listDays(m)}`;
        }
        break;
      }
      case "MONTHLY": {
        text = interval === 1 ? "Monthly" : `Every ${interval} months`;
        if (m.workday !== undefined) text += m.workday === 1 ? " on the first workday" : " on the last workday";
        else if (m.byDay.length) {
          const parts = m.byDay.map((b) => (b.n !== undefined ? `${ordWord(b.n)} ${DOW[b.day]}` : DOW[b.day]!));
          const sp = bySet && !m.byDay.some((b) => b.n !== undefined) ? `${bySet.map(ordWord).join(", ")} ` : "";
          text += ` on the ${sp}${parts.join(", ")}`;
        } else if (m.byMonthDay.length) {
          const parts = m.byMonthDay.map((d) => (d === -1 ? "last day" : d < 0 ? `${ordinal(d)} last day` : ordinal(d)));
          text += ` on the ${parts.join(", ")}`;
        }
        break;
      }
      case "YEARLY": {
        text = interval === 1 ? "Yearly" : `Every ${interval} years`;
        const mo = m.byMonth.map((x) => MONTHS[x - 1]).filter(Boolean).join(", ");
        if (m.byDay.length && m.byMonth.length) {
          const parts = m.byDay.map((b) => (b.n !== undefined ? `${ordWord(b.n)} ${DOW[b.day]}` : DOW[b.day]!));
          text += ` on the ${parts.join(", ")} of ${mo}`;
        } else if (m.byMonth.length && m.byMonthDay.length) {
          text += ` on ${mo} ${m.byMonthDay.map((d) => (d === -1 ? "last day" : ordinal(d))).join(", ")}`;
        } else if (m.byMonth.length) text += ` in ${mo}`;
        break;
      }
      default:
        text = `${m.freq ?? "Custom"} repeat`;
    }
    if (m.skip.length && !(m.freq === "DAILY" && interval === 1 && (has("OFFICIAL_WORKDAY") || (has("HOLIDAY") && has("WEEKEND"))))) {
      const bits: string[] = [];
      if (has("HOLIDAY")) bits.push("holidays");
      if (has("WEEKEND")) bits.push("weekends");
      if (has("OFFICIAL_WORKDAY")) bits.push("working days");
      text += `, skipping ${bits.join(" and ")}`;
    }
  }
  if (m.prefix && m.prefix !== "RRULE" && m.prefix !== "ERULE") text = `${CAL_LABEL[m.prefix] ?? m.prefix}: ${text}`;
  if (m.count !== undefined) text += `; In ${m.count} ${m.count === 1 ? "time" : "times"}`;
  if (m.until) text += `; Until ${untilText(m.until)}`;
  return text;
}
