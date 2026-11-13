import type { EdgeKind } from './ports';
import type { NodeParams } from './params';
import type {
  CutoutMesh,
  DisplacementDef,
  ForceDef,
  MaskDef,
  MaterialDef,
  MaterialSetDef,
  UVAreaDef,
  WindSettings,
} from './material';

/** Versioned project file (JSON). Persistence lives in `src/app/project`. */

export const PROJECT_VERSION = 2;

export interface GraphNodeJSON {
  id: string;
  /** NodeDef.type */
  type: string;
  name: string;
  position: { x: number; y: number };
  enabled: boolean;
  params: NodeParams;
  /** Optional editor state (absent = false / empty). */
  bypass?: boolean;
  solo?: boolean;
  collapsed?: boolean;
  locked?: boolean;
  note?: string;
}

export interface GraphEdgeJSON {
  id: string;
  kind: EdgeKind;
  from: { nodeId: string; portId: string };
  to: { nodeId: string; portId: string };
}

/** Group box or sticky comment drawn behind the nodes (editor-only, no effect on generation). */
export interface GraphAnnotationJSON {
  id: string;
  kind: 'group' | 'comment';
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Theme colour key: blue | green | yellow | red | gray. */
  color: string;
}

export interface GraphJSON {
  nodes: GraphNodeJSON[];
  edges: GraphEdgeJSON[];
  annotations?: GraphAnnotationJSON[];
}

export interface ProjectSettings {
  seed: number;
  units: 'm' | 'cm';
  /** Always 'Z' in v1. */
  upAxis: 'Z';
  lodCount: number;
  wind: WindSettings;
}

export interface AssetEntry {
  id: string;
  kind: 'image' | 'mesh';
  name: string;
  mime: string;
  /** Data URL or base64 payload. Empty when the bytes live in the binary container (see app/project/binaryContainer.ts). */
  data: string;
  /** SHA-256 / FNV content hash used to dedupe imports. */
  hash?: string;
}

export interface ProjectFile {
  version: number;
  /** Constant "kekenik-tree" in files written by v2+ (sniffing aid). */
  format?: string;
  /** ISO timestamp of the save. */
  savedAt?: string;
  /** Schema version of every node type present in `graph` at save time (NodeDef.version), for per-node migration. */
  nodeVersions?: Record<string, number>;
  name: string;
  graph: GraphJSON;
  settings: ProjectSettings;
  materials: MaterialDef[];
  forces: ForceDef[];
  assets: AssetEntry[];
  /** Absent in older files. */
  materialSets?: MaterialSetDef[];
  masks?: MaskDef[];
  displacements?: DisplacementDef[];
  /** Absent in older files. */
  cutoutMeshes?: CutoutMesh[];
  uvAreas?: UVAreaDef[];
}

export function isProjectFile(raw: unknown): raw is ProjectFile {
  if (typeof raw !== 'object' || raw === null) return false;
  const r = raw as Record<string, unknown>;
  return typeof r.version === 'number' && typeof r.graph === 'object' && r.graph !== null && typeof r.settings === 'object';
}

type RawProject = Record<string, unknown>;

/** One step per version: `PROJECT_MIGRATIONS[n]` upgrades a version-n file to version n+1. */
export const PROJECT_MIGRATIONS: Record<number, (raw: RawProject) => RawProject> = {
  /** v1 -> v2: adds format / nodeVersions and guarantees the collection fields exist. */
  1: (raw) => {
    const graph = typeof raw.graph === 'object' && raw.graph !== null ? (raw.graph as { nodes?: unknown }) : {};
    const nodeVersions: Record<string, number> = {};
    for (const n of Array.isArray(graph.nodes) ? graph.nodes : []) {
      const type = (n as { type?: unknown } | null)?.type;
      if (typeof type === 'string') nodeVersions[type] = 1;
    }
    return {
      ...raw,
      format: 'kekenik-tree',
      nodeVersions,
      materials: Array.isArray(raw.materials) ? raw.materials : [],
      forces: Array.isArray(raw.forces) ? raw.forces : [],
      assets: Array.isArray(raw.assets) ? raw.assets : [],
    };
  },
};

/** Upgrade older files to PROJECT_VERSION by running the migration chain; throws for unsupported/newer versions. */
export function migrateProject(raw: unknown): ProjectFile {
  if (!isProjectFile(raw)) throw new Error('Not a Kekenik Tree project file');
  if (!Number.isInteger(raw.version) || raw.version < 1) throw new Error(`Invalid project version ${String(raw.version)}`);
  if (raw.version > PROJECT_VERSION) throw new Error(`Project version ${raw.version} is newer than supported (${PROJECT_VERSION})`);
  let cur = structuredClone(raw) as unknown as RawProject;
  for (let v = raw.version; v < PROJECT_VERSION; v++) {
    const step = PROJECT_MIGRATIONS[v];
    if (!step) throw new Error(`No migration from project version ${v}`);
    cur = { ...step(cur), version: v + 1 };
  }
  return cur as unknown as ProjectFile;
}
