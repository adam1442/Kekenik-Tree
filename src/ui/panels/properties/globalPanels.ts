import { getApp, type AppContext } from '@/app/context';
import { activeDocument } from '@/app/state';
import { VIEW_MODES, VIEW_MODE_LABELS, type ViewMode } from '@/contracts/app';
import type { ParamDef, ParamState, RGBA } from '@/contracts/params';
import { rgbaToCss } from '../../components/colorPicker';
import { h, iconButton } from '../../components/dom';
import { showMenu } from '../../components/menu';
import { mountParamRow, type ParamRowInstance } from '../../components/params';
import type { PanelInstance } from '../../docking/panelRegistry';
import { icon } from '../../icons/icons';

function makeCollapsibleSection(
  title: string,
  rows: HTMLElement[],
  onResetSection?: () => void,
): HTMLElement {
  const chev = icon('chevronDown', 14);
  const dots = iconButton(icon('dotsV', 14), 'Section menu', (e) => {
    showMenu(
      [
        {
          label: 'Reset section',
          disabled: !onResetSection,
          run: () => onResetSection?.(),
        },
      ],
      e.currentTarget as HTMLElement,
    );
  });
  const head = h('div', 'kt-section-head', chev, h('span', 'kt-section-title', title), h('div', 'kt-spacer'), dots);
  const body = h('div', 'kt-section-body', ...rows);
  const sec = h('div', 'kt-section', head, body);
  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.kt-icon-btn')) return;
    const collapsed = sec.classList.toggle('collapsed');
    chev.style.transform = collapsed ? 'rotate(-90deg)' : '';
  });
  return sec;
}

/**
 * Mount the Tree / Project Settings sections (global seed, units, scale, season, LOD preview, wind)
 * into `container`. Used both by the standalone dockable Project Settings panel and by the Properties
 * Inspector when no node (or the Tree root) is selected.
 */
