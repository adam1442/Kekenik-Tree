import type { AppContext } from '@/app/context';
import { hasDisplacementSource, onDisplacementSourcesChanged } from './displacement';
import { getMaterialLibrary } from './library';
import { setResolverRepaint } from './materialResolver';
import { setMaterialSource } from './materialSource';
import { getTextureManager } from '@/textures/textureManager';

/**
 * Connects the material library + texture manager to the running app: binds them to the active document's project data,
 * installs the `MaterialSource` used by node evaluation and re-runs generation when something generators depend on
 * (sets, displacements, season) changes. Returns a disposer.
 */
export function installMaterialSystem(app: AppContext): () => void {
  const lib = getMaterialLibrary();
  const tm = getTextureManager();
  const meta = () => app.project.metaOf(app.store.get().activeDocumentId);
  lib.bind(meta, app.undo);
  tm.bind(() => lib.assets());
  setMaterialSource(lib);
  setResolverRepaint(() => app.viewport?.requestRender());

  let timer = 0;
  let refreshTimer = 0;
  const regenerate = (): void => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => app.events.emit('tree:regenerate', undefined), 150);
  };
  const refresh = (): void => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => app.events.emit('tree:refresh', undefined), 120);
  };
  const decodeDisplacements = (): void => {
    for (const d of lib.displacements()) if (d.assetId && !hasDisplacementSource(d.assetId)) void tm.loadPixels(d.assetId);
  };

  const unsubs = [
    lib.onChange((c) => {
      if (c.kind === 'all') decodeDisplacements();
      if (c.kind === 'displacements' || c.kind === 'masks') {
        decodeDisplacements();
        refresh();
      }
      if (
        c.kind === 'materialSets' ||
        c.kind === 'meshes' ||
        c.kind === 'uvAreas' ||
        c.kind === 'season' ||
        c.kind === 'all'
      ) {
        regenerate();
      }
      app.viewport?.requestRender();
    }),
    onDisplacementSourcesChanged(refresh),
    app.store.select((s) => s.activeDocumentId, () => {
      tm.bind(() => lib.assets());
      lib.refresh();
    }),
    app.project.onMetaLoaded(() => {
      tm.bind(() => lib.assets());
      lib.refresh();
    }),
  ];
  return () => {
    window.clearTimeout(timer);
    window.clearTimeout(refreshTimer);
    unsubs.forEach((u) => u());
    setMaterialSource(null);
    tm.dispose();
  };
}
