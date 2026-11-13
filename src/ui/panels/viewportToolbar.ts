import { commandItem } from '@/app/menus';
import type { AppContext } from '@/app/context';
import { formatShortcut } from '@/app/shortcuts';
import { VIEW_MODES, VIEW_MODE_LABELS, type EditMode, type ViewMode } from '@/contracts/app';
import type { WindSettings } from '@/contracts/material';
import { getMaterialLibrary } from '@/materials/library';
import { getLighting, setLighting } from '@/viewport/lighting';
import { DEBUG_VIEW_LIMITS, getDebugView, setDebugView } from '@/viewport/debug/debugSettings';
import { applyQualityPreset, getQuality, QUALITY_PRESETS, type QualityPreset } from '@/viewport/quality/qualitySettings';
import { addSceneObject, getSceneObjects, getViewFilter, removeSceneObject, setIsolate, setVisibility, showAll, updateSceneObject, VISIBILITY_LABELS, type VisibilityKey } from '@/viewport/viewState';
import { WIND_PARAM_RANGES, windParamsFromSettings, writeWindParam, type WindNumericKey } from '@/viewport/wind/windParams';
import { getWindSystem } from '@/viewport/wind/windSystem';
import { h, isMac } from '../components/dom';
import { showMenu, type MenuItem } from '../components/menu';
import { popButton, popHeading, popNote, popRow, popSelect, popSlider, popToggle, showPopover } from '../components/popover';
import type { PanelContext } from '../docking/panelRegistry';
import { icon, registerIcon } from '../icons/icons';
import { addMenuItems, compatibleDefs, type MenuHost } from './graph/graphMenus';
import { showAddNodePopup } from './graph/addNodePopup';

const EDIT_MODES: EditMode[] = ['generator', 'node', 'freehand'];
const NA = 'Not available yet';

// Toolbar glyphs (drawn in-house, 24x24 grid).
registerIcon('tbAdd', '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>');
registerIcon('tbVisibility', '<circle cx="8" cy="8" r="3"/><circle cx="16" cy="8" r="3"/><path d="M4 20c0-3 2-5 4-5s4 2 4 5M12 20c0-3 2-5 4-5s4 2 4 5"/>');
registerIcon('tbSeason', '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>');
registerIcon('tbLod', '<rect x="3" y="8" width="18" height="8" rx="1.5"/><path d="M7 8v8M11 8v8M15 8v8"/>');
registerIcon('tbObjects', '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>');
registerIcon('tbRender', '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>');
registerIcon('tbGizmo', '<path d="M5 19L12 12M12 12V4M12 12h8"/><circle cx="5" cy="19" r="1.5"/>');
registerIcon('tbAO', '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16" fill="currentColor"/>');
registerIcon('tbCollision', '<path d="M5 16c4 0 3-8 7-8s3 8 7 8M3 20h18"/>');
registerIcon('tbShade', '<path d="M12 3c4 5 6 8 6 11a6 6 0 01-12 0c0-3 2-6 6-11z"/>');

/**
 * Viewport toolbar - four labelled groups over two rows: Mode | Edit | Scene (row 1) and
 * View | Post (row 2). Every control has a tooltip + aria-label; settings open as popovers (`ui/components/popover.ts`).
 * Controls whose backend does not exist yet are disabled with the tooltip "Not available yet".
 */
