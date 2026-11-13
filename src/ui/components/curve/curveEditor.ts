import {
  addCurvePoint,
  applyCurvePreset,
  cloneCurve,
  copyCurveClipboard,
  CURVE_PRESETS,
  detectCurvePreset,
  evaluateCurve,
  fitCurveFromStroke,
  flatCurve,
  flipCurveHorizontal,
  flipCurveVertical,
  mirrorCurve,
  moveCurvePoint,
  moveCurvePointsByDelta,
  pasteCurveClipboard,
  removeCurvePoints,
  reverseCurve,
  scaleOffsetCurvePoints,
  setPointsTangentMode,
  setPointTangent,
  simplifyCurve,
  smoothCurvePoints,
  switchCurveLevel,
  type Curve,
  type CurvePresetId,
  type CurveValueMode,
  type TangentMode,
  type WrapMode,
} from '@/core/curve';
import { clamp } from '@/core/math';
import { h, iconButton } from '../dom';
import { showMenu, type MenuItem } from '../menu';
import { createSelect } from '../select';
import { icon } from '../../icons/icons';

/**
 * Full interactive Curve Editor component (`mountCurveEditor`).
 * Toolbar, colors, point/tangent handles, freehand Draw tool, and interactions.
 */

export interface CurveEditorOptions {
  curve?: Curve;
  /** Optional ghost/reference curve drawn behind the primary curve. */
  ghostCurve?: Curve | null;
  /** Optional variance spread (0..1) drawn as a shaded min/max band around the curve. */
  variance?: number;
  /** Optional parent-level dropdown labels (e.g. ['1 - Big branches', '2 - Little branches']). */
  levels?: string[];
  /** Active level label or 1-based index. */
  activeLevel?: string;
  /** Multiplier used when displaying Y in Relative/Absolute field if base value != 1. */
  valueScale?: number;
  /** Initial selected point index (defaults to last or first point). */
  initialSelectedIndex?: number;
  /** Show the secondary tangent/details bar below the main toolbar. */
  showTangentBar?: boolean;
  /** Render in profile color (cyan-blue) instead of parent color (green). */
  variant?: 'parent' | 'profile';
  /** Show axis ruler numbers along the grid margin. */
  showRulers?: boolean;
  /** Fired continuously during drag/scrub gestures for live 60fps viewport updates. */
  onChange?: (curve: Curve) => void;
  /** Fired once when a drag/edit gesture completes (used to seal undo command). */
  onCommit?: (curve: Curve, previous: Curve) => void;
}

export interface CurveEditorInstance {
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  getCurve(): Curve;
  setCurve(curve: Curve, silent?: boolean): void;
  getSelectedIndices(): number[];
  setSelectedIndices(indices: number[]): void;
  setGhostCurve(ghost: Curve | null): void;
  setVariance(variance: number | undefined): void;
  fitView(): void;
  resetView(): void;
  redraw(): void;
  dispose(): void;
}

