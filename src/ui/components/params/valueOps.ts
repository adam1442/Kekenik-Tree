import { curveHash, rampHash, type Curve, type Ramp } from '@/core/curve';
import {
  defaultParamState,
  evalCondition,
  type FloatParamDef,
  type IntParamDef,
  type ListItem,
  type NodeParams,
  type ParamDef,
  type ParamState,
  type ParamValue,
  type RangeParamDef,
  type Vec2ParamDef,
  type Vec3ParamDef,
} from '@/contracts/params';

/**
 * Pure parameter value math, clamping, scrubbing, comparison, mixed-state detection,
 * and search filtering for the Properties Inspector.
 */

export interface SliderBounds {
  /** Minimum value used by the visual slider track. */
  sliderMin: number;
  /** Maximum value used by the visual slider track. */
  sliderMax: number;
  /** Hard minimum when typing or scrubbing (may be -Infinity). */
  hardMin: number;
  /** Hard maximum when typing or scrubbing (may be +Infinity). */
  hardMax: number;
  /** Base increment step. */
  step: number;
  /** Whether the slider should render discrete tick marks by default. */
  showTicks: boolean;
}

/** Parameter ids that use a tick slider. */
const TICK_SLIDER_IDS = new Set<string>([
  'number',
  'jumble',
  'sweep',
  'roll',
  'first',
  'last',
  'clip',
  'weight',
  'seasonSize',
  'seasonCurl',
  'seasonFold',
  'angle',
]);

export function getSliderBounds(def: FloatParamDef | IntParamDef): SliderBounds {
  const isInt = def.kind === 'int';
  const hardMin = def.min ?? -Infinity;
  const hardMax = def.max ?? Infinity;
  const softMin = def.softMin !== undefined ? def.softMin : def.min ?? 0;
  // Counts with a large hard limit get a 0..100 slider (the old `default * 2` rule capped Branch.Number at 24).
  const intFallback = Math.max(100, typeof def.default === 'number' ? def.default * 2 : 100);
  const softMax =
    def.softMax !== undefined
      ? def.softMax
      : def.max !== undefined && def.max <= 1000
        ? def.max
        : isInt
          ? intFallback
          : 1;
  const span = Math.max(1e-6, softMax - softMin);
  const step = def.step ?? (isInt ? 1 : span <= 2 ? 0.001 : span <= 20 ? 0.01 : 0.1);
  const showTicks = TICK_SLIDER_IDS.has(def.id);
  return {
    sliderMin: softMin,
    sliderMax: softMax > softMin ? softMax : softMin + 1,
    hardMin,
    hardMax,
    step,
    showTicks,
  };
}

/**
 * Clamp and snap a numeric value according to `def`.
 * When `useSoftLimits` is true (slider track drag), clamps to `[sliderMin, sliderMax]`.
 * When `useSoftLimits` is false (typing or label scrubbing), clamps only to hard `[min, max]`.
 */
