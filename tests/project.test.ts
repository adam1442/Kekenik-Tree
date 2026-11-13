import { beforeAll, describe, expect, it } from 'vitest';
import { UndoStack } from '@/app/commands/undoStack';
import type { AppEvents } from '@/app/context';
import { GraphSession } from '@/app/graphSession';
import { AutosaveStore } from '@/app/project/autosave';
import { decodeJson, decodeProject, encodeJson, encodeProject, isGzip } from '@/app/project/codec';
import { defaultGraph } from '@/app/project/defaultGraph';
import type { FileHandleLike, FileIO, OpenedFile } from '@/app/project/fileAccess';
import { createProjectFile, defaultMeta, parseProject } from '@/app/project/format';
import { MemoryKeyValueStore } from '@/app/project/kvStore';
import { ProjectManager, type ProjectUi } from '@/app/project/projectManager';
import { RecentFiles } from '@/app/project/recent';
import { createTemplate, decodeTemplate, encodeTemplate } from '@/app/project/templates';
import { createAppStore } from '@/app/state';
import { PROJECT_VERSION, migrateProject } from '@/contracts/project';
import { CancellationSource, type NodeDef } from '@/contracts/nodes';
import { EventBus } from '@/core/eventBus';
import { GraphEvaluator, hashPortValue, snapshotGraph } from '@/graph/engine';
import { copySubgraph } from '@/graph/model/clipboard';
import { GraphModel } from '@/graph/model/graphModel';
import { getNodeDef, registerDiscoveredNodes, registerNode, unregisterNode } from '@/graph/registry';

beforeAll(() => registerDiscoveredNodes());

const sceneHash = async (graph: ReturnType<typeof defaultGraph>, seed: number): Promise<string[]> => {
  const m = new GraphModel();
  m.load(graph);
  const r = await new GraphEvaluator().evaluate(snapshotGraph(m), { seed, lod: 0, token: new CancellationSource().token });
  return r.scene.entries.map((e) => `${e.nodeId}:${hashPortValue({ kind: 'Mesh', value: e.mesh })}`).sort();
};

describe('project file round trip', () => {
  const file = createProjectFile({ name: 'Spruce', graph: defaultGraph(), meta: defaultMeta(99), seed: 99 });

  it.each([false, true, 'auto'] as const)('encode/decode keeps everything (compress=%s)', (compress) => {
    const bytes = encodeProject(file, { compress });
    expect(isGzip(bytes)).toBe(compress === true);
    const back = decodeProject(bytes);
    expect(back.graph.nodes).toEqual(file.graph.nodes);
    expect(back.graph.edges).toEqual(file.graph.edges);
    expect(back.settings.seed).toBe(99);
    expect(back.version).toBe(PROJECT_VERSION);
  });

  it('save -> reload produces an identical plant', async () => {
    const before = await sceneHash(file.graph, 99);
    const back = decodeProject(encodeProject(file, { compress: true }));
    expect(await sceneHash(back.graph, back.settings.seed)).toEqual(before);
  });

  it('rejects garbage, newer versions and malformed graphs', () => {
    expect(() => decodeJson(new TextEncoder().encode('{nope'))).toThrow(/valid JSON/);
    expect(() => parseProject({ version: PROJECT_VERSION + 1, graph: { nodes: [], edges: [] }, settings: {} })).toThrow(/newer/);
    expect(() => parseProject({ version: 2, graph: {}, settings: {} })).toThrow(/malformed/);
    expect(() => parseProject('hello')).toThrow(/Not a Kekenik/);
    expect(decodeJson(encodeJson({ a: 1 }, { compress: true }))).toEqual({ a: 1 });
  });
});

