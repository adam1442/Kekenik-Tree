import type { NodeDef } from '@/contracts/nodes';
import { getBool, getNumber, type NodeParams } from '@/contracts/params';
import type { TreePlacement } from '@/contracts/ports';
import { emptySkeleton } from '@/contracts/skeleton';
import { PORT } from '@/graph/ports';
import { section } from '../shared/builders';
import { childrenOut, windIn } from '../shared/ports';

/** Tree node tabs are: Gen | Shape | LOD | Collision. */
const gen = section('Generation', 'More');
const season = section('Generation', 'Season');
const shape = section('Shape', 'Shape');

/** Placement disc of the Tree node (yellow circle in the viewport). */
export function placementFromTreeParams(params: NodeParams): TreePlacement {
  return {
    shape: 'circle',
    radius: Math.max(0, getNumber(params, 'radius', 10)),
    centerX: getNumber(params, 'centerX', 0),
    centerY: getNumber(params, 'centerY', 0),
    sink: getNumber(params, 'treeSink', 0),
    rollDeg: getNumber(params, 'treeRoll', 0),
    unify: getBool(params, 'unifyChildOrientation', false),
  };
}

export const nodeDefs: NodeDef[] = [
  {
    type: 'output.tree',
    category: 'output',
    label: 'Tree',
    icon: 'nodeTree',
    color: 'var(--kt-node-tree)',
    description: 'Root of the plant. Its Shape defines the ground disc in which first-generation nodes are placed.',
    ports: [childrenOut, windIn],
    params: [
      gen.float('scale', 'Size scalar', 1, { min: 0.01, max: 100, softMax: 5 }),
      gen.float('groundOffset', 'Ground offset', 0, { min: -10, max: 10, unit: 'm' }),
      season.float('season', 'Season', 0, { min: 0, max: 1 }),
      shape.enumOf('shapeType', 'Type', 'Circle', ['Circle'], { tooltip: 'Placement area. Only the circle shape is available.' }),
      shape.float('radius', 'Radius', 10, { min: 0, max: 10000, softMax: 50, unit: 'm', tooltip: 'Radius of the placement disc (drag the white handle in the viewport).' }),
      shape.float('centerX', 'Center X', 0, { min: -10000, max: 10000, softMin: -50, softMax: 50, unit: 'm' }),
      shape.float('centerY', 'Center Y', 0, { min: -10000, max: 10000, softMin: -50, softMax: 50, unit: 'm' }),
      shape.float('treeSink', 'Sink', 0, { min: -50, max: 50, softMin: -2, softMax: 2, unit: 'm', tooltip: 'Depth every child is sunk into the ground.' }),
      shape.float('treeRoll', 'Roll', 0, { min: -360, max: 360, softMin: -180, softMax: 180, unit: '°', tooltip: 'Rotates the whole placement pattern around the vertical axis.' }),
      shape.bool('unifyChildOrientation', 'Unify child orientation', false, { tooltip: 'Give all children the same orientation instead of a random one.' }),
    ],
    /** The root hands an empty structure plus the placement disc to its children; they decide where to start. */
    evaluate: (_ctx, _inputs, params) => {
      return { [PORT.children]: { kind: 'Structure', value: { skeleton: emptySkeleton(), placement: placementFromTreeParams(params) } } };
    },
  },
];
