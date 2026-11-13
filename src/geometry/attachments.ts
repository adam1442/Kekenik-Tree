import { emptyAttachmentSet, type AttachmentFrame, type AttachmentSet } from '@/contracts/attachment';
import type { Frame } from './rigid';
import { frameToMat } from './rigid';
import { hashParts } from '@/instances/keys';

/** Incremental builder of an `AttachmentSet` (one instance at a time, frames appended to the current instance). */
export class AttachmentBuilder {
  private keys: number[] = [];
  private branches: number[] = [];
  private transforms: number[] = [];
  private scales: number[] = [];
  private frameStart: number[] = [];
  private frameCount: number[] = [];
  private pos: number[] = [];
  private dir: number[] = [];
  private up: number[] = [];
  private fScale: number[] = [];
  private hashes: number[] = [];
  private indices: number[] = [];
  private axisT: number[] = [];
  private ids: string[] = [];
  private tags: (readonly string[])[] = [];

  constructor(private readonly nodeId: string) {}

  /** Start an instance. `base` is the instance base frame (origin = axis base, +Y = growth, +Z = card normal). */
  beginInstance(key: number, branchId: number, base: Frame, scale = 1): void {
    this.keys.push(key >>> 0);
    this.branches.push(branchId);
    this.transforms.push(...frameToMat(base));
    this.scales.push(scale);
    this.frameStart.push(this.fScale.length);
    this.frameCount.push(0);
  }

  addFrame(f: Frame, scale: number, anchorId: string, anchorIndex: number, axisT: number, tags: readonly string[] = []): void {
    if (this.frameCount.length === 0) throw new Error('AttachmentBuilder: beginInstance() missing');
    this.pos.push(f.position[0], f.position[1], f.position[2]);
    this.dir.push(f.direction[0], f.direction[1], f.direction[2]);
    this.up.push(f.up[0], f.up[1], f.up[2]);
    this.fScale.push(scale);
    this.hashes.push(hashParts(anchorId));
    this.indices.push(anchorIndex);
    this.axisT.push(axisT);
    this.ids.push(anchorId);
    this.tags.push(tags);
    this.frameCount[this.frameCount.length - 1] = (this.frameCount[this.frameCount.length - 1] as number) + 1;
  }

  get instanceCount(): number {
    return this.keys.length;
  }

  build(): AttachmentSet {
    if (this.keys.length === 0) return emptyAttachmentSet(this.nodeId);
    return {
      nodeId: this.nodeId,
      instanceCount: this.keys.length,
      instanceKey: Uint32Array.from(this.keys),
      instanceBranch: Int32Array.from(this.branches),
      instanceTransform: Float32Array.from(this.transforms),
      instanceScale: Float32Array.from(this.scales),
      frameStart: Int32Array.from(this.frameStart),
      frameCount: Int32Array.from(this.frameCount),
      position: Float32Array.from(this.pos),
      direction: Float32Array.from(this.dir),
      up: Float32Array.from(this.up),
      scale: Float32Array.from(this.fScale),
      anchorHash: Uint32Array.from(this.hashes),
      anchorIndex: Int32Array.from(this.indices),
      axisT: Float32Array.from(this.axisT),
      anchorIds: this.ids,
      tags: this.tags,
    };
  }
}

/** Row of the instance with `instanceKey`, -1 when unknown. */
export function findAttachmentInstance(set: AttachmentSet | undefined, instanceKey: number): number {
  if (!set) return -1;
  const k = instanceKey >>> 0;
  for (let i = 0; i < set.instanceCount; i++) if (set.instanceKey[i] === k) return i;
  return -1;
}

/** Row of the instance represented by skeleton branch `branchId`, -1 when none. */
export function findAttachmentByBranch(set: AttachmentSet | undefined, branchId: number): number {
  if (!set) return -1;
  for (let i = 0; i < set.instanceCount; i++) if (set.instanceBranch[i] === branchId) return i;
  return -1;
}

/** Unpack the frames of instance row `row`. */
export function attachmentFramesOf(set: AttachmentSet, row: number): AttachmentFrame[] {
  if (row < 0 || row >= set.instanceCount) return [];
  const out: AttachmentFrame[] = [];
  const start = set.frameStart[row] as number;
  const n = set.frameCount[row] as number;
  for (let f = start; f < start + n; f++) {
    out.push({
      position: [set.position[f * 3] as number, set.position[f * 3 + 1] as number, set.position[f * 3 + 2] as number],
      direction: [set.direction[f * 3] as number, set.direction[f * 3 + 1] as number, set.direction[f * 3 + 2] as number],
      up: [set.up[f * 3] as number, set.up[f * 3 + 1] as number, set.up[f * 3 + 2] as number],
      scale: set.scale[f] as number,
      anchorId: set.anchorIds[f] as string,
      anchorIndex: set.anchorIndex[f] as number,
      axisT: set.axisT[f] as number,
      tags: set.tags[f] ?? [],
    });
  }
  return out;
}

/** Frames of the parent instance with the stable `instanceKey` (the engine exposes this as `ctx.getParentAttachments`). */
export function getParentAttachments(set: AttachmentSet | undefined, instanceKey: number): AttachmentFrame[] {
  return set ? attachmentFramesOf(set, findAttachmentInstance(set, instanceKey)) : [];
}
