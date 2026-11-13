import type { CutoutLodVariant, CutoutMesh, LodLevel } from '@/contracts/material';
import { rebuildCutoutLods } from './lod';

export interface CutoutPreviewCamera {
  yaw: number;
  pitch: number;
  panX: number;
  panY: number;
  zoom: number;
}

export function defaultCutoutPreviewCamera(): CutoutPreviewCamera {
  return {
    yaw: -0.42,
    pitch: 0.92,
    panX: 0,
    panY: 0.04,
    zoom: 1,
  };
}

export interface RenderCutout3DOptions {
  lod?: LodLevel;
  camera?: CutoutPreviewCamera;
  showAlignment?: boolean;
  showAnchors?: boolean;
}

/**
 * Render a 3D perspective preview of a `CutoutMesh` LOD onto a 2D HTMLCanvasElement (transparent background over CSS checkerboard).
 * Look of the Meshes panel & Edit Mesh LOD preview: white shaded surface with subtle leaf contour lines,
 * crisp dark wireframe edges, RGB pivot axis gizmo, and bright green anchor markers.
 */
export function renderCutout3DPreview(
  canvas: HTMLCanvasElement,
  cutout: CutoutMesh,
  cssWidth: number,
  cssHeight: number,
  opts: RenderCutout3DOptions = {},
): void {
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  const W = Math.max(1, Math.round(cssWidth));
  const H = Math.max(1, Math.round(cssHeight));
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d');
  if (!g) return;

  g.save();
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);

  if (!cutout.lods || !cutout.lods.high) {
    rebuildCutoutLods(cutout);
  }
  const level: LodLevel = opts.lod ?? 'high';
  const variant: CutoutLodVariant = cutout.lods[level] ?? cutout.lods.high;
  const cam = opts.camera ?? defaultCutoutPreviewCamera();
  const showAlignment = opts.showAlignment ?? true;
  const showAnchors = opts.showAnchors ?? true;

  const cosY = Math.cos(cam.yaw);
  const sinY = Math.sin(cam.yaw);
  const cosP = Math.cos(cam.pitch);
  const sinP = Math.sin(cam.pitch);

  const scalePx = Math.min(W, H) * 0.72 * Math.max(0.25, cam.zoom);
  const cx = W * (0.5 + cam.panX);
  const cy = H * (0.54 + cam.panY);

  // Project a 3D point (x in [-0.5..0.5], y in [-0.5..0.5], z in [-0.5..0.5]) to 2D canvas coordinates
  const project = (x: number, y: number, z: number): [number, number, number] => {
    // Rotate around Z (yaw)
    const x1 = x * cosY - y * sinY;
    const y1 = x * sinY + y * cosY;
    const z1 = z;
    // Tilt around X (pitch)
    const y2 = y1 * cosP - z1 * sinP;
    const z2 = y1 * sinP + z1 * cosP;
    const fov = 2.6 / Math.max(0.6, 2.6 - z2 * 0.65);
    return [cx + x1 * scalePx * fov, cy - y2 * scalePx * fov, z2];
  };

  // Build 3D vertex list centered around (0.5, 0.5, 0)
  const pts3d: [number, number, number][] = [];
  const projPts: [number, number, number][] = [];
  let triIndices: number[];

  if (variant.importedMesh && variant.importedMesh.positions.length >= 9) {
    const pos = variant.importedMesh.positions;
    const nv = Math.floor(pos.length / 3);
    for (let i = 0; i < nv; i++) {
      const px = pos[i * 3] as number;
      const py = (pos[i * 3 + 1] as number) - 0.35;
      const pz = (pos[i * 3 + 2] as number) * 0.5;
      pts3d.push([px, py, pz]);
      projPts.push(project(px, py, pz));
    }
    triIndices = variant.importedMesh.indices;
  } else {
    const nv = Math.floor(variant.vertices.length / 2);
    for (let i = 0; i < nv; i++) {
      const u = variant.vertices[i * 2] as number;
      const v = variant.vertices[i * 2 + 1] as number;
      const px = u - 0.5;
      const py = v - 0.5;
      const pz = 0;
      pts3d.push([px, py, pz]);
      projPts.push(project(px, py, pz));
    }
    triIndices = variant.indices;
  }

  // Sort triangles back-to-front by average Z
  const faces: { i0: number; i1: number; i2: number; z: number }[] = [];
  for (let t = 0; t + 2 < triIndices.length; t += 3) {
    const i0 = triIndices[t] as number;
    const i1 = triIndices[t + 1] as number;
    const i2 = triIndices[t + 2] as number;
    const p0 = projPts[i0];
    const p1 = projPts[i1];
    const p2 = projPts[i2];
    if (!p0 || !p1 || !p2) continue;
    faces.push({ i0, i1, i2, z: (p0[2] + p1[2] + p2[2]) / 3 });
  }
  faces.sort((a, b) => a.z - b.z);

  // Draw shaded triangles
  for (const f of faces) {
    const p0 = projPts[f.i0] as [number, number, number];
    const p1 = projPts[f.i1] as [number, number, number];
    const p2 = projPts[f.i2] as [number, number, number];
    g.beginPath();
    g.moveTo(p0[0], p0[1]);
    g.lineTo(p1[0], p1[1]);
    g.lineTo(p2[0], p2[1]);
    g.closePath();
    g.fillStyle = '#f2f2f2';
    g.fill();
  }

  // Draw subtle grey botanical vein / contour lines inside the mesh clip region
  if (!variant.importedMesh && faces.length > 0) {
    g.save();
    g.beginPath();
    for (const f of faces) {
      const p0 = projPts[f.i0] as [number, number, number];
      const p1 = projPts[f.i1] as [number, number, number];
      const p2 = projPts[f.i2] as [number, number, number];
      g.moveTo(p0[0], p0[1]);
      g.lineTo(p1[0], p1[1]);
      g.lineTo(p2[0], p2[1]);
      g.closePath();
    }
    g.clip();

    g.strokeStyle = 'rgba(130, 130, 130, 0.55)';
    g.lineWidth = 1;
    const veins: [number, number][][] = [
      [[-0.02, -0.46], [0, -0.1], [0.02, 0.42]],
      [[0, -0.22], [-0.28, -0.02], [-0.38, 0.08]],
      [[0, -0.12], [0.26, 0.05], [0.38, 0.16]],
      [[0.01, 0.06], [-0.22, 0.24], [-0.30, 0.34]],
      [[0.01, 0.12], [0.22, 0.28], [0.30, 0.36]],
    ];
    for (const vLine of veins) {
      g.beginPath();
      vLine.forEach(([vx, vy], idx) => {
        const [sx, sy] = project(vx, vy, 0.001);
        if (idx === 0) g.moveTo(sx, sy);
        else g.lineTo(sx, sy);
      });
      g.stroke();
    }
    g.restore();
  }

  // Draw crisp dark wireframe edges
  g.strokeStyle = '#141414';
  g.lineWidth = 1.15;
  for (const f of faces) {
    const p0 = projPts[f.i0] as [number, number, number];
    const p1 = projPts[f.i1] as [number, number, number];
    const p2 = projPts[f.i2] as [number, number, number];
    g.beginPath();
    g.moveTo(p0[0], p0[1]);
    g.lineTo(p1[0], p1[1]);
    g.lineTo(p2[0], p2[1]);
    g.closePath();
    g.stroke();
  }

  // Draw green anchor markers on the mesh surface
  if (showAnchors && cutout.anchors.length > 0) {
    const r = Math.max(3.5, Math.min(6, Math.min(W, H) * 0.038));
    for (const anc of cutout.anchors) {
      const ax = anc.uv[0] - 0.5;
      const ay = anc.uv[1] - 0.5;
      const [sx, sy] = project(ax, ay, 0.01);
      const grad = g.createRadialGradient(sx - r * 0.25, sy - r * 0.25, r * 0.1, sx, sy, r * 1.25);
      grad.addColorStop(0, '#7dff59');
      grad.addColorStop(0.65, '#14d800');
      grad.addColorStop(1, 'rgba(16, 180, 0, 0.15)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(sx, sy, r * 1.2, 0, Math.PI * 2);
      g.fill();
    }
  }

  // Draw RGB axis gizmo at the pivot when Alignment is enabled
  if (showAlignment) {
    const px = (cutout.pivot?.[0] ?? 0.5) - 0.5;
    const py = (cutout.pivot?.[1] ?? 0) - 0.5;
    const origin2d = project(px, py, 0);
    const axisLen = 0.28;
    const xEnd = project(px + axisLen, py, 0);
    const yEnd = project(px, py + axisLen, 0);
    const zEnd = project(px, py, axisLen * 0.85);

    g.lineWidth = 1.4;
    // X axis (red)
    g.strokeStyle = '#e03e2d';
    g.beginPath();
    g.moveTo(origin2d[0], origin2d[1]);
    g.lineTo(xEnd[0], xEnd[1]);
    g.stroke();

    // Y axis (green)
    g.strokeStyle = '#2ecc40';
    g.beginPath();
    g.moveTo(origin2d[0], origin2d[1]);
    g.lineTo(yEnd[0], yEnd[1]);
    g.stroke();

    // Z axis (blue)
    g.strokeStyle = '#2d7ff9';
    g.beginPath();
    g.moveTo(origin2d[0], origin2d[1]);
    g.lineTo(zEnd[0], zEnd[1]);
    g.stroke();
  }

  g.restore();
}

