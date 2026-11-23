import type { GraphModel } from '@/graph/model/graphModel';
import type { GraphNode } from '@/graph/model/types';
import { PORT } from '@/graph/ports';
import { windNodeParamId, writeWindParam, type WindNumericKey } from '@/viewport/wind/windParams';
import { getWindSystem } from '@/viewport/wind/windSystem';
import type { AppContext } from './context';

/** The Wind node attached to the Tree output: while one exists it replaces the project wind settings. */
export function findTreeWindNode(model: GraphModel): GraphNode | undefined {
  for (const edge of model.edges()) {
    if (edge.kind !== 'attachment' || edge.to.portId !== PORT.wind) continue;
    if (model.getNode(edge.to.nodeId)?.type !== 'output.tree') continue;
    const from = model.getNode(edge.from.nodeId);
    if (from?.type === 'wind.settings') return from;
  }
  return undefined;
}

/**
 * Change one wind setting where it takes effect: on the Wind node attached to the Tree (an undoable graph edit, saved
 * with the graph) or, without such a node, in the project wind settings. Every wind control (toolbar popover, Wind
 * panel, Properties > Global Wind, the arrow gizmo) goes through here so that none of them can be overridden silently.
 */
export function setWindParam(app: AppContext, key: WindNumericKey | 'enabled', value: number | boolean, merge = false): void {
  const node = findTreeWindNode(app.graph.model);
  if (node) {
    app.graph.setParam(node.id, key === 'enabled' ? 'enabled' : windNodeParamId(key), { value }, merge);
    return;
  }
  const settings = app.project.metaOf(app.store.get().activeDocumentId)?.settings.wind;
  if (!settings) return;
  if (key === 'enabled') settings.enabled = Boolean(value);
  else writeWindParam(settings, key, Number(value));
  app.undo.markDirty();
  getWindSystem().syncProject(settings);
}
