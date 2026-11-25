import type { PlantGeometry } from '../geometry';

/** One tiled primitive that was (or could not be) remapped by the V-tiling option. */
export interface VTilingEntry {
  geometry: string;
  materialId: string;
  /** V range before the remap. */
  vMin: number;
  vMax: number;
  /** Whole V repeats after the remap: V' runs 0 .. repeats, so top and bottom touch the cell edges (cell V = fract(V') / repeats-free: V' / repeats gives 0..1 over `repeats` tiles). */
  repeats: number;
  /** V scale applied (repeats / (vMax - vMin)); 1 = no stretch. */
  stretch: number;
  /** Width of the U range in tiles (`uMax - uMin`). */
  uTiles: number;
  uTilesWhole: boolean;
  /** Share (0..100) of V texel density lost by squashing the repeats (0 when the texture is stretched instead). */
  resolutionLossPercent: number;
  applied: boolean;
  /** Why the primitive was left alone (applied = false). */
  reason?: string;
}

export interface VTilingOptions {
  /** Materials that are never cut apart / remapped (Atlas handling = Force out). */
  skipMaterial?: (materialId: string) => boolean;
}

const EPS = 1e-6;

/**
 * V-tiling for branch atlases (in place, positions untouched). A primitive that tiles in V (V range > 1) is stretched to a whole number
 * of repeats starting at V = 0, so the branch texture's top and bottom edges coincide with the edges of its atlas cell. Vertices shared with
 * another primitive are left alone (they would be remapped twice); the entry then reports `applied = false`.
 */
export function applyVTiling(geometries: readonly PlantGeometry[], options: VTilingOptions = {}): VTilingEntry[] {
  const out: VTilingEntry[] = [];
  for (const g of geometries) {
    const n = g.uv0.length / 2;
    const uses = new Uint8Array(n);
    for (const p of g.primitives) {
      const seen = new Uint8Array(n);
      for (const i of p.indices) {
        if (!seen[i]) {
          seen[i] = 1;
          uses[i] = Math.min(255, (uses[i] as number) + 1);
        }
      }
    }
    for (const p of g.primitives) {
      if (options.skipMaterial?.(p.materialId)) continue;
      let vMin = Infinity;
      let vMax = -Infinity;
      let uMin = Infinity;
      let uMax = -Infinity;
      for (const i of p.indices) {
        const u = g.uv0[i * 2] as number;
        const v = g.uv0[i * 2 + 1] as number;
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
      }
      const range = vMax - vMin;
      if (!(range > 1 + 1e-4)) continue;
      const uTiles = uMax - uMin;
      const repeats = Math.max(1, Math.round(range));
      const stretch = repeats / range;
      const entry: VTilingEntry = {
        geometry: g.name,
        materialId: p.materialId,
        vMin,
        vMax,
        repeats,
        stretch,
        uTiles,
        uTilesWhole: Math.abs(uTiles - Math.round(uTiles)) < 0.01,
        resolutionLossPercent: Math.max(0, 1 - stretch) * 100,
        applied: false,
      };
      const shared = p.indices.some((i) => (uses[i] as number) > 1);
      if (shared) {
        entry.reason = 'vertices are shared with another material';
        out.push(entry);
        continue;
      }
      const done = new Uint8Array(n);
      for (const i of p.indices) {
        if (done[i]) continue;
        done[i] = 1;
        g.uv0[i * 2 + 1] = ((g.uv0[i * 2 + 1] as number) - vMin) * stretch;
      }
      entry.applied = true;
      out.push(entry);
    }
  }
  return out;
}

/** Warnings of a V-tiling run: a fractional U tile count and a noticeable resolution loss. */
export function vTilingWarnings(entries: readonly VTilingEntry[], materialName: (id: string) => string): string[] {
  const warnings: string[] = [];
  for (const e of entries) {
    const name = materialName(e.materialId);
    if (!e.applied) warnings.push(`V-tiling: "${name}" was left unchanged (${e.reason ?? 'not applicable'}).`);
    else if (!e.uTilesWhole && e.uTiles > EPS) warnings.push(`V-tiling: "${name}" covers ${e.uTiles.toFixed(2)} U tiles (not a whole number): the branch texture cannot sit in an atlas cell without a seam. Turn on Branch > UV Mapping > Create seams and use a whole U tile count.`);
    if (e.applied && e.resolutionLossPercent > 10) warnings.push(`V-tiling: "${name}" is squashed by ${e.resolutionLossPercent.toFixed(0)} % in V (${e.repeats} repeats over a V range of ${(e.vMax - e.vMin).toFixed(2)}): about that much texture resolution is lost along the branch.`);
  }
  return warnings;
}
