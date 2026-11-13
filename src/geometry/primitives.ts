import type { MeshData } from '@/contracts/mesh';
import { buildLeafMesh, FULL_ATLAS, type LeafCard } from './leafMesher';
import type { V3 } from './math3';
import { MeshAccumulator, newVertex } from './meshAccumulator';

/** Built-in primitive library of the Mesh generator (unit size, Z-up, base at the origin). */
export type PrimitiveKind = 'quad' | 'cross' | 'cone' | 'sphere' | 'flower';
export const PRIMITIVE_KINDS: readonly PrimitiveKind[] = ['quad', 'cross', 'cone', 'sphere', 'flower'];

const card = (axis: V3, side: V3, o: V3, length: number, width: number, materialId: string, extra: Partial<LeafCard> = {}): LeafCard => ({
  origin: o,
  axis,
  side,
  length,
  width,
  bend: 0,
  fold: 0,
  curl: 0,
  twist: 0,
  segLength: 1,
  segWidth: 1,
  outline: 'rect',
  color: [1, 1, 1],
  ao: 1,
  atlas: FULL_ATLAS,
  materialId,
  pivot: o,
  wind: [0, 0, 1, 0],
  ...extra,
});

function lathe(profile: readonly [number, number, number, number][], sides: number, materialId: string, capBottom: boolean): MeshData {
  // profile entries: [radius, z, nr, nz] (outward normal in the radius/z plane)
  const acc = new MeshAccumulator();
  acc.beginSlot(materialId);
  const V = sides + 1;
  profile.forEach(([r, z, nr, nz], i) => {
    for (let j = 0; j < V; j++) {
      const a = (2 * Math.PI * (j % sides)) / sides;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const v = newVertex();
      v.px = r * c; v.py = r * s; v.pz = z;
      const nl = Math.hypot(nr, nz) || 1;
      v.nx = (nr / nl) * c; v.ny = (nr / nl) * s; v.nz = nz / nl;
      v.tx = -s; v.ty = c; v.tz = 0;
      v.u = j / sides; v.v = i / (profile.length - 1);
      v.u1 = v.u; v.v1 = v.v;
      acc.addVertex(v);
    }
  });
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < sides; j++) {
      const a0 = i * V + j;
      // Profile rows with r == 0 collapse to a pole: emit a single triangle instead of a degenerate quad.
      const topPole = (profile[i + 1] as readonly number[])[0] === 0;
      const botPole = (profile[i] as readonly number[])[0] === 0;
      if (topPole) acc.addTriangle(a0, a0 + 1, a0 + V);
      else if (botPole) acc.addTriangle(a0 + 1, a0 + V + 1, a0 + V);
      else {
        acc.addTriangle(a0, a0 + 1, a0 + V);
        acc.addTriangle(a0 + 1, a0 + V + 1, a0 + V);
      }
    }
  }
  if (capBottom) {
    const [r, z] = profile[0] as readonly number[];
    const center = newVertex();
    center.pz = z as number; center.nz = -1; center.u = 0.5; center.v = 0.5;
    const c0 = acc.addVertex(center);
    const ring: number[] = [];
    for (let j = 0; j < V; j++) {
      const a = (2 * Math.PI * (j % sides)) / sides;
      const v = newVertex();
      v.px = (r as number) * Math.cos(a); v.py = (r as number) * Math.sin(a); v.pz = z as number;
      v.nz = -1; v.u = 0.5 + 0.5 * Math.cos(a); v.v = 0.5 + 0.5 * Math.sin(a);
      ring.push(acc.addVertex(v));
    }
    for (let j = 0; j < sides; j++) acc.addTriangle(c0, ring[j + 1] as number, ring[j] as number);
  }
  return acc.build(materialId, true);
}

export function buildPrimitive(kind: PrimitiveKind, materialId: string, detail = 1): MeshData {
  const sides = Math.max(4, Math.round(8 * detail));
  switch (kind) {
    case 'quad':
      return buildLeafMesh([card([0, 0, 1], [1, 0, 0], [0, 0, 0], 1, 1, materialId)], { defaultMaterial: materialId });
    case 'cross':
      return buildLeafMesh(
        [card([0, 0, 1], [1, 0, 0], [0, 0, 0], 1, 1, materialId), card([0, 0, 1], [0, 1, 0], [0, 0, 0], 1, 1, materialId)],
        { defaultMaterial: materialId },
      );
    case 'cone': {
      const r = 0.35;
      const slope = r; // normal tilt: (h, r) rotated -> outward normal (1, r/h) for h = 1
      return lathe(
        [
          [r, 0, 1, slope],
          [0, 1, 1, slope],
        ],
        sides,
        materialId,
        true,
      );
    }
    case 'sphere': {
      const rings = Math.max(3, Math.round(6 * detail));
      const pts: [number, number, number, number][] = [];
      for (let i = 0; i <= rings; i++) {
        const phi = -Math.PI / 2 + (i / rings) * Math.PI;
        const r = i === 0 || i === rings ? 0 : 0.5 * Math.cos(phi);
        pts.push([r, 0.5 + 0.5 * Math.sin(phi), Math.cos(phi), Math.sin(phi)]);
      }
      return lathe(pts, sides, materialId, false);
    }
    default: {
      const petals = 5;
      const cards: LeafCard[] = [];
      for (let k = 0; k < petals; k++) {
        const th = (k / petals) * Math.PI * 2;
        const tilt = 0.55;
        const axis: V3 = [Math.cos(th) * Math.cos(tilt), Math.sin(th) * Math.cos(tilt), Math.sin(tilt)];
        const side: V3 = [-Math.sin(th), Math.cos(th), 0];
        cards.push(card(axis, side, [0, 0, 0.05], 0.5, 0.32, materialId, { outline: 'oval', segLength: 3, segWidth: 2, bend: -0.5, curl: 0.15 }));
      }
      return buildLeafMesh(cards, { defaultMaterial: materialId });
    }
  }
}
