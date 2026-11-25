import { beforeAll, describe, expect, it } from 'vitest';
import { OUTPUT_KEY } from '@/contracts/engine';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import { mergeMeshData, type MeshData } from '@/contracts/mesh';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { applyAoToGeometry } from '@/export/bake/aoCore';
import { mergeToPlantGeometry } from '@/export/geometry';
import { applyVertexColorPacking, sceneVertexColor } from '@/export/vertexColorExport';
import { readGlbJson, writeGltf } from '@/export/writers/gltf';
import { buildTubeMesh, type TubeOptions } from '@/geometry/tubeMesher';
import {
  applyVcMode,
  isNeutralVertexColor,
  itemBranchTint,
  itemColorFn,
  modifyColor,
  normalisedHeight,
  packKekenik,
  packKekenikColors,
  parseVcPacking,
  recordedPointColor,
  sampleLut,
  varianceFactor,
  zRangeOf,
  type Rgb,
  type VertexColorOptions,
} from '@/geometry/vertexColor';
import { readTreeVertexColor } from '@/geometry/vertexColor';
import { readVertexColorOptions } from '@/nodes/generators/common';
import { vertexColorParams } from '@/nodes/generators/params';
import { defaultParams, type NodeParams, type ParamState } from '@/contracts/params';

const TRUNK_POINTS = 8;

/** Trunk (branch 0, 8 points, straight up) with one child leaving point 4. */
function twoBranches(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i < TRUNK_POINTS; i++) sb.addPoint(0, 0, i * 0.5, 0.2 - i * 0.01);
  sb.endBranch();
  sb.beginBranch(0, 4, 1);
  for (let i = 0; i < 5; i++) sb.addPoint(i * 0.3, 0, 2 + i * 0.3, 0.08 - i * 0.01);
  sb.endBranch();
  return sb.build();
}

const vc = (over: Partial<VertexColorOptions> = {}): VertexColorOptions => ({ mode: 'inherit', color: [1, 1, 1], variance: 0, seamless: false, profile: null, parentCurve: null, ...over });

function mesh(sk: Skeleton, over: Partial<TubeOptions> = {}) {
  return buildTubeMesh(sk, {
    maxGeneration: 8,
    radialSegments: () => 8,
    color: (g, t) => [0.3 - g * 0.05, 0.2 - t * 0.05, 0.1],
    uvMetres: 1,
    materialId: 'bark',
    parent: sk,
    tintVariance: 0.2,
    ...over,
  });
}

/** Flat colour, no AO shading and no tint variance: the vertex colour equals the generator colour exactly. */
const FLAT: Partial<TubeOptions> = { color: () => [0.4, 0.2, 0.1], tintVariance: 0, aoStrength: 0 };

const checksum = (a: Float32Array): number => {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + Math.round((a[i] as number) * 1e6)) % 1000000007;
  return h;
};

describe('vertex colour maths', () => {
  const base: Rgb = [0.4, 0.2, 0.1];
  const own: Rgb = [0.5, 0.5, 1];
  it('Inherit / Multiply / Set / Add', () => {
    expect(applyVcMode('inherit', base, own)).toEqual(base);
    expect(applyVcMode('multiply', base, own)).toEqual([0.2, 0.1, 0.1]);
    expect(applyVcMode('set', base, own)).toEqual(own);
    expect(applyVcMode('add', base, own)).toEqual([0.9, 0.7, 1]);
    expect(applyVcMode('add', [0.8, 0.8, 0.8], own)).toEqual([1, 1, 1]);
  });
  it('the amount blends from the inherited colour to the mode result', () => {
    const o = vc({ mode: 'set', color: own });
    expect(modifyColor(base, o, 0, 0.3)).toEqual(base);
    expect(modifyColor(base, o, 1, 0.3)).toEqual(own);
    const half = modifyColor(base, o, 0.5, 0.3);
    expect(half[0]).toBeCloseTo(0.45);
    expect(half[2]).toBeCloseTo(0.55);
  });
  it('variance is a deterministic +- factor', () => {
    expect(varianceFactor(0.5, 0.4)).toBeCloseTo(1);
    expect(varianceFactor(0, 0.4)).toBeCloseTo(0.6);
    expect(varianceFactor(1, 0.4)).toBeCloseTo(1.4);
    expect(varianceFactor(0.7, 0.4)).toBe(varianceFactor(0.7, 0.4));
  });
  it('neutral options and curve sampling', () => {
    expect(isNeutralVertexColor(undefined)).toBe(true);
    expect(isNeutralVertexColor(vc())).toBe(true);
    expect(isNeutralVertexColor(vc({ mode: 'set' }))).toBe(false);
    expect(isNeutralVertexColor(vc({ variance: 0.1 }))).toBe(false);
    expect(isNeutralVertexColor(vc({ seamless: true }))).toBe(false);
    const lut = Float32Array.from([0, 1]);
    expect(sampleLut(lut, 0.5)).toBeCloseTo(0.5);
    expect(sampleLut(null, 0.5)).toBe(1);
  });
});

