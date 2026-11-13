/**
 * Panel registry. EVERY panel (Viewport, Node Graph, Properties, Library, Timeline ...) must be registered
 * here so it can be docked, tabbed and floated. Never hard-wire a panel into the shell.
 */
export type DockHint = 'left' | 'right' | 'center' | 'bottom' | 'float';

export interface PanelContext {
  readonly panelId: string;
  /** Start dragging this panel (use from a custom header such as the viewport's document-tab strip). */
  startDrag(e: PointerEvent): void;
  /** Open the panel menu (Float, Maximize, Close ...) at the pointer. */
  showMenu(e: MouseEvent): void;
  toggleFloat(): void;
  toggleMaximize(): void;
  isFloating(): boolean;
}

export interface PanelInstance {
  dispose?(): void;
  /** Called when the panel becomes the visible tab. */
  onShow?(): void;
}

export interface PanelDef {
  id: string;
  title: string;
  /** Icon registry key. */
  icon?: string;
  /** Builds the panel into `host`. Panels keep state while docked/floated (host is never recreated). */
  component(host: HTMLElement, ctx: PanelContext): PanelInstance | void;
  /** Where "Window > Panel" opens it when closed. */
  defaultDock: DockHint;
  minSize?: { w: number; h: number };
  /** Default false = closable. Viewport sets false. */
  closable?: boolean;
  /** v1: all panels are singletons; the flag is reserved for multi-instance panels. */
  singleton?: boolean;
  /** Hide the group header when the panel is alone in its group (panel draws its own header). */
  headerless?: boolean;
  floatSize?: { w: number; h: number };
}

const panels = new Map<string, PanelDef>();

export function registerPanel(def: PanelDef): void {
  if (panels.has(def.id)) throw new Error(`Panel already registered: ${def.id}`);
  panels.set(def.id, def);
}

export function getPanelDef(id: string): PanelDef | undefined {
  return panels.get(id);
}

export function listPanelDefs(): PanelDef[] {
  return [...panels.values()];
}

/** Test helper. */
export function clearPanelRegistry(): void {
  panels.clear();
}
