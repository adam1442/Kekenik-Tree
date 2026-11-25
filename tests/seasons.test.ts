import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UndoStack } from '@/app/commands/undoStack';
import type { AppContext, AppEvents } from '@/app/context';
import { starterGraph } from './fixtures/starterGraph';
import { GraphSession } from '@/app/graphSession';
import { findTreeNode, getSeason, setSeason } from '@/app/seasonControl';
import { createAppStore } from '@/app/state';
import { CancellationSource } from '@/contracts/nodes';
import { flatCurve, linearCurve } from '@/contracts/curve';
import type { MaterialDef, MaterialSetDef } from '@/contracts/material';
import type { SceneEntry } from '@/contracts/engine';
import { EventBus } from '@/core/eventBus';
import { Rng } from '@/core/rng';
import { exportEntries } from '@/export/exportService';
import { GraphEvaluator, snapshotGraph, type GraphSnapshot } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import { createMaterialDef } from '@/materials/shadingMath';
import { memberWeight, pickFromSet, resolveMaterialRef, setMaterialSource, type MaterialSource } from '@/materials/materialSource';
import { getSeasonForceType } from '@/forces';
import { loadSample, SAMPLE_IDS } from './helpers/sampleProjects';
import { seasonLightDelay, seasonWindOffset, transitionValue } from '@/seasons';

beforeAll(() => registerDiscoveredNodes());
afterEach(() => setMaterialSource(null));

const mat = (id: string, season: MaterialDef['season'] = null): MaterialDef => ({ ...createMaterialDef(id, id), season });
/** A: full at the start of the year, gone at its end. B: the opposite. */
const A = mat('a', linearCurve(1, 0));
const B = mat('b', linearCurve(0, 1));
const SET: MaterialSetDef = { id: 'set1', name: 'Seasons', overrideSeason: false, season: null, members: [{ id: 'm1', materialId: 'a', weight: 1 }, { id: 'm2', materialId: 'b', weight: 1 }] };

function install(materials: MaterialDef[], sets: MaterialSetDef[]): MaterialSource {
  const src: MaterialSource = { materials: () => materials, sets: () => sets, displacements: () => [], masks: () => [], season: () => 0.5 };
  setMaterialSource(src);
  return src;
}

type Params = Record<string, unknown>;

/** A parameter patch that sets value AND variance (instead of just the value). */
interface StatePatch { state: { value: number; variance: number } }
const withVariance = (value: number, variance: number): StatePatch => ({ state: { value, variance } });
const isStatePatch = (v: unknown): v is StatePatch => typeof v === 'object' && v !== null && 'state' in v;

function buildModel(patches: Record<string, Params> = {}): GraphModel {
  const m = new GraphModel();
  m.load(starterGraph());
  for (const [id, params] of Object.entries(patches)) {
    const node = m.getNode(id);
    if (!node) throw new Error(`no node ${id}`);
    for (const [pid, value] of Object.entries(params)) {
      const cur = node.params[pid];
      if (!cur) throw new Error(`missing ${id}.${pid}`);
      m.setParam(id, pid, (isStatePatch(value) ? { ...cur, ...value.state } : { ...cur, value }) as typeof cur);
    }
  }
  return m;
}

const evaluate = (snap: GraphSnapshot) => new GraphEvaluator().evaluate(snap, { seed: 1, lod: 0, token: new CancellationSource().token, collision: false });
const LEAF_ROWS = [{ material: 'set1', mesh: 'any', weight: 1 }];
const leafNode = (extra: Params = {}): Record<string, Params> => ({ leaf: { leafTypes: LEAF_ROWS, ...extra } });
const run = (patches: Record<string, Params>) => evaluate(snapshotGraph(buildModel(patches)));
const leafEntry = (s: Awaited<ReturnType<typeof run>>): SceneEntry | undefined => s.scene.entries.find((e) => e.type === 'generator.leaf' && !e.ground);
const groundEntry = (s: Awaited<ReturnType<typeof run>>): SceneEntry | undefined => s.scene.entries.find((e) => e.ground);
const materialsOf = (e: SceneEntry | undefined): Map<string, number> => new Map((e?.mesh.slots ?? []).map((x) => [x.materialId, x.indexCount]));
const sameBuffers = (a: SceneEntry | undefined, b: SceneEntry | undefined): boolean =>
  a !== undefined && b !== undefined && a.mesh.positions.length === b.mesh.positions.length && a.mesh.positions.every((v, i) => v === (b.mesh.positions[i] as number));

