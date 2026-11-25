import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { decodeProject, encodeProject } from '@/app/project/codec';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import type { CutoutMesh, MaterialDef, MaskDef } from '@/contracts/material';
import type { MeshData } from '@/contracts/mesh';
import { defaultParams, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { createSimplex } from '@/core/noise';
import { Rng } from '@/core/rng';
import { SIZE_PARAMS } from '@/generators/common/sizeScalar';
import { buildDecalMesh, decalCells } from '@/generators/decal';
import { buildFinMesh, finSegments } from '@/generators/fin';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { registerDisplacementSource } from '@/materials/displacement';
import { createMaskDef } from '@/materials/masks';
import { createDefaultCutoutMesh } from '@/materials/cutouts/ops';
import { rebuildCutoutLods } from '@/materials/cutouts/lod';
import { ensureCutoutAttachmentData } from '@/materials/cutouts/frame';
import { cutoutShape, gridShape, MAX_SHAPE_TRIANGLES } from '@/generators/surfaceDetail';
import { removeRetiredNodes } from '@/app/project/retiredNodes';
import { migrateGraphNodes } from '@/app/project/format';
import { attachmentFramesOf } from '@/geometry/attachments';
import { setMaterialSource } from '@/materials/materialSource';
import { createFusedParents } from '@/nodes/generators/fusedParent';
import { prepareParentBranch } from '@/nodes/generators/frames';
import { evaluateDecal } from '@/nodes/generators/decal';
import { evaluateFin } from '@/nodes/generators/fin';
import { surfaceDetailMaps, SURFACE_DETAIL_KINDS } from '@/presets/procTextures';
import { familyOf } from '@/viewport/viewState';
import { auditWindSeams, windAuditMeshFromParts } from '@/viewport/wind/windAudit';
import { defaultWindParams } from '@/viewport/wind/windParams';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());
afterEach(() => setMaterialSource(null));

const RADIUS = 0.25;
const LENGTH = 4;

/** A straight vertical trunk skeleton with the ring frames stored (what a generator publishes). */
function plainTrunk(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * (LENGTH / 8), RADIUS);
  sb.endBranch();
  const sk = sb.build();
  for (const [id, v] of [['rmfNormalX', 0], ['rmfNormalY', -1], ['rmfNormalZ', 0]] as const) sk.attributes.set(id, new Float32Array(sk.count).fill(v));
  return sk;
}

const paramsOf = (type: string, over: Record<string, unknown> = {}): NodeParams => {
  const out = defaultParams(getNodeDef(type)!.params);
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] as NodeParams[string]), value: v as never };
  return out;
};
const ctx = (lod = 0, seed = 9): NodeContext => ({ nodeId: 'n', name: 'N', rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod, logger: createLogger('test', 'error') });
const inputs = (sk: Skeleton): NodeInputs => ({ parent: [{ kind: 'Structure', value: { skeleton: sk, materialId: 'bark' } }] });
const meshOf = (out: ReturnType<typeof evaluateDecal>): MeshData => {
  const g = out.geometry;
  if (!g || g.kind !== 'Mesh') throw new Error('no mesh');
  return g.value;
};
const childSkeleton = (out: ReturnType<typeof evaluateDecal>): Skeleton => {
  const c = out.children;
  return c && c.kind === 'Structure' ? c.value.skeleton : emptySkeleton();
};
const axisDistance = (m: MeshData, i: number): number => Math.hypot(m.positions[i * 3] as number, m.positions[i * 3 + 1] as number);

/** Material with a normal map whose alpha is the height (T07 convention) registered as a decoded image. */
function heightMaterial(cutouts: CutoutMesh[] = []): void {
  const w = 16;
  const rgba = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 128;
      rgba[i + 1] = 128;
      rgba[i + 2] = 255;
      rgba[i + 3] = Math.round(255 * (0.5 + 0.5 * Math.sin((x / w) * Math.PI * 2) * Math.cos((y / w) * Math.PI * 2)));
    }
  }
  registerDisplacementSource('decal-normal', { width: w, height: w, rgba });
  const mat = { id: 'relief', name: 'Relief', meshes: [], twoSided: false, variations: [], variationAmount: 0, slots: { normal: { texture: { assetId: 'decal-normal' } } }, atlas: { scale: 1, handling: 'default', name: '' }, maxResolution: null, backMaterialId: null, backSpacing: 0, userData: '' } as unknown as MaterialDef;
  setMaterialSource({ materials: () => [mat], sets: () => [], displacements: () => [], masks: () => [], cutoutMeshes: () => cutouts, season: () => 0.5 });
}

