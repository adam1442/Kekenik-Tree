import type { MaterialDef, MaterialSlotValue, TextureSlot } from '@/contracts/material';
import type { RGBA } from '@/contracts/params';
import { detectOpacityChannel } from '@/textures/alphaCoverage';
import { fitSize, hasTransparency, mergeOpacity, packOrm, resizeImage, dilateColor, type RGBAImage } from '../images/imageOps';
import type { ExportFile, ExportSettings, ImageFormat } from '../types';
import type { GltfImage, GltfMaterial, GltfTextureRef } from '../writers/gltf';
import type { ObjMaterial } from '../writers/simpleFormats';

/** Source of material data and pixels (browser implementation in `materialContext.ts`, fakes in tests). */
export interface MaterialExportContext {
  /** Resolve the id stored in a mesh slot (id or name). */
  material(id: string): MaterialDef | undefined;
  /** Decoded RGBA pixels in the ORIGINAL orientation (top row first); null when missing / undecodable. */
  loadImage(assetId: string): Promise<RGBAImage | null>;
  /** Encode an image; PNG must always be supported. */
  encode(img: RGBAImage, format: ImageFormat, quality: number): Promise<{ data: Uint8Array; mime: GltfImage['mime']; ext: string }>;
  alphaThreshold: number;
}

export interface MaterialRecord {
  id: string;
  name: string;
  /** The material cuts out its silhouette. */
  cutout: boolean;
  textures: { slot: string; image: number; width: number; height: number }[];
}

export interface MaterialExportResult {
  materials: GltfMaterial[];
  materialIndex: Map<string, number>;
  images: GltfImage[];
  obj: Map<string, ObjMaterial>;
  records: MaterialRecord[];
  warnings: string[];
  /** Estimated GPU memory in bytes (RGBA8 with a full mip chain). */
  textureBytes: number;
  /** Final base-colour pixels (colour + opacity merged) per material id, for the impostor renderer. */
  albedo: Map<string, RGBAImage>;
}

const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const rgbaToLinear = (c: RGBA): [number, number, number, number] => [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]];
const safe = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'material';

/** Slots that glTF cannot express natively: kept as raw maps + constants in `extras.kekenik.slots`. */
const EXTRA_SLOTS: TextureSlot[] = ['specular', 'subsurface', 'subsurfacePercent', 'height', 'custom', 'custom2'];

