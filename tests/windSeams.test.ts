import { appendFileSync } from 'node:fs';
import { BoxGeometry, BufferAttribute, Group, Mesh, MeshStandardMaterial, ShaderMaterial } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { VIEW_MODES, VIEW_MODE_LABELS } from '@/contracts/app';
import type { MeshData } from '@/contracts/mesh';
import { anchorWind } from '@/nodes/generators/cutoutPlacement';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import { blendWeldWind, lerpPhase, parentWindAt, windArraysOf } from '@/geometry/weldWind';
import { loadSample, SAMPLE_IDS } from './helpers/sampleProjects';
import { ViewModeController } from '@/viewport/viewModes';
import type { ViewportContent } from '@/viewport/types';
import { auditWindSeams, windAuditMeshFromParts, type WindAuditResult } from '@/viewport/wind/windAudit';
import { defaultWindParams } from '@/viewport/wind/windParams';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const WOOD = new Set(['generator.trunk', 'generator.branch', 'generator.root']);
const WIND = { ...defaultWindParams(), enabled: true, strength: 2 };

interface Report {
  /** Largest gap of seams inside one generator (split halves, extensions, caps): never relaxed. */
  wood: number;
  /** Largest gap between vertices of two different wood nodes closer than the contact distance (junction rings, but also crossing limbs). */
  woodCross: number;
  foliage: number;
  result: WindAuditResult;
}

function classify(result: WindAuditResult, types: ReadonlyMap<string, string>): Report {
  let wood = 0;
  let woodCross = 0;
  let foliage = 0;
  for (const [key, s] of Object.entries(result.byGroups)) {
    const isWood = key.split('|').every((k) => WOOD.has(types.get(k) ?? ''));
    const [ka, kb] = key.split('|');
    if (isWood && ka === kb) wood = Math.max(wood, s.maxGap);
    else if (isWood) woodCross = Math.max(woodCross, s.maxGap);
    else foliage = Math.max(foliage, s.maxGap);
  }
  return { wood, woodCross, foliage, result };
}

async function evaluate(model: GraphModel, seed: number) {
  const r = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed, lod: 0, token: new CancellationSource().token });
  return windAuditMeshFromParts(r.scene.entries.map((e) => ({ id: e.nodeId, mesh: e.mesh })));
}

/** Set SEAM_REPORT=<file> to append the numbers of every sample project (used for AgentProgress/T03.md). */
const report = (line: string): void => {
  const file = process.env.SEAM_REPORT;
  if (file) appendFileSync(file, `${line}\n`);
};

describe('T03: wind seams of every sample project', () => {
  it.each(SAMPLE_IDS)('%s: no tearing at branch / crotch / cap seams, welded variant included', async (id) => {
    const project = loadSample(id);
    const types = new Map(project.graph.nodes.map((n) => [n.id, n.type]));
    // Spine / frond plants (Fern, Grass) have no trunk, branch or root seams to audit.
    if (![...types.values()].some((t) => WOOD.has(t))) return;
    const relief = project.graph.nodes.some((n) => n.params.displaceSource?.value === 'bark');
    for (const seed of [1, 2]) {
      const model = GraphModel.fromJSON(project.graph);
      const plain = classify(auditWindSeams(await evaluate(model, seed), WIND), types);
      expect(plain.result.maxDisplacement, `${id}: the audit must see a moving tree`).toBeGreaterThan(0);
      const limit = 0.002 * plain.result.height;
      expect(plain.wood, `${id} seed ${seed}: wood seams`).toBeLessThan(limit);
      // Bark relief makes the limb meshes 10x denser, so two limbs that merely cross are found "in contact" more often
      // (their wind phases differ: they are not a seam). Samples with relief get a 0.5 % bound for those pairs.
      const crossLimit = (relief ? 0.005 : 0.002) * plain.result.height;
      expect(plain.woodCross, `${id} seed ${seed}: wood contact between different nodes`).toBeLessThan(crossLimit);
      // Foliage touching wood (leaf base on a twig): looser bound, the numbers are listed in AgentProgress/T03.md.
      expect(plain.foliage, `${id} seed ${seed}: foliage seams`).toBeLessThan(0.01 * plain.result.height);
      expect(plain.result.coincident.maxGap, `${id} seed ${seed}: coincident vertices`).toBeLessThan(limit);

      // Same tree with every branch fused to its parent (weld rings on the parent's skin).
      const weldedGraph = structuredClone(project.graph);
      for (const n of weldedGraph.nodes) {
        const cur = n.params.weldEnabled;
        if (cur) n.params.weldEnabled = { ...cur, value: true };
      }
      const welded = GraphModel.fromJSON(weldedGraph);
      const w = classify(auditWindSeams(await evaluate(welded, seed), WIND), types);
      expect(w.wood, `${id} seed ${seed}: welded wood seams`).toBeLessThan(limit);
      expect(w.woodCross, `${id} seed ${seed}: welded wood contact`).toBeLessThan(crossLimit);
      report(
        `${id} seed ${seed} H=${plain.result.height.toFixed(2)} wood=${(plain.wood / plain.result.height).toExponential(1)}H weldedWood=${(w.wood / plain.result.height).toExponential(1)}H ` +
          `foliageContactMax=${(plain.result.contact.maxGap / plain.result.height).toExponential(1)}H (${plain.result.contact.pairs} pairs)`,
      );
    }
  }, 180000);
});

