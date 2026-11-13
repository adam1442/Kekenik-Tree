import type { AppContext } from '@/app/context';
import { activeDocument } from '@/app/state';
import { CancelledError, CancellationSource } from '@/contracts/nodes';
import { createExportEnv, downloadFile, estimateTextureBytes } from '@/export/install';
import { runExport, type ExportResult } from '@/export/exportService';
import { getLodPreview } from '@/export/lod/lodPreview';
import { getLodSettings, loadExportSettings, onLodSettingsChange, saveExportSettings } from '@/export/settings';
import { formatBytes, formatCount, sceneMaterialIds, sceneStats } from '@/export/stats';
import type { ExportFormat, ExportSettings, ExportUnits } from '@/export/types';
import { h } from '@/ui/components/dom';
import { FloatingWindow } from '@/ui/components/floatingWindow';
import { mountLodEditor } from '../lodEditor';
import { button, choice, formRow, numberInput, section, tabs, textInput, toggle } from './exportKit';

/**
 * Export dialog (modal `FloatingWindow`). Tabs: General · LODs · Textures · Bake · Impostor; footer: statistics preview,
 * progress bar with Cancel, result list. Layout is generic.
 */

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'glb', label: 'glTF Binary (.glb)' },
  { value: 'gltf', label: 'glTF Separate (.gltf + .bin)' },
  { value: 'obj', label: 'Wavefront OBJ + MTL' },
  { value: 'ply', label: 'PLY (binary)' },
  { value: 'stl', label: 'STL (binary, geometry only)' },
];
const UNITS: { value: ExportUnits; label: string }[] = [
  { value: 'm', label: 'Meters' },
  { value: 'cm', label: 'Centimeters' },
  { value: 'mm', label: 'Millimeters' },
  { value: 'in', label: 'Inches' },
  { value: 'ft', label: 'Feet' },
];

let openWindow: FloatingWindow | null = null;

