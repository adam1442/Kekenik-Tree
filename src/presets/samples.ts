import type { ProjectFile } from '@/contracts/project';
import { decodeProject } from '@/app/project/codec';
import type { PresetCategory } from './types';

/**
 * Built-in sample projects. They are real `.ktree` files stored in `public/Sample Projects/`; Vite copies that folder
 * next to `index.html` (`dist/Sample Projects/`) and a sample is fetched only when it is opened or its thumbnail is
 * rendered (about 32 MB in total, so they are not inlined into the single-file bundle).
 * To add a sample: drop the file into `public/Sample Projects/` and add one row to `SAMPLES` below.
 */
export interface SampleDef {
  id: string;
  /** File name inside `Sample Projects/` (case-sensitive). */
  file: string;
  name: string;
  category: PresetCategory;
  description: string;
  tags: string[];
}

export const SAMPLES: readonly SampleDef[] = [
  {
    id: 'oak',
    file: 'oak.ktree',
    name: 'Oak',
    category: 'Broadleaf',
    description: 'Broadleaf tree with a forking trunk, a hierarchy of branches, three leaf generators and a bark knot.',
    tags: ['broadleaf', 'deciduous', 'tree', 'knot'],
  },
  {
    id: 'birch',
    file: 'Birch.ktree',
    name: 'Birch',
    category: 'Broadleaf',
    description: 'Slender birch with light branches, small leaves and wind settings.',
    tags: ['broadleaf', 'deciduous', 'tree', 'wind'],
  },
  {
    id: 'palm',
    file: 'palm.ktree',
    name: 'Palm',
    category: 'Palm & Tropical',
    description: 'Palm with a ringed trunk, a crown of fronds, a spine-driven frond and a fin generator.',
    tags: ['palm', 'tropical', 'frond', 'fin'],
  },
  {
    id: 'fern',
    file: 'fern.ktree',
    name: 'Fern',
    category: 'Shrubs & Plants',
    description: 'Ground fern made of spines carrying frond generators, bent by gravity.',
    tags: ['fern', 'plant', 'frond', 'undergrowth'],
  },
  {
    id: 'grass',
    file: 'grass.ktree',
    name: 'Grass',
    category: 'Shrubs & Plants',
    description: 'Grass tuft: one spine with a frond generator for the blades, bent by gravity.',
    tags: ['grass', 'plant', 'frond', 'meadow'],
  },
  {
    id: 'swamp',
    file: 'swamp.ktree',
    name: 'Swamp',
    category: 'Special',
    description: 'Gnarled swamp tree with drooping branches, directional forces and wind settings.',
    tags: ['swamp', 'tree', 'forces', 'wind'],
  },
];

/** The sample the Library lists first. */
export const DEFAULT_WELCOME_PRESET_ID = 'oak';

/** Folder of the sample files, relative to `index.html` (Vite copies `public/` next to it in `dist/`). */
export const SAMPLE_FOLDER = 'Sample Projects';

/** Page-relative URL of a sample file; resolves against the document, so it works from any sub-path (GitHub Pages). */
export const sampleUrl = (def: SampleDef): string => encodeURI(`${SAMPLE_FOLDER}/${def.file}`);

/** Raw `.ktree` bytes of a sample (also used by the Library export). */
export async function sampleBytes(def: SampleDef): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(sampleUrl(def), { cache: 'force-cache' });
  } catch {
    throw new Error(`The sample "${def.name}" could not be read. Open the app through a web server (the "${SAMPLE_FOLDER}" folder must sit next to index.html).`);
  }
  if (!res.ok) throw new Error(`The sample file "${SAMPLE_FOLDER}/${def.file}" was not found (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Decode a sample into an evaluate-ready project (named after the sample, not after the name stored in the file). */
export async function loadSampleProject(def: SampleDef): Promise<ProjectFile> {
  return { ...decodeProject(await sampleBytes(def)), name: def.name };
}
