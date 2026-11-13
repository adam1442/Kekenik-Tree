import { evaluateCurve, type Curve } from '@/contracts/curve';
import type { MeshData } from '@/contracts/mesh';
import type { MaskDef } from '@/contracts/material';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { AttachmentBuilder } from '@/geometry/attachments';
import { buildLeafMesh, cardAttachments, type LeafCard } from '@/geometry/leafMesher';
import { instanceKey } from '@/instances/keys';
import { anchorWind, orientAtAnchor, planAnchorSlots, type AnchorSlot } from './cutoutPlacement';
import { cross, dot, len, norm, rotate, type V3 } from '@/geometry/math3';
import { MeshAccumulator, newVertex, type VertexAttrs } from '@/geometry/meshAccumulator';
import { evaluateMask } from '@/materials/masks';
import { getMaterialSource, resolveCutoutForLeaf, resolveUvAreaRect } from '@/materials/materialSource';
import { prepareParentBranch, sampleParentBranch } from './frames';
import { atlasRect, emptyFoliage, foliageOutput, isActive, leafAo, leafTint, parentOf, parentWind, pickLeafType, varied } from './foliageCommon';

export const MAX_DECORATIONS = 30_000;
const UP: V3 = [0, 0, 1];

/** One planned decoration (everything the mesher needs; also what the tests inspect). */
export interface DecoItem {
  branchId: number;
  parentPoint: number;
  /** Point on the parent axis, unit tangent of the parent and outward direction of the surface at this item. */
  axisPoint: V3;
  tangent: V3;
  outward: V3;
  /** Surface normal (outward tilted by the taper). */
  normal: V3;
  radius: number;
  /** d(radius)/d(arc length) of the parent. */
  taper: number;
  /** Final centre position: axisPoint + outward * (radius + offset). */
  position: V3;
  offset: number;
  /** Angle around the parent in degrees (parent frame or world compass, as chosen). */
  angleDeg: number;
  u: number;
  width: number;
  height: number;
  roll: number;
  tilt: number;
  rng: Rng;
  index: number;
  /** Set for items planted on a parent anchor: the slot and its anchor scale / axisT. */
  anchor?: { slot: AnchorSlot; scale: number };
}

const curveOf = (p: NodeParams, id: string): Curve | undefined => (p[id]?.curve ?? undefined) as Curve | undefined;
const curveAt = (c: Curve | undefined, t: number): number => (c ? evaluateCurve(c, t) : 1);

/** Parent mask used by the Mask section (null = none selected). */
export const resolveDecorationMask = (p: NodeParams): MaskDef | null => {
  const id = getString(p, 'decoMask', '');
  return id ? getMaterialSource()?.masks().find((m) => m.id === id) ?? null : null;
};

/** Cache-key extra: the chosen mask definition (so editing a mask re-evaluates only decoration nodes). */
export const decorationDependencyKey = (p: NodeParams): string => {
  const m = resolveDecorationMask(p);
  return m ? JSON.stringify(m) : getString(p, 'decoMask', '') ? 'missing' : '';
};

function boundsZ(sk: Skeleton): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < sk.count; i++) {
    const z = sk.position[i * 3 + 2] as number;
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  return hi > lo ? [lo, hi] : [0, 1];
}

