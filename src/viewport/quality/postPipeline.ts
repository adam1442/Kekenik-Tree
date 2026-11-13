import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  ColorManagement,
  CustomToneMapping,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  LinearToneMapping,
  NearestFilter,
  NeutralToneMapping,
  RawShaderMaterial,
  ReinhardToneMapping,
  RGBAFormat,
  SRGBTransfer,
  UnsignedByteType,
  UnsignedIntType,
  WebGLRenderTarget,
  type MagnificationTextureFilter,
  type MinificationTextureFilter,
  type PerspectiveCamera,
  type Scene,
  type TextureDataType,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FXAAPass } from 'three/examples/jsm/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { AaPlan, TaaAccumulator } from './aaLogic';

const VERTEX = /* glsl */ `
  precision highp float;
  uniform mat4 modelViewMatrix;
  uniform mat4 projectionMatrix;
  attribute vec3 position;
  attribute vec2 uv;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * Resolve of the multisampled HDR scene target. Tone mapping + output colour space are applied exactly once, here
 * (three.js skips both while rendering into a render target). Pixels that carry no geometry (depth == 1: the gradient
 * background and the ground decals) are only colour-space encoded, so the background keeps the colours the user picked.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  #include <tonemapping_pars_fragment>
  #include <colorspace_pars_fragment>
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tScene, vUv).rgb;
    float depth = texture2D(tDepth, vUv).x;
    if (depth < 0.999999) {
      #ifdef LINEAR_TONE_MAPPING
        c = LinearToneMapping(c);
      #elif defined( REINHARD_TONE_MAPPING )
        c = ReinhardToneMapping(c);
      #elif defined( CINEON_TONE_MAPPING )
        c = CineonToneMapping(c);
      #elif defined( ACES_FILMIC_TONE_MAPPING )
        c = ACESFilmicToneMapping(c);
      #elif defined( AGX_TONE_MAPPING )
        c = AgXToneMapping(c);
      #elif defined( NEUTRAL_TONE_MAPPING )
        c = NeutralToneMapping(c);
      #elif defined( CUSTOM_TONE_MAPPING )
        c = CustomToneMapping(c);
      #endif
    }
    #ifdef SRGB_TRANSFER
      c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
    #endif
    // Blue-noise-like dither hides 8-bit banding of the smooth background gradient.
    c += (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
    gl_FragColor = vec4(c, 1.0);
  }
`;

const COPY_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tDiffuse;
  varying vec2 vUv;
  void main() { gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); }
`;

const ACCUMULATE_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tCurrent;
  uniform sampler2D tHistory;
  uniform float uWeight;
  varying vec2 vUv;
  void main() {
    vec3 cur = texture2D(tCurrent, vUv).rgb;
    vec3 prev = texture2D(tHistory, vUv).rgb;
    gl_FragColor = vec4(mix(prev, cur, uWeight), 1.0);
  }
`;

