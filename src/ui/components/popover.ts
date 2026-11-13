import { h } from './dom';

/**
 * Anchored popover for toolbar settings (sliders, toggles, selects). One popover is open at a time; it closes on an
 * outside press, Escape or a second click on its anchor. Controls write straight to their target, so there is no
 * Apply step. Styling lives in `panels.css` (`.kt-pop*`).
 */
export interface PopoverHandle {
  el: HTMLElement;
  close(): void;
}

let active: { anchor: HTMLElement; close(): void } | null = null;

export function closeActivePopover(): void {
  active?.close();
}

export function showPopover(anchor: HTMLElement, title: string, build: (body: HTMLElement, close: () => void) => void, width = 260): PopoverHandle {
  if (active && active.anchor === anchor) {
    active.close();
    return { el: document.createElement('div'), close: () => undefined };
  }
  closeActivePopover();
  const body = h('div', 'kt-pop-body');
  const el = h('div', 'kt-pop', h('div', 'kt-pop-title', title), body);
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);
  el.style.width = `${width}px`;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    el.remove();
    anchor.classList.remove('open');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    if (active?.anchor === anchor) active = null;
  };
  const onOutside = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (el.contains(t) || anchor.contains(t) || (t instanceof Element && t.closest('.kt-menu'))) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  build(body, close);
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const left = Math.max(4, Math.min(window.innerWidth - width - 4, r.left));
  el.style.left = `${left}px`;
  el.style.top = `${Math.min(window.innerHeight - 40, r.bottom + 4)}px`;
  el.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 16)}px`;
  anchor.classList.add('open');
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  active = { anchor, close };
  return { el, close };
}

export const popRow = (label: string, ...controls: (HTMLElement | null)[]): HTMLElement => h('div', 'kt-pop-row', h('label', 'kt-pop-label', label), ...controls);

export const popNote = (text: string): HTMLElement => h('div', 'kt-pop-note', text);

export const popHeading = (text: string): HTMLElement => h('div', 'kt-pop-heading', text);

export function popToggle(label: string, get: () => boolean, set: (v: boolean) => void, disabledReason?: string): HTMLElement {
  const input = h('input', 'kt-pop-check');
  input.type = 'checkbox';
  input.checked = get();
  input.setAttribute('aria-label', label);
  if (disabledReason) {
    input.disabled = true;
    input.title = disabledReason;
  }
  input.addEventListener('change', () => set(input.checked));
  const row = popRow(label, input);
  if (disabledReason) {
    row.classList.add('disabled');
    row.title = disabledReason;
  }
  return row;
}

export function popSlider(label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, digits = 2): HTMLElement {
  const range = h('input', 'kt-pop-range');
  range.type = 'range';
  range.min = String(min);
  range.max = String(max);
  range.step = String(step);
  range.value = String(get());
  range.setAttribute('aria-label', label);
  const out = h('span', 'kt-pop-value', get().toFixed(digits));
  range.addEventListener('input', () => {
    const v = Number(range.value);
    out.textContent = v.toFixed(digits);
    set(v);
  });
  return popRow(label, range, out);
}

export function popSelect(label: string, options: readonly { value: string; label: string }[], get: () => string, set: (v: string) => void): HTMLElement {
  const sel = h('select', 'kt-pop-select');
  sel.setAttribute('aria-label', label);
  for (const o of options) {
    const opt = h('option', '', o.label);
    opt.value = o.value;
    sel.append(opt);
  }
  sel.value = get();
  sel.addEventListener('change', () => set(sel.value));
  return popRow(label, sel);
}

export function popButton(label: string, run: () => void, disabledReason?: string): HTMLButtonElement {
  const b = h('button', 'kt-pop-btn', label);
  b.type = 'button';
  if (disabledReason) {
    b.disabled = true;
    b.title = disabledReason;
  } else b.addEventListener('click', run);
  return b;
}