/**
 * Render a 2D cutout thumbnail (cyan polygon + triangulation over dark background) for the Materials > Cutouts/Meshes tab.
 */
export function renderCutout2DThumbnail(
  canvas: HTMLCanvasElement,
  cutout: CutoutMesh,
  cssWidth = 96,
  cssHeight = 96,
): void {
  const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));
  const g = canvas.getContext('2d');
  if (!g) return;
  g.save();
  g.scale(dpr, dpr);

  const pad = 8;
  const w = cssWidth - pad * 2;
  const h = cssHeight - pad * 2;
  const toX = (u: number): number => pad + u * w;
  const toY = (v: number): number => pad + (1 - v) * h;

  g.fillStyle = 'rgba(0, 0, 0, 0.55)';
  g.fillRect(pad, pad, w, h);

  if (!cutout.lods || !cutout.lods.high) rebuildCutoutLods(cutout);
  const high = cutout.lods.high;

  // Cyan triangulation
  g.strokeStyle = '#00e8ff';
  g.lineWidth = 1.25;
  for (let t = 0; t + 2 < high.indices.length; t += 3) {
    const i0 = high.indices[t] as number;
    const i1 = high.indices[t + 1] as number;
    const i2 = high.indices[t + 2] as number;
    g.beginPath();
    g.moveTo(toX(high.vertices[i0 * 2] as number), toY(high.vertices[i0 * 2 + 1] as number));
    g.lineTo(toX(high.vertices[i1 * 2] as number), toY(high.vertices[i1 * 2 + 1] as number));
    g.lineTo(toX(high.vertices[i2 * 2] as number), toY(high.vertices[i2 * 2 + 1] as number));
    g.closePath();
    g.stroke();
  }

  // Orange straighten axis
  if (cutout.straightenAxis.length >= 2) {
    g.strokeStyle = '#f08a1c';
    g.lineWidth = 1.2;
    g.beginPath();
    cutout.straightenAxis.forEach(([u, v], idx) => {
      if (idx === 0) g.moveTo(toX(u), toY(v));
      else g.lineTo(toX(u), toY(v));
    });
    g.stroke();
  }

  // Red vertices
  g.fillStyle = '#d63022';
  const nv = Math.floor(high.vertices.length / 2);
  for (let i = 0; i < nv; i++) {
    const x = toX(high.vertices[i * 2] as number);
    const y = toY(high.vertices[i * 2 + 1] as number);
    g.beginPath();
    g.arc(x, y, 2.5, 0, Math.PI * 2);
    g.fill();
  }

  g.restore();
}
