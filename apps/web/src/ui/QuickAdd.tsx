import { parseQuickAdd, type QuickAddResult, type RecognizedSpan } from "@noortasks/quickadd";
import { TemplatePicker, createFromTemplate } from "./Templates";
import { filterDefaults } from "../model/filters";
import { routeTaskPath } from "../model/router";
import { Calendar, ChevronDown, FileText, Flag, Hash, LayoutTemplate, List as ListIcon, Paperclip, Plus, SlidersHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { newId, type Task } from "../lib/core";
import { addDays, deviceZone, parseDate, startOfDay, toServer, weekStartIndex } from "../lib/dates";
import type { ViewRef } from "../model/views";
import { DatePicker, type DateValue } from "./DatePicker";
import { useApp } from "./ctx";
import { Menu, Modal, Popover, PRIORITIES, PRIORITY_COLOR, anchorOf, type Anchor } from "./primitives";
import { TagPicker } from "./pickers";
import { datePatch, defaultDueFor } from "./taskutil";

interface Disabled {
  start: number;
  end: number;
  text: string;
}

/** Re-anchor disabled spans after an edit: keep those whose text is still at (or near) the same place. */
function reanchor(prev: Disabled[], text: string): Disabled[] {
  const out: Disabled[] = [];
  for (const d of prev) {
    if (text.slice(d.start, d.end) === d.text) out.push(d);
    else {
      const i = text.indexOf(d.text, Math.max(0, d.start - 40));
      if (i >= 0) out.push({ start: i, end: i + d.text.length, text: d.text });
    }
  }
  return out;
}

const MARKERS: Record<string, "tag" | "list" | "priority" | "date"> = { "#": "tag", "＃": "tag", "~": "list", "～": "list", "^": "list", "＾": "list", "!": "priority", "！": "priority", "*": "date", "＊": "date" };

interface Suggest {
  kind: "tag" | "list" | "priority" | "date";
  start: number; // marker index
  query: string;
  items: Array<{ label: string; insert: string; color?: string }>;
}

function dateOptions(now: number): Array<{ label: string; insert: string }> {
  const out = [
    { label: "Today", insert: "today" },
    { label: "Tomorrow", insert: "tomorrow" },
  ];
  const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  for (let i = 2; i < 8; i++) {
    const d = new Date(addDays(startOfDay(now), i));
    out.push({ label: `${names[d.getDay()]![0]!.toUpperCase()}${names[d.getDay()]!.slice(1)}, ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, insert: names[d.getDay()]! });
  }
  out.push({ label: "Next month", insert: "next month" });
  for (let i = 2; i <= 12; i++) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + i, 1);
    const m = d.toLocaleDateString("en-US", { month: "long" });
    out.push({ label: `${m} ${d.getFullYear()}`, insert: `${m.toLowerCase()} 1` });
  }
  return out;
}

export function QuickAdd({ view, placeholder, testId = "quick-add" }: { view: ViewRef; placeholder: string; testId?: string }): JSX.Element {
  const app = useApp();
  const { repo, settings, projects, tags, inboxId, now, local, toast } = app;
  const [text, setText] = useState("");
  const [disabled, setDisabled] = useState<Disabled[]>([]);
  const [focus, setFocus] = useState(false);
  const [priority, setPriority] = useState<number | null>(null);
  const [draftProject, setDraftProject] = useState<string | null>(null);
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [draftDate, setDraftDate] = useState<DateValue | null>(null);
  const [draftKind, setDraftKind] = useState<"TEXT" | "NOTE">("TEXT");
  const [files, setFiles] = useState<File[]>([]);
  const [pop, setPop] = useState<{ kind: "menu" | "date" | "tags" | "template"; anchor: Anchor } | null>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [sIdx, setSIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const detailed = local.quickAddStyle === 1;
  const isNoteList = view.type === "project" && projects.find((p) => p.id === view.id)?.kind === "NOTE";

  const listNames = useMemo(() => ["Inbox", ...projects.filter((p) => !p.closed).map((p) => p.name)], [projects]);
  const parsed: QuickAddResult = useMemo(() => {
    const firstLine = text.split("\n")[0] ?? "";
    try {
      const tagDisabled = settings.tagging === false ? (() => {
        const r = parseQuickAdd(firstLine, { now: new Date(now), timeZone: deviceZone(), weekStart: weekStartIndex(settings.startDayOfWeek), tags: tags.map((t) => t.label ?? t.name), lists: listNames });
        return r.recognized.filter((s) => s.kind === "tag").map((s) => [s.start, s.end] as [number, number]);
      })() : [];
      return parseQuickAdd(firstLine, {
        now: new Date(now),
        timeZone: deviceZone(),
        weekStart: weekStartIndex(settings.startDayOfWeek),
        dateParsing: settings.nlpEnabled !== false,
        removeRecognizedText: true,
        disabledSpans: [...disabled.map((d) => [d.start, d.end] as [number, number]), ...tagDisabled],
        tags: tags.map((t) => t.label ?? t.name),
        lists: listNames,
      });
    } catch {
      return { title: firstLine, tags: [], recognized: [] };
    }
  }, [text, disabled, settings.nlpEnabled, settings.tagging, settings.startDayOfWeek, now, tags, listNames]);

  // merge adjacent spans separated only by a space (QADD-064)
  const marks = useMemo(() => {
    const spans = [...parsed.recognized].sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number; kinds: RecognizedSpan["kind"][] }> = [];
    for (const s of spans) {
      const last = merged[merged.length - 1];
      if (last && /^\s?$/.test(text.slice(last.end, s.start))) {
        last.end = s.end;
        last.kinds.push(s.kind);
      } else merged.push({ start: s.start, end: s.end, kinds: [s.kind] });
    }
    return merged;
  }, [parsed, text]);

  const updateText = (v: string): void => {
    setText(v);
    setDisabled((d) => reanchor(d, v));
  };

  // marker autocomplete (QADD-030): scan back from the caret to the nearest marker, stop at whitespace
  const computeSuggest = (v: string, caret: number): void => {
    let i = caret - 1;
    while (i >= 0 && !/\s/.test(v[i]!) && !(v[i]! in MARKERS)) i--;
    if (i < 0 || !(v[i]! in MARKERS) || (i > 0 && !/\s/.test(v[i - 1]!))) return setSuggest(null);
    const kind = MARKERS[v[i]!]!;
    const query = v.slice(i + 1, caret).toLowerCase();
    let items: Suggest["items"] = [];
    if (kind === "tag") {
      if (settings.tagging === false) return setSuggest(null);
      items = tags.filter((t) => (t.label ?? t.name).toLowerCase().includes(query) && !parsed.tags.includes(t.name)).map((t) => ({ label: t.label ?? t.name, insert: t.label ?? t.name, color: t.color ?? undefined }));
    } else if (kind === "list") items = listNames.filter((n) => n.toLowerCase().includes(query)).map((n) => ({ label: n, insert: n.replace(/\s+/g, "") === n ? n : n }));
    else if (kind === "priority") items = PRIORITIES.filter((p) => p.label.toLowerCase().startsWith(query)).map((p) => ({ label: p.label, insert: p.label, color: PRIORITY_COLOR[p.value] }));
    else items = dateOptions(now).filter((d) => d.label.toLowerCase().includes(query) || d.insert.includes(query));
    setSIdx(0);
    setSuggest(items.length ? { kind, start: i, query, items: items.slice(0, 12) } : null);
  };

  const applySuggest = (item: Suggest["items"][number]): void => {
    if (!suggest) return;
    const caret = inputRef.current?.selectionStart ?? text.length;
    if (suggest.kind === "list" && /\s/.test(item.insert)) {
      // names with spaces cannot be typed whole (QADD-032): pick sets the list directly
      const proj = item.label === "Inbox" ? inboxId : projects.find((p) => p.name === item.label)?.id;
      if (proj) setDraftProject(proj);
      updateText(text.slice(0, suggest.start) + text.slice(caret));
    } else {
      const v = `${text.slice(0, suggest.start + 1)}${item.insert} ${text.slice(caret).replace(/^\s+/, "")}`;
      updateText(v);
    }
    setSuggest(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const contextFields = (): Partial<Task> => {
    const f: Partial<Task> = {};
    if (view.type === "project") f.projectId = view.id;
    else if (view.type === "group") f.projectId = projects.find((p) => p.groupId === view.id)?.id;
    else f.projectId = settings.defaultProjectId && (settings.defaultProjectId === inboxId || projects.some((p) => p.id === settings.defaultProjectId)) ? (settings.defaultProjectId as string) : inboxId;
    if (view.type === "tag") f.tags = [view.name];
    if (view.type === "filter") {
      // FILT-015: a task added in a filter view takes the filter's single priority, its tags and its single list
      const fl = app.filters.find((x) => x.id === view.id);
      const d = filterDefaults(fl?.rule, new Set([inboxId, ...projects.map((p) => p.id)]));
      if (d.projectId) f.projectId = d.projectId;
      if (d.tags) f.tags = d.tags;
      if (d.priority !== undefined) f.priority = d.priority;
    }
    if (view.type === "smart" && (view.name === "today" || view.name === "tomorrow" || view.name === "week")) {
      const day = addDays(startOfDay(now), view.name === "tomorrow" ? 1 : 0);
      f.startDate = toServer(day);
      f.dueDate = toServer(day);
      f.isAllDay = true;
    }
    return f;
  };

  const buildFields = (line: string, p: QuickAddResult): Partial<Task> & { title: string } => {
    const ctx = contextFields();
    const fields: Partial<Task> & { title: string } = { ...ctx, title: (settings.removeDate === false ? line.replace(/[*＊]/, "") : p.title).trim() || line.trim() };
    if (settings.removeTag === false && p.tags.length && settings.removeDate !== false) fields.title = `${fields.title} ${p.tags.map((t) => `#${t}`).join(" ")}`;
    if (p.list) {
      const pr = p.list.toLowerCase() === "inbox" ? inboxId : projects.find((x) => x.name.toLowerCase() === p.list!.toLowerCase())?.id;
      if (pr) fields.projectId = pr;
    }
    if (draftProject) fields.projectId = draftProject;
    const allTags = [...new Set([...(ctx.tags ?? []), ...(settings.defaultTags ?? []), ...p.tags.map((t) => t.toLowerCase()), ...draftTags])];
    fields.tags = allTags;
    if (p.priority !== undefined) fields.priority = p.priority;
    if (priority !== null) fields.priority = priority;
    if (p.startDate) {
      const s = parseDate(p.startDate);
      fields.startDate = toServer(s);
      fields.dueDate = p.dueDate ? toServer(parseDate(p.dueDate)) : toServer(s);
      fields.isAllDay = p.isAllDay ?? true;
      const triggers = p.reminders?.length ? p.reminders : fields.isAllDay ? settings.defaultADReminders ?? [] : settings.defaultReminds ?? [];
      fields.reminders = triggers.map((trigger) => ({ id: newId(), trigger }));
    } else if (!ctx.startDate) Object.assign(fields, defaultDueFor(settings, now));
    if (p.repeatFlag) {
      fields.repeatFlag = p.repeatFlag;
      fields.repeatFrom = "2";
      if (!fields.startDate) {
        const day = startOfDay(now);
        fields.startDate = toServer(day);
        fields.dueDate = toServer(day);
        fields.isAllDay = true;
      }
    }
    if (draftDate) Object.assign(fields, datePatch(draftDate));
    if (draftKind === "NOTE") {
      fields.kind = "NOTE";
      fields.priority = 0;
    }
    if (ctx.startDate && fields.reminders === undefined && fields.startDate === ctx.startDate) fields.reminders = (settings.defaultADReminders ?? []).map((trigger) => ({ id: newId(), trigger }));
    return fields;
  };

  const reset = (): void => {
    setText("");
    setDisabled([]);
    setPriority(null);
    setDraftProject(null);
    setDraftTags([]);
    setDraftDate(null);
    setDraftKind("TEXT");
    setFiles([]);
    setSuggest(null);
  };

  const submit = async (): Promise<void> => {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    if (lines.length > 1) {
      app.setModal({
        kind: "batchAdd",
        lines,
        onOk: async () => {
          for (const l of lines) {
            const p = parseQuickAdd(l, { now: new Date(now), timeZone: deviceZone(), weekStart: weekStartIndex(settings.startDayOfWeek), dateParsing: settings.nlpEnabled !== false, tags: tags.map((t) => t.label ?? t.name), lists: listNames });
            await repo.createTask(buildFields(l, p));
          }
          reset();
        },
      });
      return;
    }
    const fields = buildFields(lines[0]!, parsed);
    const t = await repo.createTask(fields);
    for (const f of files) await repo.addAttachment(t.id, f, f.name);
    const listName = fields.projectId && fields.projectId !== contextFields().projectId ? app.projectName(fields.projectId) : "";
    if (listName) toast(`Added to ${listName}`);
    reset();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (suggest) {
      if (e.key === "ArrowDown") return (e.preventDefault(), setSIdx((i) => (i + 1) % suggest.items.length));
      if (e.key === "ArrowUp") return (e.preventDefault(), setSIdx((i) => (i - 1 + suggest.items.length) % suggest.items.length));
      const exact = suggest.items.some((it) => it.insert.toLowerCase() === suggest.query || it.label.toLowerCase() === suggest.query);
      if ((e.key === "Enter" && !exact) || e.key === "Tab") {
        e.preventDefault();
        applySuggest(suggest.items[sIdx]!);
        return;
      }
      if (e.key === "Enter") setSuggest(null);
      if (e.key === "Escape") return (e.stopPropagation(), setSuggest(null));
    }
    if (e.key === "Enter" && !e.shiftKey && !(detailed && !e.ctrlKey && !e.metaKey && text.includes("\n"))) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      if (text) reset();
      else inputRef.current?.blur();
      return;
    }
    if (e.key === "Backspace") {
      // Backspace inside a highlight disables it; on a disabled mark it enables it again (QADD-067)
      const el = inputRef.current!;
      const c = el.selectionStart ?? 0;
      if (el.selectionEnd !== c) return;
      const dis = disabled.find((d) => c > d.start && c <= d.end);
      if (dis) {
        e.preventDefault();
        setDisabled((x) => x.filter((d) => d !== dis));
        return;
      }
      const m = marks.find((s) => c > s.start && c <= s.end && s.kinds.some((k) => k === "date" || k === "time" || k === "repeat" || k === "reminder"));
      if (m) {
        e.preventDefault();
        setDisabled((x) => [...x, { start: m.start, end: m.end, text: text.slice(m.start, m.end) }]);
      }
    }
  };

  // clicking a highlighted fragment cancels it (QADD-066)
  const onClickInput = (): void => {
    const el = inputRef.current!;
    const c = el.selectionStart ?? 0;
    if (el.selectionEnd !== c) return;
    const m = marks.find((s) => c >= s.start && c <= s.end && s.kinds.some((k) => k === "date" || k === "time" || k === "repeat" || k === "reminder"));
    if (m && c < m.end) setDisabled((x) => [...x, { start: m.start, end: m.end, text: text.slice(m.start, m.end) }]);
  };

  useEffect(() => {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
  });

  // mirror with marks
  const firstLine = text.split("\n")[0] ?? "";
  const pieces: JSX.Element[] = [];
  let pos = 0;
  const all = [...marks.map((m) => ({ ...m, off: false })), ...disabled.map((d) => ({ start: d.start, end: d.end, kinds: [] as string[], off: true }))].sort((a, b) => a.start - b.start);
  for (const m of all) {
    if (m.start < pos || m.end > firstLine.length) continue;
    pieces.push(<span key={`t${pos}`}>{firstLine.slice(pos, m.start)}</span>);
    pieces.push(
      <mark key={`m${m.start}`} className={m.off ? "qa-mark off" : `qa-mark k-${m.kinds[0]}`} data-testid={m.off ? "qa-mark-off" : "qa-mark"}>
        {firstLine.slice(m.start, m.end)}
      </mark>,
    );
    pos = m.end;
  }
  pieces.push(<span key="rest">{firstLine.slice(pos)}</span>);
  const hasDateMark = marks.some((m) => m.kinds.some((k) => k === "date" || k === "time" || k === "repeat"));

  const InputEl = detailed ? "textarea" : "input";
  const effectivePriority = priority ?? parsed.priority ?? null;

  return (
    <div className={`quick-add${focus || text ? " active" : ""}${detailed ? " detailed" : ""}`} data-testid={testId}>
      {!focus && !text && <Plus size={16} className="qa-plus" />}
      <div className="qa-field">
        {!detailed && (
          <div className="qa-mirror" ref={mirrorRef} aria-hidden>
            {pieces}
          </div>
        )}
        <InputEl
          ref={inputRef}
          className="qa-input"
          data-testid="quick-add-input"
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            updateText(e.target.value);
            computeSuggest(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onClick={onClickInput}
          onFocus={() => setFocus(true)}
          onBlur={() => setTimeout(() => setFocus(false), 150)}
          onPaste={(e) => {
            const t = e.clipboardData.getData("text");
            if (t.includes("\n") && !detailed) {
              e.preventDefault();
              const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
              if (lines.length > 1) {
                setText(lines.join("\n"));
                app.setModal({
                  kind: "batchAdd",
                  lines,
                  onOk: async () => {
                    for (const l of lines) {
                      const p = parseQuickAdd(l, { now: new Date(now), timeZone: deviceZone(), weekStart: weekStartIndex(settings.startDayOfWeek), dateParsing: settings.nlpEnabled !== false, tags: tags.map((x) => x.label ?? x.name), lists: listNames });
                      await repo.createTask(buildFields(l, p));
                    }
                    reset();
                  },
                });
              }
            }
          }}
          rows={detailed ? 3 : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        {hasDateMark && focus && <div className="qa-tip">Date parsing is enabled, tap text to cancel.</div>}
      </div>
      {(
        <div className={`qa-tools${focus || text || pop ? "" : " idle"}`}>
          {effectivePriority ? <Flag size={15} color={PRIORITY_COLOR[effectivePriority]} fill={PRIORITY_COLOR[effectivePriority]} /> : null}
          <button className={`icon-btn sm${draftDate ? " accent" : ""}`} title="Date" aria-label="Set date" data-testid="qa-date" onMouseDown={(e) => e.preventDefault()} onClick={(e) => setPop({ kind: "date", anchor: anchorOf(e.currentTarget) })}>
            <Calendar size={16} />
          </button>
          <button className="icon-btn sm" title="More" aria-label="More options" data-testid="qa-more" onMouseDown={(e) => e.preventDefault()} onClick={(e) => setPop({ kind: "menu", anchor: anchorOf(e.currentTarget) })}>
            <ChevronDown size={16} />
          </button>
          {detailed && (
            <button className="btn primary sm" onClick={() => void submit()} data-testid="qa-add">
              Add
            </button>
          )}
        </div>
      )}
      {suggest && (
        <Popover anchor={anchorOf(inputRef.current)} onClose={() => setSuggest(null)} testId="qa-suggest">
          <div className="menu">
            {suggest.items.map((it, i) => (
              <button key={it.label} className={`menu-item${i === sIdx ? " hover" : ""}`} onMouseDown={(e) => e.preventDefault()} onClick={() => applySuggest(it)}>
                <span className="menu-icon">{suggest.kind === "tag" ? <Hash size={13} color={it.color} /> : suggest.kind === "list" ? <ListIcon size={13} /> : suggest.kind === "priority" ? <Flag size={13} color={it.color} /> : <Calendar size={13} />}</span>
                <span className="menu-label">{it.label}</span>
              </button>
            ))}
          </div>
        </Popover>
      )}
      {pop?.kind === "date" && (
        <DatePicker
          anchor={pop.anchor}
          value={draftDate ?? (parsed.startDate ? { startDate: toServer(parseDate(parsed.startDate)), dueDate: parsed.dueDate ? toServer(parseDate(parsed.dueDate)) : undefined, isAllDay: parsed.isAllDay, reminders: parsed.reminders ?? [], repeatFlag: parsed.repeatFlag } : { reminders: [] })}
          onChange={(v) => setDraftDate(v)}
          onClose={() => {
            setPop(null);
            inputRef.current?.focus();
          }}
        />
      )}
      {pop?.kind === "menu" && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} placement="bottom-end" testId="qa-menu">
          <div className="menu">
            <div className="menu-flags" aria-label="Priority">
              <span className="muted">Priority</span>
              {PRIORITIES.map((p) => (
                <button key={p.value} className={`icon-btn sm${effectivePriority === p.value ? " on" : ""}`} title={p.label} aria-label={`Priority ${p.label}`} data-testid={`qa-priority-${p.value}`} onClick={() => setPriority(p.value)}>
                  <Flag size={16} color={PRIORITY_COLOR[p.value]} fill={p.value ? PRIORITY_COLOR[p.value] : "none"} />
                </button>
              ))}
            </div>
            <Menu
              onClose={() => setPop(null)}
              items={[
                {
                  label: draftProject ? app.projectName(draftProject) : app.projectName(contextFields().projectId ?? inboxId) || "Inbox",
                  icon: <ListIcon size={15} />,
                  submenu: () => (
                    <Menu
                      onClose={() => setPop(null)}
                      items={[{ id: inboxId, name: "Inbox" }, ...projects.filter((p) => !p.closed)].map((p) => ({ label: p.name, checked: (draftProject ?? contextFields().projectId) === p.id, onClick: () => setDraftProject(p.id) }))}
                    />
                  ),
                },
                { label: "Tags", icon: <Hash size={15} />, onClick: () => setTimeout(() => setPop({ kind: "tags", anchor: pop.anchor }), 0) },
                { label: "Attachment", icon: <Paperclip size={15} />, hint: files.length ? String(files.length) : undefined, onClick: () => fileRef.current?.click() },
                { label: "Add from Template", icon: <LayoutTemplate size={15} />, testId: "qa-from-template", onClick: () => setTimeout(() => setPop({ kind: "template", anchor: pop.anchor }), 0) },
                { label: draftKind === "NOTE" ? "Convert to Task" : "Convert to Note", icon: <FileText size={15} />, onClick: () => setDraftKind(draftKind === "NOTE" ? "TEXT" : "NOTE") },
                { label: "Input Box Setting", icon: <SlidersHorizontal size={15} />, onClick: () => app.setModal({ kind: "quickAddStyle" }) },
              ]}
            />
          </div>
        </Popover>
      )}
      {pop?.kind === "template" && (
        <TemplatePicker
          anchor={pop.anchor}
          kind={isNoteList ? "note" : "task"}
          onClose={() => setPop(null)}
          onPick={(tpl) => {
            setPop(null);
            const ctx = contextFields();
            void createFromTemplate(app, tpl, { ...ctx, kind: isNoteList ? "NOTE" : undefined }).then((t) => (location.hash = routeTaskPath(app.route, t.id)));
          }}
        />
      )}
      {pop?.kind === "tags" && (
        <TagPicker
          anchor={pop.anchor}
          value={[...new Set([...draftTags, ...parsed.tags.map((t) => t.toLowerCase())])]}
          onClose={() => setPop(null)}
          onChange={(v) => setDraftTags(v)}
        />
      )}
      <input ref={fileRef} type="file" hidden multiple onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
    </div>
  );
}

export function QuickAddStyleDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const { local, setLocal } = useApp();
  return (
    <Modal onClose={onClose} testId="quickadd-style">
      <h3>Input Box Setting</h3>
      <div className="style-options">
        {(["Simple", "Detailed"] as const).map((label, i) => (
          <label key={label} className={`style-card${local.quickAddStyle === i ? " on" : ""}`}>
            <div className={`style-art ${label.toLowerCase()}`}>
              <span />
              {i === 1 && <span className="tall" />}
            </div>
            <span>
              <input type="radio" checked={local.quickAddStyle === i} onChange={() => setLocal("quickAddStyle", i as 0 | 1)} /> {label}
            </span>
          </label>
        ))}
      </div>
      <div className="row end">
        <button className="btn primary" onClick={onClose}>OK</button>
      </div>
    </Modal>
  );
}
