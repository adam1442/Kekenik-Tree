import type { ForceDef } from '@/contracts/material';
import type { MeshData } from '@/contracts/mesh';
import { buildLeafMesh, type LeafCard } from '@/geometry/leafMesher';
import type { V3 } from '@/geometry/math3';
import type { Rng } from '@/core/rng';
import { seasonWindOffset } from '@/seasons';

/**
 * Dropped leaves (Tree > Show dropped leaves): the cards of a leaf that finished its life, laid flat on the ground
 * (z = 0) under the point it grew from, with a random yaw, scattered by `spread` metres and swept along the Season wind
 * arrows. They carry no wind data, so the viewport wind never moves them.
 */
export function groundCards(cards: readonly LeafCard[], base: readonly [number, number, number], rng: Rng, spread: number, forces: readonly ForceDef[]): LeafCard[] {
  const yaw = rng.next() * Math.PI * 2;
  const r = rng.next();
  const [wx, wy] = seasonWindOffset(forces, r);
  const jr = Math.sqrt(rng.next()) * Math.max(0, spread);
  const ja = rng.next() * Math.PI * 2;
  const x = base[0] + wx + Math.cos(ja) * jr;
  const y = base[1] + wy + Math.sin(ja) * jr;
  const origin: V3 = [x, y, 0.004];
  const axis: V3 = [Math.cos(yaw), Math.sin(yaw), 0];
  const side: V3 = [-Math.sin(yaw), Math.cos(yaw), 0];
  return cards.map((c) => {
    const { deform: _deform, light: _light, ...rest } = c;
    return { ...rest, origin, pivot: origin, axis, side, bend: c.bend * 0.25, fold: 0, curl: 0, twist: 0, wind: [0, 0, 0, 0, 0] };
  });
}

/** Meshes the ground cards into `mesh.dropped` (nothing when there are none). */
export function attachDropped(mesh: MeshData, cards: readonly LeafCard[], fixWinding: boolean): void {
  if (cards.length === 0) return;
  const ground = buildLeafMesh([...cards], { defaultMaterial: 'leaf', fixWinding });
  delete ground.wind; // lying leaves never move: no per-vertex wind data
  mesh.dropped = ground;
}
