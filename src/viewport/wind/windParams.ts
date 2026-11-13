import type { MeshWindOverride } from '@/contracts/engine';
import type { WindSettings } from '@/contracts/material';

/**
 * Full wind parameter set. The persisted `WindSettings` contract keeps its original fields
 * (`directionDeg`, `strength`, `gustiness` = gust strength, `frequency` = gust frequency); every additional value is
 * stored in `WindSettings.params` so older project files keep loading.
 */
export interface WindParams {
  enabled: boolean;
  /** Direction the wind blows TOWARDS, degrees around +Z (0 = +X, 90 = +Y). */
  directionDeg: number;
  /** Time multiplier of the simulation clock. */
  speed: number;
  strength: number;
  /** Gust travelling frequency (gusts per ~7 s at 1). */
  gustFrequency: number;
  /** 0..1, how much the strength is modulated by gusts. */
  gustStrength: number;
  /** 0..1 high-frequency chaotic motion of branches and leaves. */
  turbulence: number;
  trunkResponse: number;
  branchResponse: number;
  leafResponse: number;
  /** 0..1, stiff = small and fast motion. */
  stiffness: number;
  /** 0..1, how much the oscillation (not the steady lean) is damped. */
  damping: number;
  /** 0..1 leaf lamina ripple. */
  ripple: number;
  /** Metres above the ground over which the wind weight ramps from exactly 0 (anchor) to full (smoothstep). */
  baseHold: number;
}

export type WindNumericKey = Exclude<keyof WindParams, 'enabled'>;

export interface WindParamRange {
  key: WindNumericKey;
  label: string;
  min: number;
  max: number;
  softMax: number;
  step: number;
  def: number;
  unit?: string;
  group: 'Wind' | 'Gusts' | 'Response' | 'Dynamics';
}

/** Single source of truth for UI, clamping and export documentation. */
export const WIND_PARAM_RANGES: readonly WindParamRange[] = [
  { key: 'directionDeg', label: 'Direction', min: 0, max: 360, softMax: 360, step: 1, def: 0, unit: '°', group: 'Wind' },
  { key: 'speed', label: 'Speed', min: 0, max: 10, softMax: 4, step: 0.05, def: 1, group: 'Wind' },
  { key: 'baseHold', label: 'Base hold (m)', min: 0, max: 10, softMax: 3, step: 0.05, def: 0.6, unit: 'm', group: 'Wind' },
  { key: 'strength', label: 'Strength', min: 0, max: 20, softMax: 4, step: 0.05, def: 1, group: 'Wind' },
  { key: 'gustFrequency', label: 'Gust frequency', min: 0, max: 20, softMax: 4, step: 0.05, def: 1, group: 'Gusts' },
  { key: 'gustStrength', label: 'Gust strength', min: 0, max: 1, softMax: 1, step: 0.01, def: 0.3, group: 'Gusts' },
  { key: 'turbulence', label: 'Turbulence', min: 0, max: 1, softMax: 1, step: 0.01, def: 0.3, group: 'Gusts' },
  { key: 'trunkResponse', label: 'Trunk', min: 0, max: 4, softMax: 2, step: 0.01, def: 0.5, group: 'Response' },
  { key: 'branchResponse', label: 'Branches', min: 0, max: 4, softMax: 2, step: 0.01, def: 1, group: 'Response' },
  { key: 'leafResponse', label: 'Leaves', min: 0, max: 4, softMax: 2, step: 0.01, def: 1, group: 'Response' },
  { key: 'stiffness', label: 'Stiffness', min: 0, max: 1, softMax: 1, step: 0.01, def: 0.3, group: 'Dynamics' },
  { key: 'damping', label: 'Damping', min: 0, max: 1, softMax: 1, step: 0.01, def: 0.2, group: 'Dynamics' },
  { key: 'ripple', label: 'Ripple', min: 0, max: 1, softMax: 1, step: 0.01, def: 0.3, group: 'Dynamics' },
];

const RANGE = new Map(WIND_PARAM_RANGES.map((r) => [r.key, r]));

export function defaultWindParams(): WindParams {
  const p = { enabled: false } as WindParams;
  for (const r of WIND_PARAM_RANGES) p[r.key] = r.def;
  return p;
}

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** Clamp every value to its legal range (NaN / Infinity fall back to the default). */
export function clampWindParams(p: WindParams): WindParams {
  const out = { ...p };
  for (const r of WIND_PARAM_RANGES) out[r.key] = Math.min(r.max, Math.max(r.min, finite(p[r.key], r.def)));
  return out;
}

const extra = (s: WindSettings, key: string, fallback: number): number => {
  const v = s.params[key]?.value;
  return finite(v, fallback);
};

export function windParamsFromSettings(s: WindSettings | null | undefined): WindParams {
  const d = defaultWindParams();
  if (!s) return d;
  return clampWindParams({
    enabled: s.enabled,
    directionDeg: finite(s.directionDeg, d.directionDeg),
    strength: finite(s.strength, d.strength),
    gustStrength: finite(s.gustiness, d.gustStrength),
    gustFrequency: finite(s.frequency, d.gustFrequency),
    speed: extra(s, 'speed', d.speed),
    turbulence: extra(s, 'turbulence', d.turbulence),
    trunkResponse: extra(s, 'trunkResponse', d.trunkResponse),
    branchResponse: extra(s, 'branchResponse', d.branchResponse),
    leafResponse: extra(s, 'leafResponse', d.leafResponse),
    stiffness: extra(s, 'stiffness', d.stiffness),
    damping: extra(s, 'damping', d.damping),
    ripple: extra(s, 'ripple', d.ripple),
    baseHold: extra(s, 'baseHold', d.baseHold),
  });
}

/** Write one parameter back into a persisted `WindSettings` (mutates). */
export function writeWindParam(s: WindSettings, key: WindNumericKey, value: number): void {
  const r = RANGE.get(key);
  const v = r ? Math.min(r.max, Math.max(r.min, finite(value, r.def))) : value;
  switch (key) {
    case 'directionDeg':
      s.directionDeg = v;
      break;
    case 'strength':
      s.strength = v;
      break;
    case 'gustStrength':
      s.gustiness = v;
      break;
    case 'gustFrequency':
      s.frequency = v;
      break;
    default:
      s.params[key] = { ...(s.params[key] ?? {}), value: v };
  }
}

export type { MeshWindOverride };

