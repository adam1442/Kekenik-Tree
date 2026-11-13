// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addCurvePoint,
  addRampStop,
  applyCurvePreset,
  clearCurveLUTCache,
  copyCurveClipboard,
  copyRampClipboard,
  CURVE_PRESETS,
  curveDerivative,
  curveHash,
  curveIntegral,
  curveToLUT,
  defaultRamp,
  deserializeCurve,
  deserializeRamp,
  detectCurvePreset,
  distributeRampStops,
  evaluateCurve,
  evaluateRamp,
  fitCurveFromStroke,
  flatCurve,
  flipCurveHorizontal,
  flipCurveVertical,
  flipRamp,
  getCurvePreset,
  getRampPreset,
  linearCurve,
  linearPoint,
  mirrorCurve,
  moveCurvePoint,
  moveRampStop,
  pasteCurveClipboard,
  pasteRampClipboard,
  rampToFloatLUT,
  rampToLUT,
  removeCurvePoints,
  removeRampStop,
  reverseCurve,
  sampleCurveLUT,
  scaleOffsetCurvePoints,
  serializeCurve,
  serializeRamp,
  setPointsTangentMode,
  setPointTangent,
  setRampStopAlpha,
  setRampStopColor,
  simplifyCurve,
  smoothCurvePoints,
  steppedPoint,
  switchCurveLevel,
  type Curve,
} from '@/core/curve';
import { hexToRgba, hsvToRgb, mountColorPicker, rgbaToHex, rgbToHsv } from '@/ui/components/colorPicker';
import { mountCurveEditor, mountMiniCurve } from '@/ui/components/curve';
import { hasParamWidget, mountParamWidget } from '@/ui/components/paramWidgetRegistry';
import { mountRampEditor } from '@/ui/components/ramp';

