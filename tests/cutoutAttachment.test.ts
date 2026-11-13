import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { attachmentFramesOf, findAttachmentByBranch } from '@/geometry/attachments';
import { composeFrame, frameToMat, matToFrame, rigidInverse, mat4Mul } from '@/geometry/rigid';
import { cardPointAt } from '@/geometry/cardPose';
import type { V3 } from '@/geometry/math3';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import type { CutoutMesh } from '@/contracts/material';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import {
  anchorFrameInPose,
  attachmentWarnings,
  buildCutoutFrame,
  cardPoseFor,
  defaultAxisFor,
  ensureCutoutAttachmentData,
  flipSigns,
  uvToLocal,
} from '@/materials/cutouts/frame';
import { createDefaultCutoutMesh, linearizeStraighten, resetStraighten } from '@/materials/cutouts/ops';
import { rebuildCutoutLods } from '@/materials/cutouts/lod';
import { setMaterialSource } from '@/materials/materialSource';
import { instanceKey } from '@/instances/keys';

beforeAll(() => registerDiscoveredNodes());
afterEach(() => setMaterialSource(null));

type P2 = [number, number];

/** Diamond with a vertex exactly on the axis base (0.5, 0) and one on every authored anchor. */
function cutout(id: string, over: Partial<CutoutMesh> = {}, anchors: { uv: P2; handle: P2 }[] = []): CutoutMesh {
  const c = createDefaultCutoutMesh(id, id, 'leaf');
  c.outline = [[0.5, 0], [1, 0.4], [0.5, 1], [0, 0.4]];
  c.interiorPoints = anchors.map((a) => a.uv);
  c.straightenAxis = [[0.5, 0], [0.5, 1]];
  c.anchors = anchors.map((a, i) => ({ id: `${id}_a${i}`, uv: a.uv, handleUv: a.handle }));
  Object.assign(c, over);
  rebuildCutoutLods(c);
  ensureCutoutAttachmentData(c);
  return c;
}

function stem(dir: V3 = [0, 0, 1]): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(dir[0] * i * 0.5, dir[1] * i * 0.5, dir[2] * i * 0.5, 0.02);
  sb.endBranch();
  return sb.build();
}

const ctx = (nodeId: string, seed = 7): NodeContext => ({ nodeId, name: nodeId, rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod: 0, logger: createLogger('test', 'error') });

function params(type: string, over: Record<string, unknown> = {}): NodeParams {
  const out: NodeParams = {};
  for (const d of getNodeDef(type)!.params) out[d.id] = defaultParamState(d);
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] as NodeParams[string]), value: v as never, variance: undefined } as never;
  return out;
}

/** Leaf params with every random size / angle channel switched off so the maths can be checked exactly. */
function leafParams(cutoutId: string, over: Record<string, unknown> = {}): NodeParams {
  const p = params('generator.leaf', {
    number: 1, first: 0.5, last: 0.5, leafBend: 0, droopAmount: 0, leafTwist: 0, width: 0.3, height: 0.5, scale: 1,
    angleToParent: 55, rollAngle: 0, leavesPerNode: 1, ...over,
  });
  p.leafTypes = { ...(p.leafTypes as NodeParams[string]), value: [{ material: 'leaf', mesh: cutoutId, weight: 1 }] as never };
  return p;
}

function install(cutouts: CutoutMesh[]): void {
  setMaterialSource({ materials: () => [], sets: () => [], displacements: () => [], masks: () => [], cutoutMeshes: () => cutouts, season: () => 0.5 });
}

function runLeaf(nodeId: string, parent: Skeleton | ReturnType<typeof structureOf>, p: NodeParams, seed = 7) {
  const input = 'kind' in (parent as object) ? (parent as ReturnType<typeof structureOf>) : structureOf(parent as Skeleton);
  const out = getNodeDef('generator.leaf')!.evaluate(ctx(nodeId, seed), { parent: [input] } as NodeInputs, p) as Record<string, { kind: string; value: never }>;
  const children = out.children as unknown as { kind: 'Structure'; value: { skeleton: Skeleton; attachments?: import('@/contracts/attachment').AttachmentSet } };
  const geometry = out.geometry as unknown as { value: { positions: Float32Array; normals: Float32Array } };
  return { children, skeleton: children.value.skeleton, attachments: children.value.attachments!, mesh: geometry.value };
}

