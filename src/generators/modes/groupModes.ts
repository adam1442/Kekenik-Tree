import { inBounds, MAX_GROUPS, paritySide, record, TAU } from './shared';
import type { IntervalRequest, ModeFrame, PhyllotaxyRequest, PhyllotaxyStyle, PlacementRecord } from './types';

/** Number of groups used by Phyllotaxy when Internode length is 0 and Limit is unlimited. */
const FIT_GROUPS = 8;
/** Smallest allowed distance between two groups, metres. */
const MIN_INTERNODE = 0.001;

/** Nodes per group of a Phyllotaxy style. */
export function nodesPerGroup(style: PhyllotaxyStyle, childrenPerNode: number): number {
  switch (style) {
    case 'opposite-distichous':
    case 'opposite-decussate':
    case 'opposite-random':
      return 2;
    case 'whorled':
      return Math.max(1, Math.round(childrenPerNode));
    default:
      return 1;
  }
}

/** Rotation of a whole group (before Spiral and the order of the nodes inside it). */
function groupRoll(style: PhyllotaxyStyle, g: number, frame: ModeFrame): number {
  switch (style) {
    case 'opposite-decussate':
      return g * (Math.PI / 2);
    case 'opposite-random':
    case 'alternating-random':
      return frame.rng.fork(`gr:${g}`).next() * TAU;
    case 'alternating-distichous':
      return g * Math.PI;
    default:
      return 0;
  }
}

function dropByLod(frame: ModeFrame, g: number, m: number): boolean {
  return frame.lodKeep < 1 && frame.rng.fork(`lod:${g}:${m}`).next() > frame.lodKeep;
}

interface Group {
  t: number;
  /** Lengthwise distance to the neighbouring group, normalised to the parent. */
  gap: number;
}

/**
 * Phyllotaxy: groups of nodes placed every `internode` metres (world space) walking from Last towards First; the first group
 * sits exactly at Last. The style decides how many nodes a group has and how groups are turned against each other.
 * With `internode` = 0 the `limit` groups (8 when unlimited) are spread evenly between Last and First instead.
 */
export function phyllotaxy(frame: ModeFrame, req: PhyllotaxyRequest): PlacementRecord[] {
  const length = frame.parentLength;
  if (length <= 0) return [];
  const sp = Math.max(0, frame.last - frame.first);
  const per = nodesPerGroup(req.style, req.childrenPerNode);
  const limit = req.limit > 0 ? Math.round(req.limit) : Infinity;

  const groups: Group[] = [];
  if (req.internode <= 0) {
    const n = Math.min(Number.isFinite(limit) ? limit : FIT_GROUPS, MAX_GROUPS);
    const gap = n > 1 ? sp / (n - 1) : sp;
    for (let g = 0; g < n; g++) groups.push({ t: n === 1 ? frame.last : frame.last - g * gap, gap });
  } else {
    const gap = Math.max(MIN_INTERNODE, req.internode) / length;
    const n = Math.min(Math.floor(sp / gap + 1e-9) + 1, limit, MAX_GROUPS);
    for (let g = 0; g < n; g++) groups.push({ t: frame.last - g * gap, gap });
  }

  const maxGroups = Math.ceil(frame.maxCount / per);
  const base = frame.rollBase + frame.branchPhase;
  const out: PlacementRecord[] = [];
  for (let g = 0; g < groups.length && g < maxGroups; g++) {
    const grp = groups[g] as Group;
    const rollG = base + groupRoll(req.style, g, frame) + g * req.spiral;
    for (let m = 0; m < per && out.length < frame.maxCount; m++) {
      if (dropByLod(frame, g, m)) continue;
      const rng = frame.rng.fork(`n:${g}:${m}`);
      let roll = rollG + (m * TAU) / per;
      if (req.alignStyle === 'individual') roll += (rng.next() * 2 - 1) * (Math.PI / per);
      const t = grp.t + (rng.next() * 2 - 1) * req.spread * grp.gap + frame.positionOffset;
      out.push(record(inBounds(frame, t), roll, g, paritySide(g, m)));
    }
  }
  return out;
}

/**
 * Interval: groups of `count` nodes walking from Last towards First. The first group is exactly at Last (there is no
 * guarantee a group lands on First). The distance to the next group is `frequency` x curve, so a low curve value packs the
 * groups tighter there. `balance` turns every other group by half the angular gap so it fills the gaps of the previous group.
 */
export function interval(frame: ModeFrame, req: IntervalRequest): PlacementRecord[] {
  const length = frame.parentLength;
  if (length <= 0) return [];
  const sp = Math.max(0, frame.last - frame.first);
  const per = Math.max(1, Math.round(req.count));
  const limit = req.limit > 0 ? Math.round(req.limit) : Infinity;
  const maxGroups = Math.min(Math.ceil(frame.maxCount / per), limit, MAX_GROUPS);
  const balance = Math.min(1, Math.max(0, req.balance));
  const base = frame.rollBase + frame.branchPhase;

  const out: PlacementRecord[] = [];
  let t = frame.last;
  for (let g = 0; g < maxGroups; g++) {
    const x = sp > 1e-9 ? Math.min(1, Math.max(0, (t - frame.first) / sp)) : 1;
    const gap = Math.max(MIN_INTERNODE, req.frequency * req.frequencyCurve(x)) / length;
    const rollG = base + g * req.spiral + (g % 2) * balance * (Math.PI / per);
    for (let m = 0; m < per && out.length < frame.maxCount; m++) {
      if (dropByLod(frame, g, m)) continue;
      const rng = frame.rng.fork(`n:${g}:${m}`);
      let roll = rollG + (m * TAU) / per;
      if (req.alignStyle === 'individual') roll += (rng.next() * 2 - 1) * (Math.PI / per);
      const tn = t + (rng.next() * 2 - 1) * req.spread * gap + frame.positionOffset;
      out.push(record(inBounds(frame, tn), roll, g, paritySide(g, m)));
    }
    t -= gap;
    if (t < frame.first - 1e-9) break;
  }
  return out;
}
