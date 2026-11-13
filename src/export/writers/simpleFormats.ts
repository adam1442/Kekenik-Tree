import type { PlantGeometry } from '../geometry';
import type { ExportFile } from '../types';

/** OBJ + MTL, binary PLY and binary STL writers (DOM-free). */

export interface ObjMaterial {
  name: string;
  diffuse: [number, number, number];
  specular: [number, number, number];
  /** 0..1000 shininess derived from gloss. */
  shininess: number;
  opacity: number;
  /** File names inside the export (relative to the OBJ). */
  mapKd?: string;
  mapD?: string;
  mapBump?: string;
  mapKs?: string;
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]+/g, '_') || 'material';

const f = (n: number): string => (Math.abs(n) < 1e-9 ? '0' : Number(n.toFixed(6)).toString());

export interface ObjResult {
  files: ExportFile[];
}

/** Wavefront OBJ: positions, UVs (v up, as authored), normals; optional `v x y z r g b` colours; one `o` per geometry. */
export function writeObj(baseName: string, geometries: readonly PlantGeometry[], materials: ReadonlyMap<string, ObjMaterial>, vertexColors: boolean): ObjResult {
  const lines: string[] = [`# Kekenik Tree OBJ export`, `mtllib ${baseName}.mtl`];
  let offset = 1;
  const used = new Map<string, ObjMaterial>();
  for (const g of geometries) {
    lines.push(`o ${safeName(g.name)}`);
    const n = g.positions.length / 3;
    const colors = vertexColors ? g.colors : undefined;
    for (let i = 0; i < n; i++) {
      const base = `v ${f(g.positions[i * 3] as number)} ${f(g.positions[i * 3 + 1] as number)} ${f(g.positions[i * 3 + 2] as number)}`;
      lines.push(colors ? `${base} ${f(colors[i * 4] as number)} ${f(colors[i * 4 + 1] as number)} ${f(colors[i * 4 + 2] as number)}` : base);
    }
    for (let i = 0; i < n; i++) lines.push(`vt ${f(g.uv0[i * 2] as number)} ${f(g.uv0[i * 2 + 1] as number)}`);
    for (let i = 0; i < n; i++) lines.push(`vn ${f(g.normals[i * 3] as number)} ${f(g.normals[i * 3 + 1] as number)} ${f(g.normals[i * 3 + 2] as number)}`);
    for (const p of g.primitives) {
      const mat = materials.get(p.materialId);
      const name = mat ? safeName(mat.name) : 'default';
      if (mat) used.set(name, mat);
      lines.push(`usemtl ${name}`);
      for (let i = 0; i + 2 < p.indices.length; i += 3) {
        const a = (p.indices[i] as number) + offset;
        const b = (p.indices[i + 1] as number) + offset;
        const c = (p.indices[i + 2] as number) + offset;
        lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
      }
    }
    offset += n;
  }
  const mtl: string[] = ['# Kekenik Tree MTL export'];
  if (!used.has('default')) mtl.push('newmtl default', 'Kd 0.8 0.8 0.8', 'illum 1', '');
  for (const [name, m] of used) {
    mtl.push(`newmtl ${name}`, `Ka 1 1 1`, `Kd ${m.diffuse.map(f).join(' ')}`, `Ks ${m.specular.map(f).join(' ')}`, `Ns ${f(m.shininess)}`, `d ${f(m.opacity)}`, 'illum 2');
    if (m.mapKd) mtl.push(`map_Kd ${m.mapKd}`);
    if (m.mapD) mtl.push(`map_d ${m.mapD}`);
    if (m.mapBump) mtl.push(`map_Bump ${m.mapBump}`);
    if (m.mapKs) mtl.push(`map_Ks ${m.mapKs}`);
    mtl.push('');
  }
  return {
    files: [
      { name: `${baseName}.obj`, data: `${lines.join('\n')}\n`, mime: 'text/plain' },
      { name: `${baseName}.mtl`, data: `${mtl.join('\n')}\n`, mime: 'text/plain' },
    ],
  };
}

