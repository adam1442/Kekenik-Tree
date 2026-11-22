import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import type { CutoutMesh, MaterialDef, MaterialSetDef } from '@/contracts/material';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { getNodeDef, migrateNodeParams, registerDiscoveredNodes } from '@/graph/registry';
import { MaterialLibrary, type LibraryMeta } from '@/materials/library';
import { createDefaultCutoutMesh } from '@/materials/cutouts/ops';
import { rebuildCutoutLods } from '@/materials/cutouts/lod';
import { setMaterialSource, type MaterialSource } from '@/materials/materialSource';
import {
  materialChoices,
  meshChoices,
  migrateLegacyMaterialParam,
  ownedMeshRefs,
  pickMaterialMesh,
  pickWeightedIndex,
  readMaterialSlots,
  reconcileMaterialMeshes,
  resolveMaterial,
  selectMesh,
  slotProbabilities,
  type MaterialSlotRow,
} from '@/materials/meshSelection';
import { createMaterialDef } from '@/materials/shadingMath';
import { parseProject } from '@/app/project/format';
import { buildFrondSpecs } from '@/nodes/generators/frond';

beforeAll(() => registerDiscoveredNodes());

const refs = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }));

function cutout(id: string, materialId: string, outline: [number, number][] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]): CutoutMesh {
  const c = createDefaultCutoutMesh(id, `Mesh ${id}`, materialId);
  c.outline = outline;
  c.interiorPoints = [];
  rebuildCutoutLods(c);
  return c;
}

function source(materials: MaterialDef[], cutouts: CutoutMesh[], sets: MaterialSetDef[] = [], season = 0.5): MaterialSource {
  return { materials: () => materials, sets: () => sets, displacements: () => [], masks: () => [], cutoutMeshes: () => cutouts, season: () => season };
}

afterEach(() => setMaterialSource(null));

describe('selectMesh', () => {
  const mat = { meshes: refs('a', 'b', 'c', 'd') };

  it('primary is always index 0', () => {
    const rng = new Rng(1);
    for (let i = 0; i < 20; i++) expect(selectMesh(mat, 'primary', rng)?.id).toBe('a');
  });

  it('notPrimary never returns index 0 and covers every other mesh', () => {
    const rng = new Rng(2);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(selectMesh(mat, 'notPrimary', rng)?.id ?? '');
    expect([...seen].sort()).toEqual(['b', 'c', 'd']);
  });

  it('notPrimary falls back to the primary when there is only one mesh', () => {
    expect(selectMesh({ meshes: refs('only') }, 'notPrimary', new Rng(3))?.id).toBe('only');
  });

  it('any covers all meshes and is deterministic for a seed', () => {
    const run = (seed: number): (string | undefined)[] => {
      const rng = new Rng(seed);
      return Array.from({ length: 40 }, () => selectMesh(mat, 'any', rng)?.id);
    };
    expect(run(7)).toEqual(run(7));
    expect(new Set(run(7)).size).toBe(4);
    expect(run(7)).not.toEqual(run(8));
  });

  it('a specific id selects that mesh; an unknown id falls back to primary', () => {
    const rng = new Rng(4);
    expect(selectMesh(mat, 'c', rng)?.id).toBe('c');
    expect(selectMesh(mat, 'gone', rng)?.id).toBe('a');
  });

  it('returns null without meshes and draws nothing when there is no real choice', () => {
    const rng = new Rng(5);
    expect(selectMesh({ meshes: [] }, 'any', rng)).toBeNull();
    selectMesh({ meshes: refs('x') }, 'any', rng);
    expect(rng.next()).toBe(new Rng(5).next());
  });
});

