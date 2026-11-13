import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import type { AttachmentSet } from '@/contracts/attachment';
import type { CutoutMesh } from '@/contracts/material';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { getNodeDef } from '@/graph/registry';
import { setMaterialSource } from '@/materials/materialSource';
import { createDefaultCutoutMesh } from '@/materials/cutouts/ops';
import { ensureCutoutAttachmentData } from '@/materials/cutouts/frame';
import { rebuildCutoutLods } from '@/materials/cutouts/lod';

/**
 * Test scene for the cutout attachment pipeline. `buildCutoutAttachmentScene()` evaluates, without the
 * engine UI, the chain  Stem -> Leaf(cluster cutout, 4 anchors) -> Leaf(single leaf) -> Leaf(single leaf)
 * and returns every level's skeleton + attachment set. Expected result (see docs/CUTOUT_ATTACHMENT.md):
 *  - level 1: one cluster whose axis base sits on the stem and whose +Y follows the leaf growth direction;
 *  - level 2: exactly 4 leaves, each base on one anchor, each axis along that anchor's direction;
 *  - level 3: one leaf per anchor of level 2 (single leaf cutouts have 2 anchors -> 8 leaves).
 * Turn on Show > Attachment frames in the viewport to see the triads.
 */

type P2 = [number, number];

function makeCutout(id: string, anchors: { uv: P2; handle: P2 }[]): CutoutMesh {
  const c = createDefaultCutoutMesh(id, id, 'leaf');
  c.outline = [[0.5, 0], [1, 0.4], [0.5, 1], [0, 0.4]];
  c.interiorPoints = anchors.map((a) => a.uv);
  c.straightenAxis = [[0.5, 0], [0.5, 1]];
  c.anchors = anchors.map((a, i) => ({ id: `${id}_${i}`, uv: a.uv, handleUv: a.handle }));
  rebuildCutoutLods(c);
  ensureCutoutAttachmentData(c);
  return c;
}

export interface AttachmentSceneLevel {
  nodeId: string;
  skeleton: Skeleton;
  attachments: AttachmentSet;
}

export function buildCutoutAttachmentScene(seed = 1): { cutouts: CutoutMesh[]; levels: AttachmentSceneLevel[] } {
  const cluster = makeCutout('cluster', [
    { uv: [0.5, 0.2], handle: [0.6, 0.3] },
    { uv: [0.5, 0.4], handle: [0.4, 0.5] },
    { uv: [0.5, 0.6], handle: [0.6, 0.7] },
    { uv: [0.5, 0.8], handle: [0.5, 0.9] },
  ]);
  const single = makeCutout('single', [{ uv: [0.5, 0.35], handle: [0.58, 0.45] }, { uv: [0.5, 0.7], handle: [0.42, 0.8] }]);
  const cutouts = [cluster, single];
  setMaterialSource({ materials: () => [], sets: () => [], displacements: () => [], masks: () => [], cutoutMeshes: () => cutouts, season: () => 0.5 });

  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.03);
  sb.endBranch();
  let skeleton = sb.build();
  let attachments: AttachmentSet | undefined;

  const levels: AttachmentSceneLevel[] = [];
  const steps: { id: string; mesh: string; over: Record<string, unknown> }[] = [
    { id: 'cluster', mesh: 'cluster', over: { number: 1, first: 0.5, last: 0.5 } },
    { id: 'leaf', mesh: 'single', over: {} },
    { id: 'subleaf', mesh: 'single', over: {} },
  ];
  for (const step of steps) {
    const def = getNodeDef('generator.leaf');
    if (!def) throw new Error('Leaf node is not registered');
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = defaultParamState(d);
    for (const [k, v] of Object.entries(step.over)) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
    p.leafTypes = { ...(p.leafTypes as NodeParams[string]), value: [{ material: 'leaf', mesh: step.mesh, weight: 1 }] as never };
    const ctx: NodeContext = { nodeId: step.id, name: step.id, rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod: 0, logger: createLogger('dev', 'error') };
    const inputs: NodeInputs = { parent: [{ kind: 'Structure', value: { skeleton, ...(attachments ? { attachments } : {}) } }] };
    const out = def.evaluate(ctx, inputs, p) as Record<string, { kind: string; value: { skeleton: Skeleton; attachments?: AttachmentSet } }>;
    const children = out.children?.value;
    if (!children?.attachments) throw new Error(`Level ${step.id} produced no attachment frames`);
    skeleton = children.skeleton;
    attachments = children.attachments;
    levels.push({ nodeId: step.id, skeleton, attachments });
  }
  return { cutouts, levels };
}