const structureOf = (skeleton: Skeleton) => ({ kind: 'Structure' as const, value: { skeleton } });
const col = (m: ArrayLike<number>, o: number, c: number): V3 => [m[o * 16 + c * 4] as number, m[o * 16 + c * 4 + 1] as number, m[o * 16 + c * 4 + 2] as number];
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-4): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(eps);
};
const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('frame math', () => {
  it('uvToLocal: base is the origin, the axis becomes +Y with arc length', () => {
    const c = cutout('c', { straightenAxis: [[0.5, 0], [0.8, 0.5], [0.5, 1]] });
    const f = buildCutoutFrame(c, { w: 1, h: 2 });
    close(uvToLocal(f, [0.5, 0]), [0, 0, 0]);
    // the middle control point is on the axis: lateral 0, arc length of the first segment
    const mid = uvToLocal(f, [0.8, 0.5]);
    expect(Math.abs(mid[0])).toBeLessThan(1e-9);
    expect(mid[1]).toBeCloseTo(Math.hypot(0.3, 1), 6);
    const tip = uvToLocal(f, [0.5, 1]);
    expect(tip[1]).toBeCloseTo(f.length, 6);
    // the first segment direction is the base tangent
    expect(f.baseTangent[0]).toBeCloseTo(0.3 / Math.hypot(0.3, 1), 6);
  });

  it('a tilted straight axis maps onto +Y (growth axis = axis direction, not the bounding box up)', () => {
    const c = cutout('t', { straightenAxis: [[0.2, 0.1], [0.6, 0.9]], straightenLinear: true });
    const f = buildCutoutFrame(c, { w: 1, h: 1 });
    const l = uvToLocal(f, [0.6, 0.9]);
    expect(Math.abs(l[0])).toBeLessThan(1e-9);
    expect(l[1]).toBeCloseTo(Math.hypot(0.4, 0.8), 6);
    // a point to the right of the axis has +X
    expect(uvToLocal(f, [0.9, 0.5])[0]).toBeGreaterThan(0);
  });

  it('default fallback: bottom-centre of the outline bounds, straight up', () => {
    const c = createDefaultCutoutMesh('d', 'd', 'leaf');
    c.outline = [[0.2, 0.1], [0.8, 0.1], [0.8, 0.9], [0.2, 0.9]];
    expect(defaultAxisFor(c)).toEqual([[0.5, 0.1], [0.5, 0.9]]);
    // missing / degenerate data never crashes and falls back
    (c as unknown as Record<string, unknown>).straightenAxis = undefined;
    (c as unknown as Record<string, unknown>).anchors = undefined;
    const f = buildCutoutFrame(c, { w: 1, h: 1 });
    expect(f.usedDefaultAxis).toBe(true);
    expect(f.base).toEqual([0.5, 0.1]);
    expect(f.anchors).toHaveLength(0);
  });

  it('mirror flips mirror anchors, directions and the winding', () => {
    const anchors = [{ uv: [0.5, 0.3] as P2, handle: [0.62, 0.42] as P2 }];
    const a = buildCutoutFrame(cutout('m0', {}, anchors), { w: 1, h: 1 }).anchors[0]!;
    const fx = cutout('m1', { transform: { orient: 'Z-Up Right-handed', flip: 'X', flipNormals: false, fixWinding: false } }, anchors);
    const f = buildCutoutFrame(fx, { w: 1, h: 1 });
    expect(f.mirrored).toBe(true);
    expect(f.anchors[0]!.localDirection[0]).toBeCloseTo(-a.localDirection[0], 9);
    expect(f.anchors[0]!.localDirection[1]).toBeCloseTo(a.localDirection[1], 9);
    expect(flipSigns('X Y')).toEqual([-1, -1, 1]);
    // geometry: x mirrored, faces still point to +Z (winding reversed together with the mirror)
    const g0 = buildCutoutGeometry(cutout('m0', {}, anchors), 'high', { metric: { w: 1, h: 1 } });
    const g1 = buildCutoutGeometry(fx, 'high', { metric: { w: 1, h: 1 } });
    for (let i = 0; i < g0.positions.length / 3; i++) {
      expect(g1.positions[i * 3]!).toBeCloseTo(-g0.positions[i * 3]!, 5);
      expect(g1.normals[i * 3 + 2]!).toBeGreaterThan(0.9);
    }
  });

  it('composeFrame = parent * anchor * inverse(childBase)', () => {
    const parent = frameToMat({ position: [1, 2, 3], direction: [0, 0, 1], up: [1, 0, 0] });
    const anchor = { position: [0, 0.5, 0] as V3, direction: [1, 0, 0] as V3, up: [0, 0, 1] as V3 };
    const w = composeFrame(parent, anchor);
    const fr = matToFrame(w);
    close(fr.position, [1 + 0, 2 + 0, 3 + 0.5 * 1]); // anchor y (0.5) maps to the parent +Y = world +Z
    // anchor direction (local +X) maps to the parent X = (1,0,0) x ... use the matrix directly
    const expectDir = [parent[0]!, parent[1]!, parent[2]!];
    close(fr.direction, expectDir);
    // a child whose base frame is offset ends up with its base frame on the anchor
    const childBase = { position: [0, 0.2, 0] as V3, direction: [0, 1, 0] as V3, up: [0, 0, 1] as V3 };
    const w2 = composeFrame(parent, anchor, childBase);
    const baseWorld = mat4Mul(w2, frameToMat(childBase));
    close(baseWorld.slice(12, 15), mat4Mul(parent, frameToMat(anchor)).slice(12, 15));
    const inv = mat4Mul(rigidInverse(parent), parent);
    expect(inv[0]).toBeCloseTo(1, 9);
    expect(inv[12]).toBeCloseTo(0, 9);
  });

  it('warnings: base outside the outline and anchors off the mesh', () => {
    const c = cutout('w', {}, [{ uv: [0.05, 0.95], handle: [0.05, 1] }]);
    expect(attachmentWarnings(c).some((w) => w.includes('off the mesh'))).toBe(true);
    c.straightenAxis = [[0.02, 0.95], [0.5, 1]];
    expect(attachmentWarnings(c).some((w) => w.includes('base is outside'))).toBe(true);
  });
});

