import type { AppState } from '@/contracts/app';
import type { ProjectFile } from '@/contracts/project';
import type { Store } from '@/core/store';
import { uid } from '@/core/id';
import type { GraphSession } from '../graphSession';
import type { UndoStack } from '../commands/undoStack';
import { activeDocument } from '../state';
import { AutosaveStore, Debouncer, type AutosaveRecord } from './autosave';
import { decodeProject, encodeProject } from './codec';
import { defaultGraph } from './defaultGraph';
import type { FileHandleLike, FileIO } from './fileAccess';
import { createProjectFile, defaultMeta, fileNameForProject, projectNameFromFile, TEMPLATE_EXTENSION, type ProjectMeta } from './format';
import type { KeyValueStore } from './kvStore';
import { RecentFiles, type RecentEntry } from './recent';
import { createTemplate, decodeTemplate, encodeTemplate } from './templates';

export interface ProjectUi {
  /** Resolves the clicked button index, -1 = dismissed. */
  choose(title: string, message: string, buttons: { label: string; primary?: boolean }[]): Promise<number>;
  ask(title: string, initial: string): Promise<string | null>;
}

export interface ProjectDeps {
  store: Store<AppState>;
  graph: GraphSession;
  undo: UndoStack;
  fileIO: FileIO;
  kv: KeyValueStore;
  ui: ProjectUi;
  notify(message: string): void;
  /** Autosave delay after the last edit (default 1500 ms). */
  autosaveMs?: number;
}

interface DocMeta {
  /** File name as shown in the tab ("Spruce.ktree"), null while unsaved. */
  fileName: string | null;
  handle: FileHandleLike | null;
  meta: ProjectMeta;
  /** Untouched default document (replaced silently by crash recovery). */
  pristine: boolean;
}

/**
 * Documents <-> files. One entry in `store.documents` per open project; the graph lives in `GraphSession`, everything
 * else the file contains (settings, materials, forces, assets) is kept verbatim in `DocMeta`.
 */
export class ProjectManager {
  private readonly docs = new Map<string, DocMeta>();
  private readonly dirtyByDoc = new Map<string, boolean>();
  private readonly autosaved = new Set<string>();
  private readonly autosaveStore: AutosaveStore;
  private readonly recent: RecentFiles;
  private debounce: Debouncer;
  private recentCache: RecentEntry[] = [];
  private readonly unsubs: (() => void)[] = [];
  private untitledCounter = 1;
  private readonly metaListeners = new Set<() => void>();

  constructor(private readonly deps: ProjectDeps) {
    this.autosaveStore = new AutosaveStore(deps.kv);
    this.recent = new RecentFiles(deps.kv);
    this.debounce = new Debouncer(() => void this.autosaveNow(), deps.autosaveMs ?? 1500);
    this.unsubs.push(
      deps.store.subscribe((s, prev) => {
        if (s.dirty === prev.dirty && s.activeDocumentId === prev.activeDocumentId) return;
        this.dirtyByDoc.set(s.activeDocumentId, s.dirty);
        const meta = this.docs.get(s.activeDocumentId);
        if (meta && s.dirty) meta.pristine = false;
        this.debounce.trigger();
      }),
    );
    void this.refreshRecent();
  }

  /** Change the delay between the last edit and the recovery autosave. */
  setAutosaveMs(ms: number): void {
    this.debounce.cancel();
    this.debounce = new Debouncer(() => void this.autosaveNow(), ms);
  }

