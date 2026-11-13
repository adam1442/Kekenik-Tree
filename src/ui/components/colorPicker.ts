import type { RGBA } from '@/contracts/params';
import { clamp } from '@/core/math';
import { h, iconButton } from './dom';
import { icon } from '../icons/icons';

/**
 * Shared ColorPicker component (HSV 2D area, Hue slider, Alpha slider,
 * RGB/HEX numeric inputs, EyeDropper support, and popup launcher).
 */

export interface ColorPickerOptions {
  value: RGBA;
  showAlpha?: boolean;
  onChange?: (color: RGBA) => void;
  onCommit?: (color: RGBA, previous: RGBA) => void;
}

export interface ColorPickerInstance {
  readonly element: HTMLElement;
  getValue(): RGBA;
  setValue(color: RGBA, silent?: boolean): void;
  dispose(): void;
}

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [clamp(h * 360, 0, 360), clamp(s, 0, 1), clamp(v, 0, 1)];
}

export function hsvToRgb(hDeg: number, s: number, v: number): [number, number, number] {
  const h = (((hDeg % 360) + 360) % 360) / 60;
  const i = Math.floor(h);
  const f = h - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

export function rgbaToHex(c: RGBA, includeAlpha = false): string {
  const to2 = (v: number): string => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  const base = `#${to2(c[0])}${to2(c[1])}${to2(c[2])}`;
  return includeAlpha ? `${base}${to2(c[3])}` : base;
}

export function hexToRgba(hex: string, fallbackAlpha = 1): RGBA | null {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt((clean[0] ?? '0') + (clean[0] ?? '0'), 16);
    const g = parseInt((clean[1] ?? '0') + (clean[1] ?? '0'), 16);
    const b = parseInt((clean[2] ?? '0') + (clean[2] ?? '0'), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return [r / 255, g / 255, b / 255, fallbackAlpha];
  }
  if (clean.length === 6 || clean.length === 8) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : fallbackAlpha;
    if ([r, g, b, a].some(Number.isNaN)) return null;
    return [r / 255, g / 255, b / 255, clamp(a, 0, 1)];
  }
  return null;
}

export function rgbaToCss(c: RGBA): string {
  const r = Math.round(clamp(c[0], 0, 1) * 255);
  const g = Math.round(clamp(c[1], 0, 1) * 255);
  const b = Math.round(clamp(c[2], 0, 1) * 255);
  const a = clamp(c[3], 0, 1);
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

const PRESET_SWATCHES: readonly RGBA[] = [
  [0.263, 0.376, 0.059, 1], // #43600f
  [0.576, 0.749, 0.337, 1], // #93bf56
  [0.455, 0.576, 0.482, 1], // #74937b
  [0.635, 0.827, 0.42, 1],  // #a2d36b (Curve green)
  [0.46, 0.41, 0.35, 1],    // Bark brown
  [0.82, 0.31, 0.14, 1],    // Autumn red
  [0.92, 0.78, 0.22, 1],    // Autumn gold
  [1, 1, 1, 1],
  [0.5, 0.5, 0.5, 1],
  [0.12, 0.12, 0.12, 1],
];

interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}

