import Dexie, { type Table } from "dexie";
import type { Column, Filter, Preferences, Project, ProjectGroup, Tag, Task } from "../lib/core";
import type { Checkin, Countdown, FocusRecord, FocusTimer, Habit, HabitRecord, HabitSection } from "./m4types";

export type OpKind =
  | "task" // upsert, key = task id, payload {add?: true}
  | "taskDelete" // key = task id, payload {taskId, projectId}
  | "taskProject" // payload {taskId, toProjectId}
  | "taskParent" // payload {taskId, parentId, oldParentId, projectId}
  | "project" // upsert, key = id, payload {add?: true}
  | "projectDelete"
  | "group" // upsert
  | "groupDelete"
  | "tag" // upsert, key = name, payload {add?: true}
  | "tagRename" // payload {name, newName}
  | "tagMerge"
  | "tagDelete" // payload {name}
  | "trashRestore" // payload {taskId, projectId}
  | "deleteForever" // payload {taskId, projectId}
  | "cleanTrash"
  | "settings" // coalesced, payload = keys to merge
  | "column" // upsert kanban column, key = id, payload {add?: true}
  | "columnDelete" // key = column id, payload {columnId, projectId}
  | "ext" // coalesced extended preferences, payload = whole sections to merge
  | "order" // manual order records, key = scope, payload {typeKey, records: [{id, order}]}
  | "upload" // payload {taskId, projectId, attachmentId, fileName, blobKey}
  | "attachmentDelete" // payload {taskId, attachmentId}
  | "m4" // M4 upsert, key = id, payload {entity, add?: true}
  | "m4Delete" // M4 delete, key = id, payload {entity}
  | "pref" // coalesced small preference object, key = name (pomodoro | habit), payload = keys to merge
  | "focusOp" // live timer op that could not be sent, payload = the op
  | "filter" // M5 custom filter upsert, key = id, payload {add?: true}
  | "filterDelete"; // M5 custom filter delete, key = id

export interface Op {
  seq?: number;
  kind: OpKind;
  key: string;
  payload: Record<string, unknown>;
  tries?: number;
  createdAt?: number;
}

export interface KV {
  k: string;
  v: unknown;
}

export interface BlobRow {
  id: string;
  blob: Blob;
  name: string;
  type: string;
}

export class NoorDb extends Dexie {
  tasks!: Table<Task, string>;
  projects!: Table<Project, string>;
  groups!: Table<ProjectGroup, string>;
  tags!: Table<Tag, string>;
  columns!: Table<Column, string>;
  outbox!: Table<Op, number>;
  kv!: Table<KV, string>;
  blobs!: Table<BlobRow, string>;
  habits!: Table<Habit, string>;
  habitSections!: Table<HabitSection, string>;
  checkins!: Table<Checkin, string>;
  habitRecords!: Table<HabitRecord, string>;
  pomos!: Table<FocusRecord, string>;
  timers!: Table<FocusTimer, string>;
  countdowns!: Table<Countdown, string>;
  filters!: Table<Filter, string>;

  constructor(name = "noortasks") {
    super(name);
    this.version(1).stores({
      tasks: "id, projectId, parentId, status, deleted",
      projects: "id",
      groups: "id",
      tags: "name",
      outbox: "++seq, [kind+key]",
      kv: "k",
      blobs: "id",
    });
    // M3: kanban columns (sections)
    this.version(2).stores({ columns: "id, projectId" });
    // M4: habits, focus, countdown
    this.version(3).stores({
      habits: "id",
      habitSections: "id",
      checkins: "id, habitId, [habitId+checkinStamp]",
      habitRecords: "id, habitId",
      pomos: "id, type",
      timers: "id",
      countdowns: "id",
    });
    // M5: custom filters (smart lists)
    this.version(4).stores({ filters: "id" });
  }

  async getKV<T>(k: string, d: T): Promise<T> {
    const row = await this.kv.get(k);
    return row ? (row.v as T) : d;
  }
  setKV(k: string, v: unknown): Promise<string> {
    return this.kv.put({ k, v });
  }
}

export type { Preferences };