describe('Leaf placement', () => {
  it('base pivot lands on the parent attachment point and +Y is the growth direction (any parent orientation)', () => {
    for (const dir of [[0, 0, 1], [1, 0, 0], [0.6, 0.0, 0.8], [0, -0.7071, 0.7071]] as V3[]) {
      const c = cutout('leafc');
      install([c]);
      const parentSk = stem(dir);
      const r = runLeaf('leaf', parentSk, leafParams('leafc'));
      expect(r.skeleton.branches).toHaveLength(1);
      const origin: V3 = [r.skeleton.position[0]!, r.skeleton.position[1]!, r.skeleton.position[2]!];
      const tip: V3 = [r.skeleton.position[3]!, r.skeleton.position[4]!, r.skeleton.position[5]!];
      // origin is on the parent stem line
      const t = dot3(origin, dir);
      close(origin, [dir[0] * t, dir[1] * t, dir[2] * t]);
      // +Y of the exported instance transform == growth direction
      const y = col(r.attachments.instanceTransform, 0, 1);
      const len = Math.hypot(tip[0] - origin[0], tip[1] - origin[1], tip[2] - origin[2]);
      close(y, [(tip[0] - origin[0]) / len, (tip[1] - origin[1]) / len, (tip[2] - origin[2]) / len]);
      close(col(r.attachments.instanceTransform, 0, 3), origin);
      // the mesh vertex authored at the axis base is exactly on the attachment point
      let best = Infinity;
      for (let i = 0; i < r.mesh.positions.length / 3; i++) best = Math.min(best, Math.hypot(r.mesh.positions[i * 3]! - origin[0], r.mesh.positions[i * 3 + 1]! - origin[1], r.mesh.positions[i * 3 + 2]! - origin[2]));
      expect(best).toBeLessThan(1e-4);
    }
  });

  it('Roll rotates only around the axis; scale / variance are deterministic', () => {
    const c = cutout('rollc');
    install([c]);
    const a = runLeaf('leaf', stem(), leafParams('rollc', { rollAngle: 0 }));
    const b = runLeaf('leaf', stem(), leafParams('rollc', { rollAngle: 90 }));
    close(col(a.attachments.instanceTransform, 0, 3), col(b.attachments.instanceTransform, 0, 3));
    close(col(a.attachments.instanceTransform, 0, 1), col(b.attachments.instanceTransform, 0, 1));
    const za = col(a.attachments.instanceTransform, 0, 2);
    const zb = col(b.attachments.instanceTransform, 0, 2);
    expect(Math.abs(dot3(za, zb))).toBeLessThan(1e-4);
    const again = runLeaf('leaf', stem(), leafParams('rollc', { rollAngle: 90 }));
    expect(Array.from(again.mesh.positions)).toEqual(Array.from(b.mesh.positions));
  });

  it('Straighten deformation keeps the base fixed and anchor frames follow the bent axis', () => {
    const c = cutout('bend', { straightenAxis: [[0.5, 0], [0.62, 0.5], [0.5, 1]] }, [{ uv: [0.62, 0.5], handle: [0.62, 0.6] }]);
    const f = buildCutoutFrame(c, { w: 0.3, h: 0.5 });
    const pose = cardPoseFor(f, { origin: [0, 0, 0], axis: [0, 1, 0], side: [1, 0, 0] }, { bend: 1.2 });
    const g = buildCutoutGeometry(c, 'high', { origin: [0, 0, 0], axis: [0, 1, 0], side: [1, 0, 0], width: 0.3, length: 0.5, bend: 1.2 });
    const vertexAt = (u: number, v: number): V3 => {
      const verts = c.lods.high.vertices;
      for (let i = 0; i < verts.length / 2; i++) if (Math.abs(verts[i * 2]! - u) < 1e-9 && Math.abs(verts[i * 2 + 1]! - v) < 1e-9) return [g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!];
      throw new Error('vertex not found');
    };
    close(vertexAt(0.5, 0), [0, 0, 0]);
    const anchor = anchorFrameInPose(pose, f.anchors[0]!);
    close(anchor.position, vertexAt(0.62, 0.5));
    // bending moved the anchor off the straight axis, i.e. the frame really is deformed
    expect(Math.abs(anchor.position[2])).toBeGreaterThan(0.01);
    const straight = cardPointAt({ ...pose, bend: 0 }, 0, f.anchors[0]!.localPosition[1]).p;
    expect(Math.hypot(straight[0] - anchor.position[0], straight[1] - anchor.position[1], straight[2] - anchor.position[2])).toBeGreaterThan(0.01);
  });
});

