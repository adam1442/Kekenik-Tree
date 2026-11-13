import type { MeshData } from '@/contracts/mesh';
import { WIND_PARAM_RANGES, type WindParams } from './windParams';
import { WIND_GLSL_APPLY, WIND_GLSL_DECLARATIONS, WIND_GLSL_FUNCTION } from './windShader';

/**
 * Exact per-vertex wind data layout. Written by `geometry/windAttributes.ts` and
 * the mesh builders, uploaded as the geometry attributes below.
 */
export const WIND_VERTEX_LAYOUT = {
  version: 1,
  attributes: [
    {
      meshField: 'wind.pivot',
      threeAttribute: 'windPivot',
      itemSize: 3,
      type: 'float32',
      semantic: 'Rotation pivot of the vertex in mesh-local space (leaf base / attachment point).',
      range: null,
    },
    {
      meshField: 'wind.weights',
      threeAttribute: 'windWeights',
      itemSize: 4,
      type: 'float32',
      semantic: '(trunk weight, branch weight, leaf weight, phase)',
      range: [0, 1],
      components: ['trunk', 'branch', 'leaf', 'phase'],
    },
  ],
  /** Suggested packed encodings for game engines. */
  packed: { pivot: 'float16x3 or object-space offset from the vertex', weights: 'unorm8x4 (RGBA vertex colour / second UV set)' },
} as const;

export interface WindRuntimeUniform {
  name: string;
  type: 'vec4';
  scope: 'global' | 'mesh';
  components: string[];
  value: [number, number, number, number];
}

export interface WindRuntimeDescription {
  version: 1;
  coordinateSystem: 'Z-up, metres, direction = degrees around +Z towards which the wind blows';
  parameters: WindParams;
  parameterRanges: typeof WIND_PARAM_RANGES;
  uniforms: WindRuntimeUniform[];
  vertexLayout: typeof WIND_VERTEX_LAYOUT;
  /** Reference GLSL (three.js `begin_vertex` hook) implementing the model. */
  glsl: { declarations: string; functions: string; apply: string };
}

/** Everything a runtime needs to reproduce the preview: parameters, uniform packing, vertex layout and reference shader. */
export function describeWindRuntime(params: WindParams, treeHeight: number): WindRuntimeDescription {
  const rad = (params.directionDeg * Math.PI) / 180;
  return {
    version: 1,
    coordinateSystem: 'Z-up, metres, direction = degrees around +Z towards which the wind blows',
    parameters: params,
    parameterRanges: WIND_PARAM_RANGES,
    uniforms: [
      { name: 'uWindA', type: 'vec4', scope: 'global', components: ['dirX', 'dirY', 'strength', 'gustStrength'], value: [Math.cos(rad), Math.sin(rad), params.enabled ? params.strength : 0, params.gustStrength] },
      { name: 'uWindB', type: 'vec4', scope: 'global', components: ['gustFrequency', 'turbulence', 'ripple', 'quality'], value: [params.gustFrequency, params.turbulence, params.ripple, 1] },
      { name: 'uWindC', type: 'vec4', scope: 'global', components: ['trunkResponse', 'branchResponse', 'leafResponse', 'stiffness'], value: [params.trunkResponse, params.branchResponse, params.leafResponse, params.stiffness] },
      { name: 'uWindD', type: 'vec4', scope: 'global', components: ['damping', 'clock', 'treeHeight', 'baseHold'], value: [params.damping, 0, treeHeight, params.baseHold] },
      { name: 'uWindMesh', type: 'vec4', scope: 'mesh', components: ['amount', 'flutter', 'stiffnessOverride(-1 none)', 'flutterFrequency'], value: [1, 1, -1, 1] },
    ],
    vertexLayout: WIND_VERTEX_LAYOUT,
    glsl: { declarations: WIND_GLSL_DECLARATIONS, functions: WIND_GLSL_FUNCTION, apply: WIND_GLSL_APPLY },
  };
}

export interface WindAttributeReport {
  ok: boolean;
  issues: string[];
}

/** Validate the per-vertex wind data of a mesh (lengths, finite values, weights and phase in 0..1). */
export function validateWindAttributes(mesh: MeshData): WindAttributeReport {
  const issues: string[] = [];
  const w = mesh.wind;
  if (!w) return { ok: true, issues };
  const n = mesh.positions.length / 3;
  if (w.pivot.length !== n * 3) issues.push(`pivot length ${w.pivot.length} != ${n * 3}`);
  if (w.weights.length !== n * 4) issues.push(`weights length ${w.weights.length} != ${n * 4}`);
  for (let i = 0; i < w.pivot.length; i++) {
    if (!Number.isFinite(w.pivot[i] as number)) {
      issues.push(`pivot[${i}] not finite`);
      break;
    }
  }
  for (let i = 0; i < w.weights.length; i++) {
    const v = w.weights[i] as number;
    if (!Number.isFinite(v) || v < -1e-4 || v > 1 + 1e-4) {
      issues.push(`weights[${i}]=${v} outside 0..1`);
      break;
    }
  }
  return { ok: issues.length === 0, issues };
}