/** Distribution, boundaries, angle range, spacing mode, mask, overlap and LOD of the Decoration node. Deterministic. */
export function planDecorations(ctx: NodeContext, parent: Skeleton, p: NodeParams, inputs?: NodeInputs): DecoItem[] {
  const slots = inputs ? planAnchorSlots(ctx, inputs, parent, p, getNumber(p, 'number', 12)) : null;
  if (slots) return anchorItems(slots.slice(0, MAX_DECORATIONS), p);
  const out: DecoItem[] = [];
  const first = getNumber(p, 'first', 0);
  const last = Math.max(first, getNumber(p, 'last', 1));
  const range = (p.decoAngle?.value as number[] | undefined) ?? [-180, 180];
  const a0 = Math.min(range[0] ?? -180, range[1] ?? 180);
  const a1 = Math.max(range[0] ?? -180, range[1] ?? 180);
  const world = getString(p, 'decoAngleRef', 'parent-frame') === 'world';
  const spacing = getString(p, 'decoSpacing', 'random');
  const jumble = getNumber(p, 'jumble', 0.3);
  const mask = resolveDecorationMask(p);
  const maskStrength = getNumber(p, 'decoMaskStrength', 1);
  const [zLo, zHi] = boundsZ(parent);
  const relative = getString(p, 'decoSizeMode', 'absolute') === 'relative-to-radius';
  const wCurve = curveOf(p, relative ? 'decoWidthRel' : 'decoWidth');
  const hCurve = curveOf(p, relative ? 'decoHeightRel' : 'decoHeight');
  const cull = getNumber(p, 'lodCull', 0.5) * (Math.min(Math.max(ctx.lod, 0), 3) / 3);
  const overlap = getNumber(p, 'decoOverlap', 1);
  const clusterCount = Math.max(1, Math.round(getNumber(p, 'decoClusterCount', 5)));
  const clusterSize = getNumber(p, 'decoClusterSize', 0.15);
  const offset = getNumber(p, 'decoOffset', 0.003);

  for (const pb of parent.branches) {
    if (pb.count < 2) continue;
    if (out.length >= MAX_DECORATIONS) break;
    ctx.cancel.throwIfCancelled();
    const prep = prepareParentBranch(parent, pb);
    const rng = ctx.rng.fork(`deco:${pb.id}`);
    const L = Math.max(1e-4, pb.length);
    let n = getString(p, 'decoMode', 'number') === 'density' ? getNumber(p, 'decoDensity', 6) * (last - first) * L : getNumber(p, 'number', 12);
    n = Math.min(MAX_DECORATIONS - out.length, Math.floor(n + rng.fork('count').next()));
    const accepted: { s: number; a: number; w: number; h: number }[] = [];
    const clusterCenters: { u: number; ang: number }[] = [];
    for (let i = 0; i < n; i++) {
      const r = rng.fork(`i:${i}`);
      let u: number;
      let ang: number;
      if (spacing === 'even') {
        u = first + (last - first) * ((i + 0.5) / Math.max(1, n));
        ang = a0 + (a1 - a0) * ((i * 0.6180339887) % 1);
        u += ((r.next() - 0.5) * jumble * (last - first)) / Math.max(1, n);
        ang += (r.next() - 0.5) * jumble * (a1 - a0) * 0.25;
      } else if (spacing === 'clustered') {
        const ci = Math.floor(i / clusterCount);
        let c = clusterCenters[ci];
        if (!c) {
          const cr = rng.fork(`c:${ci}`);
          c = { u: first + (last - first) * cr.next(), ang: a0 + (a1 - a0) * cr.next() };
          clusterCenters[ci] = c;
        }
        const rad = Math.max(0.02, prep.radii[Math.min(prep.radii.length - 1, Math.round(c.u * (prep.radii.length - 1)))] ?? 0.05);
        u = c.u + ((r.next() * 2 - 1) * clusterSize) / L;
        ang = c.ang + ((r.next() * 2 - 1) * clusterSize * 180) / (Math.PI * rad);
      } else {
        u = first + (last - first) * r.next();
        ang = a0 + (a1 - a0) * r.next();
      }
      u = Math.min(last, Math.max(first, u));
      ang = Math.min(a1, Math.max(a0, ang));
      const cullDraw = r.next();
      const maskDraw = r.next();
      if (cullDraw < cull) continue;
      const s = sampleParentBranch(prep, u);
      const T = norm(s.tangent as V3);
      let outward: V3;
      if (world) {
        const d: V3 = [Math.cos(deg2rad(ang)), Math.sin(deg2rad(ang)), 0];
        const dt = dot(d, T);
        const proj: V3 = [d[0] - T[0] * dt, d[1] - T[1] * dt, d[2] - T[2] * dt];
        if (len(proj) < 0.25) continue;
        outward = norm(proj);
      } else {
        const az = deg2rad(ang);
        outward = norm([s.normal[0] * Math.cos(az) + s.binormal[0] * Math.sin(az), s.normal[1] * Math.cos(az) + s.binormal[1] * Math.sin(az), s.normal[2] * Math.cos(az) + s.binormal[2] * Math.sin(az)]);
      }
      const du = Math.min(0.03, 0.5 / L);
      const rA = sampleParentBranch(prep, Math.max(0, s.u - du)).radius;
      const rB = sampleParentBranch(prep, Math.min(1, s.u + du)).radius;
      const taper = (rB - rA) / (Math.max(1e-6, Math.min(1, s.u + du) - Math.max(0, s.u - du)) * L);
      const normal = norm([outward[0] - T[0] * taper, outward[1] - T[1] * taper, outward[2] - T[2] * taper], outward);
      const radius = Math.max(1e-4, s.radius);
      const axisPoint: V3 = [s.position[0], s.position[1], s.position[2]];
      const position: V3 = [axisPoint[0] + outward[0] * (radius + offset), axisPoint[1] + outward[1] * (radius + offset), axisPoint[2] + outward[2] * (radius + offset)];
      if (mask && maskStrength > 0) {
        const m = evaluateMask(mask, { position, normal, height: (position[2] - zLo) / (zHi - zLo) });
        if (maskDraw >= 1 - maskStrength + maskStrength * m) continue;
      }
      const scale = varied(r, p, 'decoScale', 1);
      const tt = s.u;
      const base = relative ? radius : 1;
      const width = Math.max(1e-4, varied(r, p, relative ? 'decoWidthRel' : 'decoWidth', relative ? 1.5 : 0.2) * curveAt(wCurve, tt) * base * scale);
      const height = Math.max(1e-4, varied(r, p, relative ? 'decoHeightRel' : 'decoHeight', relative ? 1.5 : 0.2) * curveAt(hCurve, tt) * base * scale);
      if (overlap < 1) {
        const arc = deg2rad(ang) * radius;
        const clash = accepted.some((q) => {
          const ds = Math.abs(q.s - s.u * L);
          let da = Math.abs(q.a - arc);
          da = Math.min(da, 2 * Math.PI * radius - da);
          return ds < ((q.h + height) / 2) * (1 - overlap) && da < ((q.w + width) / 2) * (1 - overlap);
        });
        if (clash) continue;
        accepted.push({ s: s.u * L, a: arc, w: width, h: height });
      }
      const roll = deg2rad(varied(r, p, 'decoRoll', 0)) + (r.next() * 2 - 1) * Math.PI * getNumber(p, 'decoRandomRotation', 1);
      const tilt = deg2rad(varied(r, p, 'decoTilt', 0));
      out.push({ branchId: pb.id, parentPoint: s.parentPoint, axisPoint, tangent: T, outward, normal, radius, taper, position, offset, angleDeg: ang, u: s.u, width, height, roll, tilt, rng: r.fork('mat'), index: out.length });
    }
  }
  return out;
}

