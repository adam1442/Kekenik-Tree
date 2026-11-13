import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FrontSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  RGBAFormat,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
  type Material,
  type Texture,
} from 'three';
import { CancelledError, type CancellationToken } from '@/contracts/nodes';
import type { PlantGeometry } from '../geometry';
import { createImage, dilateColor, resizeImage, type RGBAImage } from '../images/imageOps';
import type { ImpostorSettings } from '../types';
import { viewDirection, type ImpostorLayout } from './impostorLayout';

/** WebGL renderer of the impostor atlas: N orthographic views (+ optional top view) of albedo, normals and depth. */

export interface ImpostorMaterial {
  /** Linear RGB base colour. */
  color: [number, number, number];
  /** Alpha-test threshold (0 = opaque). */
  cutoff: number;
  doubleSided: boolean;
  /** Base-colour pixels (original orientation, alpha = cut-out mask) or null. */
  albedo: RGBAImage | null;
}

export interface ImpostorRenderInput {
  geometries: readonly PlantGeometry[];
  materials: ReadonlyMap<string, ImpostorMaterial>;
  settings: ImpostorSettings;
  layout: ImpostorLayout;
}

export interface ImpostorRenderResult {
  albedo: RGBAImage;
  normal: RGBAImage | null;
  depth: RGBAImage | null;
  center: [number, number, number];
  /** Bounding-sphere radius: every frame shows +-radius around the centre. */
  radius: number;
}

const FALLBACK: ImpostorMaterial = { color: [0.8, 0.8, 0.8], cutoff: 0, doubleSided: true, albedo: null };

