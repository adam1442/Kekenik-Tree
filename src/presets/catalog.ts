import type { ProjectFile } from '@/contracts/project';
import { decodeProject, encodeProject } from '@/app/project/codec';
import { fileNameForProject } from '@/app/project/format';
import { IndexedDbKeyValueStore, type KeyValueStore } from '@/app/project/kvStore';
import { uid } from '@/core/id';
import { buildSpeciesProject } from './builder';
import { SPECIES } from './species';
import type { PresetCategory, PresetEntry } from './types';

const USER_PREFIX = 'preset:user:';
/** Bump when built-in species change so cached thumbnails are regenerated. */
export const BUILTIN_REVISION = 'b1';

interface UserRecord {
  id: string;
  name: string;
  savedAt: number;
  bytes: Uint8Array;
}

const isUserRecord = (v: unknown): v is UserRecord => {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.name === 'string' && typeof r.savedAt === 'number' && r.bytes instanceof Uint8Array;
};

export function builtinPresets(): PresetEntry[] {
  return SPECIES.map((s) => ({
    id: s.id,
    name: s.name,
    category: s.category,
    description: s.description,
    tags: s.tags,
    builtin: true,
    revision: `${BUILTIN_REVISION}`,
    load: () => Promise.resolve(buildSpeciesProject(s)),
  }));
}

/** Case-insensitive search over name, tags and description; `category` null / 'All' keeps everything. */
export function filterPresets(entries: readonly PresetEntry[], query: string, category: PresetCategory | 'User' | 'All' | null): PresetEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((e) => {
    if (category && category !== 'All' && e.category !== category) return false;
    const hay = `${e.name} ${e.category} ${e.tags.join(' ')} ${e.description}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** Built-in species plus the user's local presets (stored in IndexedDB as `.ktree` bytes). */
export class PresetCatalog {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly kv: KeyValueStore) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  async userPresets(): Promise<PresetEntry[]> {
    const keys = await this.kv.keys(USER_PREFIX);
    const out: PresetEntry[] = [];
    for (const key of keys) {
      const rec = await this.kv.get(key);
      if (!isUserRecord(rec)) continue;
      out.push({
        id: rec.id,
        name: rec.name,
        category: 'User',
        description: `Saved ${new Date(rec.savedAt).toLocaleString()}`,
        tags: ['user'],
        builtin: false,
        revision: String(rec.savedAt),
        load: () => Promise.resolve(decodeProject(rec.bytes)),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async all(): Promise<PresetEntry[]> {
    return [...builtinPresets(), ...(await this.userPresets())];
  }

  async saveUser(name: string, project: ProjectFile): Promise<PresetEntry> {
    const id = uid('user');
    const rec: UserRecord = { id, name: name.trim() || 'Untitled preset', savedAt: Date.now(), bytes: encodeProject({ ...project, name }) };
    await this.kv.set(USER_PREFIX + id, rec);
    this.emit();
    const found = (await this.userPresets()).find((p) => p.id === id);
    if (!found) throw new Error('Preset could not be stored');
    return found;
  }

  async deleteUser(id: string): Promise<void> {
    await this.kv.delete(USER_PREFIX + id);
    await this.kv.delete(`thumb:${id}`);
    this.emit();
  }

  /** Import a `.ktree` file as a user preset. Throws on invalid data. */
  async importBytes(fileName: string, bytes: Uint8Array): Promise<PresetEntry> {
    const project = decodeProject(bytes);
    return this.saveUser(fileName.replace(/\.(ktree|json)$/i, '') || project.name, project);
  }

  /** Bytes + file name for exporting any preset as a `.ktree` file. */
  async exportBytes(entry: PresetEntry): Promise<{ name: string; bytes: Uint8Array }> {
    return { name: fileNameForProject(entry.name), bytes: encodeProject(await entry.load()) };
  }
}

let catalog: PresetCatalog | null = null;

export function getPresetCatalog(): PresetCatalog {
  catalog ??= new PresetCatalog(new IndexedDbKeyValueStore());
  return catalog;
}

