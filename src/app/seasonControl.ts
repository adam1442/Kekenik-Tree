import type { GraphModel } from '@/graph/model/graphModel';
import type { GraphNode } from '@/graph/model/types';
import { getMaterialLibrary } from '@/materials/library';
import { clampSeason } from '@/seasons';
import type { AppContext } from './context';

export type SeasonFlag = 'showDroppedLeaves' | 'exportDroppedLeaves';

/** The Tree output node, which owns the Season value. */
export function findTreeNode(model: GraphModel): GraphNode | undefined {
  return model.nodes().find((n) => n.type === 'output.tree');
}

export function getSeason(app: AppContext): number {
  const node = findTreeNode(app.graph.model);
  const v = node?.params.season?.value;
  if (typeof v === 'number') return clampSeason(v);
  return clampSeason(app.project.metaOf(app.store.get().activeDocumentId)?.settings.season ?? 0);
}

export function getSeasonFlag(app: AppContext, flag: SeasonFlag): boolean {
  return findTreeNode(app.graph.model)?.params[flag]?.value === true;
}

/**
 * Change the Season where it takes effect: the Tree node's `season` (an undoable graph edit that re-evaluates every
 * generator, saved with the graph), mirrored into the project settings. Every Season control (toolbar popover,
 * Lighting panel, Properties > Tree Global) goes through here. `merge` joins a slider drag into one undo step.
 */
export function setSeason(app: AppContext, value: number, merge = false): void {
  const v = clampSeason(value);
  const settings = app.project.metaOf(app.store.get().activeDocumentId)?.settings;
  if (settings) settings.season = v;
  getMaterialLibrary().setSeason(v, true);
  const node = findTreeNode(app.graph.model);
  if (node) app.graph.setParam(node.id, 'season', { value: v }, merge);
  else {
    app.undo.markDirty();
    app.events.emit('tree:regenerate', undefined);
  }
}

export function setSeasonFlag(app: AppContext, flag: SeasonFlag, value: boolean): void {
  const node = findTreeNode(app.graph.model);
  if (node) app.graph.setParam(node.id, flag, { value }, false);
}
