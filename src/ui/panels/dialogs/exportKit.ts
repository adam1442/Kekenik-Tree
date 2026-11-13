import { createCheckbox, createSelect } from '@/ui/components/select';
import { h } from '@/ui/components/dom';

/** Tiny form helpers shared by the Export dialog and the LODs panel (DOM only, no state). */

export function formRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const row = h('div', 'kt-xp-row', h('span', 'kt-xp-label', label), h('div', 'kt-xp-control', control));
  if (hint) row.title = hint;
  return row;
}

export function section(title: string, ...rows: HTMLElement[]): HTMLElement {
  return h('div', 'kt-xp-section', h('div', 'kt-xp-section-title', title), ...rows);
}

const stopKeys = (el: HTMLElement): void => el.addEventListener('keydown', (e) => e.stopPropagation());

export interface NumberOptions {
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  onChange: (v: number) => void;
}

export function numberInput(value: number, o: NumberOptions): HTMLInputElement {
  const input = h('input', 'kt-field kt-xp-num');
  input.type = 'number';
  input.min = String(o.min);
  input.max = String(o.max);
  input.step = String(o.step ?? 1);
  input.value = String(Number(value.toFixed(o.decimals ?? 3)));
  stopKeys(input);
  input.addEventListener('change', () => {
    const raw = Number(input.value);
    const v = Number.isFinite(raw) ? Math.min(o.max, Math.max(o.min, raw)) : value;
    input.value = String(Number(v.toFixed(o.decimals ?? 3)));
    o.onChange(v);
  });
  return input;
}

export function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const input = h('input', 'kt-field kt-xp-text');
  input.value = value;
  stopKeys(input);
  input.addEventListener('change', () => onChange(input.value));
  return input;
}

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export function choice<T extends string>(items: readonly Choice<T>[], value: T, onChange: (v: T) => void): HTMLElement {
  const current = items.find((i) => i.value === value) ?? (items[0] as Choice<T>);
  return createSelect({
    options: items.map((i) => i.label),
    value: current.label,
    className: 'kt-xp-select',
    onChange: (label) => {
      const hit = items.find((i) => i.label === label);
      if (hit) onChange(hit.value);
    },
  });
}

export function toggle(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  return createCheckbox(value, onChange);
}

export function slider(value: number, min: number, max: number, step: number, onInput: (v: number) => void): HTMLInputElement {
  const input = h('input', 'kt-xp-slider');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => onInput(Number(input.value)));
  return input;
}

export function button(label: string, onClick: () => void, className = ''): HTMLButtonElement {
  const b = h('button', `kt-em-btn ${className}`.trim(), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

export interface TabSpec {
  id: string;
  label: string;
  content: HTMLElement;
}

/** Simple tab strip; returns the root element and a selector. */
export function tabs(specs: readonly TabSpec[], initial = 0): { el: HTMLElement; select(id: string): void } {
  const strip = h('div', 'kt-xp-tabs');
  const body = h('div', 'kt-xp-tab-body');
  const buttons = new Map<string, HTMLButtonElement>();
  const select = (id: string): void => {
    for (const [k, b] of buttons) b.classList.toggle('active', k === id);
    const spec = specs.find((s) => s.id === id);
    if (spec) body.replaceChildren(spec.content);
  };
  for (const s of specs) {
    const b = h('button', 'kt-xp-tab', s.label);
    b.type = 'button';
    b.addEventListener('click', () => select(s.id));
    buttons.set(s.id, b);
    strip.append(b);
  }
  select((specs[initial] ?? specs[0] as TabSpec).id);
  return { el: h('div', 'kt-xp-tabs-root', strip, body), select };
}