describe('weights', () => {
  it('probability of a row is weight / sum(weights)', () => {
    expect(slotProbabilities([{ weight: 1 }, { weight: 3 }])).toEqual([0.25, 0.75]);
    expect(slotProbabilities([{ weight: 0 }, { weight: 0 }])).toEqual([0, 0]);
    expect(pickWeightedIndex([0, 0], 0.5)).toBe(-1);
    expect(pickWeightedIndex([0, 2, 0], 0.99)).toBe(1);
  });

  it('pickMaterialMesh draws rows with the configured distribution', () => {
    const a = createMaterialDef('a', 'A');
    const b = createMaterialDef('b', 'B');
    const src = source([a, b], []);
    const rows: MaterialSlotRow[] = [
      { material: 'a', mesh: 'any', weight: 1 },
      { material: 'b', mesh: 'any', weight: 3 },
    ];
    const rng = new Rng(11);
    const N = 8000;
    let countB = 0;
    for (let i = 0; i < N; i++) if (pickMaterialMesh(rows, { rng, fallbackMaterial: 'leaf', src }).materialId === 'b') countB++;
    expect(countB / N).toBeGreaterThan(0.72);
    expect(countB / N).toBeLessThan(0.78);
  });

  it('a zero-weight row is never chosen', () => {
    const src = source([createMaterialDef('a', 'A'), createMaterialDef('b', 'B')], []);
    const rows: MaterialSlotRow[] = [
      { material: 'a', mesh: 'any', weight: 0 },
      { material: 'b', mesh: 'any', weight: 1 },
    ];
    const rng = new Rng(12);
    for (let i = 0; i < 300; i++) expect(pickMaterialMesh(rows, { rng, fallbackMaterial: 'leaf', src }).materialId).toBe('b');
  });
});

describe('pickMaterialMesh', () => {
  const m1 = createMaterialDef('m1', 'M1');
  const m2 = createMaterialDef('m2', 'M2');
  const cuts = [cutout('c1', 'm1'), cutout('c2', 'm1'), cutout('c3', 'm1'), cutout('d1', 'm2')];
  reconcileMaterialMeshes([m1, m2], cuts);
  const src = source([m1, m2], cuts);

  it('honours the Mesh selector of the row', () => {
    const rng = new Rng(1);
    const pick = (mesh: string): string | undefined => pickMaterialMesh([{ material: 'm1', mesh, weight: 1 }], { rng, fallbackMaterial: 'leaf', src }).meshAsset?.id;
    expect(pick('primary')).toBe('c1');
    expect(['c2', 'c3']).toContain(pick('notPrimary'));
    expect(pick('c3')).toBe('c3');
    expect(pick('Mesh c2')).toBe('c2');
    expect(pick('none')).toBeUndefined();
  });

  it('returns the chosen mesh LOD variants', () => {
    const r = pickMaterialMesh([{ material: 'm2', mesh: 'primary', weight: 1 }], { rng: new Rng(1), fallbackMaterial: 'leaf', src });
    expect(r.meshAsset?.id).toBe('d1');
    expect(r.lodMeshes).toBe(r.meshAsset?.lods);
    expect(r.material?.id).toBe('m2');
  });

  it('falls back to the unit-square placeholder for None, mesh-less and unknown materials', () => {
    const bare = createMaterialDef('bare', 'Bare');
    const s2 = source([m1, bare], cuts);
    for (const material of ['', 'bare', 'nope']) {
      const r = pickMaterialMesh([{ material, mesh: 'any', weight: 1 }], { rng: new Rng(1), fallbackMaterial: 'leaf', src: s2 });
      expect(r.meshAsset).toBeNull();
      expect(r.lodMeshes).toBeNull();
      expect(r.materialId).toBe(material || 'leaf');
    }
    const none = pickMaterialMesh([], { rng: new Rng(1), fallbackMaterial: 'leaf', src: null });
    expect(none.meshAsset).toBeNull();
    expect(none.materialId).toBe('leaf');
  });

  it('is deterministic for the same seed', () => {
    const rows: MaterialSlotRow[] = [
      { material: 'm1', mesh: 'any', weight: 2 },
      { material: 'm2', mesh: 'any', weight: 1 },
    ];
    const run = (): (string | undefined)[] => {
      const rng = new Rng(99);
      return Array.from({ length: 50 }, () => pickMaterialMesh(rows, { rng, fallbackMaterial: 'leaf', src }).meshAsset?.id);
    };
    expect(run()).toEqual(run());
  });
});

