import { h } from './dom';
import { icon } from '../icons/icons';
import { showMenu } from './menu';

export interface SelectOptions {
  options: string[];
  value: string;
  onChange?: (value: string) => void;
  className?: string;
  /** Width in px; omit for fill. */
  width?: number;
}

/** Themed dropdown ("Absolute ▾"). */
export function createSelect(opts: SelectOptions): HTMLButtonElement {
  const label = h('span', 'kt-select-label', opts.value);
  const btn = h('button', `kt-select ${opts.className ?? ''}`.trim(), label, icon('chevronDown', 12));
  btn.type = 'button';
  if (opts.width) btn.style.width = `${opts.width}px`;
  let value = opts.value;
  btn.addEventListener('click', () => {
    showMenu(
      opts.options.map((o) => ({
        label: o,
        checked: o === value,
        run: () => {
          value = o;
          label.textContent = o;
          opts.onChange?.(o);
        },
      })),
      btn,
    );
  });
  return btn;
}

export function createCheckbox(checked = false, onChange?: (v: boolean) => void): HTMLButtonElement {
  const b = h('button', `kt-check${checked ? ' on' : ''}`);
  b.type = 'button';
  if (checked) b.append(icon('check', 12));
  b.addEventListener('click', () => {
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    b.replaceChildren(...(on ? [icon('check', 12)] : []));
    onChange?.(on);
  });
  return b;
}
