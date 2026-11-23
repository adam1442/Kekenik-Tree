import type { FractionalU, UvStyle } from './types';

const TWO_PI = Math.PI * 2;

/**
 * Whole number of texture tiles around a branch: `max(1, round(Absolute + Relative x circumference / metresPerTile))`.
 * Absolute 0 with Relative 1 is the tiling by world size that older projects used.
 */
export function wholeUTiles(absolute: number, relative: number, circumference: number, metresPerTile: number): number {
  const extra = (Math.max(0, relative) * Math.max(0, circumference)) / Math.max(1e-4, metresPerTile);
  return Math.max(1, Math.round(Math.max(0, absolute) + extra));
}

export interface UTileInput {
  style: UvStyle;
  absolute: number;
  relative: number;
  fractional: FractionalU;
  /** Circumference of the branch at its thickest ring (metres). */
  circumference: number;
  metresPerTile: number;
  /** Circumference at the first ring of the branch (Fractional > Auto matches the density where it leaves its parent); defaults to `circumference`. */
  autoCircumference?: number;
  /** Tiles per metre of circumference of the parent (undefined = unknown, the world scale is used). */
  parentDensity?: number;
  /** Extensions that match their parent: the parent's tile count wins. */
  forcedTiles?: number;
}

/**
 * Tiles around the branch (a float only with Fractional on). Locked styles use exactly one tile. `forcedTiles` (an
 * extension that matches its parent) replaces every other rule except the locked styles.
 */
export function resolveUTiles(i: UTileInput): number {
  if (i.style !== 'unrestricted') return 1;
  if (i.forcedTiles !== undefined && i.forcedTiles > 0) return i.forcedTiles;
  if (i.fractional.enabled) {
    if (!i.fractional.auto) return Math.max(0.01, i.fractional.value);
    const density = i.parentDensity !== undefined && i.parentDensity > 0 ? i.parentDensity : 1 / Math.max(1e-4, i.metresPerTile);
    return Math.max(0.01, density * (i.autoCircumference ?? i.circumference));
  }
  return wholeUTiles(i.absolute, i.relative, i.circumference, i.metresPerTile);
}

/** Tiles per metre of circumference (the texel density that Fractional > Auto copies from the parent). */
export function uDensity(tiles: number, radius: number): number {
  return tiles / Math.max(1e-6, TWO_PI * radius);
}