export function mountColorPicker(host: HTMLElement, opts: ColorPickerOptions): ColorPickerInstance {
  let current: RGBA = [
    clamp(opts.value[0], 0, 1),
    clamp(opts.value[1], 0, 1),
    clamp(opts.value[2], 0, 1),
    clamp(opts.value[3], 0, 1),
  ];
  let gestureStart: RGBA = [...current];
  let [hue, sat, val] = rgbToHsv(current[0], current[1], current[2]);
  const showAlpha = opts.showAlpha !== false;

  const svCanvas = h('canvas', 'kt-cp-sv-canvas');
  svCanvas.width = 160;
  svCanvas.height = 120;
  const svCursor = h('div', 'kt-cp-sv-cursor');
  const svWrap = h('div', 'kt-cp-sv-wrap', svCanvas, svCursor);

  const hueTrack = h('div', 'kt-cp-hue-track');
  const hueThumb = h('div', 'kt-cp-slider-thumb');
  const hueBar = h('div', 'kt-cp-bar kt-cp-hue', hueTrack, hueThumb);

  const alphaFill = h('div', 'kt-cp-alpha-fill');
  const alphaThumb = h('div', 'kt-cp-slider-thumb');
  const alphaBar = h('div', 'kt-cp-bar kt-cp-alpha checker', alphaFill, alphaThumb);
  if (!showAlpha) alphaBar.hidden = true;

  const previewNow = h('div', 'kt-cp-preview-fill');
  const previewBox = h('div', 'kt-cp-preview checker', previewNow);

  const hexInput = h('input', 'kt-num kt-cp-hex');
  hexInput.type = 'text';
  hexInput.title = 'Hex color (#RRGGBB)';

  const makeChannelInput = (label: string, max: number, onEdit: (n: number) => void): { wrap: HTMLElement; input: HTMLInputElement } => {
    const input = h('input', 'kt-num kt-cp-chan-input');
    input.type = 'text';
    input.addEventListener('keydown', (e) => e.stopPropagation());
    input.addEventListener('change', () => {
      const parsed = parseFloat(input.value);
      if (Number.isFinite(parsed)) {
        const before: RGBA = [...current];
        onEdit(clamp(parsed, 0, max));
        opts.onChange?.([...current]);
        opts.onCommit?.([...current], before);
      } else {
        syncUI();
      }
    });
    const wrap = h('label', 'kt-cp-chan', h('span', 'kt-cp-chan-lbl', label), input);
    return { wrap, input };
  };

  const rChan = makeChannelInput('R', 255, (v) => setFromRgba([v / 255, current[1], current[2], current[3]]));
  const gChan = makeChannelInput('G', 255, (v) => setFromRgba([current[0], v / 255, current[2], current[3]]));
  const bChan = makeChannelInput('B', 255, (v) => setFromRgba([current[0], current[1], v / 255, current[3]]));
  const aChan = makeChannelInput('A', 1, (v) => setFromRgba([current[0], current[1], current[2], v]));
  if (!showAlpha) aChan.wrap.hidden = true;

  hexInput.addEventListener('keydown', (e) => e.stopPropagation());
  hexInput.addEventListener('change', () => {
    const parsed = hexToRgba(hexInput.value, current[3]);
    if (parsed) {
      const before: RGBA = [...current];
      setFromRgba(parsed);
      opts.onChange?.([...current]);
      opts.onCommit?.([...current], before);
    } else {
      syncUI();
    }
  });

  const eyeBtn = iconButton(icon('eyedropper', 14), 'Sample color (EyeDropper)', async () => {
    const EyeDropperApi = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (EyeDropperApi) {
      try {
        const res = await new EyeDropperApi().open();
        const rgba = hexToRgba(res.sRGBHex, current[3]);
        if (rgba) {
          const before: RGBA = [...current];
          setFromRgba(rgba);
          opts.onChange?.([...current]);
          opts.onCommit?.([...current], before);
        }
      } catch {
        // User cancelled eyedropper
      }
    }
  });

  const swatchesEl = h('div', 'kt-cp-swatches');
  for (const sw of PRESET_SWATCHES) {
    const btn = h('button', 'kt-cp-swatch');
    btn.type = 'button';
    btn.style.background = rgbaToCss(sw);
    btn.title = rgbaToHex(sw);
    btn.addEventListener('click', () => {
      const before: RGBA = [...current];
      setFromRgba([sw[0], sw[1], sw[2], current[3]]);
      opts.onChange?.([...current]);
      opts.onCommit?.([...current], before);
    });
    swatchesEl.append(btn);
  }

  const drawSV = (): void => {
    const g = svCanvas.getContext('2d');
    if (!g) return;
    const w = svCanvas.width;
    const hgt = svCanvas.height;
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
    g.fillStyle = `rgb(${Math.round(hr * 255)}, ${Math.round(hg * 255)}, ${Math.round(hb * 255)})`;
    g.fillRect(0, 0, w, hgt);

    const whiteGrad = g.createLinearGradient(0, 0, w, 0);
    whiteGrad.addColorStop(0, 'rgba(255,255,255,1)');
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = whiteGrad;
    g.fillRect(0, 0, w, hgt);

    const blackGrad = g.createLinearGradient(0, 0, 0, hgt);
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
    blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = blackGrad;
    g.fillRect(0, 0, w, hgt);
  };

  const syncUI = (): void => {
    drawSV();
    svCursor.style.left = `${sat * 100}%`;
    svCursor.style.top = `${(1 - val) * 100}%`;
    hueThumb.style.left = `${(hue / 360) * 100}%`;
    alphaThumb.style.left = `${current[3] * 100}%`;
    const rgbCss = rgbaToCss([current[0], current[1], current[2], 1]);
    alphaFill.style.background = `linear-gradient(to right, rgba(0,0,0,0), ${rgbCss})`;
    previewNow.style.background = rgbaToCss(current);

    hexInput.value = rgbaToHex(current, false);
    rChan.input.value = String(Math.round(current[0] * 255));
    gChan.input.value = String(Math.round(current[1] * 255));
    bChan.input.value = String(Math.round(current[2] * 255));
    aChan.input.value = String(Math.round(current[3] * 100) / 100);
  };

  const setFromRgba = (next: RGBA): void => {
    current = [clamp(next[0], 0, 1), clamp(next[1], 0, 1), clamp(next[2], 0, 1), clamp(next[3], 0, 1)];
    const [nh, ns, nv] = rgbToHsv(current[0], current[1], current[2]);
    if (ns > 1e-4) hue = nh;
    if (nv > 1e-4) sat = ns;
    val = nv;
    syncUI();
  };

  const setFromHsv = (nh: number, ns: number, nv: number, na = current[3]): void => {
    hue = clamp(nh, 0, 360);
    sat = clamp(ns, 0, 1);
    val = clamp(nv, 0, 1);
    const [r, g, b] = hsvToRgb(hue, sat, val);
    current = [r, g, b, clamp(na, 0, 1)];
    syncUI();
  };

  // Drag interactions
  const bindDrag = (el: HTMLElement, onMove: (rx: number, ry: number) => void): void => {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      gestureStart = [...current];
      const step = (ev: PointerEvent): void => {
        const r = el.getBoundingClientRect();
        const rx = clamp((ev.clientX - r.left) / (r.width || 1), 0, 1);
        const ry = clamp((ev.clientY - r.top) / (r.height || 1), 0, 1);
        onMove(rx, ry);
        opts.onChange?.([...current]);
      };
      step(e);
      const up = (): void => {
        el.removeEventListener('pointermove', step);
        el.removeEventListener('pointerup', up);
        opts.onCommit?.([...current], gestureStart);
      };
      el.addEventListener('pointermove', step);
      el.addEventListener('pointerup', up);
    });
  };

  bindDrag(svWrap, (rx, ry) => setFromHsv(hue, rx, 1 - ry));
  bindDrag(hueBar, (rx) => setFromHsv(rx * 360, sat, val));
  bindDrag(alphaBar, (rx) => setFromHsv(hue, sat, val, rx));

  const root = h(
    'div',
    'kt-cp',
    svWrap,
    h('div', 'kt-cp-sliders', previewBox, h('div', 'kt-cp-bars', hueBar, alphaBar), eyeBtn),
    h('div', 'kt-cp-fields', hexInput, rChan.wrap, gChan.wrap, bChan.wrap, aChan.wrap),
    swatchesEl,
  );

  host.append(root);
  syncUI();

  return {
    element: root,
    getValue: () => [...current],
    setValue: (color, silent = true) => {
      setFromRgba(color);
      if (!silent) opts.onChange?.([...current]);
    },
    dispose: () => {
      root.remove();
    },
  };
}

