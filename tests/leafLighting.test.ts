import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { NEUTRAL_LEAF_LIGHTING, type LeafLightingSettings } from '@/contracts/lighting';
import type { MeshData } from '@/contracts/mesh';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { iconMarkup } from '@/ui/icons/icons';
import '@/ui/icons/nodeIcons';
import { mergeByMaterial, partAtTriangle, partRowOfKey, sourceKeyAtTriangle, type LeafSpan } from '@/geometry/batchedLeaf';
import {
  applyLeafLighting,
  isLightingActive,
  resolveAdjust,
  resolveLightAnchor,
  shiftAnchor,
  surfaceDirection,
  type LightingGroup,
} from '@/geometry/leafLighting';
import { buildLeafMesh, FULL_ATLAS, type LeafCard } from '@/geometry/leafMesher';
import type { V3 } from '@/geometry/math3';
import { GLOBAL_PREFIX, LIGHTING_STYLE_ID, readLeafLighting, resolveLeafLighting } from '../src/nodes/generators/leafLightingParams';
import { placementFromTreeParams } from '../src/nodes/output';

beforeAll(() => registerDiscoveredNodes());

const settings = (over: Partial<LeafLightingSettings> = {}): LeafLightingSettings => ({ ...NEUTRAL_LEAF_LIGHTING, ...over });
const unit = (v: ArrayLike<number>, o = 0): V3 => {
  const l = Math.hypot(v[o] as number, v[o + 1] as number, v[o + 2] as number);
  return [(v[o] as number) / l, (v[o + 1] as number) / l, (v[o + 2] as number) / l];
};
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-5): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(eps);
};

/** A bent leaf card (4 length x 2 width segments) built by the real mesher, one lighting group. */
function card(over: Partial<LeafCard> = {}): LeafCard {
  return {
    origin: [0, 0, 0],
    axis: [0, 1, 0],
    side: [1, 0, 0],
    length: 1,
    width: 0.6,
    bend: 1,
    fold: 0.4,
    curl: 0,
    twist: 0,
    segLength: 4,
    segWidth: 2,
    outline: 'rect',
    color: [1, 1, 1],
    ao: 1,
    atlas: FULL_ATLAS,
    materialId: 'leaf',
    pivot: [0, 0, 0],
    wind: [0, 0, 0, 0],
    ...over,
  };
}

function groupOf(mesh: MeshData, over: Partial<LightingGroup> = {}): LightingGroup {
  return {
    vertexStart: 0,
    vertexCount: mesh.positions.length / 3,
    indexStart: 0,
    indexCount: mesh.indices.length,
    anchor: null,
    surface: null,
    frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
    adjust: [0, 0, 0],
    ...over,
  };
}

const bentMesh = (): MeshData => buildLeafMesh([card()], { defaultMaterial: 'leaf' });