describe('transition value', () => {
  it('is 0 at the start, delayed by positive offsets and scaled by the time scale', () => {
    expect(transitionValue(0, 0, 1)).toBe(0);
    expect(transitionValue(0.5, 0, 1)).toBeCloseTo(0.5);
    expect(transitionValue(0.5, 0.25, 1)).toBeCloseTo(0.25);
    expect(transitionValue(0.5, -0.25, 1)).toBeCloseTo(0.75);
    expect(transitionValue(0.5, 0, 2)).toBe(1);
    expect(transitionValue(0.5, 0, 0)).toBe(0);
    expect(transitionValue(0.5, 0, 1, 0.5)).toBe(0);
  });
});

describe('weighted choice with season curves', () => {
  it('probability = weight x curve value at the transition value', () => {
    const mats = [A, B];
    for (const t of [0, 0.25, 0.5, 0.9]) {
      const wa = memberWeight(SET, SET.members[0]!, mats, t);
      const wb = memberWeight(SET, SET.members[1]!, mats, t);
      expect(wa).toBeCloseTo(1 - t);
      expect(wb).toBeCloseTo(t);
      const rng = new Rng(99);
      let a = 0;
      const n = 6000;
      for (let i = 0; i < n; i++) if (pickFromSet(SET, mats, t, rng) === 'a') a += 1;
      expect(a / n).toBeCloseTo(wa / (wa + wb), 1);
    }
  });

  it('member weights multiply the curve and resolveMaterialRef uses the node transition value', () => {
    const heavy: MaterialSetDef = { ...SET, members: [{ id: 'm1', materialId: 'a', weight: 3 }, { id: 'm2', materialId: 'b', weight: 1 }] };
    expect(memberWeight(heavy, heavy.members[0]!, [A, B], 0.5)).toBeCloseTo(1.5);
    const src = install([A, B], [SET]);
    const rng = () => new Rng(5);
    expect(resolveMaterialRef('set1', rng(), src, 0)).toBe('a');
    expect(resolveMaterialRef('set1', rng(), src, 1)).toBe('b');
  });

  it('a set override replaces every member curve', () => {
    const over: MaterialSetDef = { ...SET, overrideSeason: true, season: flatCurve(0) };
    expect(memberWeight(over, over.members[0]!, [A, B], 0)).toBe(0);
    const keep: MaterialSetDef = { ...SET, overrideSeason: true, season: flatCurve(1) };
    expect(memberWeight(keep, keep.members[1]!, [A, B], 0)).toBe(1);
  });
});

