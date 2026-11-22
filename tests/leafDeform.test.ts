import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { attachmentFramesOf } from '@/geometry/attachments';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import type { CutoutMesh, LodLevel } from '@/contracts/material';
import { linearCurve } from '@/contracts/curve';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger, type Logger } from '@/core/logger';
import { createSimplex } from '@/core/noise';
import { Rng } from '@/core/rng';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import {
  NEUTRAL_DEFORM,
  deformFrame,
  deformLocalPoint,
  deformWorldVertex,
  heightOffset,
  isDeformActive,
  leafLocalFrame,
  subdivisionPasses,
  type LeafDeform,
} from '@/geometry/leafDeform';
import { chooseMeshLod, defaultMeshLodIndex, filledMeshLods, lodPosition, sizeIncreaseFactor } from '@/geometry/leafLod';
import { buildLeafMesh, FULL_ATLAS, type LeafCard } from '@/geometry/leafMesher';
import type { V3 } from '@/geometry/math3';
import { MeshAccumulator, newVertex } from '@/geometry/meshAccumulator';
import { registerDisplacementSource } from '@/materials/displacement';
import { setMaterialSource } from '@/materials/materialSource';
import { createDefaultCutoutMesh } from '@/materials/cutouts/ops';
import { rebuildCutoutLods } from '@/materials/cutouts/lod';
import { ensureCutoutAttachmentData } from '@/materials/cutouts/frame';
import { defaultMeshLodCurve, defaultSizeIncreaseCurve, leafDependencyKey, leafDeformFor, materialHeightSampler, readLeafDeform } from '../src/nodes/generators/leafDeformParams';

beforeAll(() => registerDiscoveredNodes());
afterEach(() => setMaterialSource(null));

const L = 2;
const W = 1;
const deform = (over: Partial<LeafDeform> = {}): LeafDeform => ({ ...NEUTRAL_DEFORM, length: L, ...over });
const near = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(eps);
};

