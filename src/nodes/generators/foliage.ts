import { getNumber, getString, type NodeParams } from '@/contracts/params';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import { AttachmentBuilder } from '@/geometry/attachments';
import { bladeBasis, buildLeafMesh, cardAttachments, type LeafCard, type LeafOutline } from '@/geometry/leafMesher';
import { instanceKey } from '@/instances/keys';
import { anchorWind, orientAtAnchor, placementsFromSlots, planAnchorSlots } from './cutoutPlacement';
import { cross, dot, norm, rotate, type V3 } from '@/geometry/math3';
import { resolveCutoutForLeaf, resolveUvAreaRect } from '@/materials/materialSource';
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

/** Build the card(s) of one leaf. */
function leafCards(ctx: NodeContext, parent: Skeleton, pl: Placement, k: number, n: number, p: NodeParams): { cards: LeafCard[]; tip: V3; origin: V3 } {
  const { sample: s } = pl;
  const rng = pl.rng.fork(`leaf:${k}`);
  const u = s.u;
  const post = postTransform(p);
  const az = pl.placement.azimuthRad + (n > 1 ? (k * Math.PI * 2) / n : 0) + deg2rad(varied(rng, p, 'yaw', 0));
  const out = outwardAt(s, az);
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
  const { axis: ax, side } = bladeBasis(axis, facing, roll);

  const scale = varied(rng, p, 'scale', 1) * curveFactor(p, 'scale', u) * post.scale * anchorScale * (1 + 0.12 * Math.min(ctx.lod, 3));
  const width = varied(rng, p, 'width', 0.3) * curveFactor(p, 'width', u) * scale;
  const height = varied(rng, p, 'height', 0.5) * curveFactor(p, 'height', u) * scale;
  const seg = bladeSegments(p, ctx.lod);
  const n0 = cross(side, ax);
  const bendSign = dot(n0, [0, 0, -1]) >= 0 ? 1 : -1;
  const bend = bendSign * ((varied(rng, p, 'leafBend', 0.35) * curveFactor(p, 'leafBend', u)) * Math.PI * 0.7 + droop * Math.PI * 0.45);
  const fold = getNumber(p, 'leafFold', 0) * curveFactor(p, 'leafFold', u) * 0.8;
  const curl = getNumber(p, 'leafCurl', 0) * curveFactor(p, 'leafCurl', u);
  const twist = varied(rng, p, 'leafTwist', 0) * (Math.PI / 2);
  const origin: V3 = [s.position[0] + post.offset[0], s.position[1] + post.offset[1], s.position[2] + post.offset[2]];
  const type = pickLeafType(rng, p, 'leaf');
  const cutout = resolveCutoutForLeaf(type.material, type.mesh, rng);
  const uvArea = resolveUvAreaRect(type.material, 'leaf', rng);
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
    cards.push({
      origin,
      axis: ax,
      side: sd,
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
      materialId: type.material,
      pivot: origin,
      wind,
      cutout,
      lod: ctx.lod,
    });
  }
  const tip: V3 = [origin[0] + ax[0] * height, origin[1] + ax[1] * height, origin[2] + ax[2] * height];
  return { cards, tip, origin };
}

/** Placements of the node: one per selected parent anchor or the normal distribution along the parents. */
function leafPlacements(ctx: NodeContext, inputs: NodeInputs, parent: Skeleton, p: NodeParams): Placement[] {
  const slots = planAnchorSlots(ctx, inputs, parent, p, getNumber(p, 'number', 1));
  return slots ? placementsFromSlots(slots, 60_000) : collectPlacements(ctx, parent, p);
}

export function evaluateLeaf(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const placements = leafPlacements(ctx, inputs, parent, p);
  const perNode = Math.max(1, Math.round(getNumber(p, 'leavesPerNode', 1)));
  const cards: LeafCard[] = [];
  const sb = new SkeletonBuilder();
  const att = new AttachmentBuilder(ctx.nodeId);
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  let outBranch = 0;
  for (const pl of placements) {
    const copies = pl.anchor ? 1 : perNode;
    for (let k = 0; k < copies; k++) {
      const r = leafCards(ctx, parent, pl, k, copies, p);
      cards.push(...r.cards);
      sb.beginBranch(pl.branch.id, pl.sample.parentPoint, gen);
      sb.addPoint(r.origin[0], r.origin[1], r.origin[2], 0.001);
      sb.addPoint(r.tip[0], r.tip[1], r.tip[2], 0.001);
      sb.endBranch();
      const ca = r.cards[0] ? cardAttachments(r.cards[0]) : null;
      if (ca) {
        const key = pl.anchor ? pl.anchor.key : instanceKey(ctx.nodeId, pl.branch.id, pl.placement.slotIndex, k);
        att.beginInstance(key, outBranch, ca.base);
        for (const a of ca.anchors) att.addFrame(a.frame, a.scale, a.anchor.id, a.anchor.index, a.anchor.axisT, a.anchor.tags);
      }
      outBranch += 1;
    }
  }
  const sk = sb.build();
  return foliageOutput(sk, parent, buildLeafMesh(cards, { defaultMaterial: 'leaf' }), sk.branches.length, ctx.seed, att.build());
}