describe('applyLeafLighting', () => {
  it('Smooth = 0 (and every other option neutral) keeps the normals bit for bit', () => {
    const mesh = bentMesh();
    const before = Float32Array.from(mesh.normals);
    expect(isLightingActive(settings({ smooth: 0 }))).toBe(false);
    expect(applyLeafLighting(mesh, settings({ smooth: 0 }), { groups: [groupOf(mesh)] })).toBe(0);
    expect(Array.from(mesh.normals)).toEqual(Array.from(before));
  });

  it('Smooth = 1 replaces corrupted normals with the face-averaged ones, on the side of the original', () => {
    const mesh = bentMesh();
    const clean = Float32Array.from(mesh.normals);
    for (let i = 0; i < mesh.normals.length; i += 3) {
      mesh.normals[i] = 0.2;
      mesh.normals[i + 1] = 0.2;
      mesh.normals[i + 2] = 1;
    }
    applyLeafLighting(mesh, settings({ smooth: 1 }), { groups: [groupOf(mesh)] });
    for (let i = 0; i < mesh.normals.length / 3; i++) {
      const n = unit(mesh.normals, i * 3);
      expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
      // Same hemisphere as the geometric normal of the clean card.
      expect(n[0] * (clean[i * 3] as number) + n[1] * (clean[i * 3 + 1] as number) + n[2] * (clean[i * 3 + 2] as number)).toBeGreaterThan(0.5);
    }
    // A half blend lies between the two.
    const half = bentMesh();
    for (let i = 0; i < half.normals.length; i += 3) {
      half.normals[i] = 0;
      half.normals[i + 1] = 0;
      half.normals[i + 2] = 1;
    }
    const orig = Float32Array.from(half.normals);
    applyLeafLighting(half, settings({ smooth: 0.5 }), { groups: [groupOf(half)] });
    expect(Array.from(half.normals)).not.toEqual(Array.from(orig));
  });

  it('Unify = 1 turns all normals of a leaf into one direction (their average)', () => {
    const mesh = bentMesh();
    const sum: V3 = [0, 0, 0];
    for (let i = 0; i < mesh.normals.length; i += 3) for (let k = 0; k < 3; k++) sum[k] = (sum[k] as number) + (mesh.normals[i + k] as number);
    const avg = unit(sum);
    applyLeafLighting(mesh, settings({ unify: 1 }), { groups: [groupOf(mesh)] });
    for (let i = 0; i < mesh.normals.length / 3; i++) close(unit(mesh.normals, i * 3), avg);
  });

  it('Unify is ignored when the generator has no such option (allowUnify: false)', () => {
    const mesh = bentMesh();
    const before = Float32Array.from(mesh.normals);
    expect(applyLeafLighting(mesh, settings({ unify: 1 }), { groups: [groupOf(mesh)], allowUnify: false })).toBe(0);
    expect(Array.from(mesh.normals)).toEqual(Array.from(before));
  });

  it('World up = 1 forces every normal up and overrides puffiness and the adjustments', () => {
    const mesh = bentMesh();
    const g = groupOf(mesh, { adjust: [1, 0.5, 2], anchor: [0, 0, -1] });
    applyLeafLighting(mesh, settings({ worldUp: 1, puffiness: 1, parentAmount: 1, parentAnchor: 'global', unify: 0.5, smooth: 1 }), { groups: [g] });
    for (let i = 0; i < mesh.normals.length / 3; i++) close(unit(mesh.normals, i * 3), [0, 0, 1]);
    const off = bentMesh();
    expect(applyLeafLighting(off, settings({ worldUp: 1 }), { groups: [groupOf(off)], allowWorldUp: false })).toBe(0);
  });

  it('Parent puffiness = 1 points every normal away from the anchor through its vertex', () => {
    const mesh = bentMesh();
    const anchor: V3 = [0.3, -1, 0.2];
    applyLeafLighting(mesh, settings({ parentAmount: 1, parentAnchor: 'global' }), { groups: [groupOf(mesh, { anchor })] });
    for (let i = 0; i < mesh.normals.length / 3; i++) {
      const d: V3 = [(mesh.positions[i * 3] as number) - anchor[0], (mesh.positions[i * 3 + 1] as number) - anchor[1], (mesh.positions[i * 3 + 2] as number) - anchor[2]];
      close(unit(mesh.normals, i * 3), unit(d));
    }
  });

  it('Parent puffiness Surface axes align every normal with the given parent axis', () => {
    const mesh = bentMesh();
    applyLeafLighting(mesh, settings({ parentAmount: 1, parentAnchor: 'surface-y' }), { groups: [groupOf(mesh, { surface: [0, 1, 0] })] });
    for (let i = 0; i < mesh.normals.length / 3; i++) close(unit(mesh.normals, i * 3), [0, 1, 0]);
    expect(surfaceDirection('surface-x', { normal: [1, 0, 0], binormal: [0, 1, 0], tangent: [0, 0, 1] })).toEqual([1, 0, 0]);
    expect(surfaceDirection('surface-z', { normal: [1, 0, 0], binormal: [0, 1, 0], tangent: [0, 0, 1] })).toEqual([0, 0, 1]);
    expect(surfaceDirection('global', { normal: [1, 0, 0], binormal: [0, 1, 0], tangent: [0, 0, 1] })).toBeNull();
  });

  it('Puffiness = 1 spherizes the normals around the centre of the leaf', () => {
    const mesh = bentMesh();
    applyLeafLighting(mesh, settings({ puffiness: 1 }), { groups: [groupOf(mesh)] });
    const c: V3 = [0, 0, 0];
    const n = mesh.positions.length / 3;
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) c[k] = (c[k] as number) + (mesh.positions[i * 3 + k] as number) / n;
    for (let i = 0; i < n; i++) {
      const d: V3 = [(mesh.positions[i * 3] as number) - c[0], (mesh.positions[i * 3 + 1] as number) - c[1], (mesh.positions[i * 3 + 2] as number) - c[2]];
      if (Math.hypot(d[0], d[1], d[2]) > 1e-6) close(unit(mesh.normals, i * 3), unit(d));
    }
  });

  it('Adjustments rotate the normals about the leaf axes, never the geometry', () => {
    const flat = buildLeafMesh([card({ bend: 0, fold: 0 })], { defaultMaterial: 'leaf' });
    const positions = Float32Array.from(flat.positions);
    const before = unit(flat.normals, 0);
    applyLeafLighting(flat, settings({ up: 90 }), { groups: [groupOf(flat, { adjust: [Math.PI / 2, 0, 0] })] });
    expect(Array.from(flat.positions)).toEqual(Array.from(positions));
    const after = unit(flat.normals, 0);
    expect(Math.abs(before[0] * after[0] + before[1] * after[1] + before[2] * after[2])).toBeLessThan(1e-5);
    expect(after[0]).toBeCloseTo(0, 5);
  });

  it('keeps tangents perpendicular to the edited normals', () => {
    const mesh = bentMesh();
    applyLeafLighting(mesh, settings({ puffiness: 1, worldUp: 0.4 }), { groups: [groupOf(mesh)] });
    const t = mesh.tangents as Float32Array;
    for (let i = 0; i < mesh.normals.length / 3; i++) {
      const d = (t[i * 4] as number) * (mesh.normals[i * 3] as number) + (t[i * 4 + 1] as number) * (mesh.normals[i * 3 + 1] as number) + (t[i * 4 + 2] as number) * (mesh.normals[i * 3 + 2] as number);
      expect(Math.abs(d)).toBeLessThan(1e-4);
    }
  });

  it('lights each group on its own (the second leaf keeps its normals)', () => {
    const mesh = buildLeafMesh([card({ origin: [0, 0, 0] }), card({ origin: [5, 0, 0] })], { defaultMaterial: 'leaf' });
    const half = mesh.positions.length / 6;
    const g0 = groupOf(mesh, { vertexCount: half, indexCount: mesh.indices.length / 2 });
    const tail = Float32Array.from(mesh.normals.subarray(half * 3));
    applyLeafLighting(mesh, settings({ worldUp: 1 }), { groups: [g0] });
    expect(Array.from(mesh.normals.subarray(half * 3))).toEqual(Array.from(tail));
  });
});

