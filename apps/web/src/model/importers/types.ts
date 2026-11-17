export type ImportSourceId =
  | "backupCsv"
  | "todoist"
  | "genericCsv"
  | "todotxt"
  | "markdown"
  | "microsoftTodo"
  | "googleTasks"
  | "appleReminders"
  | "trello"
  | "notion"
  | "anydo"
  | "things";

export interface ImportFolder {
  sourceKey: string;
  name: string;
  sortOrder?: number;
}

export interface ImportList {
  sourceKey: string;
  name: string;
  folderKey?: string;
  viewMode?: "list" | "kanban" | "timeline";
  color?: string | null;
  kind?: "TASK" | "NOTE";
}

export interface ImportSection {
  sourceKey: string;
  listKey: string;
  name: string;
  sortOrder?: number;
}

export interface ImportTag {
  name: string;
  label: string;
  color?: string | null;
}

export interface ImportChecklistItem {
  sourceId?: string;
  title: string;
  status: 0 | 1;
  sortOrder: number;
}

export interface ImportTask {
  /** Stable source identifier (within the source) used to derive deterministic NoorTasks task IDs. */
  sourceId: string;
  /** Optional explicit 24-hex or legacy task ID (used by backup CSV restore). */
  explicitId?: string;
  listKey: string;
  sectionKey?: string;
  parentSourceId?: string;
  title: string;
  kind: "TEXT" | "NOTE" | "CHECKLIST";
  content?: string;
  desc?: string;
  items?: ImportChecklistItem[];
  status: 0 | 2 | -1;
  priority: 0 | 1 | 3 | 5;
  startDate?: string;
  dueDate?: string;
  isAllDay?: boolean;
  isFloating?: boolean;
  timeZone?: string;
  reminders?: Array<{ trigger: string }>;
  repeatFlag?: string;
  repeatFrom?: "0" | "1" | "2";
  exDate?: string[];
  tags: string[];
  sortOrder?: number;
  createdTime?: string;
  completedTime?: string;
}

export type ImportLossCategory =
  | "unsupported_recurrence"
  | "recurrence_start_lost"
  | "unsupported_reminder"
  | "attachment"
  | "comment"
  | "assignee"
  | "subtask_depth"
  | "subtask_cross_list"
  | "field_ignored"
  | "duration"
  | "completed_absent"
  | "metadata"
  | "unmapped_column"
  | "invalid_date"
  | "parse_warning";

export interface ImportLossItem {
  category: ImportLossCategory;
  sourceItem?: string;
  field?: string;
  reason: string;
  count?: number;
}

export interface ImportCounts {
  tasks: number;
  open: number;
  completed: number;
  wontDo: number;
  checklists: number;
  subtasks: number;
  notes: number;
  lists: number;
  folders: number;
  tags: number;
  sections: number;
}

export interface ImportBundle {
  source: ImportSourceId;
  sourceLabel: string;
  folders: ImportFolder[];
  lists: ImportList[];
  sections: ImportSection[];
  tags: ImportTag[];
  tasks: ImportTask[];
  losses: ImportLossItem[];
  counts: ImportCounts;
  /** Preview table columns (kept optional for UI rendering). */
  previewRows?: Array<{
    title: string;
    list: string;
    status: string;
    due: string;
    tags: string;
  }>;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  createdProjects: number;
  createdFolders: number;
  createdTags: number;
  createdColumns: number;
  losses: ImportLossItem[];
}

export interface CsvColumnMapping {
  title: string;
  notes?: string;
  list?: string;
  section?: string;
  tags?: string;
  priority?: string;
  status?: string;
  startDate?: string;
  dueDate?: string;
  timeZone?: string;
  repeat?: string;
  parent?: string;
  id?: string;
}

export interface CsvInspection {
  headers: string[];
  sampleRows: string[][];
  suggested: CsvColumnMapping;
}

export interface ParseImportOptions {
  fileName?: string;
  defaultTimeZone?: string;
  now?: number;
  listName?: string;
  csvMapping?: CsvColumnMapping;
}