/** Diamond cutout of the 'relief' material (its bounding box corners are empty). */
function diamond(): CutoutMesh {
  const c = createDefaultCutoutMesh('dia', 'dia', 'relief');
  c.outline = [[0.5, 0], [1, 0.4], [0.5, 1], [0, 0.4]];
  c.interiorPoints = [[0.5, 0.7]];
  c.straightenAxis = [[0.5, 0], [0.5, 1]];
  c.anchors = [{ id: 'dia_a0', uv: [0.5, 0.7], handleUv: [0.5, 0.8] }];
  rebuildCutoutLods(c);
  ensureCutoutAttachmentData(c);
  return c;
}
const CUTOUT_ROW = [{ material: 'relief', mesh: 'dia', weight: 1 }];

describe('registration', () => {
  it.each(['generator.decal', 'generator.fin'])('%s is a registered generator of decorations with tooltips', (type) => {
    const def = getNodeDef(type)!;
    expect(def.statsGroup).toBe('decorations');
    expect(familyOf(type)).toBe('decorations');
    expect(SIZE_PARAMS[type]?.length).toBeGreaterThan(0);
    const shared = new Set(getNodeDef('generator.knot')!.params.filter((p) => p.group === 'Generation').map((p) => p.id));
    for (const p of def.params.filter((d) => !shared.has(d.id) && d.group !== 'Material')) expect(p.kind === 'seed' || (p.tooltip ?? '').length > 5, `${type}.${p.id}`).toBe(true);
  });

  it('has the SpeedTree property groups', () => {
    const decal = new Set(getNodeDef('generator.decal')!.params.map((p) => p.id));
    for (const id of ['mode', 'knockout', 'genMasks', 'decalSize', 'decalSizeParent', 'decalLodOffset', 'decalResolution', 'decalRotation', 'decalOffset', 'decalHeight', 'leafTypes', 'seasonStartOffset']) expect(decal.has(id), id).toBe(true);
    const fin = new Set(getNodeDef('generator.fin')!.params.map((p) => p.id));
    for (const id of ['finSize', 'finFlip', 'finStyle', 'finStartAngle', 'finRoll', 'finFold', 'finCurl', 'finVertexAmount', 'finVertexScale', 'finVertexSeed', 'finScaleX', 'finScaleY', 'finScaleZ', 'finPuffiness', 'finMatchSurface', 'finRipple', 'leafTypes']) expect(fin.has(id), id).toBe(true);
  });
});

