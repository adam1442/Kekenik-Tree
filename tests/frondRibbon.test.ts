import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { V3 } from '@/geometry/math3';
import { buildRibbonFrames, buildRibbonMesh, DEFAULT_RIBBON_OPTIONS, type RibbonSpec } from '@/geometry/ribbonMesher';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { migrateFrondParams, tryInstance, trimPolyline } from '@/nodes/generators/frond';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const spec = (over: Partial<RibbonSpec> = {}, path?: V3[]): RibbonSpec => ({
  path: path ?? [
    [0, 0, 0],
    [0, 0, 0.5],
    [0.1, 0, 1],
    [0.3, 0, 1.4],
  ],
  normalHint: [0, 1, 0],
  width: 0.2,
  baseWidth: 1,
  tipShape: 'pointed',
  tipTaper: 0.3,
  shape: 'flat',
  foldAngle: 0.7,
  curl: 0,
  crease: 0,
  roll: 0,
  twist: 0,
  droop: 0,
  arch: 0,
  offset: 0,
  color: [0.2, 0.4, 0.1],
  colorGradient: 0,
  ao: 0.5,
  atlas: [0, 0, 1, 1],
  materialId: 'leaf',
  wind: [0, 0.2, 0.3, 0.4],
  windPower: 1.5,
  ...over,
});

const polyLen = (p: V3[]): number => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i]![0], q[1] - p[i]![1], q[2] - p[i]![2]), 0);

describe('ribbon mesher', () => {
  it('has (segments + 1) x (width segments + 1) vertices and 2 triangles per quad', () => {
    const { mesh } = buildRibbonMesh([spec()], { lengthSegments: 6, widthSegments: 3 });
    expect(mesh.positions.length / 3).toBe(7 * 4);
    expect(mesh.indices.length / 3).toBe(6 * 3 * 2);
    for (const v of [...mesh.positions, ...mesh.normals, ...mesh.uv0]) expect(Number.isFinite(v)).toBe(true);
  });

  it('is connected (every index used, no degenerate or flipped quads) and faces the requested side', () => {
    const { mesh } = buildRibbonMesh([spec()], { lengthSegments: 8, widthSegments: 2 });
    const used = new Set(mesh.indices);
    expect(used.size).toBe(mesh.positions.length / 3);
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t]!, mesh.indices[t + 1]!, mesh.indices[t + 2]!];
      const e1 = [0, 1, 2].map((k) => mesh.positions[b * 3 + k]! - mesh.positions[a * 3 + k]!);
      const e2 = [0, 1, 2].map((k) => mesh.positions[c * 3 + k]! - mesh.positions[a * 3 + k]!);
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const area = Math.hypot(n[0]!, n[1]!, n[2]!);
      expect(area).toBeGreaterThan(0);
      // Geometric normal agrees with the stored vertex normal (no flipped triangles).
      const vn = [0, 1, 2].map((k) => mesh.normals[a * 3 + k]!);
      expect(n[0]! * vn[0]! + n[1]! * vn[1]! + n[2]! * vn[2]!).toBeGreaterThan(0);
    }
    // Facing hint +Y: the normals look toward +Y.
    expect(mesh.normals[1]!).toBeGreaterThan(0.9);
  });

  it('V runs monotonically along the length and U covers 0..1 across the width', () => {
    const { mesh } = buildRibbonMesh([spec()], { lengthSegments: 7, widthSegments: 2 });
    const C = 3;
    for (let i = 1; i < 8; i++) expect(mesh.uv0[i * C * 2 + 1]!).toBeGreaterThan(mesh.uv0[(i - 1) * C * 2 + 1]!);
    expect(mesh.uv0[0]).toBeCloseTo(0);
    expect(mesh.uv0[(C - 1) * 2]).toBeCloseTo(1);
  });

  it('world-length tiling gives V = length / tile', () => {
    const s = spec();
    const { mesh, frames } = buildRibbonMesh([s], { lengthSegments: 4, widthSegments: 1, uvMode: 'tile', uvTile: 0.5 });
    const last = mesh.uv0[(4 * 2 + 0) * 2 + 1]!;
    expect(last).toBeCloseTo(frames[0]!.length / 0.5, 4);
  });

  it('bounding box follows the spine length (droop and arch preserve length)', () => {
    for (const bend of [{}, { droop: 0.8, arch: 0.6 }]) {
      const fr = buildRibbonFrames(spec(bend), { lengthSegments: 12, adaptive: true })!;
      expect(polyLen(fr.points)).toBeCloseTo(fr.length, 4);
      expect(fr.length).toBeCloseTo(polyLen(spec().path), 1);
    }
    const flat = buildRibbonFrames(spec(), { lengthSegments: 6, adaptive: false })!;
    expect(flat.points[0]).toEqual([0, 0, 0]);
  });

  it('cross-section shapes use >= 2 width segments and lift the edges', () => {
    const { mesh } = buildRibbonMesh([spec({ shape: 'vfold', foldAngle: 0.8 })], { lengthSegments: 2, widthSegments: 1 });
    expect(mesh.positions.length / 3).toBe(3 * 3);
    const edgeY = mesh.positions[1]!;
    const midY = mesh.positions[4]!;
    expect(edgeY).toBeGreaterThan(midY);
  });

  it('duplicates flipped back faces and is deterministic', () => {
    const one = buildRibbonMesh([spec()], { ...DEFAULT_RIBBON_OPTIONS, duplicateBackFaces: true }).mesh;
    const two = buildRibbonMesh([spec()], { ...DEFAULT_RIBBON_OPTIONS, duplicateBackFaces: true }).mesh;
    expect(one.indices.length).toBe(2 * buildRibbonMesh([spec()]).mesh.indices.length);
    expect(Array.from(one.positions)).toEqual(Array.from(two.positions));
    const n = one.positions.length / 3 / 2;
    expect(one.normals[n * 3 + 1]!).toBeCloseTo(-one.normals[1]!, 6);
  });

  it('meshes 5000 blades x 6 segments quickly and groups materials into contiguous slots', () => {
    const specs = Array.from({ length: 5000 }, (_, i) => spec({ materialId: i % 2 ? 'a' : 'b' }, [[i * 0.01, 0, 0], [i * 0.01, 0.05, 0.4], [i * 0.01, 0.2, 0.8]]));
    const t0 = performance.now();
    const { mesh } = buildRibbonMesh(specs, { lengthSegments: 6 });
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(mesh.slots.map((s) => s.materialId).sort()).toEqual(['a', 'b']);
    expect(mesh.slots.reduce((s, x) => s + x.indexCount, 0)).toBe(mesh.indices.length);
  });

  it('instances identical blades and refuses different ones', () => {
    const mk = (x: number, y = 0.5): RibbonSpec => spec({}, [[x, 0, 0], [x, 0, y], [x + 0.1, 0, y * 2]]);
    const same = tryInstance([mk(0), mk(1), mk(2)], { ...DEFAULT_RIBBON_OPTIONS, lengthSegments: 4 });
    expect(same?.instanced?.count).toBe(3);
    expect(tryInstance([mk(0), mk(1, 0.9)], { ...DEFAULT_RIBBON_OPTIONS, lengthSegments: 4 })).toBeNull();
  });
});

