import type { OpenEnd, OpenEndFrame, OpenEndSelector, Vec3 } from './splitMath';

/**
 * Generation > Extend parent (pure): which open ends of a parent branch does an extension generator continue, how many nodes does it
 * create per end, and the guards around that. Nothing here touches the graph, so every rule is unit-tested on plain data.
 */

/** The Extend parent types, in the order of the inspector enum. */
export type ExtendSelectType = 'none' | OpenEndSelector | 'bottom';

/** An open end as the selection sees it: `broken` marks ends created by Break (a split replaces the break at the tip). */
export interface SelectableEnd extends OpenEnd {
  broken?: boolean;
}

/** One extension node to create: the end it continues, its index among the nodes of that end and its RNG stream key. */
export interface SelectedOpenEnd<T extends SelectableEnd = SelectableEnd> {
  end: T;
  /** Position of the end in the list that was passed in (the Bottom end uses -1). */
  endIndex: number;
  /** 0 .. count - 1. */
  index: number;
  /** Fork key of the extension's own RNG stream; depends only on the end's side and the index, never on other ends or seeds. */
  seedKey: string;
}

/** Counts per end are limited to 1..8. */
export const EXTEND_COUNT_MIN = 1;
export const EXTEND_COUNT_MAX = 8;
/** Longest chain trunk -> split generator -> split generator ... that is evaluated. */
export const MAX_EXTENSION_DEPTH = 32;

export const clampExtendCount = (count: number): number =>
  Number.isFinite(count) ? Math.min(EXTEND_COUNT_MAX, Math.max(EXTEND_COUNT_MIN, Math.round(count))) : EXTEND_COUNT_MIN;

/** RNG fork key of extension `index` on an end (side 0 = unsplit / broken end). */
export const extensionSeedKey = (side: 0 | 1 | 2, index: number): string => `ext:s${side}:i${index}`;

/**
 * Whether one open end is taken by `type` (never `none` / `bottom`, those do not read the ends).
 * An unsplit end (side 0) is the single "Split 1" end and counts as Fat, never as Skinny; Breaks only wants an end made by Break.
 */
export function endMatches(type: OpenEndSelector, end: SelectableEnd): boolean {
  const split = end.side === 1 || end.side === 2;
  const fat = end.kind !== undefined ? end.kind === 'fat' : end.fat;
  switch (type) {
    case 'any':
      return true;
    case 'split-1':
      return end.side !== 2;
    case 'split-2':
      return end.side === 2;
    case 'fat':
      return split ? fat : true;
    case 'skinny':
      return split && !fat;
    case 'breaks-only':
      return end.broken === true;
  }
}

/**
 * The open ends a generator extends, each repeated `count` (1-8) times with its own seed key. `base` is the synthetic end at the
 * base of the parent (see {@link bottomOpenEnd}) that Bottom uses instead of the real ends.
 */
export function selectOpenEnds<T extends SelectableEnd>(openEnds: readonly T[], type: ExtendSelectType, count: number, base?: T | null): SelectedOpenEnd<T>[] {
  if (type === 'none') return [];
  const n = clampExtendCount(count);
  const picked: { end: T; endIndex: number }[] = [];
  if (type === 'bottom') {
    if (base) picked.push({ end: base, endIndex: -1 });
  } else {
    for (let i = 0; i < openEnds.length; i++) {
      const end = openEnds[i] as T;
      if (endMatches(type, end)) picked.push({ end, endIndex: i });
    }
  }
  const out: SelectedOpenEnd<T>[] = [];
  for (const p of picked) {
    for (let index = 0; index < n; index++) out.push({ end: p.end, endIndex: p.endIndex, index, seedKey: extensionSeedKey(p.end.side, index) });
  }
  return out;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Synthetic open end at the BASE of a parent: the spine start, pointing back along `-tangent` with the base radius. The frame is
 * flipped consistently: the normal is kept and the binormal becomes `direction x normal`, so `normal x binormal = direction` holds.
 */
export function bottomOpenEnd(position: Vec3, tangent: Vec3, normal: Vec3, radius: number): SelectableEnd {
  const t = unit(tangent);
  const direction: Vec3 = [-t[0], -t[1], -t[2]];
  const n = unit(cross(cross(direction, normal), direction));
  const frame: OpenEndFrame = { normal: n, binormal: unit(cross(direction, n)) };
  return { position, direction, radius, side: 0, fat: true, frame };
}

/** Deviation of an extension's first spine point from the open end it continues. */
export interface JunctionError {
  /** Distance between the positions (metres). */
  dPos: number;
  /** Angle between the directions (degrees). */
  angleDeg: number;
  /** Absolute radius difference (metres). */
  dRadius: number;
}

/** Continuity of an extension start (`position`, `direction`, `radius`) against its open end. */
export function junctionError(end: Pick<OpenEnd, 'position' | 'direction' | 'radius'>, start: Pick<OpenEnd, 'position' | 'direction' | 'radius'>): JunctionError {
  const a = unit(end.direction);
  const b = unit(start.direction);
  const d = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return {
    dPos: Math.hypot(end.position[0] - start.position[0], end.position[1] - start.position[1], end.position[2] - start.position[2]),
    angleDeg: (Math.acos(d) * 180) / Math.PI,
    dRadius: Math.abs(end.radius - start.radius),
  };
}

export interface DepthCheck {
  ok: boolean;
  /** Set when `ok` is false: the message shown on the node. */
  message?: string;
}

/** Recursion guard: an extension chain deeper than {@link MAX_EXTENSION_DEPTH} generations is refused with a clear message. */
export function checkExtensionDepth(depth: number, max = MAX_EXTENSION_DEPTH): DepthCheck {
  if (depth <= max) return { ok: true };
  return { ok: false, message: `Extend parent chain is deeper than ${max} generations; the extensions beyond that depth were not created.` };
}

/**
 * Why a node cannot use Extend parent, or null when it can. Only Branch generators (the Trunk is the first one) have open ends and
 * only Branch, Root, Cap, Leaf mesh and Batched leaf nodes may extend them.
 */
export function extendDisabledReason(childType: string, parentType: string | undefined, childTypes: ReadonlySet<string>, parentTypes: ReadonlySet<string>): string | null {
  if (!childTypes.has(childType)) return 'Extend parent is only available for Branch, Root, Cap, Leaf mesh and Batched leaf nodes.';
  if (parentType === undefined || !parentTypes.has(parentType)) return 'Extend parent needs a Branch, Trunk or Root generator as the parent node: only those have open ends.';
  return null;
}
