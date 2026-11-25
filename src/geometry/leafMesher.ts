import type { CutoutMesh, LodLevel } from '@/contracts/material';
import type { LeafLightingSettings } from '@/contracts/lighting';
import { windPhase1Of, type MeshData } from '@/contracts/mesh';
import { windPhase1OfTuple, type WindTuple } from './windAttributes';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import { anchorFrameInPose, baseFrameInPose, buildCutoutFrame, cardPoseFor, placedMetric, type ResolvedAnchor } from '@/materials/cutouts/frame';
import type { Frame } from './rigid';
import { cross, dot, len, mul, norm, perpendicular, rotate, sub, type V3 } from './math3';
import { deformFrame, deformWorldVertex, isDeformActive, leafLocalFrame, subdivisionPasses, type LeafDeform } from './leafDeform';
import type { ItemColorFn } from './vertexColor';
import { MeshAccumulator, newVertex, type VertexAttrs } from './meshAccumulator';
import { applyLeafLighting, isLightingActive, type LightingGroup } from './leafLighting';
import type { LeafSpan } from './batchedLeaf';

export type LeafOutline = 'rect' | 'oval' | 'pointed' | 'heart';

/** Per-leaf inputs of the Lighting pass (see `applyLeafLighting`). */
export interface CardLight {
  /** Parent puffiness anchor point (null = none). */
  anchor: V3 | null;
  /** Fixed direction of the Surface X / Y / Z anchors (null = none). */
  surface: V3 | null;
  /** Up / Right / Out rotation in radians (variance applied). */
  adjust: V3;
}

/** Identity of the placement a card belongs to (index table of batched meshes). */
export interface CardSource {
  key: number;
  branch: number;
}

/** One leaf blade / card. `axis` runs base -> tip, `side` across the blade (both unit, perpendicular). */
export interface LeafCard {
  origin: V3;
  axis: V3;
  side: V3;
  length: number;
  width: number;
  /** Total bend along the length in radians (+ = toward the blade normal `side x axis`). */
  bend: number;
  /** V-fold across the midrib (radians). */
  fold: number;
  /** Sideways curl (cup) amount. */
  curl: number;
  /** Total twist about the axis along the length (radians). */
  twist: number;
  segLength: number;
  segWidth: number;
  outline: LeafOutline;
  color: V3;
  /** Per-card random tint 0..1 (Kekenik packing R channel). */
  tint?: number;
  /** Material > Vertex Color > Mode: the card colour at 0 (base) .. 1 (tip) along the axis; absent = the plain colour. */
  colorAt?: ItemColorFn;
  ao: number;
  /** UV0 rectangle [u0, v0, u1, v1] inside the atlas. */
  atlas: [number, number, number, number];
  materialId: string;
  /** Wind pivot (leaf base) and weights (hierarchy 0..2, phase). */
  pivot: V3;
  wind: WindTuple;
  /** Optional authored CutoutMesh. When present, emits tight cutout geometry instead of a quad grid. */
  cutout?: CutoutMesh | null;
  /** LOD level 0..3 or an explicit mesh LOD slot for cutout LOD selection. */
  lod?: number | LodLevel;
  /** Mirror the finished card across its local Y axis (the plane through `origin` with normal `side`). */
  mirror?: boolean;
  /** Leaf > Deformation applied to the finished card (vertices and attachment frames). */
  deform?: LeafDeform;
  /** Lighting inputs of this leaf; without them only the settings that need no per-leaf data apply. */
  light?: CardLight;
  /** Source placement, recorded in `LeafMeshOptions.spans`. Cards of one leaf must share the same object. */
  source?: CardSource;
}

export const FULL_ATLAS: [number, number, number, number] = [0, 0, 1, 1];

