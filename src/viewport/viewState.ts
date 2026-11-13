import { loadJSON, saveJSON } from '@/app/settings';

/** Toolbar > Edit > Visibility: which node families are drawn. */
export type VisibilityKey = 'trunks' | 'branches' | 'fronds' | 'leaves' | 'caps' | 'decorations' | 'roots' | 'collision';
export type VisibilityMap = Record<VisibilityKey, boolean>;

export const VISIBILITY_LABELS: Record<VisibilityKey, string> = {
  trunks: 'Trunks',
  branches: 'Branches',
  fronds: 'Fronds',
  leaves: 'Leaves',
  caps: 'Caps',
  decorations: 'Decorations',
  roots: 'Roots',
  collision: 'Collision objects',
};

/** Node type -> visibility family (types not listed here are always visible). */
const FAMILY: Record<string, VisibilityKey> = {
  'generator.trunk': 'trunks',
  'generator.branch': 'branches',
  'generator.spine': 'branches',
  'generator.split': 'branches',
  'generator.knot': 'branches',
  'generator.frond': 'fronds',
  'generator.leaf': 'leaves',
  'generator.cluster': 'leaves',
  'generator.meshes': 'leaves',
  'generator.cap': 'caps',
  'generator.decoration': 'decorations',
  'generator.root': 'roots',
};

export const familyOf = (nodeType: string): VisibilityKey | null => FAMILY[nodeType] ?? null;

export interface ViewFilter {
  visibility: VisibilityMap;
  /** When non-null only these node ids are drawn (Isolate selected). */
  isolate: readonly string[] | null;
}

export const defaultVisibility = (): VisibilityMap => ({ trunks: true, branches: true, fronds: true, leaves: true, caps: true, decorations: true, roots: true, collision: true });

/** Is a node drawn under the filter? */
export function isNodeVisible(f: ViewFilter, nodeId: string, nodeType: string | undefined): boolean {
  if (f.isolate && !f.isolate.includes(nodeId)) return false;
  const fam = nodeType ? familyOf(nodeType) : null;
  return fam === null || f.visibility[fam];
}

const KEY = 'kt.viewFilter.v1';
let visibility: VisibilityMap = { ...defaultVisibility(), ...(sanitize(typeof localStorage === 'undefined' ? null : loadJSON(KEY))) };
let isolate: readonly string[] | null = null;
const listeners = new Set<() => void>();

function sanitize(raw: unknown): Partial<VisibilityMap> {
  const out: Partial<VisibilityMap> = {};
  if (raw && typeof raw === 'object') for (const k of Object.keys(VISIBILITY_LABELS) as VisibilityKey[]) if (typeof (raw as Record<string, unknown>)[k] === 'boolean') out[k] = (raw as Record<string, boolean>)[k] as boolean;
  return out;
}

export const getViewFilter = (): ViewFilter => ({ visibility, isolate });

export function setVisibility(patch: Partial<VisibilityMap>): void {
  visibility = { ...visibility, ...patch };
  if (typeof localStorage !== 'undefined') saveJSON(KEY, visibility);
  listeners.forEach((l) => l());
}

export function setIsolate(ids: readonly string[] | null): void {
  isolate = ids && ids.length > 0 ? [...ids] : null;
  listeners.forEach((l) => l());
}

export function showAll(): void {
  isolate = null;
  setVisibility(defaultVisibility());
}

export function onViewFilterChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reference objects of the scene (Toolbar > Scene Objects). */
export interface SceneObjectDef {
  id: string;
  kind: 'box' | 'cylinder' | 'sphere';
  /** Position of the centre on the ground plane (z is derived from the size). */
  x: number;
  y: number;
  /** Size in metres (box: x/y/z extents, cylinder: x = diameter, z = height, sphere: x = diameter). */
  sx: number;
  sy: number;
  sz: number;
}

const OBJ_KEY = 'kt.sceneObjects.v1';
let objects: SceneObjectDef[] = loadObjects();
const objListeners = new Set<(o: readonly SceneObjectDef[]) => void>();

function loadObjects(): SceneObjectDef[] {
  const raw = typeof localStorage === 'undefined' ? null : loadJSON(OBJ_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is SceneObjectDef => !!o && typeof o === 'object' && typeof (o as SceneObjectDef).id === 'string' && ['box', 'cylinder', 'sphere'].includes((o as SceneObjectDef).kind) && [(o as SceneObjectDef).x, (o as SceneObjectDef).y, (o as SceneObjectDef).sx, (o as SceneObjectDef).sy, (o as SceneObjectDef).sz].every(Number.isFinite));
}

export const getSceneObjects = (): readonly SceneObjectDef[] => objects;

function commitObjects(next: SceneObjectDef[]): void {
  objects = next;
  if (typeof localStorage !== 'undefined') saveJSON(OBJ_KEY, objects);
  objListeners.forEach((l) => l(objects));
}

let counter = 0;
export function addSceneObject(kind: SceneObjectDef['kind'], at: { x: number; y: number }): SceneObjectDef {
  const size = kind === 'box' ? { sx: 1, sy: 1, sz: 1 } : kind === 'cylinder' ? { sx: 0.8, sy: 0.8, sz: 1.6 } : { sx: 1, sy: 1, sz: 1 };
  const o: SceneObjectDef = { id: `so-${Date.now().toString(36)}-${counter++}`, kind, x: at.x, y: at.y, ...size };
  commitObjects([...objects, o]);
  return o;
}

export function updateSceneObject(id: string, patch: Partial<Omit<SceneObjectDef, 'id' | 'kind'>>): void {
  commitObjects(objects.map((o) => (o.id === id ? { ...o, ...patch } : o)));
}

export function removeSceneObject(id: string): void {
  commitObjects(objects.filter((o) => o.id !== id));
}

export function onSceneObjectsChange(fn: (o: readonly SceneObjectDef[]) => void): () => void {
  objListeners.add(fn);
  return () => objListeners.delete(fn);
}
