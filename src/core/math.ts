/** Small math helpers shared by all layers. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const EPS = 1e-6;

export const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));
export const remap = (v: number, a0: number, a1: number, b0: number, b1: number): number =>
  lerp(b0, b1, invLerp(a0, a1, v));
export const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp(invLerp(a, b, v), 0, 1);
  return t * t * (3 - 2 * t);
};
export const deg2rad = (d: number): number => (d * Math.PI) / 180;
