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
import type { EvaluationSummary } from '@/contracts/engine';
import { getApp } from '@/app/context';
import { allPanelIds } from '@/ui/docking/layoutOps';
import { defaultLayout } from '@/ui/docking/layoutPresets';

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

describe('application shell (jsdom smoke test)', () => {
  it('renders the default layout with all panels and menus', () => {
    const root = boot();
    expect(root.querySelectorAll('.kt-group')).toHaveLength(4);
    expect(root.querySelectorAll('.kt-menubar-item')).toHaveLength(6);
    expect(root.querySelector('.kt-vp-toolbar')).not.toBeNull();
    expect(root.querySelector('.kt-graph-svg')).not.toBeNull();
    expect(root.querySelector('.kt-prop-tabs')).not.toBeNull();
    expect(root.querySelector('.kt-slots')).not.toBeNull();
    expect(root.querySelector('.kt-statusbar')).not.toBeNull();
  });

  it('floats, docks, closes and re-opens panels without losing them', () => {
    const root = boot();
    const dock = getApp().dock!;
    const host = root.querySelector('.kt-panel-host[data-panel="graph"]');
    dock.floatPanel('graph');
    expect(dock.isFloating('graph')).toBe(true);
    expect(root.querySelectorAll('.kt-fw')).toHaveLength(1);
    expect(root.querySelector('.kt-fw .kt-panel-host[data-panel="graph"]')).toBe(host); // same DOM host, state preserved
    dock.dockPanel('graph');
    expect(root.querySelectorAll('.kt-fw')).toHaveLength(0);
    expect(root.querySelector('.kt-group .kt-panel-host[data-panel="graph"]')).toBe(host);

    dock.closePanel('materials');
    expect(dock.isOpen('materials')).toBe(false);
    dock.openPanel('materials');
    expect(dock.isOpen('materials')).toBe(true);

    dock.closePanel('viewport'); // never closable
    expect(dock.isOpen('viewport')).toBe(true);
  });

  it('maximizes a group and restores it', () => {
    const root = boot();
    const dock = getApp().dock!;
    const group = dock.getLayout().root;
    expect(group).not.toBeNull();
    dock.toggleMaximize(root.querySelector<HTMLElement>('.kt-group')!.dataset.group);
    expect(root.querySelectorAll('.kt-maximized')).toHaveLength(1);
    dock.toggleMaximize(root.querySelector<HTMLElement>('.kt-group')!.dataset.group);
    expect(root.querySelectorAll('.kt-maximized')).toHaveLength(0);
  });

  it('keeps every panel exactly once through layout changes and persists the layout', () => {
    boot();
    const dock = getApp().dock!;
    dock.floatPanel('properties');
    dock.floatPanel('masks');
    dock.closePanel('meshes');
    dock.openPanel('timeline');
    const ids = allPanelIds(dock.getLayout());
    expect(new Set(ids).size).toBe(ids.length);
    dispose?.();
    dispose = null;
    expect(localStorage.getItem('kekenik.layout.current')).toContain('timeline');
  });

  it('applies layout presets via the Window > Layout commands', () => {
    boot();
    const app = getApp();
    app.dock!.floatPanel('graph');
    app.commands.run('window.resetLayout');
    expect(allPanelIds(app.dock!.getLayout()).sort()).toEqual(allPanelIds(defaultLayout()).sort());
    expect(app.dock!.isFloating('graph')).toBe(false);
  });

  it('opens menus from the menu bar and runs undoable commands', () => {
    const root = boot();
    const app = getApp();
    root.querySelectorAll<HTMLElement>('.kt-menubar-item')[4]!.click(); // Window
    expect(document.querySelectorAll('.kt-menu').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('Timeline');
    const seed = app.store.get().documents[0]!.seed;
    app.commands.run('tree.randomize');
    expect(app.store.get().documents[0]!.seed).not.toBe(seed);
    expect(app.store.get().canUndo).toBe(true);
    app.commands.run('edit.undo');
    expect(app.store.get().documents[0]!.seed).toBe(seed);
    app.commands.run('view.toggle.grid');
    expect(app.store.get().showGrid).toBe(false);
  });
});

describe('engine + project integration (jsdom)', () => {
  it('evaluates the default project, decorates nodes and reacts to edits and File > New', async () => {
    const root = boot();
    const app = getApp();
    const next = (): Promise<EvaluationSummary> =>
      new Promise((resolve) => {
        const off = app.engine.events.on('result', (r) => {
          if (r.preview) return;
          off();
          resolve(r);
        });
      });
    let pending = next();
    app.engine.schedule(0);
    const first = await pending;
    expect(first?.errors).toBe(0);
    expect(first?.scene.entries.length).toBeGreaterThan(3);
    expect(app.store.get().stats.triangles).toBeGreaterThan(1000);
    expect(app.graph.diagnostics.get('trunk')?.state).toMatch(/ok|cached/);
    expect(app.graph.rootInfo).toMatch(/^Nodes \d/);
    expect(app.graph.edgeLabels.size).toBeGreaterThan(0);

    pending = next();
    app.graph.setParam('leaf', 'number', { value: 2 });
    const second = await pending;
    expect(second?.evaluated).toBe(1);
    expect(app.store.get().dirty).toBe(true);

    app.commands.run('file.new');
    expect(app.store.get().documents).toHaveLength(2);
    expect(app.store.get().dirty).toBe(false);
    expect(root.querySelectorAll('.kt-doctab')).toHaveLength(2);
    expect(app.commands.get('file.save')?.shortcut).toBe('Mod+S');
  });
});

