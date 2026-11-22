import type { NodeParams } from '@/contracts/params';

const numberOf = (params: NodeParams, id: string): number | undefined => {
  const v = params[id]?.value;
  return typeof v === 'number' ? v : undefined;
};

/**
 * Brings the Generation parameters of older projects to the current mode set:
 * - `whorled` became `absolute-steps` (the Whorls / Per whorl / Spread / Step roll ids are kept),
 * - the golden-angle `phyllotaxy` (Number + Divergence angle) becomes Alternating (distichous) with `Spiral` = angle - 180,
 *   `Internode length` 0 (fit `Limit` groups between Last and First) and `Limit` = Number,
 * - `bifurcation` takes its old Number as the new Count.
 * Only called for nodes saved before the new parameters existed.
 */
export function migrateGenerationParams(params: NodeParams): NodeParams {
  const mode = params.mode?.value;
  if (typeof mode !== 'string') return params;
  if (mode === 'whorled') {
    return { ...params, mode: { ...params.mode, value: 'absolute-steps' } };
  }
  if (mode === 'phyllotaxy') {
    const out: NodeParams = { ...params };
    const angle = numberOf(params, 'phyllotaxyAngle') ?? 137.508;
    const count = numberOf(params, 'number');
    out.phyllotaxyStyle = { value: 'alternating-distichous' };
    out.phyllotaxyInternode = { value: 0 };
    out.phyllotaxySpiral = { value: Math.max(-180, Math.min(180, angle - 180)) };
    if (count !== undefined) out.phyllotaxyLimit = { value: Math.max(1, Math.round(count)) };
    delete out.phyllotaxyAngle;
    return out;
  }
  if (mode === 'bifurcation') {
    const count = numberOf(params, 'number');
    return count === undefined ? params : { ...params, bifurcationCount: { value: Math.max(0, Math.round(count)) } };
  }
  return params;
}

/** Chains `migrateGenerationParams` after an existing node migration. */
export function withGenerationMigration(
  previous?: (params: NodeParams, fromVersion: number) => NodeParams,
): (params: NodeParams, fromVersion: number) => NodeParams {
  return (params, fromVersion) => migrateGenerationParams(previous ? previous(params, fromVersion) : params);
}
