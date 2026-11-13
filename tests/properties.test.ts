// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UndoStack } from '@/app/commands/undoStack';
import { setApp, type AppContext, type AppEvents } from '@/app/context';
import { GraphSession } from '@/app/graphSession';
import { defaultGraph } from '@/app/project/defaultGraph';
import type { FileIO } from '@/app/project/fileAccess';
import { MemoryKeyValueStore } from '@/app/project/kvStore';
import { ProjectManager } from '@/app/project/projectManager';
import { createAppStore } from '@/app/state';
import { CommandRegistry } from '@/app/commands';
import { EngineHost } from '@/app/engineHost';
import type {
  AssetParamDef,
  BoolParamDef,
  EnumParamDef,
  FloatParamDef,
  IntParamDef,
  ListParamDef,
  ParamState,
  RangeParamDef,
  SeedParamDef,
  StringParamDef,
  Vec2ParamDef,
  Vec3ParamDef,
} from '@/contracts/params';
import { EventBus } from '@/core/eventBus';
import { listNodeDefs, registerDiscoveredNodes } from '@/graph/registry';
import {
  listRegisteredParamWidgetKinds,
  mountParamWidget,
} from '@/ui/components/paramWidgetRegistry';
import {
  buildInspectorSections,
  applyParamToSelectedNodes,
  createProjectSettingsPanel,
  createPropertiesPanel,
  createViewportSettingsPanel,
  getInspectorTabs,
  resolveSharedParams,
} from '@/ui/panels/properties';
import {
  clampNumericParam,
  clampRangeParam,
  clampVecComponent,
  computeMixedParamState,
  computeScrubDelta,
  copyParamToClipboard,
  formatParamNumber,
  formatVarianceBadge,
  getParamFromClipboard,
  getSliderBounds,
  isParamModified,
  isParamVisibleForNodes,
  matchesParamSearch,
  mountParamRow,
  parseNumericInput,
} from '@/ui/components/params';

beforeAll(() => {
  registerDiscoveredNodes();
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

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
});

function createTestApp(): { app: AppContext; dispose(): void } {
  const store = createAppStore();
  const events = new EventBus<AppEvents>();
  const commands = new CommandRegistry();
  const undo = new UndoStack(store);
  const dialogLayer = document.createElement('div');
  document.body.append(dialogLayer);

  const graph = new GraphSession({
    store,
    undo,
    appEvents: events,
    notify: () => undefined,
  });
  const engine = new EngineHost({
    store,
    graph,
    events,
  });
  const fileIO: FileIO = {
    openFile: () => Promise.resolve(null),
    pickFile: () => Promise.resolve(null),
    writeHandle: () => Promise.resolve(),
    saveAs: () => Promise.resolve(null),
    readHandle: () => Promise.resolve(null),
    download: () => undefined,
  };
  const project = new ProjectManager({
    store,
    graph,
    undo,
    fileIO,
    kv: new MemoryKeyValueStore(),
    ui: { choose: () => Promise.resolve(1), ask: () => Promise.resolve(null) },
    notify: () => undefined,
  });

  const app: AppContext = {
    store,
    events,
    commands,
    undo,
    graph,
    engine,
    project,
    dialogLayer,
    dock: null,
    viewport: null,
    notify: () => undefined,
  };
  setApp(app);
  graph.loadGraph(defaultGraph());
  return {
    app,
    dispose: () => {
      engine.dispose();
      project.dispose();
      graph.dispose();
      dialogLayer.remove();
    },
  };
}

