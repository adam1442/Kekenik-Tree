import type { CutoutAnchor, CutoutMesh, MeshFlipMode, StraightenMode } from '@/contracts/material';
import { cardPointAt, cardSampleAt, type CardPose } from '@/geometry/cardPose';
import { norm, rotate, type V3 } from '@/geometry/math3';
import type { Frame } from '@/geometry/rigid';
import type { Point2 } from './triangulate';

/**
 * Cutout attachment frame — pure math, no DOM, no three.js. See docs/CUTOUT_ATTACHMENT.md.
 *
 * UV space: u right, v up. "Card metres" = UV scaled by the metric (metres per UV unit, u and v separately).
 * The Straighten axis is a polyline; its FIRST point is the attachment pivot (local origin), its first segment
 * defines the local +Y. Every card point is expressed as (d, s): `s` = arc length along the axis (the axis becomes a
 * straight line along +Y) and `d` = signed lateral distance (+X is to the right of the axis direction).
 * Local frame: +Y = base tangent, +Z = card normal (texture front), +X = Y x Z.
 */


export const ATTACH_VERSION = 1;

export interface CutoutMetric {
  /** Metres per UV unit along u / v. */
  w: number;
  h: number;
}

/** UV unit square -> metres for a cutout used standalone (Meshes panel, Mesh instances): bounds x mesh scale. */
export function defaultMetric(cutout: CutoutMesh): CutoutMetric {
  const s = Math.max(0.001, cutout.scale || 1);
  return { w: Math.max(1e-4, cutout.boundsMeters?.[0] || 1) * s, h: Math.max(1e-4, cutout.boundsMeters?.[1] || 1) * s };
}

/** Placed cards: UV unit square -> node width x height (metres), times the mesh Scale of the Meshes panel. */
export function placedMetric(cutout: CutoutMesh, width: number, height: number): CutoutMetric {
  const s = Math.max(0.001, cutout.scale || 1);
  return { w: Math.max(1e-5, width * s), h: Math.max(1e-5, height * s) };
}

/** Mesh-asset Transform > Flip as per-axis signs. 'None' and 'X Y Z' (the idle label) are identity. */
export function flipSigns(flip: MeshFlipMode | undefined): V3 {
  if (!flip || flip === 'None' || flip === 'X Y Z') return [1, 1, 1];
  return [flip.includes('X') ? -1 : 1, flip.includes('Y') ? -1 : 1, flip.includes('Z') ? -1 : 1];
}

export interface ResolvedAnchor {
  id: string;
  name: string;
  /** Index in axis order (0 = nearest the base). */
  index: number;
  uv: Point2;
  /** Unit direction in the card plane (card metres, before straightening). */
  direction: Point2;
  /** Anchor position in the straightened, flipped local frame (metres). */
  localPosition: V3;
  /** Unit direction in the straightened, flipped local frame. */
  localDirection: V3;
  /** Roll in radians. */
  roll: number;
  scale: number;
  tags: readonly string[];
  /** Arc-length position along the axis (m) and normalised 0..1. */
  s: number;
  axisT: number;
}

export interface CutoutFrame {
  metric: CutoutMetric;
  mode: StraightenMode;
  /** Axis polyline in UV (>= 2 points; exactly 2 in linear mode). */
  axisUv: Point2[];
  base: Point2;
  tip: Point2;
  /** Axis polyline relative to the base in card metres. */
  axisM: Point2[];
  segDir: Point2[];
  segLen: number[];
  cum: number[];
  /** Total axis arc length (m). */
  length: number;
  /** Unit direction of the first axis segment (card metres) — used for attachment orientation. */
  baseTangent: Point2;
  /** Unit direction base -> tip (card metres). */
  tipDirection: Point2;
  signs: V3;
  /** True when an odd number of mirror flips is active (winding must be reversed). */
  mirrored: boolean;
  anchors: ResolvedAnchor[];
  /** True when the authored axis was missing / degenerate and the bounding-box default was used. */
  usedDefaultAxis: boolean;
}

