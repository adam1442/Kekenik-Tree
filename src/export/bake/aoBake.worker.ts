import { buildAoField, computeAoRange, type AoOptions } from './aoCore';

export interface AoJob {
  id: number;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  resolution: number;
  options: AoOptions;
}

export type AoMessage = { id: number; kind: 'progress'; fraction: number } | { id: number; kind: 'done'; ao: Float32Array };

interface WorkerScope {
  onmessage: ((e: MessageEvent<AoJob>) => void) | null;
  postMessage(message: AoMessage, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e): void => {
  const job = e.data;
  const field = buildAoField(job.positions, job.indices, job.resolution);
  const n = job.positions.length / 3;
  const out = new Float32Array(n).fill(1);
  const chunk = 4096;
  for (let from = 0; from < n; from += chunk) {
    computeAoRange(field, job.positions, job.normals, from, Math.min(n, from + chunk), job.options, out);
    scope.postMessage({ id: job.id, kind: 'progress', fraction: Math.min(1, (from + chunk) / n) });
  }
  scope.postMessage({ id: job.id, kind: 'done', ao: out }, [out.buffer]);
};
