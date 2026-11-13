/** Fuzzy search used by the add-node popup. Pure. */

/** Score a single string against a query; -1 = no match. Higher is better. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q === '') return 0;
  if (t === q) return 200;
  if (t.startsWith(q)) return 150 - Math.min(40, t.length - q.length);
  const wordStart = t.split(/[\s._:/-]+/).some((w) => w.startsWith(q));
  if (wordStart) return 110;
  const idx = t.indexOf(q);
  if (idx >= 0) return 80 - Math.min(40, idx);
  // subsequence match with a gap penalty
  let ti = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    if (last >= 0) gaps += found - last - 1;
    last = found;
    ti = found + 1;
  }
  return Math.max(1, 40 - gaps);
}

export interface Searchable {
  type: string;
  label: string;
  category: string;
  description?: string;
}

/**
 * Filter + rank. With an empty query: recent entries first (most recent first), then input order.
 */
export function searchDefs<T extends Searchable>(defs: readonly T[], query: string, recent: readonly string[] = []): T[] {
  if (query.trim() === '') {
    const rank = (d: T): number => {
      const i = recent.indexOf(d.type);
      return i < 0 ? Infinity : i;
    };
    return defs.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d) - rank(b.d) || a.i - b.i).map((x) => x.d);
  }
  const scored: { d: T; s: number; i: number }[] = [];
  defs.forEach((d, i) => {
    const s = Math.max(fuzzyScore(query, d.label), fuzzyScore(query, d.category) - 30, fuzzyScore(query, d.type) - 10, fuzzyScore(query, d.description ?? '') - 50);
    if (s > 0) scored.push({ d, s, i });
  });
  return scored.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.d);
}
