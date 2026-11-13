import type { AppContext } from '@/app/context';
import { getPreferences, setPreferences } from '@/app/preferences';
import { formatShortcut } from '@/app/shortcuts';
import { t } from '@/i18n';
import { builtinPresets } from '@/presets/catalog';
import { getThumbnailService, PLACEHOLDER_THUMB } from '@/presets/thumbnails';
import { NAV_SCHEMES } from '@/viewport/navScheme';
import { showInfoDialog } from '../components/dialogs';
import { h, isMac } from '../components/dom';
import { BUILTIN_LAYOUTS } from '../docking/layoutPresets';
import { loadPreset } from '../panels/libraryPanel';

/* ---------------------------------------------------------------- welcome ---------------------------------------- */

/** Welcome / start screen: new, open, recent, presets, layouts, tour. */
export function showWelcome(app: AppContext): void {
  let win: { close(): void } | null = null;
  const close = (): void => win?.close();
  const link = (label: string, run: () => void, title?: string): HTMLButtonElement => {
    const b = h('button', 'kt-welcome-link', label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', () => {
      close();
      run();
    });
    return b;
  };

  const recent = app.project.recentFiles().slice(0, 5);
  const left = h(
    'div',
    'kt-welcome-actions',
    h('h2', '', 'Start'),
    link(t('New Project'), () => app.commands.run('file.new'), 'Ctrl+N'),
    link(t('Open Project…'), () => app.commands.run('file.open'), 'Ctrl+O'),
    h('h2', '', t('Recent Projects')),
    ...(recent.length === 0 ? [h('p', '', 'No recent projects yet.')] : recent.map((r) => link(r.name, () => void app.project.openRecent(r.name)))),
    h('h2', '', 'Layouts'),
    ...BUILTIN_LAYOUTS.map((l) => link(l.label, () => {
        app.dock?.setLayout(l.build());
        app.events.emit('layout:replaced', undefined);
      }, 'Rearrange the panels')),
    h('h2', '', 'Help'),
    link(t('Take the tour'), () => startTour(app)),
    link(t('Keyboard Shortcuts'), () => showShortcutSheet(app), '?'),
    link(t('Preferences'), () => void app.commands.run('edit.preferences')),
  );

  const grid = h('div', 'kt-welcome-presets');
  const thumbs = getThumbnailService();
  for (const entry of builtinPresets().slice(0, 12)) {
    const img = h('img', 'kt-lib-thumb');
    img.alt = entry.name;
    img.src = PLACEHOLDER_THUMB;
    void thumbs.get(entry).then((url) => {
      img.src = url;
    });
    const card = h('div', 'kt-lib-card', img, h('div', 'kt-lib-name', entry.name));
    card.title = `${entry.name} — ${entry.description}`;
    card.addEventListener('click', () => {
      close();
      void loadPreset(app, entry);
    });
    grid.append(card);
  }
  const more = link('Browse the full Library…', () => app.dock?.openPanel('library'));

  const check = h('input');
  check.type = 'checkbox';
  check.checked = getPreferences().showWelcome;
  check.addEventListener('change', () => setPreferences({ showWelcome: check.checked }));
  const body = h(
    'div',
    'kt-welcome',
    h('div', '', h('h1', '', 'Kekenik Tree'), h('p', '', 'Procedural plant & tree generator. Pick a species to start, then tweak its parameters, animate the wind and export a GLB.')),
    h('div', 'kt-welcome-cols', left, h('div', '', h('h2', '', t('Start from a preset')), grid, h('div', 'kt-welcome-actions', more))),
    h('div', 'kt-welcome-foot', h('label', '', check, t('Show this window at startup')), h('span', '', `Help ▸ Welcome · ${formatShortcut('F1', isMac())} for shortcuts`)),
  );
  win = showInfoDialog(app.dialogLayer, `${t('Welcome')} — Kekenik Tree`, body, { w: 760, h: 560 });
}

export function maybeShowWelcome(app: AppContext): void {
  if (getPreferences().showWelcome) showWelcome(app);
}

/* ------------------------------------------------------------------ tour ----------------------------------------- */

interface TourStep {
  selector: string;
  title: string;
  text: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { selector: '[data-panel="library"]', title: 'Library', text: 'Browse 16 species. Double-click one (or drag it into the viewport) to open it as a new project. “Save Current…” adds your own presets.' },
  { selector: '[data-panel="graph"]', title: 'Generation graph', text: 'The plant is a graph: Tree → Trunk → Branches → Leaves. Press Tab or double-click the canvas to add nodes, drag from a node’s port to connect.' },
  { selector: '[data-panel="properties"]', title: 'Properties', text: 'Select a node to edit its parameters. Hover any label for a description; the % toggle adds random variance and the green curve button varies a value along the parent.' },
  { selector: '[data-panel="viewport"]', title: 'Viewport', text: 'LMB orbit · MMB / Shift+LMB pan · wheel zoom · F frames the tree. Alt+1…8 switch view modes.' },
  { selector: '[data-panel="timeline"]', title: 'Wind & Timeline', text: 'Open Window ▸ Wind & Timeline to set wind direction and strength and press play to preview the animation.' },
  { selector: '.kt-menubar', title: 'Export', text: 'File ▸ Export… (Ctrl+E) writes GLB / glTF / OBJ with LODs, baked AO and impostors.' },
];

