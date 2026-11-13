import { VIEW_MODES, VIEW_MODE_LABELS } from '@/contracts/app';
import { h } from '@/ui/components/dom';
import { showInfoDialog, showPromptDialog } from '@/ui/components/dialogs';
import type { MenuItem } from '@/ui/components/menu';
import { BUILTIN_LAYOUTS, defaultLayout } from '@/ui/docking/layoutPresets';
import { listPanelDefs } from '@/ui/docking/panelRegistry';
import type { DockLayout } from '@/ui/docking/types';
import type { AppCommand } from './commands';
import type { AppContext } from './context';
import { deleteNamedLayout, listSavedLayouts, loadNamedLayout, saveNamedLayout } from './layoutStore';
import { registerGraphCommands } from './graphAppCommands';
import { registerExportCommands } from '@/export/install';
import { registerProjectCommands } from './project/projectCommands';
import { showShortcutSheet, showWelcome, startTour } from '@/ui/onboarding/onboarding';
import { showPreferences } from '@/ui/onboarding/preferencesDialog';
import { saveCurrentAsPreset } from '@/ui/panels/libraryPanel';
import { activeDocument } from './state';


export function applyLayout(app: AppContext, layout: DockLayout): void {
  app.dock?.setLayout(layout);
  app.events.emit('layout:replaced', undefined);
}

const USER_GUIDE_URL = 'https://github.com/adam1442/Kekenik-Tree/blob/main/docs/USER_GUIDE.md';