  /** Subscribe to "a project was loaded into a document" (material library re-binds). Returns unsubscribe. */
  onMetaLoaded(fn: () => void): () => void {
    this.metaListeners.add(fn);
    return () => this.metaListeners.delete(fn);
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------

  /** Synchronously fill the first document with the default graph, then offer crash recovery (async). */
  start(): Promise<void> {
    const id = this.deps.store.get().activeDocumentId;
    this.loadInto(id, this.defaultProject('Untitled', 1337), null, null, true);
    if (this.deps.graph.model.hasNode('trunk')) {
      this.deps.graph.setSelection(['trunk']);
    }
    return this.offerRecovery();
  }

  dispose(): void {
    this.debounce.flush();
    this.unsubs.forEach((u) => u());
  }

  // ---- queries ---------------------------------------------------------------------------------------------------

  recentFiles(): readonly RecentEntry[] {
    return this.recentCache;
  }

  hasUnsavedChanges(): boolean {
    return [...this.dirtyByDoc.values()].some(Boolean);
  }

  /** Serialise any open document (used by save, autosave and tests). */
  serialize(docId: string): ProjectFile {
    const { store, graph } = this.deps;
    const doc = store.get().documents.find((d) => d.id === docId);
    const info = this.docs.get(docId);
    const model = graph.modelOf(docId);
    if (!doc || !info || !model) throw new Error(`Unknown document ${docId}`);
    return createProjectFile({ name: projectNameFromFile(doc.name), graph: model.toJSON(), meta: info.meta, seed: doc.seed });
  }

  /** Mutable non-graph project data of a document (settings / materials / forces / assets). */
  metaOf(docId: string): ProjectMeta | undefined {
    return this.docs.get(docId)?.meta;
  }

  // ---- new / open --------------------------------------------------------------------------------------------------

  newProject(): void {
    const name = this.uniqueName('Untitled');
    const seed = Math.floor(Math.random() * 1_000_000);
    const id = this.createDocument(name, seed);
    this.loadInto(id, this.defaultProject(name, seed), null, null, false);
  }

  /** Open an in-memory project (preset library, templates) as a new, unsaved document. */
  openProjectFile(project: ProjectFile, name: string): void {
    const id = this.createDocument(name, project.settings.seed);
    this.loadInto(id, project, null, null, false);
    this.deps.notify(`Loaded “${name}”`);
  }

  async open(): Promise<boolean> {
    try {
      const file = await this.deps.fileIO.openFile();
      return file ? await this.openBytes(file.name, file.bytes, file.handle) : false;
    } catch (e) {
      this.deps.notify(`Could not open file: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  async openRecent(name: string): Promise<boolean> {
    const entry = this.recentCache.find((e) => e.name === name);
    if (!entry) return false;
    try {
      if (entry.handle) {
        const f = await this.deps.fileIO.readHandle(entry.handle);
        if (f) return await this.openBytes(f.name, f.bytes, f.handle);
      }
      if (entry.bytes) return await this.openBytes(entry.name, entry.bytes, null);
    } catch (e) {
      this.deps.notify(`Could not open "${name}": ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    this.deps.notify(`"${name}" is no longer available. Use File > Open.`);
    await this.recent.remove(name);
    await this.refreshRecent();
    return false;
  }

  async clearRecent(): Promise<void> {
    await this.recent.clear();
    await this.refreshRecent();
  }

  async openBytes(fileName: string, bytes: Uint8Array, handle: FileHandleLike | null): Promise<boolean> {
    let project: ProjectFile;
    try {
      project = decodeProject(bytes);
    } catch (e) {
      this.deps.notify(`Could not open "${fileName}": ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    const id = this.createDocument(fileName, project.settings.seed);
    this.loadInto(id, project, fileName, handle, false);
    await this.remember(fileName, handle, bytes);
    this.deps.notify(`Opened ${fileName}`);
    return true;
  }

  // ---- save --------------------------------------------------------------------------------------------------------

  async save(): Promise<boolean> {
    const id = this.deps.store.get().activeDocumentId;
    const info = this.docs.get(id);
    if (!info) return false;
    if (!info.handle) return this.saveAs();
    try {
      await this.deps.fileIO.writeHandle(info.handle, encodeProject(this.serialize(id)));
    } catch (e) {
      this.deps.notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    await this.afterSave(id);
    this.deps.notify(`Saved ${info.fileName ?? ''}`.trim());
    return true;
  }

  async saveAs(): Promise<boolean> {
    const { store, fileIO } = this.deps;
    const id = store.get().activeDocumentId;
    const info = this.docs.get(id);
    const doc = activeDocument(store.get());
    if (!info) return false;
    try {
      const bytes = encodeProject(this.serialize(id));
      const saved = await fileIO.saveAs(fileNameForProject(projectNameFromFile(doc.name)), bytes);
      if (!saved) return false;
      info.handle = saved.handle;
      info.fileName = saved.name;
      store.set((s) => ({ documents: s.documents.map((d) => (d.id === id ? { ...d, name: saved.name } : d)) }));
      await this.remember(saved.name, saved.handle, bytes);
    } catch (e) {
      this.deps.notify(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    await this.afterSave(id);
    this.deps.notify(`Saved ${activeDocument(store.get()).name}`);
    return true;
  }

  private async afterSave(docId: string): Promise<void> {
    this.deps.undo.markClean();
    this.dirtyByDoc.set(docId, false);
    this.autosaved.delete(docId);
    await this.autosaveStore.remove(docId);
  }

  // ---- close -------------------------------------------------------------------------------------------------------

  /** Close the active document (asks about unsaved changes). Resolves false when the user cancelled. */
  async closeActive(): Promise<boolean> {
    const { store, ui } = this.deps;
    const id = store.get().activeDocumentId;
    const doc = activeDocument(store.get());
    if (store.get().dirty) {
      const choice = await ui.choose('Unsaved changes', `“${doc.name}” has unsaved changes. Save them before closing?`, [{ label: 'Save', primary: true }, { label: 'Don’t Save' }, { label: 'Cancel' }]);
      if (choice === 0 && !(await this.save())) return false;
      if (choice !== 0 && choice !== 1) return false;
    }
    this.removeDocument(id);
    await this.autosaveStore.remove(id);
    return true;
  }

  private removeDocument(id: string): void {
    const { store, graph } = this.deps;
    const docs = store.get().documents;
    const idx = docs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    if (docs.length === 1) {
      // Always keep one document: replace it by a fresh default project.
      const name = this.uniqueName('Untitled');
      const nid = this.createDocument(name, 1337);
      this.loadInto(nid, this.defaultProject(name, 1337), null, null, true);
    } else if (store.get().activeDocumentId === id) {
      store.set({ activeDocumentId: (docs[idx === 0 ? 1 : idx - 1] as { id: string }).id });
    }
    store.set((s) => ({ documents: s.documents.filter((d) => d.id !== id) }));
    graph.dropDocument(id);
    this.docs.delete(id);
    this.dirtyByDoc.delete(id);
    this.autosaved.delete(id);
  }

  // ---- node templates ----------------------------------------------------------------------------------------------

  async exportTemplate(): Promise<boolean> {
    const payload = this.deps.graph.exportSelection();
    if (!payload) {
      this.deps.notify('Select a node (with its sub-tree) to export as a template.');
      return false;
    }
    const first = payload.nodes[0];
    const name = await this.deps.ui.ask('Export Node Template', first?.name ?? 'Template');
    if (!name) return false;
    this.deps.fileIO.download(`${name}${TEMPLATE_EXTENSION}`, encodeTemplate(createTemplate(name, payload)), 'application/json');
    this.deps.notify(`Exported template “${name}” (${payload.nodes.length} nodes).`);
    return true;
  }

  async importTemplate(): Promise<boolean> {
    try {
      const file = await this.deps.fileIO.pickFile([TEMPLATE_EXTENSION, '.json'], 'Kekenik Tree node template');
      if (!file) return false;
      const { name, payload } = decodeTemplate(file.bytes);
      this.deps.graph.importSubgraph(payload, `Import ${name}`);
      this.deps.notify(`Imported template “${name}”.`);
      return true;
    } catch (e) {
      this.deps.notify(`Could not import template: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  // ---- autosave / recovery -----------------------------------------------------------------------------------------

  /** Write every dirty document to the recovery store; remove records of documents that became clean. */
  async autosaveNow(): Promise<void> {
    for (const [id, dirty] of this.dirtyByDoc) {
      const doc = this.deps.store.get().documents.find((d) => d.id === id);
      const info = this.docs.get(id);
      if (!doc || !info) continue;
      if (dirty) {
        const record: AutosaveRecord = { docId: id, name: doc.name, fileName: info.fileName, savedAt: Date.now(), bytes: encodeProject(this.serialize(id)) };
        await this.autosaveStore.write(record);
        this.autosaved.add(id);
      } else if (this.autosaved.has(id)) {
        await this.autosaveStore.remove(id);
        this.autosaved.delete(id);
      }
    }
  }

  async offerRecovery(): Promise<void> {
    const records = await this.autosaveStore.list();
    if (records.length === 0) return;
    const names = records.map((r) => `• ${r.name}`).join('\n');
    const choice = await this.deps.ui.choose('Recover unsaved work', `The previous session ended with unsaved changes:\n${names}\n\nRecover them?`, [{ label: 'Recover', primary: true }, { label: 'Discard' }]);
    if (choice !== 0) {
      await this.autosaveStore.clear();
      return;
    }
    const firstId = this.deps.store.get().activeDocumentId;
    let restored = 0;
    for (const r of records) {
      try {
        const project = decodeProject(r.bytes);
        const id = this.createDocument(r.name, project.settings.seed);
        this.loadInto(id, project, r.fileName, null, false);
        this.deps.undo.markDirty();
        this.dirtyByDoc.set(id, true);
        restored += 1;
      } catch (e) {
        this.deps.notify(`Could not recover “${r.name}”: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    await this.autosaveStore.clear();
    this.autosaved.clear();
    if (restored > 0 && this.docs.get(firstId)?.pristine && !this.dirtyByDoc.get(firstId)) {
      const last = this.deps.store.get().activeDocumentId;
      this.removeDocument(firstId);
      this.deps.store.set({ activeDocumentId: last });
    }
    this.debounce.trigger();
    if (restored > 0) this.deps.notify(`Recovered ${restored} document${restored > 1 ? 's' : ''}.`);
  }

  // ---- internals ---------------------------------------------------------------------------------------------------

  /** Best-effort "recent files" bookkeeping: a storage problem must never fail a save/open. */
  private async remember(name: string, handle: FileHandleLike | null, bytes: Uint8Array): Promise<void> {
    try {
      await this.recent.add({ name, handle, bytes });
    } catch {
      await this.recent.add({ name, handle: null, bytes }).catch(() => undefined);
    }
    await this.refreshRecent();
  }

  private async refreshRecent(): Promise<void> {
    this.recentCache = await this.recent.list();
  }

  private uniqueName(base: string): string {
    const names = new Set(this.deps.store.get().documents.map((d) => d.name));
    if (!names.has(base)) return base;
    let n = ++this.untitledCounter;
    while (names.has(`${base} ${n}`)) n += 1;
    return `${base} ${n}`;
  }

  private defaultProject(name: string, seed: number): ProjectFile {
    return createProjectFile({ name, graph: defaultGraph(), meta: defaultMeta(seed), seed });
  }

  private createDocument(name: string, seed: number): string {
    const id = uid('doc');
    this.deps.store.set((s) => ({ documents: [...s.documents, { id, name, seed }], activeDocumentId: id }));
    return id;
  }

  /** Load `project` into the ACTIVE document `id` (the graph session works on the active document). */
  private loadInto(id: string, project: ProjectFile, fileName: string | null, handle: FileHandleLike | null, pristine: boolean): void {
    const { store, graph, undo } = this.deps;
    graph.loadGraph(project.graph);
    undo.markClean();
    this.docs.set(id, {
      fileName,
      handle,
      meta: {
        settings: project.settings,
        materials: project.materials,
        forces: project.forces,
        assets: project.assets,
        materialSets: project.materialSets ?? [],
        masks: project.masks ?? [],
        displacements: project.displacements ?? [],
        cutoutMeshes: project.cutoutMeshes ?? [],
        uvAreas: project.uvAreas ?? [],
      },
      pristine,
    });
    this.dirtyByDoc.set(id, false);
    store.set((s) => ({ documents: s.documents.map((d) => (d.id === id ? { ...d, name: fileName ?? d.name, seed: project.settings.seed } : d)) }));
    this.metaListeners.forEach((l) => l());
  }
}
