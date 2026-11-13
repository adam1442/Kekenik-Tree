import type { AppState } from '@/contracts/app';
import type { EvaluationSummary } from '@/contracts/engine';
import { CancelledError, CancellationSource, type CancellationToken } from '@/contracts/nodes';
import { createDebugLogger } from '@/core/debugLog';
import { EventBus } from '@/core/eventBus';
import type { Logger } from '@/core/logger';
import type { Store } from '@/core/store';
import { GraphEvaluator, ParamSnapshotCache, snapshotGraph } from '@/graph/engine';
import type { AppEvents } from './context';
import type { GraphSession } from './graphSession';
import { activeDocument } from './state';

/** LOD index per UI level (0 = highest detail). Highest and High share full detail until LOD generation exists (6A). */
export const LOD_INDEX: Record<AppState['lodLevel'], number> = { Highest: 0, High: 0, Medium: 1, Low: 2 };

export interface EngineSettings {
  /** Show a quick low-detail pass first when full detail is slow. */
  progressive: boolean;
  /** LOD used by the quick pass. */
  previewLod: number;
  /** A preview pass is only worth it when the last full pass took longer than this. */
  previewThresholdMs: number;
  /** Synchronous work per slice before yielding to the browser. */
  budgetMs: number;
  /** Delay that coalesces rapid edits (slider scrubbing) into one run. */
  debounceMs: number;
}

export interface EngineEvents {
  started: { run: number };
  /** A pass finished (preview or full). */
  result: EvaluationSummary;
}

export interface EngineDeps {
  store: Store<AppState>;
  events: EventBus<AppEvents>;
  graph: GraphSession;
  logger?: Logger;
}

/**
 * Evaluation host: owns the evaluator + cache, listens to graph/seed/LOD changes and keeps the app in sync.
 *
 * Threading decision: evaluation runs on the MAIN thread, time-sliced (default 8 ms slices, then a macrotask yield)
 * and cancellable (every edit cancels the running pass; finished nodes stay cached). Reasons: node definitions are
 * registered from the main bundle (a worker would have to re-import the whole catalogue and registry), the app ships
 * as a single inlined HTML file, and typical node cost is small once cached. `GraphEvaluator` is DOM-free and works
 * on an immutable `GraphSnapshot` + typed arrays, so a Worker backend can be added later without touching nodes.
 */
export class EngineHost {
  readonly events = new EventBus<EngineEvents>();
  readonly evaluator = new GraphEvaluator();
  settings: EngineSettings = { progressive: true, previewLod: 3, previewThresholdMs: 60, budgetMs: 8, debounceMs: 16 };

  private readonly paramCache = new ParamSnapshotCache();
  private readonly logger: Logger;
  private readonly unsubs: (() => void)[] = [];
  private current: CancellationSource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestResult: EvaluationSummary | null = null;
  private lastFullMs = Infinity;
  private lastProgressPush = 0;
  private runId = 0;
  private disposed = false;

  constructor(private readonly deps: EngineDeps) {
    this.logger = deps.logger ?? createDebugLogger('engine');
    const { store, events, graph } = deps;
    this.unsubs.push(
      events.on('graph:changed', ({ docId }) => {
        if (docId === graph.documentId) this.schedule();
      }),
      events.on('tree:refresh', () => this.schedule(0)),
      events.on('tree:regenerate', () => {
        this.evaluator.cache.clear();
        this.schedule(0);
      }),
      store.select((s) => `${s.activeDocumentId}|${activeDocument(s).seed}|${s.lodLevel}`, () => this.schedule(0)),
      graph.events.on('modelSwapped', () => this.schedule(0)),
    );
  }

  get latest(): EvaluationSummary | null {
    return this.latestResult;
  }

  /** Coalesce requests: the run starts `delayMs` after the LAST request. */
  schedule(delayMs = this.settings.debounceMs): void {
    if (this.disposed) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
  }

  /**
   * Evaluate the current graph at an arbitrary LOD WITHOUT publishing the result.
   * Shares the node cache with the normal runs, so repeated calls are cheap. Throws `CancelledError` when cancelled.
   */
  evaluateAt(lod: number, token: CancellationToken, onProgress?: (done: number, total: number) => void): Promise<EvaluationSummary> {
    const { store, graph } = this.deps;
    const snap = snapshotGraph(graph.model, this.paramCache);
    return this.evaluator.evaluate(snap, { seed: activeDocument(store.get()).seed, lod, token, budgetMs: this.settings.budgetMs, logger: this.logger, onProgress });
  }

  /** Cancel the running pass (the next scheduled run starts from the cache). */
  cancel(): void {
    this.current?.cancel();
  }

  /** Evaluate now and resolve when the (full-detail) pass is done or was superseded. Used by tests and exporters. */
  async run(): Promise<EvaluationSummary | null> {
    if (this.disposed) return null;
    const { store, graph } = this.deps;
    this.current?.cancel();
    const source = new CancellationSource();
    this.current = source;
    const run = ++this.runId;
    this.events.emit('started', { run });
    const snap = snapshotGraph(graph.model, this.paramCache);
    const seed = activeDocument(store.get()).seed;
    const lod = LOD_INDEX[store.get().lodLevel];
    const common = {
      seed,
      token: source.token,
      budgetMs: this.settings.budgetMs,
      logger: this.logger,
      onProgress: (done: number, total: number): void => {
        const t = performance.now();
        if (t - this.lastProgressPush < 60 && done < total) return;
        this.lastProgressPush = t;
        store.set({ evaluationProgress: total === 0 ? 1 : done / total });
      },
    };
    const wantPreview = this.settings.progressive && lod < this.settings.previewLod && this.lastFullMs > this.settings.previewThresholdMs;
    store.set({ evaluating: true, evaluationProgress: 0 });
    try {
      if (wantPreview) {
        const quick = await this.evaluator.evaluate(snap, { ...common, lod: this.settings.previewLod, preview: true });
        if (source.token.cancelled) return null;
        this.publish(quick);
      }
      const full = await this.evaluator.evaluate(snap, { ...common, lod });
      if (source.token.cancelled) return null;
      this.lastFullMs = full.totalMs;
      this.publish(full);
      return full;
    } catch (err) {
      if (err instanceof CancelledError) return null;
      this.logger.error(`Evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      if (this.current === source) {
        this.current = null;
        store.set({ evaluating: false, evaluationProgress: 1 });
      }
    }
  }

  private publish(s: EvaluationSummary): void {
    const { store, graph } = this.deps;
    this.latestResult = s;
    graph.setDiagnostics(s.diagnostics);
    graph.setEdgeLabels(s.edgeLabels);
    graph.setRootInfo(s.scene.stats.totalInstances > 0 ? `Nodes ${s.scene.stats.totalInstances.toLocaleString('en-US')}` : null);
    store.set((st) => ({
      evaluationPreview: s.preview,
      stats: { ...st.stats, triangles: s.scene.stats.triangles, vertices: s.scene.stats.vertices, generationMs: s.totalMs },
    }));
    this.events.emit('result', s);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.current?.cancel();
    this.unsubs.forEach((u) => u());
    this.events.clear();
  }
}
