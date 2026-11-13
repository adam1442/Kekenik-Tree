import type { RGBA } from '@/contracts/params';
import type { MaterialDef, TextureSlot } from '@/contracts/material';
import { evaluateCurve } from '@/core/curve';
import type { Curve } from '@/core/curve';

/** Pure shading rules shared by the three.js material factory, the UI and the tests. */

export type SlotMode = 'color' | 'number';

export interface SlotInfo {
  slot: TextureSlot;
  title: string;
  /** `color` slots show a colour swatch, `number` slots a scalar field. */
  mode: SlotMode;
  /** sRGB-encoded image data (colours) vs. linear data (masks, normals, scalars). */
  srgb: boolean;
  /** Neutral value of the constant field. */
  defaultScalar: number;
}

/** Order and grouping of the 3-column slot grid. */
export const SLOT_INFO: readonly SlotInfo[] = [
  { slot: 'color', title: 'Color', mode: 'color', srgb: true, defaultScalar: 1 },
  { slot: 'opacity', title: 'Opacity', mode: 'number', srgb: false, defaultScalar: 1 },
  { slot: 'normal', title: 'Normal', mode: 'number', srgb: false, defaultScalar: 1 },
  { slot: 'gloss', title: 'Gloss', mode: 'number', srgb: false, defaultScalar: 0.3 },
  { slot: 'specular', title: 'Specular', mode: 'color', srgb: true, defaultScalar: 1 },
  { slot: 'metallic', title: 'Metallic', mode: 'number', srgb: false, defaultScalar: 0 },
  { slot: 'subsurface', title: 'Subsurface', mode: 'color', srgb: true, defaultScalar: 1 },
  { slot: 'subsurfacePercent', title: 'Subsurface %', mode: 'number', srgb: false, defaultScalar: 0 },
  { slot: 'ao', title: 'AO', mode: 'number', srgb: false, defaultScalar: 1 },
  { slot: 'height', title: 'Height', mode: 'number', srgb: false, defaultScalar: 0 },
  { slot: 'custom', title: 'Custom', mode: 'number', srgb: false, defaultScalar: 0 },
  { slot: 'custom2', title: 'Custom2', mode: 'number', srgb: false, defaultScalar: 0 },
];

export const slotInfo = (slot: TextureSlot): SlotInfo => SLOT_INFO.find((s) => s.slot === slot) as SlotInfo;

/** Colour-space rule: Color / Specular / Subsurface are sRGB, everything else is linear data. */
export const slotColorSpace = (slot: TextureSlot): 'srgb' | 'linear' => (slotInfo(slot).srgb ? 'srgb' : 'linear');

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Gloss -> roughness conversion (roughness = 1 - gloss), clamped to a numerically safe range. */
export const glossToRoughness = (gloss: number): number => Math.min(1, Math.max(0.02, 1 - gloss));

/** Season weight of a material or set member: the season curve evaluated at the global season (1 when no curve). */
export function seasonWeight(curve: Curve | null | undefined, season: number): number {
  if (!curve) return 1;
  const v = evaluateCurve(curve, clamp01(season));
  return Number.isFinite(v) ? Math.max(0, v) : 1;
}

const luma = (c: readonly number[]): number => 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0);

/**
 * Per-instance tint from the three Variation swatches. `rand` (0..1) walks along swatch 1 -> 2 -> 3 with a smooth
 * cross-fade; the swatch is normalised to unit luminance so variation changes hue, not brightness; `amount` blends from
 * white (no variation) to the tint. The GLSL in materialFactory.ts implements the same formula.
 */
export function variationTint(variations: readonly [RGBA, RGBA, RGBA], amount: number, rand: number): [number, number, number] {
  const t = clamp01(rand) * 2;
  const i = Math.min(1, Math.floor(t));
  const f = t - i;
  const a = variations[i] as RGBA;
  const b = variations[i + 1] as RGBA;
  const out: [number, number, number] = [1, 1, 1];
  const mixed = [0, 1, 2].map((k) => (a[k] as number) * (1 - f) + (b[k] as number) * f);
  const l = Math.max(luma(mixed), 1e-3);
  for (let k = 0; k < 3; k++) {
    const tint = Math.min(2, (mixed[k] as number) / l);
    out[k] = 1 + (tint - 1) * clamp01(amount);
  }
  return out;
}

/** Neutral per-material defaults used when a material is created (neutral default swatches). */
export const DEFAULT_VARIATIONS: [RGBA, RGBA, RGBA] = [
  [0.263, 0.376, 0.059, 1],
  [0.576, 0.749, 0.337, 1],
  [0.455, 0.576, 0.482, 1],
];

export function createMaterialDef(id: string, name: string): MaterialDef {
  return {
    id,
    name,
    twoSided: false,
    season: null,
    variations: DEFAULT_VARIATIONS.map((c) => [...c] as RGBA) as [RGBA, RGBA, RGBA],
    variationAmount: 0.5,
    slots: {},
    atlas: { scale: 1, handling: 'default', name: '' },
    maxResolution: null,
    backMaterialId: null,
    backSpacing: 0.001,
    userData: '',
  };
}

export const MAX_RES_OPTIONS = ['None', '256', '512', '1024', '2048', '4096'] as const;
export const maxResToValue = (label: string): number | null => (label === 'None' ? null : Number(label));
export const maxResToLabel = (v: number | null): string => (v === null ? 'None' : String(v));
