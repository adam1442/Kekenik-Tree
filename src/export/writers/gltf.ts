import type { PlantGeometry } from '../geometry';
import type { ExportFile } from '../types';

/**
 * glTF 2.0 / GLB writer (custom, DOM-free). Spec of the Kekenik extras and `_` attributes: docs/EXPORT_SPEC.md.
 * Extensions written when needed: KHR_materials_specular, KHR_texture_transform, EXT_texture_webp.
 */

export interface GltfTextureRef {
  /** Index into `GltfScene.images`. */
  image: number;
  /** KHR_texture_transform (used by impostor / cross-billboard frames inside an atlas). */
  transform?: { offset: [number, number]; scale: [number, number] };
}

export interface GltfImage {
  name: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  data: Uint8Array;
  /** Relative file name when the image is written next to the model instead of being embedded. */
  uri?: string;
}

export interface GltfMaterial {
  name: string;
  baseColorFactor: [number, number, number, number];
  baseColorTexture?: GltfTextureRef;
  metallicFactor: number;
  roughnessFactor: number;
  metallicRoughnessTexture?: GltfTextureRef;
  occlusionTexture?: GltfTextureRef & { strength: number };
  normalTexture?: GltfTextureRef & { scale: number };
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  alphaCutoff: number;
  doubleSided: boolean;
  specular?: { factor: number; color: [number, number, number] };
  extras?: Record<string, unknown>;
}

export interface GltfNodeInput {
  name: string;
  geometry: PlantGeometry;
  extras?: Record<string, unknown>;
}

export interface GltfScene {
  name: string;
  images: GltfImage[];
  materials: GltfMaterial[];
  /** `PlantPrimitive.materialId` -> index into `materials`. Unknown ids fall back to material 0 (or none). */
  materialIndex: ReadonlyMap<string, number>;
  nodes: GltfNodeInput[];
  /** Written to `asset.extras.kekenik` / `scenes[0].extras.kekenik`. */
  extras?: Record<string, unknown>;
}

export interface GltfOptions {
  binary: boolean;
  customAttributes: boolean;
  vertexColors: boolean;
  /** glTF only: write the bin as a separate file and the images as uris (data URIs unless `images[i].uri` is set). */
  baseName: string;
}

export interface GltfResult {
  files: ExportFile[];
  json: GltfJson;
}

export interface GltfJson {
  asset: { version: string; generator: string; extras?: Record<string, unknown> };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  scene: number;
  scenes: { name: string; nodes: number[]; extras?: Record<string, unknown> }[];
  nodes: { name: string; mesh: number; extras?: Record<string, unknown> }[];
  meshes: { name: string; primitives: Record<string, unknown>[] }[];
  materials?: Record<string, unknown>[];
  textures?: Record<string, unknown>[];
  images?: Record<string, unknown>[];
  samplers?: Record<string, unknown>[];
  accessors: Record<string, unknown>[];
  bufferViews: Record<string, unknown>[];
  buffers: { byteLength: number; uri?: string }[];
}

const FLOAT = 5126;
const UINT = 5125;
const USHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

class BufferBuilder {
  readonly chunks: Uint8Array[] = [];
  readonly views: Record<string, unknown>[] = [];
  readonly accessors: Record<string, unknown>[] = [];
  private length = 0;

  get byteLength(): number {
    return this.length;
  }

  addView(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) {
      this.chunks.push(new Uint8Array(pad));
      this.length += pad;
    }
    const view: Record<string, unknown> = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    this.views.push(view);
    return this.views.length - 1;
  }

  addAccessor(array: Float32Array | Uint16Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4', target: number, bounds?: { min: number[]; max: number[] }): number {
    const comp = array instanceof Float32Array ? FLOAT : array instanceof Uint16Array ? USHORT : UINT;
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const view = this.addView(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), target);
    const acc: Record<string, unknown> = { bufferView: view, componentType: comp, count: array.length / n, type };
    if (bounds) {
      acc.min = bounds.min;
      acc.max = bounds.max;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  concat(): Uint8Array {
    const pad = (4 - (this.length % 4)) % 4;
    const out = new Uint8Array(this.length + pad);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.byteLength;
    }
    return out;
  }
}

