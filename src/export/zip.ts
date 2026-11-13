import { zip, zipSync, type Zippable } from 'fflate';
import type { ExportFile } from './types';

const COMPRESSED = /\.(png|jpe?g|webp|glb|zip)$/i;

const bytesOf = (f: ExportFile): Uint8Array => (typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data);

function toZippable(files: readonly ExportFile[], folder: string): Zippable {
  const map: Zippable = {};
  for (const f of files) {
    // Already-compressed payloads are stored; text and raw binary are deflated.
    map[`${folder}${f.name}`] = [bytesOf(f), { level: COMPRESSED.test(f.name) ? 0 : 6 }];
  }
  return map;
}

/** Bundle files into a zip without blocking the UI (fflate worker), falling back to the synchronous encoder. */
export function zipFiles(files: readonly ExportFile[], folder = ''): Promise<Uint8Array> {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  const map = toZippable(files, prefix);
  return new Promise((resolve, reject) => {
    try {
      zip(map, (err, data) => {
        if (err) {
          try {
            resolve(zipSync(map));
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        } else resolve(data);
      });
    } catch {
      resolve(zipSync(map));
    }
  });
}
