import { InterleavedBufferAttribute, WireframeGeometry, Vector2, type BufferAttribute, type BufferGeometry, type InstancedInterleavedBuffer, type Material } from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';

/**
 * Screen-space thick lines (shader quads, `LineMaterial`) replace 1 px GL lines for wireframes, skeleton debug,
 * selection outlines and gizmos: constant CSS-pixel thickness at any distance, MSAA / post-AA friendly.
 * All materials created here are registered so the viewport can keep their `resolution` in sync.
 */
const materials = new Set<LineMaterial>();
const resolution = new Vector2(1, 1);

export interface ThickLineOptions {
  color: number;
  /** Width in CSS pixels. */
  width: number;
  opacity?: number;
  depthTest?: boolean;
  vertexColors?: boolean;
  /** Pull the lines towards the camera (outlines drawn on top of their own surface). */
  offset?: boolean;
}

export function createThickMaterial(o: ThickLineOptions): LineMaterial {
  const opacity = o.opacity ?? 1;
  const m = new LineMaterial({
    color: o.color,
    linewidth: o.width,
    worldUnits: false,
    vertexColors: o.vertexColors === true,
    transparent: opacity < 1,
    opacity,
    depthTest: o.depthTest !== false,
    // Lines are decals: they never write depth, so they cannot hide geometry that is drawn after them.
    depthWrite: false,
    polygonOffset: o.offset === true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  m.resolution.copy(resolution);
  materials.add(m);
  m.addEventListener('dispose', () => materials.delete(m));
  return m;
}

/** CSS-pixel size of the viewport (LineMaterial measures widths against it). */
export function setThickLineResolution(width: number, height: number): void {
  resolution.set(Math.max(1, width), Math.max(1, height));
  materials.forEach((m) => m.resolution.copy(resolution));
}

interface WireEntry {
  geometry: LineSegmentsGeometry;
  version: number;
  positions: number;
  indices: number;
}

const versionOf = (a: BufferAttribute | InterleavedBufferAttribute): number => (a instanceof InterleavedBufferAttribute ? a.data.version : a.version);

const wireCache = new WeakMap<BufferGeometry, WireEntry>();

/**
 * De-duplicated edge list of a mesh as `LineSegmentsGeometry`, cached per source geometry and rebuilt when the vertex
 * data changed (in-place buffer updates bump `position.version`). Owned by the cache: do not dispose it yourself.
 */
export function wireGeometryFor(source: BufferGeometry): LineSegmentsGeometry {
  const pos = source.getAttribute('position');
  const hit = wireCache.get(source);
  const indices = source.index?.count ?? 0;
  if (hit && hit.version === versionOf(pos) && hit.positions === pos.count && hit.indices === indices) return hit.geometry;
  if (hit) hit.geometry.dispose();
  const edges = new WireframeGeometry(source);
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(edges.getAttribute('position').array as Float32Array);
  edges.dispose();
  if (!hit) {
    source.addEventListener('dispose', () => {
      wireCache.get(source)?.geometry.dispose();
      wireCache.delete(source);
    });
  }
  wireCache.set(source, { geometry, version: versionOf(pos), positions: pos.count, indices });
  return geometry;
}

/** Anti-aliased wire overlay of a mesh (shares the cached edge geometry). */
export function createWireOverlay(source: BufferGeometry, material: Material): LineSegments2 {
  const lines = new LineSegments2(wireGeometryFor(source), material as LineMaterial);
  lines.frustumCulled = false;
  lines.userData.isOverlay = true;
  return lines;
}

/** Convert a `LineSegments` geometry (position + optional colour attribute) into thick-line geometry. */
export function thickGeometryFromSegments(source: BufferGeometry): LineSegmentsGeometry {
  const geometry = new LineSegmentsGeometry();
  const pos = source.getAttribute('position');
  geometry.setPositions(Array.from(pos.array));
  const col = source.getAttribute('color');
  if (col) geometry.setColors(Array.from(col.array));
  return geometry;
}

/** One thick segment whose end points can be moved cheaply (gizmo shafts, force arrows). */
export class ThickSegment {
  readonly lines: LineSegments2;
  private readonly buffer: InstancedInterleavedBuffer;

  constructor(material: LineMaterial) {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(new Float32Array(6));
    this.buffer = (geometry.getAttribute('instanceStart') as InterleavedBufferAttribute).data as InstancedInterleavedBuffer;
    this.lines = new LineSegments2(geometry, material);
    this.lines.frustumCulled = false;
  }

  set(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    (this.buffer.array as Float32Array).set([ax, ay, az, bx, by, bz]);
    this.buffer.needsUpdate = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
  }
}
