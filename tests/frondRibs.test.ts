import { beforeAll, describe, expect, it } from 'vitest';
import { OUTPUT_KEY } from '@/contracts/engine';
import { CancellationSource, type NodeContext, type NodeOutputs } from '@/contracts/nodes';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { buildFrondMesh, unitMeshFromGeometry, type FrondSpec, type UnitMesh } from '@/geometry/frondMesher';
import { bendPath, buildRibs, cleanPath, locateStation, mapToRibs, netForceDirection, ribCountOf, ribbonColumns, sampleRib, type RibSettings } from '@/geometry/frondRibs';
import type { V3 } from '@/geometry/math3';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import { createDefaultCutoutMesh } from '@/materials/cutouts/ops';
import { rebuildCutoutLods } from '@/materials/cutouts/lod';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildFrondSpecs, migrateFrondParams, unificationHint } from '@/nodes/generators/frond';

beforeAll(() => registerDiscoveredNodes());

const none = (): number => 0;
const settings = (over: Partial<RibSettings> = {}): RibSettings => ({
  halfWidthAt: () => 0.5,
  fold: none,
  curl: none,
  gravity: none,
  roll: 0,
  accuracy: 4,
  hint: [0, 0, 1],
  alignAmount: 0,
  alignDir: null,
  ...over,
});

/** Straight spine along +Y with `n` length segments. Face normal +Z, side +X. */
const spine = (n: number, length = 2): V3[] => Array.from({ length: n + 1 }, (_, i): V3 => [0, (i * length) / n, 0]);
const at = (r: ReturnType<typeof buildRibs>, i: number, u: number): V3 => {
  const out: number[] = [0, 0, 0];
  sampleRib(r!, i, u, out, 0);
  return [out[0] as number, out[1] as number, out[2] as number];
};

