import { beforeAll, describe, expect, it } from 'vitest';
import { OUTPUT_KEY } from '@/contracts/engine';
import { CancellationSource, type NodeContext, type NodeOutputs } from '@/contracts/nodes';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { NEUTRAL_LEAF_LIGHTING } from '@/contracts/lighting';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { buildFrondMesh, unitMeshFromGeometry, type FrondSpec, type UnitMesh } from '@/geometry/frondMesher';
import { buildRibs, sampleRib, type RibSettings, type Ribs } from '@/geometry/frondRibs';
import { hasSectionVariance, leftRightScales, NEUTRAL_SECTION_VARIANCE, sectionDeltas, spreadDraw, type SectionVarianceSettings } from '@/geometry/frondVariance';
import { DEFAULT_FROND_WIND, frondWindAt, ribsLevelOf } from '@/geometry/frondWind';
import type { V3 } from '@/geometry/math3';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import { rebuildCutoutLods } from '@/materials/cutouts/lod';
import { createDefaultCutoutMesh } from '@/materials/cutouts/ops';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildFrondSpecs, readSectionVariance } from '@/nodes/generators/frond';
import { resolveFrondLighting } from '@/nodes/generators/frondLightingParams';

beforeAll(() => registerDiscoveredNodes());

const settings = (over: Partial<RibSettings> = {}): RibSettings => ({
  halfWidthAt: () => 0.5,
  fold: () => 0.4,
  curl: () => 0.8,
  gravity: () => 0.5,
  roll: 0,
  accuracy: 4,
  hint: [0, 0, 1],
  alignAmount: 0,
  alignDir: null,
  ...over,
});
const spine = (n: number, length = 2): V3[] => Array.from({ length: n + 1 }, (_, i): V3 => [0, (i * length) / n, 0]);
const rib = (r: Ribs, i: number, u: number): V3 => {
  const out: number[] = [0, 0, 0];
  sampleRib(r, i, u, out, 0);
  return [out[0] as number, out[1] as number, out[2] as number];
};
const must = (r: Ribs | null): Ribs => {
  if (!r) throw new Error('no ribs');
  return r;
};
const seq = (seed: number): (() => number) => {
  const r = new Rng(seed);
  return () => r.next();
};

describe('Left-Right Variance', () => {
  it('amount 0 keeps both halves identical (mirror images)', () => {
    const sides = leftRightScales({ amount: 0 }, seq(3));
    expect(sides.left).toEqual({ fold: 1, curl: 1, gravity: 1 });
    expect(sides.right).toEqual({ fold: 1, curl: 1, gravity: 1 });
    const r = must(buildRibs(spine(4), settings({ sides })));
    for (const u of [0.5, 1]) {
      const l = rib(r, 2, -u);
      const rr = rib(r, 2, u);
      expect(l[0]).toBeCloseTo(-rr[0], 6);
      expect(l[2]).toBeCloseTo(rr[2], 6);
    }
  });

  it('amount > 0 lets the two halves react differently to Fold, Curl and Gravity', () => {
    const sides = leftRightScales({ amount: 0.8 }, seq(3));
    expect(sides.left).not.toEqual(sides.right);
    const r = must(buildRibs(spine(4), settings({ sides })));
    const l = rib(r, 2, -1);
    const rr = rib(r, 2, 1);
    expect(Math.abs(l[2] - rr[2])).toBeGreaterThan(0.002);
    expect(Math.abs(Math.abs(l[0]) - Math.abs(rr[0]))).toBeGreaterThan(0.001);
    // the spine itself never moves
    const c = rib(r, 2, 0);
    expect(c[0]).toBeCloseTo(0, 6);
  });

  it('is deterministic and the multipliers stay inside 1 +- amount', () => {
    const a = leftRightScales({ amount: 0.5 }, seq(9));
    const b = leftRightScales({ amount: 0.5 }, seq(9));
    expect(a).toEqual(b);
    for (const v of [a.left, a.right]) {
      for (const k of [v.fold, v.curl, v.gravity]) {
        expect(k).toBeGreaterThanOrEqual(0.5);
        expect(k).toBeLessThanOrEqual(1.5);
      }
    }
    expect(leftRightScales({ amount: 0.5 }, seq(10))).not.toEqual(a);
  });

  it('the Frond node applies it per spine (seed changes the result, amount 0 does not)', () => {
    const def = getNodeDef('generator.frond');
    if (!def) throw new Error('Frond missing');
    const run = (over: Record<string, unknown>): Ribs => buildFrondSpecs(ctx(), stem(), params(over)).specs[0]!.ribs;
    const base = { frondFold: 30, frondCurlAngle: 40, frondGravity: 0.4 };
    const flat = run({ ...base, frondLRAmount: 0 });
    const flatB = run({ ...base, frondLRAmount: 0, frondLRSeed: 5 });
    expect(Array.from(flat.rib)).toEqual(Array.from(flatB.rib));
    const a = run({ ...base, frondLRAmount: 0.9, frondLRSeed: 1 });
    const b = run({ ...base, frondLRAmount: 0.9, frondLRSeed: 2 });
    expect(Array.from(a.rib)).not.toEqual(Array.from(b.rib));
    expect(Math.abs(rib(a, 4, -1)[2] - rib(a, 4, 1)[2])).toBeGreaterThan(0.005);
  });
});