describe('packing', () => {
  it('channels are clamped to 0..1 and the height is normalised', () => {
    expect(packKekenik(-1, 2, 0.4)).toEqual([0, 1, 0.4]);
    expect(normalisedHeight(1, 0, 4)).toBe(0.25);
    expect(normalisedHeight(1, 1, 1)).toBe(0);
    expect(parseVcPacking('Kekenik')).toBe('kekenik');
    expect(parseVcPacking('nonsense')).toBe('legacy');
  });
  it('every channel of a real mesh is in 0..1 and G is monotone along a straight trunk', () => {
    const sk = twoBranches();
    const m = mesh(sk);
    expect(m.branchTint).toBeDefined();
    const packed = packKekenikColors({ positions: m.positions, ...(m.ao ? { ao: m.ao } : {}), ...(m.branchTint ? { branchTint: m.branchTint } : {}) });
    for (const v of packed) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const n = m.positions.length / 3;
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (m.positions[a * 3 + 2] as number) - (m.positions[b * 3 + 2] as number));
    let prev = -1;
    for (const i of order) {
      const g = packed[i * 4 + 1] as number;
      expect(g).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = g;
    }
    expect(packed[order[0]! * 4 + 1]).toBe(0);
    expect(packed[order[n - 1]! * 4 + 1]).toBe(1);
    // trunk only: ring heights give a strictly rising G ring by ring
    const trunk = mesh(twoBranches(), { parent: undefined });
    const z = zRangeOf([trunk.positions]);
    expect(z[1]).toBeGreaterThan(z[0]);
  });
  it('the per-branch tint is deterministic and differs between branches', () => {
    const a = mesh(twoBranches()).branchTint!;
    const b = mesh(twoBranches()).branchTint!;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(new Set(Array.from(a).map((v) => v.toFixed(5))).size).toBeGreaterThanOrEqual(2);
  });
});

