import { describe, expect, it } from 'vitest';
import type { DisplacementDef, MaterialDef } from '@/contracts/material';
import { flatCurve } from '@/core/curve';
import { Rng } from '@/core/rng';
import { decodeProject, encodeProject } from '@/app/project/codec';
import { createProjectFile, defaultMeta } from '@/app/project/format';
import { displaceMeshData, lodDisplacementFactor } from '@/geometry/displaceMesh';
import { MaterialLibrary, defaultMaterials } from '@/materials/library';
import { createDisplacementDef, processDisplacement, registerDisplacementSource, sampleHeightField } from '@/materials/displacement';
import { evaluateMask, createMaskDef, rangeFactor, slopeOf } from '@/materials/masks';
import { pickFromSet, resolveMaterialRef, type MaterialSource } from '@/materials/materialSource';
import { SLOT_INFO, createMaterialDef, glossToRoughness, seasonWeight, slotColorSpace, variationTint } from '@/materials/shadingMath';
import { base64ToBytes, bytesToBase64, fnvHash, hashBytes } from '@/textures/bytes';
import { TextureManager } from '@/textures/textureManager';
import type { MeshData } from '@/contracts/mesh';

describe('slot rules', () => {
  it('uses sRGB only for colour slots', () => {
    const srgb = SLOT_INFO.filter((s) => slotColorSpace(s.slot) === 'srgb').map((s) => s.slot);
    expect(srgb).toEqual(['color', 'specular', 'subsurface']);
    expect(slotColorSpace('normal')).toBe('linear');
    expect(slotColorSpace('opacity')).toBe('linear');
  });
  it('lists the 12 slots in grouped order', () => {
    expect(SLOT_INFO.map((s) => s.title)).toEqual(['Color', 'Opacity', 'Normal', 'Gloss', 'Specular', 'Metallic', 'Subsurface', 'Subsurface %', 'AO', 'Height', 'Custom', 'Custom2']);
  });
  it('converts gloss to roughness', () => {
    expect(glossToRoughness(1)).toBeCloseTo(0.02);
    expect(glossToRoughness(0)).toBe(1);
    expect(glossToRoughness(0.25)).toBeCloseTo(0.75);
  });
});

describe('season and variation maths', () => {
  it('evaluates season curves and defaults to 1', () => {
    expect(seasonWeight(null, 0.3)).toBe(1);
    expect(seasonWeight(flatCurve(0.4), 0.9)).toBeCloseTo(0.4);
  });
  it('keeps luminance-neutral tints and fades with amount', () => {
    const v = createMaterialDef('a', 'a').variations;
    expect(variationTint(v, 0, 0.5)).toEqual([1, 1, 1]);
    const full = variationTint(v, 1, 0);
    expect(full[1]).toBeGreaterThan(full[2]);
    const half = variationTint(v, 0.5, 0);
    expect(half[1]).toBeCloseTo((1 + full[1]) / 2);
    expect(variationTint(v, 1, 1)).not.toEqual(full);
  });
});

function source(materials: MaterialDef[], season = 0.5, sets = [] as MaterialSource['sets'] extends () => readonly (infer S)[] ? S[] : never): MaterialSource {
  return { materials: () => materials, sets: () => sets, displacements: () => [], masks: () => [], season: () => season };
}

describe('material sets', () => {
  const a = createMaterialDef('ma', 'A');
  const b = createMaterialDef('mb', 'B');
  const set = { id: 'set1', name: 'Summer', overrideSeason: false, season: null, members: [{ id: '1', materialId: 'ma', weight: 1 }, { id: '2', materialId: 'mb', weight: 1 }] };
  it('passes plain material ids / names through without consuming RNG', () => {
    const rng = new Rng(5);
    const src = source([a, b], 0.5, [set]);
    expect(resolveMaterialRef('ma', rng, src)).toBe('ma');
    expect(resolveMaterialRef('B', rng, src)).toBe('mb');
    expect(resolveMaterialRef('leaf', rng, src)).toBe('leaf');
    expect(rng.next()).toBe(new Rng(5).next());
  });
  it('picks deterministically and respects weights', () => {
    const src = source([a, b], 0.5, [set]);
    const run = (): string[] => {
      const rng = new Rng(9);
      return Array.from({ length: 20 }, () => resolveMaterialRef('set1', rng, src));
    };
    expect(run()).toEqual(run());
    expect(new Set(run())).toEqual(new Set(['ma', 'mb']));
    const heavy = { ...set, members: [{ id: '1', materialId: 'ma', weight: 0 }, { id: '2', materialId: 'mb', weight: 3 }] };
    expect(pickFromSet(heavy, [a, b], 0.5, new Rng(1))).toBe('mb');
  });
  it('applies the override season to every member', () => {
    const off = { ...set, overrideSeason: true, season: flatCurve(0), members: set.members };
    expect(pickFromSet(off, [a, b], 0.5, new Rng(1))).toBeNull();
  });
});

