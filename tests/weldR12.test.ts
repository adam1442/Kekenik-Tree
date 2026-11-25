import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { flatCurve, type Curve } from '@/contracts/curve';
import type { Skeleton } from '@/contracts/skeleton';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildInspectorSections } from '@/ui/panels/properties/inspectorState';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';
import {
  coneFromPolyline,
  coneSurface,
  sagScale,
  solveWeld,
  tubeSurface,
  weldHeightFraction,
  weldKept,
  weldRingCount,
  type ChildPath,
  type ParentSurface,
  type WeldSettings,
} from '@/generators/weld';

/** Straight child leaving the parent axis (z axis) at `angleDeg` from the parent tangent, in the x-z plane. */
function straightChild(angleDeg: number, radius: number, length = 2, count = 11, taper = 1): ChildPath {
  const a = (angleDeg * Math.PI) / 180;
  const t = [Math.sin(a), 0, Math.cos(a)];
  const nrm = [0, 1, 0];
  const pos = new Float32Array(count * 3);
  const rad = new Float32Array(count);
  const tan = new Float32Array(count * 3);
  const nr = new Float32Array(count * 3);
  const s = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const d = (length * i) / (count - 1);
    pos.set([t[0]! * d, 0, 1 + t[2]! * d], i * 3);
    rad[i] = radius * (1 - (1 - taper) * (i / (count - 1)));
    tan.set(t, i * 3);
    nr.set(nrm, i * 3);
    s[i] = d;
  }
  return { count, pos, rad, nrm: nr, tan, s };
}

const parentCone = (radius = 0.2, slope = 0): ParentSurface => coneSurface({ position: [0, 0, 1], tangent: [0, 0, 1], radius, slope });
const SETTINGS: WeldSettings = { sides: 12, segments: 4, offset: 0.1, spread: 0.3, upper: 0.2, lower: 0.1 };

