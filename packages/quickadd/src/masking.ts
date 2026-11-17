export type Range = [number, number];

const PROTECTED_PATTERNS: RegExp[] = [
  // Explicit scheme URLs
  /(?:https?|ftp):\/\/[^\s<>()]+/gi,
  // www. URLs
  /\bwww\.[^\s<>()]+/gi,
  // Email addresses (requires local part before @ so @assignee triggers still match)
  /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
  // Bare domain URLs with common TLDs and optional path/fragment
  /\b[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.(?:com|org|net|io|dev|app|ai|co|edu|gov|me|info|biz|uk|de|fr|jp|cn|ru)(?:\/[^\s<>()]*)?/gi,
  // Phone numbers (e.g. 123-456-7890, 123-456-789, (555) 123-4567, +1-800-555-0199)
  /(?<!\w)(?:\+?\d{1,3}[\s.-])?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{3,4}\b/g,
  // Alphanumeric serial/issue codes like P12-3, A1-2, AAAA-BBBB-CCCC (requires at least one letter so ISO dates stay unmasked)
  /\b[A-Za-z]{1,4}\d+-\d+(?:-[A-Za-z0-9]+)*\b/g,
  /(?=[A-Z0-9-]*[A-Z])\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){2,}\b/g,
  // Semantic versions and IPv4 addresses (avoids masking D.M.YYYY dates)
  /\b[vV]\d+\.\d+(?:\.\d+)*\b/g,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
  /\b\d+\.\d+\.(?!\d{4}\b)\d+\b/g,
  // Long bare digit runs (5+ digits, e.g. 20261115, 123456)
  /\b\d{5,}\b/g,
];

/**
 * Finds non-parseable regions (URLs, emails, serial codes, phones, IPs, long digit runs)
 * so neither symbol triggers nor NLP parsers match inside them.
 */
export function findProtectedRegions(text: string): Range[] {
  const ranges: Range[] = [];
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      if (m[0].length > 0) {
        ranges.push([m.index, m.index + m[0].length]);
      }
    }
  }
  return mergeRanges(ranges);
}

/** Merges overlapping or adjacent `[start, end)` ranges. */
export function mergeRanges(ranges: ReadonlyArray<Range>): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges]
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length === 0) return [];

  const merged: Range[] = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const curr = sorted[i]!;
    const prev = merged[merged.length - 1]!;
    if (curr[0] <= prev[1]) {
      prev[1] = Math.max(prev[1], curr[1]);
    } else {
      merged.push([curr[0], curr[1]]);
    }
  }
  return merged;
}

/** Normalizes user-supplied disabled spans clamped to `[0, length]`. */
export function normalizeDisabledSpans(
  disabledSpans: ReadonlyArray<[number, number]> | undefined,
  length: number,
): Range[] {
  if (!disabledSpans || disabledSpans.length === 0) return [];
  const clamped: Range[] = [];
  for (const [rawStart, rawEnd] of disabledSpans) {
    const s = Math.max(0, Math.min(length, rawStart));
    const e = Math.max(0, Math.min(length, rawEnd));
    if (e > s) {
      clamped.push([s, e]);
    }
  }
  return mergeRanges(clamped);
}

/** Replaces each `[start, end)` range with spaces of identical length, preserving indices. */
export function maskRanges(text: string, ranges: ReadonlyArray<Range>): string {
  if (ranges.length === 0) return text;
  const chars = text.split('');
  for (const [start, end] of ranges) {
    const s = Math.max(0, start);
    const e = Math.min(chars.length, end);
    for (let i = s; i < e; i++) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

/** Checks whether `[start, end)` overlaps any range in `ranges`. */
export function overlapsAny(start: number, end: number, ranges: ReadonlyArray<Range>): boolean {
  for (const [rs, re] of ranges) {
    if (start < re && end > rs) return true;
  }
  return false;
}

/**
 * Rejects a match if it starts or ends immediately inside a word/non-whitespace seam
 * of a disabled span (for instance, disabling "2026-" inside "2026-05-01").
 */
export function touchesDisabledSeam(
  originalText: string,
  start: number,
  end: number,
  disabled: ReadonlyArray<Range>,
): boolean {
  if (overlapsAny(start, end, disabled)) return true;
  for (const [ds, de] of disabled) {
    if (de === start && start > 0 && !/\s/.test(originalText[start - 1] ?? '')) {
      return true;
    }
    if (ds === end && end < originalText.length && !/\s/.test(originalText[end] ?? '')) {
      return true;
    }
  }
  return false;
}

/**
 * Reconstructs the task title after removing the selected recognized spans,
 * collapsing only whitespace directly adjacent to removed spans and trimming ends.
 */
export function reconstructTitle(
  text: string,
  spansToRemove: ReadonlyArray<{ start: number; end: number }>,
): string {
  if (spansToRemove.length === 0) return text.trim();

  const merged = mergeRanges(spansToRemove.map((s) => [s.start, s.end] as Range));
  const keptPieces: string[] = [];
  let cursor = 0;

  for (const [rStart, rEnd] of merged) {
    if (rStart > cursor) {
      keptPieces.push(text.slice(cursor, rStart));
    }
    cursor = rEnd;
  }
  if (cursor < text.length) {
    keptPieces.push(text.slice(cursor));
  }

  // Collapse seam whitespace where segments were cut apart, then join with single spaces.
  const cleanedParts: string[] = [];
  for (let i = 0; i < keptPieces.length; i++) {
    let piece = keptPieces[i]!;
    if (i > 0 || merged[0]![0] === 0) {
      piece = piece.replace(/^\s+/, '');
    }
    if (i < keptPieces.length - 1 || merged[merged.length - 1]![1] === text.length) {
      piece = piece.replace(/\s+$/, '');
    }
    if (piece.length > 0) {
      cleanedParts.push(piece);
    }
  }

  return cleanedParts.join(' ').trim();
}
