import { beforeAll, describe, expect, it } from 'vitest';
import { defaultParams, type NodeParams } from '@/contracts/params';
import { meshVertexCount, type MeshData } from '@/contracts/mesh';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { buildTubeMesh, type TubeOptions } from '@/geometry/tubeMesher';
import {
  atS,
  choosePatches,
  computeRingV,
  DEFAULT_UV_MAPPING,
  layoutPatches,
  normalizeRect,
  remapToRect,
  resolveAreaRect,
  resolveUTiles,
  snapRingsToWhole,
  UV_TILES_ATTR,
  UV_V_ATTR,
  wholeUTiles,
  type PatchRow,
  type UvAreaLike,
  type UvMapping,
  type VInput,
} from '@/generators/uv';
import { EXTENSION_ATTR } from '@/generators/split';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { migrateBranchMaterial, readBranchMaterialRows, readExtensionMaterialRows, readUvMapping } from '@/nodes/generators/uvConfig';

beforeAll(() => registerDiscoveredNodes());

const TWO_PI = Math.PI * 2;

// ---- helpers --------------------------------------------------------------------------------------------------------

function line(points: number, length: number, radius: (k: number) => number, generation = 0, parent: [number, number] = [-1, -1]): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(parent[0], parent[1], generation);
  for (let k = 0; k < points; k++) sb.addPoint(0, 0, (k * length) / (points - 1), radius(k));
  sb.endBranch();
  return sb.build();
}

const opts = (over: Partial<TubeOptions> = {}, mapping: Partial<UvMapping> = {}, sides = 16): TubeOptions => ({
  maxGeneration: 8,
  radialSegments: () => sides,
  color: () => [0.3, 0.2, 0.1],
  uvMetres: 1,
  materialId: 'bark',
  uvMapping: { ...DEFAULT_UV_MAPPING, ...mapping },
  ...over,
});

const uvOf = (m: MeshData, i: number): [number, number] => [m.uv0[i * 2] as number, m.uv0[i * 2 + 1] as number];
const posOf = (m: MeshData, i: number): [number, number, number] => [m.positions[i * 3] as number, m.positions[i * 3 + 1] as number, m.positions[i * 3 + 2] as number];

const vInput = (over: Partial<VInput> = {}): VInput => {
  const n = 21;
  const s = Array.from({ length: n }, (_, k) => (k * 2) / (n - 1));
  return { style: 'absolute', anchor: 'start', scale: 1, skew: 0, pinch: 0, offset: 0, uTiles: 1, metresPerTile: 1, s, radius: s.map(() => 0.1), refRadius: 0.1, ...over };
};

// ---- U ---------------------------------------------------------------------------------------------------------------

describe('U tile count', () => {
  it('is max(1, round(Absolute + Relative x circumference / metres)) and always a whole number >= 1', () => {
    expect(wholeUTiles(0, 1, TWO_PI * 0.5, 1)).toBe(3);
    expect(wholeUTiles(2, 1, TWO_PI * 0.5, 1)).toBe(5);
    expect(wholeUTiles(0, 0, 1, 1)).toBe(1);
    expect(wholeUTiles(0, 1, TWO_PI * 0.02, 1)).toBe(1);
    expect(wholeUTiles(3, 0, 0.1, 2)).toBe(3);
    const rng = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const n = wholeUTiles(rng.range(-2, 12), rng.range(-1, 6), rng.range(0, 12), rng.range(0.01, 4));
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
    }
  });

  it('Fractional > Value ignores Absolute / Relative; Auto copies the parent texel density; off keeps whole numbers', () => {
    const base = { style: 'unrestricted' as const, absolute: 4, relative: 3, circumference: 1.5, metresPerTile: 1 };
    expect(resolveUTiles({ ...base, fractional: { enabled: true, auto: false, value: 2.5 } })).toBe(2.5);
    expect(resolveUTiles({ ...base, fractional: { enabled: true, auto: true, value: 9 }, parentDensity: 2 })).toBeCloseTo(3, 9);
    expect(resolveUTiles({ ...base, fractional: { enabled: true, auto: true, value: 9 } })).toBeCloseTo(1.5, 9);
    expect(Number.isInteger(resolveUTiles({ ...base, fractional: { enabled: false, auto: false, value: 2.5 } }))).toBe(true);
    expect(resolveUTiles({ ...base, style: 'u-locked', fractional: { enabled: true, auto: false, value: 2.5 } })).toBe(1);
    expect(resolveUTiles({ ...base, fractional: { enabled: false, auto: false, value: 1 }, forcedTiles: 7 })).toBe(7);
  });
});

