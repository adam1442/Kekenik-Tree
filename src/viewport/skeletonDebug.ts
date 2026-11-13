import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Points,
  type ShaderMaterial,
  Vector3,
} from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Skeleton } from '@/contracts/skeleton';
import { buildSkeletonSegments } from './debug/debugBuffers';
import { createRoundPointMaterial } from './debug/roundPoints';
import { createThickMaterial, thickGeometryFromSegments } from './thickLines';

/** Linear-RGB palette indexed by branch generation (0 = Trunk/Root, 1 = Primary, 2 = Secondary, ...). */
export const GENERATION_PALETTE: readonly [number, number, number][] = [
  [1.0, 0.56, 0.12], // Gen 0: Amber / Gold
  [0.14, 0.76, 0.98], // Gen 1: Sky Cyan
  [0.2, 0.86, 0.44], // Gen 2: Emerald Green
  [0.75, 0.42, 1.0], // Gen 3: Orchid Violet
  [1.0, 0.36, 0.52], // Gen 4: Coral Rose
  [1.0, 0.88, 0.28], // Gen 5+: Warm Yellow
];

export function generationColor(generation: number): [number, number, number] {
  const idx = Math.max(0, Math.min(GENERATION_PALETTE.length - 1, generation));
  return GENERATION_PALETTE[idx]!;
}

export interface SkeletonDebugVisibility {
  showLines: boolean;
  showPoints: boolean;
  showRadii: boolean;
  showFrames: boolean;
}

export interface SkeletonDebugMaterials {
  readonly lineMat: LineMaterial;
  readonly highlightLineMat: LineMaterial;
  readonly pointMat: ShaderMaterial;
  readonly radiusMat: LineMaterial;
  readonly frameMat: LineMaterial;
  dispose(): void;
}

export function createSkeletonDebugMaterials(): SkeletonDebugMaterials {
  // Screen-space thick lines: constant, anti-aliased pixel width at any zoom.
  const lineMat = createThickMaterial({ color: 0xffffff, width: 1.5, vertexColors: true });
  const highlightLineMat = createThickMaterial({ color: 0xfff066, width: 2.5, opacity: 0.95, depthTest: false });
  const pointMat = createRoundPointMaterial({ size: 5, vertexColors: true });
  const radiusMat = createThickMaterial({ color: 0xffffff, width: 1, opacity: 0.78, vertexColors: true });
  const frameMat = createThickMaterial({ color: 0xffffff, width: 1.25, opacity: 0.92, vertexColors: true });

  return {
    lineMat,
    highlightLineMat,
    pointMat,
    radiusMat,
    frameMat,
    dispose(): void {
      lineMat.dispose();
      highlightLineMat.dispose();
      pointMat.dispose();
      radiusMat.dispose();
      frameMat.dispose();
    },
  };
}

export interface SkeletonDebugPiece {
  readonly group: Group;
  readonly lines: LineSegments2;
  readonly highlightLines: LineSegments2;
  readonly points: Points;
  readonly radii: LineSegments2;
  readonly frames: LineSegments2;
  readonly bounds: Box3;
  rev: string;
  applyVisibility(vis: SkeletonDebugVisibility, selected: boolean): void;
  dispose(): void;
}

type V3 = [number, number, number];

function norm3(x: number, y: number, z: number): V3 {
  const l = Math.hypot(x, y, z);
  if (l < 1e-8) return [0, 0, 1];
  return [x / l, y / l, z / l];
}

