import { describe, expect, it } from 'vitest';
import {
  AXIS_WIDTH_PX,
  GRID_LEVELS,
  MAJOR_ALPHA,
  MINOR_ALPHA,
  clipPlanes,
  distanceFade,
  dominantLevel,
  effectiveFadeEnd,
  grazingFade,
  levelSpacing,
  lineCoverage,
  selectGridLevels,
  spacingWeight,
} from '../quality/gridMath';

describe('grid levels', () => {
  it('spaces levels by 10x from cell/100 to cell*1000', () => {
    expect(levelSpacing(1, 0)).toBeCloseTo(0.01);
    expect(levelSpacing(1, 2)).toBeCloseTo(1);
    expect(levelSpacing(1, GRID_LEVELS - 1)).toBeCloseTo(1000);
    expect(levelSpacing(0.3048, 2)).toBeCloseTo(0.3048);
  });

  it('fades a level in between 5 and 20 px of spacing', () => {
    expect(spacingWeight(2)).toBe(0);
    expect(spacingWeight(5)).toBe(0);
    expect(spacingWeight(12.5)).toBeGreaterThan(0.3);
    expect(spacingWeight(12.5)).toBeLessThan(0.7);
    expect(spacingWeight(20)).toBe(1);
    expect(spacingWeight(400)).toBe(1);
  });

  it('never shows lines closer than ~5 px: far zoom-out hides fine levels, close zoom hides coarse ones', () => {
    const far = selectGridLevels(1, 0.5); // 1 m = half a pixel
    expect(far.slice(0, 4).every((l) => l.weight === 0)).toBe(true);
    expect(dominantLevel(far)?.spacing).toBeGreaterThanOrEqual(100);
    const near = selectGridLevels(1, 2000); // 1 m = 2000 px
    expect(near[0]?.weight).toBe(1);
    expect(dominantLevel(near)?.index).toBe(GRID_LEVELS - 1);
  });

  it('draws a level brighter and wider when the next finer level is visible (major lines)', () => {
    const levels = selectGridLevels(1, 100); // 1 m = 100 px: 10 cm = 10 px (partial), 1 m fully visible
    const metre = levels[2];
    const decimetre = levels[1];
    expect(metre?.weight).toBe(1);
    expect(decimetre?.weight).toBeGreaterThan(0);
    expect(metre?.alpha).toBeGreaterThan(MINOR_ALPHA);
    expect(metre?.alpha).toBeLessThanOrEqual(MAJOR_ALPHA);
    expect(levels[0]?.alpha).toBe(0);
  });

  it('keeps the dominant level monotonic while zooming', () => {
    let last = -1;
    for (let ppu = 0.01; ppu < 1e5; ppu *= 1.3) {
      const idx = dominantLevel(selectGridLevels(1, ppu))?.index ?? -1;
      expect(idx).toBeLessThanOrEqual(GRID_LEVELS - 1);
      if (last !== -1 && idx !== -1) expect(idx).toBeLessThanOrEqual(last);
      if (idx !== -1) last = idx;
    }
  });
});

describe('line width and fades', () => {
  it('has constant pixel coverage independent of how far the line is in world units', () => {
    // Width 2 px: full coverage up to 0.5 px from the centre, 0 beyond 1.5 px, linear in between.
    expect(lineCoverage(0, AXIS_WIDTH_PX)).toBe(1);
    expect(lineCoverage(0.5, AXIS_WIDTH_PX)).toBe(1);
    expect(lineCoverage(1, AXIS_WIDTH_PX)).toBeCloseTo(0.5);
    expect(lineCoverage(1.5, AXIS_WIDTH_PX)).toBe(0);
    // The integral over the cross-section equals the line width (what "constant thickness" means).
    let sum = 0;
    for (let x = -3; x < 3; x += 0.01) sum += lineCoverage(Math.abs(x), 2) * 0.01;
    expect(sum).toBeCloseTo(2, 1);
    let sum1 = 0;
    for (let x = -3; x < 3; x += 0.01) sum1 += lineCoverage(Math.abs(x), 1) * 0.01;
    expect(sum1).toBeCloseTo(1, 1);
  });

  it('fades with distance from 20 % of the end distance to zero', () => {
    expect(distanceFade(0, 400)).toBe(1);
    expect(distanceFade(80, 400)).toBe(1);
    expect(distanceFade(400, 400)).toBe(0);
    expect(distanceFade(240, 400)).toBeGreaterThan(0);
    expect(distanceFade(240, 400)).toBeLessThan(1);
  });

  it('fades at grazing angles', () => {
    expect(grazingFade(0)).toBe(0);
    expect(grazingFade(0.01)).toBe(0);
    expect(grazingFade(0.5)).toBe(1);
    expect(grazingFade(-0.5)).toBe(1);
  });

  it('grows the fade distance with the camera distance', () => {
    expect(effectiveFadeEnd(420, 10)).toBe(420);
    expect(effectiveFadeEnd(420, 200)).toBe(1200);
  });
});

describe('clip planes', () => {
  it('keeps the near/far ratio small and monotonic', () => {
    let lastNear = 0;
    for (const d of [0.1, 1, 5, 20, 74, 300, 2000]) {
      const { near, far } = clipPlanes(d);
      expect(near).toBeGreaterThanOrEqual(lastNear);
      expect(far / near).toBeLessThan(40000);
      expect(far).toBeGreaterThanOrEqual(Math.min(d * 3, 6000));
      lastNear = near;
    }
  });
});
