/** sortOrder helpers: step 2^40, lower sorts earlier, signed 64-bit range clamp. */

export const ORDER_STEP = 2 ** 40;
/** 0x7ffffffffffffc00 as a double (rounds to 2^63). */
export const ORDER_MAX = 0x7ffffffffffffc00;
export const ORDER_MIN = -0x7ffffffffffffc00;

export function clampOrder(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(ORDER_MIN, Math.min(ORDER_MAX, n));
}

/** New item at the top of a list: min - step (an empty list gives 0, then -step). */
export function orderForTop(existing: readonly number[]): number {
  const nums = existing.filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  return clampOrder(Math.min(...nums) - ORDER_STEP);
}

/** New item at the bottom: max + step (skip 0 if reached, since 0 marks an unset order). */
export function orderForBottom(existing: readonly number[]): number {
  const nums = existing.filter((n) => Number.isFinite(n));
  if (nums.length === 0) return 0;
  const v = Math.max(...nums) + ORDER_STEP;
  return clampOrder(v === 0 ? v + ORDER_STEP : v);
}

/** n new items at the top, topmost first: min - step*n ... min - step (empty list: -step*(n-1) ... 0). */
export function ordersForTopBatch(existing: readonly number[], n: number): number[] {
  const nums = existing.filter((v) => Number.isFinite(v));
  const base = nums.length === 0 ? ORDER_STEP : Math.min(...nums);
  return Array.from({ length: n }, (_, i) => clampOrder(base - ORDER_STEP * (n - i)));
}

/**
 * Order for an item dropped between two neighbours. Either side may be undefined (list end).
 * Returns `needsRebalance` when the gap is too small to fit another integer.
 */
export function orderBetween(
  before: number | undefined,
  after: number | undefined,
): { order: number; needsRebalance: boolean } {
  const hasB = before !== undefined && Number.isFinite(before);
  const hasA = after !== undefined && Number.isFinite(after);
  if (!hasB && !hasA) return { order: 0, needsRebalance: false };
  if (!hasB) return { order: clampOrder((after as number) - ORDER_STEP), needsRebalance: false };
  if (!hasA) return { order: clampOrder((before as number) + ORDER_STEP), needsRebalance: false };
  const gap = (after as number) - (before as number);
  const order = Math.floor(((before as number) + (after as number)) / 2);
  return { order, needsRebalance: gap <= 1 || order <= (before as number) || order >= (after as number) };
}

export function needsRebalance(sorted: readonly number[]): boolean {
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! < 2) return true;
  return false;
}

/** Fresh evenly spaced orders for items already in the desired sequence: index * step. */
export function rebalance<T>(items: readonly T[]): Array<{ item: T; order: number }> {
  return items.map((item, i) => ({ item, order: i * ORDER_STEP }));
}

/** Checklist items: index times step, starting at 0. */
export function checklistOrder(index: number): number {
  return index * ORDER_STEP;
}
