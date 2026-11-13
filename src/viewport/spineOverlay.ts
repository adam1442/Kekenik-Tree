import type { SceneModel } from '@/contracts/engine';

/** Line segments (pairs of xyz points) of every spine a node produced, for selection / always-on overlays. */
export interface SpineOverlay {
  nodeId: string;
  branchCount: number;
  /** x0,y0,z0,x1,y1,z1 per segment. */
  segments: Float32Array;
}

/** Overlay geometry of the spines of `nodeId` (works for Spine nodes, which have no tube mesh); null if none. */
export function getSpineOverlay(scene: SceneModel | null | undefined, nodeId: string): SpineOverlay | null {
  const entry = scene?.skeletons.find((s) => s.nodeId === nodeId);
  if (!entry) return null;
  const sk = entry.skeleton;
  let segCount = 0;
  for (const b of sk.branches) segCount += Math.max(0, b.count - 1);
  const segments = new Float32Array(segCount * 6);
  let o = 0;
  for (const b of sk.branches) {
    for (let k = 0; k < b.count - 1; k++) {
      const i = (b.start + k) * 3;
      const j = i + 3;
      segments.set([sk.position[i] as number, sk.position[i + 1] as number, sk.position[i + 2] as number, sk.position[j] as number, sk.position[j + 1] as number, sk.position[j + 2] as number], o);
      o += 6;
    }
  }
  return { nodeId, branchCount: sk.branches.length, segments };
}
