import { evaluateCurve } from '@/contracts/curve';
import { OUTPUT_KEY } from '@/contracts/engine';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getNumber, type NodeParams } from '@/contracts/params';
import type { PortValue } from '@/contracts/ports';
import { emptySkeleton, type Branch, type Skeleton } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { atSite, sampleVariance } from '@/graph/engine/seeds';
import { pickMaterialMesh, readMaterialSlots, type PickedMaterialMesh } from '@/materials/meshSelection';
import { WIND_ATTRIBUTES, windPhase1OfTuple, type WindTuple } from '@/geometry/windAttributes';
import { parentWindAt, windArraysOf } from '@/geometry/weldWind';
import { hash01, norm, type V3 } from '@/geometry/math3';
import type { AttachmentSet } from '@/contracts/attachment';
import { isGeneratorActive } from './common';
import { itemBranchTint, itemColorFn, type ItemColorFn, type ItemColorSpec } from '@/geometry/vertexColor';

export { readVertexColorOptions } from './common';
import { generateChildPlacements, type ChildPlacement } from './distribution';
import { createGenerationEnv } from './generationEnv';
import type { AnchorSlot } from './cutoutPlacement';
import { prepareParentBranch, sampleParentBranch, type ParentSample } from './frames';
import { createFusedParents } from './fusedParent';
import { attachSkeletonWind } from '@/geometry/windAttributes';

export const MAX_FOLIAGE_ITEMS = 60_000;

export function parentOf(inputs: NodeInputs): Skeleton {
  const v = inputs.parent?.[0];
  return v && v.kind === 'Structure' ? v.value.skeleton : emptySkeleton();
}

export const curveFactor = (p: NodeParams, id: string, t: number): number => {
  const c = p[id]?.curve;
  return c ? evaluateCurve(c, t) : 1;
};

/** Parameter value with its optional "±" variance applied (always consumes exactly one random number). */
export const varied = (rng: Rng, p: NodeParams, id: string, fallback: number): number =>
  sampleVariance(rng, getNumber(p, id, fallback), p[id]?.variance ?? 0);

export interface Placement {
  branch: Branch;
  sample: ParentSample;
  placement: ChildPlacement;
  rng: Rng;
  /** Running index of the placement within the node (sequential atlas cells, whorls). */
  index: number;
  /** Set when the placement comes from a parent anchor instead of the distribution. */
  anchor?: AnchorSlot;
}

/** Child placements of every parent branch through the shared distribution engine (Generation tab). */
export function collectPlacements(ctx: NodeContext, parent: Skeleton, params: NodeParams, max = MAX_FOLIAGE_ITEMS): Placement[] {
  const out: Placement[] = [];
  const env = createGenerationEnv(ctx, params, parent);
  // A split is one logical spine: the true tube of the parent only, the fused halves are not parents (see fusedParent.ts)
  const fused = createFusedParents(parent);
  for (const pb of parent.branches) {
    if (out.length >= max) break;
    if (pb.count < 2 || fused.halves.has(pb.id)) continue;
    ctx.cancel.throwIfCancelled();
    const prep = fused.prepare(pb, prepareParentBranch(parent, pb));
    const branchRng = ctx.rng.fork(`pb:${pb.id}`);
    for (const placement of generateChildPlacements(prep, params, branchRng, ctx.lod, max - out.length, env)) {
      out.push({
        branch: pb,
        sample: sampleParentBranch(prep, placement.u),
        placement,
        rng: atSite(branchRng.fork(`ch:${placement.slotIndex}`), placement.u, pb.id, ctx.seed),
        index: out.length,
      });
    }
  }
  return out;
}

/** Outward direction around the parent tangent at an azimuth. */
export function outwardAt(s: ParentSample, azimuth: number): V3 {
  const c = Math.cos(azimuth);
  const sn = Math.sin(azimuth);
  return norm([
    s.normal[0] * c + s.binormal[0] * sn,
    s.normal[1] * c + s.binormal[1] * sn,
    s.normal[2] * c + s.binormal[2] * sn,
  ]);
}

/** Index of the branch owning every point of a skeleton (cached per skeleton; -1 for points outside any branch). */
const branchOfPoint = new WeakMap<Skeleton, Int32Array>();
function branchIndexAt(sk: Skeleton, point: number): number {
  let map = branchOfPoint.get(sk);
  if (!map) {
    map = new Int32Array(sk.count).fill(-1);
    sk.branches.forEach((b, bi) => map?.fill(bi, b.start, Math.min(sk.count, b.start + b.count)));
    branchOfPoint.set(sk, map);
  }
  return point >= 0 && point < map.length ? (map[point] as number) : -1;
}

/**
 * Wind channels of the parent at the attachment (hierarchy 0..2, phase, level-1 phase) + a per-item phase offset.
 * With `at` (the item's rest position on / next to the parent spine) the weights are interpolated along the parent exactly like
 * the parent's own mesh rings, so the item's base moves with the parent vertex it touches (no step to the nearest skeleton point).
 */
