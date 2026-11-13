import { getApp } from '@/app/context';
import type {
  CutoutMesh,
  LodLevel,
  MeshFlipMode,
  MeshOrientMode,
  WindGrowthAxis,
  WindRippleMode,
} from '@/contracts/material';
import { fitToUnit, parseGltf, parseObj } from '@/geometry/meshImport';
import {
  buildCutoutGeometry,
  defaultCutoutPreviewCamera,
  lodCounts,
  meshDataToImportedLod,
  meshDataToObj,
  rebuildCutoutLods,
  renderCutout3DPreview,
  resetCutoutOutline,
  updateCutoutBounds,
  type CutoutPreviewCamera,
} from '@/materials/cutouts';
import { h } from '../components/dom';
import { createSelect } from '../components/select';
import type { PanelInstance } from '../docking/panelRegistry';
import { icon } from '../icons/icons';
import { mountAssetPanel, type AssetPanelContext } from './assets/assetPanel';
import { card, checkbox, numberField, row, textField } from './assets/widgets';
import { openEditMeshDialog } from './dialogs/editMeshDialog';

const MESH_ACCEPT = '.obj,.gltf,.glb,model/gltf-binary,model/gltf+json,text/plain';

const LOD_ROWS: { level: LodLevel; label: string }[] = [
  { level: 'high', label: 'High' },
  { level: 'med', label: 'Med' },
  { level: 'low', label: 'Low' },
];

const SHOW_LABELS: Record<LodLevel, string> = { high: 'High', med: 'Med', low: 'Low' };
const LABEL_TO_LOD: Record<string, LodLevel> = { High: 'high', Med: 'med', Low: 'low' };

const ORIENT_OPTIONS: MeshOrientMode[] = [
  'Z-Up Right-handed',
  'Y-Up Right-handed',
  'Z-Up Left-handed',
  'Y-Up Left-handed',
];

const FLIP_OPTIONS: MeshFlipMode[] = ['X Y Z', 'None', 'X', 'Y', 'Z', 'X Y', 'X Z', 'Y Z'];
const GROWTH_OPTIONS: WindGrowthAxis[] = ['+Y', '-Y', '+X', '-X', '+Z', '-Z'];
const RIPPLE_OPTIONS: WindRippleMode[] = ['Normal', 'Tangent', 'Binormal', 'Up', 'Radial'];

const MORE_OPTIONS = [
  'None',
  'Copy High to Med & Low',
  'Rebuild LODs',
  'Reset to Embedded',
  'Reset Outline to Quad',
] as const;

let activeShowLod: LodLevel = 'high';
let showAlignment = true;
const fileCache = new Map<string, File>();

function pickMeshFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = MESH_ACCEPT;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

