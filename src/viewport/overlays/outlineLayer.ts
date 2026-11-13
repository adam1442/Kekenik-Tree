import { BackSide, Color, InstancedMesh, Mesh, ShaderMaterial, Vector2, type Group, type Material } from 'three';
import type { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { createThickMaterial, createWireOverlay, wireGeometryFor } from '../thickLines';

export const OUTLINE_COLOR = 0xffe21a;
const OUTLINE_PIXELS = 2.2;

const VERTEX = /* glsl */ `
uniform vec2 uResolution;
uniform float uPixels;
void main() {
  vec4 p = vec4(position, 1.0);
  vec3 n = normal;
  #ifdef USE_INSTANCING
    p = instanceMatrix * p;
    n = mat3(instanceMatrix) * n;
  #endif
  vec4 clip = projectionMatrix * modelViewMatrix * p;
  vec4 clipN = projectionMatrix * vec4(normalMatrix * n, 0.0);
  vec2 dirPx = clipN.xy * uResolution;
  float len = length(dirPx);
  dirPx = len > 1e-6 ? dirPx / len : vec2(0.0);
  // Constant pixel width: the offset is expressed in NDC and multiplied by w.
  clip.xy += dirPx * (uPixels * 2.0) / uResolution * clip.w;
  gl_Position = clip;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

interface Entry {
  source: Mesh;
  object: Mesh | LineSegments2;
  kind: 'hull' | 'wire';
}

function hasCutout(m: Material | Material[]): boolean {
  return (Array.isArray(m) ? m : [m]).some((x) => x.alphaTest > 0 || x.alphaToCoverage);
}

/**
 * Yellow selection outline of whole generator nodes, independent of the View mode: an inverted hull (back faces pushed
 * outwards in clip space by a constant number of pixels, so the width does not depend on distance or DPI). Alpha-cutout
 * geometry (leaves) has no meaningful hull, so it gets an anti-aliased thick edge overlay instead. Everything lives in
 * the overlay group, never inside the plant content, so view modes cannot touch it.
 */
export class OutlineLayer {
  private readonly entries = new Map<string, Entry>();
  private readonly hullMaterial = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: { uResolution: { value: new Vector2(1, 1) }, uPixels: { value: OUTLINE_PIXELS }, uColor: { value: new Color(OUTLINE_COLOR) } },
    side: BackSide,
    depthWrite: false,
  });
  private readonly wireMaterial = createThickMaterial({ color: OUTLINE_COLOR, width: 1.6, opacity: 0.95, offset: true });

  constructor(private readonly group: Group) {}

  setResolution(w: number, h: number): void {
    (this.hullMaterial.uniforms.uResolution!.value as Vector2).set(Math.max(1, w), Math.max(1, h));
  }

  /** Outline exactly the nodes in `nodeIds` (rebuilding objects whose source geometry changed). */
  sync(nodeIds: ReadonlySet<string>, meshOf: (nodeId: string) => Mesh | undefined): void {
    for (const [id, e] of this.entries) {
      const src = nodeIds.has(id) ? meshOf(id) : undefined;
      if (src && src === e.source) {
        this.refresh(e);
        continue;
      }
      this.drop(id, e);
    }
    for (const id of nodeIds) {
      if (this.entries.has(id)) continue;
      const src = meshOf(id);
      if (!src) continue;
      const entry = this.create(src);
      this.group.add(entry.object);
      this.entries.set(id, entry);
    }
  }

  private create(src: Mesh): Entry {
    if (hasCutout(src.material)) {
      const wire = createWireOverlay(src.geometry, this.wireMaterial);
      wire.renderOrder = 995;
      return { source: src, object: wire, kind: 'wire' };
    }
    const hull = src instanceof InstancedMesh ? new InstancedMesh(src.geometry, this.hullMaterial, src.count) : new Mesh(src.geometry, this.hullMaterial);
    if (hull instanceof InstancedMesh && src instanceof InstancedMesh) hull.instanceMatrix = src.instanceMatrix;
    hull.frustumCulled = false;
    hull.renderOrder = 994;
    hull.castShadow = false;
    hull.receiveShadow = false;
    hull.userData.isOverlay = true;
    return { source: src, object: hull, kind: 'hull' };
  }

  /** Geometry may have been swapped or rewritten in place since the last sync. */
  private refresh(e: Entry): void {
    const src = e.source;
    if (e.kind === 'wire') {
      (e.object as LineSegments2).geometry = wireGeometryFor(src.geometry);
      return;
    }
    const hull = e.object as Mesh;
    if (hull.geometry !== src.geometry) hull.geometry = src.geometry;
    if (hull instanceof InstancedMesh && src instanceof InstancedMesh) {
      hull.instanceMatrix = src.instanceMatrix;
      hull.count = src.count;
    }
  }

  private drop(id: string, e: Entry): void {
    e.object.removeFromParent();
    this.entries.delete(id);
  }

  get count(): number {
    return this.entries.size;
  }

  dispose(): void {
    for (const [id, e] of [...this.entries]) this.drop(id, e);
    this.hullMaterial.dispose();
    this.wireMaterial.dispose();
  }
}
