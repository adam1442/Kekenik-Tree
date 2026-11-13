import type { ParamState, Vec2ParamDef, Vec3ParamDef } from '@/contracts/params';
import { h } from '../dom';
import type { ParamWidgetInstance, ParamWidgetMountOptions } from '../paramWidgetRegistry';
import { clampVecComponent, computeScrubDelta, formatParamNumber, parseNumericInput } from './valueOps';

const AXIS_NAMES = ['X', 'Y', 'Z'] as const;
const AXIS_CLASSES = ['axis-x', 'axis-y', 'axis-z'] as const;

export function createVecWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<Vec2ParamDef | Vec3ParamDef>,
): ParamWidgetInstance {
  const { def } = opts;
  const dims = def.kind === 'vec3' ? 3 : 2;
  let curState: ParamState = structuredClone(opts.state);
  let isMixed = Boolean(opts.mixed);

  const readVec = (v: unknown): number[] => {
    if (Array.isArray(v) && v.length >= dims) {
      return Array.from({ length: dims }, (_, i) =>
        clampVecComponent(def, typeof v[i] === 'number' ? (v[i] as number) : (def.default[i] ?? 0)),
      );
    }
    return [...def.default];
  };

  let curVec = readVec(curState.value);
  const inputs: HTMLInputElement[] = [];

  const updateVisuals = (): void => {
    for (let i = 0; i < dims; i++) {
      const inp = inputs[i];
      if (!inp) continue;
      if (isMixed) {
        inp.value = '';
        inp.placeholder = '—';
        inp.classList.add('mixed');
      } else {
        inp.placeholder = '';
        inp.classList.remove('mixed');
        inp.value = formatParamNumber(curVec[i] ?? 0, def.step, false);
      }
    }
  };

  const emitChange = (nextVec: number[], merge: boolean): void => {
    const prevState = structuredClone(curState);
    curVec = [...nextVec];
    isMixed = false;
    curState = { ...curState, value: [...curVec] };
    updateVisuals();
    opts.onChange(structuredClone(curState), merge);
    if (!merge) {
      opts.onCommit?.(structuredClone(curState), prevState);
    }
  };

  const wrapper = h('div', `kt-param-vec kt-param-vec-${dims}`);

  for (let i = 0; i < dims; i++) {
    const axisLabel = h('span', `kt-vec-axis ${AXIS_CLASSES[i] ?? ''}`, AXIS_NAMES[i] ?? '');
    axisLabel.title = `Drag to scrub ${AXIS_NAMES[i] ?? ''} · Double-click to reset`;

    const inp = h('input', 'kt-num kt-vec-num');
    inp.type = 'text';
    inp.disabled = Boolean(opts.disabled);
    inp.setAttribute('aria-label', `${def.label} ${AXIS_NAMES[i] ?? ''}`);
    inputs.push(inp);

    // Drag-scrub on axis label
    axisLabel.addEventListener('pointerdown', (e: PointerEvent) => {
      if (opts.disabled || e.button !== 0) return;
      e.preventDefault();
      try {
        axisLabel.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in synthetic jsdom tests
      }
      const startState = structuredClone(curState);
      let valNow = curVec[i] ?? 0;
      let lastX = e.clientX;

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        const delta = computeScrubDelta(def, dx, {
          shiftKey: ev.shiftKey,
          ctrlKey: ev.ctrlKey || ev.metaKey,
        });
        valNow = clampVecComponent(def, valNow + delta, false);
        const nextVec = [...curVec];
        nextVec[i] = valNow;
        emitChange(nextVec, true);
      };

      const onUp = (): void => {
        axisLabel.removeEventListener('pointermove', onMove);
        axisLabel.removeEventListener('pointerup', onUp);
        axisLabel.removeEventListener('pointercancel', onUp);
        opts.onCommit?.(structuredClone(curState), startState);
      };

      axisLabel.addEventListener('pointermove', onMove);
      axisLabel.addEventListener('pointerup', onUp);
      axisLabel.addEventListener('pointercancel', onUp);
    });

    axisLabel.addEventListener('dblclick', (e) => {
      if (opts.disabled) return;
      e.preventDefault();
      const nextVec = [...curVec];
      nextVec[i] = def.default[i] ?? 0;
      emitChange(nextVec, false);
    });

    let focusStart = curVec[i] ?? 0;
    inp.addEventListener('focus', () => {
      focusStart = curVec[i] ?? 0;
      if (isMixed) inp.value = formatParamNumber(focusStart, def.step, false);
      inp.select();
    });

    const commitAxis = (): void => {
      const parsed = parseNumericInput(inp.value, curVec[i] ?? 0);
      const nextVal = clampVecComponent(def, parsed, false);
      const nextVec = [...curVec];
      nextVec[i] = nextVal;
      emitChange(nextVec, false);
    };

    inp.addEventListener('change', commitAxis);
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commitAxis();
        inp.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        curVec[i] = focusStart;
        updateVisuals();
        inp.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const step = def.step ?? 0.1;
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        const nextVal = clampVecComponent(def, (curVec[i] ?? 0) + dir * step * mult, false);
        const nextVec = [...curVec];
        nextVec[i] = nextVal;
        emitChange(nextVec, false);
        inp.select();
      }
    });

    wrapper.append(h('div', 'kt-vec-cell', axisLabel, inp));
  }

  updateVisuals();
  host.append(wrapper);

  return {
    element: wrapper,
    update(next: ParamState, mixed = false): void {
      curState = structuredClone(next);
      isMixed = mixed;
      curVec = readVec(next.value);
      updateVisuals();
    },
    focusInput(): void {
      inputs[0]?.focus();
      inputs[0]?.select();
    },
    dispose(): void {
      wrapper.remove();
    },
  };
}
