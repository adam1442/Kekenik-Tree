import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, RepeatWrapping, SRGBColorSpace, Texture, UnsignedByteType } from 'three';
import type { TextureSlot } from '@/contracts/material';
import type { AssetEntry } from '@/contracts/project';
import { uid } from '@/core/id';
import { registerDisplacementSource } from '@/materials/displacement';
import { slotColorSpace } from '@/materials/shadingMath';
import { bleedColorUnderAlpha, detectOpacityChannel, extractOpacityChannel, quantizeCutoff, type CoverageChannel } from './alphaCoverage';
import { base64ToBytes, bytesToBase64, hashBytes, sniffImageMime } from './bytes';
import { COVERAGE_MAX_EDGE, computeCoverageMips } from './coverageService';

export interface DecodedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** True when at least one pixel is not fully opaque (checked on a 64x64 downsample). */
  hasAlpha: boolean;
}

export interface ImageInfo {
  name: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  hasAlpha: boolean;
}

/** Request for alpha-coverage preserving mips (see `alphaCoverage.ts`). */
export interface CoverageSpec {
  channel: CoverageChannel;
  /** Alpha-test threshold the coverage is preserved for. */
  cutoff: number;
}

interface PoolEntry {
  tex: Texture;
  refs: number;
  bytes: number;
}

const POOL_KEY = 'ktPoolKey';
const OPACITY_SUFFIX = '|opa';

/** Longest edge of the low-resolution proxy used while the user is interacting. */
export const PROXY_RESOLUTION = 256;

/**
 * Project texture storage. Imported image files become `AssetEntry`s (content-hash deduped, base64 in memory, raw bytes
 * in the saved `.ktree` container); decoding is async (`createImageBitmap`); GPU textures are pooled and ref-counted
 * per (asset, colour space, resolution).
 */
export class TextureManager {
  private getAssets: () => AssetEntry[] = () => [];
  private readonly bytesCache = new Map<string, Uint8Array>();
  private readonly decoding = new Map<string, Promise<DecodedImage | null>>();
  private readonly ready = new Map<string, DecodedImage>();
  private readonly pool = new Map<string, PoolEntry>();
  private readonly listeners = new Set<() => void>();
  private anisotropy = 8;
  private proxy = false;
  private coverageOn = true;
  private readonly coverageBusy = new Map<string, CoverageSpec | null>();

  /** Point the manager at the active document's `assets` array (re-bound on every document switch / load). */
  bind(getAssets: () => AssetEntry[]): void {
    this.getAssets = getAssets;
    this.bytesCache.clear();
  }

  setAnisotropy(n: number): void {
    const next = Math.max(1, Math.round(n));
    if (next === this.anisotropy) return;
    this.anisotropy = next;
    for (const e of this.pool.values()) {
      e.tex.anisotropy = next;
      e.tex.needsUpdate = true;
    }
    this.emit();
  }

  /** Enable / disable coverage-preserving mips (listeners are notified so materials re-acquire their textures). */
  setCoverageEnabled(on: boolean): void {
    if (this.coverageOn === on) return;
    this.coverageOn = on;
    this.emit();
  }