describe('ribs', () => {
  it('builds one rib pair per station of the parent spine', () => {
    const path = spine(8);
    const r = buildRibs(path, settings());
    expect(r?.count).toBe(9);
    expect(ribCountOf(path)).toBe(9);
    expect(r?.rib.length).toBe(9 * 2 * 5 * 3);
    // coincident points do not create ribs
    expect(cleanPath([[0, 0, 0], [0, 0, 0], [0, 1, 0]]).length).toBe(2);
    expect(buildRibs([[0, 0, 0]], settings())).toBeNull();
  });

  it('keeps the centre of every rib on the spine, whatever the deformation', () => {
    const path: V3[] = [[0, 0, 0], [0, 0.5, 0.2], [0.1, 1, 0.6], [0.3, 1.4, 1.1], [0.6, 1.6, 1.7]];
    const r = buildRibs(path, settings({ fold: () => 0.7, curl: () => 1.2, gravity: () => 0.8, roll: 0.5, accuracy: 6 }));
    for (let i = 0; i < path.length; i++) {
      const c = at(r, i, 0);
      expect(Math.hypot(c[0] - path[i]![0], c[1] - path[i]![1], c[2] - path[i]![2])).toBeLessThan(1e-5);
    }
  });

  it('is flat and as wide as requested without deformation', () => {
    const r = buildRibs(spine(4), settings({ halfWidthAt: () => 0.3 }));
    expect(at(r, 2, 1)[0]).toBeCloseTo(0.3, 5);
    expect(at(r, 2, -1)[0]).toBeCloseTo(-0.3, 5);
    expect(at(r, 2, 1)[2]).toBeCloseTo(0, 6);
  });

  it('Fold: positive lifts both edges toward the face, negative lowers them, edges stay symmetric', () => {
    const up = buildRibs(spine(4), settings({ fold: () => 0.5 }));
    const down = buildRibs(spine(4), settings({ fold: () => -0.5 }));
    for (const u of [-1, 1]) {
      expect(at(up, 2, u)[2]).toBeGreaterThan(0.1);
      expect(at(down, 2, u)[2]).toBeLessThan(-0.1);
    }
    expect(Math.abs(at(up, 2, 1)[0])).toBeCloseTo(Math.abs(at(up, 2, -1)[0]), 6);
    expect(Math.abs(at(up, 2, 1)[0])).toBeLessThan(0.5);
    expect(at(up, 2, 0.5)[2]).toBeGreaterThan(0);
  });

  it('Curl: positive rolls the outer edge toward the face and back toward the spine, negative goes the other way', () => {
    const pos = buildRibs(spine(4), settings({ curl: () => Math.PI * 0.9 }));
    const neg = buildRibs(spine(4), settings({ curl: () => -Math.PI * 0.9 }));
    expect(at(pos, 2, 1)[2]).toBeGreaterThan(0.1);
    expect(at(neg, 2, 1)[2]).toBeLessThan(-0.1);
    expect(Math.abs(at(pos, 2, 1)[0])).toBeLessThan(0.5);
    // the rib keeps its length: the arc is length preserving
    let l = 0;
    let prev = at(pos, 2, 0);
    for (let j = 1; j <= 40; j++) {
      const q = at(pos, 2, j / 40);
      l += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
      prev = q;
    }
    expect(l).toBeGreaterThan(0.48);
    expect(l).toBeLessThan(0.51);
  });

  it('Gravity: positive pulls the edges down (world -Z), negative lifts them, the centre stays', () => {
    const down = buildRibs(spine(4), settings({ gravity: () => 0.5 }));
    const lift = buildRibs(spine(4), settings({ gravity: () => -0.5 }));
    for (const u of [-1, 1]) {
      expect(at(down, 2, u)[2]).toBeCloseTo(-0.25, 5);
      expect(at(lift, 2, u)[2]).toBeCloseTo(0.25, 5);
    }
    expect(at(down, 2, 0)[2]).toBeCloseTo(0, 6);
    expect(at(down, 2, 0.5)[2]).toBeGreaterThan(at(down, 2, 1)[2]);
  });

  it('Roll turns the face around the spine', () => {
    const r = buildRibs(spine(4), settings({ roll: Math.PI / 2 }));
    const nx = r!.normal[2 * 3] as number;
    const nz = r!.normal[2 * 3 + 2] as number;
    expect(Math.abs(nz)).toBeLessThan(1e-5);
    expect(Math.abs(nx)).toBeCloseTo(1, 5);
  });

  it('Align turns the face away from the force', () => {
    const tilted = settings({ hint: [1, 0, 0] });
    const plain = buildRibs(spine(4), tilted);
    const aligned = buildRibs(spine(4), { ...tilted, alignAmount: 1, alignDir: [0, 0, -1] });
    expect(Math.abs(plain!.normal[2 * 3 + 2] as number)).toBeLessThan(1e-5);
    expect(aligned!.normal[2 * 3 + 2] as number).toBeCloseTo(1, 5);
    const half = buildRibs(spine(4), { ...tilted, alignAmount: 0.5, alignDir: [0, 0, -1] });
    expect(half!.normal[2 * 3 + 2] as number).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('locates stations and maps (u, v) onto the ribs, centre line on the spine', () => {
    const path: V3[] = [[0, 0, 0], [0, 1, 0], [0, 3, 0]];
    const r = buildRibs(path, settings())!;
    expect(locateStation(r, 0)).toEqual({ i: 0, f: 0 });
    const loc = locateStation(r, 0.5);
    expect(loc.i).toBe(1);
    expect(loc.f).toBeCloseTo(0.25, 5);
    const out: number[] = [0, 0, 0];
    mapToRibs(r, 0, 0.5, out, 0);
    expect(out[1]).toBeCloseTo(1.5, 5);
    expect(Math.abs(out[0] as number)).toBeLessThan(1e-6);
    mapToRibs(r, 1, 1, out, 0);
    expect(out[0]).toBeCloseTo(0.5, 5);
  });
});

describe('ribbon columns', () => {
  it('uses Absolute + Relative per metre and is always even', () => {
    expect(ribbonColumns(2, 0, 5)).toBe(2);
    expect(ribbonColumns(3, 0, 5)).toBe(4);
    expect(ribbonColumns(2, 1, 4)).toBe(6);
    expect(ribbonColumns(1, 0, 1)).toBe(2);
    expect(ribbonColumns(500, 0, 1)).toBeLessThanOrEqual(64);
  });
});

describe('forces', () => {
  const f = (g: number, u = 0, a = 0) => ({ gravity: () => g, upDown: () => u, ancestor: () => a });
  const len = (p: V3[]): number => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i]![0], q[1] - p[i]![1], q[2] - p[i]![2]), 0);

  it('keeps the base and the length of the parent spine', () => {
    const path = spine(8, 3).map((p): V3 => [p[0], p[1], p[2] + p[1] * 0.2]);
    const bent = bendPath(path, f(0.8));
    expect(bent[0]).toEqual(path[0]);
    expect(bent.length).toBe(path.length);
    expect(len(bent)).toBeCloseTo(len(path), 4);
  });

  it('gravity bends the tip down, up/down lifts it, no force changes nothing', () => {
    const path = spine(6);
    expect(bendPath(path, f(1))[6]![2]).toBeLessThan(-0.2);
    expect(bendPath(path, f(0, 1))[6]![2]).toBeGreaterThan(0.2);
    expect(bendPath(path, f(0))[6]).toEqual(path[6]);
  });

  it('net force direction follows the signs', () => {
    expect(netForceDirection(1, 0)).toEqual([0, 0, -1]);
    expect(netForceDirection(0, 1)).toEqual([0, 0, 1]);
    expect(netForceDirection(1, 1)).toBeNull();
  });
});

