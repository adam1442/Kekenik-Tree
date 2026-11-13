import { BufferAttribute, type Material, type Mesh, type MeshDepthMaterial } from 'three';
import type { WindSettings } from '@/contracts/material';
import { applyWindToMaterial, createWindDepthMaterial, createWindUniforms, createWindVariant, type WindUniforms } from './windMaterials';
import { clampWindParams, windParamsFromSettings, type MeshWindOverride, type WindParams } from './windParams';

const NEUTRAL_KEY = '1|1|-1|1';
const overrideKey = (o: MeshWindOverride | undefined): string => (o ? `${o.amount}|${o.flutter}|${o.stiffness}|${o.flutterFrequency}` : NEUTRAL_KEY);

export type WindQuality = 'high' | 'low';

export interface WindPreviewState {
  playing: boolean;
  timeScale: number;
  quality: WindQuality;
  showArrow: boolean;
  /** Simulation clock in (speed scaled) seconds. */
  clock: number;
  loop: boolean;
  loopLength: number;
}

interface Host {
  setAnimating(on: boolean): void;
  requestRender(): void;
  addBeforeRender(fn: (dt: number) => void): () => void;
}

/**
 * Wind preview runtime. Owns the shared uniforms; all animation is evaluated on the GPU, so a frame costs one clock
 * increment and five uniform uploads regardless of the geometry size.
 */
export class WindSystem {
  readonly uniforms: WindUniforms = createWindUniforms();
  readonly state: WindPreviewState = { playing: true, timeScale: 1, quality: 'high', showArrow: true, clock: 0, loop: false, loopLength: 60 };
  private readonly depths = new Map<string, MeshDepthMaterial>();
  private readonly variants = new Map<Material, Map<string, Material>>();
  private project: WindParams = clampWindParams(windParamsFromSettings(null));
  private scene: WindSettings | null = null;
  private height = 10;
  private host: Host | null = null;
  private unhook: (() => void) | null = null;
  private signature = '';
  private readonly listeners = new Set<() => void>();

  /** Effective parameters: a Wind node attached to the Tree overrides the project settings. */
  get params(): WindParams {
    return this.scene ? windParamsFromSettings(this.scene) : this.project;
  }

  /** True when a Wind node attached to the Tree replaces the project settings. */
  get overridden(): boolean {
    return this.scene !== null;
  }

  get enabled(): boolean {
    return this.params.enabled;
  }

  get treeHeight(): number {
    return this.height;
  }

  /** Bind to a viewport: installs the per-frame clock update. */
  bind(host: Host): void {
    this.host = host;
    this.unhook?.();
    this.unhook = host.addBeforeRender((dt) => this.tick(dt));
    this.pushUniforms();
    this.updateAnimating();
  }

