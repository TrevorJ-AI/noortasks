import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError } from "../data/api";
import { CsvFormatError } from "../model/backupCsv";
import {
  IMPORT_SOURCES,
  executeImportBundle,
  fetchMsTodoGraphJson,
  inspectGenericCsv,
  parseImportSource,
  type CsvColumnMapping,
  type CsvInspection,
  type ImportBundle,
  type ImportLossItem,
  type ImportResult,
  type ImportSourceId,
} from "../model/importers";
import { useApp, type App } from "./ctx";
import { Modal } from "./primitives";
import { ArchiveRestore, Building2, CalendarCheck2, CheckCheck, CircleDot, CircleHelp, FileText, Link2, RefreshCw, ListChecks, ListTodo, Mail, PartyPopper } from "lucide-react";
import { CAL_ENTRIES, CalEntryForm, FeedSection, type Entry } from "./CalSettings";
import { Card, LinkBtn, SetSection, StDialog } from "./settings/kit";
import { BrandTile, GlyphTile } from "./settings/brands";

/** Backup and restore (IMP-013..IMP-025, IMP-033, ACC-035), third-party importers, habit and focus export (HAB-028, IMP-022, IMP-023). */

async function downloadFrom(app: App, path: string, fileName: string, headers: Record<string, string> = {}): Promise<number> {
  const res = await fetch(app.engine.api.base + path, { credentials: "include", headers });
  if (!res.ok) throw new HttpError(res.status, await res.text());
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  return blob.size;
}

const stamp = (): string => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

/** Generate Backup: verify (passphrase when the server asks), then download the 23-column CSV. */
export async function generateBackup(app: App, password?: string): Promise<"ok" | "needsPassword" | "error"> {
  try {
    await app.engine.sync();
    const { verifyId } = await app.engine.api.post<{ verifyId: string }>("/api/v2/user/verify", password ? { password } : {});
    await downloadFrom(app, "/api/v2/data/export", `NoorTasks-backup-${stamp()}.csv`, { "x-verify-id": verifyId });
    return "ok";
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return "needsPassword";
    if ((e as Error).message === "unauthorized") return "needsPassword";
    return "error";
  }
}

/** Account tab row: Generate Backup and Import Backups (ACC-035). */
export function BackupButtons(): JSX.Element {
  const app = useApp();
  const [askPw, setAskPw] = useState(false);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async (password?: string): Promise<void> => {
    setBusy(true);
    const r = await generateBackup(app, password);
    setBusy(false);
    if (r === "needsPassword") {
      if (password) app.toast("Wrong passphrase");
      setAskPw(true);
    } else if (r === "error") app.toast("Backup failed: is the server reachable?");
    else {
      setAskPw(false);
      app.toast("Backup downloaded");
    }
  };
  return (
    <div className="col gap-s">
      <div className="row gap">
        <button className="btn sm" disabled={busy} data-testid="generate-backup" onClick={() => void run()}>
          <Download size={13} /> Generate Backup
        </button>
        <button className="btn sm" data-testid="import-backups" onClick={() => app.setModal({ kind: "importBackup", source: "backupCsv" })}>
          <Upload size={13} /> Import Backups
        </button>
      </div>
      {askPw && (
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            void run(pw);
          }}
        >
          <input className="field" type="password" autoFocus placeholder="Passphrase" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="btn sm primary" type="submit">Verify</button>
        </form>
      )}
    </div>
  );
}

const CSV_MAPPING_FIELDS: Array<{ key: keyof CsvColumnMapping; label: string; required?: boolean }> = [
  { key: "title", label: "Title", required: true },
  { key: "notes", label: "Notes" },
  { key: "list", label: "List" },
  { key: "section", label: "Section" },
  { key: "tags", label: "Tags" },
  { key: "priority", label: "Priority" },
  { key: "status", label: "Status" },
  { key: "startDate", label: "Start Date" },
  { key: "dueDate", label: "Due Date" },
  { key: "timeZone", label: "Time Zone" },
  { key: "repeat", label: "Repeat" },
  { key: "parent", label: "Parent" },
  { key: "id", label: "ID" },
];

