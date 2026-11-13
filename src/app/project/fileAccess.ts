import { FILE_EXTENSION } from './format';

/** The subset of FileSystemFileHandle we use (not in lib.dom for every TS version). */
export interface FileHandleLike {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob | BufferSource | string): Promise<void>; close(): Promise<void> }>;
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<'granted' | 'denied' | 'prompt'>;
}

export interface OpenedFile {
  name: string;
  bytes: Uint8Array;
  /** null with the upload fallback (no write-back possible). */
  handle: FileHandleLike | null;
}

export interface SavedFile {
  name: string;
  handle: FileHandleLike | null;
}

/** Abstraction over the browser so the project manager is testable and works with / without the FS Access API. */
export interface FileIO {
  openFile(): Promise<OpenedFile | null>;
  /** Write to an existing handle (silent save). */
  writeHandle(handle: FileHandleLike, bytes: Uint8Array): Promise<void>;
  /** Ask where to save (picker) or download (fallback). null = cancelled. */
  saveAs(suggestedName: string, bytes: Uint8Array): Promise<SavedFile | null>;
  readHandle(handle: FileHandleLike): Promise<OpenedFile | null>;
  /** Pick any file by extension list (templates). */
  pickFile(extensions: string[], description: string): Promise<OpenedFile | null>;
  download(name: string, bytes: Uint8Array, mime?: string): void;
}

interface PickerWindow {
  showOpenFilePicker?: (o: { types: { description: string; accept: Record<string, string[]> }[]; multiple: boolean }) => Promise<FileHandleLike[]>;
  showSaveFilePicker?: (o: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandleLike>;
}

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

async function readFile(file: File): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer());
}

function typesFor(extensions: string[], description: string): { description: string; accept: Record<string, string[]> }[] {
  return [{ description, accept: { 'application/octet-stream': extensions } }];
}

export function supportsFileSystemAccess(): boolean {
  const w = window as unknown as PickerWindow;
  return typeof w.showOpenFilePicker === 'function' && typeof w.showSaveFilePicker === 'function';
}

function downloadBytes(name: string, bytes: Uint8Array, mime = 'application/octet-stream'): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** <input type=file> fallback. Resolves null when the dialog is dismissed (via the `cancel` event, where supported). */
function uploadPicker(accept: string): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      void readFile(file).then((bytes) => resolve({ name: file.name, bytes, handle: null }));
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}

export function createBrowserFileIO(): FileIO {
  const w = window as unknown as PickerWindow;
  const pick = async (extensions: string[], description: string): Promise<OpenedFile | null> => {
    if (supportsFileSystemAccess() && w.showOpenFilePicker) {
      try {
        const [handle] = await w.showOpenFilePicker({ types: typesFor(extensions, description), multiple: false });
        if (!handle) return null;
        return { name: handle.name, bytes: await readFile(await handle.getFile()), handle };
      } catch (e) {
        if (isAbort(e)) return null;
        throw e;
      }
    }
    return uploadPicker([...extensions, 'application/json'].join(','));
  };
  return {
    openFile: () => pick([FILE_EXTENSION, '.json'], 'Kekenik Tree project'),
    pickFile: pick,
    async writeHandle(handle, bytes) {
      const writable = await handle.createWritable();
      await writable.write(bytes as BufferSource);
      await writable.close();
    },
    async saveAs(suggestedName, bytes) {
      if (supportsFileSystemAccess() && w.showSaveFilePicker) {
        try {
          const handle = await w.showSaveFilePicker({ suggestedName, types: typesFor([FILE_EXTENSION], 'Kekenik Tree project') });
          const writable = await handle.createWritable();
          await writable.write(bytes as BufferSource);
          await writable.close();
          return { name: handle.name, handle };
        } catch (e) {
          if (isAbort(e)) return null;
          throw e;
        }
      }
      downloadBytes(suggestedName, bytes);
      return { name: suggestedName, handle: null };
    },
    async readHandle(handle) {
      if (handle.queryPermission && (await handle.queryPermission({ mode: 'read' })) !== 'granted') {
        if (!handle.requestPermission || (await handle.requestPermission({ mode: 'read' })) !== 'granted') return null;
      }
      return { name: handle.name, bytes: await readFile(await handle.getFile()), handle };
    },
    download: downloadBytes,
  };
}
