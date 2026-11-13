/** Global shading options (Lighting panel > Shading). Observable, tiny. */
export interface ShadingSettings {
  /** Alpha-test threshold of cut-out materials (0..1). */
  alphaThreshold: number;
  /** Smooth cut-out edges with alpha-to-coverage (needs MSAA, which the viewport uses). */
  alphaToCoverage: boolean;
  /** Thin-leaf back-lighting from the Subsurface slots. */
  translucency: boolean;
  /** Multiplier of the thin-leaf light transmission (0..2). */
  translucencyStrength: number;
  /** Wrapped-diffuse amount of foliage (soft terminator, 0..1). */
  foliageWrap: number;
  /** Fuzzy rim sheen on foliage (0..1). */
  foliageSheen: number;
  /** Strength of the baked per-vertex ambient occlusion (0..1). */
  vertexAo: number;
}

let current: ShadingSettings = { alphaThreshold: 0.5, alphaToCoverage: true, translucency: true, translucencyStrength: 1, foliageWrap: 0.3, foliageSheen: 0.35, vertexAo: 1 };
const listeners = new Set<() => void>();

export const getShadingSettings = (): ShadingSettings => current;

export function setShadingSettings(patch: Partial<ShadingSettings>): void {
  current = { ...current, ...patch };
  listeners.forEach((l) => l());
}

export function onShadingSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