/** Decoration items planted on parent anchors: base on the anchor, height axis along the anchor direction. */
function anchorItems(slots: readonly AnchorSlot[], p: NodeParams): DecoItem[] {
  return slots.map((slot, i) => {
    const r = slot.rng.fork('deco');
    const f = slot.frame;
    const o = orientAtAnchor(slot, p, r.fork('o'), null);
    const scale = varied(r, p, 'decoScale', 1) * o.scale;
    const width = Math.max(1e-4, varied(r, p, 'decoWidth', 0.2) * scale);
    const height = Math.max(1e-4, varied(r, p, 'decoHeight', 0.2) * scale);
    const pos: V3 = [f.position[0], f.position[1], f.position[2]];
    return {
      branchId: slot.branch.id,
      parentPoint: slot.branch.start,
      axisPoint: pos,
      tangent: o.axis,
      outward: o.facing,
      normal: o.facing,
      radius: 1e-4,
      taper: 0,
      position: pos,
      offset: 0,
      angleDeg: 0,
      u: f.axisT,
      width,
      height,
      roll: deg2rad(varied(r, p, 'decoRoll', 0)),
      tilt: 0,
      rng: r.fork('mat'),
      index: i,
      anchor: { slot, scale: o.scale },
    };
  });
}

/** Planar basis of a card for the non-conforming alignment modes: face normal, height axis and side axis. */
function planarBasis(it: DecoItem, alignMode: string, heightMode: string, rng: Rng): { n: V3; axis: V3; side: V3 } {
  // Anchor items follow the anchor frame exactly: normal = anchor facing, height axis = anchor direction.
  const align = it.anchor ? 'surface-normal' : alignMode;
  const heightAxis = it.anchor ? 'along-parent' : heightMode;
  const n = align === 'up' ? UP : align === 'radial' ? it.outward : it.normal;
  const want: V3 = heightAxis === 'up' ? UP : heightAxis === 'down' ? [0, 0, -1] : heightAxis === 'random' ? norm([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]) : it.tangent;
  let axis: V3 = [want[0] - n[0] * dot(want, n), want[1] - n[1] * dot(want, n), want[2] - n[2] * dot(want, n)];
  if (len(axis) < 0.2) axis = [it.tangent[0] - n[0] * dot(it.tangent, n), it.tangent[1] - n[1] * dot(it.tangent, n), it.tangent[2] - n[2] * dot(it.tangent, n)];
  axis = norm(axis, [1, 0, 0]);
  const rolledAxis = rotate(axis, n, it.roll);
  return { n, axis: rolledAxis, side: norm(cross(rolledAxis, n), [1, 0, 0]) };
}

