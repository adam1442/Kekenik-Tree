import type { ParamState, RangeParamDef } from '@/contracts/params';
import { h } from '../dom';
import type { ParamWidgetInstance, ParamWidgetMountOptions } from '../paramWidgetRegistry';
import { clampRangeParam, formatParamNumber, parseNumericInput } from './valueOps';

function readRangePair(v: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') {
    return [v[0], v[1]];
  }
  return [...fallback];
}

export function createRangeWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<RangeParamDef>,
): ParamWidgetInstance {
  const { def } = opts;
  let curState: ParamState = structuredClone(opts.state);
  let curPair: [number, number] = clampRangeParam(def, ...readRangePair(curState.value, def.default));
  let isMixed = Boolean(opts.mixed);
  let gestureStartState: ParamState = structuredClone(curState);

  const track = h('div', 'kt-slider-track');
  const rangeBar = h('div', 'kt-range-bar');
  const thumbLow = h('div', 'kt-slider-thumb kt-range-thumb low');
  const thumbHigh = h('div', 'kt-slider-thumb kt-range-thumb high');
  const sliderEl = h('div', 'kt-slider kt-range-slider', track, rangeBar, thumbLow, thumbHigh);

  const lowInput = h('input', 'kt-num kt-range-num');
  lowInput.type = 'text';
  lowInput.setAttribute('aria-label', `${def.label} min`);
  lowInput.disabled = Boolean(opts.disabled);

  const highInput = h('input', 'kt-num kt-range-num');
  highInput.type = 'text';
  highInput.setAttribute('aria-label', `${def.label} max`);
  highInput.disabled = Boolean(opts.disabled);

  const updateVisuals = (): void => {
    const span = Math.max(1e-6, def.max - def.min);
    const tLow = Math.min(1, Math.max(0, (curPair[0] - def.min) / span));
    const tHigh = Math.min(1, Math.max(0, (curPair[1] - def.min) / span));
    thumbLow.style.left = `${tLow * 100}%`;
    thumbHigh.style.left = `${tHigh * 100}%`;
    rangeBar.style.left = `${tLow * 100}%`;
    rangeBar.style.width = `${Math.max(0, tHigh - tLow) * 100}%`;
    sliderEl.classList.toggle('mixed', isMixed);

    if (isMixed) {
      lowInput.value = '';
      lowInput.placeholder = '—';
      highInput.value = '';
      highInput.placeholder = '—';
    } else {
      lowInput.placeholder = '';
      highInput.placeholder = '';
      lowInput.value = formatParamNumber(curPair[0], def.step, false);
      highInput.value = formatParamNumber(curPair[1], def.step, false);
    }
  };

  updateVisuals();

  const emitChange = (nextPair: [number, number], merge: boolean): void => {
    const prevState = structuredClone(curState);
    curPair = [...nextPair];
    isMixed = false;
    curState = { ...curState, value: [...curPair] };
    updateVisuals();
    opts.onChange(structuredClone(curState), merge);
    if (!merge) {
      opts.onCommit?.(structuredClone(curState), prevState);
    }
  };

  sliderEl.addEventListener('pointerdown', (e: PointerEvent) => {
    if (opts.disabled || e.button !== 0) return;
    e.preventDefault();
    try {
      sliderEl.setPointerCapture(e.pointerId);
    } catch {
      // Ignore in synthetic jsdom tests
    }
    gestureStartState = structuredClone(curState);

    const rect = sliderEl.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const span = Math.max(1e-6, def.max - def.min);
    const clickVal = def.min + Math.min(1, Math.max(0, (e.clientX - rect.left) / width)) * span;

    // Pick closest handle (`low` vs `high`)
    const distLow = Math.abs(clickVal - curPair[0]);
    const distHigh = Math.abs(clickVal - curPair[1]);
    const activeHandle: 'low' | 'high' = distLow <= distHigh ? 'low' : 'high';

    const applyAt = (clientX: number, shiftKey: boolean): void => {
      const r = sliderEl.getBoundingClientRect();
      const w = Math.max(1, r.width);
      const t = Math.min(1, Math.max(0, (clientX - r.left) / w));
      const v = def.min + t * span;
      if (activeHandle === 'low') {
        const clampedLow = Math.min(curPair[1], v);
        emitChange(clampRangeParam(def, shiftKey ? curPair[0] + (clampedLow - curPair[0]) * 0.2 : clampedLow, curPair[1]), true);
      } else {
        const clampedHigh = Math.max(curPair[0], v);
        emitChange(clampRangeParam(def, curPair[0], shiftKey ? curPair[1] + (clampedHigh - curPair[1]) * 0.2 : clampedHigh), true);
      }
    };

    applyAt(e.clientX, e.shiftKey);

    const onMove = (ev: PointerEvent): void => applyAt(ev.clientX, ev.shiftKey);
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

  const bindInput = (inp: HTMLInputElement, index: 0 | 1): void => {
    let startVal = curPair[index];
    inp.addEventListener('focus', () => {
      startVal = curPair[index];
      if (isMixed) inp.value = formatParamNumber(curPair[index], def.step, false);
      inp.select();
    });
    const commit = (): void => {
      const parsed = parseNumericInput(inp.value, curPair[index]);
      const next: [number, number] = index === 0 ? [parsed, Math.max(parsed, curPair[1])] : [Math.min(curPair[0], parsed), parsed];
      emitChange(clampRangeParam(def, next[0], next[1]), false);
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
        inp.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        curPair[index] = startVal;
        updateVisuals();
        inp.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = def.step ?? (def.max - def.min) / 100;
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const nextVal = curPair[index] + dir * step * (e.shiftKey ? 10 : 1);
        const next: [number, number] =
          index === 0 ? [Math.min(nextVal, curPair[1]), curPair[1]] : [curPair[0], Math.max(curPair[0], nextVal)];
        emitChange(clampRangeParam(def, next[0], next[1]), false);
      }
    });
  };

  bindInput(lowInput, 0);
  bindInput(highInput, 1);

  const wrapper = h('div', 'kt-param-range', lowInput, sliderEl, highInput);
  host.append(wrapper);

  return {
    element: wrapper,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      curPair = clampRangeParam(def, ...readRangePair(next.value, def.default));
      updateVisuals();
    },
    focusInput(): void {
      lowInput.focus();
      lowInput.select();
    },
    dispose(): void {
      wrapper.remove();
    },
  };
}
