import type { WindParams } from './windParams';

/**
 * CPU reference of the translation part (trunk + branch levels, low quality) of `ktWindLocal` in `windShader.ts`.
 * It exists so the anchoring rules can be unit-tested without a GPU; keep it in sync with the GLSL.
 */
export const smoothstep = (e0: number, e1: number, x: number): number => {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Ground anchor weight: exactly 0 for `height <= 0`, smooth ramp to 1 at `hold` metres (hold 0 = hard step). */
export function anchorWeight(height: number, hold: number): number {
  if (hold > 1e-4) return smoothstep(0, hold, height);
  return height > 1e-4 ? 1 : 0;
}

export interface WindVertex {
  /** Plant-space position (Z up, ground at z = 0). */
  position: readonly [number, number, number];
  /** (trunk, branch, leaf, phase) as stored in `windWeights`. */
  weights: readonly [number, number, number, number];
}

/** World displacement of one vertex at time `t` (seconds * speed) and tree height `H`. */
export function windDisplacement(p: WindParams, v: WindVertex, t: number, H: number): [number, number, number] {
  const strength = p.enabled ? p.strength : 0;
  const [w0, w1, w2, ph] = v.weights;
  if (strength <= 0 || w0 + w1 + w2 <= 0) return [0, 0, 0];
  const anchor = anchorWeight(v.position[2], p.baseHold);
  if (anchor <= 0) return [0, 0, 0];
  const rad = (p.directionDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const height = Math.max(H, 0.5);
  const freqK = 1 + p.stiffness * 1.5;
  const ampK = 1 / (1 + p.stiffness * 3);
  const osc = 1 - p.damping;
  const phase = ph * Math.PI * 2;
  const ga = (v.position[0] * dx + v.position[1] * dy) * 0.12 - t * 0.9 * p.gustFrequency;
  const gust = 0.5 + 0.5 * (Math.sin(ga) * 0.6 + Math.sin(ga * 2.31 + 1.7) * 0.4);
  const A = Math.max(0, strength * (1 + p.gustStrength * (gust * 2 - 1)));
  const o0 = Math.sin(t * 0.7 * freqK + 0.6 * Math.sin(t * 0.31));
  const d0 = height * 0.04 * p.trunkResponse * w0 * ampK * A * (1 + 0.6 * osc * o0);
  const o1 = Math.sin(t * 1.7 * freqK + phase) + 0.5 * Math.sin(t * 2.9 * freqK + phase * 2.3);
  const d1 = height * 0.015 * p.branchResponse * w1 * ampK * A * (0.4 + 0.6 * osc * o1);
  const c1 = height * 0.006 * p.branchResponse * w1 * ampK * A * Math.sin(t * 1.3 * freqK + phase * 1.7) * osc;
  const along = (d0 + d1) * anchor;
  const side = c1 * anchor;
  return [dx * along - dy * side, dy * along + dx * side, 0];
}
