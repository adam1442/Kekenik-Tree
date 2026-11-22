import type { NodeParams } from '@/contracts/params';

const numberOf = (params: NodeParams, id: string): number => {
  const v = params[id]?.value;
  return typeof v === 'number' ? v : 0;
};

/**
 * Brings the shared Generation parameters of older projects to the current layout: the former scalar `Pruning` (random
 * removal) is folded into Knockout (the new Pruning is a curve with its own id). Idempotent.
 */
export function migrateCommonGeneration(params: NodeParams): NodeParams {
  if (!('pruning' in params)) return params;
  const out: NodeParams = { ...params };
  const old = Math.min(1, Math.max(0, numberOf(params, 'pruning')));
  if (old > 0) {
    const ko = Math.min(1, Math.max(0, numberOf(params, 'knockout')));
    out.knockout = { ...(params.knockout ?? { value: 0 }), value: 1 - (1 - ko) * (1 - old) };
  }
  delete out.pruning;
  return out;
}