/** Synthetic flat quad grid in the leaf-local frame: x in [-W/2, W/2], y in [0, L], z = 0 (the pivot is a grid node). */
function grid(nx = 5, ny = 9): V3[] {
  const pts: V3[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([(i / (nx - 1) - 0.5) * W, (j / (ny - 1)) * L, 0]);
  return pts;
}

describe('fold / curl / twist on a quad grid', () => {
  it('leaves the pivot and the on-axis points of every operation fixed', () => {
    const d = deform({ fold: 0.7, curl: 1.2, twist: 2, scale: [1.5, 0.8, 2] });
    near(deformLocalPoint(d, [0, 0, 0]), [0, 0, 0]);
    // Fold and twist keep points of the Y axis where they are
    near(deformLocalPoint(deform({ fold: 0.7 }), [0, 1.3, 0]), [0, 1.3, 0]);
    near(deformLocalPoint(deform({ twist: 2 }), [0, 1.3, 0]), [0, 1.3, 0]);
  });

  it('fold is symmetric about the Y axis and lifts both halves the same way (+ up, - down)', () => {
    for (const p of grid()) {
      const up = deformLocalPoint(deform({ fold: 0.6 }), p);
      const mirrored = deformLocalPoint(deform({ fold: 0.6 }), [-p[0], p[1], p[2]]);
      expect(up[0]).toBeCloseTo(-mirrored[0], 9);
      expect(up[1]).toBeCloseTo(mirrored[1], 9);
      expect(up[2]).toBeCloseTo(mirrored[2], 9);
      expect(up[2]).toBeGreaterThanOrEqual(0);
      expect(deformLocalPoint(deform({ fold: -0.6 }), p)[2]).toBeLessThanOrEqual(0);
    }
    // 90 degrees: the half-blades stand upright
    near(deformLocalPoint(deform({ fold: Math.PI / 2 }), [0.5, 1, 0]), [0, 1, 0.5], 1e-9);
    // a fold keeps the distance of a flat point from the fold line
    const q = deformLocalPoint(deform({ fold: 0.9 }), [0.4, 0.7, 0]);
    expect(Math.hypot(q[0], q[2])).toBeCloseTo(0.4, 9);
  });

  it('curl bends around X: length preserving arc, tip rotated by the curl angle, sign mirrors z', () => {
    const angle = Math.PI / 2;
    const d = deform({ curl: angle });
    const tip = deformLocalPoint(d, [0, L, 0]);
    const radius = L / angle;
    near(tip, [0, radius, radius], 1e-9);
    // a point beside the centre line keeps its x, and the arc length stays y
    let prev = deformLocalPoint(d, [0.3, 0, 0]);
    let total = 0;
    for (let j = 1; j <= 200; j++) {
      const q = deformLocalPoint(d, [0.3, (j / 200) * L, 0]);
      expect(q[0]).toBeCloseTo(0.3, 9);
      total += Math.hypot(q[1] - prev[1], q[2] - prev[2]);
      prev = q;
    }
    expect(total).toBeCloseTo(L, 3);
    const neg = deformLocalPoint(deform({ curl: -angle }), [0.2, 1, 0.1]);
    const pos = deformLocalPoint(d, [0.2, 1, -0.1]);
    expect(neg[0]).toBeCloseTo(pos[0], 9);
    expect(neg[1]).toBeCloseTo(pos[1], 9);
    expect(neg[2]).toBeCloseTo(-pos[2], 9);
  });

  it('twist rotates about Y by an angle proportional to the distance from the X axis', () => {
    const d = deform({ twist: Math.PI / 2 });
    // tip: a quarter turn, point (x, L, 0) -> (0, L, x)
    near(deformLocalPoint(d, [0.5, L, 0]), [0, L, 0.5], 1e-9);
    // half way: 45 degrees
    const mid = deformLocalPoint(d, [0.5, L / 2, 0]);
    expect(mid[0]).toBeCloseTo(0.5 * Math.cos(Math.PI / 4), 9);
    expect(mid[2]).toBeCloseTo(0.5 * Math.sin(Math.PI / 4), 9);
    // the base row (on the X axis) does not rotate at all
    near(deformLocalPoint(d, [0.5, 0, 0]), [0.5, 0, 0]);
    // distance from the Y axis and the height are preserved
    for (const p of grid()) {
      const q = deformLocalPoint(d, p);
      expect(Math.hypot(q[0], q[2])).toBeCloseTo(Math.hypot(p[0], p[2]), 9);
      expect(q[1]).toBeCloseTo(p[1], 9);
    }
    // symmetric: opposite twist mirrors z
    const a = deformLocalPoint(deform({ twist: -Math.PI / 2 }), [0.5, 1, 0]);
    const b = deformLocalPoint(d, [0.5, 1, 0]);
    expect(a[2]).toBeCloseTo(-b[2], 9);
  });

  it('scale scales every axis about the pivot', () => {
    near(deformLocalPoint(deform({ scale: [2, 3, 4] }), [0.1, 0.2, 0.3]), [0.2, 0.6, 1.2]);
    expect(isDeformActive(deform())).toBe(false);
    expect(isDeformActive(deform({ scale: [1, 1.1, 1] }))).toBe(true);
  });
});

describe('vertex noise', () => {
  const noisy = (seed: number, tight = 2, offset: V3 = [0, 0, 0]): LeafDeform =>
    deform({ vertexAmount: 0.05, vertexTightness: tight, noise: createSimplex(seed), noiseOffset: offset });
  const sample = (d: LeafDeform): V3[] => grid().map((p) => deformLocalPoint(d, p));

  it('is deterministic for the same seed and different for another seed', () => {
    expect(sample(noisy(3))).toEqual(sample(noisy(3)));
    expect(sample(noisy(3))).not.toEqual(sample(noisy(4)));
    expect(sample(noisy(3, 2, [10, 0, 0]))).not.toEqual(sample(noisy(3, 2, [0, 0, 0])));
  });

  it('keeps the pivot fixed and bounds the offset by the amount', () => {
    const d = noisy(7, 3, [12, 5, 9]);
    near(deformLocalPoint(d, [0, 0, 0]), [0, 0, 0]);
    for (const p of grid()) {
      const q = deformLocalPoint(d, p);
      expect(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])).toBeLessThan(0.05 * 2 * Math.sqrt(3));
    }
  });

  it('higher tightness is more localized (rougher over the same leaf)', () => {
    const rough = (tight: number): number => {
      let s = 0;
      const g = grid(2, 80);
      let prev = deformLocalPoint(noisy(5, tight), g[0] as V3);
      for (const p of g.slice(1)) {
        const q = deformLocalPoint(noisy(5, tight), p);
        s += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
        prev = q;
      }
      return s;
    };
    expect(rough(12)).toBeGreaterThan(rough(1.5));
  });

  it('seeded per-leaf deformation is deterministic and the Seed parameter changes the pattern', () => {
    const p = leafParamsOf({ vertexAmount: 0.05, vertexSeed: 1 });
    const q = leafParamsOf({ vertexAmount: 0.05, vertexSeed: 2 });
    const mk = (pp: NodeParams): LeafDeform => leafDeformFor(readLeafDeform(pp), pp, new Rng(9), 0.5, 0.5, null, 0) as LeafDeform;
    const a = mk(p);
    const b = mk(p);
    expect(deformLocalPoint(a, [0.2, 0.3, 0])).toEqual(deformLocalPoint(b, [0.2, 0.3, 0]));
    expect(deformLocalPoint(mk(q), [0.2, 0.3, 0])).not.toEqual(deformLocalPoint(a, [0.2, 0.3, 0]));
  });
});

