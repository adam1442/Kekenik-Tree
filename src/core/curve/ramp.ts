import { clamp, lerp, smoothstep } from '@/core/math';
import { cloneRamp, type Ramp, type RampInterpolation, type RampStop } from './types';

/**
 * Ramp (Color & Alpha Gradient) evaluation, LUT generation, presets, and stop operations.
 */

const MAX_RAMP_LUT_CACHE = 256;
const rampLutCache = new Map<string, Uint8Array>();
const rampFloatLutCache = new Map<string, Float32Array>();

let memoryClipboardRamp: string | null = null;

export function normalizeRamp(ramp: Ramp): Ramp {
  const copy = cloneRamp(ramp);
  copy.stops.sort((a, b) => a.t - b.t);
  if (copy.stops.length === 0) {
    copy.stops = [
      { t: 0, color: [0, 0, 0, 1] },
      { t: 1, color: [1, 1, 1, 1] },
    ];
  } else if (copy.stops.length === 1) {
    const only = copy.stops[0] as RampStop;
    copy.stops = [
      { t: 0, color: [...only.color] },
      { t: 1, color: [...only.color] },
    ];
  }
  return copy;
}

/**
 * Evaluate a Ramp at `t` in [0, 1], returning RGBA in [0, 1].
 */
export function evaluateRamp(ramp: Ramp, tIn: number): [number, number, number, number] {
  const stops = ramp.stops;
  const n = stops.length;
  if (n === 0) return [0, 0, 0, 1];
  const first = stops[0] as RampStop;
  if (n === 1) return [...first.color];
  const last = stops[n - 1] as RampStop;

  const t = clamp(tIn, 0, 1);
  if (t <= first.t) return [...first.color];
  if (t >= last.t) return [...last.color];

  let i = 0;
  while (i < n - 2 && (stops[i + 1] as RampStop).t <= t) i++;
  const a = stops[i] as RampStop;
  const b = stops[i + 1] as RampStop;
  const dt = b.t - a.t;
  if (dt <= 1e-7 || ramp.interpolation === 'step') {
    return [...a.color];
  }

  let u = clamp((t - a.t) / dt, 0, 1);
  if (ramp.interpolation === 'smooth') {
    u = smoothstep(0, 1, u);
  }

  return [
    clamp(lerp(a.color[0], b.color[0], u), 0, 1),
    clamp(lerp(a.color[1], b.color[1], u), 0, 1),
    clamp(lerp(a.color[2], b.color[2], u), 0, 1),
    clamp(lerp(a.color[3], b.color[3], u), 0, 1),
  ];
}

export function rampHash(ramp: Ramp): string {
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    h ^= v & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  mix(ramp.interpolation === 'linear' ? 1 : ramp.interpolation === 'step' ? 2 : 3);
  mix(ramp.stops.length);
  for (const s of ramp.stops) {
    mix(Math.round(s.t * 10000));
    mix(Math.round(s.color[0] * 1000));
    mix(Math.round(s.color[1] * 1000));
    mix(Math.round(s.color[2] * 1000));
    mix(Math.round(s.color[3] * 1000));
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Sample a Ramp into an 8-bit RGBA `Uint8Array(samples * 4)` (cached by ramp hash).
 */
export function rampToLUT(ramp: Ramp, samples = 256): Uint8Array {
  const count = Math.max(2, Math.floor(samples));
  const key = `${rampHash(ramp)}:${count}`;
  const cached = rampLutCache.get(key);
  if (cached) {
    rampLutCache.delete(key);
    rampLutCache.set(key, cached);
    return cached;
  }

  const lut = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const rgba = evaluateRamp(ramp, i / (count - 1));
    const o = i * 4;
    lut[o] = Math.round(clamp(rgba[0], 0, 1) * 255);
    lut[o + 1] = Math.round(clamp(rgba[1], 0, 1) * 255);
    lut[o + 2] = Math.round(clamp(rgba[2], 0, 1) * 255);
    lut[o + 3] = Math.round(clamp(rgba[3], 0, 1) * 255);
  }

  if (rampLutCache.size >= MAX_RAMP_LUT_CACHE) {
    const oldest = rampLutCache.keys().next().value;
    if (oldest !== undefined) rampLutCache.delete(oldest);
  }
  rampLutCache.set(key, lut);
  return lut;
}

/**
 * Sample a Ramp into a float RGBA `Float32Array(samples * 4)` in [0, 1] (cached by ramp hash).
 */
export function rampToFloatLUT(ramp: Ramp, samples = 256): Float32Array {
  const count = Math.max(2, Math.floor(samples));
  const key = `${rampHash(ramp)}:${count}`;
  const cached = rampFloatLutCache.get(key);
  if (cached) {
    rampFloatLutCache.delete(key);
    rampFloatLutCache.set(key, cached);
    return cached;
  }

  const lut = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const rgba = evaluateRamp(ramp, i / (count - 1));
    const o = i * 4;
    lut[o] = rgba[0];
    lut[o + 1] = rgba[1];
    lut[o + 2] = rgba[2];
    lut[o + 3] = rgba[3];
  }

  if (rampFloatLutCache.size >= MAX_RAMP_LUT_CACHE) {
    const oldest = rampFloatLutCache.keys().next().value;
    if (oldest !== undefined) rampFloatLutCache.delete(oldest);
  }
  rampFloatLutCache.set(key, lut);
  return lut;
}

