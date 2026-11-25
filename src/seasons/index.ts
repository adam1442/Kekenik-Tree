import { curveToLUT, sampleCurveLUT } from '@/contracts/curve';
import type { ForceDef } from '@/contracts/material';
import type { SeasonState } from '@/contracts/season';
import { getNumber, type NodeParams } from '@/contracts/params';
import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';

/**
 * Seasons (SpeedTree "Seasons"). The Tree node owns the Season slider (0..1); every generator turns it into a
 * "transition value" from its own Season properties and picks materials with it. Everything here is pure and
 * deterministic: random variance is drawn from the caller's seeded RNG.
 */

/** Hidden node parameter the generator wrapper fills in (see `withGenerationCommon`). */
export const SEASON_STATE_PARAM = 'seasonState';

export type { SeasonState };

export const NEUTRAL_SEASON: SeasonState = { value: 0, shift: 0, showDropped: false, exportDropped: false };

export const clampSeason = (v: number): number => (Number.isFinite(v) ? clamp(v, 0, 1) : 0);

/** Season of the Tree node params (`season`, `showDroppedLeaves`, `exportDroppedLeaves`). */
export function seasonFromTreeParams(params: NodeParams): SeasonState {
  return {
    value: clampSeason(getNumber(params, 'season', 0)),
    shift: 0,
    showDropped: params.showDroppedLeaves?.value === true,
    exportDropped: params.exportDroppedLeaves?.value === true,
  };
}

export function packSeasonState(s: SeasonState): number[] {
  return [s.value, s.shift, s.showDropped ? 1 : 0, s.exportDropped ? 1 : 0];
}

/** State written into the params of a generator by the wrapper; null when the node has no Tree above it. */
export function readSeasonState(params: NodeParams): SeasonState | null {
  const v = params[SEASON_STATE_PARAM]?.value;
  if (!Array.isArray(v) || v.length < 4) return null;
  return { value: clampSeason(v[0] as number), shift: v[1] as number, showDropped: v[2] === 1, exportDropped: v[3] === 1 };
}

export function withSeasonState(params: NodeParams, state: SeasonState): NodeParams {
  return { ...params, [SEASON_STATE_PARAM]: { value: packSeasonState(state) } };
}

/**
 * Transition value 0..1: 0 = start of the node's year, 1 = end of its life. `start` and `shift` delay (positive) or
 * advance (negative) it, `timeScale` 1 = one slider sweep per year. `light` > 0 delays it (Season light force).
 */
export function transitionValue(season: number, start: number, timeScale: number, shift = 0, light = 0): number {
  return clamp((season - start - shift - light) * Math.max(0, timeScale), 0, 1);
}

/** Descendant offset of a node, drawn once with its variance (0 for generators without the property). */
export function sampleDescendantOffset(params: NodeParams, rng: Rng): number {
  const st = params.seasonDescendantOffset;
  if (!st || typeof st.value !== 'number') return 0;
  const variance = st.variance ?? 0;
  return st.value + (variance > 0 ? (rng.next() * 2 - 1) * variance : 0);
}

export interface SeasonSampler {
  /** Wrapper state; null when the node was evaluated outside a Tree (the library season is used then). */
  readonly state: SeasonState | null;
  /** Branch gravity (Season > Gravity). */
  readonly gravity: number;
  /** Transition value of the node itself (no per-element variance), undefined without state. */
  nodeValue(): number | undefined;
  /** Transition value of one element (leaf, frond, card ...) with variance and the curves along the parent. */
  value(rng: Rng, u?: number, light?: number): number | undefined;
  /** Drop time of one leaf (variance applied). */
  dropTime(rng: Rng): number;
  /** True when a leaf with transition value `t` is drawn on the ground. */
  dropped(t: number | undefined, rng: Rng): boolean;
}

interface Channel {
  base: number;
  variance: number;
  lut: Float32Array | null;
}

function channel(params: NodeParams, id: string, fallback: number): Channel {
  const st = params[id];
  return {
    base: typeof st?.value === 'number' ? st.value : fallback,
    variance: st?.variance ?? 0,
    lut: st?.curve ? curveToLUT(st.curve, 64) : null,
  };
}

