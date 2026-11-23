import { describe, expect, it } from 'vitest';
import { createSimplex } from '@/core/noise';
import { tubeU } from '@/generators/uv';
import {
  buildKnotMesh,
  knotSegments,
  knotSurvivesLod,
  lodKeep,
  parentUvAt,
  SECTION_CORE,
  SECTION_INNER,
  SECTION_OUTER,
  type KnotFrame,
  type KnotMeshInput,
  type KnotShape,
  type KnotUv,
  type ParentUv,
} from '@/generators/knot';

const UV: KnotUv = { style: 'match-trunk', scale: 1, offsetU: 0, offsetV: 0, rect: null };
const NO_NOISE = { amount: 0, scale: 3 };

const FRAME: KnotFrame = {
  axisPoint: [0, 0, 0],
  tangent: [0, 0, 1],
  normal: [1, 0, 0],
  binormal: [0, 1, 0],
  radius: 0.1,
  slope: -0.01,
  azimuth: 0.7,
};
const PARENT_UV: ParentUv = { tiles: 3, uOffset: 0.2, twist: 0.1, v0: 1.5, vSlope: 2 };

const shape = (over: Partial<KnotShape> = {}): KnotShape => ({
  size: 0.06,
  offset: 0.02,
  rotation: 0,
  width: 1,
  lip: 0.01,
  outerShape: NO_NOISE,
  outerOffset: NO_NOISE,
  inner: { sizeFrac: 0.6, scale: 1, curvature: 0.5, overlap: 0, uv: UV, shape: NO_NOISE },
  core: { sizeFrac: 0.5, offset: -0.01, uv: UV, shape: NO_NOISE, offsetNoise: NO_NOISE },
  ...over,
});

const input = (over: Partial<KnotMeshInput> = {}): KnotMeshInput => ({
  frame: FRAME,
  shape: shape(),
  segments: { outer: 3, inner: 2, core: 2, slices: 12 },
  parentUv: PARENT_UV,
  noise: createSimplex(7),
  noiseOffset: [1.5, -2.5],
  ...over,
});

/** Vertices of one section. */
const ofSection = (m: ReturnType<typeof buildKnotMesh>, sec: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < m.vertexCount; i++) if (m.section[i] === sec) out.push(i);
  return out;
};

describe('knot sections and ring counts', () => {
  it('has (rings + 1) x (slices + 1) vertices in Outer and Inner and rings x (slices + 1) + 1 in Core', () => {
    const m = buildKnotMesh(input());
    expect(ofSection(m, SECTION_OUTER)).toHaveLength((3 + 1) * 13);
    expect(ofSection(m, SECTION_INNER)).toHaveLength((2 + 1) * 13);
    expect(ofSection(m, SECTION_CORE)).toHaveLength(2 * 13 + 1);
    expect(m.vertexCount).toBe(4 * 13 + 3 * 13 + 2 * 13 + 1);
  });

  it('creates two triangles per quad and a fan in the Core', () => {
    const m = buildKnotMesh(input());
    expect(m.ranges[SECTION_OUTER]![1]).toBe(3 * 12 * 6);
    expect(m.ranges[SECTION_INNER]![1]).toBe(2 * 12 * 6);
    expect(m.ranges[SECTION_CORE]![1]).toBe((1 * 12 * 6) + 12 * 3);
    expect(m.indices.length).toBe(m.ranges[2]![0] + m.ranges[2]![1]);
    for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
  });

  it('keeps every index inside its own section', () => {
    const m = buildKnotMesh(input());
    for (let sec = 0; sec < 3; sec++) {
      const [start, count] = m.ranges[sec]!;
      for (let k = start; k < start + count; k++) expect(m.section[m.indices[k]!]).toBe(sec);
    }
  });
});

