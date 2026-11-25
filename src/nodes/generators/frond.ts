import { getBool, getNumber, getString, type NodeParams, type ParamState } from '@/contracts/params';
import { lodLengthFactor, readGeneratorLod } from './dynamicLodParams';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import type { CutoutMesh } from '@/contracts/material';
import type { Lineage } from '@/contracts/ports';
import { evaluateCurve, type Curve } from '@/contracts/curve';
import { SkeletonBuilder, type Branch, type Skeleton } from '@/contracts/skeleton';
import { deg2rad } from '@/core/math';
import type { LeafLightingSettings } from '@/contracts/lighting';
import { bendPath, buildRibs, netForceDirection, ribbonColumns, type RibSettings, type Ribs } from '@/geometry/frondRibs';
import {
  hasSectionVariance,
  leftRightScales,
  sectionDeltas,
  type SectionDelta,
  type SectionVarianceSettings,
} from '@/geometry/frondVariance';
import { ribsLevelOf, type FrondWind } from '@/geometry/frondWind';
import { isLightingActive, resolveAdjust, resolveLightAnchor, surfaceDirection } from '@/geometry/leafLighting';
import {
  buildFrondMesh,
  unitMeshFromGeometry,
  type FrondLight,
  type FrondSpec,
  type FrondUv,
  type UnitMesh,
} from '@/geometry/frondMesher';
import { chooseMeshLod, filledMeshLods } from '@/geometry/leafLod';
import { anchorFromChain, asAnchorStyle } from '@/geometry/leafPlacement';
import { chainOf } from '@/geometry/lineage';
import { norm, rotate, sub, len, type V3 } from '@/geometry/math3';
import { resamplePath, ribbonWidthFactor, type TipShape } from '@/geometry/ribbonMesher';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import { resolveUvAreaRect } from '@/materials/materialSource';
import { displaceFromParams, resolveDisplacement } from './displacement';
import { createSeasonSampler } from '@/seasons';
import { atlasRect, emptyFoliage, foliageOutput, isActive, itemVertexColor, parentOf, parentWind, pickLeafType, leafTint, readVertexColorOptions, varied } from './foliageCommon';
import { splitHalfIds } from './fusedParent';
import { materialHeightSampler } from './leafDeformParams';
import { resolveFrondLighting, type FrondLightingResolved } from './frondLightingParams';

/** Safety cap on fronds. */
export const MAX_FRONDS = 60_000;

const curveOf = (p: NodeParams, id: string): Curve | undefined => (p[id]?.curve ?? undefined) as Curve | undefined;
const profile = (p: NodeParams, id: string): ((t: number) => number) => {
  const c = curveOf(p, id);
  return c ? (t) => evaluateCurve(c, t) : () => 1;
};
const curveParam = (p: NodeParams, id: string): Curve | null => {
  const v = p[id]?.value;
  return v && typeof v === 'object' && 'points' in v && Array.isArray((v as Curve).points) ? (v as Curve) : null;
};

