import { OUTPUT_KEY, type EvaluationSummary, type NodeDiagnostic, type NodeMessage, type NodeState } from '@/contracts/engine';
import { meshTriangleCount } from '@/contracts/mesh';
import { CancelledError, type CancellationToken, type NodeDef, type NodeInputs, type NodeOutputs } from '@/contracts/nodes';
import { getNumber } from '@/contracts/params';
import type { PortValue } from '@/contracts/ports';
import { createLogger, type Logger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { getParentAttachments } from '@/geometry/attachments';
import { getNodeDef } from '@/graph/registry';
import { PORT } from '@/graph/ports';
import { assembleScene, type NodeResult } from './assemble';
import { EvalCache, estimateBytes } from './cache';
import { hashString } from './hash';
import { now, yieldToEventLoop } from './scheduler';
import { deriveNodeSeed } from './seeds';
import type { GraphSnapshot, SnapshotEdge, SnapshotNode } from './snapshot';
import { topologicalOrder, upstreamOf } from './topology';

export interface EvaluateOptions {
  /** Project (global) seed. */
  seed: number;
  /** 0 = highest detail. Part of every cache key. */
  lod: number;
  token: CancellationToken;
  preview?: boolean;
  /** Max milliseconds of synchronous work before yielding to the event loop (default 8). */
  budgetMs?: number;
  yieldFn?: () => Promise<void>;
  lookup?: (type: string) => NodeDef | undefined;
  onProgress?: (done: number, total: number, nodeId: string) => void;
  logger?: Logger;
}

const KEY_VERSION = 'k1';

/** Node categories whose output embeds the node's display name (so renaming must invalidate them). */
const NAMED_CATEGORIES = new Set(['force', 'material', 'mesh', 'wind', 'utility']);

function countTriangles(outputs: NodeOutputs): number {
  const g = outputs[OUTPUT_KEY.geometry];
  return g && g.kind === 'Mesh' ? meshTriangleCount(g.value) : 0;
}

function countInstances(outputs: NodeOutputs): number {
  const i = outputs[OUTPUT_KEY.instances];
  if (i && i.kind === 'Scalar') return i.value;
  const c = outputs[PORT.children];
  return c && c.kind === 'Structure' ? c.value.skeleton.branches.length : 0;
}

function countSkeletonStats(outputs: NodeOutputs): { branches: number; points: number } {
  const bOut = outputs[OUTPUT_KEY.branchCount];
  const pOut = outputs[OUTPUT_KEY.pointCount];
  const c = outputs[PORT.children];
  const sk = c && c.kind === 'Structure' ? c.value.skeleton : null;
  return {
    branches: bOut && bOut.kind === 'Scalar' ? bOut.value : sk ? sk.branches.length : 0,
    points: pOut && pOut.kind === 'Scalar' ? pOut.value : sk ? sk.count : 0,
  };
}

function validateOutputs(raw: unknown): NodeOutputs {
  if (typeof raw !== 'object' || raw === null) throw new Error('evaluate() must return an object of port values');
  const out: NodeOutputs = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'object' || v === null || typeof (v as { kind?: unknown }).kind !== 'string') throw new Error(`Output "${k}" is not a tagged port value`);
    out[k] = v as PortValue;
  }
  return out;
}

/**
 * Graph evaluator: topological, cached, cancellable, time-sliced.
 *
 * Caching: each node's result is stored under a content key =
 *   hash(type, version, params hash, derived node seed, lod, keys of all inputs [, name]).
 * Because input keys are part of the key, an edit invalidates exactly the edited node and its downstream nodes (dirty
 * propagation falls out of the key chain); siblings and ancestors hit the cache. The cache is shared by all runs
 * (preview and full detail, undo/redo ping-pong) and bounded by bytes (LRU).
 *
 * Cancellation: `token` is checked between nodes and handed to node code. Results of nodes finished before a
 * cancellation stay cached, so a restarted run resumes cheaply.
 */
export class GraphEvaluator {
  readonly cache: EvalCache;
  private runCounter = 0;

  constructor(cache: EvalCache = new EvalCache()) {
    this.cache = cache;
  }

