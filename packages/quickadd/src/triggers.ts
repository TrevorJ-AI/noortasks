import { LOCALES } from './locales/en.js';
import type { Range } from './masking.js';
import { touchesDisabledSeam } from './masking.js';
import type { RecognizedSpan } from './types.js';

const TRIGGER_CHARS = new Set(['#', '＃', '!', '！', '~', '～', '^', '＾', '@', '＠']);
const EXCLUDED_BODY_CHAR = /[\\/*"':?<>|#＃!！~～^＾@＠＊\s]/;
const PRIORITY_WORD_OR_DIGIT_RE = /^(high|medium|low|none|[1-4])(?=$|[\s.,;:)\]#＃!！~～^＾@＠＊*])/i;
const MULTI_BANG_RE = /^([!！]{1,2})(?=$|[\s#＃~～^＾@＠＊*])/;
const TOKEN_TRAILING_PUNCT_RE = /[.,;:)\]]+$/;

export interface TriggerParseOutput {
  tags: string[];
  list?: string;
  assignee?: string;
  priority?: 0 | 1 | 3 | 5;
  spans: RecognizedSpan[];
}

function isBoundaryBeforeTrigger(originalText: string, index: number, lastTriggerEnd: number): boolean {
  if (index === 0) return true;
  if (index === lastTriggerEnd) return true;
  const prev = originalText[index - 1] ?? '';
  return /[\s(\[{]/.test(prev);
}

function matchAutocomplete(
  maskedText: string,
  bodyStart: number,
  candidates: ReadonlyArray<string> | undefined,
): { canonical: string; length: number } | null {
  if (!candidates || candidates.length === 0) return null;
  const sorted = [...candidates]
    .filter((c) => c.length > 0)
    .sort((a, b) => b.length - a.length);

  const restLower = maskedText.slice(bodyStart).toLowerCase();
  for (const cand of sorted) {
    const candLower = cand.toLowerCase();
    if (!restLower.startsWith(candLower)) continue;
    const afterIdx = bodyStart + cand.length;
    const afterChar = maskedText[afterIdx];
    if (
      afterChar === undefined ||
      /\s/.test(afterChar) ||
      TRIGGER_CHARS.has(afterChar) ||
      afterChar === '*' ||
      afterChar === '＊' ||
      /[.,;:!?)\]]/.test(afterChar)
    ) {
      return { canonical: cand, length: cand.length };
    }
  }
  return null;
}

function readTokenBody(maskedText: string, bodyStart: number): string {
  let end = bodyStart;
  while (end < maskedText.length) {
    const ch = maskedText[end]!;
    if (EXCLUDED_BODY_CHAR.test(ch)) break;
    end++;
  }
  let raw = maskedText.slice(bodyStart, end);
  // Strip trailing sentence punctuation unless it leaves an empty token.
  const stripped = raw.replace(TOKEN_TRAILING_PUNCT_RE, '');
  if (stripped.length > 0) {
    raw = stripped;
  }
  return raw;
}

/**
 * Extracts symbol triggers (`#` tag, `!` priority, `~`/`^` list, `@` assignee)
 * and their fullwidth aliases, respecting `disabledSpans` and protected regions.
 */
export function parseSymbolTriggers(
  originalText: string,
  maskedText: string,
  disabled: ReadonlyArray<Range>,
  opts: {
    language: 'en';
    lists?: ReadonlyArray<string>;
    tags?: ReadonlyArray<string>;
    assignees?: ReadonlyArray<string>;
  },
): TriggerParseOutput {
  const locale = LOCALES[opts.language];
  const tags: string[] = [];
  const seenTags = new Set<string>();
  let list: string | undefined;
  let assignee: string | undefined;
  let priority: 0 | 1 | 3 | 5 | undefined;
  const spans: RecognizedSpan[] = [];

  let i = 0;
  let lastTriggerEnd = -1;

  while (i < maskedText.length) {
    const ch = maskedText[i]!;
    if (!TRIGGER_CHARS.has(ch) || !isBoundaryBeforeTrigger(originalText, i, lastTriggerEnd)) {
      i++;
      continue;
    }

    // Tag trigger: # or ＃
    if (ch === '#' || ch === '＃') {
      const auto = matchAutocomplete(maskedText, i + 1, opts.tags);
      let rawLen = 0;
      let resolvedTag = '';
      if (auto) {
        rawLen = auto.length;
        resolvedTag = auto.canonical.toLowerCase();
      } else {
        const body = readTokenBody(maskedText, i + 1);
        if (body.length > 0) {
          rawLen = body.length;
          resolvedTag = body.toLowerCase();
        }
      }

      if (rawLen > 0) {
        const end = i + 1 + rawLen;
        if (!touchesDisabledSeam(originalText, i, end, disabled)) {
          if (!seenTags.has(resolvedTag.toLowerCase())) {
            seenTags.add(resolvedTag.toLowerCase());
            tags.push(resolvedTag);
          }
          spans.push({
            start: i,
            end,
            kind: 'tag',
            text: originalText.slice(i, end),
          });
          lastTriggerEnd = end;
          i = end;
          continue;
        }
      }
      i++;
      continue;
    }

    // Priority trigger: ! or ！
    if (ch === '!' || ch === '！') {
      const rest = maskedText.slice(i + 1);
      const wordMatch = PRIORITY_WORD_OR_DIGIT_RE.exec(rest);
      let tokenLen = 0;
      let matchedPriority: 0 | 1 | 3 | 5 | undefined;

      if (wordMatch) {
        const key = wordMatch[1]!.toLowerCase();
        if (key === '1' || key === 'high') matchedPriority = 5;
        else if (key === '2' || key === 'medium') matchedPriority = 3;
        else if (key === '3' || key === 'low') matchedPriority = 1;
        else if (key === '4' || key === 'none') matchedPriority = 0;
        else if (key in locale.priorityWords) matchedPriority = locale.priorityWords[key];
        tokenLen = wordMatch[1]!.length;
      } else {
        const bangMatch = MULTI_BANG_RE.exec(rest);
        if (bangMatch) {
          // "!!" (1 extra -> 2 total) = Medium (3); "!!!" (2 extra -> 3 total) = High (5).
          const extraLen = bangMatch[1]!.length;
          matchedPriority = extraLen === 2 ? 5 : 3;
          tokenLen = extraLen;
        }
      }

      if (matchedPriority !== undefined && tokenLen > 0) {
        const end = i + 1 + tokenLen;
        if (!touchesDisabledSeam(originalText, i, end, disabled)) {
          priority = matchedPriority;
          spans.push({
            start: i,
            end,
            kind: 'priority',
            text: originalText.slice(i, end),
          });
          lastTriggerEnd = end;
          i = end;
          continue;
        }
      }
      i++;
      continue;
    }

    // List trigger: ~, ～, ^, ＾
    if (ch === '~' || ch === '～' || ch === '^' || ch === '＾') {
      const auto = matchAutocomplete(maskedText, i + 1, opts.lists);
      let rawLen = 0;
      let resolvedList = '';
      if (auto) {
        rawLen = auto.length;
        resolvedList = auto.canonical;
      } else {
        const body = readTokenBody(maskedText, i + 1);
        if (body.length > 0) {
          rawLen = body.length;
          resolvedList = body;
        }
      }

      if (rawLen > 0) {
        const end = i + 1 + rawLen;
        if (!touchesDisabledSeam(originalText, i, end, disabled)) {
          list = resolvedList;
          spans.push({
            start: i,
            end,
            kind: 'list',
            text: originalText.slice(i, end),
          });
          lastTriggerEnd = end;
          i = end;
          continue;
        }
      }
      i++;
      continue;
    }

    // Assignee trigger: @ or ＠
    if (ch === '@' || ch === '＠') {
      const auto = matchAutocomplete(maskedText, i + 1, opts.assignees);
      let rawLen = 0;
      let resolvedAssignee = '';
      if (auto) {
        rawLen = auto.length;
        resolvedAssignee = auto.canonical;
      } else {
        const body = readTokenBody(maskedText, i + 1);
        if (body.length > 0) {
          rawLen = body.length;
          resolvedAssignee = body;
        }
      }

      if (rawLen > 0) {
        const end = i + 1 + rawLen;
        if (!touchesDisabledSeam(originalText, i, end, disabled)) {
          assignee = resolvedAssignee;
          spans.push({
            start: i,
            end,
            kind: 'assignee',
            text: originalText.slice(i, end),
          });
          lastTriggerEnd = end;
          i = end;
          continue;
        }
      }
      i++;
      continue;
    }

    i++;
  }

  const out: TriggerParseOutput = { tags, spans };
  if (list !== undefined) out.list = list;
  if (assignee !== undefined) out.assignee = assignee;
  if (priority !== undefined) out.priority = priority;
  return out;
}
