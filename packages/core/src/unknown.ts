/** Tolerant-object helpers: every entity keeps fields we do not model. */

export type Loose = { [key: string]: unknown };

export function isPlainObject(v: unknown): v is Loose {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Names of the fields in `obj` that are not in `known`. */
export function unknownFields(obj: Loose, known: ReadonlySet<string> | readonly string[]): string[] {
  const set = known instanceof Set ? known : new Set(known);
  return Object.keys(obj).filter((k) => !set.has(k));
}

/** Shallow merge where `patch` wins and unknown fields on both sides survive. */
export function mergeLoose<T extends Loose>(base: T, patch: Loose): T {
  return { ...base, ...patch } as T;
}

/** Key-order-insensitive structural equality (array order counts). */
export function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => looseEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && looseEqual(a[k], b[k]));
  }
  return false;
}
