import type { AppContext } from '@/app/context';
import { activeDocument } from '@/app/state';
import type { EvaluationSummary, SceneModel } from '@/contracts/engine';
import { CancelledError, CancellationSource } from '@/contracts/nodes';
import { hashString } from '@/core/rng';
import { getLodSettings, onLodSettingsChange } from '../settings';
import type { LodLevelSettings } from '../types';
import { exportLevelsFor, modelOf } from './dynamicLevels';
import { applyDynamicLod, defaultDynamicLodConfig, lodNodeScales, lodReport, lodValueForScreen, type DynamicLodConfig, type DynamicLodMode, type DynamicLodModel } from '@/lod/dynamic';
import { buildLods } from './lodBuilder';
import { lodForFraction, screenFraction, sceneHeight } from './lodScene';

export type PreviewMode = 'off' | 'auto' | number;

/** Viewport-side Dynamic LOD controls: they override the Tree settings until the Tree's Dynamic LOD group changes. */
export interface DynamicPreviewOverride {
  enabled?: boolean;
  mode?: DynamicLodMode;
  value?: number;
}

/** What the toolbar / viewport corner show about the Dynamic LOD. */
export interface DynamicPreviewInfo {
  enabled: boolean;
  mode: DynamicLodMode;
  /** LOD value in use (the slider in manual mode, from the camera distance in screen-area mode). */
  value: number;
  triangles: number;
  fullTriangles: number;
  interiorRemovedShare: number;
}

export interface PreviewInfo {
  activeLod: number;
  /** Plant height as a fraction of the viewport height at the current / simulated distance. */
  fraction: number;
  distance: number;
  height: number;
  triangles: number[];
  building: boolean;
  ready: boolean;
}

/**
 * Viewport LOD preview. The viewport asks `resolve(summary)` which scene to draw: the engine's own result, or
 * the generated LOD scene. Modes: off · a fixed LOD · auto (LOD picked from the camera distance or a simulated distance).
 */
export class LodPreview {
  mode: PreviewMode = 'off';
  /** Auto mode: use `simulatedDistance` instead of the real camera distance. */
  simulate = false;
  simulatedDistance = 20;

  private scenes: SceneModel[] = [];
  private builtFp = '';
  private lastFull: EvaluationSummary | null = null;
  private settingsVersion = 0;
  private builtVersion = -1;
  private building: CancellationSource | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activeLod = 0;
  private dynOverride: DynamicPreviewOverride = {};
  private dynBase = '';
  private dynLast: DynamicPreviewInfo | null = null;
  private dynValue = 0;
  private app: AppContext | null = null;
  private readonly listeners = new Set<() => void>();
  private unsubs: (() => void)[] = [];