const finite2 = (p: unknown): p is Point2 =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Default axis: bottom-centre of the outline's bounding box straight up to the top-centre. */
export function defaultAxisFor(cutout: Pick<CutoutMesh, 'outline'>): Point2[] {
  const pts = (cutout.outline ?? []).filter(finite2);
  if (pts.length === 0) return [[0.5, 0], [0.5, 1]];
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [u, v] of pts) {
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const cu = (minU + maxU) / 2;
  if (maxV - minV < 1e-6) return [[cu, minV], [cu, minV + 1]];
  return [[cu, minV], [cu, maxV]];
}

/** Axis points actually used (authored polyline, first + last in linear mode, or the default). */
export function resolveAxisPoints(cutout: CutoutMesh): { points: Point2[]; mode: StraightenMode; usedDefault: boolean } {
  const mode: StraightenMode = cutout.straightenLinear ? 'linear' : 'curve';
  const raw = Array.isArray(cutout.straightenAxis) ? cutout.straightenAxis.filter(finite2) : [];
  let pts: Point2[] = raw.map((p) => [p[0], p[1]] as Point2);
  if (mode === 'linear' && pts.length >= 2) pts = [pts[0] as Point2, pts[pts.length - 1] as Point2];
  const total = pts.reduce((a, p, i) => (i === 0 ? 0 : a + Math.hypot(p[0] - (pts[i - 1] as Point2)[0], p[1] - (pts[i - 1] as Point2)[1])), 0);
  if (pts.length < 2 || total < 1e-6) return { points: defaultAxisFor(cutout), mode, usedDefault: true };
  return { points: pts, mode, usedDefault: false };
}

function projectOnAxis(f: Pick<CutoutFrame, 'axisM' | 'segDir' | 'segLen' | 'cum'>, r: Point2): { s: number; d: number; seg: number } {
  let best = { s: 0, d: 0, seg: 0, dist: Infinity };
  const n = f.segDir.length;
  for (let i = 0; i < n; i++) {
    const a = f.axisM[i] as Point2;
    const t = f.segDir[i] as Point2;
    let along = (r[0] - a[0]) * t[0] + (r[1] - a[1]) * t[1];
    const lo = i === 0 ? -Infinity : 0;
    const hi = i === n - 1 ? Infinity : (f.segLen[i] as number);
    along = Math.min(hi, Math.max(lo, along));
    const px = a[0] + t[0] * along;
    const py = a[1] + t[1] * along;
    const dx = r[0] - px;
    const dy = r[1] - py;
    const dist = Math.hypot(dx, dy);
    if (dist < best.dist - 1e-12) {
      // right of the direction (ty, -tx): (0, 1) -> (1, 0)
      best = { s: (f.cum[i] as number) + along, d: dx * t[1] - dy * t[0], seg: i, dist };
    }
  }
  return { s: best.s, d: best.d, seg: best.seg };
}

/** Build the attachment frame of a cutout for a given UV -> metres metric. Never throws. */
export function buildCutoutFrame(cutout: CutoutMesh, metric: CutoutMetric = defaultMetric(cutout)): CutoutFrame {
  const { points, mode, usedDefault } = resolveAxisPoints(cutout);
  const base = points[0] as Point2;
  const tip = points[points.length - 1] as Point2;
  const axisM: Point2[] = points.map((p) => [(p[0] - base[0]) * metric.w, (p[1] - base[1]) * metric.h]);
  const segDir: Point2[] = [];
  const segLen: number[] = [];
  const cum: number[] = [0];
  for (let i = 0; i + 1 < axisM.length; i++) {
    const a = axisM[i] as Point2;
    const b = axisM[i + 1] as Point2;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segLen.push(l);
    segDir.push(l < 1e-12 ? ((segDir[i - 1] as Point2 | undefined) ?? [0, 1]) : [(b[0] - a[0]) / l, (b[1] - a[1]) / l]);
    cum.push((cum[i] as number) + l);
  }
  const length = Math.max(1e-6, cum[cum.length - 1] as number);
  const last = axisM[axisM.length - 1] as Point2;
  const tl = Math.hypot(last[0], last[1]);
  const signs = flipSigns(cutout.transform?.flip);
  const frame: CutoutFrame = {
    metric,
    mode,
    axisUv: points,
    base,
    tip,
    axisM,
    segDir,
    segLen,
    cum,
    length,
    baseTangent: segDir[0] as Point2,
    tipDirection: tl < 1e-12 ? (segDir[0] as Point2) : [last[0] / tl, last[1] / tl],
    signs,
    mirrored: signs[0] * signs[1] * signs[2] < 0,
    anchors: [],
    usedDefaultAxis: usedDefault,
  };
  frame.anchors = resolveAnchors(cutout, frame);
  return frame;
}