export function openExportDialog(app: AppContext): void {
  if (openWindow) {
    openWindow.focus();
    return;
  }
  const doc = activeDocument(app.store.get());
  let settings: ExportSettings = loadExportSettings(doc.name.replace(/\.[^.]+$/, '') || 'Plant');
  const preview = getLodPreview();
  const save = (): void => {
    saveExportSettings(settings);
    scheduleStats();
  };
  const set = (patch: Partial<ExportSettings>): void => {
    settings = { ...settings, ...patch };
    save();
  };
  const setTex = (patch: Partial<ExportSettings['textures']>): void => set({ textures: { ...settings.textures, ...patch } });
  const setBake = (patch: Partial<ExportSettings['bake']>): void => set({ bake: { ...settings.bake, ...patch } });
  const setImp = (patch: Partial<ExportSettings['impostor']>): void => set({ impostor: { ...settings.impostor, ...patch } });

  // --- footer widgets ---------------------------------------------------------------------------------------------
  const statsBox = h('div', 'kt-xp-stats');
  const bar = h('div', 'kt-xp-progress-fill');
  const barLabel = h('div', 'kt-xp-progress-label', 'Ready');
  const progress = h('div', 'kt-xp-progress', bar, barLabel);
  const results = h('div', 'kt-xp-results');
  const exportBtn = button('Export', () => void start(), 'primary');
  const cancelBtn = button('Close', () => (running ? running.cancel() : win.close()));
  let running: CancellationSource | null = null;
  let statsTimer = 0;
  let statsToken = 0;

  const renderStats = async (): Promise<void> => {
    const token = ++statsToken;
    statsBox.textContent = 'Calculating statistics…';
    await preview.ensureBuilt();
    if (token !== statsToken) return;
    const scenes = preview.builtScenes;
    const levels = getLodSettings().levels;
    const rows = settings.lods.filter((i) => scenes[i]).map((i) => ({ i, s: sceneStats(scenes[i] as NonNullable<(typeof scenes)[number]>, settings.mergeMode) }));
    const ids = [...new Set(rows.flatMap((r) => sceneMaterialIds(scenes[r.i] as NonNullable<(typeof scenes)[number]>)))];
    const texBytes = settings.textures.enabled ? await estimateTextureBytes(settings, ids) : 0;
    if (token !== statsToken) return;
    const head = h('div', 'kt-xp-stat-row head', h('span', '', 'LOD'), h('span', '', 'Triangles'), h('span', '', 'Vertices'), h('span', '', 'Draw calls'), h('span', '', 'Detail'));
    const body = rows.map((r) => h('div', 'kt-xp-stat-row', h('span', '', `LOD ${r.i}`), h('span', '', formatCount(r.s.triangles)), h('span', '', formatCount(r.s.vertices)), h('span', '', String(r.s.drawCalls)), h('span', 'kt-xp-dim', `gen ${(levels[r.i]?.engineLod ?? 0)}`)));
    statsBox.replaceChildren(head, ...body, h('div', 'kt-xp-dim', `Materials ${ids.length} · texture memory ≈ ${formatBytes(texBytes)}${settings.impostor.mode !== 'off' ? ' + impostor atlas' : ''}`));
  };
  function scheduleStats(): void {
    window.clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => void renderStats(), 300);
  }

  // --- tabs --------------------------------------------------------------------------------------------------------
  const lodList = h('div', 'kt-xp-lodlist');
  const renderLodList = (): void => {
    const levels = getLodSettings().levels;
    settings = { ...settings, lods: settings.lods.filter((i) => i < levels.length).length > 0 ? settings.lods.filter((i) => i < levels.length) : [0] };
    lodList.replaceChildren(
      ...levels.map((_, i) => {
        const tris = preview.builtScenes[i]?.stats.triangles;
        return formRow(`LOD ${i}`, h('div', 'kt-xp-inline', toggle(settings.lods.includes(i), (on) => {
          const next = on ? [...settings.lods, i] : settings.lods.filter((k) => k !== i);
          set({ lods: [...new Set(next.length > 0 ? next : [i])].sort((a, b) => a - b) });
          renderLodList();
        }), h('span', 'kt-xp-dim', tris === undefined ? '' : `${formatCount(tris)} tris`)));
      }),
    );
  };

  const general = h(
    'div',
    'kt-xp-page',
    section(
      'Output',
      formRow('Name', textInput(settings.name, (v) => set({ name: v.trim() || 'Plant' }))),
      formRow('Format', choice(FORMATS, settings.format, (v) => set({ format: v }))),
      formRow('Bundle as .zip', toggle(settings.zip, (v) => set({ zip: v })), 'Several files (textures, atlases, metadata) are always bundled into a zip.'),
      formRow('Write metadata (.kekenik.json)', toggle(settings.metadata, (v) => set({ metadata: v }))),
      formRow('Verify by re-importing (glTF)', toggle(settings.verify, (v) => set({ verify: v })), 'Re-reads the exported file with three.js GLTFLoader and compares triangles / nodes / materials.'),
    ),
    section(
      'Scale and orientation',
      formRow('Units', choice(UNITS, settings.units, (v) => set({ units: v }))),
      formRow('Extra scale', numberInput(settings.scale, { min: 0.0001, max: 10000, step: 0.1, decimals: 4, onChange: (v) => set({ scale: v }) })),
      formRow('Up axis', choice([{ value: 'Y', label: 'Y-up' }, { value: 'Z', label: 'Z-up' }], settings.upAxis, (v) => set({ upAxis: v })), 'glTF is defined as Y-up, right-handed. Other choices are baked into the vertices and recorded in the file metadata.'),
      formRow('Handedness', choice([{ value: 'right', label: 'Right-handed' }, { value: 'left', label: 'Left-handed (mirror X)' }], settings.handedness, (v) => set({ handedness: v }))),
    ),
    section(
      'Mesh',
      formRow('Pieces', choice([{ value: 'single', label: 'One merged mesh' }, { value: 'perNode', label: 'One mesh per graph node' }], settings.mergeMode, (v) => set({ mergeMode: v }))),
      formRow('LODs in glTF', choice([{ value: 'single', label: 'One file, LOD nodes' }, { value: 'files', label: 'One file per LOD' }], settings.lodLayout, (v) => set({ lodLayout: v }))),
      formRow('Vertex colours', toggle(settings.vertexColors, (v) => set({ vertexColors: v }))),
      formRow('Custom attributes (wind, AO)', toggle(settings.customAttributes, (v) => set({ customAttributes: v })), '_WIND_PIVOT, _WIND_WEIGHTS, _AO (see docs/EXPORT_SPEC.md).'),
    ),
    h('div', 'kt-xp-note', 'FBX is not available: a binary FBX writer cannot be verified without an FBX importer. Use glTF/GLB (recommended) or OBJ.'),
  );

  const lodHost = h('div', 'kt-xp-page');
  let lodDispose: (() => void) | null = null;
  renderLodList();
  lodHost.append(section('Export these LODs', lodList), h('div', 'kt-xp-section-title', 'LOD definitions'));
  const lodEditorHost = h('div', 'kt-xp-lod-host');
  lodHost.append(lodEditorHost);
  lodDispose = mountLodEditor(lodEditorHost);
  const unsubLods = onLodSettingsChange(() => {
    renderLodList();
    scheduleStats();
  });

  const MAX_SIZES = [{ value: '0', label: 'Material "Max res"' }, ...[256, 512, 1024, 2048, 4096].map((n) => ({ value: String(n), label: `${n} px` }))];
  const textures = h(
    'div',
    'kt-xp-page',
    section(
      'Texture maps',
      formRow('Export textures', toggle(settings.textures.enabled, (v) => setTex({ enabled: v }))),
      formRow('Format', choice([{ value: 'png', label: 'PNG' }, { value: 'jpg', label: 'JPG (opaque maps only)' }, { value: 'webp', label: 'WebP' }], settings.textures.format, (v) => setTex({ format: v }))),
      formRow('Quality (JPG / WebP)', numberInput(settings.textures.quality, { min: 0.1, max: 1, step: 0.05, decimals: 2, onChange: (v) => setTex({ quality: v }) })),
      formRow('Max size', choice(MAX_SIZES, String(settings.textures.maxSize), (v) => setTex({ maxSize: Number(v) })), 'Never larger than the material Max res; never upsampled.'),
      formRow('Channel packing', choice([{ value: 'orm', label: 'ORM (R = AO, G = roughness, B = metal)' }, { value: 'none', label: 'None (AO only, rest as extra maps)' }], settings.textures.packing, (v) => setTex({ packing: v }))),
      formRow('Padding (dilation, px)', numberInput(settings.textures.padding, { min: 0, max: 64, step: 1, decimals: 0, onChange: (v) => setTex({ padding: Math.round(v) }) })),
      formRow('Write as separate files (glTF)', toggle(settings.textures.external, (v) => setTex({ external: v })), 'GLB always embeds; glTF uses data URIs unless this is on.'),
    ),
    h('div', 'kt-xp-note', 'Colour + Opacity are merged into one RGBA albedo map. Custom / Custom2 maps and constants travel in material extras.'),
  );

  const bake = h(
    'div',
    'kt-xp-page',
    section(
      'Ambient occlusion (vertices)',
      formRow('Bake AO', choice([{ value: 'off', label: 'Off' }, { value: 'multiply', label: 'Multiply into vertex colours' }, { value: 'replace', label: 'Replace vertex colours' }], settings.bake.aoMode, (v) => setBake({ aoMode: v }))),
      formRow('Rays per vertex', numberInput(settings.bake.aoSamples, { min: 4, max: 128, step: 4, decimals: 0, onChange: (v) => setBake({ aoSamples: Math.round(v) }) })),
      formRow('Radius (× plant size)', numberInput(settings.bake.aoRadius, { min: 0.01, max: 1, step: 0.01, decimals: 2, onChange: (v) => setBake({ aoRadius: v }) })),
      formRow('Strength', numberInput(settings.bake.aoStrength, { min: 0, max: 1, step: 0.05, decimals: 2, onChange: (v) => setBake({ aoStrength: v }) })),
    ),
    h('div', 'kt-xp-note', 'The result is always written to the `_AO` attribute (when custom attributes are on). Voxel-based hemisphere sampling in a worker; it is an estimate, not a path-traced bake.'),
  );

  const impostor = h(
    'div',
    'kt-xp-page',
    section(
      'Billboard / impostor',
      formRow('Mode', choice([{ value: 'off', label: 'Off' }, { value: 'impostor', label: 'Impostor (N-view atlas)' }, { value: 'cross', label: 'Cross billboard' }, { value: 'both', label: 'Both' }], settings.impostor.mode, (v) => setImp({ mode: v }))),
      formRow('Views around', numberInput(settings.impostor.views, { min: 4, max: 32, step: 4, decimals: 0, onChange: (v) => setImp({ views: Math.round(v) }) }), 'Use a multiple of 4 for a perfect cross billboard.'),
      formRow('Top view', toggle(settings.impostor.topView, (v) => setImp({ topView: v }))),
      formRow('Frame size (px)', choice([128, 256, 512, 1024].map((n) => ({ value: String(n), label: String(n) })), String(settings.impostor.frameSize), (v) => setImp({ frameSize: Number(v) }))),
      formRow('Padding (px)', numberInput(settings.impostor.padding, { min: 0, max: 32, step: 1, decimals: 0, onChange: (v) => setImp({ padding: Math.round(v) }) })),
      formRow('Normal atlas', toggle(settings.impostor.normals, (v) => setImp({ normals: v }))),
      formRow('Depth atlas', toggle(settings.impostor.depth, (v) => setImp({ depth: v }))),
      formRow('Render from LOD', numberInput(settings.impostor.sourceLod, { min: 0, max: 5, step: 1, decimals: 0, onChange: (v) => setImp({ sourceLod: Math.round(v) }) })),
    ),
    h('div', 'kt-xp-note', 'Writes <name>_impostor_albedo/normal/depth.png, a quad mesh with KHR_texture_transform (glTF) and <name>_impostor.json (frames, centre, radius, encodings).'),
  );

  const tabView = tabs([
    { id: 'general', label: 'General', content: general },
    { id: 'lods', label: 'LODs', content: lodHost },
    { id: 'textures', label: 'Textures', content: textures },
    { id: 'bake', label: 'Bake', content: bake },
    { id: 'impostor', label: 'Impostor', content: impostor },
  ]);

  // --- run -----------------------------------------------------------------------------------------------------------
  const showResult = (r: ExportResult): void => {
    const rows: HTMLElement[] = [h('div', 'kt-xp-ok', `Exported ${r.files.length} file(s) → ${r.download.name}`)];
    for (const f of r.files) rows.push(h('div', 'kt-xp-dim', `${f.name} · ${formatBytes(typeof f.data === 'string' ? f.data.length : f.data.byteLength)}`));
    for (const v of r.verification) rows.push(h('div', v.ok ? 'kt-xp-ok' : 'kt-xp-warn', v.ok ? `✓ ${v.file}: re-import matches (${formatCount(v.actual.triangles)} triangles${v.loaderTriangles !== undefined ? ', GLTFLoader OK' : ''})` : `✗ ${v.file}: ${v.mismatches.join('; ')}`));
    for (const w of r.warnings) rows.push(h('div', 'kt-xp-warn', `! ${w}`));
    results.replaceChildren(...rows);
  };

  async function start(): Promise<void> {
    if (running) return;
    const source = new CancellationSource();
    running = source;
    exportBtn.disabled = true;
    cancelBtn.textContent = 'Cancel';
    results.replaceChildren();
    saveExportSettings(settings);
    try {
      const env = createExportEnv(app);
      const result = await runExport(env, settings, source.token, (p) => {
        bar.style.width = `${(p.fraction * 100).toFixed(1)}%`;
        barLabel.textContent = `${p.stage} (${Math.round(p.fraction * 100)}%)`;
      });
      downloadFile(result.download);
      showResult(result);
      barLabel.textContent = 'Done';
      app.notify(`Exported ${result.download.name}`);
    } catch (e) {
      bar.style.width = '0%';
      barLabel.textContent = e instanceof CancelledError || source.token.cancelled ? 'Cancelled' : 'Failed';
      if (!(e instanceof CancelledError) && !source.token.cancelled) results.replaceChildren(h('div', 'kt-xp-warn', `Export failed: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      running = null;
      exportBtn.disabled = false;
      cancelBtn.textContent = 'Close';
    }
  }

  const win = new FloatingWindow({
    title: 'Export',
    container: app.dialogLayer,
    rect: { x: Math.max(0, (app.dialogLayer.clientWidth - 720) / 2), y: Math.max(0, (app.dialogLayer.clientHeight - 720) / 4), w: 720, h: Math.min(720, Math.max(480, app.dialogLayer.clientHeight - 40)) },
    minSize: { w: 560, h: 420 },
    minimizable: false,
    maximizable: true,
    modal: true,
    className: 'kt-export-dialog',
    onClose: () => {
      running?.cancel();
      window.clearTimeout(statsTimer);
      statsToken++;
      lodDispose?.();
      unsubLods();
      openWindow = null;
      win.dispose();
    },
  });
  openWindow = win;
  win.body.append(
    h('div', 'kt-xp-dialog', tabView.el, h('div', 'kt-xp-footer', statsBox, results, progress, h('div', 'kt-em-footer', h('div', 'kt-em-spacer'), cancelBtn, exportBtn))),
  );
  void renderStats();
}
