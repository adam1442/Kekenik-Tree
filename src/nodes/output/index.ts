import type { NodeDef } from '@/contracts/nodes';
import { DEFAULT_KEEP_END, DEFAULT_LOD_LEVELS, DYNAMIC_LOD_MODES, defaultGrowCurve, defaultKeepCurve } from '@/lod/dynamic/config';
import { getBool, getNumber, type NodeParams } from '@/contracts/params';
import type { TreePlacement } from '@/contracts/ports';
import { emptySkeleton } from '@/contracts/skeleton';
import { PORT } from '@/graph/ports';
import { section } from '../shared/builders';
import { childrenOut, windIn } from '../shared/ports';
import { seasonFromTreeParams } from '@/seasons';
import { GLOBAL_PREFIX, readLeafLighting, treeLightingParams } from '../generators/leafLightingParams';

/** Tree node tabs are: Gen | Shape | LOD | Collision, plus Lighting (shared leaf lighting). */
const gen = section('Generation', 'More');
const season = section('Generation', 'Season');
const shape = section('Shape', 'Shape');
const collision = section('Collision', 'Leaf collision');
const dynLod = section('LOD', 'Dynamic LOD');
const dynCurves = section('LOD', 'Reduction curves');
const vcol = section('Vertex Color', 'Vertex colors');
const lightmap = section('Lightmap', 'Lightmap UV');

const COLLISION_LEVEL_OPTIONS = ['None', 'Low', 'Medium', 'High'];

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

