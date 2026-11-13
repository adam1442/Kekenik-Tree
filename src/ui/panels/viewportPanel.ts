import { getApp } from '@/app/context';
import type { EvaluationSummary } from '@/contracts/engine';
import { Vector3 } from 'three';
import { SceneSync } from '@/viewport/sceneSync';
import { getLodPreview } from '@/export/lod/lodPreview';
import { Viewport } from '@/viewport/viewport';
import { getLighting, onLightingChange, setLighting } from '@/viewport/lighting';
import { AxisGizmo } from '@/viewport/axisGizmo';
import { ForceGizmos } from '@/viewport/gizmos/forceGizmos';
import { GizmoLayer } from '@/viewport/gizmos/gizmoLayer';
import { TreePlacementGizmo } from '@/viewport/gizmos/treePlacementGizmo';
import { WindGizmo } from '@/viewport/gizmos/windGizmo';
import { NodeModeController } from '@/viewport/nodeModeController';
import { OverlaySystem } from '@/viewport/overlays/overlaySystem';
import { selectionStats, type SelectionStats } from '@/viewport/overlays/selectionStats';
import { writeWindParam } from '@/viewport/wind/windParams';
import { getWindSystem } from '@/viewport/wind/windSystem';
import type { ContentStats } from '@/viewport/types';
import { getViewFilter, onViewFilterChange } from '@/viewport/viewState';
import { h } from '../components/dom';
import type { PanelContext, PanelInstance } from '../docking/panelRegistry';
import { icon } from '../icons/icons';
import { buildViewportToolbar } from './viewportToolbar';

const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

function statsBox(stats: ContentStats | null, selected: SelectionStats | null): HTMLElement[] {
  if (!stats) return [];
  if (selected) {
    const r = (label: string, value: string, strong = false): HTMLElement =>
      h('div', `kt-vp-stat-row${strong ? ' strong' : ''}`, h('span', '', label), h('b', '', value));
    return [
      h('div', 'kt-vp-stat-title', `POLYGONS - ${selected.scope}`),
      ...selected.groups.map((g) => r(`${g.label}:`, `${fmt(g.triangles)} tris`)),
      r('TOTAL:', fmt(selected.triangles), true),
      h('div', 'kt-vp-stat-gap'),
      r('bones:', fmt(selected.bones)),
    ];
  }
  const row = (label: string, value: string, strong = false): HTMLElement =>
    h('div', `kt-vp-stat-row${strong ? ' strong' : ''}`, h('span', '', label), h('b', '', value));
  return [
    h('div', 'kt-vp-stat-title', 'POLYGONS - MODEL'),
    ...stats.groups.map((g) => row(`${g.label}:`, `${fmt(g.triangles)} tris`)),
    row('TOTAL:', fmt(stats.triangles), true),
    h('div', 'kt-vp-stat-gap'),
    row('branches:', fmt(stats.skeletonBranches ?? stats.bones)),
    row('points:', fmt(stats.skeletonPoints ?? 0)),
    row('bones:', fmt(stats.bones)),
  ];
}