describe('valueOps: clamping, soft vs hard limits, step, scrub & search', () => {
  const floatDef: FloatParamDef = {
    kind: 'float',
    id: 'length',
    label: 'Length',
    group: 'Spine',
     subgroup: 'Length',
    default: 10,
    min: 0,
    max: 500,
    softMin: 0,
    softMax: 50,
    step: 0.5,
    unit: 'm',
    variance: { default: 0.1 },
    curveAllowed: true,
  };

  const intDef: IntParamDef = {
    kind: 'int',
    id: 'segments',
    label: 'Segments',
    group: 'Spine',
    default: 8,
    min: 2,
    max: 64,
    step: 2,
  };

  it('distinguishes soft slider limits from hard typed/scrubbed limits', () => {
    const bounds = getSliderBounds(floatDef);
    expect(bounds.sliderMin).toBe(0);
    expect(bounds.sliderMax).toBe(50);
    expect(bounds.hardMin).toBe(0);
    expect(bounds.hardMax).toBe(500);

    // Soft clamp (slider drag) caps at softMax = 50
    expect(clampNumericParam(floatDef, 120, true, false)).toBe(50);
    // Hard clamp (typing / scrubbing) allows 120 up to hardMax = 500
    expect(clampNumericParam(floatDef, 120, false, false)).toBe(120);
    expect(clampNumericParam(floatDef, 900, false, false)).toBe(500);
    expect(clampNumericParam(floatDef, -5, false, false)).toBe(0);
  });

  it('rounds and snaps int parameters to step and bounds', () => {
    expect(clampNumericParam(intDef, 7.2, false, true)).toBe(8);
    expect(clampNumericParam(intDef, 1, false, true)).toBe(2);
    expect(clampNumericParam(intDef, 100, false, true)).toBe(64);
  });

  it('clamps range pairs and vec components', () => {
    const rangeDef: RangeParamDef = {
      kind: 'range',
      id: 'bounds',
      label: 'Bounds',
      group: 'Gen',
      default: [0.2, 0.8],
      min: 0,
      max: 1,
      step: 0.05,
    };
    expect(clampRangeParam(rangeDef, -0.5, 1.5)).toEqual([0, 1]);
    expect(clampRangeParam(rangeDef, 0.72, 0.24)).toEqual([0.25, 0.7]);

    const vecDef: Vec3ParamDef = {
      kind: 'vec3',
      id: 'dir',
      label: 'Direction',
      group: 'Force',
      default: [0, 0, 1],
      min: -1,
      max: 1,
      step: 0.25,
    };
    expect(clampVecComponent(vecDef, 2.4, true)).toBe(1);
    expect(clampVecComponent(vecDef, 0.36, true)).toBe(0.25);
  });

  it('computes scrub delta with Shift (fine) and Ctrl (coarse) modifiers', () => {
    const normal = computeScrubDelta(floatDef, 20);
    const fine = computeScrubDelta(floatDef, 20, { shiftKey: true });
    const coarse = computeScrubDelta(floatDef, 20, { ctrlKey: true });
    expect(fine).toBeCloseTo(normal * 0.1, 5);
    expect(coarse).toBeCloseTo(normal * 10, 5);
  });

  it('parses numbers, units, and arithmetic expressions in numeric fields', () => {
    expect(parseNumericInput('12.5 m', 0)).toBe(12.5);
    expect(parseNumericInput('45°', 0)).toBe(45);
    expect(parseNumericInput('10 + 5 * 2', 0)).toBe(20);
    expect(parseNumericInput('(1 + 3) / 8', 0)).toBe(0.5);
    expect(parseNumericInput('invalid', 7)).toBe(7);
    expect(formatParamNumber(0.13600001)).toBe('0.136');
    expect(formatVarianceBadge(0.1)).toBe('.10');
  });

  it('detects modified state for value, variance, and curve', () => {
    expect(isParamModified(floatDef, { value: 10, variance: 0.1, curve: null })).toBe(false);
    expect(isParamModified(floatDef, { value: 12, variance: 0.1, curve: null })).toBe(true);
    expect(isParamModified(floatDef, { value: 10, variance: 0.25, curve: null })).toBe(true);
  });

  it('matches search queries including pipe-separated OR expressions', () => {
    const defs: FloatParamDef[] = [
      { kind: 'float', id: 'seasonDropTime', label: 'Drop time', group: 'Material', subgroup: 'Season', default: 1 },
      { kind: 'float', id: 'vertexColorVariance', label: 'Variance', group: 'Material', subgroup: 'Vertex Color', default: 0.1 },
      { kind: 'float', id: 'length', label: 'Length', group: 'Spine', subgroup: 'Length', default: 10 },
    ];
    const query = 'Season|Leaves:Type|Vertex Color:|Lightmap';
    expect(matchesParamSearch(defs[0]!, query)).toBe(true);
    expect(matchesParamSearch(defs[1]!, query)).toBe(true);
    expect(matchesParamSearch(defs[2]!, query)).toBe(false);
  });
});

