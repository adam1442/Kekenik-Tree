import { beforeAll, describe, expect, it } from 'vitest';
import type { DisplacementDef } from '@/contracts/material';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { createDisplacementDef, getHeightMips, registerDisplacementSource, sampleDisplacement, sampleHeightMips } from '@/materials/displacement';
import { displaceMeshData, lodDisplacementFactor, createTubeDisplacer } from '@/geometry/displaceMesh';
import { recomputeNormalsAndTangents } from '@/geometry/meshNormals';
import { buildTubeMesh } from '@/geometry/tubeMesher';
import { createProjectFile, defaultMeta, migrateGraphNodes, parseProject } from '@/app/project/format';
import { registerDiscoveredNodes } from '@/graph/registry';
import { displacementDependencyKey } from '@/nodes/generators/displacement';
import { setMaterialSource } from '@/materials/materialSource';
import type { MeshData } from '@/contracts/mesh';

beforeAll(() => registerDiscoveredNodes());

/** 8x8 vertical-stripe map: columns alternate 0.2 / 0.8. */
function stripes(assetId: string, w = 8): DisplacementDef {
  const rgba = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const v = x % 2 ? 204 : 51;
    rgba.set([v, v, v, 255], (y * w + x) * 4);
  }
  registerDisplacementSource(assetId, { width: w, height: w, rgba });
  return { ...createDisplacementDef(`d-${assetId}`, 'Stripes'), assetId, normalize: false };
}

/** 16x16 pseudo-random bumps (no neighbouring texels average to grey). */
function bumpy(assetId: string): DisplacementDef {
  const w = 16;
  const rgba = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const v = Math.round((((x * 7 + y * 3 + x * y) % 16) / 15) * 255);
    rgba.set([v, v, v, 255], (y * w + x) * 4);
  }
  registerDisplacementSource(assetId, { width: w, height: w, rgba });
  return { ...createDisplacementDef(`d-${assetId}`, 'Bumps'), assetId, normalize: false };
}

function straightTube(radius = 0.2, points = 6) {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i < points; i++) sb.addPoint(0, 0, i * 0.5, radius);
  sb.endBranch();
  return sb.build();
}

const tubeOpts = (displace?: ReturnType<typeof createTubeDisplacer>) => ({
  maxGeneration: 8,
  radialSegments: () => 12,
  color: () => [0.3, 0.2, 0.1] as [number, number, number],
  uvMetres: 1,
  materialId: 'bark',
  ...(displace ? { displace, displaceDirection: 'normal' as const, maxSegmentLength: 0.1 } : {}),
});

const spec = (def: DisplacementDef, over = {}) => ({
  def, amount: 0.05, radiusAmount: 0, bias: 0, midGrey: true, scaleU: 1, scaleV: 1, tiling: 'world' as const, tileSize: 0.5,
  rotation: 0, lockSeams: true, fadeBase: 1.5, fadeTip: 1, lod: 0, lodFade: true, ...over,
});

describe('height sampling', () => {
  it('returns the processed values of a synthetic map (bilinear, wrapping, mips)', () => {
    const def = stripes('a-sample');
    expect(sampleDisplacement(def, 0.5 / 8, 0.3)).toBeCloseTo(0.2, 5);
    expect(sampleDisplacement(def, 1.5 / 8, 0.3)).toBeCloseTo(0.8, 5);
    expect(sampleDisplacement(def, 1 + 0.5 / 8, 5.3)).toBeCloseTo(0.2, 5);
    expect(sampleDisplacement(def, 1 / 8, 0.1)).toBeCloseTo(0.5, 5);
    const mips = getHeightMips(def)!;
    expect(mips.length).toBeGreaterThan(2);
    expect(sampleHeightMips(mips, 0.1, 0.1, 3)).toBeCloseTo(0.5, 2);
  });

  it('stamp-based cache key changes when the settings change', () => {
    const def = stripes('a-key');
    const lib = { materials: () => [], sets: () => [], masks: () => [], season: () => 0.5, displacements: () => [def] };
    setMaterialSource(lib);
    const p = { displacement: { value: def.id } };
    const k1 = displacementDependencyKey(p);
    def.contrast = 0.9;
    expect(displacementDependencyKey(p)).not.toBe(k1);
    stripes('a-key');
    setMaterialSource(null);
  });
});

describe('tube displacement', () => {
  it('displaces the bark, keeps the U seam watertight and produces finite unit normals', () => {
    const def = bumpy('a-tube');
    const sk = straightTube();
    const mesh = buildTubeMesh(sk, tubeOpts(createTubeDisplacer(spec(def))));
    const V = 13;
    for (let i = 0; i < 10; i++) {
      const a = (i * V) * 3;
      const b = (i * V + 12) * 3;
      for (let k = 0; k < 3; k++) {
        expect(mesh.positions[b + k]).toBeCloseTo(mesh.positions[a + k]!, 6);
        expect(mesh.normals[b + k]).toBeCloseTo(mesh.normals[a + k]!, 6);
      }
    }
    let moved = 0;
    for (let i = 0; i < mesh.positions.length; i++) {
      expect(Number.isFinite(mesh.positions[i]!)).toBe(true);
    }
    for (let i = 0; i < mesh.normals.length / 3; i++) {
      expect(Math.hypot(mesh.normals[i * 3]!, mesh.normals[i * 3 + 1]!, mesh.normals[i * 3 + 2]!)).toBeCloseTo(1, 4);
    }
    const radialOf = (m: MeshData, i: number): number => Math.hypot(m.positions[i * 3]!, m.positions[i * 3 + 1]!);
    for (let i = 0; i < 13 * 6; i++) if (Math.abs(radialOf(mesh, i) - 0.2) > 1e-3) moved++;
    expect(moved).toBeGreaterThan(10);
  });

  it('fades to zero at the tip so the cap stays closed, and auto-subdivides to the detail size', () => {
    const def = bumpy('a-tip');
    const sk = straightTube();
    const plain = buildTubeMesh(sk, tubeOpts());
    const mesh = buildTubeMesh(sk, tubeOpts(createTubeDisplacer(spec(def))));
    expect(mesh.positions.length).toBeGreaterThan(plain.positions.length);
    // The ring at the tip (z = 2.5) keeps its undisplaced radius.
    let tipRings = 0;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      if (Math.abs(mesh.positions[i * 3 + 2]! - 2.5) < 1e-5) {
        tipRings++;
        expect(Math.hypot(mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!)).toBeCloseTo(0.2, 4);
      }
    }
    expect(tipRings).toBeGreaterThan(5);
  });

  it('scales with LOD (fully off at LOD 3) and does nothing without an image or amount', () => {
    const def = stripes('a-lod');
    expect(lodDisplacementFactor(0)).toBe(1);
    expect(lodDisplacementFactor(2)).toBeCloseTo(0.5);
    expect(createTubeDisplacer(spec(def, { lod: 3 }))).toBeNull();
    expect(createTubeDisplacer(spec(def, { amount: 0 }))).toBeNull();
    expect(createTubeDisplacer(spec({ ...def, assetId: 'nope' }))).toBeNull();
  });
});

