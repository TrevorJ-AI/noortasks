import { Activity as ActivityIcon, AlarmClock, ArrowRightLeft, Calendar, Check, CircleSlash, Flag, Hash, MessageSquare, Paperclip, Pencil, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ActivityEntry } from "../lib/core";
import { formatTime, parseDate } from "../lib/dates";
import { useApp } from "./ctx";
import { Modal } from "./primitives";

/** Task and list activity logs (TASK-055, TASK-121, TASK-122, PREM-106, PREM-107). */

const PRIORITY: Record<string, string> = { "0": "None", "1": "Low", "3": "Medium", "5": "High" };

function short(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" ? (x as { title?: string; trigger?: string }).title ?? (x as { trigger?: string }).trigger ?? "" : String(x))).join(", ") : "none";
  if (typeof v === "object") return "changed";
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}T/.test(s) ? parseDate(s) : NaN;
  if (!Number.isNaN(d)) return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

export function activitySentence(a: ActivityEntry, listName: (id: string) => string): { icon: JSX.Element; text: string } {
  const o = a.oldValue;
  const n = a.newValue;
  switch (a.action) {
    case "T_CREATE":
      return { icon: <Plus size={14} />, text: "Created the task" };
    case "T_COMPLETE":
      return { icon: <Check size={14} />, text: "Completed the task" };
    case "T_WONTDO":
      return { icon: <CircleSlash size={14} />, text: "Marked the task Won't Do" };
    case "T_REOPEN":
      return { icon: <RotateCcw size={14} />, text: "Reopened the task" };
    case "T_TITLE":
      return { icon: <Pencil size={14} />, text: `Renamed from "${short(o)}" to "${short(n)}"` };
    case "T_CONTENT":
      return { icon: <Pencil size={14} />, text: "Edited the description" };
    case "T_DUE":
      return { icon: <Calendar size={14} />, text: `Changed the date from ${short(o)} to ${short(n)}` };
    case "T_PRIORITY":
      return { icon: <Flag size={14} />, text: `Changed priority from ${PRIORITY[String(o ?? 0)] ?? short(o)} to ${PRIORITY[String(n ?? 0)] ?? short(n)}` };
    case "T_TAG":
      return { icon: <Hash size={14} />, text: `Changed tags to ${short(n)}` };
    case "T_REMINDER":
      return { icon: <AlarmClock size={14} />, text: a.field === "snoozeReminderTime" ? `Snoozed the reminder to ${n ? formatTime(parseDate(String(n)), false) : "later"}` : "Changed reminders" };
    case "T_REPEAT":
      return { icon: <RotateCcw size={14} />, text: n ? "Changed the repeat" : "Removed the repeat" };
    case "T_ITEMS":
      return { icon: <Check size={14} />, text: "Edited the checklist" };
    case "T_MOVE":
      return { icon: <ArrowRightLeft size={14} />, text: `Moved from ${listName(String(o ?? "")) || "another list"} to ${listName(String(n ?? "")) || "another list"}` };
    case "T_PARENT":
      return { icon: <ArrowRightLeft size={14} />, text: n ? "Made it a subtask" : "Made it a top-level task" };
    case "T_TRASH":
      return { icon: <Trash2 size={14} />, text: "Moved to the Trash" };
    case "T_RESTORE":
      return { icon: <RotateCcw size={14} />, text: "Restored from the Trash" };
    case "T_DELETE":
      return { icon: <X size={14} />, text: "Deleted for good" };
    case "T_ATTACH_ADD":
      return { icon: <Paperclip size={14} />, text: a.summary || `Added attachment ${short(n)}` };
    case "T_ATTACH_DEL":
      return { icon: <Paperclip size={14} />, text: "Removed an attachment" };
    case "T_COMMENT_ADD":
      return { icon: <MessageSquare size={14} />, text: "Added a comment" };
    case "T_COMMENT_EDIT":
      return { icon: <MessageSquare size={14} />, text: "Edited a comment" };
    case "T_COMMENT_DEL":
      return { icon: <MessageSquare size={14} />, text: "Deleted a comment" };
    default:
      return { icon: <ActivityIcon size={14} />, text: a.summary || a.action };
  }
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const diff = Math.round((t.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === t.getFullYear() ? undefined : "numeric" });
}

/** Task Activities (task menu) or List Activities (list menu): grouped by day, newest first, paged by 50. */
export function ActivityDialog({ taskId, projectId, title }: { taskId?: string; projectId?: string; title: string }): JSX.Element {
  const app = useApp();
  const [rows, setRows] = useState<ActivityEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [err, setErr] = useState("");
  const path = taskId ? `/api/v1/task/activity/${taskId}` : `/api/v1/project/${projectId}/activity`;
  const load = async (offset: number): Promise<void> => {
    try {
      await app.engine.sync(); // local edits first, so the log includes them
      const page = await app.engine.api.get<ActivityEntry[]>(`${path}?limit=50&offset=${offset}`);
      setRows((r) => [...(offset ? (r ?? []) : []), ...page]);
      setMore(page.length === 50);
    } catch {
      setErr("The activity log needs the server: try again when online.");
      setRows((r) => r ?? []);
    }
  };
  useEffect(() => void load(0), [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const groups: Array<{ day: string; items: ActivityEntry[] }> = [];
  for (const a of rows ?? []) {
    const ms = typeof a.when === "number" ? a.when : parseDate(a.createdTime);
    const day = dayLabel(ms);
    if (groups[groups.length - 1]?.day !== day) groups.push({ day, items: [] });
    groups[groups.length - 1]!.items.push(a);
  }
  const setModal = app.setModal;
  const close = useCallback((): void => setModal(null), [setModal]);
  return (
    <Modal onClose={close} className="activity-modal" testId="activity-dialog">
      <div className="row gap">
        <ActivityIcon size={17} />
        <h3 className="grow ellipsis">{taskId ? "Task Activities" : "List Activities"}</h3>
        <button className="icon-btn sm" aria-label="Close" onClick={close}><X size={16} /></button>
      </div>
      <div className="muted small ellipsis">{title}</div>
      <div className="act-list" data-testid="activity-list">
        {rows === null && <div className="muted pad">Loading...</div>}
        {err && <div className="muted pad">{err}</div>}
        {rows !== null && rows.length === 0 && !err && <div className="muted pad">No activity yet</div>}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="act-day">{g.day}</div>
            {g.items.map((a) => {
              const s = activitySentence(a, app.projectName);
              const ms = typeof a.when === "number" ? a.when : parseDate(a.createdTime);
              return (
                <div key={a.id} className="act-row" data-testid="activity-row" data-action={a.action}>
                  <span className="act-icon">{s.icon}</span>
                  <span className="act-text">
                    {!taskId && a.taskTitle && <span className="act-task">{a.taskTitle}</span>}
                    <span>{s.text}</span>
                  </span>
                  <span className="act-time">{formatTime(ms, app.settings.showMeridiem)}</span>
                </div>
              );
            })}
          </div>
        ))}
        {more && (
          <button className="btn sm full" onClick={() => void load(rows?.length ?? 0)}>Load more</button>
        )}
      </div>
    </Modal>
  );
}
