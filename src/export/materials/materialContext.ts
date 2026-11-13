import type { MaterialDef } from '@/contracts/material';
import { getMaterialLibrary } from '@/materials/library';
import { getShadingSettings } from '@/materials/shadingSettings';
import { getTextureManager } from '@/textures/textureManager';
import type { RGBAImage } from '../images/imageOps';
import { encodePng } from '../images/imageOps';
import type { ImageFormat } from '../types';
import type { MaterialExportContext } from './materialExport';

/** Browser implementation of `MaterialExportContext`: library lookups, `createImageBitmap` decode, canvas encode. */

function canvas2d(width: number, height: number): { ctx: CanvasRenderingContext2D; el: HTMLCanvasElement } {
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  const ctx = el.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas is not available.');
  return { ctx, el };
}

export async function decodeAssetPixels(assetId: string): Promise<RGBAImage | null> {
  const tm = getTextureManager();
  const bytes = tm.bytesOf(assetId);
  const asset = tm.find(assetId);
  if (!bytes || !asset || typeof createImageBitmap !== 'function') return null;
  try {
    const bmp = await createImageBitmap(new Blob([bytes as unknown as ArrayBuffer], { type: asset.mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const { ctx } = canvas2d(bmp.width, bmp.height);
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return { width: data.width, height: data.height, data: data.data };
  } catch {
    return null;
  }
}

/** Encode through a canvas (JPG / WebP) or the lossless-alpha PNG writer. */
export async function encodeImage(img: RGBAImage, format: ImageFormat, quality: number): Promise<{ data: Uint8Array; mime: 'image/png' | 'image/jpeg' | 'image/webp'; ext: string }> {
  if (format !== 'png' && typeof document !== 'undefined') {
    const mime = format === 'jpg' ? 'image/jpeg' : 'image/webp';
    const { ctx, el } = canvas2d(img.width, img.height);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => el.toBlob(resolve, mime, quality));
    if (blob && blob.type === mime) return { data: new Uint8Array(await blob.arrayBuffer()), mime, ext: format === 'jpg' ? 'jpg' : 'webp' };
  }
  return { data: encodePng(img), mime: 'image/png', ext: 'png' };
}

export function createBrowserMaterialContext(): MaterialExportContext {
  const lib = getMaterialLibrary();
  return {
    material: (id: string): MaterialDef | undefined => lib.material(id) ?? lib.materials().find((m) => m.name === id),
    loadImage: decodeAssetPixels,
    encode: encodeImage,
    alphaThreshold: getShadingSettings().alphaThreshold,
  };
}
