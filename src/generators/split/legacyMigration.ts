import type { NodeParams, ParamState } from '@/contracts/params';
import { clamp } from '@/core/math';

/** Legacy ids that belonged to the removed polyline fork (`Tip behavior = Fork`, Split chance / spread / balance / position / depth). */
const LEGACY_IDS = ['splitChance', 'splitSpread', 'splitBalance', 'splitStart', 'splitMaxDepth'] as const;

const numberOf = (params: NodeParams, id: string): number | undefined => {
  const v = params[id]?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};

const setValue = (out: NodeParams, id: string, value: number): void => {
  const cur: ParamState | undefined = out[id];
  out[id] = cur ? { ...cur, value } : { value };
};

/**
 * Maps the legacy split parameters of Trunk / Branch / Root / Spine nodes onto Skin > Splits (the one shared split engine):
 * - `splitChance` -> `splitsChance`, `splitSpread` -> `splitsSpread1` and `splitsSpread2` (half angle each side),
 *   `splitBalance` -> `splitsBalance` (clamped 0..1),
 * - `termination: fork` -> Taper with `splitsChance = 1` (the old fork mode always forked),
 * - `splitStart` and `splitMaxDepth` are dropped: a split is always at the tip, chains of splits come from Extend parent.
 * Values already present under the new ids are never overwritten. Nodes without legacy data are returned unchanged (same object).
 */
export function migrateLegacySplitParams(params: NodeParams): NodeParams {
  const termination = params.termination?.value;
  const isFork = typeof termination === 'string' && termination.toLowerCase() === 'fork';
  if (!isFork && !LEGACY_IDS.some((id) => id in params)) return params;

  const out: NodeParams = { ...params };
  const legacyChance = numberOf(params, 'splitChance');
  const chance = isFork ? 1 : legacyChance;
  if (chance !== undefined && chance > 0 && out.splitsChance === undefined) setValue(out, 'splitsChance', clamp(chance, 0, 1));

  const spread = numberOf(params, 'splitSpread');
  if (spread !== undefined && chance !== undefined && chance > 0) {
    if (out.splitsSpread1 === undefined) setValue(out, 'splitsSpread1', clamp(spread, 0, 80));
    if (out.splitsSpread2 === undefined) setValue(out, 'splitsSpread2', clamp(spread, 0, 80));
  }
  const balance = numberOf(params, 'splitBalance');
  if (balance !== undefined && chance !== undefined && chance > 0 && out.splitsBalance === undefined) {
    setValue(out, 'splitsBalance', clamp(balance, 0, 1));
  }
  if (isFork) out.termination = { ...(params.termination as ParamState), value: 'taper' };
  for (const id of LEGACY_IDS) delete out[id];
  return out;
}