  attach(app: AppContext): () => void {
    this.app = app;
    this.lastFull = app.engine.latest && !app.engine.latest.preview ? app.engine.latest : null;
    this.unsubs = [
      app.engine.events.on('result', (s) => {
        if (!s.preview) this.lastFull = s;
      }),
      onLodSettingsChange(() => {
        this.settingsVersion++;
        if (this.mode !== 'off') this.schedule();
        this.emit();
      }),
      app.store.select((s) => s.stats.cameraDistance, () => {
        if (this.mode === 'auto' && !this.simulate) this.refreshActive();
        this.refreshDynamicValue();
      }),
    ];
    return () => {
      this.unsubs.forEach((u) => u());
      this.building?.cancel();
      if (this.timer) clearTimeout(this.timer);
      this.listeners.clear();
      this.app = null;
    };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  setMode(mode: PreviewMode): void {
    this.mode = mode;
    if (mode !== 'off') {
      this.refreshActive(false);
      if (!this.isFresh()) this.schedule(0);
    }
    this.emit();
  }

  setSimulation(on: boolean, distance = this.simulatedDistance): void {
    this.simulate = on;
    this.simulatedDistance = Math.max(0.1, distance);
    this.refreshActive();
  }

  private isFresh(): boolean {
    return this.scenes.length > 0 && this.builtVersion === this.settingsVersion && this.lastFull !== null && this.builtFp === fingerprint(this.lastFull);
  }

  /** Change the viewport's Dynamic LOD controls (the graph is not re-evaluated). */
  setDynamic(patch: DynamicPreviewOverride): void {
    this.dynOverride = { ...this.dynOverride, ...patch };
    this.emit();
  }

  /** Effective Dynamic LOD state of the latest result (null before the first one). */
  dynamicInfo(): DynamicPreviewInfo | null {
    const scene = this.lastFull?.scene ?? this.app?.engine.latest?.scene;
    if (!scene) return null;
    const cfg = this.dynamicConfig(scene);
    const info = this.dynLast;
    if (!cfg.enabled) return { enabled: false, mode: cfg.mode, value: 0, triangles: scene.stats.triangles, fullTriangles: scene.stats.triangles, interiorRemovedShare: 0 };
    return info ?? { enabled: true, mode: cfg.mode, value: this.dynValue, triangles: scene.stats.triangles, fullTriangles: scene.stats.triangles, interiorRemovedShare: 0 };
  }

  /** Tree settings merged with the viewport override (the override is dropped when the Tree's group changed). */
  private dynamicConfig(scene: SceneModel): DynamicLodConfig & { enabled: boolean } {
    const base = scene.dynamicLod ?? defaultDynamicLodConfig();
    const key = JSON.stringify(base);
    if (key !== this.dynBase) {
      this.dynBase = key;
      this.dynOverride = {};
    }
    return { ...base, enabled: this.dynOverride.enabled ?? base.enabled, mode: this.dynOverride.mode ?? base.mode, value: this.dynOverride.value ?? base.value };
  }

  private dynamicValue(cfg: DynamicLodConfig, model: DynamicLodModel): number {
    if (cfg.mode === 'manual') return cfg.value;
    if (model.radius <= 0) return 0;
    return lodValueForScreen(screenFraction(this.currentDistance(), model.radius * 2, this.fov()));
  }

  /** Screen-area mode: re-apply when the camera moved far enough to change the LOD value. */
  private refreshDynamicValue(): void {
    const scene = this.lastFull?.scene;
    if (!scene || this.mode !== 'off') return;
    const cfg = this.dynamicConfig(scene);
    if (!cfg.enabled || cfg.mode !== 'screen') return;
    const next = this.dynamicValue(cfg, modelOf(scene, this.seed()));
    if (Math.abs(next - this.dynValue) >= 0.01) this.emit();
  }

  private seed(): number {
    return this.app ? activeDocument(this.app.store.get()).seed : 0;
  }

  private resolveDynamic(summary: EvaluationSummary): SceneModel {
    const scene = summary.scene;
    const cfg = this.dynamicConfig(scene);
    if (!cfg.enabled) {
      this.dynLast = null;
      return scene;
    }
    const model = modelOf(scene, this.seed());
    const value = Math.round(this.dynamicValue(cfg, model) * 200) / 200;
    this.dynValue = value;
    const scales = lodNodeScales(model, cfg, value);
    const report = lodReport(model, scales, value);
    const out = applyDynamicLod(scene, model, cfg, value);
    this.dynLast = { enabled: true, mode: cfg.mode, value, triangles: out.stats.triangles, fullTriangles: report.fullTriangles, interiorRemovedShare: report.interiorRemovedShare };
    return out;
  }

  /** Which scene should the viewport draw for this engine result? */
  resolve(summary: EvaluationSummary): SceneModel {
    if (summary.preview) return summary.scene;
    if (this.mode === 'off') return this.resolveDynamic(summary);
    if (this.builtFp === fingerprint(summary) && this.builtVersion === this.settingsVersion && this.scenes.length > 0) {
      return this.scenes[Math.min(this.activeLod, this.scenes.length - 1)] as SceneModel;
    }
    this.schedule();
    return summary.scene;
  }

  /** Generated LOD scenes (empty until the first build). */
  get builtScenes(): readonly SceneModel[] {
    return this.scenes;
  }

  /** Make sure the LOD scenes match the current graph and settings. */
  async ensureBuilt(): Promise<void> {
    // Concurrent callers share one build; a build superseded by a newer one is retried (bounded).
    for (let attempt = 0; attempt < 3 && !this.isFresh(); attempt++) {
      this.pending ??= this.build().finally(() => {
        this.pending = null;
      });
      await this.pending;
    }
  }

  info(): PreviewInfo {
    const height = this.scenes[0] ? sceneHeight(this.scenes[0]).height : 0;
    const distance = this.currentDistance();
    return {
      activeLod: this.activeLod,
      fraction: height > 0 ? screenFraction(distance, height, this.fov()) : 0,
      distance,
      height,
      triangles: this.scenes.map((s) => s.stats.triangles),
      building: this.building !== null,
      ready: this.isFresh(),
    };
  }

  private fov(): number {
    return this.app?.viewport?.camera.fov ?? 35;
  }

  private currentDistance(): number {
    return this.simulate ? this.simulatedDistance : (this.app?.store.get().stats.cameraDistance ?? this.simulatedDistance);
  }

  /** The LOD levels in use: the export settings, or the Tree's Levels count while Dynamic LOD is enabled. */
  levels(): LodLevelSettings[] {
    return exportLevelsFor(getLodSettings().levels, this.lastFull?.scene);
  }

  private refreshActive(notify = true): void {
    const levels = this.levels();
    let next = this.activeLod;
    if (typeof this.mode === 'number') next = Math.min(this.mode, levels.length - 1);
    else if (this.mode === 'auto') {
      const height = this.scenes[0] ? sceneHeight(this.scenes[0]).height : 0;
      next = height > 0 ? lodForFraction(levels, screenFraction(this.currentDistance(), height, this.fov())) : 0;
    }
    const changed = next !== this.activeLod;
    this.activeLod = next;
    if (notify && (changed || this.simulate)) {
      this.emit();
    }
  }

  private schedule(delay = 250): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.build();
    }, delay);
  }

  /** Generate every LOD of the current graph (cancellable, reuses the engine cache). Resolves when done. */
  async build(): Promise<void> {
    const app = this.app;
    if (!app) return;
    this.building?.cancel();
    const source = new CancellationSource();
    this.building = source;
    this.emit();
    const levels = this.levels();
    const version = this.settingsVersion;
    const basis = this.lastFull;
    if (!basis) {
      this.building = null;
      return;
    }
    const fp = fingerprint(basis);
    try {
      const built = await buildLods(
        { evaluateAt: (lod, token, p) => app.engine.evaluateAt(lod, token, p), seed: activeDocument(app.store.get()).seed },
        levels,
        levels.map((_, i) => i),
        source.token,
      );
      if (source.token.cancelled) return;
      this.scenes = built.map((b) => b.scene);
      this.builtFp = fp;
      this.builtVersion = version;
      this.refreshActive(false);
    } catch (e) {
      if (!(e instanceof CancelledError)) app.notify(`LOD generation failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (this.building === source) this.building = null;
      this.emit();
    }
  }
}

/** Identity of a generated plant: the revision tokens of its pieces (stable across no-op re-runs). */
function fingerprint(s: EvaluationSummary): string {
  const dyn = s.scene.dynamicLod?.enabled ? JSON.stringify(s.scene.dynamicLod) : '';
  return String(hashString(s.scene.entries.map((e) => e.rev).join('|') + dyn));
}

let instance: LodPreview | null = null;

export function getLodPreview(): LodPreview {
  instance ??= new LodPreview();
  return instance;
}