describe('generators and the slider', () => {
  it('with untouched curves and offsets the slider changes nothing (bit identical)', async () => {
    install([mat('a'), mat('b')], [SET]);
    const base = await run(leafNode());
    const late = await run({ ...leafNode(), tree: { season: 1 } });
    const mid = await run({ ...leafNode(), tree: { season: 0.4 } });
    for (const other of [late, mid]) {
      expect(other.scene.entries.length).toBe(base.scene.entries.length);
      other.scene.entries.forEach((e, i) => {
        const b = base.scene.entries[i] as SceneEntry;
        expect(e.mesh.positions.length).toBe(b.mesh.positions.length);
        expect(e.mesh.positions.every((v, k) => v === (b.mesh.positions[k] as number))).toBe(true);
        expect(e.mesh.slots).toEqual(b.mesh.slots);
      });
    }
  }, 120_000);

  it('the slider moves the probabilities of curved materials; all members stay assigned', async () => {
    install([A, B], [SET]);
    const early = materialsOf(leafEntry(await run({ ...leafNode(), tree: { season: 0 } })));
    const late = materialsOf(leafEntry(await run({ ...leafNode(), tree: { season: 1 } })));
    const mid = materialsOf(leafEntry(await run({ ...leafNode(), tree: { season: 0.5 } })));
    expect([...early.keys()]).toEqual(['a']);
    expect([...late.keys()]).toEqual(['b']);
    expect(mid.get('a')).toBeGreaterThan(0);
    expect(mid.get('b')).toBeGreaterThan(0);
  }, 120_000);

  it('Descendant offset shifts the node and its children', async () => {
    install([A, B], [SET]);
    const plain = materialsOf(leafEntry(await run({ ...leafNode(), tree: { season: 0.5 } })));
    expect(plain.has('b')).toBe(true);
    const shifted = materialsOf(leafEntry(await run({ ...leafNode(), tree: { season: 0.5 }, big: { seasonDescendantOffset: 0.5 } })));
    expect([...shifted.keys()]).toEqual(['a']);
    // The Start offset of the leaf alone does the same for the leaves only.
    const delayed = materialsOf(leafEntry(await run({ ...leafNode({ seasonStartOffset: 0.5 }), tree: { season: 0.5 } })));
    expect([...delayed.keys()]).toEqual(['a']);
  }, 120_000);

  it('Season gravity bends the branches only while the season advanced, deterministically', async () => {
    const branch = (s: Awaited<ReturnType<typeof run>>): SceneEntry | undefined => s.scene.entries.find((e) => e.nodeId === 'little');
    const base = branch(await run({}));
    const atStart = branch(await run({ little: { seasonGravity: 0.8 }, tree: { season: 0 } }));
    const bent = await run({ little: { seasonGravity: 0.8 }, tree: { season: 0.8 } });
    const again = await run({ little: { seasonGravity: 0.8 }, tree: { season: 0.8 } });
    const noGravity = branch(await run({ tree: { season: 0.8 } }));
    expect(sameBuffers(atStart, base)).toBe(true);
    expect(sameBuffers(noGravity, base)).toBe(true);
    expect(sameBuffers(branch(bent), base)).toBe(false);
    expect(sameBuffers(branch(bent), branch(again))).toBe(true);
    const meanZ = (e: SceneEntry | undefined): number => {
      const p = e?.mesh.positions ?? new Float32Array(0);
      let s = 0;
      for (let i = 2; i < p.length; i += 3) s += p[i] as number;
      return s / (p.length / 3);
    };
    expect(meanZ(branch(bent))).toBeLessThan(meanZ(base));
  }, 120_000);

  it('dropped leaves: the ground gets exactly the leaves whose life finished', async () => {
    install([mat('a'), mat('b')], [SET]);
    const total = leafEntry(await run({ ...leafNode(), tree: { season: 0.9 } }))!.mesh.positions.length;
    const spread = { seasonStartOffset: withVariance(0.3, 0.9) };
    const patches = (season: number, show: boolean): Record<string, Params> => ({ ...leafNode(spread), tree: { season, showDroppedLeaves: show } });
    // Nothing is dropped without the checkbox or before the end of life.
    const off = await run(patches(1, false));
    expect(groundEntry(off)).toBeUndefined();
    const early = await run(patches(0, true));
    expect(groundEntry(early)).toBeUndefined();
    const plain = leafEntry(await run(patches(0.9, false)))!;
    const split = await run(patches(0.9, true));
    const kept = leafEntry(split)?.mesh.positions.length ?? 0;
    const ground = groundEntry(split);
    expect(ground).toBeDefined();
    const dropped = ground!.mesh.positions.length;
    expect(dropped).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
    expect(kept + dropped).toBe(plain.mesh.positions.length);
    expect(plain.mesh.positions.length).toBe(total);
    // The ground cards lie on z ~ 0, carry no wind and are flagged.
    const p = ground!.mesh.positions;
    for (let i = 2; i < p.length; i += 3) expect(Math.abs(p[i] as number)).toBeLessThan(0.2);
    expect(ground!.wind?.amount).toBe(0);
    expect(ground!.mesh.wind).toBeUndefined();
    // Every leaf finished at the end of the year.
    const all = await run({ ...leafNode(), tree: { season: 1, showDroppedLeaves: true } });
    expect(leafEntry(all)).toBeUndefined();
    expect(groundEntry(all)!.mesh.positions.length).toBe(total);
  }, 180_000);

  it('Season wind sweeps the dropped leaves and Season light delays or advances leaves', () => {
    const wind = [{ id: 'w', name: 'w', type: 'seasonWind', enabled: true, params: { direction: { value: [1, 0, 0] }, strength: { value: 1 }, distance: { value: 5 } } }];
    const [x, y] = seasonWindOffset(wind, 1);
    expect(x).toBeCloseTo(5);
    expect(y).toBeCloseTo(0);
    const light = [{ id: 'l', name: 'l', type: 'seasonLight', enabled: true, params: { direction: { value: [0, 0, 1] }, strength: { value: 1 } } }];
    expect(seasonLightDelay(light, [0, 0, 1])).toBeLessThan(0);
    expect(seasonLightDelay(light, [0, 0, -1])).toBeGreaterThan(0);
    expect(seasonLightDelay([], [0, 0, 1])).toBe(0);
    expect(getSeasonForceType('seasonLight')?.role).toBe('light');
    expect(getSeasonForceType('seasonWind')?.role).toBe('wind');
  });
});

