import { AlarmClock, Calendar, CheckSquare, ChevronLeft, Flag, Hash, List as ListIcon, ListChecks, MessageSquare, MoreHorizontal, Plus, Type, X } from "lucide-react";
import { renderMarkdown } from "../lib/markdown";
export { renderMarkdown } from "../lib/markdown";
import { useEffect, useMemo, useRef, useState } from "react";
import { ORDER_STEP, newId, type ChecklistItem, type Task } from "../lib/core";
import { chipLabel, formatTime, isOverdue, parseDate, taskStart } from "../lib/dates";
import { routeTaskPath } from "../model/router";
import { DatePicker, reminderLabel, repeatSummary, taskDateValue } from "./DatePicker";
import { AttachmentGrid, VoiceMemoButton, clipboardFiles, useFileDrop } from "./Attach";
import { CommentsPanel } from "./Comments";
import { TemplatePicker } from "./Templates";
import { canEditProject, isSharedProject } from "../data/accounts";
import { AssignButton } from "./Members";
import { useApp } from "./ctx";
import { Checkbox, Menu, Popover, PRIORITY_COLOR, anchorOf, type Anchor } from "./primitives";
import { ListPicker, PriorityMenu, TagPicker } from "./pickers";
import { pickFile, taskMenuItems } from "./taskMenu";
import { datePatch } from "./taskutil";
import { TaskFocusLine } from "./Focus";

const SLASH_COMMANDS: Array<{ label: string; insert: string }> = [
  { label: "Heading 1", insert: "# " },
  { label: "Heading 2", insert: "## " },
  { label: "Heading 3", insert: "### " },
  { label: "Bulleted list", insert: "- " },
  { label: "Numbered list", insert: "1. " },
  { label: "Checklist", insert: "- [ ] " },
  { label: "Quote", insert: "> " },
  { label: "Divider", insert: "---\n" },
  { label: "Code block", insert: "```\n\n```" },
  { label: "Template", insert: "" },
];

function useDebouncedSave<T>(value: T, save: (v: T) => void, ms = 400): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => save(value), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
}

function Body({ task }: { task: Task }): JSX.Element {
  const { repo } = useApp();
  const field = task.kind === "CHECKLIST" ? "desc" : "content";
  const bodyValue = (task[field] as string) ?? "";
  const [text, setText] = useState(bodyValue);
  const [editing, setEditing] = useState(false);
  const [slash, setSlash] = useState<{ anchor: Anchor; at: number } | null>(null);
  const [tplAt, setTplAt] = useState<{ anchor: Anchor; at: number } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const saved = useRef(bodyValue);
  useEffect(() => {
    saved.current = bodyValue;
    setText(bodyValue);
  }, [task.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!editing && bodyValue !== saved.current) {
      saved.current = bodyValue;
      setText(bodyValue);
    }
  }, [editing, bodyValue]);
  const latest = useRef(text);
  latest.current = text;
  const save = (v: string): void => {
    if (v === saved.current) return;
    saved.current = v;
    void repo.updateTask(task.id, { [field]: v });
  };
  useDebouncedSave(text, save);
  useEffect(() => () => save(latest.current), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [text, editing]);
  const html = useMemo(() => (text ? renderMarkdown(text) : ""), [text]);

  if (!editing && text) {
    return (
      <div
        className="md-body"
        data-testid="detail-body-rendered"
        onClick={(e) => {
          if ((e.target as HTMLElement).tagName === "A") return;
          setEditing(true);
          requestAnimationFrame(() => ref.current?.focus());
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  }
  return (
    <>
      <textarea
        ref={ref}
        id="detail-body"
        className="detail-body"
        data-testid="detail-body"
        placeholder="Write something or type / for commands"
        value={text}
        autoFocus={editing}
        onBlur={() => {
          save(text);
          setTimeout(() => !slash && setEditing(false), 120);
        }}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          const c = e.target.selectionStart;
          const lineStart = v.lastIndexOf("\n", c - 2) + 1;
          if (v[c - 1] === "/" && c - 1 === lineStart) setSlash({ anchor: anchorOf(e.target), at: c - 1 });
          else if (slash) setSlash(null);
        }}
      />
      {slash && (
        <Popover anchor={slash.anchor} onClose={() => setSlash(null)} testId="slash-menu">
          <Menu
            onClose={() => setSlash(null)}
            items={SLASH_COMMANDS.map((c) => ({
              label: c.label,
              testId: `slash-${c.label.toLowerCase().replace(/\s+/g, "-")}`,
              onClick: () => {
                if (c.label === "Template") {
                  setTplAt(slash);
                  return;
                }
                const v = text.slice(0, slash.at) + c.insert + text.slice(slash.at + 1);
                setText(v);
                requestAnimationFrame(() => {
                  ref.current?.focus();
                  const pos = slash.at + c.insert.length - (c.insert.startsWith("```") ? 4 : 0);
                  ref.current?.setSelectionRange(pos, pos);
                });
              },
            }))}
          />
        </Popover>
      )}
      {tplAt && (
        <TemplatePicker
          anchor={tplAt.anchor}
          kind={task.kind === "NOTE" ? "note" : "task"}
          onClose={() => setTplAt(null)}
          onPick={(tpl) => {
            // TPL-014: insert the template content where the slash was
            const v = text.slice(0, tplAt.at) + (tpl.content ?? "") + text.slice(tplAt.at + 1);
            setText(v);
            save(v);
            setTplAt(null);
          }}
        />
      )}
    </>
  );
}

