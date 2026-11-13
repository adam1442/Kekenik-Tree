import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  Color,
  FogExp2,
  LinearFilter,
  AgXToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  WebGLRenderer,
  type Texture,
  type Mesh,
  type Material,
} from 'three';
import { CameraController } from './cameraController';
import { createEnvironment, type Environment } from './environment';
import { Grid } from './gridMesh';
import { getTextureManager } from '@/textures/textureManager';
import { RefinementState, TaaAccumulator, clampPixelRatio, describeAa, planAa, viewFingerprint } from './quality/aaLogic';
import { clipPlanes } from './quality/gridMath';
import { QualityPipeline } from './quality/postPipeline';
import { getQuality, onQualityChange, setQualityStatus } from './quality/qualitySettings';
import { setThickLineResolution } from './thickLines';
import { onDebugViewChange } from './debug/debugSettings';
import { setPointPixelRatio } from './debug/roundPoints';
import { SceneObjectsLayer } from './sceneObjectsLayer';
import { getSceneObjects, onSceneObjectsChange } from './viewState';
import { buildEnvironmentFromFile, buildGradientEnvironment, getLighting, type LightingSettings } from './lighting';
import type { FrameInfo, ViewportContent, ViewportOptions } from './types';
import { isSurfaceMesh, ViewModeController } from './viewModes';

const DEFAULT_OPTIONS: ViewportOptions = {
  viewMode: 'shaded',
  showGrid: true,
  showGround: true,
  showHuman: true,
  sunIntensity: 1.5,
};

/**
 * Viewport — owns the three.js renderer, scene, camera controller, grid, lighting and view modes.
 * Render-on-demand: call requestRender() after any change; the loop idles when nothing moves.
 * The WebGL context is created once and never recreated when the panel is docked/floated.
 */
export class Viewport {
  readonly camera = new PerspectiveCamera(35, 1, 0.1, 3000);
  readonly scene = new Scene();
  readonly controller: CameraController;
  private readonly renderer: WebGLRenderer;
  private readonly env: Environment;
  private readonly grid: Grid;
  private readonly pipeline: QualityPipeline;
  private readonly refine = new RefinementState(150);
  private readonly taa = new TaaAccumulator(getQuality().taaFrames);
  private readonly unsubQuality: () => void;
  private readonly unsubDebug: () => void;
  private readonly unsubObjects: () => void;
  private readonly sceneObjects: SceneObjectsLayer;
  private bgCanvas: HTMLCanvasElement | null = null;
  private bgTexture: CanvasTexture | null = null;
  private lastFingerprint = '';
  private taaPending = false;
  private refineTimer = 0;
  private pixelRatio = 1;
  private readonly modes = new ViewModeController();
  private readonly resizeObserver: ResizeObserver;
  private content: ViewportContent | null = null;
  private options: ViewportOptions = { ...DEFAULT_OPTIONS };
  private raf = 0;
  private dirty = true;
  private animating = false;
  private lastTime = 0;
  private fps = 60;
  private disposed = false;
  private customEnv = false;
  onFrame: ((info: FrameInfo) => void) | null = null;
  private readonly beforeRender = new Set<(dt: number) => void>();