export async function exportMaterials(ids: readonly string[], ctx: MaterialExportContext, settings: ExportSettings, isCancelled: () => boolean): Promise<MaterialExportResult> {
  const out: MaterialExportResult = { materials: [], materialIndex: new Map(), images: [], obj: new Map(), records: [], warnings: [], textureBytes: 0, albedo: new Map() };
  const tex = settings.textures;
  const cache = new Map<string, Promise<RGBAImage | null>>();
  const imageCache = new Map<string, number>();
  const usedNames = new Set<string>();
  const writeImages = tex.enabled;

  const load = (assetId: string): Promise<RGBAImage | null> => {
    let p = cache.get(assetId);
    if (!p) {
      p = ctx.loadImage(assetId);
      cache.set(assetId, p);
    }
    return p;
  };

  for (const id of ids) {
    if (isCancelled()) throw new Error('cancelled');
    const def = ctx.material(id);
    if (!def) {
      out.warnings.push(`Material "${id}" is not in the library; exported with default shading.`);
      continue;
    }
    const cap = Math.min(def.maxResolution ?? Infinity, tex.maxSize > 0 ? tex.maxSize : Infinity);
    const maxEdge = Number.isFinite(cap) ? cap : 0;
    const record: MaterialRecord = { id: def.id, name: def.name, cutout: false, textures: [] };

    const slotImage = async (slot: TextureSlot): Promise<RGBAImage | null> => {
      const ref = def.slots[slot]?.texture;
      if (!ref || !writeImages) return null;
      const img = await load(ref.assetId);
      if (!img) {
        out.warnings.push(`${def.name}: ${slot} texture could not be decoded and was skipped.`);
        return null;
      }
      const s = fitSize(img.width, img.height, maxEdge);
      return resizeImage(img, s.width, s.height);
    };

    const addImage = async (img: RGBAImage, label: string, slot: string, key: string, forcePng = false): Promise<number> => {
      const cached = imageCache.get(key);
      if (cached !== undefined) return cached;
      const wantAlpha = forcePng || hasTransparency(img);
      const format: ImageFormat = wantAlpha && tex.format === 'jpg' ? 'png' : tex.format;
      const processed = tex.padding > 0 && wantAlpha ? dilateColor(img, tex.padding) : img;
      const enc = await ctx.encode(processed, format, tex.quality);
      let base = `${safe(def.name)}_${label}`;
      let n = 1;
      while (usedNames.has(`${base}.${enc.ext}`)) base = `${safe(def.name)}_${label}_${n++}`;
      const file = `${base}.${enc.ext}`;
      usedNames.add(file);
      out.images.push({ name: base, mime: enc.mime, data: enc.data, uri: `textures/${file}` });
      const index = out.images.length - 1;
      imageCache.set(key, index);
      record.textures.push({ slot, image: index, width: img.width, height: img.height });
      out.textureBytes += img.width * img.height * 4 * (4 / 3);
      return index;
    };

    const colorSlot = def.slots.color;
    const colorRgba = colorSlot?.color ?? [1, 1, 1, 1];
    const colorImg = await slotImage('color');
    const opacityImg = await slotImage('opacity');
    const opacityScalar = def.slots.opacity?.scalar;
    const colorAlpha = colorImg ? hasTransparency(colorImg) : false;
    const cutout = opacityImg !== null || colorAlpha;
    record.cutout = cutout;

    let baseColor: GltfTextureRef | undefined;
    if (opacityImg) {
      const channel = detectOpacityChannel(opacityImg.data);
      const merged = mergeOpacity(colorImg, opacityImg, channel);
      baseColor = { image: await addImage(merged, 'albedo', 'color+opacity', `${def.id}:albedo-opacity`, true) };
      out.albedo.set(def.id, merged);
    } else if (colorImg) {
      baseColor = { image: await addImage(colorImg, 'albedo', 'color', `${def.id}:albedo`) };
      out.albedo.set(def.id, colorImg);
    }

    const normalImg = await slotImage('normal');
    const normal: (GltfTextureRef & { scale: number }) | undefined = normalImg ? { image: await addImage(normalImg, 'normal', 'normal', `${def.id}:normal`), scale: def.slots.normal?.scalar ?? 1 } : undefined;

    const glossScalar = def.slots.gloss?.scalar;
    const metalScalar = def.slots.metallic?.scalar;
    const aoScalar = def.slots.ao?.scalar ?? 1;
    const glossImg = await slotImage('gloss');
    const metalImg = await slotImage('metallic');
    const aoImg = await slotImage('ao');

    let metallicRoughness: GltfTextureRef | undefined;
    let occlusion: (GltfTextureRef & { strength: number }) | undefined;
    const extraSlots: Record<string, unknown> = {};

    if (tex.packing === 'orm') {
      const packed = packOrm({
        ao: aoImg,
        gloss: glossImg,
        metallic: metalImg,
        aoScalar,
        glossScalar: glossScalar ?? (glossImg ? 1 : 0.3),
        metallicScalar: metalScalar ?? (metalImg ? 1 : 0),
      });
      if (packed) {
        const ref = { image: await addImage(packed, 'orm', 'occlusion+roughness+metallic', `${def.id}:orm`, true) };
        if (glossImg || metalImg) metallicRoughness = ref;
        if (aoImg) occlusion = { ...ref, strength: aoScalar };
      }
    } else {
      if (aoImg) occlusion = { image: await addImage(aoImg, 'ao', 'ao', `${def.id}:ao`), strength: aoScalar };
      if (glossImg) extraSlots.gloss = { scalar: glossScalar, image: await addImage(glossImg, 'gloss', 'gloss', `${def.id}:gloss`, true) };
      if (metalImg) extraSlots.metallic = { scalar: metalScalar, image: await addImage(metalImg, 'metallic', 'metallic', `${def.id}:metallic`, true) };
    }

    for (const slot of EXTRA_SLOTS) {
      const v: MaterialSlotValue | undefined = def.slots[slot];
      if (!v) continue;
      const entry: Record<string, unknown> = {};
      if (v.color) entry.color = v.color;
      if (v.scalar !== undefined) entry.scalar = v.scalar;
      const img = await slotImage(slot);
      if (img) entry.image = await addImage(img, slot, slot, `${def.id}:${slot}`, true);
      if (Object.keys(entry).length > 0) extraSlots[slot] = entry;
    }

    const roughness = metallicRoughness ? 1 : Math.min(1, Math.max(0, 1 - (glossScalar ?? 0.3)));
    const metallic = metallicRoughness ? 1 : Math.min(1, Math.max(0, metalScalar ?? 0));
    const specColor = def.slots.specular?.color;
    const specular = specColor && (specColor[0] < 0.999 || specColor[1] < 0.999 || specColor[2] < 0.999) ? { factor: 1, color: [srgbToLinear(specColor[0]), srgbToLinear(specColor[1]), srgbToLinear(specColor[2])] as [number, number, number] } : undefined;

    const factor = rgbaToLinear(colorRgba as RGBA);
    if (cutout) factor[3] = 1;
    else if (opacityScalar !== undefined) factor[3] = opacityScalar;
    const blend = !cutout && factor[3] < 0.999;

    const mat: GltfMaterial = {
      name: def.name,
      baseColorFactor: factor,
      metallicFactor: metallic,
      roughnessFactor: roughness,
      alphaMode: cutout ? 'MASK' : blend ? 'BLEND' : 'OPAQUE',
      alphaCutoff: ctx.alphaThreshold,
      doubleSided: def.twoSided || Boolean(def.backMaterialId),
      extras: {
        kekenik: {
          id: def.id,
          twoSided: def.twoSided,
          backMaterial: def.backMaterialId ? { id: def.backMaterialId, spacing: def.backSpacing } : null,
          variations: { colors: def.variations, amount: def.variationAmount },
          season: def.season ?? null,
          atlas: def.atlas,
          maxResolution: def.maxResolution,
          userData: def.userData,
          slots: extraSlots,
        },
      },
    };
    if (baseColor) mat.baseColorTexture = baseColor;
    if (metallicRoughness) mat.metallicRoughnessTexture = metallicRoughness;
    if (occlusion) mat.occlusionTexture = occlusion;
    if (normal) mat.normalTexture = normal;
    if (specular) mat.specular = specular;

    out.materials.push(mat);
    const index = out.materials.length - 1;
    out.materialIndex.set(id, index);
    out.materialIndex.set(def.id, index);
    out.records.push(record);

    const file = (ref: GltfTextureRef | undefined): string | undefined => (ref ? out.images[ref.image]?.uri : undefined);
    const spec = def.slots.specular?.color ?? [1, 1, 1, 1];
    out.obj.set(id, {
      name: def.name,
      diffuse: [colorRgba[0], colorRgba[1], colorRgba[2]],
      specular: [spec[0] * 0.2, spec[1] * 0.2, spec[2] * 0.2],
      shininess: Math.round((glossScalar ?? 0.3) * 200),
      opacity: factor[3],
      mapKd: file(baseColor),
      mapD: cutout ? file(baseColor) : undefined,
      mapBump: file(normal),
    });
  }
  return out;
}

/** Texture files for formats that reference images by name (OBJ): the images carry their relative `uri`. */
export function imageFiles(images: readonly GltfImage[]): ExportFile[] {
  return images.map((i) => ({ name: i.uri ?? `${i.name}`, data: i.data, mime: i.mime }));
}
