import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { flatCurve } from '@/contracts/curve';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { curveToLUT } from '@/contracts/curve';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildTubeMesh } from '@/geometry/tubeMesher';
import {
  BARK_STYLES,
  barkHeight,
  barkMaturityFactor,
  barkOffset,
  createBranchDisplacer,
  creviceLut,
  displaceFade,
  type BarkSpec,
  type BarkStyle,
  type BranchDisplaceSpec,
  type BranchDisplaceVertex,
  type DisplaceOut,
} from '@/generators/displace';
import { surfaceMetrics } from '@/qa';
import { barkSpecOf, branchDisplaceSpec, readSource, tubeDisplacementOptions } from '@/nodes/generators/displacement';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';
import type { NodeParams } from '@/contracts/params';

beforeAll(() => registerDiscoveredNodes());

const RADIUS = 0.3;
const LENGTH = 3;
const CIRC = 2 * Math.PI * RADIUS;

const bark = (over: Partial<BarkSpec> = {}): BarkSpec => ({
  style: 'furrowed',
  depth: 0.2,
  scale: 0.08,
  stretch: 4,
  warp: 0.5,
  crevice: null,
  maturity: { amount: 0, rMin: 0.01, rMax: 0.15, curve: null },
  seed: 3,
  maxVertices: 40000,
  ...over,
});

const spec = (b: BarkSpec, over: Partial<BranchDisplaceSpec> = {}): BranchDisplaceSpec => ({
  source: 'bark',
  radial: 0,
  length: 0,
  sharpness: null,
  mapping: 'fit',
  scaleU: 1,
  scaleV: 1,
  seed: 1,
  map: null,
  fine: { amount: 0, sharpness: null, scale: 1 },
  shape: { amount: 0, twist: 0, scale: 1, seed: 0 },
  flares: { radius: 0, noiseScale: 5, height: 1, pinch: 0, angle: 0, seed: 0 },
  fadeBase: 0,
  fadeTip: 0,
  lod: 0,
  lodFade: false,
  bark: b,
  ...over,
});

const vertex = (over: Partial<BranchDisplaceVertex> = {}): BranchDisplaceVertex => ({
  u: 0.3, s: 0.5, t: 0.2, sEnd: 2, radius: RADIUS, circumference: CIRC, sides: 64, junction: false,
  uvU: 0.3, uvV: 0.5, uTiles: 1, length: LENGTH, baseRadius: RADIUS, sFree: 0.5, branch: 0, ...over,
});

function cylinder(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i < 6; i++) sb.addPoint(0, 0, (i * LENGTH) / 5, RADIUS);
  sb.endBranch();
  return sb.build();
}

function mesh(b: BarkSpec | null, sides = 64, over: Partial<BranchDisplaceSpec> = {}): MeshData {
  const field = b ? createBranchDisplacer(spec(b, over)) : null;
  return buildTubeMesh(cylinder(), {
    maxGeneration: 8,
    radialSegments: () => sides,
    color: () => [0.3, 0.2, 0.1],
    uvMetres: 1,
    materialId: 'bark',
    maxSegmentLength: 0.03,
    ...(field ? { displaceField: field, displaceDirection: 'normal' as const } : {}),
  });
}

/** Mean absolute height step over a regular sampling, `step` metres apart, along the spine or around the trunk. */
function meanStep(style: BarkStyle, dir: 'along' | 'around', over: Partial<BarkSpec> = {}): number {
  const b = bark({ style, ...over });
  const step = 0.004;
  let sum = 0;
  let n = 0;
  const lines = 24;
  for (let line = 0; line < lines; line++) {
    const fixed = (line + 0.5) / lines;
    const count = dir === 'along' ? Math.floor(LENGTH / step) : Math.floor(CIRC / step);
    let prev = 0;
    for (let k = 0; k <= count; k++) {
      const h = dir === 'along' ? barkHeight(b, { u: fixed, s: k * step, circumference: CIRC }, 11) : barkHeight(b, { u: (k * step) / CIRC, s: fixed * LENGTH, circumference: CIRC }, 11);
      if (k > 0) {
        sum += Math.abs(h - prev);
        n++;
      }
      prev = h;
    }
  }
  return sum / n;
}

