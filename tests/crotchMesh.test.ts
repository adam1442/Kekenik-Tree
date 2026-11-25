import { describe, expect, it } from 'vitest';
import { Rng } from '@/core/rng';
import {
  DEFAULT_SPLIT_SETTINGS,
  buildCrotchMesh,
  creaseFillWeight,
  crotchPinchTurning,
  crotchVertexIndex,
  evenSides,
  planSplit,
  type CrotchInput,
  type CrotchMesh,
  type SplitPlan,
  type SplitSettings,
} from '@/generators/split';

const R = 0.5;
const DEG = Math.PI / 180;

function plan(settings: Partial<SplitSettings> = {}): SplitPlan {
  const p = planSplit({
    end: { position: [0, 0, 2], tangent: [0, 0, 1], up: [1, 0, 0], radius: R },
    parentLength: 2,
    settings: { ...DEFAULT_SPLIT_SETTINGS, ...settings },
    ringSpacing: 0.1,
    rng: new Rng(11).fork('splits0'),
    chance: 1,
    parentTiles: 4,
    axisStart: { position: [0, 0, 2 - R * 3.5], tangent: [0, 0, 1] },
    treeAxis: [3, 0, 0],
  });
  if (!p) throw new Error('plan expected');
  return p;
}

function inputFor(p: SplitPlan, over: Partial<CrotchInput> = {}): CrotchInput {
  const [l1, l2] = p.lobes;
  return {
    sides: 16,
    rings: l1.ringCount,
    centre1: l1.positions,
    centre2: l2.positions,
    radius0: R,
    radius1: l1.radius,
    radius2: l2.radius,
    startTangent: [0, 0, 1],
    endTangent1: l1.endTangent,
    endTangent2: l2.endTangent,
    divergence: p.divergence,
    ...over,
  };
}

function edgeUse(mesh: CrotchMesh): Map<string, number> {
  const use = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.indices[t + e] as number;
      const b = mesh.indices[t + ((e + 1) % 3)] as number;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
}

function area(mesh: CrotchMesh, t: number): number {
  const P = mesh.positions;
  const [a, b, c] = [mesh.indices[t]! * 3, mesh.indices[t + 1]! * 3, mesh.indices[t + 2]! * 3];
  const e1 = [P[b]! - P[a]!, P[b + 1]! - P[a + 1]!, P[b + 2]! - P[a + 2]!];
  const e2 = [P[c]! - P[a]!, P[c + 1]! - P[a + 1]!, P[c + 2]! - P[a + 2]!];
  return 0.5 * Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!);
}

