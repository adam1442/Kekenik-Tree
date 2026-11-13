import type { CancellationToken } from '@/contracts/nodes';
import { CancelledError } from '@/contracts/nodes';
import type { PlantGeometry } from '../geometry';
import { geometryBounds } from '../geometry';
import type { BakeSettings } from '../types';
import type { AoJob, AoMessage } from './aoBake.worker';
import { applyAoToGeometry, buildAoField, computeAoRange, concatForBake } from './aoCore';

interface WorkerLike {
  postMessage(job: AoJob, transfer: Transferable[]): void;
  addEventListener(type: 'message', fn: (e: MessageEvent<AoMessage>) => void): void;
  addEventListener(type: 'error', fn: () => void): void;
  removeEventListener(type: 'message', fn: (e: MessageEvent<AoMessage>) => void): void;
  terminate(): void;
}

const GRID = 64;
let jobId = 1;

async function createWorker(): Promise<WorkerLike | null> {
  if (typeof Worker === 'undefined') return null;
  try {
    const mod = await import('./aoBake.worker?worker&inline');
    return new mod.default() as unknown as WorkerLike;
  } catch {
    return null;
  }
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function bakeOnMain(job: AoJob, token: CancellationToken, onProgress: (f: number) => void): Promise<Float32Array> {
  const field = buildAoField(job.positions, job.indices, job.resolution);
  const n = job.positions.length / 3;
  const out = new Float32Array(n).fill(1);
  const chunk = 3000;
  for (let from = 0; from < n; from += chunk) {
    if (token.cancelled) throw new CancelledError();
    computeAoRange(field, job.positions, job.normals, from, Math.min(n, from + chunk), job.options, out);
    onProgress(Math.min(1, (from + chunk) / n));
    await yieldToBrowser();
  }
  return out;
}

function bakeInWorker(worker: WorkerLike, job: AoJob, token: CancellationToken, onProgress: (f: number) => void): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (token.cancelled) {
        clearInterval(poll);
        worker.terminate();
        reject(new CancelledError());
      }
    }, 50);
    const onMessage = (e: MessageEvent<AoMessage>): void => {
      if (e.data.id !== job.id) return;
      if (e.data.kind === 'progress') onProgress(e.data.fraction);
      else {
        clearInterval(poll);
        worker.removeEventListener('message', onMessage);
        resolve(e.data.ao);
      }
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', () => {
      clearInterval(poll);
      reject(new Error('AO worker failed'));
    });
    worker.postMessage(job, [job.positions.buffer, job.normals.buffer, job.indices.buffer]);
  });
}

/**
 * Bake ambient occlusion into the geometries' `ao` attribute (and vertex colours per `settings.aoMode`).
 * Runs in a worker; falls back to a time-sliced main-thread loop. Cancellable through `token`.
 */
export async function bakeVertexAo(geometries: PlantGeometry[], settings: BakeSettings, token: CancellationToken, onProgress: (f: number) => void): Promise<void> {
  if (geometries.length === 0) return;
  const merged = concatForBake(geometries);
  const b = geometryBounds(geometries);
  const height = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2], 1e-3);
  const job: AoJob = {
    id: jobId++,
    positions: merged.positions,
    normals: merged.normals,
    indices: merged.indices,
    resolution: GRID,
    options: { samples: settings.aoSamples, radius: settings.aoRadius * height, strength: settings.aoStrength },
  };
  let baked: Float32Array;
  const worker = await createWorker();
  if (worker) {
    try {
      // The worker takes ownership of the buffers; keep copies for the (rare) fallback.
      const backup: AoJob = { ...job, positions: job.positions.slice(), normals: job.normals.slice(), indices: job.indices.slice() };
      try {
        baked = await bakeInWorker(worker, job, token, onProgress);
      } catch (e) {
        if (e instanceof CancelledError) throw e;
        baked = await bakeOnMain(backup, token, onProgress);
      }
    } finally {
      worker.terminate();
    }
  } else {
    baked = await bakeOnMain(job, token, onProgress);
  }
  geometries.forEach((g, i) => applyAoToGeometry(g, baked, merged.offsets[i] as number, settings.aoMode));
}