/** Interactive tour: dims the UI and highlights one panel per step. */
export function startTour(app: AppContext, steps: readonly TourStep[] = TOUR_STEPS): void {
  app.dock?.openPanel('library');
  let index = 0;
  const mask = h('div', 'kt-tour-mask');
  const ring = h('div', 'kt-tour-ring');
  const card = h('div', 'kt-tour-card');
  document.body.append(mask, ring, card);

  const end = (): void => {
    mask.remove();
    ring.remove();
    card.remove();
    window.removeEventListener('keydown', onKey, true);
    setPreferences({ tourDone: true });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') end();
    if (e.key === 'ArrowRight') go(1);
    if (e.key === 'ArrowLeft') go(-1);
  };
  const show = (): void => {
    const step = steps[index] as TourStep;
    const target = document.querySelector<HTMLElement>(step.selector);
    const r = target?.getBoundingClientRect();
    if (r && r.width > 0) {
      ring.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      const left = Math.min(window.innerWidth - 300, Math.max(8, r.left + r.width / 2 - 140));
      const top = r.bottom + 12 + 170 > window.innerHeight ? Math.max(8, r.top + 12) : r.bottom + 12;
      card.style.cssText = `left:${left}px;top:${top}px`;
    } else {
      ring.style.cssText = 'left:50%;top:50%;width:0;height:0';
      card.style.cssText = `left:${window.innerWidth / 2 - 140}px;top:${window.innerHeight / 3}px`;
    }
    const back = h('button', 'kt-lib-btn', t('Back'));
    back.disabled = index === 0;
    back.addEventListener('click', () => go(-1));
    const next = h('button', 'kt-lib-btn primary', index === steps.length - 1 ? t('Done') : t('Next'));
    next.addEventListener('click', () => go(1));
    const skip = h('button', 'kt-lib-btn', 'Skip');
    skip.addEventListener('click', end);
    card.replaceChildren(h('h3', '', step.title), h('p', '', step.text), h('div', 'kt-tour-nav', h('span', 'kt-tour-step', `${index + 1} / ${steps.length}`), skip, back, next));
  };
  const go = (d: number): void => {
    const n = index + d;
    if (n >= steps.length) return end();
    index = Math.max(0, n);
    show();
  };
  mask.addEventListener('click', (e) => e.stopPropagation());
  window.addEventListener('keydown', onKey, true);
  show();
}

/* ------------------------------------------------------- shortcut cheat sheet ------------------------------------- */

const GROUP_LABELS: [string, string][] = [
  ['file.', 'File'],
  ['edit.', 'Edit'],
  ['view.', 'View'],
  ['window.', 'Window'],
  ['tree.', 'Tree'],
  ['graph.', 'Graph'],
  ['help.', 'Help'],
];

/** Shortcut cheat sheet generated from the command registry (always in sync with the real bindings). */
export function showShortcutSheet(app: AppContext): void {
  const mac = isMac();
  const groups = new Map<string, HTMLElement[]>();
  const add = (g: string, label: string, keys: string): void => {
    const rows = groups.get(g) ?? [];
    rows.push(h('div', 'kt-sheet-row', h('span', '', label), h('kbd', '', keys)));
    groups.set(g, rows);
  };
  for (const c of app.commands.list()) {
    if (!c.shortcut) continue;
    const g = GROUP_LABELS.find(([p]) => c.id.startsWith(p))?.[1] ?? 'Other';
    add(g, c.label, formatShortcut(c.shortcut, mac));
  }
  const scheme = NAV_SCHEMES.find((s) => s.id === getPreferences().navScheme);
  add('Viewport navigation', scheme?.label ?? 'Navigation', scheme?.help ?? '');
  add('Viewport navigation', 'Zoom', 'Wheel');
  add('Graph', 'Add node', 'Tab');
  add('Graph', 'Pan canvas', 'Space+drag / MMB');
  add('Graph', 'Rename node', 'F2');
  const order = ['Viewport navigation', ...GROUP_LABELS.map(([, l]) => l), 'Other'];
  const cols = order.filter((g) => groups.has(g)).map((g) => h('div', '', h('h3', '', g), ...(groups.get(g) as HTMLElement[])));
  showInfoDialog(app.dialogLayer, t('Keyboard Shortcuts'), h('div', 'kt-sheet', ...cols), { w: 760, h: 520 });
}

/* ----------------------------------------------------------- graph empty hint ------------------------------------- */

/** Shows a hint over the graph canvas while the document has no (or only the Tree) node. */
export function installGraphEmptyHint(app: AppContext, host: HTMLElement): () => void {
  host.style.position = host.style.position || 'relative';
  const hint = h('div', 'kt-empty-hint', h('b', '', 'Your graph is empty'), h('br'), 'Press Tab or double-click to add a Trunk, or open the Library and double-click a species.');
  hint.style.display = 'none';
  host.append(hint);
  const update = (): void => {
    hint.style.display = app.graph.model.nodeCount <= 1 ? 'block' : 'none';
  };
  const off = app.events.on('graph:changed', update);
  const offStore = app.store.subscribe((s, prev) => {
    if (s.activeDocumentId !== prev.activeDocumentId) update();
  });
  update();
  return () => {
    off();
    offStore();
    hint.remove();
  };
}
