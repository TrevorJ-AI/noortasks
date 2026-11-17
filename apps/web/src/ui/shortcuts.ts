/** Shortcut registry (Settings > Shortcuts, the ? sheet and the global key handler share it). */
export interface ShortcutDef {
  id: string;
  label: string;
  keys: string;
  locked?: boolean;
}
export interface ShortcutGroup {
  title: string;
  items: ShortcutDef[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "General",
    items: [
      { id: "save", label: "Save", keys: "Ctrl+S", locked: true },
      { id: "sync", label: "Sync", keys: "." },
      { id: "cancel", label: "Cancel", keys: "Esc", locked: true },
      { id: "undo", label: "Undo", keys: "Ctrl+Z" },
      { id: "redo", label: "Redo", keys: "Ctrl+Shift+Z" },
      { id: "print", label: "Print", keys: "Ctrl+P" },
      { id: "command", label: "Open Command Menu", keys: "Ctrl+K" },
      { id: "shortcuts", label: "Shortcuts", keys: "?" },
    ],
  },
  {
    title: "Task",
    items: [
      { id: "add_task", label: "Add task", keys: "Tab+N / N" },
      { id: "add_below", label: "Add task below", keys: "Enter", locked: true },
      { id: "add_subtask", label: "Add subtask", keys: "Shift+Enter", locked: true },
      { id: "toggle_groups", label: "Toggle all groups", keys: "" },
      { id: "expand_all", label: "Expand/Collapse all subtasks", keys: "Tab+E" },
      { id: "view_list", label: "List View", keys: "V L" },
      { id: "view_kanban", label: "Kanban View", keys: "V K" },
      { id: "view_timeline", label: "Timeline View", keys: "V T" },
    ],
  },
  {
    title: "Quick Add",
    items: [
      { id: "qa_date", label: "Set due date for the task", keys: "*", locked: true },
      { id: "qa_priority", label: "Set priority for the task", keys: "!", locked: true },
      { id: "qa_tag", label: "Set tag for the task", keys: "#", locked: true },
      { id: "qa_list", label: "Add/move task to certain list", keys: "~ / ^", locked: true },
      { id: "qa_assignee", label: "Assign task to certain member", keys: "@", locked: true },
    ],
  },
  {
    title: "Edit Tasks",
    items: [
      { id: "complete", label: "Complete tasks", keys: "Tab+M" },
      { id: "pin", label: "Pin tasks", keys: "Tab+P" },
      { id: "delete", label: "Delete tasks", keys: "Ctrl+Delete" },
      { id: "set_date", label: "Set date", keys: "Tab+D" },
      { id: "clear_time", label: "Clear time", keys: "Tab+0" },
      { id: "date_today", label: "Set today", keys: "Tab+1" },
      { id: "date_tomorrow", label: "Set tomorrow", keys: "Tab+2" },
      { id: "date_next_week", label: "Set next week", keys: "Tab+3" },
      { id: "priority", label: "Set priority", keys: "Alt+0/1/2/3", locked: true },
    ],
  },
  {
    title: "Navigation",
    items: [
      { id: "nav_task", label: "Go to Tasks", keys: "" },
      { id: "nav_calendar", label: "Go to Calendar", keys: "" },
      { id: "nav_split", label: "Show/Hide Split View", keys: "" },
      { id: "nav_search", label: "Go to Search", keys: "/" },
      { id: "nav_settings", label: "Go to Settings", keys: "G S" },
      { id: "nav_all", label: "Go to All", keys: "G A" },
      { id: "nav_today", label: "Go to Today", keys: "G T" },
      { id: "nav_tomorrow", label: "Go to Tomorrow", keys: "G R" },
      { id: "nav_week", label: "Go to Next 7 Days", keys: "G N" },
      { id: "nav_assigned", label: "Go to Assigned to Me", keys: "G M" },
      { id: "nav_inbox", label: "Go to Inbox", keys: "G I" },
      { id: "nav_completed", label: "Go to Completed", keys: "G C" },
      { id: "nav_wontdo", label: "Go to Won't do", keys: "G W" },
      { id: "nav_summary", label: "Go to Summary", keys: "G B" },
      { id: "nav_trash", label: "Go to Trash", keys: "G G" },
    ],
  },
  {
    title: "Calendar",
    items: [
      { id: "cal_day", label: "Day View", keys: "D / 1", locked: true },
      { id: "cal_week", label: "Week View", keys: "W / 2", locked: true },
      { id: "cal_month", label: "Month View", keys: "M / 3", locked: true },
      { id: "cal_year", label: "Year View", keys: "Y / 4", locked: true },
      { id: "cal_agenda", label: "Agenda", keys: "A / 5", locked: true },
      { id: "cal_today", label: "Back to Today", keys: "T", locked: true },
      { id: "cal_goto", label: "Go to Date", keys: "" },
    ],
  },
];

export const ALL_SHORTCUTS = SHORTCUT_GROUPS.flatMap((g) => g.items);

export function keyLabel(keys: string): string {
  // a two-key sequence ("G S") reads "G then S"; alternatives ("Tab+N / N") stay as they are
  return (
    keys
      .split(" / ")
      .map((k) => (/^[A-Z] [A-Z0-9]$/.test(k.trim()) ? k.trim().replace(" ", " then ") : k))
      .join(" / ") || "None"
  );
}

/** Normalise a keyboard event to the registry notation: "Ctrl+Shift+Z", "Tab+M", ".", "G". */
export function eventCombo(e: KeyboardEvent, tabHeld: boolean): string {
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key === "Delete" ? "Delete" : e.key;
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey && e.key.length !== 1) mods.push("Shift");
  if (e.shiftKey && (e.ctrlKey || e.metaKey) && e.key.length === 1) mods.push("Shift");
  if (tabHeld && k !== "Tab") mods.push("Tab");
  return [...mods, k].join("+");
}

/** All alternatives of one binding ("Tab+N / N" -> ["Tab+N", "N"]; "G S" stays a two-key sequence). */
export function alternatives(keys: string): string[] {
  return keys
    .split(" / ")
    .map((s) => s.trim())
    .filter(Boolean);
}
