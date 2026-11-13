import { cloneCurve, flatCurve, getCurvePreset, type Curve } from '@/core/curve';
import { defaultParamState, type BoolParamDef, type ParamDef, type ParamState } from '@/contracts/params';
import { mountMiniCurve, type MiniCurveInstance } from '../curve';
import { h } from '../dom';
import { showMenu, type MenuItem } from '../menu';
import { mountParamWidget, type ParamWidgetInstance } from '../paramWidgetRegistry';
import { icon } from '../../icons/icons';
import { openCurveDialog } from '../../panels/dialogs/curveDialog';
import {
  buildParamTooltip,
  canPasteParamFromClipboard,
  copyParamToClipboard,
  getParamFromClipboard,
} from './clipboard';
import {
  formatParamNumber,
  formatVarianceBadge,
  hasActiveCurve,
  isParamModified,
  parseNumericInput,
} from './valueOps';

/** Parameters that display a secondary profile curve toggle. */
const TWO_CURVE_PARAMS = new Set<string>([
  'number',
  'sweep',
  'roll',
  'seasonDroop',
  'seasonSize',
  'seasonCurl',
  'seasonFold',
]);

const PROFILE_VARIANT_PARAMS = new Set<string>(['seasonDroop', 'seasonSize', 'seasonCurl', 'seasonFold']);

export interface ParamRowMountOptions {
  def: ParamDef;
  state: ParamState;
  nodeId?: string;
  nodeName?: string;
  mixed?: boolean;
  disabled?: boolean;
  /** Optional paired boolean enable parameter. */
  pairedEnable?: {
    def: BoolParamDef;
    state: ParamState;
    mixed?: boolean;
    onChange: (next: ParamState, merge: boolean) => void;
    onCommit?: (next: ParamState, previous: ParamState) => void;
  };
  resolveDynamicOptions?: (fieldId: string) => { value: string; label: string }[];
  onChange: (next: ParamState, merge: boolean) => void;
  onCommit?: (next: ParamState, previous: ParamState) => void;
}

