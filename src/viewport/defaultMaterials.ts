import { CanvasTexture, DoubleSide, Material, MeshStandardMaterial, SRGBColorSpace } from 'three';
import { Rng } from '@/core/rng';

/** Maps MeshData material slot ids to three.js materials (the materials layer installs real material rendering on top). */
export interface MaterialResolver {
  resolve(materialId: string): Material;
  /** Material for the BackSide twin mesh of `materialId`, or null when it has no Back material. */
  resolveBack?(materialId: string): Material | null;
  /** Identifies the structural (non in-place) state of a material, e.g. its Back material id. */
  backKey?(materialId: string): string;
  /** Subscribe to structural changes (returns unsubscribe). Property edits are applied in place and only repaint. */
  onChange?(fn: () => void): () => void;
  dispose(): void;
}

function createLeafTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d');
  if (!g) return null;
  const rng = new Rng(7);
  g.lineCap = 'round';
  g.strokeStyle = 'rgb(190,205,170)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(64, 254);
  g.lineTo(64, 6);
  g.stroke();
  for (let i = 0; i < 26; i++) {
    const t = i / 25;
    const y = 246 - t * 232;
    const len = (1 - t * 0.7) * 56 + 6;
    const ang = 0.95 - 0.3 * t;
    for (const side of [-1, 1]) {
      const shade = Math.round(rng.range(170, 245));
      g.strokeStyle = `rgb(${shade - 20},${shade},${shade - 30})`;
      g.lineWidth = rng.range(2.6, 3.8);
      g.beginPath();
      g.moveTo(64, y);
      g.lineTo(64 + side * Math.sin(ang) * len, y - Math.cos(ang) * len * 0.8);
      g.stroke();
    }
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function createDefaultMaterialResolver(): MaterialResolver {
  const cache = new Map<string, Material>();
  let leafTexture: CanvasTexture | null | undefined;
  return {
    resolve(materialId) {
      const hit = cache.get(materialId);
      if (hit) return hit;
      let m: Material;
      if (materialId === 'leaf') {
        if (leafTexture === undefined) leafTexture = createLeafTexture();
        m = new MeshStandardMaterial({ vertexColors: true, map: leafTexture ?? null, alphaTest: 0.5, side: DoubleSide, roughness: 0.8 });
      } else m = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, ...(materialId === 'cluster' ? { side: DoubleSide } : {}) });
      cache.set(materialId, m);
      return m;
    },
    dispose() {
      cache.forEach((m) => m.dispose());
      cache.clear();
      leafTexture?.dispose();
      leafTexture = undefined;
    },
  };
}
