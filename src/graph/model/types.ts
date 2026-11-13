import type { NodeDef } from '@/contracts/nodes';
import type { NodeParams, ParamState } from '@/contracts/params';
import type { GraphAnnotationJSON, GraphEdgeJSON } from '@/contracts/project';

/** In-memory graph node (the serialisable shape plus fully-defaulted editor flags). */
export interface GraphNode {
  id: string;
  /** NodeDef.type */
  type: string;
  name: string;
  x: number;
  y: number;
  enabled: boolean;
  bypass: boolean;
  solo: boolean;
  collapsed: boolean;
  locked: boolean;
  note: string;
  params: NodeParams;
}

export type GraphEdge = GraphEdgeJSON;
export type GraphAnnotation = GraphAnnotationJSON;

export interface PortRef {
  nodeId: string;
  portId: string;
}

/** Editable node fields (everything but identity, type and params). */
export type NodePatch = Partial<Pick<GraphNode, 'name' | 'x' | 'y' | 'enabled' | 'bypass' | 'solo' | 'collapsed' | 'locked' | 'note'>>;
export type NodePatchKey = keyof NodePatch;

export type AnnotationPatch = Partial<Pick<GraphAnnotation, 'text' | 'x' | 'y' | 'w' | 'h' | 'color'>>;

export interface ConnectCheck {
  ok: boolean;
  /** Human readable reason when `ok` is false. */
  reason?: string;
  /** Existing edges that must be removed first (single-connection ports are replaced, like re-parenting). */
  replaced: GraphEdge[];
}

export interface GraphEvents {
  nodeAdded: GraphNode;
  nodeRemoved: GraphNode;
  nodeChanged: { node: GraphNode; keys: NodePatchKey[] };
  edgeAdded: GraphEdge;
  edgeRemoved: GraphEdge;
  paramChanged: { nodeId: string; paramId: string; state: ParamState; prev: ParamState | undefined };
  annotationAdded: GraphAnnotation;
  annotationRemoved: GraphAnnotation;
  annotationChanged: { annotation: GraphAnnotation; keys: (keyof AnnotationPatch)[] };
  /** The whole graph was replaced (fromJSON / load). */
  reset: undefined;
  /** Fires after ANY change (coarse, for dirty tracking and engine invalidation). */
  changed: undefined;
}

export type NodeDefLookup = (type: string) => NodeDef | undefined;
