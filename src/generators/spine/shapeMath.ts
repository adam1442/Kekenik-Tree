const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Share of the noise that Straightness removes at `f` (0 = base, 1 = tip): full strength at the base, fading to nothing at the tip. */
export function straightnessRemoval(f: number, straightness: number): number {
  return clamp01(straightness) * (1 - clamp01(f));
}

/** Share of the noise that is kept at `f`. */
export function noiseKeep(f: number, straightness: number): number {
  return 1 - straightnessRemoval(f, straightness);
}

/** Total turn (radians) that a Parent Curl value of 1 produces over a whole spine. */
export const CURL_RADIANS = 1.4;

/** Turn (radians) of one accurate segment for a Parent Curl axis. The weight grows towards the tip and integrates to `value x CURL_RADIANS`. */
export function curlStepAngle(value: number, f: number, steps: number, influence: number): number {
  return (value * CURL_RADIANS * (0.5 + clamp01(f)) * influence) / Math.max(1, steps);
}

/** Length of one zigzag segment in metres: `(Absolute + Relative x branch length) x profile curve`, never below `minLength`. */
export function zigzagSegmentLength(absolute: number, relative: number, branchLength: number, curveValue: number, minLength: number): number {
  const base = Math.max(0, absolute) + Math.max(0, relative) * Math.max(0, branchLength);
  return Math.max(minLength, base * Math.max(0.05, curveValue));
}

/** Heading kick of the n-th zigzag corner (0-based) for amplitude `a`: +a, then alternately -2a and +2a. */
export function zigzagKick(index: number, a: number): number {
  return index === 0 ? a : index % 2 === 1 ? -2 * a : 2 * a;
}
