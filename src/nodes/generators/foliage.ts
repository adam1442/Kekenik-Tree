import { getNumber, getString, type NodeParams } from '@/contracts/params';
import type { Lineage } from '@/contracts/ports';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import type { LodLevel } from '@/contracts/material';
import { deg2rad } from '@/core/math';
import { AttachmentBuilder } from '@/geometry/attachments';
import { bladeBasis, buildLeafMesh, cardAttachments, type CardLight, type LeafCard, type LeafOutline } from '@/geometry/leafMesher';
import type { LeafLightingSettings } from '@/contracts/lighting';
import { mergeByMaterial, type LeafSpan } from '@/geometry/batchedLeaf';
import { isLightingActive, resolveAdjust, resolveLightAnchor, surfaceDirection } from '@/geometry/leafLighting';
import { instanceKey } from '@/instances/keys';
import { anchorWind, orientAtAnchor, placementsFromSlots, planAnchorSlots } from './cutoutPlacement';
import { cross, dot, norm, rotate, type V3 } from '@/geometry/math3';
import { chainOf } from '@/geometry/lineage';
import type { Rng } from '@/core/rng';
import type { ParentSample } from './frames';
import {
  AnchorResolver,
  crossedSide,
  effectiveSize,
  isMirrored,
  orientLeaf,
  parentBasis,
  resolveSide,
  weldToSkin,
  type AnchorStyle,
} from '@/geometry/leafPlacement';
import { readLeafPlacement, type LeafPlacementConfig } from './leafPlacementParams';
import { resolveLeafLighting } from './leafLightingParams';
import { leafDeformFor, materialHasHeight, materialHeightSampler, readLeafDeform, readLeafResolution, type LeafDeformConfig, type LeafResolution } from './leafDeformParams';
import { chooseMeshLod, filledMeshLods, sizeIncreaseFactor } from '@/geometry/leafLod';
import { resolveUvAreaRect } from '@/materials/materialSource';
import {
  atlasRect,
  collectPlacements,
  curveFactor,
  emptyFoliage,
  foliageOutput,
  isActive,
  leafAo,
  leafTint,
  LOD_FOLIAGE_DETAIL,
  outwardAt,
  parentOf,
  parentWind,
  pickLeafType,
  postTransform,
  varied,
  type Placement,
} from './foliageCommon';

const UP: V3 = [0, 0, 1];
const SUN: V3 = [0.4, -0.3, 0.85];

const OUTLINES: Record<string, LeafOutline> = { rect: 'rect', oval: 'oval', pointed: 'pointed', heart: 'heart' };

/** Number of length segments of one blade for the chosen card type / geometry, scaled by LOD. */
export function bladeSegments(p: NodeParams, lod: number): { len: number; wid: number; outline: LeafOutline } {
  const detail = LOD_FOLIAGE_DETAIL(lod);
  const mesh = getString(p, 'geometry', 'card') === 'mesh';
  const type = getString(p, 'cardType', 'curved');
  const full = type === 'quad' ? 1 : type === 'curved' ? 3 : Math.round(getNumber(p, 'leafSegments', 4));
  const lenSeg = Math.max(mesh ? 2 : 1, Math.round((mesh ? Math.max(full, 3) : full) * detail));
  const widSeg = mesh ? Math.max(1, Math.round(getNumber(p, 'leafWidthSegments', 1) * detail)) : 1;
  return { len: type === 'quad' && !mesh ? 1 : lenSeg, wid: widSeg, outline: mesh ? (OUTLINES[getString(p, 'outline', 'rect')] ?? 'rect') : 'rect' };
}

/** Desired blade-face direction for the Orientation > Facing options. */
function faceDirection(mode: string, axis: V3, tangent: V3, out: V3, blend: number): V3 {
  const parentFace = norm(cross(tangent, axis), out);
  switch (mode) {
    case 'up':
      return norm([parentFace[0] + (UP[0] - parentFace[0]) * Math.max(blend, 0.6), parentFace[1] + (UP[1] - parentFace[1]) * Math.max(blend, 0.6), parentFace[2] + (UP[2] - parentFace[2]) * Math.max(blend, 0.6)]);
    case 'outward':
      return norm([parentFace[0] + (out[0] - parentFace[0]) * blend, parentFace[1] + (out[1] - parentFace[1]) * blend, parentFace[2] + (out[2] - parentFace[2]) * blend]);
    case 'sun': {
      const s = norm(SUN);
      return norm([parentFace[0] + (s[0] - parentFace[0]) * blend, parentFace[1] + (s[1] - parentFace[1]) * blend, parentFace[2] + (s[2] - parentFace[2]) * blend]);
    }
    default:
      return parentFace;
  }
}