function Checklist({ task }: { task: Task }): JSX.Element {
  const { repo } = useApp();
  const items = [...(task.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const [draft, setDraft] = useState("");
  const save = (next: ChecklistItem[]): void => void repo.updateTask(task.id, { items: next });
  const add = (title: string, at?: number): void => {
    const list = [...items];
    const it: ChecklistItem = { id: newId(), title, status: 0, sortOrder: 0 };
    list.splice(at ?? list.length, 0, it);
    save(list.map((x, i) => ({ ...x, sortOrder: i * ORDER_STEP })));
  };
  return (
    <div className="checklist" data-testid="checklist">
      {items.map((it, i) => (
        <div key={it.id} className={`check-item${it.status ? " done" : ""}`}>
          <Checkbox checked={!!it.status} onChange={() => save(items.map((x) => (x.id === it.id ? { ...x, status: x.status ? 0 : 2, completedTime: x.status ? null : new Date().toISOString().replace("Z", "+0000") } : x)))} />
          <input
            className="check-title"
            defaultValue={it.title}
            onBlur={(e) => e.target.value !== it.title && save(items.map((x) => (x.id === it.id ? { ...x, title: e.target.value } : x)))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
                add("", i + 1);
              }
              if (e.key === "Backspace" && !(e.target as HTMLInputElement).value) {
                e.preventDefault();
                save(items.filter((x) => x.id !== it.id));
              }
            }}
          />
          <button className="icon-btn xs" aria-label="Delete item" onClick={() => save(items.filter((x) => x.id !== it.id))}>
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="check-item add">
        <Plus size={14} className="muted" />
        <input
          className="check-title"
          placeholder="Add item"
          data-testid="checklist-add"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              add(draft.trim());
              setDraft("");
            }
          }}
        />
      </div>
    </div>
  );
}

