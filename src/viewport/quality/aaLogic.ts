import type { PostAA, QualitySettings } from './qualitySettings';

/** Radical-inverse (Halton) sequence value; index >= 1. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Sub-pixel jitter in pixels, each component in [-0.5, 0.5), for the n-th (0-based) accumulated TAA frame. */
export function jitterOffset(frame: number): [number, number] {
  return [halton(frame + 1, 2) - 0.5, halton(frame + 1, 3) - 0.5];
}

export function clampPixelRatio(deviceRatio: number, max: number): number {
  return Math.max(0.5, Math.min(deviceRatio || 1, max));
}

export interface AaPlan {
  /** MSAA samples of the scene render target (0 = none). */
  samples: number;
  post: PostAA;
}

export interface PlanContext {
  /** Something changed within the hold time (camera move, slider drag, regeneration). */
  interactive: boolean;
  /** Content changes every frame (wind): temporal accumulation is impossible. */
  animating: boolean;
  /** `renderer.capabilities.maxSamples`. */
  maxSamples: number;
  /** Samples used by the cheap interactive level. */
  interactiveSamples?: number;
}

/**
 * Picks the AA configuration for the next frame.
 *  - full quality: the requested MSAA + post AA (TAA falls back to MSAA-only while the content animates);
 *  - interactive (progressive refinement): lower MSAA, no SMAA/TAA; FXAA stands in when MSAA is off so edges stay smooth.
 */
export function planAa(q: Pick<QualitySettings, 'msaaSamples' | 'postAA' | 'progressive'>, ctx: PlanContext): AaPlan {
  const supported = Math.max(0, Math.floor(ctx.maxSamples));
  let samples = Math.min(q.msaaSamples, supported);
  let post = q.postAA;
  if (ctx.animating && post === 'taa') post = samples > 0 ? 'none' : 'fxaa';
  if (ctx.interactive && q.progressive) {
    samples = Math.min(samples, ctx.interactiveSamples ?? 2);
    if (post === 'smaa' || post === 'taa') post = samples > 0 ? 'none' : 'fxaa';
  }
  return { samples, post };
}

/** Time-based progressive refinement: interactive until `holdMs` after the last `touch`. */
export class RefinementState {
  private last = Number.NEGATIVE_INFINITY;

  constructor(readonly holdMs = 150) {}

  touch(now: number): void {
    this.last = now;
  }

  isInteractive(now: number): boolean {
    return now - this.last < this.holdMs;
  }

  /** Milliseconds until the refined frame is due (0 when already refined). */
  msUntilRefine(now: number): number {
    return Math.max(0, this.holdMs - (now - this.last));
  }
}

/** Temporal accumulation bookkeeping: running average weights 1/(n+1), restart on any change. */
export class TaaAccumulator {
  private frames = 0;

  constructor(public target = 8) {}

  reset(): void {
    this.frames = 0;
  }

  get count(): number {
    return this.frames;
  }

  get done(): boolean {
    return this.frames >= this.target;
  }

  /** Jitter and blend weight of the frame about to be rendered; call `commit` afterwards. */
  next(): { jitter: [number, number]; weight: number } {
    return { jitter: jitterOffset(this.frames), weight: 1 / (this.frames + 1) };
  }

  commit(): void {
    this.frames++;
  }
}

/** Fingerprint of everything that moves the image; a change resets temporal accumulation. */
export function viewFingerprint(matrixWorld: ArrayLike<number>, projection: ArrayLike<number>, width: number, height: number): string {
  const parts: number[] = [width, height];
  for (let i = 0; i < 16; i++) parts.push(Math.round((matrixWorld[i] ?? 0) * 1e5), Math.round((projection[i] ?? 0) * 1e5));
  return parts.join(',');
}

export function describeAa(plan: AaPlan, pixelRatio: number): string {
  const parts: string[] = [];
  if (plan.samples > 0) parts.push(`MSAA ${plan.samples}x`);
  if (plan.post !== 'none') parts.push(plan.post.toUpperCase());
  if (parts.length === 0) parts.push('Off');
  return `${parts.join(' + ')} @ ${pixelRatio.toFixed(2)}x`;
}
