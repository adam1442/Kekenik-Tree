import { getApp } from '@/app/context';
import {
  applyQualityPreset,
  getQuality,
  getQualityStatus,
  onQualityChange,
  onQualityStatusChange,
  setQuality,
  type AlphaMode,
  type GridUnit,
  type PostAA,
  type QualityPreset,
} from '@/viewport/quality/qualitySettings';
import { h } from '../components/dom';
import { createSelect } from '../components/select';
import type { PanelInstance } from '../docking/panelRegistry';
import { card, checkbox, row, sliderField } from './assets/widgets';

const PRESET_NAMES: QualityPreset[] = ['low', 'medium', 'high', 'ultra'];
const MSAA_LABELS = ['Off', '2x', '4x', '8x'];
const MSAA_VALUES = [0, 2, 4, 8] as const;
const POST_LABELS = ['None', 'FXAA', 'SMAA', 'TAA'];
const POST_VALUES: PostAA[] = ['none', 'fxaa', 'smaa', 'taa'];
const ALPHA_LABELS = ['Alpha to coverage', 'Hashed (dither)', 'Alpha test'];
const ALPHA_VALUES: AlphaMode[] = ['coverage', 'hashed', 'test'];
const UNITS: GridUnit[] = ['m', 'cm', 'in', 'ft'];

/**
 * Viewport Quality panel: presets (Low / Medium / High / Ultra), anti-aliasing, cut-out foliage and
 * ground-grid options. Everything is persisted by `qualitySettings` and takes effect live.
 */
export function createViewportQualityPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  host.classList.add('kt-lighting', 'kt-quality');
  const body = h('div', 'kt-asset-body kt-lighting-body');
  host.append(body);

  const status = h('div', 'kt-quality-status');
  const presetButtons = new Map<QualityPreset, HTMLButtonElement>();
  const syncStatus = (): void => {
    const s = getQualityStatus();
    const taa = s.taaProgress[1] > 0 && getQuality().postAA === 'taa' ? ` · TAA ${Math.min(s.taaProgress[0], s.taaProgress[1])}/${s.taaProgress[1]}` : '';
    status.textContent = s.label ? `Active: ${s.label}${s.refined ? '' : ' (interactive)'}${taa}` : 'Active: -';
  };
  const syncPresets = (): void => {
    const current = getQuality().preset;
    presetButtons.forEach((b, name) => b.setAttribute('aria-pressed', String(name === current)));
  };

  const build = (): void => {
    const q = getQuality();
    presetButtons.clear();
    const presets = h(
      'div',
      'kt-lighting-presets',
      ...PRESET_NAMES.map((name) => {
        const b = h('button', 'kt-btn', name[0]?.toUpperCase() + name.slice(1));
        b.type = 'button';
        b.addEventListener('click', () => {
          applyQualityPreset(name);
          build();
        });
        presetButtons.set(name, b);
        return b;
      }),
    );
    const sel = (options: string[], value: string, onChange: (v: string) => void): HTMLButtonElement => createSelect({ options, value, width: 130, onChange });
    const showGrid = app.store.get().showGrid;
    body.replaceChildren(
      card('Viewport Quality', presets, status),
      card(
        'Anti-aliasing',
        row('MSAA', sel(MSAA_LABELS, MSAA_LABELS[MSAA_VALUES.indexOf(q.msaaSamples)] ?? 'Off', (v) => setQuality({ msaaSamples: MSAA_VALUES[MSAA_LABELS.indexOf(v)] ?? 0 }))),
        row('Post AA', sel(POST_LABELS, POST_LABELS[POST_VALUES.indexOf(q.postAA)] ?? 'None', (v) => setQuality({ postAA: POST_VALUES[POST_LABELS.indexOf(v)] ?? 'none' }))),
        row('TAA frames', sliderField({ value: q.taaFrames, min: 2, max: 32, step: 1, onChange: (v) => setQuality({ taaFrames: v }) })),
        row('Progressive', checkbox(q.progressive, (v) => setQuality({ progressive: v }))),
        row('Max pixel ratio', sliderField({ value: q.maxPixelRatio, min: 1, max: 3, step: 0.25, onChange: (v) => setQuality({ maxPixelRatio: v }) })),
      ),
      card(
        'Cut-out foliage',
        row('Alpha mode', sel(ALPHA_LABELS, ALPHA_LABELS[ALPHA_VALUES.indexOf(q.alphaMode)] ?? ALPHA_LABELS[0] ?? '', (v) => setQuality({ alphaMode: ALPHA_VALUES[ALPHA_LABELS.indexOf(v)] ?? 'coverage' }))),
        row('Coverage mips', checkbox(q.coverageMips, (v) => setQuality({ coverageMips: v }))),
        row('Anisotropy', sliderField({ value: q.anisotropy, min: 1, max: 16, step: 1, onChange: (v) => setQuality({ anisotropy: v }) })),
        row('Mip bias', sliderField({ value: q.mipBias, min: -1, max: 1, step: 0.05, onChange: (v) => setQuality({ mipBias: v }) })),
        row('Leaf scaling', checkbox(q.leafDistanceScale, (v) => setQuality({ leafDistanceScale: v }))),
        row('Scaling amount', sliderField({ value: q.leafScaleAmount, min: 0, max: 0.3, step: 0.01, onChange: (v) => setQuality({ leafScaleAmount: v }) })),
      ),
      card(
        'Ground grid',
        row('Show grid', checkbox(showGrid, (v) => app.store.set({ showGrid: v }))),
        row('Axis lines', checkbox(q.showGridAxes, (v) => setQuality({ showGridAxes: v }))),
        row('Cell size', sliderField({ value: q.gridSize, min: 0.1, max: 10, step: 0.1, onChange: (v) => setQuality({ gridSize: v }) })),
        row('Units', sel(UNITS, q.gridUnit, (v) => setQuality({ gridUnit: v as GridUnit }))),
        row('Fade distance', sliderField({ value: q.gridFadeDistance, min: 50, max: 2000, step: 10, onChange: (v) => setQuality({ gridFadeDistance: v }) })),
      ),
    );
    syncPresets();
    syncStatus();
  };
  build();

  const unsubs = [
    onQualityChange(() => {
      syncPresets();
      app.viewport?.requestRender();
    }),
    onQualityStatusChange(syncStatus),
  ];
  return { dispose: () => unsubs.forEach((u) => u()) };
}