describe('lighting helpers', () => {
  it('anchor shift only works when Amount > 0 and moves straight up', () => {
    expect(shiftAnchor([1, 2, 3], 1, 0)).toEqual([1, 2, 3]);
    expect(shiftAnchor([1, 2, 3], 0.5, 4)).toEqual([1, 2, 5]);
    expect(shiftAnchor([1, 2, 3], 5, 4)).toEqual([1, 2, 7]);
  });

  it('resolves Global / Deep / Intermediate / Local from the chain and Height as the ground below the Global ancestor', () => {
    const pts: Record<string, V3> = { global: [1, 1, 5], deep: [2, 2, 4], intermediate: [3, 3, 3], local: [4, 4, 2] };
    const chain = (s: string): V3 | null => pts[s] ?? null;
    const base = { anchorPosition: 0, anchorAmount: 0 };
    for (const style of ['global', 'deep', 'intermediate', 'local'] as const) expect(resolveLightAnchor({ parentAnchor: style, ...base }, chain, [9, 9, 9])).toEqual(pts[style]);
    expect(resolveLightAnchor({ parentAnchor: 'height', ...base }, chain, [9, 9, 9])).toEqual([1, 1, 0]);
    expect(resolveLightAnchor({ parentAnchor: 'height', anchorPosition: 0.5, anchorAmount: 2 }, chain, [9, 9, 9])).toEqual([1, 1, 1]);
    expect(resolveLightAnchor({ parentAnchor: 'height', ...base }, () => null, [9, 8, 7])).toEqual([9, 8, 0]);
    expect(resolveLightAnchor({ parentAnchor: 'none', ...base }, chain, [0, 0, 0])).toBeNull();
    expect(resolveLightAnchor({ parentAnchor: 'surface-x', ...base }, chain, [0, 0, 0])).toBeNull();
    expect(resolveLightAnchor({ parentAnchor: 'local', ...base }, () => null, [0, 0, 0])).toBeNull();
  });

  it('Up / Right / Out variance is deterministic with the seeded stream and stays inside its range', () => {
    const s = settings({ up: 20, upVariance: 0.5, right: 0, rightVariance: 0.2, out: 10 });
    const a = resolveAdjust(s, ((r) => () => r.next())(new Rng(5)));
    const b = resolveAdjust(s, ((r) => () => r.next())(new Rng(5)));
    expect(a).toEqual(b);
    expect(Math.abs(a[0] * (180 / Math.PI) - 20)).toBeLessThanOrEqual(10 + 1e-9);
    expect(Math.abs(a[1] * (180 / Math.PI))).toBeLessThanOrEqual(0.2 * 45 + 1e-9);
    expect(a[2]).toBeCloseTo((10 * Math.PI) / 180, 9);
    const seen = new Set<number>();
    for (let i = 0; i < 6; i++) seen.add(resolveAdjust(s, ((r) => () => r.next())(new Rng(i)))[0]);
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('lighting params', () => {
  it('Local params are read from the leaf, Global params from the tree group, with the same fields', () => {
    const tree = getNodeDef('output.tree');
    const leaf = getNodeDef('generator.leaf');
    if (!tree || !leaf) throw new Error('nodes missing');
    const names = ['Smooth', 'ParentAmount', 'ParentAnchor', 'AnchorPosition', 'AnchorAmount', 'Puffiness', 'Unify', 'Up', 'Right', 'Out', 'WorldUp'];
    for (const n of names) {
      expect(tree.params.some((d) => d.id === `${GLOBAL_PREFIX}${n}` && d.group === 'Lighting')).toBe(true);
      expect(leaf.params.some((d) => d.id === `light${n}` && d.group === 'Lighting')).toBe(true);
    }
    const up = leaf.params.find((d) => d.id === 'lightUp');
    expect(up?.variance).toBeDefined();
    const p: NodeParams = {};
    for (const d of tree.params) p[d.id] = defaultParamState(d);
    p[`${GLOBAL_PREFIX}Smooth`] = { value: 0.7 };
    p[`${GLOBAL_PREFIX}ParentAnchor`] = { value: 'surface-z' };
    const s = readLeafLighting(p, GLOBAL_PREFIX);
    expect(s.smooth).toBe(0.7);
    expect(s.parentAnchor).toBe('surface-z');
    expect(placementFromTreeParams(p).radius).toBeGreaterThan(0);
  });

  it('Style Global reads the tree settings, Local the leaf ones; garbage anchors fall back to None', () => {
    const global = settings({ puffiness: 0.4 });
    const p: NodeParams = { [LIGHTING_STYLE_ID]: { value: 'global' }, lightPuffiness: { value: 0.9 } };
    expect(resolveLeafLighting(p, global).puffiness).toBe(0.4);
    expect(resolveLeafLighting(p, undefined).puffiness).toBe(0);
    p[LIGHTING_STYLE_ID] = { value: 'local' };
    expect(resolveLeafLighting(p, global).puffiness).toBe(0.9);
    p.lightParentAnchor = { value: 'bogus' };
    expect(readLeafLighting(p, 'light').parentAnchor).toBe('none');
    expect(resolveLeafLighting({ [LIGHTING_STYLE_ID]: { value: 'global' } }, settings({ unify: 1, worldUp: 1, smooth: 0.2 }), true)).toMatchObject({ unify: 0, worldUp: 0, smooth: 0.2 });
  });
});

/* ------------------------------------------------------------------------------ node level */

function stem(): ReturnType<SkeletonBuilder['build']> {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.03);
  sb.endBranch();
  return sb.build();
}

interface RunResult {
  mesh: MeshData;
  branches: number;
}

function run(type: string, over: Record<string, unknown> = {}, opts: { lod?: number; lighting?: LeafLightingSettings; variance?: Record<string, number> } = {}): RunResult {
  const def = getNodeDef(type);
  if (!def) throw new Error(`${type} missing`);
  const p: NodeParams = {};
  for (const d of def.params) p[d.id] = defaultParamState(d);
  for (const [k, v] of Object.entries({ number: 6, first: 0.2, last: 1, leavesPerNode: 2, ...over })) p[k] = { ...(p[k] as NodeParams[string] ?? { value: 0 }), value: v as never, variance: 0 };
  for (const [k, v] of Object.entries(opts.variance ?? {})) p[k] = { ...(p[k] as NodeParams[string]), variance: v };
  const ctx: NodeContext = { nodeId: type, name: type, rng: new Rng(3), seed: 3, cancel: new CancellationSource().token, lod: opts.lod ?? 0, logger: createLogger('dev', 'error') };
  const inputs: NodeInputs = { parent: [{ kind: 'Structure', value: { skeleton: stem(), ...(opts.lighting ? { lighting: opts.lighting } : {}) } }] };
  const out = def.evaluate(ctx, inputs, p) as Record<string, { value: unknown }>;
  const children = out.children?.value as { skeleton: { branches: unknown[] } };
  return { mesh: out.geometry?.value as MeshData, branches: children.skeleton.branches.length };
}

describe('Leaf lighting through the node', () => {
  it('Local World up = 1 makes every normal point up; Global style without tree settings changes nothing', () => {
    const base = run('generator.leaf');
    const none = run('generator.leaf', { [LIGHTING_STYLE_ID]: 'global' });
    expect(Array.from(none.mesh.normals)).toEqual(Array.from(base.mesh.normals));
    const up = run('generator.leaf', { [LIGHTING_STYLE_ID]: 'local', lightWorldUp: 1 });
    expect(up.mesh.normals.length).toBeGreaterThan(0);
    for (let i = 0; i < up.mesh.normals.length / 3; i++) close(unit(up.mesh.normals, i * 3), [0, 0, 1]);
    expect(Array.from(up.mesh.positions)).toEqual(Array.from(base.mesh.positions));
  });

  it('Global style reads the lighting handed down from the Tree node', () => {
    const viaTree = run('generator.leaf', {}, { lighting: settings({ worldUp: 1 }) });
    for (let i = 0; i < viaTree.mesh.normals.length / 3; i++) close(unit(viaTree.mesh.normals, i * 3), [0, 0, 1]);
    const localWins = run('generator.leaf', { [LIGHTING_STYLE_ID]: 'local' }, { lighting: settings({ worldUp: 1 }) });
    const base = run('generator.leaf', { [LIGHTING_STYLE_ID]: 'local' });
    expect(Array.from(localWins.mesh.normals)).toEqual(Array.from(base.mesh.normals));
  });

  it('is deterministic, and Up variance jumbles the leaves', () => {
    const over = { [LIGHTING_STYLE_ID]: 'local', lightUp: 30 };
    const a = run('generator.leaf', over, { variance: { lightUp: 0.8 } });
    const b = run('generator.leaf', over, { variance: { lightUp: 0.8 } });
    expect(Array.from(a.mesh.normals)).toEqual(Array.from(b.mesh.normals));
    const flat = run('generator.leaf', over);
    expect(Array.from(a.mesh.normals)).not.toEqual(Array.from(flat.mesh.normals));
    // Without variance every leaf gets the same rotation about its own axis: the normals stay unit length.
    for (let i = 0; i < a.mesh.normals.length / 3; i++) expect(Math.hypot(...unit(a.mesh.normals, i * 3))).toBeCloseTo(1, 5);
  });
});

describe('Batched leaf', () => {
  it('is registered as a generator with the leaf colour and its own registered icon', () => {
    const def = getNodeDef('generator.batchedLeaf');
    expect(def).toBeDefined();
    expect(def?.category).toBe('generator');
    expect(def?.icon).toBe('nodeBatchedLeaf');
    expect(def?.label).toBe('Batched Leaf');
    expect(iconMarkup('nodeBatchedLeaf')).toBeTruthy();
    expect(def?.ports.some((p) => p.id === 'parent')).toBe(true);
  });

  it('shares the leaf groups but has no Mesh LOD offset, vertex-noise Seed, Unify or World up', () => {
    const leaf = getNodeDef('generator.leaf')?.params.map((d) => d.id) ?? [];
    const batched = getNodeDef('generator.batchedLeaf')?.params.map((d) => d.id) ?? [];
    for (const id of ['resMeshLodOffset', 'vertexSeed', 'lightUnify', 'lightWorldUp']) {
      expect(leaf).toContain(id);
      expect(batched).not.toContain(id);
    }
    for (const id of ['leafSize', 'leafWeld', 'orientSky', 'finalUp', 'deformFold', 'vertexAmount', 'resMeshLod', 'lightSmooth', 'lightPuffiness', 'lightUp', 'lightParentAnchor', 'number', 'first', 'last']) {
      expect(batched).toContain(id);
    }
    expect(batched.length).toBe(leaf.length - 4);
  });

  it('merges all leaves of a material into one slot, keeps the vertex count and builds the index table', () => {
    const leaf = run('generator.leaf', { cardCount: 2 });
    const batched = run('generator.batchedLeaf', { cardCount: 2 });
    expect(batched.mesh.positions.length).toBe(leaf.mesh.positions.length);
    expect(batched.mesh.indices.length).toBe(leaf.mesh.indices.length);
    const mats = new Set(batched.mesh.slots.map((s) => s.materialId));
    expect(batched.mesh.slots.length).toBe(mats.size);
    const parts = batched.mesh.parts;
    expect(parts).toBeDefined();
    if (!parts) return;
    expect(parts.count).toBe(batched.branches);
    let verts = 0;
    for (let i = 0; i < parts.count; i++) {
      verts += parts.vertexCount[i] as number;
      if (i > 0) expect(parts.indexStart[i] as number).toBeGreaterThanOrEqual((parts.indexStart[i - 1] as number) + (parts.indexCount[i - 1] as number));
      expect(partAtTriangle(parts, (parts.indexStart[i] as number) / 3)).toBe(i);
      expect(sourceKeyAtTriangle(parts, (parts.indexStart[i] as number) / 3)).toBe(parts.key[i]);
      expect(partRowOfKey(parts, parts.key[i] as number)).toBeGreaterThanOrEqual(0);
    }
    expect(verts).toBe(batched.mesh.positions.length / 3);
    expect(new Set(Array.from(parts.key)).size).toBe(parts.count);
    expect(leaf.mesh.parts).toBeUndefined();
  });

  it('ignores Unify / World up (also from the Tree) and the viewport LOD', () => {
    const calm = run('generator.batchedLeaf');
    const up = run('generator.batchedLeaf', {}, { lighting: settings({ worldUp: 1, unify: 1 }) });
    expect(Array.from(up.mesh.normals)).toEqual(Array.from(calm.mesh.normals));
    const puffed = run('generator.batchedLeaf', {}, { lighting: settings({ puffiness: 1 }) });
    expect(Array.from(puffed.mesh.normals)).not.toEqual(Array.from(calm.mesh.normals));
    const low = run('generator.batchedLeaf', {}, { lod: 3 });
    expect(low.mesh.positions.length).toBe(calm.mesh.positions.length);
    expect(Array.from(low.mesh.positions)).toEqual(Array.from(calm.mesh.positions));
    expect(run('generator.batchedLeaf', {}, { lod: 0 }).mesh.indices.length).toBe(calm.mesh.indices.length);
  });
});

describe('mergeByMaterial', () => {
  function interleaved(): { mesh: MeshData; spans: LeafSpan[] } {
    // Three single-triangle leaves (A, B, A) emitted in leaf order, one slot per leaf.
    const positions = new Float32Array(27);
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const mesh: MeshData = {
      positions,
      normals: new Float32Array(27),
      uv0: new Float32Array(18),
      indices,
      slots: [
        { materialId: 'A', indexStart: 0, indexCount: 3 },
        { materialId: 'B', indexStart: 3, indexCount: 3 },
        { materialId: 'A', indexStart: 6, indexCount: 3 },
      ],
    };
    const span = (i: number, materialId: string): LeafSpan => ({ key: 100 + i, branch: i, materialId, vertexStart: i * 3, vertexCount: 3, indexStart: i * 3, indexCount: 3 });
    return { mesh, spans: [span(0, 'A'), span(1, 'B'), span(2, 'A')] };
  }

  it('groups per material, preserves vertices and triangle content, and resolves triangles to leaves', () => {
    const { mesh, spans } = interleaved();
    const merged = mergeByMaterial(mesh, spans);
    expect(merged.positions).toBe(mesh.positions);
    expect(merged.slots).toEqual([
      { materialId: 'A', indexStart: 0, indexCount: 6 },
      { materialId: 'B', indexStart: 6, indexCount: 3 },
    ]);
    expect(Array.from(merged.indices)).toEqual([0, 1, 2, 6, 7, 8, 3, 4, 5]);
    const t = merged.parts;
    expect(t?.count).toBe(3);
    if (!t) return;
    expect(Array.from(t.key)).toEqual([100, 102, 101]);
    expect(Array.from(t.branch)).toEqual([0, 2, 1]);
    expect(Array.from(t.slot)).toEqual([0, 0, 1]);
    expect([0, 1, 2].map((tri) => sourceKeyAtTriangle(t, tri))).toEqual([100, 102, 101]);
    expect(sourceKeyAtTriangle(t, 3)).toBeNull();
    expect(sourceKeyAtTriangle(undefined, 0)).toBeNull();
    expect(partRowOfKey(t, 999)).toBe(-1);
  });

  it('drops empty spans and returns an empty table for no spans', () => {
    const { mesh } = interleaved();
    const none = mergeByMaterial(mesh, []);
    expect(none.indices.length).toBe(0);
    expect(none.slots).toEqual([]);
    expect(none.parts?.count).toBe(0);
  });
});
