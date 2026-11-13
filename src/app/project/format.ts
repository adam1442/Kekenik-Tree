import { ATTACH_VERSION, ensureCutoutAttachmentData } from '@/materials/cutouts/frame';
import type {
  CutoutMesh,
  DisplacementDef,
  ForceDef,
  MaskDef,
  MaterialDef,
  MaterialSetDef,
  UVAreaDef,
} from '@/contracts/material';
import { defaultWindSettings } from '@/contracts/material';
import type { NodeParams } from '@/contracts/params';
import { migrateProject, PROJECT_VERSION, type AssetEntry, type GraphJSON, type ProjectFile, type ProjectSettings } from '@/contracts/project';
import { migrateNodeParams, nodeVersion } from '@/graph/registry';

export const FILE_EXTENSION = '.ktree';
export const TEMPLATE_EXTENSION = '.kttemplate';
export const FORMAT_ID = 'kekenik-tree';

/** Parts of a project the graph editor does not own (kept verbatim). */
export interface ProjectMeta {
  settings: ProjectSettings;
  materials: MaterialDef[];
  forces: ForceDef[];
  assets: AssetEntry[];
  materialSets?: MaterialSetDef[];
  masks?: MaskDef[];
  displacements?: DisplacementDef[];
  cutoutMeshes?: CutoutMesh[];
  uvAreas?: UVAreaDef[];
}

export function defaultMeta(seed: number): ProjectMeta {
  return { settings: { seed, units: 'm', upAxis: 'Z', lodCount: 4, wind: defaultWindSettings() }, materials: [], forces: [], assets: [] };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Strip the extension: "Spruce.ktree" -> "Spruce". */
export function projectNameFromFile(fileName: string): string {
  return fileName.replace(/\.(ktree|json)$/i, '') || 'Untitled';
}

export function fileNameForProject(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'Untitled';
  return safe.toLowerCase().endsWith(FILE_EXTENSION) ? safe : `${safe}${FILE_EXTENSION}`;
}

/** Collect the NodeDef versions of every node type used in `graph`. */
export function collectNodeVersions(graph: GraphJSON): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of graph.nodes) out[n.type] = nodeVersion(n.type);
  return out;
}

export function createProjectFile(args: { name: string; graph: GraphJSON; meta: ProjectMeta; seed: number }): ProjectFile {
  return {
    version: PROJECT_VERSION,
    format: FORMAT_ID,
    savedAt: new Date().toISOString(),
    nodeVersions: collectNodeVersions(args.graph),
    name: args.name,
    graph: args.graph,
    settings: { ...args.meta.settings, seed: args.seed },
    materials: args.meta.materials,
    forces: args.meta.forces,
    assets: args.meta.assets,
    materialSets: args.meta.materialSets ?? [],
    masks: args.meta.masks ?? [],
    displacements: args.meta.displacements ?? [],
    cutoutMeshes: args.meta.cutoutMeshes ?? [],
    uvAreas: args.meta.uvAreas ?? [],
  };
}

/** Per-node param migration (NodeDef.migrate hooks). Returns a new graph; unknown types are left untouched. */
export function migrateGraphNodes(graph: GraphJSON, nodeVersions: Record<string, number> | undefined): GraphJSON {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => {
      const from = nodeVersions?.[n.type] ?? 1;
      const params: NodeParams = migrateNodeParams(n.type, n.params, from);
      return params === n.params ? n : { ...n, params };
    }),
  };
}

/**
 * Validate + upgrade raw JSON into a ProjectFile: runs the project migration chain, sanitises the fields every
 * consumer relies on and migrates node params. Throws a readable Error on anything unusable.
 */
export function parseProject(raw: unknown): ProjectFile {
  const p = migrateProject(raw);
  const graph = isRecord(p.graph) ? p.graph : ({} as GraphJSON);
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('Project graph is malformed (nodes/edges missing)');
  const s = isRecord(p.settings) ? (p.settings as unknown as Partial<ProjectSettings>) : {};
  const settings: ProjectSettings = {
    seed: typeof s.seed === 'number' && Number.isFinite(s.seed) ? Math.trunc(s.seed) >>> 0 : 1337,
    units: s.units === 'cm' ? 'cm' : 'm',
    upAxis: 'Z',
    lodCount: typeof s.lodCount === 'number' && s.lodCount >= 1 ? Math.min(8, Math.trunc(s.lodCount)) : 4,
    wind: isRecord(s.wind) ? { ...defaultWindSettings(), ...(s.wind as object) } : defaultWindSettings(),
  };
  return {
    ...p,
    name: typeof p.name === 'string' && p.name ? p.name : 'Untitled',
    graph: migrateGraphNodes(graph as GraphJSON, p.nodeVersions),
    settings,
    materials: Array.isArray(p.materials) ? p.materials : [],
    forces: Array.isArray(p.forces) ? p.forces : [],
    assets: Array.isArray(p.assets) ? p.assets : [],
    materialSets: Array.isArray(p.materialSets) ? p.materialSets : [],
    masks: Array.isArray(p.masks) ? p.masks : [],
    displacements: Array.isArray(p.displacements) ? p.displacements : [],
    cutoutMeshes: Array.isArray(p.cutoutMeshes) ? p.cutoutMeshes.map(migrateCutout) : [],
    uvAreas: Array.isArray(p.uvAreas) ? p.uvAreas : [],
    nodeVersions: collectNodeVersions(graph as GraphJSON),
  };
}

/** Fill axis / anchor data of cutouts saved before attachment frames existed (never throws). */
function migrateCutout(c: CutoutMesh): CutoutMesh {
  try {
    if (c && c.attachVersion !== ATTACH_VERSION) ensureCutoutAttachmentData(c);
  } catch {
    /* keep the cutout as stored; generators fall back to the default axis */
  }
  return c;
}
