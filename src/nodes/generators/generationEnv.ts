import type { MaskDef } from '@/contracts/material';
import type { NodeContext, NodeDef } from '@/contracts/nodes';
import { getNumber, type NodeParams } from '@/contracts/params';
import type { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import type { Skeleton } from '@/contracts/skeleton';
import {
  knockedOut,
  knockedOutByForce,
  readKnockoutForces,
  type KnockoutForce,
  knockoutChance,
  maskGateKeeps,
  passesForceContainers,
  readForceContainers,
  listNames,
  type ForceContainers,
  type ForceVolume,
} from '@/generators/common';
import { migrateCommonGeneration } from '@/generators/common/migrate';
import type { SeasonState } from '@/contracts/season';
import { sampleDescendantOffset, withSeasonState } from '@/seasons';
import { applySizeScalar, cumulativeSizeScalar, readSizeScalar, SIZE_PARAMS } from '@/generators/common/sizeScalar';
import { extractAttachedForces } from './forcesHook';
import { getMaterialSource } from '@/materials/materialSource';

/** Everything the shared Generation filters need besides the node's own parameters. */
export interface GenerationEnv {
  volumes: readonly ForceVolume[];
  containers: ForceContainers;
  masks: readonly MaskDef[];
  /** Lowest / highest Z of the parent skeleton (the `relative` elevation range of masks). */
  zRange: readonly [number, number];
  /** Node type of the hierarchy parent. */
  parentType: string | undefined;
  /** Attached Knockout forces. */
  knockouts: readonly KnockoutForce[];
}

const NO_Z: readonly [number, number] = [0, 1];

function skeletonZRange(sk: Skeleton | undefined): readonly [number, number] {
  if (!sk || sk.count === 0) return NO_Z;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < sk.count; i++) {
    const z = sk.position[i * 3 + 2] as number;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  return hi > lo ? [lo, hi] : NO_Z;
}

/** The masks assigned in the Masks section that exist in the project library. */
export function resolveGenerationMasks(params: NodeParams): MaskDef[] {
  const ids = listNames(params, 'genMasks', 'genMaskId');
  if (ids.length === 0) return [];
  const all = getMaterialSource()?.masks() ?? [];
  const out: MaskDef[] = [];
  for (const id of ids) {
    const m = all.find((x) => x.id === id);
    if (m) out.push(m);
  }
  return out;
}

export function createGenerationEnv(ctx: NodeContext, params: NodeParams, parent?: Skeleton): GenerationEnv {
  const masks = resolveGenerationMasks(params);
  return {
    volumes: ctx.forceVolumes ?? [],
    containers: readForceContainers(params),
    masks,
    zRange: masks.length > 0 ? skeletonZRange(parent) : NO_Z,
    parentType: ctx.parentType,
    knockouts: ctx.knockoutForces ?? [],
  };
}

/** True when the env can remove nodes by position (Force containers or Masks assigned). */
export const envFiltersByPosition = (env: GenerationEnv | undefined): env is GenerationEnv =>
  env !== undefined && (env.containers.include.length > 0 || env.containers.exclude.length > 0 || env.masks.length > 0 || env.knockouts.length > 0);

/** Force containers, then Masks, for a node at `position` on a surface with the given unit normal. */
export function keepsAtPosition(env: GenerationEnv, position: readonly [number, number, number], normal: readonly [number, number, number]): boolean {
  if (!passesForceContainers(position, env.containers, env.volumes)) return false;
  if (env.knockouts.length > 0 && knockedOutByForce(env.knockouts, normal)) return false;
  if (env.masks.length === 0) return true;
  const [lo, hi] = env.zRange;
  return maskGateKeeps(env.masks, { position, normal, height: (position[2] - lo) / (hi - lo) });
}

/**
 * Knockout, Force containers and Masks for a node placed in the Tree disc (first generation): the position is the stem's
 * base on the ground.
 */
export function keepsRootLevelNode(env: GenerationEnv, params: NodeParams, lod: number, rng: Rng, position: readonly [number, number, number]): boolean {
  const chance = knockoutChance(getNumber(params, 'knockout', 0), getNumber(params, 'knockoutResolution', 0), lod);
  if (chance > 0 && knockedOut(rng.fork('ko'), chance)) return false;
  return !envFiltersByPosition(env) || keepsAtPosition(env, position, [0, 0, 1]);
}

/** Sink of one node: the Sink value with its variance applied (metres into the parent; negative = out of it). */
export function sampledSink(params: NodeParams, rng: Rng): number {
  return sampleVariance(rng.fork('snk'), getNumber(params, 'sink', 0), params.sink?.variance ?? 0);
}

/** Cache-key text: the assigned mask definitions (editing a mask re-evaluates only the generators that use it). */
export function generationDependencyKey(params: NodeParams): string {
  const ids = listNames(params, 'genMasks', 'genMaskId');
  if (ids.length === 0) return '';
  const all = getMaterialSource()?.masks() ?? [];
  return ids.map((id) => JSON.stringify(all.find((m) => m.id === id) ?? 'missing')).join('#');
}

/**
 * Finishes a generator node definition: shared Generation migration (version + 1), the Mask cache key and the Size
 * scalar (own value x the value handed down by the parent, applied to the node's size parameters and handed on).
 */
export function withGenerationCommon(def: NodeDef): NodeDef {
  const previousMigrate = def.migrate;
  const previousKey = def.dependencyKey;
  const evaluate = def.evaluate;
  const hasScalar = def.params.some((p) => p.id === 'sizeScalar');
  return {
    ...def,
    version: (def.version ?? 1) + 1,
    migrate: (params, fromVersion) => migrateCommonGeneration(previousMigrate ? previousMigrate(params, fromVersion) : params),
    dependencyKey: (params) => `${previousKey ? previousKey(params) : ''}|${generationDependencyKey(params)}`,
    evaluate: (ctx, inputs, params) => {
      const pv = inputs.parent?.[0];
      const parentScalar = pv && pv.kind === 'Structure' ? pv.value.sizeScalar : undefined;
      const scalar = hasScalar ? cumulativeSizeScalar(parentScalar, readSizeScalar(params)) : (parentScalar ?? 1);
      const sized = SIZE_PARAMS[def.type] ? applySizeScalar(def.type, params, scalar) : params;
      // Season: the Tree's state plus this node's (and its ancestors') Descendant offset; children inherit it.
      const parentSeason = pv && pv.kind === 'Structure' ? pv.value.season : undefined;
      const season: SeasonState | undefined = parentSeason
        ? { ...parentSeason, shift: parentSeason.shift + sampleDescendantOffset(params, ctx.rng.fork('seasonDescendant')) }
        : undefined;
      const scaled = season ? withSeasonState(sized, season) : sized;
      const tag = (out: Awaited<ReturnType<NodeDef['evaluate']>>): Awaited<ReturnType<NodeDef['evaluate']>> => {
        const own = out.children;
        if (!own || own.kind !== 'Structure') return out;
        return { ...out, children: { kind: 'Structure', value: { ...own.value, kind: def.type, ...(season ? { season } : {}), ...(Math.abs(scalar - 1) > 1e-9 ? { sizeScalar: scalar } : {}) } } };
      };
      const knock = readKnockoutForces(extractAttachedForces(inputs));
      const r = evaluate(knock.length > 0 ? { ...ctx, knockoutForces: knock } : ctx, inputs, scaled);
      return r instanceof Promise ? r.then(tag) : tag(r);
    },
  };
}
