import type { Curve } from '@/contracts/curve';
import type { DisplacementDef } from '@/contracts/material';
import type { MeshData } from '@/contracts/mesh';
import type { NodeContext } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { displaceMeshData, createTubeDisplacer, type DisplaceDirection } from '@/geometry/displaceMesh';
import type { TubeOptions } from '@/geometry/tubeMesher';
import { Rng } from '@/core/rng';
import { createBranchDisplacer, sharpnessLut, type BranchDisplaceSpec, type DisplaceMapping, type DisplaceSource } from '@/generators/displace';
import { createDisplacementDef, displacementStamp, getHeightMips, hasDisplacementSource, type HeightField } from '@/materials/displacement';
import { getMaterialSource, resolveMaterialRef } from '@/materials/materialSource';
import { primaryMaterialRef } from './uvConfig';

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
  const assetKey = !id ? '' : ((def) => (def ? `${id}:${displacementStamp(def)}` : `${id}:missing`))(getMaterialSource()?.displacements().find((d) => d.id === id));
  if (readSource(params) !== 'material') return assetKey;
  const heights = materialHeightDefs(primaryMaterialRef(params)).map((d) => displacementStamp(d));
  return `${assetKey}|m:${heights.join(',')}`;
}

/** Source of the Displacement > Main height values (Trunk / Branch / Root). Nodes without the parameter read as 'noise' (all amounts 0, nothing moves). */
export function readSource(params: NodeParams): DisplaceSource {
  const v = getString(params, 'displaceSource', '');
  return v === 'material' ? 'material' : v === 'displacement' ? 'displacement' : 'noise';
}

/** Height-map definitions of a material (or of every member of a material set) referenced by the node's Material property. */
function materialHeightDefs(ref: string): DisplacementDef[] {
  const src = getMaterialSource();
  if (!src || !ref) return [];
  const materials = src.materials();
  const set = src.sets().find((x) => x.id === ref || x.name === ref);
  const ids = materials.some((m) => m.id === ref || m.name === ref)
    ? [materials.find((m) => m.id === ref || m.name === ref)?.id ?? ref]
    : set
      ? set.members.map((m) => m.materialId)
      : [];
  const out: DisplacementDef[] = [];
  for (const id of ids) {
    const mat = materials.find((m) => m.id === id);
    const assetId = mat?.slots.height?.texture?.assetId;
    if (mat && assetId) out.push({ ...createDisplacementDef(`material-height:${mat.id}`, mat.name), assetId, normalize: false });
  }
  return out;
}

/** Height definition of the Material source for an already resolved material id. */
export function materialHeightDef(materialId: string): DisplacementDef | null {
  return materialHeightDefs(materialId)[0] ?? null;
}

export interface ResolvedHeightSource {
  state: DisplacementState;
  chain: readonly HeightField[] | null;
}

/** Mip chain of the chosen Main source: Noise needs none; Material = Height map of the node's material; Displacement = named asset. */
export function resolveHeightSource(params: NodeParams, materialId: string): ResolvedHeightSource {
  const source = readSource(params);
  if (source === 'noise') return { state: 'ready', chain: null };
  let def: DisplacementDef | null;
  if (source === 'displacement') {
    const r = resolveDisplacement(params);
    if (r.state !== 'ready') return { state: r.state, chain: null };
    def = r.def ?? null;
  } else {
    def = materialHeightDef(materialId);
    if (!def) return { state: 'missing', chain: null };
    if (!hasDisplacementSource(def.assetId)) return { state: 'unloaded', chain: null };
  }
  const chain = def ? getHeightMips(def) : null;
  return chain ? { state: 'ready', chain } : { state: 'unloaded', chain: null };
}

/** Shows the warning badge on the node when its displacement map cannot be used. */
export function warnDisplacement(ctx: NodeContext, params: NodeParams): void {
  const mainActive = getNumber(params, 'displaceRadial', 0) !== 0 || getNumber(params, 'displaceLength', 0) !== 0;
  if (mainActive && readSource(params) === 'material') {
    const ref = resolveMaterialRef(primaryMaterialRef(params), new Rng(0));
    const h = resolveHeightSource(params, ref);
    if (h.state === 'missing') ctx.logger.warn('Displacement source is Material: assign a material that has a Height map.');
    else if (h.state === 'unloaded') ctx.logger.warn('The material Height image is not loaded yet.');
  }
  const legacy = getNumber(params, 'displaceAmount', 0) !== 0 || getNumber(params, 'displaceRadiusAmount', 0) !== 0;
  if (!legacy && !(mainActive && readSource(params) === 'displacement')) return;
  const r = resolveDisplacement(params);
  if (r.state === 'missing') ctx.logger.warn('Displacement map is missing: pick an existing displacement with an image in the Displacements panel.');
  else if (r.state === 'unloaded') ctx.logger.warn('Displacement image is not loaded yet.');
}

