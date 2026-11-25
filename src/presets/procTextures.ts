import { createSimplex } from '@/core/noise';
import { createImage, encodePng, type RGBAImage } from '@/export/images/imageOps';
import { barkHeight, creviceLut, type BarkInput, type BarkSpec, type BarkStyle } from '@/generators/displace/bark';
import { hashLattice } from '@/generators/displace/noise';
import { blurWrap } from '@/materials/displacement';

/**
 * Neutral, fully procedural placeholder maps used by the procedural-material tools. They are deliberately plain: users are
 * expected to replace them by dropping real maps onto the material slots (Materials panel).
 */

export type Rgb = readonly [number, number, number];

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const to8 = (v: number): number => Math.round(clamp01(v) * 255);

function put(img: RGBAImage, x: number, y: number, r: number, g: number, b: number, a = 255): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

/** Bark: vertical streaks (fbm stretched along V) with darker fissures. Tileable in U. */
export function barkTexture(base: Rgb, seed: number, size = 128): RGBAImage {
  const img = createImage(size, size, [255, 255, 255, 255]);
  const n = createSimplex(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const a = Math.PI * 2 * u;
      const cx = Math.cos(a) * 1.4;
      const cy = Math.sin(a) * 1.4;
      const streak = n.noise3(cx, cy, v * 1.2) * 0.6 + n.noise3(cx * 2.6, cy * 2.6, v * 2.4) * 0.3;
      const fissure = Math.max(0, 0.15 - Math.abs(n.noise3(cx * 2, cy * 2, v * 0.5))) * 4;
      const k = 0.78 + streak * 0.35 - fissure * 0.45;
      put(img, x, y, to8(base[0] * k), to8(base[1] * k), to8(base[2] * k));
    }
  }
  return img;
}

/** Leaf colour map: blade gradient, central vein and side veins, no alpha (the card outline shapes the silhouette). */
export function leafTexture(base: Rgb, seed: number, size = 128): RGBAImage {
  const img = createImage(size, size, [255, 255, 255, 255]);
  const n = createSimplex(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1) - 0.5;
      const v = y / (size - 1);
      const mid = Math.exp(-Math.pow(u / 0.018, 2));
      const side = Math.exp(-Math.pow(((Math.abs(u) * 2.2 - v * 0.9 + 1) % 0.22) / 0.018, 2)) * 0.5 * (Math.abs(u) < 0.4 ? 1 : 0);
      const vein = Math.min(1, mid + side);
      const grad = 0.82 + v * 0.18 + n.noise2(u * 6, v * 6) * 0.08;
      const k = grad * (1 + vein * 0.28);
      put(img, x, y, to8(base[0] * k), to8(base[1] * k), to8(base[2] * k));
    }
  }
  return img;
}

/** Needle / grass-blade map: bright centre line fading to the edges. */
export function needleTexture(base: Rgb, seed: number, size = 64): RGBAImage {
  const img = createImage(size, size, [255, 255, 255, 255]);
  const n = createSimplex(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1) - 0.5;
      const v = y / (size - 1);
      const k = 0.7 + Math.exp(-Math.pow(u / 0.12, 2)) * 0.35 + v * 0.1 + n.noise2(u * 4, v * 10) * 0.05;
      put(img, x, y, to8(base[0] * k), to8(base[1] * k), to8(base[2] * k));
    }
  }
  return img;
}

/** Soft mottled map used for flowers, succulents and mosses. */
export function mottleTexture(base: Rgb, seed: number, size = 64): RGBAImage {
  const img = createImage(size, size, [255, 255, 255, 255]);
  const n = createSimplex(seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const k = 0.85 + n.noise2((x / size) * 5, (y / size) * 5) * 0.2;
      put(img, x, y, to8(base[0] * k), to8(base[1] * k), to8(base[2] * k));
    }
  }
  return img;
}

export type TextureKind = 'bark' | 'leaf' | 'needle' | 'mottle';

