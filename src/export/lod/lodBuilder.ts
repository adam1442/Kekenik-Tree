import type { EvaluationSummary, SceneModel } from '@/contracts/engine';
import type { CancellationToken } from '@/contracts/nodes';
import type { LodLevelSettings } from '../types';
import { applyLodToScene } from './lodScene';

/** What the LOD builder needs from the engine (`EngineHost.evaluateAt` satisfies it). */
export interface LodSceneSource {
  evaluateAt(lod: number, token: CancellationToken, onProgress?: (done: number, total: number) => void): Promise<EvaluationSummary>;
  /** Project seed (drives the deterministic foliage selection). */
  seed: number;
}

export interface BuiltLod {
  index: number;
  level: LodLevelSettings;
  scene: SceneModel;
}

/**
 * Generate the requested LODs: evaluate the graph at each distinct generator detail (cached by the engine), then run
 * the post-process (small-branch removal, foliage thinning + enlargement, triangle budget).
 */
export async function buildLods(source: LodSceneSource, levels: readonly LodLevelSettings[], indices: readonly number[], token: CancellationToken, onProgress?: (fraction: number) => void): Promise<BuiltLod[]> {
  const evaluated = new Map<number, SceneModel>();
  const distinct = [...new Set(indices.map((i) => (levels[i] as LodLevelSettings).engineLod))];
  const out: BuiltLod[] = [];
  let done = 0;
  for (const lod of distinct) {
    const summary = await source.evaluateAt(lod, token, (d, t) => onProgress?.((done + (t === 0 ? 1 : d / t)) / (distinct.length + 1)));
    evaluated.set(lod, summary.scene);
    done += 1;
  }
  for (const index of indices) {
    const level = levels[index] as LodLevelSettings;
    out.push({ index, level, scene: applyLodToScene(evaluated.get(level.engineLod) as SceneModel, level, source.seed) });
  }
  onProgress?.(1);
  return out;
}