export function parentWind(parent: Skeleton, point: number, salt: number, at?: ArrayLike<number>): [number, number, number, number, number] {
  const g = (k: (typeof WIND_ATTRIBUTES)[number]): number => {
    const a = parent.attributes.get(k);
    return a && point >= 0 && point < a.length ? (a[point] as number) : 0;
  };
  let tuple: WindTuple = [g('wind0'), g('wind1'), g('wind2'), g('windPhase'), parent.attributes.get('windPhase1') ? g('windPhase1') : g('windPhase')];
  const arrays = at ? windArraysOf(parent.attributes) : null;
  const branch = at && arrays ? parent.branches[branchIndexAt(parent, point)] : undefined;
  if (at && arrays && branch && branch.count >= 2) {
    tuple = parentWindAt({ arrays, start: branch.start, count: branch.count, position: parent.position }, at[0] as number, at[1] as number, at[2] as number);
  }
  const ph = (tuple[3] as number) * 0.6 + hash01(salt, 17) * 0.4;
  return [tuple[0] as number, tuple[1] as number, tuple[2] as number, ph - Math.floor(ph), windPhase1OfTuple(tuple)];
}

/**
 * Weighted pick from the Material tab's "Type" list (Material / Mesh / Weight rows): material (Material Sets resolved
 * by weight and season), then one of that material's cutout meshes. A None / mesh-less row yields the unit square.
 */
export function pickLeafType(rng: Rng, p: NodeParams, fallbackMaterial: string, season?: number): PickedMaterialMesh {
  return pickMaterialMesh(readMaterialSlots(p), { rng, fallbackMaterial, ...(season !== undefined ? { season } : {}) });
}

export const LOD_FOLIAGE_DETAIL = (lod: number): number => Math.pow(0.7, Math.min(Math.max(lod, 0), 3));

/** Green leaf tint from the Vertex Color section (+ variance and base->tip gradient is applied per card by the caller). */
export function leafTint(rng: Rng, p: NodeParams): V3 {
  const tint = (p.vertexColor?.value as number[] | undefined) ?? [1, 1, 1, 1];
  const v = getNumber(p, 'vertexColorVariance', 0.1);
  const k = 0.75 + rng.range(-v, v);
  return [0.13 * k * (tint[0] ?? 1) * 1.6, 0.3 * k * (tint[1] ?? 1) * 1.6, 0.07 * k * (tint[2] ?? 1) * 1.6];
}

/** Per-item vertex colour data of Leaf / Frond / Decal / Fin / Cluster: the Kekenik R tint and (non-neutral Mode only) the colour function. */
export function itemVertexColor(spec: ItemColorSpec, key: number, seed: number): { tint: number; colorAt?: ItemColorFn } {
  const colorAt = itemColorFn(spec);
  return { tint: itemBranchTint(key, seed), ...(colorAt ? { colorAt } : {}) };
}

export function leafAo(p: NodeParams, u: number, rng: Rng): number {
  const strength = getNumber(p, 'aoStrength', 0.5);
  const depth = getNumber(p, 'aoDepth', 0.5);
  const v = 1 - strength * (0.55 - 0.4 * u + rng.range(-0.1, 0.1)) * (0.5 + depth);
  return Math.min(1, Math.max(0.2, v));
}

/** Atlas cell rectangle [u0, v0, u1, v1] from the Skin > Atlas section. */
export function atlasRect(p: NodeParams, rng: Rng, index: number): [number, number, number, number] {
  const cols = Math.max(1, Math.round(getNumber(p, 'atlasColumns', 1)));
  const rows = Math.max(1, Math.round(getNumber(p, 'atlasRows', 1)));
  const cells = cols * rows;
  const draw = rng.next();
  const mode = (p.atlasMode?.value as string | undefined) ?? 'random';
  const cell = cells === 1 ? 0 : mode === 'sequential' ? index % cells : mode === 'fixed' ? Math.min(cells - 1, Math.round(getNumber(p, 'atlasCell', 0))) : Math.min(cells - 1, Math.floor(draw * cells));
  const cx = cell % cols;
  const cy = Math.floor(cell / cols);
  return [cx / cols, cy / rows, (cx + 1) / cols, (cy + 1) / rows];
}

export function postTransform(p: NodeParams): { scale: number; offset: V3; roll: number } {
  const off = p.postOffset?.value as number[] | undefined;
  return {
    scale: getNumber(p, 'postScale', 1),
    offset: [off?.[0] ?? 0, off?.[1] ?? 0, off?.[2] ?? 0],
    roll: deg2rad(getNumber(p, 'postRotate', 0)),
  };
}

export const isActive = (p: NodeParams, lod = 0): boolean => isGeneratorActive(p, lod);

/** Standard output of foliage-like generators. `skeleton` holds one short branch per emitted item. */
export function foliageOutput(skeleton: Skeleton, parent: Skeleton, geometry: MeshData, instances: number, seed: number, attachments?: AttachmentSet): NodeOutputs {
  attachSkeletonWind(skeleton, parent, seed);
  return {
    children: { kind: 'Structure', value: { skeleton, ...(attachments && attachments.instanceCount > 0 ? { attachments } : {}) } } satisfies PortValue,
    [OUTPUT_KEY.geometry]: { kind: 'Mesh', value: geometry },
    [OUTPUT_KEY.instances]: { kind: 'Scalar', value: instances },
    [OUTPUT_KEY.branchCount]: { kind: 'Scalar', value: skeleton.branches.length },
    [OUTPUT_KEY.pointCount]: { kind: 'Scalar', value: skeleton.count },
  };
}

export const emptyFoliage = (parent: Skeleton, seed: number): NodeOutputs => foliageOutput(emptySkeleton(), parent, emptyMeshData(), 0, seed);