let activePopupDispose: (() => void) | null = null;

export function closeColorPickerPopup(): void {
  activePopupDispose?.();
}

export function openColorPickerPopup(
  anchor: HTMLElement | { x: number; y: number },
  opts: ColorPickerOptions,
): { close(): void } {
  closeColorPickerPopup();
  const pop = h('div', 'kt-cp-popup');
  pop.addEventListener('contextmenu', (e) => e.preventDefault());
  const picker = mountColorPicker(pop, opts);
  document.body.append(pop);

  const r = pop.getBoundingClientRect();
  let x: number;
  let y: number;
  if (anchor instanceof HTMLElement) {
    const ar = anchor.getBoundingClientRect();
    x = ar.left;
    y = ar.bottom + 4;
  } else {
    x = anchor.x;
    y = anchor.y;
  }
  if (x + r.width > window.innerWidth - 8) x = window.innerWidth - r.width - 8;
  if (y + r.height > window.innerHeight - 8) y = Math.max(8, y - r.height - 28);
  pop.style.left = `${Math.max(8, x)}px`;
  pop.style.top = `${Math.max(8, y)}px`;

  const onDown = (e: PointerEvent): void => {
    const t = e.target as Node;
    if (pop.contains(t)) return;
    if (anchor instanceof HTMLElement && anchor.contains(t)) return;
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = (): void => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    picker.dispose();
    pop.remove();
    if (activePopupDispose === close) activePopupDispose = null;
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  activePopupDispose = close;
  return { close };
}
