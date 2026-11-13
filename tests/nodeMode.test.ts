import { beforeAll, describe, expect, it } from 'vitest';
import { Group, Scene } from 'three';
import { UndoStack } from '@/app/commands/undoStack';
import type { AppContext, AppEvents } from '@/app/context';
import { GraphSession } from '@/app/graphSession';
import { createAppStore } from '@/app/state';
import type { SceneModel } from '@/contracts/engine';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { EventBus } from '@/core/eventBus';
import { OverrideEditor } from '@/instances/editor';
import { registerNodeModeMapping, resolveHandle } from '@/instances/mappings';
import { OVERRIDES_PARAM_ID, readOverrides } from '@/instances/overrides';
import { fillTableBounds, InstanceScope } from '@/instances/scope';
import { FLAG_HIDDEN, type InstanceTable } from '@/instances/types';
import { registerDiscoveredNodes } from '@/graph/registry';
import { computeInstanceFrame, lineParamClosestToRay, planeAngle, polylineUClosestToRay, snap, wrapAngle } from '@/viewport/gizmos/nodeModeMath';
import { childInstances, marqueePick, parentInstance, pickInstance, type PickRay, type PickSource } from '@/viewport/picking/instancePicker';
import { SpineLayer } from '@/viewport/overlays/spineLayer';
import { OverlaySystem } from '@/viewport/overlays/overlaySystem';
import { selectionStats } from '@/viewport/overlays/selectionStats';
import { ViewModeController } from '@/viewport/viewModes';
import type { Viewport } from '@/viewport/viewport';
import { buildDemoGraph } from './fixtures/demoGraph';

beforeAll(() => registerDiscoveredNodes());

/** Three vertical branches at x = 0, 2, 4 (radius 0.05), each its own instance of node "n". */
function synthetic(): { sk: Skeleton; table: InstanceTable; src: PickSource } {
  const b = new SkeletonBuilder();
  const scope = new InstanceScope('n', {}, null);
  for (let i = 0; i < 3; i++) {
    const h = scope.spawn({ parentBranch: -1, index: i }, { branchCount: i, pointCount: i * 3 });
    b.beginBranch(-1, -1, 0);
    b.addPoint(i * 2, 0, 0, 0.05);
    b.addPoint(i * 2, 0, 1, 0.05);
    b.addPoint(i * 2, 0, 2, 0.05);
    b.endBranch();
    scope.finish(h, { branchCount: i + 1, pointCount: (i + 1) * 3 });
  }
  const sk = b.build();
  const table = scope.table();
  fillTableBounds(table, sk);
  return { sk, table, src: { nodeId: 'n', skeleton: sk, table } };
}

const ray = (x: number, y: number, z: number, dy = 1): PickRay => ({ origin: [x, y, z], dir: [0, dy, 0] });
const PX = 0.002;

