import { loadJSON, saveJSON } from '@/app/settings';

/** Post-process anti-aliasing applied after the (multisampled) scene pass. */
export type PostAA = 'none' | 'fxaa' | 'smaa' | 'taa';
/** How cut-out (alpha-tested) foliage is rasterised. `coverage` needs MSAA; without it `hashed` is used. */
export type AlphaMode = 'coverage' | 'hashed' | 'test';
export type QualityPreset = 'low' | 'medium' | 'high' | 'ultra';
export type GridUnit = 'm' | 'cm' | 'in' | 'ft';

export interface QualitySettings {
  /** Preset the values were derived from; 'custom' as soon as one value is edited. */
  preset: QualityPreset | 'custom';
  /** MSAA sample count of the scene render target (0 = off). Clamped to what the GPU supports. */
  msaaSamples: 0 | 2 | 4 | 8;
  postAA: PostAA;
  /** Jittered frames accumulated by TAA once the view is still. */
  taaFrames: number;
  /** Upper bound of the device pixel ratio used for the canvas. */
  maxPixelRatio: number;
  /** Cheap AA while interacting, full quality ~150 ms after the last change. */
  progressive: boolean;
  anisotropy: number;
  /** Texture LOD bias (negative = sharper, positive = blurrier). */
  mipBias: number;
  alphaMode: AlphaMode;
  /** Rescale texture mips so alpha-tested leaves keep their coverage at distance. */
  coverageMips: boolean;
  /** Grow cut-out leaf cards slightly with camera distance. */
  leafDistanceScale: boolean;
  /** Maximum relative growth of leaf cards at far distance (0..0.3). */
  leafScaleAmount: number;
  showGridAxes: boolean;
  /** Edge length of the grid base cell in `gridUnit`s (levels are 10x steps of it, 1/100 .. 1000 cells). */
  gridSize: number;
  gridUnit: GridUnit;
  /** Distance (m) at which the grid has completely faded out. */
  gridFadeDistance: number;
}

export const QUALITY_PRESETS: Record<QualityPreset, Partial<QualitySettings>> = {
  low: { msaaSamples: 0, postAA: 'fxaa', taaFrames: 8, maxPixelRatio: 1, progressive: true, anisotropy: 4, mipBias: 0, alphaMode: 'test', coverageMips: true, leafDistanceScale: true },
  medium: { msaaSamples: 4, postAA: 'none', taaFrames: 8, maxPixelRatio: 2, progressive: true, anisotropy: 8, mipBias: 0, alphaMode: 'coverage', coverageMips: true, leafDistanceScale: false },
  high: { msaaSamples: 4, postAA: 'smaa', taaFrames: 8, maxPixelRatio: 2, progressive: true, anisotropy: 16, mipBias: 0, alphaMode: 'coverage', coverageMips: true, leafDistanceScale: false },
  ultra: { msaaSamples: 8, postAA: 'taa', taaFrames: 16, maxPixelRatio: 2, progressive: true, anisotropy: 16, mipBias: -0.25, alphaMode: 'coverage', coverageMips: true, leafDistanceScale: false },
};

export const GRID_UNIT_METERS: Record<GridUnit, number> = { m: 1, cm: 0.01, in: 0.0254, ft: 0.3048 };

export const DEFAULT_QUALITY: QualitySettings = {
  preset: 'medium',
  msaaSamples: 4,
  postAA: 'none',
  taaFrames: 8,
  maxPixelRatio: 2,
  progressive: true,
  anisotropy: 8,
  mipBias: 0,
  alphaMode: 'coverage',
  coverageMips: true,
  leafDistanceScale: false,
  leafScaleAmount: 0.1,
  showGridAxes: true,
  gridSize: 1,
  gridUnit: 'm',
  gridFadeDistance: 420,
};

const STORAGE_KEY = 'viewport.quality';
const SAMPLES = [0, 2, 4, 8] as const;
const POST: readonly PostAA[] = ['none', 'fxaa', 'smaa', 'taa'];
const ALPHA: readonly AlphaMode[] = ['coverage', 'hashed', 'test'];
const UNITS: readonly GridUnit[] = ['m', 'cm', 'in', 'ft'];
const PRESETS: readonly (QualityPreset | 'custom')[] = ['low', 'medium', 'high', 'ultra', 'custom'];