function downloadText(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createMeshesPanel(host: HTMLElement): PanelInstance {
  const app = getApp();
  const camera: CutoutPreviewCamera = defaultCutoutPreviewCamera();

  return mountAssetPanel<CutoutMesh>(host, {
    kind: 'meshes',
    noun: 'mesh',
    className: 'kt-meshes',
    hand: true,
    build(ctx: AssetPanelContext<CutoutMesh>) {
      const mesh = ctx.entry;
      if (!mesh) return;
      if (!mesh.lods || !mesh.lods.high) rebuildCutoutLods(mesh);

      const editMeshBtn = h('button', 'kt-btn kt-btn-wide kt-meshes-edit-btn', 'Edit Mesh...');
      editMeshBtn.type = 'button';
      editMeshBtn.addEventListener('click', () => {
        const cur = ctx.lib.cutoutMesh(mesh.id) ?? mesh;
        openEditMeshDialog({ cutoutId: cur.id, materialId: cur.materialId });
      });

      const importLodFromFile = async (level: LodLevel, file: File): Promise<void> => {
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const isObj = file.name.toLowerCase().endsWith('.obj');
          const parsed = fitToUnit(
            isObj ? parseObj(new TextDecoder().decode(bytes), mesh.materialId) : parseGltf(bytes, mesh.materialId),
          );
          if (parsed.indices.length < 3) {
            app.notify(`${file.name}: mesh contains no triangles.`);
            return;
          }
          fileCache.set(`${mesh.id}:${level}`, file);
          ctx.edit(`Import ${SHOW_LABELS[level]} LOD mesh`, (m) => {
            m.lods[level] = {
              ...m.lods[level],
              level,
              sourceName: file.name,
              importedMesh: meshDataToImportedLod(parsed, file.name),
            };
          });
          ctx.rerender();
        } catch (err) {
          app.notify(`Failed to import ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      const lodRowEls = LOD_ROWS.map(({ level, label }) => {
        const variant = mesh.lods[level];
        const isEmbedded = !variant?.importedMesh;
        const statusInput = textField(variant?.sourceName || 'Embedded', () => undefined, {
          readOnly: true,
          disabled: true,
        });
        statusInput.classList.add('kt-meshes-lod-path');

        const loadBtn = h('button', 'kt-btn kt-btn-icon', icon('folder', 15));
        loadBtn.type = 'button';
        loadBtn.title = `Load ${label} LOD mesh from file (.obj, .gltf, .glb)`;
        loadBtn.addEventListener('click', () => {
          void pickMeshFile().then((f) => f && importLodFromFile(level, f));
        });

        const reloadBtn = h('button', 'kt-btn kt-btn-icon', icon('reload', 15));
        reloadBtn.type = 'button';
        reloadBtn.disabled = isEmbedded;
        reloadBtn.title = isEmbedded ? 'Embedded cutout (edit via Edit Mesh…)' : `Reload ${variant?.sourceName ?? ''}`;
        reloadBtn.addEventListener('click', () => {
          const cached = fileCache.get(`${mesh.id}:${level}`);
          if (cached) void importLodFromFile(level, cached);
          else void pickMeshFile().then((f) => f && importLodFromFile(level, f));
        });

        const exportBtn = h('button', 'kt-btn kt-btn-icon', icon('export', 15));
        exportBtn.type = 'button';
        exportBtn.title = `Export ${label} LOD as Wavefront OBJ`;
        exportBtn.addEventListener('click', () => {
          const cur = ctx.lib.cutoutMesh(mesh.id) ?? mesh;
          const built = buildCutoutGeometry(cur, level);
          const safe = cur.name.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'Cutout';
          downloadText(`${safe}_${label}.obj`, meshDataToObj(built, `${safe}_${label}`));
          app.notify(`Exported ${safe}_${label}.obj`);
        });

        return h('div', 'kt-meshes-lod-row', h('label', '', label), statusInput, loadBtn, reloadBtn, exportBtn);
      });

      const moreSel = createSelect({
        options: [...MORE_OPTIONS],
        value: 'None',
        onChange: (action) => {
          if (action === 'None') return;
          ctx.edit(action, (m) => {
            if (action === 'Copy High to Med & Low') {
              m.lods.med = { ...structuredClone(m.lods.high), level: 'med' };
              m.lods.low = { ...structuredClone(m.lods.high), level: 'low' };
            } else if (action === 'Rebuild LODs') {
              m.lods.high.importedMesh = null;
              m.lods.med.importedMesh = null;
              m.lods.low.importedMesh = null;
              rebuildCutoutLods(m);
            } else if (action === 'Reset to Embedded') {
              for (const lv of ['high', 'med', 'low'] as LodLevel[]) {
                m.lods[lv].importedMesh = null;
                m.lods[lv].sourceName = 'Embedded';
              }
              rebuildCutoutLods(m);
            } else if (action === 'Reset Outline to Quad') {
              resetCutoutOutline(m);
            }
          });
          ctx.rerender();
        },
      });
      moreSel.classList.add('kt-meshes-more-select');

      const geometryCard = card(
        'Geometry',
        h('div', 'kt-meshes-edit-wrap', editMeshBtn),
        ...lodRowEls,
        h('div', 'kt-meshes-more-row', h('label', '', 'More'), moreSel),
      );

      // 3D Preview on checkerboard
      const previewCanvas = h('canvas', 'kt-meshes-canvas');
      const previewWrap = h('div', 'kt-meshes-preview checker', previewCanvas);
      previewWrap.draggable = true;
      previewWrap.title = 'Drag to orbit (or pan when Hand tool is active) · Wheel to zoom · Alt+drag to drop onto a Leaf node';
      previewWrap.addEventListener('dragstart', (e) => {
        if (!e.altKey) {
          e.preventDefault();
          return;
        }
        e.dataTransfer?.setData('application/x-kekenik-cutout', mesh.id);
        e.dataTransfer?.setData('text/plain', mesh.name);
      });

      const statsEl = h('div', 'kt-meshes-stats');
      const updateStats = (): void => {
        const cur = ctx.lib.cutoutMesh(mesh.id) ?? mesh;
        const counts = lodCounts(cur.lods[activeShowLod] ?? cur.lods.high);
        statsEl.textContent = `V:${counts.vertices}  F:${counts.faces}  A:${cur.anchors.length}`;
      };

      let raf = 0;
      const drawPreview = (): void => {
        raf = 0;
        if (!previewWrap.isConnected) return;
        const cur = ctx.lib.cutoutMesh(mesh.id) ?? mesh;
        const w = Math.max(80, previewWrap.clientWidth || 260);
        const hh = Math.max(80, previewWrap.clientHeight || 190);
        previewCanvas.style.width = `${w}px`;
        previewCanvas.style.height = `${hh}px`;
        renderCutout3DPreview(previewCanvas, cur, w, hh, {
          lod: activeShowLod,
          camera,
          showAlignment,
          showAnchors: true,
        });
        updateStats();
      };
      const scheduleDraw = (): void => {
        if (!raf) raf = requestAnimationFrame(drawPreview);
      };

      previewCanvas.addEventListener('pointerdown', (e) => {
        if (e.altKey) return;
        try {
          previewCanvas.setPointerCapture(e.pointerId);
        } catch {
          /* ignore in jsdom */
        }
        let lx = e.clientX;
        let ly = e.clientY;
        const isPan = Boolean(ctx.header.handButton?.classList.contains('active')) || e.button === 1 || e.shiftKey;
        const onMove = (ev: PointerEvent): void => {
          const dx = ev.clientX - lx;
          const dy = ev.clientY - ly;
          lx = ev.clientX;
          ly = ev.clientY;
          if (isPan) {
            camera.panX += dx / 220;
            camera.panY += dy / 220;
          } else {
            camera.yaw += dx * 0.012;
            camera.pitch = Math.max(-1.45, Math.min(1.45, camera.pitch + dy * 0.012));
          }
          scheduleDraw();
        };
        const onUp = (): void => {
          previewCanvas.removeEventListener('pointermove', onMove);
          previewCanvas.removeEventListener('pointerup', onUp);
          previewCanvas.removeEventListener('pointercancel', onUp);
        };
        previewCanvas.addEventListener('pointermove', onMove);
        previewCanvas.addEventListener('pointerup', onUp);
        previewCanvas.addEventListener('pointercancel', onUp);
      });

      previewCanvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          camera.zoom = Math.max(0.35, Math.min(3.5, camera.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
          scheduleDraw();
        },
        { passive: false },
      );

      // Show / Alignment / V:F:A bar below preview
      const showSelect = createSelect({
        options: ['High', 'Med', 'Low'],
        value: SHOW_LABELS[activeShowLod],
        width: 72,
        className: 'kt-sel-sm',
        onChange: (v) => {
          activeShowLod = LABEL_TO_LOD[v] ?? 'high';
          scheduleDraw();
        },
      });
      const alignCheck = checkbox(showAlignment, (v) => {
        showAlignment = v;
        scheduleDraw();
      });
      const previewBar = h(
        'div',
        'kt-meshes-bar',
        h('label', '', 'Show'),
        showSelect,
        h('label', 'kt-meshes-align', alignCheck, h('span', '', 'Alignment')),
        h('div', 'kt-spacer'),
        statsEl,
      );

      // Transform & Wind direction / Scale cards
      const transformCard = card(
        'Transform',
        row(
          'Orient',
          createSelect({
            options: [...ORIENT_OPTIONS],
            value: mesh.transform.orient,
            className: 'kt-sel-sm kt-meshes-sel-wide',
            onChange: (v) => {
              ctx.edit('Mesh orient', (m) => (m.transform.orient = v as MeshOrientMode));
              scheduleDraw();
            },
          }),
        ),
        row(
          'Flip',
          createSelect({
            options: [...FLIP_OPTIONS],
            value: mesh.transform.flip,
            className: 'kt-sel-sm kt-meshes-sel-wide',
            onChange: (v) => {
              ctx.edit('Mesh flip', (m) => (m.transform.flip = v as MeshFlipMode));
              scheduleDraw();
            },
          }),
        ),
        row(
          'Flip normals',
          checkbox(mesh.transform.flipNormals, (v) =>
            ctx.edit('Flip normals', (m) => (m.transform.flipNormals = v)),
          ),
        ),
        row(
          'Fix winding',
          checkbox(mesh.transform.fixWinding, (v) =>
            ctx.edit('Fix winding', (m) => (m.transform.fixWinding = v)),
          ),
        ),
      );

      const windCard = card(
        'Wind direction',
        row(
          'Growth',
          createSelect({
            options: [...GROWTH_OPTIONS],
            value: mesh.windDirection.growth,
            width: 86,
            className: 'kt-sel-sm',
            onChange: (v) => ctx.edit('Wind growth axis', (m) => (m.windDirection.growth = v as WindGrowthAxis)),
          }),
        ),
        row(
          'Ripple',
          createSelect({
            options: [...RIPPLE_OPTIONS],
            value: mesh.windDirection.ripple,
            width: 86,
            className: 'kt-sel-sm',
            onChange: (v) => ctx.edit('Wind ripple mode', (m) => (m.windDirection.ripple = v as WindRippleMode)),
          }),
        ),
      );

      const scaleField = numberField({
        value: mesh.scale,
        min: 0.001,
        max: 1000,
        step: 0.05,
        onChange: (v) =>
          ctx.edit(
            'Mesh scale',
            (m) => {
              m.scale = v;
              const mat = ctx.lib.material(m.materialId);
              updateCutoutBounds(m, mat?.atlas.scale ?? 1);
            },
            'scale',
          ),
      });
      const computeBtn = h('button', 'kt-btn kt-btn-wide', 'Compute');
      computeBtn.type = 'button';
      computeBtn.title = 'Auto-compute real-world scale from UV bounds and material atlas scale';
      computeBtn.addEventListener('click', () => {
        ctx.edit('Compute mesh scale', (m) => {
          const mat = ctx.lib.material(m.materialId);
          const atlasScale = mat?.atlas.scale ?? 1;
          let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
          for (const [u, v] of m.outline) {
            if (u < minU) minU = u;
            if (v < minV) minV = v;
            if (u > maxU) maxU = u;
            if (v > maxV) maxV = v;
          }
          const span = Math.max(0.05, Math.max(maxU - minU, maxV - minV));
          m.scale = Math.round(span * atlasScale * 1000) / 1000;
          scaleField.value = String(m.scale);
          updateCutoutBounds(m, atlasScale);
        });
      });
      const scaleCard = card('Scale', row('Value', scaleField), computeBtn);

      const cols = h('div', 'kt-mat-cols kt-meshes-cols', h('div', 'kt-mat-col', transformCard), h('div', 'kt-mat-col', windCard, scaleCard));

      ctx.body.append(geometryCard, previewWrap, previewBar, cols);

      const ro = new ResizeObserver(scheduleDraw);
      ro.observe(previewWrap);
      queueMicrotask(drawPreview);

      return () => {
        if (raf) cancelAnimationFrame(raf);
        ro.disconnect();
      };
    },
  });
}