/** Registers every application command (menus, shortcuts and toolbars reference them by id). */
export function registerAppCommands(app: AppContext): void {
  const { commands, store } = app;
  const add = (cmd: AppCommand): void => commands.register(cmd);

  registerProjectCommands(app);
  registerExportCommands(app);
  add({ id: 'edit.preferences', label: 'Preferences…', run: () => showPreferences(app) });
  add({ id: 'file.openPreset', label: 'Open Preset…', shortcut: 'Mod+Shift+O', run: () => app.dock?.openPanel('library') });
  add({ id: 'file.saveAsPreset', label: 'Save as Preset…', run: () => void saveCurrentAsPreset(app) });

  add({ id: 'edit.undo', label: 'Undo', shortcut: 'Mod+Z', run: () => app.undo.undo(), enabled: () => store.get().canUndo });
  add({ id: 'edit.redo', label: 'Redo', shortcut: 'Mod+Shift+Z', extraShortcuts: ['Mod+Y'], run: () => app.undo.redo(), enabled: () => store.get().canRedo });
  registerGraphCommands(app);

  add({ id: 'view.frame', label: 'Frame Selection', shortcut: 'F', run: () => app.viewport?.frame() });
  add({ id: 'view.frameSelection', label: 'Zoom to Selection', shortcut: 'Shift+F', run: () => app.viewport?.frameNodes(store.get().selection) });
  add({ id: 'view.reset', label: 'Reset Camera', shortcut: 'Home', run: () => app.viewport?.resetCamera() });
  VIEW_MODES.forEach((mode, i) =>
    add({
      id: `view.mode.${mode}`,
      label: VIEW_MODE_LABELS[mode],
      shortcut: i < 9 ? `Alt+${i + 1}` : undefined,
      run: () => store.set({ viewMode: mode }),
      checked: () => store.get().viewMode === mode,
    }),
  );
  const toggle = (
    id: string,
    label: string,
    key:
      | 'showGrid'
      | 'showAxes'
      | 'showStats'
      | 'showGround'
      | 'showHuman'
      | 'showSkeletonPoints'
      | 'showSkeletonRadii'
      | 'showSkeletonFrames'
      | 'spinesOnTop'
      | 'showAttachmentFrames',
    shortcut?: string,
  ): void =>
    add({
      id: `view.toggle.${id}`,
      label,
      shortcut,
      run: () => store.set({ [key]: !store.get()[key] }),
      checked: () => store.get()[key],
    });
  toggle('grid', 'Show Grid', 'showGrid');
  toggle('axes', 'Show Axes Gizmo', 'showAxes');
  toggle('stats', 'Show Polygon Stats', 'showStats');
  toggle('ground', 'Show Ground & Shadows', 'showGround');
  toggle('human', 'Show Human Scale', 'showHuman');
  toggle('spinesOnTop', 'Spines on top', 'spinesOnTop');
  toggle('showAttachmentFrames', 'Attachment frames', 'showAttachmentFrames');
  toggle('skeletonPoints', 'Skeleton: Sample Points', 'showSkeletonPoints');
  toggle('skeletonRadii', 'Skeleton: Radius Circles', 'showSkeletonRadii', 'Alt+R');
  toggle('skeletonFrames', 'Skeleton: Normal Frames', 'showSkeletonFrames', 'Alt+N');

  add({ id: 'window.maximizePanel', label: 'Maximize Panel', shortcut: 'Shift+Space', run: () => app.dock?.toggleMaximize() });
  add({ id: 'window.resetLayout', label: 'Reset Layout', run: () => applyLayout(app, defaultLayout()) });
  add({
    id: 'window.saveLayout',
    label: 'Save Layout As…',
    run: () =>
      showPromptDialog(app.dialogLayer, 'Save Layout As…', 'My Layout', (name) => {
        if (app.dock) saveNamedLayout(name, app.dock.getLayout());
        app.notify(`Layout “${name}” saved.`);
      }),
  });

  add({
    id: 'tree.randomize',
    label: 'Randomize Seed',
    shortcut: 'Shift+R',
    run: () => {
      const doc = activeDocument(store.get());
      const oldSeed = doc.seed;
      const newSeed = Math.floor(Math.random() * 1_000_000);
      const setSeed = (seed: number): void =>
        store.set((s) => ({ documents: s.documents.map((d) => (d.id === doc.id ? { ...d, seed } : d)) }));
      app.undo.execute({ label: 'Randomize', do: () => setSeed(newSeed), undo: () => setSeed(oldSeed) });
      app.notify(`Seed ${newSeed}`);
    },
  });
  add({ id: 'tree.regenerate', label: 'Regenerate', shortcut: 'Shift+G', run: () => app.events.emit('tree:regenerate', undefined) });

  add({ id: 'help.docs', label: 'User Guide', run: () => void window.open(USER_GUIDE_URL, '_blank', 'noopener,noreferrer') });
  add({ id: 'help.welcome', label: 'Welcome Screen', run: () => showWelcome(app) });
  add({ id: 'help.tour', label: 'Interactive Tour', run: () => startTour(app) });
  add({ id: 'help.shortcuts', label: 'Keyboard Shortcuts', shortcut: 'Shift+?', extraShortcuts: ['F1'], run: () => showShortcutSheet(app) });
  add({
    id: 'help.about',
    label: 'About Kekenik Tree',
    run: () =>
      showInfoDialog(
        app.dialogLayer,
        'About Kekenik Tree',
        h('div', 'kt-about', h('b', '', 'Kekenik Tree'), h('p', '', 'Node-based procedural plant & tree generator.'), h('p', '', 'Species library, node graph, wind, LODs and GLB export — all in the browser.')),
        { w: 380, h: 220 },
      ),
  });
}

/** Window-menu entries: one checkable item per registered panel. */
export function panelMenuItems(app: AppContext): MenuItem[] {
  return listPanelDefs().map((def) => {
    const open = app.dock?.isOpen(def.id) ?? false;
    return {
      label: def.title,
      checked: open,
      disabled: def.closable === false && open,
      run: () => app.dock?.togglePanel(def.id),
    };
  });
}

/** Window > Layout submenu: presets, saved layouts, save, reset. */
export function layoutMenuItems(app: AppContext): MenuItem[] {
  const saved = listSavedLayouts();
  const items: MenuItem[] = BUILTIN_LAYOUTS.map((p) => ({ label: p.label, run: () => applyLayout(app, p.build()) }));
  if (saved.length > 0) {
    items.push({ separator: true });
    for (const name of saved) {
      items.push({
        label: name,
        submenu: [
          {
            label: 'Load',
            run: () => {
              const layout = loadNamedLayout(name);
              if (layout) applyLayout(app, layout);
              else app.notify(`Layout “${name}” is invalid.`);
            },
          },
          { label: 'Delete', run: () => deleteNamedLayout(name) },
        ],
      });
    }
  }
  items.push({ separator: true }, { label: 'Save Layout As…', run: () => app.commands.run('window.saveLayout') }, { label: 'Reset Layout', run: () => app.commands.run('window.resetLayout') });
  return items;
}
