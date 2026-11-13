import type { PlantGeometry } from '../geometry';
import type { ImpostorSettings } from '../types';

/** Pure impostor math: frame layout, camera directions and the billboard meshes (source space: Z-up, right-handed). */

export interface ImpostorFrame {
  index: number;
  /** Camera azimuth in degrees (0 = camera on +X looking at the plant, counter-clockwise seen from above). */
  azimuthDeg: number;
  /** 0 = horizontal, 90 = top-down. */
  elevationDeg: number;
  /** Pixel rectangle in the atlas, origin top-left: x, y, w, h. */
  rect: [number, number, number, number];
}

export interface ImpostorLayout {
  cols: number;
  rows: number;
  frameSize: number;
  frames: ImpostorFrame[];
}

export function computeLayout(settings: Pick<ImpostorSettings, 'views' | 'topView' | 'frameSize'>): ImpostorLayout {
  const total = settings.views + (settings.topView ? 1 : 0);
  const cols = Math.min(total, 4);
  const rows = Math.ceil(total / cols);
  const frames: ImpostorFrame[] = [];
  for (let i = 0; i < total; i++) {
    const top = settings.topView && i === total - 1;
    frames.push({
      index: i,
      azimuthDeg: top ? 0 : (360 * i) / settings.views,
      elevationDeg: top ? 90 : 0,
      rect: [(i % cols) * settings.frameSize, Math.floor(i / cols) * settings.frameSize, settings.frameSize, settings.frameSize],
    });
  }
  return { cols, rows, frameSize: settings.frameSize, frames };
}

/** Unit vector from the plant towards the camera. */
export function viewDirection(azimuthDeg: number, elevationDeg: number): [number, number, number] {
  const a = (azimuthDeg * Math.PI) / 180;
  const e = (elevationDeg * Math.PI) / 180;
  return [Math.cos(a) * Math.cos(e), Math.sin(a) * Math.cos(e), Math.sin(e)];
}

/** KHR_texture_transform of one frame inside the atlas (glTF UVs have a top-left origin). */
export function frameTransform(layout: ImpostorLayout, frame: ImpostorFrame): { offset: [number, number]; scale: [number, number] } {
  const w = layout.cols * layout.frameSize;
  const h = layout.rows * layout.frameSize;
  return { offset: [frame.rect[0] / w, frame.rect[1] / h], scale: [frame.rect[2] / w, frame.rect[3] / h] };
}

/** Index of the horizontal frame closest to an azimuth. */
export function nearestFrame(layout: ImpostorLayout, azimuthDeg: number): ImpostorFrame {
  let best = layout.frames[0] as ImpostorFrame;
  let bestD = Infinity;
  for (const f of layout.frames) {
    if (f.elevationDeg !== 0) continue;
    const d = Math.abs((((f.azimuthDeg - azimuthDeg) % 360) + 540) % 360 - 180);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

/**
 * Billboard quad facing the camera direction at `azimuthDeg`, centred on `center`, spanning +-radius.
 * UV (0,0) is the bottom-left of the image as seen by the camera (Kekenik convention: v up).
 */
export function billboardQuad(name: string, materialId: string, center: readonly [number, number, number], radius: number, azimuthDeg: number): PlantGeometry {
  const a = (azimuthDeg * Math.PI) / 180;
  const nx = Math.cos(a);
  const ny = Math.sin(a);
  const rx = -Math.sin(a);
  const ry = Math.cos(a);
  const corners: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const positions = new Float32Array(12);
  const normals = new Float32Array(12);
  const uv0 = new Float32Array(8);
  corners.forEach(([sx, sz], i) => {
    positions[i * 3] = center[0] + rx * radius * sx;
    positions[i * 3 + 1] = center[1] + ry * radius * sx;
    positions[i * 3 + 2] = center[2] + radius * sz;
    normals[i * 3] = nx;
    normals[i * 3 + 1] = ny;
    normals[i * 3 + 2] = 0;
    uv0[i * 2] = (sx + 1) / 2;
    uv0[i * 2 + 1] = (sz + 1) / 2;
  });
  return { name, positions, normals, uv0, primitives: [{ materialId, indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) }] };
}

/** Merge several billboard geometries (each with its own material id) into one. */
export function mergeBillboards(name: string, quads: readonly PlantGeometry[]): PlantGeometry {
  const positions = new Float32Array(quads.length * 12);
  const normals = new Float32Array(quads.length * 12);
  const uv0 = new Float32Array(quads.length * 8);
  const primitives: PlantGeometry['primitives'] = [];
  quads.forEach((q, i) => {
    positions.set(q.positions, i * 12);
    normals.set(q.normals, i * 12);
    uv0.set(q.uv0, i * 8);
    const p = q.primitives[0];
    if (p) primitives.push({ materialId: p.materialId, indices: p.indices.map((v) => v + i * 4) });
  });
  return { name, positions, normals, uv0, primitives };
}
