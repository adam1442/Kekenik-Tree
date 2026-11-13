import type { MeshData } from '@/contracts/mesh';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import { emptySkeleton, SkeletonBuilder } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import { AttachmentBuilder } from '@/geometry/attachments';
import { composeMatrix, placeMeshes } from '@/geometry/instancing';
import { bladeBasis } from '@/geometry/leafMesher';
import { instanceKey } from '@/instances/keys';
import type { CutoutMesh } from '@/contracts/material';
import { cross, norm, rotate, type V3 } from '@/geometry/math3';
import { loadMeshAsset } from '@/geometry/meshAssets';
import { buildPrimitive, type PrimitiveKind } from '@/geometry/primitives';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import { getMaterialSource } from '@/materials/materialSource';
import { emitStructureOutput, extractParentSkeleton, isGeneratorActive } from './common';
import { anchorWind, orientAtAnchor, placementsFromSlots, planAnchorSlots, rigidInstanceAttachment } from './cutoutPlacement';
import {
  collectPlacements,
  curveFactor,
  emptyFoliage,
  foliageOutput,
  isActive,
  LOD_FOLIAGE_DETAIL,
  outwardAt,
  parentOf,
  parentWind,
  pickLeafType,
  postTransform,
  varied,
} from './foliageCommon';

const PRIMITIVES: Record<string, PrimitiveKind> = {
  quad: 'quad',
  cross: 'cross',
  cone: 'cone',
  sphere: 'sphere',
  'flower-card': 'flower',
};

interface ResolvedBase {
  mesh: MeshData;
  /** Set when the base is an authored cutout (placed with base pivot + axis orientation, anchors exported). */
  cutout: CutoutMesh | null;
}

function resolveBase(kind: string, assetId: string | null, material: string, detail: number, lod = 0, inputs?: NodeInputs): ResolvedBase {
  // Check attached Mesh port first
  const attachedMesh = inputs?.meshes?.[0];
  if (attachedMesh && attachedMesh.kind === 'Mesh' && attachedMesh.value.indices.length > 0) {
    return { mesh: attachedMesh.value, cutout: null };
  }
  if (kind === 'asset' || assetId) {
    // Check if assetId matches a CutoutMesh in the library
    const cutouts = getMaterialSource()?.cutoutMeshes?.() ?? [];
    const hitCutout = assetId
      ? cutouts.find((c) => c.id === assetId || c.name === assetId)
      : cutouts.find((c) => c.materialId === material);
    if (hitCutout) {
      return { mesh: buildCutoutGeometry(hitCutout, lod, { materialId: material }), cutout: hitCutout };
    }
    const asset = loadMeshAsset(assetId, material);
    if (asset) return { mesh: asset, cutout: null };
  }
  return { mesh: buildPrimitive(PRIMITIVES[kind] ?? 'sphere', material, detail), cutout: null };
}

/** Orthonormal basis with z along `dir` and a roll about it. */
function basisFor(dir: V3, hint: V3, roll: number): [V3, V3, V3] {
  const z = norm(dir);
  let x = norm(cross(hint, z), [1, 0, 0]);
  if (Math.abs(z[2]) > 0.999 && Math.hypot(x[0], x[1], x[2]) < 0.5) x = [1, 0, 0];
  if (roll !== 0) x = rotate(x, z, roll);
  const y = norm(cross(z, x));
  return [x, y, z];
}

function pushBranch(sb: SkeletonBuilder, parentBranch: number, parentPoint: number, gen: number, o: V3, d: V3, len: number): void {
  sb.beginBranch(parentBranch, parentPoint, gen);
  sb.addPoint(o[0], o[1], o[2], 0.001);
  sb.addPoint(o[0] + d[0] * len, o[1] + d[1] * len, o[2] + d[2] * len, 0.001);
  sb.endBranch();
}

const tintOf = (p: NodeParams, key: string): V3 => {
  const t = p[key]?.value as number[] | undefined;
  return [t?.[0] ?? 1, t?.[1] ?? 1, t?.[2] ?? 1];
};