/** Sub-polyline of `pts` between arc-length fractions f0..f1 (interpolated end points). */
export function trimPolyline(pts: V3[], f0: number, f1: number): V3[] {
  if (pts.length < 2) return pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as V3;
    const b = pts[i] as V3;
    cum.push((cum[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const total = cum[cum.length - 1] as number;
  const s0 = Math.min(1, Math.max(0, f0)) * total;
  const s1 = Math.min(1, Math.max(0, f1)) * total;
  if (s1 - s0 < 1e-9) return [];
  const at = (s: number): V3 => {
    let i = 1;
    while (i < pts.length - 1 && (cum[i] as number) < s) i++;
    const span = (cum[i] as number) - (cum[i - 1] as number);
    const f = span > 1e-12 ? (s - (cum[i - 1] as number)) / span : 0;
    const a = pts[i - 1] as V3;
    const b = pts[i] as V3;
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  };
  const out: V3[] = [at(s0)];
  for (let i = 1; i < pts.length - 1; i++) if ((cum[i] as number) > s0 && (cum[i] as number) < s1) out.push(pts[i] as V3);
  out.push(at(s1));
  return out;
}

export function polyLength(pts: readonly V3[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as V3;
    const b = pts[i] as V3;
    total += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  }
  return total;
}

function branchPoints(sk: Skeleton, b: Branch): V3[] {
  const out: V3[] = [];
  for (let k = 0; k < b.count; k++) {
    const q = (b.start + k) * 3;
    out.push([sk.position[q] as number, sk.position[q + 1] as number, sk.position[q + 2] as number]);
  }
  return out;
}

const UP: V3 = [0, 0, 1];

/**
 * Initial face direction of a frond (Unification): away from the anchor point (`base - anchor`), or up for None / when
 * the anchor is unknown or sits on the base.
 */
export function unificationHint(style: string, anchor: V3 | null, base: V3): V3 {
  if (style === 'none' || !anchor) return UP;
  const d = sub(base, anchor);
  return len(d) < 1e-6 ? UP : norm(d);
}

/** Parameter value times its optional profile curve (the curve toggled off = flat). */
const scaled = (p: NodeParams, id: string, fallback: number): ((t: number) => number) => {
  const base = getNumber(p, id, fallback);
  const shape = profile(p, id);
  return (t) => base * shape(t);
};

/** Section Variance group (Favor Outliers + Amount / Offset of Gravity, Fold, Curl, Roll). */
export function readSectionVariance(p: NodeParams): SectionVarianceSettings {
  const axis = (name: string): { amount: number; offset: number } => ({
    amount: Math.max(0, getNumber(p, `frondSec${name}Amount`, 0)),
    offset: getNumber(p, `frondSec${name}Offset`, 0),
  });
  return { favorOutliers: getBool(p, 'frondSecOutliers', false), gravity: axis('Gravity'), fold: axis('Fold'), curl: axis('Curl'), roll: axis('Roll') };
}

/** Frond settings read once per evaluation. */
export interface FrondConfig {
  planes: number;
  startAngle: number;
  unification: string;
  start: number;
  end: number;
  accuracy: number;
  columns: { absolute: number; relative: number };
  cull: number;
  widthBoost: number;
  forceGravity: (t: number) => number;
  forceUp: (t: number) => number;
  forceAncestor: (t: number) => number;
  forceNet: V3 | null;
  align: number;
  shape: { tip: TipShape; taper: number; baseWidth: number };
  flip: boolean;
  twoSided: boolean;
  meshLod: Curve | null;
  meshIndex: number;
  windPower: number;
  /** Wind Weight / Cross / Boost / Ribs (the Ribs channel is set per parent branch). */
  wind: Omit<FrondWind, 'ribsLevel'>;
  leftRight: { amount: number; seed: number };
  sections: SectionVarianceSettings;
  densify: { detail: number } | null;
}

const TIPS: Record<string, TipShape> = { pointed: 'pointed', rounded: 'rounded', blunt: 'blunt' };
const lodKeep = (p: NodeParams, lod: number): number => Math.pow(1 - Math.min(0.9, Math.max(0, getNumber(p, 'lodSegments', 0.5))) * 0.4, Math.min(Math.max(lod, 0), 3)) * lodLengthFactor(readGeneratorLod(p), lod);

export function readFrondConfig(p: NodeParams, lod: number): FrondConfig {
  const keep = lodKeep(p, lod);
  const lodT = Math.min(Math.max(lod, 0), 3) / 3;
  const on = (id: string): boolean => getBool(p, id, false);
  const strength = (flag: string, id: string): ((t: number) => number) => {
    if (!on(flag)) return () => 0;
    const base = getNumber(p, id, 0.5);
    const shape = profile(p, id);
    // The base stays stiff: the pull ramps up linearly toward the tip.
    return (t) => base * shape(t) * t;
  };
  const gravityOn = on('frondForceGravityOn') ? getNumber(p, 'frondForceGravity', 0.5) : 0;
  const upOn = on('frondForceUpOn') ? getNumber(p, 'frondForceUp', 0.5) : 0;
  const displaced = getBool(p, 'displaceAutoSubdivide', true) && resolveDisplacement(p).state === 'ready' && getNumber(p, 'displaceAmount', 0) !== 0;
  return {
    planes: Math.max(1, Math.min(8, Math.round(getNumber(p, 'frondPlanes', 1)))),
    startAngle: deg2rad(getNumber(p, 'frondStartAngle', 0)),
    unification: getString(p, 'frondUnification', 'none'),
    start: Math.min(1, Math.max(0, getNumber(p, 'frondBoundaryStart', 0))),
    end: Math.min(1, Math.max(0, getNumber(p, 'frondBoundaryEnd', 1))),
    accuracy: Math.max(1, Math.round(getNumber(p, 'frondAccuracy', 4) * keep)),
    columns: { absolute: Math.max(1, Math.round(getNumber(p, 'frondWidthAbsolute', 2) * keep)), relative: getNumber(p, 'frondWidthRelative', 0) * keep },
    cull: getNumber(p, 'lodCull', 0) * lodT,
    widthBoost: getNumber(p, 'lodWidthBoost', 0.5),
    forceGravity: strength('frondForceGravityOn', 'frondForceGravity'),
    forceUp: strength('frondForceUpOn', 'frondForceUp'),
    forceAncestor: strength('frondForceAncestorOn', 'frondForceAncestor'),
    forceNet: netForceDirection(gravityOn, upOn),
    align: Math.min(1, Math.max(0, getNumber(p, 'frondAlign', 0))),
    shape: { tip: TIPS[getString(p, 'frondTipShape', 'pointed')] ?? 'pointed', taper: getNumber(p, 'frondTipTaper', 0.35), baseWidth: getNumber(p, 'frondBaseWidth', 1) },
    flip: getBool(p, 'frondFlip', false),
    twoSided: getBool(p, 'frondTwoSided', false),
    meshLod: curveParam(p, 'frondMeshLod'),
    meshIndex: Math.round(getNumber(p, 'frondMeshIndex', 0)),
    windPower: getNumber(p, 'frondBendPower', 1.5),
    wind: {
      power: getNumber(p, 'frondBendPower', 1.5),
      weight: scaled(p, 'frondWindWeight', 1),
      boost: scaled(p, 'frondWindBoost', 0),
      cross: Math.min(1, Math.max(0, getNumber(p, 'frondWindCross', 0))),
      ribsBranchWind: getBool(p, 'frondRibsBranchWind', false),
      ribsWeight: Math.min(1, Math.max(0, getNumber(p, 'frondRibsWeight', 0.5))),
    },
    leftRight: { amount: Math.min(1, Math.max(0, getNumber(p, 'frondLRAmount', 0))), seed: Math.round(getNumber(p, 'frondLRSeed', 0)) },
    sections: readSectionVariance(p),
    densify: displaced ? { detail: Math.max(0.002, getNumber(p, 'displaceDetail', 0.03)) } : null,
  };
}

/** UV options of the plain ribbon (UV tab). */
export function frondUvFromParams(p: NodeParams): FrondUv {
  return {
    mode: getString(p, 'frondUvMode', 'stretch') === 'tile' ? 'tile' : 'stretch',
    tile: getNumber(p, 'frondUvTile', 1),
    scaleU: getNumber(p, 'frondUvScaleU', 1),
    scaleV: getNumber(p, 'frondUvScaleV', 1),
    offsetU: getNumber(p, 'frondUvOffsetU', 0),
    offsetV: getNumber(p, 'frondUvOffsetV', 0),
  };
}

/** Unit-size mesh of a cutout at the chosen mesh LOD, cached per evaluation. */
function unitMeshOf(cache: Map<string, UnitMesh | null>, asset: CutoutMesh, level: 'high' | 'med' | 'low', materialId: string): UnitMesh | null {
  const key = `${asset.id}:${level}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const geometry = buildCutoutGeometry(asset, level, {
    origin: [0, 0, 0],
    axis: [0, 1, 0],
    side: [1, 0, 0],
    length: 1,
    width: 1,
    metric: { w: 1, h: 1 },
    applyPanelTransform: false,
    materialId,
  });
  const unit = unitMeshFromGeometry(geometry);
  cache.set(key, unit);
  return unit;
}

export interface FrondBuild {
  /** Resolved lighting (Style Global / Local) the mesh is lit with. */
  lighting: FrondLightingResolved;
  specs: FrondSpec[];
  /** Spine of every frond (first plane of each spine), after Start / End and Forces. */
  paths: V3[][];
}

/**
 * Ribs of every parent spine (one rib pair per length segment of the spine, planes per spine included) with the mesh of the
 * chosen material mapped on them: its cutout mesh, or the plain ribbon when the row has none. Exported for tests.
 */
export function buildFrondSpecs(ctx: NodeContext, parent: Skeleton, p: NodeParams, lineage?: Lineage, globalLighting?: LeafLightingSettings): FrondBuild {
  const cfg = readFrondConfig(p, ctx.lod);
  const boost = 1 + (cfg.cull > 0 ? (1 / Math.max(0.2, 1 - cfg.cull) - 1) * cfg.widthBoost : 0);
  const widthCurve = profile(p, 'frondWidth');
  const foldCurve = profile(p, 'frondFold');
  const curlCurve = profile(p, 'frondCurlAngle');
  const gravityCurve = profile(p, 'frondGravity');
  const seasons = createSeasonSampler(p);
  const lighting = resolveFrondLighting(p, globalLighting);
  const lit = isLightingActive(lighting.settings, { frond: lighting.extras });
  const specs: FrondSpec[] = [];
  const paths: V3[][] = [];
  const unitCache = new Map<string, UnitMesh | null>();
  const heightCache = new Map<string, ((u: number, v: number) => number) | null>();
  const heightOffset = getNumber(p, 'frondHeightOffset', 0);
  const vertexColor = readVertexColorOptions(p);
  let index = 0;
  // A split is one logical spine: one frond for it, none for the two fused halves
  const fusedHalves = splitHalfIds(parent);
  for (let bi = 0; bi < parent.branches.length; bi++) {
    const b = parent.branches[bi] as Branch;
    if (b.count < 2 || fusedHalves.has(b.id)) continue;
    if (specs.length >= MAX_FRONDS) break;
    ctx.cancel.throwIfCancelled();
    const rng = ctx.rng.fork(`fr:${b.id}`);
    // Draws are always consumed in the same order, so LOD changes never reshuffle the other fronds.
    const cullDraw = rng.next();
    const width = varied(rng, p, 'frondWidth', 0.25);
    const amount = varied(rng, p, 'frondHeightAmount', 1);
    const gravity = varied(rng, p, 'frondGravity', 0);
    const fold = varied(rng, p, 'frondFold', 0);
    const curl = varied(rng, p, 'frondCurlAngle', 0);
    const roll = varied(rng, p, 'frondRoll', 0);
    const type = pickLeafType(rng, p, 'leaf', seasons.value(rng));
    const atlas = resolveUvAreaRect(type.materialId, 'frond', rng) ?? atlasRect(p, rng, index);
    const color = leafTint(rng, p);
    const flipDraw = rng.next();
    if (cullDraw < cfg.cull) continue;
    let pts = trimPolyline(branchPoints(parent, b), cfg.start, Math.max(cfg.start, cfg.end));
    if (pts.length < 2) continue;
    if (cfg.densify) {
      const want = Math.min(64, Math.ceil(polyLength(pts) / cfg.densify.detail));
      if (want > pts.length - 1) pts = resamplePath(pts, want, false);
    }
    pts = bendPath(pts, { gravity: cfg.forceGravity, upDown: cfg.forceUp, ancestor: cfg.forceAncestor });
    if (pts.length < 2) continue;
    const mesh = resolveMesh(unitCache, type.meshAsset, type.materialId, ctx.lod, cfg);
    const anchorStyle = asAnchorStyle(cfg.unification);
    const anchor: V3 | null = cfg.unification === 'origin' ? [0, 0, 0] : anchorFromChain(chainOf(lineage, parent, bi), anchorStyle);
    const base = unificationHint(cfg.unification, anchor, pts[0] as V3);
    const t0 = norm(sub(pts[1] as V3, pts[0] as V3));
    const wind = parentWind(parent, b.start, index * 31 + 7);
    const heightMap = heightOffset !== 0 ? cachedHeight(heightCache, type.materialId) : null;
    const columns = ribbonColumns(cfg.columns.absolute, cfg.columns.relative, polyLength(pts));
    const flip = cfg.flip && flipDraw < 0.5;
    const sides = cfg.leftRight.amount > 0 ? leftRightScales(cfg.leftRight, rngLeftRight(ctx, b.id, cfg.leftRight.seed)) : undefined;
    const deltas = mesh && mesh.sections.length > 0 && hasSectionVariance(cfg.sections) ? sectionDeltas(cfg.sections, rngNext(rng.fork('sec'))) : null;
    const lightRng = lit ? rng.fork('light') : null;
    const adjust = lightRng ? resolveAdjust(lighting.settings, () => lightRng.next()) : null;
    const windSet: FrondWind = { ...cfg.wind, ribsLevel: ribsLevelOf(b.generation) };
    for (let k = 0; k < cfg.planes; k++) {
      const angle = cfg.startAngle + (k * Math.PI) / cfg.planes;
      const make = (d: SectionDelta | null): Ribs | null => {
        const set: RibSettings = {
          halfWidthAt: (t) => 0.5 * width * boost * (mesh ? Math.max(0, widthCurve(t)) : ribbonWidthFactor({ baseWidth: cfg.shape.baseWidth, tipShape: cfg.shape.tip, tipTaper: cfg.shape.taper, widthAt: widthCurve }, t)),
          fold: (t) => deg2rad(fold + (d?.fold ?? 0)) * foldCurve(t),
          curl: (t) => deg2rad(curl + (d?.curl ?? 0)) * curlCurve(t),
          gravity: (t) => (gravity + (d?.gravity ?? 0)) * gravityCurve(t),
          roll: deg2rad(roll + (d?.roll ?? 0)),
          accuracy: cfg.accuracy,
          hint: rotate(base, t0, angle),
          alignAmount: cfg.align,
          alignDir: cfg.align > 0 ? (cfg.forceNet ?? [0, 0, -1]) : null,
          ...(sides ? { sides } : {}),
        };
        return buildRibs(pts, set);
      };
      const ribs = make(null);
      if (!ribs) continue;
      let sectionRibs: (Ribs | null)[] | undefined;
      if (deltas && mesh) {
        sectionRibs = [];
        for (const id of mesh.sections) sectionRibs[id] = make(deltas[id] ?? null);
      }
      let light: FrondLight | null = null;
      if (lit && adjust) {
        const anchorPoint = resolveLightAnchor(lighting.settings, (style) => anchorFromChain(chainOf(lineage, parent, bi), style), pts[0] as V3);
        const surface = surfaceDirection(lighting.settings.parentAnchor, {
          normal: [ribs.normal[0] as number, ribs.normal[1] as number, ribs.normal[2] as number],
          binormal: [ribs.side[0] as number, ribs.side[1] as number, ribs.side[2] as number],
          tangent: [ribs.tangent[0] as number, ribs.tangent[1] as number, ribs.tangent[2] as number],
        });
        light = { anchor: anchorPoint, surface, adjust };
      }
      specs.push({
        ribs,
        materialId: type.materialId,
        mesh,
        columns,
        flip,
        twoSided: cfg.twoSided,
        atlas,
        color,
        colorGradient: getNumber(p, 'vertexColorGradient', 0),
        ...itemVertexColor({ options: vertexColor, parent, point: b.start + Math.round(cfg.start * (b.count - 1)), at: [cfg.start, Math.max(cfg.start, cfg.end)] }, b.id, ctx.seed),
        ao: getNumber(p, 'aoStrength', 0.5),
        wind,
        windPower: cfg.windPower,
        windSet,
        ...(sectionRibs ? { sectionRibs } : {}),
        light,
        heightScale: getNumber(p, 'frondScaleHeight', 1),
        heightAmount: amount,
        heightOffset,
        heightMap,
      });
      if (k === 0) paths.push(pts);
    }
    index++;
  }
  return { lighting, specs, paths };
}

const rngLeftRight = (ctx: NodeContext, branchId: number, seed: number): (() => number) => rngNext(ctx.rng.fork(`frlr:${seed}:${branchId}`));
const rngNext = (r: { next: () => number }): (() => number) => () => r.next();

function resolveMesh(cache: Map<string, UnitMesh | null>, asset: CutoutMesh | null, materialId: string, lod: number, cfg: FrondConfig): UnitMesh | null {
  if (!asset) return null;
  const choice = chooseMeshLod({ lod, curve: cfg.meshLod, offset: cfg.meshIndex, filled: filledMeshLods(asset) });
  return unitMeshOf(cache, asset, choice.level, materialId);
}

function cachedHeight(cache: Map<string, ((u: number, v: number) => number) | null>, materialId: string): ((u: number, v: number) => number) | null {
  if (!cache.has(materialId)) cache.set(materialId, materialHeightSampler(materialId));
  return cache.get(materialId) ?? null;
}

export function evaluateFrond(ctx: NodeContext, inputs: NodeInputs, p: NodeParams): NodeOutputs {
  const parent = parentOf(inputs);
  if (!isActive(p, ctx.lod) || parent.count === 0) return emptyFoliage(parent, ctx.seed);
  const pv = inputs.parent?.[0];
  const lineage = pv && pv.kind === 'Structure' ? pv.value.lineage : undefined;
  const globalLighting = pv && pv.kind === 'Structure' ? pv.value.lighting : undefined;
  const { specs, paths, lighting } = buildFrondSpecs(ctx, parent, p, lineage, globalLighting);
  if (specs.length === 0) return emptyFoliage(parent, ctx.seed);
  const mesh = displaceFromParams(
    buildFrondMesh(specs, { uv: frondUvFromParams(p), defaultMaterial: 'leaf', lighting: lighting.settings, lightingExtras: lighting.extras }),
    p,
    ctx.lod,
  );
  // One centre-line branch per frond (first plane of every spine) for overlays and child inheritance.
  const sb = new SkeletonBuilder();
  const gen = (parent.branches[0]?.generation ?? -1) + 1;
  for (const path of paths) {
    sb.beginBranch(-1, -1, gen);
    for (const pt of path) sb.addPoint(pt[0], pt[1], pt[2], 0.001);
    sb.endBranch();
  }
  return foliageOutput(sb.build(), parent, mesh, paths.length, ctx.seed);
}

/**
 * Migrates older Frond params. v1 (pinnae-style) -> v2 ribbon params; v2 (ribbon along the spine) -> v3 (rib-based frond:
 * Shape / Segments / Forces groups). Unknown / obsolete ids are dropped.
 */
export function migrateFrondParams(params: NodeParams, fromVersion: number): NodeParams {
  let out = params;
  if (fromVersion < 2) out = migrateV1(out);
  if (fromVersion < 3) out = migrateV2(out);
  return out;
}

function migrateV1(params: NodeParams): NodeParams {
  const out: NodeParams = { ...params };
  const num = (id: string): number | undefined => (typeof params[id]?.value === 'number' ? (params[id]?.value as number) : undefined);
  const set = (id: string, state: ParamState): void => {
    out[id] = state;
  };
  const pinnaLen = num('frondPinnaLength');
  if (pinnaLen !== undefined) set('frondWidth', { value: Math.min(50, pinnaLen * 1.4), ...(params.frondPinnaLength?.variance !== undefined ? { variance: params.frondPinnaLength.variance } : {}) });
  const taper = num('frondTaper');
  if (taper !== undefined) set('frondTipTaper', { value: Math.min(1, 0.25 + taper * 0.5) });
  const droop = num('frondDroop');
  if (droop !== undefined) set('frondDroop', { value: droop });
  const arch = num('frondCurl');
  if (arch !== undefined) set('frondArch', { value: arch * 45 });
  const twist = num('frondTwist');
  if (twist !== undefined) set('frondTwist', { value: twist * 90 });
  const segs = num('frondSegments');
  if (segs !== undefined) set('frondLengthSegments', { value: Math.min(24, Math.max(2, Math.round(segs))) });
  const rachis = num('frondLength');
  if (rachis !== undefined) set('frondLengthScale', { value: 1 });
  // Obsolete: the number / boundaries of the old distribution, pinnae and rachis settings.
  for (const id of ['number', 'first', 'last', 'mode', 'frondRachisRadius', 'frondFins', 'frondStart', 'frondPinnaLength', 'frondPinnaWidth', 'frondPinnaAngle', 'frondPinnaDroop', 'frondPinnaSegments', 'frondSizeCurve', 'frondLength']) delete out[id];
  return out;
}

/** Ribbon-along-the-spine params (v2) -> rib-based params (v3). */
function migrateV2(params: NodeParams): NodeParams {
  const out: NodeParams = { ...params };
  const num = (id: string): number | undefined => (typeof params[id]?.value === 'number' ? (params[id]?.value as number) : undefined);
  const str = (id: string): string | undefined => (typeof params[id]?.value === 'string' ? (params[id]?.value as string) : undefined);
  const move = (from: string, to: string): void => {
    const s = params[from];
    if (s) out[to] = s;
  };
  move('first', 'frondBoundaryStart');
  move('last', 'frondBoundaryEnd');
  const shape = str('frondShape');
  const foldDeg = num('frondFoldAngle') ?? 40;
  if (shape === 'v-fold') out.frondFold = { value: foldDeg, ...(params.frondFoldAngle?.curve ? { curve: params.frondFoldAngle.curve } : {}) };
  let curlDeg = (num('frondCurl') ?? 0) * 90;
  if (shape === 'u-curve') curlDeg += foldDeg / 2;
  if (curlDeg !== 0) out.frondCurlAngle = { value: Math.max(-180, Math.min(180, curlDeg)), ...(shape === 'u-curve' && params.frondFoldAngle?.curve ? { curve: params.frondFoldAngle.curve } : {}) };
  // The old Droop pulled the ribbon toward the ground along the spine: it becomes the Gravity force.
  const droop = num('frondDroop') ?? 0.3;
  if (droop > 0) {
    out.frondForceGravityOn = { value: true };
    out.frondForceGravity = { value: Math.min(4, droop * 1.6) };
  }
  if (str('frondFacing') === 'outward') out.frondUnification = { value: 'origin' };
  const widthSegs = num('frondWidthSegments');
  if (widthSegs !== undefined) out.frondWidthAbsolute = { value: Math.max(1, Math.min(32, Math.round(widthSegs))) };
  if (str('frondFaces') === 'duplicate-back-faces') out.frondTwoSided = { value: true };
  for (const id of [
    'first', 'last', 'frondShape', 'frondFoldAngle', 'frondCurl', 'frondCrease', 'frondDroop', 'frondArch', 'frondTwist', 'frondFacing', 'frondOffset',
    'frondLengthScale', 'frondLengthAdd', 'frondLengthSegments', 'frondAdaptive', 'frondWidthSegments', 'frondFaces', 'frondInstancing',
  ]) delete out[id];
  return out;
}
