import type { Command } from '@/contracts/app';
import { SetParamCommand } from './commands/graphCommands';
import type { AppContext } from './context';
import { getNodeDef } from '@/graph/registry';
import { getMaterialLibrary } from '@/materials/library';

/** Parameters the lightmap packer reads from the graph: generator weights and material unwrap scales. */
const LIGHTMAP_PARAM_IDS: readonly string[] = ['lightmapWeight', 'unwrapScale'];

/**
 * "Reset lightmap": puts every generator Lightmap weight (leaves 0, everything else 1) and every material Unwrap scale (1) back to the
 * default of its parameter definition, as ONE undo step; Unwrap scales of the project material library (materials that are not graph
 * nodes) go back to 1 as a second undo step of the library. Returns the number of values changed.
 */
export function resetLightmap(app: AppContext): number {
  const model = app.graph.model;
  const commands: Command[] = [];
  for (const node of model.nodes()) {
    const def = getNodeDef(node.type);
    if (!def) continue;
    for (const id of LIGHTMAP_PARAM_IDS) {
      const pd = def.params.find((p) => p.id === id);
      const stored = node.params[id];
      if (!pd || !stored || stored.value === pd.default) continue;
      commands.push(new SetParamCommand(model, node.id, id, { ...structuredClone(stored), value: pd.default as never }));
    }
  }
  if (commands.length > 0) app.graph.transaction('Reset lightmap', commands);
  const lib = getMaterialLibrary();
  const stale = lib.materials().filter((m) => m.atlas.unwrapScale !== undefined && m.atlas.unwrapScale !== 1);
  if (stale.length > 0) {
    lib.edit('Reset lightmap', 'materials', () => {
      for (const m of stale) m.atlas.unwrapScale = 1;
    });
  }
  return commands.length + stale.length;
}