export function clampNumericParam(
  def: FloatParamDef | IntParamDef,
  raw: number,
  useSoftLimits = false,
  applyStep = false,
): number {
  if (!Number.isFinite(raw)) return def.default;
  const bounds = getSliderBounds(def);
  const lo = useSoftLimits ? Math.max(bounds.hardMin, bounds.sliderMin) : bounds.hardMin;
  const hi = useSoftLimits ? Math.min(bounds.hardMax, bounds.sliderMax) : bounds.hardMax;

  let v = Math.min(hi, Math.max(lo, raw));
  if (def.kind === 'int') {
    const s = def.step && def.step > 0 ? Math.round(def.step) : 1;
    const base = Number.isFinite(lo) ? lo : 0;
    v = base + Math.round((v - base) / s) * s;
    v = Math.min(hi, Math.max(lo, Math.round(v)));
    return Object.is(v, -0) ? 0 : v;
  }

  if (applyStep && def.step && def.step > 0) {
    const base = Number.isFinite(lo) ? lo : 0;
    v = base + Math.round((v - base) / def.step) * def.step;
  }
  v = Math.min(hi, Math.max(lo, v));
  const rounded = Math.round(v * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Clamp a `[low, high]` range pair according to `RangeParamDef`. */
export function clampRangeParam(def: RangeParamDef, low: number, high: number): [number, number] {
  const step = def.step && def.step > 0 ? def.step : 0;
  const snap = (n: number): number => {
    let v = Math.min(def.max, Math.max(def.min, Number.isFinite(n) ? n : def.min));
    if (step > 0) v = def.min + Math.round((v - def.min) / step) * step;
    v = Math.min(def.max, Math.max(def.min, Math.round(v * 1e6) / 1e6));
    return Object.is(v, -0) ? 0 : v;
  };
  const a = snap(low);
  const b = snap(high);
  return a <= b ? [a, b] : [b, a];
}

/** Clamp a Vec2 or Vec3 component according to its definition. */
export function clampVecComponent(def: Vec2ParamDef | Vec3ParamDef, value: number, applyStep = false): number {
  if (!Number.isFinite(value)) return 0;
  let v = value;
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  if (applyStep && def.step && def.step > 0) {
    const base = def.min ?? 0;
    v = base + Math.round((v - base) / def.step) * def.step;
  }
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  const rounded = Math.round(v * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Compute value delta for horizontal drag-scrubbing on a label or field.
 * `shiftKey` = fine (0.1x), `ctrlKey`/`metaKey` = coarse (10x).
 */
export function computeScrubDelta(
  def: FloatParamDef | IntParamDef | Vec2ParamDef | Vec3ParamDef,
  dxPixels: number,
  opts?: { shiftKey?: boolean; ctrlKey?: boolean },
): number {
  const mult = opts?.shiftKey ? 0.1 : opts?.ctrlKey ? 10 : 1;
  if (def.kind === 'int') {
    const step = def.step ?? 1;
    // 4 pixels per integer step at normal speed
    return Math.trunc((dxPixels * mult) / 4) * step;
  }
  if (def.kind === 'vec2' || def.kind === 'vec3') {
    const step = def.step ?? 0.01;
    return dxPixels * step * mult;
  }
  const bounds = getSliderBounds(def);
  const span = Math.max(1e-4, bounds.sliderMax - bounds.sliderMin);
  const perPixel = span / 200;
  return dxPixels * perPixel * mult;
}

/** Format a number for display in a parameter input field (compact decimals). */
export function formatParamNumber(value: number, step?: number, isInt = false): string {
  if (!Number.isFinite(value)) return '0';
  if (isInt) return String(Math.round(value));
  const decimals = step && step < 0.001 ? 4 : 3;
  const fixed = Number(value.toFixed(decimals));
  return String(Object.is(fixed, -0) ? 0 : fixed);
}

/** Format variance badge text like `.10` or `1.2`. */
export function formatVarianceBadge(variance: number): string {
  if (!Number.isFinite(variance) || variance <= 0) return '0';
  const rounded = Math.round(variance * 100) / 100;
  if (rounded > 0 && rounded < 1) {
    const s = rounded.toFixed(2);
    return s.startsWith('0.') ? s.slice(1) : s;
  }
  return String(Number(rounded.toFixed(2)));
}

/**
 * Parse user-typed numeric input (supports plain numbers, trailing units like "12m" or "45°",
 * and simple arithmetic `+`, `-`, `*`, `/` expressions).
 */
export function parseNumericInput(raw: string, fallback: number): number {
  const cleaned = raw.trim().replace(/[a-zA-Z°%]+$/g, '').trim();
  if (!cleaned) return fallback;
  const direct = Number(cleaned);
  if (Number.isFinite(direct)) return direct;

  // Safe simple arithmetic parser (+, -, *, / with numbers and parentheses)
  if (/^[0-9.+\-*/()\s]+$/.test(cleaned)) {
    try {
      const val = evaluateSimpleMath(cleaned);
      if (Number.isFinite(val)) return val;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function evaluateSimpleMath(expr: string): number {
  const tokens = expr.match(/(\d+\.?\d*|\.\d+|[+\-*/()])/g);
  if (!tokens || tokens.length === 0) return NaN;
  let pos = 0;

  const parseExpr = (): number => {
    let left = parseTerm();
    while (pos < tokens.length && (tokens[pos] === '+' || tokens[pos] === '-')) {
      const op = tokens[pos++];
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };

  const parseTerm = (): number => {
    let left = parseFactor();
    while (pos < tokens.length && (tokens[pos] === '*' || tokens[pos] === '/')) {
      const op = tokens[pos++];
      const right = parseFactor();
      left = op === '*' ? left * right : right !== 0 ? left / right : NaN;
    }
    return left;
  };

  const parseFactor = (): number => {
    const tok = tokens[pos];
    if (tok === '+' || tok === '-') {
      pos++;
      return tok === '-' ? -parseFactor() : parseFactor();
    }
    if (tok === '(') {
      pos++;
      const v = parseExpr();
      if (tokens[pos] === ')') pos++;
      return v;
    }
    pos++;
    return tok !== undefined ? Number(tok) : NaN;
  };

  const res = parseExpr();
  return pos === tokens.length ? res : NaN;
}

function isCurveObj(v: unknown): v is Curve {
  return typeof v === 'object' && v !== null && 'points' in v && Array.isArray((v as Curve).points);
}

function isRampObj(v: unknown): v is Ramp {
  return typeof v === 'object' && v !== null && 'stops' in v && Array.isArray((v as Ramp).stops);
}

/** Deep equality check for any `ParamValue`. */
export function isParamValueEqual(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i];
      const bi = b[i];
      if (typeof ai === 'number' && typeof bi === 'number') {
        if (Math.abs(ai - bi) > 1e-6) return false;
      } else if (typeof ai === 'object' && ai !== null && typeof bi === 'object' && bi !== null) {
        const recA = ai as ListItem;
        const recB = bi as ListItem;
        const keysA = Object.keys(recA);
        const keysB = Object.keys(recB);
        if (keysA.length !== keysB.length) return false;
        for (const k of keysA) {
          if (!isParamValueEqual(recA[k] as ParamValue, recB[k] as ParamValue)) return false;
        }
      } else if (ai !== bi) {
        return false;
      }
    }
    return true;
  }
  if (isCurveObj(a) && isCurveObj(b)) {
    return curveHash(a) === curveHash(b);
  }
  if (isRampObj(a) && isRampObj(b)) {
    return rampHash(a) === rampHash(b);
  }
  return false;
}

/** Check whether a curve is effectively active / non-null and non-default. */
export function hasActiveCurve(curve: Curve | null | undefined): boolean {
  return curve !== null && curve !== undefined && Array.isArray(curve.points) && curve.points.length > 0;
}

/** True when `state` differs from `defaultParamState(def)` in value, variance, or driving curve. */
export function isParamModified(def: ParamDef, state: ParamState | undefined): boolean {
  if (!state) return false;
  const defState = defaultParamState(def);
  if (!isParamValueEqual(state.value, defState.value)) return true;
  const varNow = state.variance ?? defState.variance ?? 0;
  const varDef = defState.variance ?? 0;
  if (Math.abs(varNow - varDef) > 1e-6) return true;
  if (def.curveAllowed) {
    const cNow = state.curve ?? null;
    const cDef = defState.curve ?? null;
    if (cNow === null && cDef === null) return false;
    if (cNow === null || cDef === null) return true;
    return curveHash(cNow) !== curveHash(cDef);
  }
  return false;
}

export interface MixedParamInfo {
  valueMixed: boolean;
  varianceMixed: boolean;
  curveMixed: boolean;
  /** First node's state (or default) used as baseline when rendering. */
  representative: ParamState;
}

/** Compute mixed-value status for a parameter across 1 or more selected nodes. */
export function computeMixedParamState(def: ParamDef, states: readonly (ParamState | undefined)[]): MixedParamInfo {
  const fallback = defaultParamState(def);
  if (states.length === 0) {
    return { valueMixed: false, varianceMixed: false, curveMixed: false, representative: fallback };
  }
  const first = states[0] ?? fallback;
  let valueMixed = false;
  let varianceMixed = false;
  let curveMixed = false;

  const firstVar = first.variance ?? fallback.variance ?? 0;
  const firstCurve = first.curve ?? null;

  for (let i = 1; i < states.length; i++) {
    const s = states[i] ?? fallback;
    if (!valueMixed && !isParamValueEqual(first.value, s.value)) valueMixed = true;
    const sVar = s.variance ?? fallback.variance ?? 0;
    if (!varianceMixed && Math.abs(firstVar - sVar) > 1e-6) varianceMixed = true;
    const sCurve = s.curve ?? null;
    if (!curveMixed) {
      if ((firstCurve === null) !== (sCurve === null)) curveMixed = true;
      else if (firstCurve && sCurve && curveHash(firstCurve) !== curveHash(sCurve)) curveMixed = true;
    }
  }

  return {
    valueMixed,
    varianceMixed,
    curveMixed,
    representative: structuredClone(first),
  };
}

/**
 * Evaluate `visibleIf` across one or more node parameter maps.
 * In multi-selection, returns true if the parameter is visible on at least one selected node.
 */
export function isParamVisibleForNodes(def: ParamDef, nodeParamMaps: readonly NodeParams[]): boolean {
  if (!def.visibleIf) return true;
  if (nodeParamMaps.length === 0) return true;
  return nodeParamMaps.some((params) => evalCondition(def.visibleIf, params));
}

/**
 * Filter a parameter definition against a search query.
 * Supports:
 * - Plain substring & space-separated AND tokens (e.g. "drop time")
 * - Pipe-separated OR terms: `Season|Leaves:Type|Vertex Color:|Lightmap`
 * - `Section:Subgroup` or `Section:` path matching
 */
export function matchesParamSearch(def: ParamDef, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;

  const group = def.group.toLowerCase();
  const sub = (def.subgroup ?? '').toLowerCase();
  const label = def.label.toLowerCase();
  const id = def.id.toLowerCase();
  const pathColon = sub ? `${group}:${sub}:${label}` : `${group}:${label}`;
  const subColon = sub ? `${sub}:${label}` : label;
  const haystack = `${group} ${sub} ${label} ${id} ${pathColon} ${subColon}`;

  const orBranches = q
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (orBranches.length === 0) return true;

  return orBranches.some((branch) => {
    // Handle trailing colon like "Vertex Color:" matching subgroup or group
    const cleanBranch = branch.endsWith(':') ? branch.slice(0, -1).trim() : branch;
    if (!cleanBranch) return true;
    if (cleanBranch.includes(':')) {
      return pathColon.includes(cleanBranch) || subColon.includes(cleanBranch) || haystack.includes(cleanBranch);
    }
    const andTokens = cleanBranch.split(/\s+/).filter(Boolean);
    return andTokens.every((tok) => haystack.includes(tok));
  });
}
