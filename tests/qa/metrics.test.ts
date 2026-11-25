import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { MeshData } from '@/contracts/mesh';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import { loadSample } from '../helpers/sampleProjects';
import { analyzeOutline, forkMetrics, isSimplePolygon, profileMetrics, surfaceMetrics, auditWindSeams, windAuditMeshFromParts, type P2 } from '@/qa';

beforeAll(() => registerDiscoveredNodes());

/** Z-axis tube with `rings` rings of `sides` vertices (+ a duplicated seam vertex, like the real mesher) and the radius `radius(z, angle)`. */
function tube(length: number, rings: number, sides: number, radius: (z: number, a: number) => number): MeshData {
  const V = sides + 1;
  const positions = new Float32Array(rings * V * 3);
  const normals = new Float32Array(rings * V * 3);
  for (let i = 0; i < rings; i++) {
    const z = (i / (rings - 1)) * length;
    for (let j = 0; j < V; j++) {
      const a = ((j % sides) / sides) * Math.PI * 2;
      const r = radius(z, a);
      const o = (i * V + j) * 3;
      positions.set([Math.cos(a) * r, Math.sin(a) * r, z], o);
      normals.set([Math.cos(a), Math.sin(a), 0], o);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i + 1 < rings; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * V + j;
      const b = a + 1;
      const c = a + V;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return { positions, normals, uv0: new Float32Array(rings * V * 2), indices: Uint32Array.from(idx), slots: [] };
}

function axisSkeleton(length: number, radius: number): Skeleton {
  const b = new SkeletonBuilder();
  b.beginBranch(-1, -1, 0);
  for (let k = 0; k < 3; k++) b.addPoint(0, 0, (length * k) / 2, radius);
  b.endBranch();
  return b.build();
}

describe('QA surfaceMetrics', () => {
  it('a fine perfect cylinder is entirely soft', () => {
    const m = surfaceMetrics(tube(2, 20, 160, () => 1));
    expect(m.softnessIndex).toBeGreaterThan(0.99);
    expect(m.dihedral.p95).toBeLessThan(3);
    expect(m.normalVariance.mean).toBeLessThan(0.01);
    expect(m.edges).toBeGreaterThan(0);
  });

  it('a 12-sided tube has a 30 degree edge on every ring seam (one third of the edges)', () => {
    const m = surfaceMetrics(tube(2, 10, 12, () => 0.1));
    expect(m.dihedral.max).toBeCloseTo(30, 0);
    expect(m.softnessIndex).toBeGreaterThan(0.6);
    expect(m.softnessIndex).toBeLessThan(0.7);
  });

  it('a rough surface scores a lower softness index and a higher normal variance than a smooth one', () => {
    const smooth = surfaceMetrics(tube(2, 60, 48, () => 0.1));
    const rough = surfaceMetrics(tube(2, 60, 48, (z, a) => 0.1 * (1 + 0.15 * Math.sin(z * 90) * Math.sin(a * 7))));
    expect(rough.softnessIndex).toBeLessThan(smooth.softnessIndex - 0.2);
    expect(rough.normalVariance.mean).toBeGreaterThan(smooth.normalVariance.mean);
  });

  it('counts vertices per metre of an axis and reports edge lengths', () => {
    const m = surfaceMetrics(tube(2, 21, 16, () => 0.1), { axis: { points: [0, 0, 0, 0, 0, 2], radius: [0.1, 0.1] } });
    expect(m.verticesPerMetre).toBeCloseTo((21 * 16) / 2, 0);
    expect(m.edgeLength.min).toBeGreaterThan(0.03);
    expect(m.triangles).toBe(20 * 16 * 2);
  });
});

describe('QA profileMetrics', () => {
  it('a perfect cylinder is circular and smooth', () => {
    const p = profileMetrics(axisSkeleton(2, 0.1), tube(2, 30, 96, () => 0.1)).trunk;
    expect(p).not.toBeNull();
    expect(p!.circularity).toBeGreaterThan(0.999);
    expect(p!.circularityDeviation).toBeLessThan(0.002);
    expect(p!.radiusRoughness).toBeLessThan(0.002);
    expect(p!.silhouetteDeviation).toBeLessThan(0.002);
    expect(p!.meanRadius).toBeCloseTo(0.1, 2);
  });

  it('an elliptical cylinder is measurably less circular', () => {
    const p = profileMetrics(axisSkeleton(2, 0.1), tube(2, 30, 96, (_z, a) => 0.1 / Math.sqrt(1 + 0.6 * Math.sin(a) * Math.sin(a)))).trunk;
    expect(p!.circularity).toBeLessThan(0.99);
    expect(p!.circularityDeviation).toBeGreaterThan(0.03);
  });

  it('a sinusoidal radius gives its RMS amplitude as radius roughness', () => {
    const amp = 0.05;
    const mesh = tube(4, 400, 64, (z) => 0.1 * (1 + amp * Math.sin((z / 4) * Math.PI * 2 * 7)));
    const p = profileMetrics(axisSkeleton(4, 0.1), mesh, { stations: 70 }).trunk;
    expect(p!.radiusRoughness).toBeGreaterThan((amp / Math.SQRT2) * 0.85);
    expect(p!.radiusRoughness).toBeLessThan((amp / Math.SQRT2) * 1.15);
  });
});

/** Closed union outline of two unit circles with centres at +-d (CCW), plus an optional self-intersecting variant. */
function figureEight(d: number, n = 90): P2[] {
  const t0 = Math.acos(d);
  const out: P2[] = [];
  for (let k = 0; k <= n; k++) {
    const t = -(Math.PI - t0) + ((2 * (Math.PI - t0)) * k) / n;
    out.push([d + Math.cos(t), Math.sin(t)]);
  }
  for (let k = 0; k <= n; k++) {
    const t = t0 + ((2 * Math.PI - 2 * t0) * k) / n;
    out.push([-d + Math.cos(t), Math.sin(t)]);
  }
  return out.filter((p, i) => i === 0 || Math.hypot(p[0] - (out[i - 1] as P2)[0], p[1] - (out[i - 1] as P2)[1]) > 1e-9);
}

describe('QA forkMetrics / outline analysis', () => {
  const lobes = (d: number) => ({ c1: [-d, 0] as P2, c2: [d, 0] as P2, r1: 1, r2: 1 });

  it('a hand-built figure-8 has the analytic waist ratio and a sharp valley', () => {
    const d = 0.6;
    const a = analyzeOutline([figureEight(d)], lobes(d));
    expect(a.loops).toBe(1);
    expect(a.waistRatio).toBeCloseTo(Math.sqrt(1 - d * d), 1);
    expect(a.simple).toBe(true);
    expect(a.valleyRadiusRel).not.toBeNull();
    expect(a.valleyRadiusRel!).toBeLessThan(0.2);
  });

  it('a single circle has no waist and no valley', () => {
    const circle: P2[] = Array.from({ length: 64 }, (_, k) => [Math.cos((k / 64) * 2 * Math.PI), Math.sin((k / 64) * 2 * Math.PI)]);
    const a = analyzeOutline([circle], { c1: [-0.01, 0], c2: [0.01, 0], r1: 1, r2: 1 });
    expect(a.waistRatio).toBeCloseTo(1, 1);
    expect(a.valleyRadiusRel).toBeNull();
  });

  it('detects self-intersecting outlines and crossing loops', () => {
    const bowTie: P2[] = [[0, 0], [1, 1], [1, 0], [0, 1]];
    expect(isSimplePolygon(bowTie)).toBe(false);
    expect(isSimplePolygon([[0, 0], [1, 0], [1, 1], [0, 1]])).toBe(true);
    expect(analyzeOutline([bowTie], lobes(0.5)).simple).toBe(false);
    const sq = (x: number): P2[] => [[x, 0], [x + 1, 0], [x + 1, 1], [x, 1]];
    expect(analyzeOutline([sq(0), sq(0.5)], lobes(0.5)).simple).toBe(true);
    const diamond: P2[] = [[1, -0.3], [1.8, 0.5], [1, 1.3], [0.2, 0.5]];
    expect(analyzeOutline([sq(0), diamond], lobes(0.5)).simple).toBe(false);
  });

  it('measures the forks of a real sample tree with a forced trunk fork (headless graph evaluation)', async () => {
    const project = loadSample('oak');
    // The sample's trunk may not fork by default: make every trunk split so the fork metrics have something to measure.
    for (const n of project.graph.nodes) if (n.type === 'generator.trunk' && n.params.splitsChance) n.params.splitsChance = { ...n.params.splitsChance, value: 1 };
    const types = new Map(project.graph.nodes.map((n) => [n.id, n.type]));
    const r = await new GraphEvaluator().evaluate(snapshotGraph(GraphModel.fromJSON(project.graph)), { seed: 1, lod: 0, token: new CancellationSource().token });
    const forks: ReturnType<typeof forkMetrics>['forks'] = [];
    for (const e of r.scene.entries) {
      if (types.get(e.nodeId) !== 'generator.trunk' && types.get(e.nodeId) !== 'generator.branch') continue;
      const skeleton = r.scene.skeletons.find((s) => s.nodeId === e.nodeId)?.skeleton;
      if (skeleton) forks.push(...forkMetrics(skeleton, e.mesh).forks);
    }
    expect(forks.length).toBeGreaterThan(0);
    for (const fork of forks) {
      expect(fork.stations).toHaveLength(7);
      expect(fork.stations[0]!.area).toBeGreaterThan(0);
      expect(fork.waistMid).toBeGreaterThanOrEqual(0);
    }
    const parts = windAuditMeshFromParts(r.scene.entries.map((e) => ({ id: e.nodeId, mesh: e.mesh })));
    expect(typeof auditWindSeams).toBe('function');
    expect(parts.groups.length).toBeGreaterThan(0);
  }, 60000);
});
