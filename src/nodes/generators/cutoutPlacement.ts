import type { AttachmentFrame, AttachmentSet } from '@/contracts/attachment';
import type { NodeContext, NodeInputs } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams, type ParamDef } from '@/contracts/params';
import type { Branch, Skeleton } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { attachmentFramesOf } from '@/geometry/attachments';
import { cross, norm, perpendicular, rotate, type V3 } from '@/geometry/math3';
import { instanceKey } from '@/instances/keys';
import type { CutoutMesh } from '@/contracts/material';
import { section } from '../shared/builders';
import type { ParentSample } from './frames';
import type { Placement } from './foliageCommon';
import { anchorFrameInPose, buildCutoutFrame, cardPoseFor, defaultMetric } from '@/materials/cutouts/frame';
import { composeFrame, type Frame } from '@/geometry/rigid';

/**
 * Anchor-based child placement shared by Leaf, Mesh and Decoration.
 * A parent instance (a cutout card with Anchors) exports `AttachmentFrame`s; a child generator connected below it
 * plants its own cutouts ON those frames: child base = anchor position, child growth axis = anchor direction.
 */

const COND_AUTO = { param: 'attachToAnchors', op: 'ne', value: 'never' } as const;

/** The "Placement" section of the Generation tab (Leaf, Mesh, Decoration). */
export function anchorPlacementParams(): ParamDef[] {
  const s = section('Generation', 'Placement');
  return [
    s.enumOf('attachToAnchors', 'Attach to parent anchors', 'Auto', ['Auto', 'Always', 'Never'], {
      tooltip: 'Auto uses the anchors of the parent cutout when it has any; otherwise the normal distribution along the parent is used.',
    }),
    s.enumOf('anchorMode', 'Anchor mode', 'One per anchor', ['One per anchor', 'Cycle', 'Random', 'Specific index', 'Specific tag'], { visibleIf: COND_AUTO }),
    s.int('anchorNumber', 'Number per anchor', 1, { min: 1, max: 64, visibleIf: COND_AUTO, tooltip: 'Children planted on each selected anchor. Cycle / Random use the node Number per parent instance.' }),
    s.int('anchorIndex', 'Anchor index', 0, { min: 0, max: 1000, visibleIf: { param: 'anchorMode', value: 'specific-index' } }),
    s.string('anchorTag', 'Anchor tag', '', { visibleIf: { param: 'anchorMode', value: 'specific-tag' } }),
    s.float('anchorAlign', 'Align to anchor direction', 1, { min: 0, max: 1, visibleIf: COND_AUTO, tooltip: '1 = child axis follows the anchor direction; 0 = the node\'s own angle settings relative to the anchor.' }),
    s.float('anchorSpread', 'Direction spread', 0, { min: 0, max: 90, unit: '°', visibleIf: COND_AUTO, tooltip: 'Random cone around the anchor direction.' }),
    s.enumOf('anchorRollMode', 'Roll mode', 'Anchor', ['Anchor', 'Random', 'Node'], {
      visibleIf: COND_AUTO,
      tooltip: 'Anchor = face like the anchor (plus the node Roll); Random = random roll around the axis; Node = use the node\'s own Facing setting.',
    }),
    s.bool('anchorUseScale', 'Use anchor scale', true, { visibleIf: COND_AUTO }),
  ];
}

export interface AnchorSlot {
  branch: Branch;
  frame: AttachmentFrame;
  /** Running slot index (also the atlas cell / whorl index of the node). */
  index: number;
  rng: Rng;
  /** Stable key of the child instance planted on the anchor. */
  key: number;
  /** Row of the parent instance in the attachment set. */
  parentRow: number;
}

/** Parent attachment set of the node (`parent` input), if any. */
export function parentAttachments(inputs: NodeInputs): AttachmentSet | undefined {
  const v = inputs.parent?.[0];
  return v && v.kind === 'Structure' ? v.value.attachments : undefined;
}

