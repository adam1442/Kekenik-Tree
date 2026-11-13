import { beforeAll, describe, expect, it } from 'vitest';
import { UndoStack } from '@/app/commands/undoStack';
import { GraphSession } from '@/app/graphSession';
import type { AppEvents } from '@/app/context';
import { createAppStore } from '@/app/state';
import { EventBus } from '@/core/eventBus';
import { buildDemoGraph } from './fixtures/demoGraph';
import { PatchNodesCommand } from '@/app/commands/graphCommands';
import { registerDiscoveredNodes } from '@/graph/registry';
import { adaptiveGridStep, fitView, screenToWorld, worldToScreen, zoomAt } from '@/ui/panels/graph/viewTransform';
import { curveCrossesPolyline, edgeGeometry, sampleBezier } from '@/ui/panels/graph/edgeGeometry';

beforeAll(() => registerDiscoveredNodes());

function make(): { s: GraphSession; undo: UndoStack; store: ReturnType<typeof createAppStore>; msgs: string[]; events: EventBus<AppEvents> } {
  const store = createAppStore();
  const undo = new UndoStack(store);
  const events = new EventBus<AppEvents>();
  const msgs: string[] = [];
  const s = new GraphSession({ store, undo, appEvents: events, notify: (m) => msgs.push(m), initialGraph: buildDemoGraph });
  return { s, undo, store, msgs, events };
}

describe('UndoStack', () => {
  it('merges keyed commands until sealed, tracks dirty and per-context histories', () => {
    const { s, undo, store } = make();
    expect(undo.dirty).toBe(false);
    const m = s.model;
    const mk = (x: number): PatchNodesCommand => new PatchNodesCommand(m, 'Move', new Map([['trunk', { x }]]), 'k');
    undo.execute(mk(1));
    undo.execute(mk(2));
    undo.execute(mk(3));
    expect(undo.history()).toHaveLength(1);
    expect(store.get().dirty).toBe(true);
    undo.seal();
    undo.execute(mk(4));
    expect(undo.history()).toHaveLength(2);
    undo.undo();
    expect(m.getNode('trunk')?.x).toBe(3);
    undo.undo();
    expect(m.getNode('trunk')?.x).not.toBe(3);
    expect(undo.history().map((h) => h.undone)).toEqual([true, true]);
    undo.redo();
    undo.redo();
    expect(m.getNode('trunk')?.x).toBe(4);
    undo.markClean();
    expect(undo.dirty).toBe(false);
    undo.undo();
    expect(undo.dirty).toBe(true);
    undo.redo();
    expect(undo.dirty).toBe(false);
    undo.jumpTo(0);
    expect(undo.history().every((h) => h.undone)).toBe(true);
    undo.setContext('other');
    expect(undo.history()).toHaveLength(0);
    undo.setContext('doc-1');
    expect(undo.history()).toHaveLength(2);
  });

  it('respects the history limit', () => {
    const store = createAppStore();
    const undo = new UndoStack(store, 3);
    let n = 0;
    for (let i = 0; i < 6; i++) undo.execute({ label: `c${i}`, do: () => void (n += 1), undo: () => void (n -= 1) });
    expect(undo.history()).toHaveLength(3);
    expect(n).toBe(6);
  });
});