/**
 * Add a stop at `t` (interpolating the current ramp color at `t` if `color` is omitted).
 */
export function addRampStop(
  ramp: Ramp,
  t: number,
  color: [number, number, number, number] = evaluateRamp(ramp, t),
): { ramp: Ramp; index: number } {
  const clampedT = clamp(t, 0, 1);
  const stops = ramp.stops.map((s) => ({ t: s.t, color: [...s.color] as [number, number, number, number] }));
  const newStop: RampStop = {
    t: clampedT,
    color: [clamp(color[0], 0, 1), clamp(color[1], 0, 1), clamp(color[2], 0, 1), clamp(color[3], 0, 1)],
  };
  let insertIdx = stops.findIndex((s) => s.t > clampedT);
  if (insertIdx === -1) insertIdx = stops.length;
  stops.splice(insertIdx, 0, newStop);
  return {
    ramp: { ...ramp, stops },
    index: insertIdx,
  };
}

/**
 * Remove a stop at `index` (always keeping at least 2 stops).
 */
export function removeRampStop(ramp: Ramp, index: number): Ramp {
  if (ramp.stops.length <= 2 || index < 0 || index >= ramp.stops.length) return ramp;
  return {
    ...ramp,
    stops: ramp.stops
      .filter((_, idx) => idx !== index)
      .map((s) => ({ t: s.t, color: [...s.color] as [number, number, number, number] })),
  };
}

/**
 * Reposition a stop to `t` in [0, 1], keeping stops sorted and returning the stop's new index.
 */
export function moveRampStop(ramp: Ramp, index: number, t: number): { ramp: Ramp; index: number } {
  if (index < 0 || index >= ramp.stops.length) return { ramp, index };
  const clampedT = clamp(t, 0, 1);
  const tagged = ramp.stops.map((s, idx) => ({
    t: idx === index ? clampedT : s.t,
    color: [...s.color] as [number, number, number, number],
    target: idx === index,
  }));
  tagged.sort((a, b) => a.t - b.t);
  const newIndex = tagged.findIndex((s) => s.target);
  return {
    ramp: {
      ...ramp,
      stops: tagged.map(({ t: pos, color }) => ({ t: pos, color })),
    },
    index: newIndex >= 0 ? newIndex : index,
  };
}

export function setRampStopColor(
  ramp: Ramp,
  index: number,
  color: [number, number, number, number],
): Ramp {
  if (index < 0 || index >= ramp.stops.length) return ramp;
  return {
    ...ramp,
    stops: ramp.stops.map((s, idx) =>
      idx === index
        ? {
            t: s.t,
            color: [clamp(color[0], 0, 1), clamp(color[1], 0, 1), clamp(color[2], 0, 1), clamp(color[3], 0, 1)],
          }
        : { t: s.t, color: [...s.color] as [number, number, number, number] },
    ),
  };
}

export function setRampStopAlpha(ramp: Ramp, index: number, alpha: number): Ramp {
  const stop = ramp.stops[index];
  if (!stop) return ramp;
  return setRampStopColor(ramp, index, [stop.color[0], stop.color[1], stop.color[2], clamp(alpha, 0, 1)]);
}

export function setRampInterpolation(ramp: Ramp, interpolation: RampInterpolation): Ramp {
  return {
    ...cloneRamp(ramp),
    interpolation,
  };
}

export function flipRamp(ramp: Ramp): Ramp {
  const flipped = ramp.stops
    .map((s): RampStop => ({
      t: 1 - s.t,
      color: [...s.color] as [number, number, number, number],
    }))
    .reverse();
  return normalizeRamp({ ...ramp, stops: flipped });
}

export function distributeRampStops(ramp: Ramp): Ramp {
  const n = ramp.stops.length;
  if (n < 2) return ramp;
  return {
    ...ramp,
    stops: ramp.stops.map((s, i) => ({
      t: i / (n - 1),
      color: [...s.color] as [number, number, number, number],
    })),
  };
}

export type RampPresetId =
  | 'foliage-summer'
  | 'autumn-decay'
  | 'bark-trunk'
  | 'canopy-ao'
  | 'grayscale'
  | 'alpha-fade'
  | 'stepped-zones';

export interface RampPresetDef {
  id: RampPresetId;
  label: string;
  ramp: Ramp;
}

