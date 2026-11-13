import { UNIT_SCALE, type ExportSettings, type Handedness, type UpAxis } from './types';

/**
 * Coordinate conversion from the Kekenik scene (right-handed, Z-up, metres) to the export space.
 * `m` is a row-major 3x3 matrix that includes the axis change and the optional mirror, WITHOUT the uniform `scale`.
 */
export interface ExportTransform {
  m: readonly number[];
  scale: number;
  /** The matrix mirrors the model: triangle winding must be reversed to keep faces outward. */
  flipWinding: boolean;
}

const det3 = (m: readonly number[]): number =>
  (m[0] as number) * ((m[4] as number) * (m[8] as number) - (m[5] as number) * (m[7] as number)) -
  (m[1] as number) * ((m[3] as number) * (m[8] as number) - (m[5] as number) * (m[6] as number)) +
  (m[2] as number) * ((m[3] as number) * (m[7] as number) - (m[4] as number) * (m[6] as number));

/** Builds the transform. Y-up = rotate -90 deg about X ((x,y,z) -> (x,z,-y)); left-handed = mirror X afterwards. */
export function buildTransform(upAxis: UpAxis, handedness: Handedness, scale: number): ExportTransform {
  let m: number[] = upAxis === 'Y' ? [1, 0, 0, 0, 0, 1, 0, -1, 0] : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (handedness === 'left') m = [-(m[0] as number), -(m[1] as number), -(m[2] as number), ...m.slice(3)];
  return { m, scale, flipWinding: det3(m) < 0 };
}

export function transformFromSettings(s: Pick<ExportSettings, 'upAxis' | 'handedness' | 'units' | 'scale'>): ExportTransform {
  return buildTransform(s.upAxis, s.handedness, UNIT_SCALE[s.units] * s.scale);
}

/** Apply to a point list (xyz triples) in place. */
export function transformPoints(t: ExportTransform, a: Float32Array): void {
  const m = t.m as number[];
  for (let i = 0; i + 2 < a.length; i += 3) {
    const x = a[i] as number;
    const y = a[i + 1] as number;
    const z = a[i + 2] as number;
    a[i] = ((m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z) * t.scale;
    a[i + 1] = ((m[3] as number) * x + (m[4] as number) * y + (m[5] as number) * z) * t.scale;
    a[i + 2] = ((m[6] as number) * x + (m[7] as number) * y + (m[8] as number) * z) * t.scale;
  }
}

/** Apply to directions (xyz triples, stride 3 or 4 for tangents) in place; no scaling. */
export function transformDirections(t: ExportTransform, a: Float32Array, stride: 3 | 4): void {
  const m = t.m as number[];
  const flip = t.flipWinding;
  for (let i = 0; i + 2 < a.length; i += stride) {
    const x = a[i] as number;
    const y = a[i + 1] as number;
    const z = a[i + 2] as number;
    a[i] = (m[0] as number) * x + (m[1] as number) * y + (m[2] as number) * z;
    a[i + 1] = (m[3] as number) * x + (m[4] as number) * y + (m[5] as number) * z;
    a[i + 2] = (m[6] as number) * x + (m[7] as number) * y + (m[8] as number) * z;
    if (stride === 4 && flip) a[i + 3] = -(a[i + 3] as number);
  }
}

export function transformPoint(t: ExportTransform, p: readonly [number, number, number]): [number, number, number] {
  const a = new Float32Array(p);
  transformPoints(t, a);
  return [a[0] as number, a[1] as number, a[2] as number];
}
