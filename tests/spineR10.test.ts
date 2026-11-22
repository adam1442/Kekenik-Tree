import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { NodeParams } from '@/contracts/params';
import { Rng } from '@/core/rng';
import {
  LENGTH_BASIS,
  RADIAL_BASIS,
  accuratePointCount,
  alignedNormal,
  clampLength,
  curlStepAngle,
  directionalPruneChance,
  groundPrunes,
  influenceGain,
  intersectsGround,
  lengthSegmentCount,
  migrateSpineParams,
  noiseKeep,
  oneVTileLength,
  pruneStrength,
  radialSegmentCount,
  reshapeWeldSamples,
  shapedEnvelope,
  spineLength,
  startAngleFromDegrees,
  startAngleFromUnit,
  straightnessRemoval,
  unifiedStartRoll,
  weldSegmentCount,
  zigzagKick,
  zigzagSegmentLength,
} from '@/generators/spine';
import { GraphEvaluator, hashPortValue, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { getInspectorTabSpecs } from '@/ui/panels/properties/inspectorState';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string) => r.scene.skeletons.find((s) => s.nodeId === id)!.skeleton;

describe('length formula and clamp', () => {
  it('adds the absolute length, the % of the parent and the % of the radius', () => {
    expect(spineLength({ absolute: 2, percentParent: 0.5, percentRadius: 10, parentLength: 4, parentRadius: 0.1 })).toBeCloseTo(2 + 2 + 1, 6);
    expect(spineLength({ absolute: 2, percentParent: 0, percentRadius: 0, parentLength: 4, parentRadius: 0.1 })).toBe(2);
    expect(spineLength({ absolute: -1, percentParent: -1, percentRadius: -1, parentLength: 4, parentRadius: 1 })).toBe(0);
  });

  it('clamps with Min / Max (0 = off) and the minimum wins when they cross', () => {
    expect(clampLength(5, 0, 0)).toBe(5);
    expect(clampLength(5, 0, 3)).toBe(3);
    expect(clampLength(1, 2, 0)).toBe(2);
    expect(clampLength(5, 4, 3)).toBe(4);
  });

  it('Match one V tile is the circumference times the texture aspect', () => {
    expect(oneVTileLength(0.5, 1)).toBeCloseTo(Math.PI, 6);
    expect(oneVTileLength(0.5, 2)).toBeCloseTo(2 * Math.PI, 6);
    expect(oneVTileLength(0.5, Number.NaN)).toBeCloseTo(Math.PI, 6);
  });

  it('shape scale 0 switches the envelope off, 1 keeps it, 2 doubles its deviation', () => {
    expect(shapedEnvelope(0.5, 0)).toBe(1);
    expect(shapedEnvelope(0.5, 1)).toBeCloseTo(0.5, 6);
    expect(shapedEnvelope(0.75, 2)).toBeCloseTo(0.5, 6);
  });

  it('Clamp Min / Max and the additive terms drive a real Branch', async () => {
    const make = (extra: Record<string, number>): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 1, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, spineOnly: true, ...extra, length: { value: extra.length ?? 3, variance: 0 } } },
    ];
    const len = async (extra: Record<string, number>) => skeletonOf(await run(make(extra)), 'sp').branches[0]!.length;
    expect(await len({ length: 3 })).toBeCloseTo(3, 1);
    expect(await len({ length: 2, lengthPercent: 0.5 })).toBeCloseTo(2, 1); // no parent: the parent terms do not apply
    expect(await len({ length: 3, lengthMin: 5 })).toBeGreaterThan(4.9);
    expect(await len({ length: 3, lengthMax: 2 })).toBeLessThan(2.05);
  });
});

