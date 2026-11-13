import type { TopMenu } from '@/app/menus';
import { h } from '../components/dom';
import { showMenu, closeActiveMenu } from '../components/menu';
import { icon } from '../icons/icons';

/** Title bar with the application menu (File, Edit, View, Tree, Window, Help) and the document title. */
export function createTitleBar(menus: TopMenu[]): { el: HTMLElement; setTitle(text: string): void } {
  const title = h('div', 'kt-titlebar-title', 'Kekenik Tree');
  const bar = h('div', 'kt-menubar', h('div', 'kt-menubar-logo', icon('logo', 16)));
  let openBtn: HTMLElement | null = null;

  const open = (btn: HTMLElement, menu: TopMenu): void => {
    openBtn?.classList.remove('open');
    openBtn = btn;
    btn.classList.add('open');
    showMenu(menu.items(), btn, () => {
      if (openBtn === btn) {
        btn.classList.remove('open');
        openBtn = null;
      }
    });
  };
  for (const menu of menus) {
    const btn = h('button', 'kt-menubar-item', menu.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (openBtn === btn) closeActiveMenu();
      else open(btn, menu);
    });
    btn.addEventListener('pointerenter', () => {
      if (openBtn && openBtn !== btn) open(btn, menu);
    });
    bar.append(btn);
  }
  const el = h('div', 'kt-titlebar', bar, title);
  return { el, setTitle: (t) => (title.textContent = t) };
}