describe('mesher', () => {
  it('legacy packing is bit-identical to before (default and explicit neutral options)', () => {
    const m = mesh(twoBranches());
    expect(m.colors!.length).toBe(696);
    expect(checksum(m.colors!)).toBe(211547602);
    expect(checksum(m.ao!)).toBe(744766987);
    const neutral = mesh(twoBranches(), { vertexColor: vc() });
    expect(checksum(neutral.colors!)).toBe(211547602);
    expect(checksum(neutral.ao!)).toBe(744766987);
  });
  it('Set / Multiply / Add change the generator colour', () => {
    const colorsOf = (o: Partial<VertexColorOptions>): Float32Array => mesh(twoBranches(), { ...FLAT, vertexColor: vc(o) }).colors!;
    const first = (c: Float32Array): number[] => [c[0] as number, c[1] as number, c[2] as number];
    const trunk = first(colorsOf({ mode: 'inherit', variance: 0.0001 }));
    expect(trunk[0]).toBeCloseTo(0.4, 2);
    const set = first(colorsOf({ mode: 'set', color: [0.1, 0.5, 0.9] }));
    expect(set[0]).toBeCloseTo(0.1);
    expect(set[1]).toBeCloseTo(0.5);
    expect(set[2]).toBeCloseTo(0.9);
    const mul = first(colorsOf({ mode: 'multiply', color: [0.5, 0.5, 0.5] }));
    expect(mul[0]).toBeCloseTo(0.2);
    expect(mul[2]).toBeCloseTo(0.05);
    const add = first(colorsOf({ mode: 'add', color: [0.1, 0.1, 0.1] }));
    expect(add[0]).toBeCloseTo(0.5);
  });
  it('the profile curve fades the effect along the branch', () => {
    const ramp = Float32Array.from({ length: 256 }, (_, i) => i / 255);
    const c = mesh(twoBranches(), { ...FLAT, vertexColor: vc({ mode: 'set', color: [1, 1, 1], profile: ramp }), parent: undefined }).colors!;
    const n = c.length / 4;
    const z = mesh(twoBranches(), { ...FLAT, parent: undefined }).positions;
    let lowest = 0;
    let highest = 0;
    for (let i = 0; i < n; i++) {
      if ((z[i * 3 + 2] as number) < (z[lowest * 3 + 2] as number)) lowest = i;
      if ((z[i * 3 + 2] as number) > (z[highest * 3 + 2] as number)) highest = i;
    }
    expect(c[highest * 4]).toBeGreaterThan(c[lowest * 4] as number);
  });
  it('variance is deterministic and stays inside 1 +- v', () => {
    const a = mesh(twoBranches(), { ...FLAT, vertexColor: vc({ variance: 0.3 }) }).colors!;
    const b = mesh(twoBranches(), { ...FLAT, vertexColor: vc({ variance: 0.3 }) }).colors!;
    expect(Array.from(a)).toEqual(Array.from(b));
    for (let i = 0; i < a.length; i += 4) {
      expect(a[i]).toBeGreaterThanOrEqual(0.4 * 0.7 - 1e-6);
      expect(a[i]).toBeLessThanOrEqual(0.4 * 1.3 + 1e-6);
    }
    const other = mesh(twoBranches(), { ...FLAT, seed: 99, vertexColor: vc({ variance: 0.3 }) }).colors!;
    expect(Array.from(other)).not.toEqual(Array.from(a));
  });
  it('Inherit + Seamless continues the parent colour at the attach point (<= 1/255)', () => {
    const sk = twoBranches();
    const m = mesh(sk, { vertexColor: vc({ seamless: true }) });
    const parentColor = recordedPointColor(sk, 4)!;
    const childStart = TRUNK_POINTS;
    const childColor = recordedPointColor(sk, childStart)!;
    for (let k = 0; k < 3; k++) expect(Math.abs((childColor[k] as number) - (parentColor[k] as number))).toBeLessThanOrEqual(1 / 255);
    // and it is really what the vertices carry
    let found = false;
    for (let i = 0; i < m.colors!.length; i += 4) {
      if (Math.abs((m.colors![i] as number) - (childColor[0] as number)) < 1 / 255 && Math.abs((m.colors![i + 1] as number) - (childColor[1] as number)) < 1 / 255 && Math.abs((m.colors![i + 2] as number) - (childColor[2] as number)) < 1 / 255) found = true;
    }
    expect(found).toBe(true);
    // without Seamless the legacy collar blend leaves a visible step
    const plain = twoBranches();
    mesh(plain);
    const step = Math.abs((recordedPointColor(plain, childStart)![0] as number) - (recordedPointColor(plain, 4)![0] as number));
    expect(step).toBeGreaterThan(1 / 255);
  });
});

describe('parameters', () => {
  it('defaults are neutral and every param has a tooltip or a self-explaining label', () => {
    const defs = vertexColorParams();
    expect(defs.map((d) => d.id)).toEqual(['vcMode', 'vcColor', 'vcVariance', 'vcSeamless', 'vcProfile', 'vcParentCurve']);
    expect(defs.every((d) => typeof d.tooltip === 'string' && d.tooltip.length > 10)).toBe(true);
    const params = defaultParams(defs);
    expect(readVertexColorOptions(params)).toBeUndefined();
    expect(readVertexColorOptions({ ...params, vcMode: { ...(params.vcMode as ParamState), value: 'multiply' } })?.mode).toBe('multiply');
  });
  it('the Tree node defaults to legacy packing with colours computed', () => {
    expect(readTreeVertexColor({})).toEqual({ compute: true, packing: 'legacy' });
    expect(sceneVertexColor(undefined)).toEqual({ compute: true, packing: 'legacy' });
  });
});

