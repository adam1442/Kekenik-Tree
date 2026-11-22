import { evaluateCurve, type Curve } from '@/contracts/curve';
import { clamp, smoothstep } from '@/core/math';
import { leanNormal } from '@/generators/skin/seam';

/**
 * Skin > Welding > Blend (pure). The mesher writes three vertex channels for the bark shader:
 * - `weldBlend`    0 on the parent side of the weld, 1 on the child (monotonic along the child),
 * - `weldParentUV` the UV the parent's bark has at the vertex,
 * - `weldStyle`    (contrast, noise, active).
 */
export interface WeldBlendSettings {
  /** Extra length of the blended region up the child, in child radii (0 = ends with the weld part). */
  texture: number;
  /** Scale of the parent-side map inside the blended region. */
  textureScale: number;
  /** 0 = soft transition, 1 = hard edge. */
  contrast: number;
  /** 0..1 wave-noise around the child that makes the blend line irregular (applied in the shader). */
  noise: number;
  /** Lighting curve over the blend (0 = parent side .. 1 = child): value 0 = normals follow the spine, 1 = point outward, 0.5 = unchanged. */
  lighting: Curve | undefined;
}

export const DEFAULT_WELD_BLEND: WeldBlendSettings = { texture: 1, textureScale: 1, contrast: 0.35, noise: 0.3, lighting: undefined };

/**
 * Blend value at arc length `s` of the child. `s0` is the first weld ring, `sEnd` the end of the weld part and `r0` the child
 * radius there. 0 at `s0`, 1 at `sEnd + texture x r0` and above; strictly non-decreasing in between.
 */
export function weldBlendValue(s: number, s0: number, sEnd: number, r0: number, texture: number): number {
  const length = Math.max(1e-9, sEnd - s0 + Math.max(0, texture) * r0);
  return smoothstep(0, 1, (s - s0) / length);
}

/**
 * Lighting curve -> normal. `v` 0 aligns the normal with the spine, 1 turns it outward from the spine, 0.5 keeps `n`.
 * All vectors are unit length; the result is unit length.
 */
export function lightingNormal(
  n: readonly [number, number, number],
  spine: readonly [number, number, number],
  outward: readonly [number, number, number],
  v: number,
): [number, number, number] {
  const c = clamp(v, 0, 1);
  return c < 0.5 ? leanNormal(n, spine, 1 - c * 2) : leanNormal(n, outward, c * 2 - 1);
}

/** Value of the Lighting curve at blend `b` (0.5 = neutral when there is no curve). */
export function lightingValue(curve: Curve | undefined, b: number): number {
  return curve ? evaluateCurve(curve, Math.min(1, Math.max(0, b))) : 0.5;
}
