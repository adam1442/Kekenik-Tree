import type { Curve } from '@/contracts/curve';
import type { Condition, ParamDef, RGBA } from '@/contracts/params';

/** Small declarative helpers so node catalogues stay readable. `group` = inspector tab, `sub` = section header. */
export interface NumOpts {
  min?: number;
  max?: number;
  softMin?: number;
  softMax?: number;
  step?: number;
  unit?: string;
  /** Presence enables the "±" variance toggle (value = default variance). */
  variance?: number;
  /** A curve may drive the parameter ("curve toggle"). */
  curve?: boolean;
  /** Int params: show a performance warning badge above this count. */
  warnAbove?: number;
  tooltip?: string;
  visibleIf?: Condition;
}

export interface Section {
  float(id: string, label: string, def: number, o?: NumOpts): ParamDef;
  int(id: string, label: string, def: number, o?: NumOpts): ParamDef;
  bool(id: string, label: string, def: boolean, o?: Pick<NumOpts, 'tooltip' | 'visibleIf' | 'curve'>): ParamDef;
  enumOf(id: string, label: string, def: string, options: string[], o?: Pick<NumOpts, 'tooltip' | 'visibleIf'>): ParamDef;
  color(id: string, label: string, def: RGBA, o?: Pick<NumOpts, 'tooltip' | 'visibleIf'>): ParamDef;
  string(id: string, label: string, def: string, o?: Pick<NumOpts, 'tooltip' | 'visibleIf'>): ParamDef;
  vec3(id: string, label: string, def: [number, number, number], o?: Pick<NumOpts, 'tooltip' | 'visibleIf' | 'step'>): ParamDef;
  curve(id: string, label: string, def: Curve, o?: Pick<NumOpts, 'tooltip' | 'visibleIf'>): ParamDef;
  range(id: string, label: string, def: [number, number], min: number, max: number, o?: Pick<NumOpts, 'tooltip' | 'visibleIf' | 'step'>): ParamDef;
  seed(id: string, label: string, def?: number): ParamDef;
}


export function section(group: string, sub?: string): Section {
  const base = (o: Pick<NumOpts, 'tooltip' | 'visibleIf'> | undefined): { group: string; subgroup?: string; tooltip?: string; visibleIf?: Condition } => ({
    group,
    ...(sub ? { subgroup: sub } : {}),
    ...(o?.tooltip ? { tooltip: o.tooltip } : {}),
    ...(o?.visibleIf ? { visibleIf: o.visibleIf } : {}),
  });
  const numeric = (o: NumOpts | undefined): Record<string, unknown> => ({
    ...(o?.min !== undefined ? { min: o.min } : {}),
    ...(o?.max !== undefined ? { max: o.max } : {}),
    ...(o?.step !== undefined ? { step: o.step } : {}),
    ...(o?.unit ? { unit: o.unit } : {}),
    ...(o?.variance !== undefined ? { variance: { default: o.variance } } : {}),
    ...(o?.curve ? { curveAllowed: true } : {}),
  });
  return {
    float: (id, label, def, o) => ({
      kind: 'float',
      id,
      label,
      default: def,
      ...base(o),
      ...numeric(o),
      ...(o?.softMin !== undefined ? { softMin: o.softMin } : {}),
      ...(o?.softMax !== undefined ? { softMax: o.softMax } : {}),
    }),
    int: (id, label, def, o) => ({
      kind: 'int',
      id,
      label,
      default: def,
      ...base(o),
      ...numeric(o),
      ...(o?.softMin !== undefined ? { softMin: o.softMin } : {}),
      ...(o?.softMax !== undefined ? { softMax: o.softMax } : {}),
      ...(o?.warnAbove !== undefined ? { warnAbove: o.warnAbove } : {}),
    }),
    bool: (id, label, def, o) => ({ kind: 'bool', id, label, default: def, ...base(o), ...(o?.curve ? { curveAllowed: true } : {}) }),
    enumOf: (id, label, def, options, o) => ({
      kind: 'enum',
      id,
      label,
      default: optionValue(def),
      options: options.map((label) => ({ value: optionValue(label), label })),
      ...base(o),
    }),
    color: (id, label, def, o) => ({ kind: 'color', id, label, default: def, ...base(o) }),
    string: (id, label, def, o) => ({ kind: 'string', id, label, default: def, ...base(o) }),
    vec3: (id, label, def, o) => ({ kind: 'vec3', id, label, default: def, ...base(o), ...(o?.step !== undefined ? { step: o.step } : {}) }),
    curve: (id, label, def, o) => ({ kind: 'curve', id, label, default: def, ...base(o) }),
    range: (id, label, def, min, max, o) => ({
      kind: 'range',
      id,
      label,
      default: def,
      min,
      max,
      ...base(o),
      ...(o?.step !== undefined ? { step: o.step } : {}),
    }),
    seed: (id, label, def = 0) => ({ kind: 'seed', id, label, default: def, ...base(undefined) }),
  };
}

/** Enum option value as produced by `enumOf` ("Group" -> "group"). */
export function optionValue(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
