import { expect } from 'vitest';
import type { ParseQuickAddOptions, QuickAddResult } from '../src/index.js';

// Fixed deterministic reference instant: Sunday, 2026-11-15 14:00:00 UTC
export const FIXED_NOW_UTC = new Date('2026-11-15T14:00:00.000Z');

export function makeOpts(overrides: Partial<ParseQuickAddOptions> = {}): ParseQuickAddOptions {
  return {
    now: FIXED_NOW_UTC,
    timeZone: 'UTC',
    weekStart: 0,
    language: 'en',
    ...overrides,
  };
}

export function expectValidSpans(input: string, result: QuickAddResult): void {
  let prevEnd = 0;
  for (const span of result.recognized) {
    expect(span.start).toBeGreaterThanOrEqual(prevEnd);
    expect(span.end).toBeGreaterThan(span.start);
    expect(span.end).toBeLessThanOrEqual(input.length);
    expect(span.text).toBe(input.slice(span.start, span.end));
    prevEnd = span.end;
  }
}
