import { unzipSync, unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { MaterialDef } from '@/contracts/material';
import { CancellationSource } from '@/contracts/nodes';
import { applyAoToGeometry, buildAoField, computeAoRange } from '@/export/bake/aoCore';
import { runExport, type ExportEnv } from '@/export/exportService';
import { buildGeometries, geometryStats, mergeToPlantGeometry, transformGeometry } from '@/export/geometry';
import { createImage, dilateColor, encodePng, fitSize, mergeOpacity, packOrm, resizeImage, transformNormalImage, type RGBAImage } from '@/export/images/imageOps';
import { billboardQuad, computeLayout, frameTransform, nearestFrame, viewDirection } from '@/export/impostor/impostorLayout';
import { applyLodToScene, lodForFraction, screenFraction, distanceForFraction } from '@/export/lod/lodScene';
import { meshComponents } from '@/export/lod/meshOps';
import { exportMaterials, type MaterialExportContext } from '@/export/materials/materialExport';
import { defaultExportSettings, defaultLodLevels, sanitizeExportSettings, sanitizeLodSettings } from '@/export/settings';
import { buildTransform } from '@/export/transform';
import { UNIT_SCALE } from '@/export/types';
import { statsFromJson } from '@/export/verify';
import { readGlbJson, writeGltf, type GltfMaterial } from '@/export/writers/gltf';
import { writeObj, writePly, writeStl } from '@/export/writers/simpleFormats';
import { createMaterialDef } from '@/materials/shadingMath';
import { testScene, cards } from './helpers/exportScene';

const encoder: MaterialExportContext['encode'] = async (img) => ({ data: encodePng(img), mime: 'image/png', ext: 'png' });

function fakeContext(defs: MaterialDef[], images: Record<string, RGBAImage> = {}): MaterialExportContext {
  return { material: (id) => defs.find((d) => d.id === id || d.name === id), loadImage: async (a) => images[a] ?? null, encode: encoder, alphaThreshold: 0.5 };
}

const leafDef = (): MaterialDef => {
  const d = createMaterialDef('leaf', 'Leaf');
  d.twoSided = true;
  return d;
};

function fakeEnv(defs: MaterialDef[] = [createMaterialDef('bark', 'Bark'), leafDef()], images: Record<string, RGBAImage> = {}): ExportEnv {
  const scene = testScene();
  return {
    source: { seed: 7, evaluateAt: async (lod) => ({ run: 1, lod, preview: false, totalMs: 0, evaluated: 0, cached: 0, skipped: 0, errors: 0, diagnostics: new Map(), edgeLabels: new Map(), scene }) },
    levels: defaultLodLevels(),
    materials: fakeContext(defs, images),
    nodeName: (id) => (id === 'trunk' ? 'Trunk' : 'Leaves'),
    wind: null,
    seed: 7,
    verifyWithLoader: false,
  };
}

describe('transform', () => {
  it('Y-up right-handed rotates Z to Y without mirroring', () => {
    const t = buildTransform('Y', 'right', 2);
    const g = mergeToPlantGeometry('t', [cards(1)]);
    const z = g.positions[2] as number;
    transformGeometry(g, t);
    expect(g.positions[1]).toBeCloseTo(z * 2);
    expect(t.flipWinding).toBe(false);
  });
  it('left-handed mirrors X and reverses winding', () => {
    const t = buildTransform('Z', 'left', 1);
    expect(t.flipWinding).toBe(true);
    const g = mergeToPlantGeometry('t', [cards(1)]);
    const first = g.primitives[0]?.indices.slice(0, 3);
    const x = g.positions[0] as number;
    transformGeometry(g, t);
    expect(g.positions[0]).toBeCloseTo(-x);
    expect([...(g.primitives[0]?.indices.slice(0, 3) ?? [])]).toEqual([first?.[0], first?.[2], first?.[1]]);
  });
  it('unit table converts metres', () => expect(UNIT_SCALE.cm).toBe(100));
});

describe('geometry merge', () => {
  it('merges meshes, fills missing attributes and groups by material', () => {
    const a = cards(2, 'leaf');
    const b = { ...cards(1, 'bark'), ao: Float32Array.from([0.5, 0.5, 0.5, 0.5]) };
    const g = mergeToPlantGeometry('m', [a, b]);
    expect(g.positions.length / 3).toBe(12);
    expect(g.ao?.length).toBe(12);
    expect(g.ao?.[0]).toBe(1);
    expect(g.ao?.[8]).toBe(0.5);
    expect(g.primitives.map((p) => p.materialId).sort()).toEqual(['bark', 'leaf']);
    expect(geometryStats([g])).toEqual({ triangles: 6, vertices: 12, drawCalls: 2 });
  });
  it('per-node mode returns one geometry per mesh', () => {
    const list = buildGeometries([{ name: 'a', mesh: cards(1) }, { name: 'b', mesh: cards(1) }], 'perNode', 'x');
    expect(list.map((g) => g.name)).toEqual(['a', 'b']);
  });
});

describe('LOD generation', () => {
  const level = { engineLod: 1, foliageKeep: 0.4, keepSilhouette: true, minBranchSize: 5, transition: 0.5, triangleBudget: 0 };
  it('finds connected components (cards)', () => expect(meshComponents(cards(10)).count).toBe(10));
  it('is a no-op for a pass-through level', () => {
    const scene = testScene();
    expect(applyLodToScene(scene, { ...level, foliageKeep: 1, minBranchSize: 0 }, 1)).toBe(scene);
  });
  it('thins foliage, enlarges what remains and removes tiny branches', () => {
    const scene = testScene(200);
    const out = applyLodToScene(scene, level, 3);
    const leaves = out.entries.find((e) => e.nodeId === 'leaves')?.mesh;
    expect(meshComponents(leaves!).count).toBeGreaterThan(50);
    expect(meshComponents(leaves!).count).toBeLessThan(120);
    const bark = out.entries.find((e) => e.nodeId === 'trunk')?.mesh;
    expect(meshComponents(bark!).count).toBe(3); // 0.05 and 0.04 m boxes are below 5 % of the height
    // Remaining cards are enlarged about their base: width 0.1 -> ~0.1/sqrt(0.4)
    const w = Math.abs((leaves!.positions[3] as number) - (leaves!.positions[0] as number));
    expect(w).toBeGreaterThan(0.12);
    expect(out.stats.triangles).toBeLessThan(scene.stats.triangles);
  });
  it('is deterministic and nested (a smaller keep is a subset)', () => {
    const a = applyLodToScene(testScene(100), level, 3);
    const b = applyLodToScene(testScene(100), level, 3);
    expect(a.stats.triangles).toBe(b.stats.triangles);
    const lo = applyLodToScene(testScene(100), { ...level, foliageKeep: 0.2 }, 3).stats.triangles;
    expect(lo).toBeLessThanOrEqual(a.stats.triangles);
  });
  it('fits a triangle budget', () => {
    const out = applyLodToScene(testScene(400), { ...level, foliageKeep: 1, minBranchSize: 0, triangleBudget: 300 }, 3);
    expect(out.stats.triangles).toBeLessThan(600);
  });
  it('keeps the base of every kept card fixed', () => {
    const scene = testScene(50);
    const out = applyLodToScene(scene, { ...level, minBranchSize: 0 }, 3);
    const m = out.entries[1]!.mesh;
    // base vertices (v = 0) of each card keep their z = cz and the base midpoint
    for (let i = 0; i + 3 < m.positions.length / 3; i += 4) {
      expect(m.positions[i * 3 + 2]).toBeCloseTo(m.positions[(i + 1) * 3 + 2] as number, 5);
    }
  });
  it('maps screen size to LODs', () => {
    const levels = defaultLodLevels();
    expect(lodForFraction(levels, 0.9)).toBe(0);
    expect(lodForFraction(levels, 0.3)).toBe(1);
    expect(lodForFraction(levels, 0.15)).toBe(2);
    expect(lodForFraction(levels, 0.01)).toBe(3);
    const d = distanceForFraction(0.5, 10, 35);
    expect(screenFraction(d, 10, 35)).toBeCloseTo(0.5, 5);
  });
});

describe('settings', () => {
  it('sanitises garbage and keeps LOD transitions decreasing', () => {
    const s = sanitizeExportSettings({ format: 'exe', units: 'cm', textures: { maxSize: 99999 }, lods: [9, 1] }, 3);
    expect(s.format).toBe('glb');
    expect(s.units).toBe('cm');
    expect(s.textures.maxSize).toBe(8192);
    expect(s.lods).toEqual([1]);
    const l = sanitizeLodSettings({ levels: [{ transition: 1 }, { transition: 0.9 }, { transition: 0.95 }] });
    expect(l.levels[2]!.transition).toBeLessThan(l.levels[1]!.transition);
  });
});

describe('image operations', () => {
  it('resizes, fits and packs ORM', () => {
    const img = createImage(8, 8, [100, 100, 100, 255]);
    expect(resizeImage(img, 2, 2).width).toBe(2);
    expect(fitSize(4096, 1024, 1024)).toEqual({ width: 1024, height: 256 });
    expect(fitSize(512, 512, 1024)).toEqual({ width: 512, height: 512 });
    const gloss = createImage(2, 2, [255, 0, 0, 255]);
    const metal = createImage(2, 2, [0, 0, 0, 255]);
    const orm = packOrm({ ao: null, gloss, metallic: metal, aoScalar: 1, glossScalar: 1, metallicScalar: 1 })!;
    expect([...orm.data.slice(0, 4)]).toEqual([255, 0, 0, 255]); // gloss 1 -> roughness 0
  });
  it('merges an opacity mask into alpha and dilates colour under transparency', () => {
    const color = createImage(2, 1, [10, 20, 30, 255]);
    const mask: RGBAImage = { width: 2, height: 1, data: Uint8ClampedArray.from([0, 255, 0, 255, 0, 0, 0, 255]) };
    const merged = mergeOpacity(color, mask, 'g');
    expect([merged.data[3], merged.data[7]]).toEqual([255, 0]);
    const d = dilateColor({ width: 2, height: 1, data: Uint8ClampedArray.from([200, 100, 50, 255, 0, 0, 0, 0]) }, 1);
    expect([d.data[4], d.data[5], d.data[6], d.data[7]]).toEqual([200, 100, 50, 0]);
  });
  it('rotates encoded normals through a matrix', () => {
    const img: RGBAImage = { width: 1, height: 1, data: Uint8ClampedArray.from([128, 128, 255, 255]) };
    transformNormalImage(img, buildTransform('Y', 'right', 1).m); // +Z -> +Y
    expect(img.data[1]).toBeGreaterThan(250);
  });
  it('encodes a valid PNG (signature, IHDR, inflatable IDAT)', () => {
    const png = encodePng(createImage(3, 2, [1, 2, 3, 4]));
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const dv = new DataView(png.buffer);
    expect(dv.getUint32(16)).toBe(3);
    expect(dv.getUint32(20)).toBe(2);
    const idatLen = dv.getUint32(33);
    const raw = unzlibSync(png.slice(41, 41 + idatLen));
    expect(raw.length).toBe((3 * 4 + 1) * 2);
  });
});

describe('writers', () => {
  const geo = (): ReturnType<typeof mergeToPlantGeometry> => {
    const g = mergeToPlantGeometry('Plant', [cards(3, 'leaf'), cards(1, 'bark')]);
    g.wind = { pivot: new Float32Array(g.positions.length), weights: new Float32Array((g.positions.length / 3) * 4) };
    g.ao = new Float32Array(g.positions.length / 3).fill(0.5);
    return g;
  };
  const mat = (name: string, extra: Partial<GltfMaterial> = {}): GltfMaterial => ({ name, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false, ...extra });

  it('writes a structurally valid GLB with custom attributes and bounds', () => {
    const g = geo();
    const res = writeGltf({ name: 's', images: [], materials: [mat('Leaf'), mat('Bark')], materialIndex: new Map([['leaf', 0], ['bark', 1]]), nodes: [{ name: 'Plant', geometry: g }] }, { binary: true, customAttributes: true, vertexColors: true, baseName: 'p' });
    const bytes = res.files[0]!.data as Uint8Array;
    expect(bytes.byteLength % 4).toBe(0);
    const { json, bin } = readGlbJson(bytes);
    expect(json.asset.version).toBe('2.0');
    const prim = json.meshes[0]!.primitives[0]!;
    const attrs = prim.attributes as Record<string, number>;
    expect(Object.keys(attrs)).toEqual(expect.arrayContaining(['POSITION', 'NORMAL', 'TEXCOORD_0', '_WIND_PIVOT', '_WIND_WEIGHTS', '_AO']));
    expect(json.accessors[attrs.POSITION as number]!.min).toHaveLength(3);
    expect(bin!.byteLength).toBe(json.buffers[0]!.byteLength);
    expect(statsFromJson(json)).toMatchObject({ triangles: 8, materials: 2, nodes: 1 });
  });
  it('flips V for glTF and uses 16-bit indices for small meshes', () => {
    const g = geo();
    const { json, bin } = readGlbJson(writeGltf({ name: 's', images: [], materials: [], materialIndex: new Map(), nodes: [{ name: 'P', geometry: g }] }, { binary: true, customAttributes: false, vertexColors: false, baseName: 'p' }).files[0]!.data as Uint8Array);
    const attrs = json.meshes[0]!.primitives[0]!.attributes as Record<string, number>;
    const view = json.bufferViews[json.accessors[attrs.TEXCOORD_0 as number]!.bufferView as number]!;
    const uv = new Float32Array(bin!.buffer.slice(bin!.byteOffset + (view.byteOffset as number), bin!.byteOffset + (view.byteOffset as number) + 8));
    expect(uv[1]).toBeCloseTo(1 - (g.uv0[1] as number));
    expect(json.accessors[json.meshes[0]!.primitives[0]!.indices as number]!.componentType).toBe(5123);
  });
  it('writes .gltf + .bin with an external texture and KHR_texture_transform', () => {
    const png = encodePng(createImage(2, 2, [255, 0, 0, 255]));
    const res = writeGltf(
      { name: 's', images: [{ name: 'a', mime: 'image/png', data: png, uri: 'textures/a.png' }], materials: [mat('M', { baseColorTexture: { image: 0, transform: { offset: [0.5, 0], scale: [0.5, 1] } }, specular: { factor: 1, color: [0.5, 0.5, 0.5] } })], materialIndex: new Map([['leaf', 0]]), nodes: [{ name: 'P', geometry: mergeToPlantGeometry('P', [cards(1)]) }] },
      { binary: false, customAttributes: false, vertexColors: false, baseName: 'p' },
    );
    expect(res.files.map((f) => f.name)).toEqual(expect.arrayContaining(['p.gltf', 'p.bin', 'textures/a.png']));
    expect(res.json.extensionsUsed).toEqual(expect.arrayContaining(['KHR_texture_transform', 'KHR_materials_specular']));
    expect(res.json.buffers[0]!.uri).toBe('p.bin');
  });
  it('writes OBJ/MTL, PLY and STL', () => {
    const g = geo();
    const obj = writeObj('p', [g], new Map([['leaf', { name: 'Leaf', diffuse: [1, 1, 1], specular: [0, 0, 0], shininess: 10, opacity: 1, mapKd: 'textures/a.png' }]]), false);
    const text = obj.files[0]!.data as string;
    expect(text.match(/^v /gm)).toHaveLength(16);
    expect(text.match(/^f /gm)).toHaveLength(8);
    expect(text).toContain('usemtl Leaf');
    expect(obj.files[1]!.data as string).toContain('map_Kd textures/a.png');
    const ply = writePly('p', [g]).data as Uint8Array;
    expect(new TextDecoder().decode(ply.slice(0, 60))).toContain('binary_little_endian');
    expect((writeStl('p', [g]).data as Uint8Array).byteLength).toBe(84 + 8 * 50);
  });
});

describe('ambient occlusion', () => {
  it('darkens enclosed vertices more than open ones', () => {
    // Floor + ceiling with a vertex in between versus a lone floor vertex.
    const floor = mergeToPlantGeometry('f', [cards(1)]);
    const pos: number[] = [];
    const idx: number[] = [];
    const quad = (z: number): void => {
      const b = pos.length / 3;
      pos.push(-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    quad(0);
    quad(0.3);
    const positions = Float32Array.from(pos);
    const indices = Uint32Array.from(idx);
    const field = buildAoField(positions, indices, 32);
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < normals.length; i += 3) normals[i + 2] = 1;
    const ao = new Float32Array(positions.length / 3).fill(1);
    computeAoRange(field, positions, normals, 0, positions.length / 3, { samples: 32, radius: 0.6, strength: 1 }, ao);
    const underCeiling = ao[0] as number; // floor vertex looking up at the ceiling
    const open = ao[4] as number; // the upper plane's own vertex looks into empty space
    expect(underCeiling).toBeLessThan(open);
    applyAoToGeometry(floor, Float32Array.from([0.5, 0.5, 0.5, 0.5]), 0, 'replace');
    expect(floor.colors?.[0]).toBe(0.5);
    expect(floor.ao?.[0]).toBe(0.5);
  });
});

describe('impostor math', () => {
  it('lays out views and frame transforms', () => {
    const l = computeLayout({ views: 8, topView: true, frameSize: 128 });
    expect(l.frames).toHaveLength(9);
    expect(l.cols).toBe(4);
    expect(l.rows).toBe(3);
    expect(l.frames[8]!.elevationDeg).toBe(90);
    const t = frameTransform(l, l.frames[5]!);
    expect(t.scale).toEqual([0.25, 1 / 3]);
    expect(t.offset[0]).toBeCloseTo(0.25);
    expect(nearestFrame(l, 90).azimuthDeg).toBe(90);
    expect(viewDirection(90, 0)[1]).toBeCloseTo(1);
  });
  it('builds a billboard facing the camera azimuth', () => {
    const q = billboardQuad('q', 'm', [0, 0, 1], 2, 90);
    expect(q.normals[0]).toBeCloseTo(0);
    expect(q.normals[1]).toBeCloseTo(1);
    expect(q.positions[2]).toBeCloseTo(-1);
    expect(q.primitives[0]!.indices).toHaveLength(6);
  });
});

describe('material export', () => {
  it('merges opacity into the albedo, packs ORM and respects Max res', async () => {
    const def = createMaterialDef('leaf', 'Leaf');
    def.slots.color = { texture: { assetId: 'c' } };
    def.slots.opacity = { texture: { assetId: 'o' } };
    def.slots.gloss = { texture: { assetId: 'g' } };
    def.slots.custom = { scalar: 0.4 };
    def.maxResolution = 4;
    const big = (v: number[]): RGBAImage => createImage(16, 16, v as [number, number, number, number]);
    const res = await exportMaterials(['leaf'], fakeContext([def], { c: big([10, 200, 10, 255]), o: big([0, 255, 0, 255]), g: big([128, 128, 128, 255]) }), { ...defaultExportSettings(), textures: { ...defaultExportSettings().textures, padding: 0 } }, () => false);
    const m = res.materials[0]!;
    expect(m.alphaMode).toBe('MASK');
    expect(m.baseColorTexture).toBeDefined();
    expect(m.metallicRoughnessTexture).toBeDefined();
    expect(m.occlusionTexture).toBeUndefined();
    expect(res.images.length).toBe(2); // albedo+opacity, orm
    expect(res.records[0]!.cutout).toBe(true);
    expect(((m.extras?.kekenik as { slots: Record<string, unknown> }).slots.custom as { scalar: number }).scalar).toBe(0.4);
    const dv = new DataView((res.images[0]!.data as Uint8Array).buffer, (res.images[0]!.data as Uint8Array).byteOffset);
    expect(dv.getUint32(16)).toBe(4);
  });
  it('exports plain constants without textures', async () => {
    const def = createMaterialDef('bark', 'Bark');
    def.slots.gloss = { scalar: 0.05 };
    const res = await exportMaterials(['bark'], fakeContext([def]), defaultExportSettings(), () => false);
    expect(res.images).toHaveLength(0);
    expect(res.materials[0]!.roughnessFactor).toBeCloseTo(0.95);
    expect(res.materials[0]!.alphaMode).toBe('OPAQUE');
  });
});

describe('export service', () => {
  it('exports LODs into one GLB with LOD nodes and verifies it', async () => {
    const settings = { ...defaultExportSettings('Oak'), lods: [0, 1, 2], verify: true, metadata: true };
    const stages: string[] = [];
    const out = await runExport(fakeEnv(), settings, new CancellationSource().token, (p) => stages.push(p.stage));
    const glb = out.files.find((f) => f.name === 'Oak.glb')!;
    const { json } = readGlbJson(glb.data as Uint8Array);
    expect(json.nodes.map((n) => n.name)).toEqual(['Oak_LOD0', 'Oak_LOD1', 'Oak_LOD2']);
    expect(out.lods.map((l) => l.index)).toEqual([0, 1, 2]);
    expect(out.lods[2]!.stats.triangles).toBeLessThan(out.lods[0]!.stats.triangles);
    expect(out.verification[0]!.ok).toBe(true);
    expect(out.files.some((f) => f.name === 'Oak.kekenik.json')).toBe(true);
    expect(stages).toContain('Writing files');
    // metadata + glb -> bundled
    const zip = unzipSync(out.download.data as Uint8Array);
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['Oak/Oak.glb', 'Oak/Oak.kekenik.json']));
  });
  it('writes one file per LOD for OBJ with Y-up scaled to centimetres', async () => {
    const settings = { ...defaultExportSettings('Oak'), format: 'obj' as const, lods: [0, 1], units: 'cm' as const, metadata: false };
    const out = await runExport(fakeEnv(), settings, new CancellationSource().token, () => undefined);
    expect(out.files.map((f) => f.name)).toEqual(expect.arrayContaining(['Oak_LOD0.obj', 'Oak_LOD0.mtl', 'Oak_LOD1.obj']));
    const text = out.files.find((f) => f.name === 'Oak_LOD0.obj')!.data as string;
    const maxY = Math.max(...[...text.matchAll(/^v \S+ (\S+) \S+/gm)].map((m) => Number(m[1])));
    expect(maxY).toBeGreaterThan(250); // ~3 m tall trunk in cm, Y-up
  });
  it('cancels cooperatively', async () => {
    const src = new CancellationSource();
    src.cancel();
    await expect(runExport(fakeEnv(), defaultExportSettings(), src.token, () => undefined)).rejects.toThrow();
  });
  it('skips the impostor with a warning when no renderer exists', async () => {
    const out = await runExport(fakeEnv(), { ...defaultExportSettings(), impostor: { ...defaultExportSettings().impostor, mode: 'both' }, verify: false }, new CancellationSource().token, () => undefined);
    expect(out.warnings.join(' ')).toContain('Impostor skipped');
  });
});
