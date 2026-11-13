import { describe, expect, it } from 'vitest';
import type { ForceDef } from '@/contracts/material';
import { defaultParams, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { applyForces } from '@/forces';
import { nodeDefs } from '@/nodes/forces';

function force(type: string, nodeType: string, patch: Record<string, unknown> = {}): ForceDef {
  const def = nodeDefs.find((n) => n.type === nodeType);
  if (!def) throw new Error(nodeType);
  const params: NodeParams = defaultParams(def.params);
  for (const [k, v] of Object.entries(patch)) params[k] = { ...(params[k] ?? { value: 0 }), value: v as number };
  return { id: nodeType, name: nodeType, type, enabled: true, params };
}

function stem(radius = 0.02, length = 3, n = 12): Skeleton {
  const b = new SkeletonBuilder();
  b.beginBranch(-1, -1, 0);
  for (let i = 0; i < n; i++) b.addPoint(0, 0, (length * i) / (n - 1), radius * (1 - 0.7 * (i / (n - 1))));
  b.endBranch();
  return b.build();
}

const lengthOf = (sk: Skeleton, branch = 0): number => {
  const br = sk.branches[branch]!;
  let l = 0;
  for (let k = 1; k < br.count; k++) {
    const i = br.start + k;
    l += Math.hypot(sk.position[i * 3]! - sk.position[(i - 1) * 3]!, sk.position[i * 3 + 1]! - sk.position[(i - 1) * 3 + 1]!, sk.position[i * 3 + 2]! - sk.position[(i - 1) * 3 + 2]!);
  }
  return l;
};

const tip = (sk: Skeleton): [number, number, number] => {
  const i = sk.count - 1;
  return [sk.position[i * 3]!, sk.position[i * 3 + 1]!, sk.position[i * 3 + 2]!];
};

describe('applyForces', () => {
  it('gravity bends a thin stem downwards and preserves its length', () => {
    const sk = stem();
    const l0 = lengthOf(sk);
    // horizontal-ish stem so gravity has a lever arm
    for (let i = 0; i < sk.count; i++) {
      sk.position[i * 3] = (3 * i) / (sk.count - 1);
      sk.position[i * 3 + 2] = 0;
    }
    const before = tip(sk);
    const stats = applyForces(sk, [force('gravity', 'force.gravity')], { rng: new Rng(1) });
    expect(stats.appliedForces).toBe(1);
    expect(tip(sk)[2]).toBeLessThan(before[2] - 0.05);
    expect(lengthOf(sk)).toBeCloseTo(l0, 3);
  });

  it('thin branches bend more than thick ones', () => {
    const make = (r: number): number => {
      const sk = stem(r);
      for (let i = 0; i < sk.count; i++) {
        sk.position[i * 3] = (3 * i) / (sk.count - 1);
        sk.position[i * 3 + 2] = 0;
      }
      applyForces(sk, [force('gravity', 'force.gravity')], { rng: new Rng(1) });
      return -tip(sk)[2];
    };
    expect(make(0.01)).toBeGreaterThan(make(0.06));
  });

  it('is deterministic', () => {
    const run = (): number[] => {
      const sk = stem();
      applyForces(sk, [force('turbulence', 'force.noise', { strength: 3 }), force('directional', 'force.directional')], { rng: new Rng(5) });
      return [...sk.position];
    };
    expect(run()).toEqual(run());
  });

  it('survives extreme values without NaN or flipping', () => {
    const sk = stem(0.0005, 10, 30);
    applyForces(
      sk,
      [force('gravity', 'force.gravity', { strength: 100 }), force('directional', 'force.directional', { strength: -100 }), force('vortex', 'force.vortex', { twist: 10, strength: 100 }), force('point', 'force.point', { strength: 100 })],
      { rng: new Rng(2) },
    );
    for (const v of sk.position) expect(Number.isFinite(v)).toBe(true);
    for (const v of sk.tangent) expect(Number.isFinite(v)).toBe(true);
    expect(lengthOf(sk)).toBeCloseTo(10, 2);
    // Never deflected more than ~110 degrees from the original (+Z) segments.
    for (let i = 0; i < sk.count; i++) expect(sk.direction[i * 3 + 2]!).toBeGreaterThan(-0.5);
  });

  it('phototropism steers growth towards the light', () => {
    const sk = stem();
    applyForces(sk, [force('phototropism', 'force.phototropism', { strength: 2, sensitivity: 1 })], { rng: new Rng(3) });
    // light direction defaults to (0.4, 0.2, 1): x/y should increase
    expect(tip(sk)[0]).toBeGreaterThan(0.02);
    expect(lengthOf(sk)).toBeCloseTo(3, 3);
  });

  it('ground avoidance lifts branches that would sit below the ground', () => {
    const sk = stem(0.02, 2, 10);
    for (let i = 0; i < sk.count; i++) {
      sk.position[i * 3] = (2 * i) / (sk.count - 1);
      sk.position[i * 3 + 2] = 0.05;
    }
    applyForces(sk, [force('groundAvoid', 'force.groundAvoid', { strength: 3 })], { rng: new Rng(4) });
    expect(tip(sk)[2]).toBeGreaterThan(0.09);
  });

  it('keeps forks attached to their parent branch', () => {
    const b = new SkeletonBuilder();
    b.beginBranch(-1, -1, 0);
    const pts: number[] = [];
    for (let i = 0; i < 8; i++) pts.push(b.addPoint(i * 0.4, 0, 0, 0.01));
    b.endBranch();
    b.beginBranch(0, pts[4]!, 1);
    for (let i = 0; i < 5; i++) b.addPoint(1.6, i * 0.3, 0, 0.006);
    b.endBranch();
    const sk = b.build();
    applyForces(sk, [force('gravity', 'force.gravity', { strength: 2 })], { rng: new Rng(1) });
    const child = sk.branches[1]!;
    const pi = pts[4]!;
    expect(sk.position[child.start * 3]).toBeCloseTo(sk.position[pi * 3]!, 4);
    expect(sk.position[child.start * 3 + 2]).toBeCloseTo(sk.position[pi * 3 + 2]!, 4);
  });

  it('does nothing for disabled or unknown forces', () => {
    const sk = stem();
    const copy = [...sk.position];
    const off = { ...force('gravity', 'force.gravity'), enabled: false };
    applyForces(sk, [off, { ...force('gravity', 'force.gravity'), type: 'nope' }], { rng: new Rng(1) });
    expect([...sk.position]).toEqual(copy);
  });
});
