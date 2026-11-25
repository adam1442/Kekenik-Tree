import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getNumber, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { buildDecalMesh, decalCells } from '@/generators/decal';
import { AttachmentBuilder } from '@/geometry/attachments';
import { MeshAccumulator, newVertex, type VertexAttrs } from '@/geometry/meshAccumulator';
import type { V3 } from '@/geometry/math3';
import { instanceKey } from '@/instances/keys';
import { createSeasonSampler } from '@/seasons';
import { lodRadialFactor, readGeneratorLod } from './dynamicLodParams';
import { collectPlacements, curveFactor, emptyFoliage, foliageOutput, isActive, itemVertexColor, parentOf, pickLeafType, readVertexColorOptions, varied } from './foliageCommon';
import { knotFrame } from './knot';
import { addShapeAnchors, emitPiece, heightChainOf, heightSampler, MAX_DECALS, pickedShape, SlotBuckets, surfaceTint, windAtY, windProfile } from './surfaceDetail';

const TAU = Math.PI * 2;

/**
 * Decal generator (`generator.decal`): a flat grid projected onto the skin of every parent branch at the Generation tab's
 * placements. Vertices sit `Offset` above the real skin, displaced by `Height` x the material height map (faded to 0 at the
 * border); wind is the parent's at every vertex (the patch is a part of its skin). One mesh with a slot per material.
 * A Material row with a cutout mesh gives the patch the cutout's outline (refined, then projected like the grid).
 */
export function evaluateDecal(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p, ctx.lod) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const placements = collectPlacements(ctx, parent, p, MAX_DECALS);
  if (placements.length === 0) return emptyFoliage(parent, ctx.seed);

  const pv = inputs.parent?.[0];
  const parentMaterial = (pv && pv.kind === 'Structure' ? pv.value.materialId : undefined) || 'bark';
  const seasons = createSeasonSampler(p);
  const genLod = readGeneratorLod(p);
  const cull = getNumber(p, 'lodCull', 0.5) * (clamp(ctx.lod, 0, 3) / 3);
  const baseCells = Math.round(getNumber(p, 'decalResolution', 12));
  const cells = decalCells(baseCells, ctx.lod, lodRadialFactor(genLod, 1), Math.round(getNumber(p, 'decalLodOffset', 0)));
  const offset = getNumber(p, 'decalOffset', 0.002);
  const fade = clamp(getNumber(p, 'decalFade', 0.25), 0, 0.5);
  const randomRot = clamp(getNumber(p, 'decalRandomRotation', 1), 0, 1);
  const sizeParent = Math.max(0, getNumber(p, 'decalSizeParent', 0)) / 100;
  const tint = surfaceTint(p);
  const vertexColor = readVertexColorOptions(p);

  const acc = new MeshAccumulator();
  const buckets = new SlotBuckets();
  const chains = new Map<string, ReturnType<typeof heightChainOf>>();
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
    const type = pickLeafType(rng.fork('type'), p, parentMaterial, seasons.value(rng, pl.sample.u));
    const materialId = type.materialId || parentMaterial;
    const r = rng.fork('shape');
    const frame = knotFrame(parent, pl.branch, pl);
    const length = Math.max(1e-3, varied(r, p, 'decalSize', 0.25) * curveFactor(p, 'decalSize', pl.sample.u) + sizeParent * frame.radius);
    const width = Math.max(1e-3, length * Math.max(0.05, varied(r, p, 'decalAspect', 1)));
    const rotation = deg2rad(varied(r, p, 'decalRotation', 0)) + randomRot * TAU * r.next();
    const height = varied(r, p, 'decalHeight', 0.03);
    let chain = chains.get(materialId);
    if (chain === undefined) {
      chain = heightChainOf(materialId);
      chains.set(materialId, chain);
    }
    const shape = pickedShape(type, clamp(ctx.lod + Math.round(getNumber(p, 'decalLodOffset', 0)), 0, 3), width, length, cells, cells);
    const mesh = buildDecalMesh({ frame, width, length, rotation, offset, height, ...(chain ? { heightAt: heightSampler(chain, cells) } : {}), cells, fade, ...(shape ? { shape } : {}) });

    // The decal is part of the parent's skin: wind of the parent along the patch (interpolated like the parent's rings).
    const half = (Math.abs(Math.cos(rotation)) * length + Math.abs(Math.sin(rotation)) * width) * 0.5 + Math.abs(offset);
    const wind = windProfile(parent, pl.sample.parentPoint, made * 13 + 3, pl.sample.position, frame.tangent, -half, half, Math.max(2, cells));
    const axis = pl.sample.position;
    const item = itemVertexColor({ options: vertexColor, parent, point: pl.sample.parentPoint, at: pl.sample.u }, made, ctx.seed);
    const base = emitPiece(acc, vx, mesh, { x: made % cellsAtlas, y: Math.floor(made / cellsAtlas), count: cellsAtlas }, (i, v) => {
      const y = mesh.along[i] as number;
      const w = windAtY(wind, y);
      const col = item.colorAt ? item.colorAt(tint, (y + half) / (2 * half)) : tint;
      v.r = col[0];
      v.g = col[1];
      v.b = col[2];
      v.bt = item.tint;
      v.ao = 1;
      v.pvx = axis[0] + frame.tangent[0] * y;
      v.pvy = axis[1] + frame.tangent[1] * y;
      v.pvz = axis[2] + frame.tangent[2] * y;
      v.w0 = w[0];
      v.w1 = w[1];
      v.w2 = w[2];
      v.w3 = w[3];
      v.w4 = w[4];
    });
    buckets.push(materialId, base, mesh.indices);

    const c = mesh.centre;
    const cp: V3 = [mesh.positions[c * 3] as number, mesh.positions[c * 3 + 1] as number, mesh.positions[c * 3 + 2] as number];
    const cn: V3 = [mesh.normals[c * 3] as number, mesh.normals[c * 3 + 1] as number, mesh.normals[c * 3 + 2] as number];
    sb.beginBranch(pl.branch.id, pl.sample.parentPoint, generation);
    sb.addPoint(cp[0], cp[1], cp[2], 0.001);
    sb.addPoint(cp[0] + cn[0] * 0.01, cp[1] + cn[1] * 0.01, cp[2] + cn[2] * 0.01, 0.001);
    sb.endBranch();
    att.beginInstance(instanceKey(ctx.nodeId, pl.branch.id, pl.placement.slotIndex, 0), pl.branch.id, { position: cp, direction: [frame.tangent[0], frame.tangent[1], frame.tangent[2]], up: cn });
    if (shape) addShapeAnchors(att, shape, mesh);
    made++;
  }
  if (made === 0) return emptyFoliage(parent, ctx.seed);
  buckets.flush(acc);
  return foliageOutput(sb.build(), parent, acc.build('bark', true), made, ctx.seed, att.build());
}
