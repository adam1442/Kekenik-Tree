import { compactVariance, resolveVariance, type VarianceDistribution, type VarianceSpec, type VarianceValue } from '@/contracts/variance';
import { h } from '../dom';
import { showPopover, type PopoverHandle } from '../popover';
import { formatParamNumber } from './valueOps';
import { PREVIEW_SAMPLES, previewHistogram, previewStrip } from './variancePreview';

export interface VarianceEditorOptions {
  /** Parameter label for the title and the aria labels. */
  label: string;
  value: VarianceValue | undefined;
  /** Upper end of the Variance slider (the field accepts more). */
  max: number;
  disabled?: boolean;
  /** Live edit while a slider is dragged (`merge` = coalesce undo steps). */
  onChange(next: VarianceValue, merge: boolean): void;
  /** One finished edit (release / Enter / dropdown); `prev` is the value before it, for undo. */
  onCommit(next: VarianceValue, prev: VarianceValue | undefined): void;
}

const DISTRIBUTIONS: readonly { value: VarianceDistribution; label: string }[] = [
  { value: 'uniform', label: 'Uniform' },
  { value: 'gaussian', label: 'Gaussian' },
];

/** The strip + histogram preview; `update` redraws it from the current spec. */
function createPreview(): { el: HTMLElement; update(spec: VarianceSpec): void } {
  const strip = h('div', 'kt-var-strip');
  strip.setAttribute('aria-hidden', 'true');
  const bars = Array.from({ length: PREVIEW_SAMPLES }, (_, i) => {
    const bar = strip.appendChild(h('div', 'kt-var-strip-bar'));
    bar.style.left = `${(i / PREVIEW_SAMPLES) * 100}%`;
    bar.style.width = `${100 / PREVIEW_SAMPLES - 0.6}%`;
    return bar;
  });
  const hist = h('div', 'kt-var-hist');
  hist.setAttribute('aria-hidden', 'true');
  const columns = Array.from({ length: 15 }, () => hist.appendChild(h('div', 'kt-var-hist-bar')));
  return {
    el: h('div', 'kt-var-preview', strip, hist),
    update(spec) {
      const values = previewStrip(spec);
      bars.forEach((bar, i) => {
        const v = (values[i] ?? 0) * Math.min(1, spec.amount);
        const height = Math.max(2, Math.abs(v) * 50);
        bar.style.height = `${height}%`;
        bar.style.top = v < 0 ? '50%' : `${50 - height}%`;
      });
      previewHistogram(spec).forEach((v, i) => {
        const col = columns[i];
        if (col) col.style.height = `${Math.max(2, v * 100)}%`;
      });
    },
  };
}

/**
 * Variance Editor popup of the "+/-" button (SpeedTree style): Variance amount, Distribution, the Cohesion group
 * (Cohesive, Scale, Offset) and a live strip / histogram preview. Every control is a native range / select / number input,
 * so it works with the keyboard; Escape closes it. Edits go through `onChange` / `onCommit` (undoable by the caller).
 */
export function openVarianceEditor(anchor: HTMLElement, opts: VarianceEditorOptions): PopoverHandle {
  let spec = resolveVariance(opts.value);
  const preview = createPreview();
  const syncers: (() => void)[] = [];
  let startValue: VarianceValue | undefined = opts.value;

  const apply = (patch: Partial<VarianceSpec>, merge: boolean): void => {
    spec = { ...spec, ...patch };
    const next = compactVariance(spec);
    preview.update(spec);
    opts.onChange(next, merge);
  };
  const commit = (): void => {
    const next = compactVariance(spec);
    opts.onCommit(next, startValue);
    startValue = next;
  };

  const slider = (label: string, key: 'amount' | 'cohesion' | 'scale' | 'offset', max: number, step: number): HTMLElement => {
    const range = h('input', 'kt-pop-range');
    range.type = 'range';
    range.min = '0';
    range.max = String(max);
    range.step = String(step);
    range.disabled = opts.disabled === true;
    range.setAttribute('aria-label', `${opts.label} ${label}`);
    const field = h('input', 'kt-num kt-pop-value');
    field.type = 'text';
    field.inputMode = 'decimal';
    field.setAttribute('aria-label', `${opts.label} ${label} value`);
    field.disabled = opts.disabled === true;
    const sync = (): void => {
      range.value = String(spec[key]);
      if (document.activeElement !== field) field.value = formatParamNumber(spec[key], 0.01);
    };
    range.addEventListener('input', () => {
      apply({ [key]: Number(range.value) }, true);
      sync();
    });
    range.addEventListener('change', commit);
    field.addEventListener('change', () => {
      const typed = Number(field.value);
      if (Number.isFinite(typed)) apply({ [key]: Math.max(0, key === 'amount' ? typed : Math.min(1, typed)) }, false);
      sync();
      commit();
    });
    syncers.push(sync);
    return h('label', 'kt-pop-row', h('span', 'kt-pop-label', label), range, field);
  };

  const distribution = h('select', 'kt-pop-select');
  distribution.disabled = opts.disabled === true;
  distribution.setAttribute('aria-label', `${opts.label} distribution`);
  for (const d of DISTRIBUTIONS) distribution.append(new Option(d.label, d.value));
  distribution.addEventListener('change', () => {
    apply({ distribution: distribution.value === 'gaussian' ? 'gaussian' : 'uniform' }, false);
    commit();
  });
  syncers.push(() => {
    distribution.value = spec.distribution;
  });

  const handle = showPopover(
    anchor,
    `Variance - ${opts.label}`,
    (body) => {
      body.append(
        slider('Variance', 'amount', opts.max, 0.01),
        h('label', 'kt-pop-row', h('span', 'kt-pop-label', 'Distribution'), distribution),
        h('div', 'kt-pop-group', 'Cohesion'),
        slider('Cohesive', 'cohesion', 1, 0.01),
        slider('Scale', 'scale', 1, 0.01),
        slider('Offset', 'offset', 1, 0.01),
        preview.el,
      );
      for (const sync of syncers) sync();
      preview.update(spec);
    },
    280,
  );
  handle.el.querySelector<HTMLElement>('input, select')?.focus();
  return handle;
}
