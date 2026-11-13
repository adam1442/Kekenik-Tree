import type { CutoutTessellationSettings } from '@/contracts/material';
import { Rng } from '@/core/rng';
import {
  computeConvexHull,
  ensureCCW,
  pointToSegment,
  segmentsProperlyIntersect,
  type Point2,
} from './triangulate';

export interface MaskInput {
  width: number;
  height: number;
  /** Either single-channel alpha/luma (length = width * height) or RGBA (length = width * height * 4). */
  data: Uint8Array | Uint8ClampedArray;
  /** Explicit channel count (1 or 4). Inferred from length when omitted. */
  channels?: 1 | 4;
  /** Note: row 0 is top of image (v = 1) by standard 2D ImageData convention unless `bottomUp` is true. */
  bottomUp?: boolean;
}

/** Extract a normalized single-channel opacity buffer (0..255) where row 0 = bottom (v=0) and row H-1 = top (v=1). */
export function extractOpacityMask(input: MaskInput): { mask: Uint8Array; width: number; height: number } {
  const { width: w, height: h, data } = input;
  const ch = input.channels ?? (data.length === w * h * 4 ? 4 : 1);
  const bottomUp = input.bottomUp ?? false;
  const out = new Uint8Array(w * h);

  if (ch === 1) {
    for (let y = 0; y < h; y++) {
      const srcY = bottomUp ? y : h - 1 - y;
      const srcRow = srcY * w;
      const dstRow = y * w;
      for (let x = 0; x < w; x++) {
        out[dstRow + x] = data[srcRow + x] ?? 0;
      }
    }
    return { mask: out, width: w, height: h };
  }

  // Check if the RGBA image has meaningful alpha variation; if all alpha === 255, use luminance (for greyscale opacity maps)
  let minA = 255;
  let maxA = 0;
  const step = Math.max(1, Math.floor((w * h) / 4096));
  for (let i = 0; i < w * h; i += step) {
    const a = data[i * 4 + 3] ?? 255;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
  }
  const useAlpha = minA < 245 && maxA > 10;

  for (let y = 0; y < h; y++) {
    const srcY = bottomUp ? y : h - 1 - y;
    const srcRow = srcY * w;
    const dstRow = y * w;
    for (let x = 0; x < w; x++) {
      const idx = (srcRow + x) * 4;
      if (useAlpha) {
        out[dstRow + x] = data[idx + 3] ?? 0;
      } else {
        const r = data[idx] ?? 0;
        const g = data[idx + 1] ?? 0;
        const b = data[idx + 2] ?? 0;
        const a = (data[idx + 3] ?? 255) / 255;
        out[dstRow + x] = Math.round((0.299 * r + 0.587 * g + 0.114 * b) * a);
      }
    }
  }
  return { mask: out, width: w, height: h };
}

/** Downsample a large mask to at most `maxDim` (default 512) using max-pooling so thin stems/leaves are never lost. */
export function downsampleMaskMaxPool(
  mask: Uint8Array,
  width: number,
  height: number,
  maxDim = 512,
): { mask: Uint8Array; width: number; height: number } {
  if (width <= maxDim && height <= maxDim) return { mask, width, height };
  const scale = maxDim / Math.max(width, height);
  const nw = Math.max(8, Math.round(width * scale));
  const nh = Math.max(8, Math.round(height * scale));
  const out = new Uint8Array(nw * nh);
  for (let ny = 0; ny < nh; ny++) {
    const y0 = Math.floor((ny * height) / nh);
    const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(((ny + 1) * height) / nh)));
    for (let nx = 0; nx < nw; nx++) {
      const x0 = Math.floor((nx * width) / nw);
      const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(((nx + 1) * width) / nw)));
      let mx = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          const v = mask[row + x] ?? 0;
          if (v > mx) mx = v;
        }
      }
      out[ny * nw + nx] = mx;
    }
  }
  return { mask: out, width: nw, height: nh };
}

/** Fast separable Chamfer/Manhattan distance dilation of binary mask by `radiusPx`. */
function dilateBinaryMask(binary: Uint8Array, w: number, h: number, radiusPx: number): Uint8Array {
  if (radiusPx <= 0) return binary;
  const inf = w + h + 1000;
  const dist = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = binary[i] ? 0 : inf;

  // Forward pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let d = dist[row + x] as number;
      if (x > 0) d = Math.min(d, (dist[row + x - 1] as number) + 1);
      if (y > 0) d = Math.min(d, (dist[row - w + x] as number) + 1);
      dist[row + x] = d;
    }
  }
  // Backward pass
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    for (let x = w - 1; x >= 0; x--) {
      let d = dist[row + x] as number;
      if (x + 1 < w) d = Math.min(d, (dist[row + x + 1] as number) + 1);
      if (y + 1 < h) d = Math.min(d, (dist[row + w + x] as number) + 1);
      dist[row + x] = d;
    }
  }

  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    out[i] = (dist[i] as number) <= radiusPx ? 1 : 0;
  }
  return out;
}

