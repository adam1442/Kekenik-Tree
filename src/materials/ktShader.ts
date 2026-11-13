import { Color, MeshPhysicalMaterial, ShaderChunk, Texture, Vector3, type IUniform, type WebGLProgramParametersWithUniforms } from 'three';
import { installAlphaChunk, ktSharedUniforms } from '@/viewport/quality/sharedUniforms';

installAlphaChunk();

/**
 * Kekenik material: MeshPhysicalMaterial + shader patches for the slot workflow (gloss map -> roughness, per-instance
 * variation tint, subsurface back-lighting, Back-material offset). Uniform objects are shared by `clone()`s so the wind
 * system's per-mesh variants keep following live edits.
 */
export interface KtUniforms {
  uKtVar0: IUniform<Vector3>;
  uKtVar1: IUniform<Vector3>;
  uKtVar2: IUniform<Vector3>;
  uKtVarAmount: IUniform<number>;
  uKtGloss: IUniform<number>;
  ktGlossMap: IUniform<Texture | null>;
  uKtSubColor: IUniform<Color>;
  uKtSubAmount: IUniform<number>;
  ktSubColorMap: IUniform<Texture | null>;
  ktSubAmountMap: IUniform<Texture | null>;
  uKtBackOffset: IUniform<number>;
  uKtTrans: IUniform<number>;
  uKtWrap: IUniform<number>;
  uKtAoMix: IUniform<number>;
}

export function createKtUniforms(): KtUniforms {
  return {
    uKtVar0: { value: new Vector3(1, 1, 1) },
    uKtVar1: { value: new Vector3(1, 1, 1) },
    uKtVar2: { value: new Vector3(1, 1, 1) },
    uKtVarAmount: { value: 0 },
    uKtGloss: { value: 0.3 },
    ktGlossMap: { value: null },
    uKtSubColor: { value: new Color(1, 1, 1) },
    uKtSubAmount: { value: 0 },
    ktSubColorMap: { value: null },
    ktSubAmountMap: { value: null },
    uKtBackOffset: { value: 0 },
    uKtTrans: { value: 1 },
    uKtWrap: { value: 0.3 },
    uKtAoMix: { value: 1 },
  };
}

const VERT_DECL = /* glsl */ `
varying vec2 vKtUv;
varying float vKtRand;
#ifdef KT_BACK_OFFSET
uniform float uKtBackOffset;
#endif
#ifdef KT_LEAF_SCALE
uniform float uKtLeafScale;
uniform float uKtLeafNear;
uniform float uKtLeafFar;
#endif
#ifdef KT_AO_ONLY
attribute float ao;
uniform float uKtAoMix;
#endif
`;

const VERT_BODY = /* glsl */ `
vKtUv = uv;
#ifdef KT_WIND_RAND
float ktR = windWeights.w;
#ifdef USE_INSTANCING
ktR = fract(ktR + sin(dot(instanceMatrix[3].xyz, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
#endif
vKtRand = ktR;
#else
vKtRand = 0.5;
#endif
#ifdef KT_BACK_OFFSET
transformed -= normalize(objectNormal) * uKtBackOffset;
#endif
#ifdef KT_LEAF_SCALE
if (uKtLeafScale > 0.0) {
  // Leaf cards grow slightly with camera distance (about their pivot) to compensate the remaining thinning.
  vec4 ktPv = vec4(windPivot, 1.0);
  #ifdef USE_INSTANCING
  ktPv = instanceMatrix * ktPv;
  #endif
  float ktDist = length((modelViewMatrix * ktPv).xyz);
  float ktScale = 1.0 + uKtLeafScale * smoothstep(uKtLeafNear, uKtLeafFar, ktDist);
  transformed = windPivot + (transformed - windPivot) * ktScale;
}
#endif
`;

/** Vertex colours carry tint * AO. With a Color map the tint comes from the image, so only the baked AO is kept. */
const VERT_COLOR = /* glsl */ `
#if defined(KT_AO_ONLY) && (defined(USE_COLOR) || defined(USE_COLOR_ALPHA))
vColor.rgb = vec3(mix(1.0, ao, uKtAoMix));
#endif
`;

const FRAG_DECL = /* glsl */ `
varying vec2 vKtUv;
varying float vKtRand;
uniform vec3 uKtVar0;
uniform vec3 uKtVar1;
uniform vec3 uKtVar2;
uniform float uKtVarAmount;
uniform float uKtGloss;
uniform sampler2D ktGlossMap;
uniform vec3 uKtSubColor;
uniform float uKtSubAmount;
uniform sampler2D ktSubColorMap;
uniform sampler2D ktSubAmountMap;
uniform float uKtTrans;
uniform float uKtWrap;
uniform float uKtMipBias;

// Same maths as variationTint() in shadingMath.ts (luminance-normalised swatch, blended from white by the amount).
vec3 ktVariationTint(float r) {
  float t = clamp(r, 0.0, 1.0) * 2.0;
  vec3 a = t < 1.0 ? uKtVar0 : uKtVar1;
  vec3 b = t < 1.0 ? uKtVar1 : uKtVar2;
  vec3 c = mix(a, b, fract(t >= 2.0 ? 1.0 : t));
  float l = max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.001);
  vec3 tint = min(c / l, vec3(2.0));
  return mix(vec3(1.0), tint, clamp(uKtVarAmount, 0.0, 1.0));
}
`;