describe('knot welding to the parent surface', () => {
  it('puts the outer boundary on the parent cone (distance to the axis = radius + taper)', () => {
    const m = buildKnotMesh(input());
    for (let j = 0; j < 12; j++) {
      const x = m.rim[j * 3]!;
      const y = m.rim[j * 3 + 1]!;
      const z = m.rim[j * 3 + 2]!;
      expect(Math.hypot(x, y)).toBeCloseTo(FRAME.radius + FRAME.slope * z, 5);
    }
  });

  it('stays on the surface with noise, scale and rotation applied', () => {
    const m = buildKnotMesh(
      input({
        shape: shape({ rotation: 1.1, width: 2, outerShape: { amount: 0.4, scale: 4 }, outerOffset: { amount: 0.01, scale: 3 } }),
      }),
    );
    for (let j = 0; j < 12; j++) {
      const z = m.rim[j * 3 + 2]!;
      expect(Math.hypot(m.rim[j * 3]!, m.rim[j * 3 + 1]!)).toBeCloseTo(FRAME.radius + FRAME.slope * z, 5);
    }
  });

  it('copies the exact parent normal onto the outer boundary', () => {
    const m = buildKnotMesh(input());
    const outer = ofSection(m, SECTION_OUTER).slice(0, 12);
    for (const v of outer) {
      const px = m.positions[v * 3]!;
      const py = m.positions[v * 3 + 1]!;
      const len = Math.hypot(px, py) || 1;
      // cone normal: radial direction minus the taper along the axis
      const nx = m.normals[v * 3]!;
      const ny = m.normals[v * 3 + 1]!;
      expect((nx * px + ny * py) / len).toBeGreaterThan(0.99);
    }
  });

  it('shares the boundary rings between sections without cracks', () => {
    const m = buildKnotMesh(input());
    const outer = ofSection(m, SECTION_OUTER);
    const inner = ofSection(m, SECTION_INNER);
    const lastOuterRing = outer.slice(3 * 13, 4 * 13);
    const firstInnerRing = inner.slice(0, 13);
    for (let c = 0; c < 13; c++) {
      for (let k = 0; k < 3; k++) expect(m.positions[firstInnerRing[c]! * 3 + k]).toBeCloseTo(m.positions[lastOuterRing[c]! * 3 + k]!, 6);
    }
    const lastInnerRing = inner.slice(2 * 13, 3 * 13);
    const firstCoreRing = ofSection(m, SECTION_CORE).slice(0, 13);
    for (let c = 0; c < 13; c++) {
      for (let k = 0; k < 3; k++) expect(m.positions[firstCoreRing[c]! * 3 + k]).toBeCloseTo(m.positions[lastInnerRing[c]! * 3 + k]!, 6);
    }
  });

  it('lifts the rim by Offset + Lip and the Core by Offset + Core offset', () => {
    const m = buildKnotMesh(input());
    const radial = (v: number): number => Math.hypot(m.positions[v * 3]!, m.positions[v * 3 + 1]!) - (FRAME.radius + FRAME.slope * m.positions[v * 3 + 2]!);
    const outer = ofSection(m, SECTION_OUTER);
    const rim = outer.slice(3 * 13, 4 * 13 - 1);
    for (const v of rim) expect(radial(v)).toBeGreaterThan(0.025);
    const core = ofSection(m, SECTION_CORE);
    const centre = core[core.length - 1]!;
    expect(radial(centre)).toBeGreaterThan(0.005);
    expect(radial(centre)).toBeLessThan(0.02);
  });

  it('cuts into the parent for a negative Offset', () => {
    const m = buildKnotMesh(input({ shape: shape({ offset: -0.02, lip: 0, core: { sizeFrac: 0.5, offset: -0.01, uv: UV, shape: NO_NOISE, offsetNoise: NO_NOISE } }) }));
    const core = ofSection(m, SECTION_CORE);
    const centre = core[core.length - 1]!;
    const r = Math.hypot(m.positions[centre * 3]!, m.positions[centre * 3 + 1]!) - (FRAME.radius + FRAME.slope * m.positions[centre * 3 + 2]!);
    expect(r).toBeLessThan(0);
  });

  it('faces every triangle away from the parent', () => {
    const m = buildKnotMesh(input());
    let outward = 0;
    let total = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]!, m.indices[t + 1]!, m.indices[t + 2]!];
      const e1 = [0, 1, 2].map((k) => m.positions[b * 3 + k]! - m.positions[a * 3 + k]!);
      const e2 = [0, 1, 2].map((k) => m.positions[c * 3 + k]! - m.positions[a * 3 + k]!);
      const gx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      const gy = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      const gz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      const l = Math.hypot(gx, gy, gz);
      if (l < 1e-14) continue;
      const nx = m.normals[a * 3]! + m.normals[b * 3]! + m.normals[c * 3]!;
      const ny = m.normals[a * 3 + 1]! + m.normals[b * 3 + 1]! + m.normals[c * 3 + 1]!;
      const nz = m.normals[a * 3 + 2]! + m.normals[b * 3 + 2]! + m.normals[c * 3 + 2]!;
      total++;
      if (gx * nx + gy * ny + gz * nz > 0) outward++;
    }
    expect(total).toBeGreaterThan(50);
    expect(outward / total).toBeGreaterThan(0.97);
  });
});