/** Params of versions before 2: the Skin > Size "Scale" became the Leaves > Size parameter. */
export function migrateLeafParams(params: NodeParams, fromVersion: number): NodeParams {
  if (fromVersion >= 2) return params;
  const old = params.scale;
  if (old && !params.leafSize) {
    params.leafSize = old;
    delete params.scale;
  }
  return params;
}

interface LeafCardsResult {
  cards: LeafCard[];
  tip: V3;
  origin: V3;
}

/** Per-evaluation helpers shared by all leaves of the node. */
interface LeafEnv {
  cfg: LeafPlacementConfig;
  anchors: AnchorResolver;
  parentSide: Float32Array | undefined;
  deform: LeafDeformConfig;
  resolution: LeafResolution;
  /** Height-map samplers by material id (null = none / not decoded). */
  heights: Map<string, ((u: number, v: number) => number) | null>;
  /** One-time warnings already shown. */
  warned: Set<string>;
  /** Lighting settings when they change any normal, else null. */
  lighting: LeafLightingSettings | null;
}

/** Build the card(s) of one leaf; null when its weld failed and failed welds are dropped. */
function leafCards(ctx: NodeContext, parent: Skeleton, pl: Placement, k: number, n: number, p: NodeParams, env: LeafEnv): LeafCardsResult | null {
  const { sample: s } = pl;
  const { cfg } = env;
  const rng = pl.rng.fork(`leaf:${k}`);
  const u = s.u;
  const post = postTransform(p);
  const az = pl.placement.azimuthRad + (n > 1 ? (k * Math.PI * 2) / n : 0) + deg2rad(varied(rng, p, 'yaw', 0));
  const basis = parentBasis(s.tangent, s.normal, s.binormal, cfg.parentStyle);
  const out = outwardAt({ ...s, normal: basis.normal, binormal: basis.binormal }, az);
  const spread = n > 1 ? deg2rad(getNumber(p, 'clusterAngle', 25)) * (rng.next() * 2 - 1) : 0;
  const angle = deg2rad(varied(rng, p, 'angleToParent', 55) * curveFactor(p, 'angleToParent', u) + varied(rng, p, 'pitch', 0)) + spread;
  const T = s.tangent;
  let axis = norm([T[0] * Math.cos(angle) + out[0] * Math.sin(angle), T[1] * Math.cos(angle) + out[1] * Math.sin(angle), T[2] * Math.cos(angle) + out[2] * Math.sin(angle)]);
  const droop = getNumber(p, 'droopAmount', 0.2) * curveFactor(p, 'droopAmount', u);
  const stiff = getNumber(p, 'droopStiffness', 0.5);
  axis = norm([axis[0], axis[1], axis[2] - droop * (1 - stiff) * 0.9]);
  const ownFacing = (a: V3): V3 => faceDirection(getString(p, 'facing', 'parent'), a, T, out, getNumber(p, 'facingBlend', 0.5) * curveFactor(p, 'facingBlend', u));
  let facing: V3;
  let anchorScale = 1;
  if (pl.anchor) {
    // Planted on a parent anchor: base = anchor position, growth axis = anchor direction (blended by Align).
    const o = orientAtAnchor(pl.anchor, p, rng.fork('anc'), getNumber(p, 'anchorAlign', 1) < 1 ? axis : null);
    axis = o.axis;
    anchorScale = o.scale;
    facing = o.useFacing ? o.facing : ownFacing(axis);
  } else facing = ownFacing(axis);
  const roll = deg2rad(varied(rng, p, 'rollAngle', 0)) + post.roll;
  const blade = bladeBasis(axis, facing, roll);

  // Weld: base on the skin of the parent tube (anchored cutout placements keep their anchor position).
  let basePos: V3 = s.position;
  if (cfg.weld && !pl.anchor) {
    const welded = weldToSkin(s.position, T, out, s.radius);
    if (welded) basePos = welded;
    else if (!cfg.keepFailedWelds) return null;
  }
  const attach: V3 = [basePos[0] + post.offset[0], basePos[1] + post.offset[1], basePos[2] + post.offset[2]];
  const oriented = orientLeaf(
    blade,
    { position: attach, parentTangent: T, anchor: (style: AnchorStyle) => env.anchors.computeAnchorPoint(pl.branch.id, style) },
    cfg.local,
    cfg.sensitivity,
    cfg.final,
  );
  const ax = oriented.axis;
  const side = oriented.side;

  const sizeCurve = varied(rng, p, 'leafSize', 1) * curveFactor(p, 'leafSize', u);
  const lodGrow = sizeIncreaseFactor(env.resolution.sizeIncrease, ctx.lod);
  const fixedScale = post.scale * anchorScale * lodGrow;
  const sizeTerm = cfg.useActualSize ? 1 : effectiveSize(sizeCurve, cfg.sizeParent, pl.branch.length);
  const scale = sizeTerm * post.scale * anchorScale * lodGrow;
  let width = varied(rng, p, 'width', 0.3) * curveFactor(p, 'width', u) * scale;
  let height = varied(rng, p, 'height', 0.5) * curveFactor(p, 'height', u) * scale;
  const seg = bladeSegments(p, ctx.lod);
  const n0 = cross(side, ax);
  const bendSign = dot(n0, [0, 0, -1]) >= 0 ? 1 : -1;
  const bend = bendSign * ((varied(rng, p, 'leafBend', 0.35) * curveFactor(p, 'leafBend', u)) * Math.PI * 0.7 + droop * Math.PI * 0.45);
  const fold = getNumber(p, 'leafFold', 0) * curveFactor(p, 'leafFold', u) * 0.8;
  const curl = getNumber(p, 'leafCurl', 0) * curveFactor(p, 'leafCurl', u);
  const twist = varied(rng, p, 'leafTwist', 0) * (Math.PI / 2);
  const origin = attach;
  const type = pickLeafType(rng, p, 'leaf');
  const cutout = type.meshAsset;
  if (cfg.useActualSize && cutout) {
    // Authored real size of the mesh (the Meshes-panel scale is applied by the cutout builder).
    width = (cutout.boundsMeters?.[0] || 1) * fixedScale;
    height = (cutout.boundsMeters?.[1] || 1) * fixedScale;
  }
  // Resolution: mesh version for the active LOD (curve + offset, needs two filled slots for the offset).
  let meshLod: LodLevel | number = ctx.lod;
  if (cutout) {
    const choice = chooseMeshLod({ lod: ctx.lod, curve: env.resolution.meshLod, offset: env.resolution.meshLodOffset, filled: filledMeshLods(cutout) });
    meshLod = choice.level;
    if (choice.offsetIgnored && !env.warned.has('lodOffset')) {
      env.warned.add('lodOffset');
      ctx.logger.warn('Mesh LOD offset is ignored: the mesh needs at least two filled LOD slots.');
    }
  }
  // Deformation: Height uses the Height map of the leaf's material.
  let heightSample: ((u: number, v: number) => number) | null = null;
  if (env.deform.hasHeight) {
    if (!env.heights.has(type.materialId)) env.heights.set(type.materialId, materialHeightSampler(type.materialId));
    heightSample = env.heights.get(type.materialId) ?? null;
    if (!heightSample && !env.warned.has(`height:${type.materialId}`)) {
      env.warned.add(`height:${type.materialId}`);
      ctx.logger.warn(materialHasHeight(type.materialId) ? 'Deformation > Height: the material Height image is not loaded yet.' : 'Deformation > Height needs a Height texture in the leaf material.');
    }
  }
  const deform = leafDeformFor(env.deform, p, rng, u, height, heightSample, ctx.lod);
  const light = leafLight(env, pl.branch.id, s, attach, rng);
  const sideSign = resolveSide(pl.placement.side, env.parentSide ? (env.parentSide[s.parentPoint] ?? 0) : 0, () => pl.rng.fork(`side:${k}`).next());
  const mirror = isMirrored(cfg.flip, cfg.initial, sideSign, pl.rng.fork(`flip:${k}`).next());
  const uvArea = resolveUvAreaRect(type.materialId, 'leaf', rng);
  const color = leafTint(rng, p);
  const ao = leafAo(p, u, rng);
  const atlas = uvArea ?? atlasRect(p, rng, pl.index * 7 + k);
  const wind0 = parentWind(parent, s.parentPoint, pl.index * 13 + k);
  const wind = pl.anchor ? anchorWind(wind0, pl.anchor.frame.axisT) : wind0;
  const count = Math.max(1, Math.round(getNumber(p, 'cardCount', 1)));
  const cards: LeafCard[] = [];
  for (let c = 0; c < count; c++) {
    const cr = (c * Math.PI) / count;
    const sd = c === 0 ? side : rotate(side, ax, cr);
    const sides = cfg.cross ? [sd, crossedSide(sd, ax)] : [sd];
    for (const cs of sides) {
      cards.push({
        origin,
        axis: ax,
        side: cs,
        length: height,
        width,
        bend,
        fold,
        curl,
        twist,
        segLength: seg.len,
        segWidth: seg.wid,
        outline: seg.outline,
        color,
        ao,
        atlas,
        materialId: type.materialId,
        pivot: origin,
        wind,
        cutout,
        lod: meshLod,
        ...(deform ? { deform } : {}),
        ...(mirror ? { mirror: true } : {}),
        ...(light ? { light } : {}),
      });
    }
  }
  const tip: V3 = [origin[0] + ax[0] * height, origin[1] + ax[1] * height, origin[2] + ax[2] * height];
  return { cards, tip, origin };
}

