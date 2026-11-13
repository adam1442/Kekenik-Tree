import type { PanelInstance } from '@/ui/docking/panelRegistry';
import { h } from '@/ui/components/dom';
import { mountLodEditor } from './lodEditor';

/** Dockable "LODs" panel: LOD definitions, generated triangle counts, viewport preview and distance simulation. */
export function createLodPanel(host: HTMLElement): PanelInstance {
  const root = h('div', 'kt-xp-panel');
  host.append(root);
  const dispose = mountLodEditor(root);
  return {
    dispose: () => {
      dispose();
      root.remove();
    },
  };
}
