import type { InstanceTable } from '@/instances/types';
import type { AttachmentSet } from './attachment';
import type { WindSettings } from './material';
import type { MeshData } from './mesh';
import type { Skeleton } from './skeleton';

/**
 * Evaluation engine data shapes. The engine itself lives in src/graph/engine/ and is DOM-free.
 */

/** Per-node evaluation outcome shown on the node (badge + tooltip). */
export type NodeState =
  /** Not evaluated yet in this run. */
  | 'pending'
  | 'running'
  /** Evaluated now. */
  | 'ok'
  /** Result reused from the cache. */
  | 'cached'
  /** Node is disabled ("zz") or has a disabled ancestor / is excluded by Solo. */
  | 'skipped'
  /** Bypassed: not evaluated, structure input is passed through. */
  | 'bypassed'
  /** evaluate() threw. */
  | 'error'
  /** An upstream node failed, so this one could not run. */
  | 'blocked';

export interface NodeMessage {
  level: 'warn' | 'error';
  text: string;
}

export interface NodeDiagnostic {
  nodeId: string;
  state: NodeState;
  /** Wall time of evaluate() (0 for cached / skipped). */
  ms: number;
  messages: NodeMessage[];
  /** Triangles of this node's own geometry. */
  triangles: number;
  /** Instance count reported by the node (branch count, leaf count ...), shown on edges. */
  instances: number;
  /** Skeleton branch count emitted by this node (if any). */
  branches?: number;
  /** Skeleton sample point count emitted by this node (if any). */
  points?: number;
}

/** Reserved, undeclared output keys a node may return from evaluate() next to its declared out-ports. */
export const OUTPUT_KEY = {
  /** `Mesh` PortValue: the node's own renderable geometry, collected by the output assembler. */
  geometry: 'geometry',
  /** `Scalar` PortValue: how many instances the node produced (edge label). */
  instances: 'instances',
  /** `Scalar` PortValue: skeleton branch count produced by structure generators. */
  branchCount: 'branchCount',
  /** `Scalar` PortValue: skeleton point count produced by structure generators. */
  pointCount: 'pointCount',
} as const;

/** Per-mesh (per-generator) wind multipliers resolved from node params and attached Wind nodes. */
export interface MeshWindOverride {
  /** Multiplier of the wind strength for this mesh. */
  amount: number;
  /** Multiplier of the leaf flutter rotation. */
  flutter: number;
  /** Multiplier of the flutter frequency. */
  flutterFrequency: number;
  /** Replaces the global stiffness when >= 0. */
  stiffness: number;
}

/** One renderable piece of the plant (one graph node's geometry). */
export interface SceneEntry {
  nodeId: string;
  /** NodeDef.type of the producing node. */
  type: string;
  statsGroup: string;
  mesh: MeshData;
  /** Revision token: changes whenever the mesh content may have changed (cache key of the producing node). */
  rev: string;
  /** Wind multipliers for this piece (absent = neutral). */
  wind?: MeshWindOverride;
}

export interface SceneSkeleton {
  nodeId: string;
  skeleton: Skeleton;
  rev: string;
  /** Per-instance table (generators that support Node mode). */
  instances?: InstanceTable;
  /** Cutout attachment frames of the instances. */
  attachments?: AttachmentSet;
}

export interface SceneStats {
  triangles: number;
  vertices: number;
  bones: number;
  groups: { label: string; triangles: number }[];
  /** Instances of each hierarchy node (root text "Nodes N"). */
  totalInstances: number;
  /** Total skeleton branches across all structure generators. */
  skeletonBranches?: number;
  /** Total skeleton sample points across all structure generators. */
  skeletonPoints?: number;
}

/** Combined result of one evaluation pass: what the viewport shows. */
export interface SceneModel {
  entries: SceneEntry[];
  skeletons: SceneSkeleton[];
  stats: SceneStats;
  /** Wind node attached to the Tree output: overrides the project wind settings. */
  wind?: WindSettings | null;
}

export interface EvaluationSummary {
  /** Monotonic id of the run (generation token). */
  run: number;
  lod: number;
  /** True when this is the quick low-detail pass and a refinement will follow. */
  preview: boolean;
  totalMs: number;
  evaluated: number;
  cached: number;
  skipped: number;
  errors: number;
  diagnostics: Map<string, NodeDiagnostic>;
  /** Edge id -> instance label, e.g. "2,188". */
  edgeLabels: Map<string, string>;
  scene: SceneModel;
}
