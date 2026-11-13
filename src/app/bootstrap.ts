import { EventBus } from '@/core/eventBus';
import { h } from '@/ui/components/dom';
import { closeActiveMenu } from '@/ui/components/menu';
import { DockManager } from '@/ui/docking/dockManager';
import { defaultLayout } from '@/ui/docking/layoutPresets';
import { clearPanelRegistry } from '@/ui/docking/panelRegistry';
import { createTitleBar } from '@/ui/panels/menubar';
import { registerBuiltinPanels } from '@/ui/panels/registerPanels';
import { createStatusBar } from '@/ui/panels/statusbar';
import { layoutMenuItems, panelMenuItems, registerAppCommands } from './appCommands';
import { CommandRegistry, UndoStack } from './commands';
import { GraphSession } from './graphSession';
import '@/ui/icons/nodeIcons';
import '@/ui/components/paramWidgetRegistry';
import { registerDiscoveredNodes } from '@/graph/registry';
import { askText, showChoiceDialog } from '@/ui/components/dialogs';
import { setMeshAssetLookup } from '@/geometry/meshAssets';
import { EngineHost } from './engineHost';
import { createBrowserFileIO } from './project/fileAccess';
import { IndexedDbKeyValueStore } from './project/kvStore';
import { ProjectManager } from './project/projectManager';
import { installMaterialSystem } from '@/materials/install';
import { installExport } from '@/export/install';
import { installCrashHandler } from './crash';
import { installPreferences } from './installPreferences';
import { maybeShowWelcome } from '@/ui/onboarding/onboarding';
import { installPresetDrop } from '@/ui/panels/libraryPanel';
import { setApp, type AppContext, type AppEvents } from './context';
import { loadCurrentLayout, saveCurrentLayout } from './layoutStore';
import { buildTopMenus } from './menus';
import { attachShortcuts } from './shortcuts';
import { activeDocument, createAppStore } from './state';

/**
 * Build the whole application into `root`. Returns a dispose function (safe for React StrictMode double-mount / HMR).
 */
export function bootstrap(root: HTMLElement): () => void {
  const store = createAppStore();
  const events = new EventBus<AppEvents>();
  const commands = new CommandRegistry();
  const undo = new UndoStack(store);
  const dialogLayer = h('div', 'kt-dialog-layer');
  let messageTimer = 0;

  registerDiscoveredNodes();
  const graph = new GraphSession({ store, undo, appEvents: events, notify: (m) => app.notify(m) });
  const engine = new EngineHost({ store, events, graph });
  const project = new ProjectManager({
    store,
    graph,
    undo,
    fileIO: createBrowserFileIO(),
    kv: new IndexedDbKeyValueStore(),
    notify: (m) => app.notify(m),
    ui: { choose: (title, message, buttons) => showChoiceDialog(dialogLayer, title, message, buttons), ask: (title, initial) => askText(dialogLayer, title, initial) },
  });

  setMeshAssetLookup((id) => project.metaOf(store.get().activeDocumentId)?.assets.find((a) => a.id === id));

  const app: AppContext = {
    store,
    events,
    commands,
    undo,
    graph,
    engine,
    project,
    dialogLayer,
    dock: null,
    viewport: null,
    notify: (message) => {
      store.set({ message });
      window.clearTimeout(messageTimer);
      messageTimer = window.setTimeout(() => store.set({ message: '' }), 4000);
    },
  };
  setApp(app);

  clearPanelRegistry();
  registerBuiltinPanels();
  registerAppCommands(app);

  const dockHost = h('div', 'kt-dock-host');
  const menus = buildTopMenus(
    app,
    () => panelMenuItems(app),
    () => layoutMenuItems(app),
  );
  const titleBar = createTitleBar(menus);
  const status = createStatusBar(store);
  const shell = h('div', 'kt-app', titleBar.el, dockHost, status.el, dialogLayer);
  root.append(shell);

  const dock = new DockManager(loadCurrentLayout() ?? defaultLayout());
  app.dock = dock;
  dockHost.append(dock.element);

  let saveTimer = 0;
  const unsubDock = dock.onDidChange(() => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveCurrentLayout(dock.getLayout()), 250);
  });
  const syncTitle = (): void => titleBar.setTitle(`Kekenik Tree — ${activeDocument(store.get()).name}${store.get().dirty ? ' •' : ''}`);
  syncTitle();
  const unsubTitle = store.subscribe((s, prev) => {
    if (s.activeDocumentId !== prev.activeDocumentId || s.dirty !== prev.dirty) syncTitle();
  });
  const detachShortcuts = attachShortcuts(commands);
  const guard = (e: BeforeUnloadEvent): void => {
    if (!project.hasUnsavedChanges()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  const flush = (): void => {
    if (document.visibilityState === 'hidden' && project.hasUnsavedChanges()) void project.autosaveNow();
  };
  window.addEventListener('beforeunload', guard);
  document.addEventListener('visibilitychange', flush);
  const detachCrash = installCrashHandler();
  const disposePrefs = installPreferences(app);
  const detachDrop = installPresetDrop(app, dockHost);
  const disposeMaterials = installMaterialSystem(app);
  const disposeExport = installExport(app);
  void project.start().then(() => maybeShowWelcome(app));

  return () => {
    detachCrash();
    disposePrefs();
    detachDrop();
    disposeMaterials();
    disposeExport();
    window.clearTimeout(saveTimer);
    window.clearTimeout(messageTimer);
    saveCurrentLayout(dock.getLayout());
    unsubDock();
    unsubTitle();
    window.removeEventListener('beforeunload', guard);
    document.removeEventListener('visibilitychange', flush);
    project.dispose();
    engine.dispose();
    graph.dispose();
    detachShortcuts();
    closeActiveMenu();
    status.dispose();
    dock.dispose();
    shell.remove();
    events.clear();
    setApp(null);
  };
}
