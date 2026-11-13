import type { DisplacementChannel, DisplacementDef } from '@/contracts/material';
import { DISPLACEMENT_CHANNELS, getHeightField, hasDisplacementSource, onDisplacementSourcesChanged } from '@/materials/displacement';
import { getTextureManager } from '@/textures/textureManager';
import { h, iconButton } from '../components/dom';
import { createSelect } from '../components/select';
import type { PanelInstance } from '../docking/panelRegistry';
import { icon } from '../icons/icons';
import { mountAssetPanel, type AssetPanelContext } from './assets/assetPanel';
import { card, checkbox, row, sliderField, textField } from './assets/widgets';

/** Displacements: height image + channel / smoothing / brightness / contrast / normalise, with a processed preview. */

function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/bmp';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function drawField(canvas: HTMLCanvasElement, def: DisplacementDef): void {
  const hf = getHeightField(def);
  const g = canvas.getContext('2d');
  if (!g) return;
  if (!hf) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  canvas.width = hf.width;
  canvas.height = hf.height;
  const img = g.createImageData(hf.width, hf.height);
  for (let i = 0; i < hf.data.length; i++) {
    const v = Math.round((hf.data[i] as number) * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

function build(ctx: AssetPanelContext<DisplacementDef>): void | (() => void) {
  const def = ctx.entry;
  if (!def) {
    ctx.body.append(h('div', 'kt-prop-empty', 'No displacements yet. Press + to create one.'));
    return;
  }
  const tm = getTextureManager();
  const canvas = h('canvas', 'kt-disp-canvas');
  const preview = h('div', 'kt-disp-preview checker', canvas);
  const redraw = (): void => {
    const live = ctx.lib.displacements().find((d) => d.id === def.id);
    if (live) drawField(canvas, live);
  };
  const load = async (file: File | null): Promise<void> => {
    if (!file) return;
    const asset = await tm.importFile(file);
    ctx.edit('Load displacement image', (d) => {
      d.assetId = asset.id;
      d.fileName = file.name;
    });
    await tm.loadPixels(asset.id);
    ctx.rerender();
  };
  const reload = async (): Promise<void> => {
    if (!def.assetId) return;
    tm.invalidate(def.assetId);
    await tm.loadPixels(def.assetId);
    redraw();
  };
  if (def.assetId && !hasDisplacementSource(def.assetId)) void tm.loadPixels(def.assetId);

  const pick = h('button', 'kt-btn kt-btn-icon', '…');
  pick.type = 'button';
  pick.title = 'Browse…';
  pick.addEventListener('click', () => void pickImage().then(load));
  const reloadBtn = iconButton(icon('reset', 18), 'Reload image', () => void reload(), 'kt-btn kt-btn-icon');

  const set = <K extends keyof DisplacementDef>(key: K, label: string, merge = false) => (v: DisplacementDef[K]): void => {
    ctx.edit(label, (d) => (d[key] = v), merge ? key : undefined);
    redraw();
  };
  const channel = createSelect({
    options: DISPLACEMENT_CHANNELS.map((c) => c.label),
    value: DISPLACEMENT_CHANNELS.find((c) => c.value === def.channel)?.label ?? 'Greyscale',
    width: 110,
    onChange: (label) => set('channel', 'Displacement channel')((DISPLACEMENT_CHANNELS.find((c) => c.label === label)?.value ?? 'greyscale') as DisplacementChannel),
  });
  const settings = card(
    'Settings',
    h('div', 'kt-disp-file', h('label', '', 'Filename'), textField(def.fileName, () => undefined, { readOnly: true, placeholder: 'No image' }), pick, reloadBtn),
    h('div', 'kt-disp-pair', h('label', '', 'Channel'), channel, h('label', '', 'Smoothing'), sliderField({ value: def.smoothing, min: 0, max: 1, onChange: set('smoothing', 'Displacement smoothing', true) })),
    h('div', 'kt-disp-pair', h('label', '', 'Brightness'), sliderField({ value: def.brightness, min: 0, max: 1, onChange: set('brightness', 'Displacement brightness', true) }), h('label', '', 'Contrast'), sliderField({ value: def.contrast, min: 0, max: 1, onChange: set('contrast', 'Displacement contrast', true) })),
    row('Normalize', checkbox(def.normalize, set('normalize', 'Displacement normalize'))),
  );
  ctx.body.append(settings, preview);
  const off = onDisplacementSourcesChanged(redraw);
  requestAnimationFrame(redraw);
  return off;
}

export function createDisplacementsPanel(host: HTMLElement): PanelInstance {
  return mountAssetPanel<DisplacementDef>(host, { kind: 'displacements', noun: 'displacement', className: 'kt-disp', hand: true, build });
}