export interface ParamRowInstance {
  readonly element: HTMLElement;
  readonly def: ParamDef;
  update(state: ParamState, mixed?: boolean, pairedState?: ParamState, pairedMixed?: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function mountParamRow(host: HTMLElement, opts: ParamRowMountOptions): ParamRowInstance {
  const { def } = opts;

  // List parameters render their own subhead + cards block
  if (def.kind === 'list') {
    const listWrap = h('div', 'kt-param-list-block');
    const path = `${opts.nodeName ?? 'Node'}.${def.subgroup ?? def.group}:${def.label}`;
    const widget = mountParamWidget(listWrap, {
      def,
      state: opts.state,
      nodeId: opts.nodeId,
      path,
      mixed: opts.mixed,
      disabled: opts.disabled,
      resolveDynamicOptions: opts.resolveDynamicOptions,
      onChange: opts.onChange,
      onCommit: opts.onCommit,
    });
    host.append(listWrap);
    return {
      element: listWrap,
      def,
      update(next, mixed): void {
        widget?.update(next, mixed);
      },
      setVisible(visible: boolean): void {
        listWrap.hidden = !visible;
      },
      dispose(): void {
        widget?.dispose();
        listWrap.remove();
      },
    };
  }

  let curState: ParamState = structuredClone(opts.state);
  let isMixed = Boolean(opts.mixed);
  let varianceOpen = false;
  let profileCurve: Curve = PROFILE_VARIANT_PARAMS.has(def.id) ? getCurvePreset('linear') : flatCurve(1);

  const pathPrefix = `${opts.nodeName ?? 'Node'}.${def.group}${def.subgroup ? `:${def.subgroup}` : ''}:${def.label}`;

  // --- Row container ---
  const rowContainer = h('div', 'kt-param-item');
  const mainRow = h('div', 'kt-row');
  mainRow.dataset.paramId = def.id;

  // --- Label + modified dot + hover reset button ---
  const labelText = h('span', 'kt-row-label-text', def.label);
  const resetInlineBtn = h('button', 'kt-row-reset', icon('reset', 11));
  resetInlineBtn.type = 'button';
  resetInlineBtn.title = `Reset ${def.label} to default`;
  resetInlineBtn.tabIndex = -1;

  const perfBadge = h('span', 'kt-row-perf', '!');
  perfBadge.hidden = true;
  const labelEl = h('label', 'kt-row-label', labelText, resetInlineBtn, perfBadge);

  // --- Optional leading checkbox ---
  let leadingWrap: HTMLElement | null = null;
  let updateLeadingCheck: ((s: ParamState, m?: boolean) => void) | null = null;
  if (opts.pairedEnable) {
    const pe = opts.pairedEnable;
    let peState = structuredClone(pe.state);
    let peChecked = typeof peState.value === 'boolean' ? peState.value : pe.def.default;
    let peMixed = Boolean(pe.mixed);
    const checkBtn = h('button', 'kt-check');
    checkBtn.type = 'button';
    checkBtn.title = pe.def.label;
    const syncCheck = (): void => {
      checkBtn.classList.toggle('on', !peMixed && peChecked);
      checkBtn.classList.toggle('mixed', peMixed);
      checkBtn.replaceChildren(...(peMixed ? [icon('minus', 11)] : peChecked ? [icon('check', 12)] : []));
    };
    syncCheck();
    checkBtn.addEventListener('click', () => {
      if (opts.disabled) return;
      const prev = structuredClone(peState);
      peChecked = peMixed ? true : !peChecked;
      peMixed = false;
      peState = { ...peState, value: peChecked };
      syncCheck();
      pe.onChange(structuredClone(peState), false);
      pe.onCommit?.(structuredClone(peState), prev);
    });
    updateLeadingCheck = (nextS, nextM = false): void => {
      peState = structuredClone(nextS);
      peMixed = nextM;
      if (typeof nextS.value === 'boolean') peChecked = nextS.value;
      syncCheck();
    };
    leadingWrap = h('div', 'kt-row-lead', checkBtn);
  }

  // --- Primary Widget Host ---
  const controlHost = h('div', 'kt-row-control');
  const widget: ParamWidgetInstance | null = mountParamWidget(controlHost, {
    def,
    state: curState,
    nodeId: opts.nodeId,
    path: pathPrefix,
    mixed: isMixed,
    disabled: opts.disabled,
    resolveDynamicOptions: opts.resolveDynamicOptions,
    onChange: (next, merge) => {
      curState = {
        ...curState,
        ...structuredClone(next),
        variance: next.variance !== undefined ? next.variance : curState.variance,
        curve: next.curve !== undefined ? next.curve : curState.curve,
      };
      isMixed = false;
      syncRowIndicators();
      opts.onChange(structuredClone(curState), merge);
    },
    onCommit: (next, prev) => {
      curState = {
        ...curState,
        ...structuredClone(next),
        variance: next.variance !== undefined ? next.variance : curState.variance,
        curve: next.curve !== undefined ? next.curve : curState.curve,
      };
      syncRowIndicators();
      opts.onCommit?.(structuredClone(curState), prev);
    },
  });

  // --- Variance Control (`±/` button or `.10` blue badge + expandable sub-row) ---
  const supportsVariance = def.variance !== undefined || def.kind === 'float' || def.kind === 'int';
  let varSlotEl: HTMLElement;
  let varianceSubRow: HTMLElement | null = null;
  let syncVarianceUi: (() => void) | null = null;

  if (supportsVariance && def.kind !== 'bool' && def.kind !== 'enum' && def.kind !== 'string') {
    const varMin = def.variance?.min ?? 0;
    const varMax =
      def.variance?.max ??
      (def.kind === 'float' && def.softMax !== undefined ? Math.max(1, def.softMax) : def.kind === 'int' ? 10 : 1);

    const varBtn = h('button', 'kt-row-var');
    varBtn.type = 'button';
    varSlotEl = varBtn;

    // Expandable Variance sub-row (a second small slider/field under a parameter)
    const varFill = h('div', 'kt-slider-fill');
    const varThumb = h('div', 'kt-slider-thumb');
    const varSlider = h('div', 'kt-slider kt-var-slider', h('div', 'kt-slider-track'), varFill, varThumb);
    const varInput = h('input', 'kt-num kt-var-num');
    varInput.type = 'text';
    varInput.inputMode = 'decimal';
    varInput.setAttribute('aria-label', `${def.label} variance`);

    const varResetBtn = h('button', 'kt-icon-btn kt-var-clear', icon('close', 11));
    varResetBtn.type = 'button';
    varResetBtn.title = 'Clear variance (0)';

    varianceSubRow = h(
      'div',
      'kt-row kt-var-subrow',
      h('label', 'kt-row-label kt-var-label', '± Variance'),
      varSlider,
      varInput,
      varResetBtn,
    );
    varianceSubRow.hidden = true;

    const getVarVal = (): number => (typeof curState.variance === 'number' ? curState.variance : 0);

    syncVarianceUi = (): void => {
      const v = getVarVal();
      const hasV = v > 1e-5;
      varBtn.classList.toggle('has-badge', hasV);
      varBtn.classList.toggle('open', varianceOpen);
      if (hasV) {
        varBtn.replaceChildren(h('span', 'kt-badge', formatVarianceBadge(v)));
        varBtn.title = `Variance: ±${formatParamNumber(v)} (click to edit, drag to scrub, right-click to clear)`;
      } else {
        varBtn.replaceChildren(icon('plusMinus', 14));
        varBtn.title = 'Variance (click to toggle slider, drag to scrub)';
      }

      const t = Math.min(1, Math.max(0, (v - varMin) / Math.max(1e-6, varMax - varMin)));
      varThumb.style.left = `${t * 100}%`;
      varFill.style.width = `${t * 100}%`;
      if (document.activeElement !== varInput) {
        varInput.value = formatParamNumber(v, 0.01, def.kind === 'int');
      }
      if (varianceSubRow) {
        varianceSubRow.hidden = !varianceOpen;
      }
    };

    const setVariance = (nextV: number, merge: boolean, startState?: ParamState): void => {
      const clamped = Math.max(varMin, Math.min(varMax * 10, Math.round(nextV * 1000) / 1000));
      const prevState = startState ?? structuredClone(curState);
      curState = { ...curState, variance: clamped };
      syncVarianceUi?.();
      syncRowIndicators();
      opts.onChange(structuredClone(curState), merge);
      if (!merge) {
        opts.onCommit?.(structuredClone(curState), prevState);
      }
    };

    // Click vs drag-scrub on the `±/` / `.10` variance button
    varBtn.addEventListener('pointerdown', (e: PointerEvent) => {
      if (opts.disabled || e.button !== 0) return;
      e.preventDefault();
      try {
        varBtn.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in jsdom
      }
      const startX = e.clientX;
      const startV = getVarVal();
      const startState = structuredClone(curState);
      let dragged = false;

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX;
        if (!dragged && Math.abs(dx) < 3) return;
        dragged = true;
        const mult = ev.shiftKey ? 0.1 : ev.ctrlKey || ev.metaKey ? 5 : 1;
        const stepSpan = Math.max(0.1, varMax - varMin);
        const nextV = Math.max(0, startV + (dx / 120) * stepSpan * mult);
        setVariance(nextV, true, startState);
      };

      const onUp = (): void => {
        varBtn.removeEventListener('pointermove', onMove);
        varBtn.removeEventListener('pointerup', onUp);
        varBtn.removeEventListener('pointercancel', onUp);
        if (dragged) {
          opts.onCommit?.(structuredClone(curState), startState);
        } else {
          varianceOpen = !varianceOpen;
          syncVarianceUi?.();
        }
      };

      varBtn.addEventListener('pointermove', onMove);
      varBtn.addEventListener('pointerup', onUp);
      varBtn.addEventListener('pointercancel', onUp);
    });

    varBtn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(
        [
          {
            label: varianceOpen ? 'Hide Variance Slider' : 'Show Variance Slider',
            run: () => {
              varianceOpen = !varianceOpen;
              syncVarianceUi?.();
            },
          },
          {
            label: 'Clear Variance (0)',
            disabled: getVarVal() <= 0,
            run: () => setVariance(0, false),
          },
          {
            label: 'Set Variance 0.10',
            run: () => setVariance(0.1, false),
          },
          {
            label: 'Set Variance 0.25',
            run: () => setVariance(0.25, false),
          },
        ],
        varBtn,
      );
    });

