import {
  applyCurvePreset,
  cloneCurve,
  copyCurveClipboard,
  CURVE_PRESETS,
  detectCurvePreset,
  evaluateCurve,
  flatCurve,
  flipCurveHorizontal,
  flipCurveVertical,
  pasteCurveClipboard,
  switchCurveLevel,
  type Curve,
  type CurvePresetId,
} from '@/core/curve';
import { clamp } from '@/core/math';
import { h, iconButton } from '../dom';
import { showMenu, type MenuItem } from '../menu';
import { icon } from '../../icons/icons';

/**
 * Inline Mini Curve component (thumbnail in property rows, hover highlight,
 * click to open full editor, right-click preset/copy/paste/reset menu,
 * optional inline preset dropdown & reset buttons).
 */

export type MiniCurveVariant = 'parent' | 'profile' | 'dim';

export interface MiniCurveOptions {
  curve?: Curve | null;
  variant?: MiniCurveVariant;
  /** Optional level badge number shown in bottom-right. */
  levelBadge?: number;
  /** Parameter path/title for the popup editor. */
  path?: string;
  /** Show inline preset dropdown + reset button alongside the thumbnail. */
  showInlineControls?: boolean;
  /** Width & height of the thumbnail button in CSS pixels (default 24x20). */
  width?: number;
  height?: number;
  onOpenEditor?: (curve: Curve) => void;
  onChange?: (curve: Curve) => void;
  onCommit?: (curve: Curve, previous: Curve) => void;
  onReset?: () => void;
}

export interface MiniCurveInstance {
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  getCurve(): Curve;
  setCurve(curve: Curve | null, levelBadge?: number): void;
  setVariant(variant: MiniCurveVariant): void;
  redraw(): void;
  dispose(): void;
}

/**
 * Draw a Curve onto a mini thumbnail canvas (HiDPI-aware).
 */
export function renderCurveThumbnail(
  canvas: HTMLCanvasElement,
  curve: Curve | null | undefined,
  opts?: {
    variant?: MiniCurveVariant;
    hovered?: boolean;
    levelBadge?: number;
    showReferenceDashed?: boolean;
    width?: number;
    height?: number;
  },
): void {
  const cssW = opts?.width ?? (canvas.clientWidth || 24);
  const cssH = opts?.height ?? (canvas.clientHeight || 20);
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const targetW = Math.max(1, Math.round(cssW * dpr));
  const targetH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const g = canvas.getContext('2d');
  if (!g) return;
  g.save();
  g.scale(dpr, dpr);

  const style = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const token = (name: string, fallback: string): string => style?.getPropertyValue(name).trim() || fallback;

  g.clearRect(0, 0, cssW, cssH);

  const activeCurve = curve ?? flatCurve(1);
  const variant = opts?.variant ?? 'parent';
  const strokeColor =
    variant === 'profile'
      ? token('--kt-curve-profile', '#73a4bf')
      : variant === 'dim'
        ? token('--kt-text-dim', '#9b9b9b')
        : token('--kt-curve', '#a2d36b');

  const padX = 2.5;
  const padTop = 3;
  const padBot = 3;
  const plotW = Math.max(2, cssW - padX * 2);
  const plotH = Math.max(2, cssH - padTop - padBot);

  if (opts?.showReferenceDashed) {
    g.strokeStyle = token('--kt-border', '#565656');
    g.lineWidth = 1;
    g.setLineDash([2, 2]);
    g.beginPath();
    g.moveTo(padX, padTop + plotH * 0.2);
    g.lineTo(padX + plotW, padTop + plotH * 0.2);
    g.stroke();
    g.setLineDash([]);
  }

  const [x0, x1] = activeCurve.xRange;
  const [y0, y1] = activeCurve.yRange;
  const xSpan = x1 - x0 || 1;
  const ySpan = y1 - y0 || 1;

  g.strokeStyle = strokeColor;
  g.lineWidth = opts?.hovered ? 1.8 : 1.5;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();

  const samples = Math.max(16, Math.round(plotW * 1.5));
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const xVal = x0 + u * xSpan;
    const yVal = evaluateCurve(activeCurve, xVal);
    const yn = clamp((yVal - y0) / ySpan, 0, 1);
    const px = padX + u * plotW;
    const py = padTop + (1 - yn) * plotH;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();

  const badge = opts?.levelBadge ?? (activeCurve.level && activeCurve.level > 1 ? activeCurve.level : undefined);
  if (badge !== undefined && badge > 0) {
    const text = String(badge);
    g.font = `600 9px ${token('--kt-font', 'Inter, sans-serif')}`;
    g.textAlign = 'right';
    g.textBaseline = 'bottom';
    // Dark halo for legibility over curve lines
    g.strokeStyle = token('--kt-bg-input', '#2a2a2a');
    g.lineWidth = 2.5;
    g.strokeText(text, cssW - 1.5, cssH - 0.5);
    g.fillStyle = token('--kt-text-strong', '#ffffff');
    g.fillText(text, cssW - 1.5, cssH - 0.5);
  }

  g.restore();
}

