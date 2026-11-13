import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { runExport, type ExportEnv } from '@/export/exportService';
import { defaultExportSettings, defaultLodLevels } from '@/export/settings';
import { readGlbJson } from '@/export/writers/gltf';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { createMaterialDef } from '@/materials/shadingMath';
import { buildGraph } from './helpers/graphSpec';
import { REFERENCE_GRAPHS } from './helpers/referenceGraphs';

beforeAll(() => registerDiscoveredNodes());

describe('export of a real generated plant', () => {
  it('produces decreasing LOD triangle counts and a verified GLB for the oak reference graph', async () => {
    const model = buildGraph(REFERENCE_GRAPHS.oak_broadleaf as never);
    const evaluator = new GraphEvaluator();
    const defs = ['bark', 'leaf', 'cluster'].map((id) => createMaterialDef(id, id));
    const env: ExportEnv = {
      source: { seed: 1, evaluateAt: (lod, token) => evaluator.evaluate(snapshotGraph(model), { seed: 1, lod, token }) },
      levels: defaultLodLevels(),
      materials: { material: (id) => defs.find((d) => d.id === id || d.name === id), loadImage: async () => null, encode: async () => ({ data: new Uint8Array(0), mime: 'image/png', ext: 'png' }), alphaThreshold: 0.5 },
      nodeName: (id) => id,
      wind: null,
      seed: 1,
      verifyWithLoader: false,
    };
    const settings = { ...defaultExportSettings('Oak'), lods: [0, 1, 2, 3], bake: { ...defaultExportSettings().bake, aoMode: 'multiply' as const, aoSamples: 8 }, metadata: false };
    const out = await runExport(env, settings, new CancellationSource().token, () => undefined);
    const tris = out.lods.map((l) => l.stats.triangles);
    for (let i = 1; i < tris.length; i++) expect(tris[i]).toBeLessThan(tris[i - 1] as number);
    expect(out.verification.every((v) => v.ok)).toBe(true);
    const json = readGlbJson(out.files[0]!.data as Uint8Array).json;
    const attrs = json.meshes[0]!.primitives[0]!.attributes as Record<string, number>;
    expect(attrs._WIND_PIVOT).toBeDefined();
    expect(attrs._AO).toBeDefined();
    expect(attrs.COLOR_0).toBeDefined();
  }, 120000);
});
