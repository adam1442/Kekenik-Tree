import { paritySide, record, scaledCount, span, TAU } from './shared';
import type { ModeFrame, PlacementRecord, StepsRequest } from './types';

/**
 * Absolute steps / Proportional steps: nodes grow in steps (whorls, as on pines).
 * Step centres are spread evenly from First to Last. Inside a step the nodes sit at the same height, shifted lengthwise by
 * up to `spread` x (First..Last) and placed around the parent evenly (`balance` 1) or at random (`balance` 0).
 * Each step is turned by `stepRoll` relative to the previous one.
 */
export function steps(frame: ModeFrame, req: StepsRequest): PlacementRecord[] {
  const sp = span(frame);
  const keep = Math.sqrt(frame.lodKeep);
  const rawSteps = req.mode === 'proportional-steps' ? req.steps * frame.parentLength : req.steps;
  const stepCount = Math.max(0, Math.round(Math.round(rawSteps) * keep));
  const perStep = Math.max(1, Math.round(Math.round(req.perStep) * keep));
  const balance = Math.min(1, Math.max(0, req.balance));
  const total = scaledCount(frame, stepCount * perStep);
  const out: PlacementRecord[] = [];

  for (let i = 0; i < stepCount && out.length < total; i++) {
    const centre = stepCount === 1 ? (frame.first + frame.last) / 2 : frame.first + (i / (stepCount - 1)) * sp;
    const base = frame.rollBase + frame.branchPhase + i * req.stepRoll;
    for (let m = 0; m < perStep && out.length < total; m++) {
      const rng = frame.rng.fork(`s:${i}:${m}`);
      const even = m / perStep;
      const frac = even + (1 - balance) * (rng.next() - even);
      const t = centre + (rng.next() - 0.5) * req.spread * sp + frame.positionOffset;
      out.push(record(Math.min(frame.last, Math.max(frame.first, t)), base + frac * TAU, i, paritySide(i, m)));
    }
  }
  return out;
}
