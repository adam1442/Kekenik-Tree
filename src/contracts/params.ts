import type { Curve, Ramp } from './curve';

/**
 * Parameter definitions (ParamDef) — the schema of every node property.
 * The Properties inspector renders widgets from these definitions;
 * node authors never build UI by hand.
 */

export type RGBA = [number, number, number, number];
export type ParamScalar = number | boolean | string;

/** Per-instance random spread. */
export interface VarianceDef {
  default: number;
  min?: number;
  max?: number;
}

/** Declarative visibility rule. */
export type Condition =
  | { param: string; op?: 'eq' | 'ne' | 'gt' | 'lt' | 'in'; value: ParamScalar | ParamScalar[] }
  | { all: Condition[] }
  | { any: Condition[] };

interface ParamBase {
  /** Stable key stored in project files. Never rename after release. */
  id: string;
  label: string;
  /** Inspector tab / section grouping, e.g. "Generation", "Spine". */
  group: string;
  /** Optional sub-section within the group, e.g. "Absolute", "Boundaries". */
  subgroup?: string;
  tooltip?: string;
  visibleIf?: Condition;
  /** Presence enables the "±" variance toggle. */
  variance?: VarianceDef;
  /** Whether a Curve may drive this parameter along the parent. */
  curveAllowed?: boolean;
}

export interface FloatParamDef extends ParamBase {
  kind: 'float';
  default: number;
  min?: number;
  max?: number;
  /** Soft range used by the slider (value may exceed it when typed). */
  softMin?: number;
  softMax?: number;
  step?: number;
  unit?: string;
}
export interface IntParamDef extends ParamBase {
  kind: 'int';
  default: number;
  min?: number;
  max?: number;
  /** Soft range used by the slider (typed values may exceed it up to `max`). */
  softMin?: number;
  softMax?: number;
  /** Counts above this value show a performance warning badge in the inspector. */
  warnAbove?: number;
  step?: number;
  unit?: string;
}
export interface BoolParamDef extends ParamBase {
  kind: 'bool';
  default: boolean;
}
export interface EnumParamDef extends ParamBase {
  kind: 'enum';
  default: string;
  options: { value: string; label: string }[];
}
export interface Vec2ParamDef extends ParamBase {
  kind: 'vec2';
  default: [number, number];
  min?: number;
  max?: number;
  step?: number;
}
export interface Vec3ParamDef extends ParamBase {
  kind: 'vec3';
  default: [number, number, number];
  min?: number;
  max?: number;
  step?: number;
}
export interface ColorParamDef extends ParamBase {
  kind: 'color';
  default: RGBA;
}
export interface CurveParamDef extends ParamBase {
  kind: 'curve';
  default: Curve;
}
export interface RampParamDef extends ParamBase {
  kind: 'ramp';
  default: Ramp;
}
export interface RangeParamDef extends ParamBase {
  kind: 'range';
  /** [low, high] */
  default: [number, number];
  min: number;
  max: number;
  step?: number;
}
export interface StringParamDef extends ParamBase {
  kind: 'string';
  default: string;
  multiline?: boolean;
}
export interface SeedParamDef extends ParamBase {
  kind: 'seed';
  default: number;
}
export interface AssetParamDef extends ParamBase {
  kind: 'asset';
  assetKind: 'image' | 'mesh';
  /** Asset id inside the project's asset table, or null. */
  default: string | null;
}

/** Repeatable group of fields (e.g. the Leaf's material "Type" list with Material / Mesh / Weight rows). */
export type ListItem = Record<string, ParamScalar>;
export interface ListParamDef extends ParamBase {
  kind: 'list';
  /** Fields of one row (scalar-valued kinds only: float/int/bool/enum/string/asset). */
  fields: ParamDef[];
  default: ListItem[];
  minItems?: number;
  maxItems?: number;
}

export type ParamDef =
  | FloatParamDef
  | IntParamDef
  | BoolParamDef
  | EnumParamDef
  | Vec2ParamDef
  | Vec3ParamDef
  | ColorParamDef
  | CurveParamDef
  | RampParamDef
  | RangeParamDef
  | StringParamDef
  | SeedParamDef
  | AssetParamDef
  | ListParamDef;

export type ParamKind = ParamDef['kind'];

export type ParamValue = number | boolean | string | number[] | RGBA | Curve | Ramp | ListItem[] | null;

/** Runtime/persisted state of one parameter: value + optional variance + optional driving curve. */
export interface ParamState {
  value: ParamValue;
  variance?: number;
  curve?: Curve | null;
}
export type NodeParams = Record<string, ParamState>;

function cloneValue<T>(v: T): T {
  return typeof v === 'object' && v !== null ? (structuredClone(v) as T) : v;
}

export function defaultParamState(def: ParamDef): ParamState {
  const state: ParamState = { value: cloneValue(def.default) as ParamValue };
  if (def.variance) state.variance = def.variance.default;
  if (def.curveAllowed) state.curve = null;
  return state;
}

export function defaultParams(defs: readonly ParamDef[]): NodeParams {
  const out: NodeParams = {};
  for (const def of defs) out[def.id] = defaultParamState(def);
  return out;
}

export function evalCondition(cond: Condition | undefined, params: NodeParams): boolean {
  if (!cond) return true;
  if ('all' in cond) return cond.all.every((c) => evalCondition(c, params));
  if ('any' in cond) return cond.any.some((c) => evalCondition(c, params));
  const actual = params[cond.param]?.value;
  const op = cond.op ?? 'eq';
  switch (op) {
    case 'eq':
      return actual === cond.value;
    case 'ne':
      return actual !== cond.value;
    case 'gt':
      return typeof actual === 'number' && typeof cond.value === 'number' && actual > cond.value;
    case 'lt':
      return typeof actual === 'number' && typeof cond.value === 'number' && actual < cond.value;
    case 'in':
      return Array.isArray(cond.value) && (cond.value as unknown[]).includes(actual);
  }
}

/** Clamp / snap a numeric value according to its definition (non-numeric kinds pass through). */
export function clampParam(def: ParamDef, value: number): number {
  if (def.kind !== 'float' && def.kind !== 'int' && def.kind !== 'range') return value;
  let v = value;
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  if (def.kind === 'int') v = Math.round(v);
  return v;
}

export function getNumber(params: NodeParams, id: string, fallback = 0): number {
  const v = params[id]?.value;
  return typeof v === 'number' ? v : fallback;
}
export function getBool(params: NodeParams, id: string, fallback = false): boolean {
  const v = params[id]?.value;
  return typeof v === 'boolean' ? v : fallback;
}
export function getString(params: NodeParams, id: string, fallback = ''): string {
  const v = params[id]?.value;
  return typeof v === 'string' ? v : fallback;
}
