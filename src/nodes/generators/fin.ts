import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getNumber, getString, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { createSimplex } from '@/core/noise';
import { Rng } from '@/core/rng';
import { buildFinMesh, finSegments, type FinStyle } from '@/generators/fin';
import { AttachmentBuilder } from '@/geometry/attachments';
import { MeshAccumulator, newVertex, type VertexAttrs } from '@/geometry/meshAccumulator';
import type { V3 } from '@/geometry/math3';
import { instanceKey } from '@/instances/keys';
import { createSeasonSampler } from '@/seasons';
import { lodLengthFactor, lodRadialFactor, readGeneratorLod } from './dynamicLodParams';
import { collectPlacements, curveFactor, emptyFoliage, foliageOutput, isActive, itemVertexColor, parentOf, pickLeafType, readVertexColorOptions, varied } from './foliageCommon';
import { knotFrame } from './knot';
import { addShapeAnchors, emitPiece, MAX_FINS, pickedShape, SlotBuckets, surfaceTint, windAtY, windProfile } from './surfaceDetail';

const styleOf = (p: NodeParams): FinStyle => {
  const v = getString(p, 'finStyle', 'perpendicular');
  return v === 'along-spine' ? 'along-spine' : v === 'up' ? 'up' : 'perpendicular';
};

/**
 * Fin generator (`generator.fin`): thin flaps on the skin of every parent branch (fungus, moss, lichen flaps, bark curls).
 * The base ring lies on the skin (zero gap) and carries the parent's wind exactly; the leaf-level wind weight grows towards
 * the tip by `Ripple scale`, so the flap moves without tearing from the bark.
 * A Material row with a cutout mesh gives the flap the cutout's outline (refined, then mapped like the grid).
 */
