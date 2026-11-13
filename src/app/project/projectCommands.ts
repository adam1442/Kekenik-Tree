import type { AppCommand } from '../commands';
import type { AppContext } from '../context';

/** File-menu commands (New / Open / Save / Save As / Close / node templates) and their shortcuts. */
export function registerProjectCommands(app: AppContext): void {
  const add = (cmd: AppCommand): void => app.commands.register(cmd);
  const p = (): AppContext['project'] => app.project;
  // Browsers reserve Ctrl+N / Ctrl+W outside installed-app mode, so each also gets an Alt+Shift alias.
  add({ id: 'file.new', label: 'New', shortcut: 'Mod+N', extraShortcuts: ['Alt+Shift+N'], run: () => p().newProject() });
  add({ id: 'file.open', label: 'Open…', shortcut: 'Mod+O', run: () => void p().open() });
  add({ id: 'file.save', label: 'Save', shortcut: 'Mod+S', run: () => void p().save() });
  add({ id: 'file.saveAs', label: 'Save As…', shortcut: 'Mod+Shift+S', run: () => void p().saveAs() });
  add({ id: 'file.close', label: 'Close', shortcut: 'Mod+W', extraShortcuts: ['Alt+Shift+W'], run: () => void p().closeActive() });
  add({ id: 'file.exportTemplate', label: 'Export Node Template…', run: () => void p().exportTemplate(), enabled: () => app.store.get().selection.length > 0 });
  add({ id: 'file.importTemplate', label: 'Import Node Template…', run: () => void p().importTemplate() });
  add({ id: 'file.clearRecent', label: 'Clear Recent', run: () => void p().clearRecent() });
}
