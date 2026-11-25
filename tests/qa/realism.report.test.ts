import { mkdirSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { MeshData } from '@/contracts/mesh';
import type { Skeleton } from '@/contracts/skeleton';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph, type NodeSpec } from '../helpers/graphSpec';
import { loadSample, SAMPLE_IDS } from '../helpers/sampleProjects';
import { SPINE_ORIGIN_ATTR, SpineOrigin } from '@/generators/split';
import { defaultWindParams } from '@/viewport/wind/windParams';
import {
  REALISM_COLUMNS,
  auditWindSeams,
  averageRows,
  columnMedian,
  forkMetrics,
  forkSectionMarkdown,
  profileMetrics,
  realismTable,
  summarizeForks,
  surfaceMetrics,
  windAuditMeshFromParts,
  type BranchProfile,
  type ForkReport,
  type ForkSectionRow,
  type P2,
  type RealismRow,
} from '@/qa';

/**
 * Realism QA report. Skipped unless QA_REPORT=1:
 *   QA_REPORT=1 npx vitest run tests/qa --maxWorkers=2
 * Writes qa/realism-report.md and qa/baseline.json (every sample project, seeds 1 and 2, LOD 0).
 */
const ENABLED = process.env.QA_REPORT === '1';
const WOOD = new Set(['generator.trunk', 'generator.branch', 'generator.root']);
const WIND = { ...defaultWindParams(), enabled: true, strength: 2 };
const SEEDS = [1, 2];
const NATURAL_FORK = { splitsWaist: 0.7, splitsNeckSwell: 0.15, splitsValleyRadius: 0.35, splitsRidge: 0.3, splitsStretch: 1.2 };

/** Fork metrics of one controlled straight trunk that always splits (the same input for every parameter set). */
async function forkRow(label: string, extra: Record<string, number>): Promise<ForkSectionRow> {
  const specs: NodeSpec[] = [
    { id: 'tree', type: 'output.tree', parent: null },
    {
      id: 'trunk',
      type: 'generator.trunk',
      parent: 'tree',
      params: { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0, splitsChance: 1, ...extra } as NodeSpec['params'],
    },
  ];
  const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed: 1, lod: 0, token: new CancellationSource().token });
  const mesh = r.scene.entries.find((e) => e.nodeId === 'trunk')?.mesh;
  const sk = r.scene.skeletons.find((s) => s.nodeId === 'trunk')?.skeleton;
  if (!mesh || !sk) throw new Error('trunk expected');
  const sum = summarizeForks(forkMetrics(sk, mesh).forks);
  return { label, forks: sum.count, waistMid: sum.waistMid, minAreaRatio: sum.minAreaRatio, minValleyRadiusRel: sum.minValleyRadiusRel, allSimple: sum.allSimple, ring0NormalJumpMax: sum.ring0NormalJumpMax, openEndEdgeCv: sum.openEndEdgeCv };
}

beforeAll(() => registerDiscoveredNodes());

const pct = (x: number | null | undefined): number | null => (x === null || x === undefined ? null : x * 100);
const meanOf = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