/** (s, d) of a UV point relative to the straighten axis. */
export function straightenCoords(frame: CutoutFrame, uv: Point2): { s: number; d: number } {
  const r: Point2 = [(uv[0] - frame.base[0]) * frame.metric.w, (uv[1] - frame.base[1]) * frame.metric.h];
  const { s, d } = projectOnAxis(frame, r);
  return { s, d };
}

/** UV point -> local metres (x = lateral, y = along the straightened axis, z = 0), Transform > Flip applied. */
export function uvToLocal(frame: CutoutFrame, uv: Point2): V3 {
  const { s, d } = straightenCoords(frame, uv);
  return [d * frame.signs[0], s * frame.signs[1], 0];
}

function resolveAnchors(cutout: CutoutMesh, frame: CutoutFrame): ResolvedAnchor[] {
  const list = (Array.isArray(cutout.anchors) ? cutout.anchors : []).filter((a) => finite2(a?.uv));
  const out: ResolvedAnchor[] = list.map((a, i) => {
    const uv: Point2 = [a.uv[0], a.uv[1]];
    const h: Point2 = finite2(a.handleUv) ? [a.handleUv[0], a.handleUv[1]] : [uv[0], uv[1] + 0.09];
    let dm: Point2 = [(h[0] - uv[0]) * frame.metric.w, (h[1] - uv[1]) * frame.metric.h];
    const dl = Math.hypot(dm[0], dm[1]);
    dm = dl < 1e-9 ? [0, 1] : [dm[0] / dl, dm[1] / dl];
    const r: Point2 = [(uv[0] - frame.base[0]) * frame.metric.w, (uv[1] - frame.base[1]) * frame.metric.h];
    const pr = projectOnAxis(frame, r);
    const t = frame.segDir[pr.seg] as Point2;
    // direction expressed in the (right, tangent) basis of the axis segment under the anchor
    const ld: V3 = [(dm[0] * t[1] - dm[1] * t[0]) * frame.signs[0], (dm[0] * t[0] + dm[1] * t[1]) * frame.signs[1], 0];
    return {
      id: a.id,
      name: a.name || `Anchor ${i + 1}`,
      index: i,
      uv,
      direction: dm,
      localPosition: [pr.d * frame.signs[0], pr.s * frame.signs[1], 0],
      localDirection: ld,
      roll: ((a.roll ?? 0) * Math.PI) / 180,
      scale: a.scale !== undefined && Number.isFinite(a.scale) && a.scale > 0 ? a.scale : 1,
      tags: a.tags ?? [],
      s: pr.s,
      axisT: Math.min(1, Math.max(0, pr.s / frame.length)),
    };
  });
  out.sort((a, b) => a.axisT - b.axisT || a.index - b.index);
  out.forEach((a, i) => (a.index = i));
  return out;
}

/** Anchor frame in WORLD space for a card with the given pose (bend/straighten deformation already applied). */
export function anchorFrameInPose(pose: CardPose, a: ResolvedAnchor): Frame & { scale: number } {
  const { p, sample } = cardPointAt(pose, a.localPosition[0], a.localPosition[1]);
  const [dx, dy] = a.localDirection;
  const dir = norm([sample.side[0] * dx + sample.axis[0] * dy, sample.side[1] * dx + sample.axis[1] * dy, sample.side[2] * dx + sample.axis[2] * dy], sample.axis);
  const up = a.roll !== 0 ? rotate(sample.normal, dir, a.roll) : sample.normal;
  return { position: p, direction: dir, up, scale: a.scale };
}

/** Base frame (instance origin) in world space for a pose. */
export function baseFrameInPose(pose: CardPose): Frame {
  const s = cardSampleAt(pose, 0);
  return { position: s.spine, direction: s.axis, up: s.normal };
}

