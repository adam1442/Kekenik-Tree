import { getApp } from '@/app/context';
import { askText } from '../../components/dialogs';
import { h, iconButton } from '../../components/dom';
import { showMenu, type MenuItem } from '../../components/menu';
import { icon } from '../../icons/icons';

export interface AssetItem {
  id: string;
  name: string;
}

export interface AssetHeaderOptions {
  /** Singular noun for tooltips and menus ("material", "mask", ...). */
  noun: string;
  items(): AssetItem[];
  selected(): string | null;
  onSelect(id: string): void;
  onAdd(): void;
  onDuplicate(): void;
  onRename(id: string, name: string): void;
  onDelete(id: string): void;
  onMove(id: string, delta: number): void;
  /** JSON text of the selected asset (clipboard copy), null when nothing is selected. */
  copy(): string | null;
  paste(text: string): void;
  /** Pan / hand tool button placed left of the dropdown (omit when the panel has its own, e.g. inside a preview). */
  hand?: { active(): boolean; toggle(): void };
  disableAdd?: boolean;
}

export interface AssetHeader {
  el: HTMLElement;
  /** Rebuild the dropdown label (call after selection or names changed). */
  refresh(): void;
  handButton: HTMLButtonElement | null;
}

let internalClipboard = '';

/**
 * Shared header row of every asset panel: [hand] [asset dropdown ▾] [± duplicate] [+ add] [clipboard].
 * The dropdown lists the assets; its "Manage" submenu renames, deletes, reorders and searches.
 */
export function createAssetHeader(o: AssetHeaderOptions): AssetHeader {
  const app = getApp();
  const label = h('span', 'kt-select-label');
  const dropdown = h('button', 'kt-select kt-asset-select', label, icon('chevronDown', 12));
  dropdown.type = 'button';

  const current = (): AssetItem | undefined => o.items().find((i) => i.id === o.selected());

  const manage = (): MenuItem[] => {
    const cur = current();
    return [
      {
        label: 'Rename…',
        disabled: !cur,
        run: () => {
          if (cur) void askText(app.dialogLayer, `Rename ${o.noun}`, cur.name).then((n) => n && o.onRename(cur.id, n));
        },
      },
      { label: 'Delete', disabled: !cur, run: () => cur && o.onDelete(cur.id) },
      { label: 'Move up', disabled: !cur, run: () => cur && o.onMove(cur.id, -1) },
      { label: 'Move down', disabled: !cur, run: () => cur && o.onMove(cur.id, 1) },
      { separator: true },
      {
        label: 'Find…',
        run: () => {
          void askText(app.dialogLayer, `Find ${o.noun}`, '').then((q) => {
            const hit = q ? o.items().find((i) => i.name.toLowerCase().includes(q.toLowerCase())) : undefined;
            if (hit) o.onSelect(hit.id);
            else if (q) app.notify(`No ${o.noun} matches “${q}”.`);
          });
        },
      },
    ];
  };

  const openMenu = (anchor: HTMLElement | { x: number; y: number }): void => {
    const items: MenuItem[] = o.items().map((i) => ({ label: i.name, checked: i.id === o.selected(), run: () => o.onSelect(i.id) }));
    showMenu([...items, { separator: true }, { label: 'Manage', submenu: manage() }], anchor);
  };
  dropdown.addEventListener('click', () => openMenu(dropdown));
  dropdown.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(manage(), { x: e.clientX, y: e.clientY });
  });

  const copyText = async (): Promise<void> => {
    const text = o.copy();
    if (!text) return;
    internalClipboard = text;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard permission denied: the in-app copy still works */
    }
    app.notify(`Copied ${o.noun}.`);
  };
  const pasteText = async (): Promise<void> => {
    let text = internalClipboard;
    try {
      const sys = await navigator.clipboard.readText();
      if (sys.trim().startsWith('{')) text = sys;
    } catch {
      /* fall back to the in-app clipboard */
    }
    if (text) o.paste(text);
  };

  let handButton: HTMLButtonElement | null = null;
  if (o.hand) {
    const hand = o.hand;
    handButton = iconButton(icon('hand', 22), 'Pan / orbit tool', () => {
      hand.toggle();
      handButton?.classList.toggle('active', hand.active());
    }, 'kt-asset-hand');
    handButton.classList.toggle('active', hand.active());
  }
  const dup = iconButton(icon('plusMinus', 22), `Duplicate ${o.noun}`, () => o.onDuplicate(), 'kt-asset-btn');
  const add = iconButton(icon('plus', 22), `New ${o.noun}`, () => o.onAdd(), 'kt-asset-btn has-menu');
  add.disabled = o.disableAdd ?? false;
  const clip = iconButton(
    icon('clipboard', 22),
    'Copy / paste',
    () =>
      showMenu(
        [
          { label: `Copy ${o.noun}`, run: () => void copyText() },
          { label: `Paste ${o.noun}`, run: () => void pasteText() },
        ],
        clip,
      ),
    'kt-asset-btn',
  );

  const el = h('div', 'kt-asset-header', handButton, dropdown, dup, add, clip);
  const refresh = (): void => {
    label.textContent = current()?.name ?? '—';
  };
  refresh();
  return { el, refresh, handButton };
}