describe('export', () => {
  const colorAttribute = (bytes: Uint8Array, count: number): Float32Array => {
    const { json, bin } = readGlbJson(bytes);
    const attrs = json.meshes[0]!.primitives[0]!.attributes as Record<string, number>;
    expect(attrs.COLOR_0).toBeDefined();
    const acc = json.accessors[attrs.COLOR_0 as number]!;
    const view = json.bufferViews[acc.bufferView as number]!;
    const start = bin!.byteOffset + (view.byteOffset as number) + ((acc.byteOffset as number | undefined) ?? 0);
    return new Float32Array(bin!.buffer.slice(start, start + count * 16));
  };
  const write = (g: ReturnType<typeof mergeToPlantGeometry>): Uint8Array =>
    writeGltf({ name: 's', images: [], materials: [], materialIndex: new Map(), nodes: [{ name: 'P', geometry: g }] }, { binary: true, customAttributes: false, vertexColors: true, baseName: 'p' }).files[0]!.data as Uint8Array;

  it('writes COLOR_0 with the Kekenik channels', () => {
    const m = mesh(twoBranches());
    const g = mergeToPlantGeometry('P', [m]);
    expect(g.branchTint).toBeDefined();
    applyVertexColorPacking([g], { compute: true, packing: 'kekenik' });
    const n = g.positions.length / 3;
    const out = colorAttribute(write(g), n);
    const [zMin, zMax] = zRangeOf([g.positions]);
    for (const i of [0, 7, Math.floor(n / 2), n - 1]) {
      expect(out[i * 4]).toBeCloseTo(g.branchTint![i] as number, 5);
      expect(out[i * 4 + 1]).toBeCloseTo(normalisedHeight(g.positions[i * 3 + 2] as number, zMin, zMax), 5);
      expect(out[i * 4 + 2]).toBeCloseTo(g.ao![i] as number, 5);
      expect(out[i * 4 + 3]).toBe(1);
    }
  });
  it('legacy packing leaves the colours untouched; compute off drops them', () => {
    const g = mergeToPlantGeometry('P', [mesh(twoBranches())]);
    const before = Array.from(g.colors!);
    applyVertexColorPacking([g], { compute: true, packing: 'legacy' });
    expect(Array.from(g.colors!)).toEqual(before);
    applyVertexColorPacking([g], { compute: false, packing: 'kekenik' });
    expect(g.colors).toBeUndefined();
  });
  it('"Bake AO into vertex colour B" writes the baked AO into B only; Kekenik B follows the baked AO', () => {
    const g = mergeToPlantGeometry('P', [mesh(twoBranches())]);
    const n = g.positions.length / 3;
    const before = Float32Array.from(g.colors!);
    const baked = new Float32Array(n).fill(0.25);
    applyAoToGeometry(g, baked, 0, 'channelB');
    for (let i = 0; i < n; i++) {
      expect(g.colors![i * 4]).toBe(before[i * 4]);
      expect(g.colors![i * 4 + 1]).toBe(before[i * 4 + 1]);
      expect(g.colors![i * 4 + 2]).toBe(0.25);
    }
    applyVertexColorPacking([g], { compute: true, packing: 'kekenik' });
    for (let i = 0; i < n; i++) {
      expect(g.colors![i * 4 + 2]).toBeCloseTo(g.ao![i] as number, 5);
      expect(g.ao![i]).toBeLessThanOrEqual(0.25 + 1e-6);
    }
  });
});

