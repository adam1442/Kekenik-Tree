import { cross, norm, rotate, type V3 } from './math3';

/**
 * Pose of one cutout card in world space plus its procedural deformation (bend / twist / fold / curl).
 * The card is expressed in the STRAIGHTENED local frame of the cutout: `x` = lateral distance from the Straighten axis,
 * `y` = arc length along it (metres). `origin` is the axis base (attachment pivot), `axis` the growth direction and
 * `side` the lateral direction; the card normal is `side x axis`.
 */
export interface CardPose {
  origin: V3;
  axis: V3;
  side: V3;
  /** Total bend over `length`, radians (+ = toward the card normal `side x axis`). */
  bend: number;
  twist: number;
  fold: number;
  curl: number;
  /** Arc length (m) over which bend/twist are distributed (the Straighten axis length). */
  length: number;
  /** Half of the card width, scales the curl term. */
  halfWidth: number;
}

export interface CardSample {
  /** Point on the (bent) axis. */
  spine: V3;
  axis: V3;
  side: V3;
  normal: V3;
}

/** Frame of the deformed axis at arc length `y`. Straight below the base and beyond the tip. */
export function cardSampleAt(pose: CardPose, y: number): CardSample {
  const L = Math.max(1e-6, pose.length);
  const n0 = norm(cross(pose.side, pose.axis), [0, 0, 1]);
  if (y <= 0 || (Math.abs(pose.bend) < 1e-9 && Math.abs(pose.twist) < 1e-9)) {
    const a = Math.min(1, Math.max(0, y / L));
    const tw = pose.twist * a;
    const axis = pose.axis;
    const side = tw !== 0 ? rotate(pose.side, axis, tw) : pose.side;
    const normal = tw !== 0 ? rotate(n0, axis, tw) : n0;
    return { spine: [pose.origin[0] + axis[0] * y, pose.origin[1] + axis[1] * y, pose.origin[2] + axis[2] * y], axis, side, normal };
  }
  const sc = Math.min(y, L);
  const a = sc / L;
  const ang = pose.bend * a;
  const ratio = Math.abs(ang) > 1e-4 ? Math.sin(ang * 0.5) / (ang * 0.5) : 1;
  const mid = rotate(pose.axis, pose.side, ang * 0.5);
  const localAxis = rotate(pose.axis, pose.side, ang);
  let spine: V3 = [pose.origin[0] + mid[0] * sc * ratio, pose.origin[1] + mid[1] * sc * ratio, pose.origin[2] + mid[2] * sc * ratio];
  if (y > L) spine = [spine[0] + localAxis[0] * (y - L), spine[1] + localAxis[1] * (y - L), spine[2] + localAxis[2] * (y - L)];
  let side = pose.side;
  let normal = rotate(n0, pose.side, ang);
  if (pose.twist !== 0) {
    side = rotate(side, localAxis, pose.twist * a);
    normal = rotate(normal, localAxis, pose.twist * a);
  }
  return { spine, axis: localAxis, side, normal };
}

/** World position of the straightened local point (x lateral, y along the axis) of the deformed card. */
export function cardPointAt(pose: CardPose, x: number, y: number): { p: V3; sample: CardSample } {
  const s = cardSampleAt(pose, y);
  const halfW = Math.max(1e-5, pose.halfWidth);
  const z = Math.abs(x) * Math.sin(pose.fold) + (pose.curl * x * x) / halfW;
  const xx = x * Math.cos(pose.fold);
  return {
    p: [s.spine[0] + s.side[0] * xx + s.normal[0] * z, s.spine[1] + s.side[1] * xx + s.normal[1] * z, s.spine[2] + s.side[2] * xx + s.normal[2] * z],
    sample: s,
  };
}