describe('Material Sets and seasons', () => {
  it('resolveMaterial picks a set member by weight and season, plain materials draw nothing', () => {
    const a = createMaterialDef('a', 'Summer');
    const b = createMaterialDef('b', 'Autumn');
    const set: MaterialSetDef = {
      id: 'set1',
      name: 'Seasons',
      overrideSeason: false,
      season: null,
      members: [
        { id: 'x', materialId: 'a', weight: 1 },
        { id: 'y', materialId: 'b', weight: 1 },
      ],
    };
    const src = source([a, b], [], [set]);
    const rng = new Rng(5);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(resolveMaterial({ material: 'set1' }, 0.5, rng, src));
    expect([...seen].sort()).toEqual(['a', 'b']);
    const plain = new Rng(5);
    expect(resolveMaterial({ material: 'a' }, 0.5, plain, src)).toBe('a');
    expect(plain.next()).toBe(new Rng(5).next());
    expect(resolveMaterial({ material: '' }, 0.5, plain, src)).toBe('');
  });
});

describe('migration', () => {
  it('reconcile derives the ordered list of an old material from the cutouts and drops stale refs', () => {
    const m = createMaterialDef('m', 'M');
    delete (m as Partial<MaterialDef>).meshes;
    const other = createMaterialDef('o', 'O');
    other.meshes = refs('c1');
    const cuts = [cutout('c1', 'm'), cutout('c2', 'm'), cutout('c3', 'o')];
    expect(reconcileMaterialMeshes([m, other], cuts)).toBe(true);
    expect(m.meshes.map((r) => r.id)).toEqual(['c1', 'c2']);
    expect(other.meshes.map((r) => r.id)).toEqual(['c3']);
    expect(reconcileMaterialMeshes([m, other], cuts)).toBe(false);
  });

  it('keeps a stored custom order and appends unreferenced meshes', () => {
    const m = createMaterialDef('m', 'M');
    m.meshes = refs('c2', 'c1');
    const cuts = [cutout('c1', 'm'), cutout('c2', 'm'), cutout('c3', 'm')];
    expect(ownedMeshRefs(m, cuts).map((r) => r.id)).toEqual(['c2', 'c1', 'c3']);
  });

  it('parseProject migrates a project saved with a single cutout (and materials without cutouts get [])', () => {
    const old = {
      version: 1,
      name: 'old',
      graph: { nodes: [], edges: [] },
      settings: { seed: 1 },
      materials: [{ ...createMaterialDef('leaf', 'Leaf') }, { ...createMaterialDef('bark', 'Bark') }],
      cutoutMeshes: [cutout('only', 'leaf')],
    } as Record<string, unknown>;
    for (const m of old.materials as Partial<MaterialDef>[]) delete m.meshes;
    const p = parseProject(JSON.parse(JSON.stringify(old)));
    const leaf = p.materials.find((m) => m.id === 'leaf');
    const bark = p.materials.find((m) => m.id === 'bark');
    expect(leaf?.meshes).toEqual([{ id: 'only' }]);
    expect(bark?.meshes).toEqual([]);
  });

  it('the single legacy `material` param becomes a one-row list', () => {
    const p: NodeParams = { meshMaterial: { value: 'bark' } };
    expect(readMaterialSlots(p, 'meshTypes', 'meshMaterial')).toEqual([{ material: 'bark', mesh: 'any', weight: 1 }]);
    const migrated = migrateLegacyMaterialParam(p, 'meshTypes', 'meshMaterial');
    expect(migrated.meshTypes?.value).toEqual([{ material: 'bark', mesh: 'any', weight: 1 }]);
    expect(migrated.meshMaterial).toBeUndefined();
    expect(migrateLegacyMaterialParam(migrated, 'meshTypes', 'meshMaterial')).toBe(migrated);
    expect(readMaterialSlots({})).toEqual([{ material: '', mesh: 'any', weight: 1 }]);
  });

  it('Mesh Instance nodes saved at version 1 are migrated through the node registry', () => {
    const out = migrateNodeParams('generator.meshes', { meshMaterial: { value: 'leaf' }, meshScale: { value: 0.3 } }, 1);
    expect(out.meshTypes?.value).toEqual([{ material: 'leaf', mesh: 'any', weight: 1 }]);
    expect(out.meshScale?.value).toBe(0.3);
  });
});

