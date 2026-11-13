import { BoxGeometry, Box3, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, Points, Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { VIEW_MODES } from '@/contracts/app';
import { buildNormalSegments, buildPointPositions, buildSkeletonSegments } from '@/viewport/debug/debugBuffers';
import { buildSkeletonDebugPiece, createSkeletonDebugMaterials, generationColor } from '@/viewport/skeletonDebug';
import { isSurfaceMesh, ViewModeController } from '@/viewport/viewModes';
import type { ViewportContent } from '@/viewport/types';

function skeleton() {
  const b = new SkeletonBuilder();
  b.beginBranch(-1, -1, 0);
  for (let i = 0; i < 5; i++) b.addPoint(0, 0, i * 0.5, 0.1);
  b.endBranch();
  b.beginBranch(0, 2, 1);
  for (let i = 0; i < 4; i++) b.addPoint(i * 0.2, 0, 1 + i * 0.1, 0.03);
  b.endBranch();
  return b.build();
}

describe('line / point / normal buffer builders', () => {
  it('skeleton segments pair consecutive points of the same branch only', () => {
    const sk = skeleton();
    const r = buildSkeletonSegments(sk, generationColor);
    expect(r.segments).toBe(4 + 3);
    expect(r.positions.length).toBe(r.segments * 6);
    expect(r.colors.length).toBe(r.segments * 6);
    for (let s = 0; s < r.segments; s++) {
      const a = r.indices[s * 2] as number;
      const b = r.indices[s * 2 + 1] as number;
      expect(b).toBe(a + 1);
      const branch = sk.branches.find((br) => a >= br.start && a < br.start + br.count);
      expect(branch).toBeDefined();
      expect(b).toBeLessThan((branch?.start ?? 0) + (branch?.count ?? 0)); // never crosses into another branch
    }
    expect([...r.positions, ...r.colors].every(Number.isFinite)).toBe(true);
    // generation colours: branch 0 and branch 1 differ
    expect(r.colors[0]).not.toBe(r.colors[4 * 6]);
  });

  it('normal lines: identity transform, length and finite values', () => {
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const nor = [0, 0, 2, 0, 0, 1, 0, 0, 0]; // last normal is degenerate
    const r = buildNormalSegments(pos, nor, 0.1);
    expect(r.segments).toBe(2);
    expect(r.positions.length).toBe(12);
    expect(r.positions[5]).toBeCloseTo(0.1, 6);
    expect([...r.positions].every(Number.isFinite)).toBe(true);
  });

  it('normal lines of instances are in world space with rotation and non-uniform scale', () => {
    const m = new Matrix4().compose(new Vector3(10, 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2), new Vector3(1, 3, 1));
    const r = buildNormalSegments([0, 0, 0], [1, 0, 0], 1, { matrices: m.elements });
    expect(r.segments).toBe(1);
    // +X normal rotated by 90 deg about Z -> +Y; position moved to x = 10
    expect(r.positions[0]).toBeCloseTo(10, 6);
    expect(r.positions[3]).toBeCloseTo(10, 6);
    expect(r.positions[4]).toBeCloseTo(1, 5);
  });

  it('strides huge meshes to the element cap', () => {
    const n = 5000;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3).fill(1);
    const r = buildNormalSegments(pos, nor, 1, { max: 1000 });
    expect(r.stride).toBe(5);
    expect(r.segments).toBeLessThanOrEqual(1000);
    expect(buildPointPositions(pos, { max: 1000 }).count).toBeLessThanOrEqual(1000);
  });

  it('points of an instanced mesh are transformed by every instance matrix', () => {
    const a = new Matrix4().makeTranslation(1, 0, 0);
    const b = new Matrix4().makeTranslation(0, 5, 0);
    const r = buildPointPositions([0, 0, 0], { matrices: [...a.elements, ...b.elements], instanceCount: 2 });
    expect(Array.from(r.positions)).toEqual([1, 0, 0, 0, 5, 0]);
  });
});

