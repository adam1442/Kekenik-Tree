// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/viewport/viewport', async () => {
  const { Box3 } = await import('three');
  return {
  Viewport: class {
    camera = { fov: 35, position: { distanceTo: () => 1 } };
    scene = { add(): void {}, remove(): void {} };
    onFrame = null;
    addBeforeRender(): () => void {
      return () => undefined;
    }
    setAnimating(): void {}
    getBounds(): InstanceType<typeof Box3> {
      return new Box3();
    }
    setContent(): void {}
    setOptions(): void {}
    setSunDirection(): void {}
    setLighting(): void {}
    maxAnisotropy(): number {
      return 8;
    }
    setEnvironmentFile(): Promise<void> {
      return Promise.resolve();
    }
    frame(): void {}
    frameNodes(): void {}
    cameraDistance(): number {
      return 1;
    }
    resetCamera(): void {}
    refreshContent(): void {}
    requestRender(): void {}
    dispose(): void {}
  },
  };
});

import { bootstrap } from '@/app/bootstrap';

beforeAll(() => {
  class RO {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  HTMLCanvasElement.prototype.getContext = (() =>
    new Proxy(
      {},
      {
        get: (_t, p) =>
          p === 'createImageData'
            ? (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })
            : p === 'createRadialGradient' || p === 'createLinearGradient'
              ? () => ({ addColorStop(): void {} })
              : () => undefined,
        set: () => true,
      },
    )) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = '';
  localStorage.clear();
});

function boot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  dispose = bootstrap(root);
  return root;
}

describe('viewport toolbar audit', () => {
  const GROUPS = ['Mode', 'Edit', 'Scene', 'View', 'Post'];

  it('has the toolbar groups and every control has a tooltip and an aria-label', () => {
    const root = boot();
    const tb = root.querySelector('.kt-vp-toolbar2') as HTMLElement;
    expect(tb).not.toBeNull();
    const titles = [...tb.querySelectorAll('.kt-tb-group-title')].map((e) => e.textContent);
    expect(titles).toEqual(GROUPS);
    const controls = [...tb.querySelectorAll('button')];
    expect(controls.length).toBeGreaterThanOrEqual(17);
    for (const b of controls) {
      expect(b.title.length, b.outerHTML).toBeGreaterThan(0);
      expect(b.getAttribute('aria-label') ?? b.textContent, b.outerHTML).toBeTruthy();
    }
  });

  it('no control is a silent no-op: it opens a popover / menu, or is disabled with "Not available yet"', () => {
    const root = boot();
    const tb = root.querySelector('.kt-vp-toolbar2') as HTMLElement;
    const labels = ['Visibility', 'Season', 'LOD', 'Scene Objects', 'Wind', 'Light', 'Render', 'Show', 'Gizmo', 'Zoom', 'Shade'];
    for (const label of labels) {
      const b = tb.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(b, label).not.toBeNull();
      expect(b.disabled).toBe(false);
      b.click();
      expect(document.querySelectorAll('.kt-pop').length, label).toBe(1);
      b.click(); // second click closes
      expect(document.querySelectorAll('.kt-pop').length, label).toBe(0);
    }
    for (const label of ['AO', 'Collision']) {
      const b = tb.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toContain('Not available yet');
    }
    const freehand = tb.querySelector('button[aria-label="Freehand mode"]') as HTMLButtonElement;
    expect(freehand.disabled).toBe(true);
  });

  it('the Show popover offers the Alpha coverage diagnostic', () => {
    const root = boot();
    const tb = root.querySelector('.kt-vp-toolbar2') as HTMLElement;
    (tb.querySelector('button[aria-label="Show"]') as HTMLButtonElement).click();
    expect(document.querySelector('.kt-pop')?.textContent).toContain('Alpha coverage');
  });
});