describe('Frond node', () => {
  const run = (specs: NodeSpec[], lod = 0) => new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed: 1, lod, token: new CancellationSource().token });
  const graph = (spineNumber: number, frond: NodeSpec['params'] = {}): NodeSpec[] => [
    { id: 'tree', type: 'output.tree', parent: null },
    { id: 'spine', type: 'generator.spine', parent: 'tree', params: { number: spineNumber, noiseAmount: 0 } },
    { id: 'frond', type: 'generator.frond', parent: 'spine', params: frond ?? {} },
  ];

  it('is a ribbon per spine (no pinnae): Spine(6) -> Frond yields 6 ribbons', async () => {
    const r = await run(graph(6, { frondLengthSegments: 4, frondInstancing: false }));
    const d = r.diagnostics.get('frond')!;
    expect(d.state).not.toBe('error');
    expect(d.instances).toBe(6);
    expect(d.triangles).toBe(6 * 4 * 2);
  });

  it('planes per spine multiplies the geometry and is deterministic', async () => {
    const a = await run(graph(5, { frondPlanes: 3, frondLengthSegments: 3, frondInstancing: false }));
    const b = await run(graph(5, { frondPlanes: 3, frondLengthSegments: 3, frondInstancing: false }));
    expect(a.diagnostics.get('frond')!.triangles).toBe(5 * 3 * 3 * 2);
    expect(a.diagnostics.get('frond')!.triangles).toBe(b.diagnostics.get('frond')!.triangles);
  });

  it('trim + length helpers', () => {
    const p: V3[] = [[0, 0, 0], [0, 0, 1], [0, 0, 2]];
    const t = trimPolyline(p, 0.25, 0.75);
    expect(t[0]).toEqual([0, 0, 0.5]);
    expect(t[t.length - 1]).toEqual([0, 0, 1.5]);
  });

  it('migrates old pinnae-style graphs to ribbon params', () => {
    const def = getNodeDef('generator.frond')!;
    expect(def.version).toBe(2);
    const old = { frondPinnaLength: { value: 0.3 }, frondDroop: { value: 0.4 }, frondCurl: { value: 0.5 }, first: { value: 0.2 }, number: { value: 4 }, frondFins: { value: 10 } };
    const m = migrateFrondParams(old, 1);
    expect(m.frondWidth?.value).toBeCloseTo(0.42);
    expect(m.frondArch?.value).toBeCloseTo(22.5);
    expect(m.first).toBeUndefined();
    expect(m.frondFins).toBeUndefined();
    expect(migrateFrondParams(m, 2)).toBe(m);
  });
});