export function makeTexture(kind: TextureKind, base: Rgb, seed: number): RGBAImage {
  switch (kind) {
    case 'bark':
      return barkTexture(base, seed);
    case 'leaf':
      return leafTexture(base, seed);
    case 'needle':
      return needleTexture(base, seed);
    case 'mottle':
      return mottleTexture(base, seed);
  }
}

export { encodePng };

/* ------------------------------------------------------------------------------------------------------------------ *
 * Bark map sets (colour + normal(height in alpha) + AO + roughness), all derived from ONE height field.
 * ------------------------------------------------------------------------------------------------------------------ */

/** Default / hero edge length (px) of a generated bark set. */
export const BARK_MAP_SIZE = 256;
export const BARK_MAP_SIZE_HERO = 512;

/** Edge length (metres) of the tile: the pattern is evaluated on a 1 m circumference over 1 m of length. */
const PATCH_METRES = 1;

export interface BarkMapOptions {
  /** Feature size in metres on the 1 m tile (default 0.08). */
  scale?: number;
  /** Feature length along the trunk relative to its width (default 4). */
  stretch?: number;
  /** Domain warp (default 0.5). */
  warp?: number;
  /** Crevice profile, 0.5 = linear (default 0.5). */
  crevice?: number;
  /** Normal strength (default 2): slope = height gradient per UV unit x strength / 64. */
  strength?: number;
  /** Mean glossiness of the bark, 0..1 (roughness = 1 - gloss on the ridges, 1 in the crevices; default 0.08). */
  gloss?: number;
  /** AO darkness in the cavities, 0..1 (default 0.8). */
  aoStrength?: number;
  /** Amount of low-frequency hue / value variation of the colour map (default 1). */
  hueVariation?: number;
}

export interface BarkMaps {
  size: number;
  /** sRGB colour (opaque). */
  color: RGBAImage;
  /** Tangent-space normal (OpenGL: +Y = +V), height in the alpha channel. */
  normal: RGBAImage;
  /** Height as an opaque grey image (the same values as the normal alpha). */
  height: RGBAImage;
  /** AO (grey, 1 = open). */
  ao: RGBAImage;
  /** Roughness (grey, high in crevices). The viewport Gloss slot stores `1 - roughness` (see `roughnessToGloss`). */
  roughness: RGBAImage;
  /** Float height 0..1, row 0 = top row of the images. */
  heights: Float32Array;
}

const wrapIdx = (i: number, n: number): number => (i < 0 ? i + n : i >= n ? i - n : i);

/** Fraction of the tile height over which the V seam is cross-faded. */
const SEAM_BAND = 0.3;

/**
 * Tileable bark height 0..1. The bark styles are periodic around (U). Along V the field is made periodic by blending
 * the pattern at `s` into the pattern at `s - P` over the last `SEAM_BAND` of the tile: at v = 1 the result is
 * `A(0)`, exactly the value at v = 0, and the pattern continues smoothly across the seam. Independent patterns blend with
 * cos / sin weights (contrast is kept), the rings (same phase after a whole number of periods) blend linearly.
 */