/** Blade half-width profile 0..1 along the length. Never reaches 0 so tips stay non-degenerate. */
export function widthProfile(outline: LeafOutline, a: number): number {
  switch (outline) {
    case 'oval':
      return Math.max(0.04, Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, a))), 0.7));
    case 'pointed':
      return Math.max(0.04, Math.pow(Math.sin(Math.PI * Math.pow(Math.min(1, Math.max(0, a)), 0.7)), 0.85));
    case 'heart':
      return Math.max(0.04, Math.pow(Math.sin(Math.PI * Math.pow(Math.min(1, Math.max(0, a)), 1.35)), 0.55));
    default:
      return 1;
  }
}

export interface LeafMeshOptions {
  defaultMaterial: string;
  /** Flip triangles whose winding disagrees with the vertex normals (after every deformation and mirroring). */
  fixWinding?: boolean;
  /** Normal-editing pass applied after deformation, mirroring and winding fixes. */
  lighting?: LeafLightingSettings;
  /** Options that do not exist for this generator (Batched leaf: no Unify, no World up). */
  lightingAllow?: { unify?: boolean; worldUp?: boolean };
  /** Output: one span per source leaf (cards with `source`), in emission order. */
  spans?: LeafSpan[];
}

/** Build one mesh from many cards. Cards are grouped per material so the result has one slot per material. */
export function buildLeafMesh(cards: readonly LeafCard[], opts: LeafMeshOptions): MeshData {
  const acc = new MeshAccumulator();
  const order: string[] = [];
  const byMat = new Map<string, number[]>();
  cards.forEach((c, i) => {
    let list = byMat.get(c.materialId);
    if (!list) {
      list = [];
      byMat.set(c.materialId, list);
      order.push(c.materialId);
    }
    list.push(i);
  });
  const cells = Math.max(1, Math.ceil(Math.sqrt(cards.length)));
  const lit = opts.lighting !== undefined && isLightingActive(opts.lighting, { allowUnify: opts.lightingAllow?.unify, allowWorldUp: opts.lightingAllow?.worldUp });
  const groups: LightingGroup[] = [];
  let lastSource: CardSource | undefined;
  for (const mat of order) {
    acc.beginSlot(mat);
    lastSource = undefined;
    for (const i of byMat.get(mat) as number[]) {
      const card = cards[i] as LeafCard;
      const first = acc.vertexCount;
      const firstIndex = acc.indexCount;
      emitCard(acc, card, i, cells);
      if (card.deform && isDeformActive(card.deform)) deformCard(acc, card, first, firstIndex);
      if (card.mirror) acc.mirrorFrom(first, card.origin, norm(card.side));
      if (lit) groups.push(cardGroup(card, first, acc.vertexCount - first, firstIndex, acc.indexCount - firstIndex));
      if (opts.spans && card.source) {
        const last = opts.spans[opts.spans.length - 1];
        if (last && lastSource === card.source) {
          last.vertexCount = acc.vertexCount - last.vertexStart;
          last.indexCount = acc.indexCount - last.indexStart;
        } else {
          opts.spans.push({ key: card.source.key, branch: card.source.branch, materialId: mat, vertexStart: first, vertexCount: acc.vertexCount - first, indexStart: firstIndex, indexCount: acc.indexCount - firstIndex });
        }
        lastSource = card.source;
      }
    }
  }
  if (opts.fixWinding) acc.fixWinding();
  const mesh = acc.build(opts.defaultMaterial, true);
  if (lit && opts.lighting) applyLeafLighting(mesh, opts.lighting, { groups, allowUnify: opts.lightingAllow?.unify, allowWorldUp: opts.lightingAllow?.worldUp });
  return mesh;
}

function cardGroup(card: LeafCard, vertexStart: number, vertexCount: number, indexStart: number, indexCount: number): LightingGroup {
  const f = leafLocalFrame(card.origin, card.axis, card.side);
  return {
    vertexStart,
    vertexCount,
    indexStart,
    indexCount,
    anchor: card.light?.anchor ?? null,
    surface: card.light?.surface ?? null,
    frame: { x: f.x, y: f.y, z: f.z },
    adjust: card.light?.adjust ?? [0, 0, 0],
  };
}

