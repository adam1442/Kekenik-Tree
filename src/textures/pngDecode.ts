import { unzlibSync } from 'fflate';
import type { RGBAImage } from '@/export/images/imageOps';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const be32 = (b: Uint8Array, o: number): number => (((b[o] as number) << 24) | ((b[o + 1] as number) << 16) | ((b[o + 2] as number) << 8) | (b[o + 3] as number)) >>> 0;

/**
 * Minimal synchronous PNG decoder (8-bit grey / grey+alpha / RGB / RGBA, not interlaced) returning straight-alpha RGBA.
 * Used for data maps (normal maps) that must keep exact RGB under a low alpha, which a canvas round trip would destroy.
 * Returns null for anything it does not understand (callers fall back to the browser decoder).
 */
export function decodePng(bytes: Uint8Array): RGBAImage | null {
  if (bytes.length < 33) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return null;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = be32(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4] as number, bytes[pos + 5] as number, bytes[pos + 6] as number, bytes[pos + 7] as number);
    const start = pos + 8;
    if (start + len > bytes.length) return null;
    if (type === 'IHDR') {
      width = be32(bytes, start);
      height = be32(bytes, start + 4);
      const depth = bytes[start + 8] as number;
      colorType = bytes[start + 9] as number;
      const interlace = bytes[start + 12] as number;
      if (depth !== 8 || interlace !== 0) return null;
    } else if (type === 'IDAT') idat.push(bytes.subarray(start, start + len));
    else if (type === 'IEND') break;
    pos = start + len + 4;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0 || width < 1 || height < 1 || width * height > 16_777_216) return null;
  let total = 0;
  for (const c of idat) total += c.length;
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(joined);
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? (px[dst + x - channels] as number) : 0;
      const up = y > 0 ? (px[dst - stride + x] as number) : 0;
      const upLeft = y > 0 && x >= channels ? (px[dst - stride + x - channels] as number) : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) return null;
      px[dst + x] = ((raw[src + x] as number) + add) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1) {
      data[d] = data[d + 1] = data[d + 2] = px[s] as number;
      data[d + 3] = 255;
    } else if (channels === 2) {
      data[d] = data[d + 1] = data[d + 2] = px[s] as number;
      data[d + 3] = px[s + 1] as number;
    } else {
      data[d] = px[s] as number;
      data[d + 1] = px[s + 1] as number;
      data[d + 2] = px[s + 2] as number;
      data[d + 3] = channels === 4 ? (px[s + 3] as number) : 255;
    }
  }
  return { width, height, data };
}
