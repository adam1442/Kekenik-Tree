import { zlibSync } from 'fflate';

/** Pure pixel operations on straight-alpha RGBA8 images (the browser-only decode / encode lives in `imageIO.ts`). */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number, fill: readonly [number, number, number, number] = [0, 0, 0, 0]): RGBAImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, data };
}

/** 2x2 box filter, colour weighted by alpha so transparent texels do not darken the edges. */
function halve(src: RGBAImage): RGBAImage {
  const w = Math.max(1, src.width >> 1);
  const h = Math.max(1, src.height >> 1);
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let pr = 0;
      let pg = 0;
      let pb = 0;
      for (let k = 0; k < 4; k++) {
        const sx = Math.min(src.width - 1, x * 2 + (k & 1));
        const sy = Math.min(src.height - 1, y * 2 + (k >> 1));
        const i = (sy * src.width + sx) * 4;
        const al = src.data[i + 3] as number;
        r += (src.data[i] as number) * al;
        g += (src.data[i + 1] as number) * al;
        b += (src.data[i + 2] as number) * al;
        pr += src.data[i] as number;
        pg += src.data[i + 1] as number;
        pb += src.data[i + 2] as number;
        a += al;
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = r / a;
        out.data[o + 1] = g / a;
        out.data[o + 2] = b / a;
      } else {
        out.data[o] = pr / 4;
        out.data[o + 1] = pg / 4;
        out.data[o + 2] = pb / 4;
      }
      out.data[o + 3] = a / 4;
    }
  }
  return out;
}