const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
function pick<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Validate untrusted (persisted) data; unknown / invalid fields fall back to the defaults. */
export function sanitizeQuality(raw: unknown): QualitySettings {
  const d = DEFAULT_QUALITY;
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const samples = typeof r.msaaSamples === 'number' && (SAMPLES as readonly number[]).includes(r.msaaSamples) ? (r.msaaSamples as 0 | 2 | 4 | 8) : d.msaaSamples;
  return {
    preset: pick(r.preset, PRESETS, d.preset),
    msaaSamples: samples,
    postAA: pick(r.postAA, POST, d.postAA),
    taaFrames: Math.round(num(r.taaFrames, 2, 64, d.taaFrames)),
    maxPixelRatio: num(r.maxPixelRatio, 0.5, 4, d.maxPixelRatio),
    progressive: bool(r.progressive, d.progressive),
    anisotropy: Math.round(num(r.anisotropy, 1, 16, d.anisotropy)),
    mipBias: num(r.mipBias, -1, 1, d.mipBias),
    alphaMode: pick(r.alphaMode, ALPHA, d.alphaMode),
    coverageMips: bool(r.coverageMips, d.coverageMips),
    leafDistanceScale: bool(r.leafDistanceScale, d.leafDistanceScale),
    leafScaleAmount: num(r.leafScaleAmount, 0, 0.3, d.leafScaleAmount),
    showGridAxes: bool(r.showGridAxes, d.showGridAxes),
    gridSize: num(r.gridSize, 0.001, 1000, d.gridSize),
    gridUnit: pick(r.gridUnit, UNITS, d.gridUnit),
    gridFadeDistance: num(r.gridFadeDistance, 20, 5000, d.gridFadeDistance),
  };
}

/** Metres covered by one cell of the grid base level. */
export function gridCellMeters(q: Pick<QualitySettings, 'gridSize' | 'gridUnit'>): number {
  return q.gridSize * GRID_UNIT_METERS[q.gridUnit];
}

/**
 * The alpha mode that is actually used: `coverage` needs MSAA (alpha-to-coverage does nothing without it) and the
 * shading option "Alpha to coverage"; otherwise it degrades to dithered (hashed) alpha.
 */
export function effectiveAlphaMode(q: Pick<QualitySettings, 'alphaMode' | 'msaaSamples'>, shadingAlphaToCoverage = true): AlphaMode {
  if (q.alphaMode !== 'coverage') return q.alphaMode;
  return q.msaaSamples > 0 && shadingAlphaToCoverage ? 'coverage' : 'hashed';
}

export interface QualityStatus {
  /** Human readable label, e.g. "MSAA 4x + SMAA @ 2.00x". */
  label: string;
  refined: boolean;
  /** TAA frames accumulated so far / target. */
  taaProgress: [number, number];
}

let current: QualitySettings = sanitizeQuality(typeof localStorage === 'undefined' ? null : loadJSON(STORAGE_KEY));
let status: QualityStatus = { label: '', refined: true, taaProgress: [0, 0] };
const listeners = new Set<() => void>();
const statusListeners = new Set<() => void>();

export const getQuality = (): QualitySettings => current;

/** Patch the settings; touching any value other than `preset` switches the preset label to 'custom'. */
export function setQuality(patch: Partial<QualitySettings>): void {
  const touched = Object.keys(patch).some((k) => k !== 'preset');
  current = sanitizeQuality({ ...current, ...patch, preset: patch.preset ?? (touched ? 'custom' : current.preset) });
  saveJSON(STORAGE_KEY, current);
  listeners.forEach((l) => l());
}

export function applyQualityPreset(name: QualityPreset): void {
  setQuality({ ...QUALITY_PRESETS[name], preset: name });
}

export function onQualityChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getQualityStatus = (): QualityStatus => status;

export function setQualityStatus(next: QualityStatus): void {
  const same = next.label === status.label && next.refined === status.refined && next.taaProgress[0] === status.taaProgress[0] && next.taaProgress[1] === status.taaProgress[1];
  status = next;
  if (!same) statusListeners.forEach((l) => l());
}

export function onQualityStatusChange(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