describe('migrations', () => {
  it('upgrades a v1 file: project chain and per-node param hooks', () => {
    const def: NodeDef = {
      type: 'test.migrating', category: 'utility', label: 'M', icon: 'x', color: 'x', ports: [],
      version: 3,
      params: [{ kind: 'float', id: 'strength', label: 'Strength', group: 'g', default: 1 }],
      migrate: (p, from) => {
        const out = { ...p };
        if (from < 2 && out.amount) { out.strength = out.amount; delete out.amount; }
        if (from < 3 && out.strength) out.strength = { value: Number(out.strength.value) * 10 };
        return out;
      },
      evaluate: () => ({}),
    };
    registerNode(def);
    try {
      const v1 = {
        version: 1,
        name: 'Old',
        graph: { nodes: [{ id: 'a', type: 'test.migrating', name: 'A', position: { x: 0, y: 0 }, enabled: true, params: { amount: { value: 2 } } }], edges: [] },
        settings: { seed: 5, units: 'm', upAxis: 'Z', lodCount: 4 },
      };
      expect(migrateProject(v1).version).toBe(PROJECT_VERSION);
      const parsed = parseProject(v1);
      expect(parsed.graph.nodes[0]?.params.strength?.value).toBe(20);
      expect(parsed.graph.nodes[0]?.params.amount).toBeUndefined();
      expect(parsed.nodeVersions).toEqual({ 'test.migrating': 3 });
      expect(parsed.materials).toEqual([]);
      expect(parsed.settings.wind.strength).toBeDefined();
      // A file saved with the current node version is left alone.
      const again = parseProject({ ...parsed });
      expect(again.graph.nodes[0]?.params.strength?.value).toBe(20);
    } finally {
      unregisterNode('test.migrating');
    }
  });

  it('keeps unknown node types untouched', () => {
    const p = parseProject({ version: 1, name: 'x', graph: { nodes: [{ id: 'a', type: 'future.node', name: 'F', position: { x: 0, y: 0 }, enabled: true, params: { z: { value: 1 } } }], edges: [] }, settings: {} });
    expect(p.graph.nodes[0]?.params.z?.value).toBe(1);
  });
});

describe('recovery storage, recent files, templates', () => {
  it('autosave records are listed newest first and removable', async () => {
    const a = new AutosaveStore(new MemoryKeyValueStore());
    await a.write({ docId: 'd1', name: 'One', fileName: null, savedAt: 1, bytes: new Uint8Array([1]) });
    await a.write({ docId: 'd2', name: 'Two', fileName: 'two.ktree', savedAt: 2, bytes: new Uint8Array([2]) });
    expect((await a.list()).map((r) => r.docId)).toEqual(['d2', 'd1']);
    await a.remove('d2');
    expect((await a.list()).map((r) => r.docId)).toEqual(['d1']);
    await a.clear();
    expect(await a.list()).toEqual([]);
  });

  it('recent files are de-duplicated, capped and ordered', async () => {
    const r = new RecentFiles(new MemoryKeyValueStore());
    for (let i = 0; i < 14; i++) await r.add({ name: `f${i}.ktree`, handle: null, bytes: new Uint8Array(1) });
    await r.add({ name: 'f3.ktree', handle: null, bytes: new Uint8Array(1) });
    const list = await r.list();
    expect(list).toHaveLength(10);
    expect(list[0]?.name).toBe('f3.ktree');
    expect(list.filter((e) => e.name === 'f3.ktree')).toHaveLength(1);
  });

  it('node templates round-trip and paste under a parent', () => {
    const m = new GraphModel();
    m.load(defaultGraph());
    const payload = copySubgraph(m, ['little', 'leaf']);
    const tpl = decodeTemplate(encodeTemplate(createTemplate('Twigs', payload)));
    expect(tpl.name).toBe('Twigs');
    expect(tpl.payload.nodes.map((n) => n.id).sort()).toEqual(['leaf', 'little']);
    expect(tpl.payload.edges).toHaveLength(1);
    expect(() => decodeTemplate(new TextEncoder().encode('{"format":"other"}'))).toThrow(/template/);
    expect(getNodeDef('generator.leaf')).toBeDefined();
  });
});