/** Grid position of a card vertex at plane offsets (a across, b along) in metres. */
export function cardVertex(it: DecoItem, a: number, b: number, conform: boolean, basis: { n: V3; axis: V3; side: V3 }, psi: number): { p: V3; ref: V3 } {
  const lift = Math.sin(it.tilt) * (b + it.height * 0.5);
  if (!conform) {
    const lp = basis.n;
    return {
      p: [it.position[0] + basis.side[0] * a + basis.axis[0] * b + lp[0] * lift, it.position[1] + basis.side[1] * a + basis.axis[1] * b + lp[1] * lift, it.position[2] + basis.side[2] * a + basis.axis[2] * b + lp[2] * lift],
      ref: basis.n,
    };
  }
  const ar: V3 = [a * Math.cos(psi) - b * Math.sin(psi), 0, a * Math.sin(psi) + b * Math.cos(psi)];
  const aa = ar[0];
  const bb = ar[2];
  const rr = Math.max(1e-4, it.radius + it.taper * bb);
  const o = rotate(it.outward, it.tangent, aa / Math.max(1e-4, it.radius + it.offset));
  const dist = rr + it.offset + lift;
  return {
    p: [it.axisPoint[0] + it.tangent[0] * bb + o[0] * dist, it.axisPoint[1] + it.tangent[1] * bb + o[1] * dist, it.axisPoint[2] + it.tangent[2] * bb + o[2] * dist],
    ref: o,
  };
}

