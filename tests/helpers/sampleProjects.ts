import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProjectFile } from '@/contracts/project';
import { decodeProject } from '@/app/project/codec';
import { SAMPLES, type SampleDef } from '@/presets/samples';

/** Folder with the built-in sample projects (`.ktree` files, served from `public/`). */
export const SAMPLE_DIR = path.resolve(__dirname, '../../public/Sample Projects');

export const SAMPLE_IDS: readonly string[] = SAMPLES.map((s) => s.id);

export function sampleDef(id: string): SampleDef {
  const def = SAMPLES.find((s) => s.id === id);
  if (!def) throw new Error(`Unknown sample "${id}"`);
  return def;
}

/** Raw bytes of a sample file, read straight from disk. */
export const sampleFileBytes = (id: string): Uint8Array => new Uint8Array(readFileSync(path.join(SAMPLE_DIR, sampleDef(id).file)));

/** Decoded sample project (same decoder as File > Open). */
export function loadSample(id: string): ProjectFile {
  return decodeProject(sampleFileBytes(id));
}

/** Test stand-in for `fetch` that serves the sample URLs from disk (a relative URL cannot be fetched under vitest). */
export function sampleFetch(input: unknown): Promise<Response> {
  const url = decodeURIComponent(String(input)).split('?')[0] as string;
  const file = path.join(SAMPLE_DIR, path.basename(url));
  try {
    const bytes = readFileSync(file);
    return Promise.resolve(new Response(bytes, { status: 200 }));
  } catch {
    return Promise.resolve(new Response('not found', { status: 404 }));
  }
}
