import { buildCoverageMipChain, type CoverageChannel, type MipLevel } from './alphaCoverage';
import type { CoverageJob, CoverageResult } from './alphaCoverage.worker';

/** Largest edge (px) that gets coverage mips; bigger images keep GPU mips (plus the sharpened-alpha shader). */
export const COVERAGE_MAX_EDGE = 2048;
const CACHE_LIMIT_BYTES = 96 * 1024 * 1024;

interface WorkerLike {
  postMessage(job: CoverageJob, transfer: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<CoverageResult>) => void): void;
  addEventListener(type: 'error', fn: () => void): void;
}

const cache = new Map<string, MipLevel[]>();
const waiting = new Map<number, (levels: MipLevel[]) => void>();
let worker: WorkerLike | null = null;
let workerFailed = typeof Worker === 'undefined';
let workerPromise: Promise<WorkerLike | null> | null = null;
let nextId = 1;

function cacheBytes(): number {
  let n = 0;
  for (const levels of cache.values()) for (const l of levels) n += l.data.byteLength;
  return n;
}

function remember(key: string, levels: MipLevel[]): void {
  cache.set(key, levels);
  while (cacheBytes() > CACHE_LIMIT_BYTES && cache.size > 1) {
    const oldest = cache.keys().next().value as string;
    cache.delete(oldest);
  }
}

async function getWorker(): Promise<WorkerLike | null> {
  if (worker || workerFailed) return worker;
  workerPromise ??= (async () => {
    try {
      const mod = await import('./alphaCoverage.worker?worker&inline');
      const w = new mod.default() as unknown as WorkerLike;
      w.addEventListener('message', (e) => {
        waiting.get(e.data.id)?.(e.data.levels);
        waiting.delete(e.data.id);
      });
      w.addEventListener('error', () => {
        workerFailed = true;
        worker = null;
        waiting.forEach((resolve) => resolve([]));
        waiting.clear();
      });
      worker = w;
      return w;
    } catch {
      workerFailed = true;
      return null;
    }
  })();
  return workerPromise;
}

export interface CoverageRequest {
  /** Identity of (image content, resolution) - normally the asset hash + resolution. */
  imageKey: string;
  width: number;
  height: number;
  /** RGBA pixels (ownership is taken: the buffer may be transferred to the worker). */
  data: Uint8Array;
  channel: CoverageChannel;
  cutoff: number;
}

export const coverageCacheKey = (r: Pick<CoverageRequest, 'imageKey' | 'channel' | 'cutoff'>): string => `${r.imageKey}|${r.channel}|${r.cutoff.toFixed(2)}`;

/** Mip chain with preserved alpha coverage (empty array on failure); computed in a worker, cached by image hash. */
export async function computeCoverageMips(req: CoverageRequest): Promise<MipLevel[]> {
  const key = coverageCacheKey(req);
  const hit = cache.get(key);
  if (hit) return hit;
  const w = await getWorker();
  let levels: MipLevel[];
  if (w) {
    const id = nextId++;
    levels = await new Promise<MipLevel[]>((resolve) => {
      waiting.set(id, resolve);
      w.postMessage({ id, width: req.width, height: req.height, data: req.data, channel: req.channel, cutoff: req.cutoff }, [req.data.buffer]);
    });
  } else {
    levels = buildCoverageMipChain({ width: req.width, height: req.height, data: req.data }, { channel: req.channel, cutoff: req.cutoff });
  }
  if (levels.length > 0) remember(key, levels);
  return levels;
}

