import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../server/src/app";
import { CsvFormatError, parseCsv, previewBackupCsv } from "../src/model/backupCsv";

/** CSV import preview (IMP-014, IMP-025, IMP-033): the client reads what the server writes and what TickTick writes. */

const HEADER = '"Folder Name","List Name","Title","Tags","Content","Is Check list","Start Date","Due Date","Reminder","Repeat","Priority","Status","Created Time","Completed Time","Order","Timezone","Is All Day","Is Floating","Column Name","Column Order","View Mode","taskId","parentId"';

describe("backup CSV preview parsing", () => {
  it("RFC 4180: quotes, doubled quotes, CRLF and newlines inside a cell", () => {
    expect(parseCsv('a,"b ""x""",c\r\n"multi\nline",2,\n')).toEqual([["a", 'b "x"', "c"], ["multi\nline", "2", ""]]);
  });

  it("TickTick export: BOM, metadata preamble and status legend (1 completed, 2 archived)", () => {
    const csv = [
      "﻿\"Date: 2026-11-16+0000\"",
      '"Version: 7.1"',
      '"Status: \n0 Normal\n1 Completed\n2 Archived"',
      HEADER,
      '"Home","Chores","Fix door","errands, weekend","","N","","","","","3","0","","","0","Europe/Amsterdam","","false","","","list","aaaaaaaaaaaaaaaaaaaaaaa1",""',
      '"Home","Chores","Paint room","","","Y","","","","","0","1","","","1","Europe/Amsterdam","","false","Doing","1","kanban","aaaaaaaaaaaaaaaaaaaaaaa2",""',
      '"","Inbox","Old idea","#weekend","","N","","","","","0","2","","","2","","","false","","","list","aaaaaaaaaaaaaaaaaaaaaaa3","aaaaaaaaaaaaaaaaaaaaaaa1"',
      "",
    ].join("\n");
    const p = previewBackupCsv(csv);
    expect(p.archiveLegend).toBe(true);
    expect(p.headers[0]).toBe("Folder Name");
    expect(p.counts).toEqual({ tasks: 3, open: 1, completed: 1, wontDo: 1, checklists: 1, subtasks: 1, notes: 0, lists: 2, folders: 1, tags: 2, sections: 1 });
    expect(p.lists.sort()).toEqual(["Chores", "Inbox"]);
    expect(p.records[1]!.title).toBe("Paint room");
  });

  it("a file without the header row is refused with a readable error", () => {
    expect(() => previewBackupCsv("name,value\nx,1\n")).toThrow(CsvFormatError);
  });

  describe("against the server's own export", () => {
    const dir = mkdtempSync(join(tmpdir(), "nt-m5csv-"));
    const { app } = buildApp({ noAuth: true, dataDir: join(dir, "files"), dbPath: join(dir, "db.sqlite") });
    afterAll(async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    });
    it("counts in the preview equal what was exported", async () => {
      const status = (await app.inject({ method: "GET", url: "/api/v2/user/status" })).json() as { inboxId: string };
      const step = 2 ** 40;
      const id = (k: number) => `65a0000000000000000000${String(k).padStart(2, "0")}`;
      await app.inject({ method: "POST", url: "/api/v2/batch/projectGroup", payload: { add: [{ id: id(90), name: "Folder A", sortOrder: 0 }] } });
      await app.inject({ method: "POST", url: "/api/v2/batch/project", payload: { add: [{ id: id(91), name: "List, with comma", groupId: id(90), sortOrder: 0, kind: "TASK", viewMode: "list" }, { id: id(92), name: "Second", sortOrder: step, kind: "TASK", viewMode: "list" }] } });
      const T = (k: number, p: Record<string, unknown>) => ({ id: id(k), projectId: id(91), title: `Task ${k}`, status: 0, kind: "TEXT", priority: 0, sortOrder: k * step, tags: [], items: [], ...p });
      await app.inject({
        method: "POST",
        url: "/api/v2/batch/task",
        payload: {
          add: [
            T(1, { title: 'Quote "this", please', tags: ["errands"] }),
            T(2, { status: 2, completedTime: "2026-11-10T09:00:00.000+0000" }),
            T(3, { status: -1, projectId: id(92) }),
            T(4, { kind: "CHECKLIST", items: [{ id: id(80), title: "a", status: 0, sortOrder: 0 }], content: "line one\nline two" }),
            T(5, { projectId: status.inboxId, tags: ["weekend", "errands"] }),
          ],
        },
      });
      await app.inject({ method: "POST", url: "/api/v2/batch/task", payload: { add: [T(6, { parentId: id(1) })] } });
      const v = (await app.inject({ method: "POST", url: "/api/v2/user/verify", payload: {} })).json() as { verifyId: string };
      const csv = (await app.inject({ method: "GET", url: "/api/v2/data/export", headers: { "x-verify-id": v.verifyId } })).body;
      const p = previewBackupCsv(csv);
      expect(p.counts.tasks).toBe(6);
      expect(p.counts.completed).toBe(1);
      expect(p.counts.wontDo).toBe(1);
      expect(p.counts.open).toBe(4);
      expect(p.counts.checklists).toBe(1);
      expect(p.counts.subtasks).toBe(1);
      expect(p.counts.folders).toBe(1);
      expect(p.lists.sort()).toEqual(["Inbox", "List, with comma", "Second"]);
      expect(p.tags.sort()).toEqual(["errands", "weekend"]);
      expect(p.records.find((r) => r.taskid === id(1))!.title).toBe('Quote "this", please');
    });
  });
});