describe('knot sizes', () => {
  it('derives Inner and Core radii from Size % (Inner of the knot, Core of the Inner)', () => {
    const m = buildKnotMesh(input());
    for (let j = 0; j < 12; j++) {
      expect(m.boundary.outer[j]).toBeCloseTo(0.06, 9);
      expect(m.boundary.inner[j]).toBeCloseTo(0.06 * 0.6, 9);
      expect(m.boundary.core[j]).toBeCloseTo(0.06 * 0.6 * 0.5, 9);
    }
  });

  it('keeps Inner and Core inside Outer when shape noise is strong', () => {
    const m = buildKnotMesh(input({ shape: shape({ outerShape: { amount: 1, scale: 5 }, inner: { sizeFrac: 0.9, scale: 1, curvature: 0.5, overlap: 0, uv: UV, shape: { amount: 1, scale: 5 } } }) }));
    for (let j = 0; j < 12; j++) {
      expect(m.boundary.inner[j]!).toBeLessThan(m.boundary.outer[j]!);
      expect(m.boundary.core[j]!).toBeLessThan(m.boundary.inner[j]!);
    }
  });

  it('stretches the footprint across the parent with Scale', () => {
    const wide = buildKnotMesh(input({ shape: shape({ width: 2 }) }));
    const round = buildKnotMesh(input());
    const spanX = (m: ReturnType<typeof buildKnotMesh>): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = 0; j < 12; j++) {
        const a = Math.atan2(m.rim[j * 3 + 1]!, m.rim[j * 3]!);
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      return hi - lo;
    };
    expect(spanX(wide)).toBeGreaterThan(spanX(round) * 1.5);
  });

  it('lets Inner reach under the Core with Overlap', () => {
    const none = buildKnotMesh(input());
    const over = buildKnotMesh(input({ shape: shape({ inner: { sizeFrac: 0.6, scale: 1, curvature: 0.5, overlap: 0.5, uv: UV, shape: NO_NOISE } }) }));
    const planeDistance = (m: ReturnType<typeof buildKnotMesh>, v: number): number => Math.hypot(m.plane[v * 2]! - 0.5, m.plane[v * 2 + 1]! - 0.5);
    const lastInner = (m: ReturnType<typeof buildKnotMesh>): number => ofSection(m, SECTION_INNER)[2 * 13 + 3]!;
    const firstCore = (m: ReturnType<typeof buildKnotMesh>): number => ofSection(m, SECTION_CORE)[3]!;
    // Without overlap the rings coincide; with overlap the Inner ends inside the Core edge.
    expect(planeDistance(none, lastInner(none))).toBeCloseTo(planeDistance(none, firstCore(none)), 6);
    expect(planeDistance(over, lastInner(over))).toBeLessThan(planeDistance(over, firstCore(over)) * 0.7);
    expect(over.ranges[SECTION_CORE]![1]).toBe(none.ranges[SECTION_CORE]![1]);
  });
});

