import { Rng } from '@/core/rng';
import { DEFAULT_SPLIT_SETTINGS, planSplit, type OpenEnd } from '@/generators/split';

export interface TestHalf {
  openEnd: OpenEnd;
  fat: boolean;
  side: 1 | 2;
}

/** The two open ends of a planned split of a 0.1 m parent (the only split model there is: `planSplit`). */
export function splitHalves(balance: number): TestHalf[] {
  const plan = planSplit({
    end: { position: [0, 0, 0], tangent: [0, 0, 1], up: [1, 0, 0], radius: 0.1 },
    parentLength: 2,
    ringSpacing: 0.1,
    rng: new Rng(1),
    chance: 1,
    parentTiles: 6,
    settings: { ...DEFAULT_SPLIT_SETTINGS, balance },
  });
  if (!plan) throw new Error('split expected');
  return plan.lobes.map((l) => ({ openEnd: l.openEnd, fat: l.kind === 'fat', side: l.side }));
}