function bounds3(p: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a] as number;
      if (v < (min[a] as number)) min[a] = v;
      if (v > (max[a] as number)) max[a] = v;
    }
  }
  return p.length === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max };
}

const textureInfo = (ref: GltfTextureRef, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const info: Record<string, unknown> = { index: ref.image, ...extra };
  if (ref.transform) info.extensions = { KHR_texture_transform: { offset: ref.transform.offset, scale: ref.transform.scale } };
  return info;
};

function materialJson(m: GltfMaterial, used: Set<string>): Record<string, unknown> {
  const pbr: Record<string, unknown> = { baseColorFactor: m.baseColorFactor, metallicFactor: m.metallicFactor, roughnessFactor: m.roughnessFactor };
  if (m.baseColorTexture) pbr.baseColorTexture = textureInfo(m.baseColorTexture);
  if (m.metallicRoughnessTexture) pbr.metallicRoughnessTexture = textureInfo(m.metallicRoughnessTexture);
  const out: Record<string, unknown> = { name: m.name, pbrMetallicRoughness: pbr, doubleSided: m.doubleSided, alphaMode: m.alphaMode };
  if (m.alphaMode === 'MASK') out.alphaCutoff = m.alphaCutoff;
  if (m.normalTexture) out.normalTexture = textureInfo(m.normalTexture, { scale: m.normalTexture.scale });
  if (m.occlusionTexture) out.occlusionTexture = textureInfo(m.occlusionTexture, { strength: m.occlusionTexture.strength });
  const textures = [m.baseColorTexture, m.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture];
  if (textures.some((t) => t?.transform)) used.add('KHR_texture_transform');
  if (m.specular) {
    used.add('KHR_materials_specular');
    out.extensions = { KHR_materials_specular: { specularFactor: m.specular.factor, specularColorFactor: m.specular.color } };
  }
  if (m.extras) out.extras = m.extras;
  return out;
}

/** glTF uses a top-left UV origin: flip V of the (bottom-left) Kekenik UVs. */
function flipV(uv: Float32Array): Float32Array {
  const out = new Float32Array(uv.length);
  for (let i = 0; i + 1 < uv.length; i += 2) {
    out[i] = uv[i] as number;
    out[i + 1] = 1 - (uv[i + 1] as number);
  }
  return out;
}

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const asciiBytes = (s: string): Uint8Array => new TextEncoder().encode(s);