beforeAll(() => {
  class RO {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy(
      {},
      {
        get: (_t, p) =>
          p === 'createImageData'
            ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
            : p === 'createRadialGradient' || p === 'createLinearGradient'
              ? () => ({ addColorStop(): void {} })
              : () => undefined,
        set: () => true,
      },
    )) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

describe('core/curve evaluation & tangent modes', () => {
  it('evaluates linear, stepped/constant, flat, and smooth curves accurately', () => {
    const lin = linearCurve(0, 4, [0, 2], [0, 4]);
    expect(evaluateCurve(lin, 0)).toBeCloseTo(0);
    expect(evaluateCurve(lin, 0.5)).toBeCloseTo(1);
    expect(evaluateCurve(lin, 1.5)).toBeCloseTo(3);
    expect(evaluateCurve(lin, 2)).toBeCloseTo(4);

    const step: Curve = {
      points: [steppedPoint(0, 0.2), steppedPoint(0.5, 0.8), steppedPoint(1, 1)],
      xRange: [0, 1],
      yRange: [0, 1],
      wrap: 'clamp',
    };
    expect(evaluateCurve(step, 0.1)).toBeCloseTo(0.2);
    expect(evaluateCurve(step, 0.499)).toBeCloseTo(0.2);
    expect(evaluateCurve(step, 0.5)).toBeCloseTo(0.8);
    expect(evaluateCurve(step, 0.99)).toBeCloseTo(0.8);
    expect(evaluateCurve(step, 1)).toBeCloseTo(1);

    const easeInOut = getCurvePreset('ease-in-out');
    expect(evaluateCurve(easeInOut, 0)).toBeCloseTo(0);
    expect(evaluateCurve(easeInOut, 0.5)).toBeCloseTo(0.5, 2);
    expect(evaluateCurve(easeInOut, 1)).toBeCloseTo(1);
    // Flat tangents at endpoints => derivative at 0 and 1 is 0
    expect(curveDerivative(easeInOut, 0.001)).toBeLessThan(0.05);
    expect(curveDerivative(easeInOut, 0.999)).toBeLessThan(0.05);
    expect(curveDerivative(easeInOut, 0.5)).toBeGreaterThan(1.2);
  });

  it('supports wrap modes: clamp, loop/repeat, pingpong', () => {
    const c = linearCurve(0, 1);
    expect(evaluateCurve({ ...c, wrap: 'clamp' }, 1.3)).toBeCloseTo(1);
    expect(evaluateCurve({ ...c, wrap: 'loop' }, 1.3)).toBeCloseTo(0.3);
    expect(evaluateCurve({ ...c, wrap: 'repeat' }, 2.75)).toBeCloseTo(0.75);
    expect(evaluateCurve({ ...c, wrap: 'pingpong' }, 1.25)).toBeCloseTo(0.75);
    expect(evaluateCurve({ ...c, wrap: 'pingpong' }, 2.25)).toBeCloseTo(0.25);
  });

  it('computes analytic derivative and definite integral', () => {
    const bell = getCurvePreset('bell');
    const x = 0.25;
    const eps = 1e-5;
    const numDeriv = (evaluateCurve(bell, x + eps) - evaluateCurve(bell, x - eps)) / (2 * eps);
    expect(curveDerivative(bell, x)).toBeCloseTo(numDeriv, 3);
    expect(curveDerivative(bell, 0.5)).toBeCloseTo(0, 3);

    // Integral of linear 0->1 over [0,1] is 0.5
    expect(curveIntegral(linearCurve(0, 1))).toBeCloseTo(0.5, 4);
    // Integral of constant 0.75 over [0,2] is 1.5
    expect(curveIntegral(flatCurve(0.75, [0, 2], [0, 1]), 0, 2)).toBeCloseTo(1.5, 4);
  });

  it('builds 256 and 512 sample LUTs and caches by hash', () => {
    clearCurveLUTCache();
    const c = getCurvePreset('ease-in');
    const h1 = curveHash(c);
    const lut256 = curveToLUT(c, 256);
    const lut256Again = curveToLUT(c, 256);
    const lut512 = curveToLUT(c, 512);

    expect(lut256).toHaveLength(256);
    expect(lut512).toHaveLength(512);
    expect(lut256).toBe(lut256Again); // exact cached reference
    expect(sampleCurveLUT(lut256, 0)).toBeCloseTo(0);
    expect(sampleCurveLUT(lut256, 1)).toBeCloseTo(1);
    expect(sampleCurveLUT(lut512, 0.5)).toBeCloseTo(evaluateCurve(c, 0.5), 2);

    const modified = moveCurvePoint(c, 1, 1, 0.5);
    expect(curveHash(modified)).not.toBe(h1);
  });

  it('recognizes all presets', () => {
    for (const preset of CURVE_PRESETS) {
      const c = getCurvePreset(preset.id);
      expect(detectCurvePreset(c)).toBe(preset.id);
      const applied = applyCurvePreset(flatCurve(1), preset.id);
      expect(detectCurvePreset(applied)).toBe(preset.id);
    }
  });
});

describe('core/curve operations & serialization', () => {
  it('adds, moves (with x-order & endpoint constraints), and removes points', () => {
    let c = linearCurve(0, 1);
    c.fixedEndpoints = true;

    const added = addCurvePoint(c, 0.4, 0.8);
    c = added.curve;
    expect(c.points).toHaveLength(3);
    expect(added.index).toBe(1);
    expect(c.points[1]?.x).toBeCloseTo(0.4);
    expect(c.points[1]?.y).toBeCloseTo(0.8);

    // Endpoint 0 X is locked to 0 when fixedEndpoints is true
    const movedEnd = moveCurvePoint(c, 0, 0.9, 0.25);
    expect(movedEnd.points[0]?.x).toBe(0);
    expect(movedEnd.points[0]?.y).toBeCloseTo(0.25);

    // Interior point 1 X is clamped between point 0 (0) and point 2 (1)
    const movedMid = moveCurvePoint(c, 1, 2.5, 0.6);
    expect(movedMid.points[1]!.x).toBeLessThan(1);
    expect(movedMid.points[1]!.x).toBeGreaterThan(0.99);

    // Removing fixed endpoints is ignored; removing interior point succeeds
    expect(removeCurvePoints(c, [0, 2]).points).toHaveLength(3);
    expect(removeCurvePoints(c, [1]).points).toHaveLength(2);
  });

  it('handles tangent modes: mirrored, aligned, free, flat, linear, stepped', () => {
    let c = addCurvePoint(linearCurve(0, 1), 0.5, 0.5).curve;
    c = setPointsTangentMode(c, [1], 'mirrored');
    c = setPointTangent(c, 1, 'out', 0.2, 0.4);
    expect(c.points[1]?.outTangent).toEqual({ dx: 0.2, dy: 0.4 });
    expect(c.points[1]?.inTangent).toEqual({ dx: -0.2, dy: -0.4 });

    c = setPointsTangentMode(c, [1], 'aligned');
    c = setPointTangent(c, 1, 'in', -0.1, -0.2);
    // Out tangent preserves its length (hypot(0.2, 0.4)) and aligns slope (2)
    expect(c.points[1]!.outTangent.dy / c.points[1]!.outTangent.dx).toBeCloseTo(2, 3);

    // Free (broken) tangent only changes the dragged side
    c = setPointTangent(c, 1, 'in', -0.15, 0.3, true);
    expect(c.points[1]?.mode).toBe('free');
    expect(c.points[1]?.inTangent).toEqual({ dx: -0.15, dy: 0.3 });
    expect(c.points[1]!.outTangent.dy).toBeGreaterThan(0);
  });

  it('flips, mirrors, reverses, scales, smooths, simplifies, fits strokes, and switches levels', () => {
    const c = getCurvePreset('late-rise'); // (0,0) -> (0.683,0) -> (1,1)
    const fh = flipCurveHorizontal(c);
    expect(evaluateCurve(fh, 0)).toBeCloseTo(1);
    expect(evaluateCurve(fh, 1)).toBeCloseTo(0);

    const fv = flipCurveVertical(c);
    expect(evaluateCurve(fv, 0)).toBeCloseTo(1);
    expect(evaluateCurve(fv, 1)).toBeCloseTo(0);

    const rev = reverseCurve(c);
    expect(evaluateCurve(rev, 0)).toBeCloseTo(1);

    const mir = mirrorCurve(linearCurve(0, 1), 'leftToRight');
    expect(evaluateCurve(mir, 0)).toBeCloseTo(evaluateCurve(mir, 1));
    expect(evaluateCurve(mir, 0.25)).toBeCloseTo(evaluateCurve(mir, 0.75));

    const scaled = scaleOffsetCurvePoints(linearCurve(0, 1), [0, 1], 1, 0.5, 0, 0.25);
    expect(evaluateCurve(scaled, 0)).toBeCloseTo(0.25);
    expect(evaluateCurve(scaled, 1)).toBeCloseTo(0.75);

    const noisy = getCurvePreset('noise');
    const smoothed = smoothCurvePoints(noisy, undefined, 0.8);
    expect(smoothed.points).toHaveLength(noisy.points.length);

    // Simplify collinear multi-point curve down to 2 endpoints
    const dense: Curve = {
      points: [linearPoint(0, 0), linearPoint(0.25, 0.25), linearPoint(0.5, 0.5), linearPoint(0.75, 0.75), linearPoint(1, 1)],
      xRange: [0, 1],
      yRange: [0, 1],
      wrap: 'clamp',
    };
    expect(simplifyCurve(dense, 0.01).points).toHaveLength(2);

    const stroke = Array.from({ length: 20 }, (_, i) => ({ x: i / 19, y: Math.sin((i / 19) * Math.PI) }));
    const fitted = fitCurveFromStroke(stroke, flatCurve(1));
    expect(fitted.points.length).toBeGreaterThanOrEqual(3);
    expect(evaluateCurve(fitted, 0.5)).toBeGreaterThan(0.8);

    const lvl2 = switchCurveLevel(c, 2);
    expect(lvl2.level).toBe(2);
    const modLvl2 = moveCurvePoint(lvl2, 0, 0, 0.9);
    const backTo1 = switchCurveLevel(modLvl2, 1);
    expect(backTo1.points[0]?.y).toBeCloseTo(0);
  });

  it('round-trips JSON and clipboard', async () => {
    const c = getCurvePreset('bell');
    const json = serializeCurve(c);
    const parsed = deserializeCurve(json);
    expect(parsed).not.toBeNull();
    expect(evaluateCurve(parsed!, 0.5)).toBeCloseTo(1);
    expect(deserializeCurve('invalid json')).toBeNull();

    await copyCurveClipboard(c);
    const pasted = await pasteCurveClipboard();
    expect(pasted).not.toBeNull();
    expect(curveHash(pasted!)).toBe(curveHash(c));
  });
});

describe('core/curve ramp & color utilities', () => {
  it('evaluates ramps, generates LUTs, and edits stops', () => {
    let r = defaultRamp();
    expect(evaluateRamp(r, 0)[3]).toBe(1);
    const added = addRampStop(r, 0.5, [1, 0, 0, 0.5]);
    r = added.ramp;
    expect(r.stops).toHaveLength(3);
    expect(evaluateRamp(r, 0.5)[0]).toBeCloseTo(1);
    expect(evaluateRamp(r, 0.5)[3]).toBeCloseTo(0.5);

    const lut = rampToLUT(r, 64);
    expect(lut).toHaveLength(64 * 4);
    expect(rampToLUT(r, 64)).toBe(lut); // cached
    expect(rampToFloatLUT(r, 64)).toHaveLength(64 * 4);

    r = moveRampStop(r, 1, 0.8).ramp;
    expect(r.stops[1]?.t).toBeCloseTo(0.8);
    r = setRampStopColor(r, 1, [0, 1, 0, 1]);
    r = setRampStopAlpha(r, 1, 0.25);
    expect(r.stops[1]?.color).toEqual([0, 1, 0, 0.25]);

    r = distributeRampStops(r);
    expect(r.stops[1]?.t).toBeCloseTo(0.5);
    const flipped = flipRamp(r);
    expect(flipped.stops[0]?.color).toEqual(r.stops[2]?.color);

    r = removeRampStop(r, 1);
    expect(r.stops).toHaveLength(2);
    expect(removeRampStop(r, 0).stops).toHaveLength(2); // never fewer than 2 stops
  });

  it('round-trips ramp clipboard and color conversions', async () => {
    const r = getRampPreset('autumn-decay');
    await copyRampClipboard(r);
    const pasted = await pasteRampClipboard();
    expect(pasted?.stops).toHaveLength(r.stops.length);
    expect(deserializeRamp(serializeRamp(r))?.interpolation).toBe(r.interpolation);

    const [h, s, v] = rgbToHsv(0.4, 0.8, 0.2);
    const [cr, cg, cb] = hsvToRgb(h, s, v);
    expect(cr).toBeCloseTo(0.4);
    expect(cg).toBeCloseTo(0.8);
    expect(cb).toBeCloseTo(0.2);

    expect(rgbaToHex([1, 0, 0.5, 1])).toBe('#ff0080');
    expect(hexToRgba('#ff0080')?.[0]).toBeCloseTo(1);
  });
});

describe('UI components (CurveEditor, MiniCurve, RampEditor, ColorPicker, ParamWidgetRegistry)', () => {
  it('mounts and disposes CurveEditor, MiniCurve, RampEditor, ColorPicker cleanly', () => {
    const host = document.createElement('div');
    document.body.append(host);

    const ce = mountCurveEditor(host, {
      curve: getCurvePreset('late-rise'),
      valueScale: 6.342,
      initialSelectedIndex: 1,
      showTangentBar: true,
    });
    expect(host.querySelector('.kt-curve-editor')).not.toBeNull();
    expect(ce.getSelectedIndices()).toEqual([1]);
    ce.setCurve(getCurvePreset('bell'));
    expect(ce.getCurve().points).toHaveLength(3);
    ce.dispose();

    const mc = mountMiniCurve(host, {
      curve: getCurvePreset('early-drop'),
      levelBadge: 5,
      showInlineControls: true,
    });
    expect(host.querySelector('.kt-mini-curve')).not.toBeNull();
    mc.dispose();

    const re = mountRampEditor(host, {
      ramp: getRampPreset('foliage-summer'),
    });
    expect(host.querySelector('.kt-ramp-editor')).not.toBeNull();
    re.dispose();

    const cp = mountColorPicker(host, {
      value: [0.2, 0.6, 0.3, 1],
    });
    expect(host.querySelector('.kt-cp')).not.toBeNull();
    cp.dispose();

    expect(hasParamWidget('curve')).toBe(true);
    expect(hasParamWidget('ramp')).toBe(true);
    expect(hasParamWidget('color')).toBe(true);

    const wCurve = mountParamWidget(host, {
      def: { id: 'c', kind: 'curve', label: 'Curve', group: 'Gen', default: flatCurve(1) },
      state: { value: flatCurve(1) },
      onChange: () => undefined,
    });
    expect(wCurve).not.toBeNull();
    wCurve?.dispose();

    const wRamp = mountParamWidget(host, {
      def: { id: 'r', kind: 'ramp', label: 'Ramp', group: 'Gen', default: defaultRamp() },
      state: { value: defaultRamp() },
      onChange: () => undefined,
    });
    expect(wRamp).not.toBeNull();
    wRamp?.dispose();

    host.remove();
  });
});