describe('masks', () => {
  const m = createMaskDef('m', 'Mask_1');
  it('measures slope as angle / 90°', () => {
    expect(slopeOf([0, 0, 1])).toBeCloseTo(0);
    expect(slopeOf([1, 0, 0])).toBeCloseTo(1);
    expect(slopeOf([0, 0.7071, 0.7071])).toBeCloseTo(0.5, 2);
  });
  it('is inclusive inside and fuzzy outside the ranges', () => {
    const mask = { ...m, slope: { min: 0, max: 0.5 }, fuzziness: 0.2 };
    const flat = { position: [0, 0, 1] as const, normal: [0, 0, 1] as const, height: 0.5 };
    expect(evaluateMask(mask, flat)).toBe(1);
    const steep = { ...flat, normal: [0.8, 0, 0.6] as const };
    const v = evaluateMask(mask, steep);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(1);
    expect(evaluateMask({ ...mask, behavior: 'exclusive' }, flat)).toBe(0);
  });
  it('switches between relative and absolute elevation', () => {
    const abs = { ...m, elevationMode: 'absolute' as const, absoluteElevation: { min: 10, max: 20 } };
    const s = { position: [0, 0, 5] as const, normal: [0, 0, 1] as const, height: 0.5 };
    expect(evaluateMask(abs, s)).toBe(0);
    expect(evaluateMask({ ...abs, absoluteElevation: { min: 0, max: 20 } }, s)).toBe(1);
    expect(rangeFactor(0.5, 0, 1, 0)).toBe(1);
  });
});

describe('displacement', () => {
  const rgba = (vals: number[]): Uint8ClampedArray => new Uint8ClampedArray(vals.flatMap((v) => [v, v, v, 255]));
  const src = { width: 2, height: 2, rgba: rgba([0, 255, 255, 0]) };
  it('processes channel, contrast and normalisation', () => {
    const def: DisplacementDef = createDisplacementDef('d', 'D');
    const hf = processDisplacement(def, src);
    expect(Array.from(hf.data)).toEqual([0, 1, 1, 0]);
    const flat = processDisplacement({ ...def, normalize: false, contrast: 0 }, src);
    expect(Array.from(flat.data).every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
    const bright = processDisplacement({ ...def, normalize: false, brightness: 1 }, { width: 1, height: 1, rgba: rgba([128]) });
    expect(bright.data[0]).toBeGreaterThan(0.9);
  });
  it('samples with wrap-around (seam safe)', () => {
    const hf = processDisplacement(createDisplacementDef('d', 'D'), src);
    expect(sampleHeightField(hf, 0.25, 0.25)).toBeCloseTo(sampleHeightField(hf, 1.25, 3.25));
    expect(sampleHeightField(hf, -0.75, 0.25)).toBeCloseTo(sampleHeightField(hf, 0.25, 0.25));
  });
  it('displaces along normals, fades with LOD and keeps seam vertices equal', () => {
    registerDisplacementSource('img1', { width: 2, height: 2, rgba: rgba([0, 255, 255, 0]) });
    const def = { ...createDisplacementDef('d', 'D'), assetId: 'img1' };
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 0, 0, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1]),
      uv0: new Float32Array([0, 0.25, 1, 0.25]),
      indices: new Uint32Array([0, 1, 0]),
      slots: [],
    };
    const out = displaceMeshData(mesh, def, { amount: 1, scale: 1, offset: 0, lod: 0 });
    expect(out.positions[2]).toBeCloseTo(out.positions[5] as number);
    expect(mesh.positions[2]).toBe(0);
    expect(lodDisplacementFactor(3)).toBe(0);
    expect(displaceMeshData(mesh, def, { amount: 1, scale: 1, offset: 0, lod: 3 })).toBe(mesh);
  });
});