  constructor(private readonly container: HTMLElement) {
    // The canvas itself is never multisampled: the scene is rendered into a multisampled HDR target (QualityPipeline)
    // which also draws the gradient background, so the canvas is opaque.
    this.renderer = new WebGLRenderer({ antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    const canvas = this.renderer.domElement;
    canvas.className = 'kt-viewport-canvas';
    container.append(canvas);

    this.env = createEnvironment();
    this.scene.add(this.env.group);
    this.grid = new Grid();
    this.scene.add(this.grid.mesh);
    this.pipeline = new QualityPipeline(this.renderer);

    this.controller = new CameraController(this.camera, canvas, () => this.requestRender());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.sceneObjects = new SceneObjectsLayer(this.scene);
    this.sceneObjects.set(getSceneObjects());
    this.unsubObjects = onSceneObjectsChange((o) => {
      this.sceneObjects.set(o);
      this.requestRender();
    });
    // Normals length changes need the line buffers rebuilt; point size is a live uniform.
    this.unsubDebug = onDebugViewChange(() => {
      if (this.content && this.options.viewMode === 'normals') this.modes.apply(this.content, this.options.viewMode);
      this.requestRender();
    });
    this.applyQuality();
    this.unsubQuality = onQualityChange(() => this.applyQuality());
    this.applyOptions();
    this.setLighting(getLighting());
  }

  setContent(content: ViewportContent | null, frame = true): void {
    if (this.content) {
      this.scene.remove(this.content.root);
      this.content.dispose();
    }
    this.content = content;
    if (content) {
      this.scene.add(content.root);
      if (content.skeleton) content.root.add(content.skeleton);
      this.refreshContent(frame);
    }
    this.requestRender();
  }

  /**
   * Re-apply shadow flags, view mode and fit after the CURRENT content changed in place (incremental updates from
   * SceneSync). Does nothing without content.
   */
  refreshContent(frame = false): void {
    const content = this.content;
    if (!content) return;
    content.root.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && isSurfaceMesh(m)) {
        m.castShadow = true;
        m.receiveShadow = true;
      }
    });
    this.modes.apply(content, this.options.viewMode);
    this.env.fit(content.bounds);
    if (frame) this.controller.frame(content.bounds, true);
    this.requestRender();
  }

  getContent(): ViewportContent | null {
    return this.content;
  }

  setOptions(patch: Partial<ViewportOptions>): void {
    this.options = { ...this.options, ...patch };
    this.applyOptions();
    if (this.content && patch.viewMode) this.modes.apply(this.content, this.options.viewMode);
    this.requestRender();
  }

  /** Apply lighting settings: sun / hemisphere, tone mapping, IBL environment, fog and the background gradient. */
  setLighting(l: LightingSettings): void {
    this.env.applyLighting(l);
    this.renderer.toneMapping = { ACES: ACESFilmicToneMapping, AgX: AgXToneMapping, Neutral: NeutralToneMapping, Linear: LinearToneMapping, None: NoToneMapping }[l.toneMapping];
    this.renderer.toneMappingExposure = l.exposure;
    this.scene.environmentIntensity = l.envIntensity;
    this.scene.fog = l.fog ? new FogExp2(new Color(l.fogFollowsHorizon ? l.horizonColor : l.bgMid), l.fogDensity) : null;
    this.container.style.setProperty('--kt-viewport-top', l.bgTop);
    this.container.style.setProperty('--kt-viewport-mid', l.bgMid);
    this.container.style.setProperty('--kt-viewport-bottom', l.bgBottom);
    this.setBackground(l);
    if (!this.customEnv) {
      this.setEnvironmentTexture(buildGradientEnvironment(this.renderer, l.skyColor, l.horizonColor, l.groundColor, l.sunColor, [Math.cos(l.sunAzimuth), Math.sin(l.sunAzimuth), Math.sin(l.sunElevation)], l.sunGlow));
    }
    this.requestRender();
  }

  /** Vertical gradient (same stops as the CSS gradient: top 0 %, middle 55 %, bottom 100 %) drawn as the scene background. */
  private setBackground(l: LightingSettings): void {
    if (typeof document === 'undefined') return;
    const canvas = (this.bgCanvas ??= Object.assign(document.createElement('canvas'), { width: 1, height: 256 }));
    const g = canvas.getContext('2d');
    if (!g) return;
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, l.bgTop);
    grad.addColorStop(0.55, l.bgMid);
    grad.addColorStop(1, l.bgBottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, 1, 256);
    if (!this.bgTexture) {
      const tex = new CanvasTexture(canvas);
      tex.colorSpace = SRGBColorSpace;
      tex.generateMipmaps = false;
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      this.bgTexture = tex;
      this.scene.background = tex;
    }
    this.bgTexture.needsUpdate = true;
  }

  /** Use an imported HDR/EXR environment (pass null to return to the procedural gradient). */
  async setEnvironmentFile(file: File | null): Promise<void> {
    this.customEnv = file !== null;
    if (file) this.setEnvironmentTexture(await buildEnvironmentFromFile(this.renderer, file));
    else this.setLighting(getLighting());
    this.requestRender();
  }

  private setEnvironmentTexture(tex: Texture): void {
    this.scene.environment?.dispose();
    this.scene.environment = tex;
  }

  /** Maximum anisotropic filtering supported by the GPU (for the texture manager). */
  maxAnisotropy(): number {
    return this.renderer.capabilities.getMaxAnisotropy();
  }

  setSunDirection(azimuth: number, elevation: number): void {
    this.env.setSunDirection(azimuth, elevation);
    this.requestRender();
  }

  frame(): void {
    if (this.content) this.controller.frame(this.content.bounds);
  }

  /** Frame the geometry of the given graph nodes (Zoom > Selection); falls back to the whole plant. */
  frameNodes(ids: readonly string[]): void {
    if (!this.content) return;
    const box = new Box3();
    const tmp = new Box3();
    this.content.root.traverse((o) => {
      const id = o.userData.nodeId as string | undefined;
      if (id === undefined || !ids.includes(id) || !isSurfaceMesh(o) || !o.visible) return;
      tmp.setFromObject(o);
      if (!tmp.isEmpty() && Number.isFinite(tmp.min.x + tmp.max.z)) box.union(tmp);
    });
    this.controller.frame(box.isEmpty() ? this.content.bounds : box);
  }

  /** Camera position as a unit-less distance for the Zoom readout. */
  cameraDistance(): number {
    return this.controller.distance;
  }

  resetCamera(): void {
    this.controller.reset(this.content?.bounds);
  }

  /** Register a callback run once per rendered frame before drawing, with the frame delta in seconds. Returns an unsubscribe function. */
  addBeforeRender(fn: (dt: number) => void): () => void {
    this.beforeRender.add(fn);
    return () => this.beforeRender.delete(fn);
  }

  /** Keep rendering every frame (wind / animation). */
  setAnimating(on: boolean): void {
    this.animating = on;
    if (on) this.requestRender();
  }

  /** Something changed: redraw, restart temporal accumulation and (progressive refinement) drop to the cheap AA level. */
  requestRender(): void {
    if (!this.animating) this.refine.touch(performance.now());
    this.taa.reset();
    this.kick();
  }

  /** Schedule a frame without marking an interaction (used by refinement and temporal accumulation). */
  private kick(): void {
    this.dirty = true;
    if (this.raf === 0 && !this.disposed) {
      this.lastTime = performance.now();
      this.raf = requestAnimationFrame(this.tick);
    }
  }

  /** Push the Viewport Quality settings into the texture manager, pixel ratio and temporal accumulator. */
  private applyQuality(): void {
    const q = getQuality();
    const tm = getTextureManager();
    tm.setAnisotropy(Math.min(q.anisotropy, this.renderer.capabilities.getMaxAnisotropy()));
    tm.setCoverageEnabled(q.coverageMips);
    this.taa.target = q.taaFrames;
    this.resize();
  }

  private applyOptions(): void {
    this.grid.mesh.visible = this.options.showGrid;
    this.env.setGroundVisible(this.options.showGround);
    this.env.setHumanVisible(this.options.showHuman);
      }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.pixelRatio = clampPixelRatio(window.devicePixelRatio || 1, getQuality().maxPixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, false);
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    this.pipeline.setSize(size.x, size.y);
    setThickLineResolution(w, h);
    setPointPixelRatio(this.pixelRatio);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  private readonly tick = (time: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = Math.min(0.1, Math.max(0.001, (time - this.lastTime) / 1000));
    this.lastTime = time;
    const now = performance.now();
    const moving = this.controller.update(dt);
    if (moving) this.refine.touch(now);
    if (this.dirty || moving || this.animating || this.taaPending) {
      this.dirty = false;
      this.beforeRender.forEach((fn) => fn(dt));
      const t0 = performance.now();
      const q = getQuality();
      this.updateClipPlanes();
      this.grid.update(this.camera.position, q, this.controller.distance);
      this.env.faceCamera(this.controller.azimuth);
      this.camera.updateMatrixWorld();
      const fingerprint = viewFingerprint(this.camera.matrixWorld.elements, this.camera.projectionMatrix.elements, this.renderer.domElement.width, this.renderer.domElement.height);
      if (fingerprint !== this.lastFingerprint) {
        this.lastFingerprint = fingerprint;
        this.taa.reset();
      }
      const interactive = this.refine.isInteractive(now);
      const plan = planAa(q, { interactive, animating: this.animating, maxSamples: this.pipeline.maxSamples });
      if (plan.post !== 'taa') this.taa.reset();
      this.pipeline.render(this.scene, this.camera, plan, this.taa);
      this.taaPending = plan.post === 'taa' && !this.taa.done;
      setQualityStatus({ label: describeAa(plan, this.pixelRatio), refined: !(interactive && q.progressive), taaProgress: [this.taa.count, this.taa.target] });
      if (interactive && q.progressive) this.scheduleRefine(now);
      const drawMs = performance.now() - t0;
      this.fps = this.fps * 0.9 + (1 / dt) * 0.1;
      this.onFrame?.({ fps: Math.min(this.fps, 240), drawMs, distance: this.controller.distance });
    }
    if (moving || this.animating || this.taaPending) {
      this.raf = requestAnimationFrame(this.tick);
    }
  };

  /** One refined (full-quality) frame ~150 ms after the last change. */
  private scheduleRefine(now: number): void {
    window.clearTimeout(this.refineTimer);
    this.refineTimer = window.setTimeout(() => {
      this.refineTimer = 0;
      if (!this.disposed) this.kick();
    }, this.refine.msUntilRefine(now) + 4);
  }

  /** Near / far follow the zoom: precise depth buffer for close-ups, far plane far enough for the horizon. */
  private updateClipPlanes(): void {
    const { near, far } = clipPlanes(this.controller.distance);
    const c = this.camera;
    if (Math.abs(near - c.near) > c.near * 0.1 || Math.abs(far - c.far) > c.far * 0.1) {
      c.near = near;
      c.far = far;
      c.updateProjectionMatrix();
    }
  }

  /** Bounding box of the current content (empty box when none). */
  getBounds(): Box3 {
    return this.content ? this.content.bounds.clone() : new Box3();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.refineTimer);
    this.unsubQuality();
    this.unsubDebug();
    this.unsubObjects();
    this.sceneObjects.dispose();
    this.resizeObserver.disconnect();
    this.controller.dispose();
    if (this.content) {
      this.scene.remove(this.content.root);
      this.content.dispose();
      this.content = null;
    }
    this.modes.dispose();
    this.scene.environment?.dispose();
    this.env.dispose();
    this.grid.dispose();
    this.pipeline.dispose();
    this.scene.background = null;
    this.bgTexture?.dispose();
    this.scene.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.material) (m.material as Material).dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
