import { ShaderChunk, type IUniform } from 'three';
import { getQuality, onQualityChange } from './qualitySettings';

/**
 * Uniform objects shared by every Kekenik material (one object, referenced by all compiled programs), so quality
 * toggles never recompile or touch materials: mip bias and distance scaling of leaf cards.
 */
export const ktSharedUniforms: { uKtMipBias: IUniform<number>; uKtLeafScale: IUniform<number>; uKtLeafNear: IUniform<number>; uKtLeafFar: IUniform<number> } = {
  uKtMipBias: { value: 0 },
  uKtLeafScale: { value: 0 },
  uKtLeafNear: { value: 20 },
  uKtLeafFar: { value: 160 },
};

export function syncSharedUniforms(): void {
  const q = getQuality();
  ktSharedUniforms.uKtMipBias.value = q.mipBias;
  ktSharedUniforms.uKtLeafScale.value = q.leafDistanceScale ? q.leafScaleAmount : 0;
}

syncSharedUniforms();
onQualityChange(syncSharedUniforms);

/** Edge width model of the sharpened alpha: `(a - cutoff) / fwidth(a) + 0.5` stays ~1 px wide at every distance. */
const SHARP = 'clamp( ( diffuseColor.a - alphaTest ) / max( fwidth( diffuseColor.a ), 0.0001 ) + 0.5, 0.0, 1.0 )';

/**
 * three.js `alphatest_fragment` replacement shared by the main, depth and distance (shadow) shaders:
 *  - `ALPHA_TO_COVERAGE`: sharpened alpha -> MSAA coverage mask (crisp, pop-free edges);
 *  - `KT_ALPHA_HASHED`: sharpened alpha compared against interleaved gradient noise (dither fallback without MSAA);
 *  - otherwise the plain alpha test.
 */
export const KT_ALPHATEST_CHUNK = /* glsl */ `
#ifdef USE_ALPHATEST
  #ifdef ALPHA_TO_COVERAGE
    diffuseColor.a = ${SHARP};
    if ( diffuseColor.a == 0.0 ) discard;
  #elif defined( KT_ALPHA_HASHED )
    float ktSharpA = ${SHARP};
    if ( ktSharpA < fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) ) discard;
  #else
    if ( diffuseColor.a < alphaTest ) discard;
  #endif
#endif
`;

/**
 * three.js `alphamap_fragment` replacement used by every shader that does not go through the Kekenik material patch
 * (depth + distance shadow passes, debug materials): an Opacity map REPLACES the colour alpha (cut-out materials keep opacity = 1) instead of multiplying with
 * it, exactly like the main pass (`ktShader.ts`), so the shadow cut-out always matches what is drawn.
 */
export const KT_ALPHAMAP_CHUNK = /* glsl */ `
#ifdef USE_ALPHAMAP
  diffuseColor.a = texture2D( alphaMap, vAlphaMapUv ).g;
#endif
`;

let installed = false;

/** Replace three's alpha-test chunk once, before any program is compiled. */
export function installAlphaChunk(): void {
  if (installed) return;
  installed = true;
  ShaderChunk.alphatest_fragment = KT_ALPHATEST_CHUNK;
  ShaderChunk.alphamap_fragment = KT_ALPHAMAP_CHUNK;
}
