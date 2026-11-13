import type { Curve } from '@/core/curve';
import { mountMiniCurve, type MiniCurveVariant } from './curve';
import { h } from './dom';

/**
 * Static parameter-row widgets used by the Properties inspector.
 * Visual vocabulary: right-aligned label · tick slider · numeric field · "±/" variance toggle ·
 * green curve toggle(s).
 */
export interface SliderRowOptions {
  label: string;
  value: number;
  min?: number;
  max?: number;
  ticks?: boolean;
  /** 0 = no curve toggle, 1 or 2 toggles. */
  curves?: 0 | 1 | 2;
  /** Optional initial curve for the primary curve toggle. */
  curveData?: Curve;
  /** Optional initial curve for the secondary (profile) curve toggle. */
  profileCurveData?: Curve;
  /** Optional level badge number (e.g. 2, 4, 5) on the primary curve toggle. */
  curveLevelBadge?: number;
  /** Optional variant for the secondary curve toggle ('dim' or 'profile'). */
  secondCurveVariant?: MiniCurveVariant;
  /** Show blue variance badge. */
  variance?: string;
  /** Hide the variance toggle ("±/") column. */
  noVariance?: boolean;
  /** Checkbox before slider (e.g. "Clip"). */
  leadingCheck?: boolean;
  onCurve?: (label: string) => void;
  onChange?: (v: number) => void;
}

export function curveToggle(
  onClick?: () => void,
  dim = false,
  initialCurve?: Curve,
  levelBadge?: number,
  variant?: MiniCurveVariant,
): HTMLButtonElement {
  const holder = document.createElement('div');
  const inst = mountMiniCurve(holder, {
    curve: initialCurve,
    variant: variant ?? (dim ? 'dim' : 'parent'),
    levelBadge,
    onOpenEditor: () => onClick?.(),
  });
  return inst.button;
}

export function slider(opts: { value: number; min: number; max: number; ticks: boolean; onChange: (v: number) => void }): { el: HTMLElement; setValue(v: number): void } {
  const thumb = h('div', 'kt-slider-thumb');
  const el = h('div', `kt-slider${opts.ticks ? ' ticks' : ''}`, h('div', 'kt-slider-track'), thumb);
  const set = (v: number): void => {
    const t = (v - opts.min) / (opts.max - opts.min || 1);
    thumb.style.left = `${Math.min(1, Math.max(0, t)) * 100}%`;
  };
  set(opts.value);
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const apply = (ev: PointerEvent): void => {
      const r = el.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const v = opts.min + t * (opts.max - opts.min);
      set(v);
      opts.onChange(v);
    };
    apply(e);
    el.addEventListener('pointermove', apply);
    const up = (): void => {
      el.removeEventListener('pointermove', apply);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointerup', up);
  });
  return { el, setValue: set };
}

