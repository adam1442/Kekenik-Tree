import { alphaCoverage, buildCoverageMipChain, buildPlainMipChain, type MipLevel } from '@/textures/alphaCoverage';

/**
 * Foliage Density test scene (CPU model). A dense crown of leaf cards is seen at three distances; at distance the
 * texture is sampled from a smaller mip level, so the fraction of texels that pass the alpha test is the fraction of
 * leaf pixels that survive. Used by tests to compare plain GPU mips with the coverage-preserving
 * chain, and to sweep the Alpha Threshold.
 */
export interface DensityScene {
  /** Synthetic leaf mask (RGBA, mask in green and alpha). */
  mask: MipLevel;
  /** Texels per screen pixel for the near / mid / far camera. */
  distances: { near: number; mid: number; far: number };
}

/** Synthetic leaf: soft blade, thin midrib, serration teeth (the features that vanish first in plain mips). */
export function syntheticLeafMask(size: number): MipLevel {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const r = Math.hypot(u / 0.28, v / 0.45);
      let a = Math.min(1, Math.max(0, (1 - r) * 5));
      if (Math.abs(u) < 0.5 / size && Math.abs(v) < 0.4) a = Math.max(a, 0.9);
      if ((x + y) % 11 === 0 && r < 1.4 && r > 1) a = Math.max(a, 0.8);
      const i = (y * size + x) * 4;
      data[i] = 40;
      data[i + 1] = Math.round(a * 255);
      data[i + 2] = 40;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return { width: size, height: size, data };
}

export function createDensityScene(size = 256): DensityScene {
  return { mask: syntheticLeafMask(size), distances: { near: 1, mid: 4, far: 16 } };
}

export interface CoverageRow {
  near: number;
  mid: number;
  far: number;
}

/** Fraction of covered pixels at one mip level (`texelsPerPixel` 1 = level 0, 4 = level 2, ...). */
function levelCoverage(chain: MipLevel[], texelsPerPixel: number, testAt: number): number {
  const level = Math.min(chain.length - 1, Math.max(0, Math.round(Math.log2(texelsPerPixel))));
  return alphaCoverage((chain[level] as MipLevel).data, 1, testAt);
}

/** Coverage at the three distances for a threshold, with plain or coverage-preserving mips. */
export function measureCoverage(scene: DensityScene, cutoff: number, coverageMips: boolean): CoverageRow {
  const chain = coverageMips ? buildCoverageMipChain(scene.mask, { channel: 'g', cutoff }) : buildPlainMipChain(scene.mask, 'g');
  const test = coverageMips ? 0.5 : cutoff; // the coverage chain is remapped so the cutoff sits at 0.5
  const d = scene.distances;
  return { near: levelCoverage(chain, d.near, test), mid: levelCoverage(chain, d.mid, test), far: levelCoverage(chain, d.far, test) };
}

/** Coverage at the near distance for a sweep of Alpha Threshold values. */
export function sweepThreshold(scene: DensityScene, cutoffs: readonly number[]): number[] {
  return cutoffs.map((c) => measureCoverage(scene, c, true).near);
}
