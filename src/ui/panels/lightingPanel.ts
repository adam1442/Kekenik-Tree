import { getApp } from '@/app/context';
import { getMaterialLibrary } from '@/materials/library';
import { getShadingSettings, setShadingSettings } from '@/materials/shadingSettings';
import { LIGHTING_PRESETS, applyLightingPreset, getLighting, onLightingChange, setLighting, type LightingSettings, type ShadowQuality, type ToneMappingName } from '@/viewport/lighting';
import { hexToRgba, rgbaToHex } from '../components/colorPicker';
import { h } from '../components/dom';
import { createSelect } from '../components/select';
import type { PanelInstance } from '../docking/panelRegistry';
import { card, checkbox, colorSwatch, row, sliderField } from './assets/widgets';

/** Lighting / Environment panel: sun, sky & image-based lighting, shadows, exposure, fog / background, season, shading. */
export function createLightingPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  host.classList.add('kt-lighting');
  const body = h('div', 'kt-asset-body kt-lighting-body');
  host.append(body);

  const color = (key: 'sunColor' | 'skyColor' | 'horizonColor' | 'groundColor' | 'bgTop' | 'bgMid' | 'bgBottom'): HTMLElement =>
    colorSwatch(hexToRgba(getLighting()[key]) ?? [1, 1, 1, 1], (c) => setLighting({ [key]: rgbaToHex(c) }));
  const num = (key: 'sunAzimuth' | 'sunElevation' | 'sunIntensity' | 'ambient' | 'envIntensity' | 'exposure' | 'fogDensity' | 'shadowSoftness' | 'sunGlow', min: number, max: number, scale = 1): HTMLElement =>
    sliderField({ value: getLighting()[key] * scale, min, max, onChange: (v) => setLighting({ [key]: v / scale }) });

  const build = (): void => {
    const l: LightingSettings = getLighting();
    const presets = h('div', 'kt-lighting-presets', ...Object.keys(LIGHTING_PRESETS).map((name) => {
      const b = h('button', 'kt-btn', name);
      b.type = 'button';
      b.addEventListener('click', () => {
        applyLightingPreset(name);
        build();
      });
      return b;
    }));
    const hdr = h('button', 'kt-btn', 'Import HDR / EXR…');
    hdr.type = 'button';
    hdr.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.hdr,.exr';
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (f) void app.viewport?.setEnvironmentFile(f).catch(() => app.notify(`Could not read ${f.name}.`));
      });
      input.click();
    });
    const reset = h('button', 'kt-btn', 'Gradient sky');
    reset.type = 'button';
    reset.addEventListener('click', () => void app.viewport?.setEnvironmentFile(null));

    const sh = getShadingSettings();
    body.replaceChildren(
      card('Presets', presets),
      card('Sun', row('Azimuth°', sliderField({ value: (l.sunAzimuth * 180) / Math.PI, min: -360, max: 360, onChange: (v) => setLighting({ sunAzimuth: (v * Math.PI) / 180 }) })), row('Elevation°', sliderField({ value: (l.sunElevation * 180) / Math.PI, min: 6, max: 86, onChange: (v) => setLighting({ sunElevation: (v * Math.PI) / 180 }) })), row('Intensity', num('sunIntensity', 0, 4)), row('Color', color('sunColor')), row('Glow', num('sunGlow', 0, 2))),
      card('Sky & ambient', row('Sky', color('skyColor')), row('Horizon', color('horizonColor')), row('Ground', color('groundColor')), row('Ambient', num('ambient', 0, 2)), row('Environment', num('envIntensity', 0, 2)), h('div', 'kt-btn-row', hdr, reset)),
      card('Shadows', row('Quality', createSelect({ options: ['off', 'low', 'medium', 'high', 'ultra'], value: l.shadowQuality, width: 110, onChange: (v) => setLighting({ shadowQuality: v as ShadowQuality }) })), row('Softness', num('shadowSoftness', 0, 8))),
      card('Exposure', row('Exposure', num('exposure', 0.1, 3)), row('Tone mapping', createSelect({ options: ['ACES', 'AgX', 'Neutral', 'Linear', 'None'], value: l.toneMapping, width: 110, onChange: (v) => setLighting({ toneMapping: v as ToneMappingName }) }))),
      card('Fog & background', row('Fog', checkbox(l.fog, (v) => setLighting({ fog: v }))), row('Density', num('fogDensity', 0, 0.03)), row('Use horizon colour', checkbox(l.fogFollowsHorizon, (v) => setLighting({ fogFollowsHorizon: v }))), row('Top', color('bgTop')), row('Middle', color('bgMid')), row('Bottom', color('bgBottom'))),
      card('Season', row('Season', sliderField({ value: getMaterialLibrary().season(), min: 0, max: 1, onChange: (v) => getMaterialLibrary().setSeason(v) }))),
      card('Shading', row('Alpha threshold', sliderField({ value: sh.alphaThreshold, min: 0.01, max: 0.99, onChange: (v) => setShadingSettings({ alphaThreshold: v }) })), row('Alpha to coverage', checkbox(sh.alphaToCoverage, (v) => setShadingSettings({ alphaToCoverage: v }))), row('Translucency', checkbox(sh.translucency, (v) => setShadingSettings({ translucency: v }))), row('Transmission', sliderField({ value: sh.translucencyStrength, min: 0, max: 2, onChange: (v) => setShadingSettings({ translucencyStrength: v }) })), row('Foliage wrap', sliderField({ value: sh.foliageWrap, min: 0, max: 1, onChange: (v) => setShadingSettings({ foliageWrap: v }) })), row('Foliage sheen', sliderField({ value: sh.foliageSheen, min: 0, max: 1, onChange: (v) => setShadingSettings({ foliageSheen: v }) })), row('Baked AO', sliderField({ value: sh.vertexAo, min: 0, max: 1, onChange: (v) => setShadingSettings({ vertexAo: v }) }))),
    );
  };
  build();
  const off = onLightingChange(() => app.viewport?.requestRender());
  return { dispose: off };
}