    // Variance sub-row slider drag
    varSlider.addEventListener('pointerdown', (e: PointerEvent) => {
      if (opts.disabled || e.button !== 0) return;
      e.preventDefault();
      try {
        varSlider.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in jsdom
      }
      const startState = structuredClone(curState);
      const applyAt = (clientX: number): void => {
        const r = varSlider.getBoundingClientRect();
        const w = Math.max(1, r.width);
        const t = Math.min(1, Math.max(0, (clientX - r.left) / w));
        setVariance(varMin + t * (varMax - varMin), true, startState);
      };
      applyAt(e.clientX);
      const onMove = (ev: PointerEvent): void => applyAt(ev.clientX);
      const onUp = (): void => {
        varSlider.removeEventListener('pointermove', onMove);
        varSlider.removeEventListener('pointerup', onUp);
        varSlider.removeEventListener('pointercancel', onUp);
        opts.onCommit?.(structuredClone(curState), startState);
      };
      varSlider.addEventListener('pointermove', onMove);
      varSlider.addEventListener('pointerup', onUp);
      varSlider.addEventListener('pointercancel', onUp);
    });

    varInput.addEventListener('change', () => {
      const parsed = parseNumericInput(varInput.value, getVarVal());
      setVariance(Math.max(0, parsed), false);
    });