describe('assets, container and library', () => {
  it('round-trips base64 and hashes content', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 0, 7]);
    expect(Array.from(base64ToBytes(bytesToBase64(bytes)))).toEqual(Array.from(bytes));
    expect(fnvHash(bytes)).toBe(fnvHash(new Uint8Array(bytes)));
    expect(fnvHash(bytes)).not.toBe(fnvHash(new Uint8Array([1, 2, 3])));
    expect(await hashBytes(bytes)).toBe(await hashBytes(new Uint8Array(bytes)));
  });
  it('dedupes imports by content hash and replaces bytes in place', async () => {
    const assets: import('@/contracts/project').AssetEntry[] = [];
    const tm = new TextureManager();
    tm.bind(() => assets);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5]);
    const first = await tm.importBytes(png, 'a.png');
    const again = await tm.importBytes(new Uint8Array(png), 'b.png');
    expect(again.id).toBe(first.id);
    expect(assets).toHaveLength(1);
    expect(first.mime).toBe('image/png');
    await tm.importBytes(new Uint8Array([0xff, 0xd8, 9, 9]), 'c.jpg');
    expect(assets).toHaveLength(2);
    await tm.replaceBytes(first.id, new Uint8Array([0xff, 0xd8, 1]), 'new.jpg');
    expect(assets[0]?.mime).toBe('image/jpeg');
    expect(tm.poolSize()).toBe(0);
    tm.dispose();
  });
  it('stores embedded blobs raw in the binary container and restores them', async () => {
    const meta = defaultMeta(7);
    const tm = new TextureManager();
    tm.bind(() => meta.assets);
    const payload = new Uint8Array(5000).map((_, i) => (i * 31) % 251);
    const asset = await tm.importBytes(payload, 'big.png', 'image/png');
    const mat = createMaterialDef('m1', 'Bark texture');
    mat.slots.color = { texture: { assetId: asset.id } };
    meta.materials = [mat];
    meta.materialSets = [{ id: 's', name: 'Summer', overrideSeason: true, season: null, members: [] }];
    meta.masks = [createMaskDef('k', 'Mask_1')];
    meta.displacements = [{ ...createDisplacementDef('d', 'Oak'), assetId: asset.id, fileName: 'x.png' }];
    const file = createProjectFile({ name: 'T', graph: { nodes: [], edges: [] }, meta, seed: 7 });
    const bytes = encodeProject(file);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('KTB1');
    const rawJsonOnly = new TextEncoder().encode(JSON.stringify(file)).length;
    expect(bytes.length).toBeLessThan(rawJsonOnly);
    const back = decodeProject(bytes);
    expect(back.assets[0]?.data).toBe(asset.data);
    expect(back.materials[0]?.slots.color?.texture?.assetId).toBe(asset.id);
    expect(back.materialSets?.[0]?.name).toBe('Summer');
    expect(back.masks?.[0]?.name).toBe('Mask_1');
    expect(back.displacements?.[0]?.fileName).toBe('x.png');
    tm.dispose();
  });
  it('edits through undoable snapshots', () => {
    const meta = { materials: [] as MaterialDef[], assets: [] };
    const lib = new MaterialLibrary();
    const stack: { undo(): void; do(): void; merge?(n: unknown): boolean }[] = [];
    lib.bind(() => meta, { execute: (c) => { c.do(); stack.push(c); } });
    expect(lib.materials().map((m) => m.id)).toEqual(defaultMaterials().map((m) => m.id));
    const id = lib.add('materials');
    expect(lib.materials()).toHaveLength(4);
    lib.edit('Two-sided', 'materials', () => ((lib.material(id) as MaterialDef).twoSided = true));
    expect(lib.material(id)?.twoSided).toBe(true);
    stack[1]?.undo();
    expect(lib.material(id)?.twoSided).toBe(false);
    stack[1]?.do();
    expect(lib.material(id)?.twoSided).toBe(true);
    lib.remove('materials', id);
    expect(lib.materials()).toHaveLength(3);
    expect(lib.uniqueName('materials', 'Bark')).toBe('Bark 2');
    // slider drags with the same key merge into one step; redo restores the final value
    const log: string[] = [];
    const lib2 = new MaterialLibrary();
    const steps: { undo(): void; do(): void; merge?(n: unknown): boolean }[] = [];
    const meta2 = { materials: [] as MaterialDef[], assets: [] };
    lib2.bind(() => meta2, {
      execute: (c) => {
        c.do();
        const last = steps[steps.length - 1];
        if (!(last?.merge?.(c) === true)) steps.push(c);
      },
    });
    lib2.onChange(() => log.push('change'));
    for (const v of [0.1, 0.2, 0.3]) lib2.edit('Amount', 'materials', () => ((lib2.material('bark') as MaterialDef).variationAmount = v), 'amount');
    expect(steps).toHaveLength(1);
    steps[0]?.undo();
    expect(lib2.material('bark')?.variationAmount).toBe(0);
    steps[0]?.do();
    expect(lib2.material('bark')?.variationAmount).toBe(0.3);
  });
});