/**
 * Plan the anchor slots of a node. Returns `null` when the node must use its normal distribution (mode Never, or Auto
 * with a parent that has no anchors). `defaultCount` is the per-parent total used by the Cycle / Random modes.
 */
export function planAnchorSlots(ctx: NodeContext, inputs: NodeInputs, parent: Skeleton, p: NodeParams, defaultCount: number): AnchorSlot[] | null {
  const mode = getString(p, 'attachToAnchors', 'auto');
  if (mode === 'never') return null;
  const set = parentAttachments(inputs);
  let anyFrames = false;
  if (set) for (let i = 0; i < set.instanceCount; i++) if ((set.frameCount[i] as number) > 0) anyFrames = true;
  if (!anyFrames) return mode === 'always' ? [] : null;

  const anchorMode = getString(p, 'anchorMode', 'one-per-anchor');
  const per = Math.max(1, Math.round(getNumber(p, 'anchorNumber', 1)));
  const specific = Math.max(0, Math.round(getNumber(p, 'anchorIndex', 0)));
  const tag = getString(p, 'anchorTag', '');
  const slots: AnchorSlot[] = [];
  const set2 = set as AttachmentSet;
  for (let row = 0; row < set2.instanceCount; row++) {
    const frames = attachmentFramesOf(set2, row);
    if (frames.length === 0) continue;
    const branch = parent.branches.find((b) => b.id === (set2.instanceBranch[row] as number));
    if (!branch) continue;
    ctx.cancel.throwIfCancelled();
    const parentKey = set2.instanceKey[row] as number;
    const rowRng = ctx.rng.fork(`anc:${parentKey}`);
    let chosen: AttachmentFrame[] = [];
    switch (anchorMode) {
      case 'cycle':
        for (let j = 0; j < Math.max(1, Math.round(defaultCount)); j++) chosen.push(frames[j % frames.length] as AttachmentFrame);
        break;
      case 'random': {
        const pick = rowRng.fork('pick');
        for (let j = 0; j < Math.max(1, Math.round(defaultCount)); j++) chosen.push(frames[Math.min(frames.length - 1, Math.floor(pick.next() * frames.length))] as AttachmentFrame);
        break;
      }
      case 'specific-index':
        chosen = [frames[Math.min(frames.length - 1, specific)] as AttachmentFrame];
        break;
      case 'specific-tag':
        chosen = frames.filter((f) => f.tags.includes(tag));
        break;
      default:
        chosen = frames;
    }
    const multiply = anchorMode === 'cycle' || anchorMode === 'random' ? 1 : per;
    chosen.forEach((f, ci) => {
      for (let k = 0; k < multiply; k++) {
        const slot = ci * multiply + k;
        slots.push({ branch, frame: f, index: slots.length, rng: rowRng.fork(`s:${slot}`), key: instanceKey(ctx.nodeId, parentKey, slot, 1), parentRow: row });
      }
    });
  }
  return slots;
}

/** Fake parent sample at an anchor, so the generators' usual `s.tangent / s.normal` maths keeps working. */
export function anchorSample(slot: AnchorSlot): ParentSample {
  const f = slot.frame;
  const t = norm(f.direction);
  const n = norm(f.up);
  return {
    position: f.position,
    tangent: t,
    normal: n,
    binormal: norm(cross(t, n)),
    radius: 0,
    age: 0,
    u: f.axisT,
    parentPoint: slot.branch.start,
    curvature: 0,
  };
}

export interface AnchorOrientation {
  /** Growth direction of the child (unit). */
  axis: V3;
  /** Facing (unit, perpendicular to `axis`) before the node Roll is applied. */
  facing: V3;
  scale: number;
  /** True when the facing must be used as is; false = the caller applies its own Facing rule. */
  useFacing: boolean;
}

/**
 * Child axis / facing at an anchor.
 * `natural` is the direction the node would choose by itself relative to the anchor frame (its angle settings);
 * `anchorAlign` blends from `natural` (0) to the anchor direction (1). `Direction spread` perturbs it in a cone.
 */