/** Lighting inputs of one leaf: parent puffiness anchor / axis and the Up / Right / Out jitter (own random sub-stream). */
function leafLight(env: LeafEnv, branchId: number, s: ParentSample, attach: V3, rng: Rng): CardLight | undefined {
  const lighting = env.lighting;
  if (!lighting) return undefined;
  const lr = rng.fork('light');
  const anchor = resolveLightAnchor(lighting, (style) => env.anchors.computeAnchorPoint(branchId, style), attach);
  const surface = surfaceDirection(lighting.parentAnchor, { normal: s.normal, binormal: s.binormal, tangent: s.tangent });
  return { anchor, surface, adjust: resolveAdjust(lighting, () => lr.next()) };
}

/** Placements of the node: one per selected parent anchor or the normal distribution along the parents. */
function leafPlacements(ctx: NodeContext, inputs: NodeInputs, parent: Skeleton, p: NodeParams): Placement[] {
  const slots = planAnchorSlots(ctx, inputs, parent, p, getNumber(p, 'number', 1));
  return slots ? placementsFromSlots(slots, 60_000) : collectPlacements(ctx, parent, p);
}

export function evaluateLeaf(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  return evaluateLeafNode(ctx, inputs, p, false);
}

/**
 * Batched leaf: the Leaf evaluator at the highest detail (it does not follow the viewport / dynamic LOD), without
 * Unify and World up, merged into one slot per material with an index table that maps every triangle to its leaf.
 */