describe('Bark source: pattern', () => {
  it('is deterministic and every style spans a real height range', () => {
    for (const style of BARK_STYLES) {
      const b = bark({ style });
      const a = barkHeight(b, { u: 0.37, s: 1.21, circumference: CIRC }, 5);
      expect(barkHeight(b, { u: 0.37, s: 1.21, circumference: CIRC }, 5)).toBe(a);
      let lo = 1;
      let hi = 0;
      for (let i = 0; i < 4000; i++) {
        const h = barkHeight(b, { u: (i * 0.618) % 1, s: (i * 0.0173) % LENGTH, circumference: CIRC }, 5);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(1);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      expect(hi - lo, style).toBeGreaterThan(0.5);
    }
  });

  it('is periodic around the circumference: u = 0 and u = 1 are identical (every style, with a crevice profile)', () => {
    for (const style of BARK_STYLES) {
      const b = bark({ style, crevice: creviceLut(0.9) });
      for (const s of [0, 0.37, 1.9, 2.77]) {
        const a = barkHeight(b, { u: 0, s, circumference: CIRC }, 9);
        const z = barkHeight(b, { u: 1, s, circumference: CIRC }, 9);
        expect(z, `${style} s=${s}`).toBeCloseTo(a, 9);
      }
    }
  });

  it('feature size is in metres: the same trunk with 2x the circumference has about 2x the cells', () => {
    const count = (circ: number): number => {
      let crossings = 0;
      let prev = 0;
      const n = 2000;
      for (const s of [0.2, 0.9, 1.6, 2.3]) {
        for (let k = 0; k <= n; k++) {
          const h = barkHeight(bark({ style: 'furrowed', stretch: 1, warp: 0 }), { u: k / n, s, circumference: circ }, 7) - 0.5;
          if (k > 0 && Math.sign(h) !== Math.sign(prev)) crossings++;
          prev = h;
        }
      }
      return crossings;
    };
    const small = count(CIRC);
    const large = count(CIRC * 2);
    expect(large / small).toBeGreaterThan(1.6);
    expect(large / small).toBeLessThan(2.5);
  });

  it('furrowed, plated and fibrous bark are anisotropic: steeper around than along the spine', () => {
    for (const style of ['furrowed', 'fibrous', 'plated'] as const) {
      const ratio = meanStep(style, 'around') / meanStep(style, 'along');
      expect(ratio, style).toBeGreaterThan(style === 'plated' ? 1.4 : 2);
    }
  });

  it('rings vary along the spine and hardly at all around it', () => {
    const ratio = meanStep('rings', 'along') / meanStep('rings', 'around', { warp: 0.5 });
    expect(ratio).toBeGreaterThan(5);
  });

  it('lenticel bark runs around the trunk: steeper along the spine than around it', () => {
    expect(meanStep('lenticel', 'along') / meanStep('lenticel', 'around')).toBeGreaterThan(1.3);
  });

  it('Crevice shapes the profile: narrow V crevices lower the mean height, flat troughs keep a plateau', () => {
    const mean = (c: number): number => {
      const b = bark({ crevice: creviceLut(c) });
      let sum = 0;
      for (let i = 0; i < 3000; i++) sum += barkHeight(b, { u: (i * 0.618) % 1, s: (i * 0.0137) % LENGTH, circumference: CIRC }, 2);
      return sum / 3000;
    };
    expect(mean(1)).toBeGreaterThan(mean(0.5));
    expect(mean(0)).toBeLessThan(mean(0.5));
  });
});

describe('Bark source: depth, maturity, lineage', () => {
  it('depth is a fraction of the local radius: a thick trunk gets proportionally deeper relief than a twig', () => {
    const b = bark({ depth: 0.25 });
    const peak = (r: number): number => {
      let m = 0;
      for (let i = 0; i < 800; i++) m = Math.max(m, Math.abs(barkOffset(b, vertex({ u: (i * 0.618) % 1, s: i * 0.01, radius: r, circumference: 2 * Math.PI * r }))));
      return m;
    };
    const thick = peak(0.3);
    const thin = peak(0.03);
    expect(thick / thin).toBeGreaterThan(8);
    expect(thick).toBeLessThanOrEqual(0.25 * 0.3 * 0.5 + 1e-9);
    expect(thick).toBeGreaterThan(0.25 * 0.3 * 0.25);
  });

  it('Maturity: smooth twigs, full depth on old trunks, neutral at 0', () => {
    const m = { amount: 1, rMin: 0.01, rMax: 0.15, curve: null };
    expect(barkMaturityFactor(m, 0.005, 0.5)).toBe(0);
    expect(barkMaturityFactor(m, 0.4, 0.5)).toBe(1);
    const mid = barkMaturityFactor(m, 0.08, 0.5);
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    expect(barkMaturityFactor({ ...m, amount: 0 }, 0.005, 0.5)).toBe(1);
    const lut = curveToLUT(flatCurve(0.5), 256);
    expect(barkMaturityFactor({ ...m, amount: 0, curve: lut }, 0.4, 0.5)).toBeCloseTo(0.5, 2);
  });

  it('the seed changes the pattern and each lineage gets its own', () => {
    const v = vertex();
    const a = barkOffset(bark({ seed: 1 }), v);
    expect(barkOffset(bark({ seed: 2 }), v)).not.toBe(a);
    expect(barkOffset(bark({ seed: 1 }), vertex({ branch: 4 }))).not.toBe(a);
    expect(barkOffset(bark({ seed: 1 }), vertex({ branch: 4, lineage: 0 }))).toBe(a);
  });

  it('a continued branch (split half / extension) carries on the host pattern: same lineage + arc length = same offset', () => {
    const b = bark();
    const host = vertex({ s: 1.8, sEnd: 0, branch: 2 });
    const next = vertex({ s: 0, sEnd: 2, branch: 7, lineage: 2, sLineage: 1.8, continued: true });
    expect(barkOffset(b, next)).toBeCloseTo(barkOffset(b, host), 12);
  });

  it('no jump across a seam: the host tip and the continued base are both faded to zero displacement', () => {
    const s = spec(bark({ depth: 0.3 }), { fadeBase: 1.5, fadeTip: 1 });
    const d = createBranchDisplacer(s);
    expect(d).not.toBeNull();
    const out: DisplaceOut = { radial: 0, along: 0, normal: 0 };
    const hostTip = vertex({ s: 1.8, sEnd: 0 });
    const contBase = vertex({ s: 0, sEnd: 2, sFree: 0, continued: true, lineage: 2, sLineage: 1.8 });
    for (const u of [0.05, 0.31, 0.77]) {
      d?.({ ...hostTip, u }, out);
      expect(Math.abs(out.normal)).toBeLessThan(0.01 * 0.3 * RADIUS);
      d?.({ ...contBase, u }, out);
      expect(Math.abs(out.normal)).toBeLessThan(0.01 * 0.3 * RADIUS);
    }
    expect(displaceFade(s, contBase, false)).toBe(0);
    // junction rings fade the same way, and the fade is fully open far from them
    expect(displaceFade(s, vertex({ junction: true, sFree: 0 }), false)).toBe(0);
    expect(displaceFade(s, vertex({ junction: true, sFree: 5 }), false)).toBe(1);
  });

  it('fades with the LOD like the other sources and is idle at depth 0', () => {
    const b = bark({ depth: 0.3 });
    expect(createBranchDisplacer(spec(bark({ depth: 0 })))).toBeNull();
    const at = (lod: number): number => {
      const d = createBranchDisplacer(spec(b, { lod, lodFade: true }));
      const out: DisplaceOut = { radial: 0, along: 0, normal: 0 };
      d?.(vertex({ u: 0.41, s: 0.77 }), out);
      return Math.abs(out.normal);
    };
    expect(at(0)).toBeGreaterThan(0);
    expect(at(3)).toBe(0);
  });
});

describe('Bark source: mesh', () => {
  it('is deterministic and produces relief within depth x radius', () => {
    const a = mesh(bark({ depth: 0.2 }));
    const b = mesh(bark({ depth: 0.2 }));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < a.positions.length / 3; i++) {
      const z = a.positions[i * 3 + 2] as number;
      if (z < 0.3 || z > LENGTH - 0.5) continue;
      const r = Math.hypot(a.positions[i * 3] as number, a.positions[i * 3 + 1] as number);
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
    expect(hi - lo).toBeGreaterThan(0.2 * RADIUS * 0.4);
    expect(hi).toBeLessThanOrEqual(RADIUS * (1 + 0.1) + 1e-3);
    expect(lo).toBeGreaterThanOrEqual(RADIUS * (1 - 0.1) - 1e-3);
  });

  it('shows relief in the shading: normals are unit length and tilt away from the radial direction', () => {
    const m = mesh(bark({ depth: 0.25 }));
    let tilted = 0;
    let total = 0;
    for (let i = 0; i < m.positions.length / 3; i++) {
      const z = m.positions[i * 3 + 2] as number;
      if (z < 0.4 || z > LENGTH - 0.6) continue;
      const nx = m.normals[i * 3] as number;
      const ny = m.normals[i * 3 + 1] as number;
      const nz = m.normals[i * 3 + 2] as number;
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 3);
      const px = m.positions[i * 3] as number;
      const py = m.positions[i * 3 + 1] as number;
      const rl = Math.hypot(px, py) || 1;
      if ((nx * px + ny * py) / rl < 0.97) tilted++;
      total++;
    }
    expect(tilted / total).toBeGreaterThan(0.3);
  });

  it('softness index (T04) drops on a displaced trunk compared with depth 0', () => {
    const flat = surfaceMetrics(mesh(null)).softnessIndex;
    const rough = surfaceMetrics(mesh(bark({ depth: 0.25 }))).softnessIndex;
    expect(flat).toBeGreaterThan(0.5);
    expect(rough).toBeLessThan(flat - 0.05);
  });
});

