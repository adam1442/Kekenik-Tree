import { describe, expect, it } from 'vitest';
import type { SceneEntry, SceneModel } from '@/contracts/engine';
import type { MeshData } from '@/contracts/mesh';
import { meshTriangleCount } from '@/contracts/mesh';
import {
  analyseScene,
  applyDynamicLod,
  defaultDynamicLodConfig,
  levelValue,
  lodNodeScales,
  lodReport,
  lodValueForScreen,
  readDynamicLodConfig,
  type DynamicLodConfig,
} from '@/lod/dynamic';

/** Small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface LeafSpec {
  base: [number, number, number];
  dir: [number, number, number];
}

/** One quad per leaf: 4 vertices, 2 triangles, uv.v 0 at the base and 1 at the tip. */
function leafMesh(leaves: readonly LeafSpec[], size = 0.4): MeshData {
  const positions: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  leaves.forEach((l, i) => {
    const d = l.dir;
    // any vector not parallel to d
    const ref: [number, number, number] = Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    const tx = d[1] * ref[2] - d[2] * ref[1];
    const ty = d[2] * ref[0] - d[0] * ref[2];
    const tz = d[0] * ref[1] - d[1] * ref[0];
    const tl = Math.hypot(tx, ty, tz) || 1;
    const w = size * 0.3;
    const t: [number, number, number] = [(tx / tl) * w, (ty / tl) * w, (tz / tl) * w];
    const b = l.base;
    const tip: [number, number, number] = [b[0] + d[0] * size, b[1] + d[1] * size, b[2] + d[2] * size];
    positions.push(b[0] - t[0], b[1] - t[1], b[2] - t[2], b[0] + t[0], b[1] + t[1], b[2] + t[2], tip[0] + t[0], tip[1] + t[1], tip[2] + t[2], tip[0] - t[0], tip[1] - t[1], tip[2] - t[2]);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    const o = i * 4;
    indices.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return {
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    uv0: Float32Array.from(uv),
    indices: Uint32Array.from(indices),
    slots: [{ materialId: 'leaf', indexStart: 0, indexCount: indices.length }],
  };
}

function ballLeaves(count: number, radius: number, seed: number): LeafSpec[] {
  const r = rng(seed);
  const out: LeafSpec[] = [];
  while (out.length < count) {
    const p: [number, number, number] = [(r() * 2 - 1) * radius, (r() * 2 - 1) * radius, (r() * 2 - 1) * radius];
    if (Math.hypot(...p) > radius) continue;
    const d: [number, number, number] = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
    const l = Math.hypot(...d) || 1;
    out.push({ base: p, dir: [d[0] / l, d[1] / l, d[2] / l] });
  }
  return out;
}

/** A straight tube along z with `rings` rings of 6 vertices; uv.v is the ring index (as in the tube mesher). */
function tubeMesh(x: number, y: number, radius: number, length: number, rings = 5): MeshData {
  const positions: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < rings; k++) {
    for (let s = 0; s < 6; s++) {
      const a = (s / 6) * Math.PI * 2;
      positions.push(x + Math.cos(a) * radius, y + Math.sin(a) * radius, (k / (rings - 1)) * length);
      uv.push(s / 6, k / (rings - 1));
    }
  }
  for (let k = 0; k + 1 < rings; k++) {
    for (let s = 0; s < 6; s++) {
      const a = k * 6 + s;
      const b = k * 6 + ((s + 1) % 6);
      indices.push(a, b, a + 6, b, b + 6, a + 6);
    }
  }
  return { positions: Float32Array.from(positions), normals: new Float32Array(positions.length), uv0: Float32Array.from(uv), indices: Uint32Array.from(indices), slots: [{ materialId: 'bark', indexStart: 0, indexCount: indices.length }] };
}

const entry = (nodeId: string, statsGroup: string, mesh: MeshData, lodWeight?: number): SceneEntry => ({
  nodeId,
  type: 'test',
  statsGroup,
  mesh,
  rev: nodeId,
  ...(lodWeight !== undefined ? { lodWeight } : {}),
});

function sceneOf(entries: SceneEntry[]): SceneModel {
  const triangles = entries.reduce((s, e) => s + meshTriangleCount(e.mesh), 0);
  return { entries, skeletons: [], stats: { triangles, vertices: 0, bones: 0, groups: [] } as unknown as SceneModel['stats'] };
}

const R = 3;
const leaves = ballLeaves(1500, R, 7);
const canopy = (): SceneModel => sceneOf([entry('leaf', 'leaf meshes', leafMesh(leaves))]);
const config = (): DynamicLodConfig => ({ ...defaultDynamicLodConfig(), enabled: true });

/** Node index of leaf `k` of the first entry. */
const nodeOfLeaf = (model: ReturnType<typeof analyseScene>, k: number): number => {
  const plan = model.entries[0];
  if (!plan?.comps) throw new Error('no plan');
  return plan.nodeStart + (plan.comps.ids[k * 4] as number);
};

describe('Dynamic LOD analysis', () => {
  it('is deterministic', () => {
    const a = analyseScene(canopy(), 5);
    const b = analyseScene(canopy(), 5);
    expect(Array.from(b.rank)).toEqual(Array.from(a.rank));
    expect(Array.from(b.exposure)).toEqual(Array.from(a.exposure));
    expect(a.nodeCount).toBe(leaves.length);
  });

  it('gives interior leaves a lower exposure than silhouette leaves', () => {
    const m = analyseScene(canopy(), 1);
    let inner = 0;
    let innerN = 0;
    let outer = 0;
    let outerN = 0;
    leaves.forEach((l, k) => {
      const d = Math.hypot(...l.base) / R;
      const e = m.exposure[nodeOfLeaf(m, k)] as number;
      if (d < 0.5) {
        inner += e;
        innerN++;
      } else if (d > 0.85) {
        outer += e;
        outerN++;
      }
    });
    expect(innerN).toBeGreaterThan(20);
    expect(outerN).toBeGreaterThan(20);
    expect(inner / innerN).toBeLessThan((outer / outerN) * 0.7);
  });

  it('removes interior leaves before silhouette leaves', () => {
    const m = analyseScene(canopy(), 1);
    const scales = lodNodeScales(m, config(), 0.55);
    let innerRemoved = 0;
    let innerN = 0;
    let outerRemoved = 0;
    let outerN = 0;
    leaves.forEach((l, k) => {
      const d = Math.hypot(...l.base) / R;
      const gone = (scales[nodeOfLeaf(m, k)] as number) <= 1e-3;
      if (d < 0.5) {
        innerN++;
        if (gone) innerRemoved++;
      } else if (d > 0.85) {
        outerN++;
        if (gone) outerRemoved++;
      }
    });
    expect(innerRemoved / innerN).toBeGreaterThan(outerRemoved / outerN + 0.2);
    const report = lodReport(m, scales, 0.55);
    expect(report.interiorRemovedShare).toBeGreaterThan(0.3);
  });

  it('weights bias survival', () => {
    // Two generators interleaved over the same ball: the one with the higher weight survives longer.
    const a = leaves.filter((_, i) => i % 2 === 0);
    const b = leaves.filter((_, i) => i % 2 === 1);
    const scene = sceneOf([entry('a', 'leaf meshes', leafMesh(a), 0.9), entry('b', 'leaf meshes', leafMesh(b), 0.1)]);
    const m = analyseScene(scene, 1);
    const scales = lodNodeScales(m, config(), 0.6);
    const alive = (entryIndex: number): number => {
      const p = m.entries[entryIndex];
      if (!p) return 0;
      let n = 0;
      for (let k = 0; k < p.nodeCount; k++) if ((scales[p.nodeStart + k] as number) > 1e-3) n++;
      return n / p.nodeCount;
    };
    expect(alive(0)).toBeGreaterThan(alive(1) + 0.3);
    // neutral weights: the shares are close to each other
    const neutral = analyseScene(sceneOf([entry('a', 'leaf meshes', leafMesh(a)), entry('b', 'leaf meshes', leafMesh(b))]), 1);
    const ns = lodNodeScales(neutral, config(), 0.6);
    const share = (i: number): number => {
      const p = neutral.entries[i];
      if (!p) return 0;
      let n = 0;
      for (let k = 0; k < p.nodeCount; k++) if ((ns[p.nodeStart + k] as number) > 1e-3) n++;
      return n / p.nodeCount;
    };
    expect(Math.abs(share(0) - share(1))).toBeLessThan(0.15);
  });
});

describe('Dynamic LOD evaluation', () => {
  it('returns the unmodified scene at LOD 0 (bit-identical)', () => {
    const scene = canopy();
    const m = analyseScene(scene, 1);
    const out = applyDynamicLod(scene, m, config(), 0);
    expect(out).toBe(scene);
    expect(Array.from(lodNodeScales(m, config(), 0)).every((s) => s === 1)).toBe(true);
    const compact = applyDynamicLod(scene, m, config(), 0, { compact: true });
    expect(Array.from(compact.entries[0]?.mesh.positions ?? [])).toEqual(Array.from(scene.entries[0]?.mesh.positions ?? []));
  });

  it('shrinks continuously (no pops)', () => {
    const m = analyseScene(canopy(), 1);
    const cfg = config();
    const step = 0.0005;
    let prev = lodNodeScales(m, cfg, 0);
    let worst = 0;
    for (let v = step; v <= 1 + 1e-9; v += step) {
      const cur = lodNodeScales(m, cfg, v);
      for (let i = 0; i < cur.length; i++) worst = Math.max(worst, Math.abs((cur[i] as number) - (prev[i] as number)));
      prev = cur;
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('never increases the triangle count with the LOD value', () => {
    const scene = sceneOf([entry('leaf', 'leaf meshes', leafMesh(leaves)), entry('bark', 'branches', tubeMesh(0, 0, 0.1, 3)), entry('bark2', 'branches', tubeMesh(1, 0, 0.05, 2))]);
    const m = analyseScene(scene, 1);
    const cfg = config();
    let last = Infinity;
    let lastScene = Infinity;
    for (let v = 0; v <= 1.0001; v += 0.025) {
      const t = lodReport(m, lodNodeScales(m, cfg, v), v).triangles;
      expect(t).toBeLessThanOrEqual(last);
      last = t;
      const s = applyDynamicLod(scene, m, cfg, v).stats.triangles;
      expect(s).toBeLessThanOrEqual(lastScene);
      lastScene = s;
    }
    expect(last).toBeLessThan(m.totalTriangles);
  });

  it('shrinks branches towards their spine before removing them', () => {
    const scene = sceneOf([entry('bark', 'branches', tubeMesh(0, 0, 0.2, 4)), entry('thin', 'branches', tubeMesh(2, 0, 0.02, 1))]);
    const m = analyseScene(scene, 1);
    const cfg = { ...config(), branches: defaultDynamicLodConfig().branches };
    // find a value at which the thin branch is partially shrunk
    let found = false;
    for (let v = 0.05; v < 1 && !found; v += 0.01) {
      const s = lodNodeScales(m, cfg, v);
      const thin = s[1] as number;
      if (thin > 0.05 && thin < 0.95) {
        found = true;
        const out = applyDynamicLod(scene, m, cfg, v, { compact: true });
        const mesh = out.entries[1]?.mesh as MeshData;
        for (let i = 0; i < mesh.positions.length; i += 3) {
          const radial = Math.hypot((mesh.positions[i] as number) - 2, mesh.positions[i + 1] as number);
          expect(radial).toBeCloseTo(0.02 * thin, 5);
        }
      }
    }
    expect(found).toBe(true);
  });

  it('grows the surviving leaves so the leaf area is kept', () => {
    const scene = canopy();
    const m = analyseScene(scene, 1);
    const area = (s: SceneModel): { sum: number; projected: number } => {
      let sum = 0;
      let projected = 0;
      for (const e of s.entries) {
        const p = e.mesh.positions;
        for (let i = 0; i + 2 < e.mesh.indices.length; i += 3) {
          const [a, b, c] = [e.mesh.indices[i] as number, e.mesh.indices[i + 1] as number, e.mesh.indices[i + 2] as number];
          const ux = (p[b * 3] as number) - (p[a * 3] as number);
          const uy = (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number);
          const uz = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
          const vx = (p[c * 3] as number) - (p[a * 3] as number);
          const vy = (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number);
          const vz = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
          const nx = uy * vz - uz * vy;
          const ny = uz * vx - ux * vz;
          const nz = ux * vy - uy * vx;
          sum += 0.5 * Math.hypot(nx, ny, nz);
          projected += 0.5 * Math.abs(nz);
        }
      }
      return { sum, projected };
    };
    const full = area(scene);
    for (const v of [0.3, 0.6, 0.8]) {
      const grown = area(applyDynamicLod(scene, m, config(), v, { compact: true }));
      expect(Math.abs(grown.sum / full.sum - 1)).toBeLessThan(0.15);
      expect(Math.abs(grown.projected / full.projected - 1)).toBeLessThan(0.15);
    }
    // without grow the area really drops
    const noGrow = { ...config(), growScale: { ...config().growScale, points: config().growScale.points.map((p) => ({ ...p, y: 0 })) } };
    const shrunk = area(applyDynamicLod(scene, m, noGrow, 0.6, { compact: true }));
    expect(shrunk.sum / full.sum).toBeLessThan(0.7);
  });

  it('produces monotone export levels (level k = value k / (n - 1))', () => {
    const scene = sceneOf([entry('leaf', 'leaf meshes', leafMesh(leaves)), entry('bark', 'branches', tubeMesh(0, 0, 0.1, 3))]);
    const m = analyseScene(scene, 1);
    const n = 4;
    const counts = Array.from({ length: n }, (_, k) => applyDynamicLod(scene, m, config(), levelValue(k, n), { compact: true }).stats.triangles);
    expect(counts[0]).toBe(scene.stats.triangles);
    for (let k = 1; k < n; k++) expect(counts[k] as number).toBeLessThanOrEqual(counts[k - 1] as number);
    expect(counts[n - 1] as number).toBeLessThan(counts[0] as number);
    expect(levelValue(0, 4)).toBe(0);
    expect(levelValue(3, 4)).toBe(1);
  });
});

describe('Dynamic LOD settings', () => {
  it('defaults are neutral for old projects', () => {
    const c = readDynamicLodConfig({});
    expect(c.enabled).toBe(false);
    expect(c.value).toBe(0);
    expect(c.levels).toBe(4);
  });

  it('maps the screen coverage to the LOD value', () => {
    expect(lodValueForScreen(1)).toBe(0);
    expect(lodValueForScreen(0.01)).toBe(1);
    expect(lodValueForScreen(0.2)).toBeGreaterThan(lodValueForScreen(0.4));
  });
});

describe('Dynamic LOD in the export pipeline', () => {
  it('builds the levels with the dynamic transform (monotone, level 0 untouched)', async () => {
    const { buildLods } = await import('@/export/lod/lodBuilder');
    const { defaultLodLevels } = await import('@/export/settings');
    const { CancellationSource } = await import('@/contracts/nodes');
    const scene: SceneModel = { ...canopy(), dynamicLod: config() };
    const levels = defaultLodLevels();
    const source = {
      seed: 3,
      evaluateAt: () => Promise.resolve({ scene } as unknown as import('@/contracts/engine').EvaluationSummary),
    };
    const built = await buildLods(source, levels, levels.map((_, i) => i), new CancellationSource().token);
    expect(built[0]?.scene).toBe(scene);
    expect(built[0]?.dynamic?.value).toBe(0);
    for (let k = 1; k < built.length; k++) {
      expect(built[k]?.scene.stats.triangles).toBeLessThanOrEqual(built[k - 1]?.scene.stats.triangles ?? 0);
      expect(built[k]?.dynamic?.value).toBeCloseTo(k / (built.length - 1), 6);
    }
    const last = built[built.length - 1]?.dynamic;
    expect(last?.removedTriangles).toBeGreaterThan(0);
    expect(last?.interiorRemovedShare).toBeGreaterThan(0.3);
  });

  it('resizes the level list to the Tree Levels count', async () => {
    const { resizeLevels } = await import('@/export/lod/dynamicLevels');
    const { defaultLodLevels } = await import('@/export/settings');
    const base = defaultLodLevels();
    expect(resizeLevels(base, 6)).toHaveLength(6);
    expect(resizeLevels(base, 2)).toHaveLength(2);
    const six = resizeLevels(base, 6);
    for (let i = 1; i < six.length; i++) expect(six[i]?.transition).toBeLessThan(six[i - 1]?.transition ?? 0);
  });
});