/** Viewport panel: document tabs, toolbar, three.js canvas, overlays. Never recreates its WebGL context. */
export function createViewportPanel(host: HTMLElement, ctx: PanelContext): PanelInstance {
  const app = getApp();
  const store = app.store;

  // --- document tabs (also the drag handle of this headerless panel)
  const docTabs = h('div', 'kt-doctabs');
  const grip = h('div', 'kt-doctabs-grip');
  grip.title = 'Drag to move panel · double-click to float · right-click for menu';
  grip.addEventListener('pointerdown', (e) => ctx.startDrag(e));
  grip.addEventListener('dblclick', () => ctx.toggleFloat());
  grip.addEventListener('contextmenu', (e) => ctx.showMenu(e));
  const renderTabs = (): void => {
    const s = store.get();
    docTabs.replaceChildren(
      ...s.documents.map((d) => {
        const active = d.id === s.activeDocumentId;
        const close = h('button', 'kt-doctab-close', icon('close', 10));
        close.type = 'button';
        close.title = 'Close document';
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          app.commands.run('file.close');
        });
        const tab = h('div', `kt-doctab${active ? ' active' : ''}`, h('span', 'kt-doctab-name', d.name), active ? close : null);
        tab.addEventListener('pointerdown', (e) => {
          if (d.id !== store.get().activeDocumentId) store.set({ activeDocumentId: d.id });
          ctx.startDrag(e);
        });
        return tab;
      }),
      grip,
    );
  };

  // --- view area
  const view = h('div', 'kt-vp-view');
  const canvasWrap = h('div', 'kt-vp-canvas');
  const label = h('div', 'kt-vp-label', 'perspective');
  const stats = h('div', 'kt-vp-stats');
  const gizmo = new AxisGizmo(56);
  const gizmoWrap = h('div', 'kt-vp-gizmo', gizmo.el);
  const sunValue = h('div', 'kt-vp-light-value', '');
  const bulb = h('div', 'kt-vp-light', icon('bulb', 22), sunValue);
  bulb.title = 'Drag vertically: sun intensity';
  const sunDir = h('div', 'kt-vp-light kt-vp-sundir', icon('sunDir', 22));
  sunDir.title = 'Drag: sun direction';
  const info = h('div', 'kt-vp-info', '');
  const more = h('button', 'kt-vp-more', icon('dotsV', 12));
  more.type = 'button';
  view.append(canvasWrap, label, stats, gizmoWrap, bulb, sunDir, info, more);

  host.classList.add('kt-vp');
  host.append(docTabs, buildViewportToolbar(app, ctx), view);

  const viewport = new Viewport(canvasWrap);
  app.viewport = viewport;

  // --- wind preview + interactive gizmos (force handles, wind arrow)
  const wind = getWindSystem();
  wind.bind(viewport);
  const projectWind = () => app.project.metaOf(store.get().activeDocumentId)?.settings.wind ?? null;
  wind.syncProject(projectWind());
  const windPoll = window.setInterval(() => wind.syncProject(projectWind()), 200);
  const layer = new GizmoLayer(viewport, canvasWrap);
  const windGizmo = new WindGizmo(layer, wind, (deg) => {
    const ws = projectWind();
    if (!ws) return;
    writeWindParam(ws, 'directionDeg', deg);
    app.undo.markDirty();
    wind.syncProject(ws);
  });
  const forceGizmos = new ForceGizmos(app, viewport, layer);
  const treeGizmo = new TreePlacementGizmo(app, viewport, layer, canvasWrap);
  layer.onActiveChange = (o) => treeGizmo.setActive(o);

  // --- light controls
  const drag = (el: HTMLElement, onMove: (dx: number, dy: number) => void): void => {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      let lx = e.clientX;
      let ly = e.clientY;
      const move = (ev: PointerEvent): void => {
        onMove(ev.clientX - lx, ev.clientY - ly);
        lx = ev.clientX;
        ly = ev.clientY;
      };
      const up = (): void => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  };
  drag(bulb, (_dx, dy) => setLighting({ sunIntensity: Math.min(4, Math.max(0.1, getLighting().sunIntensity - dy * 0.01)) }));
  bulb.addEventListener('dblclick', () => app.dock?.openPanel('lighting'));
  drag(sunDir, (dx, dy) => {
    const l = getLighting();
    setLighting({ sunAzimuth: l.sunAzimuth - dx * 0.01, sunElevation: Math.min(1.5, Math.max(0.1, l.sunElevation + dy * 0.01)) });
  });
  bulb.title = 'Drag vertically: sun intensity · double-click: Lighting panel';
  const unsubLighting = onLightingChange((l) => {
    viewport.setLighting(l);
    store.set({ sunIntensity: l.sunIntensity });
  });
  const unsubSun = store.select((s) => s.sunIntensity, (v) => {
    if (Math.abs(getLighting().sunIntensity - v) > 1e-6) setLighting({ sunIntensity: v });
  });
  viewport.setLighting(getLighting());
  store.set({ sunIntensity: getLighting().sunIntensity });

  // --- content: incremental scene built from the evaluation engine's results
  const sync = new SceneSync();
  viewport.setContent(sync.content, false);
  const overlays = new OverlaySystem(viewport, canvasWrap, (id) => sync.getMesh(id));
  const nodeMode = new NodeModeController(app, viewport, canvasWrap);
  const overlayState = (): void => {
    const s = store.get();
    overlays.setState({ nodes: s.selection, editMode: s.editMode, instances: s.instanceSelection, hover: s.instanceHover, spinesOnTop: s.spinesOnTop, attachmentFrames: s.showAttachmentFrames });
  };
  const refreshStats = (): void => {
    const s = store.get();
    stats.replaceChildren(...statsBox(sync.stats, selectionStats(app.engine.latest?.scene ?? null, s.selection, s.editMode === 'node' ? s.instanceSelection : [])));
  };
  let framedDoc = '';
  const applyResult = (summary: EvaluationSummary): void => {
    const docId = store.get().activeDocumentId;
    const frame = framedDoc !== docId && summary.scene.entries.length > 0;
    const changed = sync.update(getLodPreview().resolve(summary));
    const size = sync.bounds.getSize(new Vector3());
    wind.setTreeHeight(size.z);
    windGizmo.setRadius(Math.max(size.x, size.y) * 0.5 + 1);
    forceGizmos.rebuild();
    viewport.requestRender();
    if (changed || frame) viewport.refreshContent(frame);
    if (frame) framedDoc = docId;
    overlays.setScene(summary.scene);
    nodeMode.setScene(summary.scene);
    refreshStats();
  };

  // --- state sync
  const syncOptions = (): void => {
    const s = store.get();
    viewport.setOptions({
      viewMode: s.viewMode,
      showGrid: s.showGrid,
      showGround: s.showGround,
      showHuman: s.showHuman,
      sunIntensity: s.sunIntensity,
    });
    // Skeleton layers per mode: Skeleton Lines = centre lines (+ optional samples / radii / frames), Points = samples only.
    sync.setSkeletonDebugOptions({
      showLines: s.viewMode === 'skeleton',
      showPoints: s.viewMode === 'points' || (s.viewMode === 'skeleton' && s.showSkeletonPoints),
      showRadii: s.viewMode === 'skeleton' && s.showSkeletonRadii,
      showFrames: s.viewMode === 'skeleton' && s.showSkeletonFrames,
    });
    stats.hidden = !s.showStats;
    gizmoWrap.hidden = !s.showAxes;
    sunValue.textContent = s.sunIntensity.toFixed(2);
  };
  const unsubs = [
    app.engine.events.on('result', applyResult),
    getLodPreview().onChange(() => {
      const latest = app.engine.latest;
      if (latest) applyResult(latest);
    }),
    onViewFilterChange(() => {
      sync.setFilter(getViewFilter());
      viewport.refreshContent();
    }),
    store.select((s) => s.selection, (ids) => {
      sync.setSelection(ids);
      overlayState();
      refreshStats();
      viewport.requestRender();
    }),
    store.select((s) => s.instanceSelection, () => {
      overlayState();
      refreshStats();
    }),
    store.select((s) => s.instanceHover, overlayState),
    store.select((s) => s.editMode, () => {
      overlayState();
      refreshStats();
    }),
    store.select((s) => s.spinesOnTop, overlayState),
    store.select((s) => s.showAttachmentFrames, overlayState),
    store.subscribe((s, prev) => {
      if (s.documents !== prev.documents || s.activeDocumentId !== prev.activeDocumentId) renderTabs();
      if (
        s.viewMode !== prev.viewMode ||
        s.showGrid !== prev.showGrid ||
        s.showAxes !== prev.showAxes ||
        s.showStats !== prev.showStats ||
        s.showGround !== prev.showGround ||
        s.showHuman !== prev.showHuman ||
        s.showSkeletonPoints !== prev.showSkeletonPoints ||
        s.showSkeletonRadii !== prev.showSkeletonRadii ||
        s.showSkeletonFrames !== prev.showSkeletonFrames ||
        s.sunIntensity !== prev.sunIntensity
      ) {
        syncOptions();
      }
    }),
  ];

  let lastPush = 0;
  viewport.onFrame = (f) => {
    gizmo.update(viewport.camera);
    const s = store.get();
    info.textContent = `[${navigator.hardwareConcurrency || 1} cpu threads], Last Compute ${s.stats.generationMs.toFixed(2)} ms (draw time ${f.drawMs.toFixed(2)} ms), distance ${f.distance.toFixed(2)}`;
    const now = performance.now();
    if (now - lastPush > 250) {
      lastPush = now;
      store.set({ stats: { ...s.stats, fps: f.fps, drawMs: f.drawMs, cameraDistance: f.distance } });
    }
  };

  sync.setFilter(getViewFilter());
  renderTabs();
  syncOptions();
  sync.setSelection(store.get().selection);
  overlayState();
  if (app.engine.latest) applyResult(app.engine.latest);

  return {
    onShow: () => viewport.requestRender(),
    dispose: () => {
      unsubs.forEach((u) => u());
      unsubLighting();
      unsubSun();
      window.clearInterval(windPoll);
      nodeMode.dispose();
      overlays.dispose();
      forceGizmos.dispose();
      treeGizmo.dispose();
      windGizmo.dispose();
      layer.dispose();
      wind.unbind(viewport);
      viewport.onFrame = null;
      if (app.viewport === viewport) app.viewport = null;
      viewport.dispose();
    },
  };
}
