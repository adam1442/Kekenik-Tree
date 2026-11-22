import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { MaterialDef } from '@/contracts/material';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import type { MeshData } from '@/contracts/mesh';
import { getCurvePreset } from '@/core/curve';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildTubeMesh } from '@/geometry/tubeMesher';
import {
  applySharpness,
  createBranchDisplacer,
  flareOffset,
  mainHeight,
  periodicNoise2,
  sharpnessLut,
  type BranchDisplaceSpec,
  type BranchDisplaceVertex,
  type DisplaceOut,
} from '@/generators/displace';
import { createDisplacementDef, registerDisplacementSource } from '@/materials/displacement';
import { setMaterialSource } from '@/materials/materialSource';
import { resolveHeightSource } from '@/nodes/generators/displacement';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const RADIUS = 0.2;
const LENGTH = 2.5;

const baseSpec = (over: Partial<BranchDisplaceSpec> = {}): BranchDisplaceSpec => ({
  source: 'noise',
  radial: 0,
  length: 0,
  sharpness: null,
  mapping: 'fit',
  scaleU: 1,
  scaleV: 1,
  seed: 1,
  map: null,
  fine: { amount: 0, sharpness: null, scale: 1 },
  shape: { amount: 0, twist: 0, scale: 1, seed: 0 },
  flares: { radius: 0, noiseScale: 5, height: 1, pinch: 0, angle: 0, seed: 0 },
  fadeBase: 0,
  fadeTip: 0,
  lod: 0,
  lodFade: false,
  ...over,
});

function cylinder(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i < 6; i++) sb.addPoint(0, 0, (i * LENGTH) / 5, RADIUS);
  sb.endBranch();
  return sb.build();
}

function mesh(spec: BranchDisplaceSpec | null, sides = 24): MeshData {
  const displaceField = spec ? createBranchDisplacer(spec) : null;
  return buildTubeMesh(cylinder(), {
    maxGeneration: 8,
    radialSegments: () => sides,
    color: () => [0.3, 0.2, 0.1],
    uvMetres: 1,
    materialId: 'bark',
    maxSegmentLength: 0.05,
    ...(displaceField ? { displaceField, displaceDirection: 'normal' as const } : {}),
  });
}

/** Vertices of the tube wall (the tip dome and the base cap are excluded). */
function wall(m: MeshData, zMin = 0, zMax = LENGTH - 0.15): { x: number; y: number; z: number; r: number; i: number }[] {
  const out: { x: number; y: number; z: number; r: number; i: number }[] = [];
  for (let i = 0; i < m.positions.length / 3; i++) {
    const x = m.positions[i * 3] as number;
    const y = m.positions[i * 3 + 1] as number;
    const z = m.positions[i * 3 + 2] as number;
    if (z >= zMin - 1e-6 && z <= zMax) out.push({ x, y, z, r: Math.hypot(x, y), i });
  }
  return out;
}

/** Number of edges used by exactly one triangle after merging vertices that share a position. */
function openEdges(m: MeshData): number {
  const key = (i: number): string =>
    [0, 1, 2].map((k) => Math.round((m.positions[i * 3 + k] as number) * 1e4)).join(',');
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(m.indices[t + e] as number);
      const b = key(m.indices[t + ((e + 1) % 3)] as number);
      if (a === b) continue;
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c === 1) open++;
  return open;
}

const vertexAt = (over: Partial<BranchDisplaceVertex> = {}): BranchDisplaceVertex => ({
  u: 0.3, s: 0.5, t: 0.2, sEnd: 2, radius: RADIUS, circumference: 2 * Math.PI * RADIUS, sides: 24, junction: false,
  uvU: 0.3, uvV: 0.5, uTiles: 1, length: LENGTH, baseRadius: RADIUS, sFree: 0.5, branch: 0, ...over,
});

const run = (d: NonNullable<ReturnType<typeof createBranchDisplacer>>, v: BranchDisplaceVertex): DisplaceOut => {
  const out: DisplaceOut = { radial: 0, along: 0, normal: 0 };
  d(v, out);
  return out;
};