const sampleChannel = (c: Channel, rng: Rng | null, u: number, span: number): number => {
  const scaled = c.base * (c.lut ? sampleCurveLUT(c.lut, u) : 1);
  return c.variance > 0 && rng ? scaled + (rng.next() * 2 - 1) * c.variance * span : scaled;
};

export function createSeasonSampler(params: NodeParams): SeasonSampler {
  const state = readSeasonState(params);
  const start = channel(params, 'seasonStartOffset', 0);
  const scale = channel(params, 'seasonTimeScale', 1);
  const drop = channel(params, 'seasonDropTime', 1);
  const gravity = getNumber(params, 'seasonGravity', 0);
  const value = (rng: Rng | null, u: number, light: number): number | undefined =>
    state ? transitionValue(state.value, sampleChannel(start, rng, u, 1), sampleChannel(scale, rng, u, 1), state.shift, light) : undefined;
  const dropTime = (rng: Rng): number => clamp(sampleChannel(drop, rng, 0, 1), 0, 1);
  return {
    state,
    gravity,
    nodeValue: () => value(null, 0, 0),
    value: (rng, u = 0, light = 0) => value(rng.fork('season'), u, light),
    dropTime: (rng) => dropTime(rng.fork('seasonDrop')),
    dropped: (t, rng) => state !== null && state.showDropped && t !== undefined && t >= dropTime(rng.fork('seasonDrop')) - 1e-9,
  };
}

/** Node-level transition value for material resolution (undefined without a Tree above the node). */
export const seasonNodeValue = (params: NodeParams): number | undefined => createSeasonSampler(params).nodeValue();

// ---- Season forces --------------------------------------------------------------------------------------------------

export const SEASON_LIGHT_FORCE = 'seasonLight';
export const SEASON_WIND_FORCE = 'seasonWind';

export function isSeasonForce(def: Pick<ForceDef, 'type'>): boolean {
  return def.type === SEASON_LIGHT_FORCE || def.type === SEASON_WIND_FORCE;
}

type V3 = readonly [number, number, number];

function vec(params: NodeParams, id: string, fallback: V3): V3 {
  const v = params[id]?.value;
  return Array.isArray(v) && v.length >= 3 ? [v[0] as number, v[1] as number, v[2] as number] : fallback;
}

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Season light: leaves growing towards the arrow change sooner. Returns the delay to pass to `transitionValue`
 * (negative = earlier), 0 without such a force. `axis` is the unit growth direction of the leaf.
 */
export function seasonLightDelay(forces: readonly ForceDef[], axis: V3): number {
  let delay = 0;
  for (const f of forces) {
    if (f.type !== SEASON_LIGHT_FORCE || !f.enabled || f.params.active?.value === false) continue;
    const d = unit(vec(f.params, 'direction', [0, 0, 1]));
    const toward = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
    delay -= getNumber(f.params, 'strength', 1) * clamp(getNumber(f.params, 'influence', 1), 0, 1) * toward * 0.25;
  }
  return delay;
}

/** Season wind: ground offset (x, y) of a dropped leaf, `r` in 0..1 is a per-leaf random factor. */
export function seasonWindOffset(forces: readonly ForceDef[], r: number): [number, number] {
  let x = 0;
  let y = 0;
  for (const f of forces) {
    if (f.type !== SEASON_WIND_FORCE || !f.enabled || f.params.active?.value === false) continue;
    const d = unit(vec(f.params, 'direction', [1, 0, 0]));
    const dist = getNumber(f.params, 'strength', 1) * getNumber(f.params, 'distance', 2) * (0.3 + 0.7 * r);
    x += d[0] * dist;
    y += d[1] * dist;
  }
  return [x, y];
}

/** A gravity force the branch generators apply while their material transitions (Season > Gravity x transition). */
export function seasonGravityForce(id: string, strength: number): ForceDef {
  return { id, name: 'Season gravity', type: 'gravity', enabled: true, params: { strength: { value: strength }, influence: { value: 1 }, stiffness: { value: 0.5 } } };
}
