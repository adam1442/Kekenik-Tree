import type { AppContext } from '@/app/context';
import { activeDocument } from '@/app/state';
import { getMaterialLibrary } from '@/materials/library';
import { getTextureManager } from '@/textures/textureManager';
import { openExportDialog } from '@/ui/panels/dialogs/exportDialog';
import type { ExportEnv } from './exportService';
import { renderImpostor } from './impostor/impostorRender';
import { getLodPreview } from './lod/lodPreview';
import { getLodSettings } from './settings';
import { createBrowserMaterialContext } from './materials/materialContext';
import type { ExportFile, ExportSettings } from './types';

/** Application wiring of the export system: env factory, download helper, commands, LOD preview. */

export function createExportEnv(app: AppContext): ExportEnv {
  const doc = activeDocument(app.store.get());
  const meta = app.project.metaOf(doc.id);
  return {
    source: { evaluateAt: (lod, token, progress) => app.engine.evaluateAt(lod, token, progress), seed: doc.seed },
    levels: getLodSettings().levels,
    materials: createBrowserMaterialContext(),
    nodeName: (id) => app.graph.model.getNode(id)?.name,
    wind: meta?.settings.wind ?? null,
    seed: doc.seed,
    renderImpostor,
    verifyWithLoader: true,
  };
}

/** Trigger a browser download of one file. */
export function downloadFile(file: ExportFile): void {
  const part = typeof file.data === 'string' ? file.data : (file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer);
  const url = URL.createObjectURL(new Blob([part], { type: file.mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** GPU memory estimate (RGBA8 + mips) of the maps the used materials would export, respecting Max res. */
export async function estimateTextureBytes(settings: ExportSettings, materialIds: readonly string[]): Promise<number> {
  const lib = getMaterialLibrary();
  const tm = getTextureManager();
  const seen = new Set<string>();
  let bytes = 0;
  for (const id of materialIds) {
    const def = lib.material(id) ?? lib.materials().find((m) => m.name === id);
    if (!def) continue;
    const cap = Math.min(def.maxResolution ?? Infinity, settings.textures.maxSize > 0 ? settings.textures.maxSize : Infinity);
    for (const v of Object.values(def.slots)) {
      const ref = v?.texture;
      if (!ref || seen.has(`${def.id}:${ref.assetId}`)) continue;
      seen.add(`${def.id}:${ref.assetId}`);
      const info = await tm.info(ref.assetId);
      if (!info) continue;
      const s = Number.isFinite(cap) ? Math.min(1, cap / Math.max(info.width, info.height)) : 1;
      bytes += Math.round(info.width * s) * Math.round(info.height * s) * 4 * (4 / 3);
    }
  }
  return bytes;
}

export function registerExportCommands(app: AppContext): void {
  app.commands.register({ id: 'file.export', label: 'Export…', shortcut: 'Mod+E', run: () => openExportDialog(app) });
}

/** Attach the viewport LOD preview to the running app. Returns a disposer. */
export function installExport(app: AppContext): () => void {
  return getLodPreview().attach(app);
}