describe('start angle semantics', () => {
  it('0 = parent direction, 0.5 = perpendicular, 1 = opposite', () => {
    expect(startAngleFromUnit(0)).toBe(0);
    expect(startAngleFromUnit(0.5)).toBeCloseTo(Math.PI / 2, 9);
    expect(startAngleFromUnit(1)).toBeCloseTo(Math.PI, 9);
    expect(startAngleFromUnit(7)).toBeCloseTo(Math.PI, 9);
    expect(startAngleFromDegrees(90)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('the first segment of a child follows Start angle 0 / 90 / 180 relative to the parent direction', async () => {
    const dot = async (angle: number): Promise<number> => {
      const r = await run([
        { id: 'tree', type: 'output.tree', parent: null },
        { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { spineOnly: true, lean: 0, spread: 0, noiseAmount: 0, earlyNoiseAmount: 0, length: 6 } },
        {
          id: 'br',
          type: 'generator.branch',
          parent: 'trunk',
          params: { number: 1, first: 0.5, last: 0.5, spineOnly: true, spread: angle, gravity: 0, upDown: 0, curvature: 0, noiseAmount: 0, earlyNoiseAmount: 0, pruneGround: 0, length: 1, pitch: 0 },
        },
      ]);
      const sk = skeletonOf(r, 'br');
      const b = sk.branches[0]!;
      const d = [0, 1, 2].map((c) => (sk.position[(b.start + 1) * 3 + c] as number) - (sk.position[b.start * 3 + c] as number));
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      return d[2]! / l; // the trunk grows along +Z
    };
    expect(await dot(0)).toBeGreaterThan(0.95);
    expect(Math.abs(await dot(90))).toBeLessThan(0.15);
    expect(await dot(180)).toBeLessThan(-0.95);
  });

  it('Alignment 1 turns the branch top to the world up regardless of the random roll', () => {
    const t: [number, number, number] = [1, 0, 0];
    for (const roll of [0, 1, 2.5, 5]) {
      const n = alignedNormal(t, [0, 1, 0], 1, roll);
      expect(n[2]).toBeCloseTo(1, 6);
    }
    const free = alignedNormal(t, [0, 1, 0], 0, 2.5);
    expect(Math.abs(free[2])).toBeLessThan(0.999);
  });

  it('Unify mirrors the start roll of the nodes on the opposite side', () => {
    expect(unifiedStartRoll(30, -1, true)).toBe(-30);
    expect(unifiedStartRoll(30, 1, true)).toBe(30);
    expect(unifiedStartRoll(30, -1, false)).toBe(30);
  });
});

describe('segment counts', () => {
  const base = { style: 'default' as const, absolute: 4, relative: 0.5, length: 6, radius: 0.1, parentSegments: 10, scalar: 1 };
  it('Length only: Absolute + Relative x length', () => {
    expect(lengthSegmentCount({ ...base, basis: LENGTH_BASIS.length })).toBe(7);
  });
  it('Length/radius ratio: Absolute + Relative x (length / radius)', () => {
    expect(lengthSegmentCount({ ...base, relative: 0.1, basis: LENGTH_BASIS.ratio })).toBe(10);
  });
  it("Parent's length segments: Absolute + Relative x parent segments", () => {
    expect(lengthSegmentCount({ ...base, basis: LENGTH_BASIS.parent })).toBe(9);
  });
  it('Legacy ignores the basis and counts per metre; Scalar multiplies the result', () => {
    expect(lengthSegmentCount({ ...base, style: 'legacy', basis: LENGTH_BASIS.parent })).toBe(7);
    expect(lengthSegmentCount({ ...base, basis: LENGTH_BASIS.length, scalar: 2 })).toBe(14);
    expect(lengthSegmentCount({ ...base, absolute: 0, relative: 0, basis: LENGTH_BASIS.length })).toBe(1);
  });
  it('radial: Absolute + Relative x radius or parent sides, at least 3', () => {
    const r = { absolute: 6, relative: 20, radius: 0.25, parentSides: 12, scalar: 1 };
    expect(radialSegmentCount({ ...r, basis: RADIAL_BASIS.radius })).toBe(11);
    expect(radialSegmentCount({ ...r, relative: 0.5, basis: RADIAL_BASIS.parent })).toBe(12);
    expect(radialSegmentCount({ ...r, absolute: 0, relative: 0, basis: RADIAL_BASIS.radius })).toBe(3);
    expect(radialSegmentCount({ ...r, basis: RADIAL_BASIS.radius, scalar: 0.5 })).toBe(6);
  });
  it('Accuracy is an exact point count; Influence normalises by the step count', () => {
    expect(accuratePointCount(24)).toBe(24);
    expect(accuratePointCount(1)).toBe(3);
    expect(influenceGain(1, 20) * 20).toBeCloseTo(1, 9);
    expect(influenceGain(2, 20)).toBeCloseTo(2 * influenceGain(1, 20), 9);
    expect(influenceGain(0, 20)).toBe(0);
    expect(weldSegmentCount(3, 2)).toBe(6);
    expect(weldSegmentCount(3, 0)).toBe(1);
  });
  it('weld samples hold natural x scalar segments inside the weld part and keep the rest', () => {
    const n = 21;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos[i * 3 + 2] = i * 0.1;
    const natural = Int32Array.from([0, 2, 4, 10, 20]);
    const more = reshapeWeldSamples(pos, n, natural, 0.4, 2);
    expect(Array.from(more).filter((i) => i <= 4).length).toBeGreaterThan(3);
    expect(Array.from(more).filter((i) => i > 4)).toEqual([10, 20]);
    expect(more[0]).toBe(0);
    expect(more[more.length - 1]).toBe(20);
  });

  it('Accuracy gives exactly that many points on the high-resolution spine', async () => {
    const r = await run([
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 1, accuracy: 20, segments: 400, spineOnly: true, noiseAmount: 0, earlyNoiseAmount: 0 } },
    ]);
    expect(skeletonOf(r, 'sp').branches[0]!.count).toBe(20);
  });

  it('Relative segments grow with the length / radius ratio in the Default style', async () => {
    const count = async (relative: number, style: string) => {
      const r = await run([
        { id: 'tree', type: 'output.tree', parent: null },
        { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 1, accuracy: 128, segments: 4, relativeSegments: relative, lengthStyle: style, length: 2, radius: 0.1, spineOnly: true, noiseAmount: 0, earlyNoiseAmount: 0 } },
      ]);
      return skeletonOf(r, 'sp').branches[0]!.count;
    };
    expect(await count(0, 'default')).toBe(5);
    expect(await count(0.5, 'default')).toBeGreaterThan(5);
    expect(await count(0.5, 'legacy')).toBe(6);
  });

  it('stores the radial segments per branch (Absolute + Relative x radius)', async () => {
    const r = await run([
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 1, sides: 6, radialRelative: 20, radius: 0.1, spineOnly: true } },
    ]);
    const sk = skeletonOf(r, 'sp');
    expect(sk.attributes.get('radialSides')![sk.branches[0]!.start]).toBeGreaterThanOrEqual(8);
  });
});

