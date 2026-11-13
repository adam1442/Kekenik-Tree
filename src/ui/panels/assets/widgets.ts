import type { RGBA } from '@/contracts/params';
import { h } from '../../components/dom';
import { openColorPickerPopup, rgbaToCss } from '../../components/colorPicker';
import { showMenu } from '../../components/menu';
import { slider } from '../../components/paramWidgets';
import { icon } from '../../icons/icons';

/** Small control helpers shared by the asset panels (Materials, Material Sets, Masks, Displacements, Lighting). */

export const card = (title: string, ...children: (Node | null)[]): HTMLElement => h('div', 'kt-mat-card', h('div', 'kt-mat-card-title', title), ...children);
export const row = (label: string, ...controls: HTMLElement[]): HTMLElement => h('div', 'kt-mat-row', h('label', '', label), ...controls);

export interface NumberFieldOptions {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  placeholder?: string;
  /** Show an empty field (slot "Number" placeholder when no constant is set). */
  empty?: boolean;
  onChange(v: number): void;
  /** Called when the field is cleared (empty text). */
  onClear?(): void;
}

/** Numeric text field: Enter / blur commits, Up/Down arrows nudge. */
export function numberField(o: NumberFieldOptions): HTMLInputElement {
  const el = h('input', 'kt-field');
  el.type = 'text';
  el.disabled = o.disabled ?? false;
  if (o.placeholder) el.placeholder = o.placeholder;
  const fmt = (v: number): string => String(Math.round(v * 100000) / 100000);
  el.value = o.empty ? '' : fmt(o.value);
  const clamp = (v: number): number => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  const commit = (): void => {
    if (el.value.trim() === '') {
      o.onClear?.();
      return;
    }
    const v = Number.parseFloat(el.value.replace(',', '.'));
    if (!Number.isFinite(v)) {
      el.value = o.empty ? '' : fmt(o.value);
      return;
    }
    const c = clamp(v);
    el.value = fmt(c);
    o.onChange(c);
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.blur();
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = Number.parseFloat(el.value) || 0;
      const d = (o.step ?? 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
      el.value = fmt(clamp(cur + d));
      commit();
    }
  });
  return el;
}

export function textField(value: string, onChange: (v: string) => void, opts: { disabled?: boolean; placeholder?: string; readOnly?: boolean } = {}): HTMLInputElement {
  const el = h('input', 'kt-field');
  el.type = 'text';
  el.value = value;
  el.disabled = opts.disabled ?? false;
  el.readOnly = opts.readOnly ?? false;
  if (opts.placeholder) el.placeholder = opts.placeholder;
  el.addEventListener('change', () => onChange(el.value));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.blur();
  });
  return el;
}

/** Colour swatch button opening the shared colour picker popup. */
export function colorSwatch(value: RGBA, onChange: (c: RGBA) => void, className = 'kt-swatch'): HTMLButtonElement {
  const b = h('button', className);
  b.type = 'button';
  const paint = (c: RGBA): void => {
    b.style.background = rgbaToCss(c);
  };
  paint(value);
  let cur = value;
  b.addEventListener('click', () => {
    openColorPickerPopup(b, {
      value: cur,
      onChange: (c) => {
        cur = c;
        paint(c);
        onChange(c);
      },
    });
  });
  return b;
}

export interface SelectItem {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface ValueSelect {
  el: HTMLButtonElement;
  setValue(v: string): void;
}

/** Dropdown over {value,label} items (labels may repeat; values are ids). */
export function valueSelect(items: () => SelectItem[], value: string, onChange: (v: string) => void, className = '', disabled = false): ValueSelect {
  const label = h('span', 'kt-select-label');
  const el = h('button', `kt-select ${className}`.trim(), label, icon('chevronDown', 12));
  el.type = 'button';
  el.disabled = disabled;
  let cur = value;
  const paint = (): void => {
    label.textContent = items().find((i) => i.value === cur)?.label ?? '';
  };
  paint();
  el.addEventListener('click', () => {
    showMenu(
      items().map((i) => ({
        label: i.label,
        checked: i.value === cur,
        disabled: i.disabled,
        run: () => {
          cur = i.value;
          paint();
          onChange(i.value);
        },
      })),
      el,
    );
  });
  return {
    el,
    setValue(v) {
      cur = v;
      paint();
    },
  };
}

/** Tick-less slider with a numeric readout field (kept in sync both ways). */
export function sliderField(opts: { value: number; min: number; max: number; step?: number; onChange(v: number): void }): HTMLElement {
  const s = slider({ value: opts.value, min: opts.min, max: opts.max, ticks: false, onChange: (v) => {
    const q = opts.step ? Math.round(v / opts.step) * opts.step : v;
    field.value = String(Math.round(q * 1000) / 1000);
    opts.onChange(q);
  } });
  const field = numberField({ value: opts.value, min: opts.min, max: opts.max, step: opts.step ?? (opts.max - opts.min) / 100, onChange: (v) => { s.setValue(v); opts.onChange(v); } });
  field.classList.add('kt-slider-num');
  return h('div', 'kt-slider-field', s.el, field);
}

export function checkbox(value: boolean, onChange: (v: boolean) => void): HTMLButtonElement {
  const b = h('button', `kt-check${value ? ' on' : ''}`);
  b.type = 'button';
  if (value) b.append(icon('check', 12));
  b.addEventListener('click', () => {
    if (b.disabled) return;
    const on = !b.classList.contains('on');
    b.classList.toggle('on', on);
    b.replaceChildren(...(on ? [icon('check', 12)] : []));
    onChange(on);
  });
  return b;
}