describe('GraphSession editing', () => {
  it('adds nodes under the anchor, with undo/redo, and refuses a second Tree', () => {
    const { s, undo, msgs } = make();
    const n = s.addNode('generator.branch', { anchor: { nodeId: 'cap1' } });
    expect(n).not.toBeNull(); // cap has no children port -> unconnected but still added
    expect(s.model.parentOf(n?.id ?? '')).toBeUndefined();
    const m = s.addNode('generator.leaf', { anchor: { nodeId: 'trunk' } });
    expect(s.model.parentOf(m?.id ?? '')?.id).toBe('trunk');
    expect(s.getSelection()).toEqual([m?.id]);
    undo.undo();
    expect(s.model.hasNode(m?.id ?? '')).toBe(false);
    undo.redo();
    expect(s.model.parentOf(m?.id ?? '')?.id).toBe('trunk');
    expect(s.addNode('output.tree')).toBeNull();
    expect(msgs.at(-1)).toMatch(/Only one/);
  });

  it('attachment nodes added with an anchor are attached to it', () => {
    const { s } = make();
    const f = s.addNode('force.gravity', { anchor: { nodeId: 'big1' } });
    expect(s.model.attachedTo('big1', 'force').map((x) => x.id)).toContain(f?.id);
    expect(s.model.attachmentTargets(f?.id ?? '')).toHaveLength(1);
  });

  it('deletes sub-trees, or dissolves keeping children; protects the root', () => {
    const { s, undo } = make();
    s.setSelection(['big1']);
    s.deleteSelection(false);
    expect(['big1', 'little', 'cap1', 'leaf', 'leaf2', 'leaf3a'].some((id) => s.model.hasNode(id))).toBe(false);
    undo.undo();
    expect(s.model.hierarchyNodes()).toHaveLength(13);
    expect(s.model.parentOf('leaf')?.id).toBe('big1');
    s.setSelection(['big1']);
    s.deleteSelection(true);
    expect(s.model.hasNode('big1')).toBe(false);
    expect(s.model.parentOf('little')?.id).toBe('trunk');
    expect(s.model.parentOf('leaf')?.id).toBe('trunk');
    undo.undo();
    expect(s.model.parentOf('leaf')?.id).toBe('big1');
    s.setSelection(['tree']);
    s.deleteSelection();
    expect(s.model.hasNode('tree')).toBe(true);
  });

  it('reparents with a single history entry and keeps the single-parent rule', () => {
    const { s, undo } = make();
    const before = undo.history().length;
    expect(s.reparentAndPlace('leaf4', 'big2')).toBe(true);
    expect(undo.history()).toHaveLength(before + 1);
    expect(s.model.parentOf('leaf4')?.id).toBe('big2');
    expect(s.model.childrenOf('trunk').map((n) => n.id)).not.toContain('leaf4');
    undo.undo();
    expect(s.model.parentOf('leaf4')?.id).toBe('trunk');
    expect(s.reparentAndPlace('trunk', 'leaf3a')).toBe(false); // cycle
  });

  it('live move + commit makes one undo step; locked nodes ignore flags other than lock', () => {
    const { s, undo } = make();
    const start = new Map([['cap2', { x: s.model.getNode('cap2')?.x ?? 0, y: s.model.getNode('cap2')?.y ?? 0 }]]);
    s.moveLive(new Map([['cap2', { x: 500, y: 500 }]]));
    s.moveLive(new Map([['cap2', { x: 600, y: 600 }]]));
    s.commitMove(start);
    expect(undo.history()).toHaveLength(1);
    undo.undo();
    expect(s.model.getNode('cap2')?.x).toBe(start.get('cap2')?.x);
    s.setSelection(['cap2']);
    s.setFlag('locked', true);
    s.setFlag('enabled', false);
    expect(s.model.getNode('cap2')?.enabled).toBe(true);
  });

  it('copy / paste / duplicate keep internal edges and attach to the right parent', () => {
    const { s } = make();
    s.setSelection(['big1']);
    s.duplicate();
    const sel = s.getSelection();
    expect(sel).toHaveLength(6); // big1 + 5 descendants
    const root = sel.find((id) => s.model.parentOf(id)?.id === 'trunk' && id !== 'big1' && id !== 'big2' && id !== 'leaf4');
    expect(root).toBeDefined();
    s.setSelection(['big2']);
    expect(s.copy()).toBe(true);
    s.setSelection(['leaf4']);
    s.paste();
    expect(s.model.childrenOf('leaf4').length).toBe(3);
  });

  it('auto layout is one undoable entry', () => {
    const { s, undo } = make();
    s.moveLive(new Map([['cap2', { x: 900, y: 900 }]]));
    s.autoLayout('all');
    expect(Math.abs((s.model.getNode('cap2')?.x ?? 0) - 900)).toBeGreaterThan(100);
    expect(undo.history()).toHaveLength(1);
  });

  it('publishes selection and label to the app store; switching documents swaps graphs and histories', () => {
    const { s, store, undo } = make();
    s.setSelection(['trunk', 'big1']);
    expect(store.get().selection).toEqual(['trunk', 'big1']);
    expect(store.get().selectionLabel).toBe('2 nodes');
    s.rename('trunk', 'Stem');
    s.setSelection(['trunk']);
    expect(store.get().selectionLabel).toBe('Stem');
    store.set({ activeDocumentId: 'doc-2' });
    expect(s.model.hierarchyNodes()).toHaveLength(2);
    expect(undo.history()).toHaveLength(0);
    store.set({ activeDocumentId: 'doc-1' });
    expect(s.model.getNode('trunk')?.name).toBe('Stem');
    expect(undo.history()).toHaveLength(1);
  });

  it('setParam merges scrubs into one entry; attachment summary counts forces for the selection', () => {
    const { s, undo } = make();
    s.setParam('trunk', 'number', { value: 10 }, true);
    s.setParam('trunk', 'number', { value: 20 }, true);
    s.setParam('trunk', 'number', { value: 30 }, true);
    expect(undo.history()).toHaveLength(1);
    expect(s.model.getNode('trunk')?.params.number?.value).toBe(30);
    s.endGesture();
    undo.undo();
    expect(s.model.getNode('trunk')?.params.number?.value).toBe(1);
    s.setSelection(['trunk']);
    expect(s.attachmentSummary().find((x) => x.category === 'force')?.count).toBe(2);
    s.setSelection(['leaf']);
    expect(s.attachmentSummary().find((x) => x.category === 'force')?.count).toBe(0);
    expect(s.attachmentSummary().find((x) => x.category === 'material')?.count).toBe(3);
  });

  it('emits graph:changed for edits', () => {
    const { s, events } = make();
    let n = 0;
    events.on('graph:changed', () => (n += 1));
    s.rename('trunk', 'X');
    expect(n).toBeGreaterThan(0);
  });
});

describe('view math & edge geometry', () => {
  it('zoomAt keeps the point under the cursor fixed; fit centres; grid step is adaptive', () => {
    const v = { x: 10, y: 20, k: 1 };
    const w = screenToWorld(v, 100, 100);
    const z = zoomAt(v, 100, 100, 2);
    const back = worldToScreen(z, w.x, w.y);
    expect(back.x).toBeCloseTo(100);
    expect(back.y).toBeCloseTo(100);
    const f = fitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 400, 300, 0, 10);
    expect(f.k).toBeCloseTo(3);
    expect(worldToScreen(f, 50, 50)).toEqual({ x: 200, y: 150 });
    const step = adaptiveGridStep(0.1, 13) * 0.1;
    expect(step).toBeGreaterThanOrEqual(12);
    expect(step).toBeLessThan(60);
  });

  it('detects edges crossed by a cut line', () => {
    const geo = edgeGeometry({ x: 0, y: 0 }, { x: 0, y: -52 });
    const curve = sampleBezier(geo.pts, 20);
    expect(curveCrossesPolyline(curve, [{ x: -20, y: -25.3 }, { x: 20, y: -25.3 }])).toBe(true);
    expect(curveCrossesPolyline(curve, [{ x: 30, y: -26 }, { x: 60, y: -26 }])).toBe(false);
  });
});
