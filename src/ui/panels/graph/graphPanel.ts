import { getApp } from '@/app/context';
import { h } from '../../components/dom';
import type { PanelInstance } from '../../docking/panelRegistry';
import { icon } from '../../icons/icons';
import { installGraphEmptyHint } from '../../onboarding/onboarding';
import { GraphCanvas } from './graphCanvas';
import { createGraphFooter } from './graphFooter';

/**
 * "Generation" panel: toolbar (Add / Actions / Randomize / settings), the interactive node graph and the attachment
 * counters footer. Registered with the panel registry under the id `graph`.
 */
export function createGraphPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  host.classList.add('kt-graph');
  const canvas = new GraphCanvas(app);

  const btn = (ic: string, label: string, menu: boolean, title: string, onClick: (b: HTMLButtonElement) => void): HTMLButtonElement => {
    const b = h('button', `kt-gen-btn${menu ? ' has-menu' : ''}`, icon(ic, 16), label ? h('span', '', label) : null);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', () => onClick(b));
    return b;
  };
  const toolbar = h(
    'div',
    'kt-gen-toolbar',
    btn('plusSquare', 'Add', false, 'Add node (Tab)', (b) => {
      const r = b.getBoundingClientRect();
      canvas.openAddNode({ x: r.left, y: r.bottom + 2 });
    }),
    btn('actions', 'Actions', true, 'Graph actions', (b) => canvas.showActionsMenu(b)),
    btn('dice', 'Randomize', false, 'Randomize seed (Shift+R)', () => app.commands.run('tree.randomize')),
    btn('gear', '', true, 'Graph settings', (b) => canvas.showSettingsMenu(b)),
  );
  const footer = createGraphFooter(app);
  host.append(toolbar, canvas.el, footer.el);
  const disposeHint = installGraphEmptyHint(app, canvas.el);

  app.graph.view = {
    openAddNode: () => canvas.openAddNode(),
    startRename: (id) => canvas.startRename(id),
  };

  return {
    onShow: () => canvas.renderer.flush(),
    dispose: () => {
      app.graph.view = null;
      disposeHint();
      footer.dispose();
      canvas.dispose();
    },
  };
}