/** Cluster with three anchors, authored out of axis order. */
const CLUSTER_ANCHORS = [
  { uv: [0.5, 0.7] as P2, handle: [0.5, 0.8] as P2 },
  { uv: [0.5, 0.2] as P2, handle: [0.6, 0.3] as P2 },
  { uv: [0.5, 0.45] as P2, handle: [0.4, 0.55] as P2 },
];

describe('anchor based child attachment', () => {
  const setup = () => {
    const cluster = cutout('cluster', {}, CLUSTER_ANCHORS);
    const single = cutout('single');
    const sub = cutout('sub', {}, [{ uv: [0.5, 0.3] as P2, handle: [0.5, 0.4] as P2 }, { uv: [0.5, 0.6] as P2, handle: [0.58, 0.7] as P2 }]);
    install([cluster, single, sub]);
    const parent = runLeaf('A', stem(), leafParams('cluster'));
    return { cluster, single, sub, parent };
  };

  it('anchors are ordered along the axis', () => {
    const { cluster } = setup();
    const f = buildCutoutFrame(cluster, { w: 1, h: 1 });
    expect(f.anchors.map((a) => a.axisT)).toEqual([...f.anchors.map((a) => a.axisT)].sort((a, b) => a - b));
    expect(cluster.anchors.map((a) => a.uv[1])).toEqual([0.2, 0.45, 0.7]);
  });

  it('exact formula: anchor frames in the parent instance frame (flat card, no bend)', () => {
    const { cluster, parent } = setup();
    const set = parent.attachments;
    const T = set.instanceTransform;
    const X = col(T, 0, 0);
    const Y = col(T, 0, 1);
    const O = col(T, 0, 3);
    const frames = attachmentFramesOf(set, 0);
    expect(frames).toHaveLength(3);
    // height realised by the leaf = skeleton length; width 0.3 (variance off)
    const sk = parent.skeleton;
    const H = Math.hypot(sk.position[3]! - sk.position[0]!, sk.position[4]! - sk.position[1]!, sk.position[5]! - sk.position[2]!);
    const W = 0.3 * (H / 0.5);
    const expected = cluster.anchors.map((a) => {
      const dx = (a.handleUv[0] - a.uv[0]) * W;
      const dy = (a.handleUv[1] - a.uv[1]) * H;
      const l = Math.hypot(dx, dy);
      return { s: a.uv[1] * H, d: [dx / l, dy / l] };
    });
    frames.forEach((fr, i) => {
      close(fr.position, [O[0] + Y[0] * expected[i]!.s, O[1] + Y[1] * expected[i]!.s, O[2] + Y[2] * expected[i]!.s]);
      const e = expected[i]!;
      close(fr.direction, [X[0] * e.d[0]! + Y[0] * e.d[1]!, X[1] * e.d[0]! + Y[1] * e.d[1]!, X[2] * e.d[0]! + Y[2] * e.d[1]!]);
    });
  });

  it('a child Leaf with its own cutout produces one leaf per anchor, base on the anchor, axis along its direction', () => {
    const { parent } = setup();
    const child = runLeaf('B', { kind: 'Structure', value: { skeleton: parent.skeleton, attachments: parent.attachments } } as never, leafParams('single'));
    expect(child.skeleton.branches).toHaveLength(3);
    const frames = attachmentFramesOf(parent.attachments, 0);
    for (let i = 0; i < 3; i++) {
      close(col(child.attachments.instanceTransform, i, 3), frames[i]!.position);
      close(col(child.attachments.instanceTransform, i, 1), frames[i]!.direction);
    }
  });

  it('modes: number per anchor, cycle, specific index, and determinism by seed', () => {
    const { parent } = setup();
    const input = { kind: 'Structure', value: { skeleton: parent.skeleton, attachments: parent.attachments } } as never;
    expect(runLeaf('B', input, leafParams('single', { anchorNumber: 2 })).skeleton.branches).toHaveLength(6);
    const frames = attachmentFramesOf(parent.attachments, 0);
    const cyc = runLeaf('B', input, leafParams('single', { anchorMode: 'cycle', number: 5 }));
    expect(cyc.skeleton.branches).toHaveLength(5);
    close(col(cyc.attachments.instanceTransform, 3, 3), frames[0]!.position);
    close(col(cyc.attachments.instanceTransform, 4, 3), frames[1]!.position);
    const spec = runLeaf('B', input, leafParams('single', { anchorMode: 'specific-index', anchorIndex: 1 }));
    expect(spec.skeleton.branches).toHaveLength(1);
    close(col(spec.attachments.instanceTransform, 0, 3), frames[1]!.position);
    const r1 = runLeaf('B', input, leafParams('single', { anchorMode: 'random', number: 6 }), 11);
    const r2 = runLeaf('B', input, leafParams('single', { anchorMode: 'random', number: 6 }), 11);
    expect(Array.from(r1.attachments.instanceTransform)).toEqual(Array.from(r2.attachments.instanceTransform));
    // 'Never' keeps the classic distribution along the (leaf) spine
    const never = runLeaf('B', input, leafParams('single', { attachToAnchors: 'never', number: 4, first: 0.2, last: 0.9 }));
    expect(never.skeleton.branches.length).toBeGreaterThan(0);
  });

  it('two-level nesting: cluster -> sub-cluster -> leaf', () => {
    const { parent } = setup();
    const lvl2 = runLeaf('B', { kind: 'Structure', value: { skeleton: parent.skeleton, attachments: parent.attachments } } as never, leafParams('sub'));
    expect(lvl2.skeleton.branches).toHaveLength(3);
    expect(lvl2.attachments.instanceCount).toBe(3);
    const lvl3 = runLeaf('C', { kind: 'Structure', value: { skeleton: lvl2.skeleton, attachments: lvl2.attachments } } as never, leafParams('single'));
    expect(lvl3.skeleton.branches).toHaveLength(6);
    let k = 0;
    for (let row = 0; row < 3; row++) {
      const frames = attachmentFramesOf(lvl2.attachments, row);
      for (const f of frames) {
        close(col(lvl3.attachments.instanceTransform, k, 3), f.position);
        close(col(lvl3.attachments.instanceTransform, k, 1), f.direction);
        k += 1;
      }
    }
    expect(findAttachmentByBranch(lvl2.attachments, 1)).toBe(1);
  });

  it('parent rotated / flipped keeps children on the anchors', () => {
    const cluster = cutout('flipc', { transform: { orient: 'Z-Up Right-handed', flip: 'X', flipNormals: false, fixWinding: false } }, CLUSTER_ANCHORS);
    install([cluster, cutout('single')]);
    const parent = runLeaf('A', stem([0.6, 0, 0.8]), leafParams('flipc'));
    const child = runLeaf('B', { kind: 'Structure', value: { skeleton: parent.skeleton, attachments: parent.attachments } } as never, leafParams('single'));
    const frames = attachmentFramesOf(parent.attachments, 0);
    expect(child.skeleton.branches).toHaveLength(3);
    for (let i = 0; i < 3; i++) close(col(child.attachments.instanceTransform, i, 3), frames[i]!.position);
  });

  it('instance keys are stable and anchor slots carry a key', () => {
    const { parent } = setup();
    const k1 = Array.from(parent.attachments.instanceKey);
    const again = runLeaf('A', stem(), leafParams('cluster'));
    expect(Array.from(again.attachments.instanceKey)).toEqual(k1);
    expect(k1[0]).toBe(instanceKey('A', 0, 0, 0));
  });
});