export function cardPoseFor(
  frame: CutoutFrame,
  base: { origin: V3; axis: V3; side: V3 },
  deform: { bend?: number; twist?: number; fold?: number; curl?: number } = {},
): CardPose {
  return {
    origin: base.origin,
    axis: base.axis,
    side: base.side,
    bend: deform.bend ?? 0,
    twist: deform.twist ?? 0,
    fold: deform.fold ?? 0,
    curl: deform.curl ?? 0,
    length: frame.length,
    halfWidth: Math.max(1e-5, frame.metric.w * 0.5),
  };
}

// ---- authoring helpers & migration -------------------------------------------------------------------------------

/** Re-order `cutout.anchors` by their position along the axis (stable). */
export function sortAnchorsByAxisT(cutout: CutoutMesh): void {
  if (!Array.isArray(cutout.anchors) || cutout.anchors.length < 2) return;
  const frame = buildCutoutFrame(cutout);
  const rank = new Map(frame.anchors.map((a) => [a.id, a.index]));
  cutout.anchors = [...cutout.anchors].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * Migration / normalisation of attachment data. Old projects (no `attachVersion`) get the bounding-box fallback axis
 * when theirs is missing, anchors with broken handles are repaired, anchors are ordered along the axis and the
 * pivot is synchronised with the axis base. Idempotent, never throws.
 */
export function ensureCutoutAttachmentData(cutout: CutoutMesh): void {
  if (!Array.isArray(cutout.straightenAxis) || cutout.straightenAxis.filter(finite2).length < 2) {
    cutout.straightenAxis = defaultAxisFor(cutout);
  } else {
    cutout.straightenAxis = cutout.straightenAxis.filter(finite2).map((p) => [p[0], p[1]] as Point2);
  }
  cutout.straightenLinear = cutout.straightenLinear === true;
  const anchors: CutoutAnchor[] = [];
  for (const a of Array.isArray(cutout.anchors) ? cutout.anchors : []) {
    if (!a || !finite2(a.uv)) continue;
    anchors.push({ ...a, uv: [a.uv[0], a.uv[1]], handleUv: finite2(a.handleUv) ? [a.handleUv[0], a.handleUv[1]] : [a.uv[0], a.uv[1] + 0.09] });
  }
  cutout.anchors = anchors;
  const { points } = resolveAxisPoints(cutout);
  cutout.pivot = [(points[0] as Point2)[0], (points[0] as Point2)[1]];
  sortAnchorsByAxisT(cutout);
  cutout.attachVersion = ATTACH_VERSION;
}

function pointInPolygon(p: Point2, poly: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i] as Point2;
    const b = poly[j] as Point2;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function distToPolygon(p: Point2, poly: readonly Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point2;
    const b = poly[(i + 1) % poly.length] as Point2;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 < 1e-12 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t)));
  }
  return best;
}

/** Human-readable warnings shown in the Edit Mesh status area. */
export function attachmentWarnings(cutout: CutoutMesh): string[] {
  const out: string[] = [];
  const raw = Array.isArray(cutout.straightenAxis) ? cutout.straightenAxis.filter(finite2) : [];
  if (raw.length < 2) out.push('Straighten axis needs at least 2 points (default axis used).');
  const { points } = resolveAxisPoints(cutout);
  const poly = (cutout.outline ?? []).filter(finite2) as Point2[];
  if (poly.length >= 3) {
    const tol = 0.012;
    const outside = (p: Point2): boolean => !pointInPolygon(p, poly) && distToPolygon(p, poly) > tol;
    if (outside(points[0] as Point2)) out.push('Axis base is outside the outline.');
    const off = (cutout.anchors ?? []).filter((a) => finite2(a.uv) && outside(a.uv)).length;
    if (off > 0) out.push(`${off} anchor${off > 1 ? 's are' : ' is'} off the mesh.`);
  }
  return out;
}

/** Base point + tangent angle (degrees, 0 = up/+v, positive toward +u) for the status area. */
export function axisStatus(cutout: CutoutMesh): { base: Point2; angleDeg: number; tipAngleDeg: number; points: number } {
  const f = buildCutoutFrame(cutout, { w: 1, h: 1 });
  const ang = (d: Point2): number => (Math.atan2(d[0], d[1]) * 180) / Math.PI;
  return { base: f.base, angleDeg: ang(f.baseTangent), tipAngleDeg: ang(f.tipDirection), points: f.axisUv.length };
}