describe('instance picking', () => {
  it('returns the expected instance on a synthetic scene', () => {
    const { src, table } = synthetic();
    for (let i = 0; i < 3; i++) {
      const hit = pickInstance([src], ray(i * 2, -10, 1), { pixelScale: PX });
      expect(hit?.row).toBe(i);
      expect(hit?.key).toBe(table.key[i]);
      expect(hit?.nodeId).toBe('n');
    }
    expect(pickInstance([src], ray(1, -10, 1), { pixelScale: PX })).toBeNull();
    expect(pickInstance([src], ray(0, -10, 5), { pixelScale: PX })).toBeNull();
  });

  it('has a pixel tolerance around thin branches', () => {
    const { src } = synthetic();
    expect(pickInstance([src], ray(0.11, -10, 1), { pixelScale: PX, tolerancePx: 6 })?.row).toBe(0);
    expect(pickInstance([src], ray(0.5, -10, 1), { pixelScale: PX, tolerancePx: 6 })).toBeNull();
  });

  it('ignores hidden instances and invisible nodes', () => {
    const { src, table } = synthetic();
    table.flags[1] = FLAG_HIDDEN;
    expect(pickInstance([src], ray(2, -10, 1), { pixelScale: PX })).toBeNull();
    expect(pickInstance([src], ray(0, -10, 1), { pixelScale: PX, isNodeVisible: () => false })).toBeNull();
  });

  it('prefers the nearest instance along the ray', () => {
    const { src } = synthetic();
    // Looking along +x through all three branches: the nearest one (x = 0) wins from the left, x = 4 from the right.
    const left = pickInstance([src], { origin: [-10, 0, 1], dir: [1, 0, 0] }, { pixelScale: PX });
    const right = pickInstance([src], { origin: [14, 0, 1], dir: [-1, 0, 0] }, { pixelScale: PX });
    expect(left?.row).toBe(0);
    expect(right?.row).toBe(2);
  });

  it('marquee selects instances whose points fall inside the rectangle', () => {
    const { src } = synthetic();
    const project = (x: number, _y: number, z: number): [number, number] => [x * 100, 300 - z * 100];
    const hits = marqueePick([src], project, { x0: -10, y0: 0, x1: 250, y1: 400 });
    expect(hits.map((h) => h.row).sort()).toEqual([0, 1]);
  });

  it('stays interactive with 120 000 instances', () => {
    const n = 120_000;
    const table: InstanceTable = {
      nodeId: 'big', count: n, key: new Uint32Array(n).map((_, i) => i + 1), parentKey: new Uint32Array(n), index: new Int32Array(n), parentInstance: new Int32Array(n).fill(-1),
      parentBranch: new Int32Array(n).fill(-1), branchStart: new Int32Array(n).map((_, i) => i), branchCount: new Int32Array(n).fill(1), pointStart: new Int32Array(n).map((_, i) => i * 2),
      pointCount: new Int32Array(n).fill(2), baseU: new Float32Array(n), flags: new Uint8Array(n), bounds: new Float32Array(n * 6), branchToInstance: new Int32Array(n).map((_, i) => i), pruned: new Uint32Array(0),
    };
    const b = new SkeletonBuilder();
    for (let i = 0; i < n; i++) {
      const x = (i % 400) * 0.5;
      const y = Math.floor(i / 400) * 0.5;
      b.beginBranch(-1, -1, 0);
      b.addPoint(x, y, 0, 0.02);
      b.addPoint(x, y, 1, 0.02);
      b.endBranch();
    }
    const sk = b.build();
    fillTableBounds(table, sk);
    const src = { nodeId: 'big', skeleton: sk, table };
    const t0 = performance.now();
    let hit = null;
    for (let k = 0; k < 20; k++) hit = pickInstance([src], { origin: [10, -50, 0.5], dir: [0, 1, 0] }, { pixelScale: PX });
    const per = (performance.now() - t0) / 20;
    expect(hit && (hit as { row: number }).row).toBe(20);
    expect(per).toBeLessThan(60);
  });

  it('navigates parents and children through the tables', async () => {
    const { src, table } = synthetic();
    expect(childInstances([src], table.key[0] as number)).toHaveLength(0);
    expect(parentInstance([src], 'n', 0)).toBeNull();
  });
});