/** Applies the card's Deformation to the vertices emitted since `first` (subdividing sparse cards first). */
function deformCard(acc: MeshAccumulator, card: LeafCard, first: number, firstIndex: number): void {
  const d = card.deform as LeafDeform;
  const passes = subdivisionPasses(acc.vertexCount - first, (acc.indexCount - firstIndex) / 3, d.minVertices);
  for (let i = 0; i < passes; i++) acc.subdivideFrom(firstIndex);
  const frame = leafLocalFrame(card.origin, card.axis, card.side);
  acc.transformFrom(first, (v) => {
    const p = deformWorldVertex(d, frame, [v.px, v.py, v.pz], [v.nx, v.ny, v.nz], v.u, v.v);
    v.px = p[0];
    v.py = p[1];
    v.pz = p[2];
  });
  acc.recomputeNormalsFrom(first, firstIndex);
}

/** Card colour at `t` along the blade: Material > Vertex Color > Mode applied to `base` (plain `base` when neutral). */
function cardColor(c: LeafCard, base: V3, t: number): V3 {
  return c.colorAt ? c.colorAt(base, t) : base;
}

/** 0 (base) .. 1 (tip) position of a world point along the card axis. */
function alongCard(c: LeafCard, x: number, y: number, z: number): number {
  const t = ((x - c.origin[0]) * c.axis[0] + (y - c.origin[1]) * c.axis[1] + (z - c.origin[2]) * c.axis[2]) / Math.max(1e-9, c.length);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function emitCard(acc: MeshAccumulator, c: LeafCard, index: number, cells: number): void {
  if (c.cutout) {
    const cm = buildCutoutGeometry(c.cutout, c.lod ?? 0, {
      origin: c.origin,
      axis: c.axis,
      side: c.side,
      length: c.length,
      width: c.width,
      bend: c.bend,
      fold: c.fold,
      curl: c.curl,
      twist: c.twist,
      color: c.color,
      ao: c.ao,
      atlas: c.atlas,
      materialId: c.materialId,
      wind: c.wind,
      cellIndex: index,
      cellCount: cells,
      applyPanelTransform: false,
    });
    const nv = Math.floor(cm.positions.length / 3);
    if (nv >= 3 && cm.indices.length >= 3) {
      const base = acc.vertexCount;
      for (let i = 0; i < nv; i++) {
        const vx: VertexAttrs = newVertex();
        vx.px = cm.positions[i * 3] as number;
        vx.py = cm.positions[i * 3 + 1] as number;
        vx.pz = cm.positions[i * 3 + 2] as number;
        vx.nx = cm.normals[i * 3] as number;
        vx.ny = cm.normals[i * 3 + 1] as number;
        vx.nz = cm.normals[i * 3 + 2] as number;
        vx.tx = cm.tangents ? (cm.tangents[i * 4] as number) : c.side[0];
        vx.ty = cm.tangents ? (cm.tangents[i * 4 + 1] as number) : c.side[1];
        vx.tz = cm.tangents ? (cm.tangents[i * 4 + 2] as number) : c.side[2];
        vx.tw = cm.tangents ? (cm.tangents[i * 4 + 3] as number) : 1;
        vx.u = cm.uv0[i * 2] as number;
        vx.v = cm.uv0[i * 2 + 1] as number;
        vx.u1 = cm.uv1 ? (cm.uv1[i * 2] as number) : vx.u;
        vx.v1 = cm.uv1 ? (cm.uv1[i * 2 + 1] as number) : vx.v;
        vx.ao = cm.ao ? (cm.ao[i] as number) : c.ao;
        const col = cardColor(c, cm.colors ? [cm.colors[i * 4] as number, cm.colors[i * 4 + 1] as number, cm.colors[i * 4 + 2] as number] : c.color, alongCard(c, vx.px, vx.py, vx.pz));
        const shade = cm.colors ? 1 : c.ao;
        vx.r = col[0] * shade;
        vx.g = col[1] * shade;
        vx.b = col[2] * shade;
        vx.bt = c.tint ?? -1;
        vx.pvx = c.pivot[0];
        vx.pvy = c.pivot[1];
        vx.pvz = c.pivot[2];
        vx.w0 = cm.wind ? (cm.wind.weights[i * 4] as number) : c.wind[0];
        vx.w1 = cm.wind ? (cm.wind.weights[i * 4 + 1] as number) : c.wind[1];
        vx.w2 = cm.wind ? (cm.wind.weights[i * 4 + 2] as number) : c.wind[2];
        vx.w3 = cm.wind ? (cm.wind.weights[i * 4 + 3] as number) : c.wind[3];
        vx.w4 = cm.wind ? windPhase1Of(cm.wind, i) : windPhase1OfTuple(c.wind);
        acc.addVertex(vx);
      }
      for (let t = 0; t < cm.indices.length; t += 3) {
        acc.addTriangle(
          base + (cm.indices[t] as number),
          base + (cm.indices[t + 1] as number),
          base + (cm.indices[t + 2] as number),
        );
      }
      return;
    }
  }
  const sl = Math.max(1, Math.round(c.segLength));
  const sw = Math.max(1, Math.round(c.segWidth));
  const R = sl + 1;
  const V = sw + 1;
  const half = c.width / 2;
  const n0 = norm(cross(c.side, c.axis));
  const pos = new Float32Array(R * V * 3);
  let spine: V3 = [c.origin[0], c.origin[1], c.origin[2]];
  const stepLen = c.length / sl;
  for (let r = 0; r < R; r++) {
    const a = r / sl;
    if (r > 0) {
      const mid = rotate(c.axis, c.side, (c.bend * (r - 0.5)) / sl);
      spine = [spine[0] + mid[0] * stepLen, spine[1] + mid[1] * stepLen, spine[2] + mid[2] * stepLen];
    }
    const dir = rotate(c.axis, c.side, c.bend * a);
    let side = c.side;
    let nn = rotate(n0, c.side, c.bend * a);
    if (c.twist !== 0) {
      side = rotate(side, dir, c.twist * a);
      nn = rotate(nn, dir, c.twist * a);
    }
    const wp = widthProfile(c.outline, a);
    for (let k = 0; k < V; k++) {
      const x = (k / sw * 2 - 1) * half * wp;
      const ax = Math.abs(x);
      const z = ax * Math.sin(c.fold) + (c.curl * x * x) / Math.max(1e-6, half);
      const xx = x * Math.cos(c.fold);
      const o = (r * V + k) * 3;
      pos[o] = spine[0] + side[0] * xx + nn[0] * z;
      pos[o + 1] = spine[1] + side[1] * xx + nn[1] * z;
      pos[o + 2] = spine[2] + side[2] * xx + nn[2] * z;
    }
  }
  const p3 = (r: number, k: number): V3 => {
    const o = (r * V + k) * 3;
    return [pos[o] as number, pos[o + 1] as number, pos[o + 2] as number];
  };
  const base = acc.vertexCount;
  const cx = index % cells;
  const cy = Math.floor(index / cells);
  const [u0, v0, u1, v1] = c.atlas;
  for (let r = 0; r < R; r++) {
    const a = r / sl;
    for (let k = 0; k < V; k++) {
      const kp = Math.min(V - 1, k + 1);
      const kq = Math.max(0, k - 1);
      const rp = Math.min(R - 1, r + 1);
      const rq = Math.max(0, r - 1);
      const dPu = sub(p3(r, kp), p3(r, kq));
      const dPv = sub(p3(rp, k), p3(rq, k));
      let n = norm(cross(dPu, dPv), n0);
      if (len(dPu) < 1e-12 || len(dPv) < 1e-12) n = n0;
      const tg = norm(dPu, c.side);
      const bit = cross(n, tg);
      const o = (r * V + k) * 3;
      const vx: VertexAttrs = newVertex();
      vx.px = pos[o] as number; vx.py = pos[o + 1] as number; vx.pz = pos[o + 2] as number;
      vx.nx = n[0]; vx.ny = n[1]; vx.nz = n[2];
      vx.tx = tg[0]; vx.ty = tg[1]; vx.tz = tg[2];
      vx.tw = dot(bit, dPv) >= 0 ? 1 : -1;
      vx.u = u0 + (k / sw) * (u1 - u0);
      vx.v = v0 + a * (v1 - v0);
      vx.u1 = (cx + k / sw) / cells;
      vx.v1 = (cy + a) / cells;
      const ao = c.ao * (0.85 + 0.15 * a);
      vx.ao = ao;
      const col = cardColor(c, c.color, a);
      vx.r = col[0] * ao; vx.g = col[1] * ao; vx.b = col[2] * ao;
      vx.bt = c.tint ?? -1;
      vx.pvx = c.pivot[0]; vx.pvy = c.pivot[1]; vx.pvz = c.pivot[2];
      vx.w0 = c.wind[0]; vx.w1 = c.wind[1];
      vx.w2 = c.wind[2] + (1 - c.wind[2]) * a * 0.8;
      vx.w3 = c.wind[3];
      vx.w4 = windPhase1OfTuple(c.wind);
      acc.addVertex(vx);
    }
  }
  for (let r = 0; r < sl; r++) {
    for (let k = 0; k < sw; k++) {
      const a0 = base + r * V + k;
      const a1 = a0 + 1;
      const b0 = a0 + V;
      const b1 = b0 + 1;
      acc.addTriangle(a0, a1, b0);
      acc.addTriangle(a1, b1, b0);
    }
  }
}

/** Unit axis/side pair for a blade pointing along `dir` whose face looks toward `facing` as much as possible. */
export function bladeBasis(dir: V3, facing: V3, roll = 0): { axis: V3; side: V3 } {
  const axis = norm(dir);
  // n0 = side x axis  =>  side = axis x n  for a desired normal n perpendicular to axis.
  let n = sub(facing, mul(axis, dot(facing, axis)));
  n = len(n) < 1e-6 ? perpendicular(axis) : norm(n);
  if (roll !== 0) n = rotate(n, axis, roll);
  const side = norm(cross(axis, n));
  return { axis, side };
}

export interface CardAttachments {
  /** Base frame of the card: origin = Straighten axis base, +Y = growth, +Z = card normal. */
  base: Frame;
  /** Anchor frames in world space after bend / twist / fold / curl (so grandchildren follow the deformed card). */
  anchors: { frame: Frame; scale: number; anchor: ResolvedAnchor }[];
}

/** Attachment frames of a placed cutout card (null for plain cards). Uses exactly the pose of `emitCard`. */
export function cardAttachments(c: LeafCard): CardAttachments | null {
  if (!c.cutout) return null;
  const local = c.deform && isDeformActive(c.deform) ? leafLocalFrame(c.origin, c.axis, c.side) : null;
  const frame = buildCutoutFrame(c.cutout, placedMetric(c.cutout, c.width, c.length));
  const pose = cardPoseFor(frame, { origin: c.origin, axis: c.axis, side: c.side }, { bend: c.bend, twist: c.twist, fold: c.fold, curl: c.curl });
  const deformed = (f: Frame): Frame => (local && c.deform ? deformFrame(c.deform, local, f) : f);
  const place = (f: Frame): Frame => {
    const g = deformed(f);
    return c.mirror ? mirrorFrame(g, c.origin, norm(c.side)) : g;
  };
  return {
    base: place(baseFrameInPose(pose)),
    anchors: frame.anchors.map((a) => {
      const f = anchorFrameInPose(pose, a);
      return { frame: place({ position: f.position, direction: f.direction, up: f.up }), scale: f.scale, anchor: a };
    }),
  };
}

/** Reflect a frame across the plane through `origin` with unit `normal`. */
function mirrorFrame(f: Frame, origin: V3, normal: V3): Frame {
  const vec = (v: V3): V3 => {
    const k = 2 * dot(v, normal);
    return [v[0] - k * normal[0], v[1] - k * normal[1], v[2] - k * normal[2]];
  };
  const p = vec(sub(f.position, origin));
  return { position: [origin[0] + p[0], origin[1] + p[1], origin[2] + p[2]], direction: vec(f.direction), up: vec(f.up) };
}
