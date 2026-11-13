import type { NodeParams, ParamState } from '@/contracts/params';
import type { InstanceKey, InstanceOverride, InstanceTable, InstanceTransform, OverrideParam, OverrideScalar, TransformField } from './types';

/** Reserved param id that stores a node's overrides (a JSON string, so graph / project serialisation is unchanged). */
export const OVERRIDES_PARAM_ID = '__overrides';
export const OVERRIDES_VERSION = 1;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const TRANSFORM_FIELDS: readonly TransformField[] = ['positionAlongParent', 'rotation', 'roll', 'lengthScale', 'radiusScale'];

/** Neutral value of a transform field (what "no override" means). */
export function transformNeutral(field: TransformField): number {
  return field === 'lengthScale' || field === 'radiusScale' ? 1 : 0;
}

function parseParam(raw: unknown): OverrideParam | null {
  if (!isRecord(raw)) return null;
  const mode = raw.mode;
  const value = raw.value;
  if (mode !== 'set' && mode !== 'offset' && mode !== 'scale') return null;
  if (typeof value !== 'number' && typeof value !== 'boolean' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (mode !== 'set' && typeof value !== 'number') return null;
  return { mode, value };
}

function parseTransform(raw: unknown): InstanceTransform | undefined {
  if (!isRecord(raw)) return undefined;
  const out: InstanceTransform = {};
  for (const f of TRANSFORM_FIELDS) {
    const v = raw[f];
    if (finite(v)) out[f] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseOverride(raw: unknown): InstanceOverride | null {
  if (!isRecord(raw) || !finite(raw.key)) return null;
  const params: Record<string, OverrideParam> = {};
  if (isRecord(raw.params)) {
    for (const [id, p] of Object.entries(raw.params)) {
      const parsed = parseParam(p);
      if (parsed) params[id] = parsed;
    }
  }
  const out: InstanceOverride = { key: raw.key >>> 0, params };
  const a = raw.anchor;
  if (isRecord(a) && finite(a.parentKey) && finite(a.index)) out.anchor = { parentKey: a.parentKey >>> 0, index: Math.trunc(a.index) };
  const t = parseTransform(raw.transform);
  if (t) out.transform = t;
  if (raw.hidden === true) out.hidden = true;
  if (raw.pruned === true) out.pruned = true;
  return out;
}

/** Validate + migrate a stored payload: `{ v, items }` (current) or a bare array (version 0, pre-release). */
export function migrateOverridesPayload(raw: unknown): InstanceOverride[] {
  let items: unknown[] = [];
  if (Array.isArray(raw)) items = raw;
  else if (isRecord(raw) && Array.isArray(raw.items)) items = raw.items;
  const out: InstanceOverride[] = [];
  const seen = new Set<number>();
  for (const it of items) {
    const o = parseOverride(it);
    if (!o || seen.has(o.key)) continue;
    seen.add(o.key);
    out.push(o);
  }
  return out;
}

export function encodeOverrides(list: readonly InstanceOverride[]): string {
  return JSON.stringify({ v: OVERRIDES_VERSION, items: list });
}

export function decodeOverrides(json: string): InstanceOverride[] {
  try {
    return migrateOverridesPayload(JSON.parse(json) as unknown);
  } catch {
    return [];
  }
}

/** Overrides stored on a node (empty list when none). */
export function readOverrides(params: NodeParams): InstanceOverride[] {
  const v = params[OVERRIDES_PARAM_ID]?.value;
  return typeof v === 'string' && v.length > 0 ? decodeOverrides(v) : [];
}

export function overridesParamState(list: readonly InstanceOverride[]): ParamState {
  return { value: list.length === 0 ? '' : encodeOverrides(list) };
}

export function isEmptyOverride(o: InstanceOverride): boolean {
  return Object.keys(o.params).length === 0 && o.transform === undefined && o.hidden !== true && o.pruned !== true;
}

/** Remove neutral transform fields and empty containers; returns null when nothing is left. */
export function normaliseOverride(o: InstanceOverride): InstanceOverride | null {
  const next: InstanceOverride = { ...o, params: { ...o.params } };
  if (o.transform) {
    const t: InstanceTransform = {};
    for (const f of TRANSFORM_FIELDS) {
      const v = o.transform[f];
      if (v !== undefined && Math.abs(v - transformNeutral(f)) > 1e-9) t[f] = v;
    }
    if (Object.keys(t).length > 0) next.transform = t;
    else delete next.transform;
  }
  if (next.hidden !== true) delete next.hidden;
  if (next.pruned !== true) delete next.pruned;
  return isEmptyOverride(next) ? null : next;
}

/** Insert / replace / remove (when neutral) the override with `o.key`. Returns a new list. */
export function upsertOverride(list: readonly InstanceOverride[], o: InstanceOverride): InstanceOverride[] {
  const norm = normaliseOverride(o);
  const rest = list.filter((x) => x.key !== o.key);
  return norm ? [...rest, norm] : rest;
}

export function findOverride(list: readonly InstanceOverride[], key: InstanceKey): InstanceOverride | undefined {
  return list.find((o) => o.key === key);
}

/** Result of applying one override to the procedural value. */
export function applyOverrideValue(base: OverrideScalar, p: OverrideParam): OverrideScalar {
  if (typeof base !== 'number') return p.value;
  if (typeof p.value !== 'number') return p.value;
  if (p.mode === 'offset') return base + p.value;
  if (p.mode === 'scale') return base * p.value;
  return p.value;
}

/** Copy of `params` with the overridden values applied (only changed entries are cloned). */
export function applyParamOverrides(params: NodeParams, over: Readonly<Record<string, OverrideParam>>): NodeParams {
  const ids = Object.keys(over);
  if (ids.length === 0) return params;
  const out: NodeParams = { ...params };
  for (const id of ids) {
    const p = over[id] as OverrideParam;
    const state = params[id];
    const base = state?.value;
    const baseScalar: OverrideScalar = typeof base === 'number' || typeof base === 'boolean' || typeof base === 'string' ? base : 0;
    out[id] = { ...(state ?? { value: null }), value: applyOverrideValue(baseScalar, p), curve: null };
  }
  return out;
}

/** Stable string identity of an override's effect on generation (for per-override config caches). */
export function overrideSignature(o: InstanceOverride): string {
  return JSON.stringify([o.params, o.transform ?? null]);
}

export interface OverrideResolution {
  /** Instance row -> override. */
  matched: Map<number, InstanceOverride>;
  /** Overrides whose instance no longer exists. */
  orphans: InstanceOverride[];
}

/** Match overrides against the instances that actually exist (exact key only: never apply to a wrong instance). */
export function resolveOverrides(table: InstanceTable | null | undefined, list: readonly InstanceOverride[]): OverrideResolution {
  const matched = new Map<number, InstanceOverride>();
  const orphans: InstanceOverride[] = [];
  const rows = new Map<number, number>();
  if (table) for (let i = 0; i < table.count; i++) rows.set(table.key[i] as number, i);
  const pruned = new Set<number>(table ? Array.from(table.pruned) : []);
  for (const o of list) {
    const row = rows.get(o.key);
    if (row !== undefined) matched.set(row, o);
    else if (!pruned.has(o.key)) orphans.push(o);
  }
  return { matched, orphans };
}

/**
 * Re-anchor orphans: an orphan whose recorded parent still exists is moved to the nearest FREE child slot of that
 * parent (smallest index distance, at most `maxDistance`). Everything else stays an orphan (listed, never applied).
 */
export function reanchorOverrides(
  table: InstanceTable,
  list: readonly InstanceOverride[],
  maxDistance = 2,
): { overrides: InstanceOverride[]; remaining: InstanceOverride[] } {
  const { orphans } = resolveOverrides(table, list);
  const orphanKeys = new Set(orphans.map((o) => o.key));
  const used = new Set<number>();
  for (const o of list) if (!orphanKeys.has(o.key)) used.add(o.key);
  const moved = new Map<number, InstanceOverride>();
  const remaining: InstanceOverride[] = [];
  for (const o of orphans) {
    const a = o.anchor;
    let best = -1;
    let bestDist = Infinity;
    if (a) {
      for (let i = 0; i < table.count; i++) {
        if (table.parentKey[i] !== a.parentKey || used.has(table.key[i] as number)) continue;
        const d = Math.abs((table.index[i] as number) - a.index);
        if (d <= maxDistance && d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    if (best < 0) {
      remaining.push(o);
      continue;
    }
    const key = table.key[best] as number;
    used.add(key);
    moved.set(o.key, { ...o, key, anchor: { parentKey: table.parentKey[best] as number, index: table.index[best] as number } });
  }
  const overrides = list.map((o) => moved.get(o.key) ?? o).filter((o) => !remaining.includes(o));
  return { overrides: [...overrides, ...remaining], remaining };
}