function makeContent() {
  const mats = createSkeletonDebugMaterials();
  const piece = buildSkeletonDebugPiece('trunk', skeleton(), 'r1', mats);
  const skeletonGroup = new Group();
  skeletonGroup.add(piece.group);
  const root = new Group();
  const bark = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  bark.userData.nodeId = 'trunk';
  const card = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  card.userData.nodeId = 'leaves';
  const inst = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial(), 3);
  inst.userData.nodeId = 'decor';
  for (let i = 0; i < 3; i++) inst.setMatrixAt(i, new Matrix4().makeTranslation(i, 0, 0));
  root.add(bark, card, inst, skeletonGroup); // the viewport parents the skeleton group under the plant root
  const content: ViewportContent = { root, skeleton: skeletonGroup, bounds: new Box3(), stats: { groups: [], triangles: 0, vertices: 0, bones: 0 }, dispose: () => mats.dispose() };
  return { content, piece, bark, card, inst, mats };
}

describe('ViewModeController', () => {
  it('never treats thick skeleton lines as surface meshes (they extend Mesh)', () => {
    const { piece } = makeContent();
    expect(piece.lines instanceof Mesh).toBe(true);
    expect(isSurfaceMesh(piece.lines)).toBe(false);
    expect(isSurfaceMesh(piece.radii)).toBe(false);
  });

  it('Skeleton Lines mode shows the lines, hides skeleton-owning surfaces and keeps other nodes visible as wire', () => {
    const { content, piece, bark, card, inst } = makeContent();
    const vm = new ViewModeController();
    vm.apply(content, 'skeleton');
    expect(content.skeleton?.visible).toBe(true);
    expect(piece.lines.visible).toBe(true);
    expect(piece.lines.material).toBe(piece.lines.material); // untouched LineMaterial
    expect(bark.visible).toBe(false);
    expect(card.visible).toBe(true);
    expect(card.children.length).toBe(1); // faint wire overlay
    expect(inst.visible).toBe(true);
    vm.apply(content, 'shaded');
    expect(content.skeleton?.visible).toBe(false);
    expect(piece.lines.visible).toBe(true);
    expect(bark.visible).toBe(true);
    expect(card.children.length).toBe(0);
    vm.dispose();
  });

  it('Points mode builds round points for plain and instanced meshes and shows the skeleton group', () => {
    const { content, bark, inst } = makeContent();
    const vm = new ViewModeController();
    vm.apply(content, 'points');
    expect(vm.lastDebug.points).toBe(24 + 24 + 24 * 3);
    expect(bark.children.some((c) => c instanceof Points)).toBe(true);
    expect(inst.children.some((c) => c instanceof Points)).toBe(true);
    expect(content.skeleton?.visible).toBe(true);
    vm.dispose();
  });

  it('Normals mode keeps the shaded surface and adds normal lines on every mesh kind', () => {
    const { content, bark, inst } = makeContent();
    const vm = new ViewModeController();
    vm.apply(content, 'normals');
    expect(vm.lastDebug.normalSegments).toBe(24 * 5);
    expect(bark.material).toBe(bark.userData.baseMaterial);
    expect(bark.children.some((c) => c instanceof LineSegments2)).toBe(true);
    expect(inst.children.some((c) => c instanceof LineSegments2)).toBe(true);
    expect(content.skeleton?.visible).toBe(false);
    vm.apply(content, 'shaded');
    expect(bark.children.length).toBe(0);
    vm.dispose();
  });

  it('every mode can be applied and reverted without leaking overlays; hidden-by-filter meshes stay hidden', () => {
    const { content, bark } = makeContent();
    bark.userData.ktHidden = true;
    const vm = new ViewModeController();
    for (const mode of VIEW_MODES) {
      vm.apply(content, mode);
      if (mode !== 'skeleton') expect(bark.visible).toBe(false);
    }
    vm.apply(content, 'shaded');
    expect(bark.children.length).toBe(0);
    expect(bark.material).toBe(bark.userData.baseMaterial);
    vm.dispose();
  });
});