const readTreeScale = (params: NodeParams): number => {
  const v = getNumber(params, 'scale', 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
};

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
      gen.float('scale', 'Size scalar', 1, { min: 0.01, max: 100, softMax: 5, tooltip: 'Scales every node of the plant (each generator multiplies its own Size scalar into this value).' }),
      gen.float('groundOffset', 'Ground offset', 0, { min: -10, max: 10, unit: 'm' }),
      season.float('season', 'Season', 0, { min: 0, max: 1, step: 0.01, tooltip: 'Season slider (also on the viewport toolbar). Every generator turns it into its own transition value; Material Set members are picked by weight x Season curve at that value. The model is regenerated on every change.' }),
      season.bool('showDroppedLeaves', 'Show dropped leaves', false, { tooltip: 'Leaves that finished their life (transition value reached Drop time) leave the branch and lie on the ground (z = 0), swept along the Season wind arrows.' }),
      season.bool('exportDroppedLeaves', 'Export dropped leaves', false, { tooltip: 'Include the dropped leaves on the ground in the export. Off = they are only a viewport aid.' }),
      shape.enumOf('shapeType', 'Type', 'Circle', ['Circle'], { tooltip: 'Placement area. Only the circle shape is available.' }),
      shape.float('radius', 'Radius', 10, { min: 0, max: 10000, softMax: 50, unit: 'm', tooltip: 'Radius of the placement disc (drag the white handle in the viewport).' }),
      shape.float('centerX', 'Center X', 0, { min: -10000, max: 10000, softMin: -50, softMax: 50, unit: 'm' }),
      shape.float('centerY', 'Center Y', 0, { min: -10000, max: 10000, softMin: -50, softMax: 50, unit: 'm' }),
      shape.float('treeSink', 'Sink', 0, { min: -50, max: 50, softMin: -2, softMax: 2, unit: 'm', tooltip: 'Depth every child is sunk into the ground.' }),
      shape.float('treeRoll', 'Roll', 0, { min: -360, max: 360, softMin: -180, softMax: 180, unit: '°', tooltip: 'Rotates the whole placement pattern around the vertical axis.' }),
      shape.bool('unifyChildOrientation', 'Unify child orientation', false, { tooltip: 'Give all children the same orientation instead of a random one.' }),
      collision.enumOf('leafCollision', 'Leaf collision removal', 'None', COLLISION_LEVEL_OPTIONS, {
        tooltip: 'Removes leaves that overlap other leaves or branches. None = off. Low = leaf against leaf only (spheres, fastest). Medium = all collisions with a rough (box / capsule) intersection. High = exact triangle intersection (slowest). Runs as a background pass: the plain tree shows first and the result pops in when it is done. At a coarser LOD the tests are one step cheaper.',
      }),
      collision.bool('leafCollisionSpherical', 'Use spherical tests on leaves', false, {
        tooltip: 'Test every leaf as a sphere (see the leaf generator Sphere threshold) instead of its box / triangles: faster and keeps more leaves.',
        visibleIf: { param: 'leafCollision', op: 'ne', value: 'none' },
      }),
      collision.enumOf('clusterPlaneOverlap', 'Cluster plane overlapping', 'None', COLLISION_LEVEL_OPTIONS, {
        tooltip: 'The same tests for Batched leaf (cluster) cards, but only in the top-down XY plane: removes cards that overlap when seen from above. None = off.',
      }),
      dynLod.bool('lodEnabled', 'Enable', false, { tooltip: 'Dynamic LOD: the model shrinks smoothly as the LOD value rises. Parts hidden in the interior are removed first; a part that will be removed shrinks until it is invisible (branches shrink to their spine, leaves to their attachment point) while the leaves that stay grow to keep the silhouette. Needs no re-generation: the viewport applies it live (toolbar LOD).' }),
      dynLod.enumOf('lodMode', 'Mode', 'Manual', DYNAMIC_LOD_MODES as string[], { tooltip: 'Manual: the LOD value below (or the toolbar slider) is used. Screen area: the value follows the camera distance and the bounding sphere of the tree.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      dynLod.float('lodValue', 'LOD value', 0, { min: 0, max: 1, step: 0.01, tooltip: 'Manual LOD value: 0 = full detail (the unmodified mesh), 1 = lowest detail.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      dynLod.int('lodLevels', 'Levels', DEFAULT_LOD_LEVELS, { min: 2, max: 8, tooltip: 'Number of discrete levels written on export. Level k uses the Dynamic LOD value k / (levels - 1); the billboard impostor stays the last level.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      dynCurves.curve('lodBranches', 'Branches', defaultKeepCurve(DEFAULT_KEEP_END.branches), { tooltip: 'Share of the branches kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none. Thin and interior branches go first; they shrink to their spine before they are removed.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      dynCurves.curve('lodLeaves', 'Leaves', defaultKeepCurve(DEFAULT_KEEP_END.leaves), { tooltip: 'Share of the leaves kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none. Interior leaves go first; they shrink away before they are removed.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      dynCurves.curve('lodFronds', 'Fronds', defaultKeepCurve(DEFAULT_KEEP_END.fronds), { tooltip: 'Share of the fronds / fins kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      dynCurves.curve('lodDecorations', 'Decorations', defaultKeepCurve(DEFAULT_KEEP_END.decorations), { tooltip: 'Share of the decorations / knots / meshes kept over the whole transition. X: LOD value, Y: 1 = all, 0 = none.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      dynCurves.curve('lodGrowScale', 'Grow scale', defaultGrowCurve(), { tooltip: 'How much of the leaf area lost by the removal the surviving leaves and fronds win back by growing (up to 3x). X: LOD value, Y: 0 = no growth, 1 = keep the covered area.', visibleIf: { param: 'lodEnabled', op: 'eq', value: true } }),
      vcol.bool('vertexColorCompute', 'Compute', true, { tooltip: 'Compute and keep vertex colours. Off: nothing is exported in COLOR_0 / colour columns and the Vertex Colors view is white. On (default) is the behaviour of earlier versions.' }),
      vcol.enumOf('vertexColorPacking', 'Packing', 'Legacy', ['Legacy', 'Kekenik'], { tooltip: 'What the vertex colour channels hold in the Vertex Colors view and in exports. Legacy: RGB = baked albedo tint x ambient occlusion (earlier behaviour). Kekenik: R = per-branch random tint, G = height along the plant (0 base .. 1 top), B = ambient occlusion (the baked one when the export bakes AO, otherwise the analytic one). Leaves and other meshes without a branch have R = 0.5.', visibleIf: { param: 'vertexColorCompute', op: 'eq', value: true } }),
      lightmap.bool('lightmapEnabled', 'Enabled', false, { tooltip: 'Write a packed lightmap UV set (UV1 / TEXCOORD_1) on export: every generator gets an island sized by its Lightmap weight and its material Unwrap scale, everything is fitted into the resolution below. Off = the per-branch UV1 of earlier versions.' }),
      lightmap.int('lightmapResolution', 'Resolution', 1024, { min: 4, max: 8192, tooltip: 'Target lightmap resolution in texels. The packer scales all islands uniformly to fit it and the export report states the texel density it reached. The "Lightmap density" view shows green where the density matches the target, blue where it is too low and red where it is too high.', visibleIf: { param: 'lightmapEnabled', op: 'eq', value: true } }),
      lightmap.enumOf('lightmapLayout', 'Layout', 'Atlas', ['Atlas', 'UDIM'], { tooltip: 'Atlas: all islands share one 0..1 texture. UDIM: every generator owns one tile (1001, 1002, ...), so no resolution is shared.', visibleIf: { param: 'lightmapEnabled', op: 'eq', value: true } }),
      ...treeLightingParams(),
    ],
    /** The root hands an empty structure plus the placement disc to its children; they decide where to start. */
    evaluate: (_ctx, _inputs, params) => {
      return { [PORT.children]: { kind: 'Structure', value: { skeleton: emptySkeleton(), placement: placementFromTreeParams(params), lighting: readLeafLighting(params, GLOBAL_PREFIX), season: seasonFromTreeParams(params), kind: 'output.tree', ...(Math.abs(readTreeScale(params) - 1) > 1e-9 ? { sizeScalar: readTreeScale(params) } : {}) } } };
    },
  },
];
