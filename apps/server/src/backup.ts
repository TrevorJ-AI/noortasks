import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import {
  ActivityAction,
  MAX_TASK_DEPTH,
  ORDER_STEP,
  Priority,
  TaskKind,
  TaskStatus,
  clampOrder,
  formatServerDate,
  isPlainObject,
  newEtag,
  newId,
  parseTrigger,
  type ChecklistItem,
  type Column,
  type Loose,
  type Project,
  type ProjectGroup,
  type Task,
} from "@noortasks/core";
import type { FastifyInstance } from "fastify";
import type { ActivityService } from "./activity.js";
import { verifyPassphrase, type AuthConfig } from "./auth.js";
import { JSON_LIMIT } from "./http-security.js";
import { ApiError, type Service } from "./service.js";

// 23-column CSV backup layout kept compatible with TickTick CSV exports.
export const BACKUP_CSV_HEADER = [
  "Folder Name",
  "List Name",
  "Title",
  "Tags",
  "Content",
  "Is Check list",
  "Start Date",
  "Due Date",
  "Reminder",
  "Repeat",
  "Priority",
  "Status",
  "Created Time",
  "Completed Time",
  "Order",
  "Timezone",
  "Is All Day",
  "Is Floating",
  "Column Name",
  "Column Order",
  "View Mode",
  "taskId",
  "parentId",
] as const;