const unitFromCutout = (): UnitMesh => {
  const c = createDefaultCutoutMesh('c', 'c', 'leaf');
  c.outline = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
  c.interiorPoints = [];
  rebuildCutoutLods(c);
  const g = buildCutoutGeometry(c, 'high', { origin: [0, 0, 0], axis: [0, 1, 0], side: [1, 0, 0], length: 1, width: 1, metric: { w: 1, h: 1 }, applyPanelTransform: false });
  const unit = unitMeshFromGeometry(g);
  if (!unit) throw new Error('cutout produced no geometry');
  return unit;
};

const baseSpec = (ribs: NonNullable<ReturnType<typeof buildRibs>>, over: Partial<FrondSpec> = {}): FrondSpec => ({
  ribs,
  materialId: 'leaf',
  mesh: null,
  columns: 2,
  flip: false,
  twoSided: false,
  atlas: [0, 0, 1, 1],
  color: [0.2, 0.4, 0.1],
  colorGradient: 0,
  ao: 0.5,
  wind: [0, 0.2, 0.3, 0.4],
  windPower: 1.5,
  heightScale: 1,
  heightAmount: 1,
  heightOffset: 0,
  heightMap: null,
  ...over,
});

describe('frond mesher', () => {
  it('maps a cutout mesh onto the ribs: u across, v along, centre vertices stay on the spine', () => {
    const unit = unitFromCutout();
    expect(Math.max(...unit.u)).toBeLessThanOrEqual(1 + 1e-6);
    expect(Math.min(...unit.v)).toBeCloseTo(0, 5);
    expect(Math.max(...unit.v)).toBeCloseTo(1, 5);
    const path: V3[] = [[0, 0, 0], [0, 0.6, 0.1], [0.1, 1.2, 0.4], [0.3, 1.7, 0.9]];
    const ribs = buildRibs(path, settings({ fold: () => 0.4, gravity: () => 0.3 }))!;
    const mesh = buildFrondMesh([baseSpec(ribs, { mesh: unit })]);
    expect(mesh.positions.length / 3).toBe(unit.u.length);
    for (let i = 0; i < unit.u.length; i++) {
      if (Math.abs(unit.u[i] as number) > 1e-6) continue;
      const q: number[] = [0, 0, 0];
      const out: number[] = [0, 0, 0];
      mapToRibs(ribs, 0, unit.v[i] as number, out, 0);
      for (let c = 0; c < 3; c++) q[c] = mesh.positions[i * 3 + c] as number;
      expect(Math.hypot(q[0]! - out[0]!, q[1]! - out[1]!, q[2]! - out[2]!)).toBeLessThan(1e-4);
    }
    for (const v of [...mesh.positions, ...mesh.normals, ...mesh.uv0]) expect(Number.isFinite(v)).toBe(true);
    expect(mesh.slots[0]?.indexCount).toBe(mesh.indices.length);
  });

  it('falls back to a ribbon grid when no mesh is assigned', () => {
    const ribs = buildRibs(spine(5), settings())!;
    const ribbon = buildFrondMesh([baseSpec(ribs, { columns: 4 })]);
    expect(ribbon.positions.length / 3).toBe(6 * 5);
    expect(ribbon.indices.length / 3).toBe(5 * 4 * 2);
    const mapped = buildFrondMesh([baseSpec(ribs, { mesh: unitFromCutout() })]);
    expect(mapped.positions.length).not.toBe(ribbon.positions.length);
  });

  it('puts a vertex row on the centre line and faces the front, with V along and U across', () => {
    const ribs = buildRibs(spine(4), settings())!;
    const m = buildFrondMesh([baseSpec(ribs, { columns: 2 })]);
    for (let i = 0; i < 5; i++) {
      const q = (i * 3 + 1) * 3;
      expect(Math.abs(m.positions[q] as number)).toBeLessThan(1e-6);
      expect(m.uv0[(i * 3 + 1) * 2]).toBeCloseTo(0.5, 6);
      expect(m.uv0[(i * 3 + 1) * 2 + 1]).toBeCloseTo(i / 4, 6);
    }
    for (let i = 0; i < m.normals.length / 3; i++) expect(m.normals[i * 3 + 2]).toBeGreaterThan(0.99);
    expect(m.tangents?.length).toBe((m.positions.length / 3) * 4);
    expect(m.wind?.weights.length).toBe((m.positions.length / 3) * 4);
    // bend weight rises along the length
    const w2 = (i: number): number => m.wind!.weights[i * 4 + 2] as number;
    expect(w2(12)).toBeGreaterThan(w2(0));
  });

  it('Two sided duplicates the geometry with flipped normals; Flip mirrors across the spine', () => {
    const ribs = buildRibs(spine(3), settings())!;
    const one = buildFrondMesh([baseSpec(ribs)]);
    const two = buildFrondMesh([baseSpec(ribs, { twoSided: true })]);
    expect(two.indices.length).toBe(2 * one.indices.length);
    const n = one.positions.length / 3;
    expect(two.normals[n * 3 + 2]).toBeCloseTo(-(two.normals[2] as number), 6);
    const unit = unitFromCutout();
    const plain = buildFrondMesh([baseSpec(ribs, { mesh: unit })]);
    const flipped = buildFrondMesh([baseSpec(ribs, { mesh: unit, flip: true })]);
    let mirrored = 0;
    for (let i = 0; i < unit.u.length; i++) if (Math.abs((plain.positions[i * 3] as number) + (flipped.positions[i * 3] as number)) < 1e-5) mirrored++;
    expect(mirrored).toBe(unit.u.length);
    for (let i = 0; i < flipped.normals.length / 3; i++) expect(flipped.normals[i * 3 + 2]).toBeGreaterThan(0);
  });

  it('builds 2,000 fronds x 8 length segments in under a second', () => {
    const specs: FrondSpec[] = [];
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      const path = spine(8, 1 + (i % 5) * 0.2).map((p): V3 => [p[0] + i * 0.01, p[1], p[2] + p[1] * 0.3]);
      const ribs = buildRibs(path, settings({ fold: () => 0.3, gravity: () => 0.2, accuracy: 4 }));
      if (ribs) specs.push(baseSpec(ribs, { columns: 4, materialId: i % 2 ? 'a' : 'b' }));
    }
    const mesh = buildFrondMesh(specs);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(mesh.slots.map((s) => s.materialId).sort()).toEqual(['a', 'b']);
    expect(mesh.positions.length / 3).toBe(2000 * 9 * 5);
  });
});