describe('Decal', () => {
  it('lies on the parent skin: every vertex is `offset` above the skin, faces outwards', () => {
    const out = evaluateDecal(ctx(), inputs(plainTrunk()), paramsOf('generator.decal', { number: 6, decalOffset: 0.004, decalHeight: 0, decalSize: 0.3 }));
    const m = meshOf(out);
    expect(m.positions.length).toBeGreaterThan(0);
    for (let i = 0; i < m.positions.length / 3; i++) expect(Math.abs(axisDistance(m, i) - (RADIUS + 0.004))).toBeLessThan(1e-4);
    // Triangles face away from the axis (counter-clockwise seen from outside).
    let bad = 0;
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t] as number, m.indices[t + 1] as number, m.indices[t + 2] as number];
      const p = (k: number, o: number): number => m.positions[k * 3 + o] as number;
      const e1 = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)];
      const e2 = [p(c, 0) - p(a, 0), p(c, 1) - p(a, 1), p(c, 2) - p(a, 2)];
      const n = [(e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number), (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number), (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number)];
      if ((n[0] as number) * p(a, 0) + (n[1] as number) * p(a, 1) < 0) bad++;
    }
    expect(bad).toBe(0);
  });

  it('pure mesh: skin points are exactly on the cylinder and the border carries no relief', () => {
    const frame = { axisPoint: [0, 0, 2] as const, tangent: [0, 0, 1] as const, normal: [0, -1, 0] as const, binormal: [1, 0, 0] as const, radius: RADIUS, slope: 0, azimuth: 0.4 };
    const mesh = buildDecalMesh({ frame, width: 0.3, length: 0.4, rotation: 0.7, offset: 0.002, height: 0.05, heightAt: () => 1, cells: 12, fade: 0.25 });
    for (let i = 0; i < mesh.vertexCount; i++) {
      expect(Math.hypot(mesh.skin[i * 3] as number, mesh.skin[i * 3 + 1] as number)).toBeCloseTo(RADIUS, 5);
      const d = Math.hypot(mesh.positions[i * 3] as number, mesh.positions[i * 3 + 1] as number) - RADIUS;
      expect(d).toBeCloseTo(0.002 + (mesh.displacement[i] as number), 4);
    }
    const side = mesh.cells + 1;
    for (let i = 0; i < side; i++) for (const k of [i, (side - 1) * side + i, i * side, i * side + side - 1]) expect(mesh.displacement[k]).toBeCloseTo(0, 9);
    expect(Math.max(...mesh.displacement)).toBeCloseTo(0.05, 3);
  });

  it('height displacement is bounded by decalHeight (map = alpha of the normal map); negative digs cavities', () => {
    heightMaterial();
    const row = [{ material: 'relief', mesh: 'none', weight: 1 }];
    const run = (h: number) => {
      const p = paramsOf('generator.decal', { number: 6, decalOffset: 0.002, decalHeight: h, decalSize: 0.4, leafTypes: row });
      p.decalHeight = { ...(p.decalHeight as NodeParams[string]), variance: 0 };
      return meshOf(evaluateDecal(ctx(), inputs(plainTrunk()), p));
    };
    const up = run(0.05);
    let hi = -Infinity;
    for (let i = 0; i < up.positions.length / 3; i++) {
      const d = axisDistance(up, i) - RADIUS - 0.002;
      expect(d).toBeGreaterThan(-1e-3);
      expect(d).toBeLessThan(0.05 + 1e-3);
      hi = Math.max(hi, d);
    }
    expect(hi).toBeGreaterThan(0.005);
    const down = run(-0.05);
    let lo = Infinity;
    for (let i = 0; i < down.positions.length / 3; i++) {
      const d = axisDistance(down, i) - RADIUS - 0.002;
      expect(d).toBeLessThan(1e-3);
      expect(d).toBeGreaterThan(-0.05 - 1e-3);
      lo = Math.min(lo, d);
    }
    expect(lo).toBeLessThan(-0.005);
    // Without a height map the patch stays flat whatever the Height says.
    setMaterialSource(null);
    const flat = run(0.05);
    for (let i = 0; i < flat.positions.length / 3; i++) expect(Math.abs(axisDistance(flat, i) - RADIUS - 0.002)).toBeLessThan(1e-4);
  });

  it('is deterministic and the seed changes the layout', () => {
    const run = (seed: number) => meshOf(evaluateDecal(ctx(0, seed), inputs(plainTrunk()), paramsOf('generator.decal', { number: 8 })));
    expect(Array.from(run(1).positions)).toEqual(Array.from(run(1).positions));
    expect(Array.from(run(1).positions)).not.toEqual(Array.from(run(2).positions));
  });

  it('respects First / Last, Knockout and Masks', () => {
    const base = { number: 30, first: 0.5, last: 0.6, jumble: 0 };
    const sk = childSkeleton(evaluateDecal(ctx(), inputs(plainTrunk()), paramsOf('generator.decal', base)));
    expect(sk.branches.length).toBeGreaterThan(0);
    for (const b of sk.branches) {
      const z = sk.position[b.start * 3 + 2] as number;
      expect(z).toBeGreaterThan(LENGTH * 0.5 - 0.3);
      expect(z).toBeLessThan(LENGTH * 0.6 + 0.3);
    }
    const none = evaluateDecal(ctx(), inputs(plainTrunk()), paramsOf('generator.decal', { ...base, knockout: 1 }));
    expect(meshOf(none).positions.length).toBe(0);
    const mask: MaskDef = { ...createMaskDef('hi', 'High'), elevationMode: 'absolute', absoluteElevation: { min: 3, max: 50 } };
    setMaterialSource({ materials: () => [], sets: () => [], displacements: () => [], masks: () => [mask], season: () => 0 });
    const masked = childSkeleton(evaluateDecal(ctx(), inputs(plainTrunk()), paramsOf('generator.decal', { number: 30, first: 0.05, last: 0.95, genMasks: [{ genMaskId: 'hi' }] })));
    expect(masked.branches.length).toBeGreaterThan(0);
    for (const b of masked.branches) expect(masked.position[b.start * 3 + 2] as number).toBeGreaterThanOrEqual(3 - 0.4);
  });

  it('LOD: cull survives / removes, resolution drops, Mesh LOD offset shifts the detail', () => {
    const tris = (lod: number, over: Record<string, unknown> = {}): number => meshOf(evaluateDecal(ctx(lod), inputs(plainTrunk()), paramsOf('generator.decal', { number: 6, ...over }))).indices.length / 3;
    expect(tris(0)).toBeGreaterThan(0);
    expect(tris(3, { lodCull: 0 })).toBeGreaterThan(0);
    expect(tris(3, { lodCull: 1 })).toBe(0);
    expect(tris(3, { lodCull: 0, lodRadialSegments: 0.5 })).toBeLessThan(tris(0));
    expect(tris(0, { decalLodOffset: 2, lodRadialSegments: 0.5 })).toBeLessThan(tris(0));
    expect(decalCells(12, 0, 1, 0)).toBe(12);
    expect(decalCells(12, 2, 0.5, 0)).toBe(3);
    expect(decalCells(4, 3, 0.1, 0)).toBe(2);
  });

  it('size grows with + % of parent', () => {
    const span = (pct: number): number => {
      const m = meshOf(evaluateDecal(ctx(), inputs(plainTrunk()), paramsOf('generator.decal', { number: 1, decalSize: 0.1, decalSizeParent: pct, decalRandomRotation: 0, jumble: 0 })));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < m.positions.length / 3; i++) {
        lo = Math.min(lo, m.positions[i * 3 + 2] as number);
        hi = Math.max(hi, m.positions[i * 3 + 2] as number);
      }
      return hi - lo;
    };
    expect(span(100)).toBeGreaterThan(span(0) * 1.5);
  });
});

