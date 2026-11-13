import {
  addRampStop,
  cloneRamp,
  copyRampClipboard,
  defaultRamp,
  distributeRampStops,
  evaluateRamp,
  flipRamp,
  getRampPreset,
  moveRampStop,
  pasteRampClipboard,
  RAMP_PRESETS,
  rampToLUT,
  removeRampStop,
  setRampInterpolation,
  setRampStopAlpha,
  setRampStopColor,
  type Ramp,
  type RampInterpolation,
  type RampPresetId,
} from '@/core/curve';
import { clamp } from '@/core/math';
import { openColorPickerPopup, rgbaToCss } from '../colorPicker';
import { h, iconButton } from '../dom';
import { showMenu, type MenuItem } from '../menu';
import { createSelect } from '../select';
import { icon } from '../../icons/icons';

/**
 * Ramp / Gradient Editor component (`mountRampEditor`).
 * Provides a HiDPI gradient bar with draggable color stops (bottom) and alpha stops (top),
 * click-to-add, drag-off or Delete to remove, interpolation modes (Linear, Step, Smooth),
 * shared ColorPicker popup, numeric Position & Alpha scrub inputs, presets, and flip.
 */

export interface RampEditorOptions {
  ramp?: Ramp;
  /** Compact mode renders only the interactive gradient bar + stop handles without the bottom control row. */
  compact?: boolean;
  onChange?: (ramp: Ramp) => void;
  onCommit?: (ramp: Ramp, previous: Ramp) => void;
}

export interface RampEditorInstance {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  getRamp(): Ramp;
  setRamp(ramp: Ramp, silent?: boolean): void;
  getSelectedIndex(): number;
  setSelectedIndex(index: number): void;
  redraw(): void;
  dispose(): void;
}

const PAD_X = 10;
const TOP_RAIL_H = 11;
const BAR_H = 22;
const BOT_RAIL_H = 13;
const TOTAL_CANVAS_H = TOP_RAIL_H + BAR_H + BOT_RAIL_H;

