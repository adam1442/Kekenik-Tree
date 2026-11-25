import { evaluateCurve } from '@/contracts/curve';
import type { CollisionAction, CollisionParentRule, CollisionTestAgainst } from '@/contracts/mesh';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import { clamp } from '@/core/math';
import { asCollisionLevel, type CollisionLevel, type CollisionSettings } from './types';

/** Tree > Collision: the pass settings. All defaults mean "off" (old behaviour). */
export function readTreeCollision(params: NodeParams): { leaf: CollisionLevel; spherical: boolean; cluster: CollisionLevel } {
  return {
    leaf: asCollisionLevel(getString(params, 'leafCollision', 'none')),
    spherical: getBool(params, 'leafCollisionSpherical', false),
    cluster: asCollisionLevel(getString(params, 'clusterPlaneOverlap', 'none')),
  };
}

/** Cheaper tests at a coarser LOD: one quality step down per LOD level (High -> Medium -> Low). */
export function levelForLod(level: CollisionLevel, lod: number): CollisionLevel {
  if (level === 'none' || lod <= 0) return level;
  const order: CollisionLevel[] = ['low', 'medium', 'high'];
  return order[Math.max(0, order.indexOf(level) - Math.min(2, lod))] ?? 'low';
}

/** Settings of the pass for the whole tree (leaf-leaf / leaf-branch part). */
export function leafPassSettings(params: NodeParams, lod: number): CollisionSettings {
  const t = readTreeCollision(params);
  return { level: levelForLod(t.leaf, lod), spherical: t.spherical, plane: false };
}

/** Settings of the cluster (top-down XY plane) pass. */
export function clusterPassSettings(params: NodeParams, lod: number): CollisionSettings {
  const t = readTreeCollision(params);
  return { level: levelForLod(t.cluster, lod), spherical: t.spherical, plane: true };
}

export interface LeafCollisionConfig {
  threshold: number;
  action: CollisionAction;
  testAgainst: CollisionTestAgainst;
  parentRule: CollisionParentRule;
}

const ACTIONS: readonly string[] = ['remove', 'shrink', 'move'];
const TESTS: Record<string, CollisionTestAgainst> = { all: 'all', 'same-generator': 'same', 'other-generators': 'other' };

/** Per generator Post > Collision properties (defaults: Remove / All / Keep parent / sphere x 1). */
export function readLeafCollision(p: NodeParams): LeafCollisionConfig {
  const action = getString(p, 'collisionAction', 'remove');
  const test = getString(p, 'collisionTestAgainst', 'all');
  const parent = getString(p, 'collisionParent', 'keep-parent');
  return {
    threshold: clamp(getNumber(p, 'collisionSphereThreshold', 1), 0.1, 2),
    action: (ACTIONS.includes(action) ? action : 'remove') as CollisionAction,
    testAgainst: TESTS[test] ?? 'all',
    parentRule: parent === 'remove-parent' ? 'remove' : 'keep',
  };
}

/** Priority of a leaf at position `u` along its parent (curve-capable weight). */
export function leafPriority(p: NodeParams, u: number): number {
  const curve = p.collisionPriority?.curve;
  return getNumber(p, 'collisionPriority', 1) * (curve ? evaluateCurve(curve, u) : 1);
}
