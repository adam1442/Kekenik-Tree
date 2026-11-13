import type { MaterialSetDef, MaterialSetMember } from '@/contracts/material';
import { uid } from '@/core/id';
import { cloneCurve, flatCurve, type Curve } from '@/core/curve';
import { defaultPreviewView, getPreviewRenderer } from '@/materials/preview';
import { h } from '../components/dom';
import { mountMiniCurve } from '../components/curve';
import type { PanelInstance } from '../docking/panelRegistry';
import { icon } from '../icons/icons';
import { openCurveDialog } from './dialogs/curveDialog';
import { mountAssetPanel, type AssetPanelContext } from './assets/assetPanel';
import { card, checkbox, numberField, valueSelect } from './assets/widgets';

/** Material Sets: named collections of weighted, season-aware materials. */

function seasonControl(title: string, curve: Curve | null | undefined, dim: boolean, onChange: (c: Curve) => void): HTMLElement {
  const host = h('div', 'kt-season-host');
  const mini = mountMiniCurve(host, {
    curve: curve ?? flatCurve(1),
    width: 34,
    height: 28,
    variant: dim ? 'dim' : 'parent',
    path: title,
    onChange,
    onOpenEditor: (c) => openCurveDialog(title, { curve: c, onChange: (next) => { mini.setCurve(next); onChange(next); } }),
  });
  return host;
}

function memberRow(ctx: AssetPanelContext<MaterialSetDef>, set: MaterialSetDef, m: MaterialSetMember): HTMLElement {
  const lib = ctx.lib;
  const edit = (label: string, fn: (x: MaterialSetMember) => void, key?: string): void =>
    ctx.edit(label, (s) => {
      const t = s.members.find((x) => x.id === m.id);
      if (t) fn(t);
    }, key ? `${m.id}:${key}` : undefined);

  const thumb = h('canvas', 'kt-member-thumb');
  const wrap = h('div', 'kt-member-thumb-wrap checker', thumb);
  const draw = (): void => {
    if (!thumb.isConnected) return;
    getPreviewRenderer().render(thumb, m.materialId, 48, 48, defaultPreviewView());
    thumb.style.width = thumb.style.height = '48px';
  };
  requestAnimationFrame(draw);
  const off = getPreviewRenderer().onInvalidate(() => (thumb.isConnected ? draw() : off()));

  const select = valueSelect(() => lib.materials().map((x) => ({ value: x.id, label: x.name })), m.materialId, (v) => {
    edit('Change member material', (x) => (x.materialId = v));
    draw();
  }, 'kt-member-select');
  const remove = h('button', 'kt-member-remove', icon('close', 16));
  remove.type = 'button';
  remove.title = 'Remove member';
  remove.addEventListener('click', () => {
    ctx.edit('Remove member', (s) => (s.members = s.members.filter((x) => x.id !== m.id)));
    ctx.rerender();
  });
  const weight = numberField({ value: m.weight, min: 0, step: 0.1, onChange: (v) => edit('Member weight', (x) => (x.weight = v), 'w') });
  const season = seasonControl(`MaterialSet.${set.name}:${lib.material(m.materialId)?.name ?? ''}:Season`, m.season, set.overrideSeason, (c) => edit('Member season', (x) => (x.season = cloneCurve(c)), 's'));
  season.classList.toggle('disabled', set.overrideSeason);
  return h(
    'div',
    'kt-member',
    wrap,
    h('div', 'kt-member-main', h('div', 'kt-member-top', select.el, remove), h('div', 'kt-member-bottom', h('label', '', 'Weight'), weight, h('label', 'kt-member-season-label', 'Season'), season)),
  );
}

export function createMaterialSetsPanel(host: HTMLElement): PanelInstance {
  return mountAssetPanel<MaterialSetDef>(host, {
    kind: 'materialSets',
    noun: 'material set',
    className: 'kt-sets',
    hand: true,
    alsoKinds: ['materials'],
    build(ctx) {
      const set = ctx.entry;
      if (!set) {
        ctx.body.append(h('div', 'kt-prop-empty', 'No material sets yet. Press + to create one.'));
        return;
      }
      const overrideSeason = seasonControl(`MaterialSet.${set.name}:Season`, set.season, !set.overrideSeason, (c) => ctx.edit('Set season', (s) => (s.season = cloneCurve(c)), 'season'));
      const settings = card(
        'Settings',
        h('div', 'kt-mat-row kt-left', h('label', '', 'Override season'), checkbox(set.overrideSeason, (v) => { ctx.edit('Override season', (s) => (s.overrideSeason = v)); ctx.rerender(); }), overrideSeason),
      );
      const add = h('button', 'kt-btn kt-add-member', icon('plusSquare', 16), 'Add');
      add.type = 'button';
      add.addEventListener('click', () => {
        const first = ctx.lib.materials()[0];
        if (!first) return;
        ctx.edit('Add member', (s) => s.members.push({ id: uid('mem'), materialId: first.id, weight: 1, season: null }));
        ctx.rerender();
      });
      ctx.body.append(settings, card('Members', add, h('div', 'kt-members', ...set.members.map((m) => memberRow(ctx, set, m)))));
    },
  });
}
