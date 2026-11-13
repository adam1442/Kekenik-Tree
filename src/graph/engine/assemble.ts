import { OUTPUT_KEY, type MeshWindOverride, type SceneEntry, type SceneModel, type SceneSkeleton } from '@/contracts/engine';
import type { WindSettings } from '@/contracts/material';
import { getNumber, type NodeParams } from '@/contracts/params';
import type { NodeDef, NodeOutputs } from '@/contracts/nodes';
import { meshTriangleCount, meshVertexCount } from '@/contracts/mesh';
import { PORT } from '@/graph/ports';
import type { GraphSnapshot } from './snapshot';

export interface NodeResult {
  key: string;
  outputs: NodeOutputs;
  /** Geometry/skeleton of this node may be shown (evaluated or cached, not skipped/bypassed/errored). */
  visible: boolean;
  instances: number;
}

/** Wind multipliers of one generator: its own Animation / Wind params combined with an attached Wind node. */
function meshWind(params: NodeParams, attached: WindSettings | undefined): MeshWindOverride | undefined {
  const own = params.windAmount !== undefined ? getNumber(params, 'windAmount', 1) : 1;
  const flutter = params.flutterAmount !== undefined ? getNumber(params, 'flutterAmount', 0.5) * 2 : 1;
  const freq = params.flutterFrequency !== undefined ? Math.max(0, getNumber(params, 'flutterFrequency', 1)) : 1;
  const amount = Math.max(0, own) * (attached && attached.enabled ? Math.max(0, attached.strength) : attached ? 0 : 1);
  const stiff = attached?.params.stiffness?.value;
  const stiffness = typeof stiff === 'number' ? stiff : -1;
  if (amount === 1 && flutter === 1 && freq === 1 && stiffness < 0) return undefined;
  return { amount, flutter: Math.max(0, flutter), flutterFrequency: freq, stiffness };
}

/**
 * Collect the renderable pieces of the plant from the per-node results, in dependency order.
 * With Solo active only soloed nodes contribute geometry (their ancestors were evaluated but stay hidden).
 */
export function assembleScene(snap: GraphSnapshot, order: string[], results: ReadonlyMap<string, NodeResult>, lookup: (type: string) => NodeDef | undefined): SceneModel {
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  const soloActive = snap.nodes.some((n) => n.solo && n.enabled);
  const entries: SceneEntry[] = [];
  // Wind nodes attached to generators (per mesh override) or to the Tree output (graph-level wind).
  const attachedWind = new Map<string, WindSettings>();
  let sceneWind: WindSettings | null = null;
  for (const edge of snap.edges) {
    if (edge.kind !== 'attachment' || edge.toPort !== PORT.wind) continue;
    const out = results.get(edge.fromNode)?.outputs[PORT.out];
    if (!out || out.kind !== 'Wind') continue;
    if (byId.get(edge.toNode)?.type === 'output.tree') sceneWind = out.value;
    else attachedWind.set(edge.toNode, out.value);
  }
  const skeletons: SceneSkeleton[] = [];
  const groups = new Map<string, number>();
  let triangles = 0;
  let vertices = 0;
  let bones = 0;
  let skeletonBranches = 0;
  let skeletonPoints = 0;
  let totalInstances = 0;
  for (const id of order) {
    const node = byId.get(id);
    const res = results.get(id);
    if (!node || !res || !res.visible) continue;
    if (node.hierarchy) totalInstances += res.instances;
    if (soloActive && !node.solo) continue;
    const def = lookup(node.type);
    const geo = res.outputs[OUTPUT_KEY.geometry];
    if (geo && geo.kind === 'Mesh' && geo.value.indices.length > 0) {
      const tris = meshTriangleCount(geo.value);
      const label = def?.statsGroup ?? def?.label.toLowerCase() ?? node.type;
      const wind = meshWind(node.params, attachedWind.get(id));
      entries.push({ nodeId: id, type: node.type, statsGroup: label, mesh: geo.value, rev: res.key, ...(wind ? { wind } : {}) });
      groups.set(label, (groups.get(label) ?? 0) + tris);
      triangles += tris;
      vertices += meshVertexCount(geo.value);
    }
    const st = res.outputs[PORT.children];
    if (st && st.kind === 'Structure' && st.value.skeleton.count > 0) {
      skeletons.push({ nodeId: id, skeleton: st.value.skeleton, rev: res.key, ...(st.value.instances ? { instances: st.value.instances } : {}), ...(st.value.attachments ? { attachments: st.value.attachments } : {}) });
      const isStructureGen = node.type === 'generator.trunk' || node.type === 'generator.branch' || node.type === 'generator.root' || node.type === 'generator.split' || node.type === 'generator.spine';
      if (isStructureGen) {
        bones += st.value.skeleton.branches.length;
        skeletonBranches += st.value.skeleton.branches.length;
        skeletonPoints += st.value.skeleton.count;
      } else {
        bones += st.value.skeleton.branches.filter((b) => b.generation === 0).length;
      }
    }
  }
  return {
    entries,
    skeletons,
    wind: sceneWind,
    stats: {
      triangles,
      vertices,
      bones,
      skeletonBranches,
      skeletonPoints,
      groups: [...groups].map(([label, t]) => ({ label, triangles: t })),
      totalInstances,
    },
  };
}
