import type { SceneModel } from '@/contracts/engine';
import { analyseScene, applyDynamicLod, levelValue, lodNodeScales, lodReport, type DynamicLodModel, type DynamicLodReport } from '@/lod/dynamic';
import type { LodLevelSettings } from '../types';

/** Dynamic LOD of a generated scene as discrete export levels: level k of n uses the LOD value k / (n - 1). */

const models = new WeakMap<SceneModel, DynamicLodModel>();

/** Importance analysis of a scene (cached per scene object: engine results are immutable). */
export function modelOf(scene: SceneModel, seed: number): DynamicLodModel {
  let m = models.get(scene);
  if (!m) {
    m = analyseScene(scene, seed);
    models.set(scene, m);
  }
  return m;
}

export const isDynamicScene = (scene: SceneModel): boolean => scene.dynamicLod?.enabled === true;

export interface DynamicLevelResult {
  scene: SceneModel;
  report: DynamicLodReport;
}

/** Level `index` of `count` of a scene whose Tree node enables Dynamic LOD (compact meshes: removed vertices are dropped). */
export function applyDynamicLevel(scene: SceneModel, index: number, count: number, seed: number): DynamicLevelResult | null {
  const config = scene.dynamicLod;
  if (!config?.enabled) return null;
  const value = levelValue(index, count);
  const model = modelOf(scene, seed);
  const out = applyDynamicLod(scene, model, config, value, { compact: true });
  return { scene: out, report: lodReport(model, lodNodeScales(model, config, value), value) };
}

/** The LOD level list resized to `count` levels (Tree > Dynamic LOD > Levels). Existing levels are kept; new ones continue the series. */
export function resizeLevels(levels: readonly LodLevelSettings[], count: number): LodLevelSettings[] {
  const n = Math.max(1, Math.round(count));
  if (levels.length === n) return [...levels];
  if (levels.length > n) return levels.slice(0, n);
  const out = [...levels];
  while (out.length < n) {
    const last = out[out.length - 1] as LodLevelSettings;
    const index = out.length;
    out.push({ ...last, engineLod: Math.min(3, Math.max(last.engineLod, index)), transition: Math.max(0.001, last.transition * 0.5) });
  }
  return out;
}

/** Levels the export offers: with Dynamic LOD enabled the Tree's Levels count, else the export settings. */
export function exportLevelsFor(levels: readonly LodLevelSettings[], scene: SceneModel | null | undefined): LodLevelSettings[] {
  const c = scene?.dynamicLod;
  return c?.enabled ? resizeLevels(levels, c.levels) : [...levels];
}