export function escapeCsvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(","));
  return lines.join("\r\n") + "\r\n";
}

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      if (row.length > 64) throw new ApiError(400, "csv_too_complex");
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (rows.length >= 10_000 || row.length > 64) throw new ApiError(400, "csv_too_complex");
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (inQuotes) throw new ApiError(400, "invalid_csv", "unterminated quoted field");
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function colLetters(idx: number): string {
  let n = idx + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Build a minimal, standard-compliant `.xlsx` workbook (ZIP Store with OOXML sheets). */
export function buildXlsx(sheetName: string, headers: readonly string[], rows: readonly unknown[][]): Buffer {
  const allRows: unknown[][] = [[...headers], ...rows];
  const sheetRowsXml = allRows
    .map((r, ri) => {
      const cells = r
        .map((val, ci) => {
          const ref = `${colLetters(ci)}${ri + 1}`;
          if (typeof val === "number" && Number.isFinite(val)) {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          const txt = val === null || val === undefined ? "" : String(val);
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(txt)}</t></is></c>`;
        })
        .join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");

  const files: Array<{ name: string; data: Buffer }> = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
          "</Types>",
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>",
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          `<sheets><sheet name="${escapeXml(sheetName.slice(0, 31) || "Sheet1")}" sheetId="1" r:id="rId1"/></sheets>` +
          "</workbook>",
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
          "</Relationships>",
      ),
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
          `<sheetData>${sheetRowsXml}</sheetData>` +
          "</worksheet>",
      ),
    },
  ];

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const sum = crc32(f.data) >>> 0;
    const len = f.data.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6); // UTF-8
    lfh.writeUInt16LE(0, 8); // store
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(sum, 14);
    lfh.writeUInt32LE(len, 18);
    lfh.writeUInt32LE(len, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    localParts.push(lfh, nameBuf, f.data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0, 14);
    cdh.writeUInt32LE(sum, 16);
    cdh.writeUInt32LE(len, 20);
    cdh.writeUInt32LE(len, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30);
    cdh.writeUInt16LE(0, 32);
    cdh.writeUInt16LE(0, 34);
    cdh.writeUInt16LE(0, 36);
    cdh.writeUInt32LE(0, 38);
    cdh.writeUInt32LE(offset, 42);
    centralParts.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + len;
  }

  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

function serializeContent(t: Task): string {
  if (t.kind === TaskKind.Checklist || (Array.isArray(t.items) && t.items.length > 0)) {
    const lines = (t.items ?? []).map((it) => `- [${it.status ? "x" : " "}] ${it.title ?? ""}`);
    const desc = typeof t.desc === "string" && t.desc ? `${t.desc}\n` : "";
    return `${desc}${lines.join("\n")}`;
  }
  return typeof t.content === "string" ? t.content : "";
}

function parseChecklistContent(raw: string): { desc: string; items: ChecklistItem[] } {
  const items: ChecklistItem[] = [];
  const descLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const md = /^\s*(?:[-*]\s*)?\[([ xX])\]\s*(.*)$/.exec(line);
    const sym = /^\s*([▫▪])\s*(.*)$/.exec(line);
    if (md) {
      items.push({ id: newId(), title: md[2] ?? "", status: md[1]!.toLowerCase() === "x" ? 1 : 0, sortOrder: items.length * ORDER_STEP });
    } else if (sym) {
      items.push({ id: newId(), title: sym[2] ?? "", status: sym[1] === "▪" ? 1 : 0, sortOrder: items.length * ORDER_STEP });
    } else {
      descLines.push(line);
    }
  }
  return { desc: descLines.join("\n").trim(), items };
}

function parsePriorityCell(raw: string): number {
  const s = raw.trim().toLowerCase();
  if (s === "5" || s === "high") return Priority.High;
  if (s === "3" || s === "medium") return Priority.Medium;
  if (s === "1" || s === "low") return Priority.Low;
  return Priority.None;
}

function parseStatusCell(raw: string, archiveLegend: boolean): number {
  const s = raw.trim().toLowerCase();
  if (s === "-1" || s === "abandoned" || s === "wontdo" || s === "won't do") return TaskStatus.WontDo;
  if (s === "completed" || s === "done") return TaskStatus.Completed;
  if (archiveLegend) {
    if (s === "1") return TaskStatus.Completed;
    if (s === "2") return TaskStatus.WontDo;
    return TaskStatus.Open;
  }
  if (s === "2" || s === "1") return TaskStatus.Completed;
  return TaskStatus.Open;
}

function parseBoolCell(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase();
  if (s === "true" || s === "y" || s === "yes" || s === "1") return true;
  if (s === "false" || s === "n" || s === "no" || s === "0") return false;
  return undefined;
}

export interface RestoreResult {
  imported: number;
  skipped: number;
  createdProjects: number;
  createdFolders: number;
  createdTags: number;
  createdColumns: number;
}

export interface BackupAuthOpts {
  noAuth?: boolean;
  auth?: AuthConfig;
  /**
   * Multi-user mode: re-check the signed-in member before export or restore. Password accounts re-enter their
   * password; accounts that sign in with OIDC have no password, so the check is the live session plus CSRF.
   */
  verify?: (password: string) => Promise<boolean>;
}

export class BackupService {
  private verifyTokens = new Map<string, number>();

  constructor(
    private svc: Service,
    private act?: ActivityService,
    private opts: BackupAuthOpts = {},
  ) {}

  private get store() {
    return this.svc.store;
  }

  async issueVerifyId(body: unknown): Promise<{ verifyId: string }> {
    if (!this.opts.noAuth) {
      const pw = isPlainObject(body) && typeof body.password === "string" ? body.password : "";
      const ok = this.opts.verify ? await this.opts.verify(pw) : !!this.opts.auth && !!pw && (await verifyPassphrase(pw, this.opts.auth.passphraseHash));
      if (!ok) {
        throw new ApiError(401, "incorrect_password");
      }
    }
    for (const [token, expires] of this.verifyTokens) if (expires <= this.svc.now()) this.verifyTokens.delete(token);
    if (this.verifyTokens.size >= 1000) throw new ApiError(429, "too_many_verifications");
    const id = randomBytes(16).toString("hex");
    this.verifyTokens.set(id, this.svc.now() + 15 * 60_000);
    return { verifyId: id };
  }

  requireVerifyId(header: unknown): void {
    const token = typeof header === "string" ? header.trim() : "";
    if (!token) throw new ApiError(403, "verify_required");
    if (this.opts.noAuth) return;
    const exp = this.verifyTokens.get(token);
    if (!exp || exp < this.svc.now()) {
      this.verifyTokens.delete(token);
      throw new ApiError(403, "verify_required");
    }
  }

  exportTasksCsv(): string {
    const groups = new Map(this.store.collAll<ProjectGroup>("project_groups").map((g) => [g.id, g]));
    const projects = new Map(this.store.collAll<Project>("projects").map((p) => [p.id, p]));
    const columns = new Map(this.store.collAll<Column>("columns").map((c) => [c.id, c]));

    const tasks = this.store
      .all<{ json: string }>("select json from tasks where deleted = 0 order by pos asc")
      .map((r) => JSON.parse(r.json) as Task);

    const rows = tasks.map((t) => {
      const proj = projects.get(t.projectId);
      const group = proj?.groupId ? groups.get(proj.groupId) : undefined;
      const col = t.columnId ? columns.get(t.columnId) : undefined;
      const isChecklist = t.kind === TaskKind.Checklist || (Array.isArray(t.items) && t.items.length > 0);
      const reminders = Array.isArray(t.reminders) && t.reminders.length > 0
        ? t.reminders.map((r) => r.trigger).filter(Boolean).join("\n")
        : typeof t.reminder === "string"
          ? t.reminder
          : "";
      return [
        group?.name ?? "",
        t.projectId === this.svc.inboxId ? "Inbox" : (proj?.name ?? "Inbox"),
        t.title ?? "",
        Array.isArray(t.tags) ? t.tags.join(", ") : "",
        serializeContent(t),
        isChecklist ? "Y" : "N",
        t.startDate ?? "",
        t.dueDate ?? "",
        reminders,
        t.repeatFlag ?? "",
        t.priority ?? 0,
        t.status ?? 0,
        t.createdTime ?? "",
        t.completedTime ?? "",
        t.sortOrder ?? 0,
        t.timeZone ?? "",
        t.isAllDay === true ? "true" : t.isAllDay === false ? "false" : "",
        t.isFloating === true ? "true" : "false",
        col?.name ?? "",
        col?.sortOrder ?? "",
        proj?.viewMode ?? "list",
        t.id,
        t.parentId ?? "",
      ];
    });

    return serializeCsv(BACKUP_CSV_HEADER, rows);
  }

  importTasksCsv(csvText: string): RestoreResult {
    const parsed = parseCsv(csvText);
    let legend = false;
    let headerIdx = -1;
    for (let i = 0; i < parsed.length; i++) {
      const row = parsed[i]!;
      const joined = row.join(" ").toLowerCase();
      if (joined.includes("1 completed") && joined.includes("2 archived")) legend = true;
      const norm = row.map((c) => c.trim().toLowerCase());
      if (norm.includes("title") && (norm.includes("list name") || norm.includes("taskid") || norm.includes("status"))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) throw new ApiError(400, "invalid_csv", "missing backup CSV header");

    const colIdx = new Map<string, number>();
    parsed[headerIdx]!.forEach((name, idx) => colIdx.set(name.trim().toLowerCase(), idx));
    const cell = (row: string[], key: string): string => {
      const i = colIdx.get(key);
      return i !== undefined && i < row.length ? (row[i] ?? "") : "";
    };

    const res: RestoreResult = { imported: 0, skipped: 0, createdProjects: 0, createdFolders: 0, createdTags: 0, createdColumns: 0 };

    this.store.tx(() => {
      const seq = this.store.seq();
      const now = formatServerDate(this.svc.now());

      const folderByName = new Map(this.store.collAll<ProjectGroup>("project_groups").map((g) => [g.name, g]));
      const projectByName = new Map(this.store.collAll<Project>("projects").map((p) => [p.name, p]));
      const columnByProjName = new Map<string, Column>();
      for (const c of this.store.collAll<Column>("columns")) columnByProjName.set(`${c.projectId}\0${c.name}`, c);
      const tagByName = new Map(this.store.collAll<Loose>("tags").map((t) => [String(t.name).toLowerCase(), t]));

      const pendingParents: Array<{ childId: string; rawParentId: string }> = [];
      const idRemap = new Map<string, string>();

      for (let i = headerIdx + 1; i < parsed.length; i++) {
        const row = parsed[i]!;
        if (row.every((x) => !x.trim())) continue;

        const rawTaskId = cell(row, "taskid").trim();
        if (rawTaskId && this.store.getTaskRow(rawTaskId)) {
          res.skipped++;
          continue;
        }

        // Folder
        const folderName = cell(row, "folder name").trim();
        let groupId: string | null = null;
        if (folderName) {
          let grp = folderByName.get(folderName);
          if (!grp) {
            grp = { id: newId(this.svc.now()), name: folderName, sortOrder: folderByName.size * ORDER_STEP, etag: newEtag() };
            this.store.collPut("project_groups", grp.id, grp, { seq });
            folderByName.set(folderName, grp);
            res.createdFolders++;
          }
          groupId = grp.id;
        }

        // List / Project
        const listName = cell(row, "list name").trim();
        const viewModeRaw = cell(row, "view mode").trim().toLowerCase();
        const viewMode = viewModeRaw === "kanban" || viewModeRaw === "timeline" ? viewModeRaw : "list";
        let projectId = this.svc.inboxId;
        if (listName && listName.toLowerCase() !== "inbox") {
          let proj = projectByName.get(listName);
          if (!proj) {
            proj = {
              id: newId(this.svc.now()),
              name: listName,
              color: null,
              groupId,
              sortOrder: -(projectByName.size + 1) * ORDER_STEP,
              viewMode,
              kind: "TASK",
              inAll: true,
              isOwner: true,
              muted: false,
              closed: null,
              showType: 1,
              remindType: 1,
              etag: newEtag(),
              modifiedTime: now,
            };
            this.store.collPut("projects", proj.id, proj, { seq });
            projectByName.set(listName, proj);
            res.createdProjects++;
          }
          projectId = proj.id;
        }

        // Column
        const colName = cell(row, "column name").trim();
        let columnId: string | undefined;
        if (colName && projectId !== this.svc.inboxId) {
          const ck = `${projectId}\0${colName}`;
          let col = columnByProjName.get(ck);
          if (!col) {
            const co = Number(cell(row, "column order").trim());
            col = {
              id: newId(this.svc.now()),
              projectId,
              name: colName,
              sortOrder: Number.isFinite(co) && cell(row, "column order").trim() !== "" ? co : columnByProjName.size * ORDER_STEP,
              etag: newEtag(),
              createdTime: now,
              modifiedTime: now,
            };
            this.store.collPut("columns", col.id, col, { seq });
            columnByProjName.set(ck, col);
            res.createdColumns++;
          }
          columnId = col.id;
        }

        // Tags
        const rawTags = cell(row, "tags")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const taskTags: string[] = [];
        for (const rt of rawTags) {
          const low = rt.toLowerCase();
          if (!taskTags.includes(low)) taskTags.push(low);
          if (!tagByName.has(low)) {
            const tagObj = { name: low, rawName: rt, label: rt, color: null, sortOrder: 0, type: 1, etag: newEtag() };
            this.store.collPut("tags", low, tagObj, { seq });
            tagByName.set(low, tagObj);
            res.createdTags++;
          }
        }

        // Reminders
        const remRaw = cell(row, "reminder");
        const reminders = remRaw
          .split(/[\r\n,]+/)
          .map((s) => s.trim())
          .filter((s) => parseTrigger(s) !== null)
          .map((trigger) => ({ id: newId(this.svc.now()), trigger }));

        // Kind & Content / Checklist
        const kindCell = cell(row, "kind").trim().toUpperCase();
        const isChecklist = parseBoolCell(cell(row, "is check list")) === true || kindCell === TaskKind.Checklist;
        const contentRaw = cell(row, "content");
        let kind: string = kindCell === TaskKind.Note ? TaskKind.Note : isChecklist ? TaskKind.Checklist : TaskKind.Text;
        let content: string | undefined = contentRaw;
        let desc: string | undefined;
        let items: ChecklistItem[] | undefined;
        if (isChecklist) {
          const parsedCl = parseChecklistContent(contentRaw);
          items = parsedCl.items;
          desc = parsedCl.desc;
          content = "";
          kind = TaskKind.Checklist;
        }

        const orderNum = Number(cell(row, "order").trim());
        const sortOrder = Number.isFinite(orderNum) && cell(row, "order").trim() !== "" ? clampOrder(orderNum) : 0;
        const status = parseStatusCell(cell(row, "status"), legend);
        const priority = parsePriorityCell(cell(row, "priority"));
        const id = rawTaskId || newId(this.svc.now());
        if (rawTaskId) idRemap.set(rawTaskId, id);

        const startDate = cell(row, "start date").trim() || undefined;
        const dueDate = cell(row, "due date").trim() || undefined;
        const repeatFlag = cell(row, "repeat").trim() || undefined;
        const createdTime = cell(row, "created time").trim() || now;
        const completedTime = cell(row, "completed time").trim() || (status === TaskStatus.Completed || status === TaskStatus.WontDo ? now : undefined);
        const timeZone = cell(row, "timezone").trim() || undefined;
        const isAllDay = parseBoolCell(cell(row, "is all day"));
        const isFloating = parseBoolCell(cell(row, "is floating"));
        const rawParentId = cell(row, "parentid").trim();

        const task: Task = {
          id,
          projectId,
          title: cell(row, "title"),
          kind,
          status,
          priority,
          sortOrder,
          creator: this.svc.userId,
          createdTime,
          modifiedTime: now,
          etag: newEtag(),
          deleted: 0,
          ...(content ? { content } : {}),
          ...(desc ? { desc } : {}),
          ...(items ? { items } : {}),
          ...(taskTags.length ? { tags: taskTags } : {}),
          ...(startDate ? { startDate } : {}),
          ...(dueDate ? { dueDate } : {}),
          ...(reminders.length ? { reminders } : {}),
          ...(repeatFlag ? { repeatFlag } : {}),
          ...(completedTime ? { completedTime } : {}),
          ...(timeZone ? { timeZone } : {}),
          ...(isAllDay !== undefined ? { isAllDay } : {}),
          ...(isFloating !== undefined ? { isFloating } : {}),
          ...(columnId ? { columnId } : {}),
        };

        this.store.putTask(task, { seq });
        this.act?.recordTaskCreated(task);
        res.imported++;
        if (rawParentId) pendingParents.push({ childId: id, rawParentId });
      }

      // Pass 2: link parents cleanly
      for (const { childId, rawParentId } of pendingParents) {
        const parentId = idRemap.get(rawParentId) ?? rawParentId;
        if (parentId === childId) continue;
        const child = this.store.getTask(childId);
        const parent = this.store.getTask(parentId);
        if (!child || !parent || parent.deleted || child.projectId !== parent.projectId) continue;
        // Cycle & depth check
        let cur: Task | undefined = parent;
        let depth = 1;
        let cycle = false;
        while (cur && depth <= MAX_TASK_DEPTH + 2) {
          if (cur.id === childId) {
            cycle = true;
            break;
          }
          cur = cur.parentId ? this.store.getTask(cur.parentId) : undefined;
          depth++;
        }
        if (cycle || depth > MAX_TASK_DEPTH) continue;
        child.parentId = parent.id;
        parent.childIds = [...new Set([...(parent.childIds ?? []), child.id])];
        this.store.putTask(child, { seq });
        this.store.putTask(parent, { seq });
      }
    });

    return res;
  }

  exportHabitsData(): { headers: string[]; rows: unknown[][] } {
    const habits = new Map(this.store.collAll<Loose>("habits").map((h) => [String(h.id), h]));
    const recordsByHabitDay = new Map<string, Loose>();
    for (const r of this.store.all<{ habitId: string; stamp: number; json: string }>("select habitId, stamp, json from habit_records")) {
      recordsByHabitDay.set(`${r.habitId}\0${r.stamp}`, JSON.parse(r.json) as Loose);
    }
    const checkins = this.store
      .all<{ habitId: string; stamp: number; json: string }>("select habitId, stamp, json from habit_checkins order by habitId, stamp")
      .map((r) => ({ habitId: r.habitId, stamp: r.stamp, obj: JSON.parse(r.json) as Loose }));

    const headers = ["Habit Id", "Habit Name", "Type", "Goal", "Unit", "Date", "Status", "Value", "Note", "Mood", "Checkin Time"];
    const rows = checkins.map(({ habitId, stamp, obj }) => {
      const h = habits.get(habitId);
      const rec = recordsByHabitDay.get(`${habitId}\0${stamp}`);
      return [
        habitId,
        String(h?.name ?? ""),
        String(h?.type ?? "Boolean"),
        typeof h?.goal === "number" ? h.goal : 1,
        String(h?.unit ?? "Count"),
        stamp,
        typeof obj.status === "number" ? obj.status : 0,
        typeof obj.value === "number" ? obj.value : 0,
        typeof rec?.content === "string" ? rec.content : "",
        typeof rec?.mood === "number" || typeof rec?.mood === "string"
          ? rec.mood
          : typeof rec?.emoji === "number" || typeof rec?.emoji === "string"
            ? rec.emoji
            : "",
        typeof obj.checkinTime === "string" ? obj.checkinTime : "",
      ];
    });
    return { headers, rows };
  }

  exportFocusData(): { headers: string[]; rows: unknown[][] } {
    const headers = ["Id", "Type", "Start Time", "End Time", "Duration (min)", "Pause Duration (sec)", "Adjust Time (sec)", "Bindings", "Note"];
    const recs = this.store
      .all<{ type: number; startMs: number; endMs: number; json: string }>("select type, startMs, endMs, json from pomodoros order by startMs asc, id asc")
      .map((r) => ({ type: r.type, startMs: r.startMs, endMs: r.endMs, obj: JSON.parse(r.json) as Loose }));

    const rows = recs.map(({ type, startMs, endMs, obj }) => {
      const pause = typeof obj.pauseDuration === "number" ? obj.pauseDuration : 0;
      const adjust = typeof obj.adjustTime === "number" ? obj.adjustTime : 0;
      const activeMs = Math.max(0, endMs - startMs - pause * 1000 + adjust * 1000);
      const mins = Math.round((activeMs / 60000) * 100) / 100;
      const binds = Array.isArray(obj.tasks)
        ? obj.tasks
            .filter(isPlainObject)
            .map((b) => String(b.title ?? b.timerName ?? b.taskId ?? b.habitId ?? b.timerId ?? ""))
            .filter(Boolean)
            .join("; ")
        : "";
      return [
        String(obj.id ?? ""),
        type === 1 ? "Timing" : "Pomodoro",
        formatServerDate(startMs),
        formatServerDate(endMs),
        mins,
        pause,
        adjust,
        binds,
        typeof obj.note === "string" ? obj.note : "",
      ];
    });
    return { headers, rows };
  }

  exportSingleTaskMarkdown(taskId: string): string {
    const t = this.store.getTask(taskId);
    if (!t) throw new ApiError(404, "task_not_found");
    const lines: string[] = [`# ${t.title ?? "Untitled"}`, ""];
    if (t.startDate || t.dueDate) lines.push(`- Date: ${t.startDate ?? ""}${t.dueDate && t.dueDate !== t.startDate ? ` -> ${t.dueDate}` : ""}`);
    if (t.priority) lines.push(`- Priority: ${t.priority}`);
    if (Array.isArray(t.tags) && t.tags.length) lines.push(`- Tags: ${t.tags.map((x) => `#${x}`).join(" ")}`);
    if (t.status === TaskStatus.Completed) lines.push("- Status: Completed");
    else if (t.status === TaskStatus.WontDo) lines.push("- Status: Won't Do");
    lines.push("");
    const body = serializeContent(t);
    if (body) lines.push(body, "");
    return lines.join("\n");
  }
}

export function registerBackupRoutes(
  app: FastifyInstance,
  svc: Service,
  act?: ActivityService,
  opts: BackupAuthOpts = {},
): BackupService {
  const bs = new BackupService(svc, act, opts);

  app.post("/api/v2/user/verify", async (req) => bs.issueVerifyId(req.body));

  const serveBackupCsv = async (req: { headers: Record<string, unknown> }, reply: import("fastify").FastifyReply) => {
    bs.requireVerifyId(req.headers["x-verify-id"]);
    const csv = bs.exportTasksCsv();
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="noortasks-backup.csv"');
    return reply.send(csv);
  };
  app.get("/api/v2/data/export", serveBackupCsv);
  app.get("/api/v2/data/export/auto", serveBackupCsv);
  app.get<{ Params: { id: string } }>("/api/v2/data/export/link/:id/check", async (req) => ({
    status: "ready",
    ready: true,
    id: req.params.id,
    downloadUrl: "/api/v2/data/export",
  }));

  app.post("/api/v1/import/restore", async (req) => {
    let csv = "";
    if (req.isMultipart()) {
      const part = await req.file({ limits: { fileSize: JSON_LIMIT } });
      if (!part) throw new ApiError(400, "no_file");
      csv = (await part.toBuffer()).toString("utf8");
    } else if (typeof req.body === "string") {
      csv = req.body;
    } else if (isPlainObject(req.body) && typeof req.body.csv === "string") {
      csv = req.body.csv;
    } else {
      throw new ApiError(400, "invalid_body");
    }
    return bs.importTasksCsv(csv);
  });

  app.get<{ Querystring: { format?: string } }>("/api/v2/data/export/habits", async (req, reply) => {
    const { headers, rows } = bs.exportHabitsData();
    const fmt = req.query.format?.toLowerCase();
    const accept = typeof req.headers.accept === "string" ? req.headers.accept.toLowerCase() : "";
    if (fmt === "csv" || (!fmt && accept.includes("text/csv"))) {
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", 'attachment; filename="habits.csv"');
      return reply.send(serializeCsv(headers, rows));
    }
    reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    reply.header("content-disposition", 'attachment; filename="habits.xlsx"');
    return reply.send(buildXlsx("Habits", headers, rows));
  });

  app.get<{ Querystring: { format?: string } }>("/api/v2/data/export/pomodoro", async (req, reply) => {
    const { headers, rows } = bs.exportFocusData();
    if (req.query.format?.toLowerCase() === "xlsx") {
      reply.header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      reply.header("content-disposition", 'attachment; filename="pomodoro.xlsx"');
      return reply.send(buildXlsx("Focus", headers, rows));
    }
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="pomodoro.csv"');
    return reply.send(serializeCsv(headers, rows));
  });

  app.get<{ Params: { id: string } }>("/api/v2/task/:id/export", async (req, reply) => {
    const md = bs.exportSingleTaskMarkdown(req.params.id);
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename*=UTF-8''task-${encodeURIComponent(req.params.id)}.md`);
    return reply.send(md);
  });

  return bs;
}
