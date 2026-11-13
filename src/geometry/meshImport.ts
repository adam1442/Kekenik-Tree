import type { MeshData } from '@/contracts/mesh';
import { MeshAccumulator, newVertex } from './meshAccumulator';
import { cross, norm, perpendicular, type V3 } from './math3';

/** Indexed triangle soup in the file's own (Y-up) space before conversion. */
interface RawMesh {
  pos: number[];
  nrm: number[];
  uv: number[];
  hasNormals: boolean;
  hasUv: boolean;
  idx: number[];
}

/** Y-up (OBJ / glTF) -> Z-up (project convention): (x, y, z) -> (x, -z, y). */
const toZUp = (x: number, y: number, z: number): V3 => [x, -z, y];

function finish(raw: RawMesh, materialId: string): MeshData {
  const nv = raw.pos.length / 3;
  const normals = new Float32Array(nv * 3);
  if (raw.hasNormals) {
    for (let i = 0; i < nv; i++) {
      const n = toZUp(raw.nrm[i * 3] as number, raw.nrm[i * 3 + 1] as number, raw.nrm[i * 3 + 2] as number);
      normals.set(norm(n), i * 3);
    }
  } else {
    for (let t = 0; t < raw.idx.length; t += 3) {
      const [a, b, c] = [raw.idx[t] as number, raw.idx[t + 1] as number, raw.idx[t + 2] as number];
      const p = (i: number): V3 => toZUp(raw.pos[i * 3] as number, raw.pos[i * 3 + 1] as number, raw.pos[i * 3 + 2] as number);
      const pa = p(a), pb = p(b), pc = p(c);
      const n = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]);
      for (const i of [a, b, c]) {
        normals[i * 3] += n[0];
        normals[i * 3 + 1] += n[1];
        normals[i * 3 + 2] += n[2];
      }
    }
    for (let i = 0; i < nv; i++) normals.set(norm([normals[i * 3] as number, normals[i * 3 + 1] as number, normals[i * 3 + 2] as number]), i * 3);
  }
  const acc = new MeshAccumulator();
  acc.beginSlot(materialId);
  for (let i = 0; i < nv; i++) {
    const p = toZUp(raw.pos[i * 3] as number, raw.pos[i * 3 + 1] as number, raw.pos[i * 3 + 2] as number);
    const v = newVertex();
    v.px = p[0]; v.py = p[1]; v.pz = p[2];
    v.nx = normals[i * 3] as number; v.ny = normals[i * 3 + 1] as number; v.nz = normals[i * 3 + 2] as number;
    const t = perpendicular([v.nx, v.ny, v.nz]);
    v.tx = t[0]; v.ty = t[1]; v.tz = t[2];
    v.u = raw.hasUv ? (raw.uv[i * 2] as number) : 0;
    v.v = raw.hasUv ? (raw.uv[i * 2 + 1] as number) : 0;
    v.u1 = v.u; v.v1 = v.v;
    acc.addVertex(v);
  }
  for (let t = 0; t < raw.idx.length; t += 3) acc.addTriangle(raw.idx[t] as number, raw.idx[t + 1] as number, raw.idx[t + 2] as number);
  return acc.build(materialId, true);
}

