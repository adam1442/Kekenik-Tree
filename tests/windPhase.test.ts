import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, mergeMeshData, windPhase1Of, windPhase1Array, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { attachSkeletonWind, computeSkeletonWind, WIND_ATTRIBUTES } from '@/geometry/windAttributes';
import { MeshAccumulator, newVertex } from '@/geometry/meshAccumulator';
import { meshDataToGeometry } from '@/viewport/meshDataToGeometry';
import { validateWindAttributes } from '@/viewport/wind/windExport';
import { defaultWindParams } from '@/viewport/wind/windParams';
import { WIND_GLSL_APPLY, WIND_GLSL_DECLARATIONS, WIND_GLSL_FUNCTION } from '@/viewport/wind/windShader';
import { windDisplacement, type WindVertex } from '@/viewport/wind/windReference';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const kids = (id: string, parent: string, extra: Record<string, unknown> = {}): NodeSpec => ({
  id,
  type: 'generator.branch',
  parent,
  params: { ...STRAIGHT, number: 3, first: 0.2, last: 0.9, length: 1.5, ...extra } as NodeSpec['params'],
});
const chain = (): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, length: 6, radius: 0.3, sides: 12 } as NodeSpec['params'] },
  kids('b1', 'trunk', { length: 3 }),
  kids('b2', 'b1', { length: 1.5 }),
  kids('b3', 'b2', { length: 0.8 }),
];

const vec5 = (sk: Skeleton, i: number): number[] => WIND_ATTRIBUTES.map((k) => (sk.attributes.get(k) as Float32Array)[i] as number);
const vertexOf = (sk: Skeleton, i: number, position: [number, number, number]): WindVertex => {
  const v = vec5(sk, i);
  return { position, weights: [v[0]!, v[1]!, v[2]!, v[3]!], phase1: v[4]! };
};
const p = { ...defaultWindParams(), enabled: true, strength: 2, baseHold: 0 };

