import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { flatCurve, type Curve } from '@/contracts/curve';
import type { MeshData } from '@/contracts/mesh';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, migrateNodeParams, registerDiscoveredNodes } from '@/graph/registry';
import { buildInspectorSections } from '@/ui/panels/properties/inspectorState';
import { emptyMeshData, mergeMeshData } from '@/contracts/mesh';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import {
  NEUTRAL_SKIN_RADIUS,
  bendPushFactor,
  leanNormal,
  branchVisibility,
  clampRadius,
  compensateTipRadii,
  exceedsKillRatio,
  isBranchVisible,
  isSpineOnly,
  seamWeight,
  skinBaseRadius,
  squashRadius,
  squashRatio,
} from '@/generators/skin';
import { frameNormalFor, lightingNormal, lightingValue, squashSurface, coneSurface, weldBlendValue } from '@/generators/weld';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const stepCurve = (low: number, high: number, at: number): Curve => ({
  ...flatCurve(0),
  points: [
    { x: 0, y: low, inTangent: { dx: -0.1, dy: 0 }, outTangent: { dx: 0.1, dy: 0 }, mode: 'linear' },
    { x: at, y: low, inTangent: { dx: -0.01, dy: 0 }, outTangent: { dx: 0.001, dy: 0 }, mode: 'linear' },
    { x: Math.min(1, at + 0.001), y: high, inTangent: { dx: -0.001, dy: 0 }, outTangent: { dx: 0.01, dy: 0 }, mode: 'linear' },
    { x: 1, y: high, inTangent: { dx: -0.1, dy: 0 }, outTangent: { dx: 0.1, dy: 0 }, mode: 'linear' },
  ],
});

describe('Skin > Radius formula', () => {
  it('adds Absolute and + % of the parent radius to the base radius', () => {
    const s = { ...NEUTRAL_SKIN_RADIUS, absolute: 0.01, percentParent: 0.5 };
    expect(skinBaseRadius(0.05, 0.2, s)).toBeCloseTo(0.05 + 0.01 + 0.1, 9);
    // No parent: only the absolute part.
    expect(skinBaseRadius(0.05, null, s)).toBeCloseTo(0.06, 9);
    expect(skinBaseRadius(0.05, 0.2, NEUTRAL_SKIN_RADIUS)).toBe(0.05);
  });

  it('Clamp to parent keeps the child at or below the parent radius', () => {
    const s = { ...NEUTRAL_SKIN_RADIUS, percentParent: 2, clampToParent: true };
    expect(skinBaseRadius(0.05, 0.1, s)).toBeCloseTo(0.1, 9);
    expect(skinBaseRadius(0.05, 0.1, { ...s, clampToParent: false })).toBeCloseTo(0.25, 9);
  });

  it('Clamp Min / Max limit the radius, 0 switches a bound off', () => {
    expect(clampRadius(0.5, 0.1, 0.3)).toBe(0.3);
    expect(clampRadius(0.01, 0.1, 0.3)).toBe(0.1);
    expect(clampRadius(0.5, 0, 0)).toBe(0.5);
    expect(skinBaseRadius(0.05, null, { ...NEUTRAL_SKIN_RADIUS, min: 0.08 })).toBe(0.08);
  });

  it('Length kill ratio removes branches with length / radius above it (0 = off)', () => {
    expect(exceedsKillRatio(10, 0.05, 150)).toBe(true);
    expect(exceedsKillRatio(10, 0.05, 250)).toBe(false);
    expect(exceedsKillRatio(1000, 0.001, 0)).toBe(false);
  });

  it('Length compensation lifts a pointed tip to a fraction of the base and leaves the base alone', () => {
    const n = 11;
    const radii = Float32Array.from({ length: n }, (_, k) => 0.1 * (1 - k / (n - 1)) + 0.0001);
    const u = Array.from({ length: n }, (_, k) => k / (n - 1));
    const before = Float32Array.from(radii);
    compensateTipRadii(radii, u, 1);
    expect(radii[0]).toBeCloseTo(before[0]!, 9);
    expect(radii[n - 1]).toBeCloseTo(0.5 * before[0]!, 5);
    for (let k = 0; k < n; k++) expect(radii[k]!).toBeGreaterThanOrEqual(before[k]! - 1e-9);
    const zero = Float32Array.from(before);
    compensateTipRadii(zero, u, 0);
    expect(Array.from(zero)).toEqual(Array.from(before));
    // A tip that is already thick enough is untouched.
    const thick = Float32Array.from({ length: n }, () => 0.1);
    compensateTipRadii(thick, u, 1);
    expect(Array.from(thick)).toEqual(Array.from({ length: n }, () => Float32Array.of(0.1)[0]));
  });
});