describe('Fin', () => {
  const frame = { axisPoint: [0, 0, 2] as const, tangent: [0, 0, 1] as const, normal: [0, -1, 0] as const, binormal: [1, 0, 0] as const, radius: RADIUS, slope: 0, azimuth: 0.4 };
  const finInput = (over: Partial<Parameters<typeof buildFinMesh>[0]> = {}): Parameters<typeof buildFinMesh>[0] => ({
    frame, width: 0.3, length: 0.3, style: 'perpendicular', startAngle: 1.0, roll: 0, flip: false, fold: 0, curl: 0,
    noise: { amount: 0, scale: 3, source: createSimplex(3), offset: [0, 0] }, scale: [1, 1, 1], puffiness: 0, matchSurface: 0, segmentsWidth: 6, segmentsLength: 5, ...over,
  });

  it.each(['perpendicular', 'along-spine', 'up'] as const)('%s: the base ring lies on the skin (zero gap) even with fold, curl and noise', (style) => {
    const m = buildFinMesh(finInput({ style, fold: 0.8, curl: 1.2, roll: 0.5, noise: { amount: 0.05, scale: 4, source: createSimplex(3), offset: [3, 4] } }));
    for (let i = 0; i <= m.segmentsWidth; i++) {
      expect(Math.hypot(m.baseSkin[i * 3] as number, m.baseSkin[i * 3 + 1] as number)).toBeCloseTo(RADIUS, 5);
      for (let c = 0; c < 3; c++) expect(m.positions[i * 3 + c] as number).toBeCloseTo(m.baseSkin[i * 3 + c] as number, 6);
    }
    // The tip leaves the surface.
    const tip = m.vertexCount - 1;
    expect(Math.hypot(m.positions[tip * 3] as number, m.positions[tip * 3 + 1] as number)).toBeGreaterThan(RADIUS + 0.02);
  });

  it('start angle 0 lies on the bark, 90 degrees stands out; normals are unit length', () => {
    const flat = buildFinMesh(finInput({ startAngle: 0, style: 'along-spine' }));
    for (let i = 0; i < flat.vertexCount; i++) expect(Math.hypot(flat.positions[i * 3] as number, flat.positions[i * 3 + 1] as number)).toBeLessThan(RADIUS + 0.03);
    const out = buildFinMesh(finInput({ startAngle: Math.PI / 2, style: 'along-spine' }));
    expect(Math.hypot(out.positions[(out.vertexCount - 1) * 3] as number, out.positions[(out.vertexCount - 1) * 3 + 1] as number)).toBeGreaterThan(RADIUS + 0.25);
    for (let i = 0; i < out.vertexCount; i++) expect(Math.hypot(out.normals[i * 3] as number, out.normals[i * 3 + 1] as number, out.normals[i * 3 + 2] as number)).toBeCloseTo(1, 4);
  });

  it('puffiness bends the normals towards the surface normal', () => {
    const dotWithSurface = (puff: number): number => {
      const m = buildFinMesh(finInput({ puffiness: puff, fold: 1 }));
      let s = 0;
      for (let i = 0; i < m.vertexCount; i++) {
        const x = m.positions[i * 3] as number;
        const y = m.positions[i * 3 + 1] as number;
        const l = Math.hypot(x, y) || 1;
        s += ((m.normals[i * 3] as number) * x + (m.normals[i * 3 + 1] as number) * y) / l;
      }
      return s / m.vertexCount;
    };
    expect(dotWithSurface(1)).toBeGreaterThan(dotWithSurface(0));
  });

  it('flip mirrors the U coordinate', () => {
    const a = buildFinMesh(finInput({ flip: false }));
    const b = buildFinMesh(finInput({ flip: true }));
    expect(a.uvs[0]).toBeCloseTo(1 - (b.uvs[0] as number), 6);
  });

  it('node: determinism, wind keeps the parent value at the base and grows towards the tip', () => {
    const sk = plainTrunk();
    for (const [id, f] of [['wind0', 0.3], ['wind1', 0.5], ['wind2', 0.2], ['windPhase', 0.4], ['windPhase1', 0.4]] as const) sk.attributes.set(id, new Float32Array(sk.count).fill(f));
    const run = () => evaluateFin(ctx(), inputs(sk), paramsOf('generator.fin', { number: 5, finRipple: 1, finFlip: 'none' }));
    const a = meshOf(run());
    expect(Array.from(a.positions)).toEqual(Array.from(meshOf(run()).positions));
    const w = a.wind!.weights;
    const n = a.positions.length / 3;
    let atBase = 0;
    for (let i = 0; i < n; i++) {
      expect(w[i * 4] as number).toBeCloseTo(0.3, 5);
      expect(w[i * 4 + 1] as number).toBeCloseTo(0.5, 5);
      expect(w[i * 4 + 2] as number).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(w[i * 4 + 2] as number).toBeLessThanOrEqual(1 + 1e-6);
      if (Math.abs(axisDistance(a, i) - RADIUS) < 1e-4) {
        atBase++;
        expect(w[i * 4 + 2] as number).toBeCloseTo(0.2, 5);
      }
    }
    expect(atBase).toBeGreaterThanOrEqual(5 * 5);
    expect(Math.max(...Array.from({ length: n }, (_, i) => w[i * 4 + 2] as number))).toBeGreaterThan(0.5);
    const calm = meshOf(evaluateFin(ctx(), inputs(sk), paramsOf('generator.fin', { number: 5, finRipple: 0 }))).wind!.weights;
    for (let i = 0; i < calm.length / 4; i++) expect(calm[i * 4 + 2] as number).toBeCloseTo(0.2, 5);
  });

  it('node: LOD cull and segment reduction; segment helper', () => {
    const tris = (lod: number, over: Record<string, unknown> = {}): number => meshOf(evaluateFin(ctx(lod), inputs(plainTrunk()), paramsOf('generator.fin', { number: 6, ...over }))).indices.length / 3;
    expect(tris(3, { lodCull: 1 })).toBe(0);
    expect(tris(3, { lodCull: 0, lodSegments: 0.9 })).toBeLessThan(tris(0));
    expect(finSegments(4, 6, 0, 0.5)).toEqual({ width: 4, length: 6 });
    expect(finSegments(1, 2, 3, 0.1)).toEqual({ width: 1, length: 2 });
  });
});

