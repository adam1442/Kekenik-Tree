import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { SkeletonBuilder, emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import {
  CROTCH_SEAM_BASE,
  DEFAULT_SPLIT_SETTINGS,
  EXTENSION_ATTR,
  buildCrotchMesh,
  crotchSeamAmount,
  crotchSeamWeight,
  crotchVertexIndex,
  extensionBlendValue,
  planSplit,
  splitHalfMapping,
} from '@/generators/split';
import { buildTubeMesh, type TubeOptions } from '@/geometry/tubeMesher';
import { mergeToPlantGeometry } from '@/export/geometry';
import { readGlbJson, writeGltf } from '@/export/writers/gltf';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const DEG = 180 / Math.PI;
const run = (specs: NodeSpec[], seed = 1, lod = 0) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

const TRUNK = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const graph = (extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, capEnd: false, capBase: 'no', ...extra } as NodeSpec['params'] },
];

const angleDeg = (m: MeshData, a: number, b: number): number => {
  const d = m.normals[a * 3]! * m.normals[b * 3]! + m.normals[a * 3 + 1]! * m.normals[b * 3 + 1]! + m.normals[a * 3 + 2]! * m.normals[b * 3 + 2]!;
  return Math.acos(Math.min(1, Math.max(-1, d))) * DEG;
};

interface Edge {
  a: number;
  b: number;
  du: number;
  dv: number;
  dz: number;
  length: number;
}

/** Unique triangle edges with their UV / height steps. */
function edgesOf(m: MeshData): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = m.indices[t + e]!;
      const b = m.indices[t + ((e + 1) % 3)]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        a,
        b,
        du: Math.abs(m.uv0[b * 2]! - m.uv0[a * 2]!),
        dv: m.uv0[b * 2 + 1]! - m.uv0[a * 2 + 1]!,
        dz: m.positions[b * 3 + 2]! - m.positions[a * 3 + 2]!,
        length: Math.hypot(m.positions[b * 3]! - m.positions[a * 3]!, m.positions[b * 3 + 1]! - m.positions[a * 3 + 1]!, m.positions[b * 3 + 2]! - m.positions[a * 3 + 2]!),
      });
    }
  }
  return out;
}

/** Edges that run along the branch (same U on both ends, V changes). */
const axial = (list: Edge[]): Edge[] => list.filter((e) => e.du < 1e-6 && Math.abs(e.dv) > 1e-9 && Math.abs(e.dz) > 1e-3);

