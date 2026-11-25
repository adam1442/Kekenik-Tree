import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { SceneModel } from '@/contracts/engine';
import { runExport, type ExportEnv } from '@/export/exportService';
import { defaultExportSettings, defaultLodLevels } from '@/export/settings';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { createMaterialDef } from '@/materials/shadingMath';
import { analyseScene, applyDynamicLod, defaultDynamicLodConfig, lodNodeScales, lodReport } from '@/lod/dynamic';
import { buildGraph } from './helpers/graphSpec';
import { REFERENCE_GRAPHS } from './helpers/referenceGraphs';

beforeAll(() => registerDiscoveredNodes());

describe('Dynamic LOD on a real generated plant', () => {
  it('reads the Tree defaults, ranks every piece and shrinks branches / leaves without NaN', async () => {
    const model = buildGraph(REFERENCE_GRAPHS.oak_broadleaf as never);
    const evaluator = new GraphEvaluator();
    const summary = await evaluator.evaluate(snapshotGraph(model), { seed: 1, lod: 0, token: new CancellationSource().token });
    const scene = summary.scene;
    expect(scene.dynamicLod?.enabled).toBe(false);
    expect(scene.dynamicLod?.levels).toBe(4);
    const cfg = { ...defaultDynamicLodConfig(), enabled: true };
    const m = analyseScene(scene, 1);
    expect(m.nodeCount).toBeGreaterThan(10);
    let last = Infinity;
    for (const v of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      const r = lodReport(m, lodNodeScales(m, cfg, v), v);
      expect(r.triangles).toBeLessThanOrEqual(last);
      last = r.triangles;
      const out = applyDynamicLod(scene, m, cfg, v);
      for (const e of out.entries) for (const p of e.mesh.positions) expect(Number.isFinite(p)).toBe(true);
      expect(out.stats.triangles).toBe(r.triangles);
    }
    expect(last).toBeLessThan(m.totalTriangles);
  }, 120000);

  it('exports Dynamic LOD levels with a report', async () => {
    const model = buildGraph(REFERENCE_GRAPHS.oak_broadleaf as never);
    const evaluator = new GraphEvaluator();
    const defs = ['bark', 'leaf', 'cluster'].map((id) => createMaterialDef(id, id));
    const env: ExportEnv = {
      source: {
        seed: 1,
        evaluateAt: async (lod, token) => {
          const s = await evaluator.evaluate(snapshotGraph(model), { seed: 1, lod, token });
          const scene: SceneModel = { ...s.scene, dynamicLod: { ...defaultDynamicLodConfig(), enabled: true } };
          return { ...s, scene };
        },
      },
      levels: defaultLodLevels(),
      materials: { material: (id) => defs.find((d) => d.id === id || d.name === id), loadImage: async () => null, encode: async () => ({ data: new Uint8Array(0), mime: 'image/png', ext: 'png' }), alphaThreshold: 0.5 },
      nodeName: (id) => id,
      wind: null,
      seed: 1,
      verifyWithLoader: false,
    };
    const settings = { ...defaultExportSettings('Oak'), lods: [0, 1, 2, 3], metadata: false };
    const out = await runExport(env, settings, new CancellationSource().token, () => undefined);
    const tris = out.lods.map((l) => l.stats.triangles);
    for (let i = 1; i < tris.length; i++) expect(tris[i]).toBeLessThanOrEqual(tris[i - 1] as number);
    expect(out.dynamicLevels).toHaveLength(4);
    expect(out.dynamicLevels[3]?.report.value).toBe(1);
    expect(out.verification.every((v) => v.ok)).toBe(true);
  }, 180000);
});