describe('knot UV', () => {
  it('Outer UV equals the parent UV at every surface point (Match trunk)', () => {
    const m = buildKnotMesh(input({ shape: shape({ rotation: 0.4, outerShape: { amount: 0.3, scale: 3 } }) }));
    for (const v of ofSection(m, SECTION_OUTER)) {
      const x = m.positions[v * 3]!;
      const y = m.positions[v * 3 + 1]!;
      const z = m.positions[v * 3 + 2]!;
      let a = Math.atan2(y, x);
      a += Math.round((FRAME.azimuth - a) / (2 * Math.PI)) * 2 * Math.PI;
      const [u, vv] = parentUvAt(PARENT_UV, a, z);
      // positions are lifted along the normal; compare on the rim ring where height is 0 and loosely elsewhere
      expect(m.uvs[v * 2 + 1]).toBeCloseTo(vv, 1);
      expect(Math.abs(m.uvs[v * 2]! - u)).toBeLessThan(0.15);
    }
  });

  it('is exact on the rim', () => {
    const m = buildKnotMesh(input());
    const outer = ofSection(m, SECTION_OUTER);
    for (let j = 0; j < 12; j++) {
      const v = outer[j]!;
      let a = Math.atan2(m.positions[v * 3 + 1]!, m.positions[v * 3]!);
      a += Math.round((FRAME.azimuth - a) / (2 * Math.PI)) * 2 * Math.PI;
      const [u, vv] = parentUvAt(PARENT_UV, a, m.positions[v * 3 + 2]!);
      expect(m.uvs[v * 2]).toBeCloseTo(u, 4);
      expect(m.uvs[v * 2 + 1]).toBeCloseTo(vv, 4);
    }
  });

  it('Inner and Core match the trunk with Scale 1 and no offset', () => {
    const m = buildKnotMesh(input());
    const outerRim = ofSection(m, SECTION_OUTER).slice(3 * 13, 4 * 13);
    const innerFirst = ofSection(m, SECTION_INNER).slice(0, 13);
    for (let c = 0; c < 13; c++) {
      expect(m.uvs[innerFirst[c]! * 2]).toBeCloseTo(m.uvs[outerRim[c]! * 2]!, 5);
      expect(m.uvs[innerFirst[c]! * 2 + 1]).toBeCloseTo(m.uvs[outerRim[c]! * 2 + 1]!, 5);
    }
  });

  it('applies Scale and offsets to Inner (Match trunk) without touching Outer', () => {
    const base = buildKnotMesh(input());
    const moved = buildKnotMesh(input({ shape: shape({ inner: { sizeFrac: 0.6, scale: 1, curvature: 0.5, overlap: 0, uv: { ...UV, scale: 2, offsetU: 0.25, offsetV: 0.5 }, shape: NO_NOISE } }) }));
    const o = ofSection(base, SECTION_OUTER);
    for (const v of o) expect(moved.uvs[v * 2]).toBe(base.uvs[v * 2]);
    const i0 = ofSection(base, SECTION_INNER)[13]!;
    expect(moved.uvs[i0 * 2 + 1]).not.toBeCloseTo(base.uvs[i0 * 2 + 1]!, 3);
  });

  it('Ring style maps the Inner like a torus: U around (0..1), V across the band', () => {
    const ring: KnotUv = { style: 'ring', scale: 1, offsetU: 0, offsetV: 0, rect: null };
    const m = buildKnotMesh(input({ shape: shape({ inner: { sizeFrac: 0.6, scale: 1, curvature: 0.5, overlap: 0, uv: ring, shape: NO_NOISE } }) }));
    const inner = ofSection(m, SECTION_INNER);
    expect(m.uvs[inner[0]! * 2]).toBeCloseTo(0, 6);
    expect(m.uvs[inner[12]! * 2]).toBeCloseTo(1, 6);
    expect(m.uvs[inner[0]! * 2 + 1]).toBeCloseTo(0, 6);
    expect(m.uvs[inner[2 * 13]! * 2 + 1]).toBeCloseTo(1, 6);
  });

  it('Core Ring style is a planar disc around (0.5, 0.5) and ignores the offsets', () => {
    const ring: KnotUv = { style: 'ring', scale: 1, offsetU: 0.3, offsetV: 0.3, rect: null };
    const m = buildKnotMesh(input({ shape: shape({ core: { sizeFrac: 0.5, offset: -0.01, uv: ring, shape: NO_NOISE, offsetNoise: NO_NOISE } }) }));
    const core = ofSection(m, SECTION_CORE);
    const centre = core[core.length - 1]!;
    expect(m.uvs[centre * 2]).toBeCloseTo(0.5, 6);
    expect(m.uvs[centre * 2 + 1]).toBeCloseTo(0.5, 6);
    expect(m.uvs[core[0]! * 2]).toBeCloseTo(1, 6);
    expect(m.uvs[core[0]! * 2 + 1]).toBeCloseTo(0.5, 6);
  });

  it('keeps UV Area coordinates inside the rectangle', () => {
    const rect = [0.25, 0.5, 0.5, 0.75] as const;
    const m = buildKnotMesh(input({ shape: shape({ inner: { sizeFrac: 0.6, scale: 1, curvature: 0.5, overlap: 0, uv: { ...UV, rect }, shape: NO_NOISE } }) }));
    for (const v of ofSection(m, SECTION_INNER)) {
      expect(m.uvs[v * 2]).toBeGreaterThanOrEqual(0.25 - 1e-6);
      expect(m.uvs[v * 2]).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(m.uvs[v * 2 + 1]).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(m.uvs[v * 2 + 1]).toBeLessThanOrEqual(0.75 + 1e-6);
    }
  });
});