export function evaluateFin(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p, ctx.lod) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const placements = collectPlacements(ctx, parent, p, MAX_FINS);
  if (placements.length === 0) return emptyFoliage(parent, ctx.seed);

  const seasons = createSeasonSampler(p);
  const genLod = readGeneratorLod(p);
  const cull = getNumber(p, 'lodCull', 0.5) * (clamp(ctx.lod, 0, 3) / 3);
  const keep = 1 - clamp(getNumber(p, 'lodSegments', 0.5), 0, 0.9) * 0.4;
  const segs = finSegments(
    Math.round(getNumber(p, 'finSegmentsWidth', 4) * lodRadialFactor(genLod, ctx.lod)),
    Math.round(getNumber(p, 'finSegmentsLength', 6) * lodLengthFactor(genLod, ctx.lod)),
    ctx.lod,
    keep,
  );
  const noiseSeed = Math.round(getNumber(p, 'finVertexSeed', 0));
  const noise = createSimplex(new Rng(ctx.seed).fork(`fin-noise:${noiseSeed}`).seed);
  const noiseAmount = Math.max(0, getNumber(p, 'finVertexAmount', 0));
  const noiseScale = Math.max(0.1, getNumber(p, 'finVertexScale', 3));
  const scale: [number, number, number] = [Math.max(0.01, getNumber(p, 'finScaleX', 1)), Math.max(0.01, getNumber(p, 'finScaleY', 1)), Math.max(0, getNumber(p, 'finScaleZ', 1))];
  const flipMode = getString(p, 'finFlip', 'random');
  const style = styleOf(p);
  const sizeParent = Math.max(0, getNumber(p, 'finSizeParent', 0)) / 100;
  const puffiness = clamp(getNumber(p, 'finPuffiness', 0.3), 0, 1);
  const matchSurface = clamp(getNumber(p, 'finMatchSurface', 0.5), 0, 1);
  const ripple = Math.max(0, getNumber(p, 'finRipple', 1));
  const tint = surfaceTint(p);
  const vertexColor = readVertexColorOptions(p);

  const acc = new MeshAccumulator();
  const buckets = new SlotBuckets();
  const sb = new SkeletonBuilder();
  const att = new AttachmentBuilder(ctx.nodeId);
  const generation = (parent.branches[0]?.generation ?? -1) + 1;
  const cellsAtlas = Math.max(1, Math.ceil(Math.sqrt(placements.length)));
  const vx: VertexAttrs = newVertex();
  let made = 0;

  for (const pl of placements) {
    if (made % 16 === 0) ctx.cancel.throwIfCancelled();
    const rng = pl.rng;
    if (rng.fork('lod').next() < cull) continue;
    const type = pickLeafType(rng.fork('type'), p, 'leaf', seasons.value(rng, pl.sample.u));
    const materialId = type.materialId || 'leaf';
    const r = rng.fork('shape');
    const frame = knotFrame(parent, pl.branch, pl);
    const length = Math.max(1e-3, varied(r, p, 'finSize', 0.25) * curveFactor(p, 'finSize', pl.sample.u) + sizeParent * frame.radius);
    const width = Math.max(1e-3, varied(r, p, 'finWidth', 0.2) * curveFactor(p, 'finWidth', pl.sample.u));
    const startAngle = deg2rad(varied(r, p, 'finStartAngle', 60));
    const roll = deg2rad(varied(r, p, 'finRoll', 0));
    const fold = deg2rad(varied(r, p, 'finFold', 0));
    const curl = deg2rad(varied(r, p, 'finCurl', 0));
    const flipDraw = r.next();
    const flip = flipMode === 'always' || (flipMode === 'random' && flipDraw < 0.5);
    const nr = rng.fork('noise');
    const shape = pickedShape(type, ctx.lod, width, length, segs.width, segs.length);
    const mesh = buildFinMesh({
      frame,
      width,
      length,
      style,
      startAngle,
      roll,
      flip,
      fold,
      curl,
      noise: { amount: noiseAmount, scale: noiseScale, source: noise, offset: [nr.range(-50, 50), nr.range(-50, 50)] },
      scale,
      puffiness,
      matchSurface,
      segmentsWidth: segs.width,
      segmentsLength: segs.length,
      ...(shape ? { shape } : {}),
    });

    // Base of every vertex: exactly the parent's wind at the skin point (interpolated along the parent like its own rings).
    const axis = pl.sample.position;
    const span = Math.max(width, 1e-3) * scale[0];
    const profile = windProfile(parent, pl.sample.parentPoint, made * 13 + 3, axis, frame.tangent, -span, span, Math.max(2, segs.width));
    const item = itemVertexColor({ options: vertexColor, parent, point: pl.sample.parentPoint, at: pl.sample.u }, made, ctx.seed);
    const base = emitPiece(acc, vx, mesh, { x: made % cellsAtlas, y: Math.floor(made / cellsAtlas), count: cellsAtlas }, (i, v) => {
      const t = mesh.t[i] as number;
      const along = mesh.baseAlong[i] as number;
      const w = windAtY(profile, along);
      const col = item.colorAt ? item.colorAt(tint, t) : tint;
      v.r = col[0];
      v.g = col[1];
      v.b = col[2];
      v.bt = item.tint;
      v.ao = 0.6 + 0.4 * t;
      v.pvx = axis[0] + frame.tangent[0] * along;
      v.pvy = axis[1] + frame.tangent[1] * along;
      v.pvz = axis[2] + frame.tangent[2] * along;
      v.w0 = w[0];
      v.w1 = w[1];
      // Leaf-level weight: the parent's at the base ring, growing to the free tip (never decreasing, never above 1).
      v.w2 = Math.min(1, w[2] + (1 - w[2]) * clamp(ripple * 0.8, 0, 1) * Math.pow(t, 1.5));
      v.w3 = w[3];
      v.w4 = w[4];
    });
    buckets.push(materialId, base, mesh.indices);

    const bp: V3 = [mesh.baseSkin[mesh.mid * 3] as number, mesh.baseSkin[mesh.mid * 3 + 1] as number, mesh.baseSkin[mesh.mid * 3 + 2] as number];
    const tp: V3 = [mesh.positions[mesh.tip * 3] as number, mesh.positions[mesh.tip * 3 + 1] as number, mesh.positions[mesh.tip * 3 + 2] as number];
    sb.beginBranch(pl.branch.id, pl.sample.parentPoint, generation);
    sb.addPoint(bp[0], bp[1], bp[2], 0.001);
    sb.addPoint(tp[0], tp[1], tp[2], 0.001);
    sb.endBranch();
    const dir: V3 = [tp[0] - bp[0], tp[1] - bp[1], tp[2] - bp[2]];
    att.beginInstance(instanceKey(ctx.nodeId, pl.branch.id, pl.placement.slotIndex, 0), pl.branch.id, { position: bp, direction: dir, up: [mesh.normals[mesh.mid * 3] as number, mesh.normals[mesh.mid * 3 + 1] as number, mesh.normals[mesh.mid * 3 + 2] as number] });
    if (shape) addShapeAnchors(att, shape, mesh);
    made++;
  }
  if (made === 0) return emptyFoliage(parent, ctx.seed);
  buckets.flush(acc);
  return foliageOutput(sb.build(), parent, acc.build('leaf', true), made, ctx.seed, att.build());
}