function leafParamsOf(over: Record<string, unknown>): NodeParams {
  const out: NodeParams = {};
  for (const d of getNodeDef('generator.leaf')!.params) out[d.id] = defaultParamState(d);
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] as NodeParams[string]), value: v as never, variance: 0 };
  return out;
}

describe('height displacement', () => {
  it('displaces along the normal by (map - 0.5) x amount, fades near the pivot and is zero without a map', () => {
    const d = deform({ height: 0.2, heightSample: (u) => (u < 0.5 ? 1 : 0) });
    expect(heightOffset(d, [0.4, 1, 0], 0.25, 0.5)).toBeCloseTo(0.1, 9);
    expect(heightOffset(d, [0.4, 1, 0], 0.75, 0.5)).toBeCloseTo(-0.1, 9);
    expect(heightOffset(d, [0, 0, 0], 0.25, 0.5)).toBe(0);
    expect(heightOffset(deform({ height: 0.2 }), [0.4, 1, 0], 0.25, 0.5)).toBe(0);
    const f = leafLocalFrame([0, 0, 0], [0, 1, 0], [1, 0, 0]);
    const p = deformWorldVertex(d, f, [0.4, 1, 0], [0, 0, 1], 0.25, 0.5);
    near(p, [0.4, 1, 0.1], 1e-9);
  });

  it('samples a real height image of the material at the vertex UV', () => {
    // 2 x 1 image: left half white, right half black.
    registerDisplacementSource('h-test', { width: 2, height: 1, rgba: new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]) });
    setMaterialSource({
      materials: () => [{ id: 'm', slots: { height: { texture: { assetId: 'h-test' } } } } as never],
      sets: () => [],
      displacements: () => [],
      masks: () => [],
      season: () => 0.5,
    });
    const sample = materialHeightSampler('m');
    expect(sample).not.toBeNull();
    expect(sample!(0.25, 0.5)).toBeCloseTo(1, 6);
    expect(sample!(0.75, 0.5)).toBeCloseTo(0, 6);
    expect(materialHeightSampler('missing')).toBeNull();
    expect(leafDependencyKey(leafParamsOf({ deformHeight: 0.1 }))).toContain('m:');
    expect(leafDependencyKey(leafParamsOf({}))).toBe('');

    const card: LeafCard = {
      origin: [0, 0, 0], axis: [0, 1, 0], side: [1, 0, 0], length: 1, width: 1, bend: 0, fold: 0, curl: 0, twist: 0,
      segLength: 1, segWidth: 1, outline: 'rect', color: [1, 1, 1], ao: 1, atlas: FULL_ATLAS, materialId: 'm',
      pivot: [0, 0, 0], wind: [0, 0, 0.2, 0],
    };
    card.atlas = [0.25, 0, 0.75, 1];
    const flat = buildLeafMesh([card], { defaultMaterial: 'm' });
    const bumped = buildLeafMesh([{ ...card, deform: deform({ length: 1, height: 0.2, heightSample: sample, minVertices: 0 }) }], { defaultMaterial: 'm' });
    expect(bumped.positions.length).toBe(flat.positions.length);
    let moved = 0;
    for (let i = 0; i < flat.positions.length / 3; i++) {
      const dz = (bumped.positions[i * 3 + 2] as number) - (flat.positions[i * 3 + 2] as number);
      const nz = flat.normals[i * 3 + 2] as number;
      const u = flat.uv0[i * 2] as number;
      // quad: u = 0 (left, white, +0.1 along the normal), u = 1 (right, black)
      if (Math.abs(dz) > 1e-9) moved += 1;
      expect(Math.abs(dz)).toBeLessThanOrEqual(0.1 + 1e-6);
      if (u < 0.5) expect(dz * Math.sign(nz)).toBeGreaterThan(0);
      else expect(dz * Math.sign(nz)).toBeLessThan(0);
    }
    expect(moved).toBeGreaterThan(0);
  });
});

