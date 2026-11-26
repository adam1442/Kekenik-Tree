import { compactVariance, resolveVariance, type VarianceValue } from '@/contracts/variance';
import type { NodeParams } from '@/contracts/params';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Normalise one stored variance: a number is kept as is (the classic uniform format), an object is validated, clamped and
 * compacted, anything else is dropped. Returns `undefined` for "no variance".
 */
export function migrateVariance(raw: unknown): VarianceValue | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : 0;
  if (!isRecord(raw) || typeof raw.amount !== 'number') return undefined;
  return compactVariance(resolveVariance(raw as VarianceValue));
}

/** Variance migration of a whole node: old files (number) load unchanged, malformed objects are repaired. */
export function migrateParamVariance(params: NodeParams): NodeParams {
  let out: NodeParams | null = null;
  for (const [id, state] of Object.entries(params)) {
    if (!state || state.variance === undefined) continue;
    const next = migrateVariance(state.variance);
    if (JSON.stringify(next) === JSON.stringify(state.variance)) continue;
    out ??= { ...params };
    const { variance: _old, ...rest } = state;
    out[id] = next === undefined ? rest : { ...rest, variance: next };
  }
  return out ?? params;
}
