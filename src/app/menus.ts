import { isMac } from '@/ui/components/dom';
import type { MenuItem } from '@/ui/components/menu';
import type { AppContext } from './context';
import { formatShortcut } from './shortcuts';

/** Build a menu item from a registered command (label, shortcut, enabled/checked state). */
export function commandItem(app: AppContext, id: string, label?: string): MenuItem {
  const cmd = app.commands.get(id);
  if (!cmd) return { label: label ?? id, disabled: true };
  return {
    label: label ?? cmd.label,
    shortcut: cmd.shortcut ? formatShortcut(cmd.shortcut, isMac()) : undefined,
    checked: cmd.checked?.(),
    disabled: cmd.enabled ? !cmd.enabled() : false,
    run: () => app.commands.run(id),
  };
}

export interface TopMenu {
  label: string;
  items(): MenuItem[];
}

const SEP: MenuItem = { separator: true };

/** Menu bar definition. */
export function buildTopMenus(app: AppContext, panelItems: () => MenuItem[], layoutItems: () => MenuItem[]): TopMenu[] {
  const c = (id: string, label?: string): MenuItem => commandItem(app, id, label);
  return [
    {
      label: 'File',
      items: () => [
        c('file.new'),
        c('file.open'),
        c('file.openPreset'),
        {
          label: 'Open Recent',
          submenu: app.project.recentFiles().length === 0
            ? [{ label: 'No recent files', disabled: true }]
            : [...app.project.recentFiles().map((e) => ({ label: e.name, run: () => void app.project.openRecent(e.name) })), { separator: true } as MenuItem, c('file.clearRecent')],
        },
        SEP,
        c('file.save'),
        c('file.saveAs'),
        c('file.saveAsPreset'),
        SEP,
        c('file.importTemplate'),
        c('file.exportTemplate'),
        SEP,
        c('file.export'),
        SEP,
        c('file.close'),
      ],
    },
    {
      label: 'Edit',
      items: () => [
        { ...c('edit.undo'), label: app.store.get().canUndo ? `Undo ${app.store.get().undoLabel}` : 'Undo' },
        { ...c('edit.redo'), label: app.store.get().canRedo ? `Redo ${app.store.get().redoLabel}` : 'Redo' },
        SEP,
        c('edit.cut'),
        c('edit.copy'),
        c('edit.paste'),
        c('edit.duplicate'),
        c('edit.delete'),
        SEP,
        c('edit.selectAll'),
        SEP,
        c('edit.preferences'),
      ],
    },
    {
      label: 'View',
      items: () => [
        c('view.frame'),
        c('view.reset'),
        SEP,
        {
          label: 'View Mode',
          submenu: [
            ...['shaded', 'wireframe', 'shadedWire', 'flat', 'normals', 'uv', 'ao', 'skeleton'].map((m) => c(`view.mode.${m}`)),
            SEP,
            c('view.toggle.skeletonPoints'),
            c('view.toggle.skeletonRadii'),
            c('view.toggle.skeletonFrames'),
          ],
        },
        SEP,
        c('view.toggle.grid'),
        c('view.toggle.axes'),
        c('view.toggle.stats'),
        c('view.toggle.ground'),
        c('view.toggle.human'),
        SEP,
        c('window.maximizePanel'),
      ],
    },
    {
      label: 'Tree',
      items: () => [
        c('tree.randomize'),
        c('tree.regenerate'),
      ],
    },
    {
      label: 'Window',
      items: () => [...panelItems(), SEP, { label: 'Layout', submenu: layoutItems() }],
    },
    {
      label: 'Help',
      items: () => [c('help.welcome'), c('help.tour'), c('help.docs'), c('help.shortcuts'), SEP, c('help.about')],
    },
  ];
}
