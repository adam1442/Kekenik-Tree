import type { FloatParamDef, IntParamDef, ParamState } from '@/contracts/params';
import { h } from '../dom';
import type { ParamWidgetInstance, ParamWidgetMountOptions } from '../paramWidgetRegistry';
import {
  clampNumericParam,
  computeScrubDelta,
  formatParamNumber,
  getSliderBounds,
  parseNumericInput,
} from './valueOps';

export interface NumericWidgetInstance extends ParamWidgetInstance {
  scrubBegin(): void;
  scrubBy(dxPixels: number, opts?: { shiftKey?: boolean; ctrlKey?: boolean }): void;
  scrubCommit(): void;
  focusInput(): void;
}

export function createNumericWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<FloatParamDef | IntParamDef>,
): NumericWidgetInstance {
  const { def } = opts;
  const isInt = def.kind === 'int';
  const bounds = getSliderBounds(def);

  let curState: ParamState = structuredClone(opts.state);
  let curValue: number = typeof curState.value === 'number' ? curState.value : def.default;
  let isMixed = Boolean(opts.mixed);
  let gestureStartState: ParamState = structuredClone(curState);
  let scrubStartValue = curValue;
  let isEditingText = false;

  // Slider element (tick style or continuous track style)
  const fill = h('div', 'kt-slider-fill');
  const thumb = h('div', 'kt-slider-thumb');
  const sliderEl = h(
    'div',
    `kt-slider${bounds.showTicks ? ' ticks' : ''}${isMixed ? ' mixed' : ''}`,
    h('div', 'kt-slider-track'),
    fill,
    thumb,
  );
  if (opts.disabled) sliderEl.classList.add('disabled');

  // Numeric input + optional unit suffix
  const input = h('input', 'kt-num');
  input.type = 'text';
  input.inputMode = isInt ? 'numeric' : 'decimal';
  input.disabled = Boolean(opts.disabled);
  input.setAttribute('aria-label', def.label);

  const unitBadge = def.unit ? h('span', 'kt-num-unit', def.unit) : null;
  const inputWrap = unitBadge ? h('div', 'kt-num-wrap', input, unitBadge) : input;

  const updateVisuals = (): void => {
    const span = bounds.sliderMax - bounds.sliderMin || 1;
    const t = Math.min(1, Math.max(0, (curValue - bounds.sliderMin) / span));
    const pct = `${t * 100}%`;
    thumb.style.left = pct;
    fill.style.width = pct;
    sliderEl.classList.toggle('mixed', isMixed);
    if (!isEditingText) {
      if (isMixed) {
        input.value = '';
        input.placeholder = '—';
        input.classList.add('mixed');
      } else {
        input.placeholder = '';
        input.classList.remove('mixed');
        input.value = formatParamNumber(curValue, bounds.step, isInt);
      }
    }
  };

  updateVisuals();

  const emitChange = (nextVal: number, merge: boolean): void => {
    const prevState = structuredClone(curState);
    curValue = nextVal;
    isMixed = false;
    curState = { ...curState, value: nextVal };
    updateVisuals();
    opts.onChange(structuredClone(curState), merge);
    if (!merge) {
      opts.onCommit?.(structuredClone(curState), prevState);
    }
  };

  // --- Slider pointer drag (supports Shift = fine relative, Ctrl = coarse snap) ---
  sliderEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (opts.disabled || e.button !== 0) return;
    e.preventDefault();
    try {
      sliderEl.setPointerCapture(e.pointerId);
    } catch {
      // Ignore in synthetic jsdom tests where pointerId capture may throw
    }
    gestureStartState = structuredClone(curState);

    const rect = sliderEl.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const span = bounds.sliderMax - bounds.sliderMin;

    // Initial click jumps to position unless Shift is held for fine relative adjustment
    let dragVal = curValue;
    if (!e.shiftKey) {
      const t0 = Math.min(1, Math.max(0, (e.clientX - rect.left) / width));
      const raw0 = bounds.sliderMin + t0 * span;
      dragVal = clampNumericParam(def, raw0, true, e.ctrlKey || e.metaKey);
      emitChange(dragVal, true);
    }
    let lastX = e.clientX;

    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      if (ev.shiftKey) {
        // Fine mode: 0.1x sensitivity relative to current value
        const delta = (dx / width) * span * 0.1;
        dragVal = clampNumericParam(def, dragVal + delta, true, false);
      } else {
        const r = sliderEl.getBoundingClientRect();
        const w = Math.max(1, r.width);
        const t = Math.min(1, Math.max(0, (ev.clientX - r.left) / w));
        let raw = bounds.sliderMin + t * span;
        if (ev.ctrlKey || ev.metaKey) {
          // Coarse snap: 10x step or 10% of slider span
          const coarseStep = isInt ? Math.max(1, bounds.step * 5) : span / 10;
          raw = bounds.sliderMin + Math.round((raw - bounds.sliderMin) / coarseStep) * coarseStep;
        }
        dragVal = clampNumericParam(def, raw, true, false);
      }
      emitChange(dragVal, true);
    };

    const onUp = (): void => {
      sliderEl.removeEventListener('pointermove', onMove);
      sliderEl.removeEventListener('pointerup', onUp);
      sliderEl.removeEventListener('pointercancel', onUp);
      opts.onCommit?.(structuredClone(curState), gestureStartState);
    };

    sliderEl.addEventListener('pointermove', onMove);
    sliderEl.addEventListener('pointerup', onUp);
    sliderEl.addEventListener('pointercancel', onUp);
  });

  // Double-click slider to reset to default
  sliderEl.addEventListener('dblclick', (e) => {
    if (opts.disabled) return;
    e.preventDefault();
    const defVal = clampNumericParam(def, def.default, false, false);
    emitChange(defVal, false);
  });

  // --- Numeric Input events ---
  let focusStartValue = curValue;

  input.addEventListener('focus', () => {
    isEditingText = true;
    focusStartValue = curValue;
    if (isMixed) {
      input.value = formatParamNumber(curValue, bounds.step, isInt);
    }
    input.select();
  });

  input.addEventListener('dblclick', () => {
    input.focus();
    input.select();
  });

  const commitTypedInput = (): void => {
    if (!isEditingText) return;
    isEditingText = false;
    const rawText = input.value.trim();
    if (rawText === '' && isMixed) {
      updateVisuals();
      return;
    }
    const parsed = parseNumericInput(rawText, curValue);
    // Typing uses hard limits (useSoftLimits = false) so values can exceed softMin/softMax
    const next = clampNumericParam(def, parsed, false, false);
    if (next !== focusStartValue || isMixed) {
      emitChange(next, false);
    } else {
      updateVisuals();
    }
  };

  input.addEventListener('blur', () => {
    commitTypedInput();
  });

  input.addEventListener('change', () => {
    const rawText = input.value.trim();
    if (rawText === '' && isMixed) return;
    const parsed = parseNumericInput(rawText, curValue);
    const next = clampNumericParam(def, parsed, false, false);
    if (next !== curValue || isMixed) {
      emitChange(next, false);
      focusStartValue = next;
    } else {
      input.value = formatParamNumber(curValue, bounds.step, isInt);
    }
  });

  input.addEventListener('keydown', (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTypedInput();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      isEditingText = false;
      curValue = focusStartValue;
      updateVisuals();
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      const next = clampNumericParam(def, curValue + dir * bounds.step * mult, false, false);
      isEditingText = false;
      emitChange(next, false);
      focusStartValue = next;
      input.select();
    }
  });

  // Optional mouse wheel adjustment while input is focused
  input.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (document.activeElement !== input || opts.disabled) return;
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const mult = e.shiftKey ? 0.1 : e.ctrlKey || e.metaKey ? 10 : 1;
      const next = clampNumericParam(def, curValue + dir * bounds.step * mult, false, false);
      isEditingText = false;
      emitChange(next, false);
      focusStartValue = next;
    },
    { passive: false },
  );

  const wrapper = h('div', 'kt-param-numeric', sliderEl, inputWrap);
  host.append(wrapper);

  return {
    element: wrapper,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      if (typeof next.value === 'number') curValue = next.value;
      updateVisuals();
    },
    scrubBegin(): void {
      gestureStartState = structuredClone(curState);
      scrubStartValue = curValue;
    },
    scrubBy(dxPixels: number, mod?: { shiftKey?: boolean; ctrlKey?: boolean }): void {
      if (opts.disabled) return;
      const delta = computeScrubDelta(def, dxPixels, mod);
      const next = clampNumericParam(def, scrubStartValue + delta, false, false);
      scrubStartValue = next;
      emitChange(next, true);
    },
    scrubCommit(): void {
      opts.onCommit?.(structuredClone(curState), gestureStartState);
    },
    focusInput(): void {
      input.focus();
      input.select();
    },
    dispose(): void {
      wrapper.remove();
    },
  };
}