function barkHeightField(spec: BarkSpec, size: number, seed: number): Float32Array {
  const n = size * size;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  // Rings repeat every `scale` metres: use a whole number of periods so both halves of the blend have the same phase.
  const period = spec.style === 'rings' ? spec.scale * Math.max(1, Math.round(PATCH_METRES / spec.scale)) : PATCH_METRES;
  const input: BarkInput = { u: 0, s: 0, circumference: PATCH_METRES };
  const start = Math.floor(size * (1 - SEAM_BAND));
  for (let y = 0; y < size; y++) {
    const sA = ((y + 0.5) / size) * period;
    for (let x = 0; x < size; x++) {
      input.u = (x + 0.5) / size;
      input.s = sA;
      a[y * size + x] = barkHeight(spec, input, seed);
      if (y >= start) {
        input.s = sA - period;
        b[y * size + x] = barkHeight(spec, input, seed);
      }
    }
  }
  let mean = 0;
  for (let i = 0; i < n; i++) mean += a[i] as number;
  mean /= n;
  const out = new Float32Array(n);
  let lo = Infinity;
  let hi = -Infinity;
  const linear = spec.style === 'rings';
  for (let y = 0; y < size; y++) {
    const t = y >= start ? Math.min(1, (y + 1 - start) / (size - start)) : 0;
    const wa = linear ? 1 - t : Math.cos(t * Math.PI * 0.5);
    const wb = linear ? t : Math.sin(t * Math.PI * 0.5);
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const v = y >= start ? mean + ((a[i] as number) - mean) * wa + ((b[i] as number) - mean) * wb : (a[i] as number);
      out[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const range = hi - lo > 1e-6 ? hi - lo : 1;
  for (let i = 0; i < n; i++) out[i] = ((out[i] as number) - lo) / range;
  return out;
}

/** Tangent-space normal from the height with a wrap-around Sobel; alpha = height. */
function normalFromHeight(h: Float32Array, size: number, strength: number, height8: Uint8ClampedArray): RGBAImage {
  const img = createImage(size, size, [128, 128, 255, 255]);
  const k = (size * strength) / 64 / 8;
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const ym = wrapIdx(y - 1, size) * size;
    const y0 = y * size;
    const yp = wrapIdx(y + 1, size) * size;
    for (let x = 0; x < size; x++) {
      const xm = wrapIdx(x - 1, size);
      const xp = wrapIdx(x + 1, size);
      const sx = (h[ym + xp] as number) + 2 * (h[y0 + xp] as number) + (h[yp + xp] as number) - (h[ym + xm] as number) - 2 * (h[y0 + xm] as number) - (h[yp + xm] as number);
      const sy = (h[yp + xm] as number) + 2 * (h[yp + x] as number) + (h[yp + xp] as number) - (h[ym + xm] as number) - 2 * (h[ym + x] as number) - (h[ym + xp] as number);
      // Row coordinates grow downwards (-V): n = (-dh/du, -dh/dv, 1) = (-dh/dx, +dh/drow, 1).
      const nx = -sx * k;
      const ny = sy * k;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y0 + x) * 4;
      d[o] = (nx * inv * 0.5 + 0.5) * 255;
      d[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      d[o + 2] = (inv * 0.5 + 0.5) * 255;
      d[o + 3] = height8[y0 + x] as number;
    }
  }
  return img;
}

/** Bark PBR set (colour, normal + height alpha, AO, roughness) for one bark style. Deterministic, tileable in U and V. */
export function barkMaps(style: BarkStyle, base: Rgb, seed: number, size: number = BARK_MAP_SIZE, opts: BarkMapOptions = {}): BarkMaps {
  const spec: BarkSpec = {
    style,
    depth: 1,
    scale: Math.max(0.01, opts.scale ?? 0.08),
    stretch: opts.stretch ?? 4,
    warp: opts.warp ?? 0.5,
    crevice: creviceLut(opts.crevice ?? 0.5),
    maturity: { amount: 0, rMin: 0, rMax: 1, curve: null },
    seed,
    maxVertices: 0,
  };
  const n = size * size;
  const heights = barkHeightField(spec, size, seed);

  // Cavity = how far a texel lies below the local average (box blur with wrap-around), normalised by its maximum.
  const blurred = blurWrap(heights, size, size, Math.max(2, Math.round(size / 32)));
  const cavity = new Float32Array(n);
  let maxCav = 1e-6;
  for (let i = 0; i < n; i++) {
    const c = Math.max(0, (blurred[i] as number) - (heights[i] as number));
    cavity[i] = c;
    if (c > maxCav) maxCav = c;
  }

  const height = createImage(size, size, [0, 0, 0, 255]);
  const color = createImage(size, size, [255, 255, 255, 255]);
  const ao = createImage(size, size, [255, 255, 255, 255]);
  const rough = createImage(size, size, [255, 255, 255, 255]);
  const height8 = new Uint8ClampedArray(n);

  const aoStrength = clamp01(opts.aoStrength ?? 0.8);
  const hue = opts.hueVariation ?? 1;
  const rBase = Math.min(0.98, Math.max(0.3, 1 - (opts.gloss ?? 0.08)));
  // Low-frequency colour field: a few seeded integer-frequency sinusoids (exactly tileable).
  const fx: number[] = [];
  const fy: number[] = [];
  const ph: number[] = [];
  for (let i = 0; i < 6; i++) {
    fx.push(1 + Math.floor(hashLattice(i, 1, seed) * 4));
    fy.push(Math.floor(hashLattice(i, 2, seed) * 5) - 2);
    ph.push(hashLattice(i, 3, seed) * Math.PI * 2);
  }
  const TAU = Math.PI * 2;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) / size;
      const h = heights[i] as number;
      const c = clamp01((cavity[i] as number) / (maxCav * 0.6));
      const q = to8(h);
      height8[i] = q;
      const o = i * 4;
      height.data[o] = height.data[o + 1] = height.data[o + 2] = q;
      const aoV = 1 - aoStrength * c;
      ao.data[o] = ao.data[o + 1] = ao.data[o + 2] = to8(aoV);
      const r = clamp01(rBase + (1 - rBase) * c - 0.06 * (h - 0.5));
      rough.data[o] = rough.data[o + 1] = rough.data[o + 2] = to8(r);
      const f1 = Math.sin(TAU * (fx[0] as number) * u + TAU * (fy[0] as number) * v + (ph[0] as number)) + Math.sin(TAU * (fx[1] as number) * u + TAU * (fy[1] as number) * v + (ph[1] as number));
      const f2 = Math.sin(TAU * (fx[2] as number) * u + TAU * (fy[2] as number) * v + (ph[2] as number)) + Math.sin(TAU * (fx[3] as number) * u + TAU * (fy[3] as number) * v + (ph[3] as number));
      const f3 = Math.sin(TAU * (fx[4] as number) * u + TAU * (fy[4] as number) * v + (ph[4] as number)) + Math.sin(TAU * (fx[5] as number) * u + TAU * (fy[5] as number) * v + (ph[5] as number));
      const grain = (hashLattice(x, y, seed + 7) - 0.5) * 0.05;
      const k = (0.55 + 0.45 * h) * (1 - 0.35 * c) * (1 + 0.07 * hue * f3 + grain);
      const kr = 1 + 0.05 * hue * f1;
      const kg = 1 + 0.03 * hue * f2;
      const kb = 1 - 0.05 * hue * f1 + 0.03 * hue * f2;
      color.data[o] = to8(base[0] * k * kr);
      color.data[o + 1] = to8(base[1] * k * kg);
      color.data[o + 2] = to8(base[2] * k * kb);
    }
  }
  const normal = normalFromHeight(heights, size, opts.strength ?? 2, height8);
  return { size, color, normal, height, ao, roughness: rough, heights };
}