describe('graph integration', () => {
  const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 1, noiseTwist: 0, lean: 0 };
  const specs = (chance: number, extra: NodeSpec[] = []): NodeSpec[] => [
    { id: 'tree', type: 'output.tree', parent: null },
    { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, length: { value: 4, variance: 0 }, radius: { value: 0.25, variance: 0 }, splitsChance: chance, segments: 24, accuracy: 24 } as NodeSpec['params'] },
    { id: 'decal', type: 'generator.decal', parent: 'trunk', params: { number: 12, first: 0.05, last: 0.95 } as NodeSpec['params'] },
    { id: 'fin', type: 'generator.fin', parent: 'trunk', params: { number: 12, first: 0.05, last: 0.95 } as NodeSpec['params'] },
    ...extra,
  ];
  const run = (s: NodeSpec[], lod = 0) => new GraphEvaluator().evaluate(snapshotGraph(buildGraph(s)), { seed: 3, lod, token: new CancellationSource().token });
  type Result = Awaited<ReturnType<typeof run>>;
  const meshById = (r: Result, id: string): MeshData | undefined => r.scene.entries.find((e) => e.nodeId === id)?.mesh;
  const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

  it('evaluates, counts as decorations and survives LOD 3', async () => {
    const r = await run(specs(0));
    for (const id of ['decal', 'fin']) {
      expect(meshById(r, id)?.positions.length ?? 0).toBeGreaterThan(0);
      expect(r.scene.entries.find((e) => e.nodeId === id)?.statsGroup).toBe('decorations');
    }
    const low = await run(specs(0), 3);
    for (const id of ['decal', 'fin']) expect(meshById(low, id)?.positions.length ?? 0).toBeGreaterThan(0);
  });

  it('under a splitting trunk neither decals nor fins are repeated on the halves nor placed in the crotch', async () => {
    const plain = await run(specs(0));
    const split = await run(specs(1));
    for (const id of ['decal', 'fin']) {
      const a = meshById(plain, id)!.positions.length;
      const b = meshById(split, id)!.positions.length;
      expect(a).toBeGreaterThan(0);
      expect(b).toBeLessThan(a * 1.5);
    }
    const tr = skeletonOf(split, 'trunk');
    const fused = createFusedParents(tr);
    expect(fused.halves.size).toBe(2);
    const primary = tr.branches.find((b) => !fused.halves.has(b.id))!;
    const cut = fused.prepare(primary, prepareParentBranch(tr, primary));
    for (const id of ['decal', 'fin']) {
      const sk = skeletonOf(split, id);
      expect(sk.branches.length).toBeGreaterThan(0);
      for (const b of sk.branches) {
        expect(fused.halves.has(b.parentBranch)).toBe(false);
        expect(b.parentPoint - primary.start).toBeLessThanOrEqual(cut.branch.count);
      }
    }
  });

  it('wind: decals and fins touch the trunk without tearing (T03 audit)', async () => {
    const r = await run(specs(0));
    const wind = { ...defaultWindParams(), enabled: true, strength: 2 };
    const parts = ['trunk', 'decal', 'fin'].map((id) => ({ id, mesh: meshById(r, id)! }));
    const audit = auditWindSeams(windAuditMeshFromParts(parts), wind, { contact: 0.05, surface: 0.01 });
    expect(audit.maxDisplacement).toBeGreaterThan(0);
    // Decal vertices lie 2 mm above the trunk skin: compared with the trunk triangle below them they must move the same.
    expect(audit.surface.pairs).toBeGreaterThan(50);
    expect(audit.surface.maxGap, JSON.stringify(audit.surface.worst)).toBeLessThan(0.002 * audit.height);
    expect(audit.contact.pairs).toBeGreaterThan(5);
    expect(audit.contact.maxGap, JSON.stringify(audit.contact.worst)).toBeLessThan(0.01 * audit.height);
    expect(audit.coincident.maxGap).toBeLessThan(0.002 * audit.height);
  });

  it('project round trip keeps the new nodes and their parameters', async () => {
    const model = buildGraph(specs(0));
    const json = model.toJSON();
    const back = GraphModel.fromJSON(decodeProject(encodeProject({ ...(await minimalProject(json)) })).graph);
    const types = back.toJSON().nodes.map((n) => n.type);
    expect(types).toContain('generator.decal');
    expect(types).toContain('generator.fin');
    const a = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: 3, lod: 0, token: new CancellationSource().token });
    const b = await new GraphEvaluator().evaluate(snapshotGraph(back), { seed: 3, lod: 0, token: new CancellationSource().token });
    for (const id of ['decal', 'fin']) expect(Array.from(meshById(b, id)!.positions)).toEqual(Array.from(meshById(a, id)!.positions));
  });
});