describe('evenSides', () => {
  it('rounds every radial count up to an even number >= 4', () => {
    expect([0, 3, 4, 5, 6, 7, 9, 12, 13, 5.2].map(evenSides)).toEqual([4, 4, 4, 6, 6, 8, 10, 12, 14, 6]);
    expect(evenSides(Number.NaN)).toBe(4);
    for (let n = 3; n < 80; n++) {
      const e = evenSides(n);
      expect(e % 2).toBe(0);
      expect(e).toBeGreaterThanOrEqual(n);
      expect(e).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('crotch topology', () => {
  for (const sides of [4, 5, 6, 8, 16, 24]) {
    it(`is watertight with the right Euler characteristic (sides ${sides})`, () => {
      const mesh = buildCrotchMesh(inputFor(plan(), { sides, innerSmooth: 0.5, outerSmooth: 0.5 }));
      const N = mesh.sides;
      expect(N).toBe(evenSides(sides));
      const use = edgeUse(mesh);
      const boundary: string[] = [];
      for (const [key, n] of use) {
        expect(n === 1 || n === 2).toBe(true);
        if (n === 1) boundary.push(key);
      }
      // Boundary edges: the start ring (N) and the two end rings (N / 2 each). With N = 4 the end rings are two-vertex digons
      // (their edge is used by two faces), so only the start ring remains: lowest LOD fallback, still edge-manifold.
      expect(boundary.length).toBe(N === 4 ? N : 2 * N);
      const rows = mesh.rings - 1;
      expect(mesh.indices.length / 3).toBe(2 * rows * N);
      // Pair of pants: chi = V - E + F = -1 (the two digon ends of the N = 4 fallback each lose one edge: chi = +1).
      expect(mesh.vertexCount - use.size + mesh.indices.length / 3).toBe(N === 4 ? 1 : -1);
      // Boundary edges of the start ring only touch ring 0, those of the end rings only the last ring.
      const ringOf = (key: string): number[] => key.split('_').map((v) => mesh.vertexRing[Number(v)] as number);
      const start = boundary.filter((k) => ringOf(k).every((r) => r === 0)).length;
      const end = boundary.filter((k) => ringOf(k).every((r) => r === mesh.rings - 1)).length;
      expect(start).toBe(N);
      expect(end).toBe(N === 4 ? 0 : N);
    });
  }

  it('has no repeated index and no zero-area triangle', () => {
    for (const sides of [4, 6, 16]) {
      const mesh = buildCrotchMesh(inputFor(plan(), { sides, innerSmooth: 1, outerSmooth: 1 }));
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        expect(a !== b && b !== c && a !== c).toBe(true);
        expect(area(mesh, t)).toBeGreaterThan(1e-12);
      }
    }
  });

  it('has N vertices at s = 0 and two rings of N / 2 sharing one vertex at s = 1', () => {
    const mesh = buildCrotchMesh(inputFor(plan(), { sides: 16 }));
    const N = 16;
    const last = mesh.rings - 1;
    let first = 0;
    let end = 0;
    for (let v = 0; v < mesh.vertexCount; v++) {
      if (mesh.vertexRing[v] === 0) first++;
      if (mesh.vertexRing[v] === last) end++;
    }
    expect(first).toBe(N);
    expect(end).toBe(N - 1);
    expect(crotchVertexIndex(N, mesh.rings, last, 0)).toBe(crotchVertexIndex(N, mesh.rings, last, N / 2));
    // Lobe 1 ring = columns 0 .. N/2 - 1, lobe 2 ring = columns N/2 + 1 .. N - 1 plus the crotch vertex: N / 2 distinct vertices each.
    const ring1 = new Set<number>();
    const ring2 = new Set<number>();
    for (let j = 0; j <= N / 2; j++) ring1.add(crotchVertexIndex(N, mesh.rings, last, j));
    for (let j = N / 2; j <= N; j++) ring2.add(crotchVertexIndex(N, mesh.rings, last, j));
    expect(ring1.size).toBe(N / 2);
    expect(ring2.size).toBe(N / 2);
  });

  it('keeps every vertex on its U: pinch vertices sit on the tile boundaries', () => {
    const N = 16;
    const mesh = buildCrotchMesh(inputFor(plan(), { sides: N, phase: 0 }));
    const codeAt = new Map<number, Set<number>>();
    for (let i = 0; i < mesh.indices.length; i++) {
      const v = mesh.indices[i] as number;
      const set = codeAt.get(v) ?? new Set<number>();
      set.add(mesh.cornerU[i] as number);
      codeAt.set(v, set);
    }
    for (let v = 0; v < mesh.vertexCount; v++) {
      const col = mesh.vertexColumn[v] as number;
      const codes = [...(codeAt.get(v) ?? [])];
      const merged = mesh.vertexRing[v] === mesh.rings - 1 && col === 0;
      for (const c of codes) {
        if (merged) expect([0, N / 2, N]).toContain(c);
        else expect(c % N).toBe(col);
      }
    }
    // A and B are on U = 0 and U = N / 2 (tiles / 2 for an even tile count).
    expect(codeAt.get(crotchVertexIndex(N, mesh.rings, 1, N / 2))).toEqual(new Set([N / 2]));
  });
});

describe('crotch shape', () => {
  it('ring 0 equals the circle of the non-splitting trunk (within 1e-6)', () => {
    const p = plan();
    const N = 16;
    const mesh = buildCrotchMesh(inputFor(p, { sides: N, innerSmooth: 1, outerSmooth: 1 }));
    const c = [p.lobes[0].positions[0]!, p.lobes[0].positions[1]!, p.lobes[0].positions[2]!];
    const d = p.divergence;
    const T: [number, number, number] = [0, 0, 1];
    const n = [d[1] * T[2] - d[2] * T[1], d[2] * T[0] - d[0] * T[2], d[0] * T[1] - d[1] * T[0]]; // d x T = vertex 0 direction
    const b = [T[1] * n[2]! - T[2] * n[1]!, T[2] * n[0]! - T[0] * n[2]!, T[0] * n[1]! - T[1] * n[0]!];
    for (let j = 0; j < N; j++) {
      const a = (2 * Math.PI * j) / N;
      const v = crotchVertexIndex(N, mesh.rings, 0, j) * 3;
      for (let k = 0; k < 3; k++) {
        const expected = c[k]! + R * (Math.cos(a) * n[k]! + Math.sin(a) * b[k]!);
        expect(Math.abs(mesh.positions[v + k]! - expected)).toBeLessThan(1e-6);
      }
    }
  });

  it('the child rings are circles of the plan radii around the lobe centres (tangent at the crotch)', () => {
    const p = plan({ balance: 0.7 });
    const N = 16;
    const mesh = buildCrotchMesh(inputFor(p, { sides: N }));
    const last = mesh.rings - 1;
    const [l1, l2] = p.lobes;
    const dist = (lobe: typeof l1, j: number): number => {
      const v = crotchVertexIndex(N, mesh.rings, last, j) * 3;
      return Math.hypot(
        mesh.positions[v]! - lobe.positions[last * 3]!,
        mesh.positions[v + 1]! - lobe.positions[last * 3 + 1]!,
        mesh.positions[v + 2]! - lobe.positions[last * 3 + 2]!,
      );
    };
    // Interior vertices lie on the child circle (the crotch vertex is shared, it may move by a few percent of the radius).
    for (let j = 2; j < N / 2 - 1; j++) expect(Math.abs(dist(l1, j) - l1.radius)).toBeLessThan(0.1 * l1.radius);
    for (let j = N / 2 + 2; j < N - 1; j++) expect(Math.abs(dist(l2, j) - l2.radius)).toBeLessThan(0.1 * l2.radius);
    expect(l1.radius).not.toBeCloseTo(l2.radius, 3);
  });

  it('the crease starts with zero depth and deepens', () => {
    const mesh = buildCrotchMesh(inputFor(plan(), { sides: 24 }));
    const turn = (k: number): number => crotchPinchTurning(mesh, k, 0);
    // A round ring of 24 vertices already turns 15 degrees per vertex; the crease adds to that.
    const polygon = (2 * Math.PI) / 24;
    expect(Math.abs(turn(0) - polygon)).toBeLessThan(0.1 * DEG);
    expect(turn(1) - polygon).toBeLessThan(2 * DEG);
    for (let k = 1; k < mesh.rings - 2; k++) expect(turn(k + 1)).toBeGreaterThan(turn(k));
  });

  it('Inner = 0 keeps a sharp crease, Inner = 1 fills it (turning angle of the pinch)', () => {
    const p = plan();
    const sharp = buildCrotchMesh(inputFor(p, { sides: 24, innerSmooth: 0 }));
    const filled = buildCrotchMesh(inputFor(p, { sides: 24, innerSmooth: 1 }));
    let peak = 1;
    for (let k = 1; k < sharp.rings - 1; k++) if (creaseFillWeight(k / (sharp.rings - 1)) >= creaseFillWeight(peak / (sharp.rings - 1))) peak = k;
    expect(creaseFillWeight(peak / (sharp.rings - 1))).toBeCloseTo(1, 6);
    const last = sharp.rings - 2;
    expect(crotchPinchTurning(sharp, last, 0)).toBeGreaterThanOrEqual(60 * DEG);
    expect(crotchPinchTurning(sharp, last, 'B')).toBeGreaterThanOrEqual(60 * DEG);
    expect(crotchPinchTurning(filled, peak, 0)).toBeLessThanOrEqual(10 * DEG);
    expect(crotchPinchTurning(filled, peak, 'B')).toBeLessThanOrEqual(10 * DEG);
    // The fill never changes ring 0 or the open ends.
    for (const k of [0, sharp.rings - 1]) {
      for (let j = 0; j < 24; j++) {
        const v = crotchVertexIndex(24, sharp.rings, k, j) * 3;
        for (let c = 0; c < 3; c++) expect(filled.positions[v + c]).toBe(sharp.positions[v + c]);
      }
    }
  });

  it('Outer smoothing moves vertices by at most 10% of the ring spacing along the axis', () => {
    const p = plan();
    const raw = buildCrotchMesh(inputFor(p, { sides: 16 }));
    const smooth = buildCrotchMesh(inputFor(p, { sides: 16, outerSmooth: 1 }));
    const l1 = p.lobes[0];
    let spacing = 0;
    for (let k = 1; k < l1.ringCount; k++) {
      spacing += Math.hypot(l1.positions[k * 3]! - l1.positions[(k - 1) * 3]!, l1.positions[k * 3 + 1]! - l1.positions[(k - 1) * 3 + 1]!, l1.positions[k * 3 + 2]! - l1.positions[(k - 1) * 3 + 2]!);
    }
    spacing /= l1.ringCount - 1;
    let moved = 0;
    for (let v = 0; v < raw.vertexCount; v++) {
      const dz = smooth.positions[v * 3 + 2]! - raw.positions[v * 3 + 2]!;
      const dx = smooth.positions[v * 3]! - raw.positions[v * 3]!;
      const dy = smooth.positions[v * 3 + 1]! - raw.positions[v * 3 + 1]!;
      if (Math.hypot(dx, dy, dz) > 1e-9) moved++;
      // The parent runs along +Z and the lobes are tilted by < 30 degrees: the axial part is bounded by the limit (small slack for the tilt).
      expect(Math.abs(dz)).toBeLessThanOrEqual(0.1 * spacing * 1.2 + Math.hypot(dx, dy) * Math.sin(30 * DEG));
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const a = buildCrotchMesh(inputFor(plan(), { sides: 16, innerSmooth: 0.6, outerSmooth: 0.4 }));
    const b = buildCrotchMesh(inputFor(plan(), { sides: 16, innerSmooth: 0.6, outerSmooth: 0.4 }));
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(Array.from(b.indices)).toEqual(Array.from(a.indices));
    expect(Array.from(b.normals)).toEqual(Array.from(a.normals));
  });

  it('produces finite, unit normals', () => {
    const mesh = buildCrotchMesh(inputFor(plan({ balance: 0.8, expand1: 1.5, expand2: 0.7 }), { sides: 12, innerSmooth: 0.3, outerSmooth: 0.5 }));
    for (let v = 0; v < mesh.vertexCount; v++) {
      expect(Number.isFinite(mesh.positions[v * 3]! + mesh.positions[v * 3 + 1]! + mesh.positions[v * 3 + 2]!)).toBe(true);
      expect(Math.hypot(mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!)).toBeCloseTo(1, 4);
    }
  });
});