describe('Main: Radial amount and Length amount on a cylinder', () => {
  it('Radial amount pushes the wall out by at most the amount', () => {
    const w = wall(mesh(baseSpec({ radial: 0.05 })), 0.2);
    const rs = w.map((v) => v.r);
    expect(Math.min(...rs)).toBeGreaterThan(RADIUS - 1e-3);
    expect(Math.max(...rs)).toBeLessThanOrEqual(RADIUS + 0.05 + 1e-3);
    expect(Math.max(...rs)).toBeGreaterThan(RADIUS + 0.01);
  });

  it('a negative Radial amount pulls the wall toward the spine', () => {
    const rs = wall(mesh(baseSpec({ radial: -0.05 })), 0.2).map((v) => v.r);
    expect(Math.max(...rs)).toBeLessThan(RADIUS + 1e-3);
    expect(Math.min(...rs)).toBeGreaterThanOrEqual(RADIUS - 0.05 - 1e-3);
    expect(Math.min(...rs)).toBeLessThan(RADIUS - 0.01);
  });

  it('zero amounts leave the cylinder untouched', () => {
    const rs = wall(mesh(baseSpec()), 0.05).map((v) => v.r);
    expect(Math.max(...rs) - Math.min(...rs)).toBeLessThan(1e-4);
  });

  it('Length amount moves vertices along the spine so rings are no longer coplanar', () => {
    const flat = new Set(wall(mesh(null)).map((v) => Math.round(v.z * 1e5)));
    const moved = wall(mesh(baseSpec({ length: 0.05 })), 0, LENGTH + 0.2);
    const zs = new Set(moved.map((v) => Math.round(v.z * 1e5)));
    expect(zs.size).toBeGreaterThan(flat.size * 3);
    const rings = [...flat].map((z) => z / 1e5).sort((a, b) => a - b);
    for (const v of moved) {
      if (v.z > LENGTH - 0.2) continue;
      const below = rings.filter((z) => z <= v.z + 1e-4).pop() ?? 0;
      expect(v.z - below).toBeLessThanOrEqual(0.05 + 1e-3);
    }
    const rs = moved.filter((v) => v.z > 0.2 && v.z < LENGTH - 0.3).map((v) => v.r);
    expect(Math.max(...rs) - Math.min(...rs)).toBeLessThan(1e-3);
  });

  it('adds rings and sides when auto-subdividing is on (more vertices than the plain tube)', () => {
    const sb = cylinder();
    const plain = buildTubeMesh(sb, { maxGeneration: 8, radialSegments: () => 24, color: () => [0.3, 0.2, 0.1], uvMetres: 1, materialId: 'bark' });
    expect(mesh(baseSpec({ radial: 0.02 })).positions.length).toBeGreaterThan(plain.positions.length);
  });
});

describe('Sharpness curve', () => {
  it('a straight line is linear (no remap) and values pass unchanged', () => {
    expect(sharpnessLut(getCurvePreset('linear'))).toBeNull();
    expect(sharpnessLut(null)).toBeNull();
    expect(applySharpness(null, 0.37)).toBeCloseTo(0.37, 6);
    expect(applySharpness(null, 2)).toBe(1);
  });

  it('a late-rise curve keeps only high values', () => {
    const lut = sharpnessLut(getCurvePreset('late-rise'));
    expect(lut).not.toBeNull();
    expect(applySharpness(lut, 0.3)).toBeLessThan(0.15);
    expect(applySharpness(lut, 0)).toBeLessThan(0.01);
    expect(applySharpness(lut, 1)).toBeGreaterThan(0.95);
  });

  it('lowers the average displacement on the mesh', () => {
    const avg = (spec: BranchDisplaceSpec): number => {
      const rs = wall(mesh(spec), 0.2).map((v) => v.r - RADIUS);
      return rs.reduce((a, b) => a + b, 0) / rs.length;
    };
    const sharp = avg(baseSpec({ radial: 0.05, sharpness: sharpnessLut(getCurvePreset('late-rise')) }));
    expect(sharp).toBeLessThan(avg(baseSpec({ radial: 0.05 })));
  });
});