export function buildViewportToolbar(app: AppContext, ctx: PanelContext): HTMLElement {
  const { store } = app;
  const tip = (text: string, commandId?: string): string => {
    const sc = commandId ? app.commands.get(commandId)?.shortcut : undefined;
    return sc ? `${text} (${formatShortcut(sc, isMac())})` : text;
  };
  const btn = (ic: string, label: string, title: string, onClick: (b: HTMLButtonElement) => void, disabled = false): HTMLButtonElement => {
    const b = h('button', 'kt-tb-lbl', icon(ic, 15), h('span', '', label));
    b.type = 'button';
    b.title = disabled ? `${label}: ${NA}` : title;
    b.setAttribute('aria-label', label);
    if (disabled) b.disabled = true;
    else b.addEventListener('click', () => onClick(b));
    return b;
  };
  const group = (title: string, ...items: HTMLElement[]): HTMLElement => h('div', 'kt-tb-group', h('div', 'kt-tb-group-title', title), h('div', 'kt-tb-group-row', ...items));

  // --- Mode
  const seg = h('div', 'kt-tb-seg');
  const modeSpecs: [string, string, string][] = [
    ['leafCircle', 'Generator', 'Generator mode: edit the global parameters of the selected node'],
    ['nodes', 'Node', 'Node mode: click one branch / trunk / spine and edit only that instance (Esc clears, Up parent, Down children, H hide, Del prune, Alt+drag marquee)'],
    ['brush', 'Freehand', `Freehand: ${NA}`],
  ];
  modeSpecs.forEach(([ic, label, title], i) => {
    const id = EDIT_MODES[i] as EditMode;
    const b = h('button', `kt-tb-seg-btn${store.get().editMode === id ? ' active' : ''}`, icon(ic, 16), h('span', '', label));
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', `${label} mode`);
    if (id === 'freehand') b.disabled = true;
    else b.addEventListener('click', () => store.set({ editMode: id }));
    seg.append(b);
  });
  store.select((s) => s.editMode, () => seg.querySelectorAll('.kt-tb-seg-btn').forEach((x, i) => x.classList.toggle('active', EDIT_MODES[i] === store.get().editMode)));

  // --- Edit
  const add = btn('tbAdd', 'Add', 'Add a node as a child of the selected node', (b) => {
    const sel = app.graph.getSelection();
    const anchor = sel.length === 1 ? { nodeId: sel[0] as string } : undefined;
    const defs = compatibleDefs(app, anchor?.nodeId);
    const r = b.getBoundingClientRect();
    const host: MenuHost = {
      app,
      openAddNode: (screen, a) => showAddNodePopup({ x: screen.x, y: screen.y, defs, onPick: (d) => void app.graph.addNode(d.type, { anchor: a }) }),
      startRename: () => undefined,
      startEditAnnotation: () => undefined,
    };
    showMenu(addMenuItems(host, defs, anchor, undefined, { x: r.left, y: r.bottom }), b);
  });

  const visibility = btn('tbVisibility', 'Visibility', 'Show / hide node families, isolate the selection', (b) =>
    showPopover(b, 'Visibility', (body, close) => {
      (Object.keys(VISIBILITY_LABELS) as VisibilityKey[]).forEach((k) => body.append(popToggle(VISIBILITY_LABELS[k], () => getViewFilter().visibility[k], (v) => setVisibility({ [k]: v }))));
      body.append(
        h('div', 'kt-pop-btns', popButton('Isolate selected', () => {
          const sel = store.get().selection;
          if (sel.length === 0) app.notify('Select a node first to isolate it.');
          else setIsolate(sel);
          close();
        }), popButton('Show all', () => {
          showAll();
          close();
        })),
      );
    }),
  );

  const season = btn('tbSeason', 'Season', 'Season 0..1: drives Material Set members, Season curves and Variations', (b) =>
    showPopover(b, 'Season', (body) => {
      const lib = getMaterialLibrary();
      body.append(popSlider('Season', 0, 1, 0.01, () => lib.season(), (v) => lib.setSeason(v)), popNote('Material Set members fade in / out with their Season curves; Override season on a set wins.'));
    }),
  );

  const lod = btn('tbLod', 'LOD', 'Level of detail used for generation and the viewport', (b) =>
    showPopover(b, 'LOD preview', (body) => {
      const tris = app.engine.latest?.scene.stats.triangles ?? 0;
      body.append(
        popSelect('Level', ['Highest', 'High', 'Medium', 'Low'].map((v) => ({ value: v, label: v })), () => store.get().lodLevel, (v) => store.set({ lodLevel: v as 'Highest' | 'High' | 'Medium' | 'Low' })),
        popRow('Triangles', h('span', 'kt-pop-value', tris.toLocaleString('en-US'))),
        popToggle('Auto by distance', () => false, () => undefined, NA),
        popNote('The fixed levels re-generate the plant at that LOD (Dynamic LOD curves live on the Tree node).'),
      );
    }),
  );

  // --- Scene
  const objects = btn('tbObjects', 'Scene Objects', 'Reference objects: human figure, ground, boxes / cylinders', (b) =>
    showPopover(b, 'Scene Objects', (body) => {
      const list = h('div', 'kt-pop-body');
      const renderList = (): void => {
        list.replaceChildren(
          ...getSceneObjects().map((o, i) =>
            popRow(`${o.kind} ${i + 1}`, popSlider('', 0.2, 6, 0.1, () => o.sx, (v) => updateSceneObject(o.id, o.kind === 'cylinder' ? { sx: v, sy: v } : { sx: v, sy: v, sz: v })).querySelector('input') as HTMLElement, popButton('Remove', () => {
              removeSceneObject(o.id);
              renderList();
            })),
          ),
        );
        count.textContent = String(getSceneObjects().length);
      };
      const count = h('span', 'kt-pop-value', '0');
      const place = (kind: 'box' | 'cylinder' | 'sphere'): void => {
        const n = getSceneObjects().length;
        addSceneObject(kind, { x: 4 + n * 1.6, y: ((n % 3) - 1) * 1.6 });
        renderList();
      };
      body.append(
        popToggle('Human reference', () => store.get().showHuman, (v) => store.set({ showHuman: v })),
        popToggle('Ground & shadows', () => store.get().showGround, (v) => store.set({ showGround: v })),
        popHeading('Reference objects'),
        h('div', 'kt-pop-btns', popButton('+ Box', () => place('box')), popButton('+ Cylinder', () => place('cylinder')), popButton('+ Sphere', () => place('sphere'))),
        list,
        popRow('Objects in scene', count),
        popToggle('Use as collision objects', () => false, () => undefined, NA),
      );
      renderList();
    }, 300),
  );

  const windBtn = btn('wind', 'Wind', 'Wind preview and settings', (b) =>
    showPopover(b, 'Wind', (body) => {
      const wind = getWindSystem();
      const settings = (): WindSettings | null => app.project.metaOf(store.get().activeDocumentId)?.settings.wind ?? null;
      const commit = (key: WindNumericKey | 'enabled', value: number | boolean): void => {
        const s = settings();
        if (!s) return;
        if (key === 'enabled') s.enabled = Boolean(value);
        else writeWindParam(s, key, Number(value));
        app.undo.markDirty();
        wind.syncProject(s);
      };
      body.append(popToggle('Enable wind', () => wind.params.enabled, (v) => commit('enabled', v)));
      const play = popButton(wind.state.playing ? 'Pause' : 'Play', () => {
        wind.patchState({ playing: !wind.state.playing });
        play.textContent = wind.state.playing ? 'Pause' : 'Play';
      });
      body.append(h('div', 'kt-pop-btns', play, popButton('Wind & Timeline panel…', () => app.dock?.openPanel('timeline'))));
      for (const key of ['directionDeg', 'speed', 'strength', 'gustStrength', 'turbulence', 'baseHold'] as const) {
        const r = WIND_PARAM_RANGES.find((x) => x.key === key);
        if (r) body.append(popSlider(r.label, r.min, r.softMax, r.step, () => windParamsFromSettings(settings())[key], (v) => commit(key, v), r.step < 0.1 ? 2 : 0));
      }
      body.append(popNote('Base hold: height above the ground over which the wind ramps in. Trunk bases and roots never move.'));
    }),
  );

  const light = btn('sun', 'Light', 'Sun, ambient light and shadows', (b) =>
    showPopover(b, 'Light', (body) => {
      const L = getLighting();
      body.append(
        popSlider('Sun intensity', 0, 4, 0.05, () => getLighting().sunIntensity, (v) => setLighting({ sunIntensity: v })),
        popSlider('Sun direction', 0, Math.PI * 2, 0.02, () => ((getLighting().sunAzimuth % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2), (v) => setLighting({ sunAzimuth: v })),
        popSlider('Sun height', 0.1, 1.5, 0.01, () => getLighting().sunElevation, (v) => setLighting({ sunElevation: v })),
        popSlider('Ambient', 0, 2, 0.05, () => getLighting().ambient, (v) => setLighting({ ambient: v })),
        popSlider('Exposure', 0.3, 2.5, 0.05, () => getLighting().exposure, (v) => setLighting({ exposure: v })),
        popSlider('Shadow softness', 0, 8, 0.1, () => L.shadowSoftness, (v) => setLighting({ shadowSoftness: v })),
        popToggle('Ground & shadows', () => store.get().showGround, (v) => store.set({ showGround: v })),
        h('div', 'kt-pop-btns', popButton('Lighting panel…', () => app.dock?.openPanel('lighting'))),
      );
    }),
  );

  // --- View
  const render = btn('tbRender', 'Render', 'View mode, debug view options and anti-aliasing', (b) =>
    showPopover(b, 'Render', (body) => {
      const limits = DEBUG_VIEW_LIMITS;
      body.append(
        popSelect('View mode', VIEW_MODES.map((m) => ({ value: m, label: VIEW_MODE_LABELS[m] })), () => store.get().viewMode, (v) => store.set({ viewMode: v as ViewMode })),
        popSlider('Normal length (m)', limits.normalLength.min, 0.5, 0.005, () => getDebugView().normalLength, (v) => setDebugView({ normalLength: v }), 3),
        popSlider('Point size (px)', limits.pointSize.min, limits.pointSize.max, 1, () => getDebugView().pointSize, (v) => setDebugView({ pointSize: v }), 0),
        popHeading('Quality'),
        popSelect('Preset', [...(Object.keys(QUALITY_PRESETS) as QualityPreset[]), 'custom'].map((p) => ({ value: p, label: p })), () => getQuality().preset, (v) => {
          if (v !== 'custom') applyQualityPreset(v as QualityPreset);
        }),
        popRow('Anti-aliasing', h('span', 'kt-pop-value', `${getQuality().msaaSamples ? `MSAA ${getQuality().msaaSamples}x` : 'no MSAA'} · ${getQuality().postAA}`)),
        h('div', 'kt-pop-btns', popButton('Viewport Quality panel…', () => app.dock?.openPanel('viewport-quality'))),
      );
    }),
  );

  const show = btn('eye', 'Show', 'Overlays: stats, grid, axes, ground, human, spines, skeleton layers', (b) =>
    showPopover(b, 'Show', (body) => {
      const toggles: [string, string][] = [
        ['Polygon stats', 'view.toggle.stats'],
        ['Grid', 'view.toggle.grid'],
        ['Axes gizmo', 'view.toggle.axes'],
        ['Ground & shadows', 'view.toggle.ground'],
        ['Human reference', 'view.toggle.human'],
        ['Spines on top', 'view.toggle.spinesOnTop'],
        ['Skeleton: sample points', 'view.toggle.skeletonPoints'],
        ['Skeleton: radius circles', 'view.toggle.skeletonRadii'],
        ['Skeleton: normal frames', 'view.toggle.skeletonFrames'],
        ['Attachment frames', 'view.toggle.showAttachmentFrames'],
      ];
      for (const [label, id] of toggles) {
        const cmd = app.commands.get(id);
        body.append(popToggle(label, () => cmd?.checked?.() ?? false, () => app.commands.run(id)));
      }
      body.append(
        popToggle('Alpha coverage', () => store.get().viewMode === 'alpha', (v) => store.set({ viewMode: v ? 'alpha' : 'shaded' })),
        popToggle('Bounds', () => false, () => undefined, NA),
        popNote('Alpha coverage: lime = pixels that pass the alpha test, grey = non-cut-out surfaces.'),
      );
    }),
  );

  const gizmo = btn('tbGizmo', 'Gizmo', 'Axis gizmo and manipulators', (b) =>
    showPopover(b, 'Gizmo', (body) => {
      body.append(
        popToggle('Axis gizmo', () => store.get().showAxes, (v) => store.set({ showAxes: v })),
        popToggle('Spines on top', () => store.get().spinesOnTop, (v) => store.set({ spinesOnTop: v })),
        popToggle('Local space', () => false, () => undefined, NA),
        popNote('Wind arrow, force handles and the Tree disc handle follow their own nodes / the Wind popover.'),
      );
    }),
  );

  const zoom = btn('search', 'Zoom', 'Zoom to fit / selection, reset camera', (b) =>
    showPopover(b, 'Zoom', (body, close) => {
      const run = (id: string) => () => {
        app.commands.run(id);
        close();
      };
      body.append(h('div', 'kt-pop-btns', popButton('Fit scene', run('view.frame')), popButton('Selection', run('view.frameSelection')), popButton('Reset camera', run('view.reset'))));
      body.append(popRow('Distance', h('span', 'kt-pop-value', (app.viewport?.cameraDistance() ?? 0).toFixed(2))));
    }, 240),
  );

  // --- Post
  const ao = btn('tbAO', 'AO', 'Ambient occlusion', () => undefined, true);
  const collision = btn('tbCollision', 'Collision', 'Collision objects', () => undefined, true);
  const shade = btn('tbShade', 'Shade', 'Shading preview: lit, flat, vertex colour, normals, UV', (b) =>
    showPopover(b, 'Shade', (body, close) => {
      const modes: ViewMode[] = ['shaded', 'flat', 'vertexColor', 'normalColors', 'uv', 'ao'];
      for (const m of modes) {
        const row = h('button', `kt-tb-lbl${store.get().viewMode === m ? ' active' : ''}`, VIEW_MODE_LABELS[m]);
        row.type = 'button';
        row.addEventListener('click', () => {
          store.set({ viewMode: m });
          close();
        });
        body.append(row);
      }
      body.append(popNote('Lit = PBR shading; Unlit / Flat = colour map only; Vertex color = baked tint / AO; the rest are diagnostics.'));
    }, 220),
  );

  const expand = h('button', 'kt-tb-lbl', icon('expand', 15));
  expand.type = 'button';
  expand.title = tip('Maximize viewport', 'window.maximizePanel');
  expand.setAttribute('aria-label', 'Maximize viewport');
  expand.addEventListener('click', () => ctx.toggleMaximize());

  // View-mode quick menu keeps keyboard shortcuts discoverable.
  const viewModeMenu = (b: HTMLElement): void => void showMenu(VIEW_MODES.map((m): MenuItem => commandItem(app, `view.mode.${m}`)), b);
  render.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    viewModeMenu(render);
  });
  render.title = `${render.title} - right-click: view mode menu (Alt+1..9)`;

  return h(
    'div',
    'kt-vp-toolbar kt-vp-toolbar2',
    group('Mode', seg),
    group('Edit', add, visibility, season, lod),
    group('Scene', objects, windBtn, light),
    h('div', 'kt-tb-break'),
    group('View', render, show, gizmo, zoom),
    group('Post', ao, collision, shade),
    h('div', 'kt-tb-spacer'),
    expand,
  );
}