/** Viewport Gloss slot value of a roughness image (`roughness = 1 - gloss`). */
export function roughnessToGloss(rough: RGBAImage): RGBAImage {
  const out = createImage(rough.width, rough.height, [0, 0, 0, 255]);
  for (let i = 0; i < rough.width * rough.height; i++) {
    const g = 255 - (rough.data[i * 4] as number);
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = g;
  }
  return out;
}

export type BarkRecipeId =
  | 'broadleaf'
  | 'conifer'
  | 'pine'
  | 'birch'
  | 'willow'
  | 'palm'
  | 'acacia'
  | 'baobab'
  | 'dead'
  | 'shrub'
  | 'cactus'
  | 'bamboo'
  | 'sapling';

/** One bark map recipe per preset family: map options + the matching Displacement > Bark defaults (consumed by T11). */
export interface BarkRecipe extends Required<Omit<BarkMapOptions, 'hueVariation'>> {
  style: BarkStyle;
  /** Default base colour. */
  color: Rgb;
  /** `barkDepth` default (fraction of the local radius) of the matching Displacement > Bark settings. */
  depth: number;
  hueVariation: number;
}

const recipe = (style: BarkStyle, color: Rgb, scale: number, stretch: number, warp: number, crevice: number, depth: number, strength: number, gloss: number): BarkRecipe => ({
  style,
  color,
  scale,
  stretch,
  warp,
  crevice,
  depth,
  strength,
  gloss,
  aoStrength: 0.8,
  hueVariation: 1,
});

