import { BufferAttribute, BufferGeometry } from 'three';
import { windPhase1Array, type MeshData } from '@/contracts/mesh';

/** Convert engine-agnostic MeshData into a three.js BufferGeometry (caller disposes it). */
export function meshDataToGeometry(data: MeshData): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(data.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geo.setAttribute('uv', new BufferAttribute(data.uv0, 2));
  if (data.uv1) geo.setAttribute('uv1', new BufferAttribute(data.uv1, 2));
  if (data.tangents) geo.setAttribute('tangent', new BufferAttribute(data.tangents, 4));
  if (data.colors) geo.setAttribute('color', new BufferAttribute(data.colors, 4));
  if (data.ao) geo.setAttribute('ao', new BufferAttribute(data.ao, 1));
  if (data.branchTint) geo.setAttribute('branchTint', new BufferAttribute(data.branchTint, 1));
  if (data.wind) {
    geo.setAttribute('windPivot', new BufferAttribute(data.wind.pivot, 3));
    geo.setAttribute('windWeights', new BufferAttribute(data.wind.weights, 4));
    geo.setAttribute('windPhase1', new BufferAttribute(windPhase1Array(data.wind), 1));
  }
  if (data.weld) {
    geo.setAttribute('weldBlend', new BufferAttribute(data.weld.blend, 1));
    geo.setAttribute('weldParentUV', new BufferAttribute(data.weld.parentUv, 2));
    geo.setAttribute('weldStyle', new BufferAttribute(data.weld.style, 3));
  }
  geo.setIndex(new BufferAttribute(data.indices, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}