function buildCards(ctx: NodeContext, parent: Skeleton, items: readonly DecoItem[], p: NodeParams): MeshData {
  const acc = new MeshAccumulator();
  const keep = Math.pow(1 - Math.min(0.9, Math.max(0, getNumber(p, 'lodSegments', 0.5))) * 0.4, Math.min(Math.max(ctx.lod, 0), 3));
  const W = Math.max(1, Math.round(getNumber(p, 'decoSegmentsW', 3) * keep));
  const H = Math.max(1, Math.round(getNumber(p, 'decoSegmentsH', 2) * keep));
  const conform = getBool(p, 'decoConform', true) && !items.some((i) => i.anchor);
  const align = getString(p, 'decoAlign', 'surface-normal');
  const heightAxis = getString(p, 'decoHeightAxis', 'along-parent');
  const flutter = getNumber(p, 'flutterAmount', 0.5);
  const slots = new Map<string, number[]>();
  const info: { material: string; atlas: [number, number, number, number]; color: V3 }[] = [];
  items.forEach((it, i) => {
    const type = pickLeafType(it.rng, p, 'leaf');
    info.push({ material: type.material, atlas: resolveUvAreaRect(type.material, 'leaf', it.rng) ?? atlasRect(p, it.rng, i), color: leafTint(it.rng, p) });
    const list = slots.get(type.material);
    if (list) list.push(i);
    else slots.set(type.material, [i]);
  });
  const cells = Math.max(1, Math.ceil(Math.sqrt(items.length)));
  for (const [material, list] of slots) {
    acc.beginSlot(material);
    for (const i of list) {
      const it = items[i] as DecoItem;
      const meta = info[i] as (typeof info)[number];
      const basis = planarBasis(it, align, heightAxis, it.rng);
      // Conforming cards rotate their (around, along) frame so the Height axis option still applies.
      let psi = it.roll;
      if (conform && heightAxis !== 'along-parent') {
        const around = norm(cross(it.tangent, it.outward));
        const ref: V3 = heightAxis === 'random' ? [it.rng.range(-1, 1), it.rng.range(-1, 1), 0.2] : UP;
        const ua = dot(ref, around);
        const ub = dot(ref, it.tangent);
        psi += Math.atan2(-ua, ub) + (heightAxis === 'down' ? Math.PI : 0);
      }
      const wind = parentWind(parent, it.parentPoint, i * 13 + 3);
      const [u0, v0, u1, v1] = meta.atlas;
      const base = acc.vertexCount;
      const C = W + 1;
      const grid: { p: V3; ref: V3 }[] = [];
      for (let jr = 0; jr <= H; jr++) {
        for (let jc = 0; jc <= W; jc++) grid.push(cardVertex(it, (jc / W - 0.5) * it.width, (jr / H - 0.5) * it.height, conform, basis, psi));
      }
      const g = (r: number, c: number): V3 => (grid[Math.min(H, Math.max(0, r)) * C + Math.min(W, Math.max(0, c))] as { p: V3 }).p;
      const ao = leafAo(p, 0.4, it.rng);
      for (let jr = 0; jr <= H; jr++) {
        for (let jc = 0; jc <= W; jc++) {
          const cur = grid[jr * C + jc] as { p: V3; ref: V3 };
          const dPu: V3 = [g(jr, jc + 1)[0] - g(jr, jc - 1)[0], g(jr, jc + 1)[1] - g(jr, jc - 1)[1], g(jr, jc + 1)[2] - g(jr, jc - 1)[2]];
          const dPv: V3 = [g(jr + 1, jc)[0] - g(jr - 1, jc)[0], g(jr + 1, jc)[1] - g(jr - 1, jc)[1], g(jr + 1, jc)[2] - g(jr - 1, jc)[2]];
          let nrm = norm(cross(dPu, dPv), cur.ref);
          if (dot(nrm, cur.ref) < 0) nrm = [-nrm[0], -nrm[1], -nrm[2]];
          const tg = norm(dPu, [1, 0, 0]);
          const vx: VertexAttrs = newVertex();
          vx.px = cur.p[0]; vx.py = cur.p[1]; vx.pz = cur.p[2];
          vx.nx = nrm[0]; vx.ny = nrm[1]; vx.nz = nrm[2];
          vx.tx = tg[0]; vx.ty = tg[1]; vx.tz = tg[2];
          vx.tw = dot(cross(nrm, tg), dPv) >= 0 ? 1 : -1;
          vx.u = u0 + (u1 - u0) * (jc / W);
          vx.v = v0 + (v1 - v0) * (jr / H);
          vx.u1 = ((i % cells) + jc / W) / cells;
          vx.v1 = (Math.floor(i / cells) + jr / H) / cells;
          vx.r = meta.color[0] * ao; vx.g = meta.color[1] * ao; vx.b = meta.color[2] * ao;
          vx.ao = ao;
          vx.pvx = it.axisPoint[0]; vx.pvy = it.axisPoint[1]; vx.pvz = it.axisPoint[2];
          // Wind is inherited from the parent (the decoration follows its bending); only the free edge flutters a little.
          const f = jr / H;
          vx.w0 = wind[0]; vx.w1 = wind[1]; vx.w2 = Math.min(1, wind[2] + (1 - wind[2]) * 0.25 * flutter * f * f); vx.w3 = wind[3];
          acc.addVertex(vx);
        }
      }
      for (let jr = 0; jr < H; jr++) {
        for (let jc = 0; jc < W; jc++) {
          const a0 = base + jr * C + jc;
          acc.addTriangle(a0, a0 + 1, a0 + C);
          acc.addTriangle(a0 + 1, a0 + C + 1, a0 + C);
        }
      }
    }
  }
  return acc.build('leaf', true);
}