describe('Flares', () => {
  const spec = baseSpec({ flares: { radius: 1.5, noiseScale: 5, height: 0.6, pinch: 0, angle: 0, seed: 3 } });

  it('never exceeds radius x multiple and stays below the flare height', () => {
    const w = wall(mesh(spec), 0);
    for (const v of w) {
      expect(v.r).toBeLessThanOrEqual(RADIUS * (1 + 1.5) + 1e-3);
      if (v.z > 0.6 + 0.02) expect(Math.abs(v.r - RADIUS)).toBeLessThan(1e-3);
    }
    expect(Math.max(...w.filter((v) => v.z < 0.05).map((v) => v.r))).toBeGreaterThan(RADIUS * 1.5);
  });

  it('Pinch narrows the lobes, Angle rotates them, Radius 0 disables them', () => {
    const mean = (pinch: number): number => {
      let sum = 0;
      for (let k = 0; k < 200; k++) sum += flareOffset({ ...spec.flares, pinch }, k / 200, 0, RADIUS, 0);
      return sum / 200;
    };
    expect(mean(1)).toBeLessThan(mean(0) * 0.8);
    const a = flareOffset(spec.flares, 0.31, 0.1, RADIUS, 2);
    const b = flareOffset({ ...spec.flares, angle: 36 }, 0.31 - 0.1, 0.1, RADIUS, 2);
    expect(b).toBeCloseTo(a, 6);
    expect(flareOffset({ ...spec.flares, radius: 0 }, 0.3, 0, RADIUS, 0)).toBe(0);
    expect(flareOffset(spec.flares, 0.3, spec.flares.height + 0.1, RADIUS, 0)).toBe(0);
  });

  it('fades out near a junction instead of cracking the weld', () => {
    const d = createBranchDisplacer(baseSpec({ fadeBase: 2, flares: { ...spec.flares, height: 3 } })) as NonNullable<ReturnType<typeof createBranchDisplacer>>;
    const at = (sFree: number): number => run(d, vertexAt({ junction: true, s: 0.1, sFree })).radial;
    expect(at(0)).toBe(0);
    expect(at(-0.1)).toBe(0);
    expect(at(0.1)).toBeLessThan(at(1));
  });
});