export function mountProjectSettingsContent(container: HTMLElement, app: AppContext = getApp()): { dispose(): void } {
  const rowInstances: ParamRowInstance[] = [];
  const unsubs: (() => void)[] = [];

  const getDoc = () => activeDocument(app.store.get());
  const getMeta = () => app.project.metaOf(app.store.get().activeDocumentId);
  const findTreeNode = () => app.graph.model.nodes().find((n) => n.type === 'output.tree');

  const seedDef: ParamDef = {
    kind: 'seed',
    id: 'globalSeed',
    label: 'Global seed',
    group: 'Project',
    default: 1337,
    tooltip: 'Master deterministic seed for the entire tree project.',
  };

  const unitsDef: ParamDef = {
    kind: 'enum',
    id: 'units',
    label: 'Units',
    group: 'Project',
    default: 'm',
    options: [
      { value: 'm', label: 'Meters (m)' },
      { value: 'cm', label: 'Centimeters (cm)' },
    ],
  };

  const lodPreviewDef: ParamDef = {
    kind: 'enum',
    id: 'lodLevel',
    label: 'LOD preview',
    group: 'LOD',
    default: 'High',
    options: [
      { value: 'Highest', label: 'Highest (LOD 0)' },
      { value: 'High', label: 'High (LOD 1)' },
      { value: 'Medium', label: 'Medium (LOD 2)' },
      { value: 'Low', label: 'Low (LOD 3)' },
    ],
  };

  const lodCountDef: ParamDef = {
    kind: 'int',
    id: 'lodCount',
    label: 'LOD count',
    group: 'LOD',
    default: 4,
    min: 1,
    max: 6,
  };

  const scaleDef: ParamDef = {
    kind: 'float',
    id: 'scale',
    label: 'Tree scale',
    group: 'Tree',
    default: 1,
    min: 0.01,
    max: 100,
    softMin: 0.1,
    softMax: 5,
  };

  const groundOffsetDef: ParamDef = {
    kind: 'float',
    id: 'groundOffset',
    label: 'Ground offset',
    group: 'Tree',
    default: 0,
    min: -10,
    max: 10,
    softMin: -2,
    softMax: 2,
    unit: 'm',
  };

  const seasonDef: ParamDef = {
    kind: 'float',
    id: 'season',
    label: 'Season',
    group: 'Tree',
    default: 0,
    min: 0,
    max: 1,
  };

  const windEnabledDef: ParamDef = {
    kind: 'bool',
    id: 'windEnabled',
    label: 'Enabled',
    group: 'Wind',
    default: true,
  };

  const windStrengthDef: ParamDef = {
    kind: 'float',
    id: 'windStrength',
    label: 'Strength',
    group: 'Wind',
    default: 0.3,
    min: 0,
    max: 10,
    softMax: 2,
  };

  const windDirDef: ParamDef = {
    kind: 'float',
    id: 'windDirection',
    label: 'Direction',
    group: 'Wind',
    default: 0,
    min: 0,
    max: 360,
    unit: '°',
  };

  const setProjectSeed = (nextSeed: number): void => {
    const doc = getDoc();
    const oldSeed = doc.seed;
    if (oldSeed === nextSeed) return;
    const apply = (sVal: number): void => {
      const meta = getMeta();
      if (meta) meta.settings.seed = sVal;
      app.store.set((s) => ({
        documents: s.documents.map((d) => (d.id === doc.id ? { ...d, seed: sVal } : d)),
      }));
    };
    app.undo.execute({
      label: 'Set Global Seed',
      do: () => apply(nextSeed),
      undo: () => apply(oldSeed),
    });
  };

  const projectRows: HTMLElement[] = [];
  const seedHost = h('div', '');
  const seedRow = mountParamRow(seedHost, {
    def: seedDef,
    state: { value: getDoc().seed },
    nodeName: 'Project',
    onChange: (next, merge) => {
      const val = typeof next.value === 'number' ? Math.round(next.value) : 1337;
      if (merge) {
        const doc = getDoc();
        const meta = getMeta();
        if (meta) meta.settings.seed = val;
        app.store.set((s) => ({
          documents: s.documents.map((d) => (d.id === doc.id ? { ...d, seed: val } : d)),
        }));
      } else {
        setProjectSeed(val);
      }
    },
  });
  rowInstances.push(seedRow);
  projectRows.push(seedRow.element);

  const unitsHost = h('div', '');
  const unitsRow = mountParamRow(unitsHost, {
    def: unitsDef,
    state: { value: getMeta()?.settings.units ?? 'm' },
    nodeName: 'Project',
    onChange: (next) => {
      const meta = getMeta();
      if (meta && (next.value === 'm' || next.value === 'cm')) {
        meta.settings.units = next.value;
        app.undo.markDirty();
      }
    },
  });
  rowInstances.push(unitsRow);
  projectRows.push(unitsRow.element);

  // Tree root rows (Scale, Ground offset, Season)
  const treeRows: HTMLElement[] = [];
  const bindTreeParam = (def: ParamDef): ParamRowInstance => {
    const holder = h('div', '');
    const tNode = findTreeNode();
    const initial = tNode?.params[def.id] ?? { value: def.default };
    const r = mountParamRow(holder, {
      def,
      state: initial,
      nodeName: 'Tree',
      onChange: (next, merge) => {
        const node = findTreeNode();
        if (node) {
          app.graph.setParam(node.id, def.id, next, merge);
        }
      },
      onCommit: () => app.graph.endGesture(),
    });
    rowInstances.push(r);
    treeRows.push(r.element);
    return r;
  };

  const scaleRow = bindTreeParam(scaleDef);
  const groundRow = bindTreeParam(groundOffsetDef);
  const seasonRow = bindTreeParam(seasonDef);

  // LOD rows
  const lodRows: HTMLElement[] = [];
  const lodPrevHolder = h('div', '');
  const lodPrevRow = mountParamRow(lodPrevHolder, {
    def: lodPreviewDef,
    state: { value: app.store.get().lodLevel },
    nodeName: 'Project',
    onChange: (next) => {
      const lv = next.value;
      if (lv === 'Highest' || lv === 'High' || lv === 'Medium' || lv === 'Low') {
        app.store.set({ lodLevel: lv });
      }
    },
  });
  rowInstances.push(lodPrevRow);
  lodRows.push(lodPrevRow.element);

  const lodCountHolder = h('div', '');
  const lodCountRow = mountParamRow(lodCountHolder, {
    def: lodCountDef,
    state: { value: getMeta()?.settings.lodCount ?? 4 },
    nodeName: 'Project',
    onChange: (next) => {
      const meta = getMeta();
      if (meta && typeof next.value === 'number') {
        meta.settings.lodCount = Math.round(next.value);
        app.undo.markDirty();
      }
    },
  });
  rowInstances.push(lodCountRow);
  lodRows.push(lodCountRow.element);

  // Global Wind rows
  const windRows: HTMLElement[] = [];
  const windEnHolder = h('div', '');
  const windEnRow = mountParamRow(windEnHolder, {
    def: windEnabledDef,
    state: { value: getMeta()?.settings.wind.enabled ?? false },
    nodeName: 'Wind',
    onChange: (next) => {
      const meta = getMeta();
      if (meta && typeof next.value === 'boolean') {
        meta.settings.wind.enabled = next.value;
        app.undo.markDirty();
      }
    },
  });
  rowInstances.push(windEnRow);
  windRows.push(windEnRow.element);

  const windStrHolder = h('div', '');
  const windStrRow = mountParamRow(windStrHolder, {
    def: windStrengthDef,
    state: { value: getMeta()?.settings.wind.strength ?? 0.3 },
    nodeName: 'Wind',
    onChange: (next) => {
      const meta = getMeta();
      if (meta && typeof next.value === 'number') {
        meta.settings.wind.strength = next.value;
        app.undo.markDirty();
      }
    },
  });
  rowInstances.push(windStrRow);
  windRows.push(windStrRow.element);

  const windDirHolder = h('div', '');
  const windDirRow = mountParamRow(windDirHolder, {
    def: windDirDef,
    state: { value: getMeta()?.settings.wind.directionDeg ?? 0 },
    nodeName: 'Wind',
    onChange: (next) => {
      const meta = getMeta();
      if (meta && typeof next.value === 'number') {
        meta.settings.wind.directionDeg = next.value;
        app.undo.markDirty();
      }
    },
  });
  rowInstances.push(windDirRow);
  windRows.push(windDirRow.element);

  container.append(
    makeCollapsibleSection('Project & Units', projectRows, () => {
      setProjectSeed(1337);
      unitsRow.update({ value: 'm' });
    }),
    makeCollapsibleSection('Tree Global', treeRows, () => {
      const node = findTreeNode();
      if (node) {
        app.graph.setParam(node.id, 'scale', { value: 1 }, false);
        app.graph.setParam(node.id, 'groundOffset', { value: 0 }, false);
        app.graph.setParam(node.id, 'season', { value: 0 }, false);
      }
    }),
    makeCollapsibleSection('LOD Preview', lodRows, () => {
      app.store.set({ lodLevel: 'High' });
    }),
    makeCollapsibleSection('Global Wind', windRows),
  );

  const syncFromApp = (): void => {
    seedRow.update({ value: getDoc().seed });
    unitsRow.update({ value: getMeta()?.settings.units ?? 'm' });
    lodPrevRow.update({ value: app.store.get().lodLevel });
    lodCountRow.update({ value: getMeta()?.settings.lodCount ?? 4 });
    const tNode = findTreeNode();
    if (tNode) {
      scaleRow.update(tNode.params.scale ?? { value: 1 });
      groundRow.update(tNode.params.groundOffset ?? { value: 0 });
      seasonRow.update(tNode.params.season ?? { value: 0 });
    }
  };

  unsubs.push(
    app.store.subscribe(() => syncFromApp()),
    app.events.on('graph:changed', () => syncFromApp()),
  );

  return {
    dispose(): void {
      unsubs.forEach((u) => u());
      rowInstances.forEach((r) => r.dispose());
    },
  };
}

