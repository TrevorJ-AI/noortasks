import { cleanTagName } from "../../data/repo";
import { parseCsv } from "../backupCsv";
import type { ImportLossItem, ImportTag } from "./types";

export interface ParsedCsvTable {
  headers: string[];
  rows: string[][];
}

export function parseCsvTable(text: string, emptyMessage = "CSV file is empty"): ParsedCsvTable {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) throw new Error(emptyMessage);
  const headers = rows[0]!.map((h) => h.trim());
  if (!headers.some(Boolean)) throw new Error("CSV header row is empty");
  return { headers, rows };
}

export function buildHeaderIndex(headers: string[]): Map<string, number> {
  const colIdx = new Map<string, number>();
  headers.forEach((h, i) => {
    if (!colIdx.has(h)) colIdx.set(h, i);
  });
  return colIdx;
}

export function csvCell(row: string[], colIdx: Map<string, number>, headerName: string | undefined): string {
  if (!headerName) return "";
  const idx = colIdx.get(headerName);
  return idx !== undefined && idx < row.length ? (row[idx] ?? "").trim() : "";
}

export function pickHeaderMatch(headers: string[], aliases: string[], used: Set<string>, fuzzy = true): string | undefined {
  const lower = headers.map((h) => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = lower.findIndex((h, i) => h === alias && !used.has(headers[i]!));
    if (idx >= 0) {
      const chosen = headers[idx]!;
      used.add(chosen);
      return chosen;
    }
  }
  if (!fuzzy) return undefined;
  for (const alias of aliases) {
    const idx = lower.findIndex((h, i) => h.includes(alias) && !used.has(headers[i]!));
    if (idx >= 0) {
      const chosen = headers[idx]!;
      used.add(chosen);
      return chosen;
    }
  }
  return undefined;
}

export function reportUnmappedCsvColumns(
  headers: string[],
  rows: string[][],
  mappedHeaders: Set<string>,
  losses: ImportLossItem[],
): void {
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    if (!h || mappedHeaders.has(h)) continue;
    let nonEmpty = 0;
    for (let r = 1; r < rows.length; r++) {
      if ((rows[r]![i] ?? "").trim() !== "") nonEmpty++;
    }
    if (nonEmpty > 0) {
      losses.push({
        category: "unmapped_column",
        field: h,
        count: nonEmpty,
        reason: `Unmapped column "${h}" (${nonEmpty} non-empty value${nonEmpty === 1 ? "" : "s"} skipped)`,
      });
    }
  }
}

export function parsePriorityToken(
  raw: string,
  opts: { normalPriority?: 0 | 3 } = {},
): { priority: 0 | 1 | 3 | 5; lost?: string } {
  const s = raw.trim().toLowerCase();
  if (!s || s === "0" || s === "none" || s === "p4") return { priority: 0 };
  if (s === "normal") return { priority: opts.normalPriority ?? 3 };
  if (s === "5" || s === "high" || s === "urgent" || s === "critical" || s === "p1") return { priority: 5 };
  if (s === "3" || s === "medium" || s === "med" || s === "p2") return { priority: 3 };
  if (s === "1" || s === "low" || s === "p3") return { priority: 1 };
  return { priority: 0, lost: `Unrecognized priority "${raw.trim()}" defaulted to None` };
}

export function parseStatusToken(
  raw: string,
  opts: { archivedStatus?: 2 | -1; sourceName?: string } = {},
): { status: 0 | 2 | -1; lost?: string } {
  const s = raw.trim().toLowerCase();
  if (!s || s === "0" || s === "open" || s === "todo" || s === "to do" || s === "active" || s === "not started" || s === "false" || s === "no" || s === "needsaction") {
    return { status: 0 };
  }
  if (s === "2" || s === "1" || s === "done" || s === "completed" || s === "complete" || s === "checked" || s === "true" || s === "yes" || s === "x") {
    return { status: 2 };
  }
  if (s === "-1" || s === "wontdo" || s === "won't do" || s === "abandoned" || s === "cancelled" || s === "canceled") {
    return { status: -1 };
  }
  if (s === "archived") {
    return { status: opts.archivedStatus ?? -1 };
  }
  if (s === "in progress" || s === "in-progress" || s === "doing" || s === "blocked" || s === "waiting") {
    const label = opts.sourceName ? `${opts.sourceName} status` : "Status";
    return { status: 0, lost: `${label} "${raw.trim()}" simplified to Open` };
  }
  return { status: 0, lost: `Unrecognized status "${raw.trim()}" defaulted to Open` };
}

export function collectTagsIntoMap(
  raw: string,
  tagMap: Map<string, ImportTag>,
  sepRe: RegExp = /[,;]/,
): string[] {
  const out: string[] = [];
  for (const part of raw.split(sepRe)) {
    const cleaned = cleanTagName(part.trim().replace(/^#/, ""));
    if (!cleaned) continue;
    const low = cleaned.toLowerCase();
    if (!out.includes(low)) out.push(low);
    if (!tagMap.has(low)) tagMap.set(low, { name: low, label: cleaned });
  }
  return out;
}

export function appendNoteBlock(base: string, extra: string): string {
  const a = base.trim();
  const b = extra.trim();
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n${b}`;
}

export function deriveListFromFileName(fileName: string | undefined, fallback: string): string {
  if (!fileName || !fileName.trim()) return fallback;
  const base = fileName
    .trim()
    .replace(/^.*[/\\]/, "")
    .replace(/\.(csv|json|txt|md|markdown)$/i, "");
  // Strip Todoist [123] / (123) and Notion 32-hex page UUID suffixes
  const stripped = base
    .replace(/(?:\s+|_)[0-9a-f]{32}(?:_all)?$/i, "")
    .replace(/\s*\[\d+\]$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .trim();
  return stripped || fallback;
}