function rawMaterial(fragmentShader: string, uniforms: RawShaderMaterial['uniforms']): RawShaderMaterial {
  return new RawShaderMaterial({ vertexShader: VERTEX, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

/**
 * Scene -> multisampled HDR target -> composite (tone map + sRGB) -> optional FXAA / SMAA / TAA -> canvas.
 * TAA = sub-pixel jittered frames accumulated into a running average while the view is still (the caller resets the
 * accumulator on any camera / scene change), so it needs no motion vectors and cannot ghost.
 */
export class QualityPipeline {
  private scene: WebGLRenderTarget | null = null;
  private ldr: WebGLRenderTarget | null = null;
  private acc: [WebGLRenderTarget, WebGLRenderTarget] | null = null;
  private accIndex = 0;
  private samples = -1;
  private width = 1;
  private height = 1;
  private fxaa: FXAAPass | null = null;
  private smaa: SMAAPass | null = null;
  private readonly quad = new FullScreenQuad();
  private readonly composite = rawMaterial(COMPOSITE_FRAGMENT, { tScene: { value: null }, tDepth: { value: null }, toneMappingExposure: { value: 1 } });
  private readonly copy = rawMaterial(COPY_FRAGMENT, { tDiffuse: { value: null } });
  private readonly accumulate = rawMaterial(ACCUMULATE_FRAGMENT, { tCurrent: { value: null }, tHistory: { value: null }, uWeight: { value: 1 } });
  private toneMapping: number | null = null;
  private colorSpace: string | null = null;
  private readonly colorType: TextureDataType;

  constructor(private readonly renderer: WebGLRenderer) {
    const ext = renderer.extensions;
    this.colorType = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float') ? HalfFloatType : UnsignedByteType;
  }

  /** Maximum MSAA sample count of the GPU. */
  get maxSamples(): number {
    return this.renderer.capabilities.maxSamples;
  }

  /** Drawing-buffer size in physical pixels. */
  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.scene?.setSize(this.width, this.height);
    this.ldr?.setSize(this.width, this.height);
    this.acc?.forEach((t) => t.setSize(this.width, this.height));
    this.fxaa?.setSize(this.width, this.height);
    this.smaa?.setSize(this.width, this.height);
  }

  private target(type: TextureDataType, filter: MinificationTextureFilter & MagnificationTextureFilter, depth: boolean, samples = 0): WebGLRenderTarget {
    const rt = new WebGLRenderTarget(this.width, this.height, { type, format: RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: depth, stencilBuffer: false, samples, generateMipmaps: false });
    if (depth) {
      const dt = new DepthTexture(this.width, this.height);
      dt.type = UnsignedIntType;
      rt.depthTexture = dt;
    }
    return rt;
  }

  private ensureScene(samples: number): WebGLRenderTarget {
    if (!this.scene || this.samples !== samples) {
      this.scene?.depthTexture?.dispose();
      this.scene?.dispose();
      this.scene = this.target(this.colorType, NearestFilter, true, samples);
      this.samples = samples;
    }
    return this.scene;
  }

  private ensureLdr(): WebGLRenderTarget {
    this.ldr ??= this.target(UnsignedByteType, LinearFilter, false);
    return this.ldr;
  }

  private ensureAcc(): [WebGLRenderTarget, WebGLRenderTarget] {
    this.acc ??= [this.target(this.colorType, NearestFilter, false), this.target(this.colorType, NearestFilter, false)];
    return this.acc;
  }

  /** Same define logic as three's OutputPass: rebuild only when tone mapping / colour space changed. */
  private syncOutputDefines(): void {
    const r = this.renderer;
    this.composite.uniforms.toneMappingExposure.value = r.toneMappingExposure;
    if (this.toneMapping === r.toneMapping && this.colorSpace === r.outputColorSpace) return;
    this.toneMapping = r.toneMapping;
    this.colorSpace = r.outputColorSpace;
    const d: Record<string, string> = {};
    if (ColorManagement.getTransfer(r.outputColorSpace) === SRGBTransfer) d.SRGB_TRANSFER = '';
    const names: [number, string][] = [
      [LinearToneMapping, 'LINEAR_TONE_MAPPING'],
      [ReinhardToneMapping, 'REINHARD_TONE_MAPPING'],
      [CineonToneMapping, 'CINEON_TONE_MAPPING'],
      [ACESFilmicToneMapping, 'ACES_FILMIC_TONE_MAPPING'],
      [AgXToneMapping, 'AGX_TONE_MAPPING'],
      [NeutralToneMapping, 'NEUTRAL_TONE_MAPPING'],
      [CustomToneMapping, 'CUSTOM_TONE_MAPPING'],
    ];
    const hit = names.find(([mode]) => mode === r.toneMapping);
    if (hit) d[hit[1]] = '';
    this.composite.defines = d;
    this.composite.needsUpdate = true;
  }

  private pass(material: RawShaderMaterial, target: WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  /** Renders one frame to the canvas. `taa` is only used (and advanced) when `plan.post === 'taa'`. */
  render(scene: Scene, camera: PerspectiveCamera, plan: AaPlan, taa: TaaAccumulator): void {
    const r = this.renderer;
    const sceneRt = this.ensureScene(plan.samples);
    const jitter = plan.post === 'taa' ? taa.next() : null;
    if (jitter) camera.setViewOffset(this.width, this.height, jitter.jitter[0], jitter.jitter[1], this.width, this.height);
    r.setRenderTarget(sceneRt);
    r.render(scene, camera);
    if (jitter) camera.clearViewOffset();

    this.syncOutputDefines();
    this.composite.uniforms.tScene.value = sceneRt.texture;
    this.composite.uniforms.tDepth.value = sceneRt.depthTexture;

    if (plan.post === 'none') {
      this.pass(this.composite, null);
    } else {
      const ldr = this.ensureLdr();
      this.pass(this.composite, ldr);
      if (plan.post === 'fxaa') {
        this.fxaa ??= new FXAAPass();
        this.fxaa.setSize(this.width, this.height);
        this.fxaa.renderToScreen = true;
        this.fxaa.render(r, ldr, ldr, 0, false);
      } else if (plan.post === 'smaa') {
        this.smaa ??= new SMAAPass();
        this.smaa.setSize(this.width, this.height);
        this.smaa.renderToScreen = true;
        this.smaa.render(r, ldr, ldr, 0, false);
      } else if (jitter) {
        const acc = this.ensureAcc();
        const history = acc[this.accIndex] as WebGLRenderTarget;
        const next = acc[1 - this.accIndex] as WebGLRenderTarget;
        if (jitter.weight >= 1) {
          this.copy.uniforms.tDiffuse.value = ldr.texture;
          this.pass(this.copy, next);
        } else {
          this.accumulate.uniforms.tCurrent.value = ldr.texture;
          this.accumulate.uniforms.tHistory.value = history.texture;
          this.accumulate.uniforms.uWeight.value = jitter.weight;
          this.pass(this.accumulate, next);
        }
        this.accIndex = 1 - this.accIndex;
        this.copy.uniforms.tDiffuse.value = next.texture;
        this.pass(this.copy, null);
        taa.commit();
      }
    }
    r.setRenderTarget(null);
  }

  dispose(): void {
    this.scene?.depthTexture?.dispose();
    this.scene?.dispose();
    this.ldr?.dispose();
    this.acc?.forEach((t) => t.dispose());
    this.fxaa?.dispose();
    this.smaa?.dispose();
    this.quad.dispose();
    this.composite.dispose();
    this.copy.dispose();
    this.accumulate.dispose();
  }
}