describe('UI option lists', () => {
  it('offers Any / Primary / Not primary plus the named meshes of the material', () => {
    const m = createMaterialDef('m', 'M');
    const cuts = [cutout('c1', 'm'), cutout('c2', 'm')];
    reconcileMaterialMeshes([m], cuts);
    const src = source([m], cuts);
    expect(meshChoices('m', src).map((o) => o.label)).toEqual(['Any', 'Primary', 'Not primary', 'Mesh c1', 'Mesh c2']);
    expect(meshChoices('', src).map((o) => o.value)).toEqual(['any', 'primary', 'notPrimary']);
    expect(materialChoices({ materials: () => [m], sets: () => [{ id: 's', name: 'S', overrideSeason: false, members: [] }] }).map((o) => o.label)).toEqual(['None', 'M', 'Set: S']);
  });
});

describe('MaterialLibrary mesh ownership', () => {
  function makeLib(): { lib: MaterialLibrary; meta: LibraryMeta; undo: () => void } {
    const leaf = createMaterialDef('leaf', 'Leaf');
    const meta: LibraryMeta = { materials: [leaf], cutoutMeshes: [cutout('c1', 'leaf'), cutout('c2', 'leaf')], assets: [] };
    const stack: { undo(): void }[] = [];
    const lib = new MaterialLibrary();
    lib.bind(() => meta, {
      execute: (cmd) => {
        cmd.do();
        stack.push(cmd);
      },
    });
    return { lib, meta, undo: () => stack.pop()?.undo() };
  }
  const order = (lib: MaterialLibrary): string[] => (lib.material('leaf')?.meshes ?? []).map((r) => r.id);

  it('derives refs, appends added meshes and reorders (first = Primary) with undo', () => {
    const { lib, undo } = makeLib();
    expect(order(lib)).toEqual(['c1', 'c2']);
    const id = lib.add('meshes', 'leaf');
    expect(order(lib)).toEqual(['c1', 'c2', id]);
    lib.moveMesh(id, -2);
    expect(order(lib)).toEqual([id, 'c1', 'c2']);
    expect(lib.cutoutsForMaterial('leaf')[0]?.id).toBe(id);
    undo();
    expect(order(lib)).toEqual(['c1', 'c2', id]);
    lib.moveMesh('c1', -1);
    expect(order(lib)).toEqual(['c1', 'c2', id]);
  });

  it('duplicates a mesh right after its source and removes refs on delete', () => {
    const { lib } = makeLib();
    const copy = lib.duplicate('meshes', 'c1');
    expect(order(lib)).toEqual(['c1', copy, 'c2']);
    lib.remove('meshes', 'c1');
    expect(order(lib)).toEqual([copy, 'c2']);
  });

  it('a duplicated material owns copies of the source meshes', () => {
    const { lib } = makeLib();
    const dup = lib.duplicate('materials', 'leaf');
    const copy = lib.material(dup);
    expect(copy?.meshes.length).toBe(2);
    expect(copy?.meshes.some((r) => r.id === 'c1' || r.id === 'c2')).toBe(false);
    expect(lib.cutoutsForMaterial(dup ?? '').every((c) => c.materialId === dup)).toBe(true);
    expect(order(lib)).toEqual(['c1', 'c2']);
  });
});

