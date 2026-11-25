import type { SceneModel } from '@/contracts/engine';
import { packKekenikColors, zRangeOf, type TreeVertexColor } from '@/geometry/vertexColor';
import type { PlantGeometry } from './geometry';

/** Tree > Vertex Color of a scene (legacy packing, computed, when the scene has no Tree node). */
export function sceneVertexColor(scene: Pick<SceneModel, 'vertexColor'> | undefined): TreeVertexColor {
  return scene?.vertexColor ?? { compute: true, packing: 'legacy' };
}

/**
 * Writes the chosen vertex-colour packing into the export geometries (source space, Z up; run after the AO bake):
 * - compute off: the colours are dropped (no COLOR_0 / colour columns),
 * - Kekenik: R = per-branch tint, G = height over the whole plant (0 base .. 1 top), B = `ao` (baked when the export
 *   baked AO, analytic otherwise),
 * - Legacy: unchanged (the AO bake mode decides what the colours hold).
 */
export function applyVertexColorPacking(geometries: readonly PlantGeometry[], cfg: TreeVertexColor): void {
  if (!cfg.compute) {
    for (const g of geometries) delete g.colors;
    return;
  }
  if (cfg.packing !== 'kekenik') return;
  const zRange = zRangeOf(geometries.map((g) => g.positions));
  for (const g of geometries) {
    g.colors = packKekenikColors({ positions: g.positions, zRange, ...(g.ao ? { ao: g.ao } : {}), ...(g.branchTint ? { branchTint: g.branchTint } : {}) });
  }
}
