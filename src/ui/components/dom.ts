/** Tiny DOM helpers (no framework). */
export type Child = Node | string | null | undefined | false;

/** Create an element: h('div', 'cls a b', child, 'text', ...). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  append(el, ...children);
  return el;
}

export function append(el: Element, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function svg(markup: string): SVGElement {
  const holder = document.createElement('div');
  holder.innerHTML = markup.trim();
  return holder.firstElementChild as SVGElement;
}

/** Icon button helper. */
export function iconButton(iconEl: Element, title: string, onClick: (e: MouseEvent) => void, className = ''): HTMLButtonElement {
  const b = h('button', `kt-icon-btn ${className}`.trim(), iconEl as unknown as Node);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

export const isMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
