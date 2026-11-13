import type {
  ExportFormat,
  ExportSettings,
  ExportUnits,
  Handedness,
  ImageFormat,
  ImpostorMode,
  LodLevelSettings,
  LodSettings,
  UpAxis,
} from './types';

const KEY = 'kekenik.export.settings';
const LOD_KEY = 'kekenik.export.lods';
export const MAX_LODS = 6;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback);

export function defaultLodLevels(): LodLevelSettings[] {
  return [
    { engineLod: 0, foliageKeep: 1, keepSilhouette: true, minBranchSize: 0, transition: 1, triangleBudget: 0 },
    { engineLod: 1, foliageKeep: 0.6, keepSilhouette: true, minBranchSize: 1, transition: 0.45, triangleBudget: 0 },
    { engineLod: 2, foliageKeep: 0.3, keepSilhouette: true, minBranchSize: 3, transition: 0.2, triangleBudget: 0 },
    { engineLod: 3, foliageKeep: 0.12, keepSilhouette: true, minBranchSize: 6, transition: 0.08, triangleBudget: 0 },
  ];
}

export function defaultExportSettings(name = 'Plant'): ExportSettings {
  return {
    name,
    format: 'glb',
    lods: [0],
    lodLayout: 'single',
    mergeMode: 'single',
    units: 'm',
    upAxis: 'Y',
    handedness: 'right',
    scale: 1,
    zip: false,
    customAttributes: true,
    vertexColors: true,
    metadata: true,
    verify: true,
    textures: { enabled: true, format: 'png', quality: 0.9, maxSize: 0, packing: 'orm', padding: 4, external: false },
    bake: { aoMode: 'off', aoSamples: 24, aoRadius: 0.12, aoStrength: 0.8 },
    impostor: { mode: 'off', views: 8, topView: false, frameSize: 256, padding: 4, normals: true, depth: true, sourceLod: 0 },
  };
}

export function sanitizeLodLevel(raw: unknown, fallback: LodLevelSettings, index: number): LodLevelSettings {
  const r = isRecord(raw) ? raw : {};
  return {
    engineLod: Math.round(num(r.engineLod, fallback.engineLod, 0, 3)),
    foliageKeep: num(r.foliageKeep, fallback.foliageKeep, 0.02, 1),
    keepSilhouette: bool(r.keepSilhouette, fallback.keepSilhouette),
    minBranchSize: num(r.minBranchSize, fallback.minBranchSize, 0, 50),
    transition: index === 0 ? 1 : num(r.transition, fallback.transition, 0.001, 1),
    triangleBudget: Math.round(num(r.triangleBudget, fallback.triangleBudget, 0, 50_000_000)),
  };
}

export function sanitizeLodSettings(raw: unknown): LodSettings {
  const defaults = defaultLodLevels();
  const list = isRecord(raw) && Array.isArray(raw.levels) ? raw.levels.slice(0, MAX_LODS) : [];
  if (list.length === 0) return { levels: defaults };
  const levels = list.map((l, i) => sanitizeLodLevel(l, defaults[Math.min(i, defaults.length - 1)] as LodLevelSettings, i));
  // Transitions must be strictly decreasing, otherwise a LOD could never be selected.
  for (let i = 1; i < levels.length; i++) {
    const prev = (levels[i - 1] as LodLevelSettings).transition;
    const cur = levels[i] as LodLevelSettings;
    if (cur.transition >= prev) cur.transition = Math.max(0.001, prev * 0.5);
  }
  return { levels };
}

