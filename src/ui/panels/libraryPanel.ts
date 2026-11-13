import type { AppContext } from '@/app/context';
import { getApp } from '@/app/context';
import { activeDocument } from '@/app/state';
import { t } from '@/i18n';
import { builtinPresets, filterPresets, getPresetCatalog } from '@/presets/catalog';
import { getThumbnailService, PLACEHOLDER_THUMB } from '@/presets/thumbnails';
import { PRESET_CATEGORIES, type PresetCategory, type PresetEntry } from '@/presets/types';
import { askText } from '../components/dialogs';
import { h } from '../components/dom';
import type { PanelInstance } from '../docking/panelRegistry';

export const PRESET_DRAG_MIME = 'application/x-kekenik-preset';
/** Load a preset as a new document (File > Open semantics, but nothing is written to disk). */
export async function loadPreset(app: AppContext, entry: PresetEntry): Promise<void> {
  try {
    app.project.openProjectFile(await entry.load(), entry.name);
  } catch (e) {
    app.notify(`Could not load “${entry.name}”: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Save the active document as a user preset (asks for a name). */
export async function saveCurrentAsPreset(app: AppContext): Promise<void> {
  const doc = activeDocument(app.store.get());
  const name = await askText(app.dialogLayer, 'Save as Preset', doc.name.replace(/\.ktree$/i, ''));
  if (!name) return;
  const project = app.project.serialize(doc.id);
  await getPresetCatalog().saveUser(name, { ...project, name });
  app.notify(`Preset “${name}” saved to your library.`);
}

/** Make the viewport / graph accept dragged presets from the Library. Returns a dispose function. */
export function installPresetDrop(app: AppContext, area: HTMLElement): () => void {
  const hint = h('div', 'kt-drop-hint', 'Drop to load preset');
  area.style.position = area.style.position || 'relative';
  area.append(hint);
  const has = (e: DragEvent): boolean => e.dataTransfer?.types.includes(PRESET_DRAG_MIME) ?? false;
  const over = (e: DragEvent): void => {
    if (!has(e)) return;
    e.preventDefault();
    hint.classList.add('show');
  };
  const leave = (): void => hint.classList.remove('show');
  const drop = (e: DragEvent): void => {
    if (!has(e)) return;
    e.preventDefault();
    hint.classList.remove('show');
    if ((e.target as HTMLElement | null)?.closest('.kt-lib')) return;
    const id = e.dataTransfer?.getData(PRESET_DRAG_MIME);
    void getPresetCatalog()
      .all()
      .then((all) => {
        const entry = all.find((p) => p.id === id);
        if (entry) return loadPreset(app, entry);
        return undefined;
      });
  };
  area.addEventListener('dragover', over);
  area.addEventListener('dragleave', leave);
  area.addEventListener('drop', drop);
  return () => {
    area.removeEventListener('dragover', over);
    area.removeEventListener('dragleave', leave);
    area.removeEventListener('drop', drop);
    hint.remove();
  };
}

/** Dockable "Library" panel: searchable species browser with cached thumbnails, user presets and `.ktree` import / export. */
export function createLibraryPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  const catalog = getPresetCatalog();
  const thumbs = getThumbnailService();
  let entries: PresetEntry[] = builtinPresets();
  let query = '';
  let category: PresetCategory | 'User' | 'All' = 'All';
  let selected: PresetEntry | null = null;
  let disposed = false;

  const search = h('input', 'kt-lib-search');
  search.type = 'search';
  search.placeholder = t('Search presets…');
  search.title = 'Filter presets by name, category or tag';
  const saveBtn = h('button', 'kt-lib-btn', t('Save Current…'));
  saveBtn.title = 'Store the open project in your local library';
  const importBtn = h('button', 'kt-lib-btn', t('Import'));
  importBtn.title = 'Import a .ktree file as a user preset';
  const exportBtn = h('button', 'kt-lib-btn', t('Export'));
  exportBtn.title = 'Download the selected preset as a .ktree file';
  exportBtn.disabled = true;
  const bar = h('div', 'kt-lib-bar', search, saveBtn, importBtn, exportBtn);
  const cats = h('div', 'kt-lib-cats');
  const grid = h('div', 'kt-lib-grid');
  const info = h('div', 'kt-lib-info', 'Double-click a preset to open it, or drag it onto the viewport.');
  const root = h('div', 'kt-lib', bar, cats, grid, info);
  host.append(root);

  const renderCats = (): void => {
    cats.replaceChildren();
    const list: (PresetCategory | 'User' | 'All')[] = ['All', ...PRESET_CATEGORIES, 'User'];
    for (const c of list) {
      const b = h('button', `kt-lib-chip${c === category ? ' active' : ''}`, t(c));
      b.type = 'button';
      b.addEventListener('click', () => {
        category = c;
        renderCats();
        renderGrid();
      });
      cats.append(b);
    }
  };

  const select = (entry: PresetEntry | null): void => {
    selected = entry;
    exportBtn.disabled = !entry;
    grid.querySelectorAll<HTMLElement>('.kt-lib-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === entry?.id));
    info.replaceChildren(
      ...(entry ? [h('b', '', entry.name), ` · ${entry.category} — ${entry.description}`] : ['Double-click a preset to open it, or drag it onto the viewport.']),
    );
  };

  const renderGrid = (): void => {
    grid.replaceChildren();
    const shown = filterPresets(entries, query, category);
    if (shown.length === 0) {
      grid.append(h('div', 'kt-lib-empty', category === 'User' ? 'No user presets yet. Use “Save Current…” or Import.' : 'No presets match your search.'));
      return;
    }
    for (const entry of shown) {
      const img = h('img', 'kt-lib-thumb');
      img.alt = entry.name;
      img.draggable = false;
      img.src = PLACEHOLDER_THUMB;
      void thumbs.get(entry).then((url) => {
        if (!disposed) img.src = url;
      });
      const card = h('div', 'kt-lib-card', img, h('div', 'kt-lib-name', entry.name));
      card.dataset.id = entry.id;
      card.title = `${entry.name} — ${entry.description}`;
      card.draggable = true;
      if (selected?.id === entry.id) card.classList.add('selected');
      card.addEventListener('click', () => select(entry));
      card.addEventListener('dblclick', () => void loadPreset(app, entry));
      card.addEventListener('dragstart', (e) => {
        e.dataTransfer?.setData(PRESET_DRAG_MIME, entry.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
      });
      if (!entry.builtin) {
        const del = h('button', 'kt-lib-del', '×');
        del.title = 'Delete this user preset';
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          void catalog.deleteUser(entry.id);
        });
        card.append(del);
      }
      grid.append(card);
    }
  };

  const refresh = async (): Promise<void> => {
    entries = await catalog.all();
    if (disposed) return;
    if (selected && !entries.some((e) => e.id === selected?.id)) select(null);
    renderGrid();
  };

  search.addEventListener('input', () => {
    query = search.value;
    renderGrid();
  });
  saveBtn.addEventListener('click', () => void saveCurrentAsPreset(app));
  importBtn.addEventListener('click', () => {
    void (async () => {
      const file = await getImporter()(app);
      if (!file) return;
      try {
        const entry = await catalog.importBytes(file.name, file.bytes);
        app.notify(`Imported “${entry.name}”.`);
        category = 'User';
        renderCats();
      } catch (e) {
        app.notify(`Could not import: ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  });
  exportBtn.addEventListener('click', () => {
    if (!selected) return;
    void catalog.exportBytes(selected).then((f) => {
      pickDownloader(app)(f.name, f.bytes);
    });
  });

  const unsub = catalog.onChange(() => void refresh());
  renderCats();
  renderGrid();
  void refresh();

  return {
    dispose: () => {
      disposed = true;
      unsub();
      root.remove();
    },
  };
}

type Importer = (app: AppContext) => Promise<{ name: string; bytes: Uint8Array } | null>;

/** File picker for `.ktree` imports (a hidden `<input type=file>`, works in every browser). */
function getImporter(): Importer {
  return (app) =>
    new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ktree,.json';
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (!f) return resolve(null);
        void f.arrayBuffer().then(
          (buf) => resolve({ name: f.name, bytes: new Uint8Array(buf) }),
          () => {
            app.notify('Could not read file.');
            resolve(null);
          },
        );
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
}

function pickDownloader(_app: AppContext): (name: string, bytes: Uint8Array) => void {
  return (name, bytes) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
}
