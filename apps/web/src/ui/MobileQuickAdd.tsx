import { parseQuickAdd } from "@noortasks/quickadd";
import { useMemo, useState } from "react";
import { newId, type Task } from "../lib/core";
import { deviceZone, parseDate, toServer, weekStartIndex } from "../lib/dates";
import { useApp } from "./ctx";
import { Modal, PRIORITIES } from "./primitives";
import { defaultDueFor } from "./taskutil";

export function MobileQuickAdd({ initialText, onClose }: { initialText: string; onClose: () => void }): JSX.Element {
  const { repo, settings, projects, tags, inboxId, now, toast } = useApp();
  const [text, setText] = useState(initialText);
  const [projectId, setProjectId] = useState(inboxId);
  const [priority, setPriority] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const listNames = useMemo(() => ["Inbox", ...projects.filter((p) => !p.closed).map((p) => p.name)], [projects]);
  const parsed = useMemo(() => {
    const firstLine = text.split("\n")[0] ?? "";
    try {
      return parseQuickAdd(firstLine, {
        now: new Date(now),
        timeZone: deviceZone(),
        weekStart: weekStartIndex(settings.startDayOfWeek),
        dateParsing: settings.nlpEnabled !== false,
        removeRecognizedText: true,
        tags: tags.map((t) => t.label ?? t.name),
        lists: listNames,
      });
    } catch {
      return { title: firstLine, tags: [], recognized: [] };
    }
  }, [text, now, settings.startDayOfWeek, settings.nlpEnabled, tags, listNames]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length || busy) return;
    setBusy(true);
    try {
      const firstLine = lines[0]!;
      const rest = lines.slice(1).join("\n");
      const fields: Partial<Task> & { title: string } = {
        projectId: projectId || inboxId,
        title: parsed.title.trim() || firstLine,
        ...(rest ? { content: rest } : {}),
        tags: [...new Set([...(settings.defaultTags ?? []), ...parsed.tags.map((t) => t.toLowerCase())])],
      };
      if (parsed.list) {
        const hit = parsed.list.toLowerCase() === "inbox" ? inboxId : projects.find((x) => x.name.toLowerCase() === parsed.list!.toLowerCase())?.id;
        if (hit) fields.projectId = hit;
      }
      if (priority !== null) fields.priority = priority;
      else if (parsed.priority !== undefined) fields.priority = parsed.priority;
      if (parsed.startDate) {
        const s = parseDate(parsed.startDate);
        fields.startDate = toServer(s);
        fields.dueDate = parsed.dueDate ? toServer(parseDate(parsed.dueDate)) : toServer(s);
        fields.isAllDay = parsed.isAllDay ?? true;
        const triggers = parsed.reminders?.length ? parsed.reminders : fields.isAllDay ? settings.defaultADReminders ?? [] : settings.defaultReminds ?? [];
        fields.reminders = triggers.map((trigger) => ({ id: newId(), trigger }));
      } else {
        Object.assign(fields, defaultDueFor(settings, now));
      }
      if (parsed.repeatFlag) {
        fields.repeatFlag = parsed.repeatFlag;
        fields.repeatFrom = "2";
      }
      await repo.createTask(fields);
      toast("Task added");
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} testId="mobile-quick-add">
      <form className="col gap-s" onSubmit={(e) => void submit(e)}>
        <div className="row between">
          <span className="strong">Quick Add</span>
          <button type="button" className="link-btn" onClick={onClose}>Cancel</button>
        </div>
        <textarea
          className="field full"
          style={{ height: 84, padding: 10, resize: "vertical" }}
          placeholder="What would you like to do?"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {parsed.recognized.length > 0 && (
          <div className="row gap" style={{ flexWrap: "wrap" }}>
            {parsed.startDate && <span className="chip-btn on">{parsed.startDate.slice(0, 16)}</span>}
            {parsed.list && <span className="chip-btn on">~{parsed.list}</span>}
            {parsed.tags.map((tg) => <span key={tg} className="chip-btn on">#{tg}</span>)}
          </div>
        )}
        <div className="row gap" style={{ marginTop: 4 }}>
          <select className="field" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value={inboxId}>Inbox</option>
            {projects.filter((p) => !p.closed && p.id !== inboxId).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select className="field" value={priority === null ? "" : String(priority)} onChange={(e) => setPriority(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Priority</option>
            {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <span className="grow" />
          <button type="submit" className="btn primary" disabled={busy || !text.trim()}>Add</button>
        </div>
      </form>
    </Modal>
  );
}
