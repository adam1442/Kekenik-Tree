import { beforeAll, describe, expect, it } from 'vitest';
import type { MaterialDef } from '@/contracts/material';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { buildTubeMesh } from '@/geometry/tubeMesher';
import { BARK_STYLES } from '@/generators/displace/bark';
import { createBranchDisplacer, type BranchDisplaceSpec } from '@/generators/displace';
import { registerDiscoveredNodes } from '@/graph/registry';
import { createDisplacementDef, registerDisplacementSource, sampleHeightField, sourceAlphaVaries } from '@/materials/displacement';
import { setMaterialSource } from '@/materials/materialSource';
import { resolveHeightSource } from '@/nodes/generators/displacement';
import { BARK_RECIPES, BARK_RECIPE_IDS, barkMaps, barkMapsFromRecipe, roughnessToGloss, type BarkMaps } from '@/presets/procTextures';
import { encodePng } from '@/export/images/imageOps';
import { decodePng } from '@/textures/pngDecode';
import { fnvHash } from '@/textures/bytes';
import { buildNormalMips, flipRows } from '@/textures/normalMips';

beforeAll(() => registerDiscoveredNodes());

const SIZE = 128;
const sets = new Map<string, BarkMaps>();
const setOf = (style: (typeof BARK_STYLES)[number]): BarkMaps => {
  let m = sets.get(style);
  if (!m) {
    m = barkMaps(style, [0.4, 0.3, 0.2], 7, SIZE, { scale: 0.08 });
    sets.set(style, m);
  }
  return m;
};

const range = (a: Float32Array): number => {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of a) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return hi - lo;
};

describe('barkMaps: tileability', () => {
  for (const style of BARK_STYLES) {
    it(`${style}: height wraps in U and V (seam step within 6 % of the range of the interior step; an untiled field gives > 20 %)`, () => {
      const { heights, size } = setOf(style);
      const r = range(heights);
      let seamU = 0;
      let seamV = 0;
      let innerU = 0;
      let innerV = 0;
      for (let a = 0; a < size; a++) {
        seamU += Math.abs((heights[a * size] as number) - (heights[a * size + size - 1] as number));
        seamV += Math.abs((heights[a] as number) - (heights[(size - 1) * size + a] as number));
        for (let b = 0; b < size - 1; b++) {
          innerU += Math.abs((heights[a * size + b] as number) - (heights[a * size + b + 1] as number));
          innerV += Math.abs((heights[b * size + a] as number) - (heights[(b + 1) * size + a] as number));
        }
      }
      // A periodic field has the same step across the seam as anywhere else (one row / column is a noisy sample, hence 6 %).
      expect((seamU - innerU / (size - 1)) / size / r).toBeLessThan(0.06);
      expect((seamV - innerV / (size - 1)) / size / r).toBeLessThan(0.06);
    });
  }

  it('the normal map wraps too (no seam in the shading)', () => {
    const { normal, size } = setOf('furrowed');
    let d = 0;
    for (let y = 0; y < size; y++) {
      for (const c of [0, 1]) d += Math.abs((normal.data[(y * size) * 4 + c] as number) - (normal.data[(y * size + size - 1) * 4 + c] as number));
    }
    expect(d / (size * 2) / 255).toBeLessThan(0.05);
  });
});

