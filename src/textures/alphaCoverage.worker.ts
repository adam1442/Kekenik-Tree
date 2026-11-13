import { buildCoverageMipChain, type CoverageChannel, type MipLevel } from './alphaCoverage';

export interface CoverageJob {
  id: number;
  width: number;
  height: number;
  data: Uint8Array;
  channel: CoverageChannel;
  cutoff: number;
}

export interface CoverageResult {
  id: number;
  levels: MipLevel[];
}

interface WorkerScope {
  onmessage: ((e: MessageEvent<CoverageJob>) => void) | null;
  postMessage(message: CoverageResult, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (e): void => {
  const { id, width, height, data, channel, cutoff } = e.data;
  const levels = buildCoverageMipChain({ width, height, data }, { channel, cutoff });
  scope.postMessage({ id, levels }, levels.map((l) => l.data.buffer));
};
