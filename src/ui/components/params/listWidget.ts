import { cloneCurve, flatCurve } from '@/core/curve';
import type {
  EnumParamDef,
  FloatParamDef,
  IntParamDef,
  ListItem,
  ListParamDef,
  ParamDef,
  ParamScalar,
  ParamState,
} from '@/contracts/params';
import { mountMiniCurve, type MiniCurveInstance } from '../curve';
import { h, iconButton } from '../dom';
import type { ParamWidgetInstance, ParamWidgetMountOptions } from '../paramWidgetRegistry';
import { icon } from '../../icons/icons';
import { openCurveDialog } from '../../panels/dialogs/curveDialog';
import { createNumericWidget } from './numericWidgets';
import { createBoolWidget, createEnumWidget, createStringWidget } from './scalarWidgets';

function defaultListItem(fields: readonly ParamDef[]): ListItem {
  const item: ListItem = {};
  for (const f of fields) {
    if (typeof f.default === 'number' || typeof f.default === 'boolean' || typeof f.default === 'string') {
      item[f.id] = f.default;
    } else {
      item[f.id] = '';
    }
  }
  return item;
}

function readListItems(val: unknown, def: ListParamDef): ListItem[] {
  if (Array.isArray(val)) {
    const out: ListItem[] = [];
    for (const raw of val) {
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const item = defaultListItem(def.fields);
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
            item[k] = v;
          }
        }
        out.push(item);
      }
    }
    if (out.length >= (def.minItems ?? 0)) return out;
  }
  return structuredClone(def.default);
}