describe('weld solver: base on the parent skin', () => {
  it('puts ring 0 on the parent surface at every angle between 10 and 170 degrees', () => {
    for (const angle of [10, 25, 45, 70, 90, 110, 135, 155, 170]) {
      const surf = parentCone(0.2);
      const w = solveWeld(straightChild(angle, 0.05), surf, SETTINGS);
      expect(w.ok, `angle ${angle}: ${w.failure}`).toBe(true);
      for (let j = 0; j < w.sides; j++) {
        const x = w.positions[j * 3]!;
        const y = w.positions[j * 3 + 1]!;
        expect(Math.hypot(x, y)).toBeCloseTo(0.2, 4);
      }
    }
  });

  it('closes the loop: ring 0 surrounds the child axis and every ring is a proper loop', () => {
    const w = solveWeld(straightChild(60, 0.06), parentCone(0.2), SETTINGS);
    expect(w.ok).toBe(true);
    // Angular order around the child's axis is preserved (no fold-over): the projected polygon keeps its orientation.
    const tx = Math.sin(Math.PI / 3);
    const tz = Math.cos(Math.PI / 3);
    for (let i = 0; i < w.rings; i++) {
      let area = 0;
      for (let j = 0; j < w.sides; j++) {
        const k = (j + 1) % w.sides;
        const pj = [w.positions[(i * w.sides + j) * 3]!, w.positions[(i * w.sides + j) * 3 + 1]!, w.positions[(i * w.sides + j) * 3 + 2]! - 1];
        const pk = [w.positions[(i * w.sides + k) * 3]!, w.positions[(i * w.sides + k) * 3 + 1]!, w.positions[(i * w.sides + k) * 3 + 2]! - 1];
        // Child frame: N = y axis, B = T x N.
        const bj = pj[0]! * tz - pj[2]! * tx; // dot with B = (tz, 0, -tx)... sign irrelevant for |area|
        const bk = pk[0]! * tz - pk[2]! * tx;
        area += pj[1]! * bk - pk[1]! * bj;
      }
      expect(Math.abs(area)).toBeGreaterThan(1e-5);
    }
  });

  it('ends in the plain child circle beyond the surface, with the parent normal fading out', () => {
    const w = solveWeld(straightChild(90, 0.05), parentCone(0.2), SETTINGS);
    expect(w.ok).toBe(true);
    const last = w.rings - 1;
    // Last ring: plain circle of radius 0.05 around the child axis (the x axis through z = 1).
    for (let j = 0; j < w.sides; j++) {
      const o = (last * w.sides + j) * 3;
      expect(Math.hypot(w.positions[o + 1]!, w.positions[o + 2]! - 1)).toBeCloseTo(0.05, 4);
      expect(w.positions[o]!).toBeCloseTo(w.sEnd, 4);
    }
    expect(w.sEnd).toBeGreaterThan(0.2);
    expect(w.blend[0]).toBeCloseTo(1, 6);
    expect(w.blend[last]).toBeCloseTo(0, 6);
    for (let i = 1; i < w.rings; i++) expect(w.blend[i]!).toBeLessThanOrEqual(w.blend[i - 1]!);
    // Parent normals are unit and point away from the parent axis.
    for (let j = 0; j < w.sides; j++) {
      const o = j * 3;
      expect(Math.hypot(w.parentNormals[o]!, w.parentNormals[o + 1]!, w.parentNormals[o + 2]!)).toBeCloseTo(1, 5);
    }
  });

  it('keeps the arc length of every column increasing from the skin to the end (no cracks / fold-overs)', () => {
    const w = solveWeld(straightChild(20, 0.1), parentCone(0.2), SETTINGS);
    expect(w.ok).toBe(true);
    for (let j = 0; j < w.sides; j++) {
      for (let i = 1; i < w.rings; i++) expect(w.vs[i * w.sides + j]!).toBeGreaterThan(w.vs[(i - 1) * w.sides + j]! - 1e-9);
    }
  });

  it('works for large child / parent radius ratios up to 0.8, also with Spread', () => {
    for (const ratio of [0.3, 0.6, 0.8]) {
      for (const angle of [10, 90, 170]) {
        const w = solveWeld(straightChild(angle, 0.2 * ratio, 4), parentCone(0.2), { ...SETTINGS, spread: 0.5 });
        expect(w.ok, `ratio ${ratio} angle ${angle}: ${w.failure}`).toBe(true);
        for (let j = 0; j < w.sides; j++) expect(Math.hypot(w.positions[j * 3]!, w.positions[j * 3 + 1]!)).toBeCloseTo(0.2, 4);
      }
    }
  });

  it('follows a tapered parent', () => {
    const surf = parentCone(0.2, -0.05);
    const w = solveWeld(straightChild(70, 0.04), surf, { ...SETTINGS, spread: 0 });
    expect(w.ok).toBe(true);
    for (let j = 0; j < w.sides; j++) {
      const x = w.positions[j * 3]!;
      const y = w.positions[j * 3 + 1]!;
      const z = w.positions[j * 3 + 2]!;
      expect(Math.hypot(x, y)).toBeCloseTo(0.2 - 0.05 * (z - 1), 4);
    }
  });

  it('Spread widens the base and the widening fades out; upper / lower act on opposite sides', () => {
    const none = solveWeld(straightChild(90, 0.05), parentCone(0.2), { ...SETTINGS, spread: 0, upper: 0, lower: 0 });
    const wide = solveWeld(straightChild(90, 0.05), parentCone(0.2), { ...SETTINGS, spread: 0.4, upper: 0, lower: 0 });
    const radiusAround = (w: typeof none, ring: number, j: number): number => {
      const o = (ring * w.sides + j) * 3;
      return Math.hypot(w.positions[o + 1]!, w.positions[o + 2]! - 1);
    };
    expect(radiusAround(wide, 0, 0)).toBeGreaterThan(radiusAround(none, 0, 0) * 1.2);
    expect(radiusAround(wide, wide.rings - 1, 0)).toBeCloseTo(0.05, 4);
    // Upper only: widens the vertices facing the parent tip (+z) more than those facing its base.
    const up = solveWeld(straightChild(90, 0.05), parentCone(0.2), { ...SETTINGS, spread: 0, upper: 0.6, lower: 0 });
    let top = 0;
    let bottom = 0;
    for (let j = 0; j < up.sides; j++) {
      const dz = up.dirs[j * 3 + 2]!;
      const r = radiusAround(up, 0, j);
      if (dz > 0.9) top = Math.max(top, r);
      if (dz < -0.9) bottom = Math.max(bottom, r);
    }
    expect(top).toBeGreaterThan(bottom * 1.3);
  });

  it('uses Weld scalar for the number of rings', () => {
    expect(weldRingCount(1)).toBe(5);
    expect(weldRingCount(2)).toBe(9);
    expect(weldRingCount(0)).toBe(2);
    const w = solveWeld(straightChild(90, 0.05), parentCone(0.2), { ...SETTINGS, segments: 8 });
    expect(w.rings).toBe(9);
  });
});