export const RAMP_PRESETS: readonly RampPresetDef[] = [
  {
    id: 'foliage-summer',
    label: 'Foliage Summer',
    ramp: {
      interpolation: 'smooth',
      stops: [
        { t: 0, color: [0.26, 0.38, 0.06, 1] },
        { t: 0.5, color: [0.58, 0.75, 0.34, 1] },
        { t: 1, color: [0.45, 0.58, 0.48, 1] },
      ],
    },
  },
  {
    id: 'autumn-decay',
    label: 'Autumn Season',
    ramp: {
      interpolation: 'smooth',
      stops: [
        { t: 0, color: [0.28, 0.48, 0.16, 1] },
        { t: 0.38, color: [0.85, 0.72, 0.18, 1] },
        { t: 0.72, color: [0.82, 0.31, 0.14, 1] },
        { t: 1, color: [0.42, 0.22, 0.12, 1] },
      ],
    },
  },
  {
    id: 'bark-trunk',
    label: 'Bark Elevation',
    ramp: {
      interpolation: 'linear',
      stops: [
        { t: 0, color: [0.22, 0.18, 0.14, 1] },
        { t: 0.45, color: [0.46, 0.41, 0.35, 1] },
        { t: 1, color: [0.64, 0.6, 0.52, 1] },
      ],
    },
  },
  {
    id: 'canopy-ao',
    label: 'Canopy AO',
    ramp: {
      interpolation: 'smooth',
      stops: [
        { t: 0, color: [0.12, 0.15, 0.1, 1] },
        { t: 0.6, color: [0.55, 0.62, 0.48, 1] },
        { t: 1, color: [0.96, 0.98, 0.92, 1] },
      ],
    },
  },
  {
    id: 'grayscale',
    label: 'Grayscale',
    ramp: {
      interpolation: 'linear',
      stops: [
        { t: 0, color: [0, 0, 0, 1] },
        { t: 1, color: [1, 1, 1, 1] },
      ],
    },
  },
  {
    id: 'alpha-fade',
    label: 'Alpha Fade Out',
    ramp: {
      interpolation: 'smooth',
      stops: [
        { t: 0, color: [0.58, 0.75, 0.34, 1] },
        { t: 0.7, color: [0.58, 0.75, 0.34, 0.85] },
        { t: 1, color: [0.58, 0.75, 0.34, 0] },
      ],
    },
  },
  {
    id: 'stepped-zones',
    label: 'Stepped Zones',
    ramp: {
      interpolation: 'step',
      stops: [
        { t: 0, color: [0.26, 0.38, 0.06, 1] },
        { t: 0.33, color: [0.58, 0.75, 0.34, 1] },
        { t: 0.66, color: [0.45, 0.58, 0.48, 1] },
        { t: 1, color: [0.45, 0.58, 0.48, 1] },
      ],
    },
  },
];

export function getRampPreset(id: RampPresetId): Ramp {
  const found = RAMP_PRESETS.find((p) => p.id === id) ?? (RAMP_PRESETS[0] as RampPresetDef);
  return cloneRamp(found.ramp);
}

export function serializeRamp(ramp: Ramp): string {
  return JSON.stringify({
    format: 'kekenik-ramp-v1',
    ramp: cloneRamp(ramp),
  });
}

export function deserializeRamp(json: string): Ramp | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = ('ramp' in parsed ? (parsed as { ramp: unknown }).ramp : parsed) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.stops) || raw.stops.length === 0) return null;
    const interpolation: RampInterpolation =
      raw.interpolation === 'step' || raw.interpolation === 'smooth' ? raw.interpolation : 'linear';
    const stops: RampStop[] = [];
    for (const s of raw.stops) {
      if (typeof s !== 'object' || s === null) continue;
      const item = s as Record<string, unknown>;
      if (typeof item.t !== 'number' || !Array.isArray(item.color) || item.color.length < 3) continue;
      const c = item.color as unknown[];
      const r = typeof c[0] === 'number' ? clamp(c[0], 0, 1) : 0;
      const g = typeof c[1] === 'number' ? clamp(c[1], 0, 1) : 0;
      const b = typeof c[2] === 'number' ? clamp(c[2], 0, 1) : 0;
      const a = typeof c[3] === 'number' ? clamp(c[3], 0, 1) : 1;
      stops.push({ t: clamp(item.t, 0, 1), color: [r, g, b, a] });
    }
    if (stops.length === 0) return null;
    return normalizeRamp({ stops, interpolation });
  } catch {
    return null;
  }
}

export async function copyRampClipboard(ramp: Ramp): Promise<string> {
  const text = serializeRamp(ramp);
  memoryClipboardRamp = text;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // Fallback to memory clipboard
  }
  return text;
}

export async function pasteRampClipboard(): Promise<Ramp | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      const parsed = deserializeRamp(text);
      if (parsed) return parsed;
    }
  } catch {
    // Fallback to memory clipboard
  }
  return memoryClipboardRamp ? deserializeRamp(memoryClipboardRamp) : null;
}