describe('generators read the Material list', () => {
  function stem(): Skeleton {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.03);
    sb.endBranch();
    return sb.build();
  }
  function run(type: string, over: Record<string, unknown>, seed = 1): Record<string, { kind: string; value: unknown }> {
    const def = getNodeDef(type);
    if (!def) throw new Error(`${type} missing`);
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = defaultParamState(d);
    for (const [k, v] of Object.entries(over)) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
    const ctx: NodeContext = { nodeId: type, name: type, rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod: 0, logger: createLogger('dev', 'error') };
    const inputs: NodeInputs = { parent: [{ kind: 'Structure', value: { skeleton: stem() } }] };
    return def.evaluate(ctx, inputs, p) as Record<string, { kind: string; value: unknown }>;
  }
  const indexCount = (o: Record<string, { value: unknown }>): number => (o.geometry?.value as { indices: Uint32Array }).indices.length;

  function install(): void {
    const m = createMaterialDef('m', 'M');
    const tri = cutout('tri', 'm', [[0.5, 0], [1, 1], [0, 1]]);
    const hex = cutout('hex', 'm', [[0.5, 0], [0.9, 0.2], [1, 0.6], [0.5, 1], [0, 0.6], [0.1, 0.2]]);
    const cuts = [tri, hex];
    reconcileMaterialMeshes([m], cuts);
    setMaterialSource(source([m], cuts));
  }

  it('Leaf: Primary / Not primary pick different meshes of the same material', () => {
    install();
    const leaf = (mesh: string): number => indexCount(run('generator.leaf', { number: 1, first: 0.5, last: 0.5, leafTypes: [{ material: 'm', mesh, weight: 1 }] }));
    const primary = leaf('primary');
    const notPrimary = leaf('notPrimary');
    expect(primary).toBeGreaterThan(0);
    expect(notPrimary).toBeGreaterThan(0);
    expect(primary).not.toBe(notPrimary);
  });

  it('Leaf: a None row renders the unit-square placeholder card', () => {
    install();
    const quad = indexCount(run('generator.leaf', { number: 1, first: 0.5, last: 0.5, leafTypes: [{ material: '', mesh: 'any', weight: 1 }] }));
    expect(quad).toBeGreaterThan(0);
  });

  it('Frond: uses the cutout mesh when present, the ribbon otherwise', () => {
    install();
    const def = getNodeDef('generator.frond');
    if (!def) throw new Error('Frond missing');
    const params = (types: unknown): NodeParams => {
      const p: NodeParams = {};
      for (const d of def.params) p[d.id] = defaultParamState(d);
      p.leafTypes = { ...(p.leafTypes as NodeParams[string]), value: types as never };
      return p;
    };
    const ctx: NodeContext = { nodeId: 'f', name: 'f', rng: new Rng(1), seed: 1, cancel: new CancellationSource().token, lod: 0, logger: createLogger('dev', 'error') };
    const withMesh = buildFrondSpecs(ctx, stem(), params([{ material: 'm', mesh: 'primary', weight: 1 }]));
    expect(withMesh.specs.length).toBeGreaterThan(0);
    expect(withMesh.specs.every((s) => s.mesh !== null)).toBe(true);
    const ribbon = buildFrondSpecs(ctx, stem(), params([{ material: '', mesh: 'any', weight: 1 }]));
    expect(ribbon.specs.length).toBeGreaterThan(0);
    expect(ribbon.specs.every((s) => s.mesh === null)).toBe(true);
    const out = run('generator.frond', { leafTypes: [{ material: 'm', mesh: 'primary', weight: 1 }] });
    expect(indexCount(out)).toBeGreaterThan(0);
  });

  it('Mesh Instance: mixes the meshes of the material list deterministically', () => {
    install();
    const over = { number: 12, first: 0.1, last: 1, primitive: 'cone', meshTypes: [{ material: 'm', mesh: 'any', weight: 1 }] };
    const a = run('generator.meshes', over, 3);
    const b = run('generator.meshes', over, 3);
    expect(indexCount(a)).toBeGreaterThan(0);
    expect(indexCount(a)).toBe(indexCount(b));
    const onlyTri = run('generator.meshes', { ...over, meshTypes: [{ material: 'm', mesh: 'tri', weight: 1 }] }, 3);
    const onlyHex = run('generator.meshes', { ...over, meshTypes: [{ material: 'm', mesh: 'hex', weight: 1 }] }, 3);
    expect(indexCount(onlyTri)).not.toBe(indexCount(onlyHex));
    expect(indexCount(a)).toBeGreaterThanOrEqual(Math.min(indexCount(onlyTri), indexCount(onlyHex)));
    expect(indexCount(a)).toBeLessThanOrEqual(Math.max(indexCount(onlyTri), indexCount(onlyHex)));
    // no cutout owned -> falls back to the primitive
    const prim = run('generator.meshes', { ...over, meshTypes: [{ material: '', mesh: 'any', weight: 1 }] }, 3);
    expect(indexCount(prim)).toBeGreaterThan(0);
  });

  it('Decoration: cutout-mesh shape picks meshes from the list', () => {
    install();
    const out = run('generator.decoration', { decoShape: 'cutout-mesh', leafTypes: [{ material: 'm', mesh: 'primary', weight: 1 }] });
    expect(indexCount(out)).toBeGreaterThan(0);
  });
});