export function orientAtAnchor(slot: AnchorSlot, p: NodeParams, rng: Rng, natural: V3 | null): AnchorOrientation {
  const f = slot.frame;
  const dir = norm(f.direction);
  const align = Math.min(1, Math.max(0, getNumber(p, 'anchorAlign', 1)));
  let axis = natural ? norm([natural[0] + (dir[0] - natural[0]) * align, natural[1] + (dir[1] - natural[1]) * align, natural[2] + (dir[2] - natural[2]) * align], dir) : dir;
  const spread = deg2rad(getNumber(p, 'anchorSpread', 0));
  const a = rng.next() * Math.PI * 2;
  const r = Math.sqrt(rng.next()) * spread;
  if (spread > 0) axis = rotate(axis, rotate(perpendicular(axis), axis, a), r);
  const rollMode = getString(p, 'anchorRollMode', 'anchor');
  const up = norm(f.up);
  const proj = (v: V3): V3 => {
    const d = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
    return norm([v[0] - axis[0] * d, v[1] - axis[1] * d, v[2] - axis[2] * d], perpendicular(axis));
  };
  let facing = proj(up);
  if (rollMode === 'random') facing = rotate(facing, axis, rng.next() * Math.PI * 2);
  return {
    axis,
    facing,
    scale: getBool(p, 'anchorUseScale', true) ? f.scale : 1,
    useFacing: rollMode !== 'node',
  };
}

/** Wind weights inherited from the parent at the anchor: the flutter weight grows with the anchor's `axisT`. */
export function anchorWind(base: [number, number, number, number], axisT: number): [number, number, number, number] {
  return [base[0], base[1], Math.min(1, base[2] + (1 - base[2]) * axisT * 0.8), base[3]];
}

/** Turn anchor slots into generator placements (a fake parent sample sits on every anchor). */
export function placementsFromSlots(slots: readonly AnchorSlot[], max: number): Placement[] {
  return slots.slice(0, max).map((slot, i) => {
    const sample = anchorSample(slot);
    return {
      branch: slot.branch,
      sample,
      placement: { slotIndex: slot.index, u: sample.u, azimuthRad: slot.rng.fork('az').next() * Math.PI * 2, isExtension: false },
      rng: slot.rng,
      index: i,
      anchor: slot,
    };
  });
}

export interface InstanceAttachment {
  base: Frame;
  anchors: { frame: Frame; scale: number; id: string; index: number; axisT: number; tags: readonly string[] }[];
}

/**
 * Attachment frames of a rigidly placed standalone cutout (Mesh instances / GPU instancing): the anchors of the
 * undeformed card carried through the instance transform (origin, unit basis x / y / z, uniform scale).
 */
export function rigidInstanceAttachment(cutout: CutoutMesh, origin: V3, x: V3, y: V3, z: V3, scale: number): InstanceAttachment {
  const frame = buildCutoutFrame(cutout, defaultMetric(cutout));
  const pose = cardPoseFor(frame, { origin: [0, 0, 0], axis: [0, 1, 0], side: [1, 0, 0] });
  const m = [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, origin[0], origin[1], origin[2], 1];
  return {
    base: { position: origin, direction: y, up: z },
    anchors: frame.anchors.map((a) => {
      const f = anchorFrameInPose(pose, a);
      const local: Frame = { position: [f.position[0] * scale, f.position[1] * scale, f.position[2] * scale], direction: f.direction, up: f.up };
      const w = composeFrame(m, local);
      return { frame: { position: [w[12] as number, w[13] as number, w[14] as number], direction: [w[4] as number, w[5] as number, w[6] as number], up: [w[8] as number, w[9] as number, w[10] as number] }, scale: a.scale, id: a.id, index: a.index, axisT: a.axisT, tags: a.tags };
    }),
  };
}
