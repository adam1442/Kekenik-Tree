import type { Curve } from '@/contracts/curve';
import { coneFromPolyline, sagScale, tubeSurface, type ParentSurface } from './surface';

/** Parent segments around the attachment that the ray cast surface and the cone fit consider (each side). */
export const RAY_WINDOW = 8;

/** Surface of the parent at the base of a child: procedural cone, or the ray cast tube of the parent branch around the attachment. */
export function parentSurfaceFor(
  positions: ArrayLike<number>,
  radii: ArrayLike<number>,
  count: number,
  base: readonly [number, number, number],
  hint: number,
  parentSides: number,
  forceRays: boolean,
): ParentSurface | null {
  const scale = sagScale(parentSides);
  if (forceRays) return tubeSurface({ positions, radii, count, hint, window: RAY_WINDOW, radiusScale: scale });
  return coneFromPolyline(positions, radii, count, base, hint, RAY_WINDOW, scale);
}

/** Mesher options for welded junctions (Skin > Welding + Segments > Length > Weld scalar). */
export interface WeldMeshOptions {
  /** Length of the weld part beyond the skin, in child radii. */
  offset: number;
  spread: number;
  upper: number;
  lower: number;
  scalar: number;
  forceRays: boolean;
  /** Texture blending between the parent and the child at the weld (absent = off). */
  blend?: WeldBlendMeshOptions;
}

/** Skin > Welding > Blend as the mesher receives it. */
export interface WeldBlendMeshOptions {
  texture: number;
  textureScale: number;
  contrast: number;
  noise: number;
  lighting?: Curve;
}
