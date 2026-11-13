import type { MaskDef } from '@/contracts/material';
import { createSelect } from '../components/select';
import { h } from '../components/dom';
import type { PanelInstance } from '../docking/panelRegistry';
import { mountAssetPanel } from './assets/assetPanel';
import { card, numberField } from './assets/widgets';

/** Masks: terrain masks selecting by slope and elevation (see materials/masks.ts for the evaluation). */
export function createMasksPanel(host: HTMLElement): PanelInstance {
  return mountAssetPanel<MaskDef>(host, {
    kind: 'masks',
    noun: 'mask',
    className: 'kt-masks',
    hand: true,
    build(ctx) {
      const mask = ctx.entry;
      if (!mask) {
        ctx.body.append(h('div', 'kt-prop-empty', 'No masks yet. Press + to create one.'));
        return;
      }
      const range = (get: (m: MaskDef) => { min: number; max: number }, label: string, disabled = false): HTMLElement[] => [
        numberField({ value: get(mask).min, step: 0.05, disabled, onChange: (v) => ctx.edit(`${label} min`, (m) => (get(m).min = v), `${label}-min`) }),
        numberField({ value: get(mask).max, step: 0.05, disabled, onChange: (v) => ctx.edit(`${label} max`, (m) => (get(m).max = v), `${label}-max`) }),
      ];
      const relative = mask.elevationMode === 'relative';
      const radio = (on: boolean, mode: MaskDef['elevationMode'], text: string): HTMLElement => {
        const b = h('button', `kt-radio${on ? ' on' : ''}`);
        b.type = 'button';
        b.addEventListener('click', () => {
          ctx.edit('Elevation mode', (m) => (m.elevationMode = mode));
          ctx.rerender();
        });
        return h('div', 'kt-mask-radio', b, h('label', on ? '' : 'dim', text));
      };
      const grid = h(
        'div',
        'kt-mask-grid',
        h('span'), h('span', 'kt-mask-head', 'Min'), h('span', 'kt-mask-head', 'Max'),
        h('label', 'kt-mask-label', 'Slope'), ...range((m) => m.slope, 'Slope'),
        radio(relative, 'relative', 'Relative elevation'), ...range((m) => m.relativeElevation, 'Relative elevation', !relative),
        radio(!relative, 'absolute', 'Absolute elevation'), ...range((m) => m.absoluteElevation, 'Absolute elevation', relative),
      );
      const behavior = createSelect({
        options: ['Inclusive', 'Exclusive'],
        value: mask.behavior === 'inclusive' ? 'Inclusive' : 'Exclusive',
        width: 100,
        onChange: (v) => ctx.edit('Mask behavior', (m) => (m.behavior = v === 'Inclusive' ? 'inclusive' : 'exclusive')),
      });
      const top = h(
        'div',
        'kt-mask-top',
        h('label', '', 'Behavior'), behavior,
        h('label', '', 'Fuzziness'), numberField({ value: mask.fuzziness, min: 0, step: 0.05, onChange: (v) => ctx.edit('Mask fuzziness', (m) => (m.fuzziness = v), 'fuzz') }),
        h('label', 'kt-mask-type-label', 'Type'), createSelect({ options: ['Terrain'], value: 'Terrain', width: 100 }),
      );
      ctx.body.append(card('Settings', top, grid));
    },
  });
}