/** A 3 x 3 vertex patch: u in -1..1, v in 0..1. Vertices with u > 0.5 belong to section 2. */
const patch = (): UnitMesh => {
  const us = [-1, 0, 1];
  const vs = [0, 0.5, 1];
  const u: number[] = [];
  const v: number[] = [];
  for (const b of vs) for (const a of us) {
      u.push(a);
      v.push(b);
    }
  const idx: number[] = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      const a = r * 3 + c;
      idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
    }
  }
  const section = new Uint8Array(u.map((x) => (x > 0.5 ? 2 : 1)));
  return {
    u: new Float32Array(u),
    v: new Float32Array(v),
    z: new Float32Array(u.length),
    uv: new Float32Array(u.length * 2),
    indices: new Uint32Array(idx),
    section,
    sections: [2],
  };
};

const specFor = (ribs: Ribs, over: Partial<FrondSpec> = {}): FrondSpec => ({
  ribs,
  materialId: 'leaf',
  mesh: patch(),
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

describe('Section Variance', () => {
  it('only the vertices of the painted section move; section 1 keeps the whole-mesh values', () => {
    const base = must(buildRibs(spine(4), settings({ fold: () => 0, curl: () => 0, gravity: () => 0 })));
    const varied = must(buildRibs(spine(4), settings({ fold: () => 0.6, curl: () => 0, gravity: () => 0.5 })));
    const plain = buildFrondMesh([specFor(base)]);
    const shifted = buildFrondMesh([specFor(base, { sectionRibs: [null, null, varied] })]);
    const mesh = patch();
    expect(plain.positions.length).toBe(shifted.positions.length);
    let moved = 0;
    for (let i = 0; i < mesh.u.length; i++) {
      const d = Math.hypot(
        (plain.positions[i * 3] as number) - (shifted.positions[i * 3] as number),
        (plain.positions[i * 3 + 1] as number) - (shifted.positions[i * 3 + 1] as number),
        (plain.positions[i * 3 + 2] as number) - (shifted.positions[i * 3 + 2] as number),
      );
      if ((mesh.section as Uint8Array)[i] === 2) {
        expect(d).toBeGreaterThan(0.01);
        moved++;
      } else {
        expect(d).toBeLessThan(1e-6);
      }
    }
    expect(moved).toBe(3);
  });

  it('unitMeshFromGeometry reads the painted section ids; an unpainted mesh has none', () => {
    const c = createDefaultCutoutMesh('c', 'c', 'leaf');
    c.outline = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
    c.interiorPoints = [];
    rebuildCutoutLods(c);
    const build = (): UnitMesh => {
      const g = buildCutoutGeometry(c, 'high', { origin: [0, 0, 0], axis: [0, 1, 0], side: [1, 0, 0], length: 1, width: 1, metric: { w: 1, h: 1 }, applyPanelTransform: false });
      const unit = unitMeshFromGeometry(g);
      if (!unit) throw new Error('no geometry');
      return unit;
    };
    expect(build().sections).toEqual([]);
    expect(build().section).toBeNull();
    c.paint.vertexSection.fill(3);
    const painted = build();
    expect(painted.sections).toEqual([3]);
    expect(painted.section?.length).toBe(painted.u.length);
  });

  it('section deltas: offset shifts, amount spreads, section 1 is untouched, deterministic', () => {
    const s: SectionVarianceSettings = { ...NEUTRAL_SECTION_VARIANCE, fold: { amount: 0, offset: 12 }, roll: { amount: 30, offset: 0 } };
    expect(hasSectionVariance(NEUTRAL_SECTION_VARIANCE)).toBe(false);
    expect(hasSectionVariance(s)).toBe(true);
    const d = sectionDeltas(s, seq(4));
    expect(d[0]).toBeNull();
    expect(d[1]).toBeNull();
    for (let id = 2; id <= 8; id++) {
      expect(d[id]?.fold).toBe(12);
      expect(Math.abs(d[id]?.roll ?? 99)).toBeLessThanOrEqual(30);
    }
    expect(new Set(d.slice(2).map((x) => x?.roll)).size).toBeGreaterThan(1);
    expect(sectionDeltas(s, seq(4))).toEqual(d);
  });

  it('Favor Outliers widens the distribution', () => {
    const variance = (favor: boolean): number => {
      const next = seq(21);
      let sum = 0;
      let sq = 0;
      const n = 4000;
      for (let i = 0; i < n; i++) {
        const x = spreadDraw(next(), favor);
        sum += x;
        sq += x * x;
      }
      const mean = sum / n;
      return sq / n - mean * mean;
    };
    const plain = variance(false);
    const outliers = variance(true);
    expect(outliers).toBeGreaterThan(plain * 1.3);
    expect(spreadDraw(1, true)).toBeCloseTo(1, 2);
    expect(spreadDraw(0, true)).toBeCloseTo(-1, 6);
    expect(spreadDraw(0.5, true)).toBe(0);
  });

  it('is read from the parameters', () => {
    const p = params({ frondSecOutliers: true, frondSecFoldAmount: 20, frondSecGravityOffset: 0.3 });
    const v = readSectionVariance(p);
    expect(v.favorOutliers).toBe(true);
    expect(v.fold.amount).toBe(20);
    expect(v.gravity.offset).toBe(0.3);
    expect(readSectionVariance(params())).toEqual(NEUTRAL_SECTION_VARIANCE);
  });

  it('a ribbon (no mesh, no sections) keeps the whole-mesh values', () => {
    const { specs } = buildFrondSpecs(ctx(), stem(), params({ frondSecFoldAmount: 40, frondSecFoldOffset: 20 }));
    expect(specs[0]?.sectionRibs).toBeUndefined();
  });
});

describe('Frond wind', () => {
  const zero = [0, 0, 0, 0.4];
  const out = [0, 0, 0, 0];

  it('own weight is 0 at the base for every profile, Cross, Boost and Ribs setting', () => {
    const wind = { ...DEFAULT_FROND_WIND, weight: () => 1, boost: () => 1, cross: 1, ribsBranchWind: true, ribsWeight: 1, ribsLevel: 1 };
    for (const u of [-1, -0.4, 0, 0.7, 1]) {
      frondWindAt(zero, 0, u, wind, out);
      expect(out.slice(0, 3)).toEqual([0, 0, 0]);
      expect(out[3]).toBe(0.4);
    }
    frondWindAt(zero, 1, 0.5, wind, out);
    expect(out[2]).toBeGreaterThan(0.2);
  });

  it('Weight follows its profile and grows toward the tip', () => {
    const w = (t: number, weight: (t: number) => number): number => (frondWindAt(zero, t, 0, { ...DEFAULT_FROND_WIND, weight }, out), out[2] as number);
    expect(w(0.8, () => 1)).toBeGreaterThan(w(0.3, () => 1));
    expect(w(0.8, () => 0)).toBe(0);
    expect(w(0.8, (t) => t)).toBeLessThan(w(0.8, () => 1));
  });

  it('Cross: the motion grows from the spine to the edge', () => {
    const at = (u: number, cross: number): number => (frondWindAt(zero, 0.8, u, { ...DEFAULT_FROND_WIND, cross }, out), out[2] as number);
    expect(at(0, 1)).toBe(0);
    expect(at(1, 1)).toBeGreaterThan(at(0.5, 1));
    expect(at(0, 0)).toBeCloseTo(at(1, 0), 9);
  });

  it('Boost adds absolute weight, curve left = base, right = tip', () => {
    const at = (t: number): number => (frondWindAt(zero, t, 0, { ...DEFAULT_FROND_WIND, weight: () => 0, boost: (x) => 0.5 * x }, out), out[2] as number);
    expect(at(0)).toBe(0);
    expect(at(1)).toBeCloseTo(0.5, 6);
    expect(at(0.5)).toBeCloseTo(0.25, 6);
  });

  it('Ribs: branch wind reaches only vertices off the spine, only past the base, and on the level above the parent', () => {
    const wind = { ...DEFAULT_FROND_WIND, weight: () => 0, ribsBranchWind: true, ribsWeight: 0.8, ribsLevel: ribsLevelOf(2) };
    expect(ribsLevelOf(0)).toBe(0);
    expect(ribsLevelOf(1)).toBe(0);
    expect(ribsLevelOf(2)).toBe(1);
    expect(ribsLevelOf(5)).toBe(1);
    frondWindAt([0.5, 0.2, 0.1, 0], 0.6, 0, wind, out);
    expect(out[1]).toBeCloseTo(0.2, 9);
    frondWindAt([0.5, 0.2, 0.1, 0], 0.6, 1, wind, out);
    expect(out[1]).toBeGreaterThan(0.5);
    expect(out[0]).toBe(0.5);
    frondWindAt([0.5, 0.2, 0.1, 0], 0, 1, wind, out);
    expect(out[1]).toBeCloseTo(0.2, 9);
    frondWindAt([0.5, 0.2, 0.1, 0], 0.6, 1, { ...wind, ribsBranchWind: false }, out);
    expect(out[1]).toBeCloseTo(0.2, 9);
  });

  it('mesh vertices at the base are static (own weight 0), the tip moves', () => {
    const r = must(buildRibs(spine(6), settings({ fold: () => 0, curl: () => 0, gravity: () => 0 })));
    const wind = { ...DEFAULT_FROND_WIND, boost: () => 1, cross: 0.5, ribsBranchWind: true, ribsWeight: 1, ribsLevel: 0 };
    const m = buildFrondMesh([specFor(r, { mesh: null, columns: 4, wind: [0, 0, 0, 0.4], windSet: wind })]);
    const weights = m.wind?.weights;
    if (!weights) throw new Error('no wind');
    const n = m.positions.length / 3;
    let tipMax = 0;
    for (let i = 0; i < n; i++) {
      const z = m.positions[i * 3 + 1] as number;
      const w = [weights[i * 4], weights[i * 4 + 1], weights[i * 4 + 2]] as number[];
      if (z < 1e-6) expect(w).toEqual([0, 0, 0]);
      else if (z > 1.99) tipMax = Math.max(tipMax, ...w);
    }
    expect(tipMax).toBeGreaterThan(0.5);
  });

  it('the Frond node passes the wind parameters into the spec', () => {
    const { specs } = buildFrondSpecs(ctx(), stem(), params({ frondWindCross: 0.7, frondRibsBranchWind: true, frondRibsWeight: 0.3, frondWindBoost: 0.2 }));
    const w = specs[0]?.windSet;
    expect(w?.cross).toBeCloseTo(0.7, 9);
    expect(w?.ribsBranchWind).toBe(true);
    expect(w?.ribsWeight).toBeCloseTo(0.3, 9);
    expect(w?.boost(0.5)).toBeCloseTo(0.2, 9);
    expect(w?.weight(0.5)).toBe(1);
  });
});

describe('Frond lighting', () => {
  const ribs = (): Ribs => must(buildRibs(spine(6), settings({ fold: () => 0.5, curl: () => 0, gravity: () => 0 })));
  const light = { anchor: null, surface: null, adjust: [0, 0, 0] as V3 };
  const build = (opts: Parameters<typeof buildFrondMesh>[1], over: Partial<FrondSpec> = {}) => buildFrondMesh([specFor(ribs(), { mesh: null, columns: 4, light, ...over })], opts);
  const dot = (m: { normals: Float32Array }, i: number, d: V3): number => (m.normals[i * 3] as number) * d[0] + (m.normals[i * 3 + 1] as number) * d[1] + (m.normals[i * 3 + 2] as number) * d[2];

  it('neutral settings leave the normals untouched', () => {
    const a = build({});
    const b = build({ lighting: { ...NEUTRAL_LEAF_LIGHTING }, lightingExtras: { alignment: 0, spread: 0 } });
    expect(Array.from(b.normals)).toEqual(Array.from(a.normals));
  });

  it('Alignment 1 turns every normal toward the growth direction of the spine', () => {
    const m = build({ lighting: { ...NEUTRAL_LEAF_LIGHTING }, lightingExtras: { alignment: 1, spread: 0 } });
    for (let i = 0; i < m.positions.length / 3; i++) expect(dot(m, i, [0, 1, 0])).toBeGreaterThan(0.999);
  });

  it('Spread 1 turns the normals away from the spine (outward across the frond)', () => {
    const m = build({ lighting: { ...NEUTRAL_LEAF_LIGHTING }, lightingExtras: { alignment: 0, spread: 1 } });
    for (let i = 0; i < m.positions.length / 3; i++) {
      const x = m.positions[i * 3] as number;
      const nx = m.normals[i * 3] as number;
      if (Math.abs(x) > 1e-4) expect(Math.sign(nx)).toBe(Math.sign(x));
      expect(m.normals[i * 3 + 1]).toBeCloseTo(0, 5);
    }
  });

  it('Parent puffiness with the Origin anchor radiates from the model origin; geometry never moves', () => {
    const plain = build({});
    const m = build(
      { lighting: { ...NEUTRAL_LEAF_LIGHTING, parentAnchor: 'origin', parentAmount: 1 }, lightingExtras: { alignment: 0, spread: 0 } },
      { light: { anchor: [0, 0, 0], surface: null, adjust: [0, 0, 0] } },
    );
    expect(Array.from(m.positions)).toEqual(Array.from(plain.positions));
    for (let i = 0; i < m.positions.length / 3; i++) {
      const p: V3 = [m.positions[i * 3] as number, m.positions[i * 3 + 1] as number, m.positions[i * 3 + 2] as number];
      const l = Math.hypot(...p);
      if (l > 1e-6) expect(dot(m, i, [p[0] / l, p[1] / l, p[2] / l])).toBeGreaterThan(0.999);
    }
  });

  it('Adjustments rotate the normals about the frond axes', () => {
    const plain = build({});
    const m = build(
      { lighting: { ...NEUTRAL_LEAF_LIGHTING, up: 90 }, lightingExtras: { alignment: 0, spread: 0 } },
      { light: { anchor: null, surface: null, adjust: [Math.PI / 2, 0, 0] } },
    );
    expect(Array.from(m.positions)).toEqual(Array.from(plain.positions));
    let changed = 0;
    for (let i = 0; i < m.normals.length; i++) if (Math.abs((m.normals[i] as number) - (plain.normals[i] as number)) > 0.1) changed++;
    expect(changed).toBeGreaterThan(0);
  });

  it('Style Global reads the Tree lighting without Alignment / Spread; Local reads the frond group', () => {
    const global = { ...NEUTRAL_LEAF_LIGHTING, smooth: 0.4 };
    const g = resolveFrondLighting(params(), global);
    expect(g.settings.smooth).toBe(0.4);
    expect(g.extras).toEqual({ alignment: 0, spread: 0 });
    const l = resolveFrondLighting(
      params({ lightingStyle: 'local', frondLightSmooth: 0.7, frondLightAlignment: 0.5, frondLightSpread: 0.25, frondLightParentAnchor: 'origin', frondLightParentAmount: 0.6, frondLightUp: 20 }),
      global,
    );
    expect(l.settings).toMatchObject({ smooth: 0.7, parentAnchor: 'origin', parentAmount: 0.6, up: 20 });
    expect(l.extras).toEqual({ alignment: 0.5, spread: 0.25 });
    expect(resolveFrondLighting(params(), undefined).settings).toEqual(NEUTRAL_LEAF_LIGHTING);
  });

  it('the node builds a lit mesh in Local style and the default is neutral', async () => {
    const def = getNodeDef('generator.frond');
    if (!def) throw new Error('Frond missing');
    const run = async (over: Record<string, unknown>): Promise<Float32Array> => {
      const out = (await def.evaluate(ctx(), { parent: [{ kind: 'Structure', value: { skeleton: stem() } }] }, params(over))) as NodeOutputs;
      const g = out[OUTPUT_KEY.geometry];
      if (!g || g.kind !== 'Mesh') throw new Error('no mesh');
      return g.value.normals;
    };
    const base = await run({});
    expect(Array.from(await run({ frondLightAlignment: 1 }))).toEqual(Array.from(base));
    const lit = await run({ lightingStyle: 'local', frondLightAlignment: 1 });
    expect(Array.from(lit)).not.toEqual(Array.from(base));
    // the stems grow along +Z, so aligned normals point there
    expect(lit[2] as number).toBeGreaterThan(0.99);
  });

  it('exposes the documented parameters, tabs and groups', () => {
    const def = getNodeDef('generator.frond');
    if (!def) throw new Error('Frond missing');
    const by = (id: string) => def.params.find((d) => d.id === id);
    expect(by('frondLRAmount')).toMatchObject({ group: 'Shape', subgroup: 'Left-Right Variance', label: 'Amount' });
    expect(by('frondLRSeed')).toMatchObject({ group: 'Shape', subgroup: 'Left-Right Variance', label: 'Seed' });
    expect(by('frondSecOutliers')).toMatchObject({ group: 'Shape', subgroup: 'Section Variance', label: 'Favor Outliers' });
    for (const name of ['Gravity', 'Fold', 'Curl', 'Roll']) {
      expect(by(`frondSec${name}Amount`)).toMatchObject({ group: 'Shape', subgroup: `Section ${name}`, label: 'Amount' });
      expect(by(`frondSec${name}Offset`)).toMatchObject({ group: 'Shape', subgroup: `Section ${name}`, label: 'Offset' });
    }
    expect(by('lightingStyle')).toMatchObject({ group: 'Lighting', label: 'Style' });
    for (const [id, label, sub] of [['frondLightSmooth', 'Smooth', 'Normals'], ['frondLightAlignment', 'Alignment', 'Normals'], ['frondLightSpread', 'Spread', 'Normals'], ['frondLightParentAnchor', 'Anchor', 'Parent puffiness'], ['frondLightParentAmount', 'Amount', 'Parent puffiness'], ['frondLightUp', 'Up', 'Adjustments'], ['frondLightRight', 'Right', 'Adjustments'], ['frondLightOut', 'Out', 'Adjustments']] as const) {
      expect(by(id)).toMatchObject({ group: 'Lighting', label, subgroup: sub });
    }
    expect(by('frondLightParentAnchor')).toMatchObject({ kind: 'enum' });
    expect(JSON.stringify(by('frondLightParentAnchor'))).toContain('Origin');
    expect(by('frondWindWeight')).toMatchObject({ group: 'Animation', subgroup: 'Wind', label: 'Weight', curveAllowed: true });
    expect(by('frondWindCross')).toMatchObject({ group: 'Animation', subgroup: 'Wind', label: 'Cross' });
    expect(by('frondWindBoost')).toMatchObject({ group: 'Animation', subgroup: 'Wind', label: 'Boost', curveAllowed: true });
    expect(by('frondRibsBranchWind')).toMatchObject({ group: 'Animation', subgroup: 'Ribs', label: 'Apply branch wind' });
    expect(by('frondRibsWeight')).toMatchObject({ group: 'Animation', subgroup: 'Ribs', label: 'Weight' });
  });
});

function stem(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.03);
  sb.endBranch();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(1, 0, i * 0.5, 0.03);
  sb.endBranch();
  return sb.build();
}

function params(over: Record<string, unknown> = {}): NodeParams {
  const def = getNodeDef('generator.frond');
  if (!def) throw new Error('Frond missing');
  const p: NodeParams = {};
  for (const d of def.params) p[d.id] = defaultParamState(d);
  for (const [k, v] of Object.entries(over)) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
  return p;
}

function ctx(seed = 1, lod = 0): NodeContext {
  return { nodeId: 'f', name: 'f', rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod, logger: createLogger('dev', 'error') };
}