  async evaluate(snap: GraphSnapshot, opts: EvaluateOptions): Promise<EvaluationSummary> {
    const lookup = opts.lookup ?? getNodeDef;
    const run = ++this.runCounter;
    const t0 = now();
    const budget = opts.budgetMs ?? 8;
    const yieldFn = opts.yieldFn ?? yieldToEventLoop;
    const baseLogger = opts.logger ?? createLogger('engine', 'warn');
    const byId = new Map(snap.nodes.map((n) => [n.id, n]));
    const incoming = new Map<string, SnapshotEdge[]>();
    for (const e of snap.edges) {
      const list = incoming.get(e.toNode);
      if (list) list.push(e);
      else incoming.set(e.toNode, [e]);
    }
    const { order, cyclic } = topologicalOrder(snap);
    const diagnostics = new Map<string, NodeDiagnostic>();
    const results = new Map<string, NodeResult>();
    const diag = (nodeId: string, state: NodeState, extra: Partial<NodeDiagnostic> = {}): NodeDiagnostic => {
      const d: NodeDiagnostic = { nodeId, state, ms: 0, messages: [], triangles: 0, instances: 0, ...extra };
      diagnostics.set(nodeId, d);
      return d;
    };
    for (const id of cyclic) diag(id, 'error', { messages: [{ level: 'error', text: 'The graph contains a cycle through this node.' }] });

    // Solo: evaluate only the soloed nodes and everything they depend on.
    const solos = snap.nodes.filter((n) => n.solo && n.enabled).map((n) => n.id);
    const needed = solos.length > 0 ? upstreamOf(snap, solos) : null;

    let evaluated = 0;
    let cached = 0;
    let skipped = 0;
    let errors = cyclic.length;
    let sliceStart = now();

    let done = 0;
    for (const id of order) {
      const node = byId.get(id) as SnapshotNode;
      opts.token.throwIfCancelled();
      if (now() - sliceStart > budget) {
        await yieldFn();
        opts.token.throwIfCancelled();
        sliceStart = now();
      }
      done += 1;
      opts.onProgress?.(done, order.length, id);
      const def = lookup(node.type);
      const skip = (): void => {
        skipped += 1;
        diag(id, 'skipped');
        results.set(id, { key: '', outputs: {}, visible: false, instances: 0 });
      };
      if (!def) {
        errors += 1;
        diag(id, 'error', { messages: [{ level: 'error', text: `Unknown node type "${node.type}".` }] });
        results.set(id, { key: '', outputs: {}, visible: false, instances: 0 });
        continue;
      }
      if (!node.enabled || (needed && !needed.has(id))) {
        skip();
        continue;
      }
      // Gather inputs.
      const inputs: NodeInputs = {};
      const inputTokens: string[] = [];
      let blockedBy: string | null = null;
      let lineageOff = false;
      for (const e of incoming.get(id) ?? []) {
        const src = results.get(e.fromNode);
        const srcDiag = diagnostics.get(e.fromNode);
        const hierarchy = e.kind === 'hierarchy';
        if (!src) {
          // Source is on a cycle (never evaluated).
          if (hierarchy) blockedBy = e.fromNode;
          continue;
        }
        if (srcDiag?.state === 'error' || srcDiag?.state === 'blocked') {
          if (hierarchy) blockedBy = e.fromNode;
          continue;
        }
        if (srcDiag?.state === 'skipped') {
          if (hierarchy) lineageOff = true;
          continue;
        }
        const value = src.outputs[e.fromPort];
        inputTokens.push(`${e.toPort}<${e.fromNode}.${e.fromPort}=${src.key}`);
        if (value) (inputs[e.toPort] ??= []).push(value);
      }
      if (lineageOff) {
        skip();
        continue;
      }
      if (blockedBy) {
        skipped += 1;
        diag(id, 'blocked', { messages: [{ level: 'error', text: `Blocked: upstream node "${byId.get(blockedBy)?.name ?? blockedBy}" failed.` }] });
        results.set(id, { key: '', outputs: {}, visible: false, instances: 0 });
        continue;
      }
      if (node.bypass) {
        if (!node.hierarchy) {
          skip();
          continue;
        }
        // Pass the structure through; descendants see the grandparent as if this node did not exist.
        const through = inputs[PORT.parent]?.[0];
        const outputs: NodeOutputs = through ? { [PORT.children]: through } : {};
        const key = hashString(`${KEY_VERSION}|bypass|${inputTokens.sort().join(',')}`);
        diag(id, 'bypassed');
        results.set(id, { key, outputs, visible: false, instances: 0 });
        continue;
      }
      inputTokens.sort();
      const perNodeSeed = getNumber(node.params, 'seed', 0);
      const nodeSeed = deriveNodeSeed(opts.seed, id, perNodeSeed);
      const named = NAMED_CATEGORIES.has(def.category) ? `|${node.name}` : '';
      const key = `${id}:${hashString([KEY_VERSION, def.type, def.version ?? 1, node.paramsHash, nodeSeed, opts.lod, inputTokens.join(','), named, def.dependencyKey?.(node.params) ?? ''].join('|'))}`;
      const hit = this.cache.get(key);
      if (hit) {
        cached += 1;
        if (hit.error) {
          errors += 1;
          diag(id, 'error', { messages: [{ level: 'error', text: hit.error }, ...hit.messages] });
          results.set(id, { key, outputs: {}, visible: false, instances: 0 });
        } else {
          diag(id, 'cached', { messages: hit.messages, triangles: hit.triangles, instances: hit.instances, branches: hit.branches, points: hit.points });
          results.set(id, { key, outputs: hit.outputs, visible: true, instances: hit.instances });
        }
        continue;
      }
      // Miss: run the node.
      const messages: NodeMessage[] = [];
      const logger = capturingLogger(baseLogger.child(node.name), messages);
      const started = now();
      try {
        const parentIn = inputs[PORT.parent]?.[0];
        const parentAttach = parentIn && parentIn.kind === 'Structure' ? parentIn.value.attachments : undefined;
        const raw = await def.evaluate({ nodeId: id, name: node.name, rng: new Rng(nodeSeed), seed: nodeSeed, cancel: opts.token, lod: opts.lod, logger, getParentAttachments: (key) => getParentAttachments(parentAttach, key) }, inputs, node.params);
        opts.token.throwIfCancelled();
        const outputs = validateOutputs(raw);
        const ms = now() - started;
        const triangles = countTriangles(outputs);
        const instances = countInstances(outputs);
        const { branches, points } = countSkeletonStats(outputs);
        this.cache.set({ key, nodeId: id, outputs, messages, ms, triangles, instances, branches, points, bytes: estimateBytes(outputs) });
        evaluated += 1;
        diag(id, 'ok', { ms, messages, triangles, instances, branches, points });
        results.set(id, { key, outputs, visible: true, instances });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const text = err instanceof Error ? err.message : String(err);
        const ms = now() - started;
        errors += 1;
        this.cache.set({ key, nodeId: id, outputs: {}, error: text, messages, ms, triangles: 0, instances: 0, bytes: 512 });
        diag(id, 'error', { ms, messages: [{ level: 'error', text }, ...messages] });
        results.set(id, { key, outputs: {}, visible: false, instances: 0 });
        baseLogger.error(`Node "${node.name}" (${node.type}) failed: ${text}`);
      }
      sliceStart = Math.min(sliceStart, now());
    }

    this.cache.retainNodes(new Set(snap.nodes.map((n) => n.id)));
    const scene = assembleScene(snap, order, results, lookup);
    const edgeLabels = new Map<string, string>();
    for (const e of snap.edges) {
      if (e.kind !== 'hierarchy') continue;
      const n = results.get(e.toNode)?.instances ?? 0;
      if (n > 0) edgeLabels.set(e.id, n.toLocaleString('en-US'));
    }
    return { run, lod: opts.lod, preview: opts.preview ?? false, totalMs: now() - t0, evaluated, cached, skipped, errors, diagnostics, edgeLabels, scene };
  }
}

/** Logger handed to node code: warnings/errors are captured for the node badge and forwarded to the console logger. */
function capturingLogger(base: Logger, sink: NodeMessage[]): Logger {
  const push = (level: 'warn' | 'error', message: string): void => {
    if (!sink.some((m) => m.text === message)) sink.push({ level, text: message });
  };
  return {
    debug: (m, ...d) => base.debug(m, ...d),
    info: (m, ...d) => base.info(m, ...d),
    warn: (m, ...d) => {
      push('warn', m);
      base.warn(m, ...d);
    },
    error: (m, ...d) => {
      push('error', m);
      base.error(m, ...d);
    },
    child: (s) => capturingLogger(base.child(s), sink),
  };
}
