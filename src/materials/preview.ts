import { ACESFilmicToneMapping, AmbientLight, DirectionalLight, DoubleSide, Group, HemisphereLight, Material, Mesh, PerspectiveCamera, PlaneGeometry, Scene, SphereGeometry, SRGBColorSpace, WebGLRenderer, type Texture } from 'three';
import { buildGradientEnvironment } from '@/viewport/lighting';
import { getMaterialLibrary } from './library';
import { KtMaterialResolver } from './materialResolver';
import { getTextureManager } from '@/textures/textureManager';

export type PreviewKind = 'sphere' | 'card';

export interface PreviewView {
  yaw: number;
  pitch: number;
  panX: number;
  panY: number;
  zoom: number;
}

export const defaultPreviewView = (): PreviewView => ({ yaw: 0.6, pitch: 0.25, panX: 0, panY: 0, zoom: 1 });

/**
 * One shared offscreen WebGL renderer for every material preview (sphere / cut-out card) and thumbnail. Results are
 * copied into the caller's 2D canvas, which sits on a CSS checkerboard (transparent background).
 */
export class MaterialPreviewRenderer {
  private renderer: WebGLRenderer | null = null;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.1, 20);
  private readonly pivot = new Group();
  private readonly sphere: Mesh;
  private readonly card: Mesh;
  private env: Texture | null = null;
  private resolver: KtMaterialResolver | null = null;
  private readonly invalidate = new Set<() => void>();

  constructor() {
    this.sphere = new Mesh(new SphereGeometry(0.5, 64, 48));
    this.card = new Mesh(new PlaneGeometry(1, 1));
    this.pivot.add(this.sphere, this.card);
    this.scene.add(this.pivot);
    const sun = new DirectionalLight(0xfff0dc, 2.6);
    sun.position.set(1.2, 1.6, 2.2);
    this.scene.add(sun, new HemisphereLight(0xdfe8f5, 0x6b6a45, 0.7), new AmbientLight(0xffffff, 0.15));
    this.camera.position.set(0, 0, 3.4);
  }

  /** Subscribe to "a material or texture changed, redraw"; returns unsubscribe. */
  onInvalidate(fn: () => void): () => void {
    this.invalidate.add(fn);
    return () => this.invalidate.delete(fn);
  }

  private ensure(): { renderer: WebGLRenderer; resolver: KtMaterialResolver } | null {
    if (!this.renderer) {
      try {
        this.renderer = new WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: false });
      } catch {
        return null;
      }
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = SRGBColorSpace;
      this.renderer.toneMapping = ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 0.95;
      this.env = buildGradientEnvironment(this.renderer, '#dfe8f5', '#c9cfd6', '#6b6a45');
      this.scene.environment = this.env;
      this.scene.environmentIntensity = 0.6;
      this.resolver = new KtMaterialResolver(getMaterialLibrary(), getTextureManager(), { windRand: false });
      this.resolver.setRepaint(() => this.invalidate.forEach((f) => f()));
    }
    return { renderer: this.renderer, resolver: this.resolver as KtMaterialResolver };
  }

  /** Does the material need the flat card preview (opacity / alpha) instead of a sphere? */
  kindFor(materialId: string): PreviewKind {
    return this.ensure()?.resolver.isCutout(materialId) ? 'card' : 'sphere';
  }

  /** Draw `materialId` into `target` (a 2D canvas) at CSS size w x h. */
  render(target: HTMLCanvasElement, materialId: string, w: number, h: number, view: PreviewView, kind: PreviewKind = this.kindFor(materialId)): void {
    const ctx = this.ensure();
    const g = target.getContext('2d');
    if (!ctx || !g) return;
    const pr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.renderer.setPixelRatio(pr);
    ctx.renderer.setSize(w, h, false);
    target.width = Math.round(w * pr);
    target.height = Math.round(h * pr);
    this.camera.aspect = w / h;
    this.camera.position.z = 3.4 / Math.max(0.2, view.zoom);
    this.camera.updateProjectionMatrix();
    const material: Material = ctx.resolver.resolve(materialId);
    this.sphere.visible = kind === 'sphere';
    this.card.visible = kind === 'card';
    const mesh = kind === 'sphere' ? this.sphere : this.card;
    mesh.material = material;
    if (kind === 'card') (material as Material).side = DoubleSide;
    this.pivot.rotation.set(kind === 'sphere' ? view.pitch : 0, kind === 'sphere' ? view.yaw : view.yaw * 0.25, 0);
    this.pivot.position.set(view.panX, view.panY, 0);
    ctx.renderer.render(this.scene, this.camera);
    g.clearRect(0, 0, target.width, target.height);
    g.drawImage(ctx.renderer.domElement, 0, 0, target.width, target.height);
  }

  dispose(): void {
    this.resolver?.dispose();
    this.env?.dispose();
    this.sphere.geometry.dispose();
    this.card.geometry.dispose();
    this.renderer?.dispose();
    this.renderer = null;
    this.resolver = null;
  }
}

let shared: MaterialPreviewRenderer | null = null;
export function getPreviewRenderer(): MaterialPreviewRenderer {
  shared ??= new MaterialPreviewRenderer();
  return shared;
}