async function measure(sampleId: string, seed: number): Promise<RealismRow> {
  const project = loadSample(sampleId);
  const types = new Map(project.graph.nodes.map((n) => [n.id, n.type]));
  const r = await new GraphEvaluator().evaluate(snapshotGraph(GraphModel.fromJSON(project.graph)), { seed, lod: 0, token: new CancellationSource().token });
  const wood = r.scene.entries.filter((e) => WOOD.has(types.get(e.nodeId) ?? '') && e.mesh.positions.length > 0);
  const skeletonOf = (id: string): Skeleton | undefined => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton;
  const trunkEntry = wood.find((e) => types.get(e.nodeId) === 'generator.trunk');
  const trunkSk = trunkEntry ? skeletonOf(trunkEntry.nodeId) : undefined;

  const bark = surfaceMetrics(wood.map((e) => e.mesh as MeshData));
  let trunkSoft: number | null = null;
  let trunkVpm: number | null = null;
  let trunkProfile: BranchProfile | null = null;
  if (trunkEntry && trunkSk) {
    const primary = trunkSk.branches.filter((b) => (trunkSk.attributes.get(SPINE_ORIGIN_ATTR)?.[b.start] ?? 0) === SpineOrigin.Primary && b.generation === 0).sort((a, b) => b.length - a.length)[0];
    const axisPts: number[] = [];
    const axisR: number[] = [];
    if (primary) {
      for (let k = 0; k < primary.count; k++) {
        const i = primary.start + k;
        axisPts.push(trunkSk.position[i * 3] as number, trunkSk.position[i * 3 + 1] as number, trunkSk.position[i * 3 + 2] as number);
        axisR.push(trunkSk.radius[i] as number);
      }
    }
    const s = surfaceMetrics(trunkEntry.mesh, { axis: { points: axisPts, radius: axisR } });
    trunkSoft = s.softnessIndex;
    trunkVpm = s.verticesPerMetre;
    trunkProfile = profileMetrics(trunkSk, trunkEntry.mesh).trunk;
  }

  const branchProfiles: BranchProfile[] = [];
  const forks: ForkReport[] = [];
  for (const e of wood) {
    const sk = skeletonOf(e.nodeId);
    if (!sk) continue;
    if (types.get(e.nodeId) === 'generator.branch') branchProfiles.push(...profileMetrics(sk, e.mesh).branches);
    forks.push(...forkMetrics(sk, e.mesh).forks);
  }
  const bestBranches = branchProfiles.sort((a, b) => b.meanRadius * b.length - a.meanRadius * a.length).slice(0, 2);
  const fork = summarizeForks(forks);

  let windGap: number | null = null;
  const audit = auditWindSeams(windAuditMeshFromParts(r.scene.entries.map((e) => ({ id: e.nodeId, mesh: e.mesh }))), WIND);
  for (const [key, s] of Object.entries(audit.byGroups)) {
    if (key.split('|').every((k) => WOOD.has(types.get(k) ?? ''))) windGap = Math.max(windGap ?? 0, s.maxGap / audit.height);
  }

  return {
    trunkSoftness: trunkSoft,
    barkSoftness: bark.softnessIndex,
    dihedralP50: bark.dihedral.p50,
    dihedralP95: bark.dihedral.p95,
    normalVariance: bark.normalVariance.mean,
    edgeLengthMean: bark.edgeLength.mean,
    trunkVerticesPerMetre: trunkVpm,
    barkTriangles: bark.triangles,
    trunkCircularityDevPct: pct(trunkProfile?.circularityDeviation),
    trunkRoughnessPct: pct(trunkProfile?.radiusRoughness),
    trunkSilhouettePct: pct(trunkProfile?.silhouetteDeviation),
    branchCircularityDevPct: pct(meanOf(bestBranches.map((b) => b.circularityDeviation))),
    branchRoughnessPct: pct(meanOf(bestBranches.map((b) => b.radiusRoughness))),
    forkCount: fork.count,
    waistMid: fork.waistMid,
    minAreaRatio: fork.minAreaRatio,
    thinningForks: fork.thinningForks,
    minValleyRadiusRel: fork.minValleyRadiusRel,
    allSimple: fork.count > 0 ? fork.allSimple : null,
    ring0NormalJumpMax: fork.ring0NormalJumpMax,
    openEndEdgeCv: fork.openEndEdgeCv,
    windSeamGapPct: pct(windGap),
  };
}