describe('shape: straightness, influence, curl, zigzag', () => {
  it('Straightness removes noise fully at the base and not at all at the tip', () => {
    expect(straightnessRemoval(0, 1)).toBe(1);
    expect(straightnessRemoval(1, 1)).toBe(0);
    expect(straightnessRemoval(0.5, 0.6)).toBeCloseTo(0.3, 9);
    expect(noiseKeep(0, 1)).toBe(0);
    expect(noiseKeep(1, 1)).toBe(1);
    expect(noiseKeep(0, 0)).toBe(1);
  });

  it('Parent Curl turn integrates to value x 1.4 rad and Influence scales it', () => {
    let total = 0;
    const steps = 200;
    for (let s = 1; s <= steps; s++) total += curlStepAngle(1, s / steps, steps, 1);
    expect(total).toBeCloseTo(1.4 * 1.0, 1);
    expect(curlStepAngle(1, 0.5, steps, 2)).toBeCloseTo(2 * curlStepAngle(1, 0.5, steps, 1), 9);
  });

  it('zigzag spacing is Absolute + Relative x length scaled by the curve and never below the minimum', () => {
    expect(zigzagSegmentLength(0.2, 0.1, 3, 1, 0.01)).toBeCloseTo(0.5, 9);
    expect(zigzagSegmentLength(0.2, 0.1, 3, 2, 0.01)).toBeCloseTo(1, 9);
    expect(zigzagSegmentLength(0, 0, 3, 1, 0.05)).toBe(0.05);
    expect([0, 1, 2, 3].map((i) => zigzagKick(i, 1))).toEqual([1, -2, 2, -2]);
  });

  const tipBend = async (extra: Record<string, number>): Promise<number> => {
    const r = await run([
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 1, length: 4, spread: 0, noiseAmount: 0, earlyNoiseAmount: 0, spineOnly: true, ...extra } },
    ]);
    const sk = skeletonOf(r, 'sp');
    const last = sk.branches[0]!.start + sk.branches[0]!.count - 1;
    return Math.hypot(sk.position[last * 3] as number, sk.position[last * 3 + 1] as number);
  };

  it('Influence strengthens bending and keeps the shape when Accuracy changes', async () => {
    const weak = await tipBend({ gravity: 0.5, accuracy: 24, segmentInfluence: 0.5 });
    const normal = await tipBend({ gravity: 0.5, accuracy: 24, segmentInfluence: 1 });
    const strong = await tipBend({ gravity: 0.5, accuracy: 24, segmentInfluence: 2 });
    expect(strong).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThan(weak);
    const fine = await tipBend({ gravity: 0.5, accuracy: 96, segmentInfluence: 1 });
    expect(Math.abs(fine - normal) / normal).toBeLessThan(0.25);
  });

  it('Parent Curl Up / Right / Out each move the tip of an angled spine', async () => {
    const tip = async (extra: Record<string, number>): Promise<number[]> => {
      const r = await run([
        { id: 'tree', type: 'output.tree', parent: null },
        { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 1, length: 4, spread: 60, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, spineOnly: true, ...extra } },
      ]);
      const sk = skeletonOf(r, 'sp');
      const last = sk.branches[0]!.start + sk.branches[0]!.count - 1;
      return [0, 1, 2].map((c) => sk.position[last * 3 + c] as number);
    };
    const base = await tip({});
    for (const id of ['curlUp', 'curlRight', 'curlOut']) {
      const moved = await tip({ [id]: 1 });
      expect(Math.hypot(moved[0]! - base[0]!, moved[1]! - base[1]!, moved[2]! - base[2]!)).toBeGreaterThan(0.3);
    }
  });

  it('a longer zigzag segment length gives fewer corners (smaller sideways drift)', async () => {
    const short = await tipBend({ zigzag: 1, zigzagLengthRelative: 0.05, zigzagLengthAbsolute: 0 });
    const none = await tipBend({});
    expect(short).toBeGreaterThan(none + 0.05);
  });
});

