import type { RGBAImage } from '@/export/images/imageOps';

/**
 * Mip chain of a tangent-space normal map. Every level averages the DECODED vectors of the 2x2 parent texels and
 * renormalises them (a plain box filter of the encoded RGB would shorten the vectors and flatten the relief);
 * alpha (height in the bark sets) is box filtered. Level 0 is the input; the chain ends at 1x1.
 */
export function buildNormalMips(base: RGBAImage): RGBAImage[] {
  const chain: RGBAImage[] = [base];
  let cur = base;
  while (cur.width > 1 || cur.height > 1) {
    const w = Math.max(1, cur.width >> 1);
    const h = Math.max(1, cur.height >> 1);
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const y0 = Math.min(cur.height - 1, y * 2);
      const y1 = Math.min(cur.height - 1, y * 2 + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.min(cur.width - 1, x * 2);
        const x1 = Math.min(cur.width - 1, x * 2 + 1);
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let sa = 0;
        for (let k = 0; k < 4; k++) {
          const i = ((k < 2 ? y0 : y1) * cur.width + (k % 2 === 0 ? x0 : x1)) * 4;
          sx += ((cur.data[i] as number) / 255) * 2 - 1;
          sy += ((cur.data[i + 1] as number) / 255) * 2 - 1;
          sz += ((cur.data[i + 2] as number) / 255) * 2 - 1;
          sa += cur.data[i + 3] as number;
        }
        let len = Math.hypot(sx, sy, sz);
        if (len < 1e-6) {
          sx = 0;
          sy = 0;
          sz = 1;
          len = 1;
        }
        const o = (y * w + x) * 4;
        out[o] = (sx / len) * 127.5 + 127.5;
        out[o + 1] = (sy / len) * 127.5 + 127.5;
        out[o + 2] = (sz / len) * 127.5 + 127.5;
        out[o + 3] = sa / 4;
      }
    }
    cur = { width: w, height: h, data: out };
    chain.push(cur);
  }
  return chain;
}

/** Row-flipped copy (images are stored top row first, GL textures with flipY = false bottom row first). */
export function flipRows(img: RGBAImage): RGBAImage {
  const out = new Uint8ClampedArray(img.data.length);
  const stride = img.width * 4;
  for (let y = 0; y < img.height; y++) out.set(img.data.subarray((img.height - 1 - y) * stride, (img.height - y) * stride), y * stride);
  return { width: img.width, height: img.height, data: out };
}