const direction = (p: NodeParams): DisplaceDirection => (getString(p, 'displaceDirection', 'normal') === 'radial' ? 'radial' : 'normal');
const amountCurve = (p: NodeParams): Curve | undefined => p.displaceAmount?.curve as Curve | undefined;

const mappingOf = (p: NodeParams): DisplaceMapping => (getString(p, 'displaceMapping', 'use-uvs') === 'fit-to-geometry' ? 'fit' : 'uvs');
const curveOf = (p: NodeParams, id: string): Curve | null => {
  const v = p[id]?.value;
  return v && typeof v === 'object' && 'points' in v && Array.isArray((v as Curve).points) ? (v as Curve) : null;
};

/** Spec of the new Displacement tab (Main / Fine / Shape / Flares) read from a node's parameters. */
export function branchDisplaceSpec(params: NodeParams, lod: number, chain: readonly HeightField[] | null): BranchDisplaceSpec {
  return {
    source: readSource(params),
    radial: getNumber(params, 'displaceRadial', 0),
    length: getNumber(params, 'displaceLength', 0),
    sharpness: sharpnessLut(curveOf(params, 'displaceSharpness')),
    mapping: mappingOf(params),
    scaleU: Math.max(0.05, getNumber(params, 'displaceUScale', 1)),
    scaleV: Math.max(0.05, getNumber(params, 'displaceVScale', 1)),
    seed: Math.round(getNumber(params, 'displaceMainSeed', 0)),
    map: chain,
    fine: {
      amount: getNumber(params, 'displaceFineAmount', 0),
      sharpness: sharpnessLut(curveOf(params, 'displaceFineSharpness')),
      scale: getNumber(params, 'displaceFineScale', 1),
    },
    shape: {
      amount: getNumber(params, 'displaceShapeAmount', 0),
      twist: getNumber(params, 'displaceShapeTwist', 0),
      scale: getNumber(params, 'displaceShapeScale', 1),
      seed: Math.round(getNumber(params, 'displaceShapeSeed', 0)),
    },
    flares: {
      radius: getNumber(params, 'displaceFlareRadius', 0),
      noiseScale: getNumber(params, 'displaceFlareNoise', 5),
      height: getNumber(params, 'displaceFlareHeight', 1),
      pinch: getNumber(params, 'displaceFlarePinch', 0),
      angle: getNumber(params, 'displaceFlareAngle', 0),
      seed: Math.round(getNumber(params, 'displaceFlareSeed', 0)),
    },
    fadeBase: getNumber(params, 'displaceFadeBase', 1.5),
    fadeTip: getNumber(params, 'displaceFadeTip', 1),
    lod,
    lodFade: getBool(params, 'displaceLodFade', true),
  };
}

/**
 * Tube-mesher options for a node's Displacement tab: the new Main / Fine / Shape / Flares field plus the legacy asset
 * amount (old projects). Empty when nothing would move. `materialId` is the node's resolved material (Material source).
 */
export function tubeDisplacementOptions(params: NodeParams, lod: number, skeleton: Skeleton | null, materialId = ''): Partial<TubeOptions> {
  const out: Partial<TubeOptions> = {};
  const height = resolveHeightSource(params, materialId);
  const field = createBranchDisplacer(branchDisplaceSpec(params, lod, height.chain));
  if (field) {
    out.displaceField = field;
    out.displaceDirection = direction(params);
  }
  const r = resolveDisplacement(params);
  if (r.state === 'ready' && r.def) {
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
    if (displace) {
      out.displace = displace;
      out.displaceDirection = direction(params);
    }
  }
  if ((out.displace || out.displaceField) && getBool(params, 'displaceAutoSubdivide', true)) {
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