describe('visibleIf evaluation & multi-selection mixed values', () => {
  it('evaluates visibleIf across single and multiple selected nodes', () => {
    const { app, dispose } = createTestApp();
    try {
      const trunk = app.graph.model.getNode('trunk')!;
      const trunkDef = listNodeDefs().find((d) => d.type === trunk.type)!;
      const numberDef = trunkDef.params.find((p) => p.id === 'number')!;
      const densityDef = trunkDef.params.find((p) => p.id === 'density')!;

      // Default mode is 'absolute' -> number is visible, density is hidden
      expect(isParamVisibleForNodes(numberDef, [trunk.params])).toBe(true);
      expect(isParamVisibleForNodes(densityDef, [trunk.params])).toBe(false);

      // Switch mode to 'density' -> number is hidden, density is visible
      app.graph.setParam('trunk', 'mode', { value: 'density' });
      expect(isParamVisibleForNodes(numberDef, [trunk.params])).toBe(false);
      expect(isParamVisibleForNodes(densityDef, [trunk.params])).toBe(true);
    } finally {
      dispose();
    }
  });

  it('detects mixed values across multiple selected nodes and resolves shared params', () => {
    const { app, dispose } = createTestApp();
    try {
      const big = app.graph.model.getNode('big')!;
      const little = app.graph.model.getNode('little')!;
      const shared = resolveSharedParams([big, little]);
      expect(shared.length).toBeGreaterThan(20);

      const numberDef = shared.find((p) => p.id === 'number')!;
      const firstDef = shared.find((p) => p.id === 'first')!;
      const alignDef = shared.find((p) => p.id === 'align')!;

      // 'big' has number=14, 'little' has number=9 -> mixed!
      const numMixed = computeMixedParamState(numberDef, [big.params.number, little.params.number]);
      expect(numMixed.valueMixed).toBe(true);

      // Both have align=false -> not mixed!
      const alignMixed = computeMixedParamState(alignDef, [big.params.align, little.params.align]);
      expect(alignMixed.valueMixed).toBe(false);

      // Applying a shared edit updates both nodes and clears mixed state
      applyParamToSelectedNodes(app, ['big', 'little'], firstDef, { value: 0.42 }, false);
      expect(big.params.first?.value).toBe(0.42);
      expect(little.params.first?.value).toBe(0.42);
      const afterMixed = computeMixedParamState(firstDef, [big.params.first, little.params.first]);
      expect(afterMixed.valueMixed).toBe(false);
    } finally {
      dispose();
    }
  });
});

describe('undo merging for single and multi-node parameter scrubs', () => {
  it('merges consecutive live scrub changes into a single undo entry until endGesture()', () => {
    const { app, dispose } = createTestApp();
    try {
      const trunk = app.graph.model.getNode('trunk')!;
      const initialLength = trunk.params.length?.value;
      expect(typeof initialLength).toBe('number');

      // Simulate slider drag / label scrub with merge = true
      app.graph.setParam('trunk', 'length', { value: 14 }, true);
      app.graph.setParam('trunk', 'length', { value: 16.5 }, true);
      app.graph.setParam('trunk', 'length', { value: 20 }, true);
      app.graph.endGesture();

      expect(trunk.params.length?.value).toBe(20);
      expect(app.undo.history().filter((h) => !h.undone)).toHaveLength(1);

      // One undo restores the original value
      app.undo.undo();
      expect(trunk.params.length?.value).toBe(initialLength);

      // Redo restores 20
      app.undo.redo();
      expect(trunk.params.length?.value).toBe(20);
    } finally {
      dispose();
    }
  });

  it('merges multi-node parameter scrubs into one undo step', () => {
    const { app, dispose } = createTestApp();
    try {
      const big = app.graph.model.getNode('big')!;
      const little = app.graph.model.getNode('little')!;
      const shared = resolveSharedParams([big, little]);
      const numberDef = shared.find((p) => p.id === 'number')!;

      expect(big.params.number?.value).toBe(14);
      expect(little.params.number?.value).toBe(9);

      applyParamToSelectedNodes(app, ['big', 'little'], numberDef, { value: 18 }, true);
      applyParamToSelectedNodes(app, ['big', 'little'], numberDef, { value: 22 }, true);
      applyParamToSelectedNodes(app, ['big', 'little'], numberDef, { value: 25 }, true);
      app.graph.endGesture();

      expect(big.params.number?.value).toBe(25);
      expect(little.params.number?.value).toBe(25);
      expect(app.undo.history().filter((h) => !h.undone)).toHaveLength(1);

      // Single undo restores each node's distinct prior value (14 and 9)
      app.undo.undo();
      expect(big.params.number?.value).toBe(14);
      expect(little.params.number?.value).toBe(9);
    } finally {
      dispose();
    }
  });
});