// ---- V ---------------------------------------------------------------------------------------------------------------

describe('V styles', () => {
  it('Absolute: Scale copies per metre; Relative: Scale copies over the whole length', () => {
    const a = computeRingV(vInput({ style: 'absolute', scale: 3 }));
    expect(a[a.length - 1]).toBeCloseTo(6, 6);
    const r = computeRingV(vInput({ style: 'relative', scale: 4 }));
    expect(r[0]).toBe(0);
    expect(r[r.length - 1]).toBeCloseTo(4, 6);
  });

  it('keeps the aspect ratio on a cylinder: one V copy is as long as one U copy is wide', () => {
    const input = vInput({ style: 'aspect', uTiles: 3 });
    const v = computeRingV(input);
    for (let k = 1; k < v.length; k++) {
      const ds = (input.s[k] as number) - (input.s[k - 1] as number);
      const texelV = ((v[k] as number) - (v[k - 1] as number)) / ds;
      const texelU = 3 / (TWO_PI * 0.1);
      expect(texelV / texelU).toBeCloseTo(1, 9);
    }
  });

  it('keeps the aspect ratio on the real mesh of a cylinder', () => {
    const sides = 64;
    const V = sides + 1;
    const m = buildTubeMesh(line(9, 2, () => 0.1), opts({}, { vStyle: 'aspect', uAbsolute: 3, uRelative: 0 }, sides));
    let checked = 0;
    for (let ring = 1; ring < 7; ring++) {
      const i = ring * V + 4;
      const a = posOf(m, i);
      const b = posOf(m, i + 1);
      const up = posOf(m, i + V);
      const du = Math.abs(uvOf(m, i + 1)[0] - uvOf(m, i)[0]);
      const dv = Math.abs(uvOf(m, i + V)[1] - uvOf(m, i)[1]);
      const arc = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      const along = Math.hypot(up[0] - a[0], up[1] - a[1], up[2] - a[2]);
      expect(along).toBeGreaterThan(1e-6);
      const ratio = dv / along / (du / arc);
      expect(ratio).toBeGreaterThan(0.99);
      expect(ratio).toBeLessThan(1.01);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it('Skew correction: 0 tapers the texture with the branch, 1 keeps the proportions everywhere (Pinch floors the tip)', () => {
    const n = 31;
    const s = Array.from({ length: n }, (_, k) => (k * 3) / (n - 1));
    const radius = s.map((x) => 0.2 - (0.15 * x) / 3);
    const common = { style: 'aspect' as const, s, radius, refRadius: 0.2, uTiles: 2, pinch: 0 };
    const flat = computeRingV(vInput({ ...common, skew: 0 }));
    const fixed = computeRingV(vInput({ ...common, skew: 1 }));
    const slope = (v: Float64Array, k: number): number => ((v[k] as number) - (v[k - 1] as number)) / ((s[k] as number) - (s[k - 1] as number));
    expect(slope(flat, 2)).toBeCloseTo(slope(flat, n - 1), 9);
    for (const k of [2, 10, 20, n - 1]) {
      const r = ((radius[k] as number) + (radius[k - 1] as number)) / 2;
      expect((slope(fixed, k) * TWO_PI * r) / 2).toBeCloseTo(1, 1);
    }
    expect(fixed[n - 1]).toBeGreaterThan(flat[n - 1] as number);
    const pointed = computeRingV(vInput({ ...common, radius: s.map((x) => Math.max(1e-4, 0.2 - (0.2 * x) / 3)), skew: 1, pinch: 1 }));
    expect(pointed[n - 1]).toBeLessThan((2 * 3) / (TWO_PI * 0.2 * 0.5) + 1e-6);
  });

  it('Anchor End puts a whole V number on the tip; Offset shifts everything', () => {
    const start = computeRingV(vInput({ style: 'absolute', scale: 1.3 }));
    expect(start[0]).toBe(0);
    const end = computeRingV(vInput({ style: 'absolute', scale: 1.3, anchor: 'end' }));
    expect((end[end.length - 1] as number) % 1).toBeCloseTo(0, 9);
    expect(end[0]).toBeGreaterThanOrEqual(0);
    expect(end[0]).toBeLessThan(1);
    const off = computeRingV(vInput({ offset: 0.25 }));
    expect(off[0]).toBeCloseTo(0.25, 9);
  });

  it('snapRingsToWhole moves near-whole rings onto the number without reordering', () => {
    const v = snapRingsToWhole([0, 0.4, 0.97, 1.5, 2.04, 2.5], 0.1);
    expect(Array.from(v)).toEqual([0, 0.4, 1, 1.5, 2, 2.5]);
    expect(Array.from(snapRingsToWhole([0, 0.96, 1.03], 0.1))).toEqual([0, 0.96, 1]);
    expect(atS([0, 1, 2], [0, 10, 20], 1.5)).toBe(15);
  });
});

// ---- patches ---------------------------------------------------------------------------------------------------------

describe('patch layout', () => {
  const rings = [0, 0.4, 0.8, 1.2, 1.6, 2.0, 2.4, 2.8, 3.2];

  it('adds a doubled ring at every whole V number and keeps local V in [0, 1]', () => {
    const l = layoutPatches({ v: rings, optimize: false, tolerance: 0.1, firstFree: 0 });
    expect(l.patches).toBe(4);
    // 1.0 and 3.0 fall between rings (+2 each); 2.0 is an existing ring (doubled: +1).
    expect(l.count).toBe(rings.length + 5);
    expect(l.seamStart.reduce((a, b) => a + b, 0)).toBe(3);
    for (let k = 0; k < l.count; k++) {
      expect(l.localV[k]).toBeGreaterThanOrEqual(0);
      expect(l.localV[k]).toBeLessThanOrEqual(1);
      if (l.seamStart[k] === 1) {
        expect(l.src[k]).toBe(l.src[k - 1]);
        expect(l.frac[k]).toBe(l.frac[k - 1]);
        expect(l.localV[k]).toBe(0);
        expect(l.localV[k - 1]).toBe(1);
        expect((l.patch[k] as number) - (l.patch[k - 1] as number)).toBe(1);
      }
    }
    for (let k = 1; k < l.count; k++) expect(l.patch[k]).toBeGreaterThanOrEqual(l.patch[k - 1] as number);
  });

  it('Optimize segments snaps a seam onto a ring within the tolerance instead of adding one', () => {
    const near = [0, 0.5, 0.97, 1.5, 2.0];
    const plain = layoutPatches({ v: near, optimize: false, tolerance: 0.1, firstFree: 0 });
    const tuned = layoutPatches({ v: near, optimize: true, tolerance: 0.1, firstFree: 0 });
    expect(plain.count).toBe(near.length + 2);
    expect(tuned.count).toBe(near.length + 1);
    expect(tuned.frac.every((f) => f === 0)).toBe(true);
    expect(tuned.patches).toBe(2);
  });

  it('never puts a seam inside the weld rings', () => {
    const l = layoutPatches({ v: [0, 0.3, 0.6, 0.9, 1.2, 1.5, 1.8], optimize: false, tolerance: 0.1, firstFree: 4 });
    const seam = Array.from(l.seamStart).findIndex((f) => f === 1);
    expect(seam).toBeGreaterThanOrEqual(5);
    for (let k = 0; k < 4; k++) expect(l.patch[k]).toBe(0);
  });

  it('is deterministic and handles a branch shorter than one patch', () => {
    const a = layoutPatches({ v: rings, optimize: true, tolerance: 0.2, firstFree: 1 });
    const b = layoutPatches({ v: rings, optimize: true, tolerance: 0.2, firstFree: 1 });
    expect(Array.from(a.localV)).toEqual(Array.from(b.localV));
    const short = layoutPatches({ v: [0, 0.2, 0.5], optimize: false, tolerance: 0.1, firstFree: 0 });
    expect(short.patches).toBe(1);
    expect(short.count).toBe(3);
  });
});

describe('UV Areas', () => {
  const areas: UvAreaLike[] = [
    { id: 'a1', name: 'Plate', materialId: 'barkA', rect: [0, 0, 0.5, 0.5], usage: 'bark', weight: 1 },
    { id: 'a2', name: 'Crack', materialId: 'barkA', rect: [0.5, 0.5, 1, 1], usage: 'any', weight: 3 },
    { id: 'l1', name: 'LeafOnly', materialId: 'barkA', rect: [0, 0.5, 0.5, 1], usage: 'leaf', weight: 5 },
    { id: 'b1', name: 'Other', materialId: 'barkB', rect: [0.2, 0.2, 0.4, 0.4], usage: 'any', weight: 1 },
  ];

  it('normalizes rectangles into the unit square and remaps inside them', () => {
    expect(normalizeRect([0.8, 0.9, 0.2, 0.1])).toEqual([0.2, 0.1, 0.8, 0.9]);
    expect(normalizeRect([-1, -1, 2, 2])).toEqual([0, 0, 1, 1]);
    expect(normalizeRect([0.3, 0.3, 0.3, 0.9])).toEqual([0, 0, 1, 1]);
    const rect = normalizeRect([0.25, 0.5, 0.75, 1]);
    for (const [u, v] of [[0, 0], [1, 1], [0.5, 0.5], [-3, 7], [1.0001, -0.2]] as const) {
      const [ru, rv] = remapToRect(rect, u, v);
      expect(ru).toBeGreaterThanOrEqual(0.25);
      expect(ru).toBeLessThanOrEqual(0.75);
      expect(rv).toBeGreaterThanOrEqual(0.5);
      expect(rv).toBeLessThanOrEqual(1);
    }
  });

  it('resolves Whole map, Any (bark / any usage of the material only), ids, names and unknown values', () => {
    const rng = new Rng(3);
    expect(resolveAreaRect('whole', 'barkA', areas, rng)).toEqual([0, 0, 1, 1]);
    expect(resolveAreaRect('', 'barkA', areas, rng)).toEqual([0, 0, 1, 1]);
    expect(resolveAreaRect('a1', 'barkA', areas, rng)).toEqual([0, 0, 0.5, 0.5]);
    expect(resolveAreaRect('Crack', 'barkA', areas, rng)).toEqual([0.5, 0.5, 1, 1]);
    expect(resolveAreaRect('missing', 'barkA', areas, rng)).toEqual([0, 0, 1, 1]);
    expect(resolveAreaRect('any', 'none', areas, rng)).toEqual([0, 0, 1, 1]);
    const seen = new Set<string>();
    for (let i = 0; i < 80; i++) seen.add(resolveAreaRect('any', 'barkA', areas, rng).join(','));
    expect([...seen].sort()).toEqual(['0,0,0.5,0.5', '0.5,0.5,1,1']);
  });
});

describe('patch material choice', () => {
  const rows: PatchRow[] = [
    { material: 'A', weight: 1, uvArea: 'whole', placement: 'first' },
    { material: 'A', weight: 1, uvArea: 'any', placement: 'anywhere' },
    { material: 'B', weight: 1, uvArea: 'whole', placement: 'anywhere' },
  ];
  const deps = { resolveMaterial: (ref: string): string => ref, areas: [] as UvAreaLike[] };

  it('Tiling picks one row by weight for the whole branch', () => {
    const c = choosePatches('tiling', rows, 5, new Rng(1), deps);
    expect(c.materials).toHaveLength(1);
    expect(c.rects).toEqual([[0, 0, 1, 1]]);
  });

  it('choose-one keeps a single material over all patches; use-all mixes materials', () => {
    for (let seed = 1; seed < 20; seed++) {
      const one = choosePatches('patch-one', rows, 6, new Rng(seed), deps);
      expect(one.materials).toHaveLength(6);
      expect(new Set(one.materials).size).toBe(1);
    }
    const mixed = new Set<string>();
    for (let seed = 1; seed < 20; seed++) for (const m of choosePatches('patch-all', rows, 6, new Rng(seed), deps).materials) mixed.add(m);
    expect(mixed).toEqual(new Set(['A', 'B']));
  });

  it('First ring rows only compete for the first patch', () => {
    const only: PatchRow[] = [
      { material: 'A', weight: 1, uvArea: 'whole', placement: 'first' },
      { material: 'B', weight: 1, uvArea: 'whole', placement: 'anywhere' },
    ];
    for (let seed = 1; seed < 30; seed++) {
      const c = choosePatches('patch-all', only, 5, new Rng(seed), deps);
      expect(c.materials.slice(1).every((m) => m === 'B')).toBe(true);
    }
  });

  it('is deterministic and respects zero weights', () => {
    const a = choosePatches('patch-all', rows, 8, new Rng(11), deps);
    const b = choosePatches('patch-all', rows, 8, new Rng(11), deps);
    expect(a).toEqual(b);
    const zero = choosePatches('patch-all', [{ ...(rows[0] as PatchRow), weight: 0, placement: 'anywhere' }, rows[2] as PatchRow], 6, new Rng(5), deps);
    expect(zero.materials.every((m) => m === 'B')).toBe(true);
  });
});

// ---- mesher ----------------------------------------------------------------------------------------------------------

describe('tube mesher UV0', () => {
  const taper = (): Skeleton => line(13, 3, (k) => 0.2 - k * 0.01);
  const allU = (m: MeshData): number[] => Array.from({ length: meshVertexCount(m) }, (_, i) => uvOf(m, i)[0]);
  const allV = (m: MeshData): number[] => Array.from({ length: meshVertexCount(m) }, (_, i) => uvOf(m, i)[1]);

  it('Tiling with the default mapping equals the legacy world-size tiling', () => {
    const a = buildTubeMesh(taper(), opts({ uvMapping: undefined, uv: { scaleU: 1, scaleV: 1 } }));
    const b = buildTubeMesh(taper(), opts());
    expect(Array.from(a.uv0)).toEqual(Array.from(b.uv0));
  });

  it('U locked keeps U in [0, 1]; U and V locked keeps the whole map in [0, 1]', () => {
    const u = buildTubeMesh(taper(), opts({}, { style: 'u-locked', uOffset: 3, twist: 1 }));
    for (const x of allU(u)) {
      expect(x).toBeGreaterThanOrEqual(-1e-6);
      expect(x).toBeLessThanOrEqual(1 + 1e-6);
    }
    expect(Math.max(...allV(u))).toBeGreaterThan(1);
    const uv = buildTubeMesh(taper(), opts({}, { style: 'uv-locked', vOffset: 2, uAbsolute: 5 }));
    for (const c of [...allU(uv), ...allV(uv)]) {
      expect(c).toBeGreaterThanOrEqual(-1e-6);
      expect(c).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('Twist spirals U along V, Offset moves it, Rotate swaps the axes', () => {
    const sides = 16;
    const V = sides + 1;
    const base = { uRelative: 0, uAbsolute: 1 };
    const cyl = (): Skeleton => line(5, 2, () => 0.1);
    const plain = buildTubeMesh(cyl(), opts({}, base, sides));
    const twisted = buildTubeMesh(cyl(), opts({}, { ...base, twist: 0.25 }, sides));
    const top = 3 * V + 4;
    expect(uvOf(twisted, top)[0] - uvOf(plain, top)[0]).toBeCloseTo(0.25 * uvOf(plain, top)[1], 6);
    const moved = buildTubeMesh(cyl(), opts({}, { ...base, uOffset: 0.5 }, sides));
    expect(uvOf(moved, 4)[0] - uvOf(plain, 4)[0]).toBeCloseTo(0.5, 6);
    const rotated = buildTubeMesh(cyl(), opts({}, { ...base, rotate: true }, sides));
    expect(uvOf(rotated, top)[0]).toBeCloseTo(uvOf(plain, top)[1], 6);
    expect(uvOf(rotated, top)[1]).toBeCloseTo(uvOf(plain, top)[0], 6);
  });

  it('random Offset variance and Random flip differ per branch and are deterministic', () => {
    const two = (): Skeleton => {
      const sb = new SkeletonBuilder();
      for (let b = 0; b < 2; b++) {
        sb.beginBranch(-1, -1, 0);
        for (let k = 0; k < 4; k++) sb.addPoint(b * 2, 0, k * 0.5, 0.1);
        sb.endBranch();
      }
      return sb.build();
    };
    const mapping: Partial<UvMapping> = { uOffset: 0, uOffsetVariance: 1, vOffsetVariance: 1, twist: 0.5, twistRandomFlip: true, uRelative: 0, uAbsolute: 2 };
    const a = buildTubeMesh(two(), opts({ seed: 5 }, mapping));
    const b = buildTubeMesh(two(), opts({ seed: 5 }, mapping));
    const c = buildTubeMesh(two(), opts({ seed: 6 }, mapping));
    expect(Array.from(a.uv0)).toEqual(Array.from(b.uv0));
    expect(Array.from(a.uv0)).not.toEqual(Array.from(c.uv0));
    // The first vertex of each branch sits at V = Offset: the two branches start at different V.
    const minV = (from: number, to: number): number => Math.min(...allV(a).slice(from, to));
    const half = Math.floor(meshVertexCount(a) / 2);
    expect(minV(0, half)).not.toBeCloseTo(minV(half, meshVertexCount(a)), 4);
  });

  it('patch styles keep UV inside the UV Area, double the seam vertices and use one slot per material', () => {
    const areas: UvAreaLike[] = [
      { id: 'a1', name: 'A1', materialId: 'matA', rect: [0, 0, 0.5, 0.5], usage: 'bark', weight: 1 },
      { id: 'b1', name: 'B1', materialId: 'matB', rect: [0.5, 0.5, 1, 1], usage: 'bark', weight: 1 },
    ];
    const rows: PatchRow[] = [
      { material: 'matA', weight: 1, uvArea: 'a1', placement: 'anywhere' },
      { material: 'matB', weight: 1, uvArea: 'b1', placement: 'anywhere' },
    ];
    const sides = 8;
    const make = (mapping: Partial<UvMapping>): MeshData =>
      buildTubeMesh(line(13, 3, (k) => 0.2 - k * 0.01), {
        ...opts({ seed: 4 }, mapping, sides),
        uvMaterials: { branchRows: rows, extensionRows: rows, areas, resolve: (ref) => ref },
      });
    const plain = make({});
    const patched = make({ tiling: 'patch-all', uAbsolute: 3 });
    const rect = (id: string): readonly number[] => (areas.find((a) => a.materialId === id) as UvAreaLike).rect;
    const slotMaterials = new Set<string>();
    for (const slot of patched.slots) {
      if (slot.indexCount === 0) continue;
      slotMaterials.add(slot.materialId);
      const r = rect(slot.materialId);
      for (let k = slot.indexStart; k < slot.indexStart + slot.indexCount; k++) {
        const [u, v] = uvOf(patched, patched.indices[k] as number);
        expect(u).toBeGreaterThanOrEqual((r[0] as number) - 1e-6);
        expect(u).toBeLessThanOrEqual((r[2] as number) + 1e-6);
        expect(v).toBeGreaterThanOrEqual((r[1] as number) - 1e-6);
        expect(v).toBeLessThanOrEqual((r[3] as number) + 1e-6);
      }
    }
    // 3 m at 1 m per tile: seams at 1 m and 2 m.
    expect(plain.slots.filter((s) => s.indexCount > 0).length).toBe(1);
    expect(slotMaterials.size).toBeGreaterThanOrEqual(1);
    // Doubled rings: positions shared by vertices with different UV.
    const groups = new Map<string, Set<string>>();
    for (let i = 0; i < meshVertexCount(patched); i++) {
      const key = posOf(patched, i).map((x) => Math.round(x * 1e4)).join(',');
      const set = groups.get(key) ?? new Set<string>();
      set.add(uvOf(patched, i).map((x) => x.toFixed(4)).join(','));
      groups.set(key, set);
    }
    const doubled = [...groups.values()].filter((s) => s.size >= 2).length;
    expect(doubled).toBeGreaterThanOrEqual(2 * sides);
    expect(meshVertexCount(patched)).toBeGreaterThan(meshVertexCount(plain));
    expect(patched.slots.reduce((n, s) => n + s.indexCount, 0)).toBe(patched.indices.length);
  });

  it('patch-all mixes the assigned materials over the patches of long branches', () => {
    const rows: PatchRow[] = [
      { material: 'matA', weight: 1, uvArea: 'whole', placement: 'anywhere' },
      { material: 'matB', weight: 1, uvArea: 'whole', placement: 'anywhere' },
    ];
    const m = buildTubeMesh(line(41, 10, () => 0.1), {
      ...opts({ seed: 2 }, { tiling: 'patch-all' }, 8),
      uvMaterials: { branchRows: rows, extensionRows: rows, areas: [], resolve: (ref) => ref },
    });
    expect(new Set(m.slots.filter((s) => s.indexCount > 0).map((s) => s.materialId))).toEqual(new Set(['matA', 'matB']));
    for (const c of [...allU(m), ...allV(m)]) {
      expect(c).toBeGreaterThanOrEqual(-1e-6);
      expect(c).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('patch generation is deterministic', () => {
    const rows: PatchRow[] = [
      { material: 'matA', weight: 1, uvArea: 'whole', placement: 'anywhere' },
      { material: 'matB', weight: 2, uvArea: 'whole', placement: 'anywhere' },
    ];
    const build = (): MeshData =>
      buildTubeMesh(line(13, 3, () => 0.1), {
        ...opts({ seed: 9 }, { tiling: 'patch-all', optimizeSegments: true }),
        uvMaterials: { branchRows: rows, extensionRows: rows, areas: [], resolve: (ref) => ref },
      });
    const a = build();
    const b = build();
    expect(Array.from(a.uv0)).toEqual(Array.from(b.uv0));
    expect(a.slots).toEqual(b.slots);
  });

  it('extensions continue the parent mapping (Automatic) or use their own (Manual full control)', () => {
    const parent = line(7, 2.4, () => 0.3);
    buildTubeMesh(parent, opts());
    const parentTiles = (parent.attributes.get(UV_TILES_ATTR) as Float32Array)[6] as number;
    const parentV = (parent.attributes.get(UV_V_ATTR) as Float32Array)[6] as number;
    expect(parentTiles).toBe(2);
    expect(parentV).toBeCloseTo(2.4, 4);
    const make = (extensionStyle: UvMapping['extensionStyle']): MeshData => {
      const child = line(5, 1, () => 0.05, 1, [0, 6]);
      child.attributes.set(EXTENSION_ATTR, new Float32Array(child.count).fill(1));
      return buildTubeMesh(child, opts({ parent }, { extensionStyle }, 12));
    };
    const auto = make('automatic');
    expect(Math.max(...allU(auto))).toBeCloseTo(2, 4);
    expect(Math.min(...allV(auto))).toBeCloseTo(parentV, 3);
    expect(Math.max(...allU(make('match-u')))).toBeCloseTo(2, 4);
    expect(Math.min(...allV(make('match-u')))).toBeCloseTo(0, 3);
    expect(Math.min(...allV(make('match')))).toBeCloseTo(parentV, 3);
    expect(Math.max(...allU(make('full')))).toBe(1);
  });

  it('Fractional > Auto matches the texel density of the parent', () => {
    const parent = line(7, 2.4, () => 0.3);
    buildTubeMesh(parent, opts());
    const child = line(5, 1, () => 0.1, 1, [0, 3]);
    const m = buildTubeMesh(child, opts({ parent }, { fractional: { enabled: true, auto: true, value: 1 } }, 12));
    // parent: 2 tiles around radius 0.3; child radius 0.1 -> 2 / 3 tiles.
    expect(Math.max(...allU(m))).toBeCloseTo(2 / 3, 3);
  });
});

// ---- parameter reader ------------------------------------------------------------------------------------------------

describe('UV parameters', () => {
  const branchParams = (): NonNullable<ReturnType<typeof getNodeDef>>['params'] => (getNodeDef('generator.branch') as NonNullable<ReturnType<typeof getNodeDef>>).params;
  const defs = (): NodeParams => defaultParams(branchParams());
  const labelValue = (id: string, label: string): string => {
    const def = branchParams().find((p) => p.id === id);
    if (!def || def.kind !== 'enum') throw new Error(id);
    const opt = def.options.find((o) => o.label === label);
    if (!opt) throw new Error(label);
    return opt.value;
  };

  it('the defaults reproduce the previous tiling by world size', () => {
    expect(readUvMapping(defs())).toEqual(DEFAULT_UV_MAPPING);
  });

  it('reads every enum label of the UV tab', () => {
    const p = defs();
    p.uvStyle = { value: labelValue('uvStyle', 'U and V locked [0,1]') };
    p.extensionUvStyle = { value: labelValue('extensionUvStyle', 'Manual (match u only)') };
    p.uvVStyle = { value: labelValue('uvVStyle', 'Relative (keep aspect ratio)') };
    p.uvVAnchor = { value: labelValue('uvVAnchor', 'End') };
    p.uvTilingStyle = { value: labelValue('uvTilingStyle', '0-1 patches (use all assigned materials)') };
    const m = readUvMapping(p);
    expect([m.style, m.extensionStyle, m.vStyle, m.vAnchor, m.tiling]).toEqual(['uv-locked', 'match-u', 'aspect', 'end', 'patch-all']);
    p.uvStyle = { value: labelValue('uvStyle', 'U locked [0,1], V unrestricted') };
    p.extensionUvStyle = { value: labelValue('extensionUvStyle', 'Manual (match)') };
    p.uvVStyle = { value: labelValue('uvVStyle', 'Relative') };
    p.uvTilingStyle = { value: labelValue('uvTilingStyle', '0-1 patches (choose one assigned material)') };
    const n = readUvMapping(p);
    expect([n.style, n.extensionStyle, n.vStyle, n.tiling]).toEqual(['u-locked', 'match', 'relative', 'patch-one']);
  });

  it('old projects keep their look (U scale, Normalized, Match one V tile)', () => {
    const scaled = readUvMapping({ uvScaleU: { value: 3 }, uvScaleV: { value: 2 } });
    expect(scaled.uRelative).toBe(3);
    expect(scaled.vScale).toBe(2);
    const normalized = readUvMapping({ uvMode: { value: 'normalized' }, uvScaleU: { value: 4 } });
    expect(normalized.vStyle).toBe('relative');
    expect(normalized.fractional).toEqual({ enabled: true, auto: false, value: 4 });
    expect(readUvMapping({ matchOneVTile: { value: true } }).vStyle).toBe('relative');
  });

  it('reads variance of the offsets and has the patch options only on the Branch', () => {
    const p = defs();
    p.uvOffsetU = { value: 0.25, variance: 0.5 };
    p.uvOffsetV = { value: 0, variance: 2 };
    const m = readUvMapping(p);
    expect(m.uOffset).toBe(0.25);
    expect(m.uOffsetVariance).toBe(0.5);
    expect(m.vOffsetVariance).toBe(1);
    const ids = (type: string): string[] => (getNodeDef(type)?.params ?? []).map((d) => d.id);
    expect(ids('generator.branch')).toContain('uvTilingStyle');
    expect(ids('generator.branch')).toContain('barkMaterials');
    expect(ids('generator.trunk')).not.toContain('uvTilingStyle');
    expect(ids('generator.trunk')).toContain('uvVStyle');
  });

  it('material lists: legacy single material migrates to the first row; extensions start as Inherited', () => {
    const migrated = migrateBranchMaterial({ material: { value: 'mat-bark' } });
    expect(migrated.material).toBeUndefined();
    expect(readBranchMaterialRows(migrated)).toEqual([{ material: 'mat-bark', weight: 1, uvArea: 'whole', placement: 'anywhere' }]);
    expect(readBranchMaterialRows({ material: { value: 'old' } })[0]?.material).toBe('old');
    expect(readExtensionMaterialRows({})[0]?.material).toBe('inherited');
    expect(readExtensionMaterialRows(defs())[0]?.material).toBe('inherited');
    const rows = readBranchMaterialRows({ barkMaterials: { value: [{ material: 'a', weight: 2, uvArea: 'any', placement: 'first-ring' }, { material: 'inherited', weight: -3 }] } });
    expect(rows[0]).toEqual({ material: 'a', weight: 2, uvArea: 'any', placement: 'first' });
    expect(rows[1]).toEqual({ material: 'inherited', weight: 0, uvArea: 'whole', placement: 'anywhere' });
    expect(migrateBranchMaterial({ barkMaterials: { value: [] } }).barkMaterials?.value).toEqual([]);
  });
});
