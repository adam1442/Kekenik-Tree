import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import type { NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Branch, type Skeleton } from '@/contracts/skeleton';
import { createSimplex } from '@/core/noise';
import { Rng } from '@/core/rng';
import {
  buildKnotMesh,
  knotSegments,
  knotSurvivesLod,
  SECTION_CORE,
  SECTION_INNER,
  SECTION_OUTER,
  type KnotFrame,
  type ParentUv,
} from '@/generators/knot';
import { choosePatches, MATERIAL_INHERITED, UV_TILES_ATTR, UV_TWIST_ATTR, UV_UOFFSET_ATTR, UV_V_ATTR, type PatchRow } from '@/generators/uv';
import { sagScale } from '@/generators/weld';
import { MeshAccumulator, newVertex, type VertexAttrs } from '@/geometry/meshAccumulator';
import { createSeasonSampler } from '@/seasons';
import { resolveMaterialRef } from '@/materials/materialSource';
import { barkRingColor } from './common';
import { emptyFoliage, foliageOutput, isActive, collectPlacements, parentOf, parentWind, type Placement } from './foliageCommon';
import { readKnotConfig, rectOrNull, sampleKnotShape, type KnotConfig } from './knotConfig';
import { libraryUvAreas } from './uvConfig';
import type { UvRect } from '@/generators/uv';

/** Upper bound of knots per node (each is a few hundred triangles). */
export const MAX_KNOTS = 5000;

/** Bark tint of the vertex colour (the same default the tube mesher starts from). */
const BARK_TINT: readonly number[] = [0.36, 0.26, 0.18, 1];
/** The Core shows lighter, freshly cut wood. */
const CORE_BRIGHTNESS = 1.6;

/** Growable list of triangle indices of one material slot. */
export class IndexBucket {
  data = new Uint32Array(1024);
  length = 0;
  push(i: number): void {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = i;
  }
}

/** Surface frame of the parent at a placement: axis point, ring frame, radius (sag corrected) and taper. */
export function knotFrame(parent: Skeleton, branch: Branch, pl: Placement): KnotFrame {
  const s = pl.sample;
  const last = branch.start + branch.count - 1;
  const point = Math.min(last, Math.max(branch.start, s.parentPoint));
  const i0 = Math.max(branch.start, point - 1);
  const i1 = Math.min(last, point + 1);
  const dist = Math.hypot(
    (parent.position[i1 * 3] as number) - (parent.position[i0 * 3] as number),
    (parent.position[i1 * 3 + 1] as number) - (parent.position[i0 * 3 + 1] as number),
    (parent.position[i1 * 3 + 2] as number) - (parent.position[i0 * 3 + 2] as number),
  );
  const slope = dist > 1e-9 ? ((parent.radius[i1] as number) - (parent.radius[i0] as number)) / dist : 0;
  const sides = parent.attributes.get('radialSides')?.[point] ?? 0;
  return {
    axisPoint: [s.position[0], s.position[1], s.position[2]],
    tangent: [s.tangent[0], s.tangent[1], s.tangent[2]],
    normal: [s.normal[0], s.normal[1], s.normal[2]],
    binormal: [s.binormal[0], s.binormal[1], s.binormal[2]],
    radius: Math.max(1e-4, s.radius * sagScale(sides)),
    slope,
    azimuth: pl.placement.azimuthRad,
  };
}

/**
 * UV mapping of the parent tube at a placement, read from the attributes the tube mesher stored on the skeleton (tiles around,
 * U offset, twist, V per point). Without them (a parent that was not meshed) the parent is assumed to tile once around and
 * once per metre along.
 */
