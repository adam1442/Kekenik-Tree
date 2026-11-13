import { BufferGeometry, Float32BufferAttribute, InstancedMesh, Points, type BufferAttribute, type InterleavedBufferAttribute, type Mesh, type Object3D, type ShaderMaterial } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { createThickMaterial } from '../thickLines';
import { buildNormalSegments, buildPointPositions } from './debugBuffers';
import { getDebugView, onDebugViewChange } from './debugSettings';
import { createRoundPointMaterial, setPointSize } from './roundPoints';

type Attr = BufferAttribute | InterleavedBufferAttribute;

/** Read an attribute into a tight Float32Array (interleaved or normalised attributes included). */
function readAttribute(a: Attr, itemSize: number): Float32Array {
  const out = new Float32Array(a.count * itemSize);
  for (let i = 0; i < a.count; i++) {
    out[i * itemSize] = a.getX(i);
    if (itemSize > 1) out[i * itemSize + 1] = a.getY(i);
    if (itemSize > 2) out[i * itemSize + 2] = a.getZ(i);
  }
  return out;
}

/**
 * Debug children of surface meshes for the Normals and Points view modes. Overlays are children of the mesh they
 * describe (so they follow its transform), are never picked (no nodeId) and never cull away (their bounding volumes
 * are not trusted: they are rebuilt from the live vertex data on every `attach`).
 *
 * Instanced meshes (GPU-instanced leaves / decorations) are expanded on the CPU through their instance matrices, so
 * the lines / points are in the correct world-space position, rotation and scale of every instance.
 */
export class MeshDebugLayer {
  private readonly normalMaterial: LineMaterial = createThickMaterial({ color: 0x35d6ff, width: 1.25, opacity: 1 });
  private readonly pointMaterial: ShaderMaterial = createRoundPointMaterial({ size: getDebugView().pointSize, color: 0xffd23f });
  private readonly created: Object3D[] = [];
  private readonly geometries: BufferGeometry[] = [];
  private readonly unsub = onDebugViewChange((s) => setPointSize(this.pointMaterial, s.pointSize));

  /** Drop everything built by previous `attach` calls. */
  clear(): void {
    for (const o of this.created) o.removeFromParent();
    this.created.length = 0;
    for (const g of this.geometries) g.dispose();
    this.geometries.length = 0;
  }

  attachNormals(mesh: Mesh): number {
    const pos = mesh.geometry.getAttribute('position') as Attr | undefined;
    const nor = mesh.geometry.getAttribute('normal') as Attr | undefined;
    if (!pos || !nor) return 0;
    const im = mesh instanceof InstancedMesh ? mesh : null;
    const res = buildNormalSegments(readAttribute(pos, 3), readAttribute(nor, 3), getDebugView().normalLength, im ? { matrices: im.instanceMatrix.array, instanceCount: im.count } : {});
    if (res.segments === 0) return 0;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(res.positions);
    const lines = new LineSegments2(geo, this.normalMaterial);
    lines.frustumCulled = false;
    lines.renderOrder = 6;
    lines.userData.isDebug = true;
    mesh.add(lines);
    this.created.push(lines);
    this.geometries.push(geo);
    return res.segments;
  }

  attachPoints(mesh: Mesh): number {
    const pos = mesh.geometry.getAttribute('position') as Attr | undefined;
    if (!pos) return 0;
    const im = mesh instanceof InstancedMesh ? mesh : null;
    const res = buildPointPositions(readAttribute(pos, 3), im ? { matrices: im.instanceMatrix.array, instanceCount: im.count } : {});
    if (res.count === 0) return 0;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(res.positions, 3));
    const pts = new Points(geo, this.pointMaterial);
    pts.frustumCulled = false;
    pts.renderOrder = 6;
    pts.userData.isDebug = true;
    mesh.add(pts);
    this.created.push(pts);
    this.geometries.push(geo);
    return res.count;
  }

  dispose(): void {
    this.clear();
    this.unsub();
    this.normalMaterial.dispose();
    this.pointMaterial.dispose();
  }
}