describe('subdivision and mesh building', () => {
  it('subdivisionPasses grows sparse meshes up to the target and never past the cap', () => {
    expect(subdivisionPasses(4, 2, 0)).toBe(0);
    expect(subdivisionPasses(100, 90, 24)).toBe(0);
    expect(subdivisionPasses(4, 2, 24)).toBe(2);
    expect(subdivisionPasses(3, 1, 100000)).toBe(3);
  });

  it('MeshAccumulator.subdivideFrom splits triangles 1 -> 4 sharing edge vertices', () => {
    const acc = new MeshAccumulator();
    acc.beginSlot('m');
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) acc.addVertex({ ...newVertex(), px: x, py: y, u: x, v: y });
    acc.addTriangle(0, 1, 2);
    acc.addTriangle(1, 3, 2);
    acc.subdivideFrom(0);
    expect(acc.triangleCount).toBe(8);
    expect(acc.vertexCount).toBe(4 + 5); // 5 unique edges
    const mesh = acc.build('m', false);
    // the diagonal midpoint exists once and carries interpolated UV
    const mids = [...Array(mesh.positions.length / 3).keys()].filter((i) => Math.abs((mesh.positions[i * 3] as number) - 0.5) < 1e-6 && Math.abs((mesh.positions[i * 3 + 1] as number) - 0.5) < 1e-6);
    expect(mids).toHaveLength(1);
    expect(mesh.uv0[(mids[0] as number) * 2]).toBeCloseTo(0.5, 6);
  });

  it('a deformed quad card is subdivided, folded up and keeps its base vertices at the pivot line', () => {
    const card: LeafCard = {
      origin: [1, 2, 3], axis: [0, 1, 0], side: [1, 0, 0], length: 1, width: 1, bend: 0, fold: 0, curl: 0, twist: 0,
      segLength: 1, segWidth: 1, outline: 'rect', color: [1, 1, 1], ao: 1, atlas: FULL_ATLAS, materialId: 'm',
      pivot: [1, 2, 3], wind: [0, 0, 0.2, 0],
    };
    const plain = buildLeafMesh([card], { defaultMaterial: 'm' });
    const folded = buildLeafMesh([{ ...card, deform: deform({ length: 1, fold: 0.8, minVertices: 24 }) }], { defaultMaterial: 'm' });
    expect(folded.positions.length / 3).toBeGreaterThan(plain.positions.length / 3);
    expect(folded.positions.length / 3).toBeGreaterThanOrEqual(24);
    let centreLine = 0;
    for (let i = 0; i < folded.positions.length / 3; i++) {
      const x = (folded.positions[i * 3] as number) - 1;
      const z = (folded.positions[i * 3 + 2] as number) - 3;
      const nLen = Math.hypot(folded.normals[i * 3] as number, folded.normals[i * 3 + 1] as number, folded.normals[i * 3 + 2] as number);
      expect(nLen).toBeCloseTo(1, 5);
      // the centre line (x = 0) stays flat; elsewhere both halves are lifted to the same side by |x| sin(fold)
      if (Math.abs(x) < 1e-6) {
        centreLine += 1;
        expect(Math.abs(z)).toBeLessThan(1e-6);
      } else expect(Math.abs(z) - Math.abs(x) * Math.tan(0.8)).toBeLessThan(1e-5);
    }
    expect(centreLine).toBeGreaterThan(0);
    // pivot untouched: wind pivot equals the origin
    expect(folded.wind?.pivot[0]).toBeCloseTo(1, 6);
  });
});

