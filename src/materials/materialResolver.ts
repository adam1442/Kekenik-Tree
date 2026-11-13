import { BackSide, Color, DoubleSide, FrontSide, SRGBColorSpace, Texture, Vector2, type Material } from 'three';
import type { MaterialDef, TextureSlot } from '@/contracts/material';
import type { MaterialResolver } from '@/viewport/defaultMaterials';
import { getTextureManager, type TextureManager } from '@/textures/textureManager';
import { getMaterialLibrary, type MaterialLibrary } from './library';
import { KtPhysicalMaterial, createKtUniforms, type KtUniforms } from './ktShader';
import { getShadingSettings, onShadingSettingsChange } from './shadingSettings';
import { createMaterialDef } from './shadingMath';
import { effectiveAlphaMode, getQuality, onQualityChange } from '@/viewport/quality/qualitySettings';

interface State {
  material: KtPhysicalMaterial;
  uniforms: KtUniforms;
  defId: string;
  back: boolean;
  acquired: Texture[];
  featureKey: string;
}

export interface ResolverOptions {
  /** Use the wind attributes of scene meshes for the per-leaf variation random (false for the preview scene). */
  windRand: boolean;
  /** Mesh geometry carries `color` / `ao` vertex attributes (scene meshes yes, preview sphere / card no). */
  vertexColors?: boolean;
}

const FALLBACK = createMaterialDef('default', 'Default');

/**
 * Maps MeshData material ids to three.js materials built from the project's MaterialDefs. Edits are applied in place
 * (no new objects) so the viewport only needs a repaint; structural changes (Back material) notify `onChange`.
 */
export class KtMaterialResolver implements MaterialResolver {
  private readonly states = new Map<string, State>();
  private readonly structural = new Set<() => void>();
  private repaint: () => void = () => undefined;
  private scheduled = 0;
  private readonly unsubs: (() => void)[];
  private lastBackKeys = '';

  constructor(
    private readonly lib: MaterialLibrary,
    private readonly tm: TextureManager,
    private readonly opts: ResolverOptions,
  ) {
    this.unsubs = [lib.onChange(() => this.schedule()), tm.onChange(() => this.schedule()), onShadingSettingsChange(() => this.schedule()), onQualityChange(() => this.schedule())];
  }

  setRepaint(fn: () => void): void {
    this.repaint = fn;
  }

  private def(id: string): MaterialDef {
    return this.lib.material(id) ?? this.lib.materials().find((m) => m.name === id) ?? FALLBACK;
  }

  resolve(materialId: string): Material {
    return this.state(`f:${materialId}`, materialId, false).material;
  }

  resolveBack(materialId: string): Material | null {
    const back = this.def(materialId).backMaterialId;
    return back && this.lib.material(back) ? this.state(`b:${materialId}`, materialId, true).material : null;
  }

  backKey(materialId: string): string {
    return this.def(materialId).backMaterialId ?? '';
  }

  onChange(fn: () => void): () => void {
    this.structural.add(fn);
    return () => this.structural.delete(fn);
  }

  private state(key: string, ownerId: string, back: boolean): State {
    let st = this.states.get(key);
    if (!st) {
      const uniforms = createKtUniforms();
      st = { material: new KtPhysicalMaterial(uniforms), uniforms, defId: ownerId, back, acquired: [], featureKey: '' };
      this.states.set(key, st);
      this.apply(st);
    }
    return st;
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = window.setTimeout(() => {
      this.scheduled = 0;
      this.refreshAll();
    }, 16);
  }

  refreshAll(): void {
    for (const st of this.states.values()) this.apply(st);
    const keys = [...this.states.keys()].map((k) => `${k}=${this.def(k.slice(2)).backMaterialId ?? ''}`).join('|');
    if (keys !== this.lastBackKeys) {
      this.lastBackKeys = keys;
      this.structural.forEach((l) => l());
    }
    this.repaint();
  }

