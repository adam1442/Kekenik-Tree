/**
 * Cycle guard for geometry forces whose source is a set of generators: a generator may not (directly or through
 * other generators) be influenced by a geometry force that uses its own geometry.
 *
 * `sources` maps a generator id to the generator ids that feed the geometry forces attached to it. Returns the first
 * cycle as a list of ids (first id repeated at the end), or null when the graph is acyclic.
 */
export function findForceSourceCycle(sources: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === 2) return null;
    if (s === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1);
    path.push(id);
    for (const next of sources.get(id) ?? []) {
      const c = visit(next);
      if (c) return c;
    }
    path.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of sources.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

export const FORCE_CYCLE_MESSAGE = 'A generator cannot be the geometry source of a force that acts on itself.';
