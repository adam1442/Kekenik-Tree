import { OUTPUT_KEY, type SceneCollisionStats } from '@/contracts/engine';
import type { NodeDef } from '@/contracts/nodes';
import type { MeshData } from '@/contracts/mesh';
import {
  LEAF_MOVED,
  LEAF_REMOVED,
  LEAF_SHRUNK,
  applyOutcomeToMesh,
  clusterPassSettings,
  collidersFromMesh,
  leafPassSettings,
  resolveLeafCollisions,
  type Capsule,
  type Collider,
  type CollisionOutcome,
  type CollisionSettings,
  type TriangleSoup,
} from '@/generators/collision';
import { PORT } from '@/graph/ports';
import type { NodeResult } from './assemble';
import { hashString } from './hash';
import { now } from './scheduler';
import type { CancellationToken } from '@/contracts/nodes';
import type { GraphSnapshot } from './snapshot';

const LEAF_TYPES: ReadonlySet<string> = new Set(['generator.leaf', 'generator.batchedLeaf']);
const BATCHED_TYPE = 'generator.batchedLeaf';
const BRANCH_TYPES: ReadonlySet<string> = new Set(['generator.trunk', 'generator.branch', 'generator.root', 'generator.spine']);

export interface CollisionPassResult {
  /** Results of the leaf nodes that changed (same ids as the evaluation results). */
  patched: Map<string, NodeResult>;
  stats: SceneCollisionStats;
}

export interface CollisionPassOptions {
  lod: number;
  token: CancellationToken;
  budgetMs: number;
  yieldFn: () => Promise<void>;
}

/** True when the Tree node asks for any collision removal (the host uses it to show the plain scene first: pop-in). */
export function collisionIsActive(snap: GraphSnapshot, lod = 0): boolean {
  const tree = snap.nodes.find((n) => n.type === 'output.tree' && n.enabled);
  if (!tree) return false;
  return leafPassSettings(tree.params, lod).level !== 'none' || clusterPassSettings(tree.params, lod).level !== 'none';
}

interface LeafSource {
  nodeId: string;
  type: string;
  mesh: MeshData;
  /** Index of the first collider of this node in the combined list. */
  first: number;
  count: number;
}

/** Capsules of the skeleton of one structure node. */
function capsulesOf(res: NodeResult, salt: number): Capsule[] {
  const out: Capsule[] = [];
  const children = res.outputs[PORT.children];
  if (!children || children.kind !== 'Structure') return out;
  const sk = children.value.skeleton;
  for (const b of sk.branches) {
    for (let i = b.start; i + 1 < b.start + b.count; i++) {
      out.push({
        a: [sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number],
        b: [sk.position[i * 3 + 3] as number, sk.position[i * 3 + 4] as number, sk.position[i * 3 + 5] as number],
        ra: sk.radius[i] as number,
        rb: sk.radius[i + 1] as number,
        branch: salt * 1_000_003 + b.id,
      });
    }
  }
  return out;
}

const keyOf = (s: CollisionSettings): string => `${s.level}|${s.spherical ? 1 : 0}|${s.plane ? 1 : 0}`;

/**
 * The leaf-collision post pass: runs after every node is evaluated and before the scene is assembled. Leaf meshes are
 * replaced by copies without the losing leaves; nothing cached by the nodes is mutated. Cancellable and time-sliced.
 * Returns null when the pass is off or there is nothing to do.
 */