describe('attachment frames follow the deformed axis', () => {
  it('deformFrame keeps the pivot frame and bends frames along the curl', () => {
    const f = leafLocalFrame([0, 0, 0], [0, 1, 0], [1, 0, 0]);
    const base = { position: [0, 0, 0] as V3, direction: [0, 1, 0] as V3, up: [0, 0, 1] as V3 };
    const keep = deformFrame(deform({ curl: 1.5, fold: 0.4, twist: 1 }), f, base);
    near(keep.position, [0, 0, 0], 1e-12);
    near(keep.direction, [0, 1, 0], 1e-6);
    const tipFrame = deformFrame(deform({ curl: Math.PI / 2 }), f, { position: [0, L, 0], direction: [0, 1, 0], up: [0, 0, 1] });
    // after a quarter turn the growth direction points along the old normal
    near(tipFrame.direction, [0, 0, 1], 1e-3);
    expect(Math.abs(tipFrame.direction[0] * tipFrame.up[0] + tipFrame.direction[1] * tipFrame.up[1] + tipFrame.direction[2] * tipFrame.up[2])).toBeLessThan(1e-6);
  });

  it('the Leaf node moves anchor frames with the deformation and leaves the neutral result untouched', () => {
    const anchorUv: [number, number] = [0.5, 0.8];
    const c = createDefaultCutoutMesh('dc', 'dc', 'leaf');
    c.outline = [[0.5, 0], [1, 0.4], [0.5, 1], [0, 0.4]];
    c.interiorPoints = [anchorUv];
    c.straightenAxis = [[0.5, 0], [0.5, 1]];
    c.anchors = [{ id: 'dc_a0', uv: anchorUv, handleUv: [0.6, 0.9] }];
    rebuildCutoutLods(c);
    ensureCutoutAttachmentData(c);
    install([c]);
    const run = (over: Record<string, unknown>) => runLeaf(leafParams('dc', over));
    const base = run({});
    const neutral = run({ deformFold: 0, deformCurl: 0 });
    expect(Array.from(neutral.positions)).toEqual(Array.from(base.positions));
    const curled = run({ deformCurl: 90 });
    expect(curled.positions.length).toBeGreaterThanOrEqual(base.positions.length);
    const f0 = attachmentFramesOf(base.attachments, 0)[0]!;
    const f1 = attachmentFramesOf(curled.attachments, 0)[0]!;
    expect(Math.hypot(f1.position[0] - f0.position[0], f1.position[1] - f0.position[1], f1.position[2] - f0.position[2])).toBeGreaterThan(1e-3);
    // pivot vertex (the outline vertex on the axis base) stays at the attachment point
    const pivot = base.origin;
    const idx = nearestVertex(base.positions, pivot);
    near([curled.positions[idx * 3] as number, curled.positions[idx * 3 + 1] as number, curled.positions[idx * 3 + 2] as number], pivot, 1e-5);
    // same graph + seed -> same result
    expect(Array.from(run({ deformCurl: 90 }).positions)).toEqual(Array.from(curled.positions));
  });

  it('the old fixed LOD growth is the default of the Size increase curve', () => {
    for (const lod of [0, 1, 2, 3]) expect(sizeIncreaseFactor(defaultSizeIncreaseCurve(), lod)).toBeCloseTo(1 + 0.12 * lod, 9);
  });
});