function buildCutoutCards(ctx: NodeContext, parent: Skeleton, items: readonly DecoItem[], p: NodeParams): LeafCard[] {
  const align = getString(p, 'decoAlign', 'surface-normal');
  const heightAxis = getString(p, 'decoHeightAxis', 'along-parent');
  return items.map((it, i) => {
    const type = pickLeafType(it.rng, p, 'leaf');
    const basis = planarBasis(it, align, heightAxis, it.rng);
    const bent = Math.sin(it.tilt);
    const wind = parentWind(parent, it.parentPoint, i * 13 + 3);
    return {
      // The cutout's Straighten base (attachment pivot) sits on the surface point, growing along the height axis.
      origin: [it.position[0], it.position[1], it.position[2]],
      axis: basis.axis,
      side: basis.side,
      length: it.height,
      width: it.width,
      bend: bent,
      fold: 0,
      curl: 0,
      twist: 0,
      segLength: 1,
      segWidth: 1,
      outline: 'rect',
      color: leafTint(it.rng, p),
      ao: leafAo(p, 0.4, it.rng),
      atlas: resolveUvAreaRect(type.material, 'leaf', it.rng) ?? atlasRect(p, it.rng, i),
      materialId: type.material,
      pivot: it.axisPoint,
      wind: it.anchor ? anchorWind(wind, it.anchor.slot.frame.axisT) : wind,
      cutout: resolveCutoutForLeaf(type.material, type.mesh, it.rng),
      lod: ctx.lod,
    };
  });
}

export function evaluateDecoration(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const items = planDecorations(ctx, parent, p, inputs);
  if (items.length === 0) return emptyFoliage(parent, ctx.seed);
  const cutout = getString(p, 'decoShape', 'card') === 'cutout-mesh';
  const att = new AttachmentBuilder(ctx.nodeId);
  let mesh: MeshData;
  if (cutout) {
    const cards = buildCutoutCards(ctx, parent, items, p);
    mesh = buildLeafMesh(cards, { defaultMaterial: 'leaf' });
    cards.forEach((card, i) => {
      const ca = cardAttachments(card);
      if (!ca) return;
      const it = items[i] as DecoItem;
      att.beginInstance(it.anchor ? it.anchor.slot.key : instanceKey(ctx.nodeId, it.branchId, i, 0), i, ca.base);
      for (const a of ca.anchors) att.addFrame(a.frame, a.scale, a.anchor.id, a.anchor.index, a.anchor.axisT, a.anchor.tags);
    });
  } else mesh = buildCards(ctx, parent, items, p);
  const sb = new SkeletonBuilder();
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  for (const it of items) {
    sb.beginBranch(it.branchId, it.parentPoint, gen);
    sb.addPoint(it.position[0], it.position[1], it.position[2], 0.001);
    sb.addPoint(it.position[0] + it.normal[0] * 0.01, it.position[1] + it.normal[1] * 0.01, it.position[2] + it.normal[2] * 0.01, 0.001);
    sb.endBranch();
  }
  return foliageOutput(sb.build(), parent, mesh, items.length, ctx.seed, att.build());
}