describe('Skin > Squash', () => {
  it('short / long ratio goes from 1 (round) down to 0.1 (flat)', () => {
    expect(squashRatio(0)).toBe(1);
    expect(squashRatio(1)).toBeCloseTo(0.1, 9);
    expect(squashRatio(0.5)).toBeCloseTo(0.55, 9);
  });

  it('is an ellipse: the radius is the ratio along Rotate and 1 across it', () => {
    const amount = 0.6;
    const rot = 0.7;
    expect(squashRadius(rot, amount, rot)).toBeCloseTo(squashRatio(amount), 9);
    expect(squashRadius(rot + Math.PI, amount, rot)).toBeCloseTo(squashRatio(amount), 9);
    expect(squashRadius(rot + Math.PI / 2, amount, rot)).toBeCloseTo(1, 9);
    expect(squashRadius(1.23, 0, rot)).toBe(1);
    // Points lie on the ellipse (x / k)^2 + y^2 = 1.
    for (const a of [0.2, 1, 2.5, 4]) {
      const r = squashRadius(a, amount, rot);
      const x = r * Math.cos(a - rot);
      const y = r * Math.sin(a - rot);
      expect((x / squashRatio(amount)) ** 2 + y ** 2).toBeCloseTo(1, 9);
    }
  });

  it('the squashed parent skin follows the flattened profile (welds land on it)', () => {
    const base = coneSurface({ position: [0, 0, 0], tangent: [0, 0, 1], radius: 1, slope: 0 });
    const normal = frameNormalFor([1, 0, 0], [0, 0, 1]);
    const sq = squashSurface(base, { position: [0, 0, 0], normal, amount: 0.5, angle: 0 });
    // Short axis along x: the skin is at x = 0.55, along y it stays at 1.
    expect(Math.abs(sq.signedDistance(0.55, 0, 0.3))).toBeLessThan(1e-6);
    expect(Math.abs(sq.signedDistance(0, 1, 0.3))).toBeLessThan(1e-6);
    expect(sq.signedDistance(0.8, 0, 0)).toBeGreaterThan(0);
    const out = new Float32Array(3);
    sq.normal(0.55, 0, 0.3, out, 0);
    expect(out[0]).toBeGreaterThan(0.99);
    // No squash returns the original surface.
    expect(squashSurface(base, { position: [0, 0, 0], normal, amount: 0, angle: 0 })).toBe(base);
  });
});

describe('Weld blend maths', () => {
  it('weldBlend runs 0 -> 1 monotonically across the weld and the texture extension', () => {
    for (const texture of [0, 1, 4]) {
      let prev = -1;
      for (let k = 0; k <= 40; k++) {
        const s = -0.1 + (0.5 * k) / 40;
        const v = weldBlendValue(s, -0.1, 0.1, 0.05, texture);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
        prev = v;
      }
      expect(weldBlendValue(-0.1, -0.1, 0.1, 0.05, texture)).toBe(0);
      expect(weldBlendValue(5, -0.1, 0.1, 0.05, texture)).toBe(1);
    }
    // Texture pulls the blended region further up the child.
    expect(weldBlendValue(0.1, -0.1, 0.1, 0.05, 0)).toBeCloseTo(1, 9);
    expect(weldBlendValue(0.1, -0.1, 0.1, 0.05, 4)).toBeLessThan(0.9);
  });

  it('Lighting: 0 follows the spine, 1 points outward, 0.5 keeps the normal', () => {
    const n: [number, number, number] = [0, 0.6, 0.8];
    const spine: [number, number, number] = [1, 0, 0];
    const out: [number, number, number] = [0, 1, 0];
    expect(lightingNormal(n, spine, out, 0.5)).toEqual(n);
    const a = lightingNormal(n, spine, out, 0);
    expect(dot(a, spine)).toBeCloseTo(1, 9);
    const b = lightingNormal(n, spine, out, 1);
    expect(dot(b, out)).toBeCloseTo(1, 9);
    const mid = lightingNormal(n, spine, out, 0.25);
    expect(dot(mid, spine)).toBeGreaterThan(dot(n, spine));
    expect(Math.hypot(...mid)).toBeCloseTo(1, 9);
    expect(lightingValue(undefined, 0.3)).toBe(0.5);
    expect(lightingValue(flatCurve(0.2), 0.7)).toBeCloseTo(0.2, 6);
  });
});

