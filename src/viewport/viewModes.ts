import {
  CanvasTexture,
  DoubleSide,
  RepeatWrapping,
  ShaderMaterial,
  SRGBColorSpace,
  Material,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshNormalMaterial,
  MeshStandardMaterial,
  type Object3D,
} from 'three';
import { MeshDebugLayer } from './debug/meshDebugLayer';
import { createThickMaterial, createWireOverlay } from './thickLines';
import type { VcPacking } from '@/geometry/vertexColor';
import type { ViewMode, ViewportContent } from './types';

/**
 * A renderable plant surface: a three.js Mesh that is not a thick line (`LineSegments2` extends `Mesh`!), not a wire /
 * debug overlay and not part of the skeleton debug group. Only these get their material swapped or are hidden by a view
 * mode - the skeleton lines used to be hidden by the very mode that was meant to show them.
 */
export function isSurfaceMesh(obj: Object3D): obj is Mesh {
  if (!(obj instanceof Mesh)) return false;
  if ((obj as { isLineSegments2?: boolean }).isLineSegments2 === true) return false;
  return obj.userData.isOverlay !== true && obj.userData.isDebug !== true;
}

/** Modes that draw the skeleton group. */
export const SKELETON_MODES: readonly ViewMode[] = ['skeleton', 'points'];

/**
 * Applies a ViewMode to viewport content by swapping materials. Original materials are remembered in
 * `mesh.userData.baseMaterial` and never mutated, so switching back is lossless.
 */
