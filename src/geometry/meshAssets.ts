import type { MeshData } from '@/contracts/mesh';
import type { AssetEntry } from '@/contracts/project';
import { fitToUnit, parseGltf, parseObj } from './meshImport';

/**
 * Resolves `asset` parameters of kind 'mesh' (project asset table, data-URL payload) to unit-fitted MeshData.
 * The app registers the lookup at bootstrap; evaluation stays synchronous and the parse result is cached per asset id.
 */
export type AssetLookup = (id: string) => AssetEntry | undefined;

let lookup: AssetLookup = () => undefined;
const cache = new Map<string, MeshData | null>();

export function setMeshAssetLookup(fn: AssetLookup): void {
  lookup = fn;
  cache.clear();
}

function payloadBytes(data: string): Uint8Array {
  const comma = data.indexOf(',');
  if (data.startsWith('data:') && comma >= 0) {
    const meta = data.slice(5, comma);
    const body = data.slice(comma + 1);
    if (meta.includes(';base64')) {
      const bin = atob(body);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(decodeURIComponent(body));
  }
  return new TextEncoder().encode(data);
}

export function parseMeshAsset(entry: Pick<AssetEntry, 'name' | 'data'>, materialId: string): MeshData {
  const bytes = payloadBytes(entry.data);
  const name = entry.name.toLowerCase();
  const isObj = name.endsWith('.obj');
  return fitToUnit(isObj ? parseObj(new TextDecoder().decode(bytes), materialId) : parseGltf(bytes, materialId));
}

/** Unit-fitted mesh for an asset id, or null when missing / unreadable. */
export function loadMeshAsset(id: string | null, materialId: string): MeshData | null {
  if (!id) return null;
  const key = `${id}|${materialId}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const entry = lookup(id);
  if (!entry) return null; // not cached: the asset may be added later
  let mesh: MeshData | null;
  try {
    mesh = parseMeshAsset(entry, materialId);
    if (mesh.indices.length === 0) mesh = null;
  } catch {
    mesh = null;
  }
  cache.set(key, mesh);
  return mesh;
}
