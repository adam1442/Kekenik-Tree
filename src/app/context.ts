import type { AppState } from '@/contracts/app';
import type { EventBus } from '@/core/eventBus';
import type { Store } from '@/core/store';
import type { DockManager } from '@/ui/docking/dockManager';
import type { Viewport } from '@/viewport/viewport';
import type { CommandRegistry, UndoStack } from './commands';
import type { EngineHost } from './engineHost';
import type { ProjectManager } from './project/projectManager';
import type { GraphSession } from './graphSession';

export interface AppEvents {
  /** Layout was reset / replaced by a preset. */
  'layout:replaced': undefined;
  /** Re-run generation with the current seed. */
  'tree:regenerate': undefined;
  /** Re-evaluate without clearing the cache (nodes with a `dependencyKey` pick up external changes). */
  'tree:refresh': undefined;
  /** The active document's graph changed (any edit, undo or redo). The engine debounces and re-evaluates. */
  'graph:changed': { docId: string };
  /** The Materials panel's "Edit mesh" button was pressed. */
  'material:editMesh': { materialId: string };
}

/**
 * Application context: the handful of singletons panels need.
 * Created in bootstrap(); panels fetch it with getApp(). `dock` is assigned right after the DockManager is built
 * (panels are constructed during that call, so they must not touch `dock` while initialising).
 */
export interface AppContext {
  store: Store<AppState>;
  events: EventBus<AppEvents>;
  commands: CommandRegistry;
  undo: UndoStack;
  /** Graph model + selection + editing operations for the active document. */
  graph: GraphSession;
  /** Evaluation engine: results and diagnostics. */
  engine: EngineHost;
  /** Documents <-> files: new / open / save / recovery / templates. */
  project: ProjectManager;
  /** Positioned layer above the dock for modal dialogs (FloatingWindow container). */
  dialogLayer: HTMLElement;
  dock: DockManager | null;
  /** Currently active 3D viewport (set by the viewport panel). */
  viewport: Viewport | null;
  notify(message: string): void;
}

let current: AppContext | null = null;

export function setApp(ctx: AppContext | null): void {
  current = ctx;
}

export function getApp(): AppContext {
  if (!current) throw new Error('App context is not initialised');
  return current;
}