export function mountMiniCurve(host: HTMLElement, opts: MiniCurveOptions = {}): MiniCurveInstance {
  let current: Curve = opts.curve ? cloneCurve(opts.curve) : flatCurve(1);
  let variant: MiniCurveVariant = opts.variant ?? 'parent';
  let levelBadge: number | undefined = opts.levelBadge ?? current.level;
  let hovered = false;

  const w = opts.width ?? 24;
  const hgt = opts.height ?? 20;

  const canvas = h('canvas', 'kt-mini-curve-canvas');
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hgt}px`;

  const btn = h('button', `kt-curve-toggle kt-mini-curve${variant === 'dim' ? ' dim' : ''}`, canvas);
  btn.type = 'button';
  btn.style.width = `${w}px`;
  btn.style.height = `${hgt}px`;
  btn.title = opts.path ? `Edit curve (${opts.path})` : 'Edit curve (Right-click for presets)';

  const redraw = (): void => {
    renderCurveThumbnail(canvas, current, {
      variant,
      hovered,
      levelBadge,
      width: w,
      height: hgt,
    });
  };

  const commitChange = (next: Curve): void => {
    const prev = cloneCurve(current);
    current = cloneCurve(next);
    if (next.level !== undefined) levelBadge = next.level > 1 ? next.level : undefined;
    redraw();
    opts.onChange?.(cloneCurve(current));
    opts.onCommit?.(cloneCurve(current), prev);
  };

  const buildContextMenu = (): MenuItem[] => {
    const activePreset = detectCurvePreset(current);
    const presetItems: MenuItem[] = CURVE_PRESETS.map((p) => ({
      label: p.label,
      checked: activePreset === p.id,
      run: () => commitChange(applyCurvePreset(current, p.id as CurvePresetId)),
    }));

    const levelItems: MenuItem[] = [1, 2, 3, 4, 5].map((lvl) => ({
      label: lvl === 1 ? '1 - Parent' : `${lvl} - Level ${lvl}`,
      checked: (current.level ?? 1) === lvl,
      run: () => {
        levelBadge = lvl > 1 ? lvl : undefined;
        commitChange(switchCurveLevel(current, lvl));
      },
    }));

    return [
      {
        label: 'Edit Curve…',
        run: () => opts.onOpenEditor?.(cloneCurve(current)),
      },
      { separator: true },
      {
        label: 'Preset',
        submenu: presetItems,
      },
      {
        label: 'Parent Level',
        submenu: levelItems,
      },
      { separator: true },
      {
        label: 'Flip Horizontal',
        run: () => commitChange(flipCurveHorizontal(current)),
      },
      {
        label: 'Flip Vertical',
        run: () => commitChange(flipCurveVertical(current)),
      },
      { separator: true },
      {
        label: 'Copy Curve',
        run: () => {
          void copyCurveClipboard(current);
        },
      },
      {
        label: 'Paste Curve',
        run: () => {
          void pasteCurveClipboard().then((pasted) => {
            if (pasted) commitChange(pasted);
          });
        },
      },
      { separator: true },
      {
        label: 'Reset Curve',
        run: () => {
          levelBadge = undefined;
          commitChange(flatCurve(1, current.xRange, current.yRange));
          opts.onReset?.();
        },
      },
    ];
  };

  btn.addEventListener('pointerenter', () => {
    hovered = true;
    redraw();
  });
  btn.addEventListener('pointerleave', () => {
    hovered = false;
    redraw();
  });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onOpenEditor?.(cloneCurve(current));
  });
  btn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(buildContextMenu(), { x: e.clientX, y: e.clientY });
  });

  let root: HTMLElement = btn;
  if (opts.showInlineControls) {
    const presetBtn = h('button', 'kt-gen-btn has-menu kt-mini-curve-preset', icon('curve', 14), h('span', '', 'Preset'));
    presetBtn.type = 'button';
    presetBtn.addEventListener('click', () => {
      const activePreset = detectCurvePreset(current);
      showMenu(
        CURVE_PRESETS.map((p) => ({
          label: p.label,
          checked: activePreset === p.id,
          run: () => commitChange(applyCurvePreset(current, p.id as CurvePresetId)),
        })),
        presetBtn,
      );
    });
    const resetBtn = iconButton(icon('reset', 14), 'Reset curve', () => {
      levelBadge = undefined;
      commitChange(flatCurve(1, current.xRange, current.yRange));
      opts.onReset?.();
    });
    root = h('div', 'kt-mini-curve-inline', btn, presetBtn, resetBtn);
  }

  host.append(root);
  redraw();

  return {
    element: root,
    button: btn,
    getCurve: () => cloneCurve(current),
    setCurve: (c, badge) => {
      current = c ? cloneCurve(c) : flatCurve(1);
      if (badge !== undefined) levelBadge = badge;
      else if (current.level !== undefined) levelBadge = current.level > 1 ? current.level : undefined;
      redraw();
    },
    setVariant: (v) => {
      variant = v;
      btn.classList.toggle('dim', v === 'dim');
      redraw();
    },
    redraw,
    dispose: () => {
      root.remove();
    },
  };
}