describe('serialization / migration', () => {
  it('old cutouts without axis / anchor data load with the fallback; new data round-trips', () => {
    const old = createDefaultCutoutMesh('old', 'old', 'leaf');
    const raw = JSON.parse(JSON.stringify(old)) as Record<string, unknown>;
    delete raw.straightenAxis;
    delete raw.anchors;
    delete raw.attachVersion;
    const c = raw as unknown as CutoutMesh;
    ensureCutoutAttachmentData(c);
    expect(c.straightenAxis).toEqual([[0.5, 0], [0.5, 1]]);
    expect(c.anchors).toEqual([]);
    expect(c.attachVersion).toBe(1);
    const rt = JSON.parse(JSON.stringify(cutout('rt', {}, CLUSTER_ANCHORS))) as CutoutMesh;
    const before = JSON.stringify(rt);
    ensureCutoutAttachmentData(rt);
    expect(JSON.stringify(rt)).toBe(before);
  });

  it('Straighten tools write data the pipeline consumes (Linear is non-destructive, Reset restores the default)', () => {
    const c = cutout('tools', { straightenAxis: [[0.5, 0], [0.7, 0.5], [0.5, 1]] });
    const outline = JSON.stringify(c.outline);
    linearizeStraighten(c);
    expect(c.straightenLinear).toBe(true);
    expect(c.straightenAxis).toEqual([[0.5, 0], [0.5, 1]]);
    expect(JSON.stringify(c.outline)).toBe(outline);
    resetStraighten(c);
    expect(c.straightenLinear).toBe(false);
    expect(c.straightenAxis).toEqual(defaultAxisFor(c));
    expect(c.pivot).toEqual([0.5, 0]);
  });
});