describe('Seams, determinism and sanity', () => {
  it('is identical at U = 0 and U = 1', () => {
    const d = createBranchDisplacer(
      baseSpec({ radial: 0.05, length: 0.03, fine: { amount: 0.01, sharpness: null, scale: 1 }, shape: { amount: 0.3, twist: 40, scale: 1, seed: 2 }, flares: { radius: 1, noiseScale: 5, height: 1, pinch: 0.3, angle: 20, seed: 1 } }),
    ) as NonNullable<ReturnType<typeof createBranchDisplacer>>;
    for (const s of [0.05, 0.4, 1.2]) {
      const a = run(d, vertexAt({ u: 0, s }));
      const b = run(d, vertexAt({ u: 1, s }));
      expect(b.radial).toBeCloseTo(a.radial, 6);
      expect(b.along).toBeCloseTo(a.along, 6);
      expect(b.normal).toBeCloseTo(a.normal, 6);
    }
    expect(periodicNoise2(0, 3.3, 7, 5)).toBeCloseTo(periodicNoise2(7, 3.3, 7, 5), 9);
  });

  it('keeps the tube closed (no cracks) with every feature on', () => {
    const m = mesh(
      baseSpec({
        radial: 0.04, length: 0.03, fadeBase: 1, fadeTip: 1,
        fine: { amount: 0.01, sharpness: null, scale: 1.5 },
        shape: { amount: 0.4, twist: 30, scale: 1, seed: 4 },
        flares: { radius: 1.2, noiseScale: 6, height: 0.8, pinch: 0.5, angle: 10, seed: 2 },
      }),
    );
    expect(openEdges(m)).toBe(0);
  });

  it('is deterministic and responds to the seed', () => {
    const a = mesh(baseSpec({ radial: 0.03, seed: 4 }));
    const b = mesh(baseSpec({ radial: 0.03, seed: 4 }));
    const c = mesh(baseSpec({ radial: 0.03, seed: 5 }));
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(Array.from(c.positions)).not.toEqual(Array.from(a.positions));
  });

  it('produces finite positions and unit, outward-facing normals', () => {
    const m = mesh(
      baseSpec({ radial: 0.03, length: 0.02, fadeTip: 1, fine: { amount: 0.01, sharpness: null, scale: 1 }, shape: { amount: 0.3, twist: 20, scale: 1, seed: 1 }, flares: { radius: 1, noiseScale: 5, height: 0.8, pinch: 0.2, angle: 0, seed: 1 } }),
    );
    let outward = 0;
    let total = 0;
    for (const v of wall(m, 0.2)) {
      const nx = m.normals[v.i * 3] as number;
      const ny = m.normals[v.i * 3 + 1] as number;
      const nz = m.normals[v.i * 3 + 2] as number;
      expect(Number.isFinite(v.x + v.y + v.z + nx + ny + nz)).toBe(true);
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 3);
      total++;
      if (nx * v.x + ny * v.y > 0) outward++;
    }
    expect(outward / total).toBeGreaterThan(0.98);
    for (const p of m.positions) expect(Number.isFinite(p)).toBe(true);
  });

  it('Shape creases and Twist change the surface, Twist rotates the pattern with height', () => {
    const sh = { amount: 0.4, twist: 0, scale: 1, seed: 3 };
    const d0 = createBranchDisplacer(baseSpec({ shape: sh })) as NonNullable<ReturnType<typeof createBranchDisplacer>>;
    const d1 = createBranchDisplacer(baseSpec({ shape: { ...sh, twist: 90 } })) as NonNullable<ReturnType<typeof createBranchDisplacer>>;
    expect(run(d0, vertexAt({ s: 0 })).radial).toBeCloseTo(run(d1, vertexAt({ s: 0 })).radial, 9);
    expect(run(d0, vertexAt({ s: 1 })).radial).not.toBeCloseTo(run(d1, vertexAt({ s: 1 })).radial, 4);
    expect(Math.abs(run(d0, vertexAt()).radial)).toBeLessThanOrEqual(0.4 * RADIUS * 0.5 + 1e-9);
  });

  it('Fine noise moves along the normal; Scale above 1 pushes out on average, below 1 pulls in', () => {
    const avg = (scale: number): number => {
      const d = createBranchDisplacer(baseSpec({ fine: { amount: 0.02, sharpness: null, scale } })) as NonNullable<ReturnType<typeof createBranchDisplacer>>;
      let sum = 0;
      for (let k = 0; k < 300; k++) sum += run(d, vertexAt({ u: (k % 30) / 30, s: 0.2 + Math.floor(k / 30) * 0.13 })).normal;
      return sum / 300;
    };
    expect(avg(2)).toBeGreaterThan(0);
    expect(avg(0.5)).toBeLessThan(0);
  });
});