export function mountRampEditor(host: HTMLElement, opts: RampEditorOptions = {}): RampEditorInstance {
  let current: Ramp = opts.ramp ? cloneRamp(opts.ramp) : defaultRamp();
  let selectedIdx = 0;
  let hoveredIdx = -1;
  let hoveredRail: 'alpha' | 'color' | null = null;

  const canvas = h('canvas', 'kt-ramp-canvas');
  canvas.tabIndex = 0;
  canvas.style.height = `${TOTAL_CANVAS_H}px`;
  const barWrap = h('div', 'kt-ramp-bar-wrap', canvas);

  // Controls row
  const interpLabel = (m: RampInterpolation): string =>
    m === 'step' ? 'Constant' : m === 'smooth' ? 'Smooth' : 'Linear';

  const interpSelect = createSelect({
    options: ['Linear', 'Constant', 'Smooth'],
    value: interpLabel(current.interpolation),
    width: 84,
    onChange: (label) => {
      const mode: RampInterpolation = label === 'Constant' ? 'step' : label === 'Smooth' ? 'smooth' : 'linear';
      applyEdit(setRampInterpolation(current, mode), true);
    },
  });

  const colorSwatchFill = h('span', 'kt-ramp-swatch-fill');
  const colorSwatchBtn = h('button', 'kt-ramp-swatch checker', colorSwatchFill);
  colorSwatchBtn.type = 'button';
  colorSwatchBtn.title = 'Click to pick stop color';

  const posInput = h('input', 'kt-num kt-ramp-num');
  posInput.type = 'text';
  posInput.title = 'Stop position (0..1)';

  const alphaInput = h('input', 'kt-num kt-ramp-num');
  alphaInput.type = 'text';
  alphaInput.title = 'Stop alpha (0..1)';

  const presetBtn = h('button', 'kt-gen-btn has-menu kt-ramp-preset-btn', icon('ramp', 15), h('span', '', 'Preset'));
  presetBtn.type = 'button';

  const flipBtn = iconButton(icon('flipH', 15), 'Flip ramp stops', () => {
    applyEdit(flipRamp(current), true);
  });

  const deleteBtn = iconButton(icon('minus', 14), 'Delete selected stop', () => {
    if (current.stops.length > 2) {
      const next = removeRampStop(current, selectedIdx);
      selectedIdx = clamp(selectedIdx, 0, next.stops.length - 1);
      applyEdit(next, true);
    }
  });

  const openStopColorPicker = (anchor: HTMLElement | { x: number; y: number }): void => {
    const stop = current.stops[selectedIdx];
    if (!stop) return;
    const before = cloneRamp(current);
    openColorPickerPopup(anchor, {
      value: [...stop.color],
      showAlpha: true,
      onChange: (rgba) => {
        current = setRampStopColor(current, selectedIdx, rgba);
        syncControls();
        redraw();
        opts.onChange?.(cloneRamp(current));
      },
      onCommit: (rgba) => {
        current = setRampStopColor(current, selectedIdx, rgba);
        syncControls();
        redraw();
        opts.onCommit?.(cloneRamp(current), before);
      },
    });
  };

  colorSwatchBtn.addEventListener('click', () => openStopColorPicker(colorSwatchBtn));

  posInput.addEventListener('keydown', (e) => e.stopPropagation());
  posInput.addEventListener('change', () => {
    const v = parseFloat(posInput.value);
    if (Number.isFinite(v)) {
      const res = moveRampStop(current, selectedIdx, clamp(v, 0, 1));
      selectedIdx = res.index;
      applyEdit(res.ramp, true);
    } else {
      syncControls();
    }
  });

  alphaInput.addEventListener('keydown', (e) => e.stopPropagation());
  alphaInput.addEventListener('change', () => {
    const v = parseFloat(alphaInput.value);
    if (Number.isFinite(v)) {
      applyEdit(setRampStopAlpha(current, selectedIdx, clamp(v, 0, 1)), true);
    } else {
      syncControls();
    }
  });

  presetBtn.addEventListener('click', () => {
    showMenu(
      RAMP_PRESETS.map((p) => ({
        label: p.label,
        run: () => {
          selectedIdx = 0;
          applyEdit(getRampPreset(p.id as RampPresetId), true);
        },
      })),
      presetBtn,
    );
  });

  const controlsRow = h(
    'div',
    'kt-ramp-controls',
    colorSwatchBtn,
    h('label', 'kt-ramp-field', h('span', '', 'Pos'), posInput),
    h('label', 'kt-ramp-field', h('span', '', 'A'), alphaInput),
    interpSelect,
    presetBtn,
    flipBtn,
    deleteBtn,
  );
  if (opts.compact) controlsRow.hidden = true;

  const root = h('div', 'kt-ramp-editor', barWrap, controlsRow);

  const syncControls = (): void => {
    selectedIdx = clamp(selectedIdx, 0, Math.max(0, current.stops.length - 1));
    const stop = current.stops[selectedIdx];
    if (stop) {
      colorSwatchFill.style.background = rgbaToCss(stop.color);
      posInput.value = String(Math.round(stop.t * 1000) / 1000);
      alphaInput.value = String(Math.round(stop.color[3] * 1000) / 1000);
    }
    const selLbl = interpSelect.querySelector('.kt-select-label');
    if (selLbl) selLbl.textContent = interpLabel(current.interpolation);
  };

  const applyEdit = (next: Ramp, commit: boolean): void => {
    const prev = cloneRamp(current);
    current = cloneRamp(next);
    syncControls();
    redraw();
    opts.onChange?.(cloneRamp(current));
    if (commit) {
      opts.onCommit?.(cloneRamp(current), prev);
    }
  };

  // ---- HiDPI Canvas Drawing ----

  const redraw = (): void => {
    const r = canvas.getBoundingClientRect();
    const cssW = Math.max(120, r.width || canvas.clientWidth || 300);
    const cssH = TOTAL_CANVAS_H;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const targetW = Math.round(cssW * dpr);
    const targetH = Math.round(cssH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const g = canvas.getContext('2d');
    if (!g) return;
    g.save();
    g.scale(dpr, dpr);

    const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    const col = (name: string, fallback: string): string => style?.getPropertyValue(name).trim() || fallback;

    g.clearRect(0, 0, cssW, cssH);

    const barLeft = PAD_X;
    const barWidth = Math.max(20, cssW - PAD_X * 2);
    const barTop = TOP_RAIL_H;

    // 1. Checkerboard inside gradient bar
    const chkA = col('--kt-bg-checker-a', '#4a4a4a');
    const chkB = col('--kt-bg-checker-b', '#3a3a3a');
    const cell = 6;
    for (let y = 0; y < BAR_H; y += cell) {
      for (let x = 0; x < barWidth; x += cell) {
        const even = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0;
        g.fillStyle = even ? chkA : chkB;
        g.fillRect(barLeft + x, barTop + y, Math.min(cell, barWidth - x), Math.min(cell, BAR_H - y));
      }
    }

    // 2. Gradient LUT scanlines
    const lutSamples = Math.max(64, Math.round(barWidth));
    const lut = rampToLUT(current, lutSamples);
    for (let x = 0; x < barWidth; x++) {
      const idx = Math.min(lutSamples - 1, Math.floor((x / Math.max(1, barWidth - 1)) * (lutSamples - 1))) * 4;
      const cr = lut[idx] ?? 0;
      const cg = lut[idx + 1] ?? 0;
      const cb = lut[idx + 2] ?? 0;
      const ca = (lut[idx + 3] ?? 255) / 255;

      // Top/main portion shows RGBA with alpha
      g.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${ca.toFixed(3)})`;
      g.fillRect(barLeft + x, barTop, 1.5, BAR_H - 3);

      // Bottom 3px strip shows solid RGB
      g.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
      g.fillRect(barLeft + x, barTop + BAR_H - 3, 1.5, 3);
    }

    // 3. Bar border
    g.strokeStyle = col('--kt-border-strong', '#141414');
    g.lineWidth = 1;
    g.strokeRect(barLeft + 0.5, barTop + 0.5, barWidth - 1, BAR_H - 1);

    // 4. Top Alpha Stops & Bottom Color Stops
    current.stops.forEach((stop, idx) => {
      const sx = barLeft + clamp(stop.t, 0, 1) * barWidth;
      const isSel = idx === selectedIdx;
      const isHov = idx === hoveredIdx;

      // Top alpha marker (pointing down to barTop)
      const alphaGray = Math.round(clamp(stop.color[3], 0, 1) * 255);
      g.fillStyle = `rgb(${alphaGray}, ${alphaGray}, ${alphaGray})`;
      g.strokeStyle = isSel
        ? col('--kt-select-ring', '#ecd531')
        : isHov && hoveredRail === 'alpha'
          ? col('--kt-text-strong', '#ffffff')
          : col('--kt-border-strong', '#141414');
      g.lineWidth = isSel ? 1.5 : 1;
      g.beginPath();
      g.moveTo(sx - 4.5, 1.5);
      g.lineTo(sx + 4.5, 1.5);
      g.lineTo(sx + 4.5, TOP_RAIL_H - 4);
      g.lineTo(sx, TOP_RAIL_H);
      g.lineTo(sx - 4.5, TOP_RAIL_H - 4);
      g.closePath();
      g.fill();
      g.stroke();

      // Bottom color marker (house shape pointing up to barTop + BAR_H)
      const by = barTop + BAR_H;
      const cr = Math.round(clamp(stop.color[0], 0, 1) * 255);
      const cg = Math.round(clamp(stop.color[1], 0, 1) * 255);
      const cb = Math.round(clamp(stop.color[2], 0, 1) * 255);
      g.fillStyle = `rgb(${cr}, ${cg}, ${cb})`;
      g.strokeStyle = isSel
        ? col('--kt-select-ring', '#ecd531')
        : isHov && hoveredRail === 'color'
          ? col('--kt-text-strong', '#ffffff')
          : col('--kt-border-strong', '#141414');
      g.lineWidth = isSel ? 1.6 : 1.1;
      g.beginPath();
      g.moveTo(sx, by);
      g.lineTo(sx + 5, by + 4.5);
      g.lineTo(sx + 5, by + BOT_RAIL_H - 1.5);
      g.lineTo(sx - 5, by + BOT_RAIL_H - 1.5);
      g.lineTo(sx - 5, by + 4.5);
      g.closePath();
      g.fill();
      g.stroke();
    });

    g.restore();
  };

  const toT = (px: number, cssW: number): number => {
    const barWidth = Math.max(20, cssW - PAD_X * 2);
    return clamp((px - PAD_X) / barWidth, 0, 1);
  };

  const hitTestStop = (px: number, py: number, cssW: number): { index: number; rail: 'alpha' | 'color' } | null => {
    const barWidth = Math.max(20, cssW - PAD_X * 2);
    const rail: 'alpha' | 'color' = py < TOP_RAIL_H + BAR_H * 0.4 ? 'alpha' : 'color';
    let bestIdx = -1;
    let bestDist = 8;
    current.stops.forEach((s, idx) => {
      const sx = PAD_X + s.t * barWidth;
      const d = Math.abs(px - sx);
      if (d <= bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    });
    return bestIdx >= 0 ? { index: bestIdx, rail } : null;
  };

  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons !== 0) return;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const hit = hitTestStop(px, py, r.width || 300);
    hoveredIdx = hit ? hit.index : -1;
    hoveredRail = hit ? hit.rail : null;
    canvas.style.cursor = hit ? 'ew-resize' : 'copy';
    redraw();
  });

  canvas.addEventListener('pointerleave', () => {
    hoveredIdx = -1;
    hoveredRail = null;
    redraw();
  });

  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const hit = hitTestStop(px, py, r.width || 300);
    if (hit) {
      selectedIdx = hit.index;
      syncControls();
      redraw();
      openStopColorPicker({ x: e.clientX, y: e.clientY });
    }
  });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.focus();
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const r = canvas.getBoundingClientRect();
    const cssW = r.width || 300;
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;

    const before = cloneRamp(current);
    const hit = hitTestStop(px, py, cssW);

    if (!hit) {
      const t = toT(px, cssW);
      const added = addRampStop(current, t, evaluateRamp(current, t));
      current = added.ramp;
      selectedIdx = added.index;
      syncControls();
      redraw();
      opts.onChange?.(cloneRamp(current));
    } else {
      selectedIdx = hit.index;
      syncControls();
      redraw();
    }

    let didChange = !hit;
    const move = (ev: PointerEvent): void => {
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      didChange = true;

      // Drag vertically off the bar (> 32px) to remove stop if > 2 stops
      if ((my < -28 || my > TOTAL_CANVAS_H + 28) && before.stops.length > 2) {
        if (current.stops.length === before.stops.length) {
          current = removeRampStop(before, selectedIdx);
          selectedIdx = clamp(selectedIdx, 0, current.stops.length - 1);
          syncControls();
          redraw();
          opts.onChange?.(cloneRamp(current));
        }
        return;
      }

      let t = toT(mx, cssW);
      if (ev.ctrlKey || ev.metaKey) {
        t = Math.round(t * 20) / 20;
      }
      const moved = moveRampStop(current, selectedIdx, t);
      current = moved.ramp;
      selectedIdx = moved.index;
      syncControls();
      redraw();
      opts.onChange?.(cloneRamp(current));
    };

    const up = (): void => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      if (didChange) {
        opts.onCommit?.(cloneRamp(current), before);
      }
    };

    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const cssW = r.width || 300;
    const hit = hitTestStop(px, py, cssW);
    if (hit) {
      selectedIdx = hit.index;
      syncControls();
      redraw();
    }
    const clickT = toT(px, cssW);

    const menuItems: MenuItem[] = [
      {
        label: 'Add Stop Here',
        run: () => {
          const added = addRampStop(current, clickT);
          selectedIdx = added.index;
          applyEdit(added.ramp, true);
        },
      },
      {
        label: 'Pick Stop Color…',
        run: () => openStopColorPicker({ x: e.clientX, y: e.clientY }),
      },
      {
        label: 'Delete Selected Stop',
        shortcut: 'Del',
        disabled: current.stops.length <= 2,
        run: () => {
          const next = removeRampStop(current, selectedIdx);
          selectedIdx = clamp(selectedIdx, 0, next.stops.length - 1);
          applyEdit(next, true);
        },
      },
      { separator: true },
      {
        label: 'Interpolation',
        submenu: (['linear', 'step', 'smooth'] as RampInterpolation[]).map((m) => ({
          label: interpLabel(m),
          checked: current.interpolation === m,
          run: () => applyEdit(setRampInterpolation(current, m), true),
        })),
      },
      {
        label: 'Presets',
        submenu: RAMP_PRESETS.map((p) => ({
          label: p.label,
          run: () => {
            selectedIdx = 0;
            applyEdit(getRampPreset(p.id as RampPresetId), true);
          },
        })),
      },
      { separator: true },
      {
        label: 'Flip Ramp',
        run: () => applyEdit(flipRamp(current), true),
      },
      {
        label: 'Distribute Stops Evenly',
        run: () => applyEdit(distributeRampStops(current), true),
      },
      { separator: true },
      {
        label: 'Copy Ramp',
        run: () => {
          void copyRampClipboard(current);
        },
      },
      {
        label: 'Paste Ramp',
        run: () => {
          void pasteRampClipboard().then((pasted) => {
            if (pasted) {
              selectedIdx = 0;
              applyEdit(pasted, true);
            }
          });
        },
      },
      {
        label: 'Reset Ramp',
        run: () => {
          selectedIdx = 0;
          applyEdit(defaultRamp(), true);
        },
      },
    ];
    showMenu(menuItems, { x: e.clientX, y: e.clientY });
  });

  canvas.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && current.stops.length > 2) {
      e.preventDefault();
      e.stopPropagation();
      const next = removeRampStop(current, selectedIdx);
      selectedIdx = clamp(selectedIdx, 0, next.stops.length - 1);
      applyEdit(next, true);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      const stop = current.stops[selectedIdx];
      if (!stop) return;
      const step = (e.shiftKey ? 0.05 : 0.01) * (e.key === 'ArrowRight' ? 1 : -1);
      const res = moveRampStop(current, selectedIdx, stop.t + step);
      selectedIdx = res.index;
      applyEdit(res.ramp, true);
    }
  });

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => redraw()) : null;
  ro?.observe(barWrap);

  host.append(root);
  syncControls();
  redraw();

  return {
    element: root,
    canvas,
    getRamp: () => cloneRamp(current),
    setRamp: (r, silent = true) => {
      current = cloneRamp(r);
      selectedIdx = clamp(selectedIdx, 0, Math.max(0, current.stops.length - 1));
      syncControls();
      redraw();
      if (!silent) opts.onChange?.(cloneRamp(current));
    },
    getSelectedIndex: () => selectedIdx,
    setSelectedIndex: (i) => {
      selectedIdx = clamp(i, 0, Math.max(0, current.stops.length - 1));
      syncControls();
      redraw();
    },
    redraw,
    dispose: () => {
      ro?.disconnect();
      root.remove();
    },
  };
}