describe('prune', () => {
  it('strengths accept numbers and legacy booleans', () => {
    expect(pruneStrength(true)).toBe(1);
    expect(pruneStrength(false)).toBe(0);
    expect(pruneStrength(0.4)).toBe(0.4);
    expect(pruneStrength(7)).toBe(1);
    expect(pruneStrength(undefined, 0.3)).toBe(0.3);
  });

  it('Up / Down / Interior weigh by direction, curves scale the chance', () => {
    expect(directionalPruneChance('up', 1, 1, [0, 0, 1], [1, 0, 0])).toBe(1);
    expect(directionalPruneChance('up', 1, 1, [0, 0, -1], [1, 0, 0])).toBe(0);
    expect(directionalPruneChance('down', 1, 1, [0, 0, -1], [1, 0, 0])).toBe(1);
    expect(directionalPruneChance('down', 1, 0.5, [0, 0, -1], [1, 0, 0])).toBe(0.5);
    expect(directionalPruneChance('interior', 1, 1, [-1, 0, 0], [2, 0, 1])).toBe(1);
    expect(directionalPruneChance('interior', 1, 1, [1, 0, 0], [2, 0, 1])).toBe(0);
    expect(directionalPruneChance('interior', 1, 1, [-1, 0, 0], [0, 0, 1])).toBe(0);
  });

  it('Ground removes only branches that intersect the ground plane', () => {
    const pts = new Float32Array([0, 0, 1, 0, 0, 0.5, 0, 0, -0.2]);
    expect(intersectsGround(pts, 3)).toBe(true);
    expect(intersectsGround(pts, 2)).toBe(false);
    expect(groundPrunes(1, 1, true, new Rng(1))).toBe(true);
    expect(groundPrunes(1, 1, false, new Rng(1))).toBe(false);
    expect(groundPrunes(0, 1, true, new Rng(1))).toBe(false);
    let removed = 0;
    for (let i = 0; i < 200; i++) if (groundPrunes(0.5, 1, true, new Rng(i))) removed++;
    expect(removed).toBeGreaterThan(60);
    expect(removed).toBeLessThan(140);
  });

  it('a hanging branch is removed by Ground = 1 and kept by Ground = 0', async () => {
    const count = async (ground: number): Promise<number> => {
      const r = await run([
        { id: 'tree', type: 'output.tree', parent: null },
        { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { spineOnly: true, length: 1, lean: 0, spread: 0 } },
        { id: 'br', type: 'generator.branch', parent: 'trunk', params: { number: 6, first: 0.2, last: 0.6, spineOnly: true, length: 6, spread: 120, gravity: 2, pruneGround: ground, pruneGeneral: 0 } },
      ]);
      return r.diagnostics.get('br')?.branches ?? 0;
    };
    expect(await count(0)).toBe(6);
    expect(await count(1)).toBeLessThan(6);
  });
});

