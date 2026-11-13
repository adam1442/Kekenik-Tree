import { cloneCurve, cloneRamp, defaultRamp, flatCurve, type Curve, type Ramp } from '@/core/curve';
import type {
  ColorParamDef,
  CurveParamDef,
  ParamDef,
  ParamKind,
  ParamState,
  ParamValue,
  RampParamDef,
  RGBA,
} from '@/contracts/params';
import { openColorPickerPopup, rgbaToCss } from './colorPicker';
import { mountMiniCurve } from './curve';
import { h } from './dom';
import { createListWidget } from './params/listWidget';
import { createNumericWidget } from './params/numericWidgets';
import { createRangeWidget } from './params/rangeWidget';
import {
  createAssetWidget,
  createBoolWidget,
  createEnumWidget,
  createSeedWidget,
  createStringWidget,
} from './params/scalarWidgets';
import { createVecWidget } from './params/vecWidget';
import { mountRampEditor } from './ramp';
import { openCurveDialog } from '../panels/dialogs/curveDialog';

/**
 * Extensible registry mapping `ParamDef['kind']` to widget factories.
 * The curve, ramp and color widgets are registered below; the remaining scalar/list widgets register elsewhere.
 */

export interface ParamWidgetMountOptions<D extends ParamDef = ParamDef> {
  def: D;
  state: ParamState;
  path?: string;
  nodeId?: string;
  /** True when multiple selected nodes have differing values for this parameter. */
  mixed?: boolean;
  /** True when the parameter cannot be edited (e.g. locked node). */
  disabled?: boolean;
  /** Optional dynamic option provider for enum/list fields (e.g. Material / Mesh names). */
  resolveDynamicOptions?: (fieldId: string) => { value: string; label: string }[];
  /** Called continuously during drag gestures (`merge = true`). */
  onChange: (next: ParamState, merge: boolean) => void;
  /** Called when a drag/scrub gesture finishes (`endGesture()`). */
  onCommit?: (next: ParamState, previous: ParamState) => void;
}

export interface ParamWidgetInstance {
  readonly element: HTMLElement;
  update(state: ParamState, mixed?: boolean): void;
  scrubBegin?(): void;
  scrubBy?(dxPixels: number, opts?: { shiftKey?: boolean; ctrlKey?: boolean }): void;
  scrubCommit?(): void;
  focusInput?(): void;
  dispose(): void;
}

export type ParamWidgetFactory<D extends ParamDef = ParamDef> = (
  host: HTMLElement,
  opts: ParamWidgetMountOptions<D>,
) => ParamWidgetInstance;

const WIDGETS = new Map<ParamKind, ParamWidgetFactory>();

export function registerParamWidget<K extends ParamKind>(
  kind: K,
  factory: ParamWidgetFactory<Extract<ParamDef, { kind: K }>>,
): void {
  WIDGETS.set(kind, factory as ParamWidgetFactory);
}

export function hasParamWidget(kind: ParamKind): boolean {
  return WIDGETS.has(kind);
}

export function listRegisteredParamWidgetKinds(): ParamKind[] {
  return [...WIDGETS.keys()];
}

export function mountParamWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions,
): ParamWidgetInstance | null {
  const factory = WIDGETS.get(opts.def.kind);
  return factory ? factory(host, opts) : null;
}

// ---- Built-in registrations ('curve', 'ramp', 'color') ----

function isCurveValue(v: ParamValue | undefined): v is Curve {
  return typeof v === 'object' && v !== null && 'points' in v && Array.isArray((v as Curve).points);
}

function isRampValue(v: ParamValue | undefined): v is Ramp {
  return typeof v === 'object' && v !== null && 'stops' in v && Array.isArray((v as Ramp).stops);
}

function isRgbaValue(v: ParamValue | undefined): v is RGBA {
  return Array.isArray(v) && v.length === 4 && typeof v[0] === 'number';
}