const VERT = /* glsl */ `
varying vec3 vN;
varying vec2 vUv;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CUT = /* glsl */ `
uniform sampler2D map;
uniform float cutoff;
uniform float useMap;
varying vec3 vN;
varying vec2 vUv;
void cutOut() {
  if (cutoff > 0.0) {
    float a = useMap > 0.5 ? texture2D(map, vUv).a : 1.0;
    if (a < cutoff) discard;
  }
}`;

const NORMAL_FRAG = `${CUT}
void main() {
  cutOut();
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}`;

// Ortho depth is linear: 0 at the near plane (nearest point of the bounding sphere). Stored as 1 - depth (near = bright).
const DEPTH_FRAG = `${CUT}
void main() {
  cutOut();
  gl_FragColor = vec4(vec3(1.0 - gl_FragCoord.z), 1.0);
}`;

function toBufferGeometry(g: PlantGeometry): BufferGeometry {
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(g.positions, 3));
  geo.setAttribute('normal', new BufferAttribute(g.normals, 3));
  geo.setAttribute('uv', new BufferAttribute(g.uv0, 2));
  if (g.colors) geo.setAttribute('color', new BufferAttribute(g.colors, 4));
  const total = g.primitives.reduce((s, p) => s + p.indices.length, 0);
  const index = new Uint32Array(total);
  let o = 0;
  g.primitives.forEach((p, i) => {
    index.set(p.indices, o);
    geo.addGroup(o, p.indices.length, i);
    o += p.indices.length;
  });
  geo.setIndex(new BufferAttribute(index, 1));
  return geo;
}

function makeTexture(img: RGBAImage): DataTexture {
  // Pixels are top-row-first; WebGL expects the bottom row first (Kekenik UVs have v up).
  const flipped = new Uint8Array(img.data.length);
  const row = img.width * 4;
  for (let y = 0; y < img.height; y++) flipped.set(img.data.subarray((img.height - 1 - y) * row, (img.height - y) * row), y * row);
  const t = new DataTexture(flipped, img.width, img.height, RGBAFormat, UnsignedByteType);
  t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const yieldToBrowser = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function readImage(renderer: WebGLRenderer, rt: WebGLRenderTarget, out: number): RGBAImage {
  const buf = new Uint8Array(rt.width * rt.height * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
  const flipped = new Uint8ClampedArray(buf.length);
  const row = rt.width * 4;
  for (let y = 0; y < rt.height; y++) flipped.set(buf.subarray((rt.height - 1 - y) * row, (rt.height - y) * row), y * row);
  const full: RGBAImage = { width: rt.width, height: rt.height, data: flipped };
  return resizeImage(full, out, out);
}

export async function renderImpostor(input: ImpostorRenderInput, token: CancellationToken, onProgress: (fraction: number) => void): Promise<ImpostorRenderResult> {
  const { settings, layout, geometries } = input;
  // Bounding sphere of the visible geometry.
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const g of geometries) {
    for (let i = 0; i + 2 < g.positions.length; i += 3) {
      const x = g.positions[i] as number;
      const y = g.positions[i + 1] as number;
      const z = g.positions[i + 2] as number;
      min.set(Math.min(min.x, x), Math.min(min.y, y), Math.min(min.z, z));
      max.set(Math.max(max.x, x), Math.max(max.y, y), Math.max(max.z, z));
    }
  }
  if (!Number.isFinite(min.x)) throw new Error('Nothing to render for the impostor.');
  const center = min.clone().add(max).multiplyScalar(0.5);
  let radius = 0;
  for (const g of geometries) {
    for (let i = 0; i + 2 < g.positions.length; i += 3) {
      radius = Math.max(radius, Math.hypot((g.positions[i] as number) - center.x, (g.positions[i + 1] as number) - center.y, (g.positions[i + 2] as number) - center.z));
    }
  }
  radius = Math.max(radius, 1e-3) * (1 + settings.padding / Math.max(8, settings.frameSize));

  const renderer = new WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: false });
  const disposables: { dispose(): void }[] = [];
  try {
    const ss = settings.frameSize * 2 <= 2048 ? 2 : 1;
    const size = settings.frameSize * ss;
    const rt = new WebGLRenderTarget(size, size, { colorSpace: SRGBColorSpace, depthBuffer: true });
    disposables.push(rt);
    renderer.setSize(size, size, false);
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);

    const textures = new Map<string, Texture>();
    const blank = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
    blank.needsUpdate = true;
    disposables.push(blank);
    const matInfo = (id: string): ImpostorMaterial => input.materials.get(id) ?? FALLBACK;
    const textureOf = (id: string): Texture | null => {
      const info = matInfo(id);
      if (!info.albedo) return null;
      let t = textures.get(id);
      if (!t) {
        t = makeTexture(info.albedo);
        textures.set(id, t);
        disposables.push(t);
      }
      return t;
    };

    const scene = new Scene();
    const meshes = geometries.map((g) => {
      const geo = toBufferGeometry(g);
      disposables.push(geo);
      const mesh = new Mesh(geo);
      scene.add(mesh);
      return { mesh, ids: g.primitives.map((p) => p.materialId), colors: Boolean(g.colors) };
    });

    const passMaterials = (pass: 'albedo' | 'normal' | 'depth'): Material[][] =>
      meshes.map((m) =>
        m.ids.map((id) => {
          const info = matInfo(id);
          const tex = textureOf(id);
          const side = info.doubleSided ? DoubleSide : FrontSide;
          let mat: Material;
          if (pass === 'albedo') {
            mat = new MeshBasicMaterial({ map: tex, color: new Color().setRGB(info.color[0], info.color[1], info.color[2], LinearSRGBColorSpace), vertexColors: m.colors, alphaTest: info.cutoff, side });
          } else {
            mat = new ShaderMaterial({
              vertexShader: VERT,
              fragmentShader: pass === 'normal' ? NORMAL_FRAG : DEPTH_FRAG,
              uniforms: { map: { value: tex ?? blank }, cutoff: { value: info.cutoff }, useMap: { value: tex ? 1 : 0 } },
              side,
            });
          }
          disposables.push(mat);
          return mat;
        }),
      );
    const passes: { name: 'albedo' | 'normal' | 'depth'; mats: Material[][] }[] = [{ name: 'albedo', mats: passMaterials('albedo') }];
    if (settings.normals) passes.push({ name: 'normal', mats: passMaterials('normal') });
    if (settings.depth) passes.push({ name: 'depth', mats: passMaterials('depth') });

    const cam = new OrthographicCamera(-radius, radius, radius, -radius, radius, radius * 3);
    const atlasW = layout.cols * layout.frameSize;
    const atlasH = layout.rows * layout.frameSize;
    const atlases = new Map<string, RGBAImage>(passes.map((p) => [p.name, createImage(atlasW, atlasH)]));

    for (const frame of layout.frames) {
      if (token.cancelled) throw new CancelledError();
      const dir = viewDirection(frame.azimuthDeg, frame.elevationDeg);
      cam.position.set(center.x + dir[0] * radius * 2, center.y + dir[1] * radius * 2, center.z + dir[2] * radius * 2);
      cam.up.set(0, frame.elevationDeg >= 89.9 ? 1 : 0, frame.elevationDeg >= 89.9 ? 0 : 1);
      cam.lookAt(center);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
      for (const pass of passes) {
        meshes.forEach((m, i) => (m.mesh.material = pass.mats[i] as Material[]));
        renderer.setRenderTarget(rt);
        renderer.clear();
        renderer.render(scene, cam);
        let img = readImage(renderer, rt, layout.frameSize);
        if (pass.name !== 'depth' && settings.padding > 0) img = dilateColor(img, settings.padding);
        const atlas = atlases.get(pass.name) as RGBAImage;
        for (let y = 0; y < img.height; y++) {
          atlas.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), ((frame.rect[1] + y) * atlasW + frame.rect[0]) * 4);
        }
      }
      onProgress((frame.index + 1) / layout.frames.length);
      await yieldToBrowser();
    }
    renderer.setRenderTarget(null);
    return {
      albedo: atlases.get('albedo') as RGBAImage,
      normal: atlases.get('normal') ?? null,
      depth: atlases.get('depth') ?? null,
      center: [center.x, center.y, center.z],
      radius,
    };
  } finally {
    disposables.forEach((d) => d.dispose());
    renderer.dispose();
    renderer.forceContextLoss();
  }
}