export function createListWidget(
  host: HTMLElement,
  opts: ParamWidgetMountOptions<ListParamDef>,
): ParamWidgetInstance {
  const { def } = opts;
  const minItems = def.minItems ?? 0;
  const maxItems = def.maxItems ?? 32;

  let curState: ParamState = structuredClone(opts.state);
  let items: ListItem[] = readListItems(curState.value, def);
  let childDisposables: (() => void)[] = [];

  const clearChildren = (): void => {
    for (const d of childDisposables) d();
    childDisposables = [];
  };

  const minusBtn = iconButton(
    icon('minus', 14),
    `Remove ${def.label.toLowerCase()}`,
    () => {
      if (opts.disabled || items.length <= minItems) return;
      const prevState = structuredClone(curState);
      items = items.slice(0, -1);
      curState = { ...curState, value: structuredClone(items) };
      renderCards();
      opts.onChange(structuredClone(curState), false);
      opts.onCommit?.(structuredClone(curState), prevState);
    },
    'kt-sq-btn',
  );

  const plusBtn = iconButton(
    icon('plus', 14),
    `Add ${def.label.toLowerCase()}`,
    () => {
      if (opts.disabled || items.length >= maxItems) return;
      const prevState = structuredClone(curState);
      const template = items[items.length - 1]
        ? structuredClone(items[items.length - 1] as ListItem)
        : defaultListItem(def.fields);
      items = [...items, template];
      curState = { ...curState, value: structuredClone(items) };
      renderCards();
      opts.onChange(structuredClone(curState), false);
      opts.onCommit?.(structuredClone(curState), prevState);
    },
    'kt-sq-btn',
  );

  const subhead = h('div', 'kt-subhead kt-list-head', h('span', '', def.label), h('div', 'kt-spacer'), minusBtn, plusBtn);
  const cardsContainer = h('div', 'kt-list-cards');
  const wrapper = h('div', 'kt-param-list', subhead, cardsContainer);

  const emitItemsChange = (nextItems: ListItem[], merge: boolean, prevOverride?: ParamState): void => {
    const prevState = prevOverride ?? structuredClone(curState);
    items = structuredClone(nextItems);
    curState = { ...curState, value: structuredClone(items) };
    opts.onChange(structuredClone(curState), merge);
    if (!merge) {
      opts.onCommit?.(structuredClone(curState), prevState);
    }
  };

  const renderCards = (): void => {
    clearChildren();
    cardsContainer.replaceChildren();
    minusBtn.disabled = Boolean(opts.disabled) || items.length <= minItems;
    plusBtn.disabled = Boolean(opts.disabled) || items.length >= maxItems;

    items.forEach((item, idx) => {
      const removeBtn = h('button', 'kt-icon-btn kt-type-x', icon('close', 14));
      removeBtn.type = 'button';
      removeBtn.title = `Remove ${def.label} #${idx + 1}`;
      removeBtn.disabled = Boolean(opts.disabled) || items.length <= minItems;
      removeBtn.addEventListener('click', () => {
        if (opts.disabled || items.length <= minItems) return;
        const prevState = structuredClone(curState);
        const nextItems = items.filter((_, i) => i !== idx);
        items = nextItems;
        curState = { ...curState, value: structuredClone(items) };
        renderCards();
        opts.onChange(structuredClone(curState), false);
        opts.onCommit?.(structuredClone(curState), prevState);
      });

      const card = h('div', 'kt-type-card', removeBtn);
      card.addEventListener('dragover', (e) => {
        if (e.dataTransfer?.types.includes('application/x-kekenik-cutout')) {
          e.preventDefault();
          card.classList.add('drop');
        }
      });
      card.addEventListener('dragleave', () => card.classList.remove('drop'));
      card.addEventListener('drop', (e) => {
        card.classList.remove('drop');
        const cutoutId = e.dataTransfer?.getData('application/x-kekenik-cutout');
        if (!cutoutId || opts.disabled) return;
        e.preventDefault();
        const nextItems = structuredClone(items);
        const target = nextItems[idx];
        if (target && 'mesh' in target) {
          target.mesh = cutoutId;
          emitItemsChange(nextItems, false);
          renderCards();
        }
      });

      for (const field of def.fields) {
        const fieldVal: ParamScalar = item[field.id] ?? (field.default as ParamScalar);
        const fieldHost = h('div', 'kt-row-control');
        let gestureStart = structuredClone(curState);

        const onFieldChange = (nextFieldState: ParamState, merge: boolean): void => {
          if (merge && items[idx]?.[field.id] === fieldVal) {
            gestureStart = structuredClone(curState);
          }
          const nextItems = structuredClone(items);
          const target = nextItems[idx];
          if (target && (typeof nextFieldState.value === 'number' || typeof nextFieldState.value === 'boolean' || typeof nextFieldState.value === 'string')) {
            target[field.id] = nextFieldState.value;
          }
          emitItemsChange(nextItems, merge);
        };

        const onFieldCommit = (): void => {
          opts.onCommit?.(structuredClone(curState), gestureStart);
        };

        const fieldState: ParamState = { value: fieldVal };
        let inst: ParamWidgetInstance | null = null;
        if (field.kind === 'enum') {
          inst = createEnumWidget(fieldHost, {
            def: field as EnumParamDef,
            state: fieldState,
            disabled: opts.disabled,
            resolveDynamicOptions: opts.resolveDynamicOptions,
            onChange: onFieldChange,
            onCommit: onFieldCommit,
          });
        } else if (field.kind === 'float' || field.kind === 'int') {
          inst = createNumericWidget(fieldHost, {
            def: field as FloatParamDef | IntParamDef,
            state: fieldState,
            disabled: opts.disabled,
            onChange: onFieldChange,
            onCommit: onFieldCommit,
          });
        } else if (field.kind === 'bool') {
          inst = createBoolWidget(fieldHost, {
            def: field,
            state: fieldState,
            disabled: opts.disabled,
            onChange: onFieldChange,
            onCommit: onFieldCommit,
          });
        } else if (field.kind === 'string') {
          inst = createStringWidget(fieldHost, {
            def: field,
            state: fieldState,
            disabled: opts.disabled,
            onChange: onFieldChange,
            onCommit: onFieldCommit,
          });
        }

        if (inst) {
          childDisposables.push(() => inst.dispose());
        }

        // Optional per-field curve toggle
        let curvesCol: HTMLElement | null = null;
        if (field.curveAllowed) {
          const curveHolder = h('div', 'kt-row-curves');
          const basePath = opts.path ?? `${def.subgroup ?? def.group}:${def.label}`;
          const rowPath = `${basePath}:${idx + 1}:${field.label}.Parent`;
          const initialCurve = curState.curve ?? flatCurve(1);
          const mini: MiniCurveInstance = mountMiniCurve(curveHolder, {
            curve: initialCurve,
            path: rowPath,
            variant: 'parent',
            levelBadge: curState.curve?.level && curState.curve.level > 1 ? curState.curve.level : undefined,
            onOpenEditor: (cNow) => {
              openCurveDialog(rowPath, {
                curve: cNow,
                nodeId: opts.nodeId,
                paramId: def.id,
                valueScale: typeof items[idx]?.[field.id] === 'number' ? (items[idx]?.[field.id] as number) : 1,
                onChange: (c) => {
                  mini.setCurve(c, c.level && c.level > 1 ? c.level : undefined);
                  curState = { ...curState, curve: cloneCurve(c) };
                  opts.onChange(structuredClone(curState), true);
                },
                onCommit: (c, prev) => {
                  mini.setCurve(c, c.level && c.level > 1 ? c.level : undefined);
                  const prevS = { ...curState, curve: cloneCurve(prev) };
                  curState = { ...curState, curve: cloneCurve(c) };
                  opts.onChange(structuredClone(curState), false);
                  opts.onCommit?.(structuredClone(curState), prevS);
                },
              });
            },
            onChange: (c) => {
              curState = { ...curState, curve: cloneCurve(c) };
              opts.onChange(structuredClone(curState), true);
            },
            onCommit: (c, prev) => {
              const prevS = { ...curState, curve: cloneCurve(prev) };
              curState = { ...curState, curve: cloneCurve(c) };
              opts.onChange(structuredClone(curState), false);
              opts.onCommit?.(structuredClone(curState), prevS);
            },
          });
          childDisposables.push(() => mini.dispose());
          curvesCol = curveHolder;
        }

        const labelEl = h('label', 'kt-row-label', field.label);
        if (inst?.scrubBegin && inst.scrubBy && inst.scrubCommit) {
          labelEl.classList.add('scrubbable');
          labelEl.addEventListener('pointerdown', (e: PointerEvent) => {
            if (opts.disabled || e.button !== 0) return;
            e.preventDefault();
            try {
              labelEl.setPointerCapture(e.pointerId);
            } catch {
              // Ignore in jsdom
            }
            inst.scrubBegin?.();
            let lastX = e.clientX;
            const onMove = (ev: PointerEvent): void => {
              const dx = ev.clientX - lastX;
              lastX = ev.clientX;
              inst.scrubBy?.(dx, { shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey || ev.metaKey });
            };
            const onUp = (): void => {
              labelEl.removeEventListener('pointermove', onMove);
              labelEl.removeEventListener('pointerup', onUp);
              labelEl.removeEventListener('pointercancel', onUp);
              inst.scrubCommit?.();
            };
            labelEl.addEventListener('pointermove', onMove);
            labelEl.addEventListener('pointerup', onUp);
            labelEl.addEventListener('pointercancel', onUp);
          });
        }

        const row = h('div', 'kt-row kt-type-row', labelEl, fieldHost, curvesCol);
        card.append(row);
      }

      cardsContainer.append(card);
    });
  };

  renderCards();
  host.append(wrapper);

  return {
    element: wrapper,
    update(next: ParamState): void {
      curState = structuredClone(next);
      items = readListItems(next.value, def);
      renderCards();
    },
    dispose(): void {
      clearChildren();
      wrapper.remove();
    },
  };
}
