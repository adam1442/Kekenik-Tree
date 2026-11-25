/**
 * Per-vertex wind weights of a frond (pure). The channels are the existing `(level0, level1, level2, phase)` weights: the
 * frond starts from the weights of the parent branch at its attachment and adds its own bend on the leaf level (channel 2).
 *
 *  - Weight: bend weight along the length. `weight(t) * t^power` - the `t^power` factor keeps the base (left end of the
 *    profile = pivot) at exactly 0, so the frond never detaches from its stalk.
 *  - Cross: the motion grows from the spine (0) to the edges (1): `(1 - cross) + cross * |u|`.
 *  - Boost: extra absolute weight added on top (profile: left = base, right = tip), faded in over the first 10 % so the base stays still.
 *  - Ribs: with `ribsBranchWind` the vertices off the spine additionally follow the wind of one level above the parent branch
 *    (`ribsLevel`), growing with the distance from the spine; also faded in over the first 10 %.
 */
export interface FrondWind {
  /** Bend power: stiffness exponent of the base (>= 0.1). */
  power: number;
  weight: (t: number) => number;
  boost: (t: number) => number;
  cross: number;
  ribsBranchWind: boolean;
  ribsWeight: number;
  /** Channel (0..2) that carries "one level above the parent branch". */
  ribsLevel: number;
}

export const DEFAULT_FROND_WIND: Readonly<FrondWind> = {
  power: 1.5,
  weight: () => 1,
  boost: () => 0,
  cross: 0,
  ribsBranchWind: false,
  ribsWeight: 0,
  ribsLevel: 0,
};

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Smooth 0 -> 1 ramp over the first tenth of the length (exactly 0 at the base). */
export function rootFade(t: number): number {
  const x = clamp01(t / 0.1);
  return x * x * (3 - 2 * x);
}

/** Channel that carries the wind of one level above the branch of generation `generation` (the trunk level for the first two). */
export const ribsLevelOf = (generation: number): number => Math.max(0, Math.min(2, Math.round(generation)) - 1);

/**
 * Wind weights of a vertex at arc fraction `t` and lateral position `u` (-1..1, 0 = spine), starting from the parent weights
 * `base`. Writes `out[0..3]`.
 */
export function frondWindAt(base: readonly (number | undefined)[], t: number, u: number, wind: FrondWind, out: number[]): void {
  const tt = clamp01(t);
  const across = Math.min(1, Math.abs(u));
  const fade = rootFade(tt);
  const crossFactor = 1 - wind.cross + wind.cross * across;
  const own = clamp01(Math.max(0, wind.weight(tt)) * Math.pow(tt, Math.max(0.1, wind.power))) * crossFactor;
  const boost = Math.max(0, wind.boost(tt)) * fade * crossFactor;
  const b2 = base[2] as number;
  out[0] = base[0] as number;
  out[1] = base[1] as number;
  out[2] = clamp01(b2 + (1 - b2) * own + boost);
  out[3] = base[3] as number;
  if (wind.ribsBranchWind && wind.ribsWeight > 0 && across > 0) {
    const k = Math.max(0, Math.min(2, Math.round(wind.ribsLevel)));
    const cur = out[k] as number;
    out[k] = clamp01(cur + (1 - cur) * clamp01(wind.ribsWeight) * across * fade);
  }
}
