import type { ForceVolume } from '@/contracts/nodes';
import { getNumber, getString, type NodeParams } from '@/contracts/params';

export type { ForceVolume };

export type Vec3 = readonly [number, number, number];

export const VOLUME_SHAPES = ['none', 'sphere', 'box'] as const;

function vec3Of(params: NodeParams, id: string, fallback: Vec3): Vec3 {
  const v = params[id]?.value;
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number')) return [v[0] as number, v[1] as number, v[2] as number];
  return fallback;
}

/** Reads the Volume section of a Force node; null when the node has no volume (Shape = None). */
export function readForceVolume(name: string, params: NodeParams): ForceVolume | null {
  const shape = getString(params, 'volumeShape', 'none');
  if (shape !== 'sphere' && shape !== 'box') return null;
  const size = vec3Of(params, 'volumeSize', [2, 2, 2]);
  return {
    name,
    shape,
    center: vec3Of(params, 'volumeCenter', [0, 0, 0]),
    radius: Math.max(0, getNumber(params, 'volumeRadius', 1)),
    size: [Math.max(0, size[0]), Math.max(0, size[1]), Math.max(0, size[2])],
  };
}

export function insideVolume(v: ForceVolume, p: Vec3): boolean {
  const dx = p[0] - v.center[0];
  const dy = p[1] - v.center[1];
  const dz = p[2] - v.center[2];
  if (v.shape === 'sphere') return dx * dx + dy * dy + dz * dz <= v.radius * v.radius;
  return Math.abs(dx) <= v.size[0] / 2 && Math.abs(dy) <= v.size[1] / 2 && Math.abs(dz) <= v.size[2] / 2;
}

/** Force containers of a generator: names of volume forces whose region keeps (Include) or removes (Exclude) nodes. */
export interface ForceContainers {
  include: readonly string[];
  exclude: readonly string[];
}

export const NO_CONTAINERS: ForceContainers = { include: [], exclude: [] };

/**
 * Include: a node is kept only when it lies inside at least one of the named volumes (names that match no volume are
 * ignored; when none matches, Include does not restrict). Exclude: a node inside any named volume is removed.
 */
export function passesForceContainers(p: Vec3, containers: ForceContainers, volumes: readonly ForceVolume[]): boolean {
  if (containers.include.length === 0 && containers.exclude.length === 0) return true;
  const named = (names: readonly string[]): ForceVolume[] => volumes.filter((v) => names.includes(v.name));
  for (const v of named(containers.exclude)) if (insideVolume(v, p)) return false;
  const inc = named(containers.include);
  if (inc.length === 0) return true;
  return inc.some((v) => insideVolume(v, p));
}

/** Rows of a list parameter (`{ <field>: name }`) as a plain list of non-empty names. */
export function listNames(params: NodeParams, id: string, field: string): string[] {
  const v = params[id]?.value;
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const row of v) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const name = (row as Record<string, unknown>)[field];
    if (typeof name === 'string' && name !== '') out.push(name);
  }
  return out;
}

export function readForceContainers(params: NodeParams): ForceContainers {
  return { include: listNames(params, 'forceInclude', 'forceName'), exclude: listNames(params, 'forceExclude', 'forceName') };
}