export function writeGltf(scene: GltfScene, opts: GltfOptions): GltfResult {
  const used = new Set<string>();
  const required = new Set<string>();
  const buf = new BufferBuilder();
  const meshes: GltfJson['meshes'] = [];
  const nodes: GltfJson['nodes'] = [];

  scene.nodes.forEach((node, nodeIndex) => {
    const g = node.geometry;
    const base: Record<string, number> = {};
    base.POSITION = buf.addAccessor(g.positions, 'VEC3', ARRAY_BUFFER, bounds3(g.positions));
    base.NORMAL = buf.addAccessor(g.normals, 'VEC3', ARRAY_BUFFER);
    base.TEXCOORD_0 = buf.addAccessor(flipV(g.uv0), 'VEC2', ARRAY_BUFFER);
    if (g.uv1) base.TEXCOORD_1 = buf.addAccessor(flipV(g.uv1), 'VEC2', ARRAY_BUFFER);
    if (g.tangents) base.TANGENT = buf.addAccessor(g.tangents, 'VEC4', ARRAY_BUFFER);
    if (opts.vertexColors && g.colors) base.COLOR_0 = buf.addAccessor(g.colors, 'VEC4', ARRAY_BUFFER);
    if (opts.customAttributes) {
      if (g.wind) {
        base._WIND_PIVOT = buf.addAccessor(g.wind.pivot, 'VEC3', ARRAY_BUFFER);
        base._WIND_WEIGHTS = buf.addAccessor(g.wind.weights, 'VEC4', ARRAY_BUFFER);
      }
      if (g.ao) base._AO = buf.addAccessor(g.ao, 'SCALAR', ARRAY_BUFFER);
    }
    const vertexCount = g.positions.length / 3;
    const primitives = g.primitives.map((p) => {
      const idx = vertexCount <= 65535 ? Uint16Array.from(p.indices) : p.indices;
      const prim: Record<string, unknown> = { attributes: base, indices: buf.addAccessor(idx, 'SCALAR', ELEMENT_ARRAY_BUFFER), mode: 4 };
      const mat = scene.materialIndex.get(p.materialId);
      if (mat !== undefined) prim.material = mat;
      return prim;
    });
    meshes.push({ name: node.name, primitives });
    const entry: GltfJson['nodes'][number] = { name: node.name, mesh: nodeIndex };
    if (node.extras) entry.extras = node.extras;
    nodes.push(entry);
  });

  const hasWebp = scene.images.some((i) => i.mime === 'image/webp');
  const images: Record<string, unknown>[] = [];
  const textures: Record<string, unknown>[] = [];
  const files: ExportFile[] = [];
  scene.images.forEach((img, i) => {
    if (opts.binary) {
      images.push({ name: img.name, mimeType: img.mime, bufferView: buf.addView(img.data) });
    } else if (img.uri) {
      images.push({ name: img.name, mimeType: img.mime, uri: img.uri });
      files.push({ name: img.uri, data: img.data, mime: img.mime });
    } else {
      images.push({ name: img.name, mimeType: img.mime, uri: `data:${img.mime};base64,${toBase64(img.data)}` });
    }
    textures.push(img.mime === 'image/webp' ? { sampler: 0, extensions: { EXT_texture_webp: { source: i } } } : { sampler: 0, source: i });
  });
  if (hasWebp) {
    used.add('EXT_texture_webp');
    required.add('EXT_texture_webp');
  }

  const materials = scene.materials.map((m) => materialJson(m, used));
  const json: GltfJson = {
    asset: { version: '2.0', generator: 'Kekenik Tree', ...(scene.extras ? { extras: { kekenik: scene.extras } } : {}) },
    scene: 0,
    scenes: [{ name: scene.name, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    accessors: buf.accessors,
    bufferViews: buf.views,
    buffers: [{ byteLength: 0 }],
  };
  if (materials.length > 0) json.materials = materials;
  if (images.length > 0) {
    json.images = images;
    json.textures = textures;
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  }
  if (used.size > 0) json.extensionsUsed = [...used];
  if (required.size > 0) json.extensionsRequired = [...required];

  const bin = buf.concat();
  json.buffers[0] = { byteLength: bin.byteLength };

  if (!opts.binary) {
    json.buffers[0] = { byteLength: bin.byteLength, uri: `${opts.baseName}.bin` };
    files.unshift({ name: `${opts.baseName}.gltf`, data: JSON.stringify(json, null, 2), mime: 'model/gltf+json' }, { name: `${opts.baseName}.bin`, data: bin, mime: 'application/octet-stream' });
    return { files, json };
  }

  let jsonBytes = asciiBytes(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) {
    const padded = new Uint8Array(jsonBytes.length + jsonPad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const hasBin = bin.byteLength > 0;
  const total = 12 + 8 + jsonBytes.length + (hasBin ? 8 + bin.byteLength : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  if (hasBin) {
    const o = 20 + jsonBytes.length;
    dv.setUint32(o, bin.byteLength, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    out.set(bin, o + 8);
  }
  return { files: [{ name: `${opts.baseName}.glb`, data: out, mime: 'model/gltf-binary' }], json };
}

/** Parse the JSON chunk of a GLB (used by the verifier and tests). */
export function readGlbJson(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB file (bad magic).');
  if (dv.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB length header does not match the file size.');
  let o = 12;
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  while (o + 8 <= bytes.byteLength) {
    const len = dv.getUint32(o, true);
    const type = dv.getUint32(o + 4, true);
    const body = bytes.subarray(o + 8, o + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson;
    else if (type === 0x004e4942) bin = body;
    o += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk.');
  return { json, bin };
}
