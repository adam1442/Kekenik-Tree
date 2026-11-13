import { loadJSON, saveJSON } from '@/app/settings';

/** Persisted options of the debug view modes (Normals length, Points size, alpha overlay). */
export interface DebugViewSettings {
  /** Length of a vertex-normal line in metres. */
  normalLength: number;
  /** Diameter of a point in CSS pixels (constant on screen). */
  pointSize: number;
}

const KEY = 'kt.debugView.v1';
export const DEBUG_VIEW_LIMITS = { normalLength: { min: 0.005, max: 1 }, pointSize: { min: 1, max: 16 } } as const;
const DEFAULTS: DebugViewSettings = { normalLength: 0.05, pointSize: 4 };

const clamp = (v: unknown, min: number, max: number, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback);

export function sanitizeDebugView(raw: unknown): DebugViewSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const L = DEBUG_VIEW_LIMITS;
  return {
    normalLength: clamp(r.normalLength, L.normalLength.min, L.normalLength.max, DEFAULTS.normalLength),
    pointSize: clamp(r.pointSize, L.pointSize.min, L.pointSize.max, DEFAULTS.pointSize),
  };
}

let current = sanitizeDebugView(typeof localStorage === 'undefined' ? null : loadJSON(KEY));
const listeners = new Set<(s: DebugViewSettings) => void>();

export const getDebugView = (): DebugViewSettings => current;

export function setDebugView(patch: Partial<DebugViewSettings>): void {
  current = sanitizeDebugView({ ...current, ...patch });
  if (typeof localStorage !== 'undefined') saveJSON(KEY, current);
  listeners.forEach((l) => l(current));
}

export function onDebugViewChange(fn: (s: DebugViewSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