/** Cluster: small bodies (berries, cones, flowers) around each placement, hanging down. */
export function evaluateCluster(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const placements = collectPlacements(ctx, parent, p, 6000);
  const detail = LOD_FOLIAGE_DETAIL(ctx.lod);
  const material = pickLeafType(ctx.rng.fork('mat'), p, 'cluster').material;
  const kind = getString(p, 'clusterShape', 'sphere');
  const assetId = (p.clusterAsset?.value as string | null | undefined) ?? null;
  const base = resolveBase(kind, assetId, material, Math.max(0.5, detail), ctx.lod, inputs).mesh;
  const post = postTransform(p);
  const baseColor: V3 = kind === 'cone' ? [0.42, 0.26, 0.12] : kind === 'sphere' ? [0.55, 0.12, 0.1] : [1, 1, 1];
  const tint = tintOf(p, 'vertexColor');
  const matrices: number[] = [];
  const tints: number[] = [];
  const winds: number[] = [];
  const sb = new SkeletonBuilder();
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  const count = Math.max(1, Math.round(getNumber(p, 'clusterCount', 5) * (0.4 + 0.6 * detail)));
  for (const pl of placements) {
    const s = pl.sample;
    const radius = getNumber(p, 'clusterRadius', 0.1) * curveFactor(p, 'clusterRadius', s.u);
    const wind = parentWind(parent, s.parentPoint, pl.index * 5);
    for (let k = 0; k < count && matrices.length < 16 * 20000; k++) {
      const rng = pl.rng.fork(`it:${k}`);
      const a = rng.range(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * radius;
      const size = varied(rng, p, 'clusterSize', 0.04) * post.scale;
      const hang = getNumber(p, 'clusterDroop', 0.7);
      const o: V3 = [s.position[0] + Math.cos(a) * r + post.offset[0], s.position[1] + Math.sin(a) * r + post.offset[1], s.position[2] - rng.range(0, radius) * hang + post.offset[2]];
      const out = outwardAt(s, a);
      const dir = norm([out[0] * (1 - hang), out[1] * (1 - hang), -hang + (1 - hang) * out[2]]);
      const [x, y, z] = basisFor(dir, [0, 0, 1], rng.range(0, Math.PI * 2));
      const m = new Float32Array(16);
      composeMatrix(o, x, y, z, size, m, 0);
      matrices.push(...m);
      const v = 0.8 + rng.range(-0.2, 0.2);
      tints.push(baseColor[0] * tint[0] * v, baseColor[1] * tint[1] * v, baseColor[2] * tint[2] * v);
      winds.push(wind[0], wind[1], wind[2], wind[3]);
      pushBranch(sb, pl.branch.id, s.parentPoint, gen, o, dir, size);
    }
  }
  const n = matrices.length / 16;
  const sk = sb.build();
  const geometry = n ? placeMeshes(base, Float32Array.from(matrices), n, { tints: Float32Array.from(tints), wind: Float32Array.from(winds) }) : emptyFoliage(parent, ctx.seed)['geometry']?.value;
  return foliageOutput(sk, parent, geometry as MeshData, n, ctx.seed);
}

/** Mesh generator: primitive-library or imported meshes placed along parents (baked or GPU-instanced). */
export function evaluateMeshInstances(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const slots = planAnchorSlots(ctx, inputs, parent, p, getNumber(p, 'number', 6));
  const placements = slots ? placementsFromSlots(slots, 20000) : collectPlacements(ctx, parent, p, 20000);
  const detail = LOD_FOLIAGE_DETAIL(ctx.lod);
  const material = getString(p, 'meshMaterial', 'leaf') || 'leaf';
  const resolved = resolveBase(getString(p, 'primitive', 'cone'), (p.meshAsset?.value as string | null | undefined) ?? null, material, Math.max(0.5, detail), ctx.lod, inputs);
  const base = resolved.mesh;
  const cutout = resolved.cutout;
  const post = postTransform(p);
  const dirMode = getString(p, 'meshDirection', 'outward');
  const tint = tintOf(p, 'meshTint');
  const tintVar = getNumber(p, 'meshTintVariance', 0.1);
  const matrices = new Float32Array(placements.length * 16);
  const tints = new Float32Array(placements.length * 3);
  const winds = new Float32Array(placements.length * 4);
  const sb = new SkeletonBuilder();
  const att = new AttachmentBuilder(ctx.nodeId);
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  placements.forEach((pl, i) => {
    const s = pl.sample;
    const rng = pl.rng;
    const az = pl.placement.azimuthRad + (getNumber(p, 'meshYaw', 0) > 0 ? rng.range(-1, 1) * Math.PI * getNumber(p, 'meshYaw', 0) : 0);
    const out = outwardAt(s, az);
    const ang = deg2rad(varied(rng, p, 'meshAngle', 50) * curveFactor(p, 'meshAngle', s.u));
    const T = s.tangent;
    let dir: V3;
    switch (dirMode) {
      case 'parent':
        dir = T;
        break;
      case 'up':
        dir = [0, 0, 1];
        break;
      case 'down':
        dir = [0, 0, -1];
        break;
      default:
        dir = norm([T[0] * Math.cos(ang) + out[0] * Math.sin(ang), T[1] * Math.cos(ang) + out[1] * Math.sin(ang), T[2] * Math.cos(ang) + out[2] * Math.sin(ang)]);
    }
    let anchorScale = 1;
    let facing: V3 = out;
    if (pl.anchor) {
      const o = orientAtAnchor(pl.anchor, p, rng.fork('anc'), getNumber(p, 'anchorAlign', 1) < 1 ? dir : null);
      dir = o.axis;
      anchorScale = o.scale;
      if (o.useFacing) facing = o.facing;
    }
    const scale = varied(rng, p, 'meshScale', 0.2) * curveFactor(p, 'meshScale', s.u) * post.scale * anchorScale;
    const roll = deg2rad(varied(rng, p, 'meshRoll', 0)) + post.roll;
    const off = getNumber(p, 'meshOffset', 0);
    let x: V3, y: V3, z: V3;
    // Cutouts: local +Y = growth axis (Straighten base tangent), +Z = card normal. Other meshes keep +Z = direction.
    let growth: V3;
    if (cutout) {
      const b = bladeBasis(dir, facing, roll);
      x = b.side;
      y = b.axis;
      z = cross(b.side, b.axis);
      growth = y;
    } else {
      [x, y, z] = basisFor(dir, out, roll);
      growth = z;
    }
    const o: V3 = [s.position[0] + growth[0] * off + post.offset[0], s.position[1] + growth[1] * off + post.offset[1], s.position[2] + growth[2] * off + post.offset[2]];
    composeMatrix(o, x, y, z, scale, matrices, i * 16);
    const v = 1 + rng.range(-tintVar, tintVar);
    tints.set([tint[0] * v, tint[1] * v, tint[2] * v], i * 3);
    const wind0 = parentWind(parent, s.parentPoint, pl.index * 3);
    winds.set(pl.anchor ? anchorWind(wind0, pl.anchor.frame.axisT) : wind0, i * 4);
    pushBranch(sb, pl.branch.id, s.parentPoint, gen, o, growth, scale);
    if (cutout) {
      const ia = rigidInstanceAttachment(cutout, o, x, y, z, scale);
      att.beginInstance(pl.anchor ? pl.anchor.key : instanceKey(ctx.nodeId, pl.branch.id, pl.placement.slotIndex, 0), i, ia.base, scale);
      for (const a of ia.anchors) att.addFrame(a.frame, a.scale, a.id, a.index, a.axisT, a.tags);
    }
  });
  const n = placements.length;
  const sk = sb.build();
  if (n === 0) return emptyFoliage(parent, ctx.seed);
  let geometry: MeshData;
  if (getBool(p, 'gpuInstancing', false)) {
    const avg: V3 = [tint[0], tint[1], tint[2]];
    const colors = base.colors ? Float32Array.from(base.colors) : undefined;
    if (colors) for (let i = 0; i < colors.length; i += 4) {
      colors[i] = (colors[i] as number) * avg[0];
      colors[i + 1] = (colors[i + 1] as number) * avg[1];
      colors[i + 2] = (colors[i + 2] as number) * avg[2];
    }
    geometry = { ...base, ...(colors ? { colors } : {}), instanced: { count: n, matrices } };
  } else geometry = placeMeshes(base, matrices, n, { tints, wind: winds });
  return foliageOutput(sk, parent, geometry, n, ctx.seed, att.build());
}

/** Cap: closes the end of every parent branch with a rounded disc. */
export function evaluateCap(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = extractParentSkeleton(inputs);
  if (!isGeneratorActive(p, ctx.lod) || parent.count === 0) return emitStructureOutput(emptySkeleton(), p, ctx.lod, 'bark', 0, parent, ctx.seed);
  const scale = getNumber(p, 'capRadiusScale', 1);
  const thickness = Math.max(0.002, getNumber(p, 'capThickness', 0.01));
  const sb = new SkeletonBuilder();
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  for (const pb of parent.branches) {
    if (pb.count < 2) continue;
    ctx.cancel.throwIfCancelled();
    const idx = pb.start + pb.count - 1;
    const o: V3 = [parent.position[idx * 3] as number, parent.position[idx * 3 + 1] as number, parent.position[idx * 3 + 2] as number];
    const d: V3 = [parent.direction[idx * 3] as number, parent.direction[idx * 3 + 1] as number, parent.direction[idx * 3 + 2] as number];
    const r = Math.max((parent.radius[idx] as number) * scale, 0.002);
    const h = thickness + r * 0.4;
    sb.beginBranch(pb.id, idx, gen);
    sb.addPoint(o[0], o[1], o[2], r);
    sb.addPoint(o[0] + d[0] * h * 0.5, o[1] + d[1] * h * 0.5, o[2] + d[2] * h * 0.5, r * 0.85);
    sb.addPoint(o[0] + d[0] * h, o[1] + d[1] * h, o[2] + d[2] * h, r * 0.35);
    sb.endBranch();
  }
  const capParams: NodeParams = { ...p, tipRings: { value: getNumber(p, 'capRings', 2) }, collarAmount: { value: 0 } };
  return emitStructureOutput(sb.build(), capParams, ctx.lod, 'bark', undefined, parent, ctx.seed);
}
