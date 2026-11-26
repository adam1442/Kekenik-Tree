import { beforeAll, describe, expect, it } from 'vitest';
import { listNodeDefs, registerDiscoveredNodes } from '@/graph/registry';
import { UNWIRED_VARIANCE } from '@/graph/registry/unwiredVariance';
import { varianceChangesScene, varianceParams } from './helpers/varianceAudit';

beforeAll(() => registerDiscoveredNodes());

/** Largest variance the audit applies: 0.5 (relative) or the parameter's own maximum. */
const auditAmount = (max: number | undefined): number => Math.min(0.5, max ?? 0.5);

describe('variance coverage', () => {
  it('every parameter that shows a "+/-" button changes the generated scene when its variance is on', async () => {
    const failing: string[] = [];
    for (const def of listNodeDefs()) {
      for (const p of varianceParams(def)) {
        if (UNWIRED_VARIANCE[p.id]?.includes(def.type)) continue; // non-zero default: button kept, effect conditional (see K09.md)
        if (!(await varianceChangesScene(def, p.id, auditAmount(p.variance?.max)))) failing.push(`${def.type}.${p.id}`);
      }
    }
    expect(failing).toEqual([]);
  }, 600_000);

  it('the registry hides the button of every unwired parameter (allow-list entries are real parameters)', () => {
    const defs = new Map(listNodeDefs().map((d) => [d.type, d]));
    for (const [id, types] of Object.entries(UNWIRED_VARIANCE)) {
      for (const type of types) {
        const def = defs.get(type);
        expect(def?.params.some((p) => p.id === id), `${type}.${id} exists`).toBe(true);
        const param = def?.params.find((p) => p.id === id);
        if (param && !param.variance) continue;
        expect(param?.variance?.default, `${type}.${id} keeps its button only because its default is not 0`).not.toBe(0);
      }
    }
  });
});
