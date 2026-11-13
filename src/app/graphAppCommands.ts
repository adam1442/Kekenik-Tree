import type { AlignMode } from '@/graph/model/layout';
import type { AppCommand } from './commands';
import type { AppContext } from './context';

/**
 * Graph editing commands. Commands with `scope: 'graph'` are keyboard-dispatched by the graph panel only
 * (see ui/panels/graph/graphKeys.ts); the others (Edit menu) work globally. The shortcut map is documented in
 * docs/USER_GUIDE.md and shown in Help > Keyboard Shortcuts.
 */
export function registerGraphCommands(app: AppContext): void {
  const { commands, store } = app;
  const g = app.graph;
  const add = (cmd: AppCommand): void => commands.register(cmd);
  const hasSel = (): boolean => store.get().selection.length > 0;
  const scoped = (id: string, label: string, shortcut: string | undefined, run: () => void, enabled?: () => boolean): void =>
    add({ id: `graph.${id}`, label, shortcut, scope: shortcut ? 'graph' : undefined, run, enabled });

  // ---- global Edit menu ----
  add({ id: 'edit.cut', label: 'Cut', shortcut: 'Mod+X', run: () => g.cut(), enabled: hasSel });
  add({ id: 'edit.copy', label: 'Copy', shortcut: 'Mod+C', run: () => void g.copy(), enabled: hasSel });
  add({ id: 'edit.paste', label: 'Paste', shortcut: 'Mod+V', run: () => g.paste(), enabled: () => g.hasClipboard() });
  add({ id: 'edit.duplicate', label: 'Duplicate', shortcut: 'Mod+D', run: () => g.duplicate(), enabled: hasSel });
  add({ id: 'edit.delete', label: 'Delete', shortcut: 'Delete', extraShortcuts: ['Backspace'], run: () => g.deleteSelection(false), enabled: hasSel });
  add({ id: 'edit.selectAll', label: 'Select All', shortcut: 'Mod+A', run: () => g.selectAll() });

  // ---- graph-panel scoped ----
  scoped('addNode', 'Add Node…', 'Tab', () => g.view?.openAddNode());
  scoped('rename', 'Rename', 'F2', () => {
    const id = g.getSelection()[0];
    if (id) g.view?.startRename(id);
  }, hasSel);
  scoped('fit', 'Fit All', 'A', () => g.requestView('fit'));
  scoped('frame', 'Frame Selected', 'F', () => g.requestView('frame'), hasSel);
  scoped('deleteKeepChildren', 'Delete (Keep Children)', 'Shift+Delete', () => g.deleteSelection(true), hasSel);
  scoped('autoLayout', 'Auto Layout', 'L', () => g.autoLayout('all'));
  scoped('layoutSelection', 'Layout Selected Branch', 'Shift+L', () => g.autoLayout('selection'), hasSel);
  scoped('toggleEnabled', 'Enable / Disable', 'E', () => g.setFlag('enabled'), hasSel);
  scoped('toggleBypass', 'Bypass', 'B', () => g.setFlag('bypass'), hasSel);
  scoped('toggleSolo', 'Solo', 'S', () => g.setFlag('solo'), hasSel);
  scoped('toggleCollapse', 'Collapse / Expand Branch', 'C', () => g.setFlag('collapsed'), hasSel);
  scoped('toggleLock', 'Lock / Unlock', 'Alt+L', () => g.setFlag('locked'), hasSel);
  scoped('selectParent', 'Select Parent', '[', () => g.selectParent(), hasSel);
  scoped('selectChildren', 'Select Children', ']', () => g.selectChildren(), hasSel);
  scoped('selectSubtree', 'Select Branch (All Descendants)', 'Mod+]', () => g.selectSubtree(), hasSel);
  scoped('group', 'Group Selected', 'Mod+G', () => g.addGroup(), hasSel);
  scoped('clearSelection', 'Deselect All', 'Mod+Shift+A', () => g.clearSelection(), hasSel);

  const align = (id: string, label: string, mode: AlignMode): void => scoped(`align.${id}`, label, undefined, () => g.alignSelection(mode));
  align('left', 'Align Left', 'left');
  align('right', 'Align Right', 'right');
  align('top', 'Align Top', 'top');
  align('bottom', 'Align Bottom', 'bottom');
  align('centerX', 'Align Center Horizontally', 'centerX');
  align('centerY', 'Align Center Vertically', 'centerY');
  scoped('distribute.x', 'Distribute Horizontally', undefined, () => g.distributeSelection('x'));
  scoped('distribute.y', 'Distribute Vertically', undefined, () => g.distributeSelection('y'));
}