describe('Bark source: parameters and subdivision', () => {
  const P = (o: Record<string, string | number> = {}): NodeParams => Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value }]));

  it('defaults are neutral: Source stays Noise, depth 0, no displacement field', () => {
    const def = getNodeDef('generator.trunk');
    const p: NodeParams = Object.fromEntries((def?.params ?? []).map((d) => [d.id, { value: d.default }])) as NodeParams;
    expect(readSource(p)).toBe('noise');
    expect(barkSpecOf(p).depth).toBe(0);
    expect(tubeDisplacementOptions(p, 0, null).displaceField).toBeUndefined();
  });

  it('Source = Bark with depth 0 still moves nothing; with depth > 0 it creates the field and a density from Scale', () => {
    const p = P({ displaceSource: 'bark' });
    expect(readSource(p)).toBe('bark');
    expect(tubeDisplacementOptions(p, 0, null).displaceField).toBeUndefined();
    const q = P({ displaceSource: 'bark', barkDepth: 0.2 });
    const o = tubeDisplacementOptions(q, 0, null);
    expect(o.displaceField).toBeDefined();
    expect(branchDisplaceSpec(q, 0, null).bark?.depth).toBe(0.2);
    // >= 4 vertices across the narrowest feature (furrowed: half the scale across)
    expect(o.displaceSideSpacing as number).toBeLessThanOrEqual((0.08 * 0.5) / 4 + 1e-9);
    expect(o.maxSegmentLength as number).toBeGreaterThan(o.displaceSideSpacing as number);
    const finer = tubeDisplacementOptions(P({ displaceSource: 'bark', barkDepth: 0.2, barkScale: 0.04 }), 0, null);
    expect(finer.displaceSideSpacing as number).toBeLessThan(o.displaceSideSpacing as number);
    // LOD 3: the relief is gone, so nothing is subdivided
    expect(tubeDisplacementOptions(q, 3, null).maxSegmentLength).toBeUndefined();
  });

  it('every new parameter has a tooltip and the Bark section lives in the Displacement tab', () => {
    const def = getNodeDef('generator.trunk');
    const ids = ['barkStyle', 'barkDepth', 'barkScale', 'barkStretch', 'barkWarp', 'barkCrevice', 'barkMaturity', 'barkMaturityMin', 'barkMaturityMax', 'barkMaturityCurve', 'barkSeed', 'displaceMaxVertices'];
    for (const id of ids) {
      const d = def?.params.find((x) => x.id === id);
      expect(d, id).toBeDefined();
      expect(d?.tooltip ?? '', id).not.toBe('');
      expect(d?.group).toBe('Displacement');
    }
    expect(def?.params.find((x) => x.id === 'barkDepth')?.subgroup).toBe('Bark');
  });
});