/** Wavefront OBJ (v / vt / vn / f with n-gons and negative indices). */
export function parseObj(text: string, materialId: string): MeshData {
  const P: number[] = [], T: number[] = [], N: number[] = [];
  const raw: RawMesh = { pos: [], nrm: [], uv: [], hasNormals: false, hasUv: false, idx: [] };
  const cache = new Map<string, number>();
  const resolve = (ref: string | undefined, count: number): number => {
    if (!ref) return -1;
    const k = parseInt(ref, 10);
    if (Number.isNaN(k)) return -1;
    return k < 0 ? count + k : k - 1;
  };
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') P.push(+(parts[1] ?? 0), +(parts[2] ?? 0), +(parts[3] ?? 0));
    else if (tag === 'vt') T.push(+(parts[1] ?? 0), +(parts[2] ?? 0));
    else if (tag === 'vn') N.push(+(parts[1] ?? 0), +(parts[2] ?? 0), +(parts[3] ?? 0));
    else if (tag === 'f' && parts.length >= 4) {
      const ids: number[] = [];
      for (const ref of parts.slice(1)) {
        const [vs, ts, ns] = ref.split('/');
        const vi = resolve(vs, P.length / 3);
        const ti = resolve(ts, T.length / 2);
        const ni = resolve(ns, N.length / 3);
        if (vi < 0 || vi * 3 + 2 >= P.length) continue;
        const key = `${vi}/${ti}/${ni}`;
        let id = cache.get(key);
        if (id === undefined) {
          id = raw.pos.length / 3;
          raw.pos.push(P[vi * 3] as number, P[vi * 3 + 1] as number, P[vi * 3 + 2] as number);
          raw.uv.push(ti >= 0 ? (T[ti * 2] as number) : 0, ti >= 0 ? (T[ti * 2 + 1] as number) : 0);
          raw.nrm.push(ni >= 0 ? (N[ni * 3] as number) : 0, ni >= 0 ? (N[ni * 3 + 1] as number) : 0, ni >= 0 ? (N[ni * 3 + 2] as number) : 1);
          if (ti >= 0) raw.hasUv = true;
          if (ni >= 0) raw.hasNormals = true;
          cache.set(key, id);
        }
        ids.push(id);
      }
      for (let k = 1; k + 1 < ids.length; k++) raw.idx.push(ids[0] as number, ids[k] as number, ids[k + 1] as number);
    }
  }
  return finish(raw, materialId);
}

// ---- glTF / GLB ------------------------------------------------------------------------------------------------

interface GltfAccessor { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }
interface GltfView { buffer: number; byteOffset?: number; byteStride?: number }
interface GltfNode { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }
interface GltfPrimitive { attributes: Record<string, number>; indices?: number; mode?: number }
interface Gltf {
  accessors?: GltfAccessor[];
  bufferViews?: GltfView[];
  buffers?: { uri?: string }[];
  meshes?: { primitives: GltfPrimitive[] }[];
  nodes?: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(g: Gltf, buffers: Uint8Array[], index: number): number[] {
  const acc = g.accessors?.[index];
  if (!acc || acc.bufferView === undefined) return [];
  const view = g.bufferViews?.[acc.bufferView];
  const data = view ? buffers[view.buffer] : undefined;
  if (!view || !data) return [];
  const comps = COMPONENTS[acc.type] ?? 1;
  const size = acc.componentType === 5126 || acc.componentType === 5125 ? 4 : acc.componentType === 5123 || acc.componentType === 5122 ? 2 : 1;
  const stride = view.byteStride ?? comps * size;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: number[] = [];
  const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * size;
      switch (acc.componentType) {
        case 5126: out.push(dv.getFloat32(o, true)); break;
        case 5125: out.push(dv.getUint32(o, true)); break;
        case 5123: out.push(dv.getUint16(o, true)); break;
        case 5122: out.push(dv.getInt16(o, true)); break;
        case 5121: out.push(dv.getUint8(o)); break;
        default: out.push(dv.getInt8(o));
      }
    }
  }
  return out;
}

