// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mergeToPlantGeometry } from '@/export/geometry';
import { verifyGlb, statsFromJson } from '@/export/verify';
import { readGlbJson, writeGltf } from '@/export/writers/gltf';
import { cards } from './helpers/exportScene';

describe('GLB round trip through three.js GLTFLoader', () => {
  it('re-imports what the writer produced with identical triangle counts', async () => {
    const g = mergeToPlantGeometry('Plant', [cards(20, 'leaf'), cards(5, 'bark')]);
    const mat = (name: string) => ({ name, baseColorFactor: [1, 1, 1, 1] as [number, number, number, number], metallicFactor: 0, roughnessFactor: 1, alphaMode: 'OPAQUE' as const, alphaCutoff: 0.5, doubleSided: true });
    const out = writeGltf({ name: 's', images: [], materials: [mat('Leaf'), mat('Bark')], materialIndex: new Map([['leaf', 0], ['bark', 1]]), nodes: [{ name: 'Plant_LOD0', geometry: g }] }, { binary: true, customAttributes: false, vertexColors: false, baseName: 'p' });
    const bytes = out.files[0]!.data as Uint8Array;
    const expected = statsFromJson(readGlbJson(bytes).json);
    const report = await verifyGlb('p.glb', bytes, expected, true);
    expect(report.mismatches).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.loaderTriangles).toBe(50);
  });
});
