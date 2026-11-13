import { loadJSON, saveJSON } from '@/app/settings';
import type { NodeCategory, NodeDef } from '@/contracts/nodes';
import { searchDefs } from '@/graph/model/search';
import { h } from '../../components/dom';
import { closeActiveMenu } from '../../components/menu';
import { icon } from '../../icons/icons';

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  generator: 'Generators',
  modifier: 'Modifiers',
  force: 'Forces',
  material: 'Materials',
  mesh: 'Meshes',
  wind: 'Wind',
  utility: 'Utilities',
  output: 'Output',
};
export const CATEGORY_ORDER: NodeCategory[] = ['generator', 'modifier', 'force', 'material', 'mesh', 'wind', 'utility', 'output'];

const RECENT_KEY = 'graph.recent';
const MAX_RECENT = 6;

export function loadRecent(): string[] {
  const raw = loadJSON(RECENT_KEY);
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
}

function pushRecent(type: string): void {
  saveJSON(RECENT_KEY, [type, ...loadRecent().filter((t) => t !== type)].slice(0, MAX_RECENT));
}

/** Sort defs by category order, then label (stable base order for the empty-query view). */
export function sortDefs(defs: NodeDef[]): NodeDef[] {
  return [...defs].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.label.localeCompare(b.label));
}

export interface AddNodePopupOptions {
  /** Screen position (client coordinates) of the popup's top-left corner. */
  x: number;
  y: number;
  defs: NodeDef[];
  title?: string;
  onPick(def: NodeDef): void;
  onClose?(): void;
}

export function nodeChip(def: NodeDef, size = 18): HTMLElement {
  const chip = h('span', 'kt-node-chip', icon(def.icon, size - 6));
  chip.style.setProperty('--kt-n-color', def.color);
  chip.style.width = `${size}px`;
  chip.style.height = `${size}px`;
  return chip;
}

/** Searchable add-node popup: fuzzy search, categories, recent, full keyboard navigation. */
export function showAddNodePopup(opts: AddNodePopupOptions): { close(): void } {
  closeActiveMenu();
  const base = sortDefs(opts.defs);
  const input = h('input', 'kt-field kt-addnode-input');
  input.type = 'text';
  input.placeholder = opts.title ?? 'Search nodes…';
  input.setAttribute('aria-label', 'Search nodes');
  const list = h('div', 'kt-addnode-list');
  list.setAttribute('role', 'listbox');
  const root = h('div', 'kt-addnode', input, list);
  let rows: { def: NodeDef; el: HTMLElement }[] = [];
  let index = 0;
  let closed = false;

  const setIndex = (i: number): void => {
    if (rows.length === 0) return;
    index = (i + rows.length) % rows.length;
    rows.forEach((r, n) => r.el.classList.toggle('active', n === index));
    rows[index]?.el.scrollIntoView?.({ block: 'nearest' });
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onOutside, true);
    root.remove();
    opts.onClose?.();
  };
  const pick = (def: NodeDef): void => {
    pushRecent(def.type);
    close();
    opts.onPick(def);
  };
  const onOutside = (e: PointerEvent): void => {
    if (!root.contains(e.target as Node)) close();
  };

  const render = (): void => {
    const q = input.value;
    list.replaceChildren();
    rows = [];
    const recent = loadRecent();
    const matches = searchDefs(
      base.map((d) => ({ ...d, def: d })),
      q,
      recent,
    ).map((x) => x.def);
    const addRow = (def: NodeDef, showCategory: boolean): void => {
      const el = h('div', 'kt-addnode-row', nodeChip(def), h('span', 'kt-addnode-name', def.label), h('span', 'kt-addnode-cat', showCategory ? CATEGORY_LABELS[def.category] : (def.description ?? '')));
      el.setAttribute('role', 'option');
      el.title = def.description ?? def.label;
      el.addEventListener('pointerenter', () => setIndex(rows.findIndex((r) => r.el === el)));
      el.addEventListener('click', () => pick(def));
      rows.push({ def, el });
      list.append(el);
    };
    if (matches.length === 0) {
      list.append(h('div', 'kt-addnode-empty', 'No matching nodes'));
      return;
    }
    if (q.trim() === '') {
      const recents = recent.map((t) => matches.find((d) => d.type === t)).filter((d): d is NodeDef => d !== undefined);
      if (recents.length > 0) {
        list.append(h('div', 'kt-addnode-head', 'Recent'));
        recents.forEach((d) => addRow(d, false));
      }
      for (const cat of CATEGORY_ORDER) {
        const defs = matches.filter((d) => d.category === cat);
        if (defs.length === 0) continue;
        list.append(h('div', 'kt-addnode-head', CATEGORY_LABELS[cat]));
        defs.forEach((d) => addRow(d, false));
      }
    } else {
      matches.forEach((d) => addRow(d, true));
    }
    setIndex(0);
  };

  input.addEventListener('input', render);
  root.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(index + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(index - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows[index];
      if (r) pick(r.def);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  });
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  document.body.append(root);
  render();
  const r = root.getBoundingClientRect();
  root.style.left = `${Math.max(4, Math.min(opts.x, window.innerWidth - r.width - 4))}px`;
  root.style.top = `${Math.max(4, Math.min(opts.y, window.innerHeight - r.height - 4))}px`;
  document.addEventListener('pointerdown', onOutside, true);
  input.focus();
  return { close };
}
