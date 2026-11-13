import type { WindSettings } from '@/contracts/material';
import type { NodeDef } from '@/contracts/nodes';
import { getBool, getNumber } from '@/contracts/params';
import { PORT } from '@/graph/ports';
import { WIND_PARAM_RANGES, type WindNumericKey } from '@/viewport/wind/windParams';
import { section } from '../shared/builders';
import { attachOut } from '../shared/ports';

/**
 * Wind node: attached to the Tree output it replaces the project wind settings, attached to a generator it overrides
 * that generator's response (strength multiplier + stiffness). Parameter ids of the original contract are kept
 * (`direction`, `strength`, `gustiness`, `frequency`); everything else lands in `WindSettings.params`.
 */
const SECTION: Record<string, string> = { Wind: 'Wind', Gusts: 'Gusts', Response: 'Response', Dynamics: 'Dynamics' };
const PARAM_ID: Partial<Record<WindNumericKey, string>> = { directionDeg: 'direction', gustStrength: 'gustiness', gustFrequency: 'frequency' };
const EXTRA_KEYS: WindNumericKey[] = ['speed', 'turbulence', 'trunkResponse', 'branchResponse', 'leafResponse', 'stiffness', 'damping', 'ripple'];

const params = [
  section('Wind', 'Wind').bool('enabled', 'Enabled', true),
  ...WIND_PARAM_RANGES.map((r) => {
    const sec = section('Wind', SECTION[r.group]);
    return sec.float(PARAM_ID[r.key] ?? r.key, r.label, r.def, { min: r.min, max: r.max, softMax: r.softMax, step: r.step, ...(r.unit ? { unit: r.unit } : {}) });
  }),
];

export const nodeDefs: NodeDef[] = [
  {
    type: 'wind.settings',
    category: 'wind',
    label: 'Wind',
    icon: 'nodeWind',
    color: 'var(--kt-node-wind)',
    description: 'Wind settings: global when attached to the Tree, an override when attached to a generator.',
    ports: [attachOut('Wind')],
    params,
    evaluate: (_ctx, _inputs, p) => {
      const extra: WindSettings['params'] = {};
      for (const k of EXTRA_KEYS) extra[k] = { value: getNumber(p, k, WIND_PARAM_RANGES.find((r) => r.key === k)?.def ?? 0) };
      const value: WindSettings = {
        enabled: getBool(p, 'enabled', true),
        directionDeg: getNumber(p, 'direction'),
        strength: getNumber(p, 'strength', 1),
        gustiness: getNumber(p, 'gustiness', 0.3),
        frequency: getNumber(p, 'frequency', 1),
        params: extra,
      };
      return { [PORT.out]: { kind: 'Wind', value } };
    },
  },
];