describe('barkMaps: determinism and channels', () => {
  it('same inputs give identical bytes, other seeds differ', () => {
    const a = barkMaps('plated', [0.3, 0.3, 0.3], 3, 64);
    const b = barkMaps('plated', [0.3, 0.3, 0.3], 3, 64);
    const c = barkMaps('plated', [0.3, 0.3, 0.3], 4, 64);
    const hash = (m: BarkMaps): string => [m.color, m.normal, m.ao, m.roughness, m.height].map((i) => fnvHash(new Uint8Array(i.data.buffer))).join('|');
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).not.toBe(hash(c));
  });

  it('alpha of the normal map = height (and the grey height image)', () => {
    for (const style of BARK_STYLES) {
      const m = setOf(style);
      for (let i = 0; i < m.size * m.size; i++) {
        expect(m.normal.data[i * 4 + 3]).toBe(m.height.data[i * 4]);
        expect(m.normal.data[i * 4 + 3]).toBe(Math.round((m.heights[i] as number) * 255) + 0);
      }
      expect(range(m.heights)).toBeGreaterThan(0.99);
    }
  });

  it('normal vectors have unit length within 1e-2 and point out of the surface', () => {
    for (const style of BARK_STYLES) {
      const { normal } = setOf(style);
      for (let i = 0; i < normal.data.length; i += 4) {
        const x = ((normal.data[i] as number) / 255) * 2 - 1;
        const y = ((normal.data[i + 1] as number) / 255) * 2 - 1;
        const z = ((normal.data[i + 2] as number) / 255) * 2 - 1;
        expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(1e-2);
        expect(z).toBeGreaterThan(0);
      }
    }
  });

  it('roughness is higher in crevices than on ridges, AO darker in crevices; colour follows the height', () => {
    const m = setOf('furrowed');
    const n = m.size * m.size;
    const corr = (a: (i: number) => number): number => {
      let sa = 0;
      let sh = 0;
      for (let i = 0; i < n; i++) {
        sa += a(i);
        sh += m.heights[i] as number;
      }
      sa /= n;
      sh /= n;
      let c = 0;
      let va = 0;
      let vh = 0;
      for (let i = 0; i < n; i++) {
        const da = a(i) - sa;
        const dh = (m.heights[i] as number) - sh;
        c += da * dh;
        va += da * da;
        vh += dh * dh;
      }
      return c / Math.sqrt(va * vh);
    };
    expect(corr((i) => m.roughness.data[i * 4] as number)).toBeLessThan(-0.3);
    expect(corr((i) => m.ao.data[i * 4] as number)).toBeGreaterThan(0.3);
    expect(corr((i) => m.color.data[i * 4] as number)).toBeGreaterThan(0.6);
    const g = roughnessToGloss(m.roughness);
    expect((g.data[0] as number) + (m.roughness.data[0] as number)).toBe(255);
  });

  it('generates a 256 px set within a generous time budget', () => {
    const t0 = performance.now();
    const m = barkMaps('plated', [0.3, 0.3, 0.3], 1, 256);
    const ms = performance.now() - t0;
    expect(m.color.width).toBe(256);
    expect(ms).toBeLessThan(1500);
  });
});

/** Radix-2 complex FFT (in place) used to re-integrate the normal map (Frankot-Chellappa). */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = i + k + len / 2;
        const tr = (re[b] as number) * wr - (im[b] as number) * wi;
        const ti = (re[b] as number) * wi + (im[b] as number) * wr;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) {
    re[i] = (re[i] as number) / n;
    im[i] = (im[i] as number) / n;
  }
}

function fft2(re: Float64Array, im: Float64Array, size: number, inverse: boolean): void {
  const rr = new Float64Array(size);
  const ri = new Float64Array(size);
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b < size; b++) {
        const idx = pass === 0 ? a * size + b : b * size + a;
        rr[b] = re[idx] as number;
        ri[b] = im[idx] as number;
      }
      fft(rr, ri, inverse);
      for (let b = 0; b < size; b++) {
        const idx = pass === 0 ? a * size + b : b * size + a;
        re[idx] = rr[b] as number;
        im[idx] = ri[b] as number;
      }
    }
  }
}

function integrate(normal: BarkMaps['normal'], size: number): Float64Array {
  const gx = new Float64Array(size * size);
  const gy = new Float64Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const nx = ((normal.data[i * 4] as number) / 255) * 2 - 1;
    const ny = ((normal.data[i * 4 + 1] as number) / 255) * 2 - 1;
    const nz = ((normal.data[i * 4 + 2] as number) / 255) * 2 - 1;
    gx[i] = -nx / nz; // dh/dx
    gy[i] = ny / nz; // dh/drow (V runs upwards, rows downwards)
  }
  const xi = new Float64Array(size * size);
  const yi = new Float64Array(size * size);
  const zi = new Float64Array(size * size);
  fft2(gx, xi, size, false);
  fft2(gy, yi, size, false);
  const out = new Float64Array(size * size);
  const oi = new Float64Array(size * size);
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      const kx = (u <= size / 2 ? u : u - size) * ((2 * Math.PI) / size);
      const ky = (v <= size / 2 ? v : v - size) * ((2 * Math.PI) / size);
      const d = kx * kx + ky * ky;
      const i = v * size + u;
      if (d === 0) continue;
      // h^ = -i (kx gx^ + ky gy^) / |k|^2
      const re = (kx * (xi[i] as number) + ky * (yi[i] as number)) / d;
      const im = -(kx * (gx[i] as number) + ky * (gy[i] as number)) / d;
      out[i] = re;
      oi[i] = im;
    }
  }
  fft2(out, oi, size, true);
  void zi;
  return out;
}