const run = (specs: NodeSpec[], seed = 1, lod = 0) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod, token: new CancellationSource().token });

const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const trunkSpec = (extra: Record<string, unknown>): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, number: 1, length: 5, radius: 0.3, ...extra } as NodeSpec['params'] },
];
const meshOf = (r: Awaited<ReturnType<typeof run>>): MeshData => r.scene.entries.find((e) => e.nodeId === 'trunk')?.mesh ?? emptyMeshData();

function openEdges(m: MeshData): number {
  const key = (i: number): string => [0, 1, 2].map((k) => Math.round((m.positions[i * 3 + k] as number) * 1e4)).join(',');
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(m.indices[t + e] as number);
      const b = key(m.indices[t + ((e + 1) % 3)] as number);
      if (a === b) continue;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c === 1) open++;
  return open;
}

describe('Bark source: graph integration', () => {
  const BARK = { displaceSource: 'bark', barkDepth: 0.15, barkScale: 0.08 };

  it('a trunk with bark has relief, is finite, and keeps the mesh closed like the smooth trunk', async () => {
    const smooth = meshOf(await run(trunkSpec({})));
    const rough = meshOf(await run(trunkSpec(BARK)));
    expect(rough.positions.length).toBeGreaterThan(smooth.positions.length);
    expect(rough.positions.every((x) => Number.isFinite(x))).toBe(true);
    expect(rough.normals.every((x) => Number.isFinite(x))).toBe(true);
    expect(openEdges(rough)).toBeLessThanOrEqual(openEdges(smooth));
    expect(surfaceMetrics(rough).softnessIndex).toBeLessThan(surfaceMetrics(smooth).softnessIndex);
  });

  it('the wind attributes of the added rings and sides are interpolated, not zeroed', async () => {
    const rough = meshOf(await run(trunkSpec({ ...BARK })));
    const w = rough.wind;
    expect(w).toBeDefined();
    const n = rough.positions.length / 3;
    expect((w?.weights.length ?? 0) / 4).toBe(n);
    // the first weight channel rises with height on a trunk: every vertex above the base has a non-zero weight
    let zero = 0;
    for (let i = 0; i < n; i++) {
      const z = rough.positions[i * 3 + 2] as number;
      if (z > 0.5 && (w?.weights[i * 4] as number) + (w?.weights[i * 4 + 1] as number) + (w?.weights[i * 4 + 2] as number) <= 0) zero++;
    }
    expect(zero).toBe(0);
  });

  it('a split trunk with bark stays closed (no cracks at the crotch) and respects the vertex cap', async () => {
    const split = { splitsChance: 1 };
    const smooth = meshOf(await run(trunkSpec({ ...split, length: 6 })));
    const rough = meshOf(await run(trunkSpec({ ...split, length: 6, ...BARK })));
    expect(rough.positions.every((x) => Number.isFinite(x))).toBe(true);
    expect(openEdges(rough)).toBeLessThanOrEqual(openEdges(smooth));
    const tiny = meshOf(await run(trunkSpec({ ...split, length: 6, displaceSource: 'bark', barkDepth: 0.15, barkScale: 0.005, displaceMaxVertices: 3000 })));
    expect(tiny.positions.length / 3).toBeLessThan(6 * 3000);
    const big = meshOf(await run(trunkSpec({ ...split, length: 6, displaceSource: 'bark', barkDepth: 0.15, barkScale: 0.005, displaceMaxVertices: 60000 })));
    expect(big.positions.length).toBeGreaterThan(tiny.positions.length);
  });
});
