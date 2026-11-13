import type { NodeDef } from '@/contracts/nodes';
import { emptyMeshData } from '@/contracts/mesh';
import { PORT } from '@/graph/ports';
import { section } from '../shared/builders';
import { attachOut } from '../shared/ports';

import type { TessellationMode } from '@/contracts/material';
import { getBool, getNumber, getString } from '@/contracts/params';
import { loadMeshAsset } from '@/geometry/meshAssets';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import { applyTessellationSettings, createReferenceClusterCutout } from '@/materials/cutouts/ops';
import { getMaterialSource } from '@/materials/materialSource';

/** Mesh sources. Option names follow the Edit Mesh dialog's "Mesh options". */
const src = section('Mesh', 'Source');
const opt = section('Mesh', 'Mesh options');

const evaluateAssetMesh: NodeDef['evaluate'] = (ctx, _inputs, p) => {
  const assetId = (p.asset?.value as string | null | undefined) ?? null;
  const scale = getNumber(p, 'scale', 1);
  const cutouts = getMaterialSource()?.cutoutMeshes?.() ?? [];
  const hitCutout = assetId ? cutouts.find((c) => c.id === assetId || c.name === assetId) : cutouts[0];
  if (hitCutout) {
    const mesh = buildCutoutGeometry({ ...hitCutout, scale: hitCutout.scale * scale }, ctx.lod);
    return { [PORT.out]: { kind: 'Mesh', value: mesh } };
  }
  const loaded = loadMeshAsset(assetId, 'leaf');
  if (loaded) {
    if (Math.abs(scale - 1) > 1e-5) {
      const positions = new Float32Array(loaded.positions.length);
      for (let i = 0; i < positions.length; i++) positions[i] = (loaded.positions[i] as number) * scale;
      return { [PORT.out]: { kind: 'Mesh', value: { ...loaded, positions } } };
    }
    return { [PORT.out]: { kind: 'Mesh', value: loaded } };
  }
  return { [PORT.out]: { kind: 'Mesh', value: emptyMeshData() } };
};

const evaluateCutoutNode: NodeDef['evaluate'] = (ctx, _inputs, p) => {
  const matRef = getString(p, 'material', '') || 'leaf';
  const cutouts = getMaterialSource()?.cutoutMeshes?.() ?? [];
  const existing =
    cutouts.find((c) => c.materialId === matRef || c.id === matRef || c.name === matRef) ??
    createReferenceClusterCutout(`node_${ctx.nodeId}`, ctx.name || 'Cutout', matRef);
  const clone = structuredClone(existing);
  clone.settings.angle = getNumber(p, 'angle', clone.settings.angle);
  clone.settings.tessellation = getString(p, 'tessellation', clone.settings.tessellation) as TessellationMode;
  clone.settings.tessAmount = getNumber(p, 'tessAmount', clone.settings.tessAmount);
  clone.settings.refineEdges = getNumber(p, 'refineEdges', clone.settings.refineEdges);
  clone.settings.snapThreshold = getNumber(p, 'snapThreshold', clone.settings.snapThreshold);
  clone.settings.doubleSided = getBool(p, 'doubleSided', clone.settings.doubleSided);
  applyTessellationSettings(clone);
  const mesh = buildCutoutGeometry(clone, ctx.lod, { materialId: matRef });
  return { [PORT.out]: { kind: 'Mesh', value: mesh } };
};

export const nodeDefs: NodeDef[] = [
  {
    type: 'mesh.asset',
    category: 'mesh',
    label: 'Mesh',
    icon: 'nodeMesh',
    color: 'var(--kt-node-mesh)',
    description: 'Imported or drawn mesh.',
    ports: [attachOut('Mesh')],
    params: [{ kind: 'asset', id: 'asset', label: 'Asset', group: 'Mesh', subgroup: 'Source', assetKind: 'mesh', default: null }, src.float('scale', 'Scale', 1, { min: 0.001, max: 1000, softMax: 10 }), src.bool('doubleSided', 'Double-sided', false)],
    evaluate: evaluateAssetMesh,
  },
  {
    type: 'mesh.cutout',
    category: 'mesh',
    label: 'Cutout Mesh',
    icon: 'nodeMesh',
    color: 'var(--kt-node-mesh)',
    description: 'Mesh fitted around the opaque area of a material (Edit Mesh).',
    ports: [attachOut('Mesh')],
    params: [
      src.string('material', 'Material', ''),
      opt.float('angle', 'Angle', 0, { min: -180, max: 180, unit: '°' }),
      opt.enumOf('tessellation', 'Tessellation', 'Triangular', ['Triangular', 'Quad', 'Convex Hull', 'None']),
      opt.float('tessAmount', 'Tess. amount', 0, { min: 0, max: 1 }),
      opt.float('refineEdges', 'Refine edges', 0, { min: 0, max: 1 }),
      opt.float('snapThreshold', 'Snap threshold', 0, { min: 0, max: 1 }),
      opt.bool('doubleSided', 'Double-sided', false),
    ],
    evaluate: evaluateCutoutNode,
  },
];