/** Binary little-endian PLY with normals, UVs, colours and a per-face `material_index` (index into the sorted material list). */
export function writePly(baseName: string, geometries: readonly PlantGeometry[]): ExportFile {
  const vertexTotal = geometries.reduce((s, g) => s + g.positions.length / 3, 0);
  const faceTotal = geometries.reduce((s, g) => s + g.primitives.reduce((a, p) => a + p.indices.length / 3, 0), 0);
  const materialIds = [...new Set(geometries.flatMap((g) => g.primitives.map((p) => p.materialId)))];
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    `comment Kekenik Tree; material_index order: ${materialIds.join(', ')}`,
    `element vertex ${vertexTotal}`,
    'property float x',
    'property float y',
    'property float z',
    'property float nx',
    'property float ny',
    'property float nz',
    'property float s',
    'property float t',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'property uchar alpha',
    `element face ${faceTotal}`,
    'property list uchar int vertex_indices',
    'property int material_index',
    'end_header',
    '',
  ].join('\n');
  const head = new TextEncoder().encode(header);
  const vSize = 3 * 4 + 3 * 4 + 2 * 4 + 4;
  const fSize = 1 + 3 * 4 + 4;
  const out = new Uint8Array(head.length + vertexTotal * vSize + faceTotal * fSize);
  out.set(head);
  const dv = new DataView(out.buffer);
  let o = head.length;
  const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  for (const g of geometries) {
    for (let i = 0; i < g.positions.length / 3; i++) {
      for (let k = 0; k < 3; k++) dv.setFloat32(o + k * 4, g.positions[i * 3 + k] as number, true);
      for (let k = 0; k < 3; k++) dv.setFloat32(o + 12 + k * 4, g.normals[i * 3 + k] as number, true);
      dv.setFloat32(o + 24, g.uv0[i * 2] as number, true);
      dv.setFloat32(o + 28, g.uv0[i * 2 + 1] as number, true);
      for (let k = 0; k < 4; k++) dv.setUint8(o + 32 + k, g.colors ? byte(g.colors[i * 4 + k] as number) : 255);
      o += vSize;
    }
  }
  let base = 0;
  for (const g of geometries) {
    for (const p of g.primitives) {
      const mi = materialIds.indexOf(p.materialId);
      for (let i = 0; i + 2 < p.indices.length; i += 3) {
        dv.setUint8(o, 3);
        for (let k = 0; k < 3; k++) dv.setInt32(o + 1 + k * 4, (p.indices[i + k] as number) + base, true);
        dv.setInt32(o + 13, mi, true);
        o += fSize;
      }
    }
    base += g.positions.length / 3;
  }
  return { name: `${baseName}.ply`, data: out, mime: 'application/octet-stream' };
}

/** Binary STL (geometry only: no materials, UVs or colours). */
export function writeStl(baseName: string, geometries: readonly PlantGeometry[]): ExportFile {
  const faces = geometries.reduce((s, g) => s + g.primitives.reduce((a, p) => a + p.indices.length / 3, 0), 0);
  const out = new Uint8Array(84 + faces * 50);
  out.set(new TextEncoder().encode('Kekenik Tree binary STL'.padEnd(80, ' ')));
  const dv = new DataView(out.buffer);
  dv.setUint32(80, faces, true);
  let o = 84;
  for (const g of geometries) {
    const P = g.positions;
    for (const p of g.primitives) {
      for (let i = 0; i + 2 < p.indices.length; i += 3) {
        const a = (p.indices[i] as number) * 3;
        const b = (p.indices[i + 1] as number) * 3;
        const c = (p.indices[i + 2] as number) * 3;
        const ux = (P[b] as number) - (P[a] as number);
        const uy = (P[b + 1] as number) - (P[a + 1] as number);
        const uz = (P[b + 2] as number) - (P[a + 2] as number);
        const vx = (P[c] as number) - (P[a] as number);
        const vy = (P[c + 1] as number) - (P[a + 1] as number);
        const vz = (P[c + 2] as number) - (P[a + 2] as number);
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        dv.setFloat32(o, nx, true);
        dv.setFloat32(o + 4, ny, true);
        dv.setFloat32(o + 8, nz, true);
        [a, b, c].forEach((v, k) => {
          for (let d = 0; d < 3; d++) dv.setFloat32(o + 12 + k * 12 + d * 4, P[v + d] as number, true);
        });
        o += 50;
      }
    }
  }
  return { name: `${baseName}.stl`, data: out, mime: 'model/stl' };
}