interface ViewWindow {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

interface TangentHit {
  pointIndex: number;
  side: 'in' | 'out';
}

const PAD_LEFT = 18;
const PAD_RIGHT = 18;
const PAD_TOP = 14;
const PAD_BOTTOM = 22;
const POINT_RADIUS = 5;
const HANDLE_RADIUS = 4;

function formatNum(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '0';
  const rounded = Number(v.toFixed(digits));
  return String(rounded);
}

function niceGridStep(span: number, targetLines = 10): number {
  if (span <= 0) return 0.1;
  const raw = span / Math.max(2, targetLines);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const residual = raw / mag;
  if (residual > 5) return 10 * mag;
  if (residual > 2) return 5 * mag;
  if (residual > 1) return 2 * mag;
  return mag;
}

export function mountCurveEditor(host: HTMLElement, opts: CurveEditorOptions = {}): CurveEditorInstance {
  let current: Curve = opts.curve ? cloneCurve(opts.curve) : flatCurve(1);
  let ghostCurve: Curve | null = opts.ghostCurve ? cloneCurve(opts.ghostCurve) : null;
  let variance = opts.variance ?? 0;
  let showRulers = opts.showRulers ?? false;
  let showTangentBar = opts.showTangentBar ?? false;
  let drawMode = false;
  let spaceDown = false;
  const valueScale = opts.valueScale ?? 1;

  // Default selected point: last point or specified index
  const defaultIdx =
    opts.initialSelectedIndex !== undefined
      ? clamp(opts.initialSelectedIndex, 0, Math.max(0, current.points.length - 1))
      : Math.max(0, current.points.length - 1);
  let selected = new Set<number>([defaultIdx]);
  let hoveredPoint = -1;
  let hoveredTangent: TangentHit | null = null;
  let cursorCoord: { x: number; y: number; curveY: number } | null = null;
  let marqueeRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  let drawStroke: { x: number; y: number }[] | null = null;

  let view: ViewWindow = {
    xMin: current.xRange[0],
    xMax: current.xRange[1],
    yMin: current.yRange[0],
    yMax: current.yRange[1],
  };

  // ---- Toolbar construction ----

  const levelOptions = opts.levels ?? ['1 - Big branches', '2 - Little branches', '3 - Twigs', '4 - Level 4', '5 - Level 5'];
  const initialLevelLabel =
    opts.activeLevel ??
    levelOptions[clamp((current.level ?? 1) - 1, 0, levelOptions.length - 1)] ??
    '1 - Big branc';

  const listBtn = h('button', 'kt-icon-btn kt-curve-list-btn', icon('curveList', 18));
  listBtn.type = 'button';
  listBtn.title = 'Curve actions & options';

  const levelSelect = createSelect({
    options: levelOptions,
    value: initialLevelLabel,
    width: 112,
    onChange: (label) => {
      const match = /^(\d+)/.exec(label.trim());
      const lvl = match ? parseInt(match[1] ?? '1', 10) : 1;
      applyEdit(switchCurveLevel(current, lvl), true);
    },
  });

  const presetBtn = h('button', 'kt-gen-btn has-menu kt-curve-preset-btn', icon('curve', 16), h('span', '', 'Preset'));
  presetBtn.type = 'button';
  presetBtn.title = 'Curve presets';

  const drawBtn = h('button', 'kt-gen-btn kt-curve-draw-btn', icon('draw', 16), h('span', '', 'Draw'));
  drawBtn.type = 'button';
  drawBtn.title = 'Freehand draw curve on canvas';

  const modeSelect = createSelect({
    options: ['Relative', 'Absolute'],
    value: current.valueMode === 'absolute' ? 'Absolute' : 'Relative',
    width: 86,
    onChange: (val) => {
      const valueMode: CurveValueMode = val === 'Absolute' ? 'absolute' : 'relative';
      applyEdit({ ...current, valueMode }, true);
    },
  });

  const makeScrubField = (
    labelText: string,
    onDelta: (delta: number, finished: boolean) => void,
    onCommitText: (val: number) => void,
  ): { wrap: HTMLElement; input: HTMLInputElement } => {
    const lbl = h('span', 'kt-curve-num-lbl', labelText);
    const input = h('input', 'kt-num');
    input.type = 'text';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        input.blur();
      }
    });
    input.addEventListener('change', () => {
      if (input.readOnly) return;
      const v = parseFloat(input.value);
      if (Number.isFinite(v)) {
        onCommitText(v);
      } else {
        syncToolbarFields();
      }
    });

    // Horizontal scrub on label
    lbl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || input.readOnly) return;
      e.preventDefault();
      lbl.setPointerCapture(e.pointerId);
      let lastX = e.clientX;
      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - lastX;
        lastX = ev.clientX;
        const step = ev.shiftKey ? 0.05 : ev.altKey ? 0.001 : 0.005;
        onDelta(dx * step, false);
      };
      const up = (): void => {
        lbl.removeEventListener('pointermove', move);
        lbl.removeEventListener('pointerup', up);
        onDelta(0, true);
      };
      lbl.addEventListener('pointermove', move);
      lbl.addEventListener('pointerup', up);
    });

    const wrap = h('div', 'kt-curve-num', lbl, input);
    return { wrap, input };
  };

  let scrubStartCurve: Curve | null = null;

  const primarySelectedIndex = (): number => {
    if (selected.size === 0) return -1;
    const first = selected.values().next().value;
    return first !== undefined && first >= 0 && first < current.points.length ? first : -1;
  };

  const displayScaleY = (): number => {
    return current.valueMode === 'absolute' ? 1 : valueScale;
  };

  const xField = makeScrubField(
    'X',
    (delta, finished) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      if (!scrubStartCurve) scrubStartCurve = cloneCurve(current);
      const pt = current.points[idx];
      if (!pt) return;
      if (delta !== 0) {
        current = moveCurvePoint(current, idx, pt.x + delta * (current.xRange[1] - current.xRange[0]), pt.y, {
          clampXToRange: true,
        });
        syncToolbarFields();
        redraw();
        opts.onChange?.(cloneCurve(current));
      }
      if (finished && scrubStartCurve) {
        const prev = scrubStartCurve;
        scrubStartCurve = null;
        opts.onCommit?.(cloneCurve(current), prev);
      }
    },
    (val) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      const pt = current.points[idx];
      if (!pt) return;
      applyEdit(moveCurvePoint(current, idx, val, pt.y, { clampXToRange: true }), true);
    },
  );

  const yField = makeScrubField(
    'Y',
    (delta, finished) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      if (!scrubStartCurve) scrubStartCurve = cloneCurve(current);
      const pt = current.points[idx];
      if (!pt) return;
      if (delta !== 0) {
        const nextY = pt.y + delta * (current.yRange[1] - current.yRange[0]);
        current = moveCurvePoint(current, idx, pt.x, nextY);
        syncToolbarFields();
        redraw();
        opts.onChange?.(cloneCurve(current));
      }
      if (finished && scrubStartCurve) {
        const prev = scrubStartCurve;
        scrubStartCurve = null;
        opts.onCommit?.(cloneCurve(current), prev);
      }
    },
    (val) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      const pt = current.points[idx];
      if (!pt) return;
      const scale = displayScaleY() || 1;
      applyEdit(moveCurvePoint(current, idx, pt.x, val / scale), true);
    },
  );

  // Secondary tangent & detail bar (can be shown via options.showTangentBar or context menu)
  const inSlopeField = makeScrubField(
    'In',
    (delta, finished) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      if (!scrubStartCurve) scrubStartCurve = cloneCurve(current);
      const pt = current.points[idx];
      if (!pt) return;
      if (delta !== 0) {
        current = setPointTangent(current, idx, 'in', pt.inTangent.dx, pt.inTangent.dy + delta * 0.2);
        syncToolbarFields();
        redraw();
        opts.onChange?.(cloneCurve(current));
      }
      if (finished && scrubStartCurve) {
        const prev = scrubStartCurve;
        scrubStartCurve = null;
        opts.onCommit?.(cloneCurve(current), prev);
      }
    },
    (slopeVal) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      const pt = current.points[idx];
      if (!pt) return;
      const dx = pt.inTangent.dx || -0.1;
      applyEdit(setPointTangent(current, idx, 'in', dx, slopeVal * dx), true);
    },
  );

  const outSlopeField = makeScrubField(
    'Out',
    (delta, finished) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      if (!scrubStartCurve) scrubStartCurve = cloneCurve(current);
      const pt = current.points[idx];
      if (!pt) return;
      if (delta !== 0) {
        current = setPointTangent(current, idx, 'out', pt.outTangent.dx, pt.outTangent.dy + delta * 0.2);
        syncToolbarFields();
        redraw();
        opts.onChange?.(cloneCurve(current));
      }
      if (finished && scrubStartCurve) {
        const prev = scrubStartCurve;
        scrubStartCurve = null;
        opts.onCommit?.(cloneCurve(current), prev);
      }
    },
    (slopeVal) => {
      const idx = primarySelectedIndex();
      if (idx < 0) return;
      const pt = current.points[idx];
      if (!pt) return;
      const dx = pt.outTangent.dx || 0.1;
      applyEdit(setPointTangent(current, idx, 'out', dx, slopeVal * dx), true);
    },
  );

  const tangentButtons: { mode: TangentMode; btn: HTMLButtonElement }[] = [];
  const tangentModesList: { mode: TangentMode; iconName: string; title: string }[] = [
    { mode: 'auto', iconName: 'tangentAuto', title: 'Auto / Smooth tangents (1)' },
    { mode: 'linear', iconName: 'tangentLinear', title: 'Linear tangents (2)' },
    { mode: 'stepped', iconName: 'tangentStep', title: 'Constant / Step (3)' },
    { mode: 'flat', iconName: 'tangentFlat', title: 'Flat / Zero slope (4)' },
    { mode: 'aligned', iconName: 'tangentAligned', title: 'Aligned tangents (5)' },
    { mode: 'mirrored', iconName: 'tangentMirrored', title: 'Mirrored tangents (6)' },
    { mode: 'free', iconName: 'tangentFree', title: 'Free / Broken tangents (7)' },
  ];

  const tangentBar = h('div', 'kt-curve-subbar');
  for (const tm of tangentModesList) {
    const b = iconButton(icon(tm.iconName, 15), tm.title, () => {
      const targets = selected.size > 0 ? selected : new Set(current.points.map((_, i) => i));
      applyEdit(setPointsTangentMode(current, targets, tm.mode), true);
    });
    tangentButtons.push({ mode: tm.mode, btn: b });
    tangentBar.append(b);
  }
  tangentBar.append(
    h('div', 'kt-tb-sep'),
    iconButton(icon('flipH', 15), 'Flip Horizontal', () => applyEdit(flipCurveHorizontal(current), true)),
    iconButton(icon('flipV', 15), 'Flip Vertical', () => applyEdit(flipCurveVertical(current), true)),
    iconButton(icon('fitView', 15), 'Fit View (F)', () => fitView()),
    iconButton(icon('reset', 15), 'Reset Curve', () => applyEdit(flatCurve(1, current.xRange, current.yRange), true)),
    h('div', 'kt-spacer'),
    inSlopeField.wrap,
    outSlopeField.wrap,
  );
  tangentBar.hidden = !showTangentBar;

  const toolbar = h(
    'div',
    'kt-curve-toolbar',
    listBtn,
    levelSelect,
    presetBtn,
    drawBtn,
    modeSelect,
    xField.wrap,
    yField.wrap,
  );

  const canvas = h('canvas', 'kt-curve-canvas');
  canvas.tabIndex = 0;
  const area = h('div', 'kt-curve-area', canvas);
  const root = h('div', 'kt-curve-editor', toolbar, tangentBar, area);

  // ---- Coordinate conversions ----

  const getPlotRect = (cssW: number, cssH: number): { left: number; top: number; width: number; height: number } => {
    const left = showRulers ? PAD_LEFT + 14 : PAD_LEFT;
    const right = PAD_RIGHT;
    const top = PAD_TOP;
    const bottom = PAD_BOTTOM;
    return {
      left,
      top,
      width: Math.max(20, cssW - left - right),
      height: Math.max(20, cssH - top - bottom),
    };
  };

  const toScreenX = (x: number, plot: { left: number; width: number }): number => {
    const span = view.xMax - view.xMin || 1;
    return plot.left + ((x - view.xMin) / span) * plot.width;
  };

  const toScreenY = (y: number, plot: { top: number; height: number }): number => {
    const span = view.yMax - view.yMin || 1;
    return plot.top + (1 - (y - view.yMin) / span) * plot.height;
  };

  const toCurveX = (px: number, plot: { left: number; width: number }): number => {
    const span = view.xMax - view.xMin || 1;
    return view.xMin + ((px - plot.left) / plot.width) * span;
  };

  const toCurveY = (py: number, plot: { top: number; height: number }): number => {
    const span = view.yMax - view.yMin || 1;
    return view.yMin + (1 - (py - plot.top) / plot.height) * span;
  };

  // ---- Sync UI ----

  const syncToolbarFields = (): void => {
    const idx = primarySelectedIndex();
    const pt = idx >= 0 ? current.points[idx] : undefined;
    const fixed = current.fixedEndpoints !== false;
    const isLockedEndpoint = pt !== undefined && fixed && (idx === 0 || idx === current.points.length - 1);

    if (pt) {
      xField.input.value = formatNum(pt.x, 3);
      xField.input.readOnly = isLockedEndpoint;
      xField.input.classList.toggle('dim', isLockedEndpoint);

      const scale = displayScaleY() || 1;
      yField.input.value = formatNum(pt.y * scale, 3);
      yField.input.readOnly = false;
      yField.input.classList.remove('dim');

      const inSlope = Math.abs(pt.inTangent.dx) > 1e-6 ? pt.inTangent.dy / pt.inTangent.dx : 0;
      const outSlope = Math.abs(pt.outTangent.dx) > 1e-6 ? pt.outTangent.dy / pt.outTangent.dx : 0;
      inSlopeField.input.value = formatNum(inSlope, 2);
      outSlopeField.input.value = formatNum(outSlope, 2);
    } else {
      xField.input.value = '-';
      xField.input.readOnly = true;
      xField.input.classList.add('dim');
      yField.input.value = '-';
      yField.input.readOnly = true;
      yField.input.classList.add('dim');
      inSlopeField.input.value = '0';
      outSlopeField.input.value = '0';
    }

    for (const tb of tangentButtons) {
      const isMatch =
        pt !== undefined &&
        (pt.mode === tb.mode ||
          (tb.mode === 'auto' && pt.mode === 'smooth') ||
          (tb.mode === 'stepped' && pt.mode === 'constant'));
      tb.btn.classList.toggle('active', isMatch);
    }
    drawBtn.classList.toggle('active', drawMode);
  };

  const applyEdit = (next: Curve, commit: boolean): void => {
    const prev = cloneCurve(current);
    current = cloneCurve(next);
    // Keep selection valid
    const validSel = new Set<number>();
    for (const s of selected) {
      if (s >= 0 && s < current.points.length) validSel.add(s);
    }
    if (validSel.size === 0 && current.points.length > 0) {
      validSel.add(current.points.length - 1);
    }
    selected = validSel;
    syncToolbarFields();
    redraw();
    opts.onChange?.(cloneCurve(current));
    if (commit) {
      opts.onCommit?.(cloneCurve(current), prev);
    }
  };

  // ---- View navigation ----

  const resetView = (): void => {
    view = {
      xMin: current.xRange[0],
      xMax: current.xRange[1],
      yMin: current.yRange[0],
      yMax: current.yRange[1],
    };
    redraw();
  };

  const fitView = (): void => {
    if (current.points.length === 0) {
      resetView();
      return;
    }
    let minX = current.xRange[0];
    let maxX = current.xRange[1];
    let minY = current.yRange[0];
    let maxY = current.yRange[1];
    for (const p of current.points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const spanX = Math.max(1e-3, maxX - minX);
    const spanY = Math.max(1e-3, maxY - minY);
    view = {
      xMin: minX,
      xMax: minX + spanX,
      yMin: minY,
      yMax: minY + spanY,
    };
    redraw();
  };

  // ---- Canvas HiDPI Drawing ----

  const redraw = (): void => {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(100, rect.width || canvas.clientWidth || 560);
    const cssH = Math.max(80, rect.height || canvas.clientHeight || 260);
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

    const plot = getPlotRect(cssW, cssH);

    // 1. Outer margin fill
    g.fillStyle = col('--kt-curve-outer-bg', '#262626');
    g.fillRect(0, 0, cssW, cssH);

    // 2. Domain rectangle fill
    const domX0 = clamp(toScreenX(current.xRange[0], plot), plot.left, plot.left + plot.width);
    const domX1 = clamp(toScreenX(current.xRange[1], plot), plot.left, plot.left + plot.width);
    const domY0 = clamp(toScreenY(current.yRange[1], plot), plot.top, plot.top + plot.height);
    const domY1 = clamp(toScreenY(current.yRange[0], plot), plot.top, plot.top + plot.height);
    g.fillStyle = col('--kt-curve-domain-bg', '#353535');
    g.fillRect(plot.left, plot.top, plot.width, plot.height);

    // Highlight domain sub-rect if panned/zoomed outside domain
    if (domX1 > domX0 && domY1 > domY0) {
      g.fillStyle = col('--kt-curve-domain-bg', '#353535');
      g.fillRect(domX0, domY0, domX1 - domX0, domY1 - domY0);
    }

    // 3. Adaptive Grid Lines
    g.save();
    g.beginPath();
    g.rect(plot.left, plot.top, plot.width, plot.height);
    g.clip();

    const xSpan = view.xMax - view.xMin || 1;
    const ySpan = view.yMax - view.yMin || 1;
    const stepX = niceGridStep(xSpan, 10);
    const stepY = niceGridStep(ySpan, 8);

    g.strokeStyle = col('--kt-curve-grid-minor', '#2c2c2c');
    g.lineWidth = 1;

    const firstGridX = Math.ceil(view.xMin / stepX) * stepX;
    for (let gx = firstGridX; gx <= view.xMax + stepX * 0.01; gx += stepX) {
      const px = Math.round(toScreenX(gx, plot)) + 0.5;
      g.beginPath();
      g.moveTo(px, plot.top);
      g.lineTo(px, plot.top + plot.height);
      g.stroke();
    }

    const firstGridY = Math.ceil(view.yMin / stepY) * stepY;
    for (let gy = firstGridY; gy <= view.yMax + stepY * 0.01; gy += stepY) {
      const py = Math.round(toScreenY(gy, plot)) + 0.5;
      g.beginPath();
      g.moveTo(plot.left, py);
      g.lineTo(plot.left + plot.width, py);
      g.stroke();
    }

    // Origin / domain boundary lines
    g.strokeStyle = col('--kt-curve-grid-major', '#1f1f1f');
    g.lineWidth = 1;
    for (const bx of [0, current.xRange[0], current.xRange[1]]) {
      const px = Math.round(toScreenX(bx, plot)) + 0.5;
      g.beginPath();
      g.moveTo(px, plot.top);
      g.lineTo(px, plot.top + plot.height);
      g.stroke();
    }
    for (const by of [0, current.yRange[0], current.yRange[1]]) {
      const py = Math.round(toScreenY(by, plot)) + 0.5;
      g.beginPath();
      g.moveTo(plot.left, py);
      g.lineTo(plot.left + plot.width, py);
      g.stroke();
    }

    // Bottom horizontal range bar
    const barH = 6;
    const barY = plot.top + plot.height - barH - 2;
    g.fillStyle = col('--kt-curve-range-bar', '#474747');
    g.fillRect(plot.left + 2, barY, Math.max(0, plot.width - 4), barH);

    // 4. Optional Variance Band (min/max range around curve)
    if (variance > 1e-4) {
      const samples = Math.max(64, Math.round(plot.width / 2));
      const vSpan = (current.yRange[1] - current.yRange[0]) * variance;
      g.fillStyle = col('--kt-curve-variance-fill', '#a2d36b24');
      g.beginPath();
      for (let i = 0; i <= samples; i++) {
        const u = i / samples;
        const cx = view.xMin + u * xSpan;
        const cy = evaluateCurve(current, cx) + vSpan;
        const px = plot.left + u * plot.width;
        const py = toScreenY(cy, plot);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      for (let i = samples; i >= 0; i--) {
        const u = i / samples;
        const cx = view.xMin + u * xSpan;
        const cy = evaluateCurve(current, cx) - vSpan;
        const px = plot.left + u * plot.width;
        const py = toScreenY(cy, plot);
        g.lineTo(px, py);
      }
      g.closePath();
      g.fill();

      g.strokeStyle = col('--kt-curve-variance-stroke', '#a2d36b66');
      g.lineWidth = 1;
      g.setLineDash([3, 3]);
      for (const dir of [-1, 1]) {
        g.beginPath();
        for (let i = 0; i <= samples; i++) {
          const u = i / samples;
          const cx = view.xMin + u * xSpan;
          const cy = evaluateCurve(current, cx) + dir * vSpan;
          const px = plot.left + u * plot.width;
          const py = toScreenY(cy, plot);
          if (i === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
        g.stroke();
      }
      g.setLineDash([]);
    }

    // 5. Optional Ghost / Reference Curve
    if (ghostCurve && ghostCurve.points.length > 0) {
      const samples = Math.max(64, Math.round(plot.width / 2));
      g.strokeStyle = col('--kt-curve-ghost', '#8a8a8a77');
      g.lineWidth = 1.25;
      g.setLineDash([4, 3]);
      g.beginPath();
      for (let i = 0; i <= samples; i++) {
        const u = i / samples;
        const cx = view.xMin + u * xSpan;
        const cy = evaluateCurve(ghostCurve, cx);
        const px = plot.left + u * plot.width;
        const py = toScreenY(cy, plot);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
      g.setLineDash([]);
    }

    // 6. Main Curve Stroke
    if (current.points.length > 0) {
      const samples = Math.max(96, Math.round(plot.width / 1.5));
      g.strokeStyle =
        opts.variant === 'profile' ? col('--kt-curve-profile', '#73a4bf') : col('--kt-curve', '#a2d36b');
      g.lineWidth = 1.5;
      g.lineJoin = 'round';
      g.lineCap = 'round';
      g.beginPath();
      for (let i = 0; i <= samples; i++) {
        const u = i / samples;
        const cx = view.xMin + u * xSpan;
        const cy = evaluateCurve(current, cx);
        const px = plot.left + u * plot.width;
        const py = toScreenY(cy, plot);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    }

    // 7. Freehand Draw Stroke Preview
    if (drawStroke && drawStroke.length > 1) {
      g.strokeStyle = col('--kt-select-ring', '#ecd531');
      g.lineWidth = 1.5;
      g.setLineDash([2, 2]);
      g.beginPath();
      drawStroke.forEach((pt, idx) => {
        const px = toScreenX(pt.x, plot);
        const py = toScreenY(pt.y, plot);
        if (idx === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
      g.stroke();
      g.setLineDash([]);
    }

    // 8. Marquee Selection Box
    if (marqueeRect) {
      const mx = Math.min(marqueeRect.x0, marqueeRect.x1);
      const my = Math.min(marqueeRect.y0, marqueeRect.y1);
      const mw = Math.abs(marqueeRect.x1 - marqueeRect.x0);
      const mh = Math.abs(marqueeRect.y1 - marqueeRect.y0);
      g.fillStyle = col('--kt-curve-marquee-fill', '#4a7fc833');
      g.fillRect(mx, my, mw, mh);
      g.strokeStyle = col('--kt-curve-marquee-stroke', '#6c9be0');
      g.lineWidth = 1;
      g.strokeRect(mx + 0.5, my + 0.5, mw, mh);
    }

    g.restore(); // End plot clip so control points at (0,0) and (1,1) draw unclipped over the border

    // 9. Plot Border Frame
    g.strokeStyle = col('--kt-curve-grid-major', '#1f1f1f');
    g.lineWidth = 1;
    g.strokeRect(plot.left + 0.5, plot.top + 0.5, plot.width - 1, plot.height - 1);

    // 10. Optional Axis Ruler Labels
    if (showRulers) {
      g.fillStyle = col('--kt-curve-ruler-text', '#8a8a8a');
      g.font = `400 9px ${col('--kt-font', 'Inter, sans-serif')}`;
      g.textAlign = 'center';
      g.textBaseline = 'top';
      for (let gx = firstGridX; gx <= view.xMax + stepX * 0.01; gx += stepX * 2) {
        const px = toScreenX(gx, plot);
        if (px >= plot.left && px <= plot.left + plot.width) {
          g.fillText(formatNum(gx, 2), px, plot.top + plot.height + 4);
        }
      }
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      for (let gy = firstGridY; gy <= view.yMax + stepY * 0.01; gy += stepY * 2) {
        const py = toScreenY(gy, plot);
        if (py >= plot.top && py <= plot.top + plot.height) {
          g.fillText(formatNum(gy, 2), plot.left - 4, py);
        }
      }
    }

    // 11. Tangent Handles for Selected Points
    for (const idx of selected) {
      const pt = current.points[idx];
      if (!pt) continue;
      if (pt.mode === 'linear' || pt.mode === 'stepped' || pt.mode === 'constant') continue;

      const px = toScreenX(pt.x, plot);
      const py = toScreenY(pt.y, plot);

      const drawHandle = (side: 'in' | 'out'): void => {
        if (side === 'in' && idx === 0) return;
        if (side === 'out' && idx === current.points.length - 1) return;
        const vec = side === 'in' ? pt.inTangent : pt.outTangent;
        const hx = toScreenX(pt.x + vec.dx, plot);
        const hy = toScreenY(pt.y + vec.dy, plot);
        const isHov = hoveredTangent?.pointIndex === idx && hoveredTangent.side === side;

        g.strokeStyle = isHov
          ? col('--kt-curve-tangent-active', '#ffffff')
          : col('--kt-curve-tangent-line', '#b8c4a8');
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(hx, hy);
        g.stroke();

        g.fillStyle = isHov
          ? col('--kt-curve-tangent-active', '#ffffff')
          : col('--kt-curve-tangent-handle', '#f0b83a');
        g.strokeStyle = col('--kt-curve-point-border', '#0a2600');
        g.lineWidth = 1;
        g.beginPath();
        if (pt.mode === 'mirrored') {
          g.rect(hx - HANDLE_RADIUS + 0.5, hy - HANDLE_RADIUS + 0.5, HANDLE_RADIUS * 2 - 1, HANDLE_RADIUS * 2 - 1);
        } else {
          g.arc(hx, hy, HANDLE_RADIUS, 0, Math.PI * 2);
        }
        g.fill();
        g.stroke();
      };

      drawHandle('in');
      drawHandle('out');
    }

    // 12. Control Points
    current.points.forEach((pt, idx) => {
      const px = toScreenX(pt.x, plot);
      const py = toScreenY(pt.y, plot);
      const isSel = selected.has(idx);
      const isHov = hoveredPoint === idx;

      if (isSel || isHov) {
        g.strokeStyle = isSel
          ? col('--kt-curve-point-selected', '#ffffff')
          : col('--kt-select-ring', '#ecd531');
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(px, py, POINT_RADIUS + 2, 0, Math.PI * 2);
        g.stroke();
      }

      g.fillStyle = col('--kt-curve-point', '#12d600');
      g.strokeStyle = col('--kt-curve-point-border', '#0a2600');
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(px, py, POINT_RADIUS, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    });

    // 13. Live Cursor Value Readout under cursor
    if (cursorCoord && !drawMode) {
      const cpx = toScreenX(cursorCoord.x, plot);
      const cpy = toScreenY(cursorCoord.curveY, plot);
      if (cpx >= plot.left && cpx <= plot.left + plot.width) {
        g.fillStyle = col('--kt-curve', '#a2d36b');
        g.beginPath();
        g.arc(cpx, cpy, 2.5, 0, Math.PI * 2);
        g.fill();
      }
      const scale = displayScaleY() || 1;
      const readout = `x: ${formatNum(cursorCoord.x, 3)}  y: ${formatNum(cursorCoord.curveY * scale, 3)}`;
      g.font = `400 10px ${col('--kt-font', 'Inter, sans-serif')}`;
      g.fillStyle = col('--kt-text-dim', '#9b9b9b');
      g.textAlign = 'right';
      g.textBaseline = 'bottom';
      g.fillText(readout, cssW - PAD_RIGHT, cssH - 3);
    }

    g.restore();
  };

  // ---- Hit testing ----

  const hitTestTangent = (px: number, py: number, plot: { left: number; top: number; width: number; height: number }): TangentHit | null => {
    for (const idx of selected) {
      const pt = current.points[idx];
      if (!pt || pt.mode === 'linear' || pt.mode === 'stepped' || pt.mode === 'constant') continue;
      for (const side of ['in', 'out'] as const) {
        if (side === 'in' && idx === 0) continue;
        if (side === 'out' && idx === current.points.length - 1) continue;
        const vec = side === 'in' ? pt.inTangent : pt.outTangent;
        const hx = toScreenX(pt.x + vec.dx, plot);
        const hy = toScreenY(pt.y + vec.dy, plot);
        if (Math.hypot(px - hx, py - hy) <= HANDLE_RADIUS + 5) {
          return { pointIndex: idx, side };
        }
      }
    }
    return null;
  };

  const hitTestPoint = (px: number, py: number, plot: { left: number; top: number; width: number; height: number }): number => {
    let bestIdx = -1;
    let bestDist = POINT_RADIUS + 5;
    current.points.forEach((pt, idx) => {
      const sx = toScreenX(pt.x, plot);
      const sy = toScreenY(pt.y, plot);
      const d = Math.hypot(px - sx, py - sy);
      if (d <= bestDist) {
        bestDist = d;
        bestIdx = idx;
      }
    });
    return bestIdx;
  };

  // ---- Menus ----

  const buildPresetMenuItems = (): MenuItem[] => {
    const active = detectCurvePreset(current);
    return CURVE_PRESETS.map((p) => ({
      label: p.label,
      checked: active === p.id,
      run: () => applyEdit(applyCurvePreset(current, p.id as CurvePresetId), true),
    }));
  };

  const buildContextMenu = (clickCurveCoords?: { x: number; y: number }): MenuItem[] => {
    const idx = primarySelectedIndex();
    const selPt = idx >= 0 ? current.points[idx] : undefined;
    const targets = selected.size > 0 ? new Set(selected) : new Set(current.points.map((_, i) => i));

    const tangentItems: MenuItem[] = [
      {
        label: 'Auto / Smooth',
        shortcut: '1',
        checked: selPt?.mode === 'auto' || selPt?.mode === 'smooth',
        run: () => applyEdit(setPointsTangentMode(current, targets, 'auto'), true),
      },
      {
        label: 'Linear',
        shortcut: '2',
        checked: selPt?.mode === 'linear',
        run: () => applyEdit(setPointsTangentMode(current, targets, 'linear'), true),
      },
      {
        label: 'Constant (Step)',
        shortcut: '3',
        checked: selPt?.mode === 'stepped' || selPt?.mode === 'constant',
        run: () => applyEdit(setPointsTangentMode(current, targets, 'stepped'), true),
      },
      {
        label: 'Flat',
        shortcut: '4',
        checked: selPt?.mode === 'flat',
        run: () => applyEdit(setPointsTangentMode(current, targets, 'flat'), true),
      },
      {
        label: 'Aligned',
        shortcut: '5',
        checked: selPt?.mode === 'aligned',
        run: () => applyEdit(setPointsTangentMode(current, targets, 'aligned'), true),
      },
      {
        label: 'Mirrored',
        shortcut: '6',
        checked: selPt?.mode === 'mirrored',
        run: () => applyEdit(setPointsTangentMode(current, targets, 'mirrored'), true),
      },
      {
        label: 'Free (Broken)',
        shortcut: '7',
        checked: selPt?.mode === 'free',
        run: () => applyEdit(setPointsTangentMode(current, targets, 'free'), true),
      },
    ];

    const wrapItems: MenuItem[] = (
      [
        { mode: 'clamp', label: 'Clamp' },
        { mode: 'loop', label: 'Repeat (Loop)' },
        { mode: 'pingpong', label: 'Ping-Pong' },
      ] as { mode: WrapMode; label: string }[]
    ).map((w) => ({
      label: w.label,
      checked: current.wrap === w.mode || (w.mode === 'loop' && current.wrap === 'repeat'),
      run: () => applyEdit({ ...current, wrap: w.mode }, true),
    }));

    const transformItems: MenuItem[] = [
      {
        label: 'Flip Horizontal',
        run: () => applyEdit(flipCurveHorizontal(current), true),
      },
      {
        label: 'Flip Vertical',
        run: () => applyEdit(flipCurveVertical(current), true),
      },
      {
        label: 'Mirror Left → Right',
        run: () => applyEdit(mirrorCurve(current, 'leftToRight'), true),
      },
      {
        label: 'Mirror Right → Left',
        run: () => applyEdit(mirrorCurve(current, 'rightToLeft'), true),
      },
      {
        label: 'Reverse',
        run: () => applyEdit(reverseCurve(current), true),
      },
      { separator: true },
      {
        label: 'Smooth Selection',
        run: () => applyEdit(smoothCurvePoints(current, targets, 0.5), true),
      },
      {
        label: 'Simplify Curve',
        run: () => applyEdit(simplifyCurve(current, 0.02), true),
      },
      {
        label: 'Scale Y × 0.5',
        run: () => applyEdit(scaleOffsetCurvePoints(current, targets, 1, 0.5), true),
      },
      {
        label: 'Scale Y × 1.5',
        run: () => applyEdit(scaleOffsetCurvePoints(current, targets, 1, 1.5), true),
      },
    ];

    const canDelete =
      selected.size > 0 &&
      [...selected].some((i) => (current.fixedEndpoints !== false ? i > 0 && i < current.points.length - 1 : current.points.length > 2));

    return [
      ...(clickCurveCoords
        ? [
            {
              label: 'Add Point Here',
              run: () => {
                const res = addCurvePoint(current, clickCurveCoords.x, clickCurveCoords.y);
                selected = new Set([res.index]);
                applyEdit(res.curve, true);
              },
            },
          ]
        : []),
      {
        label: 'Delete Selected Point(s)',
        shortcut: 'Del',
        disabled: !canDelete,
        run: () => applyEdit(removeCurvePoints(current, selected), true),
      },
      { separator: true },
      {
        label: 'Tangent Mode',
        submenu: tangentItems,
      },
      {
        label: 'Presets',
        submenu: buildPresetMenuItems(),
      },
      {
        label: 'Transform',
        submenu: transformItems,
      },
      {
        label: 'Wrap Mode',
        submenu: wrapItems,
      },
      { separator: true },
      {
        label: 'Fit View',
        shortcut: 'F',
        run: () => fitView(),
      },
      {
        label: 'Reset View',
        shortcut: 'Home',
        run: () => resetView(),
      },
      {
        label: 'Show Tangent Toolbar',
        checked: showTangentBar,
        run: () => {
          showTangentBar = !showTangentBar;
          tangentBar.hidden = !showTangentBar;
          redraw();
        },
      },
      {
        label: 'Show Axis Rulers',
        checked: showRulers,
        run: () => {
          showRulers = !showRulers;
          redraw();
        },
      },
      { separator: true },
      {
        label: 'Copy Curve',
        shortcut: 'Ctrl+C',
        run: () => {
          void copyCurveClipboard(current);
        },
      },
      {
        label: 'Paste Curve',
        shortcut: 'Ctrl+V',
        run: () => {
          void pasteCurveClipboard().then((pasted) => {
            if (pasted) applyEdit(pasted, true);
          });
        },
      },
      {
        label: 'Reset Curve',
        run: () => applyEdit(flatCurve(1, current.xRange, current.yRange), true),
      },
    ];
  };

  presetBtn.addEventListener('click', () => {
    showMenu(buildPresetMenuItems(), presetBtn);
  });

  listBtn.addEventListener('click', () => {
    showMenu(buildContextMenu(), listBtn);
  });

  drawBtn.addEventListener('click', () => {
    drawMode = !drawMode;
    drawBtn.classList.toggle('active', drawMode);
    canvas.style.cursor = drawMode ? 'crosshair' : '';
  });

  // ---- Canvas Pointer & Keyboard Gestures ----

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const plot = getPlotRect(r.width || 560, r.height || 260);
    const cx = toCurveX(px, plot);
    const cy = toCurveY(py, plot);
    cursorCoord = { x: cx, y: cy, curveY: evaluateCurve(current, cx) };

    if (e.buttons === 0) {
      const th = hitTestTangent(px, py, plot);
      const ph = th ? -1 : hitTestPoint(px, py, plot);
      hoveredTangent = th;
      hoveredPoint = ph;
      canvas.style.cursor = drawMode ? 'crosshair' : spaceDown ? 'grab' : th || ph >= 0 ? 'pointer' : 'default';
    }
    redraw();
  });

  canvas.addEventListener('pointerleave', () => {
    cursorCoord = null;
    hoveredPoint = -1;
    hoveredTangent = null;
    redraw();
  });

  canvas.addEventListener('dblclick', (e) => {
    if (e.button !== 0 || drawMode) return;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const plot = getPlotRect(r.width || 560, r.height || 260);
    if (hitTestPoint(px, py, plot) >= 0) return;

    const cx = toCurveX(px, plot);
    const cy = toCurveY(py, plot);
    const res = addCurvePoint(current, cx, cy);
    selected = new Set([res.index]);
    applyEdit(res.curve, true);
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const plot = getPlotRect(r.width || 560, r.height || 260);
    const ptIdx = hitTestPoint(px, py, plot);
    if (ptIdx >= 0 && !selected.has(ptIdx)) {
      selected = new Set([ptIdx]);
      syncToolbarFields();
      redraw();
    }
    const cx = toCurveX(px, plot);
    const cy = toCurveY(py, plot);
    showMenu(buildContextMenu({ x: cx, y: cy }), { x: e.clientX, y: e.clientY });
  });

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const plot = getPlotRect(r.width || 560, r.height || 260);

    // 1. Pan (MMB or Space + LMB)
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const startView = { ...view };
      const sx = e.clientX;
      const sy = e.clientY;
      const move = (ev: PointerEvent): void => {
        const dx = ((ev.clientX - sx) / plot.width) * (startView.xMax - startView.xMin);
        const dy = ((ev.clientY - sy) / plot.height) * (startView.yMax - startView.yMin);
        view = {
          xMin: startView.xMin - dx,
          xMax: startView.xMax - dx,
          yMin: startView.yMin + dy,
          yMax: startView.yMax + dy,
        };
        redraw();
      };
      const up = (): void => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      return;
    }

    if (e.button !== 0) return;

    // 2. Freehand Draw mode
    if (drawMode) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const before = cloneCurve(current);
      drawStroke = [{ x: toCurveX(px, plot), y: toCurveY(py, plot) }];
      const move = (ev: PointerEvent): void => {
        const mx = ev.clientX - r.left;
        const my = ev.clientY - r.top;
        drawStroke?.push({ x: toCurveX(mx, plot), y: toCurveY(my, plot) });
        if (drawStroke && drawStroke.length >= 2) {
          current = fitCurveFromStroke(drawStroke, before);
          syncToolbarFields();
          opts.onChange?.(cloneCurve(current));
        }
        redraw();
      };
      const up = (): void => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        if (drawStroke && drawStroke.length >= 2) {
          current = fitCurveFromStroke(drawStroke, before);
          drawStroke = null;
          drawMode = false;
          syncToolbarFields();
          redraw();
          opts.onChange?.(cloneCurve(current));
          opts.onCommit?.(cloneCurve(current), before);
        } else {
          drawStroke = null;
          redraw();
        }
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      return;
    }

    // 3. Tangent handle drag
    const tanHit = hitTestTangent(px, py, plot);
    if (tanHit) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const before = cloneCurve(current);
      const move = (ev: PointerEvent): void => {
        const mx = ev.clientX - r.left;
        const my = ev.clientY - r.top;
        const pt = current.points[tanHit.pointIndex];
        if (!pt) return;
        const dx = toCurveX(mx, plot) - pt.x;
        const dy = toCurveY(my, plot) - pt.y;
        current = setPointTangent(current, tanHit.pointIndex, tanHit.side, dx, dy, ev.altKey);
        syncToolbarFields();
        redraw();
        opts.onChange?.(cloneCurve(current));
      };
      const up = (): void => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        opts.onCommit?.(cloneCurve(current), before);
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      return;
    }

    // 4. Control point select / drag
    const ptIdx = hitTestPoint(px, py, plot);
    if (ptIdx >= 0) {
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selected.has(ptIdx) && selected.size > 1) selected.delete(ptIdx);
        else selected.add(ptIdx);
      } else if (!selected.has(ptIdx)) {
        selected = new Set([ptIdx]);
      }
      syncToolbarFields();
      redraw();

      const before = cloneCurve(current);
      const startCurveX = toCurveX(px, plot);
      const startCurveY = toCurveY(py, plot);
      const startPx = px;
      const startPy = py;
      let lockedAxis: 'x' | 'y' | null = null;
      let didDrag = false;

      const move = (ev: PointerEvent): void => {
        const mx = ev.clientX - r.left;
        const my = ev.clientY - r.top;
        if (!didDrag && Math.hypot(mx - startPx, my - startPy) < 2) return;
        didDrag = true;

        let curX = toCurveX(mx, plot);
        let curY = toCurveY(my, plot);

        // Shift = axis lock
        if (ev.shiftKey) {
          if (!lockedAxis) {
            lockedAxis = Math.abs(mx - startPx) >= Math.abs(my - startPy) ? 'x' : 'y';
          }
          if (lockedAxis === 'x') curY = startCurveY;
          else curX = startCurveX;
        } else {
          lockedAxis = null;
        }

        // Ctrl/Cmd = grid snap
        if (ev.ctrlKey || ev.metaKey) {
          const snapStepX = niceGridStep(view.xMax - view.xMin, 20);
          const snapStepY = niceGridStep(view.yMax - view.yMin, 20);
          curX = Math.round(curX / snapStepX) * snapStepX;
          curY = Math.round(curY / snapStepY) * snapStepY;
        }

        const dx = curX - startCurveX;
        const dy = curY - startCurveY;

        if (selected.size === 1) {
          const origPt = before.points[ptIdx];
          if (origPt) {
            current = moveCurvePoint(before, ptIdx, origPt.x + dx, origPt.y + dy);
          }
        } else {
          current = moveCurvePointsByDelta(before, [...selected], dx, dy);
        }
        syncToolbarFields();
        redraw();
        opts.onChange?.(cloneCurve(current));
      };
      const up = (): void => {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerup', up);
        if (didDrag) {
          opts.onCommit?.(cloneCurve(current), before);
        }
      };
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerup', up);
      return;
    }

    // 5. Ctrl+Click on empty space -> immediately add point and drag it
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const cx = toCurveX(px, plot);
      const cy = toCurveY(py, plot);
      const res = addCurvePoint(current, cx, cy);
      selected = new Set([res.index]);
      applyEdit(res.curve, true);
      return;
    }

    // 6. Marquee selection box
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const baseSelection = e.shiftKey ? new Set(selected) : new Set<number>();
    marqueeRect = { x0: px, y0: py, x1: px, y1: py };
    const move = (ev: PointerEvent): void => {
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      marqueeRect = { x0: px, y0: py, x1: mx, y1: my };
      const minX = Math.min(px, mx);
      const maxX = Math.max(px, mx);
      const minY = Math.min(py, my);
      const maxY = Math.max(py, my);
      const nextSel = new Set(baseSelection);
      current.points.forEach((pt, idx) => {
        const sx = toScreenX(pt.x, plot);
        const sy = toScreenY(pt.y, plot);
        if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
          nextSel.add(idx);
        }
      });
      selected = nextSel;
      syncToolbarFields();
      redraw();
    };
    const up = (): void => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      marqueeRect = null;
      redraw();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
  });

  // Wheel zoom (Ctrl = X only, Shift = Y only)
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const plot = getPlotRect(r.width || 560, r.height || 260);
      const anchorX = toCurveX(px, plot);
      const anchorY = toCurveY(py, plot);
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;

      const zoomX = !e.shiftKey;
      const zoomY = !e.ctrlKey && !e.metaKey;

      if (zoomX) {
        const newMinX = anchorX - (anchorX - view.xMin) * factor;
        const newMaxX = anchorX + (view.xMax - anchorX) * factor;
        if (newMaxX - newMinX > 1e-3 && newMaxX - newMinX < 1e4) {
          view.xMin = newMinX;
          view.xMax = newMaxX;
        }
      }
      if (zoomY) {
        const newMinY = anchorY - (anchorY - view.yMin) * factor;
        const newMaxY = anchorY + (view.yMax - anchorY) * factor;
        if (newMaxY - newMinY > 1e-3 && newMaxY - newMinY < 1e4) {
          view.yMin = newMinY;
          view.yMax = newMaxY;
        }
      }
      redraw();
    },
    { passive: false },
  );

  // Keyboard shortcuts inside the Curve Editor
  canvas.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      spaceDown = true;
      canvas.style.cursor = 'grab';
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      e.stopPropagation();
      fitView();
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      e.stopPropagation();
      resetView();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      applyEdit(removeCurvePoints(current, selected), true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      selected = new Set(current.points.map((_, i) => i));
      syncToolbarFields();
      redraw();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      e.stopPropagation();
      void copyCurveClipboard(current);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      e.stopPropagation();
      void pasteCurveClipboard().then((pasted) => {
        if (pasted) applyEdit(pasted, true);
      });
      return;
    }

    // Arrow key nudge
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) && selected.size > 0) {
      e.preventDefault();
      e.stopPropagation();
      const mult = e.shiftKey ? 0.05 : 0.005;
      const dx = (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0) * (view.xMax - view.xMin) * mult;
      const dy = (e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0) * (view.yMax - view.yMin) * mult;
      applyEdit(moveCurvePointsByDelta(current, [...selected], dx, dy), true);
      return;
    }

    // Quick tangent mode keys 1..7
    const modeMap: Record<string, TangentMode> = {
      '1': 'auto',
      '2': 'linear',
      '3': 'stepped',
      '4': 'flat',
      '5': 'aligned',
      '6': 'mirrored',
      '7': 'free',
    };
    const mapped = modeMap[e.key];
    if (mapped && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const targets = selected.size > 0 ? selected : new Set(current.points.map((_, i) => i));
      applyEdit(setPointsTangentMode(current, targets, mapped), true);
    }
  });

  canvas.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      spaceDown = false;
      canvas.style.cursor = drawMode ? 'crosshair' : 'default';
    }
  });

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => redraw()) : null;
  ro?.observe(area);

  host.append(root);
  syncToolbarFields();
  redraw();

  return {
    element: root,
    canvas,
    getCurve: () => cloneCurve(current),
    setCurve: (c, silent = true) => {
      current = cloneCurve(c);
      if (selected.size === 0 || [...selected].some((i) => i >= current.points.length)) {
        selected = new Set([Math.max(0, current.points.length - 1)]);
      }
      syncToolbarFields();
      redraw();
      if (!silent) opts.onChange?.(cloneCurve(current));
    },
    getSelectedIndices: () => [...selected],
    setSelectedIndices: (indices) => {
      selected = new Set(indices.filter((i) => i >= 0 && i < current.points.length));
      syncToolbarFields();
      redraw();
    },
    setGhostCurve: (ghost) => {
      ghostCurve = ghost ? cloneCurve(ghost) : null;
      redraw();
    },
    setVariance: (v) => {
      variance = v ?? 0;
      redraw();
    },
    fitView,
    resetView,
    redraw,
    dispose: () => {
      ro?.disconnect();
      root.remove();
    },
  };
}