function Subtasks({ task }: { task: Task }): JSX.Element {
  const app = useApp();
  const kids = app.tasks.filter((k) => k.parentId === task.id && !k.deleted).sort((a, b) => a.sortOrder - b.sortOrder);
  const [draft, setDraft] = useState("");
  if (task.kind === "NOTE") return <></>;
  return (
    <div className="subtasks" data-testid="subtasks">
      {kids.map((k) => (
        <div key={k.id} className={`subtask${k.status ? " done" : ""}`} onClick={() => (location.hash = routeTaskPath(app.route, k.id))}>
          <Checkbox checked={k.status !== 0} priority={k.priority ?? 0} onChange={() => void app.repo.toggleComplete(k.id)} />
          <span className="subtask-title">{k.title || <span className="muted">No title</span>}</span>
          {!Number.isNaN(taskStart(k)) && <span className={`date-chip${isOverdue(k, app.now) ? " overdue" : " future"}`}>{chipLabel(k, app.now, app.settings.showMeridiem)}</span>}
          <button
            className="icon-btn xs"
            title="Unlink"
            aria-label="Unlink subtask"
            onClick={(e) => {
              e.stopPropagation();
              void app.repo.setParent(k.id, null);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <div className="subtask add">
        <Plus size={14} className="muted" />
        <input
          placeholder="Add subtask"
          data-testid="subtask-add"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              void app.repo.createTask({ title: draft.trim(), projectId: task.projectId, parentId: task.id }, { position: "bottom" });
              setDraft("");
            }
          }}
        />
      </div>
    </div>
  );
}

export function Detail({ taskId, popup }: { taskId: string; popup?: boolean }): JSX.Element {
  const app = useApp();
  const { tasks, repo, now, settings, route, tags } = app;
  const task = tasks.find((t) => t.id === taskId);
  const [pop, setPop] = useState<{ kind: "date" | "priority" | "list" | "tags" | "more"; anchor: Anchor } | null>(null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [immersive, setImmersive] = useState(false);
  const [plain, setPlain] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const attach = (files: File[]): void => {
    if (!task || !files.length) return;
    for (const f of files) void repo.addAttachment(task.id, f, f.name);
    app.toast(files.length === 1 ? `Attached ${files[0]!.name}` : `Attached ${files.length} files`);
  };
  const drop = useFileDrop(attach);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (document.activeElement !== titleRef.current) setTitle(task?.title ?? "");
  }, [taskId, task?.title]); // eslint-disable-line react-hooks/exhaustive-deps
  useDebouncedSave(title, (v) => task && v !== task.title && void repo.updateTask(task.id, { title: v }));
  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title]);
  useEffect(() => {
    // a fresh empty task (new subtask) gets the caret straight away
    if (task && !task.title) titleRef.current?.focus();
  }, [taskId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && (e.altKey || e.shiftKey) && e.key === "0") {
        e.preventDefault();
        setImmersive((v) => !v);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  const close = (): void => {
    location.hash = routeTaskPath(route);
  };

  if (!task) {
    return (
      <div className="detail-pane" data-testid="detail-pane">
        <div className="detail-empty">
          <div className="empty-title">Task not found</div>
          <div className="empty-sub">It may have been deleted on another device.</div>
          <button className="btn" onClick={close}>Close</button>
        </div>
      </div>
    );
  }

  const done = task.status !== 0;
  const s = taskStart(task);
  const dateLabel = Number.isNaN(s) ? "Due Date" : chipLabel(task, now, settings.showMeridiem);
  const overdue = isOverdue(task, now);
  const isNote = task.kind === "NOTE";
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : undefined;
  // shared lists (M8): view-only and comment-only members cannot change the task
  const proj = app.projects.find((p) => p.id === task.projectId);
  const ro = !canEditProject(proj);
  const shared = isSharedProject(proj) && !!app.me && !app.me.single;

  return (
    <div
      className={`detail-pane${immersive ? " immersive" : ""}${popup ? " popup" : ""}${drop.over ? " drop-over" : ""}`}
      data-testid="detail-pane"
      {...drop.bind}
      onPaste={(e) => {
        // ATT-017: a pasted image becomes an attachment (text pastes are left alone)
        if ((e.target as HTMLElement).closest(".cmt-panel")) return;
        const files = clipboardFiles(e);
        if (files.length) {
          e.preventDefault();
          attach(files);
        }
      }}
    >
      {drop.over && <div className="drop-hint" data-testid="drop-hint">Drop files to attach</div>}
      <div className="detail-top">
        <button className="icon-btn sm mobile-only" aria-label="Back" onClick={close}>
          <ChevronLeft size={18} />
        </button>
        <fieldset className="ro-fs" disabled={ro}>
        {!isNote && (
          <Checkbox
            checked={done}
            wontDo={task.status === -1}
            priority={task.priority ?? 0}
            testId="detail-check"
            onChange={() => void repo.toggleComplete(task.id).then((r) => task.status === 0 && app.toast(r.next ? "Task completed, next one scheduled" : "Task completed", () => void repo.undo()))}
          />
        )}
        <span className="divider-v" />
        <button className={`date-btn${Number.isNaN(s) ? "" : overdue ? " overdue" : " set"}`} data-testid="detail-date" onClick={(e) => setPop({ kind: "date", anchor: anchorOf(e.currentTarget) })}>
          <Calendar size={15} />
          <span>{dateLabel}</span>
          {task.repeatFlag && <span className="muted small"> · {repeatSummary(task.repeatFlag)}</span>}
          {(task.reminders?.length ?? 0) > 0 && (
            <span className="rem-chip" data-testid="detail-reminder-chip" title={(task.reminders ?? []).map((r) => reminderLabel(r.trigger, task.isAllDay !== false)).join(", ")}>
              <AlarmClock size={12} />
              {task.reminders!.length > 1 ? task.reminders!.length : ""}
            </span>
          )}
          {typeof task.snoozeReminderTime === "string" && task.snoozeReminderTime && <span className="muted small" data-testid="detail-snoozed"> · snoozed to {formatTime(parseDate(String(task.snoozeReminderTime)), settings.showMeridiem)}</span>}
        </button>
        <span className="grow" />
        {shared && !isNote && <AssignButton task={task} disabled={ro || !app.me?.collaboration.enabled} />}
        {!isNote && (
          <button className="icon-btn" aria-label="Priority" title="Priority" data-testid="detail-priority" onClick={(e) => setPop({ kind: "priority", anchor: anchorOf(e.currentTarget) })}>
            <Flag size={17} color={PRIORITY_COLOR[task.priority ?? 0]} fill={task.priority ? PRIORITY_COLOR[task.priority] : "none"} />
          </button>
        )}
        </fieldset>
        {popup && (
          <button className="icon-btn" aria-label="Close" onClick={close}>
            <X size={17} />
          </button>
        )}
      </div>
      {task.deleted ? (
        <div className="banner">
          This task is in the Trash.
          <button className="link-btn" onClick={() => void repo.restoreFromTrash([task.id])}>Restore</button>
        </div>
      ) : null}
      {ro && (
        <div className="banner ro-banner" data-testid="readonly-banner">
          {proj?.collaborationPaused ? "Collaboration is paused by the admin: this shared list is view only." : `View only${proj?.permission === "comment" ? ", you can comment" : ""}. ${String(proj?.ownerName ?? "The owner")} shared this list with you.`}
        </div>
      )}
      <div className="detail-scroll">
        <fieldset className="ro-fs" disabled={ro}>
        <TaskFocusLine task={task} />
        {parent && (
          <button className="parent-link muted" onClick={() => (location.hash = routeTaskPath(route, parent.id))}>
            <ChevronLeft size={13} /> {parent.title}
          </button>
        )}
        <div className="detail-title-row">
          <textarea
            ref={titleRef}
            className={`detail-title${done ? " done" : ""}`}
            data-testid="detail-title"
            rows={1}
            value={title}
            placeholder="What would you like to do?"
            onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (title !== task.title) void repo.updateTask(task.id, { title });
                if (e.shiftKey) {
                  const body = document.getElementById("detail-body") as HTMLTextAreaElement | null;
                  if (body) body.focus();
                  else (document.querySelector("[data-testid=detail-body-rendered]") as HTMLElement | null)?.click();
                }
              }
            }}
            onBlur={() => title !== task.title && void repo.updateTask(task.id, { title })}
          />
          {!isNote && (
            <button
              className="icon-btn sm"
              title={task.kind === "CHECKLIST" ? "Convert to text" : "Convert to checklist"}
              aria-label={task.kind === "CHECKLIST" ? "Convert to text" : "Convert to checklist"}
              data-testid="convert-checklist"
              onClick={() => void repo.convertKind(task.id, task.kind === "CHECKLIST" ? "TEXT" : "CHECKLIST")}
            >
              {task.kind === "CHECKLIST" ? <CheckSquare size={16} /> : <ListChecks size={16} />}
            </button>
          )}
        </div>
        {(task.tags?.length ?? 0) > 0 && (
          <div className="detail-tags">
            {(task.tags ?? []).map((n) => {
              const tg = tags.find((x) => x.name === n.toLowerCase());
              return (
                <span key={n} className="tag-pill" style={tg?.color ? { background: `${tg.color}33`, color: tg.color } : undefined}>
                  {tg?.label ?? n}
                  <button className="pill-x" aria-label={`Remove tag ${n}`} onClick={() => void repo.updateTask(task.id, { tags: (task.tags ?? []).filter((x) => x !== n) })}>
                    <X size={10} />
                  </button>
                </span>
              );
            })}
            <button className="icon-btn xs" aria-label="Add tag" onClick={(e) => setPop({ kind: "tags", anchor: anchorOf(e.currentTarget) })}>
              <Hash size={12} />
            </button>
          </div>
        )}
        {plain ? (
          <pre className="md-plain">{(task.kind === "CHECKLIST" ? task.desc : task.content) ?? ""}</pre>
        ) : (
          <Body key={task.id + (task.kind ?? "")} task={task} />
        )}
        {task.kind === "CHECKLIST" && <Checklist task={task} />}
        <Subtasks task={task} />
        </fieldset>
        <AttachmentGrid task={task} readOnly={ro} />
      </div>
      {showComments && <CommentsPanel task={task} onClose={() => setShowComments(false)} />}
      <div className="detail-bottom">
        <button className="list-btn" data-testid="detail-list" disabled={ro} onClick={(e) => setPop({ kind: "list", anchor: anchorOf(e.currentTarget) })}>
          <ListIcon size={15} /> <span>{app.projectName(task.projectId) || "Inbox"}</span>
        </button>
        <span className="grow" />
        <button className={`icon-btn sm${plain ? " on" : ""}`} title="Text format" aria-label="Text format" onClick={() => setPlain((v) => !v)}>
          <Type size={16} />
        </button>
        <VoiceMemoButton task={task} />
        <button className={`icon-btn sm${showComments ? " on" : ""}`} title="Comments" aria-label="Comments" data-testid="detail-comments" onClick={() => setShowComments((v) => !v)}>
          <MessageSquare size={16} />
          {(task.commentCount ?? 0) > 0 && <span className="icon-count">{task.commentCount}</span>}
        </button>
        <button className="icon-btn sm" title="More" aria-label="Task more menu" data-testid="detail-more" onClick={(e) => setPop({ kind: "more", anchor: anchorOf(e.currentTarget) })}>
          <MoreHorizontal size={16} />
        </button>
      </div>
      {pop?.kind === "date" && (
        <DatePicker anchor={pop.anchor} value={taskDateValue(task)} onChange={(v) => void repo.updateTask(task.id, datePatch(v, task), { undo: "Date changed" })} onClose={() => setPop(null)} />
      )}
      {pop?.kind === "priority" && <PriorityMenu anchor={pop.anchor} value={task.priority ?? 0} onPick={(p) => void repo.updateTask(task.id, { priority: p })} onClose={() => setPop(null)} />}
      {pop?.kind === "list" && (
        <ListPicker anchor={pop.anchor} value={task.projectId} onPick={(id) => id !== task.projectId && void repo.moveTasks([task.id], id).then(() => app.toast(`Moved to ${app.projectName(id)}`, () => void repo.undo()))} onClose={() => setPop(null)} />
      )}
      {pop?.kind === "tags" && <TagPicker anchor={pop.anchor} value={task.tags ?? []} onChange={(v) => void repo.updateTask(task.id, { tags: v })} onClose={() => setPop(null)} />}
      {pop?.kind === "more" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} placement="bottom-end" testId="detail-more-menu">
          <Menu items={taskMenuItems(app, task)} onClose={() => setPop(null)} />
        </Popover>
      )}
    </div>
  );
}

export function DetailEmpty(): JSX.Element {
  return (
    <div className="detail-pane empty" data-testid="detail-empty">
      <div className="detail-empty">
        <svg width="140" height="110" viewBox="0 0 140 110" aria-hidden>
          <rect x="30" y="20" width="80" height="70" rx="10" fill="none" stroke="currentColor" strokeWidth="2" opacity=".25" />
          <path d="M46 44h48M46 58h36M46 72h42" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".25" />
        </svg>
        <div className="empty-sub">Click a task title to view the details</div>
      </div>
    </div>
  );
}