describe('Frond node', () => {
  const stem = (): Skeleton => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.03);
    sb.endBranch();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i <= 8; i++) sb.addPoint(1, 0, i * 0.5, 0.03);
    sb.endBranch();
    return sb.build();
  };
  const params = (over: Record<string, unknown> = {}): NodeParams => {
    const def = getNodeDef('generator.frond');
    if (!def) throw new Error('Frond missing');
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = defaultParamState(d);
    for (const [k, v] of Object.entries(over)) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
    return p;
  };
  const ctx = (seed = 1, lod = 0): NodeContext => ({ nodeId: 'f', name: 'f', rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod, logger: createLogger('dev', 'error') });

  it('makes one rib pair per length segment of the parent spine', () => {
    const { specs } = buildFrondSpecs(ctx(), stem(), params());
    expect(specs.length).toBe(2);
    for (const s of specs) {
      expect(s.ribs.count).toBe(9);
      expect(s.mesh).toBeNull();
      expect(s.ribs.length).toBeCloseTo(4, 4);
    }
  });

  it('the Boundary Start / End trim the parent spine', () => {
    const { specs, paths } = buildFrondSpecs(ctx(), stem(), params({ frondBoundaryStart: 0.25, frondBoundaryEnd: 0.75 }));
    const r = specs[0]!.ribs;
    expect(r.count).toBe(5);
    expect(r.point[2]).toBeCloseTo(1, 5);
    expect(r.point[(r.count - 1) * 3 + 2]).toBeCloseTo(3, 5);
    expect(paths[0]!.length).toBe(5);
    expect(buildFrondSpecs(ctx(), stem(), params({ frondBoundaryStart: 0.5, frondBoundaryEnd: 0.5 })).specs.length).toBe(0);
  });

  it('the frond keeps the length of the parent spine whatever Width / forces say', () => {
    const { specs } = buildFrondSpecs(ctx(), stem(), params({ frondWidth: 3, frondForceGravityOn: true, frondForceGravity: 2 }));
    expect(specs[0]!.ribs.length).toBeCloseTo(4, 3);
  });

  it('is deterministic: same graph + seed -> same ribs, Flip subset and mesh', () => {
    const over = { frondFlip: true, frondWidth: 0.3, frondRoll: 20 };
    const a = buildFrondSpecs(ctx(7), stem(), params(over));
    const b = buildFrondSpecs(ctx(7), stem(), params(over));
    expect(a.specs.map((s) => s.flip)).toEqual(b.specs.map((s) => s.flip));
    expect(Array.from(a.specs[1]!.ribs.rib)).toEqual(Array.from(b.specs[1]!.ribs.rib));
    expect(a.specs.some((s) => s.flip)).toBe(true);
    const flips = Array.from({ length: 24 }, (_, s) => buildFrondSpecs(ctx(s + 1), stem(), params({ frondFlip: true })).specs[0]!.flip);
    expect(flips.some(Boolean)).toBe(true);
    expect(flips.every(Boolean)).toBe(false);
  });

  it('planes per spine and LOD accuracy change the rib layout', () => {
    expect(buildFrondSpecs(ctx(), stem(), params({ frondPlanes: 3 })).specs.length).toBe(6);
    const hi = buildFrondSpecs(ctx(1, 0), stem(), params({ frondAccuracy: 8 })).specs[0]!.ribs.accuracy;
    const lo = buildFrondSpecs(ctx(1, 3), stem(), params({ frondAccuracy: 8 })).specs[0]!.ribs.accuracy;
    expect(hi).toBe(8);
    expect(lo).toBeLessThan(hi);
  });

  it('Unification points the face away from the anchor', () => {
    expect(unificationHint('none', [0, 0, 0], [2, 0, 1])).toEqual([0, 0, 1]);
    const out = unificationHint('origin', [0, 0, 0], [2, 0, 0]);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(unificationHint('global', null, [2, 0, 0])).toEqual([0, 0, 1]);
    const { specs } = buildFrondSpecs(ctx(), stem(), params({ frondUnification: 'origin' }));
    // the second spine stands at x = 1: its face looks away from the origin (+X) instead of up
    const n = specs[1]!.ribs.normal;
    expect(Math.abs(n[0] as number)).toBeGreaterThan(0.9);
  });

  it('Gravity (Height) bends the edges, the Gravity force bends the spine of a leaning stem', () => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i <= 8; i++) sb.addPoint(i * 0.3, 0, i * 0.3, 0.03);
    sb.endBranch();
    const lean = sb.build();
    const tip = (r: { point: Float32Array; count: number }): number => r.point[(r.count - 1) * 3 + 2] as number;
    const base = buildFrondSpecs(ctx(), lean, params()).specs[0]!.ribs;
    const edges = buildFrondSpecs(ctx(), lean, params({ frondGravity: 1 })).specs[0]!.ribs;
    expect(tip(edges)).toBeCloseTo(tip(base), 4);
    expect(edges.rib[(edges.count - 1) * 2 * 5 * 3 + 4 * 3 + 2]).toBeLessThan(tip(base));
    const forced = buildFrondSpecs(ctx(), lean, params({ frondForceGravityOn: true, frondForceGravity: 1 })).specs[0]!.ribs;
    expect(tip(forced)).toBeLessThan(tip(base) - 0.1);
    expect(forced.length).toBeCloseTo(base.length, 3);
  });

  it('exposes the documented parameters and groups', () => {
    const def = getNodeDef('generator.frond')!;
    const by = (id: string) => def.params.find((d) => d.id === id);
    expect(by('frondUnification')).toMatchObject({ group: 'Shape', label: 'Unification' });
    for (const [id, sub] of [['frondHeightAmount', 'Height'], ['frondHeightOffset', 'Height'], ['frondGravity', 'Height'], ['frondFold', 'Height'], ['frondCurlAngle', 'Height'], ['frondRoll', 'Height'], ['frondBoundaryStart', 'Boundary'], ['frondBoundaryEnd', 'Boundary'], ['frondWidth', 'Scale'], ['frondScaleHeight', 'Scale']] as const) {
      expect(by(id)).toMatchObject({ group: 'Shape', subgroup: sub });
    }
    expect(by('frondAccuracy')).toMatchObject({ group: 'Segments' });
    expect(by('frondWidthAbsolute')).toMatchObject({ group: 'Segments', subgroup: 'Width', label: 'Absolute' });
    expect(by('frondWidthRelative')).toMatchObject({ label: '+ Relative' });
    expect(by('frondFlip')).toMatchObject({ group: 'Material', label: 'Flip' });
    expect(by('frondTwoSided')).toMatchObject({ group: 'Material', label: 'Two sided' });
    expect(by('frondMeshIndex')).toMatchObject({ group: 'Material', subgroup: 'Mesh', label: 'Index' });
    expect(by('frondMeshLod')).toMatchObject({ group: 'Material', subgroup: 'Mesh', label: 'Resolution' });
    expect(by('frondAlign')).toMatchObject({ group: 'Forces', subgroup: 'Align', label: 'Amount' });
    for (const id of ['frondForceGravity', 'frondForceUp', 'frondForceAncestor']) expect(by(id)).toMatchObject({ group: 'Forces', curveAllowed: true });
  });
});