  /** While true, `acquire` returns <= 256 px proxies (listeners are notified when the flag flips). */
  setInteractionProxy(on: boolean): void {
    if (this.proxy === on) return;
    this.proxy = on;
    this.emit();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  find(assetId: string): AssetEntry | undefined {
    return this.getAssets().find((a) => a.id === assetId);
  }

  bytesOf(assetId: string): Uint8Array | null {
    const cached = this.bytesCache.get(assetId);
    if (cached) return cached;
    const a = this.find(assetId);
    if (!a?.data) return null;
    const b = base64ToBytes(a.data);
    this.bytesCache.set(assetId, b);
    return b;
  }

  /** Import encoded image bytes; identical content returns the existing asset (dedupe by hash). */
  async importBytes(bytes: Uint8Array, name: string, mime = ''): Promise<AssetEntry> {
    const hash = await hashBytes(bytes);
    const assets = this.getAssets();
    const hit = assets.find((a) => a.kind === 'image' && a.hash === hash);
    if (hit) return hit;
    const entry: AssetEntry = { id: uid('img'), kind: 'image', name, mime: mime || sniffImageMime(bytes), data: bytesToBase64(bytes), hash };
    assets.push(entry);
    this.bytesCache.set(entry.id, bytes);
    return entry;
  }

  async importFile(file: Blob & { name?: string }): Promise<AssetEntry> {
    return this.importBytes(new Uint8Array(await file.arrayBuffer()), file.name ?? 'image', file.type);
  }

  /** Replace the bytes of an existing asset in place (Reload from a file). */
  async replaceBytes(assetId: string, bytes: Uint8Array, name: string): Promise<void> {
    const a = this.find(assetId);
    if (!a) return;
    a.data = bytesToBase64(bytes);
    a.hash = await hashBytes(bytes);
    a.name = name;
    a.mime = sniffImageMime(bytes);
    this.bytesCache.set(assetId, bytes);
    this.invalidate(assetId);
  }

  /** Drop decoded + GPU data of an asset (after its bytes changed). */
  invalidate(assetId: string): void {
    for (const key of [...this.ready.keys()]) if (key.startsWith(`${assetId}@`)) this.ready.delete(key);
    for (const key of [...this.decoding.keys()]) if (key.startsWith(`${assetId}@`)) this.decoding.delete(key);
    for (const [key, entry] of this.pool) {
      if (key.startsWith(`${assetId}|`)) {
        entry.tex.dispose();
        this.pool.delete(key);
      }
    }
    this.emit();
  }

  private decode(assetId: string, res: number): Promise<DecodedImage | null> {
    const key = `${assetId}@${res}`;
    const running = this.decoding.get(key);
    if (running) return running;
    const bytes = this.bytesOf(assetId);
    const asset = this.find(assetId);
    if (!bytes || !asset || typeof createImageBitmap !== 'function') return Promise.resolve(null);
    const p = (async (): Promise<DecodedImage | null> => {
      try {
        const blob = new Blob([bytes as unknown as ArrayBuffer], { type: asset.mime });
        const probe = await createImageBitmap(blob);
        const { width: w, height: h } = probe;
        const scale = res > 0 && Math.max(w, h) > res ? res / Math.max(w, h) : 1;
        const opts: ImageBitmapOptions = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
        if (scale < 1) {
          opts.resizeWidth = Math.max(1, Math.round(w * scale));
          opts.resizeHeight = Math.max(1, Math.round(h * scale));
          opts.resizeQuality = 'high';
        }
        const bitmap = await createImageBitmap(blob, opts);
        probe.close();
        const out: DecodedImage = { bitmap, width: bitmap.width, height: bitmap.height, hasAlpha: detectAlpha(bitmap) };
        this.ready.set(key, out);
        this.emit();
        return out;
      } catch {
        this.decoding.delete(key);
        return null;
      }
    })();
    this.decoding.set(key, p);
    return p;
  }

  /** Full decode (async) - used by thumbnails / info; resolves null for undecodable data. */
  decoded(assetId: string, res = 0): Promise<DecodedImage | null> {
    return this.decode(assetId, res);
  }

  /** Metadata for "Reveal info" (size / format / bytes). Async because the dimensions need a decode. */
  async info(assetId: string): Promise<ImageInfo | null> {
    const a = this.find(assetId);
    const bytes = this.bytesOf(assetId);
    if (!a || !bytes) return null;
    const d = await this.decode(assetId, 0);
    return { name: a.name, mime: a.mime, bytes: bytes.length, width: d?.width ?? 0, height: d?.height ?? 0, hasAlpha: d?.hasAlpha ?? false };
  }

  /** Whether the (already decoded) image carries transparency; undefined while not decoded. */
  hasAlpha(assetId: string): boolean | undefined {
    for (const [k, v] of this.ready) if (k.startsWith(`${assetId}@`)) return v.hasAlpha;
    return undefined;
  }

  /** RGBA pixels (un-flipped, <= maxDim) for CPU consumers such as displacement. Registers the displacement source. */
  async loadPixels(assetId: string, maxDim = 1024): Promise<boolean> {
    const bytes = this.bytesOf(assetId);
    const a = this.find(assetId);
    if (!bytes || !a || typeof createImageBitmap !== 'function' || typeof document === 'undefined') return false;
    try {
      const bmp = await createImageBitmap(new Blob([bytes as unknown as ArrayBuffer], { type: a.mime }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const s = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * s));
      const h = Math.max(1, Math.round(bmp.height * s));
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (!g) return false;
      g.drawImage(bmp, 0, 0, w, h);
      bmp.close();
      registerDisplacementSource(assetId, { width: w, height: h, rgba: g.getImageData(0, 0, w, h).data });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pooled GPU texture for a slot (ref-counted: pair every successful call with `release`). Returns null while the
   * image is still decoding - listeners fire when it becomes available.
   *
   * With `coverage` the returned texture has alpha-coverage preserving mips once they are computed (asynchronously;
   * the plain texture is returned meanwhile and listeners fire when the better one is ready). Such textures are
   * remapped so the cutoff is 0.5: check `isCoverageTexture` and use `alphaTest = 0.5` for them.
   */
  acquire(assetId: string, slot: TextureSlot, maxRes: number | null, coverage?: CoverageSpec | null): Texture | null {
    const res = this.proxy ? Math.min(PROXY_RESOLUTION, maxRes ?? PROXY_RESOLUTION) : maxRes ?? 0;
    const space = slotColorSpace(slot);
    // The Opacity slot is decoded as linear single-channel data (mask channel auto-detected), so it has its own pool entry.
    const key = `${assetId}|${space}|${res}${slot === 'opacity' ? OPACITY_SUFFIX : ''}`;
    if (coverage && this.coverageOn) {
      const ckey = `${key}|cov:${coverage.channel}:${quantizeCutoff(coverage.cutoff).toFixed(2)}`;
      const covHit = this.pool.get(ckey);
      if (covHit) {
        covHit.refs++;
        return covHit.tex;
      }
      this.requestCoverage(assetId, res, space === 'srgb', key, coverage);
    }
    const hit = this.pool.get(key);
    if (hit) {
      hit.refs++;
      return hit.tex;
    }
    const img = this.ready.get(`${assetId}@${res}`);
    if (!img) {
      void this.decode(assetId, res);
      return null;
    }
    const tex = slot === 'opacity' ? this.opacityTexture(img) : new Texture(img.bitmap);
    tex.userData[POOL_KEY] = key;
    tex.colorSpace = space === 'srgb' ? SRGBColorSpace : NoColorSpace;
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.magFilter = LinearFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = this.anisotropy;
    tex.flipY = false; // the bitmap was created flipped
    tex.premultiplyAlpha = false;
    tex.needsUpdate = true;
    this.pool.set(key, { tex, refs: 1, bytes: Math.round(img.width * img.height * 4 * 1.33) });
    return tex;
  }

  /** Opacity image as a clean linear mask (mask channel copied to R = G = B = value, alpha 1) so `alphaMap` (green) is right. */
  private opacityTexture(img: DecodedImage): Texture {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (g) {
        g.drawImage(img.bitmap, 0, 0);
        const raw = g.getImageData(0, 0, img.width, img.height);
        extractOpacityChannel(raw.data, detectOpacityChannel(raw.data));
        g.putImageData(raw, 0, 0);
        return new Texture(c);
      }
    }
    return new Texture(img.bitmap);
  }

  /** True for textures built by the coverage pass (their cutoff has been remapped to 0.5). */
  isCoverageTexture(tex: Texture | null): boolean {
    return tex?.userData.ktCoverage === true;
  }

  /** Start (or queue, newest request wins) the asynchronous coverage-mip build for one (image, cutoff). */
  private requestCoverage(assetId: string, res: number, srgb: boolean, key: string, spec: CoverageSpec): void {
    const img = this.ready.get(`${assetId}@${res}`);
    if (!img || Math.max(img.width, img.height) > COVERAGE_MAX_EDGE || typeof document === 'undefined') return;
    const busyKey = `${key}|${spec.channel}`;
    if (this.coverageBusy.has(busyKey)) {
      this.coverageBusy.set(busyKey, spec);
      return;
    }
    this.coverageBusy.set(busyKey, null);
    void this.buildCoverage(assetId, img, srgb, key, spec).finally(() => {
      const next = this.coverageBusy.get(busyKey);
      this.coverageBusy.delete(busyKey);
      if (next && quantizeCutoff(next.cutoff) !== quantizeCutoff(spec.cutoff)) this.requestCoverage(assetId, res, srgb, key, next);
    });
  }

  private async buildCoverage(assetId: string, img: DecodedImage, srgb: boolean, key: string, spec: CoverageSpec): Promise<void> {
    const cutoff = quantizeCutoff(spec.cutoff);
    const ckey = `${key}|cov:${spec.channel}:${cutoff.toFixed(2)}`;
    if (this.pool.has(ckey)) return;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return;
    g.drawImage(img.bitmap, 0, 0);
    const raw = g.getImageData(0, 0, img.width, img.height);
    if (key.endsWith(OPACITY_SUFFIX)) extractOpacityChannel(raw.data, detectOpacityChannel(raw.data));
    else if (spec.channel === 'a') bleedColorUnderAlpha(raw.data, img.width, img.height);
    const pixels = new Uint8Array(raw.data.buffer.slice(0));
    const imageKey = `${this.find(assetId)?.hash ?? assetId}|${img.width}x${img.height}`;
    const levels = await computeCoverageMips({ imageKey, width: img.width, height: img.height, data: pixels, channel: spec.channel, cutoff });
    if (levels.length === 0 || this.pool.has(ckey) || !this.find(assetId)) return;
    const base = levels[0];
    if (!base) return;
    const tex = new DataTexture(base.data, base.width, base.height, RGBAFormat, UnsignedByteType);
    tex.mipmaps = levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
    tex.generateMipmaps = false;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.wrapS = tex.wrapT = RepeatWrapping;
    tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.flipY = false;
    tex.userData[POOL_KEY] = ckey;
    tex.userData.ktCoverage = true;
    tex.needsUpdate = true;
    const bytes = levels.reduce((n, l) => n + l.data.byteLength, 0);
    // Nobody holds it yet: let the entry expire like any released texture if no material picks it up.
    this.pool.set(ckey, { tex, refs: 0, bytes });
    setTimeout(() => {
      const e = this.pool.get(ckey);
      if (e && e.refs === 0) {
        e.tex.dispose();
        this.pool.delete(ckey);
      }
    }, 4000);
    this.emit();
  }

  release(tex: Texture): void {
    const key = tex.userData[POOL_KEY] as string | undefined;
    const entry = key ? this.pool.get(key) : undefined;
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      // Keep unreferenced textures a moment so quick re-acquires (slider drags) do not re-upload.
      setTimeout(() => {
        const e = key ? this.pool.get(key) : undefined;
        if (e && e.refs === 0 && key) {
          e.tex.dispose();
          this.pool.delete(key);
        }
      }, 1500);
    }
  }

  /** GPU texture memory estimate (bytes, incl. mipmaps). */
  memoryBytes(): number {
    let n = 0;
    for (const e of this.pool.values()) n += e.bytes;
    return n;
  }

  poolSize(): number {
    return this.pool.size;
  }

  dispose(): void {
    for (const e of this.pool.values()) e.tex.dispose();
    this.pool.clear();
    for (const d of this.ready.values()) d.bitmap.close();
    this.ready.clear();
    this.decoding.clear();
    this.listeners.clear();
  }
}

function detectAlpha(bitmap: ImageBitmap): boolean {
  if (typeof document === 'undefined') return false;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g) return false;
  g.drawImage(bitmap, 0, 0, 64, 64);
  const d = g.getImageData(0, 0, 64, 64).data;
  for (let i = 3; i < d.length; i += 4) if ((d[i] as number) < 250) return true;
  return false;
}

let shared: TextureManager | null = null;
export function getTextureManager(): TextureManager {
  shared ??= new TextureManager();
  return shared;
}
