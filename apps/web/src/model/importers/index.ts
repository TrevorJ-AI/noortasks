import { parseBackupCsvBundle } from "../backupCsv";
import { parseAnydoBundle } from "./anydo";
import { parseAppleRemindersIcsBundle } from "./appleReminders";
import { inspectGenericCsv, parseGenericCsvBundle } from "./genericCsv";
import { parseGoogleTasksBundle } from "./googleTasks";
import { parseMarkdownBundle } from "./markdown";
import { fetchMsTodoGraphJson, parseMsTodoBundle } from "./microsoftTodo";
import { parseNotionCsvBundle } from "./notion";
import { parseThingsBundle } from "./things";
import { parseTodoistBundle } from "./todoist";
import { parseTodoTxtBundle } from "./todotxt";
import { parseTrelloBundle } from "./trello";
import { executeImportBundle } from "./execute";
import type {
  CsvInspection,
  ImportBundle,
  ImportSourceId,
  ParseImportOptions,
} from "./types";

export interface ImportSourceMeta {
  id: ImportSourceId;
  label: string;
  accept: string;
  title: string;
  description: string;
}

export const IMPORT_SOURCES: Record<ImportSourceId, ImportSourceMeta> = {
  backupCsv: {
    id: "backupCsv",
    label: "NoorTasks Backup",
    accept: ".csv,text/csv",
    title: "Import Backups",
    description: "Backup CSV file. Existing tasks (same task id) are skipped; lists, folders, sections and tags are created by name.",
  },
  todoist: {
    id: "todoist",
    label: "Todoist",
    accept: ".csv,.json,text/csv,application/json",
    title: "Import from Todoist",
    description: "Project CSV export or JSON backup.",
  },
  genericCsv: {
    id: "genericCsv",
    label: "CSV",
    accept: ".csv,text/csv",
    title: "Import from CSV",
    description: "Any CSV spreadsheet; map columns to task fields before importing.",
  },
  todotxt: {
    id: "todotxt",
    label: "todo.txt",
    accept: ".txt,text/plain",
    title: "Import from todo.txt",
    description: "Plain-text todo.txt file with priorities, +projects, @tags, due:, and rec: tokens.",
  },
  markdown: {
    id: "markdown",
    label: "Markdown",
    accept: ".md,.markdown,.txt,text/markdown,text/plain",
    title: "Import from Markdown",
    description: "Markdown checklists (# lists, ## sections, - [ ] tasks, nested subtasks).",
  },
  microsoftTodo: {
    id: "microsoftTodo",
    label: "Microsoft To Do",
    accept: ".json,application/json",
    title: "Import from Microsoft To Do",
    description: "Graph JSON export (or fetch directly in your browser using a Graph access token).",
  },
  googleTasks: {
    id: "googleTasks",
    label: "Google Tasks",
    accept: ".json,application/json",
    title: "Import from Google Tasks",
    description: "Takeout Tasks.json export.",
  },
  appleReminders: {
    id: "appleReminders",
    label: "Apple Reminders",
    accept: ".ics,text/calendar",
    title: "Import from Apple Reminders",
    description: "iCalendar (.ics) export containing VTODO tasks, repeats, and alarms.",
  },
  trello: {
    id: "trello",
    label: "Trello",
    accept: ".json,application/json",
    title: "Import from Trello",
    description: "Board JSON export (.json).",
  },
  notion: {
    id: "notion",
    label: "Notion",
    accept: ".csv,text/csv",
    title: "Import from Notion",
    description: "Database CSV export (.csv).",
  },
  anydo: {
    id: "anydo",
    label: "Any.do",
    accept: ".csv,.json,text/csv,application/json",
    title: "Import from Any.do",
    description: "Archived tasks CSV export (.csv).",
  },
  things: {
    id: "things",
    label: "Things 3",
    accept: ".txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv",
    title: "Import from Things 3",
    description: "todo.txt, Markdown, or CSV export.",
  },
};

export function parseImportSource(source: ImportSourceId, text: string, opts: ParseImportOptions = {}): ImportBundle {
  switch (source) {
    case "backupCsv":
      return parseBackupCsvBundle(text);
    case "todoist":
      return parseTodoistBundle(text, opts);
    case "genericCsv":
      return parseGenericCsvBundle(text, opts);
    case "todotxt":
      return parseTodoTxtBundle(text, opts);
    case "markdown":
      return parseMarkdownBundle(text, opts);
    case "microsoftTodo":
      return parseMsTodoBundle(text, opts);
    case "googleTasks":
      return parseGoogleTasksBundle(text, opts);
    case "appleReminders":
      return parseAppleRemindersIcsBundle(text, opts);
    case "trello":
      return parseTrelloBundle(text, opts);
    case "notion":
      return parseNotionCsvBundle(text, opts);
    case "anydo":
      return parseAnydoBundle(text, opts);
    case "things":
      return parseThingsBundle(text, opts);
  }
}

export {
  executeImportBundle,
  fetchMsTodoGraphJson,
  inspectGenericCsv,
  parseAnydoBundle,
  parseAppleRemindersIcsBundle,
  parseBackupCsvBundle,
  parseGenericCsvBundle,
  parseGoogleTasksBundle,
  parseMarkdownBundle,
  parseMsTodoBundle,
  parseNotionCsvBundle,
  parseThingsBundle,
  parseTodoTxtBundle,
  parseTodoistBundle,
  parseTrelloBundle,
};
export type { CsvInspection };
export type * from "./types";