export function sanitizeExportSettings(raw: unknown, lodCount: number, name = 'Plant'): ExportSettings {
  const d = defaultExportSettings(name);
  if (!isRecord(raw)) return d;
  const tex = isRecord(raw.textures) ? raw.textures : {};
  const bake = isRecord(raw.bake) ? raw.bake : {};
  const imp = isRecord(raw.impostor) ? raw.impostor : {};
  const lods = Array.isArray(raw.lods) ? raw.lods.filter((v): v is number => typeof v === 'number' && v >= 0 && v < lodCount).map((v) => Math.floor(v)) : d.lods;
  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : d.name,
    format: oneOf<ExportFormat>(raw.format, ['glb', 'gltf', 'obj', 'ply', 'stl'], d.format),
    lods: lods.length > 0 ? [...new Set(lods)].sort((a, b) => a - b) : [0],
    lodLayout: oneOf(raw.lodLayout, ['files', 'single'], d.lodLayout),
    mergeMode: oneOf(raw.mergeMode, ['single', 'perNode'], d.mergeMode),
    units: oneOf<ExportUnits>(raw.units, ['m', 'cm', 'mm', 'in', 'ft'], d.units),
    upAxis: oneOf<UpAxis>(raw.upAxis, ['Y', 'Z'], d.upAxis),
    handedness: oneOf<Handedness>(raw.handedness, ['right', 'left'], d.handedness),
    scale: num(raw.scale, 1, 0.0001, 10000),
    zip: bool(raw.zip, d.zip),
    customAttributes: bool(raw.customAttributes, d.customAttributes),
    vertexColors: bool(raw.vertexColors, d.vertexColors),
    metadata: bool(raw.metadata, d.metadata),
    verify: bool(raw.verify, d.verify),
    textures: {
      enabled: bool(tex.enabled, d.textures.enabled),
      format: oneOf<ImageFormat>(tex.format, ['png', 'jpg', 'webp'], d.textures.format),
      quality: num(tex.quality, d.textures.quality, 0.1, 1),
      maxSize: Math.round(num(tex.maxSize, d.textures.maxSize, 0, 8192)),
      packing: oneOf(tex.packing, ['none', 'orm'], d.textures.packing),
      padding: Math.round(num(tex.padding, d.textures.padding, 0, 64)),
      external: bool(tex.external, d.textures.external),
    },
    bake: {
      aoMode: oneOf(bake.aoMode, ['off', 'multiply', 'replace'], d.bake.aoMode),
      aoSamples: Math.round(num(bake.aoSamples, d.bake.aoSamples, 4, 128)),
      aoRadius: num(bake.aoRadius, d.bake.aoRadius, 0.01, 1),
      aoStrength: num(bake.aoStrength, d.bake.aoStrength, 0, 1),
    },
    impostor: {
      mode: oneOf<ImpostorMode>(imp.mode, ['off', 'impostor', 'cross', 'both'], d.impostor.mode),
      views: Math.round(num(imp.views, d.impostor.views, 4, 32)),
      topView: bool(imp.topView, d.impostor.topView),
      frameSize: Math.round(num(imp.frameSize, d.impostor.frameSize, 32, 1024)),
      padding: Math.round(num(imp.padding, d.impostor.padding, 0, 32)),
      normals: bool(imp.normals, d.impostor.normals),
      depth: bool(imp.depth, d.impostor.depth),
      sourceLod: Math.floor(num(imp.sourceLod, 0, 0, Math.max(0, lodCount - 1))),
    },
  };
}

function readStorage(key: string): unknown {
  try {
    const text = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / blocked: settings simply are not remembered */
  }
}

let lodCache: LodSettings | null = null;
const lodListeners = new Set<(s: LodSettings) => void>();

/** LOD definitions are remembered per browser profile (they are not part of the project file format yet). */
export function getLodSettings(): LodSettings {
  lodCache ??= sanitizeLodSettings(readStorage(LOD_KEY));
  return lodCache;
}

export function setLodSettings(next: LodSettings): void {
  lodCache = sanitizeLodSettings(next);
  writeStorage(LOD_KEY, lodCache);
  lodListeners.forEach((l) => l(lodCache as LodSettings));
}

export function onLodSettingsChange(fn: (s: LodSettings) => void): () => void {
  lodListeners.add(fn);
  return () => lodListeners.delete(fn);
}

export function loadExportSettings(name: string): ExportSettings {
  return sanitizeExportSettings(readStorage(KEY), getLodSettings().levels.length, name);
}

export function saveExportSettings(s: ExportSettings): void {
  writeStorage(KEY, s);
}
