import { gunzipSync, gzipSync } from 'fflate';
import type { ProjectFile } from '@/contracts/project';
import { parseProject } from './format';
import { decodeContainer, encodeContainer, isContainer } from './binaryContainer';

/** Files above this size (JSON bytes) are gzip-compressed by default. Embedded textures make projects big. */
export const COMPRESS_THRESHOLD = 200 * 1024;

export interface EncodeOptions {
  /** true / false, or 'auto' (default): compress when larger than COMPRESS_THRESHOLD. */
  compress?: boolean | 'auto';
}

export const isGzip = (bytes: Uint8Array): boolean => bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;

/** Serialise any JSON value to bytes, optionally gzip-compressed (fflate). */
export function encodeJson(value: unknown, opts: EncodeOptions = {}): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(value));
  const compress = opts.compress ?? 'auto';
  return compress === true || (compress === 'auto' && raw.length > COMPRESS_THRESHOLD) ? gzipSync(raw, { level: 6 }) : raw;
}

/** Inverse of encodeJson; sniffs the gzip magic number. */
export function decodeJson(bytes: Uint8Array): unknown {
  if (isContainer(bytes)) return decodeContainer(bytes);
  const text = new TextDecoder().decode(isGzip(bytes) ? gunzipSync(bytes) : bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('The file is not valid JSON (corrupted or not a Kekenik Tree file).');
  }
}

/** Projects with embedded images use the binary container (raw image bytes); others stay plain / gzipped JSON. */
export const encodeProject = (file: ProjectFile, opts?: EncodeOptions): Uint8Array =>
  file.assets.some((a) => a.data) ? encodeContainer(file) : encodeJson(file, opts);
export const decodeProject = (bytes: Uint8Array): ProjectFile => parseProject(decodeJson(bytes));