/**
 * Mount the Viewport Settings sections (view mode, grid/ground/human/axes/stats, sun light, background colors)
 * into `container`. Wired directly to the viewport settings in `app.store` and `app.viewport`.
 */
export function mountViewportSettingsContent(container: HTMLElement, app: AppContext = getApp()): { dispose(): void } {
  const rowInstances: ParamRowInstance[] = [];
  const unsubs: (() => void)[] = [];

  let sunAzimuthDeg = 52;
  let sunElevationDeg = 54;
  let skyTopColor: RGBA = [0.77, 0.78, 0.78, 1];
  let skyMidColor: RGBA = [0.66, 0.67, 0.65, 1];
  let groundColor: RGBA = [0.48, 0.49, 0.3, 1];

  const viewModeDef: ParamDef = {
    kind: 'enum',
    id: 'viewMode',
    label: 'View mode',
    group: 'Viewport',
    default: 'shaded',
    options: VIEW_MODES.map((m) => ({ value: m, label: VIEW_MODE_LABELS[m] })),
  };

  const boolToggleDef = (id: string, label: string, defVal: boolean): ParamDef => ({
    kind: 'bool',
    id,
    label,
    group: 'Viewport',
    default: defVal,
  });

  const gridDef = boolToggleDef('showGrid', 'Show grid', true);
  const groundDef = boolToggleDef('showGround', 'Ground & shadows', true);
  const humanDef = boolToggleDef('showHuman', 'Human scale (1.8m)', true);
  const axesDef = boolToggleDef('showAxes', 'Axes gizmo', true);
  const statsDef = boolToggleDef('showStats', 'Polygon stats', true);

  const sunIntensityDef: ParamDef = {
    kind: 'float',
    id: 'sunIntensity',
    label: 'Sun intensity',
    group: 'Lighting',
    default: 1.5,
    min: 0.1,
    max: 4,
    softMin: 0.1,
    softMax: 4,
    step: 0.05,
  };

  const sunAzDef: ParamDef = {
    kind: 'float',
    id: 'sunAzimuth',
    label: 'Sun azimuth',
    group: 'Lighting',
    default: 52,
    min: -180,
    max: 180,
    unit: '°',
  };

  const sunElDef: ParamDef = {
    kind: 'float',
    id: 'sunElevation',
    label: 'Sun elevation',
    group: 'Lighting',
    default: 54,
    min: 5,
    max: 89,
    unit: '°',
  };

  const skyTopDef: ParamDef = {
    kind: 'color',
    id: 'skyTop',
    label: 'Sky top',
    group: 'Background',
    default: [0.77, 0.78, 0.78, 1],
  };

  const skyMidDef: ParamDef = {
    kind: 'color',
    id: 'skyMid',
    label: 'Sky horizon',
    group: 'Background',
    default: [0.66, 0.67, 0.65, 1],
  };

  const skyBotDef: ParamDef = {
    kind: 'color',
    id: 'skyBottom',
    label: 'Ground tint',
    group: 'Background',
    default: [0.48, 0.49, 0.3, 1],
  };

  const displayRows: HTMLElement[] = [];
  const mountDisplayRow = (def: ParamDef, initial: ParamState, onChange: (next: ParamState) => void): ParamRowInstance => {
    const holder = h('div', '');
    const r = mountParamRow(holder, {
      def,
      state: initial,
      nodeName: 'Viewport',
      onChange,
    });
    rowInstances.push(r);
    displayRows.push(r.element);
    return r;
  };

  const s0 = app.store.get();
  const vmRow = mountDisplayRow(viewModeDef, { value: s0.viewMode }, (next) => {
    app.store.set({ viewMode: next.value as ViewMode });
  });
  const gridRow = mountDisplayRow(gridDef, { value: s0.showGrid }, (next) => {
    app.store.set({ showGrid: Boolean(next.value) });
  });
  const groundRow = mountDisplayRow(groundDef, { value: s0.showGround }, (next) => {
    app.store.set({ showGround: Boolean(next.value) });
  });
  const humanRow = mountDisplayRow(humanDef, { value: s0.showHuman }, (next) => {
    app.store.set({ showHuman: Boolean(next.value) });
  });
  const axesRow = mountDisplayRow(axesDef, { value: s0.showAxes }, (next) => {
    app.store.set({ showAxes: Boolean(next.value) });
  });
  const statsRow = mountDisplayRow(statsDef, { value: s0.showStats }, (next) => {
    app.store.set({ showStats: Boolean(next.value) });
  });

  // Lighting rows
  const lightRows: HTMLElement[] = [];
  const sunIntHolder = h('div', '');
  const sunIntRow = mountParamRow(sunIntHolder, {
    def: sunIntensityDef,
    state: { value: s0.sunIntensity },
    nodeName: 'Lighting',
    onChange: (next) => {
      if (typeof next.value === 'number') app.store.set({ sunIntensity: next.value });
    },
  });
  rowInstances.push(sunIntRow);
  lightRows.push(sunIntRow.element);

  const applySunDir = (): void => {
    const azRad = (sunAzimuthDeg * Math.PI) / 180;
    const elRad = (sunElevationDeg * Math.PI) / 180;
    app.viewport?.setSunDirection(azRad, elRad);
  };

  const sunAzHolder = h('div', '');
  const sunAzRow = mountParamRow(sunAzHolder, {
    def: sunAzDef,
    state: { value: sunAzimuthDeg },
    nodeName: 'Lighting',
    onChange: (next) => {
      if (typeof next.value === 'number') {
        sunAzimuthDeg = next.value;
        applySunDir();
      }
    },
  });
  rowInstances.push(sunAzRow);
  lightRows.push(sunAzRow.element);

  const sunElHolder = h('div', '');
  const sunElRow = mountParamRow(sunElHolder, {
    def: sunElDef,
    state: { value: sunElevationDeg },
    nodeName: 'Lighting',
    onChange: (next) => {
      if (typeof next.value === 'number') {
        sunElevationDeg = next.value;
        applySunDir();
      }
    },
  });
  rowInstances.push(sunElRow);
  lightRows.push(sunElRow.element);

  // Background color rows
  const bgRows: HTMLElement[] = [];
  const applyBgColors = (): void => {
    const rootStyle = document.documentElement.style;
    rootStyle.setProperty('--kt-viewport-top', rgbaToCss(skyTopColor));
    rootStyle.setProperty('--kt-viewport-mid', rgbaToCss(skyMidColor));
    rootStyle.setProperty('--kt-viewport-bottom', rgbaToCss(groundColor));
  };

  const mountBgColorRow = (def: ParamDef, initRgba: RGBA, assign: (c: RGBA) => void): ParamRowInstance => {
    const holder = h('div', '');
    const r = mountParamRow(holder, {
      def,
      state: { value: [...initRgba] },
      nodeName: 'Background',
      onChange: (next) => {
        if (Array.isArray(next.value) && next.value.length === 4) {
          assign(next.value as RGBA);
          applyBgColors();
        }
      },
    });
    rowInstances.push(r);
    bgRows.push(r.element);
    return r;
  };

  const skyTopRow = mountBgColorRow(skyTopDef, skyTopColor, (c) => {
    skyTopColor = c;
  });
  const skyMidRow = mountBgColorRow(skyMidDef, skyMidColor, (c) => {
    skyMidColor = c;
  });
  const skyBotRow = mountBgColorRow(skyBotDef, groundColor, (c) => {
    groundColor = c;
  });

  // Camera quick actions row
  const frameBtn = h('button', 'kt-btn', 'Frame Selection (F)');
  frameBtn.type = 'button';
  frameBtn.addEventListener('click', () => app.viewport?.frame());

  const resetCamBtn = h('button', 'kt-btn', 'Reset Camera (Home)');
  resetCamBtn.type = 'button';
  resetCamBtn.addEventListener('click', () => app.viewport?.resetCamera());

  const cameraActionsRow = h('div', 'kt-row kt-vp-cam-actions', frameBtn, resetCamBtn);

  container.append(
    makeCollapsibleSection('Display & Overlays', [...displayRows, cameraActionsRow], () => {
      app.store.set({
        viewMode: 'shaded',
        showGrid: true,
        showGround: true,
        showHuman: true,
        showAxes: true,
        showStats: true,
      });
    }),
    makeCollapsibleSection('Lighting', lightRows, () => {
      app.store.set({ sunIntensity: 1.5 });
      sunAzimuthDeg = 52;
      sunElevationDeg = 54;
      sunAzRow.update({ value: sunAzimuthDeg });
      sunElRow.update({ value: sunElevationDeg });
      applySunDir();
    }),
    makeCollapsibleSection('Background Gradient', bgRows, () => {
      skyTopColor = [...skyTopDef.default];
      skyMidColor = [...skyMidDef.default];
      groundColor = [...skyBotDef.default];
      skyTopRow.update({ value: skyTopColor });
      skyMidRow.update({ value: skyMidColor });
      skyBotRow.update({ value: groundColor });
      applyBgColors();
    }),
  );

  unsubs.push(
    app.store.subscribe((s) => {
      vmRow.update({ value: s.viewMode });
      gridRow.update({ value: s.showGrid });
      groundRow.update({ value: s.showGround });
      humanRow.update({ value: s.showHuman });
      axesRow.update({ value: s.showAxes });
      statsRow.update({ value: s.showStats });
      sunIntRow.update({ value: s.sunIntensity });
    }),
  );

  return {
    dispose(): void {
      unsubs.forEach((u) => u());
      rowInstances.forEach((r) => r.dispose());
    },
  };
}