export async function runCollisionPass(
  snap: GraphSnapshot,
  order: readonly string[],
  results: ReadonlyMap<string, NodeResult>,
  lookup: (type: string) => NodeDef | undefined,
  opts: CollisionPassOptions,
  memo?: Map<string, CollisionPassResult>,
): Promise<CollisionPassResult | null> {
  const tree = snap.nodes.find((n) => n.type === 'output.tree' && n.enabled);
  if (!tree) return null;
  const leafSettings = leafPassSettings(tree.params, opts.lod);
  const planeSettings = clusterPassSettings(tree.params, opts.lod);
  if (leafSettings.level === 'none' && planeSettings.level === 'none') return null;
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  const leaves: LeafSource[] = [];
  const capsules: Capsule[] = [];
  const soups: TriangleSoup[] = [];
  const colliders: Collider[] = [];
  const keys: string[] = [];
  let branchSalt = 0;
  for (const id of order) {
    const node = byId.get(id);
    const res = results.get(id);
    if (!node || !res || !res.visible) continue;
    const geo = res.outputs[OUTPUT_KEY.geometry];
    const mesh = geo && geo.kind === 'Mesh' ? geo.value : null;
    if (LEAF_TYPES.has(node.type) && mesh?.collision && !mesh.instanced) {
      const first = colliders.length;
      colliders.push(...collidersFromMesh(mesh, leaves.length, first, leaves.length + 1));
      leaves.push({ nodeId: id, type: node.type, mesh, first, count: colliders.length - first });
      keys.push(res.key);
    } else if (BRANCH_TYPES.has(node.type) && lookup(node.type)) {
      branchSalt += 1;
      capsules.push(...capsulesOf(res, branchSalt));
      if (mesh && leafSettings.level === 'high') soups.push({ positions: mesh.positions, indices: mesh.indices });
      keys.push(res.key);
    }
  }
  if (colliders.length === 0) return null;
  const passKey = hashString(['lc1', keyOf(leafSettings), keyOf(planeSettings), opts.lod, keys.join(',')].join('|'));
  const hit = memo?.get(passKey);
  if (hit) return hit;

  let sliceStart = now();
  const hooks = {
    checkpoint: async (): Promise<void> => {
      opts.token.throwIfCancelled();
      if (now() - sliceStart > opts.budgetMs) {
        await opts.yieldFn();
        opts.token.throwIfCancelled();
        sliceStart = now();
      }
    },
  };
  const n = colliders.length;
  const state = new Uint8Array(n);
  const scale = new Float32Array(n).fill(1);
  const offset = new Float32Array(n * 3);
  let tests = 0;
  let orphans = 0;
  const merge = (o: CollisionOutcome, subset: readonly number[] | null): void => {
    const at = (k: number): number => (subset ? (subset[k] as number) : k);
    const count = subset ? subset.length : n;
    for (let k = 0; k < count; k++) {
      const i = at(k);
      const s = o.state[k] as number;
      if (s === LEAF_REMOVED) state[i] = LEAF_REMOVED;
      else if (s === LEAF_SHRUNK || s === LEAF_MOVED) {
        if (state[i] !== LEAF_REMOVED) state[i] = state[i] === LEAF_SHRUNK ? LEAF_SHRUNK : s;
        scale[i] = (scale[i] as number) * (o.scale[k] as number);
        for (let c = 0; c < 3; c++) offset[i * 3 + c] = (offset[i * 3 + c] as number) + (o.offset[k * 3 + c] as number);
      }
    }
    tests += o.stats.tests;
    orphans += o.stats.orphanedParents;
  };
  if (leafSettings.level !== 'none') {
    const o = await resolveLeafCollisions({ colliders, capsules, branchTriangles: soups, settings: leafSettings }, hooks);
    merge(o, null);
  }
  if (planeSettings.level !== 'none') {
    // Cluster plane overlap: the Batched leaf nodes (cluster cards), the leaves that survived the first pass, XY plane only.
    const subset: number[] = [];
    for (const src of leaves) {
      if (src.type !== BATCHED_TYPE) continue;
      for (let k = 0; k < src.count; k++) if (state[src.first + k] !== LEAF_REMOVED) subset.push(src.first + k);
    }
    const o = await resolveLeafCollisions({ colliders: subset.map((i) => colliders[i] as Collider), settings: planeSettings }, hooks);
    merge(o, subset);
  }
  const outcome: CollisionOutcome = { state, scale, offset, orphanedParents: [], stats: { removed: 0, shrunk: 0, moved: 0, orphanedParents: orphans, tests } };
  const patched = new Map<string, NodeResult>();
  const stats: SceneCollisionStats = { leaves: n, removed: 0, shrunk: 0, moved: 0, orphanedParents: orphans, tests, level: leafSettings.level };
  for (const src of leaves) {
    let changed = false;
    for (let k = 0; k < src.count; k++) {
      const s = state[src.first + k] as number;
      if (s === LEAF_REMOVED) stats.removed += 1;
      else if (s === LEAF_SHRUNK) stats.shrunk += 1;
      else if (s === LEAF_MOVED) stats.moved += 1;
      if (s !== 0) changed = true;
    }
    if (!changed) continue;
    const res = results.get(src.nodeId) as NodeResult;
    const mesh = applyOutcomeToMesh(src.mesh, outcome, src.first);
    patched.set(src.nodeId, { ...res, key: `${res.key}|lc:${passKey}`, outputs: { ...res.outputs, [OUTPUT_KEY.geometry]: { kind: 'Mesh', value: mesh } } });
  }
  const result: CollisionPassResult = { patched, stats };
  if (memo) {
    memo.clear();
    memo.set(passKey, result);
  }
  return result;
}
