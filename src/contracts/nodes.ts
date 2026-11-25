import type { Logger } from '@/core/logger';
import type { Rng } from '@/core/rng';
import type { AttachmentFrame } from './attachment';
import type { NodeParams, ParamDef } from './params';
import type { PortDef, PortValue } from './ports';

/** Node definitions, registered via `registerNode()` in src/graph/registry.ts. */

export type NodeCategory = 'generator' | 'modifier' | 'force' | 'material' | 'mesh' | 'wind' | 'utility' | 'output';

export interface CancellationToken {
  readonly cancelled: boolean;
  throwIfCancelled(): void;
}

export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'CancelledError';
  }
}

export class CancellationSource {
  private flag = false;
  readonly token: CancellationToken;

  constructor() {
    const isCancelled = (): boolean => this.flag;
    this.token = {
      get cancelled(): boolean {
        return isCancelled();
      },
      throwIfCancelled(): void {
        if (isCancelled()) throw new CancelledError();
      },
    };
  }

  cancel(): void {
    this.flag = true;
  }
}

/** A named region of a Force node (Force containers: Include / Exclude). Positions are world space, metres. */
export interface ForceVolume {
  name: string;
  shape: 'sphere' | 'box';
  center: readonly [number, number, number];
  /** Sphere radius (m). */
  radius: number;
  /** Box edge lengths along X / Y / Z (m). */
  size: readonly [number, number, number];
}

export interface NodeContext {
  /** Graph node id / display name of the node being evaluated. */
  nodeId: string;
  name: string;
  /** Node-specific deterministic stream (already forked from the project seed by node id). */
  rng: Rng;
  seed: number;
  cancel: CancellationToken;
  /** 0 = highest detail. */
  lod: number;
  logger: Logger;
  /**
   * Attachment frames (cutout anchors) of the parent instance identified by its stable `InstanceKey`.
   * Provided by the engine; generators fall back to the parent input directly when it is absent.
   */
  getParentAttachments?(instanceKey: number): AttachmentFrame[];
  /** Volumes of the Force nodes in the graph (Force containers: Include / Exclude). Absent = none. */
  forceVolumes?: readonly ForceVolume[];
  /** Knockout forces attached to this generator (nodes growing in their arrow direction are removed). Absent = none. */
  knockoutForces?: readonly { direction: readonly [number, number, number]; sensitivity: number }[];
  /** Node type of the hierarchy parent (e.g. `generator.branch`); absent when the node has no parent. */
  parentType?: string;
  /** Open ends that sibling generators already extend (only given to Cap nodes, see `generators/split/endClaims`). Absent = none. */
  endClaims?: readonly EndClaim[];
}

/** Which kind of generator owns an extension. */
export type EndClaimOwner = 'branch' | 'cap';

/** An Extend parent selection of a sibling generator: the ends it selects are taken. */
export interface EndClaim {
  owner: EndClaimOwner;
  /** The sibling's Extend parent type (`any`, `split-1`, ... `bottom`). */
  type: string;
}

/** Inputs grouped by port id; ports with `multiple` receive several values. */
export type NodeInputs = Record<string, PortValue[]>;
export type NodeOutputs = Record<string, PortValue>;

export interface NodeDef {
  /** Unique registry key, e.g. "generator.trunk". */
  type: string;
  category: NodeCategory;
  label: string;
  /** Key in the icon registry (src/ui/icons). */
  icon: string;
  /** CSS colour (usually a token such as "var(--kt-node-branch)"). */
  color: string;
  description?: string;
  /** Schema version of `params`. Absent = 1. Bump it and provide `migrate` when ids/meaning of params change. */
  version?: number;
  /** Upgrade stored params from `fromVersion` to `version` (one call per stored file node; may mutate and return). */
  migrate?(params: NodeParams, fromVersion: number): NodeParams;
  /** Label of the polygon-statistics row this node's geometry is counted in (viewport overlay: "branches", "caps"...). */
  statsGroup?: string;
  /**
   * Extra cache-key text for nodes that read project data outside their params (e.g. the displacement library).
   * Evaluated on every pass; a changed string re-evaluates only this node and its descendants.
   */
  dependencyKey?(params: NodeParams): string;
  ports: PortDef[];
  params: ParamDef[];
  evaluate(ctx: NodeContext, inputs: NodeInputs, params: NodeParams): NodeOutputs | Promise<NodeOutputs>;
}