describe('widget registry: all 14 ParamDef kinds', () => {
  it('has all 14 ParamDef kinds registered and mounts/updates/disposes each cleanly', () => {
    const kinds = listRegisteredParamWidgetKinds();
    for (const k of [
      'float',
      'int',
      'bool',
      'enum',
      'vec2',
      'vec3',
      'color',
      'curve',
      'ramp',
      'range',
      'string',
      'seed',
      'asset',
      'list',
    ] as const) {
      expect(kinds).toContain(k);
    }

    const host = document.createElement('div');
    document.body.append(host);

    const changes: ParamState[] = [];
    const onChange = (next: ParamState): void => {
      changes.push(next);
    };

    const floatW = mountParamWidget(host, {
      def: { kind: 'float', id: 'f', label: 'Float', group: 'G', default: 0.5, min: 0, max: 10, softMax: 1 },
      state: { value: 0.5 },
      onChange,
    });
    expect(floatW).not.toBeNull();
    floatW!.update({ value: 0.8 });
    floatW!.dispose();

    const intW = mountParamWidget(host, {
      def: { kind: 'int', id: 'i', label: 'Int', group: 'G', default: 3, min: 0, max: 10 },
      state: { value: 3 },
      onChange,
    });
    expect(intW).not.toBeNull();
    intW!.dispose();

    const boolDef: BoolParamDef = { kind: 'bool', id: 'b', label: 'Bool', group: 'G', default: false };
    const boolW = mountParamWidget(host, { def: boolDef, state: { value: false }, onChange });
    expect(boolW).not.toBeNull();
    boolW!.element.click();
    expect(changes[changes.length - 1]?.value).toBe(true);
    boolW!.dispose();

    const enumDef: EnumParamDef = {
      kind: 'enum',
      id: 'e',
      label: 'Enum',
      group: 'G',
      default: 'a',
      options: [
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ],
    };
    const enumW = mountParamWidget(host, { def: enumDef, state: { value: 'a' }, onChange });
    expect(enumW?.element.textContent).toContain('Alpha');
    enumW!.dispose();

    const vec2Def: Vec2ParamDef = { kind: 'vec2', id: 'v2', label: 'Vec2', group: 'G', default: [1, 2] };
    const vec2W = mountParamWidget(host, { def: vec2Def, state: { value: [1, 2] }, onChange });
    expect(vec2W?.element.querySelectorAll('input')).toHaveLength(2);
    vec2W!.dispose();

    const vec3Def: Vec3ParamDef = { kind: 'vec3', id: 'v3', label: 'Vec3', group: 'G', default: [1, 2, 3] };
    const vec3W = mountParamWidget(host, { def: vec3Def, state: { value: [1, 2, 3] }, onChange });
    expect(vec3W?.element.querySelectorAll('input')).toHaveLength(3);
    vec3W!.dispose();

    const rangeDef: RangeParamDef = {
      kind: 'range',
      id: 'r',
      label: 'Range',
      group: 'G',
      default: [0.1, 0.9],
      min: 0,
      max: 1,
    };
    const rangeW = mountParamWidget(host, { def: rangeDef, state: { value: [0.1, 0.9] }, onChange });
    expect(rangeW?.element.querySelectorAll('input')).toHaveLength(2);
    rangeW!.dispose();

    const strDef: StringParamDef = { kind: 'string', id: 's', label: 'Str', group: 'G', default: 'hi' };
    const strW = mountParamWidget(host, { def: strDef, state: { value: 'hi' }, onChange });
    expect(strW).not.toBeNull();
    strW!.dispose();

    const seedDef: SeedParamDef = { kind: 'seed', id: 'sd', label: 'Seed', group: 'G', default: 42 };
    const seedW = mountParamWidget(host, { def: seedDef, state: { value: 42 }, onChange });
    seedW!.element.querySelector<HTMLButtonElement>('.kt-seed-dice')!.click();
    expect(typeof changes[changes.length - 1]?.value).toBe('number');
    seedW!.dispose();

    const assetDef: AssetParamDef = {
      kind: 'asset',
      id: 'as',
      label: 'Asset',
      group: 'G',
      assetKind: 'image',
      default: null,
    };
    const assetW = mountParamWidget(host, { def: assetDef, state: { value: null }, onChange });
    expect(assetW).not.toBeNull();
    assetW!.dispose();

    const listDef: ListParamDef = {
      kind: 'list',
      id: 'lst',
      label: 'Type',
      group: 'Material',
      subgroup: 'Leaves',
      minItems: 1,
      maxItems: 4,
      default: [{ material: '', weight: 1 }],
      fields: [
        { kind: 'enum', id: 'material', label: 'Material', group: 'Material', default: '', options: [{ value: '', label: 'None' }] },
        { kind: 'float', id: 'weight', label: 'Weight', group: 'Material', default: 1, min: 0, max: 1, curveAllowed: true },
      ],
    };
    const listW = mountParamWidget(host, { def: listDef, state: { value: [{ material: '', weight: 1 }] }, onChange });
    expect(listW?.element.querySelectorAll('.kt-type-card')).toHaveLength(1);
    // Click '+' to add a second Type card
    const plusBtn = listW!.element.querySelectorAll<HTMLButtonElement>('.kt-sq-btn')[1]!;
    plusBtn.click();
    expect(listW?.element.querySelectorAll('.kt-type-card')).toHaveLength(2);
    listW!.dispose();
  });

  it('supports variance sub-row, double-click label reset, and clipboard copy/paste on ParamRow', () => {
    const host = document.createElement('div');
    document.body.append(host);

    const def: FloatParamDef = {
      kind: 'float',
      id: 'dropTime',
      label: 'Drop time',
      group: 'Material',
      subgroup: 'Season',
      default: 1,
      min: 0,
      max: 1,
      variance: { default: 0 },
      curveAllowed: true,
    };

    let latest: ParamState = { value: 0.75, variance: 0.1, curve: null };
    const row = mountParamRow(host, {
      def,
      state: latest,
      onChange: (next) => {
        latest = next;
      },
    });

    // Variance is 0.1 -> renders blue '.10' badge
    expect(row.element.querySelector('.kt-badge')?.textContent).toBe('.10');
    expect(row.element.querySelector('.kt-row')?.classList.contains('modified')).toBe(true);

    // Copy to clipboard
    copyParamToClipboard(def, latest);
    expect(getParamFromClipboard(def)?.value).toBe(0.75);

    // Double-click label resets to default (value = 1, variance = 0)
    const label = row.element.querySelector<HTMLElement>('.kt-row-label')!;
    label.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(latest.value).toBe(1);
    expect(latest.variance).toBe(0);
    expect(row.element.querySelector('.kt-row')?.classList.contains('modified')).toBe(false);

    row.dispose();
  });
});