describe('Frond migration', () => {
  it('maps the old ribbon params (v2) to the rib-based ones', () => {
    const old: NodeParams = {
      first: { value: 0.2 },
      last: { value: 0.9 },
      frondShape: { value: 'v-fold' },
      frondFoldAngle: { value: 55 },
      frondDroop: { value: 0.5 },
      frondFacing: { value: 'outward' },
      frondWidthSegments: { value: 3 },
      frondFaces: { value: 'duplicate-back-faces' },
      frondLengthSegments: { value: 10 },
      frondInstancing: { value: true },
      frondWidth: { value: 0.4, variance: 0.1 },
    };
    const m = migrateFrondParams(old, 2);
    expect(m.frondBoundaryStart?.value).toBe(0.2);
    expect(m.frondBoundaryEnd?.value).toBe(0.9);
    expect(m.frondFold?.value).toBe(55);
    expect(m.frondForceGravityOn?.value).toBe(true);
    expect(m.frondForceGravity?.value).toBeCloseTo(0.8);
    expect(m.frondUnification?.value).toBe('origin');
    expect(m.frondWidthAbsolute?.value).toBe(3);
    expect(m.frondTwoSided?.value).toBe(true);
    expect(m.frondWidth).toEqual({ value: 0.4, variance: 0.1 });
    for (const id of ['first', 'last', 'frondShape', 'frondFoldAngle', 'frondDroop', 'frondFacing', 'frondLengthSegments', 'frondInstancing']) expect(m[id]).toBeUndefined();
  });

  it('maps u-curve + curl, keeps default droop, and leaves current graphs alone', () => {
    const m = migrateFrondParams({ frondShape: { value: 'u-curve' }, frondFoldAngle: { value: 80 }, frondCurl: { value: 0.5 } }, 2);
    expect(m.frondCurlAngle?.value).toBeCloseTo(85);
    expect(m.frondForceGravity?.value).toBeCloseTo(0.48);
    const cur: NodeParams = { frondWidth: { value: 1 } };
    expect(migrateFrondParams(cur, 3)).toBe(cur);
  });

  it('a migrated old graph evaluates to a mesh', async () => {
    const def = getNodeDef('generator.frond')!;
    const migrated = migrateFrondParams({ first: { value: 0.1 }, frondShape: { value: 'u-curve' } }, 2);
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = migrated[d.id] ?? defaultParamState(d);
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i <= 4; i++) sb.addPoint(0, 0, i * 0.4, 0.02);
    sb.endBranch();
    const out = (await def.evaluate(
      { nodeId: 'f', name: 'f', rng: new Rng(1), seed: 1, cancel: new CancellationSource().token, lod: 0, logger: createLogger('dev', 'error') },
      { parent: [{ kind: 'Structure', value: { skeleton: sb.build() } }] },
      p,
    )) as NodeOutputs;
    const g = out[OUTPUT_KEY.geometry];
    expect(g && g.kind === 'Mesh' ? g.value.indices.length : 0).toBeGreaterThan(0);
  });
});