function bilinear(src: RGBAImage, w: number, h: number): RGBAImage {
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(src.height - 1, Math.max(0, ((y + 0.5) * src.height) / h - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(src.width - 1, Math.max(0, ((x + 0.5) * src.width) / w - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src.data[(y0 * src.width + x0) * 4 + c] as number;
        const b = src.data[(y0 * src.width + x1) * 4 + c] as number;
        const d = src.data[(y1 * src.width + x0) * 4 + c] as number;
        const e = src.data[(y1 * src.width + x1) * 4 + c] as number;
        out.data[(y * w + x) * 4 + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
      }
    }
  }
  return out;
}

/** Resize with a box pre-filter for large reductions followed by a bilinear tap. Returns `src` when the size matches. */
export function resizeImage(src: RGBAImage, w: number, h: number): RGBAImage {
  if (src.width === w && src.height === h) return src;
  let cur = src;
  while (cur.width >= w * 2 && cur.height >= h * 2) cur = halve(cur);
  return bilinear(cur, w, h);
}

/** Largest size that fits `maxEdge` (0 = unlimited) while keeping the aspect ratio. Never upsamples. */
export function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (maxEdge <= 0 || Math.max(width, height) <= maxEdge) return { width, height };
  const s = maxEdge / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export type MaskChannel = 'r' | 'g' | 'b' | 'a';
const CH: Record<MaskChannel, number> = { r: 0, g: 1, b: 2, a: 3 };

/** Colour map + opacity mask -> RGBA whose alpha is the mask (glTF has no separate opacity map). */
export function mergeOpacity(color: RGBAImage | null, mask: RGBAImage, channel: MaskChannel, fill: readonly [number, number, number] = [255, 255, 255]): RGBAImage {
  const w = color ? color.width : mask.width;
  const h = color ? color.height : mask.height;
  const m = resizeImage(mask, w, h);
  const out = createImage(w, h);
  const c = CH[channel];
  for (let i = 0; i < w * h; i++) {
    out.data[i * 4] = color ? (color.data[i * 4] as number) : fill[0];
    out.data[i * 4 + 1] = color ? (color.data[i * 4 + 1] as number) : fill[1];
    out.data[i * 4 + 2] = color ? (color.data[i * 4 + 2] as number) : fill[2];
    out.data[i * 4 + 3] = m.data[i * 4 + c] as number;
  }
  return out;
}

export interface OrmInput {
  ao: RGBAImage | null;
  gloss: RGBAImage | null;
  metallic: RGBAImage | null;
  /** Constants used when a map is missing (and multipliers when it exists). */
  aoScalar: number;
  glossScalar: number;
  metallicScalar: number;
}

/**
 * Channel packing for glTF: R = occlusion, G = roughness (= 1 - gloss), B = metalness. The result is a valid
 * `occlusionTexture` AND `metallicRoughnessTexture` (glTF allows both to reference the same image).
 */
export function packOrm(input: OrmInput): RGBAImage | null {
  const maps = [input.ao, input.gloss, input.metallic].filter((m): m is RGBAImage => m !== null);
  if (maps.length === 0) return null;
  const w = Math.max(...maps.map((m) => m.width));
  const h = Math.max(...maps.map((m) => m.height));
  const ao = input.ao ? resizeImage(input.ao, w, h) : null;
  const gloss = input.gloss ? resizeImage(input.gloss, w, h) : null;
  const metal = input.metallic ? resizeImage(input.metallic, w, h) : null;
  const out = createImage(w, h, [255, 255, 255, 255]);
  for (let i = 0; i < w * h; i++) {
    out.data[i * 4] = ao ? (ao.data[i * 4] as number) : 255;
    const g = gloss ? ((gloss.data[i * 4] as number) / 255) * input.glossScalar : input.glossScalar;
    out.data[i * 4 + 1] = (1 - Math.min(1, Math.max(0, g))) * 255;
    const m = metal ? ((metal.data[i * 4] as number) / 255) * input.metallicScalar : input.metallicScalar;
    out.data[i * 4 + 2] = Math.min(1, Math.max(0, m)) * 255;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Copy colour into fully transparent texels from the nearest opaque neighbours (`passes` px), keeping alpha. */
export function dilateColor(img: RGBAImage, passes: number, alphaThreshold = 1): RGBAImage {
  if (passes <= 0) return img;
  const { width: w, height: h } = img;
  let cur = new Uint8ClampedArray(img.data);
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = (cur[i * 4 + 3] as number) >= alphaThreshold ? 1 : 0;
  for (let p = 0; p < passes; p++) {
    const next = new Uint8ClampedArray(cur);
    const nextFilled = new Uint8Array(filled);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const j = ny * w + nx;
            if (!filled[j]) continue;
            r += cur[j * 4] as number;
            g += cur[j * 4 + 1] as number;
            b += cur[j * 4 + 2] as number;
            n++;
          }
        }
        if (n > 0) {
          next[i * 4] = r / n;
          next[i * 4 + 1] = g / n;
          next[i * 4 + 2] = b / n;
          nextFilled[i] = 1;
        }
      }
    }
    cur = next;
    filled.set(nextFilled);
  }
  return { width: w, height: h, data: cur };
}

/** Re-map an encoded object-space normal image (rgb = n*0.5+0.5) through a 3x3 matrix (axis conversion). */
export function transformNormalImage(img: RGBAImage, m: readonly number[]): void {
  for (let i = 0; i < img.width * img.height; i++) {
    if ((img.data[i * 4 + 3] as number) === 0) continue;
    const x = ((img.data[i * 4] as number) / 255) * 2 - 1;
    const y = ((img.data[i * 4 + 1] as number) / 255) * 2 - 1;
    const z = ((img.data[i * 4 + 2] as number) / 255) * 2 - 1;
    const nx = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z;
    const ny = (m[3] as number) * x + (m[4] as number) * y + (m[5] as number) * z;
    const nz = (m[6] as number) * x + (m[7] as number) * y + (m[8] as number) * z;
    img.data[i * 4] = (nx * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = (nz * 0.5 + 0.5) * 255;
  }
}

export function hasTransparency(img: RGBAImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if ((img.data[i] as number) < 250) return true;
  return false;
}

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ (data[i] as number)) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n: number): Uint8Array => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(u32(crc32(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}

/** Minimal PNG encoder (8-bit RGBA, filter 0). Keeps the colour of fully transparent texels, which canvas encoders drop. */
export function encodePng(img: RGBAImage): Uint8Array {
  const { width: w, height: h } = img;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(img.data.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(w), 0);
  ihdr.set(u32(h), 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 6 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