describe('gizmo maths', () => {
  it('wraps angles and measures plane angles', () => {
    expect(wrapAngle(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 6);
    expect(wrapAngle(-Math.PI * 1.5)).toBeCloseTo(Math.PI / 2, 6);
    expect(planeAngle([0, 2, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBeCloseTo(Math.PI / 2, 6);
    expect(snap(12.4, 5, true)).toBe(10);
    expect(snap(12.4, 5, false)).toBe(12.4);
  });

  it('finds the closest line parameter and the parent position along a spine', () => {
    const r: PickRay = { origin: [3, -5, 1.5], dir: [0, 1, 0] };
    expect(lineParamClosestToRay(r, [0, 0, 0], [1, 0, 0])).toBeCloseTo(3, 6);
    const { sk } = synthetic();
    expect(polylineUClosestToRay({ origin: [2, -5, 0.5], dir: [0, 1, 0] }, sk, 1)).toBeCloseTo(0.25, 5);
    expect(polylineUClosestToRay({ origin: [2, -5, 1.5], dir: [0, 1, 0] }, sk, 1)).toBeCloseTo(0.75, 5);
  });

  it('builds the instance frame with the parent axis', () => {
    const { sk, table } = synthetic();
    const f = computeInstanceFrame(sk, table, 0, [])!;
    expect(f.rootLevel).toBe(true);
    expect(f.parentAxis).toEqual([0, 0, 1]);
    expect(f.length).toBeCloseTo(2, 6);
    expect(f.spreadDeg).toBeCloseTo(0, 3);
  });
});

describe('node mode mappings', () => {
  it('resolve per node type and context, and are registerable', () => {
    expect(resolveHandle('generator.branch', 'angle', { rootLevel: false })).toEqual({ kind: 'param', id: 'spread' });
    expect(resolveHandle('generator.trunk', 'angle', { rootLevel: true })).toEqual({ kind: 'param', id: 'lean' });
    expect(resolveHandle('generator.trunk', 'angle', { rootLevel: false })).toEqual({ kind: 'param', id: 'spread' });
    expect(resolveHandle('generator.trunk', 'position', { rootLevel: true })).toBeNull();
    expect(resolveHandle('generator.leaf', 'angle', { rootLevel: false })).toBeNull();
    registerNodeModeMapping('generator.custom', { length: { kind: 'transform', field: 'lengthScale' } });
    expect(resolveHandle('generator.custom', 'length', { rootLevel: false })).toEqual({ kind: 'transform', field: 'lengthScale' });
  });
});

describe('override editor (undo / redo)', () => {
  function make(): { editor: OverrideEditor; undo: UndoStack; session: GraphSession } {
    const store = createAppStore();
    const undo = new UndoStack(store);
    const session = new GraphSession({ store, undo, appEvents: new EventBus<AppEvents>(), notify: () => undefined, initialGraph: buildDemoGraph });
    const app = { graph: session, engine: { latest: null } } as unknown as AppContext;
    return { editor: new OverrideEditor(app), undo, session };
  }
  const ref = { nodeId: 'trunk', key: 4242 };

  it('merges a drag into one undo step and restores on undo / redo', () => {
    const { editor, undo, session } = make();
    const before = undo.history().length;
    for (const v of [5, 10, 15, 20]) editor.setTransform([ref], 'rotation', () => v, true);
    editor.commit();
    expect(undo.history().length).toBe(before + 1);
    expect(editor.get(ref)?.transform?.rotation).toBe(20);
    undo.undo();
    expect(editor.get(ref)).toBeUndefined();
    undo.redo();
    expect(editor.get(ref)?.transform?.rotation).toBe(20);
    expect(readOverrides(session.model.getNode('trunk')!.params)).toHaveLength(1);
  });

  it('a second gesture is a new undo step; reset / clear remove overrides', () => {
    const { editor, undo } = make();
    editor.setTransform([ref], 'lengthScale', () => 2, true);
    editor.commit();
    editor.setParam([ref], 'spread', 'offset', () => 7, true);
    editor.commit();
    expect(undo.history().length).toBeGreaterThanOrEqual(2);
    expect(editor.get(ref)?.params.spread?.value).toBe(7);
    editor.resetParam([ref], 'spread');
    expect(editor.get(ref)?.params.spread).toBeUndefined();
    expect(editor.get(ref)?.transform?.lengthScale).toBe(2);
    editor.clear('trunk');
    expect(editor.list('trunk')).toHaveLength(0);
    expect(OVERRIDES_PARAM_ID).toBe('__overrides');
  });

  it('can copy overrides onto other instances and toggle flags', () => {
    const { editor } = make();
    const other = { nodeId: 'trunk', key: 99 };
    editor.setTransform([ref], 'roll', () => 30, false);
    editor.commit();
    editor.copyOverrides(ref, [ref, other]);
    expect(editor.get(other)?.transform?.roll).toBe(30);
    editor.setFlag([other], 'hidden', true);
    expect(editor.get(other)?.hidden).toBe(true);
    editor.setFlag([other], 'hidden', false);
    expect(editor.get(other)?.hidden).toBeUndefined();
  });
});

describe('selection stats', () => {
  it('counts the triangles and bones of the selected node and apportions instance selections', () => {
    const { sk, table } = synthetic();
    const mesh = { indices: new Uint32Array(30) } as unknown as SceneModel['entries'][number]['mesh'];
    const scene = { entries: [{ nodeId: 'n', type: 'generator.branch', statsGroup: 'branches', mesh, rev: 'r' }], skeletons: [{ nodeId: 'n', skeleton: sk, rev: 'r', instances: table }] } as unknown as SceneModel;
    expect(selectionStats(scene, [], [])).toBeNull();
    const node = selectionStats(scene, ['n'])!;
    expect(node.scope).toBe('SELECTED');
    expect(node.triangles).toBe(10);
    expect(node.bones).toBe(3);
    const one = selectionStats(scene, ['n'], [{ nodeId: 'n', key: table.key[0] as number }])!;
    expect(one.bones).toBe(1);
    expect(one.triangles).toBe(Math.round(10 / 3));
  });
});

describe('selection overlays are independent of the View mode', () => {
  function fakeViewport(scene: Scene): Viewport {
    return { scene, addBeforeRender: () => () => undefined, requestRender: () => undefined } as unknown as Viewport;
  }
  const sceneOf = (): SceneModel => {
    const { sk, table } = synthetic();
    return { entries: [], skeletons: [{ nodeId: 'n', skeleton: sk, rev: 'r', instances: table }] } as unknown as SceneModel;
  };

  it('draws spines for a selected node in every view mode (ViewModeController never touches the overlay group)', () => {
    const scene = new Scene();
    const content = new Group();
    const skeleton = new Group();
    scene.add(content);
    const surface = { clientWidth: 100, clientHeight: 100 } as unknown as HTMLElement;
    const overlays = new OverlaySystem(fakeViewport(scene), surface, () => undefined);
    overlays.setScene(sceneOf());
    overlays.setState({ nodes: ['n'] });
    expect(overlays.spineObjectCount).toBeGreaterThan(0);
    const modes = new ViewModeController();
    for (const mode of ['shaded', 'wireframe', 'shadedWire', 'flat', 'normals', 'uv', 'ao', 'skeleton'] as const) {
      modes.apply({ root: content, skeleton, bounds: undefined as never, stats: undefined as never, dispose: () => undefined }, mode);
      expect(overlays.group.parent).toBe(scene);
      expect(overlays.group.children.length).toBeGreaterThan(0);
      expect(overlays.group.children.every((o) => o.visible)).toBe(true);
    }
    overlays.dispose();
  });

  it('rebuilds without leaking: spines follow the selection, hidden instances do not draw, dispose empties the group', () => {
    const scene = new Scene();
    const surface = { clientWidth: 100, clientHeight: 100 } as unknown as HTMLElement;
    const overlays = new OverlaySystem(fakeViewport(scene), surface, () => undefined);
    const model = sceneOf();
    overlays.setScene(model);
    overlays.setState({ nodes: ['n'] });
    const withAll = overlays.group.children.length;
    for (let i = 0; i < 5; i++) overlays.setState({ nodes: ['n'] });
    expect(overlays.group.children.length).toBe(withAll);
    overlays.setState({ nodes: [] });
    expect(overlays.group.children.length).toBe(0);
    model.skeletons[0]!.instances!.flags[0] = FLAG_HIDDEN;
    model.skeletons[0]!.instances!.flags[1] = FLAG_HIDDEN;
    model.skeletons[0]!.instances!.flags[2] = FLAG_HIDDEN;
    overlays.setScene(model);
    overlays.setState({ nodes: ['n'] });
    expect(overlays.group.children.length).toBe(0);
    overlays.dispose();
    expect(overlays.group.children.length).toBe(0);
  });

  it('instance selection draws only the picked spines (pink) plus points', () => {
    const group = new Group();
    const layer = new SpineLayer(group);
    const { sk, table } = synthetic();
    layer.rebuild([{ nodeId: 'n', skeleton: sk, table, selectedRows: new Set([1]), hoverRow: -1, scope: 'instances' }], true);
    expect(group.children.length).toBeGreaterThanOrEqual(3);
    layer.rebuild([], true);
    expect(group.children.length).toBe(0);
    layer.dispose();
  });
});