/** Closed-loop Ramer-Douglas-Peucker simplification keeping at least `minVertices` and at most `maxVertices`. */
export function simplifyClosedPolygon(
  poly: readonly Point2[],
  epsilon: number,
  minVertices = 4,
  maxVertices = 36,
): Point2[] {
  if (poly.length <= minVertices) return ensureCCW(poly);

  // Find farthest pair of vertices to split the closed ring into two open chains
  let iA = 0;
  let iB = Math.floor(poly.length / 2);
  let maxDist = -1;
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const p = poly[i] as Point2;
      const q = poly[j] as Point2;
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d > maxDist) {
        maxDist = d;
        iA = i;
        iB = j;
      }
    }
  }

  const chain1: Point2[] = [];
  for (let k = iA; k <= iB; k++) chain1.push(poly[k] as Point2);
  const chain2: Point2[] = [];
  for (let k = iB; k < poly.length; k++) chain2.push(poly[k] as Point2);
  for (let k = 0; k <= iA; k++) chain2.push(poly[k] as Point2);

  const rdp = (pts: readonly Point2[], eps: number): Point2[] => {
    if (pts.length <= 2) return pts.map((p): Point2 => [p[0], p[1]]);
    const first = pts[0] as Point2;
    const last = pts[pts.length - 1] as Point2;
    let bestIdx = -1;
    let bestD = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const { dist } = pointToSegment(pts[i] as Point2, first, last);
      if (dist > bestD) {
        bestD = dist;
        bestIdx = i;
      }
    }
    if (bestD > eps && bestIdx > 0) {
      const left = rdp(pts.slice(0, bestIdx + 1), eps);
      const right = rdp(pts.slice(bestIdx), eps);
      return [...left.slice(0, -1), ...right];
    }
    return [
      [first[0], first[1]],
      [last[0], last[1]],
    ];
  };

  const s1 = rdp(chain1, epsilon);
  const s2 = rdp(chain2, epsilon);
  let merged = [...s1.slice(0, -1), ...s2.slice(0, -1)];

  // If fewer than minVertices, reduce epsilon
  if (merged.length < minVertices && poly.length >= minVertices) {
    const s1b = rdp(chain1, epsilon * 0.25);
    const s2b = rdp(chain2, epsilon * 0.25);
    merged = [...s1b.slice(0, -1), ...s2b.slice(0, -1)];
  }

  // Iteratively collapse least-significant vertex if above maxVertices
  while (merged.length > maxVertices) {
    let minArea = Infinity;
    let removeIdx = 0;
    const m = merged.length;
    for (let i = 0; i < m; i++) {
      const prev = merged[(i + m - 1) % m] as Point2;
      const curr = merged[i] as Point2;
      const next = merged[(i + 1) % m] as Point2;
      const area = Math.abs((curr[0] - prev[0]) * (next[1] - prev[1]) - (next[0] - prev[0]) * (curr[1] - prev[1]));
      if (area < minArea) {
        minArea = area;
        removeIdx = i;
      }
    }
    merged.splice(removeIdx, 1);
  }

  return ensureCCW(removeSelfIntersections(merged));
}

function removeSelfIntersections(pts: Point2[]): Point2[] {
  const out = pts.map((p): Point2 => [p[0], p[1]]);
  const n = out.length;
  if (n < 4) return out;
  for (let pass = 0; pass < 4; pass++) {
    let fixed = false;
    for (let i = 0; i < n; i++) {
      const iNext = (i + 1) % n;
      for (let j = i + 2; j < n; j++) {
        const jNext = (j + 1) % n;
        if (i === jNext) continue;
        if (segmentsProperlyIntersect(out[i] as Point2, out[iNext] as Point2, out[j] as Point2, out[jNext] as Point2)) {
          // Reverse segment [iNext..j]
          let l = iNext;
          let r = j;
          while (l < r) {
            const tmp = out[l] as Point2;
            out[l] = out[r] as Point2;
            out[r] = tmp;
            l++;
            r--;
          }
          fixed = true;
        }
      }
    }
    if (!fixed) break;
  }
  return out;
}

/**
 * Generate a tight, non-self-intersecting polygon outline around the opaque pixels of `input`.
 * Works on both single-leaf masks and multi-branch/cluster masks.
 */
