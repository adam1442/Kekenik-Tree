// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createViewportRenderer, createWebGLRenderer, isWebGLAvailable } from '@/viewport/rendererFactory';
import { bootstrap } from '@/app/bootstrap';
import { getApp } from '@/app/context';

const originalGetContext = HTMLCanvasElement.prototype.getContext;
type GetContext = typeof HTMLCanvasElement.prototype.getContext;
const stubContext = (impl: (id: string) => unknown): void => {
  HTMLCanvasElement.prototype.getContext = ((id: string) => impl(id)) as unknown as GetContext;
};

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  document.body.innerHTML = '';
  localStorage.clear();
});

describe('WebGL availability probe', () => {
  it('reports unavailable when the canvas has no WebGL2 context', () => {
    stubContext(() => null);
    expect(isWebGLAvailable()).toBe(false);
    expect(createWebGLRenderer()).toBeNull();
    expect(createViewportRenderer()).toBeNull();
  });

  it('rejects a fake context that does not answer driver queries', () => {
    stubContext(() => new Proxy({}, { get: () => () => undefined }));
    expect(isWebGLAvailable()).toBe(false);
    expect(createWebGLRenderer({ antialias: true })).toBeNull();
  });

  it('does not throw when getContext itself throws', () => {
    stubContext(() => {
      throw new Error('boom');
    });
    expect(isWebGLAvailable()).toBe(false);
  });

  it('accepts a context that answers getShaderPrecisionFormat and releases the probe context', async () => {
    // A positive result is cached per module instance, so probe a fresh copy to keep the other tests independent.
    vi.resetModules();
    const fresh = await import('@/viewport/rendererFactory');
    const loseContext = vi.fn();
    stubContext(() => ({
      VERTEX_SHADER: 0x8b31,
      HIGH_FLOAT: 0x8df2,
      getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),
      getExtension: (name: string) => (name === 'WEBGL_lose_context' ? { loseContext } : null),
    }));
    expect(fresh.isWebGLAvailable()).toBe(true);
    expect(fresh.isWebGLAvailable()).toBe(true); // cached: no second probe
    expect(loseContext).toHaveBeenCalledTimes(1);
  });
});

describe('viewport panel without WebGL', () => {
  beforeAll(() => {
    class RO {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    }
    (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  });

  it('shows a neutral placeholder, keeps the document tabs and does not register a viewport', () => {
    stubContext(() => null);
    const root = document.createElement('div');
    document.body.append(root);
    const dispose = bootstrap(root);
    try {
      expect(root.querySelector('.kt-vp-unavailable')?.textContent).toContain('WebGL unavailable');
      expect(root.querySelector('.kt-viewport-canvas')).toBeNull();
      expect(root.querySelector('.kt-vp-toolbar')).not.toBeNull();
      expect(root.querySelectorAll('.kt-doctab')).toHaveLength(1);
      expect(getApp().viewport).toBeNull();
      getApp().commands.run('file.new');
      expect(root.querySelectorAll('.kt-doctab')).toHaveLength(2);
    } finally {
      dispose();
    }
  }, 30_000);
});
