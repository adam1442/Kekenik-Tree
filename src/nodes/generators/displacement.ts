import type { Curve } from '@/contracts/curve';
import type { DisplacementDef } from '@/contracts/material';
import type { MeshData } from '@/contracts/mesh';
import type { NodeContext } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { displaceMeshData, createTubeDisplacer, type DisplaceDirection } from '@/geometry/displaceMesh';
import type { TubeOptions } from '@/geometry/tubeMesher';
import { displacementStamp, hasDisplacementSource } from '@/materials/displacement';
import { getMaterialSource } from '@/materials/materialSource';

export type DisplacementState = 'off' | 'missing' | 'unloaded' | 'ready';

export interface ResolvedDisplacement {
  state: DisplacementState;
  def?: DisplacementDef;
}

/** Vertex budget of one displaced node: the subdivision spacing grows when the estimate would exceed it. */
export const DISPLACE_VERTEX_BUDGET = 1_500_000;

/**
 * Looks up the Displacements-panel asset chosen in a node's Displacement tab.
 *  - 'off'      no asset chosen, tab disabled or amount 0
 *  - 'missing'  the chosen asset does not exist (deleted) or has no image
 *  - 'unloaded' the image is not decoded yet (a refresh follows when it is)
 */
export function resolveDisplacement(params: NodeParams): ResolvedDisplacement {
  const id = getString(params, 'displacement', '');
  if (!id || !getBool(params, 'displaceEnabled', true)) return { state: 'off' };
  const def = getMaterialSource()?.displacements().find((d) => d.id === id);
  if (!def || !def.assetId) return { state: 'missing' };
  if (!hasDisplacementSource(def.assetId)) return { state: 'unloaded', def };
  return { state: 'ready', def };
}

/** Cache-key extra: changes when the chosen map, its processing settings or its decoded image change. */
export function displacementDependencyKey(params: NodeParams): string {
  const id = getString(params, 'displacement', '');
  if (!id) return '';
  const def = getMaterialSource()?.displacements().find((d) => d.id === id);
  return def ? `${id}:${displacementStamp(def)}` : `${id}:missing`;
}

/** Shows the warning badge on the node when its displacement map cannot be used. */
export function warnDisplacement(ctx: NodeContext, params: NodeParams): void {
  if (getNumber(params, 'displaceAmount', 0) === 0 && getNumber(params, 'displaceRadiusAmount', 0) === 0) return;
  const r = resolveDisplacement(params);
  if (r.state === 'missing') ctx.logger.warn('Displacement map is missing: pick an existing displacement with an image in the Displacements panel.');
  else if (r.state === 'unloaded') ctx.logger.warn('Displacement image is not loaded yet.');
}

const direction = (p: NodeParams): DisplaceDirection => (getString(p, 'displaceDirection', 'normal') === 'radial' ? 'radial' : 'normal');
const amountCurve = (p: NodeParams): Curve | undefined => p.displaceAmount?.curve as Curve | undefined;

/** Tube-mesher options for a node's Displacement tab (empty when displacement is off or not usable). */
export function tubeDisplacementOptions(params: NodeParams, lod: number, skeleton: Skeleton | null): Partial<TubeOptions> {
  const r = resolveDisplacement(params);
  if (r.state !== 'ready' || !r.def) return {};
  const displace = createTubeDisplacer({
    def: r.def,
    amount: getNumber(params, 'displaceAmount', 0),
    radiusAmount: getNumber(params, 'displaceRadiusAmount', 0),
    ...(amountCurve(params) ? { amountCurve: amountCurve(params) as Curve } : {}),
    bias: getNumber(params, 'displaceOffset', 0),
    midGrey: getBool(params, 'displaceMidGrey', true),
    scaleU: getNumber(params, 'displaceScale', 1) * getNumber(params, 'displaceScaleU', 1),
    scaleV: getNumber(params, 'displaceScale', 1) * getNumber(params, 'displaceScaleV', 1),
    tiling: getString(params, 'displaceTiling', 'world') === 'normalized' ? 'normalized' : 'world',
    tileSize: getNumber(params, 'displaceTileSize', 0.5),
    rotation: getNumber(params, 'displaceRotation', 0),
    lockSeams: getBool(params, 'displaceLockSeams', true),
    fadeBase: getNumber(params, 'displaceFadeBase', 1.5),
    fadeTip: getNumber(params, 'displaceFadeTip', 1),
    lod,
    lodFade: getBool(params, 'displaceLodFade', true),
  });
  if (!displace) return {};
  const out: Partial<TubeOptions> = { displace, displaceDirection: direction(params) };
  if (getBool(params, 'displaceAutoSubdivide', true)) {
    let spacing = Math.max(0.002, getNumber(params, 'displaceDetail', 0.03));
    if (skeleton) spacing = budgetedSpacing(skeleton, spacing, DISPLACE_VERTEX_BUDGET);
    out.maxSegmentLength = spacing;
  }
  return out;
}

/** Number of ring sides that gives quads of about `spacing` metres around a tube of `radius`, clamped to [minSides, 128]. */
export const displacedSides = (radius: number, spacing: number, minSides: number): number =>
  Math.min(128, Math.max(minSides, Math.ceil((2 * Math.PI * radius) / Math.max(1e-4, spacing))));

/** Increases the spacing until the estimated vertex count of the whole skeleton fits the budget. */
export function budgetedSpacing(sk: Skeleton, spacing: number, budget: number): number {
  let sp = spacing;
  for (let iter = 0; iter < 8; iter++) {
    let verts = 0;
    for (const b of sk.branches) {
      let rMax = 0;
      for (let k = 0; k < b.count; k++) rMax = Math.max(rMax, sk.radius[b.start + k] as number);
      verts += Math.min(600, Math.ceil(b.length / sp)) * displacedSides(rMax, sp, 8);
    }
    if (verts <= budget) break;
    sp *= 1.6;
  }
  return sp;
}

/** Generic mesh path (fronds, caps, decorations): amount in metres, normals + tangents rebuilt afterwards. */
export function displaceFromParams(mesh: MeshData, params: NodeParams, lod: number): MeshData {
  const r = resolveDisplacement(params);
  const amount = getNumber(params, 'displaceAmount', 0);
  if (r.state !== 'ready' || !r.def || amount === 0) return mesh;
  return displaceMeshData(mesh, r.def, {
    amount,
    scale: getNumber(params, 'displaceScale', 1),
    scaleU: getNumber(params, 'displaceScaleU', 1),
    scaleV: getNumber(params, 'displaceScaleV', 1),
    offset: getNumber(params, 'displaceOffset', 0),
    midGrey: getBool(params, 'displaceMidGrey', true),
    lod,
    lodFade: getBool(params, 'displaceLodFade', true),
    rotation: getNumber(params, 'displaceRotation', 0),
    direction: direction(params),
    lockSeams: getBool(params, 'displaceLockSeams', true),
  });
}