describe('knot determinism', () => {
  it('gives identical meshes for identical input and different ones for another noise offset', () => {
    const a = buildKnotMesh(input({ shape: shape({ outerShape: { amount: 0.3, scale: 3 }, outerOffset: { amount: 0.01, scale: 3 } }) }));
    const b = buildKnotMesh(input({ shape: shape({ outerShape: { amount: 0.3, scale: 3 }, outerOffset: { amount: 0.01, scale: 3 } }) }));
    const c = buildKnotMesh(input({ shape: shape({ outerShape: { amount: 0.3, scale: 3 }, outerOffset: { amount: 0.01, scale: 3 } }), noiseOffset: [9, 9] }));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.uvs)).toEqual(Array.from(b.uvs));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
  });

  it('is finite everywhere, also for a knot wider than the branch', () => {
    const m = buildKnotMesh(input({ shape: shape({ size: 0.5, width: 3 }) }));
    for (const x of m.positions) expect(Number.isFinite(x)).toBe(true);
    for (const x of m.normals) expect(Number.isFinite(x)).toBe(true);
    for (const x of m.uvs) expect(Number.isFinite(x)).toBe(true);
  });
});

describe('knot segments and dynamic LOD', () => {
  const base = { ringsOuter: 4, ringsInner: 3, ringsCore: 2, slices: 24, resolution: 1, lodRings: 0.5, lodSlices: 0.5 };

  it('uses the base counts at LOD 0', () => {
    expect(knotSegments(base, 0)).toEqual({ outer: 4, inner: 3, core: 2, slices: 24 });
  });

  it('scales rings and slices with Resolution', () => {
    const s = knotSegments({ ...base, resolution: 2 }, 0);
    expect(s).toEqual({ outer: 8, inner: 6, core: 4, slices: 48 });
    expect(knotSegments({ ...base, resolution: 0.5 }, 0).slices).toBe(12);
  });

  it('reduces rings and slices per LOD independently', () => {
    const lod2 = knotSegments(base, 2);
    expect(lod2.slices).toBeLessThan(24);
    expect(lod2.outer).toBeLessThan(4);
    const ringsOnly = knotSegments({ ...base, lodRings: 0.9, lodSlices: 0 }, 3);
    expect(ringsOnly.slices).toBe(24);
    expect(ringsOnly.outer).toBeLessThan(4);
    expect(lodKeep(0, 0.5)).toBe(1);
    expect(lodKeep(3, 0.5)).toBeCloseTo(0.8 ** 3, 9);
  });

  it('never drops below one ring and four slices', () => {
    const s = knotSegments({ ...base, ringsOuter: 1, ringsInner: 1, ringsCore: 1, slices: 4, lodRings: 0.9, lodSlices: 0.9 }, 3);
    expect(s.outer).toBe(1);
    expect(s.slices).toBe(4);
  });

  it('culls knots by Weight at lower detail only', () => {
    expect(knotSurvivesLod(1, 3, 0)).toBe(true);
    expect(knotSurvivesLod(0, 0, 0)).toBe(true);
    expect(knotSurvivesLod(0, 3, 0.5)).toBe(false);
    expect(knotSurvivesLod(0.5, 3, 0.6)).toBe(true);
    expect(knotSurvivesLod(0.5, 3, 0.4)).toBe(false);
  });
});

describe('shared tube U mapping', () => {
  it('is the one formula behind the knot parent UV: tiles around, offset and twist along V', () => {
    expect(tubeU(0.25, 4, 0.5, 0, 3)).toBeCloseTo(1.5, 12);
    expect(tubeU(0.25, 4, 0.5, 0.1, 3)).toBeCloseTo(1.5 + 0.1 * 4 * 3, 12);
    const p: ParentUv = { tiles: 3, uOffset: 0.2, twist: 0.05, v0: 1, vSlope: 2 };
    const [u, v] = parentUvAt(p, Math.PI, 0.5);
    expect(v).toBeCloseTo(2, 12);
    expect(u).toBeCloseTo(tubeU(0.5, 3, 0.2, 0.05, 2), 12);
  });
});