describe('T02 wind: one phase per level', () => {
  it('a: a gen-2 branch base and the parent point it grows from share (w0, w1, w2, phase1) and displace identically', async () => {
    const r = await run(chain());
    const levels = ['trunk', 'b1', 'b2', 'b3'].map((id) => skeletonOf(r, id));
    let checked = 0;
    for (let L = 1; L < levels.length; L++) {
      const child = levels[L] as Skeleton;
      const parent = levels[L - 1] as Skeleton;
      expect(child.branches.length).toBeGreaterThan(0);
      for (const b of child.branches) {
        const c = vec5(child, b.start);
        const h = vec5(parent, b.parentPoint);
        // (w0, w1, w2, phase1): the own level of the child is still 0 at its base, the others are inherited unchanged
        // a level-1 branch creates its own phase1 (its w1 is 0 at the base, so the phase is irrelevant there); deeper ones copy it
        for (const k of L >= 2 ? [0, 1, 2, 4] : [0, 1, 2]) expect(Math.abs((c[k] as number) - (h[k] as number)), `level ${L} channel ${k}`).toBeLessThan(1e-6);
        const pos: [number, number, number] = [1.2, -0.4, 3.3];
        const a = vertexOf(child, b.start, pos);
        const bb = vertexOf(parent, b.parentPoint, pos);
        // the level-2 / leaf phase differs between parent and child on purpose; the displacement must not depend on it
        for (let s = 0; s < 20; s++) {
          const t = 0.37 + s * 1.91;
          const da = windDisplacement(p, a, t, 8);
          const db = windDisplacement(p, bb, t, 8);
          expect(Math.hypot(da[0] - db[0], da[1] - db[1], da[2] - db[2])).toBeLessThan(1e-6);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(9);
    // a gen >= 2 branch keeps the phase1 of its level-1 ancestor along its whole length
    const b2 = levels[2] as Skeleton;
    for (const b of b2.branches) for (let i = 1; i < b.count; i++) expect(vec5(b2, b.start + i)[4]).toBeCloseTo(vec5(b2, b.start)[4] as number, 6);
  });

  it('a2: the level-1 phase is created by level <= 1 branches and copied by deeper ones (constant per level)', async () => {
    const r = await run(chain());
    const b1 = skeletonOf(r, 'b1');
    const b2 = skeletonOf(r, 'b2');
    const phases = new Set(b1.branches.map((b) => (vec5(b1, b.start)[4] as number).toFixed(6)));
    expect(phases.size).toBeGreaterThan(1); // siblings do not sway in sync
    for (const b of b1.branches) {
      const first = vec5(b1, b.start)[4] as number;
      for (let i = 0; i < b.count; i++) expect(vec5(b1, b.start + i)[4]).toBe(first);
    }
    for (const b of b2.branches) {
      const host = skeletonOf(r, 'b1');
      expect(vec5(b2, b.start)[4]).toBeCloseTo(vec5(host, b.parentPoint)[4] as number, 6);
    }
  });

  it('b: no tearing on a tree with 3 branch levels (coincident vertices move together, phase1 included)', async () => {
    const r = await run([
      ...chain().slice(0, 2).map((s) => (s.id === 'trunk' ? { ...s, params: { ...s.params, splitsChance: 1 } } : s)) as NodeSpec[],
      { id: 'ext', type: 'generator.branch', parent: 'trunk', params: { ...STRAIGHT, number: 1, extendParent: 'any', extendCount: 1, knockout: 1, splitsChance: 0 } as NodeSpec['params'] },
      kids('b1', 'ext', { length: 2 }),
      kids('b2', 'b1', { length: 1.2 }),
      kids('b3', 'b2', { length: 0.6 }),
    ]);
    const ids = ['trunk', 'ext', 'b1', 'b2', 'b3'];
    const meshes = ids.map((id) => meshOf(r, id));
    for (const m of meshes) {
      expect(m.wind).toBeDefined();
      expect(m.wind!.phase1).toBeDefined();
      expect(validateWindAttributes(m).ok).toBe(true);
    }
    const cell = 1e-3;
    const grid = new Map<string, Array<[number, number]>>();
    const key = (x: number, y: number, z: number): string => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
    const vertex = (m: number, i: number): WindVertex => {
      const mesh = meshes[m] as MeshData;
      return {
        position: [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!],
        weights: [0, 1, 2, 3].map((c) => mesh.wind!.weights[i * 4 + c]!) as [number, number, number, number],
        phase1: windPhase1Of(mesh.wind!, i),
      };
    };
    let pairs = 0;
    let crossPairs = 0;
    meshes.forEach((mesh, m) => {
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const a = vertex(m, i);
        const [x, y, z] = a.position;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const [m2, j] of grid.get(key(x + dx * cell, y + dy * cell, z + dz * cell)) ?? []) {
            const b = vertex(m2, j);
            if (Math.hypot(x - b.position[0], y - b.position[1], z - b.position[2]) >= 1e-4) continue;
            pairs += 1;
            if (m2 !== m) crossPairs += 1;
            for (const t of [0.7, 2.3, 5.1, 9.4]) {
              const da = windDisplacement(p, a, t, 10);
              const db = windDisplacement(p, b, t, 10);
              expect(Math.hypot(da[0] - db[0], da[1] - db[1], da[2] - db[2])).toBeLessThan(1e-4);
            }
          }
        }
        const k = key(x, y, z);
        const list = grid.get(k);
        if (list) list.push([m, i]);
        else grid.set(k, [[m, i]]);
      }
    });
    expect(crossPairs).toBeGreaterThan(4);
    expect(pairs).toBeGreaterThan(50);
    // the three child levels exist and carry wind
    for (const id of ['b1', 'b2', 'b3']) expect(meshOf(r, id).positions.length).toBeGreaterThan(0);
  });

  it('c: meshes without phase1 (old data) still work and fall back to weights[3]', () => {
    const old: MeshData = {
      ...emptyMeshData(),
      positions: new Float32Array([0, 0, 1, 1, 0, 1, 0, 1, 1]),
      normals: new Float32Array(9),
      uv0: new Float32Array(6),
      indices: Uint32Array.from([0, 1, 2]),
      slots: [{ materialId: 'bark', indexStart: 0, indexCount: 3 }],
      wind: { pivot: new Float32Array(9), weights: new Float32Array([0, 1, 0, 0.1, 0, 1, 0, 0.2, 0, 1, 0, 0.3]) },
    };
    expect(windPhase1Of(old.wind!, 1)).toBeCloseTo(0.2, 6);
    expect(Array.from(windPhase1Array(old.wind!))).toEqual(Array.from(new Float32Array([0.1, 0.2, 0.3])));
    expect(validateWindAttributes(old).ok).toBe(true);
    // upload: the wind material gets a windPhase1 attribute even without the channel
    const geo = meshDataToGeometry(old);
    const attr = geo.getAttribute('windPhase1');
    expect(attr).toBeDefined();
    expect(attr?.count).toBe(3);
    expect(attr?.getX(2)).toBeCloseTo(0.3, 6);
    geo.dispose();
    // concatenation of old + new data keeps the channel (old part falls back)
    const acc = new MeshAccumulator();
    for (let i = 0; i < 3; i++) acc.addVertex({ ...newVertex(), pz: 1, w1: 1, w3: 0.5, w4: 0.8 });
    acc.addTriangle(0, 1, 2);
    const fresh = acc.build('bark', true);
    expect(fresh.wind?.phase1?.[0]).toBeCloseTo(0.8, 6);
    const merged = mergeMeshData([old, fresh]);
    expect(merged.wind?.phase1?.length).toBe(6);
    expect(merged.wind?.phase1?.[0]).toBeCloseTo(0.1, 6);
    expect(merged.wind?.phase1?.[3]).toBeCloseTo(0.8, 6);
    // the CPU reference falls back to weights[3]
    const v: WindVertex = { position: [1, 2, 3], weights: [1, 1, 0, 0.37] };
    for (const t of [0.5, 3.3, 8.1]) expect(windDisplacement(p, v, t, 6)).toEqual(windDisplacement(p, { ...v, phase1: 0.37 }, t, 6));
  });

  it('d: with phase1 == phase the displacement is the old single-phase one; a lone trunk is unchanged', () => {
    const b = new SkeletonBuilder();
    b.beginBranch(-1, -1, 0);
    for (let k = 0; k < 6; k++) b.addPoint(0, 0, k, 0.3 - k * 0.03);
    b.endBranch();
    const b1 = b.beginBranch(0, 3, 1);
    for (let k = 0; k < 5; k++) b.addPoint(k * 0.4, 0, 3 + k * 0.3, 0.1);
    b.endBranch();
    expect(b1).toBeGreaterThanOrEqual(0);
    const sk = b.build();
    const w = computeSkeletonWind(sk, null, 5);
    // default phase variance (0.5) = the old formula: level <= 1 branches have phase1 == phase
    for (let i = 0; i < sk.count; i++) expect(w[4]![i]).toBe(w[3]![i]);
    for (let i = 0; i < sk.count; i++) {
      const base = { position: [2, 1, 1 + i] as [number, number, number], weights: [w[0]![i]!, w[1]![i]!, w[2]![i]!, w[3]![i]!] as [number, number, number, number] };
      for (const t of [0.4, 2.9, 7.7]) {
        expect(windDisplacement(p, { ...base, phase1: w[4]![i]! }, t, 7)).toEqual(windDisplacement(p, base, t, 7));
      }
    }
    // the variance parameter is honoured: 0 = a level-1 branch copies its parent's phase
    const other = computeSkeletonWind(sk, null, 5, 0);
    expect(other[4]![sk.count - 1]).not.toBe(w[4]![sk.count - 1]);
    attachSkeletonWind(sk, null, 5);
    expect(sk.attributes.get('windPhase1')).toBeDefined();
  });

  it('e: GLSL: level-1 terms use windPhase1, declared once, passed by the apply chunk', () => {
    expect(WIND_GLSL_DECLARATIONS.match(/attribute float windPhase1;/g)).toHaveLength(1);
    expect(WIND_GLSL_DECLARATIONS.match(/attribute vec4 windWeights;/g)).toHaveLength(1);
    expect(WIND_GLSL_FUNCTION).toContain('float ph1');
    expect(WIND_GLSL_FUNCTION).toContain('float phase1 = ph1 * 6.2831853;');
    expect(WIND_GLSL_FUNCTION).toContain('sin(t * 1.7 * freqK + phase1)');
    expect(WIND_GLSL_FUNCTION).toContain('sin(t * 1.3 * freqK + phase1 * 1.7)');
    expect(WIND_GLSL_FUNCTION).toContain('sin(t * 5.3 + phase1 * 3.1)');
    expect(WIND_GLSL_FUNCTION).toContain('phase * 9.0'); // leaf terms keep windWeights.w
    expect(WIND_GLSL_APPLY).toContain('windWeights, windPhase1,');
    expect(WIND_GLSL_FUNCTION.match(/vec3 ktWindLocal\(/g)).toHaveLength(1);
  });
});