describe('weld solver: failure flagging', () => {
  it('fails for a degenerate parent or child', () => {
    expect(solveWeld(straightChild(90, 0.05), parentCone(0), SETTINGS).failure).toBe('parent');
    expect(solveWeld(straightChild(90, 0), SETTINGS.sides ? parentCone(0.2) : parentCone(0.2), SETTINGS).failure).toBe('degenerate');
    const one: ChildPath = { ...straightChild(90, 0.05), count: 1 };
    expect(solveWeld(one, parentCone(0.2), SETTINGS).ok).toBe(false);
  });

  it('fails when the child is wider than the parent (base starts outside)', () => {
    const w = solveWeld(straightChild(90, 0.3), parentCone(0.2), SETTINGS);
    expect(w.ok).toBe(false);
    expect(w.failure).toBe('inside');
    expect(w.rings).toBe(0);
  });

  it('fails when the child is too short to leave the parent (ray miss / short)', () => {
    const w = solveWeld(straightChild(90, 0.05, 0.1), parentCone(0.2), SETTINGS);
    expect(w.ok).toBe(false);
    expect(['noExit', 'short']).toContain(w.failure);
  });

  it('fails when the weld part is longer than the child', () => {
    const w = solveWeld(straightChild(90, 0.05, 0.3), parentCone(0.2), { ...SETTINGS, offset: 0.5 });
    expect(w.ok).toBe(false);
    expect(w.failure).toBe('short');
  });

  it('analyzeOnly agrees with the full solve', () => {
    for (const angle of [10, 90, 170]) {
      for (const len of [0.15, 2]) {
        const a = solveWeld(straightChild(angle, 0.05, len), parentCone(0.2), { ...SETTINGS, analyzeOnly: true });
        const f = solveWeld(straightChild(angle, 0.05, len), parentCone(0.2), SETTINGS);
        expect(a.ok).toBe(f.ok);
        expect(a.failure).toBe(f.failure);
      }
    }
  });
});

