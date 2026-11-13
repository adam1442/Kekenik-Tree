import { h } from './dom';
import { icon } from '../icons/icons';

export interface MenuItem {
  label?: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  run?: () => void;
}

export interface MenuHandle {
  close(): void;
}

export type MenuAnchor = HTMLElement | { x: number; y: number };

let active: { close(): void } | null = null;

export function closeActiveMenu(): void {
  active?.close();
}

/** Show a popup menu (with nested submenus). Only one root menu is open at a time. */
export function showMenu(items: MenuItem[], anchor: MenuAnchor, onClose?: () => void): MenuHandle {
  closeActiveMenu();
  const panels: HTMLElement[] = [];
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    panels.forEach((p) => p.remove());
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    if (active === handle) active = null;
    onClose?.();
  };
  const handle: MenuHandle = { close };

  const onOutside = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (panels.some((p) => p.contains(t))) return;
    if (anchor instanceof HTMLElement && anchor.contains(t)) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  const build = (list: MenuItem[], depth: number): HTMLElement => {
    const panel = h('div', 'kt-menu');
    panel.addEventListener('contextmenu', (e) => e.preventDefault());
    const closeFrom = (level: number): void => {
      while (panels.length > level) panels.pop()?.remove();
    };
    for (const it of list) {
      if (it.separator) {
        panel.append(h('div', 'kt-menu-sep'));
        continue;
      }
      const row = h(
        'div',
        `kt-menu-item${it.disabled ? ' disabled' : ''}`,
        h('span', 'kt-menu-check', it.checked ? icon('check', 12) : null),
        h('span', 'kt-menu-label', it.label ?? ''),
        h('span', 'kt-menu-shortcut', it.shortcut ?? ''),
        h('span', 'kt-menu-arrow', it.submenu ? icon('chevronRight', 10) : null),
      );
      row.addEventListener('pointerenter', () => {
        closeFrom(depth + 1);
        if (it.submenu && !it.disabled) {
          const sub = build(it.submenu, depth + 1);
          document.body.append(sub);
          panels.push(sub);
          const r = row.getBoundingClientRect();
          place(sub, r.right - 2, r.top - 4, r.left + 2);
        }
      });
      row.addEventListener('click', () => {
        if (it.disabled || it.submenu) return;
        close();
        it.run?.();
      });
      panel.append(row);
    }
    return panel;
  };

  const place = (el: HTMLElement, x: number, y: number, altRight?: number): void => {
    el.style.left = '0px';
    el.style.top = '0px';
    const r = el.getBoundingClientRect();
    let px = x;
    if (px + r.width > window.innerWidth - 4) px = (altRight ?? x) - r.width;
    px = Math.max(4, px);
    const py = Math.max(4, Math.min(y, window.innerHeight - r.height - 4));
    el.style.left = `${px}px`;
    el.style.top = `${py}px`;
  };

  const root = build(items, 0);
  document.body.append(root);
  panels.push(root);
  if (anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    place(root, r.left, r.bottom + 2);
  } else {
    place(root, anchor.x, anchor.y);
  }
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  active = handle;
  return handle;
}

