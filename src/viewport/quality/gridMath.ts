/**
 * Pure maths of the analytic ground grid. The same formulas are written in GLSL in `gridMesh.ts`
 * (`spacingWeight`, `lineCoverage`, `distanceFade`, `grazingFade`) - keep both in sync.
 */

/** Number of 10x grid levels evaluated by the shader (finest = cell * 10^-2 ... coarsest = cell * 10^3). */
export const GRID_LEVELS = 6;
export const GRID_FIRST_EXPONENT = -2;
export const MINOR_ALPHA = 0.16;
export const MAJOR_ALPHA = 0.3;
export const AXIS_ALPHA = 0.8;
export const MINOR_WIDTH_PX = 1;
export const MAJOR_WIDTH_PX = 1.5;
export const AXIS_WIDTH_PX = 2;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** World spacing of grid level `i` for a base cell size `cell` (metres). */
export const levelSpacing = (cell: number, i: number): number => cell * Math.pow(10, GRID_FIRST_EXPONENT + i);

/** Visibility of a grid level from its on-screen line spacing: invisible below 5 px, fully visible from 20 px. */
export function spacingWeight(pixelSpacing: number): number {
  return smoothstep(5, 20, pixelSpacing);
}

/**
 * Screen-space coverage of a line of `widthPx` pixels whose centre is `distancePx` away from the pixel centre
 * (box filter => constant width and 1 px anti-aliased edges at any distance / angle).
 */
export function lineCoverage(distancePx: number, widthPx: number): number {
  return Math.min(1, Math.max(0, widthPx * 0.5 + 0.5 - distancePx));
}

/** Smooth fade between 20 % and 100 % of the fade distance. */
export function distanceFade(distance: number, fadeEnd: number): number {
  return 1 - smoothstep(fadeEnd * 0.2, fadeEnd, distance);
}

/** Fade towards the horizon; `cosView` = |cos| of the angle between the view ray and the ground normal. */
export function grazingFade(cosView: number): number {
  return smoothstep(0.015, 0.2, Math.abs(cosView));
}

/** Effective fade distance: never smaller than the user value, grows when the camera is far away. */
export function effectiveFadeEnd(userFade: number, cameraDistance: number): number {
  return Math.max(userFade, cameraDistance * 6);
}

export interface GridLevelInfo {
  index: number;
  spacing: number;
  weight: number;
  /** Brightness of this level's lines: brighter when the next finer level is visible too (it is a "major" level). */
  alpha: number;
  widthPx: number;
}

/**
 * Evaluates all grid levels for a given on-screen size of one world unit.
 * @param pixelsPerUnit screen pixels per world unit measured across the lines
 */
export function selectGridLevels(cell: number, pixelsPerUnit: number): GridLevelInfo[] {
  const out: GridLevelInfo[] = [];
  let finer = 0;
  for (let i = 0; i < GRID_LEVELS; i++) {
    const spacing = levelSpacing(cell, i);
    const weight = spacingWeight(spacing * pixelsPerUnit);
    out.push({
      index: i,
      spacing,
      weight,
      alpha: (MINOR_ALPHA + (MAJOR_ALPHA - MINOR_ALPHA) * finer) * weight,
      widthPx: MINOR_WIDTH_PX + (MAJOR_WIDTH_PX - MINOR_WIDTH_PX) * finer,
    });
    finer = weight;
  }
  return out;
}

/** The coarsest level that is (mostly) visible, i.e. what the user perceives as the grid cell size. */
export function dominantLevel(levels: readonly GridLevelInfo[]): GridLevelInfo | null {
  let best: GridLevelInfo | null = null;
  for (const l of levels) if (l.weight > 0.5) best = l;
  return best;
}

/** Dynamic near / far planes: keeps the depth buffer precise at any zoom without clipping the model. */
export function clipPlanes(cameraDistance: number): { near: number; far: number } {
  const d = Math.max(0.01, cameraDistance);
  return { near: Math.min(5, Math.max(0.03, d * 0.02)), far: Math.min(6000, Math.max(1000, d * 60)) };
}