describe('Light seam reduction', () => {
  it('the bend weight is strongest at the base and falls off monotonically', () => {
    let prev = Infinity;
    for (let k = 0; k < 20; k++) {
      const w = seamWeight(k * 0.02, 0.05, 0.8);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    expect(seamWeight(0, 0.05, 0.8)).toBeCloseTo(0.8, 9);
    expect(seamWeight(0.0, 0.05, 0)).toBe(0);
    expect(seamWeight(4, 0.05, 1)).toBeLessThan(1e-6);
  });

  it('bends the normal toward the spine and stays unit length', () => {
    const n: [number, number, number] = [0, 1, 0];
    const spine: [number, number, number] = [0, 0, 1];
    expect(leanNormal(n, spine, 0)).toEqual(n);
    const half = leanNormal(n, spine, 0.5);
    expect(half[2]).toBeGreaterThan(0.6);
    expect(Math.hypot(...half)).toBeCloseTo(1, 9);
    expect(dot(leanNormal(n, spine, 1), spine)).toBeCloseTo(1, 9);
  });

  it('Smooth pushes the section out more the sharper the bend', () => {
    expect(bendPushFactor(1)).toBeCloseTo(1, 9);
    expect(bendPushFactor(0)).toBeCloseTo(1 / Math.SQRT1_2, 9);
    expect(bendPushFactor(-1)).toBeCloseTo(2, 9);
    expect(bendPushFactor(0.5)).toBeGreaterThan(bendPushFactor(0.9));
  });
});

describe('Skin > Type & Visibility', () => {
  beforeAll(() => registerDiscoveredNodes());

  it('a branch has geometry only when the value is above 0.5', () => {
    expect(isBranchVisible(0.51)).toBe(true);
    expect(isBranchVisible(0.5)).toBe(false);
    expect(isBranchVisible(0)).toBe(false);
    expect(branchVisibility(undefined, 0.3)).toBe(true);
    const c = stepCurve(1, 0, 0.5);
    expect(branchVisibility(c, 0.2)).toBe(true);
    expect(branchVisibility(c, 0.9)).toBe(false);
  });

  it('Type: Polygons by default, Spine only (the legacy switch still counts)', () => {
    expect(isSpineOnly({})).toBe(false);
    expect(isSpineOnly({ skinType: { value: 'spine-only' } })).toBe(true);
    expect(isSpineOnly({ skinType: { value: 'polygons' } })).toBe(false);
    expect(isSpineOnly({ spineOnly: { value: true } })).toBe(true);
  });

  it('old projects: spineOnly becomes Type = Spine only', () => {
    const migrated = migrateNodeParams('generator.branch', { spineOnly: { value: true }, number: { value: 2 } }, 3);
    expect(migrated.spineOnly).toBeUndefined();
    expect(migrated.skinType?.value).toBe('spine-only');
    expect(migrated.number?.value).toBe(2);
    const off = migrateNodeParams('generator.trunk', { spineOnly: { value: false } }, 3);
    expect(off.skinType).toBeUndefined();
    expect(off.spineOnly).toBeUndefined();
  });
});

describe('mergeMeshData with weld channels', () => {
  it('fills neutral values for meshes without them', () => {
    const mk = (weld: boolean): MeshData => ({
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      uv0: new Float32Array(6),
      indices: Uint32Array.of(0, 1, 2),
      slots: [{ materialId: 'm', indexStart: 0, indexCount: 3 }],
      ...(weld ? { weld: { blend: Float32Array.of(0, 0.5, 1), parentUv: new Float32Array(6).fill(2), style: new Float32Array(9).fill(1) } } : {}),
    });
    const merged = mergeMeshData([mk(false), mk(true)]);
    expect(merged.weld!.blend.length).toBe(6);
    expect(Array.from(merged.weld!.blend.subarray(0, 3))).toEqual([0, 0, 0]);
    expect(merged.weld!.style.length).toBe(18);
    expect(merged.weld!.style[0]).toBe(0);
    expect(merged.weld!.style[9]).toBe(1);
    expect(mergeMeshData([mk(false), mk(false)]).weld).toBeUndefined();
  });
});

/* ------------------------------------------------------------------------------------ generator integration */

describe('Skin options in the generators', () => {
  beforeAll(() => registerDiscoveredNodes());

  const TRUNK = { number: 1, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 1, length: { value: 6, variance: 0 }, radius: { value: 0.3, variance: 0 }, sides: 48, accuracy: 24, segments: 24 };
  const BRANCH = { number: 8, first: 0.3, last: 0.9, mode: 'absolute', spread: { value: 70, variance: 0 }, length: { value: 2, variance: 0 }, radius: { value: 0.06, variance: 0 }, noiseAmount: 0, gravity: 0, sides: 12 };
  const specs = (branch: Record<string, unknown> = {}, trunk: Record<string, unknown> = {}): NodeSpec[] => [
    { id: 'tree', type: 'output.tree', parent: null },
    { id: 'tr', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, ...trunk } as NodeSpec['params'] },
    { id: 'br', type: 'generator.branch', parent: 'tr', params: { ...BRANCH, ...branch } as NodeSpec['params'] },
  ];
  const run = (model: ReturnType<typeof buildGraph>, seed = 3) =>
    new GraphEvaluator().evaluate(snapshotGraph(model), { seed, lod: 0, token: new CancellationSource().token });
  const skeletonOf = (r: Awaited<ReturnType<typeof run>>, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();
  const meshOf = (r: Awaited<ReturnType<typeof run>>, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
  /** Graph with a curve parameter set on the branch node. */
  const withCurve = (branch: Record<string, unknown>, id: string, curve: Curve): ReturnType<typeof buildGraph> => {
    const model = buildGraph(specs(branch));
    model.setParam('br', id, { ...model.getNode('br')!.params[id]!, curve });
    return model;
  };

  it('exposes Skin > Radius, Clamp, Squash and Type & Visibility with the specified labels', () => {
    const def = getNodeDef('generator.branch')!;
    const labels = (sub: string): string[] => def.params.filter((p) => p.group === 'Skin' && p.subgroup === sub && p.id !== 'spineOnly').map((p) => p.label);
    expect(labels('Radius')).toEqual(['Absolute', '+ % of parent', 'Clamp to parent', 'Length compensation', 'Length kill ratio', 'Light seam reduction', 'Roll', 'Smooth']);
    expect(labels('Clamp')).toEqual(['Min', 'Max']);
    expect(labels('Squash')).toEqual(['Amount', 'Rotate']);
    expect(labels('Type & Visibility')).toEqual(['Type', 'Visibility']);
    expect(labels('Blend')).toEqual(['Enabled', 'Texture', 'Texture scale', 'Contrast', 'Noise', 'Lighting']);
    const type = def.params.find((p) => p.id === 'skinType')!;
    if (type.kind !== 'enum') throw new Error('Type is an enum');
    expect(type.options.find((o) => o.value === 'polygons')).toBeDefined();
    expect(type.options.filter((o) => o.disabled).length).toBe(2);
    expect(def.params.find((p) => p.id === 'skinVisibility')!.kind).toBe('curve');
    // The trunk has no parent: no parent-relative radius rows.
    const trunk = getNodeDef('generator.trunk')!;
    expect(trunk.params.some((p) => p.id === 'skinRadiusPercent')).toBe(false);
    expect(trunk.params.some((p) => p.id === 'skinRadiusAbsolute')).toBe(true);
    const sections = buildInspectorSections(def.params, 'Skin').map((s) => s.title);
    expect(sections).toEqual(expect.arrayContaining(['Type & Visibility', 'Radius', 'Clamp', 'Squash', 'Welding']));
    expect(sections).not.toContain('Blend');
    // The Material tab keeps its own Blend section.
    expect(buildInspectorSections(def.params, 'Material').map((x) => x.title)).toContain('Blend');
  });

  it('+ % of parent adds to the radius, Clamp to parent keeps it below the trunk', async () => {
    const base = await run(buildGraph(specs()));
    const more = await run(buildGraph(specs({ skinRadiusPercent: 0.2 })));
    const clamped = await run(buildGraph(specs({ skinRadiusPercent: 20, skinRadiusClampParent: true })));
    const tr = skeletonOf(base, 'tr');
    const r0 = (r: Awaited<ReturnType<typeof run>>): number => skeletonOf(r, 'br').radius[skeletonOf(r, 'br').branches[0]!.start]!;
    expect(r0(more)).toBeGreaterThan(r0(base));
    const sk = skeletonOf(clamped, 'br');
    for (const b of sk.branches) {
      const near = Math.max(tr.radius[b.parentPoint - 1]!, tr.radius[b.parentPoint]!, tr.radius[b.parentPoint + 1]!);
      expect(sk.radius[b.start]!).toBeLessThanOrEqual(near * 1.0001);
    }
  });

  it('Clamp Max limits every point, Length kill ratio removes thin whips, compensation thickens the tips', async () => {
    const capped = skeletonOf(await run(buildGraph(specs({ skinRadiusMax: 0.03 }))), 'br');
    expect(Math.max(...capped.radius)).toBeLessThanOrEqual(0.03 + 1e-6);
    const killed = skeletonOf(await run(buildGraph(specs({ skinLengthKill: 10 }))), 'br');
    expect(killed.branches.length).toBe(0);
    const kept = skeletonOf(await run(buildGraph(specs({ skinLengthKill: 5000 }))), 'br');
    expect(kept.branches.length).toBe(8);
    const tipOf = (sk: Skeleton): number => sk.radius[sk.branches[0]!.start + sk.branches[0]!.count - 1]!;
    const plain = skeletonOf(await run(buildGraph(specs({ taper: 1 }))), 'br');
    const comp = skeletonOf(await run(buildGraph(specs({ taper: 1, skinLengthCompensation: 1 }))), 'br');
    expect(tipOf(comp)).toBeGreaterThan(tipOf(plain) * 2);
  });

  it('Visibility hides branches outside the curve but keeps them in the skeleton', async () => {
    const visible = await run(buildGraph(specs()));
    const hidden = await run(withCurve({}, 'skinVisibility', flatCurve(0.2)));
    expect(skeletonOf(hidden, 'br').branches.length).toBe(8);
    expect(meshOf(visible, 'br').indices.length).toBeGreaterThan(0);
    expect(meshOf(hidden, 'br').indices.length).toBe(0);
    const half = await run(withCurve({}, 'skinVisibility', stepCurve(1, 0, 0.5)));
    const n = meshOf(half, 'br').indices.length;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(meshOf(visible, 'br').indices.length);
  });

  it('Type = Spine only builds no mesh, Polygons does', async () => {
    const spine = await run(buildGraph(specs({ skinType: 'spine-only' })));
    expect(meshOf(spine, 'br').indices.length).toBe(0);
    expect(skeletonOf(spine, 'br').branches.length).toBe(8);
  });

  it('Squash flattens the section: the radius along Rotate shrinks to the ratio', async () => {
    const round = meshOf(await run(buildGraph(specs({ number: 1 }, { sides: 16 }))), 'tr');
    const flat = meshOf(await run(buildGraph(specs({ number: 1 }, { sides: 16, squashAmount: 1, squashRotate: 0 }))), 'tr');
    const extent = (m: MeshData): number[] => {
      const lo = [Infinity, Infinity];
      const hi = [-Infinity, -Infinity];
      for (let v = 0; v < m.positions.length / 3; v++) {
        for (let c = 0; c < 2; c++) {
          lo[c] = Math.min(lo[c]!, m.positions[v * 3 + c]!);
          hi[c] = Math.max(hi[c]!, m.positions[v * 3 + c]!);
        }
      }
      return [hi[0]! - lo[0]!, hi[1]! - lo[1]!];
    };
    const a = extent(round);
    const b = extent(flat);
    const ratios = [b[0]! / a[0]!, b[1]! / a[1]!].sort((x, y) => x - y);
    expect(ratios[0]!).toBeLessThan(0.2);
    expect(ratios[1]!).toBeGreaterThan(0.95);
  });

  it('Light seam reduction bends junction normals toward the spine, more at the base than higher up', async () => {
    const plain = await run(buildGraph(specs({ number: 1 })));
    const seam = await run(buildGraph(specs({ number: 1, seamReduction: 1 })));
    const sk = skeletonOf(plain, 'br');
    const b = sk.branches[0]!;
    const P = (i: number): [number, number, number] => [sk.position[i * 3]!, sk.position[i * 3 + 1]!, sk.position[i * 3 + 2]!];
    const spine = (() => {
      const a = P(b.start);
      const c = P(b.start + b.count - 1);
      const d: [number, number, number] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const l = Math.hypot(...d);
      return [d[0] / l, d[1] / l, d[2] / l] as const;
    })();
    /** Mean |n . spine| of the vertices within a distance band of the base. */
    const align = (m: MeshData, lo: number, hi: number): number => {
      const base = P(b.start);
      let sum = 0;
      let cnt = 0;
      for (let v = 0; v < m.positions.length / 3; v++) {
        const d = Math.hypot(m.positions[v * 3]! - base[0], m.positions[v * 3 + 1]! - base[1], m.positions[v * 3 + 2]! - base[2]);
        if (d < lo || d > hi) continue;
        sum += Math.abs(dot([m.normals[v * 3]!, m.normals[v * 3 + 1]!, m.normals[v * 3 + 2]!], spine));
        cnt++;
      }
      return cnt ? sum / cnt : 0;
    };
    const gainNear = align(meshOf(seam, 'br'), 0, 0.12) - align(meshOf(plain, 'br'), 0, 0.12);
    const gainFar = align(meshOf(seam, 'br'), 0.8, 1.2) - align(meshOf(plain, 'br'), 0.8, 1.2);
    expect(gainNear).toBeGreaterThan(0.05);
    expect(gainNear).toBeGreaterThan(gainFar);
  });

  it('Weld blend writes weldBlend 0..1 per vertex, monotonic along the child, with the active flag', async () => {
    const r = await run(buildGraph(specs({ weldEnabled: true, number: 1 })));
    const m = meshOf(r, 'br');
    expect(m.weld).toBeDefined();
    const w = m.weld!;
    const n = m.positions.length / 3;
    expect(w.blend.length).toBe(n);
    expect(w.parentUv.length).toBe(n * 2);
    expect(w.style.length).toBe(n * 3);
    let min = Infinity;
    let max = -Infinity;
    for (let v = 0; v < n; v++) {
      min = Math.min(min, w.blend[v]!);
      max = Math.max(max, w.blend[v]!);
      expect(Number.isFinite(w.parentUv[v * 2]!)).toBe(true);
      expect(Number.isFinite(w.parentUv[v * 2 + 1]!)).toBe(true);
      expect(w.style[v * 3 + 2]).toBe(1);
    }
    expect(min).toBe(0);
    expect(max).toBe(1);
    // Along the child (distance from the base) the blend never decreases (checked on a sorted sample).
    const sk = skeletonOf(r, 'br');
    const b = sk.branches[0]!;
    const t: [number, number, number] = [sk.position[(b.start + 1) * 3]! - sk.position[b.start * 3]!, sk.position[(b.start + 1) * 3 + 1]! - sk.position[b.start * 3 + 1]!, sk.position[(b.start + 1) * 3 + 2]! - sk.position[b.start * 3 + 2]!];
    const tl = Math.hypot(...t);
    const samples: [number, number][] = [];
    for (let v = 0; v < n; v++) {
      const d = (m.positions[v * 3]! - sk.position[b.start * 3]!) * t[0] / tl + (m.positions[v * 3 + 1]! - sk.position[b.start * 3 + 1]!) * t[1] / tl + (m.positions[v * 3 + 2]! - sk.position[b.start * 3 + 2]!) * t[2] / tl;
      samples.push([d, w.blend[v]!]);
    }
    samples.sort((a, c) => a[0] - c[0]);
    // The mean blend of the lower quarter is below the mean of the upper quarter, and nothing exceeds 1.
    const q = Math.floor(samples.length / 4);
    const mean = (xs: [number, number][]): number => xs.reduce((s, x) => s + x[1], 0) / xs.length;
    expect(mean(samples.slice(0, q))).toBeLessThan(mean(samples.slice(-q)));
  });

  it('Blend off or welding off writes no weld channels', async () => {
    const off = meshOf(await run(buildGraph(specs({ weldEnabled: true, weldBlendEnabled: false, number: 1 }))), 'br');
    expect(off.weld).toBeUndefined();
    const none = meshOf(await run(buildGraph(specs({ number: 1 }))), 'br');
    expect(none.weld).toBeUndefined();
  });

  it('a squashed trunk: welded children still sit on the flattened skin', async () => {
    const r = await run(buildGraph(specs({ weldEnabled: true, number: 3, last: 0.5, radius: { value: 0.03, variance: 0 } }, { squashAmount: 0.6, squashRotate: 0 })));
    const sk = skeletonOf(r, 'br');
    expect(sk.branches.length).toBe(3);
    expect(skeletonOf(r, 'tr').attributes.get('skinSquash')![0]).toBeCloseTo(0.6, 6);
    const m = meshOf(r, 'br');
    for (let i = 0; i < m.positions.length; i++) expect(Number.isFinite(m.positions[i]!)).toBe(true);
    for (let i = 0; i < m.normals.length; i++) expect(Number.isFinite(m.normals[i]!)).toBe(true);
  });

  it('is deterministic: same graph and seed give identical meshes', async () => {
    const s = specs({ weldEnabled: true, skinRadiusPercent: 0.1, seamReduction: 0.5, skinSmooth: 1, skinRoll: 30 }, { squashAmount: 0.3 });
    const a = meshOf(await run(buildGraph(s), 9), 'br');
    const b = meshOf(await run(buildGraph(s), 9), 'br');
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.weld!.parentUv)).toEqual(Array.from(b.weld!.parentUv));
  });

  it('Roll rotates the section without changing the silhouette of a round tube', async () => {
    const a = meshOf(await run(buildGraph(specs({ number: 1 }))), 'br');
    const b = meshOf(await run(buildGraph(specs({ number: 1, skinRoll: 45 }))), 'br');
    expect(b.positions.length).toBe(a.positions.length);
    const radiusSum = (m: MeshData): number => m.positions.reduce((s, x) => s + Math.abs(x), 0);
    expect(radiusSum(b)).toBeGreaterThan(0);
  });
});

