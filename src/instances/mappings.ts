import type { TransformField } from './types';

/** Gizmo handles of Node mode. */
export type HandleId = 'position' | 'rotation' | 'angle' | 'roll' | 'length' | 'radius' | 'bend';

/** What a handle edits: a placement-transform field or a ParamDef (offset mode). */
export type HandleTarget =
  | { kind: 'transform'; field: TransformField }
  /** `perUnit`: parameter change per (drag distance / branch length) for linear handles; angles map 1:1 in degrees. */
  | { kind: 'param'; id: string; perUnit?: number };

export interface MappingContext {
  /** The instance grows straight from the Tree disc (no parent spine). */
  rootLevel: boolean;
}

export type HandleMapping = HandleTarget | null | ((ctx: MappingContext) => HandleTarget | null);

/** Per node type: which concrete parameter / transform every gizmo handle edits. `null` hides the handle. */
export type NodeModeMapping = Partial<Record<HandleId, HandleMapping>>;

const registry = new Map<string, NodeModeMapping>();

export function registerNodeModeMapping(nodeType: string, mapping: NodeModeMapping): void {
  registry.set(nodeType, { ...(registry.get(nodeType) ?? {}), ...mapping });
}

export function resolveHandle(nodeType: string, handle: HandleId, ctx: MappingContext): HandleTarget | null {
  const m = registry.get(nodeType)?.[handle];
  if (m === undefined || m === null) return null;
  return typeof m === 'function' ? m(ctx) : m;
}

const spineLike: NodeModeMapping = {
  position: (c) => (c.rootLevel ? null : { kind: 'transform', field: 'positionAlongParent' }),
  rotation: { kind: 'transform', field: 'rotation' },
  angle: { kind: 'param', id: 'spread' },
  roll: { kind: 'transform', field: 'roll' },
  length: { kind: 'transform', field: 'lengthScale' },
  radius: { kind: 'transform', field: 'radiusScale' },
  bend: { kind: 'param', id: 'gravity', perUnit: -2 },
};

registerNodeModeMapping('generator.branch', spineLike);
registerNodeModeMapping('generator.spine', spineLike);
registerNodeModeMapping('generator.trunk', {
  ...spineLike,
  // A Trunk growing from the Tree disc is tilted by Lean, a Trunk on a parent by Spread.
  angle: (c) => ({ kind: 'param', id: c.rootLevel ? 'lean' : 'spread' }),
  bend: { kind: 'param', id: 'curvature', perUnit: 0.6 },
});