async function minimalProject(graph: ReturnType<GraphModel['toJSON']>): Promise<Parameters<typeof encodeProject>[0]> {
  const { createProjectFile, defaultMeta } = await import('@/app/project/format');
  const base = createProjectFile({ name: 'Decal / Fin test', graph, meta: defaultMeta(1), seed: 1 });
  return base;
}

describe('procedural surface-detail materials', () => {
  it.each(SURFACE_DETAIL_KINDS)('%s: deterministic maps with height in the normal alpha and a cut-out alpha', (kind) => {
    const a = surfaceDetailMaps(kind, 4, 64);
    const b = surfaceDetailMaps(kind, 4, 64);
    expect(Array.from(a.normal.data)).toEqual(Array.from(b.normal.data));
    expect(Array.from(a.color.data)).not.toEqual(Array.from(surfaceDetailMaps(kind, 5, 64).color.data));
    let lo = 255;
    let hi = 0;
    let aLo = 255;
    let aHi = 0;
    for (let i = 0; i < 64 * 64; i++) {
      lo = Math.min(lo, a.normal.data[i * 4 + 3] as number);
      hi = Math.max(hi, a.normal.data[i * 4 + 3] as number);
      aLo = Math.min(aLo, a.color.data[i * 4 + 3] as number);
      aHi = Math.max(aHi, a.color.data[i * 4 + 3] as number);
    }
    expect(hi - lo).toBeGreaterThan(60);
    expect(aLo).toBe(0);
    expect(aHi).toBe(255);
    expect(a.color.data.length).toBe(64 * 64 * 4);
  });
});

