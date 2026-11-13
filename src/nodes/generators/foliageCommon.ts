import { evaluateCurve } from '@/contracts/curve';
import { OUTPUT_KEY } from '@/contracts/engine';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getBool, getNumber, type ListItem, type NodeParams } from '@/contracts/params';
import type { PortValue } from '@/contracts/ports';
import { emptySkeleton, type Branch, type Skeleton } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import { resolveMaterialRef } from '@/materials/materialSource';
import { WIND_ATTRIBUTES } from '@/geometry/windAttributes';
import { hash01, norm, type V3 } from '@/geometry/math3';
import type { AttachmentSet } from '@/contracts/attachment';
import { generateChildPlacements, type ChildPlacement } from './distribution';
import type { AnchorSlot } from './cutoutPlacement';
import { prepareParentBranch, sampleParentBranch, type ParentSample } from './frames';
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
  for (const pb of parent.branches) {
    if (out.length >= max) break;
    if (pb.count < 2) continue;
    ctx.cancel.throwIfCancelled();
    const prep = prepareParentBranch(parent, pb);
    const branchRng = ctx.rng.fork(`pb:${pb.id}`);
    for (const placement of generateChildPlacements(prep, params, branchRng, ctx.lod, max - out.length)) {
      out.push({
        branch: pb,
        sample: sampleParentBranch(prep, placement.u),
        placement,
        rng: branchRng.fork(`ch:${placement.slotIndex}`),
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

/** Wind channels of the parent at the attachment point (hierarchy 0..2, phase) + a per-item phase offset. */
export function parentWind(parent: Skeleton, point: number, salt: number): [number, number, number, number] {
  const g = (k: (typeof WIND_ATTRIBUTES)[number]): number => {
    const a = parent.attributes.get(k);
    return a && point >= 0 && point < a.length ? (a[point] as number) : 0;
  };
  const ph = g('windPhase') * 0.6 + hash01(salt, 17) * 0.4;
  return [g('wind0'), g('wind1'), g('wind2'), ph - Math.floor(ph)];
}

/** Weighted pick from the Material tab's "Leaves > Type" list. */
export function pickLeafType(rng: Rng, p: NodeParams, fallbackMaterial: string): { material: string; mesh: string } {
  const t = pickLeafTypeRaw(rng, p, fallbackMaterial);
  // Material Sets are resolved per instance with the same seeded RNG (plain materials consume no draw).
  return { material: resolveMaterialRef(t.material, rng), mesh: t.mesh };
}

function pickLeafTypeRaw(rng: Rng, p: NodeParams, fallbackMaterial: string): { material: string; mesh: string } {
  const items = p.leafTypes?.value as ListItem[] | undefined;
  const list = Array.isArray(items) ? items : [];
  let total = 0;
  for (const it of list) total += Math.max(0, Number(it.weight ?? 1));
  const r = rng.next();
  if (total <= 0) return { material: fallbackMaterial, mesh: 'any' };
  let acc = 0;
  for (const it of list) {
    acc += Math.max(0, Number(it.weight ?? 1)) / total;
    if (r <= acc) return { material: String(it.material || fallbackMaterial), mesh: String(it.mesh ?? 'any') };
  }
  const last = list[list.length - 1];
  return { material: String(last?.material || fallbackMaterial), mesh: String(last?.mesh ?? 'any') };
}

export const LOD_FOLIAGE_DETAIL = (lod: number): number => Math.pow(0.7, Math.min(Math.max(lod, 0), 3));

/** Green leaf tint from the Vertex Color section (+ variance and base->tip gradient is applied per card by the caller). */
export function leafTint(rng: Rng, p: NodeParams): V3 {
  const tint = (p.vertexColor?.value as number[] | undefined) ?? [1, 1, 1, 1];
  const v = getNumber(p, 'vertexColorVariance', 0.1);
  const k = 0.75 + rng.range(-v, v);
  return [0.13 * k * (tint[0] ?? 1) * 1.6, 0.3 * k * (tint[1] ?? 1) * 1.6, 0.07 * k * (tint[2] ?? 1) * 1.6];
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

export const isActive = (p: NodeParams): boolean => getBool(p, 'active', true);

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