export function evaluateBatchedLeaf(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  return evaluateLeafNode({ ...ctx, lod: 0 }, inputs, p, true);
}

function evaluateLeafNode(ctx: NodeContext, inputs: NodeInputs, p: NodeParams, batched: boolean): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const placements = leafPlacements(ctx, inputs, parent, p);
  const cfg = readLeafPlacement(p);
  const pv = inputs.parent?.[0];
  const lineage: Lineage | undefined = pv && pv.kind === 'Structure' ? pv.value.lineage : undefined;
  const lightingSettings = resolveLeafLighting(p, pv && pv.kind === 'Structure' ? pv.value.lighting : undefined, batched);
  const lightingAllow = batched ? { unify: false, worldUp: false } : undefined;
  const branchIndex = new Map<number, number>();
  parent.branches.forEach((b, i) => branchIndex.set(b.id, i));
  const env: LeafEnv = {
    cfg,
    anchors: new AnchorResolver((branchId) => chainOf(lineage, parent, branchIndex.get(branchId) ?? -1)),
    parentSide: parent.attributes.get('side'),
    deform: readLeafDeform(p),
    resolution: readLeafResolution(p),
    heights: new Map(),
    warned: new Set(),
    lighting: isLightingActive(lightingSettings) ? lightingSettings : null,
  };
  const perNode = Math.max(1, Math.round(getNumber(p, 'leavesPerNode', 1)));
  const cards: LeafCard[] = [];
  const sb = new SkeletonBuilder();
  const att = new AttachmentBuilder(ctx.nodeId);
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  let outBranch = 0;
  for (const pl of placements) {
    const copies = pl.anchor ? 1 : perNode;
    for (let k = 0; k < copies; k++) {
      const r = leafCards(ctx, parent, pl, k, copies, p, env);
      if (!r) continue;
      const key = pl.anchor ? pl.anchor.key : instanceKey(ctx.nodeId, pl.branch.id, pl.placement.slotIndex, k);
      const source = { key, branch: outBranch };
      for (const c of r.cards) c.source = source;
      cards.push(...r.cards);
      sb.beginBranch(pl.branch.id, pl.sample.parentPoint, gen);
      sb.addPoint(r.origin[0], r.origin[1], r.origin[2], 0.001);
      sb.addPoint(r.tip[0], r.tip[1], r.tip[2], 0.001);
      sb.endBranch();
      const ca = r.cards[0] ? cardAttachments(r.cards[0]) : null;
      if (ca) {
        att.beginInstance(key, outBranch, ca.base);
        for (const a of ca.anchors) att.addFrame(a.frame, a.scale, a.anchor.id, a.anchor.index, a.anchor.axisT, a.anchor.tags);
      }
      outBranch += 1;
    }
  }
  const sk = sb.build();
  const spans: LeafSpan[] = [];
  let mesh = buildLeafMesh(cards, {
    defaultMaterial: 'leaf',
    fixWinding: cfg.fixWinding,
    ...(env.lighting ? { lighting: env.lighting } : {}),
    ...(lightingAllow ? { lightingAllow } : {}),
    ...(batched ? { spans } : {}),
  });
  if (batched) mesh = mergeByMaterial(mesh, spans);
  return foliageOutput(sk, parent, mesh, sk.branches.length, ctx.seed, att.build());
}