  /** Copy a MaterialDef onto a three.js material (textures, constants, defines). */
  private apply(st: State): void {
    const owner = this.def(st.defId);
    // A back twin renders the BACK material's maps/settings, offset by the owner's spacing.
    const def = st.back ? this.def(owner.backMaterialId ?? '') : owner;
    const m = st.material;
    const u = st.uniforms;
    const shading = getShadingSettings();
    const old = st.acquired;
    st.acquired = [];
    const quality = getQuality();
    const alphaMode = effectiveAlphaMode(quality, shading.alphaToCoverage);
    const colorAlpha = def.slots.color?.texture ? this.tm.hasAlpha(def.slots.color.texture.assetId) === true : false;
    const hasOpacityMap = Boolean(def.slots.opacity?.texture);
    const cutout = hasOpacityMap || colorAlpha;
    // Alpha-coverage mips go onto the texture that carries the cut-out: the Opacity map (green channel) or the colour alpha.
    const coverageFor = (slot: TextureSlot): { channel: 'a' | 'g'; cutoff: number } | null => {
      if (!cutout) return null;
      if (slot === 'opacity') return { channel: 'g', cutoff: shading.alphaThreshold };
      if (slot === 'color' && !hasOpacityMap) return { channel: 'a', cutoff: shading.alphaThreshold };
      return null;
    };
    const tex = (slot: TextureSlot): Texture | null => {
      const ref = def.slots[slot]?.texture;
      if (!ref) return null;
      const t = this.tm.acquire(ref.assetId, slot, def.maxResolution, coverageFor(slot));
      if (t) st.acquired.push(t);
      return t;
    };
    const scalar = (slot: TextureSlot, hasTex: boolean, fallback: number): number => def.slots[slot]?.scalar ?? (hasTex ? 1 : fallback);

    const color = tex('color');
    const opacity = tex('opacity');
    const normal = tex('normal');
    const gloss = tex('gloss');
    const specular = tex('specular');
    const metallic = tex('metallic');
    const subColor = tex('subsurface');
    const subAmount = tex('subsurfacePercent');
    const ao = tex('ao');

    const c = def.slots.color?.color ?? [1, 1, 1, 1];
    m.color.setRGB(c[0], c[1], c[2], SRGBColorSpace);
    m.map = color;
    m.vertexColors = this.opts.vertexColors === true;
    m.alphaMap = opacity;
    // A cut-out is decided by the mask alone: the Opacity constant must not scale it (that would make the Alpha
    // Threshold empty the crown). Without a mask the constant is a plain material opacity.
    m.opacity = cutout ? 1 : (def.slots.opacity?.scalar ?? 1);
    // Coverage-preserving mips are remapped so that the cutoff sits at 0.5 (shadow passes use 0.5 for alpha-to-coverage).
    const remapped = (opacity !== null && this.tm.isCoverageTexture(opacity)) || (opacity === null && this.tm.isCoverageTexture(color));
    m.alphaTest = cutout ? (remapped ? 0.5 : shading.alphaThreshold) : 0;
    m.alphaToCoverage = cutout && alphaMode === 'coverage';
    m.transparent = false;
    m.normalMap = normal;
    const ns = def.slots.normal?.scalar ?? 1;
    m.normalScale = new Vector2(ns, ns);
    m.metalnessMap = metallic;
    m.metalness = scalar('metallic', metallic !== null, 0);
    m.aoMap = ao;
    m.aoMapIntensity = def.slots.ao?.scalar ?? 1;
    const sp = def.slots.specular?.color ?? [1, 1, 1, 1];
    m.specularColor = new Color().setRGB(sp[0], sp[1], sp[2], SRGBColorSpace);
    m.specularColorMap = specular;
    m.specularIntensity = 1;
    const height = tex('height');
    m.bumpMap = height;
    m.bumpScale = height ? 2 * scalar('height', true, 1) : 0;
    const foliage = cutout || def.twoSided || (def.slots.subsurfacePercent?.scalar ?? 0) > 0;
    m.sheen = foliage ? shading.foliageSheen : 0;
    m.sheenRoughness = 0.45;
    m.sheenColor = new Color().setRGB(0.85, 1, 0.7, SRGBColorSpace);
    m.side = st.back ? BackSide : def.twoSided && !owner.backMaterialId ? DoubleSide : FrontSide;

    u.uKtGloss.value = scalar('gloss', gloss !== null, 0.3);
    u.ktGlossMap.value = gloss;
    const sc = def.slots.subsurface?.color ?? [1, 1, 1, 1];
    u.uKtSubColor.value.setRGB(sc[0], sc[1], sc[2], SRGBColorSpace);
    u.uKtSubAmount.value = shading.translucency ? scalar('subsurfacePercent', subAmount !== null, 0) : 0;
    u.ktSubColorMap.value = subColor;
    u.ktSubAmountMap.value = subAmount;
    // The shader maths expects display-referred swatches, as in shadingMath.variationTint().
    def.variations.forEach((v, i) => (i === 0 ? u.uKtVar0 : i === 1 ? u.uKtVar1 : u.uKtVar2).value.set(v[0], v[1], v[2]));
    u.uKtVarAmount.value = def.variationAmount;
    u.uKtBackOffset.value = st.back ? owner.backSpacing : 0;
    u.uKtTrans.value = shading.translucencyStrength;
    u.uKtWrap.value = shading.foliageWrap;
    u.uKtAoMix.value = shading.vertexAo;

    const features = {
      KT_GLOSSMAP: gloss !== null,
      KT_SUBCOLORMAP: subColor !== null,
      KT_SUBAMOUNTMAP: subAmount !== null,
      KT_SSS: u.uKtSubAmount.value > 0 || subAmount !== null,
      KT_BACK_OFFSET: st.back,
      KT_WIND_RAND: this.opts.windRand,
      KT_FOLIAGE: foliage,
      KT_AO_ONLY: this.opts.vertexColors === true && color !== null,
      KT_ALPHA_HASHED: cutout && alphaMode === 'hashed',
      KT_LEAF_SCALE: cutout && this.opts.windRand,
    };
    const key = [...Object.entries(features)].map(([k, v]) => `${k}${v ? 1 : 0}`).join('') + [color, opacity, normal, metallic, ao, specular, height].map((t) => (t ? 1 : 0)).join('') + `|${alphaMode}|${cutout ? 1 : 0}`;
    if (key !== st.featureKey) {
      st.featureKey = key;
      const defines: Record<string, string> = { STANDARD: '', PHYSICAL: '' };
      for (const [k, v] of Object.entries(features)) if (v) defines[k] = '';
      m.defines = defines;
      m.needsUpdate = true;
    }
    for (const t of old) this.tm.release(t);
  }

  /** Does this material cut out its silhouette (card preview + alpha handling)? */
  isCutout(materialId: string): boolean {
    const d = this.def(materialId);
    if (d.slots.opacity?.texture) return true;
    const ref = d.slots.color?.texture;
    return ref ? this.tm.hasAlpha(ref.assetId) === true : false;
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    window.clearTimeout(this.scheduled);
    for (const st of this.states.values()) {
      st.material.dispose();
      for (const t of st.acquired) this.tm.release(t);
    }
    this.states.clear();
    this.structural.clear();
    if (shared === this) shared = null;
  }
}

let shared: KtMaterialResolver | null = null;
let repaintHook: () => void = () => undefined;

/** Called after material edits / texture decodes so the viewport repaints (installed by installMaterialSystem). */
export function setResolverRepaint(fn: () => void): void {
  repaintHook = fn;
  shared?.setRepaint(fn);
}

/** The viewport's resolver (singleton; the SceneSync disposes it with the viewport, a new one is made on demand). */
export function getMaterialResolver(): KtMaterialResolver {
  if (!shared) {
    shared = new KtMaterialResolver(getMaterialLibrary(), getTextureManager(), { windRand: true, vertexColors: true });
    shared.setRepaint(repaintHook);
  }
  return shared;
}