function cross3(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function pointFrame(
  sk: Skeleton,
  i: number,
  nxArr: Float32Array | undefined,
  nyArr: Float32Array | undefined,
  nzArr: Float32Array | undefined,
): { T: V3; N: V3; B: V3 } {
  const T = norm3(
    sk.tangent[i * 3] as number,
    sk.tangent[i * 3 + 1] as number,
    sk.tangent[i * 3 + 2] as number,
  );
  let N: V3;
  if (nxArr && nyArr && nzArr && i < nxArr.length) {
    const rx = nxArr[i] as number;
    const ry = nyArr[i] as number;
    const rz = nzArr[i] as number;
    const dot = rx * T[0] + ry * T[1] + rz * T[2];
    const px = rx - T[0] * dot;
    const py = ry - T[1] * dot;
    const pz = rz - T[2] * dot;
    const pl = Math.hypot(px, py, pz);
    N = pl > 1e-4 ? [px / pl, py / pl, pz / pl] : norm3(...cross3(T, Math.abs(T[0]) < 0.85 ? [1, 0, 0] : [0, 1, 0]));
  } else {
    N = norm3(...cross3(T, Math.abs(T[0]) < 0.85 ? [1, 0, 0] : [0, 1, 0]));
  }
  const B = norm3(...cross3(T, N));
  return { T, N, B };
}

const CIRCLE_SIDES = 16;
const COS_TAB = Float32Array.from({ length: CIRCLE_SIDES + 1 }, (_, j) => Math.cos((j / CIRCLE_SIDES) * Math.PI * 2));
const SIN_TAB = Float32Array.from({ length: CIRCLE_SIDES + 1 }, (_, j) => Math.sin((j / CIRCLE_SIDES) * Math.PI * 2));

/**
 * Builds a complete debug visualization piece for a single node's `Skeleton`:
 * - Generation-colored branch centerline segments
 * - Sample joint points
 * - Cross-sectional radius circles
 * - RMF Normal (Red), Binormal (Green), Tangent (Blue) frame triads
 */
export function buildSkeletonDebugPiece(
  nodeId: string,
  sk: Skeleton,
  rev: string,
  mats: SkeletonDebugMaterials,
): SkeletonDebugPiece {
  const bounds = new Box3();
  const tmpV = new Vector3();

  // 1. Centre-line segments per branch (consecutive points of the same branch only), coloured by generation.
  const seg = buildSkeletonSegments(sk, generationColor);
  const linePos = seg.positions;
  const lineCol = seg.colors;

  const lineGeo = new BufferGeometry();
  lineGeo.setAttribute('position', new Float32BufferAttribute(linePos, 3));
  lineGeo.setAttribute('color', new Float32BufferAttribute(lineCol, 3));

  // 2. Sample points colored by generation
  const ptPos = new Float32Array(sk.count * 3);
  const ptCol = new Float32Array(sk.count * 3);
  for (let i = 0; i < sk.count; i++) {
    const px = sk.position[i * 3] as number;
    const py = sk.position[i * 3 + 1] as number;
    const pz = sk.position[i * 3 + 2] as number;
    ptPos[i * 3] = px;
    ptPos[i * 3 + 1] = py;
    ptPos[i * 3 + 2] = pz;
    bounds.expandByPoint(tmpV.set(px, py, pz));
    const [cr, cg, cb] = generationColor(sk.generation[i] as number);
    ptCol[i * 3] = cr;
    ptCol[i * 3 + 1] = cg;
    ptCol[i * 3 + 2] = cb;
  }
  const ptGeo = new BufferGeometry();
  ptGeo.setAttribute('position', new Float32BufferAttribute(ptPos, 3));
  ptGeo.setAttribute('color', new Float32BufferAttribute(ptCol, 3));

  // 3. Radius circles & 4. Normal/Binormal/Tangent frames (stride interior points if very dense to keep 60fps)
  const nxArr = sk.attributes.get('rmfNormalX');
  const nyArr = sk.attributes.get('rmfNormalY');
  const nzArr = sk.attributes.get('rmfNormalZ');
  const stride = sk.count > 6000 ? Math.ceil(sk.count / 3000) : 1;

  const sampledIndices: { idx: number; branchLen: number }[] = [];
  for (const b of sk.branches) {
    if (b.count === 0) continue;
    // Skip hair-thin 1mm foliage card placeholder stubs so circles/frames stay clean on structural branches
    if ((sk.radius[b.start] as number) <= 0.0015 && b.count <= 2) continue;
    for (let k = 0; k < b.count; k++) {
      if (k === 0 || k === b.count - 1 || k % stride === 0) {
        sampledIndices.push({ idx: b.start + k, branchLen: b.length });
      }
    }
  }

  const circleSegTotal = sampledIndices.length * CIRCLE_SIDES;
  const radPos = new Float32Array(circleSegTotal * 6);
  const radCol = new Float32Array(circleSegTotal * 6);

  const frameSegTotal = sampledIndices.length * 3; // T, N, B axes per sampled point
  const frmPos = new Float32Array(frameSegTotal * 6);
  const frmCol = new Float32Array(frameSegTotal * 6);

  let radCursor = 0;
  let frmCursor = 0;

  for (const { idx, branchLen } of sampledIndices) {
    const px = sk.position[idx * 3] as number;
    const py = sk.position[idx * 3 + 1] as number;
    const pz = sk.position[idx * 3 + 2] as number;
    const r = Math.max(0.001, sk.radius[idx] as number);
    const { T, N, B } = pointFrame(sk, idx, nxArr, nyArr, nzArr);
    const [cr, cg, cb] = generationColor(sk.generation[idx] as number);

    // Circle segments in (N, B) plane
    for (let j = 0; j < CIRCLE_SIDES; j++) {
      const c0 = COS_TAB[j] as number;
      const s0 = SIN_TAB[j] as number;
      const c1 = COS_TAB[j + 1] as number;
      const s1 = SIN_TAB[j + 1] as number;
      const base = radCursor * 6;
      radPos[base] = px + (N[0] * c0 + B[0] * s0) * r;
      radPos[base + 1] = py + (N[1] * c0 + B[1] * s0) * r;
      radPos[base + 2] = pz + (N[2] * c0 + B[2] * s0) * r;
      radPos[base + 3] = px + (N[0] * c1 + B[0] * s1) * r;
      radPos[base + 4] = py + (N[1] * c1 + B[1] * s1) * r;
      radPos[base + 5] = pz + (N[2] * c1 + B[2] * s1) * r;

      radCol[base] = cr * 0.85;
      radCol[base + 1] = cg * 0.85;
      radCol[base + 2] = cb * 0.85;
      radCol[base + 3] = cr * 0.85;
      radCol[base + 4] = cg * 0.85;
      radCol[base + 5] = cb * 0.85;
      radCursor += 1;
    }

    // Frame triad: N = Red, B = Green, T = Blue
    const axisLen = Math.min(0.45, Math.max(0.035, r * 1.8, branchLen * 0.04));
    const writeAxis = (axis: V3, ar: number, ag: number, ab: number): void => {
      const base = frmCursor * 6;
      frmPos[base] = px;
      frmPos[base + 1] = py;
      frmPos[base + 2] = pz;
      frmPos[base + 3] = px + axis[0] * axisLen;
      frmPos[base + 4] = py + axis[1] * axisLen;
      frmPos[base + 5] = pz + axis[2] * axisLen;
      frmCol[base] = ar;
      frmCol[base + 1] = ag;
      frmCol[base + 2] = ab;
      frmCol[base + 3] = ar;
      frmCol[base + 4] = ag;
      frmCol[base + 5] = ab;
      frmCursor += 1;
    };
    writeAxis(N, 1.0, 0.28, 0.28); // Normal = Red
    writeAxis(B, 0.24, 0.9, 0.42); // Binormal = Green
    writeAxis(T, 0.28, 0.62, 1.0); // Tangent = Blue
  }

  const radGeo = new BufferGeometry();
  radGeo.setAttribute('position', new Float32BufferAttribute(radPos, 3));
  radGeo.setAttribute('color', new Float32BufferAttribute(radCol, 3));

  const frmGeo = new BufferGeometry();
  frmGeo.setAttribute('position', new Float32BufferAttribute(frmPos, 3));
  frmGeo.setAttribute('color', new Float32BufferAttribute(frmCol, 3));

  const thickLineGeo = thickGeometryFromSegments(lineGeo);
  const thickRadGeo = thickGeometryFromSegments(radGeo);
  const thickFrmGeo = thickGeometryFromSegments(frmGeo);
  const lines = new LineSegments2(thickLineGeo, mats.lineMat);
  lines.frustumCulled = false;
  lines.userData.nodeId = nodeId;
  lines.renderOrder = 3;

  const highlightLines = new LineSegments2(thickLineGeo, mats.highlightLineMat);
  highlightLines.userData.nodeId = nodeId;
  highlightLines.userData.isOverlay = true;
  highlightLines.frustumCulled = false;
  highlightLines.renderOrder = 5;
  highlightLines.visible = false;

  const points = new Points(ptGeo, mats.pointMat);
  points.frustumCulled = false;
  points.userData.nodeId = nodeId;
  points.renderOrder = 4;

  const radii = new LineSegments2(thickRadGeo, mats.radiusMat);
  radii.frustumCulled = false;
  radii.userData.nodeId = nodeId;
  radii.renderOrder = 3;

  const frames = new LineSegments2(thickFrmGeo, mats.frameMat);
  frames.frustumCulled = false;
  frames.userData.nodeId = nodeId;
  frames.renderOrder = 4;

  const group = new Group();
  group.userData.nodeId = nodeId;
  group.add(lines, highlightLines, points, radii, frames);

  return {
    group,
    lines,
    highlightLines,
    points,
    radii,
    frames,
    bounds,
    rev,
    applyVisibility(vis: SkeletonDebugVisibility, selected: boolean): void {
      lines.visible = vis.showLines;
      highlightLines.visible = selected && vis.showLines;
      points.visible = vis.showPoints;
      radii.visible = vis.showRadii;
      frames.visible = vis.showFrames;
    },
    dispose(): void {
      group.removeFromParent();
      lineGeo.dispose();
      thickLineGeo.dispose();
      thickRadGeo.dispose();
      thickFrmGeo.dispose();
      ptGeo.dispose();
      radGeo.dispose();
      frmGeo.dispose();
    },
  };
}