describe('T03: weld rings move like the parent skin', () => {
  const specs = (weld: boolean): NodeSpec[] => [
    { id: 'tree', type: 'output.tree', parent: null },
    { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { spread: 0, gravity: 0, curvature: 0, noiseAmount: 0 } as NodeSpec['params'] },
    { id: 'br', type: 'generator.branch', parent: 'trunk', params: { weldEnabled: weld } as NodeSpec['params'] },
    { id: 'tw', type: 'generator.branch', parent: 'br', params: { weldEnabled: weld } as NodeSpec['params'] },
  ];

  it('the welded junction of a branch on the trunk shows no wind gap (< 0.2 % of the height)', async () => {
    const r = await evaluate(buildGraph(specs(true)), 1);
    const res = auditWindSeams(r, WIND, { surface: 1e-2 });
    const g = res.byGroups['br|trunk'];
    expect(g?.pairs ?? 0).toBeGreaterThan(5);
    expect(g?.maxGap ?? 0).toBeLessThan(0.002 * res.height);
    expect(res.coincident.maxGap).toBeLessThan(0.002 * res.height);
  }, 120000);

  it('blendWeldWind: weight 1 = the parent, weight 0 = the child, phases along the shorter arc', () => {
    const parent = [0.8, 0.1, 0, 0.95, 0.9];
    const own = [0.2, 0.6, 0.3, 0.05, 0.1];
    blendWeldWind(parent, own, 1).forEach((v, k) => expect(v).toBeCloseTo(parent[k] as number, 6));
    const zero = blendWeldWind(parent, own, 0);
    expect(zero[0]).toBeCloseTo(0.2, 6);
    expect(zero[3]).toBeCloseTo(0.05, 6);
    const wrapDist = (v: number): number => Math.min(v, 1 - v);
    expect(wrapDist(lerpPhase(0.95, 0.05, 0.5))).toBeCloseTo(0, 6);
    expect(wrapDist(lerpPhase(0.05, 0.95, 0.5))).toBeCloseTo(0, 6);
  });
});