describe('ProjectManager', () => {
  function setup(choice = 1) {
    const store = createAppStore();
    const undo = new UndoStack(store);
    const events = new EventBus<AppEvents>();
    const messages: string[] = [];
    const graph = new GraphSession({ store, undo, appEvents: events, notify: (m) => messages.push(m) });
    const written: Uint8Array[] = [];
    const handle: FileHandleLike = { name: 'tree.ktree', getFile: () => Promise.reject(new Error('n/a')), createWritable: () => Promise.resolve({ write: (d) => { written.push(d as Uint8Array); return Promise.resolve(); }, close: () => Promise.resolve() }) };
    let opened: OpenedFile | null = null;
    const fileIO: FileIO = {
      openFile: () => Promise.resolve(opened),
      pickFile: () => Promise.resolve(null),
      writeHandle: (_h, bytes) => { written.push(bytes); return Promise.resolve(); },
      saveAs: (_name, bytes) => { written.push(bytes); return Promise.resolve({ name: 'tree.ktree', handle }); },
      readHandle: () => Promise.resolve(null),
      download: () => undefined,
    };
    const ui: ProjectUi = { choose: () => Promise.resolve(choice), ask: () => Promise.resolve('x') };
    const kv = new MemoryKeyValueStore();
    const pm = new ProjectManager({ store, graph, undo, fileIO, kv, ui, notify: (m) => messages.push(m), autosaveMs: 5 });
    return { store, graph, undo, pm, written, kv, messages, setOpened: (o: OpenedFile) => { opened = o; } };
  }

  it('starts with the default graph, tracks dirty state, saves and re-opens identically', async () => {
    const t = setup();
    await t.pm.start();
    expect(t.graph.model.nodes().length).toBeGreaterThan(5);
    expect(t.store.get().dirty).toBe(false);
    t.graph.setParam('leaf', 'number', { value: 9 });
    expect(t.store.get().dirty).toBe(true);
    expect(t.pm.hasUnsavedChanges()).toBe(true);

    expect(await t.pm.save()).toBe(true);
    expect(t.store.get().dirty).toBe(false);
    expect(t.store.get().documents[0]?.name).toBe('tree.ktree');
    const bytes = t.written[0] as Uint8Array;
    expect(decodeProject(bytes).graph.nodes.find((n) => n.id === 'leaf')?.params.number?.value).toBe(9);

    t.setOpened({ name: 'copy.ktree', bytes, handle: null });
    expect(await t.pm.open()).toBe(true);
    expect(t.store.get().documents).toHaveLength(2);
    expect(t.graph.model.getNode('leaf')?.params.number?.value).toBe(9);
    expect(t.store.get().dirty).toBe(false);
    // Silent save needs a handle; this copy has none, so Save falls back to Save As.
    expect(await t.pm.save()).toBe(true);
  });

  it('asks before closing a dirty document and honours Cancel / Don’t Save', async () => {
    const cancel = setup(2);
    await cancel.pm.start();
    cancel.graph.setParam('leaf', 'number', { value: 2 });
    expect(await cancel.pm.closeActive()).toBe(false);
    expect(cancel.store.get().documents).toHaveLength(1);

    const discard = setup(1);
    await discard.pm.start();
    discard.graph.setParam('leaf', 'number', { value: 2 });
    expect(await discard.pm.closeActive()).toBe(true);
    // The last document is replaced by a fresh default project.
    expect(discard.store.get().documents).toHaveLength(1);
    expect(discard.store.get().dirty).toBe(false);
    expect(discard.graph.model.getNode('leaf')?.params.number?.value).toBe(5);
  });

  it('autosaves dirty documents and offers recovery after a "crash"', async () => {
    const first = setup();
    await first.pm.start();
    first.graph.setParam('leaf', 'number', { value: 11 });
    await first.pm.autosaveNow();
    expect((await new AutosaveStore(first.kv).list()).length).toBe(1);

    const second = setup(0);
    // reuse the same storage = same browser profile
    for (const k of await first.kv.keys()) await second.kv.set(k, await first.kv.get(k));
    await second.pm.start();
    expect(second.graph.model.getNode('leaf')?.params.number?.value).toBe(11);
    expect(second.store.get().dirty).toBe(true);
    expect(second.store.get().documents).toHaveLength(1);
    expect(await new AutosaveStore(second.kv).list()).toEqual([]);
  });

  it('refuses unreadable files without opening a document', async () => {
    const t = setup();
    await t.pm.start();
    expect(await t.pm.openBytes('bad.ktree', new TextEncoder().encode('not json'), null)).toBe(false);
    expect(t.store.get().documents).toHaveLength(1);
    expect(t.messages.some((m) => /bad\.ktree/.test(m))).toBe(true);
  });
});