export function parentUvAtPlacement(parent: Skeleton, branch: Branch, pl: Placement): ParentUv {
  const s = pl.sample;
  const last = branch.start + branch.count - 1;
  const point = Math.min(last, Math.max(branch.start, s.parentPoint));
  const attr = (id: string): Float32Array | undefined => parent.attributes.get(id);
  const tilesAttr = attr(UV_TILES_ATTR);
  const vAttr = attr(UV_V_ATTR);
  const tiles = tilesAttr && (tilesAttr[point] as number) > 0 ? (tilesAttr[point] as number) : 1;
  const uOffset = attr(UV_UOFFSET_ATTR)?.[point] ?? 0;
  const twist = attr(UV_TWIST_ATTR)?.[point] ?? 0;
  let hasV = false;
  if (vAttr) for (let k = branch.start; k <= last && !hasV; k++) hasV = (vAttr[k] as number) !== 0;
  const along = s.u * branch.length;
  if (!vAttr || !hasV || branch.count < 2) return { tiles, uOffset, twist, v0: along, vSlope: 1 };
  // Segment of the branch around the sample (t = normalised arc length per point).
  let k = branch.start;
  while (k < last - 1 && (parent.t[k + 1] as number) < s.u) k++;
  const t0 = parent.t[k] as number;
  const t1 = parent.t[k + 1] as number;
  const v0 = vAttr[k] as number;
  const v1 = vAttr[k + 1] as number;
  const span = Math.max(1e-9, (t1 - t0) * branch.length);
  const f = t1 - t0 > 1e-9 ? Math.min(1, Math.max(0, (s.u - t0) / (t1 - t0))) : 0;
  return { tiles, uOffset, twist, v0: v0 + (v1 - v0) * f, vSlope: (v1 - v0) / span };
}

interface MaterialChoice {
  material: string;
  rect: UvRect | null;
}

function chooseMaterial(rows: readonly PatchRow[], rng: Rng, parentMaterial: string, areas: ReturnType<typeof libraryUvAreas>, season?: number): MaterialChoice {
  const c = choosePatches('patch-one', rows, 1, rng, {
    resolveMaterial: (ref, r) => (ref === MATERIAL_INHERITED ? parentMaterial : ref ? resolveMaterialRef(ref, r, undefined, season) : '') || parentMaterial,
    areas,
  });
  return { material: c.materials[0] || parentMaterial, rect: rectOrNull(c.rects[0]) };
}

/**
 * Knot generator (`generator.knot`): three concentric sections (Outer, Inner, Core) welded onto the surface of every parent
 * branch at the placements of the Generation tab. Outer uses the parent material and the parent's UV; Inner and Core use the
 * Material lists. One mesh with a slot per material; every knot also leaves a short branch so children can attach to it.
 */
