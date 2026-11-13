import type { NodeDef, NodeInputs } from '@/contracts/nodes';
import { getNumber } from '@/contracts/params';
import { emptySkeleton, SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { PORT } from '@/graph/ports';
import { section } from '../shared/builders';
import { attachIns, childrenOut, parentIn } from '../shared/ports';

/**
 * Modifiers sit in the hierarchy between a generator and its children and reshape which parent branches the
 * descendants can see. They emit no geometry of their own.
 */
const parentOf = (inputs: NodeInputs): Skeleton => {
  const v = inputs[PORT.parent]?.[0];
  return v && v.kind === 'Structure' ? v.value.skeleton : emptySkeleton();
};

/** Copy the branches accepted by `keep` into a new skeleton (indices into the parent's skeleton are preserved as-is). */
function filterBranches(sk: Skeleton, keep: (id: number) => boolean): Skeleton {
  const sb = new SkeletonBuilder();
  for (const b of sk.branches) {
    if (!keep(b.id)) continue;
    sb.beginBranch(b.parentBranch, b.parentPoint, b.generation);
    for (let k = 0; k < b.count; k++) {
      const i = b.start + k;
      sb.addPoint(sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number, sk.radius[i] as number, sk.age[i] as number);
    }
    sb.endBranch();
  }
  return sb.build();
}

const s = section('Modifier', 'Selection');
const ports = [parentIn, childrenOut, ...attachIns.slice(0, 1)];

export const nodeDefs: NodeDef[] = [
  {
    type: 'modifier.prune',
    category: 'modifier',
    label: 'Prune',
    icon: 'nodeModifier',
    color: 'var(--kt-node-modifier)',
    description: 'Randomly removes a fraction of the parent branches for the descendants.',
    ports,
    params: [s.float('amount', 'Amount', 0.3, { min: 0, max: 1, curve: true }), s.seed('seed', 'Seed')],
    evaluate: (ctx, inputs, p) => {
      const amount = getNumber(p, 'amount', 0.3);
      const sk = parentOf(inputs);
      const dropped = new Set<number>();
      for (const b of sk.branches) if (ctx.rng.next() < amount) dropped.add(b.id);
      return { [PORT.children]: { kind: 'Structure', value: { skeleton: filterBranches(sk, (id) => !dropped.has(id)) } } };
    },
  },
  {
    type: 'modifier.select',
    category: 'modifier',
    label: 'Select',
    icon: 'nodeModifier',
    color: 'var(--kt-node-modifier)',
    description: 'Passes only the parent branches within a generation range.',
    ports,
    params: [s.int('minGeneration', 'Min generation', 0, { min: 0, max: 16 }), s.int('maxGeneration', 'Max generation', 16, { min: 0, max: 16 })],
    evaluate: (_ctx, inputs, p) => {
      const lo = getNumber(p, 'minGeneration', 0);
      const hi = getNumber(p, 'maxGeneration', 16);
      const sk = parentOf(inputs);
      const gen = new Map(sk.branches.map((b) => [b.id, b.generation]));
      return { [PORT.children]: { kind: 'Structure', value: { skeleton: filterBranches(sk, (id) => (gen.get(id) ?? 0) >= lo && (gen.get(id) ?? 0) <= hi) } } };
    },
  },
];
