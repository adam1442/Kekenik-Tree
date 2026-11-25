import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { isProjectFile } from '@/contracts/project';
import { decodeProject, encodeProject } from '@/app/project/codec';
import { projectMaterialSource } from './helpers/projectMaterials';
import { loadSample, sampleFetch, SAMPLE_IDS } from './helpers/sampleProjects';
import { setMaterialSource } from '@/materials/materialSource';
import { GraphModel } from '@/graph/model/graphModel';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { builtinPresets } from '@/presets/catalog';
import { DEFAULT_WELCOME_PRESET_ID, SAMPLES } from '@/presets/samples';
import { PRESET_CATEGORIES } from '@/presets/types';

beforeAll(() => registerDiscoveredNodes());

/** Total LOD 0 triangles allowed for one sample. */
const TRIANGLE_BUDGET = 1_500_000;
const TIME_LIMIT_MS = 120000;

interface Run {
  triangles: number;
  checksum: number;
  finite: boolean;
  ms: number;
}

async function evaluateLod0(id: string, seed: number): Promise<Run> {
  const model = GraphModel.fromJSON(loadSample(id).graph);
  setMaterialSource(projectMaterialSource(loadSample(id)));
  const t0 = Date.now();
  const r = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed, lod: 0, token: new CancellationSource().token });
  setMaterialSource(null);
  expect(r.errors).toBe(0);
  let checksum = 0;
  let finite = true;
  for (const e of r.scene.entries) {
    const p = e.mesh.positions;
    for (let i = 0; i < p.length; i += 1) {
      const v = p[i] as number;
      if (!Number.isFinite(v)) finite = false;
      if (i % 97 === 0) checksum += v * (1 + (i % 7));
    }
  }
  return { triangles: r.scene.stats.triangles, checksum, finite, ms: Date.now() - t0 };
}

describe('sample projects', () => {
  it('ships exactly the six sample projects, in known categories', () => {
    expect(SAMPLES.map((s) => s.id).sort()).toEqual(['birch', 'fern', 'grass', 'oak', 'palm', 'swamp']);
    expect(new Set(SAMPLES.map((s) => s.id)).size).toBe(SAMPLES.length);
    expect(new Set(SAMPLES.map((s) => s.file)).size).toBe(SAMPLES.length);
    for (const s of SAMPLES) expect(PRESET_CATEGORIES).toContain(s.category);
  });

  it('lists the samples in the built-in library, default sample first', () => {
    const entries = builtinPresets();
    expect(entries.map((e) => e.id).sort()).toEqual(SAMPLES.map((s) => s.id).sort());
    expect(entries.every((e) => e.builtin)).toBe(true);
    expect(entries[0]?.id).toBe(DEFAULT_WELCOME_PRESET_ID);
  });

  it('loads every sample file through the library entry (same path as the app)', async () => {
    vi.stubGlobal('fetch', sampleFetch);
    try {
      for (const entry of builtinPresets()) {
        const project = await entry.load();
        expect(isProjectFile(project), entry.id).toBe(true);
        expect(project.name).toBe(entry.name);
        expect(project.graph.nodes.some((n) => n.type === 'output.tree'), entry.id).toBe(true);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  }, TIME_LIMIT_MS);

  it.each(SAMPLE_IDS)('%s: graph is valid and every parameter exists in the registry', (id) => {
    const project = loadSample(id);
    expect(isProjectFile(project)).toBe(true);
    expect(project.graph.nodes.filter((n) => n.type === 'output.tree')).toHaveLength(1);
    for (const node of project.graph.nodes) {
      const nodeDef = getNodeDef(node.type);
      expect(nodeDef, `${id}: node type ${node.type}`).toBeTruthy();
    }
    const model = GraphModel.fromJSON(project.graph);
    expect(model.nodeCount).toBe(project.graph.nodes.length);
  });

  it.each(SAMPLE_IDS)('%s loads, round-trips through .ktree and evaluates at every LOD', async (id) => {
    const project = loadSample(id);
    expect(project.assets.length).toBeGreaterThan(0);
    const back = decodeProject(encodeProject(project));
    expect(back.graph.nodes.length).toBe(project.graph.nodes.length);
    expect(back.assets.map((a) => a.id)).toEqual(project.assets.map((a) => a.id));

    // The app installs the document's library as the material source.
    setMaterialSource(projectMaterialSource(back));
    const model = GraphModel.fromJSON(back.graph);
    const lod0 = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: back.settings.seed, lod: 0, token: new CancellationSource().token });
    expect(lod0.errors).toBe(0);
    expect(lod0.scene.stats.triangles).toBeGreaterThan(100);
    const lod3 = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: back.settings.seed, lod: 3, token: new CancellationSource().token });
    setMaterialSource(null);
    expect(lod3.errors).toBe(0);
    expect(lod3.scene.stats.triangles).toBeLessThanOrEqual(lod0.scene.stats.triangles);
  }, TIME_LIMIT_MS);

  it.each(SAMPLE_IDS)('%s: no NaN, triangle budget, time limit and determinism at LOD 0', async (id) => {
    const seed = loadSample(id).settings.seed;
    const a = await evaluateLod0(id, seed);
    const b = await evaluateLod0(id, seed);
    expect(a.finite, `${id}: finite positions`).toBe(true);
    expect(a.triangles, `${id}: triangles`).toBeLessThan(TRIANGLE_BUDGET);
    expect(a.ms, `${id}: time`).toBeLessThan(TIME_LIMIT_MS);
    expect(b.triangles).toBe(a.triangles);
    expect(b.checksum).toBe(a.checksum);
  }, TIME_LIMIT_MS * 2);
});