describe('cutout meshes (Material / Mesh rows)', () => {
  const meshAttach = (out: ReturnType<typeof evaluateDecal>) => {
    const c = out.children;
    if (!c || c.kind !== 'Structure' || !c.value.attachments) throw new Error('no attachments');
    return c.value.attachments;
  };

  it('Decoration is gone from the registry', () => {
    expect(getNodeDef('generator.decoration')).toBeUndefined();
  });

  it('pure shape: normalised, counter-clockwise, refined and border distance 0 on the outline', () => {
    const c = diamond();
    const shape = cutoutShape(c, 0, 0.3, 0.3, 12, 12)!;
    expect(shape).not.toBeNull();
    expect(shape.grid).toBe(false);
    expect(shape.indices.length / 3).toBeLessThanOrEqual(MAX_SHAPE_TRIANGLES);
    expect(shape.indices.length / 3).toBeGreaterThan(gridShape(2, 2).indices.length / 3);
    for (let i = 0; i < shape.count; i++) {
      expect(shape.a[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(shape.a[i]).toBeLessThanOrEqual(1 + 1e-6);
      expect(shape.b[i]).toBeGreaterThanOrEqual(-1e-6);
      expect(shape.b[i]).toBeLessThanOrEqual(1 + 1e-6);
    }
    for (let t = 0; t < shape.indices.length; t += 3) {
      const [i, j, k] = [shape.indices[t] as number, shape.indices[t + 1] as number, shape.indices[t + 2] as number];
      const ar = ((shape.a[j] as number) - (shape.a[i] as number)) * ((shape.b[k] as number) - (shape.b[i] as number)) - ((shape.a[k] as number) - (shape.a[i] as number)) * ((shape.b[j] as number) - (shape.b[i] as number));
      expect(ar).toBeGreaterThanOrEqual(0);
    }
    expect(Math.min(...shape.edge)).toBe(0);
    expect(Math.max(...shape.edge)).toBeGreaterThan(0.1);
    // the diamond leaves the corners of its bounding box empty
    for (let i = 0; i < shape.count; i++) expect(Math.hypot(shape.a[i] as number, shape.b[i] as number)).toBeGreaterThan(0.2);
    expect(shape.anchors).toHaveLength(1);
  });

  it('Decal: the patch has the cutout outline, lies on the skin and the height stays bounded and 0 on the border', () => {
    heightMaterial([diamond()]);
    const run = (rows: unknown, h = 0) => {
      const p = paramsOf('generator.decal', { number: 4, decalOffset: 0.003, decalHeight: h, decalSize: 0.3, decalRandomRotation: 0, leafTypes: rows });
      p.decalHeight = { ...(p.decalHeight as NodeParams[string]), variance: 0 };
      return evaluateDecal(ctx(), inputs(plainTrunk()), p);
    };
    const flat = meshOf(run(CUTOUT_ROW));
    expect(flat.positions.length).toBeGreaterThan(0);
    for (let i = 0; i < flat.positions.length / 3; i++) expect(Math.abs(axisDistance(flat, i) - (RADIUS + 0.003))).toBeLessThan(1e-4);
    const grid = meshOf(run([{ material: 'relief', mesh: 'none', weight: 1 }]));
    const area = (m: MeshData): number => {
      let sum = 0;
      for (let t = 0; t + 2 < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t] as number, m.indices[t + 1] as number, m.indices[t + 2] as number];
        const e1 = [0, 1, 2].map((q) => (m.positions[b * 3 + q] as number) - (m.positions[a * 3 + q] as number));
        const e2 = [0, 1, 2].map((q) => (m.positions[c * 3 + q] as number) - (m.positions[a * 3 + q] as number));
        sum += Math.hypot((e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number), (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number), (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number)) / 2;
      }
      return sum;
    };
    expect(area(flat)).toBeLessThan(area(grid) * 0.8);
    const up = meshOf(run(CUTOUT_ROW, 0.04));
    let hi = -Infinity;
    for (let i = 0; i < up.positions.length / 3; i++) hi = Math.max(hi, axisDistance(up, i) - (RADIUS + 0.003));
    expect(hi).toBeLessThanOrEqual(0.04 + 1e-4);
    expect(hi).toBeGreaterThan(0.005);
    // determinism
    expect(Array.from(meshOf(run(CUTOUT_ROW, 0.04)).positions)).toEqual(Array.from(up.positions));
  });

  it('Decal: cutout anchors are exported on the patch and a child can use them', () => {
    heightMaterial([diamond()]);
    const out = evaluateDecal(ctx(), inputs(plainTrunk()), paramsOf('generator.decal', { number: 3, decalSize: 0.3, decalHeight: 0, leafTypes: CUTOUT_ROW }));
    const att = meshAttach(out);
    expect(att.instanceCount).toBe(3);
    for (let r = 0; r < att.instanceCount; r++) {
      const frames = attachmentFramesOf(att, r);
      expect(frames).toHaveLength(1);
      expect(Math.abs(Math.hypot(frames[0]!.position[0], frames[0]!.position[1]) - (RADIUS + 0.002))).toBeLessThan(5e-3);
    }
  });

  it('Fin: base vertices (t = 0) lie on the skin with fold / curl / noise, the wind at the base equals the parent, the tip leaves the bark', () => {
    heightMaterial([diamond()]);
    const sk = plainTrunk();
    for (const [id, f] of [['wind0', 0.3], ['wind1', 0.5], ['wind2', 0.2], ['windPhase', 0.4], ['windPhase1', 0.4]] as const) sk.attributes.set(id, new Float32Array(sk.count).fill(f));
    const out = evaluateFin(ctx(), inputs(sk), paramsOf('generator.fin', { number: 4, finSize: 0.3, finWidth: 0.25, finFold: 40, finCurl: 90, finVertexAmount: 0.02, finRipple: 1, leafTypes: CUTOUT_ROW }));
    const m = meshOf(out);
    const n = m.positions.length / 3;
    let atBase = 0;
    let far = 0;
    const w = m.wind!.weights;
    for (let i = 0; i < n; i++) {
      const d = axisDistance(m, i);
      if (Math.abs(d - RADIUS) < 1e-4) {
        atBase++;
        expect(w[i * 4 + 2] as number).toBeCloseTo(0.2, 5);
      }
      if (d > RADIUS + 0.05) far++;
      expect(w[i * 4 + 2] as number).toBeLessThanOrEqual(1 + 1e-6);
      expect(w[i * 4] as number).toBeCloseTo(0.3, 5);
    }
    expect(atBase).toBeGreaterThanOrEqual(4); // a diamond touches the bark in a single point per fin
    expect(far).toBeGreaterThan(0);
    const att = meshAttach(out);
    expect(att.instanceCount).toBe(4);
    expect(attachmentFramesOf(att, 0)).toHaveLength(1);
    // the diamond is narrower at the base than a grid fin (tight outline)
    const grid = meshOf(evaluateFin(ctx(), inputs(sk), paramsOf('generator.fin', { number: 4, finSize: 0.3, finWidth: 0.25, leafTypes: [{ material: 'relief', mesh: 'none', weight: 1 }] })));
    expect(m.positions.length).not.toBe(grid.positions.length);
  });

  it('LOD: a cutout decal and fin still build at LOD 3 with fewer triangles', () => {
    heightMaterial([diamond()]);
    for (const [type, fn] of [['generator.decal', evaluateDecal], ['generator.fin', evaluateFin]] as const) {
      const tris = (lod: number): number => meshOf(fn(ctx(lod), inputs(plainTrunk()), paramsOf(type, { number: 4, leafTypes: CUTOUT_ROW }))).indices.length / 3;
      expect(tris(3)).toBeGreaterThan(0);
      expect(tris(3)).toBeLessThanOrEqual(tris(0));
    }
  });
});

describe('retired Decoration nodes in old projects', () => {
  it('are removed and their children are re-attached to the decoration parent', () => {
    const e = (id: string, from: string, to: string) => ({ id, kind: 'hierarchy' as const, from: { nodeId: from, portId: 'children' }, to: { nodeId: to, portId: 'parent' } });
    const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, enabled: true, params: {} });
    const graph = { nodes: [node('t', 'generator.trunk'), node('d', 'generator.decoration'), node('l', 'generator.leaf')], edges: [e('e1', 't', 'd'), e('e2', 'd', 'l')] };
    const out = removeRetiredNodes(graph);
    expect(out.nodes.map((n) => n.id)).toEqual(['t', 'l']);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]!.from.nodeId).toBe('t');
    expect(out.edges[0]!.to.nodeId).toBe('l');
    expect(migrateGraphNodes(graph, undefined).nodes.map((n) => n.id)).toEqual(['t', 'l']);
    expect(removeRetiredNodes({ nodes: [node('t', 'generator.trunk')], edges: [] })).toEqual({ nodes: [node('t', 'generator.trunk')], edges: [] });
  });
});