describe('Bark shader weld blend patch', () => {
  it('declares the weld channels, samples the map twice behind the active flag and keeps the other patches', async () => {
    const { ShaderLib } = await import('three');
    const { KtPhysicalMaterial } = await import('@/materials/ktShader');
    const shader = { uniforms: {}, vertexShader: ShaderLib.physical.vertexShader, fragmentShader: ShaderLib.physical.fragmentShader };
    const m = new KtPhysicalMaterial();
    m.onBeforeCompile(shader as never, undefined as never);
    const v = shader.vertexShader;
    const f = shader.fragmentShader;
    for (const decl of ['attribute float weldBlend;', 'attribute vec2 weldParentUV;', 'attribute vec3 weldStyle;', 'varying float vKtWeldBlend;']) expect(v).toContain(decl);
    expect(v).toContain('vKtWeldUv = (mapTransform * vec3(weldParentUV, 1.0)).xy;');
    // The helper is defined right after the map uniform chunk and before its use.
    const decl = f.indexOf('#include <map_pars_fragment>');
    const fn = f.indexOf('vec4 ktSampleBark(vec2 uvChild)');
    const use = f.indexOf('ktSampleBark( vMapUv )');
    expect(decl).toBeGreaterThan(-1);
    expect(fn).toBeGreaterThan(decl);
    expect(use).toBeGreaterThan(fn);
    expect(f).toContain('vKtWeldStyle.z > 0.5');
    expect(f).toContain('textureGrad(map, vKtWeldUv');
    expect(f).toContain('ktVariationTint(vKtRand)');
    // Meshes without the channels read the neutral default (blend inactive).
    expect((m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues.weldStyle).toEqual([0, 0, 0]);
  });
});