  unbind(host: Host): void {
    if (this.host !== host) return;
    this.unhook?.();
    this.unhook = null;
    host.setAnimating(false);
    this.host = null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Project-level settings (polled by the viewport panel, cheap when unchanged). */
  syncProject(settings: WindSettings | null | undefined): void {
    const sig = settings ? JSON.stringify(settings) : '';
    if (sig === this.signature) return;
    this.signature = sig;
    this.project = windParamsFromSettings(settings);
    this.changed();
  }

  /** Wind node attached to the Tree output (graph-level wind). */
  setSceneWind(settings: WindSettings | null): void {
    const sig = JSON.stringify(settings);
    if (sig === JSON.stringify(this.scene)) return;
    this.scene = settings;
    this.changed();
  }

  setTreeHeight(h: number): void {
    const next = Number.isFinite(h) ? Math.max(0.5, h) : 10;
    if (Math.abs(next - this.height) < 1e-3) return;
    this.height = next;
    this.pushUniforms();
    this.host?.requestRender();
  }

  patchState(patch: Partial<WindPreviewState>): void {
    Object.assign(this.state, patch);
    this.changed();
  }

  /** Move the simulation clock (timeline scrub). */
  scrub(clock: number): void {
    this.state.clock = Math.max(0, clock);
    this.pushUniforms();
    this.host?.requestRender();
    this.listeners.forEach((l) => l());
  }

  /** Make a material wind-aware (see `applyWindToMaterial`). */
  decorateMaterial(material: Material | Material[]): void {
    for (const m of Array.isArray(material) ? material : [material]) applyWindToMaterial(m, this.uniforms);
  }

  /**
   * Make a scene mesh wind-aware: materials, shadow depth material and per-mesh override. Idempotent; call again when
   * the override changes. The un-overridden material stays in `userData.windBase`.
   */
  decorateMesh(mesh: Mesh, override?: MeshWindOverride): void {
    this.ensureAttributes(mesh);
    const key = overrideKey(override);
    const prevBase = (mesh.userData.baseMaterial as Material | Material[] | undefined) ?? mesh.material;
    const base = (mesh.userData.windBase as Material | Material[] | undefined) ?? prevBase;
    if (mesh.userData.windKey === key && mesh.userData.windBase === base && prevBase !== base) return;
    const swapped = mesh.material !== prevBase;
    const next = Array.isArray(base) ? base.map((m) => this.variant(m, override, key)) : this.variant(base, override, key);
    mesh.userData.windBase = base;
    mesh.userData.windKey = key;
    mesh.userData.baseMaterial = next;
    if (!swapped) mesh.material = next;
    mesh.customDepthMaterial = this.depthVariant(override, key);
  }

  /** Meshes without wind data get zero weights (an undeclared attribute would read stale generic values). */
  private ensureAttributes(mesh: Mesh): void {
    const geo = mesh.geometry;
    if (geo.getAttribute('windWeights')) return;
    const count = geo.getAttribute('position')?.count ?? 0;
    geo.setAttribute('windPivot', new BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('windWeights', new BufferAttribute(new Float32Array(count * 4), 4));
  }

  private variant(base: Material, override: MeshWindOverride | undefined, key: string): Material {
    if (key === NEUTRAL_KEY) {
      applyWindToMaterial(base, this.uniforms);
      return base;
    }
    let byKey = this.variants.get(base);
    if (!byKey) {
      byKey = new Map();
      this.variants.set(base, byKey);
      base.addEventListener('dispose', () => {
        this.variants.get(base)?.forEach((v) => v.dispose());
        this.variants.delete(base);
      });
    }
    let v = byKey.get(key);
    if (!v && override) {
      v = createWindVariant(base, this.uniforms, override);
      byKey.set(key, v);
    }
    return v ?? base;
  }

  private depthVariant(override: MeshWindOverride | undefined, key: string): MeshDepthMaterial {
    let d = this.depths.get(key);
    if (!d) {
      d = createWindDepthMaterial(this.uniforms, override);
      this.depths.set(key, d);
    }
    return d;
  }

  dispose(): void {
    this.depths.forEach((d) => d.dispose());
    this.depths.clear();
    this.variants.forEach((byKey) => byKey.forEach((v) => v.dispose()));
    this.variants.clear();
    this.listeners.clear();
  }

  private tick(dt: number): void {
    if (this.state.playing && this.enabled) {
      const c = this.state.clock + dt * this.state.timeScale * this.params.speed;
      this.state.clock = this.state.loop ? c % this.state.loopLength : c;
      this.pushUniforms();
      this.listeners.forEach((l) => l());
    }
  }

  private changed(): void {
    this.pushUniforms();
    this.updateAnimating();
    this.host?.requestRender();
    this.listeners.forEach((l) => l());
  }

  private updateAnimating(): void {
    this.host?.setAnimating(this.enabled && this.state.playing);
  }

  private pushUniforms(): void {
    const p = this.params;
    const rad = (p.directionDeg * Math.PI) / 180;
    this.uniforms.a.value.set(Math.cos(rad), Math.sin(rad), p.enabled ? p.strength : 0, p.gustStrength);
    this.uniforms.b.value.set(p.gustFrequency, p.turbulence, p.ripple, this.state.quality === 'high' ? 1 : 0);
    this.uniforms.c.value.set(p.trunkResponse, p.branchResponse, p.leafResponse, p.stiffness);
    this.uniforms.d.value.set(p.damping, this.state.clock, this.height, p.baseHold);
  }
}

let instance: WindSystem | null = null;

/** Process-wide wind runtime (one set of uniforms shared by all viewports). */
export function getWindSystem(): WindSystem {
  instance ??= new WindSystem();
  return instance;
}