describe('Sources', () => {
  const stripeAsset = (assetId: string): void => {
    const w = 8;
    const rgba = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) rgba.set([x % 2 ? 230 : 25, x % 2 ? 230 : 25, x % 2 ? 230 : 25, 255], (y * w + x) * 4);
    registerDisplacementSource(assetId, { width: w, height: w, rgba });
  };

  it('switches between noise and a height map', () => {
    stripeAsset('r15-stripes');
    const def = { ...createDisplacementDef('r15', 'Stripes'), assetId: 'r15-stripes', normalize: false };
    setMaterialSource({ materials: () => [], sets: () => [], masks: () => [], season: () => 0.5, displacements: () => [def] });
    const params = { displacement: { value: 'r15' }, displaceSource: { value: 'displacement' } };
    const mapSrc = resolveHeightSource(params, '');
    expect(mapSrc.state).toBe('ready');
    expect(mapSrc.chain).not.toBeNull();
    const noise = baseSpec({ radial: 0.05 });
    const image = baseSpec({ radial: 0.05, source: 'displacement', map: mapSrc.chain, scaleU: 4 });
    const v = vertexAt({ u: 0.06, t: 0.3 });
    const hn = mainHeight(noise, v);
    const hi = mainHeight(image, v);
    expect(hi).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(hn).not.toBeCloseTo(hi, 3);
    expect(Array.from(mesh(image).positions)).not.toEqual(Array.from(mesh(noise).positions));
    expect(resolveHeightSource({ displaceSource: { value: 'noise' } }, '').chain).toBeNull();
  });

  it('Material source reads the Height map of the assigned material', () => {
    stripeAsset('r15-height');
    const mat = { id: 'mat1', name: 'Bark', slots: { height: { texture: { assetId: 'r15-height' } } } } as unknown as MaterialDef;
    const plain = { id: 'mat2', name: 'Plain', slots: {} } as unknown as MaterialDef;
    setMaterialSource({ materials: () => [mat, plain], sets: () => [], masks: () => [], season: () => 0.5, displacements: () => [] });
    const params = { displaceSource: { value: 'material' } };
    expect(resolveHeightSource(params, 'mat1').state).toBe('ready');
    expect(resolveHeightSource(params, 'mat2').state).toBe('missing');
    expect(resolveHeightSource(params, 'missing').state).toBe('missing');
    setMaterialSource({ materials: () => [{ ...mat, slots: { height: { texture: { assetId: 'r15-not-decoded' } } } } as unknown as MaterialDef], sets: () => [], masks: () => [], season: () => 0.5, displacements: () => [] });
    expect(resolveHeightSource(params, 'mat1').state).toBe('unloaded');
    setMaterialSource(null);
  });

  it('Mapping: Use UVs repeats with the UV tiles, Fit to geometry does not', () => {
    const fit = baseSpec({ radial: 0.05, mapping: 'fit' });
    const uvs = baseSpec({ radial: 0.05, mapping: 'uvs' });
    const a = vertexAt({ uTiles: 1, uvV: 0.4 });
    const b = vertexAt({ uTiles: 3, uvV: 0.4 });
    expect(mainHeight(fit, a)).toBeCloseTo(mainHeight(fit, b), 9);
    expect(mainHeight(uvs, a)).not.toBeCloseTo(mainHeight(uvs, b), 3);
  });
});

