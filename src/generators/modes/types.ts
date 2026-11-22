import type { Rng } from '@/core/rng';

/** Every `Generation > Mode` value (the option values of the `mode` parameter). */
export type ModeId =
  | 'absolute'
  | 'proportional'
  | 'absolute-steps'
  | 'proportional-steps'
  | 'phyllotaxy'
  | 'interval'
  | 'bifurcation'
  | 'flood'
  | 'parent'
  | 'density'
  | 'classic';

/**
 * One node placed on a parent branch.
 * `t` is the normalised position along the parent (0 = origin, 1 = tip), `roll` the angle around the parent axis in radians,
 * `side` the left / right side (+1 / -1) and `groupIndex` the index of the group (step, internode, bend ...) the node belongs to.
 */
export interface PlacementRecord {
  t: number;
  roll: number;
  side: 1 | -1;
  groupIndex: number;
}

/** A local bend of the parent used by the Bifurcation mode. */
export interface BendPeak {
  t: number;
  /** Turning angle in radians. */
  curvature: number;
  /** Azimuth of the outside of the bend around the parent axis. */
  roll: number;
}

/** Inputs shared by every mode. */
export interface ModeFrame {
  /** Mode-specific random stream (already forked from the parent's stream). */
  rng: Rng;
  /** Boundaries along the parent, `0 <= first <= last <= 1`. */
  first: number;
  last: number;
  /** Arc length of the whole parent in metres. */
  parentLength: number;
  /** Upper bound of the number of nodes that may be returned. */
  maxCount: number;
  /** Fraction (0..1) of the nodes that survive the level of detail. 1 at the highest detail. */
  lodKeep: number;
  /** Rotation added to every roll (rotation + group roll). */
  rollBase: number;
  /** Per-parent phase that decorrelates siblings. */
  branchPhase: number;
  /** Position offset added to every `t` before the boundaries are enforced. */
  positionOffset: number;
  /** Remaps a normalised spacing coordinate (0..1 across First..Last), e.g. the distribution curve. */
  warp: (s: number) => number;
  /** Pulls a position towards the nearest bend (Favor splits); identity when off. */
  attract: (t: number) => number;
  /** Bends of the parent between the boundaries, in any order (Bifurcation only). */
  bends: (thresholdRad: number, minSpacing: number) => BendPeak[];
}

export type CountAlignStyle = 'group' | 'individual' | 'alternate' | 'opposite' | 'spiral';

/** Settings shared by Absolute, Proportional and legacy Density. */
export interface SpreadSettings {
  jumble: number;
  sweep: number;
  alignStyle: CountAlignStyle;
}

export interface AbsoluteRequest extends SpreadSettings {
  mode: 'absolute';
  /** Exact number of nodes (variance and curve already applied). */
  number: number;
}

export interface ProportionalRequest extends SpreadSettings {
  mode: 'proportional';
  /** Nodes per metre of parent length. */
  frequency: number;
}

export interface DensityRequest extends SpreadSettings {
  mode: 'density';
  /** Nodes per metre of the First..Last part of the parent. */
  density: number;
  jitter: number;
}

export interface FloodRequest {
  mode: 'flood';
  number: number;
  sweep: number;
}

export interface ParentRequest {
  mode: 'parent';
  number: number;
  sweep: number;
}

export interface StepsRequest {
  mode: 'absolute-steps' | 'proportional-steps';
  /** Number of steps (absolute) or steps per metre of parent length (proportional). */
  steps: number;
  perStep: number;
  /** Lengthwise spread of the nodes of one step as a fraction of the First..Last span. */
  spread: number;
  /** Rotation of each step relative to the previous one, radians. */
  stepRoll: number;
  /** 0 = random radial positions, 1 = evenly spaced. */
  balance: number;
}

export type PhyllotaxyStyle =
  | 'opposite-distichous'
  | 'opposite-decussate'
  | 'opposite-random'
  | 'alternating-distichous'
  | 'alternating-random'
  | 'whorled';

export const PHYLLOTAXY_STYLES: readonly PhyllotaxyStyle[] = [
  'opposite-distichous',
  'opposite-decussate',
  'opposite-random',
  'alternating-distichous',
  'alternating-random',
  'whorled',
];

export type GroupAlignStyle = 'group' | 'individual';

export interface PhyllotaxyRequest {
  mode: 'phyllotaxy';
  style: PhyllotaxyStyle;
  /** Distance between groups in metres. 0 = fit `limit` groups evenly between Last and First. */
  internode: number;
  /** Nodes per group for the Whorled style. */
  childrenPerNode: number;
  /** Random lengthwise offset of every node, 1 = up to the neighbouring group. */
  spread: number;
  /** Extra rotation per group, radians. */
  spiral: number;
  /** Maximum number of groups, 0 = unlimited. */
  limit: number;
  alignStyle: GroupAlignStyle;
}

export interface IntervalRequest {
  mode: 'interval';
  /** Distance between groups in metres (before the curve). */
  frequency: number;
  /** Multiplies the frequency along the parent (argument: 0 at First, 1 at Last); lower = tighter spacing. */
  frequencyCurve: (s: number) => number;
  /** Nodes per group. */
  count: number;
  spread: number;
  spiral: number;
  limit: number;
  alignStyle: GroupAlignStyle;
  /** 0..1: rotate every other group by half the angular gap so it fills the gaps of the previous one. */
  balance: number;
}

export interface BifurcationRequest {
  mode: 'bifurcation';
  /** Maximum number of nodes. */
  count: number;
  /** Smallest bend (radians) that counts. */
  threshold: number;
  /** Random shift along the parent, 1 = 10 % of the parent length. */
  spread: number;
  /** Minimum distance between two bends as a fraction of the parent. */
  minSpacing: number;
}

export type ModeRequest =
  | AbsoluteRequest
  | ProportionalRequest
  | DensityRequest
  | FloodRequest
  | ParentRequest
  | StepsRequest
  | PhyllotaxyRequest
  | IntervalRequest
  | BifurcationRequest;
