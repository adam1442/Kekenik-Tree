import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import {
  DEFAULT_SPLIT_SETTINGS,
  NEUTRAL_SPLIT_SHAPE,
  buildCrotchMesh,
  buildForkOutline,
  crotchVertexIndex,
  forkNeck,
  isSplitShapeNeutral,
  planSplit,
  splitRingParam,
  splitShapeOf,
  valleyAoFactor,
  type CrotchInput,
  type CrotchMesh,
  type SplitShape,
} from '@/generators/split';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { Rng } from '@/core/rng';
import { chordThrough, isSimplePolygon, polygonArea, valleyRadius, type P2 } from '@/qa/outline';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const R0 = 0.5;
const SIDES = 64;
const RINGS = 21;
const NATURAL: Partial<SplitShape> = { waist: 0.7, neckSwell: 0.15, valleyRadius: 0.35, ridge: 0.3, stretch: 1.2 };
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Two lobes that leave a straight axis along +z (parallel end tangents): every ring is planar, so the outline can be analysed in 2D. */
function straight(shape: Partial<SplitShape> | undefined, over: Partial<CrotchInput> = {}): { input: CrotchInput; tau: number[] } {
  const bias = splitShapeOf(shape).ringBias;
  const r = R0 * Math.SQRT1_2;
  const c1 = new Float32Array(RINGS * 3);
  const c2 = new Float32Array(RINGS * 3);
  const tau: number[] = [];
  for (let k = 0; k < RINGS; k++) {
    const t = splitRingParam(k / (RINGS - 1), bias);
    tau.push(t);
    const off = 2 * r * smooth(t);
    c1.set([off / 2, 0, 3.5 * R0 * t], k * 3);
    c2.set([-off / 2, 0, 3.5 * R0 * t], k * 3);
  }
  return {
    tau,
    input: {
      sides: SIDES, rings: RINGS, centre1: c1, centre2: c2, radius0: R0, radius1: r, radius2: r,
      startTangent: [0, 0, 1], endTangent1: [0, 0, 1], endTangent2: [0, 0, 1], divergence: [1, 0, 0],
      innerSmooth: 0, ...(shape ? { shape } : {}), ...over,
    },
  };
}

const ringXY = (m: CrotchMesh, k: number): P2[] => {
  const out: P2[] = [];
  for (let j = 0; j < m.sides; j++) {
    const v = crotchVertexIndex(m.sides, m.rings, k, j) * 3;
    out.push([m.positions[v] as number, m.positions[v + 1] as number]);
  }
  return out;
};

/** Neck chord / narrower lobe chord of a ring outline (chords perpendicular to the line of the lobe centres, x). */
function waistRatio(poly: readonly P2[]): number {
  const xs = poly.map((p) => p[0]);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const mid = (lo + hi) / 2;
  const prof: { x: number; c: number }[] = [];
  for (let i = 1; i < 400; i++) {
    const x = lo + ((hi - lo) * i) / 400;
    prof.push({ x, c: chordThrough(poly, [x, 0], [0, 1]) });
  }
  const left = prof.filter((p) => p.x < mid);
  const right = prof.filter((p) => p.x >= mid);
  const maxL = Math.max(...left.map((p) => p.c));
  const maxR = Math.max(...right.map((p) => p.c));
  const xl = (left.find((p) => p.c === maxL) as { x: number }).x;
  const xr = (right.find((p) => p.c === maxR) as { x: number }).x;
  const neck = Math.min(...prof.filter((p) => p.x >= xl && p.x <= xr).map((p) => p.c));
  return neck / Math.min(maxL, maxR);
}

const angle = (a: ArrayLike<number>, ia: number, b: ArrayLike<number>, ib: number): number =>
  Math.acos(Math.min(1, Math.max(-1, (a[ia] as number) * (b[ib] as number) + (a[ia + 1] as number) * (b[ib + 1] as number) + (a[ia + 2] as number) * (b[ib + 2] as number))));