describe('Displacement tab parameters and generator integration', () => {
  const TRUNK = { number: 1, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 1, length: { value: 3, variance: 0 }, radius: { value: 0.25, variance: 0 }, sides: 24, accuracy: 24, segments: 24 };
  const specs = (trunk: Record<string, unknown> = {}): NodeSpec[] => [
    { id: 'tree', type: 'output.tree', parent: null },
    { id: 'tr', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, ...trunk } as NodeSpec['params'] },
  ];
  const evalMesh = async (trunk: Record<string, unknown>): Promise<MeshData> => {
    const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs(trunk))), { seed: 3, lod: 0, token: new CancellationSource().token });
    return r.scene.entries.find((e) => e.nodeId === 'tr')!.mesh;
  };
  const maxRadius = (m: MeshData, zMax: number): number => {
    let r = 0;
    for (let i = 0; i < m.positions.length / 3; i++) if ((m.positions[i * 3 + 2] as number) <= zMax) r = Math.max(r, Math.hypot(m.positions[i * 3] as number, m.positions[i * 3 + 1] as number));
    return r;
  };

  it.each(['generator.trunk', 'generator.branch', 'generator.root'])('%s lists Main, Fine, Shape and Flares with the specified names', (type) => {
    const defs = getNodeDef(type)!.params.filter((p) => p.group === 'Displacement');
    const label = (sub: string): string[] => defs.filter((p) => p.subgroup === sub).map((p) => p.label);
    expect(label('Main')).toEqual(expect.arrayContaining(['Radial amount', 'Length amount', 'Sharpness', 'Source', 'Mapping', 'U scale', 'V scale', 'Seed']));
    expect(label('Fine')).toEqual(['Amount', 'Sharpness', 'Scale']);
    expect(label('Shape')).toEqual(['Amount', 'Twist', 'Scale', 'Seed']);
    expect(label('Flares')).toEqual(['Radius', 'Noise scale', 'Height', 'Pinch', 'Angle', 'Seed']);
    const source = defs.find((p) => p.id === 'displaceSource');
    expect(source?.kind === 'enum' ? source.options.map((o) => o.label) : []).toEqual(['Noise', 'Material', 'Displacement']);
    expect(defs.filter((p) => p.subgroup === 'Main' || p.subgroup === 'Fine' || p.subgroup === 'Shape' || p.subgroup === 'Flares').every((p) => !!p.tooltip || p.id === 'displacement' || p.kind === 'seed')).toBe(true);
  });

  it('defaults change nothing; Radial amount and Flares widen the evaluated trunk', async () => {
    const plain = await evalMesh({});
    const radial = await evalMesh({ displaceRadial: 0.05 });
    const flared = await evalMesh({ displaceFlareRadius: 1, displaceFlareHeight: 0.8 });
    const base = maxRadius(plain, 0.02);
    expect(maxRadius(radial, 2)).toBeGreaterThan(maxRadius(plain, 2) + 0.02);
    expect(maxRadius(radial, 2)).toBeLessThanOrEqual(maxRadius(plain, 2) + 0.05 + 1e-3);
    expect(maxRadius(flared, 0.1)).toBeGreaterThan(maxRadius(plain, 0.1) + 0.05);
    expect(maxRadius(flared, 0.1)).toBeLessThanOrEqual(base * 2 + 1e-3);
    expect(maxRadius(flared, 3.2)).toBeLessThanOrEqual(base * 2 + 1e-3);
    expect(radial.positions.every((p) => Number.isFinite(p))).toBe(true);
  });

  it('old projects with the asset amount keep their displacement', async () => {
    stripeOld();
    const m = await evalMesh({ displacement: 'old', displaceAmount: 0.05 });
    const plain = await evalMesh({});
    expect(maxRadius(m, 2)).toBeGreaterThan(maxRadius(plain, 2) + 0.005);
    setMaterialSource(null);
  });

  it('welded branches: weld rings stay put, displacement fades in after them (no cracks)', async () => {
    const BRANCH = { number: 4, first: 0.3, last: 0.8, mode: 'absolute', spread: { value: 70, variance: 0 }, length: { value: 1.5, variance: 0 }, radius: { value: 0.07, variance: 0 }, noiseAmount: 0, gravity: 0, sides: 12, weldEnabled: true, displaceAutoSubdivide: false };
    const branchMesh = async (extra: Record<string, unknown>): Promise<MeshData> => {
      const list: NodeSpec[] = [...specs(), { id: 'br', type: 'generator.branch', parent: 'tr', params: { ...BRANCH, ...extra } as NodeSpec['params'] }];
      const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(list)), { seed: 3, lod: 0, token: new CancellationSource().token });
      return r.scene.entries.find((e) => e.nodeId === 'br')!.mesh;
    };
    const plain = await branchMesh({});
    const moved = await branchMesh({ displaceRadial: 0.03, displaceFineAmount: 0.01, displaceFlareRadius: 1, displaceFlareHeight: 0.5, displaceFadeBase: 3 });
    expect(moved.positions.length).toBe(plain.positions.length);
    let unmoved = 0;
    let maxMove = 0;
    for (let i = 0; i < plain.positions.length / 3; i++) {
      const d = Math.hypot(
        (moved.positions[i * 3] as number) - (plain.positions[i * 3] as number),
        (moved.positions[i * 3 + 1] as number) - (plain.positions[i * 3 + 1] as number),
        (moved.positions[i * 3 + 2] as number) - (plain.positions[i * 3 + 2] as number),
      );
      expect(Number.isFinite(d)).toBe(true);
      if (d < 1e-7) unmoved++;
      maxMove = Math.max(maxMove, d);
    }
    expect(unmoved).toBeGreaterThanOrEqual(12 * 4);
    expect(maxMove).toBeGreaterThan(0.005);
    expect(maxMove).toBeLessThan(0.03 + 0.01 + 0.07 * 2 + 1e-3);
  });

  function stripeOld(): void {
    const w = 8;
    const rgba = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) rgba.set([x % 2 ? 230 : 25, x % 2 ? 230 : 25, x % 2 ? 230 : 25, 255], (y * w + x) * 4);
    registerDisplacementSource('r15-old', { width: w, height: w, rgba });
    const def = { ...createDisplacementDef('old', 'Old'), assetId: 'r15-old', normalize: false };
    setMaterialSource({ materials: () => [], sets: () => [], masks: () => [], season: () => 0.5, displacements: () => [def] });
  }
});