export function registerCurveAndRampWidgets(): void {
  registerParamWidget('curve', (host, opts: ParamWidgetMountOptions<CurveParamDef>) => {
    const initial = isCurveValue(opts.state.value)
      ? cloneCurve(opts.state.value)
      : opts.state.curve
        ? cloneCurve(opts.state.curve)
        : cloneCurve(opts.def.default ?? flatCurve(1));

    let curState: ParamState = { ...opts.state, value: initial };
    const path = opts.path ?? `${opts.def.group}:${opts.def.label}`;

    const mini = mountMiniCurve(host, {
      curve: initial,
      path,
      showInlineControls: true,
      onOpenEditor: (curveNow) => {
        openCurveDialog(path, {
          curve: curveNow,
          nodeId: opts.nodeId,
          paramId: opts.def.id,
          onChange: (c) => {
            mini.setCurve(c);
            curState = { ...curState, value: cloneCurve(c), curve: cloneCurve(c) };
            opts.onChange(curState, true);
          },
          onCommit: (c, prev) => {
            mini.setCurve(c);
            const prevState: ParamState = { ...curState, value: cloneCurve(prev), curve: cloneCurve(prev) };
            curState = { ...curState, value: cloneCurve(c), curve: cloneCurve(c) };
            opts.onChange(curState, false);
            opts.onCommit?.(curState, prevState);
          },
        });
      },
      onChange: (c) => {
        curState = { ...curState, value: cloneCurve(c), curve: cloneCurve(c) };
        opts.onChange(curState, true);
      },
      onCommit: (c, prev) => {
        const prevState: ParamState = { ...curState, value: cloneCurve(prev), curve: cloneCurve(prev) };
        curState = { ...curState, value: cloneCurve(c), curve: cloneCurve(c) };
        opts.onChange(curState, false);
        opts.onCommit?.(curState, prevState);
      },
    });

    return {
      element: mini.element,
      update: (next) => {
        curState = { ...next };
        const c = isCurveValue(next.value) ? next.value : next.curve ?? opts.def.default;
        mini.setCurve(c);
      },
      dispose: () => mini.dispose(),
    };
  });

  registerParamWidget('ramp', (host, opts: ParamWidgetMountOptions<RampParamDef>) => {
    const initial = isRampValue(opts.state.value)
      ? cloneRamp(opts.state.value)
      : cloneRamp(opts.def.default ?? defaultRamp());
    let curState: ParamState = { ...opts.state, value: initial };

    const editor = mountRampEditor(host, {
      ramp: initial,
      onChange: (r) => {
        curState = { ...curState, value: cloneRamp(r) };
        opts.onChange(curState, true);
      },
      onCommit: (r, prev) => {
        const prevState: ParamState = { ...curState, value: cloneRamp(prev) };
        curState = { ...curState, value: cloneRamp(r) };
        opts.onChange(curState, false);
        opts.onCommit?.(curState, prevState);
      },
    });

    return {
      element: editor.element,
      update: (next) => {
        curState = { ...next };
        if (isRampValue(next.value)) editor.setRamp(next.value, true);
      },
      dispose: () => editor.dispose(),
    };
  });

  registerParamWidget('color', (host, opts: ParamWidgetMountOptions<ColorParamDef>) => {
    let curColor: RGBA = isRgbaValue(opts.state.value) ? [...opts.state.value] : [...opts.def.default];
    let curState: ParamState = { ...opts.state, value: curColor };
    let isMixed = Boolean(opts.mixed);

    const fill = h('span', 'kt-color-btn-fill');
    const syncColor = (): void => {
      fill.style.background = isMixed
        ? 'linear-gradient(135deg, var(--kt-bg-input) 48%, var(--kt-accent) 52%)'
        : rgbaToCss(curColor);
      btn.classList.toggle('mixed', isMixed);
    };
    const btn = h('button', 'kt-slot-color kt-color-btn checker', fill);
    btn.type = 'button';
    btn.disabled = Boolean(opts.disabled);
    btn.title = opts.def.label;
    syncColor();

    btn.addEventListener('click', () => {
      if (opts.disabled) return;
      openColorPickerPopup(btn, {
        value: curColor,
        onChange: (rgba) => {
          curColor = [...rgba];
          isMixed = false;
          syncColor();
          curState = { ...curState, value: [...curColor] };
          opts.onChange(curState, true);
        },
        onCommit: (rgba, prev) => {
          curColor = [...rgba];
          isMixed = false;
          syncColor();
          const prevState: ParamState = { ...curState, value: [...prev] };
          curState = { ...curState, value: [...curColor] };
          opts.onChange(curState, false);
          opts.onCommit?.(curState, prevState);
        },
      });
    });

    host.append(btn);
    return {
      element: btn,
      update: (next, mixed = false) => {
        curState = { ...next };
        isMixed = mixed;
        if (isRgbaValue(next.value)) {
          curColor = [...next.value];
        }
        syncColor();
      },
      focusInput: () => btn.focus(),
      dispose: () => btn.remove(),
    };
  });
}

export function registerBuiltinParamWidgets(): void {
  registerCurveAndRampWidgets();
  registerParamWidget('float', (host, opts) => createNumericWidget(host, opts));
  registerParamWidget('int', (host, opts) => createNumericWidget(host, opts));
  registerParamWidget('bool', (host, opts) => createBoolWidget(host, opts));
  registerParamWidget('enum', (host, opts) => createEnumWidget(host, opts));
  registerParamWidget('vec2', (host, opts) => createVecWidget(host, opts));
  registerParamWidget('vec3', (host, opts) => createVecWidget(host, opts));
  registerParamWidget('range', (host, opts) => createRangeWidget(host, opts));
  registerParamWidget('string', (host, opts) => createStringWidget(host, opts));
  registerParamWidget('seed', (host, opts) => createSeedWidget(host, opts));
  registerParamWidget('asset', (host, opts) => createAssetWidget(host, opts));
  registerParamWidget('list', (host, opts) => createListWidget(host, opts));
}

// Auto-register all built-in widgets on module import
registerBuiltinParamWidgets();