describe('generic mesh displacement', () => {
  /** A strip with a duplicated seam (two vertices at x = 1) like a UV-wrapped cylinder. */
  const seamMesh = (): MeshData => {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const cols = 9;
    for (let y = 0; y < 5; y++) for (let x = 0; x < cols; x++) {
      const a = (2 * Math.PI * (x % 8)) / 8;
      pos.push(Math.cos(a), Math.sin(a), y * 0.25);
      uv.push(x / 8, y / 4);
    }
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
      const a = y * cols + x;
      idx.push(a, a + 1, a + cols, a + 1, a + cols + 1, a + cols);
    }
    const n = pos.length / 3;
    return { positions: Float32Array.from(pos), normals: new Float32Array(n * 3), uv0: Float32Array.from(uv), indices: Uint32Array.from(idx), slots: [{ materialId: 'bark', indexStart: 0, indexCount: idx.length }] };
  };

  it('moves seam duplicates identically, pins open borders and rebuilds unit normals + tangents', () => {
    const def = bumpy('a-gen');
    const out = displaceMeshData(seamMesh(), def, { amount: 0.1, scale: 3, offset: 0, lod: 0, borderWeight: 0 });
    for (let y = 0; y < 5; y++) {
      const a = (y * 9) * 3;
      const b = (y * 9 + 8) * 3;
      for (let k = 0; k < 3; k++) expect(out.positions[b + k]).toBeCloseTo(out.positions[a + k]!, 6);
    }
    // Border rows (y = 0 and y = 4) are open edges: they did not move.
    expect(Math.hypot(out.positions[3]!, out.positions[4]!)).toBeCloseTo(1, 5);
    expect(Math.hypot(out.positions[(4 * 9 + 1) * 3]!, out.positions[(4 * 9 + 1) * 3 + 1]!)).toBeCloseTo(1, 5);
    // Middle rows did.
    let moved = 0;
    for (let x = 0; x < 9; x++) if (Math.abs(Math.hypot(out.positions[(2 * 9 + x) * 3]!, out.positions[(2 * 9 + x) * 3 + 1]!) - 1) > 1e-3) moved++;
    expect(moved).toBeGreaterThan(2);
    for (let i = 0; i < out.normals.length / 3; i++) {
      expect(Math.hypot(out.normals[i * 3]!, out.normals[i * 3 + 1]!, out.normals[i * 3 + 2]!)).toBeCloseTo(1, 4);
      expect(Math.hypot(out.tangents![i * 4]!, out.tangents![i * 4 + 1]!, out.tangents![i * 4 + 2]!)).toBeCloseTo(1, 4);
      expect(Number.isNaN(out.positions[i * 3]!)).toBe(false);
    }
  });

  it('recomputeNormalsAndTangents welds seam normals', () => {
    const { normals } = recomputeNormalsAndTangents(seamMesh());
    for (let k = 0; k < 3; k++) expect(normals[(2 * 9 + 8) * 3 + k]).toBeCloseTo(normals[(2 * 9) * 3 + k]!, 6);
  });
});

describe('project persistence', () => {
  it('keeps displacement definitions and asset links through save / load', () => {
    const meta = defaultMeta(1);
    meta.displacements = [{ ...createDisplacementDef('d1', 'Bark ridges'), assetId: 'asset-7', fileName: 'ridges.png', contrast: 0.7 }];
    const file = createProjectFile({ name: 'x', graph: { nodes: [], edges: [] } as never, meta, seed: 1 });
    const back = parseProject(JSON.parse(JSON.stringify(file)));
    expect(back.displacements?.[0]).toMatchObject({ id: 'd1', assetId: 'asset-7', fileName: 'ridges.png', contrast: 0.7 });
  });

  it('migrates old Frond nodes in loaded graphs', () => {
    const graph = {
      nodes: [{ id: 'f', type: 'generator.frond', name: 'Frond', x: 0, y: 0, params: { frondPinnaLength: { value: 0.5 }, frondFins: { value: 8 } } }],
      edges: [],
    };
    const out = migrateGraphNodes(graph as never, { 'generator.frond': 1 });
    const params = (out.nodes[0] as unknown as { params: Record<string, { value: number }> }).params;
    expect(params.frondWidth?.value).toBeCloseTo(0.7);
    expect(params.frondFins).toBeUndefined();
  });
});