/** Standalone dockable Tree / Project Settings panel (`id: 'project-settings'`). */
export function createProjectSettingsPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  host.classList.add('kt-props', 'kt-global-settings');

  const head = h(
    'div',
    'kt-prop-head',
    h('span', 'kt-prop-node-badge', icon('globe', 15)),
    h('div', 'kt-prop-title', 'Project Settings'),
    h('div', 'kt-spacer'),
  );
  const scroll = h('div', 'kt-prop-scroll');
  const mounted = mountProjectSettingsContent(scroll, app);
  host.append(head, scroll);

  return {
    dispose(): void {
      mounted.dispose();
    },
  };
}

/** Standalone dockable Viewport Settings panel (`id: 'viewport-settings'`). */
export function createViewportSettingsPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  host.classList.add('kt-props', 'kt-global-settings');

  const head = h(
    'div',
    'kt-prop-head',
    h('span', 'kt-prop-node-badge', icon('eye', 15)),
    h('div', 'kt-prop-title', 'Viewport Settings'),
    h('div', 'kt-spacer'),
  );
  const scroll = h('div', 'kt-prop-scroll');
  const mounted = mountViewportSettingsContent(scroll, app);
  host.append(head, scroll);

  return {
    dispose(): void {
      mounted.dispose();
    },
  };
}