describe('weld solver: ray cast surface', () => {
  const straightParent = (): { pos: Float32Array; rad: Float32Array } => {
    const pos = new Float32Array(11 * 3);
    const rad = new Float32Array(11).fill(0.2);
    for (let i = 0; i < 11; i++) pos.set([0, 0, i * 0.2], i * 3);
    return { pos, rad };
  };

  it('agrees with the procedural cone on a straight parent', () => {
    const p = straightParent();
    const ray = tubeSurface({ positions: p.pos, radii: p.rad, count: 11, hint: 5, window: 8, radiusScale: 1 });
    const a = solveWeld(straightChild(60, 0.05), ray, SETTINGS);
    const b = solveWeld(straightChild(60, 0.05), parentCone(0.2), SETTINGS);
    expect(a.ok).toBe(true);
    for (let k = 0; k < a.positions.length; k++) expect(a.positions[k]!).toBeCloseTo(b.positions[k]!, 3);
  });

  it('flags a weld that ends on the end cap of the parent', () => {
    const p = straightParent();
    // Child leaves the very tip of the parent heading along it: the skin crossing is the cap.
    const ray = tubeSurface({ positions: p.pos, radii: p.rad, count: 11, hint: 9, window: 8, radiusScale: 1 });
    const child = straightChild(0, 0.05, 2);
    // Move the base to the parent tip.
    for (let i = 0; i < child.count; i++) (child.pos as Float32Array)[i * 3 + 2] = 2 + (child.s[i] as number);
    const w = solveWeld(child, ray, SETTINGS);
    expect(w.ok).toBe(false);
    expect(w.failure).toBe('cap');
  });

  it('follows a curved parent: base ring stays on the bent tube', () => {
    // Parent bends in the x-z plane (quarter circle of radius 2 around (2, 0, 0)).
    const n = 21;
    const pos = new Float32Array(n * 3);
    const rad = new Float32Array(n).fill(0.15);
    for (let i = 0; i < n; i++) {
      const a = (i / (n - 1)) * (Math.PI / 2);
      pos.set([2 - 2 * Math.cos(a), 0, 2 * Math.sin(a)], i * 3);
    }
    const ray = tubeSurface({ positions: pos, radii: rad, count: n, hint: 10, window: 8, radiusScale: 1 });
    const mid = 10;
    const base: [number, number, number] = [pos[mid * 3]!, pos[mid * 3 + 1]!, pos[mid * 3 + 2]!];
    const a = (mid / (n - 1)) * (Math.PI / 2);
    // Child leaves radially outward from the bend (direction away from the circle centre), in the plane.
    const dir: [number, number, number] = [-Math.cos(a), 0, Math.sin(a)];
    const count = 9;
    const cp = new Float32Array(count * 3);
    const cr = new Float32Array(count).fill(0.04);
    const ct = new Float32Array(count * 3);
    const cn = new Float32Array(count * 3);
    const cs = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const d = i * 0.2;
      cp.set([base[0] + dir[0] * d, 0, base[2] + dir[2] * d], i * 3);
      ct.set(dir, i * 3);
      cn.set([0, 1, 0], i * 3);
      cs[i] = d;
    }
    const w = solveWeld({ count, pos: cp, rad: cr, nrm: cn, tan: ct, s: cs }, ray, { ...SETTINGS, spread: 0 });
    expect(w.ok, String(w.failure)).toBe(true);
    for (let j = 0; j < w.sides; j++) {
      const x = w.positions[j * 3]!;
      const y = w.positions[j * 3 + 1]!;
      const z = w.positions[j * 3 + 2]!;
      // Distance to the circular spine of the parent = radius.
      const distToCentre = Math.hypot(x - 2, z);
      expect(Math.hypot(distToCentre - 2, y)).toBeCloseTo(0.15, 2);
    }
  });
});

describe('weld helpers', () => {
  it('builds a procedural surface from a parent polyline (taper included)', () => {
    const pos = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 2]);
    const rad = new Float32Array([0.3, 0.2, 0.1]);
    const surf = coneFromPolyline(pos, rad, 3, [0, 0, 1.5], 0, 0, 1)!;
    expect(surf.radius).toBeCloseTo(0.15, 6);
    expect(surf.signedDistance(0.15, 0, 1.5)).toBeCloseTo(0, 6);
    expect(surf.signedDistance(0, 0, 1.5)).toBeLessThan(0);
    expect(coneFromPolyline(pos, rad, 1, [0, 0, 0], 0, 0, 1)).toBeNull();
  });

  it('compensates the polygonal sag of the parent', () => {
    expect(sagScale(0)).toBe(1);
    expect(sagScale(8)).toBeLessThan(1);
    expect(sagScale(8)).toBeGreaterThan(0.95);
    expect(sagScale(64)).toBeGreaterThan(sagScale(8));
  });

  it('Keep: weld survives where the curve is >= 0.5, heights are normalised', () => {
    expect(weldKept(0.5)).toBe(true);
    expect(weldKept(0.49)).toBe(false);
    expect(weldHeightFraction(5, 0, 10)).toBeCloseTo(0.5, 9);
    expect(weldHeightFraction(-1, 0, 10)).toBe(0);
    expect(weldHeightFraction(3, 3, 3)).toBe(0);
  });
});

describe('weld solver: determinism and speed', () => {
  it('gives identical output for identical input', () => {
    const a = solveWeld(straightChild(55, 0.05), parentCone(0.2), SETTINGS);
    const b = solveWeld(straightChild(55, 0.05), parentCone(0.2), SETTINGS);
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(a.sEnd).toBe(b.sEnd);
  });

  it('solves 5000 welds well under 1.5 s', () => {
    const paths = [10, 30, 50, 70, 90, 110, 130, 150, 170].map((deg) => straightChild(deg, 0.04));
    const surf = parentCone(0.2, -0.01);
    const t0 = performance.now();
    let ok = 0;
    for (let i = 0; i < 5000; i++) {
      const w = solveWeld(paths[i % paths.length]!, surf, SETTINGS);
      if (w.ok) ok++;
    }
    const dt = performance.now() - t0;
    expect(ok).toBe(5000);
    expect(dt).toBeLessThan(1500);
  });
});