describe('T08: shape model', () => {
  it('neutral values are neutral and only non-neutral values switch the adaptive ring spacing on', () => {
    expect(isSplitShapeNeutral(undefined)).toBe(true);
    expect(isSplitShapeNeutral(NEUTRAL_SPLIT_SHAPE)).toBe(true);
    expect(isSplitShapeNeutral({ ridgeLength: 5 })).toBe(true);
    expect(splitShapeOf(undefined).ringBias).toBe(0);
    for (const v of [{ waist: 0.9 }, { neckSwell: 0.1 }, { valleyRadius: 0.2 }, { ridge: 0.1 }, { stretch: 1.1 }, { ease: 0.5 }]) {
      expect(isSplitShapeNeutral(v)).toBe(false);
      expect(splitShapeOf(v).ringBias).toBeGreaterThan(0);
    }
  });

  it('clamps to the parameter ranges', () => {
    const s = splitShapeOf({ waist: -1, neckSwell: 9, valleyRadius: 9, ridge: 9, stretch: 9, ease: 9, ridgeLength: 99 });
    expect([s.waist, s.neckSwell, s.valleyRadius, s.ridge, s.stretch, s.ease, s.ridgeLength]).toEqual([0.2, 0.5, 1, 1, 1.6, 1, 8]);
  });

  it('ring spacing is monotonic, exact at both ends and denser at both ends than in the middle', () => {
    let prev = 0;
    for (let i = 1; i <= 40; i++) {
      const t = splitRingParam(i / 40, 0.35);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
    expect(splitRingParam(0, 0.35)).toBe(0);
    expect(splitRingParam(1, 0.35)).toBe(1);
    expect(splitRingParam(0.37, 0)).toBe(0.37);
    const first = splitRingParam(0.05, 0.35);
    const middle = splitRingParam(0.55, 0.35) - splitRingParam(0.5, 0.35);
    expect(first).toBeLessThan(0.8 * middle);
  });

  it('planSplit places the lobe rings by the adaptive spacing only for a non-neutral shape', () => {
    const make = (settings: Partial<typeof DEFAULT_SPLIT_SETTINGS>): number[] => {
      const p = planSplit({
        end: { position: [0, 0, 2], tangent: [0, 0, 1], up: [1, 0, 0], radius: R0 },
        parentLength: 2,
        settings: { ...DEFAULT_SPLIT_SETTINGS, ...settings },
        ringSpacing: 0.1,
        rng: new Rng(11).fork('splits0'),
        chance: 1,
        parentTiles: 4,
        axisStart: { position: [0, 0, 2 - R0 * 3.5], tangent: [0, 0, 1] },
        treeAxis: [3, 0, 0],
      });
      if (!p) throw new Error('plan expected');
      const pos = p.lobes[0].positions;
      const out: number[] = [];
      for (let k = 1; k < p.lobes[0].ringCount; k++) out.push(Math.hypot((pos[k * 3] as number) - (pos[k * 3 - 3] as number), (pos[k * 3 + 1] as number) - (pos[k * 3 - 2] as number), (pos[k * 3 + 2] as number) - (pos[k * 3 - 1] as number)));
      return out;
    };
    const uniform = make({});
    const adaptive = make({ waist: 0.7 });
    expect(adaptive.length).toBeGreaterThanOrEqual(12);
    expect(uniform.length).toBeLessThan(adaptive.length);
    const mid = Math.floor(adaptive.length / 2);
    expect(adaptive[0] as number).toBeLessThan(0.8 * (adaptive[mid] as number));
    expect(adaptive[adaptive.length - 1] as number).toBeLessThan(0.8 * (adaptive[mid] as number));
    expect(Math.max(...uniform) / Math.min(...uniform)).toBeLessThan(2.5);
  });
});

describe('T08: forkOutline (2D)', () => {
  it('has G1 joints: the fillet is tangent to both lobe circles and its radius is the valley radius', () => {
    const o = buildForkOutline({ r1: 0.35, r2: 0.35, distance: 0.45, fillet: 0.12, half: 200 });
    const { xf, yf, hw } = forkNeck(0.45, 0.35, 0.35, 0.12);
    expect(hw).toBeCloseTo(yf - 0.12, 12);
    expect(Math.hypot(xf, yf)).toBeCloseTo(0.35 + 0.12, 12);
    expect(Math.hypot(xf + 0.45, yf)).toBeCloseTo(0.35 + 0.12, 12);
    // neck points are the first / last samples of the halves
    expect(o.y1[0]).toBeCloseTo(hw, 9);
    expect(o.y1[200]).toBeCloseTo(-hw, 9);
    expect(o.x1[0]).toBeCloseTo(xf, 9);
  });

  it('a narrow waist only moves the lobes apart: the neck matches and the lobe circles are unchanged', () => {
    const o = buildForkOutline({ r1: 0.35, r2: 0.35, distance: 0.35, fillet: 0, neckHalf: 0.6 * 0.35, half: 64 });
    expect(o.neckHalf).toBeCloseTo(0.6 * 0.35, 6);
    expect(o.distance).toBeGreaterThan(0.35);
  });
});

describe('T08: figure-8 rings', () => {
  it('neutral shape is byte-identical to the former outline and has no valley AO', () => {
    const base = buildCrotchMesh(straight(undefined).input);
    const neutral = buildCrotchMesh(straight(NEUTRAL_SPLIT_SHAPE).input);
    expect(Array.from(neutral.positions)).toEqual(Array.from(base.positions));
    expect(Array.from(neutral.normals)).toEqual(Array.from(base.normals));
    expect(Math.min(...neutral.valleyAo)).toBe(1);
  });

  it('waist 0.6: every ring is a simple polygon and the waist at mid transition is within 5 % of the parameter', () => {
    const { input } = straight({ waist: 0.6 });
    const m = buildCrotchMesh(input);
    for (let k = 0; k < m.rings; k++) expect(isSimplePolygon(ringXY(m, k))).toBe(true);
    const ratio = waistRatio(ringXY(m, (RINGS - 1) / 2));
    expect(Math.abs(ratio - 0.6) / 0.6).toBeLessThan(0.05);
    const old = waistRatio(ringXY(buildCrotchMesh(straight(undefined).input), (RINGS - 1) / 2));
    expect(old).toBeGreaterThan(0.8);
  });

  it('natural parameter set: simple polygons at every ring and a waist near 0.7 (swell and stretch only widen the lobes)', () => {
    const m = buildCrotchMesh(straight(NATURAL).input);
    for (let k = 0; k < m.rings; k++) expect(isSimplePolygon(ringXY(m, k))).toBe(true);
    const ratio = waistRatio(ringXY(m, (RINGS - 1) / 2));
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(0.8);
  });

  it('area never falls below 90 % of the linear blend between the parent and the sum of the lobes', () => {
    for (const shape of [{ waist: 0.6 }, NATURAL, { waist: 0.6, valleyRadius: 0.5, ease: 1 }]) {
      const { input, tau } = straight(shape);
      const m = buildCrotchMesh(input);
      const a0 = polygonArea(ringXY(m, 0));
      const a1 = polygonArea(ringXY(m, m.rings - 1));
      for (let k = 0; k < m.rings; k++) {
        const lin = a0 + (a1 - a0) * (tau[k] as number);
        expect(polygonArea(ringXY(m, k))).toBeGreaterThanOrEqual(0.9 * lin);
      }
    }
  });

  it('area stays near the pipe-model blend (at most 12 % above it, times the swell)', () => {
    for (const shape of [{ waist: 0.6 }, NATURAL]) {
      const { input, tau } = straight(shape);
      const m = buildCrotchMesh(input);
      const a0 = polygonArea(ringXY(m, 0));
      const a1 = polygonArea(ringXY(m, m.rings - 1));
      const swell = splitShapeOf(shape).neckSwell;
      for (let k = 0; k < m.rings; k++) {
        const t = tau[k] as number;
        const lin = a0 + (a1 - a0) * smooth(t);
        const bump = 1 + swell * ((t ** 4 * (1 - t) ** 3.27) / (0.55 ** 4 * 0.45 ** 3.27));
        expect(polygonArea(ringXY(m, k))).toBeLessThanOrEqual(1.12 * lin * bump * bump);
      }
    }
  });

  it('valley curvature radius is at least 0.8 x the requested fillet at mid transition', () => {
    const rv = 0.35;
    const m = buildCrotchMesh(straight({ valleyRadius: rv }).input);
    const lobe = R0 * Math.SQRT1_2;
    const k = (RINGS - 1) / 2;
    const measured = valleyRadius(ringXY(m, k));
    expect(measured).not.toBeNull();
    const t = 0.5;
    const rho = (R0 + (lobe - R0) * smooth(t));
    expect(measured as number).toBeGreaterThanOrEqual(0.8 * rv * rho);
    // the former outline is a cusp: its valley is far sharper
    const old = valleyRadius(ringXY(buildCrotchMesh(straight(undefined).input), k));
    expect(old === null || old < (measured as number)).toBe(true);
  });

  it('is watertight: boundary edges only on ring 0 and the two open ends, no edge used three times, open ends are circles', () => {
    const { input } = straight(NATURAL);
    const m = buildCrotchMesh(input);
    const use = new Map<string, number>();
    for (let t = 0; t < m.indices.length; t += 3) {
      for (let e = 0; e < 3; e++) {
        const a = m.indices[t + e] as number;
        const b = m.indices[t + ((e + 1) % 3)] as number;
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        use.set(key, (use.get(key) ?? 0) + 1);
      }
    }
    for (const [key, n] of use) {
      expect(n).toBeLessThanOrEqual(2);
      if (n === 1) {
        const [a, b] = key.split('_').map(Number) as [number, number];
        const ra = m.vertexRing[a] as number;
        const rb = m.vertexRing[b] as number;
        expect(ra === rb && (ra === 0 || ra === m.rings - 1)).toBe(true);
      }
    }
    const r = R0 * Math.SQRT1_2;
    const last = m.rings - 1;
    for (let j = 0; j < m.sides; j++) {
      if (j === 0 || j === m.sides / 2) continue;
      const v = crotchVertexIndex(m.sides, m.rings, last, j) * 3;
      const cx = j < m.sides / 2 ? r : -r;
      expect(Math.abs(Math.hypot((m.positions[v] as number) - cx, m.positions[v + 1] as number) - r)).toBeLessThan(1e-3);
      expect(Math.abs(m.positions[v + 2] as number - 3.5 * R0)).toBeLessThan(1e-3);
    }
    for (let j = 0; j < m.sides; j++) {
      const v = crotchVertexIndex(m.sides, m.rings, 0, j) * 3;
      expect(Math.abs(Math.hypot(m.positions[v] as number, m.positions[v + 1] as number) - R0)).toBeLessThan(1e-3);
    }
  });

  it('G1 at ring 0: the section normals of the first 15 % of the transition differ from ring 0 by less than 2 degrees', () => {
    const { input, tau } = straight(NATURAL);
    const m = buildCrotchMesh(input);
    let checked = 0;
    for (let k = 1; k < m.rings; k++) {
      if ((tau[k] as number) > 0.15) break;
      checked++;
      for (let j = 0; j < m.sides; j++) {
        const a = crotchVertexIndex(m.sides, m.rings, 0, j) * 3;
        const b = crotchVertexIndex(m.sides, m.rings, k, j) * 3;
        // cross-section direction of the normal (the axial taper of the tube is not part of the shape)
        const la = Math.hypot(m.normals[a] as number, m.normals[a + 1] as number);
        const lb = Math.hypot(m.normals[b] as number, m.normals[b + 1] as number);
        const dot = ((m.normals[a] as number) * (m.normals[b] as number) + (m.normals[a + 1] as number) * (m.normals[b + 1] as number)) / (la * lb);
        expect(Math.acos(Math.min(1, dot)) * (180 / Math.PI)).toBeLessThan(2);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });

  it('is deterministic', () => {
    const a = buildCrotchMesh(straight(NATURAL).input);
    const b = buildCrotchMesh(straight(NATURAL).input);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.normals)).toEqual(Array.from(b.normals));
    expect(Array.from(a.valleyAo)).toEqual(Array.from(b.valleyAo));
  });

  it('the ridge is bounded by its height, vanishes at both ends and lifts the valley bottom', () => {
    const without = buildCrotchMesh(straight({ valleyRadius: 0.35 }).input);
    const withRidge = buildCrotchMesh(straight({ valleyRadius: 0.35, ridge: 0.3 }).input);
    let max = 0;
    let atEnds = 0;
    for (let v = 0; v < without.vertexCount; v++) {
      const d = Math.hypot(
        (withRidge.positions[v * 3] as number) - (without.positions[v * 3] as number),
        (withRidge.positions[v * 3 + 1] as number) - (without.positions[v * 3 + 1] as number),
        (withRidge.positions[v * 3 + 2] as number) - (without.positions[v * 3 + 2] as number),
      );
      max = Math.max(max, d);
      const ring = without.vertexRing[v] as number;
      if (ring === 0 || ring === without.rings - 1) atEnds = Math.max(atEnds, d);
    }
    expect(max).toBeGreaterThan(0.01 * R0);
    expect(max).toBeLessThanOrEqual(0.3 * R0 + 1e-6);
    expect(atEnds).toBe(0);
  });

  it('the valley is darker (AO) while the ends keep an AO of exactly 1', () => {
    const m = buildCrotchMesh(straight(NATURAL).input);
    const mid = (RINGS - 1) / 2;
    const a = m.valleyAo[crotchVertexIndex(m.sides, m.rings, mid, 0)] as number;
    const flank = m.valleyAo[crotchVertexIndex(m.sides, m.rings, mid, m.sides / 4)] as number;
    expect(a).toBeLessThan(0.7);
    expect(flank).toBeGreaterThan(a);
    for (let j = 0; j < m.sides; j++) {
      expect(m.valleyAo[crotchVertexIndex(m.sides, m.rings, 0, j)]).toBe(1);
      expect(m.valleyAo[crotchVertexIndex(m.sides, m.rings, m.rings - 1, j)]).toBe(1);
    }
    expect(valleyAoFactor(0, 0.1, 0)).toBe(1);
    expect(valleyAoFactor(0, 0.1, 0.5)).toBeLessThan(valleyAoFactor(0.3, 0.1, 0.5));
  });

  it('the valley normals are smooth across the fillet (no split normal fan at the pinch)', () => {
    const m = buildCrotchMesh(straight({ valleyRadius: 0.4 }).input);
    const k = (RINGS - 1) / 2;
    const a = crotchVertexIndex(m.sides, m.rings, k, 0) * 3;
    const b = crotchVertexIndex(m.sides, m.rings, k, 1) * 3;
    const c = crotchVertexIndex(m.sides, m.rings, k, m.sides - 1) * 3;
    expect(angle(m.normals, a, m.normals, b) * (180 / Math.PI)).toBeLessThan(25);
    expect(angle(m.normals, a, m.normals, c) * (180 / Math.PI)).toBeLessThan(25);
    for (let t = 0; t < m.indices.length; t++) if (m.indices[t] === crotchVertexIndex(m.sides, m.rings, k, 0)) expect(m.cornerFan[t]).toBe(0);
  });
});

describe('T08: whole pipeline', () => {
  it('a natural fork evaluates with finite, manifold geometry and differs from the default', async () => {
    const evaluate = async (extra: Record<string, unknown>): Promise<MeshData> => {
      const specs: NodeSpec[] = [
        { id: 'tree', type: 'output.tree', parent: null },
        {
          id: 'trunk',
          type: 'generator.trunk',
          parent: 'tree',
          params: { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0, splitsChance: 1, ...extra } as NodeSpec['params'],
        },
      ];
      const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed: 1, lod: 0, token: new CancellationSource().token });
      return r.scene.entries.find((e) => e.nodeId === 'trunk')?.mesh ?? emptyMeshData();
    };
    const plain = await evaluate({});
    const natural = await evaluate({ splitsWaist: 0.7, splitsNeckSwell: 0.15, splitsValleyRadius: 0.35, splitsRidge: 0.3, splitsStretch: 1.2 });
    expect(natural.positions.length).toBeGreaterThan(0);
    expect(Array.from(natural.positions).every(Number.isFinite)).toBe(true);
    expect(Array.from(natural.normals).every(Number.isFinite)).toBe(true);
    // a figure-8 transition has more rings than the former one
    expect(natural.positions.length).toBeGreaterThan(plain.positions.length);
    const key = (i: number): string => `${Math.round((natural.positions[i * 3] as number) * 1e5)},${Math.round((natural.positions[i * 3 + 1] as number) * 1e5)},${Math.round((natural.positions[i * 3 + 2] as number) * 1e5)}`;
    const ids = new Map<string, number>();
    const id = (i: number): number => {
      const k = key(i);
      if (!ids.has(k)) ids.set(k, ids.size);
      return ids.get(k) as number;
    };
    const use = new Map<string, number>();
    let degenerate = 0;
    for (let t = 0; t < natural.indices.length; t += 3) {
      const v = [id(natural.indices[t] as number), id(natural.indices[t + 1] as number), id(natural.indices[t + 2] as number)];
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
        degenerate++;
        continue;
      }
      for (let e = 0; e < 3; e++) {
        const a = v[e] as number;
        const b = v[(e + 1) % 3] as number;
        const kk = a < b ? `${a}_${b}` : `${b}_${a}`;
        use.set(kk, (use.get(kk) ?? 0) + 1);
      }
    }
    expect(degenerate).toBe(0);
    for (const n of use.values()) expect(n).toBeLessThanOrEqual(2);
    const ao = natural.ao;
    expect(ao && Math.min(...ao)).toBeLessThan(0.9);
  });

  it('an extension that continues the open ends of a figure-8 fork stays welded (same boundary as the default fork)', async () => {
    const build = async (extra: Record<string, unknown>): Promise<{ bad: number; boundary: number; degenerate: number }> => {
      const specs: NodeSpec[] = [
        { id: 'tree', type: 'output.tree', parent: null },
        {
          id: 'trunk',
          type: 'generator.trunk',
          parent: 'tree',
          params: { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0, splitsChance: 1, ...extra } as NodeSpec['params'],
        },
        {
          id: 'ext',
          type: 'generator.branch',
          parent: 'trunk',
          params: { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0, number: 1, extendParent: 'any', extendCount: 1, knockout: 1 } as NodeSpec['params'],
        },
      ];
      const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed: 1, lod: 0, token: new CancellationSource().token });
      const meshes = ['trunk', 'ext'].map((id) => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData());
      const ids = new Map<string, number>();
      const use = new Map<string, number>();
      let degenerate = 0;
      for (const m of meshes) {
        const id = (i: number): number => {
          const k = `${Math.round((m.positions[i * 3] as number) * 1e4)},${Math.round((m.positions[i * 3 + 1] as number) * 1e4)},${Math.round((m.positions[i * 3 + 2] as number) * 1e4)}`;
          if (!ids.has(k)) ids.set(k, ids.size);
          return ids.get(k) as number;
        };
        for (let t = 0; t < m.indices.length; t += 3) {
          const v = [id(m.indices[t] as number), id(m.indices[t + 1] as number), id(m.indices[t + 2] as number)];
          if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
            degenerate++;
            continue;
          }
          for (let e = 0; e < 3; e++) {
            const a = v[e] as number;
            const b = v[(e + 1) % 3] as number;
            const key = a < b ? `${a}_${b}` : `${b}_${a}`;
            use.set(key, (use.get(key) ?? 0) + 1);
          }
        }
      }
      let bad = 0;
      let boundary = 0;
      for (const n of use.values()) {
        if (n > 2) bad++;
        if (n === 1) boundary++;
      }
      return { bad, boundary, degenerate };
    };
    const plain = await build({});
    const natural = await build({ splitsWaist: 0.7, splitsNeckSwell: 0.15, splitsValleyRadius: 0.35, splitsRidge: 0.3, splitsStretch: 1.2 });
    expect(natural.bad).toBe(plain.bad);
    expect(natural.degenerate).toBe(0);
    expect(natural.boundary).toBe(plain.boundary);
  });
});
