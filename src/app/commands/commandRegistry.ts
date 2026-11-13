/** Named, menu/shortcut-bindable actions. Menus and shortcuts reference commands by id. */
export interface AppCommand {
  id: string;
  label: string;
  /** e.g. "Mod+Shift+Z", "F", "Shift+Space". */
  shortcut?: string;
  /** Additional accelerators (e.g. Ctrl+Y for redo). */
  extraShortcuts?: string[];
  /**
   * When set, the shortcut is only active while that panel has focus/hover and is dispatched by the panel itself
   * (e.g. 'graph': `F` frames the selection in the graph while `F` frames the viewport elsewhere).
   */
  scope?: string;
  run(): void;
  enabled?(): boolean;
  checked?(): boolean;
}

export class CommandRegistry {
  private readonly map = new Map<string, AppCommand>();

  register(cmd: AppCommand): void {
    if (this.map.has(cmd.id)) throw new Error(`Command already registered: ${cmd.id}`);
    this.map.set(cmd.id, cmd);
  }

  get(id: string): AppCommand | undefined {
    return this.map.get(id);
  }

  run(id: string): void {
    const cmd = this.map.get(id);
    if (cmd && (cmd.enabled?.() ?? true)) cmd.run();
  }

  list(): AppCommand[] {
    return [...this.map.values()];
  }
}