describe('Mesh and Decoration generators', () => {
  type AttachSet = import('@/contracts/attachment').AttachmentSet;
  const run = (type: string, id: string, input: { skeleton: Skeleton; attachments?: AttachSet }, p: NodeParams) => {
    const out = getNodeDef(type)!.evaluate(ctx(id), { parent: [{ kind: 'Structure', value: input }] } as NodeInputs, p) as Record<string, unknown>;
    const children = (out.children as { value: { skeleton: Skeleton; attachments?: AttachSet } }).value;
    return { skeleton: children.skeleton, attachments: children.attachments! };
  };

  it('Mesh instance with a cutout asset: base on the attachment point, +Y = growth, anchors exported and used by children', () => {
    const cluster = cutout('mcluster', {}, CLUSTER_ANCHORS);
    install([cluster, cutout('single')]);
    const mp = params('generator.meshes', { primitive: 'asset', meshAsset: 'mcluster', number: 1, first: 0.5, last: 0.5, meshScale: 0.4 });
    const mesh = run('generator.meshes', 'M', { skeleton: stem() }, mp);
    expect(mesh.attachments.instanceCount).toBe(1);
    const o = col(mesh.attachments.instanceTransform, 0, 3);
    close(o, [mesh.skeleton.position[0]!, mesh.skeleton.position[1]!, mesh.skeleton.position[2]!]);
    expect(Math.hypot(o[0], o[1])).toBeLessThan(1e-5); // on the stem axis
    const y = col(mesh.attachments.instanceTransform, 0, 1);
    close(y, [mesh.skeleton.direction[0]!, mesh.skeleton.direction[1]!, mesh.skeleton.direction[2]!]);
    const frames = attachmentFramesOf(mesh.attachments, 0);
    expect(frames).toHaveLength(3);
    // anchor 0 sits on the axis at v = 0.2 of the (bounds x scale) card height, scaled by the instance scale
    const h = cluster.boundsMeters[1] * 0.4;
    close(frames[0]!.position, [o[0] + y[0] * 0.2 * h, o[1] + y[1] * 0.2 * h, o[2] + y[2] * 0.2 * h], 1e-3);
    const child = run('generator.leaf', 'B', { skeleton: mesh.skeleton, attachments: mesh.attachments }, leafParams('single'));
    expect(child.skeleton.branches).toHaveLength(3);
    for (let i = 0; i < 3; i++) close(col(child.attachments.instanceTransform, i, 3), frames[i]!.position);
  });

  it('Decoration cutouts stand on the parent surface with their base pivot (not centred)', () => {
    const c = cutout('deco', {}, CLUSTER_ANCHORS);
    install([c, cutout('single')]);
    const p = params('generator.decoration', { decoShape: 'cutout-mesh', number: 6, decoOffset: 0.003 });
    p.leafTypes = { ...(p.leafTypes as NodeParams[string]), value: [{ material: 'leaf', mesh: 'deco', weight: 1 }] as never };
    const deco = run('generator.decoration', 'D', { skeleton: stem() }, p);
    expect(deco.attachments.instanceCount).toBeGreaterThan(0);
    for (let i = 0; i < deco.attachments.instanceCount; i++) {
      const o = col(deco.attachments.instanceTransform, i, 3);
      expect(Math.hypot(o[0], o[1])).toBeCloseTo(0.02 + 0.003, 4);
    }
    // a child Leaf is planted on the decoration's anchors
    const child = run('generator.leaf', 'B', { skeleton: deco.skeleton, attachments: deco.attachments }, leafParams('single'));
    expect(child.skeleton.branches).toHaveLength(deco.attachments.instanceCount * 3);
  });
});

describe('dev scene', () => {
  it('builds the three-level chain: 1 cluster, 4 leaves, 8 sub-leaves', async () => {
    const { buildCutoutAttachmentScene } = await import('./helpers/cutoutAttachmentScene');
    const { levels } = buildCutoutAttachmentScene();
    expect(levels.map((l) => l.attachments.instanceCount)).toEqual([1, 4, 8]);
  });
});