const ROUGHNESS = /* glsl */ `
float roughnessFactor = roughness;
#ifdef KT_GLOSSMAP
roughnessFactor = 1.0 - texture2D(ktGlossMap, vKtUv).r * uKtGloss;
#else
roughnessFactor = 1.0 - uKtGloss;
#endif
roughnessFactor = clamp(roughnessFactor, 0.02, 1.0);
`;

/**
 * Injected after every directional light's shadowed `RE_Direct` call (so `directLight.color` already contains the
 * shadow term): wrapped diffuse (soft terminator of thin foliage) and thin-leaf light transmission, which is
 * strongest when the camera looks towards the sun through the leaf (forward scattering).
 */
const DIRECT_HOOK = /* glsl */ `
#ifdef KT_FOLIAGE
{
  float ktNL = dot(geometryNormal, directLight.direction);
  float ktWrapped = saturate((ktNL + uKtWrap) / (1.0 + uKtWrap)) - saturate(ktNL);
  reflectedLight.directDiffuse += directLight.color * ktWrapped * RECIPROCAL_PI * diffuseColor.rgb;
  #ifdef KT_SSS
  float ktBack = saturate(-ktNL);
  float ktFwd = pow(saturate(dot(geometryViewDir, -directLight.direction)), 4.0);
  vec3 ktGlow = sqrt(diffuseColor.rgb) * ktSubTint;
  reflectedLight.directDiffuse += directLight.color * ktBack * (0.25 + 1.6 * ktFwd) * ktGlow * ktSubAmt * uKtTrans * RECIPROCAL_PI * 2.0;
  #endif
}
#endif
`;

/** Per-fragment inputs of DIRECT_HOOK, declared once before the light loops. */
const HOOK_PRELUDE = /* glsl */ `
#ifdef KT_FOLIAGE
vec3 ktSubTint = uKtSubColor;
float ktSubAmt = uKtSubAmount;
#ifdef KT_SUBCOLORMAP
ktSubTint *= texture2D(ktSubColorMap, vKtUv).rgb;
#endif
#ifdef KT_SUBAMOUNTMAP
ktSubAmt *= texture2D(ktSubAmountMap, vKtUv).r;
#endif
#endif
`;

/** three's lights_fragment_begin with DIRECT_HOOK appended to the directional-light loop (unchanged if the chunk differs). */
export function lightsFragmentBegin(): string {
  const chunk = ShaderChunk.lights_fragment_begin;
  const block = chunk.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
  if (block < 0) return chunk;
  const call = chunk.indexOf('RE_Direct(', block);
  if (call < 0) return chunk;
  const end = chunk.indexOf(';', call) + 1;
  const prelude = chunk.indexOf('IncidentLight directLight;');
  if (prelude < 0 || prelude > block) return chunk;
  return `${chunk.slice(0, prelude)}${HOOK_PRELUDE}\n${chunk.slice(prelude, end)}\n${DIRECT_HOOK}${chunk.slice(end)}`;
}

let lightsChunk: string | null = null;

/** three.js map / alphaMap chunks with a global texture LOD bias (Viewport Quality > Mip bias). */
const MAP_FRAGMENT = ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv, uKtMipBias )');
const ALPHAMAP_FRAGMENT = ShaderChunk.alphamap_fragment.replace('texture2D( alphaMap, vAlphaMapUv )', 'texture2D( alphaMap, vAlphaMapUv, uKtMipBias )');

function patch(shader: WebGLProgramParametersWithUniforms, u: KtUniforms): void {
  Object.assign(shader.uniforms, u, ktSharedUniforms);
  lightsChunk ??= lightsFragmentBegin();
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERT_DECL}`)
    .replace('#include <color_vertex>', `#include <color_vertex>\n${VERT_COLOR}`)
    .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_DECL}`)
    .replace('#include <map_fragment>', MAP_FRAGMENT)
    .replace('#include <alphamap_fragment>', ALPHAMAP_FRAGMENT)
    .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= ktVariationTint(vKtRand);')
    .replace('#include <roughnessmap_fragment>', ROUGHNESS)
    .replace('#include <lights_fragment_begin>', lightsChunk);
}

export class KtPhysicalMaterial extends MeshPhysicalMaterial {
  ktUniforms: KtUniforms;

  constructor(uniforms: KtUniforms = createKtUniforms()) {
    super();
    this.ktUniforms = uniforms;
    this.roughness = 1;
    this.onBeforeCompile = (shader) => patch(shader, this.ktUniforms);
    this.customProgramCacheKey = () => 'kt3';
  }

  override copy(source: MeshPhysicalMaterial): this {
    super.copy(source);
    const s = source as Partial<KtPhysicalMaterial>;
    if (s.ktUniforms) this.ktUniforms = s.ktUniforms;
    return this;
  }
}
