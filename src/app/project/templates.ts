import type { GraphEdgeJSON, GraphNodeJSON } from '@/contracts/project';
import { migrateNodeParams, nodeVersion } from '@/graph/registry';
import type { ClipboardPayload } from '@/graph/model/clipboard';
import { decodeJson, encodeJson } from './codec';

export const TEMPLATE_FORMAT = 'kekenik-tree-template';
export const TEMPLATE_VERSION = 1;

/** A reusable node sub-graph (a branch with its descendants and attachments). */
export interface NodeTemplate {
  format: typeof TEMPLATE_FORMAT;
  version: number;
  name: string;
  nodeVersions: Record<string, number>;
  nodes: GraphNodeJSON[];
  edges: GraphEdgeJSON[];
}

export function createTemplate(name: string, payload: ClipboardPayload): NodeTemplate {
  const nodeVersions: Record<string, number> = {};
  for (const n of payload.nodes) nodeVersions[n.type] = nodeVersion(n.type);
  return { format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, name, nodeVersions, nodes: structuredClone(payload.nodes), edges: structuredClone(payload.edges) };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Validate and upgrade a template; returns the payload ready for GraphSession.importSubgraph(). */
export function parseTemplate(raw: unknown): { name: string; payload: ClipboardPayload } {
  if (!isRecord(raw) || raw.format !== TEMPLATE_FORMAT) throw new Error('Not a Kekenik Tree node template');
  if (typeof raw.version !== 'number' || raw.version > TEMPLATE_VERSION) throw new Error('Unsupported node template version');
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error('Node template is malformed');
  const versions = isRecord(raw.nodeVersions) ? (raw.nodeVersions as Record<string, number>) : {};
  const nodes = (raw.nodes as GraphNodeJSON[])
    .filter((n) => isRecord(n) && typeof n.id === 'string' && typeof n.type === 'string' && isRecord(n.params))
    .map((n) => ({ ...n, params: migrateNodeParams(n.type, n.params, versions[n.type] ?? 1), position: isRecord(n.position) ? n.position : { x: 0, y: 0 } }));
  return { name: typeof raw.name === 'string' ? raw.name : 'Template', payload: { nodes, edges: raw.edges as GraphEdgeJSON[] } };
}

export const encodeTemplate = (t: NodeTemplate): Uint8Array => encodeJson(t, { compress: false });
export const decodeTemplate = (bytes: Uint8Array): { name: string; payload: ClipboardPayload } => parseTemplate(decodeJson(bytes));
