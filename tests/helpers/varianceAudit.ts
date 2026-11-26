import { Hasher } from '@/graph/engine/hash';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { CancellationSource } from '@/contracts/nodes';
import type { NodeDef } from '@/contracts/nodes';
import type { ParamDef, ParamValue, VarianceValue } from '@/contracts/params';
import type { GraphModel } from '@/graph/model/graphModel';
import { buildGraph, type NodeSpec } from './graphSpec';

/** Extra base values some parameters need before their variance can show (e.g. split chance > 0). */
const PREREQUISITES: Record<string, Record<string, ParamValue>> = {
  splits: { splitsChance: 0.7, splitsLateralChance: 0.5 },
};

/** Order-independent content hash of anything a scene is made of (typed arrays, numbers, strings); `rev` cache tokens are skipped. */
export function hashContent(value: unknown, h = new Hasher()): Hasher {
  if (value === null || value === undefined) h.byte(0);
  else if (ArrayBuffer.isView(value)) h.typed(value);
  else if (typeof value === 'number') h.string(value.toFixed(6));
  else if (typeof value === 'string') h.string(value);
  else if (typeof value === 'boolean') h.byte(value ? 1 : 2);
  else if (Array.isArray(value)) for (const v of value) hashContent(v, h);
  else if (value instanceof Map) for (const [k, v] of value) hashContent(v, hashContent(k, h));
  else if (typeof value === 'object') {
    for (const key of Object.keys(value).sort()) {
      if (key === 'rev') continue;
      h.string(key);
      hashContent((value as Record<string, unknown>)[key], h);
    }
  }
  return h;
}

const SEEDS = [11, 23, 47, 91];

/** Flat list of the parameters of a def that carry a "+/-" button (list rows included, as `list.field`). */
export function varianceParams(def: NodeDef): ParamDef[] {
  return def.params.filter((p) => p.variance !== undefined);
}

/** Small representative graph: Tree > Trunk > Branch (12) > node under test (12 instances), forces attach to the branch. */
export function auditSpecs(def: NodeDef, paramId: string, variance: VarianceValue): NodeSpec[] {
  const param = def.params.find((p) => p.id === paramId);
  if (!param) throw new Error(`${def.type}.${paramId}`);
  const prerequisite = paramId.startsWith('splits') ? PREREQUISITES.splits : {};
  const sutParams: Record<string, ParamValue | { value: ParamValue; variance?: VarianceValue }> = { ...prerequisite };
  if (def.params.some((p) => p.id === 'number')) sutParams.number = 12;
  sutParams[paramId] = { value: (sutParams[paramId] as ParamValue | undefined) ?? (param.default as ParamValue), variance };
  const tree: NodeSpec = { id: 'tree', type: 'output.tree', parent: null, params: { season: 0.6, showDroppedLeaves: true } };
  const trunk: NodeSpec = { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { length: 8, radius: 0.3 } };
  const branch: NodeSpec = { id: 'branch', type: 'generator.branch', parent: 'trunk', params: { number: 12, length: 3, radius: 0.05 } };
  switch (def.type) {
    case 'output.tree':
      return [{ ...tree, params: { ...tree.params, [paramId]: sutParams[paramId] as never } }, trunk, branch, { id: 'leaf', type: 'generator.leaf', parent: 'branch', params: { number: 12 } }];
    case 'generator.trunk':
      return [tree, { ...trunk, params: { ...trunk.params, ...sutParams } }, branch];
    case 'generator.root':
    case 'generator.spine':
    case 'generator.branch':
      return [tree, trunk, { id: 'sut', type: def.type, parent: 'trunk', params: sutParams }, { id: 'leaf', type: 'generator.leaf', parent: 'sut', params: { number: 12 } }];
    default:
      if (def.category === 'force') return [tree, trunk, branch, { id: 'sut', type: def.type, parent: null, params: sutParams }];
      return [tree, trunk, branch, { id: 'sut', type: def.type, parent: 'branch', params: sutParams }];
  }
}

function attachForce(model: GraphModel, def: NodeDef): void {
  if (def.category !== 'force') return;
  const pair = model.findPortPair('sut', 'branch', 'attachment');
  if (pair) model.insertEdge(model.makeEdge(pair.from, pair.to, 'a-sut-branch'));
}

/** Hash of the generated scene for one (graph, seed). */
export async function sceneHash(def: NodeDef, paramId: string, variance: VarianceValue, seed: number): Promise<string> {
  const model = buildGraph(auditSpecs(def, paramId, variance));
  attachForce(model, def);
  const result = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed, lod: 0, token: new CancellationSource().token });
  return hashContent(result.scene).hex();
}

/** True when switching the variance on changes the scene for at least one of a few global seeds. */
export async function varianceChangesScene(def: NodeDef, paramId: string, amount: number): Promise<boolean> {
  for (const seed of SEEDS) {
    if ((await sceneHash(def, paramId, 0, seed)) !== (await sceneHash(def, paramId, amount, seed))) return true;
  }
  return false;
}
