import { createSimplex } from '@/core/noise';
import { createImage, encodePng, type RGBAImage } from '@/export/images/imageOps';

/**
 * Neutral, fully procedural placeholder maps shipped with the species presets. They are deliberately plain: users are
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
