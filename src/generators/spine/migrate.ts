import type { NodeParams } from '@/contracts/params';

const numberOf = (params: NodeParams, id: string): number | undefined => {
  const v = params[id]?.value;
  return typeof v === 'number' ? v : undefined;
};

/**
 * Brings the Spine / Segments parameters of Trunk, Branch, Root and Spine nodes saved before the Segments tab to the current ids:
 * - `lengthRelative` is folded into `+ % of parent` (the old switch used 35 % of the parent when the percentage was 0),
 * - `matchOneVTile` became a checkbox (`yes` -> on),
 * - `pruneGround` became a 0..1 strength (on -> 1),
 * - the Skin `lengthSegments` override moved into the Segments tab (`segments` with no relative part),
 * - projects with `+ Relative` segments keep their layout through `lengthStyle` = Legacy (relative segments per metre),
 * - an active zigzag keeps its old spacing (one corner per length segment) through `Segment length` > `+ Relative`.
 * Idempotent: running it twice gives the same result.
 */
export function migrateSpineParams(params: NodeParams): NodeParams {
  const out: NodeParams = { ...params };
  const relative = out.lengthRelative?.value === true;
  const percent = numberOf(out, 'lengthPercent') ?? 0;
  if (relative && percent <= 0) out.lengthPercent = { ...(out.lengthPercent ?? { value: 0 }), value: 0.35 };
  delete out.lengthRelative;

  if (typeof out.matchOneVTile?.value === 'string') out.matchOneVTile = { value: out.matchOneVTile.value === 'yes' };
  if (typeof out.pruneGround?.value === 'boolean') out.pruneGround = { value: out.pruneGround.value ? 1 : 0 };

  const fixed = numberOf(out, 'lengthSegments');
  if (fixed !== undefined && fixed > 0) {
    out.segments = { ...(out.segments ?? { value: fixed }), value: Math.round(fixed) };
    out.relativeSegments = { value: 0 };
  }
  delete out.lengthSegments;

  if ((numberOf(out, 'zigzag') ?? 0) > 0 && !('zigzagLengthRelative' in out)) {
    const segments = Math.max(2, numberOf(out, 'segments') ?? 10);
    out.zigzagLengthRelative = { value: Math.min(1, 1 / segments) };
  }
  // Relative segments used to be per metre of length: keep that layout for projects that use them.
  if ((numberOf(out, 'relativeSegments') ?? 0) > 0 && !('lengthStyle' in out)) out.lengthStyle = { value: 'legacy' };
  return out;
}
