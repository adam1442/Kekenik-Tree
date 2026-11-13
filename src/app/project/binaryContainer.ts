import { gunzipSync, gzipSync } from 'fflate';
import type { ProjectFile } from '@/contracts/project';
import { base64ToBytes, bytesToBase64 } from '@/textures/bytes';

/**
 * Binary `.ktree` container used when a project embeds assets: image bytes are stored raw (no base64 +33 %, no gzip of
 * already compressed data) after a (gzip-compressed) JSON header.
 *
 *   "KTB1" | flags u8 (bit0 = json gzipped) | jsonLength u32 LE | json bytes | blob 0 | blob 1 | ...
 * The JSON is the normal ProjectFile with `assets[i].data === ''` plus a `blobs: [{id, length}]` table.
 */
export const CONTAINER_MAGIC = [0x4b, 0x54, 0x42, 0x31] as const;

export const isContainer = (b: Uint8Array): boolean => b.length > 9 && CONTAINER_MAGIC.every((v, i) => b[i] === v);

interface BlobEntry {
  id: string;
  length: number;
  /** Original `data:...;base64,` prefix when the asset was stored as a data URL. */
  prefix?: string;
}

export function encodeContainer(file: ProjectFile): Uint8Array {
  const blobs: Uint8Array[] = [];
  const table: BlobEntry[] = [];
  const assets = file.assets.map((a) => {
    if (!a.data) return a;
    const bytes = base64ToBytes(a.data);
    blobs.push(bytes);
    const comma = a.data.startsWith('data:') ? a.data.indexOf(',') : -1;
    table.push({ id: a.id, length: bytes.length, ...(comma >= 0 ? { prefix: a.data.slice(0, comma + 1) } : {}) });
    return { ...a, data: '' };
  });
  const json = new TextEncoder().encode(JSON.stringify({ ...file, assets, blobs: table }));
  const gz = gzipSync(json, { level: 6 });
  const useGz = gz.length < json.length;
  const head = useGz ? gz : json;
  const total = 9 + head.length + blobs.reduce((s, b) => s + b.length, 0);
  const out = new Uint8Array(total);
  out.set(CONTAINER_MAGIC, 0);
  out[4] = useGz ? 1 : 0;
  new DataView(out.buffer).setUint32(5, head.length, true);
  out.set(head, 9);
  let o = 9 + head.length;
  for (const b of blobs) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

/** Returns the parsed JSON (ProjectFile shape) with every asset's `data` restored as base64. */
export function decodeContainer(bytes: Uint8Array): unknown {
  if (!isContainer(bytes)) throw new Error('Not a Kekenik Tree binary container');
  const gz = (bytes[4] as number) & 1;
  const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(5, true);
  if (9 + len > bytes.length) throw new Error('The project file is truncated.');
  const head = bytes.subarray(9, 9 + len);
  const raw = JSON.parse(new TextDecoder().decode(gz ? gunzipSync(head) : head)) as ProjectFile & { blobs?: BlobEntry[] };
  const { blobs = [], ...file } = raw;
  let o = 9 + len;
  const byId = new Map<string, Uint8Array>();
  const prefixes = new Map<string, string>();
  for (const b of blobs) {
    if (o + b.length > bytes.length) throw new Error('The project file is truncated (asset data missing).');
    byId.set(b.id, bytes.subarray(o, o + b.length));
    if (b.prefix) prefixes.set(b.id, b.prefix);
    o += b.length;
  }
  return { ...file, assets: file.assets.map((a) => (byId.has(a.id) ? { ...a, data: (prefixes.get(a.id) ?? '') + bytesToBase64(byId.get(a.id) as Uint8Array) } : a)) };
}