export function evaluateKnot(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p, ctx.lod) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const cfg: KnotConfig = readKnotConfig(p);
  const placements = collectPlacements(ctx, parent, p, MAX_KNOTS);
  if (placements.length === 0) return emptyFoliage(parent, ctx.seed);

  const pv = inputs.parent?.[0];
  const parentMaterial = (pv && pv.kind === 'Structure' ? pv.value.materialId : undefined) || 'bark';
  const areas = libraryUvAreas();
  const seasons = createSeasonSampler(p);
  const segments = knotSegments(cfg.segments, ctx.lod);
  const noise = createSimplex(new Rng(ctx.seed).fork(`knot-noise:${cfg.noiseSeed}`).seed);
  const branchOf = new Map<number, Branch>();
  for (const b of parent.branches) branchOf.set(b.id, b);

  const acc = new MeshAccumulator();
  const buckets = new Map<string, IndexBucket>();
  const bucket = (material: string): IndexBucket => {
    let b = buckets.get(material);
    if (!b) {
      b = new IndexBucket();
      buckets.set(material, b);
    }
    return b;
  };
  const cells = Math.max(1, Math.ceil(Math.sqrt(placements.length)));
  const sb = new SkeletonBuilder();
  const generation = (parent.branches[0]?.generation ?? -1) + 1;
  let made = 0;
  const vx: VertexAttrs = newVertex();

  for (const pl of placements) {
    if (made % 16 === 0) ctx.cancel.throwIfCancelled();
    const branch = branchOf.get(pl.branch.id) ?? pl.branch;
    const rng = pl.rng;
    if (!knotSurvivesLod(cfg.lodWeight, ctx.lod, rng.fork('lod').next())) continue;
    const transition = seasons.value(rng, pl.sample.u);
    const inner = chooseMaterial(cfg.innerRows, rng.fork('inner-material'), parentMaterial, areas, transition);
    const core = chooseMaterial(cfg.coreRows, rng.fork('core-material'), parentMaterial, areas, transition);
    const shape = sampleKnotShape(cfg, rng.fork('shape'), inner.rect, core.rect);
    const nr = rng.fork('noise');
    const frame = knotFrame(parent, branch, pl);
    const mesh = buildKnotMesh({
      frame,
      shape,
      segments,
      parentUv: parentUvAtPlacement(parent, branch, pl),
      noise,
      noiseOffset: [nr.range(-50, 50), nr.range(-50, 50)],
    });

    const wind = parentWind(parent, pl.sample.parentPoint, made * 13 + 3, pl.sample.position);
    const axis = pl.sample.position;
    const [br, bg, bb] = barkRingColor(BARK_TINT, branch.generation, pl.sample.u);
    const cx = made % cells;
    const cy = Math.floor(made / cells);
    const base = acc.vertexCount;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const sec = mesh.section[i] as number;
      const shade = (mesh.ao[i] as number) * (sec === SECTION_CORE ? CORE_BRIGHTNESS : 1);
      vx.px = mesh.positions[i * 3] as number;
      vx.py = mesh.positions[i * 3 + 1] as number;
      vx.pz = mesh.positions[i * 3 + 2] as number;
      vx.nx = mesh.normals[i * 3] as number;
      vx.ny = mesh.normals[i * 3 + 1] as number;
      vx.nz = mesh.normals[i * 3 + 2] as number;
      vx.tx = mesh.tangents[i * 3] as number;
      vx.ty = mesh.tangents[i * 3 + 1] as number;
      vx.tz = mesh.tangents[i * 3 + 2] as number;
      vx.tw = 1;
      vx.u = mesh.uvs[i * 2] as number;
      vx.v = mesh.uvs[i * 2 + 1] as number;
      vx.u1 = (cx + (mesh.plane[i * 2] as number)) / cells;
      vx.v1 = (cy + (mesh.plane[i * 2 + 1] as number)) / cells;
      vx.r = Math.min(1, br * shade);
      vx.g = Math.min(1, bg * shade);
      vx.b = Math.min(1, bb * shade);
      vx.ao = mesh.ao[i] as number;
      vx.pvx = axis[0];
      vx.pvy = axis[1];
      vx.pvz = axis[2];
      vx.w0 = wind[0];
      vx.w1 = wind[1];
      vx.w2 = wind[2];
      vx.w3 = wind[3];
      vx.w4 = wind[4];
      acc.addVertex(vx);
    }
    const slotOf = [parentMaterial, inner.material, core.material];
    for (const sec of [SECTION_OUTER, SECTION_INNER, SECTION_CORE]) {
      const [start, count] = mesh.ranges[sec] as readonly [number, number];
      const b = bucket(slotOf[sec] as string);
      for (let k = start; k < start + count; k++) b.push(base + (mesh.indices[k] as number));
    }

    const tip = mesh.vertexCount - 1;
    sb.beginBranch(pl.branch.id, pl.sample.parentPoint, generation);
    const c = Math.cos(frame.azimuth);
    const sn = Math.sin(frame.azimuth);
    sb.addPoint(
      axis[0] + (frame.normal[0] * c + frame.binormal[0] * sn) * frame.radius,
      axis[1] + (frame.normal[1] * c + frame.binormal[1] * sn) * frame.radius,
      axis[2] + (frame.normal[2] * c + frame.binormal[2] * sn) * frame.radius,
      0.001,
    );
    sb.addPoint(mesh.positions[tip * 3] as number, mesh.positions[tip * 3 + 1] as number, mesh.positions[tip * 3 + 2] as number, 0.001);
    sb.endBranch();
    made++;
  }
  if (made === 0) return emptyFoliage(parent, ctx.seed);

  for (const [material, b] of buckets) {
    acc.beginSlot(material);
    for (let k = 0; k + 2 < b.length; k += 3) acc.addTriangle(b.data[k] as number, b.data[k + 1] as number, b.data[k + 2] as number);
  }
  return foliageOutput(sb.build(), parent, acc.build('bark', true), made, ctx.seed);
}
