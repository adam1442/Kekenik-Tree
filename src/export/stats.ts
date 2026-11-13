import type { SceneModel } from '@/contracts/engine';
import type { GeometryStats, MergeMode } from './types';

/** Statistics shown in the export dialog before anything is written (computed from the generated scene, no merging). */

export function sceneDrawCalls(scene: SceneModel, mode: MergeMode): number {
  if (mode === 'single') {
    const ids = new Set<string>();
    for (const e of scene.entries) {
      if (e.mesh.indices.length === 0) continue;
      if (e.mesh.slots.length === 0) ids.add('default');
      for (const s of e.mesh.slots) if (s.indexCount > 0) ids.add(s.materialId);
    }
    return ids.size;
  }
  let calls = 0;
  for (const e of scene.entries) {
    if (e.mesh.indices.length === 0) continue;
    calls += new Set(e.mesh.slots.length === 0 ? ['default'] : e.mesh.slots.filter((s) => s.indexCount > 0).map((s) => s.materialId)).size;
  }
  return calls;
}

export function sceneStats(scene: SceneModel, mode: MergeMode): GeometryStats {
  return { triangles: scene.stats.triangles, vertices: scene.stats.vertices, drawCalls: sceneDrawCalls(scene, mode) };
}

export function sceneMaterialIds(scene: SceneModel): string[] {
  const ids = new Set<string>();
  for (const e of scene.entries) {
    if (e.mesh.slots.length === 0 && e.mesh.indices.length > 0) ids.add('default');
    for (const s of e.mesh.slots) if (s.indexCount > 0) ids.add(s.materialId);
  }
  return [...ids];
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
