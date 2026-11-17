import { Timer, Activity, ArrowUpRight, CalendarCheck, CalendarClock, CalendarPlus, Copy, Download, FileText, Flag, GitBranchPlus, Hash, Link as LinkIcon, List as ListIcon, ListTree, Paperclip, Pin, Printer, Save, Sun, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import type { Task } from "../lib/core";
import { addDays, startOfDay, toServer } from "../lib/dates";
import { go, routeTaskPath } from "../model/router";
import type { App } from "./ctx";
import { saveAsTemplate } from "./Templates";
import { PRIORITIES, PriorityFlag, type MenuItem } from "./primitives";
import { moveToDay } from "./taskutil";

function TagChecklist({ app, task }: { app: App; task: Task }): JSX.Element {
  const [sel, setSel] = useState(new Set((task.tags ?? []).map((t) => t.toLowerCase())));
  return (
    <div className="menu tag-list">
      {app.tags.length === 0 && <div className="empty-note">No tags yet</div>}
      {app.tags.map((t) => (
        <label key={t.name} className="check-row">
          <input
            type="checkbox"
            checked={sel.has(t.name)}
            onChange={() => {
              const n = new Set(sel);
              if (n.has(t.name)) n.delete(t.name);
              else n.add(t.name);
              setSel(n);
              void app.repo.updateTask(task.id, { tags: [...n] });
            }}
          />
          <Hash size={13} color={t.color ?? undefined} /> {t.label ?? t.name}
        </label>
      ))}
    </div>
  );
}

function ListMenu({ app, task }: { app: App; task: Task }): JSX.Element {
  return (
    <div className="menu">
      {[{ id: app.inboxId, name: "Inbox" }, ...app.projects.filter((p) => !p.closed)].map((p) => (
        <button key={p.id} className={`menu-item${task.projectId === p.id ? " on" : ""}`} onClick={() => void app.repo.moveTasks([task.id], p.id).then(() => app.toast(`Moved to ${p.name}`, () => void app.repo.undo()))}>
          <span className="menu-icon"><ListIcon size={14} /></span>
          <span className="menu-label">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

export function pickFile(onFile: (f: File) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = () => Array.from(input.files ?? []).forEach(onFile);
  input.click();
}

export function taskMarkdown(t: Task, all: Task[]): string {
  const lines = [`# ${t.title}`];
  if (t.content) lines.push("", t.content);
  if (t.desc) lines.push("", t.desc);
  for (const it of t.items ?? []) lines.push(`${it.status ? "- " : "- [ ] "}${it.title}`);
  for (const k of all.filter((x) => x.parentId === t.id && !x.deleted)) lines.push(`- [${k.status ? "x" : " "}] ${k.title}`);
  return lines.join("\n");
}

/** The task "..." menu (TASK-048 order) and, with context, the right-click menu with dates and priority on top. */
export function taskMenuItems(app: App, t: Task, opts: { context?: boolean; openTask?: () => void } = {}): MenuItem[] {
  const { repo, toast } = app;
  const undoToast = (msg: string) => () => toast(msg, () => void repo.undo());
  const today = startOfDay(app.now);
  const addSubtask = async (): Promise<void> => {
    const c = await repo.createTask({ title: "", projectId: t.projectId, parentId: t.id });
    location.hash = routeTaskPath(app.route, c.id);
  };
  const items: MenuItem[] = [];
  if (opts.context) {
    items.push(
      { label: "Today", icon: <Sun size={15} />, onClick: () => void repo.updateTask(t.id, moveToDay(t, today), { undo: "Date changed" }) },
      { label: "Tomorrow", icon: <CalendarCheck size={15} />, onClick: () => void repo.updateTask(t.id, moveToDay(t, addDays(today, 1)), { undo: "Date changed" }) },
      { label: "Next Week", icon: <CalendarPlus size={15} />, onClick: () => void repo.updateTask(t.id, moveToDay(t, addDays(today, 7)), { undo: "Date changed" }) },
      { label: "Clear Date", icon: <CalendarClock size={15} />, onClick: () => void repo.updateTask(t.id, { startDate: undefined, dueDate: undefined, isAllDay: undefined, reminders: [] }, { undo: "Date cleared" }) },
      {
        label: "Priority",
        icon: <Flag size={15} />,
        submenu: () => (
          <div className="menu">
            {PRIORITIES.map((p) => (
              <button key={p.value} className={`menu-item${(t.priority ?? 0) === p.value ? " on" : ""}`} onClick={() => void repo.updateTask(t.id, { priority: p.value })}>
                <span className="menu-icon"><PriorityFlag value={p.value} /></span>
                <span className="menu-label">{p.label}</span>
              </button>
            ))}
          </div>
        ),
      },
      { label: "Move to", icon: <ArrowUpRight size={15} />, submenu: () => <ListMenu app={app} task={t} /> },
      { divider: true, label: "" },
    );
  }
  const isNote = t.kind === "NOTE";
  const pomoEnabled = (app.settings.tabBars ?? []).some((b) => b.name === "POMO" && b.enabled);
  // FOC-042: start focus from a task (menu item and a detail button)
  if (pomoEnabled && !isNote && t.status === 0) items.push({ label: "Start Focus", icon: <Timer size={15} />, testId: "menu-start-focus", onClick: () => void setTimeout(() => go("focus", { task: t.id, start: "1" }), 0) }); // deferred: the click bubbles (through the portal) to the row, which opens the task
  items.push(
    { label: "Add Subtask", icon: <ListTree size={15} />, onClick: () => void addSubtask(), disabled: isNote, testId: "menu-add-subtask" },
    { label: "Link Parent Task", icon: <GitBranchPlus size={15} />, onClick: () => app.setModal({ kind: "linkParent", taskIds: [t.id] }) },
    {
      label: t.pinnedTime ? "Unpin" : "Pin",
      icon: <Pin size={15} />,
      testId: "menu-pin",
      onClick: () => void repo.updateTask(t.id, { pinnedTime: t.pinnedTime ? undefined : toServer(Date.now()) }, { undo: t.pinnedTime ? "Unpinned" : "Pinned" }),
    },
    {
      label: t.status === -1 ? "Reopen" : "Won't Do",
      icon: <XCircle size={15} />,
      disabled: isNote,
      testId: "menu-wontdo",
      onClick: () => void (t.status === -1 ? repo.toggleComplete(t.id).then(undoToast("Task reopened")) : repo.setWontDo(t.id).then(undoToast("Marked as Won't Do"))),
    },
    { label: "Tags", icon: <Hash size={15} />, submenu: () => <TagChecklist app={app} task={t} /> },
    { label: "Upload Attachment", icon: <Paperclip size={15} />, testId: "menu-upload", onClick: () => pickFile((f) => void repo.addAttachment(t.id, f, f.name)) },
    { label: "Task Activities", icon: <Activity size={15} />, testId: "menu-activity", onClick: () => app.setModal({ kind: "activity", taskId: t.id, projectId: t.projectId, title: t.title }) },
    { label: "Save as Template", icon: <Save size={15} />, testId: "menu-save-template", onClick: () => void saveAsTemplate(app, t) },
    {
      label: "Duplicate",
      icon: <Copy size={15} />,
      testId: "menu-duplicate",
      onClick: () => {
        const hasKids = app.tasks.some((k) => k.parentId === t.id && !k.deleted);
        if (!hasKids) return void repo.duplicateTask(t.id, false).then(() => toast("Task duplicated"));
        app.setModal({
          kind: "confirm",
          title: "Duplicate task",
          body: "Keep the subtasks in the copy?",
          ok: "Keep subtasks",
          onOk: () => void repo.duplicateTask(t.id, true).then(() => toast("Task duplicated")),
          alt: { label: "Task only", onClick: () => void repo.duplicateTask(t.id, false).then(() => toast("Task duplicated")) },
        });
      },
    },
    {
      label: "Copy Link",
      icon: <LinkIcon size={15} />,
      onClick: () => {
        const url = `${location.origin}${location.pathname}#p/${t.projectId}/tasks/${t.id}`;
        void navigator.clipboard?.writeText(url).then(
          () => toast("Link copied"),
          () => toast(url),
        );
      },
    },
    {
      label: isNote ? "Convert to Task" : "Convert to Note",
      icon: <FileText size={15} />,
      testId: "menu-convert-note",
      onClick: () => void repo.convertKind(t.id, isNote ? "TEXT" : "NOTE").then((err) => (err ? toast(err) : toast(isNote ? "Converted to task" : "Converted to note", () => void repo.undo()))),
    },
    {
      label: "Export",
      icon: <Download size={15} />,
      onClick: () => {
        const blob = new Blob([taskMarkdown(t, app.tasks)], { type: "text/markdown" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${t.title.replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "task"}.md`;
        a.click();
        URL.revokeObjectURL(a.href);
      },
    },
    { label: "Print", icon: <Printer size={15} />, onClick: () => app.setModal({ kind: "print", taskIds: [t.id], title: t.title }) },
    { label: "Delete", icon: <Trash2 size={15} />, danger: true, testId: "menu-delete", onClick: () => void repo.trashIds([t.id]).then(undoToast("Task deleted")) },
  );
  return items;
}