describe('determinism, migration and parameters', () => {
  const graph = (): NodeSpec[] => [
    { id: 'tree', type: 'output.tree', parent: null },
    { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: {} },
    { id: 'br', type: 'generator.branch', parent: 'trunk', params: { number: 20, unify: true, zigzag: 0.4, pruneGeneral: 0.2, pruneUp: 0.3, alignment: 0.5, startRoll: 20, relativeSegments: 0.05, radialRelative: 10 } },
  ];

  it('the same graph and seed give the same meshes, another seed another plant', async () => {
    const hash = (r: Result): string[] => r.scene.entries.map((e) => `${e.nodeId}:${hashPortValue({ kind: 'Mesh', value: e.mesh })}`).sort();
    const a = hash(await run(graph(), 5));
    const b = hash(await run(graph(), 5));
    const c = hash(await run(graph(), 6));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  }, 60000);

  it('migrates the former parameters and is idempotent', () => {
    const old: NodeParams = {
      lengthRelative: { value: true },
      lengthPercent: { value: 0 },
      matchOneVTile: { value: 'yes' },
      pruneGround: { value: true },
      lengthSegments: { value: 14 },
      zigzag: { value: 0.3 },
      segments: { value: 14 },
    };
    const m = migrateSpineParams(old);
    expect(m.lengthRelative).toBeUndefined();
    expect(m.lengthPercent?.value).toBe(0.35);
    expect(m.matchOneVTile?.value).toBe(true);
    expect(m.pruneGround?.value).toBe(1);
    expect(m.lengthSegments).toBeUndefined();
    expect(m.segments?.value).toBe(14);
    expect(m.zigzagLengthRelative?.value).toBeCloseTo(1 / 14, 9);
    expect(migrateSpineParams(m)).toEqual(m);
    expect(migrateSpineParams({ relativeSegments: { value: 0.2 } }).lengthStyle?.value).toBe('legacy');
    expect(migrateSpineParams({})).toEqual({});
  });

  it('declares the Segments tab and the new Spine sections with tooltips', () => {
    for (const type of ['generator.trunk', 'generator.branch', 'generator.root', 'generator.spine']) {
      const defs = getNodeDef(type)!.params;
      const tabs = getInspectorTabSpecs(type, defs);
      expect(tabs.find((t) => t.id === 'Segments')?.disabled).toBeFalsy();
      const seg = defs.filter((d) => d.group === 'Segments');
      expect(seg.map((d) => `${d.subgroup ?? ''}:${d.label}`)).toEqual(
        expect.arrayContaining([':Accuracy', ':Influence', ':Scalar', 'Length:Style', 'Length:Absolute', 'Length:+ Relative', 'Length:Relative basis', 'Length:Weld scalar', 'Length:Optimization', 'Radial:Absolute', 'Radial:+ Relative', 'Radial:Relative basis']),
      );
      expect(defs.every((d) => Boolean(d.tooltip) || d.kind === 'list')).toBe(true);
    }
    const spine = getNodeDef('generator.branch')!.params.filter((d) => d.group === 'Spine');
    const labels = (sub: string): string[] => spine.filter((d) => d.subgroup === sub).map((d) => d.label);
    expect(labels('Length')).toEqual(expect.arrayContaining(['Absolute', '+ % of parent', '+ % of radius', 'Match one V tile', 'Stop shape control', 'Shape scale']));
    expect(labels('Clamp')).toEqual(['Min', 'Max']);
    expect(labels('Orientation')).toEqual(expect.arrayContaining(['Start angle', 'Start roll', 'Alignment', 'Roll', 'Unify', 'Weld start']));
    expect(labels('Shape')).toEqual(expect.arrayContaining(['Gravity', 'Ancestor', 'Straightness', 'Twist']));
    expect(labels('Parent Curl')).toEqual(['Up', 'Right', 'Out']);
    expect(labels('Zigzag')).toEqual(['Intensity']);
    expect(labels('Segment length')).toEqual(['Absolute', '+ Relative']);
    expect(labels('Prune')).toEqual(['Interior', 'Up', 'Down', 'General', 'Ground']);
    for (const id of ['pruneInterior', 'pruneUp', 'pruneDown', 'pruneGeneral', 'pruneGround', 'zigzagLengthAbsolute']) {
      const d = getNodeDef('generator.branch')!.params.find((p) => p.id === id)!;
      expect('curveAllowed' in d && d.curveAllowed).toBe(true);
    }
  });
});
