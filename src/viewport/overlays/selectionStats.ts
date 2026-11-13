import type { SceneModel } from '@/contracts/engine';
import { FLAG_HIDDEN, type InstanceRef } from '@/instances/types';
import type { ContentStatGroup } from '../types';

export interface SelectionStats {
  /** "SELECTED" (a node or instances are selected) or "MODEL". */
  scope: 'SELECTED' | 'MODEL';
  groups: ContentStatGroup[];
  triangles: number;
  /** Skeleton branches of the selection ("bones"). */
  bones: number;
}

/**
 * Polygon / bone counts of the selection for the viewport HUD ("POLYGONS - SELECTED"). With instances selected the
 * triangle count of their node is apportioned by the share of skeleton points the instances own.
 */
export function selectionStats(scene: SceneModel | null, nodeIds: readonly string[], instances: readonly InstanceRef[] = []): SelectionStats | null {
  if (!scene) return null;
  const nodes = new Set(nodeIds);
  for (const i of instances) nodes.add(i.nodeId);
  if (nodes.size === 0) return null;
  const share = (nodeId: string): number => {
    const picked = instances.filter((i) => i.nodeId === nodeId);
    if (picked.length === 0) return 1;
    const sk = scene.skeletons.find((s) => s.nodeId === nodeId);
    const table = sk?.instances;
    if (!sk || !table || sk.skeleton.count === 0) return 1;
    const keys = new Set(picked.map((p) => p.key));
    let pts = 0;
    for (let i = 0; i < table.count; i++) if (keys.has(table.key[i] as number) && ((table.flags[i] as number) & FLAG_HIDDEN) === 0) pts += table.pointCount[i] as number;
    return pts / sk.skeleton.count;
  };
  const groups = new Map<string, number>();
  let triangles = 0;
  for (const e of scene.entries) {
    if (!nodes.has(e.nodeId)) continue;
    const tris = Math.round((e.mesh.indices.length / 3) * share(e.nodeId));
    groups.set(e.statsGroup, (groups.get(e.statsGroup) ?? 0) + tris);
    triangles += tris;
  }
  let bones = 0;
  for (const s of scene.skeletons) {
    if (!nodes.has(s.nodeId)) continue;
    const picked = instances.filter((i) => i.nodeId === s.nodeId);
    if (picked.length === 0 || !s.instances) {
      bones += s.skeleton.branches.length;
      continue;
    }
    const keys = new Set(picked.map((p) => p.key));
    for (let i = 0; i < s.instances.count; i++) if (keys.has(s.instances.key[i] as number)) bones += s.instances.branchCount[i] as number;
  }
  return { scope: 'SELECTED', groups: [...groups].map(([label, t]) => ({ label, triangles: t })), triangles, bones };
}
