import { flatCurve, linearCurve, type Curve } from '@/contracts/curve';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import type { DynamicLodConfig, DynamicLodMode, LodGeometryType } from './types';

/** Default curve of one geometry family: everything kept at LOD value 0, `endKeep` left at LOD value 1. */
export const defaultKeepCurve = (endKeep: number): Curve => linearCurve(1, endKeep, [0, 1], [0, 1]);

export const DEFAULT_KEEP_END: Record<LodGeometryType, number> = { branches: 0.35, leaves: 0.08, fronds: 0.15, decorations: 0 };

/** Default grow curve: full area compensation over the whole transition. */
export const defaultGrowCurve = (): Curve => flatCurve(1, [0, 1], [0, 1]);

export const DYNAMIC_LOD_MODES: readonly string[] = ['Manual', 'Screen area'];

const curveParam = (p: NodeParams, id: string): Curve | null => {
  const v = p[id]?.value;
  return v && typeof v === 'object' && 'points' in v && Array.isArray((v as Curve).points) ? (v as Curve) : null;
};

export const DEFAULT_LOD_LEVELS = 4;

export function defaultDynamicLodConfig(): DynamicLodConfig {
  return {
    enabled: false,
    mode: 'manual',
    value: 0,
    branches: defaultKeepCurve(DEFAULT_KEEP_END.branches),
    leaves: defaultKeepCurve(DEFAULT_KEEP_END.leaves),
    fronds: defaultKeepCurve(DEFAULT_KEEP_END.fronds),
    decorations: defaultKeepCurve(DEFAULT_KEEP_END.decorations),
    growScale: defaultGrowCurve(),
    levels: DEFAULT_LOD_LEVELS,
  };
}

/** Read the Dynamic LOD group of the Tree node. Missing parameters (old projects) fall back to the neutral defaults. */
export function readDynamicLodConfig(p: NodeParams): DynamicLodConfig {
  const d = defaultDynamicLodConfig();
  const mode: DynamicLodMode = getString(p, 'lodMode', 'Manual') === 'Screen area' ? 'screen' : 'manual';
  const v = getNumber(p, 'lodValue', 0);
  const n = getNumber(p, 'lodLevels', DEFAULT_LOD_LEVELS);
  return {
    enabled: getBool(p, 'lodEnabled', false),
    mode,
    value: Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0)),
    branches: curveParam(p, 'lodBranches') ?? d.branches,
    leaves: curveParam(p, 'lodLeaves') ?? d.leaves,
    fronds: curveParam(p, 'lodFronds') ?? d.fronds,
    decorations: curveParam(p, 'lodDecorations') ?? d.decorations,
    growScale: curveParam(p, 'lodGrowScale') ?? d.growScale,
    levels: Math.min(8, Math.max(2, Math.round(Number.isFinite(n) ? n : DEFAULT_LOD_LEVELS))),
  };
}

/**
 * LOD value for a screen coverage: `fraction` is the bounding-sphere diameter as a share of the viewport height.
 * At or above `near` the value is 0, at or below `far` it is 1, in between it follows the logarithm of the coverage.
 */
export function lodValueForScreen(fraction: number, near = 0.9, far = 0.04): number {
  if (!(fraction > 0)) return 1;
  const t = (Math.log(near) - Math.log(fraction)) / (Math.log(near) - Math.log(far));
  return Math.min(1, Math.max(0, t));
}

/** Discrete export level `k` of `n`: LOD value k / (n - 1). */
export const levelValue = (k: number, n: number): number => (n <= 1 ? 0 : Math.min(1, Math.max(0, k / (n - 1))));