describe('crotch shading helpers (pure)', () => {
  it('seam weight falls off monotonically, reaches 0 at the open ends and the base amount applies', () => {
    let prev = Infinity;
    for (let d = 0; d <= 3; d += 0.1) {
      const w = crotchSeamWeight(d, 0.5, 0.5);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    expect(crotchSeamWeight(0, 0.5, 0.5)).toBeCloseTo(0.5, 9);
    expect(crotchSeamWeight(1.75, 0.5, 0.5, 1.75)).toBeCloseTo(0, 9);
    expect(crotchSeamWeight(0.2, 0.5, 0)).toBe(0);
    // falloff of about 1.5 parent radii: e^-1 at 1.5 R
    expect(crotchSeamWeight(0.75, 0.5, 1)).toBeCloseTo(Math.exp(-1), 6);
    expect(crotchSeamAmount(0)).toBe(CROTCH_SEAM_BASE);
    expect(crotchSeamAmount(0.8)).toBe(0.8);
    expect(crotchSeamAmount(Number.NaN)).toBe(CROTCH_SEAM_BASE);
  });

  it('each half gets half of the parent U tiles and starts where its outline column starts', () => {
    expect(splitHalfMapping(4, 0.25, 0, 16, 1)).toEqual({ uTiles: 2, uStart: 0.25 });
    expect(splitHalfMapping(4, 0.25, 0, 16, 2)).toEqual({ uTiles: 2, uStart: 2.25 });
    expect(splitHalfMapping(4, 0, 4, 16, 1)?.uStart).toBeCloseTo(1, 12);
    expect(splitHalfMapping(3, 0, 0, 16, 1)).toBeNull();
    expect(splitHalfMapping(1, 0, 0, 16, 1)).toBeNull();
    const a = splitHalfMapping(6, 0, 0, 12, 1)!;
    const b = splitHalfMapping(6, 0, 0, 12, 2)!;
    expect(a.uTiles + b.uTiles).toBe(6);
  });

  it('the extension blend ramps 0 -> 1 monotonically over the blend length', () => {
    const r = 0.4;
    for (const length of [0.5, 2, 8]) {
      let prev = -1;
      for (let i = 0; i <= 40; i++) {
        const s = (i / 40) * length * r * 1.5;
        const v = extensionBlendValue(s, 0, r, length);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
      expect(extensionBlendValue(0, 0, r, length)).toBe(0);
      expect(extensionBlendValue(length * r, 0, r, length)).toBeCloseTo(1, 9);
      expect(extensionBlendValue(length * r * 3, 0, r, length)).toBe(1);
    }
  });
});

describe('crotch normals (pure)', () => {
  const R = 0.5;
  function mesh(inner: number): ReturnType<typeof buildCrotchMesh> {
    const p = planSplit({
      end: { position: [0, 0, 2], tangent: [0, 0, 1], up: [1, 0, 0], radius: R },
      parentLength: 2,
      settings: { ...DEFAULT_SPLIT_SETTINGS },
      ringSpacing: 0.1,
      rng: new Rng(11).fork('splits0'),
      chance: 1,
      parentTiles: 4,
      axisStart: { position: [0, 0, 2 - R * 3.5], tangent: [0, 0, 1] },
      treeAxis: [3, 0, 0],
    });
    if (!p) throw new Error('plan expected');
    const [l1, l2] = p.lobes;
    return buildCrotchMesh({
      sides: 16,
      rings: l1.ringCount,
      centre1: l1.positions,
      centre2: l2.positions,
      radius0: R,
      radius1: l1.radius,
      radius2: l2.radius,
      startTangent: [0, 0, 1],
      endTangent1: l1.endTangent,
      endTangent2: l2.endTangent,
      divergence: p.divergence,
      innerSmooth: inner,
    });
  }

  it('Inner = 1 averages fully (no fans except the merged crotch vertex), Inner = 0 splits the pinch normals', () => {
    const smooth = mesh(1);
    const crisp = mesh(0);
    const c = crotchVertexIndex(16, smooth.rings, smooth.rings - 1, 0);
    for (let t = 0; t < smooth.indices.length; t++) {
      if (smooth.indices[t] !== c) expect(smooth.cornerFan[t]).toBe(0);
      else expect(smooth.cornerFan[t]).toBeGreaterThan(0);
    }
    const cCrisp = crotchVertexIndex(16, crisp.rings, crisp.rings - 1, 0);
    const creased = Array.from(crisp.cornerFan).filter((f, t) => f > 0 && crisp.indices[t] !== cCrisp);
    expect(creased.length).toBeGreaterThan(0);
  });

  it('every corner normal is finite and unit length, and the mesh is deterministic', () => {
    for (const inner of [0, 0.5, 1]) {
      const m = mesh(inner);
      for (let t = 0; t < m.indices.length; t++) {
        const l = Math.hypot(m.cornerNormals[t * 3]!, m.cornerNormals[t * 3 + 1]!, m.cornerNormals[t * 3 + 2]!);
        expect(Number.isFinite(l)).toBe(true);
        expect(l).toBeCloseTo(1, 4);
      }
    }
    expect(Array.from(mesh(0.5).cornerNormals)).toEqual(Array.from(mesh(0.5).cornerNormals));
  });

  it('the open-end ring has unit normals everywhere', () => {
    const m = mesh(1);
    const last = m.rings - 1;
    for (let j = 1; j < 16; j++) {
      if (j === 8) continue;
      const v = crotchVertexIndex(16, m.rings, last, j) * 3;
      expect(Math.hypot(m.normals[v]!, m.normals[v + 1]!, m.normals[v + 2]!)).toBeCloseTo(1, 4);
    }
  });
});

describe('split junction mesh (normals, UV, hygiene)', () => {
  it('normals are continuous across s = 0 and across the transition (crease only for Inner = 0)', async () => {
    for (const inner of [0, 1]) {
      const r = await run(graph({ splitsChance: 1, splitsSmoothInner: inner }));
      const m = meshOf(r, 'trunk');
      const sk = skeletonOf(r, 'trunk');
      // plane of the transition start: through the first point of the lobes, normal = the parent's direction there
      const l1 = sk.branches[1]!;
      const p0 = [sk.position[l1.start * 3]!, sk.position[l1.start * 3 + 1]!, sk.position[l1.start * 3 + 2]!];
      const dir = [sk.position[l1.start * 3 + 3]! - p0[0]!, sk.position[l1.start * 3 + 4]! - p0[1]!, sk.position[l1.start * 3 + 5]! - p0[2]!];
      const dl = Math.hypot(dir[0]!, dir[1]!, dir[2]!);
      const dist = (i: number): number => ((m.positions[i * 3]! - p0[0]!) * dir[0]! + (m.positions[i * 3 + 1]! - p0[1]!) * dir[1]! + (m.positions[i * 3 + 2]! - p0[2]!) * dir[2]!) / dl;
      const list = axial(edgesOf(m));
      // rings straddling the start of the transition: the ring on the plane and the parent ring below it
      const pre = list.filter((e) => {
        const hi = dist(e.a) > dist(e.b) ? e.a : e.b;
        const lo = hi === e.a ? e.b : e.a;
        return Math.abs(dist(hi)) < 0.02 && dist(lo) < -0.02;
      });
      expect(pre.length).toBeGreaterThan(4);
      for (const e of pre) expect(angleDeg(m, e.a, e.b)).toBeLessThan(3);
      // duplicated vertices (A / B / C fans) are the only places a crease may live
      const posKey = (i: number): string => [0, 1, 2].map((a) => Math.round(m.positions[i * 3 + a]! * 1e5)).join(',');
      const counts = new Map<string, number>();
      for (let i = 0; i < m.positions.length / 3; i++) counts.set(posKey(i), (counts.get(posKey(i)) ?? 0) + 1);
      let worst = 0;
      for (const e of edgesOf(m)) {
        if (e.du > 1e-6 || Math.abs(e.dz) < 1e-3) continue;
        const touchesFan = (counts.get(posKey(e.a)) ?? 1) > 1 || (counts.get(posKey(e.b)) ?? 1) > 1;
        if (inner === 0 && touchesFan) continue;
        worst = Math.max(worst, angleDeg(m, e.a, e.b));
      }
      expect(worst).toBeLessThan(25);
    }
  });

  it('Inner = 0 keeps a crisper crease than Inner = 1', async () => {
    const maxCrease = async (inner: number): Promise<number> => {
      const m = meshOf(await run(graph({ splitsChance: 1, splitsSmoothInner: inner })), 'trunk');
      let worst = 0;
      for (const e of edgesOf(m)) if (e.du < 1e-6 && Math.abs(e.dz) > 1e-3) worst = Math.max(worst, angleDeg(m, e.a, e.b));
      return worst;
    };
    expect(await maxCrease(0)).toBeGreaterThan(await maxCrease(1));
  });

  it('no two vertices share a position, UV and normal (only the UV seam and the A / B / C fans are duplicated)', async () => {
    for (const inner of [0, 1]) {
      const m = meshOf(await run(graph({ splitsChance: 1, splitsSmoothInner: inner })), 'trunk');
      const seen = new Set<string>();
      const posCount = new Map<string, number>();
      for (let i = 0; i < m.positions.length / 3; i++) {
        const p = [0, 1, 2].map((a) => Math.round(m.positions[i * 3 + a]! * 1e5)).join(',');
        const full = `${p}|${Math.round(m.uv0[i * 2]! * 1e4)},${Math.round(m.uv0[i * 2 + 1]! * 1e4)}|${[0, 1, 2].map((a) => Math.round(m.normals[i * 3 + a]! * 1e3)).join(',')}`;
        expect(seen.has(full)).toBe(false);
        seen.add(full);
        posCount.set(p, (posCount.get(p) ?? 0) + 1);
      }
      let dupPositions = 0;
      for (const c of posCount.values()) if (c > 1) dupPositions++;
      // UV seam: one column per ring; fans: at most a few per ring row -> far below half of the positions
      expect(dupPositions).toBeLessThan(posCount.size / 2);
    }
  });

  it('UV: U is constant along the branch, V is monotonic and has no jump at the first child ring', async () => {
    const m = meshOf(await run(graph({ splitsChance: 1, splitsSmoothInner: 1 })), 'trunk');
    const list = edgesOf(m);
    const along = axial(list);
    expect(along.length).toBeGreaterThan(50);
    // every non-ring edge either keeps U (axial) or steps by one column (diagonal): nothing in between
    const ringSteps = list.filter((e) => Math.abs(e.dv) < 1e-9 && e.du > 1e-9).map((e) => e.du);
    const step = Math.min(...ringSteps);
    for (const e of list) {
      if (Math.abs(e.dv) < 1e-9) continue;
      expect(e.du < 1e-6 || e.du > 0.5 * step).toBe(true);
    }
    // V grows with the height along the shared axis; no edge turns V back
    for (const e of along) expect(Math.sign(e.dv * e.dz)).toBe(Math.sign(along[0]!.dv * along[0]!.dz));
    // density = V per metre of the axial edges: no ring pair is more than 1.5 x the average
    const density = along.map((e) => Math.abs(e.dv) / e.length);
    const avg = density.reduce((s, d) => s + d, 0) / density.length;
    expect(Math.max(...density)).toBeLessThan(1.5 * avg);
  });

  it('is clean for VFX: finite attributes, valid indices, no degenerate triangles, correct bounds, vertex budget', async () => {
    const r = await run(graph({ splitsChance: 1, splitsSmoothInner: 0.5 }));
    const m = meshOf(r, 'trunk');
    const n = m.positions.length / 3;
    for (const arr of [m.positions, m.normals, m.uv0, m.tangents ?? new Float32Array(0), m.colors ?? new Float32Array(0)]) {
      for (const v of arr) expect(Number.isFinite(v)).toBe(true);
    }
    for (const i of m.indices) expect(i).toBeLessThan(n);
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = m.indices[t]! * 3, b = m.indices[t + 1]! * 3, c = m.indices[t + 2]! * 3;
      const e1 = [m.positions[b]! - m.positions[a]!, m.positions[b + 1]! - m.positions[a + 1]!, m.positions[b + 2]! - m.positions[a + 2]!];
      const e2 = [m.positions[c]! - m.positions[a]!, m.positions[c + 1]! - m.positions[a + 1]!, m.positions[c + 2]! - m.positions[a + 2]!];
      const area = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
      expect(area).toBeGreaterThan(1e-12);
    }
    for (let i = 0; i < n; i++) expect(Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!)).toBeGreaterThan(0.99);
    // the open ends are inside the bounding box of the mesh
    const sk = skeletonOf(r, 'trunk');
    for (const lobe of sk.branches.slice(1)) {
      const e = (lobe.start + lobe.count - 1) * 3;
      for (let a = 0; a < 3; a++) {
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) {
          lo = Math.min(lo, m.positions[i * 3 + a]!);
          hi = Math.max(hi, m.positions[i * 3 + a]!);
        }
        expect(sk.position[e + a]!).toBeGreaterThan(lo);
        expect(sk.position[e + a]!).toBeLessThan(hi + 1e-3);
      }
    }
    // vertex budget: the old split (parent + two full lobe tubes) is the reference
    const plain = meshOf(await run(graph({ splitsChance: 0 })), 'trunk');
    let zMin = Infinity;
    for (let i = 0; i < n; i++) zMin = Math.min(zMin, m.positions[i * 3 + 2]!);
    let ring = 0;
    for (let i = 0; i < n; i++) if (m.positions[i * 3 + 2]! - zMin < 1e-4) ring++;
    const lobeRings = sk.branches[1]!.count;
    expect(n).toBeLessThanOrEqual(1.25 * (plain.positions.length / 3 + 2 * lobeRings * ring));
  });

  it('works at every LOD and stays deterministic', async () => {
    for (const lod of [0, 1, 2, 3]) {
      const a = meshOf(await run(graph({ splitsChance: 1 }), 1, lod), 'trunk');
      const b = meshOf(await run(graph({ splitsChance: 1 }), 1, lod), 'trunk');
      expect(a.indices.length).toBeGreaterThan(0);
      expect(Array.from(b.normals)).toEqual(Array.from(a.normals));
      expect(Array.from(b.uv0)).toEqual(Array.from(a.uv0));
      for (const v of a.normals) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('the halves store half of the parent U tiles and the V of the open end on the lobe points (extensions continue them)', async () => {
    const sk = skeletonOf(await run(graph({ splitsChance: 1 })), 'trunk');
    const tiles = sk.attributes.get('uvTiles')!;
    const vv = sk.attributes.get('uvV')!;
    const parent = sk.branches[0]!;
    const l1 = sk.branches[1]!;
    const l2 = sk.branches[2]!;
    const pt = tiles[parent.start]!;
    expect(pt % 2).toBe(0);
    expect(tiles[l1.start + l1.count - 1]).toBe(pt / 2);
    expect(tiles[l2.start + l2.count - 1]).toBe(pt / 2);
    expect(vv[l1.start + l1.count - 1]).toBeCloseTo(vv[l2.start + l2.count - 1]!, 6);
    expect(vv[l1.start + l1.count - 1]!).toBeGreaterThan(vv[parent.start + parent.count - 1]!);
  });
});

describe('extension material blend', () => {
  /** A straight trunk with one extension that continues its last point. */
  function skeleton(): Skeleton {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i < 6; i++) sb.addPoint(0, 0, i * 0.2, 0.25);
    sb.endBranch();
    sb.beginBranch(0, 5, 0);
    for (let i = 0; i < 14; i++) sb.addPoint(0, 0, 1 + i * 0.1, 0.25);
    sb.endBranch();
    const sk = sb.build();
    const ext = new Float32Array(sk.count);
    for (const b of sk.branches.slice(1)) for (let k = 0; k < b.count; k++) ext[b.start + k] = 1;
    sk.attributes.set(EXTENSION_ATTR, ext);
    return sk;
  }
  const options = (extensionMaterial: string, over: Partial<TubeOptions> = {}): TubeOptions => ({
    maxGeneration: 8,
    radialSegments: () => 8,
    color: () => [0.2, 0.15, 0.1],
    uvMetres: 1,
    materialId: 'bark',
    capEnd: false,
    uvMaterials: {
      branchRows: [{ material: 'bark', weight: 1, uvArea: 'whole', placement: 'anywhere' }],
      extensionRows: [{ material: extensionMaterial, weight: 1, uvArea: 'whole', placement: 'anywhere' }],
      areas: [],
      resolve: (ref) => ref,
    },
    extensionBlend: { length: 2, contrast: 0.4, noise: 0.3 },
    ...over,
  });

  it('is 0 (no channel at all) for an inherited or equal extension material', () => {
    expect(buildTubeMesh(skeleton(), options('inherited')).weld).toBeUndefined();
    expect(buildTubeMesh(skeleton(), options('bark')).weld).toBeUndefined();
    const noOptions: TubeOptions = options('mat-ext');
    delete noOptions.extensionBlend;
    expect(buildTubeMesh(skeleton(), noOptions).weld).toBeUndefined();
    expect(buildTubeMesh(skeleton(), options('mat-ext')).weld).toBeDefined();
  });

  it('ramps 0 -> 1 monotonically over the blend length for a different material', () => {
    for (const length of [1, 2, 4]) {
      const m = buildTubeMesh(skeleton(), options('mat-ext', { extensionBlend: { length, contrast: 0.4, noise: 0.3 } }));
      const w = m.weld!;
      const n = m.positions.length / 3;
      const rows = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const z = Math.round(m.positions[i * 3 + 2]! * 1e4);
        if (z < 10000) continue;
        rows.set(z, Math.max(rows.get(z) ?? 0, w.blend[i]!));
      }
      const sorted = [...rows.entries()].sort((a, b) => a[0] - b[0]);
      const ordered = sorted.map((e) => e[1]);
      expect(ordered[0]).toBeCloseTo(0, 6);
      for (let i = 1; i < ordered.length; i++) expect(ordered[i]!).toBeGreaterThanOrEqual(ordered[i - 1]! - 1e-7);
      // the ramp ends after `length` parent radii (0.25 m each); the last ring of the 1.3 m extension is 1 when the ramp fits
      const endZ = sorted.find((e) => e[1] > 0.999)?.[0];
      if (length * 0.25 < 1.3) {
        expect(endZ).toBeDefined();
        expect(endZ! / 1e4 - 1).toBeLessThan(length * 0.25 + 0.11);
        expect(ordered[ordered.length - 1]).toBe(1);
      }
      // trunk vertices are untouched
      for (let i = 0; i < n; i++) if (m.positions[i * 3 + 2]! < 0.99) expect(w.style[i * 3 + 2]).toBe(0);
    }
  });

  it('writes contrast and noise, and is deterministic', () => {
    const a = buildTubeMesh(skeleton(), options('mat-ext'));
    const b = buildTubeMesh(skeleton(), options('mat-ext'));
    expect(Array.from(b.weld!.blend)).toEqual(Array.from(a.weld!.blend));
    expect(Array.from(b.weld!.style)).toEqual(Array.from(a.weld!.style));
    const active = Array.from({ length: a.positions.length / 3 }, (_, i) => i).filter((i) => a.weld!.style[i * 3 + 2]! > 0);
    expect(active.length).toBeGreaterThan(0);
    for (const i of active) {
      expect(a.weld!.style[i * 3]).toBeCloseTo(0.4, 6);
      expect(a.weld!.style[i * 3 + 1]).toBeCloseTo(0.3, 6);
    }
  });

  it('is exported as _BLEND (custom attributes on) and survives the export merge', () => {
    const m = buildTubeMesh(skeleton(), options('mat-ext'));
    const g = mergeToPlantGeometry('Plant', [m]);
    expect(g.blend).toBeDefined();
    expect(g.blend!.length).toBe(m.positions.length / 3);
    const mat = (name: string) => ({ name, baseColorFactor: [1, 1, 1, 1] as [number, number, number, number], metallicFactor: 0, roughnessFactor: 1, alphaMode: 'OPAQUE' as const, alphaCutoff: 0.5, doubleSided: true });
    const scene = { name: 's', images: [], materials: [mat('Bark'), mat('Ext')], materialIndex: new Map([['bark', 0], ['mat-ext', 1]]), nodes: [{ name: 'Plant_LOD0', geometry: g }] };
    type J = { meshes: { primitives: { attributes: Record<string, number> }[] }[] };
    const on = writeGltf(scene, { binary: true, customAttributes: true, vertexColors: false, baseName: 'p' });
    expect((readGlbJson(on.files[0]!.data as Uint8Array).json as unknown as J).meshes[0]!.primitives[0]!.attributes._BLEND).toBeDefined();
    const off = writeGltf(scene, { binary: true, customAttributes: false, vertexColors: false, baseName: 'p' });
    expect((readGlbJson(off.files[0]!.data as Uint8Array).json as unknown as J).meshes[0]!.primitives[0]!.attributes._BLEND).toBeUndefined();
  });

  it('the Branch node exposes Blend length / Contrast / Noise under Skin > Extensions', () => {
    const defs = getNodeDef('generator.branch')!.params.filter((p) => p.group === 'Skin' && p.subgroup === 'Extensions');
    const byId = new Map(defs.map((d) => [d.id, d]));
    expect(byId.get('extensionBlendLength')).toMatchObject({ label: 'Blend length', min: 0.5, max: 8, default: 2 });
    expect(byId.get('extensionBlendContrast')).toMatchObject({ label: 'Contrast', min: 0, max: 1 });
    expect(byId.get('extensionBlendNoise')).toMatchObject({ label: 'Noise', min: 0, max: 1 });
  });
});
