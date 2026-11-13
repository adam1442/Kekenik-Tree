import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { isProjectFile } from '@/contracts/project';
import { decodeProject, encodeProject } from '@/app/project/codec';
import { GraphModel } from '@/graph/model/graphModel';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { buildSpeciesProject } from '@/presets/builder';
import { SPECIES } from '@/presets/species';
import { PRESET_CATEGORIES } from '@/presets/types';

beforeAll(() => registerDiscoveredNodes());

describe('species presets', () => {
  it('ships at least 14 unique species in known categories', () => {
    expect(SPECIES.length).toBeGreaterThanOrEqual(14);
    expect(new Set(SPECIES.map((s) => s.id)).size).toBe(SPECIES.length);
    for (const s of SPECIES) expect(PRESET_CATEGORIES).toContain(s.category);
    for (const name of ['Oak', 'Maple', 'Spruce', 'Pine', 'Birch', 'Willow', 'Palm', 'Acacia', 'Baobab', 'Dead Tree', 'Shrub', 'Fern', 'Cactus', 'Bamboo', 'Young Sapling'])
      expect(SPECIES.map((s) => s.name)).toContain(name);
  });

  it.each(SPECIES.map((s) => s.id))('%s builds, round-trips through .ktree and evaluates at every LOD', async (id) => {
    const def = SPECIES.find((s) => s.id === id)!;
    const project = buildSpeciesProject(def);
    expect(isProjectFile(project)).toBe(true);
    expect(project.assets.length).toBeGreaterThan(0);
    const back = decodeProject(encodeProject(project));
    expect(back.graph.nodes.length).toBe(project.graph.nodes.length);
    expect(back.assets.map((a) => a.id)).toEqual(project.assets.map((a) => a.id));

    const model = GraphModel.fromJSON(back.graph);
    const lod0 = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: def.seed, lod: 0, token: new CancellationSource().token });
    expect(lod0.errors).toBe(0);
    expect(lod0.scene.stats.triangles).toBeGreaterThan(300);
    const lod3 = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: def.seed, lod: 3, token: new CancellationSource().token });
    expect(lod3.errors).toBe(0);
    expect(lod3.scene.stats.triangles).toBeLessThanOrEqual(lod0.scene.stats.triangles);
    expect(lod0.scene.wind).toBeTruthy();
    const mats = new Set(lod0.scene.entries.flatMap((e) => e.mesh.slots.map((s) => s.materialId)));
    for (const m of mats) expect(['bark', 'leaf', 'cluster']).toContain(m);
  }, 120000);
});