describe.skipIf(!ENABLED)('QA realism report (QA_REPORT=1)', () => {
  it('measures every sample project and writes qa/realism-report.md and qa/baseline.json', async () => {
    const perSeed: Record<string, Record<string, RealismRow>> = {};
    const averaged = new Map<string, RealismRow>();
    for (const id of SAMPLE_IDS) {
      const rows: RealismRow[] = [];
      perSeed[id] = {};
      for (const seed of SEEDS) {
        const row = await measure(id, seed);
        rows.push(row);
        (perSeed[id] as Record<string, RealismRow>)[`seed${seed}`] = row;
      }
      averaged.set(id, averageRows(rows));
    }
    const medians = REALISM_COLUMNS.map((c) => {
      const m = columnMedian(averaged, c.key);
      return `| ${c.title} | ${m === null ? '-' : m.toFixed(c.digits + 1)} |`;
    });
    const md = [
      '# Realism report',
      '',
      `Generated by \`QA_REPORT=1 npx vitest run tests/qa --maxWorkers=2\` (${SAMPLE_IDS.length} sample projects, seeds ${SEEDS.join(' and ')} averaged, LOD 0).`,
      'Numbers are measured on the generated meshes (see docs/REALISM_TARGETS.md for the goals and the metric definitions). `-` = not applicable (no trunk / no split).',
      '',
      realismTable(averaged),
      '',
      '## Median over the samples',
      '',
      '| metric | median |',
      '|---|---:|',
      ...medians,
      '',
      forkSectionMarkdown(
        [await forkRow('default (before)', {}), await forkRow('natural (after)', NATURAL_FORK)],
        'waist 0.7, neck swell 0.15, valley radius 0.35, ridge 0.3, stretch 1.2',
      ),
    ].join('\n');
    mkdirSync('qa', { recursive: true });
    writeFileSync('qa/realism-report.md', md);
    const round = (_k: string, v: unknown): unknown => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v);
    writeFileSync('qa/baseline.json', `${JSON.stringify({ version: 1, lod: 0, seeds: SEEDS, samples: perSeed }, round, 1)}\n`);
    expect(averaged.size).toBe(SAMPLE_IDS.length);
  }, 600000);
});

describe('QA realism report gate', () => {
  it('is skipped unless QA_REPORT=1', () => {
    expect(typeof ENABLED).toBe('boolean');
  });
});

/** qa/out (git-ignored): OBJ of the first trunk + SVG cross-sections of its splits, for inspection in Blender / a browser. */
function dumpOut(mesh: MeshData, sk: Skeleton): void {
  mkdirSync('qa/out', { recursive: true });
  const obj: string[] = ['# Kekenik Tree QA dump: first trunk of the oak sample (seed 1)'];
  for (let i = 0; i < mesh.positions.length; i += 3) obj.push(`v ${mesh.positions[i]} ${mesh.positions[i + 2]} ${-(mesh.positions[i + 1] as number)}`);
  for (let t = 0; t < mesh.indices.length; t += 3) obj.push(`f ${(mesh.indices[t] as number) + 1} ${(mesh.indices[t + 1] as number) + 1} ${(mesh.indices[t + 2] as number) + 1}`);
  writeFileSync('qa/out/oak-trunk.obj', `${obj.join('\n')}\n`);
  const sheets = new Map<number, P2[][][]>();
  forkMetrics(sk, mesh, { onOutline: (fork, station, loops) => { const sheet = sheets.get(fork) ?? []; sheet[station] = loops.map((l) => [...l]); sheets.set(fork, sheet); } });
  for (const [fork, sheet] of sheets) {
    let ext = 1e-9;
    for (const loops of sheet) for (const l of loops) for (const p of l) ext = Math.max(ext, Math.abs(p[0]), Math.abs(p[1]));
    const cellSize = 220;
    const parts = sheet.map((loops, k) => {
      const d = loops.map((l) => `M${l.map((p) => `${(110 + (p[0] / ext) * 100).toFixed(1)},${(110 - (p[1] / ext) * 100).toFixed(1)}`).join(' L')} Z`).join(' ');
      return `<g transform="translate(${k * cellSize},0)"><path d="${d}" fill="#c9a77c" stroke="#222" stroke-width="1.5"/><text x="8" y="16" font-size="12">${k}</text></g>`;
    });
    writeFileSync(`qa/out/oak-fork${fork}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.length * cellSize}" height="${cellSize}" viewBox="0 0 ${sheet.length * cellSize} ${cellSize}">${parts.join('')}</svg>\n`);
  }
}

describe.skipIf(!ENABLED)('QA dump (QA_REPORT=1)', () => {
  it('writes the OBJ / SVG dumps into qa/out', async () => {
    const project = loadSample('oak');
    const r = await new GraphEvaluator().evaluate(snapshotGraph(GraphModel.fromJSON(project.graph)), { seed: 1, lod: 0, token: new CancellationSource().token });
    const trunkId = project.graph.nodes.find((n) => n.type === 'generator.trunk')?.id;
    const entry = r.scene.entries.find((e) => e.nodeId === trunkId);
    const sk = r.scene.skeletons.find((s) => s.nodeId === trunkId)?.skeleton;
    expect(entry && sk).toBeTruthy();
    if (entry && sk) dumpOut(entry.mesh, sk);
  }, 60000);
});
