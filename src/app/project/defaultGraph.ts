import type { GraphJSON } from '@/contracts/project';
import { GraphModel } from '@/graph/model/graphModel';

/** Id of the one node of a new project. */
export const TREE_NODE_ID = 'tree';

/**
 * Graph of every new project (and of the project opened at startup): the Tree output node and nothing else.
 * No generator, force or material node is attached; the user (or a sample project) adds them.
 */
export function defaultGraph(): GraphJSON {
  const model = new GraphModel();
  model.addNode({ id: TREE_NODE_ID, type: 'output.tree', name: 'Tree', x: 0, y: 0 });
  return model.toJSON();
}