export function generateCutoutOutline(
  input: MaskInput,
  settings: Partial<CutoutTessellationSettings> = {},
): Point2[] {
  const refine = Math.max(0, Math.min(1, settings.refineEdges ?? 0));
  const marginEnabled = settings.opacityMarginEnabled ?? true;
  const margin = marginEnabled ? Math.max(0, Math.min(1, settings.opacityMargin ?? 0.1)) : 0;
  const mode = settings.tessellation ?? 'Triangular';
  const angleDeg = settings.angle ?? 0;

  const extracted = extractOpacityMask(input);
  const { mask, width: w, height: h } = downsampleMaskMaxPool(extracted.mask, extracted.width, extracted.height, 512);

  const binary = new Uint8Array(w * h);
  let opaqueCount = 0;
  for (let i = 0; i < w * h; i++) {
    if ((mask[i] ?? 0) > 20) {
      binary[i] = 1;
      opaqueCount++;
    }
  }

  // Fallback to default quad if mask is completely empty
  if (opaqueCount === 0) {
    return [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ];
  }

  // Dilate binary mask by margin (plus small minimum 1px padding so vertices wrap outside the pixels)
  const radiusPx = Math.max(1, Math.round((0.012 + margin * 0.085) * Math.max(w, h)));
  const dilated = dilateBinaryMask(binary, w, h, radiusPx);

  // Collect boundary points of the dilated mask
  const boundaryPoints: Point2[] = [];
  let sumU = 0;
  let sumV = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!dilated[row + x]) continue;
      const isEdge =
        x === 0 ||
        x === w - 1 ||
        y === 0 ||
        y === h - 1 ||
        !dilated[row + x - 1] ||
        !dilated[row + x + 1] ||
        !dilated[row - w + x] ||
        !dilated[row + w + x];
      if (isEdge) {
        const u = Math.max(0, Math.min(1, (x + 0.5) / w));
        const v = Math.max(0, Math.min(1, (y + 0.5) / h));
        boundaryPoints.push([u, v]);
        sumU += u;
        sumV += v;
      }
    }
  }

  if (boundaryPoints.length < 3) {
    return [
      [0.05, 0.05],
      [0.95, 0.05],
      [0.95, 0.95],
      [0.05, 0.95],
    ];
  }

  const hull = computeConvexHull(boundaryPoints);
  if (mode === 'Convex Hull') {
    const eps = Math.max(0.004, 0.06 * (1 - refine * 0.85));
    const maxV = Math.round(6 + refine * 18);
    return rotateOutlineIfNeeded(simplifyClosedPolygon(hull, eps, 4, maxV), angleDeg);
  }

  // Angular radial envelope + concavity-aware silhouette around centroid:
  // Divides into angular sectors around the centroid, picking the outermost boundary point in each sector
  // so concave indentations between lobes are captured cleanly while guaranteeing a simple polygon.
  const cx = sumU / boundaryPoints.length;
  const cy = sumV / boundaryPoints.length;
  const numBins = Math.round(36 + refine * 72);
  const binMaxR = new Float64Array(numBins).fill(-1);
  const binPt: (Point2 | null)[] = new Array<Point2 | null>(numBins).fill(null);

  for (const pt of boundaryPoints) {
    const dx = pt[0] - cx;
    const dy = pt[1] - cy;
    const r = Math.hypot(dx, dy);
    let ang = Math.atan2(dy, dx);
    if (ang < 0) ang += Math.PI * 2;
    const bin = Math.min(numBins - 1, Math.floor((ang / (Math.PI * 2)) * numBins));
    if (r > (binMaxR[bin] as number)) {
      binMaxR[bin] = r;
      binPt[bin] = pt;
    }
  }

  const radialRing: Point2[] = [];
  for (let b = 0; b < numBins; b++) {
    const p = binPt[b];
    if (p) radialRing.push(p);
  }

  const sourcePoly = radialRing.length >= 4 ? radialRing : hull;
  const eps = Math.max(0.005, 0.068 * Math.pow(1 - refine * 0.88, 1.4));
  const minV = refine > 0.15 ? 6 : 5;
  const maxV = Math.round(7 + refine * 29);
  const simplified = simplifyClosedPolygon(sourcePoly, eps, minV, maxV);
  return rotateOutlineIfNeeded(simplified, angleDeg);
}