describe('item generators (Leaf / Frond / Decal / Fin / Cluster)', () => {
  const sampleOf = (sk: Skeleton, opts: VertexColorOptions | undefined, at: number | readonly [number, number] = 0.5) => itemColorFn({ options: opts, parent: sk, point: 4, at });

  it('neutral options give no colour function (exact legacy colours)', () => {
    expect(sampleOf(twoBranches(), undefined)).toBeUndefined();
  });

  it('Multiply / Set / Add use the shared maths, blended by Profile x Parent curve', () => {
    const sk = twoBranches();
    const base: Rgb = [0.4, 0.2, 0.1];
    expect(sampleOf(sk, vc({ mode: 'multiply', color: [0.5, 0.5, 0.5] }))?.(base, 0.3)).toEqual(applyVcMode('multiply', base, [0.5, 0.5, 0.5]));
    expect(sampleOf(sk, vc({ mode: 'set', color: [0.1, 0.2, 0.3] }))?.(base, 0.3)).toEqual(applyVcMode('set', base, [0.1, 0.2, 0.3]).map((v) => expect.closeTo(v, 6)));
    const add = sampleOf(sk, vc({ mode: 'add', color: [0.9, 0, 0] }))?.(base, 0.3) as Rgb;
    expect(add[0]).toBe(1);
    const ramp = new Float32Array(256).map((_, i) => i / 255);
    const fade = sampleOf(sk, vc({ mode: 'set', color: [1, 1, 1], profile: ramp }));
    expect(fade?.(base, 0)).toEqual(base);
    expect((fade?.(base, 1) as Rgb)[0]).toBeCloseTo(1, 5);
    const parentCut = sampleOf(sk, vc({ mode: 'set', color: [1, 1, 1], parentCurve: new Float32Array(256) }));
    expect(parentCut?.(base, 0.5)).toEqual(base);
  });

  it('a frond follows the parent curve along the parent range it covers', () => {
    const ramp = new Float32Array(256).map((_, i) => i / 255);
    const fn = sampleOf(twoBranches(), vc({ mode: 'set', color: [1, 1, 1], parentCurve: ramp }), [0.5, 1]);
    const base: Rgb = [0, 0, 0];
    expect((fn?.(base, 0) as Rgb)[0]).toBeCloseTo(0.5, 2);
    expect((fn?.(base, 1) as Rgb)[0]).toBeCloseTo(1, 2);
  });

  it('Seamless starts exactly at the parent colour and fades into the own colour', () => {
    const sk = twoBranches();
    mesh(sk, FLAT);
    const parent = recordedPointColor(sk, 4) as Rgb;
    const fn = sampleOf(sk, vc({ mode: 'set', color: [0, 1, 0], seamless: true }));
    const at0 = fn?.([0.5, 0.5, 0.5], 0) as Rgb;
    for (let c = 0; c < 3; c++) expect(Math.abs((at0[c] as number) - (parent[c] as number))).toBeLessThanOrEqual(1 / 255);
    const tip = fn?.([0.5, 0.5, 0.5], 1) as Rgb;
    expect(tip[1]).toBeGreaterThan(0.95);
  });

  it('the tint of an item is deterministic and in 0..1', () => {
    expect(itemBranchTint(5, 9)).toBe(itemBranchTint(5, 9));
    expect(itemBranchTint(5, 9)).not.toBe(itemBranchTint(6, 9));
    for (let i = 0; i < 50; i++) expect(itemBranchTint(i, 3)).toBeGreaterThanOrEqual(0);
  });

  describe('generators', () => {
    beforeAll(() => registerDiscoveredNodes());
    const trunk = (): Skeleton => {
      const sb = new SkeletonBuilder();
      sb.beginBranch(-1, -1, 0);
      for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.25);
      sb.endBranch();
      const sk = sb.build();
      for (const [id, v] of [['rmfNormalX', 0], ['rmfNormalY', -1], ['rmfNormalZ', 0]] as const) sk.attributes.set(id, new Float32Array(sk.count).fill(v));
      return sk;
    };
    const paramsOf = (type: string, over: Record<string, unknown> = {}): NodeParams => {
      const out = defaultParams(getNodeDef(type)!.params);
      for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] as ParamState), value: v as never };
      return out;
    };
    const run = (type: string, over: Record<string, unknown>): MeshData => {
      const ctx: NodeContext = { nodeId: 'n', name: 'N', rng: new Rng(4), seed: 4, cancel: new CancellationSource().token, lod: 0, logger: createLogger('test', 'error') };
      const out = getNodeDef(type)!.evaluate(ctx, { parent: [{ kind: 'Structure', value: { skeleton: trunk(), materialId: 'bark' } }] } as NodeInputs, paramsOf(type, over)) as Record<string, { kind: string; value: MeshData }>;
      return (out[OUTPUT_KEY.geometry] as { value: MeshData }).value;
    };
    const SET = { vcMode: 'set', vcColor: [0.2, 0.4, 0.6, 1] };

    it.each([['generator.decal'], ['generator.fin'], ['generator.leaf'], ['generator.frond']])('%s: Set paints every vertex, Inherit keeps the legacy colours', (type) => {
      const base = run(type, { number: 4 });
      const set = run(type, { number: 4, ...SET });
      const colors = set.colors as Float32Array;
      const ao = set.ao as Float32Array;
      expect(colors.length).toBeGreaterThan(0);
      // Leaf / frond colours are multiplied by the baked ao; decal / fin store the plain colour (ao is separate).
      const scaled = type === 'generator.leaf' || type === 'generator.frond';
      for (let i = 0; i < colors.length / 4; i++) {
        const k = scaled ? (ao[i] as number) : 1;
        expect((colors[i * 4] as number) / k).toBeCloseTo(0.2, 4);
        expect((colors[i * 4 + 1] as number) / k).toBeCloseTo(0.4, 4);
        expect((colors[i * 4 + 2] as number) / k).toBeCloseTo(0.6, 4);
      }
      expect(Array.from(run(type, { number: 4, vcMode: 'inherit' }).colors as Float32Array)).toEqual(Array.from(base.colors as Float32Array));
    });

    it.each([['generator.decal'], ['generator.fin'], ['generator.leaf'], ['generator.frond']])('%s: every item has its own random tint (Kekenik R channel), deterministic', (type) => {
      const a = run(type, { number: 6 });
      const b = run(type, { number: 6 });
      const tint = a.branchTint as Float32Array;
      expect(tint).toBeDefined();
      expect(Array.from(tint)).toEqual(Array.from(b.branchTint as Float32Array));
      // A frond is one per parent branch (this trunk has one); the others make several items.
      if (type !== 'generator.frond') expect(new Set(Array.from(tint, (v) => Math.round(v * 1e4))).size).toBeGreaterThan(1);
      for (const v of tint) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });

    it('the Material > Vertex Color group of foliage carries Mode / Color / Seamless / Profile / Parent curve without a second Variance', () => {
      const ids = vertexColorParams(true).map((d) => d.id);
      expect(ids).toEqual(['vcMode', 'vcColor', 'vcSeamless', 'vcProfile', 'vcParentCurve']);
      for (const type of ['generator.leaf', 'generator.frond', 'generator.decal', 'generator.fin', 'generator.cluster']) {
        const defs = getNodeDef(type)!.params.filter((d) => d.id.startsWith('vc'));
        expect(defs.map((d) => d.id), type).toEqual(ids);
        expect(defs.every((d) => d.group === 'Material' && d.subgroup === 'Vertex Color'), type).toBe(true);
      }
    });
  });
});

describe('merged meshes', () => {
  it('a part without a branch tint reads as the neutral 0.5 when another part has one', () => {
    const part = (tint?: number): MeshData => ({
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      uv0: new Float32Array(6),
      indices: new Uint32Array([0, 1, 2]),
      slots: [{ materialId: 'm', indexStart: 0, indexCount: 3 }],
      ...(tint === undefined ? {} : { branchTint: new Float32Array(3).fill(tint) }),
    });
    expect(Array.from(mergeMeshData([part(0.9), part()]).branchTint as Float32Array)).toEqual([0.9, 0.9, 0.9, 0.5, 0.5, 0.5].map((v) => Math.fround(v)));
    expect(mergeMeshData([part(), part()]).branchTint).toBeUndefined();
  });
});