function install(cutouts: CutoutMesh[]): void {
  setMaterialSource({ materials: () => [], sets: () => [], displacements: () => [], masks: () => [], cutoutMeshes: () => cutouts, season: () => 0.5 });
}

function nearestVertex(positions: ArrayLike<number>, p: V3): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < positions.length / 3; i++) {
    const d = Math.hypot((positions[i * 3] as number) - p[0], (positions[i * 3 + 1] as number) - p[1], (positions[i * 3 + 2] as number) - p[2]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function stem(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.02);
  sb.endBranch();
  return sb.build();
}

function leafParams(cutoutId: string, over: Record<string, unknown> = {}): NodeParams {
  const p = leafParamsOf({ number: 1, first: 0.5, last: 0.5, leafBend: 0, droopAmount: 0, leafTwist: 0, width: 0.3, height: 0.5, angleToParent: 55, rollAngle: 0, leavesPerNode: 1, ...over });
  p.leafTypes = { ...(p.leafTypes as NodeParams[string]), value: [{ material: 'leaf', mesh: cutoutId, weight: 1 }] as never };
  return p;
}

function runLeaf(p: NodeParams, lod = 0, logger: Logger = createLogger('test', 'error')) {
  const ctx: NodeContext = { nodeId: 'leaf', name: 'leaf', rng: new Rng(7), seed: 7, cancel: new CancellationSource().token, lod, logger };
  const sk = stem();
  const out = getNodeDef('generator.leaf')!.evaluate(ctx, { parent: [{ kind: 'Structure', value: { skeleton: sk } }] } as NodeInputs, p) as Record<string, { kind: string; value: never }>;
  const children = out.children as unknown as { value: { skeleton: Skeleton; attachments: import('@/contracts/attachment').AttachmentSet } };
  const geometry = out.geometry as unknown as { value: { positions: Float32Array } };
  const first = children.value.skeleton;
  return { positions: geometry.value.positions, leaves: first.branches.length, attachments: children.value.attachments, origin: [first.position[0], first.position[1], first.position[2]] as V3 };
}

describe('mesh LOD selection', () => {
  const ALL: LodLevel[] = ['high', 'med', 'low'];

  it('maps the engine LOD to a mesh LOD with the default curve exactly like the legacy mapping', () => {
    const curve = defaultMeshLodCurve();
    for (const lod of [0, 1, 2, 3]) {
      const level = chooseMeshLod({ lod, curve, offset: 0, filled: ALL }).level;
      expect(level).toBe(ALL[defaultMeshLodIndex(lod)]);
      expect(chooseMeshLod({ lod, curve: null, offset: 0, filled: ALL }).level).toBe(level);
    }
    expect(['high', 'med', 'low', 'low']).toEqual([0, 1, 2, 3].map((l) => chooseMeshLod({ lod: l, curve, offset: 0, filled: ALL }).level));
    expect(lodPosition(3)).toBe(1);
    expect(lodPosition(-1)).toBe(0);
  });

  it('follows a custom curve (rounded)', () => {
    const lowAlways = linearCurve(2, 2, [0, 1], [0, 2]);
    expect(chooseMeshLod({ lod: 0, curve: lowAlways, offset: 0, filled: ALL }).level).toBe('low');
    const ramp = linearCurve(0, 2, [0, 1], [0, 2]);
    expect(chooseMeshLod({ lod: 1.5, curve: ramp, offset: 0, filled: ALL }).level).toBe('med');
    expect(chooseMeshLod({ lod: 3, curve: ramp, offset: 0, filled: ALL }).level).toBe('low');
  });

  it('applies the offset and clamps it to High..Low', () => {
    const curve = defaultMeshLodCurve();
    expect(chooseMeshLod({ lod: 0, curve, offset: 1, filled: ALL }).level).toBe('med');
    expect(chooseMeshLod({ lod: 1, curve, offset: 1, filled: ALL }).level).toBe('low');
    expect(chooseMeshLod({ lod: 2, curve, offset: 2, filled: ALL }).level).toBe('low');
    expect(chooseMeshLod({ lod: 0, curve, offset: -2, filled: ALL }).level).toBe('high');
    expect(chooseMeshLod({ lod: 2, curve, offset: -1, filled: ALL }).level).toBe('med');
    expect(chooseMeshLod({ lod: 2, curve, offset: -9, filled: ALL }).level).toBe('high');
  });

  it('falls back to the nearest filled slot and ignores the offset with a single LOD', () => {
    const curve = defaultMeshLodCurve();
    const one = chooseMeshLod({ lod: 2, curve, offset: -1, filled: ['high'] });
    expect(one).toEqual({ level: 'high', offsetIgnored: true });
    expect(chooseMeshLod({ lod: 0, curve, offset: 0, filled: ['low'] })).toEqual({ level: 'low', offsetIgnored: false });
    expect(chooseMeshLod({ lod: 0, curve, offset: 1, filled: ['high', 'low'] }).level).toBe('high');
    expect(chooseMeshLod({ lod: 0, curve, offset: 2, filled: ['high', 'low'] }).level).toBe('low');
    expect(chooseMeshLod({ lod: 1, curve, offset: 0, filled: ['high', 'low'] }).level).toBe('high');
    expect(chooseMeshLod({ lod: 1, curve, offset: 0, filled: [] })).toEqual({ level: 'med', offsetIgnored: false });
  });

  it('reads the filled slots of a cutout', () => {
    const c = createDefaultCutoutMesh('f', 'f', 'leaf');
    rebuildCutoutLods(c);
    expect(filledMeshLods(c)).toEqual(['high', 'med', 'low']);
    c.lods.low = { ...c.lods.low, vertices: [], indices: [] };
    expect(filledMeshLods(c)).toEqual(['high', 'med']);
    expect(filledMeshLods(null)).toEqual([]);
  });

  it('resolution factor: the curve gives the percentage, never below 5 %', () => {
    expect(sizeIncreaseFactor(linearCurve(0, 50, [0, 1], [0, 100]), 3)).toBeCloseTo(1.5, 9);
    expect(sizeIncreaseFactor(linearCurve(-200, -200, [0, 1], [-200, 100]), 0)).toBeCloseTo(0.05, 9);
  });

  it('the Leaf node picks the mesh LOD from the viewport LOD and warns about an unusable offset', () => {
    const c = createDefaultCutoutMesh('lc', 'lc', 'leaf');
    c.outline = [[0.5, 0], [0.9, 0.2], [1, 0.5], [0.9, 0.8], [0.5, 1], [0.1, 0.8], [0, 0.5], [0.1, 0.2]];
    c.interiorPoints = [[0.5, 0.3], [0.5, 0.6]];
    c.straightenAxis = [[0.5, 0], [0.5, 1]];
    rebuildCutoutLods(c);
    ensureCutoutAttachmentData(c);
    install([c]);
    const perLeaf = (r: ReturnType<typeof runLeaf>): number => r.positions.length / 3 / Math.max(1, r.leaves);
    const counts = [0, 1, 2].map((lod) => perLeaf(runLeaf(leafParams('lc', { number: 8, first: 0.1, last: 1 }), lod)));
    const expected = (['high', 'med', 'low'] as const).map((l) => c.lods[l].vertices.length / 2);
    expect(counts).toEqual(expected);
    // an offset of +1 at LOD 0 shows the Med mesh
    const shifted = perLeaf(runLeaf(leafParams('lc', { number: 8, first: 0.1, last: 1, resMeshLodOffset: 1 }), 0));
    expect(shifted).toBe(expected[1]);
    // a cutout with a single filled slot ignores the offset (and warns)
    c.lods.med = { ...c.lods.med, vertices: [], indices: [] };
    c.lods.low = { ...c.lods.low, vertices: [], indices: [] };
    const warnings: string[] = [];
    const logger = { ...createLogger('test', 'error'), warn: (m: string) => warnings.push(m) } as Logger;
    runLeaf(leafParams('lc', { resMeshLodOffset: 1 }), 0, logger);
    expect(warnings.some((w) => w.includes('Mesh LOD offset'))).toBe(true);
  });
});