export class ViewModeController {
  private readonly wire = new MeshBasicMaterial({ color: 0x1a1a1a, wireframe: true });
  /** Anti-aliased, constant-width wire (screen-space thick lines) for ordinary meshes; GL lines remain for instanced ones. */
  private readonly thickWire = createThickMaterial({ color: 0x1a1a1a, width: 1 });
  private readonly thickOverlay = createThickMaterial({ color: 0x101010, width: 1, opacity: 0.45, offset: true });
  private readonly hidden = new MeshBasicMaterial({ visible: false });
  private readonly overlayWire = new MeshBasicMaterial({
    color: 0x101010,
    wireframe: true,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  private readonly normals = new MeshNormalMaterial({ side: DoubleSide });
  private readonly flat = new Map<Material, MeshBasicMaterial>();
  private uvMaterial: MeshBasicMaterial | null = null;
  private uvTexture: CanvasTexture | null = null;
  private readonly aoMaterial = new ShaderMaterial({
    side: DoubleSide,
    vertexShader: `attribute float ao; varying float vAo;
      void main() { vAo = ao; vec4 p = vec4(position, 1.0);
      #ifdef USE_INSTANCING
        p = instanceMatrix * p;
      #endif
        gl_Position = projectionMatrix * modelViewMatrix * p; }`,
    fragmentShader: 'varying float vAo; void main() { gl_FragColor = vec4(vec3(vAo), 1.0); }',
  });
  /** Wind weights (trunk / branch / leaf level) as RGB: a seam is a colour step between two touching pieces. Created on first use. */
  private windWeightsMaterial: ShaderMaterial | null = null;
  private lightmapMaterial: ShaderMaterial | null = null;
  private readonly lightmapUniforms = { uRes: { value: 1024 }, uTarget: { value: 1 } };
  private readonly faintWire = new MeshBasicMaterial({ color: 0x8a8f99, wireframe: true, transparent: true, opacity: 0.35, depthWrite: false });
  private readonly faintThick = createThickMaterial({ color: 0x8a8f99, width: 1, opacity: 0.4 });
  private readonly vertexColorMats = new Map<Material, MeshBasicMaterial>();
  /** Shared by every channel material: packing (0 legacy, 1 Kekenik) and the plant's z range (height channel). */
  private readonly vcUniforms = { uPacking: { value: 0 }, uZMin: { value: 0 }, uZMax: { value: 1 } };
  private readonly vcChannelMats = new Map<string, MeshBasicMaterial>();
  private readonly alphaMats = new Map<Material, MeshBasicMaterial>();
  private readonly debug = new MeshDebugLayer();
  private overlays: Object3D[] = [];
  /** Counts of the last debug pass (HUD / tests). */
  lastDebug = { normalSegments: 0, points: 0 };

  /** Tree > Vertex Color packing the channel views decode; re-apply the view mode afterwards. */
  setVertexColorPacking(packing: VcPacking): void {
    this.vcUniforms.uPacking.value = packing === 'kekenik' ? 1 : 0;
  }

  apply(content: ViewportContent, mode: ViewMode): void {
    const bounds = content.bounds as ViewportContent['bounds'] | undefined;
    if (bounds) {
      this.vcUniforms.uZMin.value = bounds.min.z;
      this.vcUniforms.uZMax.value = bounds.max.z;
    }
    this.clearOverlays();
    this.debug.clear();
    this.lastDebug = { normalSegments: 0, points: 0 };
    // Skeleton pieces exist for nodes that grow branches; every other node (leaves, fronds, caps, decorations, placed
    // meshes) has no centre line, so Skeleton mode shows it as a faint wire instead of making it vanish.
    const withSkeleton = new Set<string>();
    content.skeleton?.children.forEach((c) => {
      if (typeof c.userData.nodeId === 'string') withSkeleton.add(c.userData.nodeId);
    });
    content.root.traverse((obj: Object3D) => {
      if (!isSurfaceMesh(obj)) return;
      const base = (obj.userData.baseMaterial as Material | undefined) ?? (obj.material as Material);
      obj.userData.baseMaterial = base;
      const nodeId = obj.userData.nodeId as string | undefined;
      const front = obj.userData.isBackFace !== true;
      obj.visible = obj.userData.ktHidden !== true;
      switch (mode) {
        case 'skeleton':
          if (nodeId !== undefined && withSkeleton.has(nodeId)) {
            obj.visible = false;
          } else if (front) {
            obj.material = this.hidden;
            if (obj instanceof InstancedMesh) obj.material = this.faintWire;
            else this.addOverlay(obj, this.faintThick);
          } else obj.visible = false;
          break;
        case 'points':
          obj.material = this.hidden;
          if (front) this.lastDebug.points += this.debug.attachPoints(obj);
          break;
        case 'normals':
          obj.material = base;
          if (front) this.lastDebug.normalSegments += this.debug.attachNormals(obj);
          break;
        case 'vertexColor':
          obj.material = this.vcUniforms.uPacking.value > 0.5 ? this.vcChannelFor(-1, obj, base) : this.vertexColorFor(base);
          break;
        case 'vertexColorR':
          obj.material = this.vcChannelFor(0, obj, base);
          break;
        case 'vertexColorG':
          obj.material = this.vcChannelFor(1, obj, base);
          break;
        case 'vertexColorB':
          obj.material = this.vcChannelFor(2, obj, base);
          break;
        case 'alpha':
          obj.material = this.alphaFor(base);
          break;
        case 'wireframe':
          if (obj instanceof InstancedMesh) {
            obj.material = this.wire;
          } else {
            obj.material = this.hidden;
            if (front) this.addOverlay(obj, this.thickWire);
          }
          break;
        case 'flat':
          obj.material = this.flatFor(base);
          break;
        case 'normalColors':
          obj.material = this.normals;
          break;
        case 'uv':
          obj.material = this.uvMaterialFor();
          break;
        case 'ao':
          obj.material = this.aoMaterial;
          break;
        case 'windWeights':
          obj.material = this.windWeightsFor();
          break;
        case 'lightmapDensity':
          obj.material = this.lightmapDensityFor(content);
          break;
        case 'shadedWire':
          obj.material = base;
          if (front && !(obj instanceof InstancedMesh)) this.addOverlay(obj, this.thickOverlay);
          break;
        default:
          obj.material = base;
      }
    });
    if (content.skeleton) content.skeleton.visible = SKELETON_MODES.includes(mode);
  }

  private addOverlay(mesh: Mesh, material: Material): void {
    const overlay = createWireOverlay(mesh.geometry, material);
    mesh.add(overlay);
    this.overlays.push(overlay);
  }

  /** Checker texture on the first UV set: seams, stretching and tiling are visible at a glance. */
  private uvMaterialFor(): MeshBasicMaterial {
    if (this.uvMaterial) return this.uvMaterial;
    let map: CanvasTexture | null = null;
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      if (g) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            g.fillStyle = (x + y) % 2 === 0 ? `hsl(${(x * 45) % 360},45%,72%)` : `hsl(${(y * 45) % 360},35%,32%)`;
            g.fillRect(x * 16, y * 16, 16, 16);
          }
        }
        map = new CanvasTexture(c);
        map.wrapS = map.wrapT = RepeatWrapping;
        map.colorSpace = SRGBColorSpace;
        this.uvTexture = map;
      }
    }
    this.uvMaterial = new MeshBasicMaterial({ map, side: DoubleSide });
    return this.uvMaterial;
  }

  /** Tree > Lightmap resolution the density view compares against (texels along one edge of the lightmap). */
  setLightmapResolution(resolution: number): void {
    this.lightmapUniforms.uRes.value = Math.max(4, resolution);
  }

  /**
   * Texel density of UV1 per fragment (texels per metre from screen-space derivatives) against the ideal one, the density of a perfectly
   * packed atlas of the whole plant: green = within 0.5x .. 2x of it, blue = too low, red = too high.
   */
  private lightmapDensityFor(content: ViewportContent): ShaderMaterial {
    let area = 0;
    content.root.traverse((obj: Object3D) => {
      if (!isSurfaceMesh(obj) || obj.userData.isBackFace === true) return;
      const pos = obj.geometry.getAttribute('position');
      const idx = obj.geometry.getIndex();
      if (!pos || !idx) return;
      for (let t = 0; t + 2 < idx.count; t += 3) {
        const a = idx.getX(t);
        const b = idx.getX(t + 1);
        const c = idx.getX(t + 2);
        const ux = pos.getX(b) - pos.getX(a);
        const uy = pos.getY(b) - pos.getY(a);
        const uz = pos.getZ(b) - pos.getZ(a);
        const vx = pos.getX(c) - pos.getX(a);
        const vy = pos.getY(c) - pos.getY(a);
        const vz = pos.getZ(c) - pos.getZ(a);
        area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      }
    });
    this.lightmapUniforms.uTarget.value = area > 1e-9 ? this.lightmapUniforms.uRes.value / Math.sqrt(area) : 1;
    if (this.lightmapMaterial) return this.lightmapMaterial;
    this.lightmapMaterial = new ShaderMaterial({
      side: DoubleSide,
      uniforms: this.lightmapUniforms,
      vertexShader: `attribute vec2 uv1; varying vec2 vUv1; varying vec3 vPos;
        void main() { vUv1 = uv1; vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        vPos = p.xyz; gl_Position = projectionMatrix * modelViewMatrix * p; }`,
      fragmentShader: `varying vec2 vUv1; varying vec3 vPos; uniform float uRes; uniform float uTarget;
        void main() {
          float worldArea = length(cross(dFdx(vPos), dFdy(vPos)));
          vec2 ux = dFdx(vUv1); vec2 uy = dFdy(vUv1);
          float texelArea = abs(ux.x * uy.y - ux.y * uy.x) * uRes * uRes;
          float ratio = sqrt(texelArea / max(worldArea, 1e-12)) / max(uTarget, 1e-6);
          vec3 c = ratio < 0.5 ? vec3(0.1, 0.3, 1.0) : (ratio > 2.0 ? vec3(1.0, 0.15, 0.1) : vec3(0.1, 0.8, 0.25));
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    return this.lightmapMaterial;
  }

  private windWeightsFor(): ShaderMaterial {
    if (this.windWeightsMaterial) return this.windWeightsMaterial;
    this.windWeightsMaterial = new ShaderMaterial({
      side: DoubleSide,
      vertexShader: `attribute vec4 windWeights; varying vec3 vWw;
        void main() { vWw = windWeights.xyz; vec4 p = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          p = instanceMatrix * p;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * p; }`,
      fragmentShader: 'varying vec3 vWw; void main() { gl_FragColor = vec4(clamp(vWw, 0.0, 1.0), 1.0); }',
    });
    return this.windWeightsMaterial;
  }

  /**
   * One vertex-colour channel as grey (`channel` 0 / 1 / 2) or all three (-1), decoded like the export: Legacy = the stored
   * colour, Kekenik = R branch tint (0.5 without one), G height over the plant, B ambient occlusion. A basic material with the
   * cut-out of `base` (alpha map / alpha test) so leaf cards keep their shape; the colour is shown raw (no tone mapping or
   * colour-space encode), so a channel value of 0.5 is grey 0.5.
   */
  private vcChannelFor(channel: number, mesh: Mesh, base: Material): MeshBasicMaterial {
    const hasTint = mesh.geometry.getAttribute('branchTint') !== undefined;
    const key = `${base.uuid}:${channel}:${hasTint ? 1 : 0}`;
    let m = this.vcChannelMats.get(key);
    if (!m) {
      const src = base as MeshStandardMaterial;
      m = new MeshBasicMaterial({ vertexColors: true, alphaMap: src.alphaMap ?? null, map: src.alphaMap ? null : src.alphaTest > 0 ? src.map : null, alphaTest: src.alphaTest, side: DoubleSide });
      if (hasTint) m.defines = { HAS_TINT: '' };
      const channelUniform = { value: channel };
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, this.vcUniforms, { uChannel: channelUniform });
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float ao;\n#ifdef HAS_TINT\nattribute float branchTint;\n#endif\nuniform float uPacking; uniform float uZMin; uniform float uZMax;')
          .replace(
            '#include <color_vertex>',
            `#include <color_vertex>
            if (uPacking > 0.5) {
              float tint = 0.5;
              #ifdef HAS_TINT
                tint = branchTint;
              #endif
              vec4 kp = vec4(position, 1.0);
              #ifdef USE_INSTANCING
                kp = instanceMatrix * kp;
              #endif
              float h = clamp(((modelMatrix * kp).z - uZMin) / max(uZMax - uZMin, 1e-6), 0.0, 1.0);
              vColor.rgb = vec3(tint, h, ao);
            }`,
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float uChannel;')
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            {
              vec3 kc = clamp(vColor.rgb, 0.0, 1.0);
              if (uChannel > 1.5) kc = vec3(kc.b); else if (uChannel > 0.5) kc = vec3(kc.g); else if (uChannel > -0.5) kc = vec3(kc.r);
              diffuseColor.rgb = kc;
            }`,
          )
          .replace('#include <tonemapping_fragment>', '')
          .replace('#include <colorspace_fragment>', '');
      };
      this.vcChannelMats.set(key, m);
    }
    return m;
  }

  /** Vertex colours only (baked AO / tint), keeping the cut-out of leaf cards. */
  private vertexColorFor(base: Material): MeshBasicMaterial {
    let m = this.vertexColorMats.get(base);
    if (!m) {
      const src = base as MeshStandardMaterial;
      m = new MeshBasicMaterial({ vertexColors: true, alphaMap: src.alphaMap ?? null, map: src.alphaMap ? null : src.alphaTest > 0 ? src.map : null, alphaTest: src.alphaTest, side: DoubleSide });
      this.vertexColorMats.set(base, m);
    }
    return m;
  }

  /**
   * Alpha-coverage diagnostic ("Show > Alpha coverage"): cut-out materials draw the pixels that PASS the alpha test in
   * solid lime (same alpha map, threshold and shaders as the real material), everything else in dim grey.
   */
  private alphaFor(base: Material): MeshBasicMaterial {
    let m = this.alphaMats.get(base);
    if (!m) {
      const src = base as MeshStandardMaterial;
      const cutout = src.alphaTest > 0;
      m = new MeshBasicMaterial({ color: cutout ? 0x7bff3a : 0x5c616b, alphaMap: src.alphaMap ?? null, map: src.alphaMap ? null : cutout ? src.map : null, alphaTest: src.alphaTest, side: DoubleSide });
      if (cutout) m.onBeforeCompile = (shader) => void (shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', 'diffuseColor.rgb = vec3(0.48, 1.0, 0.23);'));
      this.alphaMats.set(base, m);
    }
    return m;
  }

  private flatFor(base: Material): MeshBasicMaterial {
    let m = this.flat.get(base);
    if (!m) {
      const src = base as MeshStandardMaterial;
      m = new MeshBasicMaterial({
        color: src.color,
        map: src.map,
        vertexColors: src.vertexColors,
        alphaTest: src.alphaTest,
        side: src.side,
        transparent: src.transparent,
      });
      this.flat.set(base, m);
    }
    return m;
  }

  private clearOverlays(): void {
    for (const o of this.overlays) o.removeFromParent();
    this.overlays = [];
  }

  dispose(): void {
    this.clearOverlays();
    this.wire.dispose();
    this.overlayWire.dispose();
    this.thickWire.dispose();
    this.thickOverlay.dispose();
    this.hidden.dispose();
    this.debug.dispose();
    this.faintWire.dispose();
    this.faintThick.dispose();
    this.vertexColorMats.forEach((m) => m.dispose());
    this.vcChannelMats.forEach((m) => m.dispose());
    this.vcChannelMats.clear();
    this.alphaMats.forEach((m) => m.dispose());
    this.normals.dispose();
    this.aoMaterial.dispose();
    this.windWeightsMaterial?.dispose();
    this.uvMaterial?.dispose();
    this.uvTexture?.dispose();
    this.flat.forEach((m) => m.dispose());
    this.flat.clear();
  }
}