const correlation = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let c = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = (a[i] as number) - ma;
    const db = (b[i] as number) - mb;
    c += da * db;
    va += da * da;
    vb += db * db;
  }
  return c / Math.sqrt(va * vb);
};

describe('barkMaps: normal from height', () => {
  for (const style of BARK_STYLES) {
    it(`${style}: re-integrating the normal map correlates > 0.9 with the height`, () => {
      const m = setOf(style);
      const h = integrate(m.normal, m.size);
      expect(correlation(h, m.heights)).toBeGreaterThan(0.9);
    });
  }

  it('a stronger Strength tilts the normals further', () => {
    const lo = barkMaps('furrowed', [0.4, 0.3, 0.2], 7, 64, { strength: 0.5 });
    const hi = barkMaps('furrowed', [0.4, 0.3, 0.2], 7, 64, { strength: 4 });
    const tilt = (m: BarkMaps): number => {
      let s = 0;
      for (let i = 0; i < 64 * 64; i++) s += Math.abs((m.normal.data[i * 4] as number) - 128);
      return s;
    };
    expect(tilt(hi)).toBeGreaterThan(tilt(lo) * 2);
  });
});

describe('normal mips and PNG round trip', () => {
  it('every mip level is renormalised (unit length within 1e-2) and the alpha is averaged', () => {
    const { normal } = setOf('plated');
    const chain = buildNormalMips(normal);
    expect(chain.length).toBe(8);
    expect(chain[chain.length - 1]?.width).toBe(1);
    for (const level of chain) {
      for (let i = 0; i < level.data.length; i += 4) {
        const x = ((level.data[i] as number) / 255) * 2 - 1;
        const y = ((level.data[i + 1] as number) / 255) * 2 - 1;
        const z = ((level.data[i + 2] as number) / 255) * 2 - 1;
        expect(Math.abs(Math.hypot(x, y, z) - 1)).toBeLessThan(1e-2);
      }
    }
    const meanA = (l: { data: Uint8ClampedArray }): number => {
      let s = 0;
      for (let i = 3; i < l.data.length; i += 4) s += l.data[i] as number;
      return s / (l.data.length / 4);
    };
    expect(Math.abs(meanA(chain[3] as { data: Uint8ClampedArray }) - meanA(normal))).toBeLessThan(1.5);
  });

  it('a plain box filter would shorten the vectors, the renormalised mip does not', () => {
    const { normal } = setOf('furrowed');
    const chain = buildNormalMips(normal);
    const top = chain[4] as { data: Uint8ClampedArray };
    let minLen = 1;
    for (let i = 0; i < top.data.length; i += 4) {
      const x = ((top.data[i] as number) / 255) * 2 - 1;
      const y = ((top.data[i + 1] as number) / 255) * 2 - 1;
      const z = ((top.data[i + 2] as number) / 255) * 2 - 1;
      minLen = Math.min(minLen, Math.hypot(x, y, z));
    }
    expect(minLen).toBeGreaterThan(0.98);
  });

  it('PNG encode -> decode keeps RGB exact under a low alpha, flipRows reverses the rows', () => {
    const { normal } = setOf('furrowed');
    const back = decodePng(encodePng(normal));
    expect(back).not.toBeNull();
    expect(Array.from(back?.data ?? [])).toEqual(Array.from(normal.data));
    const flipped = flipRows(normal);
    expect(flipped.data[0]).toBe(normal.data[(normal.height - 1) * normal.width * 4]);
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('recipes and presets', () => {
  it('every recipe produces a set and uses a known style', () => {
    expect(BARK_RECIPE_IDS.length).toBeGreaterThanOrEqual(8);
    for (const id of BARK_RECIPE_IDS) {
      expect(BARK_STYLES).toContain(BARK_RECIPES[id].style);
      expect(barkMapsFromRecipe(id, 1, 32).normal.width).toBe(32);
    }
    for (const fam of ['broadleaf', 'conifer', 'birch', 'palm', 'cactus'] as const) expect(BARK_RECIPES[fam]).toBeDefined();
  });
});

describe('Displacement source = Material with a generated bark set', () => {
  const RADIUS = 0.2;
  const LENGTH = 2.5;
  const cylinder = (): Skeleton => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i < 6; i++) sb.addPoint(0, 0, (i * LENGTH) / 5, RADIUS);
    sb.endBranch();
    return sb.build();
  };

  it('uses the alpha of the normal map when there is no Height map; displacement correlates > 0.9 with the height at the vertex UVs', () => {
    const maps = barkMaps('furrowed', [0.4, 0.3, 0.2], 5, 256, { scale: 0.1 });
    registerDisplacementSource('t07-normal', { width: 256, height: 256, rgba: maps.normal.data });
    expect(sourceAlphaVaries('t07-normal')).toBe(true);
    const mat = { id: 'bark', name: 'Bark', slots: { normal: { texture: { assetId: 't07-normal' } } } } as unknown as MaterialDef;
    setMaterialSource({ materials: () => [mat], sets: () => [], masks: () => [], season: () => 0.5, displacements: () => [] });
    const src = resolveHeightSource({ displaceSource: { value: 'material' } }, 'bark');
    expect(src.state).toBe('ready');
    expect(src.chain).not.toBeNull();

    const spec: BranchDisplaceSpec = {
      source: 'material',
      radial: 0.05,
      length: 0,
      sharpness: null,
      mapping: 'uvs',
      scaleU: 1,
      scaleV: 1,
      seed: 1,
      map: src.chain,
      fine: { amount: 0, sharpness: null, scale: 1 },
      shape: { amount: 0, twist: 0, scale: 1, seed: 0 },
      flares: { radius: 0, noiseScale: 5, height: 1, pinch: 0, angle: 0, seed: 0 },
      fadeBase: 0,
      fadeTip: 0,
      lod: 0,
      lodFade: false,
    };
    const mesh = buildTubeMesh(cylinder(), {
      maxGeneration: 8,
      radialSegments: () => 160,
      color: () => [0.3, 0.2, 0.1],
      uvMetres: 1,
      materialId: 'bark',
      maxSegmentLength: 0.02,
      displaceField: createBranchDisplacer(spec) ?? undefined,
      displaceDirection: 'normal',
    });
    const base = (src.chain as NonNullable<typeof src.chain>)[0] as NonNullable<typeof src.chain>[number];
    const disp: number[] = [];
    const expected: number[] = [];
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const z = mesh.positions[i * 3 + 2] as number;
      if (z < 0.4 || z > LENGTH - 0.5) continue;
      const r = Math.hypot(mesh.positions[i * 3] as number, mesh.positions[i * 3 + 1] as number);
      disp.push(r - RADIUS);
      expected.push(sampleHeightField(base, mesh.uv0[i * 2] as number, mesh.uv0[i * 2 + 1] as number));
    }
    expect(disp.length).toBeGreaterThan(1000);
    expect(correlation(disp, expected)).toBeGreaterThan(0.9);
    // Without alpha variation the normal map is not a height source.
    registerDisplacementSource('t07-flat', { width: 4, height: 4, rgba: new Uint8ClampedArray(64).fill(255) });
    const flat = { id: 'flat', name: 'Flat', slots: { normal: { texture: { assetId: 't07-flat' } } } } as unknown as MaterialDef;
    setMaterialSource({ materials: () => [flat], sets: () => [], masks: () => [], season: () => 0.5, displacements: () => [] });
    expect(resolveHeightSource({ displaceSource: { value: 'material' } }, 'flat').state).toBe('missing');
    setMaterialSource(null);
    void createDisplacementDef;
  });
});