describe('T03: foliage attachment', () => {
  it('anchorWind keeps the host weight at the anchor: the base of a stacked mesh equals its host, the flutter weight never drops', () => {
    const base: [number, number, number, number, number] = [0.4, 0.3, 0.25, 0.7, 0.6];
    const atRoot = anchorWind(base, 0);
    expect(atRoot).toEqual([0.4, 0.3, 0.25, 0.7, 0.6]);
    let prev = 0;
    for (let a = 0; a <= 1.0001; a += 0.1) {
      const w = anchorWind(base, a);
      expect(w[2]).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(w[2]).toBeLessThanOrEqual(1);
      expect([w[0], w[1], w[3], w[4]]).toEqual([0.4, 0.3, 0.7, 0.6]);
      prev = w[2];
    }
  });

  it('a leaf on a twig starts with the wind of the twig vertex it grows from (interpolated, not snapped to a skeleton point)', async () => {
    const specsLeaf: NodeSpec[] = [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { spread: 0, gravity: 0, curvature: 0, noiseAmount: 0 } as NodeSpec['params'] },
      { id: 'br', type: 'generator.branch', parent: 'trunk' },
      { id: 'leaf', type: 'generator.leaf', parent: 'br' },
    ];
    const model = buildGraph(specsLeaf);
    const r = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: 1, lod: 0, token: new CancellationSource().token });
    const leaf = r.scene.entries.find((e) => e.nodeId === 'leaf')?.mesh as MeshData | undefined;
    expect(leaf?.wind).toBeDefined();
    const sk = r.scene.skeletons.find((s) => s.nodeId === 'br')?.skeleton;
    expect(sk).toBeDefined();
    const wm = leaf?.wind?.weights as Float32Array;
    const pv = leaf?.wind?.pivot as Float32Array;
    expect(sk && wm && pv).toBeTruthy();
    const arrays = windArraysOf(sk!.attributes)!;
    // Base vertices of every leaf = the lowest flutter weight among the vertices sharing a pivot.
    const lowest = new Map<string, number>();
    const keyOf = (i: number): string => `${(pv[i * 3] as number).toFixed(5)},${(pv[i * 3 + 1] as number).toFixed(5)},${(pv[i * 3 + 2] as number).toFixed(5)}`;
    for (let i = 0; i < wm.length / 4; i++) lowest.set(keyOf(i), Math.min(lowest.get(keyOf(i)) ?? 2, wm[i * 4 + 2] as number));
    let checked = 0;
    for (let i = 0; i < wm.length / 4; i++) {
      if ((wm[i * 4 + 2] as number) > (lowest.get(keyOf(i)) as number) + 1e-6) continue;
      const here = [pv[i * 3] as number, pv[i * 3 + 1] as number, pv[i * 3 + 2] as number] as const;
      // The pivot lies on the twig's spine: the base weights equal the twig's weights interpolated at that spot.
      const ok = sk!.branches.some((b) => {
        if (b.count < 2) return false;
        const t = parentWindAt({ arrays, start: b.start, count: b.count, position: sk!.position }, here[0], here[1], here[2]);
        return Math.abs(t[0] - (wm[i * 4] as number)) < 1e-4 && Math.abs(t[1] - (wm[i * 4 + 1] as number)) < 1e-4;
      });
      expect(ok).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  }, 120000);
});

describe('T03: "Wind weights" view mode', () => {
  const content = (): { c: ViewportContent; mesh: Mesh } => {
    const root = new Group();
    const geo = new BoxGeometry(1, 1, 1);
    geo.setAttribute('windWeights', new BufferAttribute(new Float32Array(24 * 4).fill(0.5), 4));
    const mesh = new Mesh(geo, new MeshStandardMaterial());
    root.add(mesh);
    return { c: { root, skeleton: null } as unknown as ViewportContent, mesh };
  };

  it('is registered in the View menu list with a label', () => {
    expect(VIEW_MODES).toContain('windWeights');
    expect(VIEW_MODE_LABELS.windWeights).toBe('Wind weights');
  });

  it('shows w0 / w1 / w2 as RGB through a shader material, restores the base material, and costs nothing while off', () => {
    const { c, mesh } = content();
    const vm = new ViewModeController();
    vm.apply(c, 'shaded');
    expect(mesh.material).toBe(mesh.userData.baseMaterial ?? mesh.material);
    const base = mesh.material;
    vm.apply(c, 'windWeights');
    expect(mesh.material).toBeInstanceOf(ShaderMaterial);
    const sm = mesh.material as ShaderMaterial;
    expect(sm.vertexShader).toContain('attribute vec4 windWeights');
    expect(sm.fragmentShader).toContain('vWw');
    vm.apply(c, 'shaded');
    expect(mesh.material).toBe(base);
    vm.dispose();
  });
});