function rotateOutlineIfNeeded(pts: Point2[], angleDeg: number): Point2[] {
  if (Math.abs(angleDeg) < 1e-4) return pts;
  const rad = (angleDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return pts.map(([u, v]): Point2 => {
    const du = u - 0.5;
    const dv = v - 0.5;
    return [
      Math.max(0, Math.min(1, 0.5 + du * c - dv * s)),
      Math.max(0, Math.min(1, 0.5 + du * s + dv * c)),
    ];
  });
}

/**
 * Generates a deterministic procedural oak branch/leaf cluster RGBA + opacity + height texture (width x height)
 * used as fallback in Edit Mesh when a material does not yet have an imported bitmap.
 */
export function generateProceduralBotanicalTexture(
  width = 256,
  height = 256,
  seed = 7,
): { colorRgba: Uint8ClampedArray; opacityRgba: Uint8ClampedArray; heightRgba: Uint8ClampedArray; alphaMask: Uint8Array } {
  const colorRgba = new Uint8ClampedArray(width * height * 4);
  const opacityRgba = new Uint8ClampedArray(width * height * 4);
  const heightRgba = new Uint8ClampedArray(width * height * 4);
  const alphaMask = new Uint8Array(width * height);

  const setPixel = (x: number, y: number, r: number, g: number, b: number, hVal: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const idx = y * width + x;
    const p = idx * 4;
    colorRgba[p] = r;
    colorRgba[p + 1] = g;
    colorRgba[p + 2] = b;
    colorRgba[p + 3] = 255;
    opacityRgba[p] = 255;
    opacityRgba[p + 1] = 255;
    opacityRgba[p + 2] = 255;
    opacityRgba[p + 3] = 255;
    heightRgba[p] = hVal;
    heightRgba[p + 1] = hVal;
    heightRgba[p + 2] = hVal;
    heightRgba[p + 3] = 255;
    // alphaMask is stored top-down (row 0 = top) to match ImageData
    alphaMask[idx] = 255;
  };

  // Initialize opaque black background for opacityRgba & heightRgba
  for (let i = 0; i < width * height; i++) {
    opacityRgba[i * 4 + 3] = 255;
    heightRgba[i * 4 + 3] = 255;
  }

  const rng = new Rng(seed);

  // Draw main central stem from bottom (y = height-1) to top (y = height * 0.06)
  for (let y = Math.floor(height * 0.06); y < height; y++) {
    const t = y / height;
    const cx = Math.round(width * (0.48 + Math.sin(t * Math.PI * 1.6) * 0.02));
    const halfW = Math.max(1, Math.round((1 + t * 2.5) * (width / 256)));
    for (let dx = -halfW; dx <= halfW; dx++) {
      setPixel(cx + dx, y, 108, 92, 68, 195);
    }
  }

  // Draw side twigs and oak leaf clusters
  const leafCount = 38;
  for (let i = 0; i < leafCount; i++) {
    const ty = 0.1 + rng.next() * 0.78;
    const side = i % 2 === 0 ? 1 : -1;
    const reach = rng.range(0.06, 0.38) * (0.4 + (1 - Math.abs(ty - 0.48)) * 0.75);
    const lx = width * (0.48 + side * reach);
    const ly = height * ty;
    const rx = rng.range(0.04, 0.075) * width;
    const ry = rng.range(0.025, 0.048) * height;
    const angle = rng.range(0, Math.PI);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const rCol = Math.round(rng.range(72, 118));
    const gCol = Math.round(rng.range(125, 175));
    const bCol = Math.round(rng.range(32, 65));

    // Twig line from stem to leaf center
    const stemX = width * 0.48;
    const stemY = Math.min(height - 4, ly + Math.abs(lx - stemX) * 0.45);
    const steps = Math.max(8, Math.round(Math.hypot(lx - stemX, ly - stemY)));
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const tx = Math.round(stemX + (lx - stemX) * u);
      const tyPx = Math.round(stemY + (ly - stemY) * u);
      setPixel(tx, tyPx, 102, 86, 62, 160);
    }

    // Lobed oak leaf ellipse
    const radBound = Math.ceil(Math.max(rx, ry) * 1.25);
    for (let dy = -radBound; dy <= radBound; dy++) {
      for (let dx = -radBound; dx <= radBound; dx++) {
        const u = (dx * cosA + dy * sinA) / rx;
        const v = (-dx * sinA + dy * cosA) / ry;
        const theta = Math.atan2(v, u);
        const lobe = 1 + 0.18 * Math.cos(theta * 6);
        const d2 = u * u + v * v;
        if (d2 <= lobe * lobe) {
          const shade = 0.85 + 0.25 * (1 - Math.sqrt(d2) / lobe);
          const hVal = Math.min(255, Math.max(40, Math.round(130 + (1 - Math.sqrt(d2)) * 110)));
          setPixel(
            Math.round(lx + dx),
            Math.round(ly + dy),
            Math.min(255, Math.round(rCol * shade)),
            Math.min(255, Math.round(gCol * shade)),
            Math.min(255, Math.round(bCol * shade)),
            hVal,
          );
        }
      }
    }
  }

  return { colorRgba, opacityRgba, heightRgba, alphaMask };
}