function nodeMatrix(n: GltfNode): number[] {
  if (n.matrix && n.matrix.length === 16) return n.matrix;
  const [tx = 0, ty = 0, tz = 0] = n.translation ?? [];
  const [qx = 0, qy = 0, qz = 0, qw = 1] = n.rotation ?? [];
  const [sx = 1, sy = 1, sz = 1] = n.scale ?? [];
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2, wx = qw * x2, wy = qw * y2, wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const mulMat = (a: number[], b: number[]): number[] => {
  const o = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
  return o;
};

function decodeDataUri(uri: string): Uint8Array {
  const bin = atob(uri.slice(uri.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Parse a GLB (binary glTF 2) or a JSON glTF with embedded data-URI buffers. Triangle primitives only. */
export function parseGltf(bytes: Uint8Array, materialId: string): MeshData {
  let json: Gltf;
  const buffers: Uint8Array[] = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    let o = 12;
    let parsed: Gltf = {};
    while (o + 8 <= bytes.byteLength) {
      const chunkLen = dv.getUint32(o, true);
      const type = dv.getUint32(o + 4, true);
      const chunk = bytes.subarray(o + 8, o + 8 + chunkLen);
      if (type === 0x4e4f534a) parsed = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
      else if (type === 0x004e4942) buffers.push(chunk);
      o += 8 + chunkLen;
    }
    json = parsed;
  } else {
    json = JSON.parse(new TextDecoder().decode(bytes)) as Gltf;
    for (const b of json.buffers ?? []) buffers.push(b.uri?.startsWith('data:') ? decodeDataUri(b.uri) : new Uint8Array(0));
  }
  const raw: RawMesh = { pos: [], nrm: [], uv: [], hasNormals: true, hasUv: true, idx: [] };
  let anyNormals = false;
  const emitMesh = (meshIndex: number, m: number[]): void => {
    for (const prim of json.meshes?.[meshIndex]?.primitives ?? []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue;
      const pos = readAccessor(json, buffers, prim.attributes.POSITION ?? -1);
      if (!pos.length) continue;
      const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(json, buffers, prim.attributes.NORMAL) : [];
      const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(json, buffers, prim.attributes.TEXCOORD_0) : [];
      const base = raw.pos.length / 3;
      const count = pos.length / 3;
      for (let i = 0; i < count; i++) {
        const x = pos[i * 3] as number, y = pos[i * 3 + 1] as number, z = pos[i * 3 + 2] as number;
        raw.pos.push(
          (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
          (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
          (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
        );
        if (nrm.length) {
          anyNormals = true;
          const nx = nrm[i * 3] as number, ny = nrm[i * 3 + 1] as number, nz = nrm[i * 3 + 2] as number;
          raw.nrm.push(
            (m[0] as number) * nx + (m[4] as number) * ny + (m[8] as number) * nz,
            (m[1] as number) * nx + (m[5] as number) * ny + (m[9] as number) * nz,
            (m[2] as number) * nx + (m[6] as number) * ny + (m[10] as number) * nz,
          );
        } else raw.nrm.push(0, 0, 1);
        raw.uv.push(uv.length ? (uv[i * 2] as number) : 0, uv.length ? 1 - (uv[i * 2 + 1] as number) : 0);
      }
      const idx = prim.indices !== undefined ? readAccessor(json, buffers, prim.indices) : Array.from({ length: count }, (_, i) => i);
      for (const i of idx) raw.idx.push(base + i);
    }
  };
  const visit = (ni: number, parent: number[]): void => {
    const node = json.nodes?.[ni];
    if (!node) return;
    const m = mulMat(parent, nodeMatrix(node));
    if (node.mesh !== undefined) emitMesh(node.mesh, m);
    for (const c of node.children ?? []) visit(c, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? (json.nodes ? json.nodes.map((_, i) => i) : []);
  if (json.nodes && roots.length) for (const r of roots) visit(r, identity);
  else json.meshes?.forEach((_, i) => emitMesh(i, identity));
  raw.hasNormals = anyNormals;
  return finish(raw, materialId);
}

/** Centre in XY, put the base on z = 0 and scale so the largest extent is 1. */
export function fitToUnit(m: MeshData): MeshData {
  const n = m.positions.length / 3;
  if (n === 0) return m;
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = m.positions[i * 3 + c] as number;
      if (v < lo[c]!) lo[c] = v;
      if (v > hi[c]!) hi[c] = v;
    }
  }
  const ext = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const positions = new Float32Array(m.positions.length);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = ((m.positions[i * 3] as number) - (lo[0] + hi[0]) / 2) / ext;
    positions[i * 3 + 1] = ((m.positions[i * 3 + 1] as number) - (lo[1] + hi[1]) / 2) / ext;
    positions[i * 3 + 2] = ((m.positions[i * 3 + 2] as number) - lo[2]) / ext;
  }
  return { ...m, positions };
}