export const BARK_RECIPES: Readonly<Record<BarkRecipeId, BarkRecipe>> = {
  broadleaf: recipe('furrowed', [0.36, 0.29, 0.22], 0.08, 5, 0.6, 0.6, 0.05, 2.2, 0.05),
  conifer: recipe('scaly', [0.32, 0.24, 0.19], 0.07, 3, 0.4, 0.5, 0.04, 2, 0.04),
  pine: recipe('plated', [0.42, 0.3, 0.2], 0.1, 2.2, 0.5, 0.55, 0.06, 2.4, 0.04),
  birch: recipe('lenticel', [0.82, 0.8, 0.74], 0.04, 5, 0.5, 0.5, 0.015, 1.2, 0.12),
  willow: recipe('fibrous', [0.34, 0.28, 0.2], 0.05, 6, 0.8, 0.5, 0.05, 2, 0.05),
  palm: recipe('rings', [0.5, 0.4, 0.3], 0.06, 1, 0.5, 0.5, 0.03, 1.8, 0.1),
  acacia: recipe('furrowed', [0.3, 0.24, 0.19], 0.06, 6, 0.7, 0.55, 0.045, 2, 0.05),
  baobab: recipe('fibrous', [0.5, 0.44, 0.38], 0.12, 5, 0.4, 0.45, 0.03, 1.2, 0.03),
  dead: recipe('furrowed', [0.42, 0.38, 0.34], 0.1, 8, 0.9, 0.7, 0.08, 2.6, 0.02),
  shrub: recipe('furrowed', [0.36, 0.28, 0.2], 0.04, 4, 0.5, 0.5, 0.03, 1.6, 0.06),
  cactus: recipe('fibrous', [0.22, 0.45, 0.22], 0.12, 8, 0.1, 0.5, 0.02, 1.4, 0.25),
  bamboo: recipe('rings', [0.52, 0.58, 0.28], 0.25, 1, 0.3, 0.5, 0.01, 1, 0.25),
  sapling: recipe('lenticel', [0.45, 0.36, 0.28], 0.05, 4, 0.4, 0.5, 0.01, 1.2, 0.12),
};

export const BARK_RECIPE_IDS = Object.keys(BARK_RECIPES) as BarkRecipeId[];

/** Bark maps of a recipe; `color` overrides the recipe colour (callers can keep their own tint). */
export function barkMapsFromRecipe(id: BarkRecipeId, seed: number, size: number = BARK_MAP_SIZE, color?: Rgb, over: BarkMapOptions = {}): BarkMaps {
  const r = BARK_RECIPES[id];
  return barkMaps(r.style, color ?? r.color, seed, size, { ...r, ...over });
}

/* ------------------------------------------------------------------------------------------------------------------ *
 * Surface-detail material maps for the Decal and Fin generators (knot / burl patch, lichen flap, fungus shelf).
 * ------------------------------------------------------------------------------------------------------------------ */

export type SurfaceDetailKind = 'knot-patch' | 'lichen-flap' | 'fungus-shelf';

export const SURFACE_DETAIL_KINDS: readonly SurfaceDetailKind[] = ['knot-patch', 'lichen-flap', 'fungus-shelf'];

export interface SurfaceDetailMaps {
  size: number;
  /** sRGB colour; the alpha channel is the cut-out opacity (edge fade of a decal, silhouette of a flap). */
  color: RGBAImage;
  /** Tangent-space normal, height in the alpha channel (the decal Height reads it). */
  normal: RGBAImage;
  /** Height 0..1 as a grey image. */
  height: RGBAImage;
  heights: Float32Array;
}

const smooth01 = (a: number, b: number, v: number): number => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const DETAIL_DEFAULTS: Readonly<Record<SurfaceDetailKind, { color: Rgb; strength: number }>> = {
  'knot-patch': { color: [0.34, 0.24, 0.16], strength: 3 },
  'lichen-flap': { color: [0.52, 0.6, 0.4], strength: 1.5 },
  'fungus-shelf': { color: [0.72, 0.5, 0.28], strength: 2 },
};