function LossReport({ losses }: { losses: ImportLossItem[] }): JSX.Element {
  const [showAll, setShowAll] = useState(false);
  if (losses.length === 0) {
    return (
      <div className="imp-loss clean" data-testid="import-loss-report">
        <CheckCircle2 size={14} />
        <span>No data lost: every item in this file carries over cleanly.</span>
      </div>
    );
  }
  const visible = showAll ? losses : losses.slice(0, 10);
  return (
    <div className="imp-loss warn" data-testid="import-loss-report">
      <div className="row gap">
        <AlertTriangle size={14} />
        <span className="strong small">Loss report ({losses.length} {losses.length === 1 ? "item" : "items"} could not carry over)</span>
      </div>
      <ul className="imp-loss-list">
        {visible.map((l, idx) => (
          <li key={idx} className="small">
            {l.sourceItem ? <span className="strong">{l.sourceItem}: </span> : null}
            <span>{l.reason}</span>
          </li>
        ))}
      </ul>
      {losses.length > 10 && (
        <button className="btn sm ghost" onClick={() => setShowAll((s) => !s)}>
          {showAll ? "Show fewer" : `Show all ${losses.length} items`}
        </button>
      )}
    </div>
  );
}

/** Unified import dialog: parse on client, preview counts + loss report, write locally via Dexie + outbox and sync. */
export function ImportBackupDialog({ initialSource = "backupCsv" }: { initialSource?: ImportSourceId }): JSX.Element {
  const app = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<ImportSourceId>(initialSource);
  const [rawText, setRawText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvInspection, setCsvInspection] = useState<CsvInspection | null>(null);
  const [csvMapping, setCsvMapping] = useState<CsvColumnMapping | undefined>(undefined);
  const [graphToken, setGraphToken] = useState("");
  const [bundle, setBundle] = useState<ImportBundle | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const setModal = app.setModal;
  const close = useCallback((): void => setModal(null), [setModal]);
  const meta = IMPORT_SOURCES[source];

  const parseLoaded = useCallback(
    (src: ImportSourceId, text: string, name: string | undefined, mapping?: CsvColumnMapping): void => {
      setResult(null);
      setErr("");
      try {
        if (src === "genericCsv") {
          const insp = inspectGenericCsv(text);
          setCsvInspection(insp);
          const effective = mapping ?? insp.suggested;
          setCsvMapping(effective);
          setBundle(parseImportSource(src, text, { ...(name ? { fileName: name } : {}), csvMapping: effective }));
        } else {
          setCsvInspection(null);
          setCsvMapping(undefined);
          setBundle(parseImportSource(src, text, name ? { fileName: name } : {}));
        }
      } catch (e) {
        setBundle(null);
        setErr(e instanceof CsvFormatError || e instanceof Error ? e.message : "This file could not be read");
      }
    },
    [],
  );

  useEffect(() => {
    setSource(initialSource);
    setRawText(null);
    setFileName(null);
    setCsvInspection(null);
    setCsvMapping(undefined);
    setBundle(null);
    setResult(null);
    setErr("");
  }, [initialSource]);

  const pick = async (f: File): Promise<void> => {
    const text = await f.text();
    setFileName(f.name);
    setRawText(text);
    parseLoaded(source, text, f.name);
  };

  const fetchGraph = async (): Promise<void> => {
    if (!graphToken.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const jsonText = await fetchMsTodoGraphJson(graphToken);
      setFileName("microsoft-todo-graph.json");
      setRawText(jsonText);
      parseLoaded("microsoftTodo", jsonText, "microsoft-todo-graph.json");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not fetch tasks from Microsoft Graph");
    } finally {
      setBusy(false);
    }
  };

  const changeSource = (next: ImportSourceId): void => {
    setSource(next);
    setResult(null);
    setErr("");
    if (rawText !== null) parseLoaded(next, rawText, fileName ?? undefined);
  };

  const updateMapping = (key: keyof CsvColumnMapping, val: string): void => {
    if (!csvMapping || rawText === null) return;
    const next: CsvColumnMapping = { ...csvMapping };
    if (val) next[key] = val;
    else if (key !== "title") delete next[key];
    setCsvMapping(next);
    parseLoaded("genericCsv", rawText, fileName ?? undefined, next);
  };

  const doImport = async (): Promise<void> => {
    if (!bundle) return;
    setBusy(true);
    setErr("");
    try {
      if (!app.inboxId) await app.engine.sync();
      const r = await executeImportBundle(app.db, app.engine, bundle);
      await app.engine.sync();
      setResult(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const c = bundle?.counts;
  const rows = bundle?.previewRows ?? [];

  return (
    <Modal onClose={close} wide className="import-modal" testId="import-dialog">
      <div className="row gap">
        <FileSpreadsheet size={18} />
        <h3 className="grow">{meta.title}</h3>
        <select
          className="field"
          aria-label="Import source"
          data-testid="import-source"
          value={source}
          onChange={(e) => changeSource(e.target.value as ImportSourceId)}
        >
          {Object.values(IMPORT_SOURCES).map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
        <button className="icon-btn sm" aria-label="Close" onClick={close}><X size={16} /></button>
      </div>
      <p className="muted small">
        {source === "backupCsv"
          ? "A CSV backup made with Generate Backup. Tasks that already exist (same task id) are skipped; lists, folders, sections and tags are created by name."
          : meta.description}
      </p>
      <div className="row gap">
        <button className="btn" data-testid="import-pick" onClick={() => fileRef.current?.click()}>
          <Upload size={14} /> Choose file
        </button>
        <span className="muted small ellipsis">{fileName ?? "No file chosen"}</span>
        <input
          ref={fileRef}
          type="file"
          accept={meta.accept}
          hidden
          data-testid="import-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void pick(f);
          }}
        />
      </div>
      {source === "microsoftTodo" && !result && (
        <div className="row gap">
          <input
            className="field grow"
            type="password"
            placeholder="Or paste Graph access token (browser only)"
            data-testid="mstodo-token"
            value={graphToken}
            onChange={(e) => setGraphToken(e.target.value)}
          />
          <button className="btn sm" disabled={busy || !graphToken.trim()} data-testid="mstodo-fetch" onClick={() => void fetchGraph()}>
            Fetch lists
          </button>
        </div>
      )}
      {err && <div className="banner error small" data-testid="import-error">{err}</div>}
      {source === "genericCsv" && csvInspection && csvMapping && !result && (
        <div className="imp-map-grid" data-testid="import-csv-mapping">
          {CSV_MAPPING_FIELDS.map(({ key, label, required }) => (
            <label key={key} className="imp-map-item">
              <span className="muted small">{label}</span>
              <select
                className="field"
                value={csvMapping[key] ?? ""}
                onChange={(e) => updateMapping(key, e.target.value)}
              >
                {!required && <option value="">(None)</option>}
                {csvInspection.headers.map((h) => (
                  <option key={h} value={h}>{h}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      {bundle && c && !result && (
        <div className="imp-preview" data-testid="import-preview">
          <div className="imp-counts">
            {[
              ["Tasks", c.tasks, "import-count-tasks"],
              ["Open", c.open, "import-count-open"],
              ["Completed", c.completed, "import-count-completed"],
              ["Won't Do", c.wontDo, "import-count-wontdo"],
              ["Checklists", c.checklists, "import-count-checklists"],
              ["Subtasks", c.subtasks, "import-count-subtasks"],
              ["Lists", c.lists, "import-count-lists"],
              ["Folders", c.folders, "import-count-folders"],
              ["Tags", c.tags, "import-count-tags"],
              ["Sections", c.sections, "import-count-sections"],
            ].map(([l, n, id]) => (
              <div key={String(id)} className="imp-count" data-testid={String(id)}>
                <span className="imp-num">{n}</span>
                <span className="muted small">{l}</span>
              </div>
            ))}
          </div>
          <LossReport losses={bundle.losses} />
          <div className="imp-table-wrap">
            <table className="imp-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>List</th>
                  <th>Status</th>
                  <th>Due</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td>{r.title}</td>
                    <td>{r.list}</td>
                    <td>{r.status}</td>
                    <td>{r.due}</td>
                    <td>{r.tags}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {bundle.tasks.length > 8 && <div className="muted small pad">and {bundle.tasks.length - 8} more rows</div>}
          </div>
        </div>
      )}
      {result && (
        <div className="imp-result" data-testid="import-result">
          <div className="strong">Import finished</div>
          <div className="imp-counts">
            {[
              ["Imported", result.imported, "import-result-imported"],
              ["Skipped", result.skipped, "import-result-skipped"],
              ["New lists", result.createdProjects, "import-result-lists"],
              ["New folders", result.createdFolders, "import-result-folders"],
              ["New tags", result.createdTags, "import-result-tags"],
              ["New sections", result.createdColumns, "import-result-sections"],
            ].map(([l, n, id]) => (
              <div key={String(id)} className="imp-count" data-testid={String(id)}>
                <span className="imp-num">{n}</span>
                <span className="muted small">{l}</span>
              </div>
            ))}
          </div>
          {result.losses.length > 0 && <LossReport losses={result.losses} />}
        </div>
      )}
      <div className="row gap end">
        <button className="btn" onClick={close}>{result ? "Done" : "Cancel"}</button>
        {!result && (
          <button className="btn primary" disabled={!bundle || busy} data-testid="import-run" onClick={() => void doImport()}>
            {busy ? "Importing..." : `Import ${c?.tasks ?? ""} tasks`}
          </button>
        )}
      </div>
    </Modal>
  );
}

type Tile = JSX.Element;
const t = (color: string, icon: JSX.Element): Tile => <GlyphTile color={color}>{icon}</GlyphTile>;

const IMPORTERS: Array<{ label: string; source: ImportSourceId; hint?: string; tile: Tile }> = [
  { label: "Todoist", source: "todoist", tile: <BrandTile brand="todoist" /> },
  { label: "Microsoft Todo", source: "microsoftTodo", tile: t("#2f7bf2", <ListTodo size={15} />) },
  { label: "Things", source: "things", tile: <BrandTile brand="things" /> },
  // no native format to read: both export CSV, which the generic CSV importer maps
  { label: "OmniFocus", source: "genericCsv", hint: "Through a CSV export", tile: t("#8a4fd8", <CircleDot size={15} />) },
  { label: "Toodledo", source: "genericCsv", hint: "Through a CSV export", tile: t("#f0a12b", <ListChecks size={15} />) },
  { label: "iCal", source: "appleReminders", tile: <BrandTile brand="apple" /> },
];

const EXTRA_IMPORTERS: Array<{ label: string; testId: string; source: ImportSourceId; tile: Tile }> = [
  { label: "Trello", testId: "importer-trello", source: "trello", tile: <BrandTile brand="trello" /> },
  { label: "Notion", testId: "importer-notion", source: "notion", tile: <BrandTile brand="notion" /> },
  { label: "Any.do", testId: "importer-anydo", source: "anydo", tile: t("#3b82f6", <CheckCheck size={15} />) },
  { label: "Google Tasks", testId: "importer-google-tasks", source: "googleTasks", tile: <BrandTile brand="gtasks" /> },
  { label: "Apple Reminders", testId: "importer-apple-reminders", source: "appleReminders", tile: <BrandTile brand="apple" /> },
  { label: "Generic CSV", testId: "importer-generic-csv", source: "genericCsv", tile: t("#22a06b", <FileSpreadsheet size={15} />) },
  { label: "todo.txt", testId: "importer-todotxt", source: "todotxt", tile: t("#6b7280", <FileText size={15} />) },
  { label: "Markdown", testId: "importer-markdown", source: "markdown", tile: <BrandTile brand="markdown" /> },
];

const CAL_TILES: Record<Entry, { label: string; tile: Tile; help?: string }> = {
  google: { label: "Google Calendar", tile: <BrandTile brand="gcal" /> },
  outlook: { label: "Outlook Calendar", tile: t("#0a64c8", <Mail size={15} />) },
  exchange: { label: "Exchange Calendar", tile: t("#1d5fb4", <Building2 size={15} />) },
  icloud: { label: "iCloud Calendar", tile: <BrandTile brand="icloud" /> },
  caldav: { label: "CalDAV", tile: t("#f29b38", <RefreshCw size={15} />) },
  holiday: { label: "Holidays", tile: t("#26b07a", <PartyPopper size={15} />) },
  url: { label: "URL", tile: t("#4a8cf7", <Link2 size={15} />), help: "Subscribe to any .ics or webcal link (read-only)" },
};

function IntCard({ tile, name, desc, onClick, testId, help, nameClass = "" }: { tile: Tile; name: string; desc?: string; onClick: () => void; testId?: string; help?: string; nameClass?: string }): JSX.Element {
  return (
    <button className={`int-card${desc ? " has-desc" : ""}`} data-testid={testId} onClick={onClick}>
      {tile}
      <span className="int-text">
        <span className={`int-name ${nameClass}`}>
          {name}
          {help && (
            <span className="st-help" title={help}>
              <CircleHelp size={12} />
            </span>
          )}
        </span>
        {desc && <span className="int-desc">{desc}</span>}
      </span>
    </button>
  );
}

/** Settings > Integrations & Import (SET-169, IMP-033, INTG-004): icon cards, plus habit and focus export. */
export function IntegrationsTab({ Row }: { Row: (p: { label: string; children: React.ReactNode; hint?: string }) => JSX.Element }): JSX.Element {
  const app = useApp();
  const [cal, setCal] = useState<Entry | null>(null);
  const [feed, setFeed] = useState(false);
  const dl = (path: string, name: string): void =>
    void downloadFrom(app, path, name).then(
      () => app.toast(`${name} downloaded`),
      () => app.toast("Export failed: is the server reachable?"),
    );
  const importFrom = (source: ImportSourceId): void => app.setModal({ kind: "importBackup", source });
  return (
    <div className="st-integrations">
      <SetSection title="Calendar" />
      <div className="int-grid" data-testid="cal-catalogue">
        {CAL_ENTRIES.map((e) => (
          <IntCard key={e.key} testId={`cal-entry-${e.key}`} tile={CAL_TILES[e.key].tile} name={CAL_TILES[e.key].label} nameClass="cal-entry-name" help={CAL_TILES[e.key].help} onClick={() => setCal(e.key)} />
        ))}
      </div>

      <SetSection title="Import" />
      <div className="int-grid" data-testid="import-entries">
        {IMPORTERS.map((entry) => (
          <IntCard key={entry.label} testId={`importer-${entry.label}`} tile={entry.tile} name={entry.label} desc={entry.hint} onClick={() => importFrom(entry.source)} />
        ))}
      </div>
      <div className="int-grid int-grid-more">
        {EXTRA_IMPORTERS.map((entry) => (
          <IntCard key={entry.testId} testId={entry.testId} tile={entry.tile} name={entry.label} onClick={() => importFrom(entry.source)} />
        ))}
        <IntCard testId="integrations-import-backup" tile={t("#e9b22e", <ArchiveRestore size={15} color="#0a0a0c" />)} name="Backup file (CSV)" desc="A backup made with Generate Backup" onClick={() => importFrom("backupCsv")} />
      </div>

      <SetSection title="Export" />
      <Card>
        <Row label="Tasks backup (CSV)">
          <BackupButtons />
        </Row>
        <Row label="Habit records">
          <div className="row gap">
            <LinkBtn testId="export-habits-xlsx" onClick={() => dl("/api/v2/data/export/habits", `NoorTasks-habits-${stamp()}.xlsx`)}>Excel</LinkBtn>
            <LinkBtn testId="export-habits-csv" onClick={() => dl("/api/v2/data/export/habits?format=csv", `NoorTasks-habits-${stamp()}.csv`)}>CSV</LinkBtn>
          </div>
        </Row>
        <Row label="Focus records">
          <div className="row gap">
            <LinkBtn testId="export-focus-csv" onClick={() => dl("/api/v2/data/export/pomodoro", `NoorTasks-focus-${stamp()}.csv`)}>CSV</LinkBtn>
            <LinkBtn testId="export-focus-xlsx" onClick={() => dl("/api/v2/data/export/pomodoro?format=xlsx", `NoorTasks-focus-${stamp()}.xlsx`)}>Excel</LinkBtn>
          </div>
        </Row>
      </Card>

      <SetSection title="Others" />
      <div className="int-grid">
        <IntCard testId="int-subscribe" tile={t("#5b6ee1", <CalendarCheck2 size={15} />)} name="Subscribe to NoorTasks" desc="Show your tasks in Google, Outlook, Apple Calendar and more." onClick={() => setFeed(true)} />
      </div>

      {cal && (
        <StDialog title={CAL_TILES[cal].label} onClose={() => setCal(null)} testId="cal-dialog">
          <div className="st-dialog-form">
            <CalEntryForm entry={cal} Row={Row} onDone={() => setCal(null)} />
          </div>
        </StDialog>
      )}
      {feed && (
        <StDialog title="Subscribe to NoorTasks" sub="A private calendar link with your tasks; paste it into any calendar app that can subscribe to a URL." onClose={() => setFeed(false)} testId="feed-dialog">
          <div className="st-dialog-form">
            <FeedSection Row={Row} />
          </div>
        </StDialog>
      )}
    </div>
  );
}