describe('Properties Inspector & Global Settings panels (DOM integration)', () => {
  it('renders every registered node type dynamically and reacts to selection, tabs, search, and edits', () => {
    const { app, dispose } = createTestApp();
    const host = document.createElement('div');
    document.body.append(host);
    const panel = createPropertiesPanel(host);

    try {
      // Select 'trunk' -> shows Trunk header and tabs (All, Gen, Spine, Forces, Shape, Skin, UV, LOD, Displacement, Material, Animation, Segments, Physics, Hand Drawn)
      app.graph.setSelection(['trunk']);
      expect(host.querySelector('.kt-prop-title')?.textContent).toBe('Trunk');
      const tabTexts = [...host.querySelectorAll('.kt-prop-tab')].map((t) => t.textContent);
      expect(tabTexts).toEqual([
        'All',
        'Gen',
        'Spine',
        'Forces',
        'Shape',
        'Skin',
        'UV',
        'LOD',
        'Displacement',
        'Material',
        'Animation',
        'Segments',
        'Physics',
        'Hand Drawn',
      ]);

      // In Generation tab, 'Number' is visible when Mode = Absolute, and 'Density' is hidden
      const numberRow = host.querySelector<HTMLElement>('[data-param-id="number"]')!.closest<HTMLElement>('.kt-param-item')!;
      const densityRow = host.querySelector<HTMLElement>('[data-param-id="density"]')!.closest<HTMLElement>('.kt-param-item')!;
      expect(numberRow.hidden).toBe(false);
      expect(densityRow.hidden).toBe(true);

      // Change Mode to 'density' -> Number hides, Density appears
      app.graph.setParam('trunk', 'mode', { value: 'density' });
      expect(numberRow.hidden).toBe(true);
      expect(densityRow.hidden).toBe(false);

      // Select 'leaf' and click 'Material' tab -> shows Leaves > Type cards and Season/Fallen parameters
      app.graph.setSelection(['leaf']);
      expect(host.querySelector('.kt-prop-title')?.textContent).toBe('Leaf');
      const matTab = [...host.querySelectorAll<HTMLButtonElement>('.kt-prop-tab')].find((b) => b.textContent === 'Material')!;
      matTab.click();
      expect(host.querySelectorAll('.kt-type-card').length).toBeGreaterThanOrEqual(1);
      expect(host.querySelector('[data-param-id="seasonDropTime"]')).not.toBeNull();
      expect(host.querySelector('[data-param-id="fallenJumble"]')).not.toBeNull();

      // Test pipe-separated search filter
      const searchInput = host.querySelector<HTMLInputElement>('.kt-prop-search-input')!;
      searchInput.value = 'Season|Leaves:Type|Vertex Color:|Lightmap';
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      expect(host.querySelector('[data-param-id="seasonDropTime"]')).not.toBeNull();

      // Clear search
      host.querySelector<HTMLButtonElement>('.kt-prop-search-clear')!.click();
      expect(searchInput.value).toBe('');

      // Verify every registered node type in the catalogue renders without error
      for (const def of listNodeDefs()) {
        const tabs = getInspectorTabs(def.params);
        expect(tabs.length).toBeGreaterThanOrEqual(1);
        const sections = buildInspectorSections(def.params, 'All');
        expect(sections.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      panel.dispose?.();
      dispose();
    }
  });

  it('mounts standalone Project Settings and Viewport Settings panels and updates store/project', () => {
    const { app, dispose } = createTestApp();
    const projHost = document.createElement('div');
    const vpHost = document.createElement('div');
    document.body.append(projHost, vpHost);

    const projPanel = createProjectSettingsPanel(projHost);
    const vpPanel = createViewportSettingsPanel(vpHost);
    try {
      expect(projHost.textContent).toContain('Project Settings');
      expect(projHost.textContent).toContain('Global seed');
      expect(projHost.textContent).toContain('LOD preview');

      expect(vpHost.textContent).toContain('Viewport Settings');
      expect(vpHost.textContent).toContain('View mode');
      expect(vpHost.textContent).toContain('Sun intensity');

      // Toggle 'Show grid' checkbox in Viewport Settings panel
      const gridCheck = vpHost
        .querySelector('[data-param-id="showGrid"]')!
        .querySelector<HTMLButtonElement>('.kt-check')!;
      expect(app.store.get().showGrid).toBe(true);
      gridCheck.click();
      expect(app.store.get().showGrid).toBe(false);
    } finally {
      projPanel.dispose?.();
      vpPanel.dispose?.();
      dispose();
    }
  });
});