describe('export', () => {
  it('uses the materials resolved at the current season and drops ground leaves unless asked', async () => {
    install([A, B], [SET]);
    const winter = await run({ ...leafNode(), tree: { season: 1, showDroppedLeaves: true } });
    expect(winter.scene.season).toEqual({ value: 1, showDropped: true, exportDropped: false });
    expect(groundEntry(winter)).toBeDefined();
    const kept = exportEntries(winter.scene);
    expect(kept.some((e) => e.ground)).toBe(false);
    const withGround = await run({ ...leafNode(), tree: { season: 1, showDroppedLeaves: true, exportDroppedLeaves: true } });
    expect(exportEntries(withGround.scene).some((e) => e.ground)).toBe(true);
    const spring = await run({ ...leafNode(), tree: { season: 0 } });
    const used = new Set(spring.scene.entries.flatMap((e) => e.mesh.slots.map((s) => s.materialId)));
    expect(used.has('b')).toBe(false);
    expect(used.has('a')).toBe(true);
  }, 120_000);
});

describe('slider command', () => {
  function app(): { ctx: AppContext; undo: UndoStack; session: GraphSession } {
    const store = createAppStore();
    const undo = new UndoStack(store);
    const events = new EventBus<AppEvents>();
    const session = new GraphSession({ store, undo, appEvents: events, notify: () => undefined, initialGraph: (model) => model.load(starterGraph()) });
    const settings = { season: 0 };
    const ctx = { graph: session, store, undo, events, project: { metaOf: () => ({ settings }) } } as unknown as AppContext;
    return { ctx, undo, session };
  }

  it('is an undoable Tree edit and a drag merges into one step', () => {
    const { ctx, undo, session } = app();
    expect(findTreeNode(session.model)).toBeDefined();
    expect(getSeason(ctx)).toBe(0);
    setSeason(ctx, 0.2, true);
    setSeason(ctx, 0.6, true);
    expect(getSeason(ctx)).toBeCloseTo(0.6);
    undo.undo();
    expect(getSeason(ctx)).toBe(0);
    undo.redo();
    expect(getSeason(ctx)).toBeCloseTo(0.6);
    setSeason(ctx, 5);
    expect(getSeason(ctx)).toBe(1);
  });
});

describe('sample projects', () => {
  it.each(SAMPLE_IDS)('%s: the Tree season parameter and every Material Set member are valid', (id) => {
    const p = loadSample(id);
    const model = GraphModel.fromJSON(p.graph);
    const season = model.getNode('tree')?.params.season?.value;
    if (season !== undefined) expect(Number(season)).toBeGreaterThanOrEqual(0);
    if (season !== undefined) expect(Number(season)).toBeLessThanOrEqual(1);
    const ids = new Set(p.materials.map((m) => m.id));
    for (const set of p.materialSets ?? []) for (const member of set.members) expect(ids.has(member.materialId), `${id}: ${set.name}`).toBe(true);
  });
});