    varInput.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const parsed = parseNumericInput(varInput.value, getVarVal());
        setVariance(Math.max(0, parsed), false);
        varInput.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        syncVarianceUi?.();
        varInput.blur();
      }
    });

    varResetBtn.addEventListener('click', () => {
      setVariance(0, false);
      varianceOpen = false;
      syncVarianceUi?.();
    });

    syncVarianceUi();
  } else {
    varSlotEl = h('div', 'kt-row-var-spacer');
  }

  // --- Curve Toggle(s) (`.kt-row-curves`) ---
  const curvesCol = h('div', 'kt-row-curves');
  let primaryMiniCurve: MiniCurveInstance | null = null;
  let secondaryMiniCurve: MiniCurveInstance | null = null;

  if (def.curveAllowed) {
    const parentCurvePath = `${pathPrefix}.Parent`;
    const initialCurve = curState.curve ?? flatCurve(1);
    const initialBadge =
      curState.curve?.level && curState.curve.level > 1
        ? curState.curve.level
        : def.id === 'number'
          ? 2
          : def.id === 'seasonDropTime' && hasActiveCurve(curState.curve)
            ? 4
            : def.id === 'seasonDroop' && hasActiveCurve(curState.curve)
              ? 5
              : undefined;

    primaryMiniCurve = mountMiniCurve(curvesCol, {
      curve: initialCurve,
      path: parentCurvePath,
      variant: 'parent',
      levelBadge: initialBadge,
      onOpenEditor: (cNow) => {
        openCurveDialog(parentCurvePath, {
          curve: cNow,
          nodeId: opts.nodeId,
          paramId: def.id,
          valueScale: typeof curState.value === 'number' ? curState.value : 1,
          variance: curState.variance,
          onChange: (c) => {
            primaryMiniCurve?.setCurve(c, c.level && c.level > 1 ? c.level : initialBadge);
            curState = { ...curState, curve: cloneCurve(c) };
            syncRowIndicators();
            opts.onChange(structuredClone(curState), true);
          },
          onCommit: (c, prev) => {
            primaryMiniCurve?.setCurve(c, c.level && c.level > 1 ? c.level : initialBadge);
            const prevState = { ...curState, curve: cloneCurve(prev) };
            curState = { ...curState, curve: cloneCurve(c) };
            syncRowIndicators();
            opts.onChange(structuredClone(curState), false);
            opts.onCommit?.(structuredClone(curState), prevState);
          },
        });
      },
      onChange: (c) => {
        curState = { ...curState, curve: cloneCurve(c) };
        syncRowIndicators();
        opts.onChange(structuredClone(curState), true);
      },
      onCommit: (c, prev) => {
        const prevState = { ...curState, curve: cloneCurve(prev) };
        curState = { ...curState, curve: cloneCurve(c) };
        syncRowIndicators();
        opts.onChange(structuredClone(curState), false);
        opts.onCommit?.(structuredClone(curState), prevState);
      },
    });

    if (TWO_CURVE_PARAMS.has(def.id)) {
      const profilePath = `${pathPrefix}.Profile`;
      const isProfileVariant = PROFILE_VARIANT_PARAMS.has(def.id);
      secondaryMiniCurve = mountMiniCurve(curvesCol, {
        curve: profileCurve,
        path: profilePath,
        variant: isProfileVariant ? 'profile' : 'dim',
        onOpenEditor: (cNow) => {
          openCurveDialog(profilePath, {
            curve: cNow,
            valueScale: 1,
            onChange: (c) => {
              profileCurve = cloneCurve(c);
              secondaryMiniCurve?.setCurve(profileCurve);
            },
            onCommit: (c) => {
              profileCurve = cloneCurve(c);
              secondaryMiniCurve?.setCurve(profileCurve);
            },
          });
        },
        onChange: (c) => {
          profileCurve = cloneCurve(c);
        },
      });
    }
  }

  // --- Reset to Default helper ---
  const resetToDefault = (): void => {
    if (opts.disabled) return;
    const prevState = structuredClone(curState);
    const defState = defaultParamState(def);
    curState = structuredClone(defState);
    isMixed = false;
    widget?.update(curState, false);
    syncVarianceUi?.();
    if (primaryMiniCurve) {
      primaryMiniCurve.setCurve(curState.curve ?? flatCurve(1));
    }
    syncRowIndicators();
    opts.onChange(structuredClone(curState), false);
    opts.onCommit?.(structuredClone(curState), prevState);
  };

  resetInlineBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resetToDefault();
  });

  // --- Drag-scrub on Label & Double-click Label to Reset ---
  if (widget?.scrubBegin && widget.scrubBy && widget.scrubCommit) {
    labelEl.classList.add('scrubbable');
    labelEl.addEventListener('pointerdown', (e: PointerEvent) => {
      if (opts.disabled || e.button !== 0 || (e.target as HTMLElement).closest('.kt-row-reset')) return;
      e.preventDefault();
      try {
        labelEl.setPointerCapture(e.pointerId);
      } catch {
        // Ignore in jsdom
      }
      let lastX = e.clientX;
      let moved = false;
      widget.scrubBegin?.();

      const onMove = (ev: PointerEvent): void => {
        const dx = ev.clientX - lastX;
        if (!moved && Math.abs(dx) < 2) return;
        moved = true;
        lastX = ev.clientX;
        widget.scrubBy?.(dx, { shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey || ev.metaKey });
      };

      const onUp = (): void => {
        labelEl.removeEventListener('pointermove', onMove);
        labelEl.removeEventListener('pointerup', onUp);
        labelEl.removeEventListener('pointercancel', onUp);
        if (moved) {
          widget.scrubCommit?.();
        }
      };

      labelEl.addEventListener('pointermove', onMove);
      labelEl.addEventListener('pointerup', onUp);
      labelEl.addEventListener('pointercancel', onUp);
    });
  }

  labelEl.addEventListener('dblclick', (e) => {
    if (opts.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    resetToDefault();
  });

  // --- Right-click Context Menu on Row / Label ---
  const openRowContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const modified = isParamModified(def, curState);
    const items: MenuItem[] = [
      {
        label: 'Reset to Default',
        disabled: Boolean(opts.disabled) || (!modified && !isMixed),
        run: resetToDefault,
      },
      { separator: true },
      {
        label: 'Copy Value',
        run: () => copyParamToClipboard(def, curState),
      },
      {
        label: 'Paste Value',
        disabled: Boolean(opts.disabled) || !canPasteParamFromClipboard(def),
        run: () => {
          const pasted = getParamFromClipboard(def);
          if (!pasted) return;
          const prevState = structuredClone(curState);
          curState = {
            value: pasted.value,
            variance: def.variance !== undefined ? pasted.variance : curState.variance,
            curve: def.curveAllowed ? pasted.curve : undefined,
          };
          isMixed = false;
          widget?.update(curState, false);
          syncVarianceUi?.();
          if (primaryMiniCurve) primaryMiniCurve.setCurve(curState.curve ?? flatCurve(1));
          syncRowIndicators();
          opts.onChange(structuredClone(curState), false);
          opts.onCommit?.(structuredClone(curState), prevState);
        },
      },
    ];

    if (supportsVariance && def.kind !== 'bool' && def.kind !== 'enum' && def.kind !== 'string') {
      items.push(
        { separator: true },
        {
          label: varianceOpen ? 'Hide Variance Slider' : 'Show Variance Slider',
          run: () => {
            varianceOpen = !varianceOpen;
            syncVarianceUi?.();
          },
        },
        {
          label: 'Reset Variance',
          disabled: !curState.variance,
          run: () => {
            const prevState = structuredClone(curState);
            curState = { ...curState, variance: 0 };
            syncVarianceUi?.();
            syncRowIndicators();
            opts.onChange(structuredClone(curState), false);
            opts.onCommit?.(structuredClone(curState), prevState);
          },
        },
      );
    }

    if (def.curveAllowed) {
      items.push(
        { separator: true },
        {
          label: 'Edit Curve…',
          run: () => primaryMiniCurve?.button.click(),
        },
        {
          label: 'Reset Curve',
          disabled: !hasActiveCurve(curState.curve),
          run: () => {
            const prevState = structuredClone(curState);
            curState = { ...curState, curve: null };
            primaryMiniCurve?.setCurve(flatCurve(1));
            syncRowIndicators();
            opts.onChange(structuredClone(curState), false);
            opts.onCommit?.(structuredClone(curState), prevState);
          },
        },
      );
    }

    showMenu(items, labelEl);
  };

  labelEl.addEventListener('contextmenu', openRowContextMenu);
  mainRow.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.kt-mini-curve')) return;
    openRowContextMenu(e);
  });

  function syncRowIndicators(): void {
    const modified = isParamModified(def, curState);
    mainRow.classList.toggle('modified', modified);
    mainRow.classList.toggle('mixed', isMixed);
    mainRow.classList.toggle('curve-active', hasActiveCurve(curState.curve));
    resetInlineBtn.hidden = !modified && !isMixed;
    labelEl.title = buildParamTooltip(def, curState, isMixed);
    if (def.kind === 'int' && def.warnAbove !== undefined) {
      const over = typeof curState.value === 'number' && curState.value > def.warnAbove;
      perfBadge.hidden = !over;
      perfBadge.title = `${def.label} is above ${def.warnAbove}: generation and meshing may be slow.`;
    }
  }

  syncRowIndicators();

  mainRow.append(labelEl, ...(leadingWrap ? [leadingWrap] : []), controlHost);
  if (def.kind === 'float' || def.kind === 'int' || def.variance !== undefined) {
    mainRow.append(varSlotEl);
  }
  if (def.curveAllowed) {
    mainRow.append(curvesCol);
  }

  rowContainer.append(mainRow);
  if (varianceSubRow) rowContainer.append(varianceSubRow);
  host.append(rowContainer);

  return {
    element: rowContainer,
    def,
    update(nextState: ParamState, nextMixed = false, pairedState?: ParamState, pairedMixed?: boolean): void {
      curState = structuredClone(nextState);
      isMixed = nextMixed;
      widget?.update(curState, isMixed);
      syncVarianceUi?.();
      if (primaryMiniCurve) {
        primaryMiniCurve.setCurve(
          curState.curve ?? flatCurve(1),
          curState.curve?.level && curState.curve.level > 1 ? curState.curve.level : undefined,
        );
      }
      if (pairedState && updateLeadingCheck) {
        updateLeadingCheck(pairedState, pairedMixed);
      }
      syncRowIndicators();
    },
    setVisible(visible: boolean): void {
      rowContainer.hidden = !visible;
    },
    dispose(): void {
      widget?.dispose();
      primaryMiniCurve?.dispose();
      secondaryMiniCurve?.dispose();
      rowContainer.remove();
    },
  };
}
