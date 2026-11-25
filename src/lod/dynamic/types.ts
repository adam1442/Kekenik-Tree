import type { Curve } from '@/contracts/curve';

/** Geometry families the Dynamic LOD curves control. */
export type LodGeometryType = 'branches' | 'leaves' | 'fronds' | 'decorations';

export const LOD_GEOMETRY_TYPES: readonly LodGeometryType[] = ['branches', 'leaves', 'fronds', 'decorations'];

/** Manual: the LOD value is set by hand. Screen area: it follows the camera distance and the tree's bounding sphere. */
export type DynamicLodMode = 'manual' | 'screen';

/** Tree > Dynamic LOD settings (read once per evaluation, carried on the scene). */
export interface DynamicLodConfig {
  enabled: boolean;
  mode: DynamicLodMode;
  /** Manual LOD value 0 (full detail) .. 1 (lowest detail). */
  value: number;
  /** Kept fraction of every geometry family over the transition (x = LOD value, y = 1 keep all .. 0 keep none). */
  branches: Curve;
  leaves: Curve;
  fronds: Curve;
  decorations: Curve;
  /** How much of the lost leaf area the surviving leaves / fronds win back (x = LOD value, y = 0 none .. 1 full). */
  growScale: Curve;
  /** Number of discrete levels written on export (level k = LOD value k / (n - 1)). */
  levels: number;
}