/* ------------------------------------------------------------------------------------ generator integration */

describe('Branch generator: welding', () => {
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
  const skeletonOf = (r: Awaited<ReturnType<typeof run>>, id: string) => r.scene.skeletons.find((s) => s.nodeId === id)!.skeleton;
  const meshOf = (r: Awaited<ReturnType<typeof run>>, id: string) => r.scene.entries.find((e) => e.nodeId === id)!.mesh;

  const stepPoint = (x: number, y: number): Curve['points'][number] => ({ x, y, inTangent: { dx: -0.1, dy: 0 }, outTangent: { dx: 0.1, dy: 0 }, mode: 'linear' });

  /** Distance of a point to the trunk polyline, the trunk radius there and the outward radial direction. */
  function trunkFit(sk: Skeleton, p: [number, number, number]): { dist: number; radius: number; radial: [number, number, number] } {
    const b = sk.branches[0]!;
    let best = { dist: Infinity, radius: 0, radial: [0, 0, 1] as [number, number, number] };
    for (let k = 0; k < b.count - 1; k++) {
      const i = b.start + k;
      const a = [sk.position[i * 3]!, sk.position[i * 3 + 1]!, sk.position[i * 3 + 2]!];
      const d = [sk.position[(i + 1) * 3]! - a[0]!, sk.position[(i + 1) * 3 + 1]! - a[1]!, sk.position[(i + 1) * 3 + 2]! - a[2]!];
      const l2 = d[0]! * d[0]! + d[1]! * d[1]! + d[2]! * d[2]!;
      const t = Math.min(1, Math.max(0, ((p[0] - a[0]!) * d[0]! + (p[1] - a[1]!) * d[1]! + (p[2] - a[2]!) * d[2]!) / l2));
      const dist = Math.hypot(p[0] - a[0]! - d[0]! * t, p[1] - a[1]! - d[1]! * t, p[2] - a[2]! - d[2]! * t);
      if (dist < best.dist) {
        best = {
          dist,
          radius: sk.radius[i]! * (1 - t) + sk.radius[i + 1]! * t,
          radial: [(p[0] - a[0]! - d[0]! * t) / (dist || 1), (p[1] - a[1]! - d[1]! * t) / (dist || 1), (p[2] - a[2]! - d[2]! * t) / (dist || 1)],
        };
      }
    }
    return best;
  }

  it('is off by default (old projects keep their geometry) and writes no weld attribute', async () => {
    const r = await run(buildGraph(specs()));
    expect(skeletonOf(r, 'br').attributes.get('weld')).toBeUndefined();
  });

  it('exposes Skin > Welding with Enabled, Keep, Keep failed, Force ray casts, Offset and Spread', () => {
    const def = getNodeDef('generator.branch')!;
    const welding = def.params.filter((p) => p.group === 'Skin' && (p.subgroup === 'Welding' || p.subgroup === 'Spread'));
    expect(welding.map((p) => p.label)).toEqual(['Enabled', 'Keep', 'Keep failed', 'Force ray casts', 'Offset', 'Amount', 'Upper scale', 'Lower scale']);
    expect(welding.find((p) => p.id === 'weldKeep')!.kind).toBe('curve');
    expect(getNodeDef('generator.root')!.params.some((p) => p.id === 'weldEnabled')).toBe(true);
    expect(getNodeDef('generator.trunk')!.params.some((p) => p.id === 'weldEnabled')).toBe(false);
    expect(def.params.find((p) => p.id === 'weldScalar')!.subgroup).toBe('Length');
    const sections = buildInspectorSections(def.params, 'Skin').map((s) => s.title);
    expect(sections).toContain('Welding');
    expect(sections).not.toContain('Spread');
  });

  it('fuses every child into the trunk surface: the base ring lies on the trunk skin', async () => {
    const model = buildGraph(specs({ weldEnabled: true, weldSpreadAmount: 0.3 }));
    const r = await run(model);
    const sk = skeletonOf(r, 'br');
    const tr = skeletonOf(r, 'tr');
    expect(sk.branches.length).toBe(8);
    expect(sk.attributes.get('weld')!.every((v) => v === 1)).toBe(true);
    const mesh = meshOf(r, 'br');
    const R = sagScale(48);
    for (const b of sk.branches) {
      // Vertices on the trunk skin (within 0.3 % of the radius) around this branch's base.
      const base: [number, number, number] = [sk.position[b.start * 3]!, sk.position[b.start * 3 + 1]!, sk.position[b.start * 3 + 2]!];
      let onSkin = 0;
      for (let v = 0; v < mesh.positions.length / 3; v++) {
        const p: [number, number, number] = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
        if (Math.hypot(p[0] - base[0], p[1] - base[1], p[2] - base[2]) > 0.6) continue;
        const fit = trunkFit(tr, p);
        if (Math.abs(fit.dist - fit.radius * R) < 0.003 * fit.radius) onSkin++;
      }
      expect(onSkin).toBeGreaterThanOrEqual(12);
    }
    // No NaN, valid indices.
    for (const x of mesh.positions) expect(Number.isFinite(x)).toBe(true);
    for (const i of mesh.indices) expect(i).toBeLessThan(mesh.positions.length / 3);
  });

  it('keeps the normals unit length and continuous at the weld (parent normal at the skin)', async () => {
    const r = await run(buildGraph(specs({ weldEnabled: true })));
    const mesh = meshOf(r, 'br');
    const tr = skeletonOf(r, 'tr');
    let checked = 0;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const l = Math.hypot(mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!);
      expect(l).toBeCloseTo(1, 3);
      const p: [number, number, number] = [mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!];
      const fit = trunkFit(tr, p);
      if (Math.abs(fit.dist - fit.radius * sagScale(48)) < 0.003 * fit.radius) {
        const dotN = mesh.normals[v * 3]! * fit.radial[0] + mesh.normals[v * 3 + 1]! * fit.radial[1] + mesh.normals[v * 3 + 2]! * fit.radial[2];
        expect(dotN).toBeGreaterThan(0.9);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('Keep curve: welds below 0.5 are dropped, the branch starts on the spine unfused', async () => {
    const off = buildGraph(specs({ weldEnabled: true }));
    off.setParam('br', 'weldKeep', { ...off.getNode('br')!.params.weldKeep!, curve: flatCurve(0) });
    const a = skeletonOf(await run(off), 'br');
    expect(a.branches.length).toBe(8);
    expect(a.attributes.get('weld')).toBeUndefined();
    // Step curve: only the upper half of the model is welded.
    const half = buildGraph(specs({ weldEnabled: true }));
    half.setParam('br', 'weldKeep', {
      ...half.getNode('br')!.params.weldKeep!,
      curve: { ...flatCurve(0), points: [stepPoint(0, 0), stepPoint(0.55, 0), stepPoint(0.56, 1), stepPoint(1, 1)] },
    });
    const rr = await run(half);
    const sk = skeletonOf(rr, 'br');
    const w = sk.attributes.get('weld')!;
    const zs = sk.branches.map((b) => ({ z: sk.position[b.start * 3 + 2]!, welded: w[b.start] === 1 }));
    const tr = skeletonOf(rr, 'tr');
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = 0; i < tr.count; i++) {
      zMin = Math.min(zMin, tr.position[i * 3 + 2]!);
      zMax = Math.max(zMax, tr.position[i * 3 + 2]!);
    }
    for (const e of zs) expect(e.welded).toBe((e.z - zMin) / (zMax - zMin) >= 0.555);
    expect(zs.some((e) => e.welded)).toBe(true);
    expect(zs.some((e) => !e.welded)).toBe(true);
  });

  it('removes branches whose weld failed unless Keep failed is on', async () => {
    // Children far shorter than their weld part cannot leave the parent: the weld fails.
    const fat = { length: { value: 0.04, variance: 0 }, lengthPercent: 0 };
    const dropped = (await run(buildGraph(specs({ weldEnabled: true, ...fat })))).scene.skeletons.find((s) => s.nodeId === 'br');
    expect(dropped?.skeleton.branches.length ?? 0).toBe(0);
    const kept = skeletonOf(await run(buildGraph(specs({ weldEnabled: true, weldKeepFailed: true, ...fat }))), 'br');
    expect(kept.branches.length).toBe(8);
    expect(kept.attributes.get('weld')!.every((v) => v === 2)).toBe(true);
    // Weld off: all there.
    expect(skeletonOf(await run(buildGraph(specs({ ...fat }))), 'br').branches.length).toBe(8);
  });

  it('works for Branch -> Branch (sub-levels of one node and a second Branch node)', async () => {
    const two: NodeSpec[] = [
      ...specs({ weldEnabled: true }),
      { id: 'br2', type: 'generator.branch', parent: 'br', params: { ...BRANCH, number: 3, radius: { value: 0.02, variance: 0 }, length: { value: 0.8, variance: 0 }, weldEnabled: true } as NodeSpec['params'] },
    ];
    const r = await run(buildGraph(two));
    const sk = skeletonOf(r, 'br2');
    expect(sk.branches.length).toBeGreaterThan(0);
    expect(sk.attributes.get('weld')!.every((v) => v === 1)).toBe(true);
    const levels = await run(buildGraph(specs({ weldEnabled: true, generations: 2 })));
    const lv = skeletonOf(levels, 'br');
    expect(lv.branches.some((b) => b.generation === 2)).toBe(true);
    for (const b of lv.branches) expect(lv.attributes.get('weld')![b.start]).toBe(1);
    expect(lv.attributes.get('weldSelf')!.some((v) => v === 1)).toBe(true);
    const mesh = meshOf(levels, 'br');
    for (const x of mesh.positions) expect(Number.isFinite(x)).toBe(true);
  });

  it('works for Trunk -> Root', async () => {
    const roots: NodeSpec[] = [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'tr', type: 'generator.trunk', parent: 'tree', params: TRUNK as NodeSpec['params'] },
      { id: 'rt', type: 'generator.root', parent: 'tr', params: { number: 4, first: 0, last: 0.1, radius: { value: 0.07, variance: 0 }, length: { value: 1.5, variance: 0 }, weldEnabled: true } as NodeSpec['params'] },
    ];
    const r = await run(buildGraph(roots));
    const sk = skeletonOf(r, 'rt');
    // Roots that sprout from the trunk are welded (forks inside a root keep their own junction).
    const w = sk.attributes.get('weld')!;
    const onOwnBranch = (b: (typeof sk.branches)[number]): boolean => {
      for (let i = 0; i < b.start; i++) {
        if (Math.hypot(sk.position[i * 3]! - sk.position[b.start * 3]!, sk.position[i * 3 + 1]! - sk.position[b.start * 3 + 1]!, sk.position[i * 3 + 2]! - sk.position[b.start * 3 + 2]!) < 1e-4) return true;
      }
      return false;
    };
    const splitInfo = sk.attributes.get('splitInfo');
    // the fused halves of a split are never welded (only the spine that splits keeps its base weld)
    const isHalf = (b: (typeof sk.branches)[number]): boolean => (((splitInfo?.[b.start] ?? 0) as number) & 6) !== 0;
    const sprouts = sk.branches.filter((b) => !onOwnBranch(b) && !isHalf(b));
    expect(sprouts.length).toBeGreaterThan(0);
    for (const b of sprouts) expect(w[b.start]).toBe(1);
    const mesh = meshOf(r, 'rt');
    for (const x of mesh.positions) expect(Number.isFinite(x)).toBe(true);
  });

  it('Force ray casts welds against the parent tube and is deterministic', async () => {
    const a = await run(buildGraph(specs({ weldEnabled: true, weldForceRays: true })));
    const b = await run(buildGraph(specs({ weldEnabled: true, weldForceRays: true })));
    expect(skeletonOf(a, 'br').branches.length).toBeGreaterThan(0);
    expect(Array.from(meshOf(a, 'br').positions)).toEqual(Array.from(meshOf(b, 'br').positions));
    expect(Array.from(meshOf(a, 'br').normals)).toEqual(Array.from(meshOf(b, 'br').normals));
  });

  it('Weld scalar changes the number of rings of the fused part', async () => {
    const one = meshOf(await run(buildGraph(specs({ weldEnabled: true, weldScalar: 1 }))), 'br').positions.length;
    const two = meshOf(await run(buildGraph(specs({ weldEnabled: true, weldScalar: 2 }))), 'br').positions.length;
    expect(two).toBeGreaterThan(one);
  });
});