/**
 * Procedural height, colour and silhouette of one surface-detail kind. Deterministic; the maps are NOT tileable (they cover the
 * decal / fin once): the silhouette alpha is 0 on the border.
 *  - knot-patch: a burl dome with concentric growth rings and a dark core; opacity fades radially to the bark.
 *  - lichen-flap: a ragged leafy blob with a soft ridge; opaque inside the noisy outline.
 *  - fungus-shelf: a half-disc bracket (flat edge at the bottom = the base on the trunk) with concentric zones.
 */
export function surfaceDetailMaps(kind: SurfaceDetailKind, seed: number, size = 128, color?: Rgb): SurfaceDetailMaps {
  const def = DETAIL_DEFAULTS[kind];
  const base = color ?? def.color;
  const n = createSimplex(seed);
  const heights = new Float32Array(size * size);
  const alpha = new Uint8ClampedArray(size * size);
  const shade = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = 1 - (y + 0.5) / size;
      const dx = u - 0.5;
      const dy = v - 0.5;
      const r = Math.hypot(dx, dy) * 2;
      let h: number;
      let a: number;
      let k: number;
      if (kind === 'knot-patch') {
        const wob = 1 + 0.12 * n.noise2(dx * 4 + 7, dy * 4 + 3);
        const rr = r * wob;
        const dome = Math.pow(clamp01(1 - rr), 0.8);
        const rings = 0.5 + 0.5 * Math.cos(rr * 26 + 2 * n.noise2(dx * 3, dy * 3));
        h = clamp01(dome * (0.75 + 0.25 * rings) + 0.05 * n.noise2(dx * 20, dy * 20));
        a = smooth01(1, 0.78, rr);
        k = 0.65 + 0.55 * rings * dome - 0.2 * (1 - smooth01(0, 0.2, rr));
      } else if (kind === 'lichen-flap') {
        const outline = 0.78 + 0.16 * n.noise2(dx * 7 + 11, dy * 7) + 0.07 * n.noise2(dx * 18, dy * 18);
        const inside = outline - r;
        a = smooth01(0, 0.06, inside);
        const ridge = Math.exp(-Math.pow(dx / 0.12, 2));
        h = clamp01(0.35 + 0.35 * ridge + 0.25 * n.noise2(dx * 12 + 5, dy * 12) * 0.5 + 0.1 * smooth01(0, 0.4, inside));
        k = 0.8 + 0.3 * n.noise2(dx * 9, dy * 9) + 0.15 * ridge;
      } else {
        // Half-disc: base on the bottom edge (v = 0), the cap grows upwards.
        const rx = dx * 2;
        const ry = v * 1.0;
        const rad = Math.hypot(rx, ry) * (1 + 0.05 * n.noise2(rx * 5, ry * 5));
        const inside = 0.96 - rad;
        a = smooth01(0, 0.04, inside) * smooth01(0, 0.03, v);
        const zones = 0.5 + 0.5 * Math.cos(rad * 30);
        h = clamp01(0.55 * (1 - rad) + 0.12 * zones + 0.1 * smooth01(0, 0.3, inside));
        k = 0.7 + 0.5 * (1 - rad) + 0.15 * (zones - 0.5);
      }
      const i = y * size + x;
      heights[i] = h;
      alpha[i] = to8(a);
      shade[i] = k;
    }
  }
  const height8 = new Uint8ClampedArray(size * size);
  const height = createImage(size, size, [0, 0, 0, 255]);
  const colorImg = createImage(size, size, [255, 255, 255, 255]);
  for (let i = 0; i < size * size; i++) {
    const q = to8(heights[i] as number);
    height8[i] = q;
    height.data[i * 4] = height.data[i * 4 + 1] = height.data[i * 4 + 2] = q;
    const k = shade[i] as number;
    colorImg.data[i * 4] = to8(base[0] * k);
    colorImg.data[i * 4 + 1] = to8(base[1] * k);
    colorImg.data[i * 4 + 2] = to8(base[2] * k);
    colorImg.data[i * 4 + 3] = alpha[i] as number;
  }
  return { size, color: colorImg, normal: normalFromHeight(heights, size, def.strength, height8), height, heights };
}
