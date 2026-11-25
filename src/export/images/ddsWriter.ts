import type { RGBAImage } from './imageOps';

const DDSD_CAPS = 0x1;
const DDSD_HEIGHT = 0x2;
const DDSD_WIDTH = 0x4;
const DDSD_PITCH = 0x8;
const DDSD_PIXELFORMAT = 0x1000;
const DDSD_MIPMAPCOUNT = 0x20000;
const DDPF_ALPHAPIXELS = 0x1;
const DDPF_RGB = 0x40;
const DDSCAPS_COMPLEX = 0x8;
const DDSCAPS_TEXTURE = 0x1000;
const DDSCAPS_MIPMAP = 0x400000;

/**
 * Uncompressed 32-bit RGBA DDS (legacy header, byte order R G B A) holding a whole mip chain. Level 0 first; every level must be the
 * previous one halved (rounded down, minimum 1) as produced by `buildMips`. Engines import it directly and keep the chain as authored,
 * which is how the packer's AlphaIsOpacity / RgbIsNormal mip flags reach the game.
 */
export function encodeDds(mips: readonly RGBAImage[]): Uint8Array {
  const first = mips[0];
  if (!first) throw new Error('encodeDds: empty mip chain');
  let payload = 0;
  for (const m of mips) payload += m.width * m.height * 4;
  const out = new Uint8Array(128 + payload);
  const view = new DataView(out.buffer);
  const u32 = (offset: number, value: number): void => view.setUint32(offset, value >>> 0, true);
  u32(0, 0x20534444); // 'DDS '
  u32(4, 124);
  u32(8, DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PITCH | DDSD_PIXELFORMAT | (mips.length > 1 ? DDSD_MIPMAPCOUNT : 0));
  u32(12, first.height);
  u32(16, first.width);
  u32(20, first.width * 4);
  u32(28, mips.length);
  u32(76, 32); // DDS_PIXELFORMAT size
  u32(80, DDPF_RGB | DDPF_ALPHAPIXELS);
  u32(88, 32);
  u32(92, 0x000000ff);
  u32(96, 0x0000ff00);
  u32(100, 0x00ff0000);
  u32(104, 0xff000000);
  u32(108, DDSCAPS_TEXTURE | (mips.length > 1 ? DDSCAPS_COMPLEX | DDSCAPS_MIPMAP : 0));
  let offset = 128;
  for (const m of mips) {
    out.set(m.data, offset);
    offset += m.width * m.height * 4;
  }
  return out;
}
