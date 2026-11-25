import { beforeAll, describe, expect, it } from 'vitest';
import type { SceneEntry, SceneModel } from '@/contracts/engine';
import type { MaterialDef } from '@/contracts/material';
import { CancellationSource } from '@/contracts/nodes';
import { meshVertexCount, type MeshData } from '@/contracts/mesh';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { applyVTiling, vTilingWarnings } from '@/export/atlas/vTiling';
import { runExport, type ExportEnv } from '@/export/exportService';
import { mergeToPlantGeometry } from '@/export/geometry';
import { encodeDds } from '@/export/images/ddsWriter';
import { createImage, encodePng, type RGBAImage } from '@/export/images/imageOps';
import { packLightmap, type LightmapInput } from '@/export/lightmap/lightmapPack';
import type { MaterialExportContext } from '@/export/materials/materialExport';
import { buildMips, packTexture, runPacker } from '@/export/packing/packer';
import { getPacker, PACKER_IDS } from '@/export/packing/presets';
import { defaultExportSettings, defaultLodLevels, sanitizeExportSettings } from '@/export/settings';
import { auditExportWind } from '@/export/windAuditReport';
import { readGlbJson, writeGltf } from '@/export/writers/gltf';
import { DEFAULT_UV_MAPPING, type UvMapping } from '@/generators/uv';
import { buildTubeMesh, type TubeOptions } from '@/geometry/tubeMesher';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { readUvMapping } from '@/nodes/generators/uvConfig';
import { atlasHandlingOf } from '@/nodes/materials';
import { readTreeLightmap } from '@/graph/engine/assemble';
import { resetLightmap } from '@/app/lightmapControl';
import type { AppContext } from '@/app/context';
import { getMaterialLibrary } from '@/materials/library';
import { createMaterialDef } from '@/materials/shadingMath';
import { boxes, cards } from './helpers/exportScene';

beforeAll(() => registerDiscoveredNodes());

// ---- helpers -------------------------------------------------------------------------------------------------------------

const withUv1 = (m: MeshData): MeshData => ({ ...m, uv1: Float32Array.from(m.uv0) });

function withWind(m: MeshData): MeshData {
  const n = meshVertexCount(m);
  const pivot = new Float32Array(n * 3);
  const weights = new Float32Array(n * 4);
  const phase1 = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pivot.set([0, 0, 1], i * 3);
    weights.set([0.2, 0.4, 0.6, 0.25 + (i % 4) * 0.1], i * 4);
    phase1[i] = 0.5;
  }
  return { ...m, wind: { pivot, weights, phase1 } };
}

const entry = (nodeId: string, mesh: MeshData, lightmapWeight?: number): SceneEntry => ({ nodeId, type: 'x', statsGroup: nodeId, mesh, rev: nodeId, ...(lightmapWeight !== undefined ? { lightmapWeight } : {}) });

function sceneOf(entries: SceneEntry[], extra: Partial<SceneModel> = {}): SceneModel {
  return { entries, skeletons: [], stats: { triangles: 0, vertices: 0, bones: 0, groups: [], totalInstances: 0 }, ...extra };
}

const encoder: MaterialExportContext['encode'] = async (img) => ({ data: encodePng(img), mime: 'image/png', ext: 'png' });

function env(scene: SceneModel, defs: MaterialDef[], images: Record<string, RGBAImage> = {}): ExportEnv {
  return {
    source: { seed: 3, evaluateAt: async (lod) => ({ run: 1, lod, preview: false, totalMs: 0, evaluated: 0, cached: 0, skipped: 0, errors: 0, diagnostics: new Map(), edgeLabels: new Map(), scene }) },
    levels: defaultLodLevels(),
    materials: { material: (id) => defs.find((d) => d.id === id || d.name === id), loadImage: async (a) => images[a] ?? null, encode: encoder, alphaThreshold: 0.5 },
    nodeName: (id) => id,
    wind: null,
    seed: 3,
    verifyWithLoader: false,
  };
}

const run = (e: ExportEnv, patch: Partial<ReturnType<typeof defaultExportSettings>> = {}) => runExport(e, { ...defaultExportSettings('Plant'), verify: false, ...patch }, new CancellationSource().token, () => undefined);

function pattern(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): RGBAImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(f(x, y), (y * w + x) * 4);
  return img;
}

// ---- 1. wind data --------------------------------------------------------------------------------------------------------

describe('wind data in the export', () => {
  it('writes _WIND_PIVOT / _WIND_WEIGHTS / _WIND_PHASE1 and they can be read back from the GLB', () => {
    const g = mergeToPlantGeometry('Plant', [withWind(cards(6, 'leaf'))]);
    const out = writeGltf({ name: 's', images: [], materials: [{ name: 'Leaf', baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1, alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: true }], materialIndex: new Map([['leaf', 0]]), nodes: [{ name: 'Plant', geometry: g }] }, { binary: true, customAttributes: true, vertexColors: false, baseName: 'p' });
    const bytes = out.files[0]!.data as Uint8Array;
    const { json, bin } = readGlbJson(bytes);
    const attrs = (json as unknown as { meshes: { primitives: { attributes: Record<string, number> }[] }[] }).meshes[0]!.primitives[0]!.attributes;
    expect(Object.keys(attrs)).toEqual(expect.arrayContaining(['_WIND_PIVOT', '_WIND_WEIGHTS', '_WIND_PHASE1']));
    const acc = (json as unknown as { accessors: { bufferView: number; byteOffset?: number; count: number; type: string }[]; bufferViews: { byteOffset?: number }[] });
    const a = acc.accessors[attrs._WIND_WEIGHTS as number]!;
    expect(a.type).toBe('VEC4');
    const off = (acc.bufferViews[a.bufferView]?.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const read = new Float32Array(bin!.buffer.slice(bin!.byteOffset + off, bin!.byteOffset + off + a.count * 16));
    expect(Array.from(read)).toEqual(Array.from(g.wind!.weights));
  });

  it('runs the wind seam audit on the export meshes and puts it in the report and the metadata', async () => {
    const scene = sceneOf([entry('Leaves', withWind(cards(10, 'leaf'))), entry('Bark', boxes([2, 1], 'bark'))]);
    const r = await run(env(scene, [createMaterialDef('bark', 'Bark'), createMaterialDef('leaf', 'Leaf')]));
    expect(r.windAudit?.checked).toBe(true);
    expect(r.windAudit?.vertices).toBe(40);
    const meta = JSON.parse(String(r.files.find((f) => f.name.endsWith('.kekenik.json'))!.data)) as { windAudit: { checked: boolean } };
    expect(meta.windAudit.checked).toBe(true);
  });

  it('audits every exported LOD, not only the first', async () => {
    const scene = sceneOf([entry('Leaves', withWind(cards(10, 'leaf'))), entry('Bark', boxes([2, 1], 'bark'))]);
    const r = await run(env(scene, [createMaterialDef('bark', 'Bark'), createMaterialDef('leaf', 'Leaf')]), { lods: [0, 1] });
    expect(r.windAuditLods.map((l) => l.lod)).toEqual([0, 1]);
    expect(r.windAuditLods.every((l) => l.audit.checked)).toBe(true);
    expect(r.windAudit).toBe(r.windAuditLods[0]!.audit);
    const meta = JSON.parse(String(r.files.find((f) => f.name.endsWith('.kekenik.json'))!.data)) as { windAuditLods: { lod: number }[] };
    expect(meta.windAuditLods.map((l) => l.lod)).toEqual([0, 1]);
  });

  it('warns when coincident vertices of different generators move apart above the threshold', () => {
    const a = withWind(cards(1, 'leaf'));
    const b = withWind(cards(1, 'leaf'));
    a.wind!.weights.fill(0);
    for (let i = 0; i < 4; i++) b.wind!.weights.set([0.9, 0.9, 0, 0], i * 4);
    const audit = auditExportWind([{ id: 'a', mesh: a }, { id: 'b', mesh: b }], null, 3);
    expect(audit.checked).toBe(true);
    expect(audit.ok).toBe(false);
    expect(audit.coincidentMaxGap).toBeGreaterThan(audit.threshold);
  });

  it('is skipped (no failure) without wind data', () => {
    expect(auditExportWind([{ id: 'a', mesh: cards(2) }], null, 3).checked).toBe(false);
  });
});

// ---- 2. texture packing --------------------------------------------------------------------------------------------------

describe('texture packer', () => {
  const color = pattern(4, 4, (x, y) => [x * 60, y * 60, 200 - x * 10, 255]);
  const opacity = pattern(4, 4, (x, y) => [(x + y) * 30, 0, 0, 255]);
  const normal = pattern(4, 4, (x, y) => [100 + x * 10, 80 + y * 10, 230, 255]);
  const ao = pattern(4, 4, (x) => [x * 70, 0, 0, 255]);
  const gloss = pattern(4, 4, (_x, y) => [y * 70, 0, 0, 255]);
  const metal = pattern(4, 4, (x, y) => [(x * y) * 20, 0, 0, 255]);
  const height = pattern(4, 4, (x, y) => [x * 20 + y * 5, 0, 0, 255]);
  const inputs = { images: { color, opacity, normal, ao, gloss, metallic: metal, height }, scalars: { ao: 1, gloss: 1, metallic: 1 } };
  const opts = { forceTextures: false, alphaCutoff: 0.5, maxSize: 0 };
  const at = (img: RGBAImage, i: number, c: number): number => img.data[i * 4 + c] as number;

  it('ships the three presets plus the legacy id', () => {
    expect(PACKER_IDS).toEqual(['legacy', 'kekenik', 'unity-urp', 'unreal']);
  });

  it('Kekenik default: RGBA colour + opacity, normal + height, ORM channels equal their sources', () => {
    const res = runPacker(getPacker('kekenik')!, inputs, opts);
    const [base, nrm, orm] = res.textures;
    expect(res.textures.map((t) => t.suffix)).toEqual(['basecolor', 'normal', 'orm']);
    for (let i = 0; i < 16; i++) {
      expect([at(base!.image, i, 0), at(base!.image, i, 1), at(base!.image, i, 2)]).toEqual([at(color, i, 0), at(color, i, 1), at(color, i, 2)]);
      expect(at(base!.image, i, 3)).toBe(at(opacity, i, 0));
      expect([at(nrm!.image, i, 0), at(nrm!.image, i, 1), at(nrm!.image, i, 2)]).toEqual([at(normal, i, 0), at(normal, i, 1), at(normal, i, 2)]);
      expect(at(nrm!.image, i, 3)).toBe(at(height, i, 0));
      expect(at(orm!.image, i, 0)).toBe(at(ao, i, 0));
      expect(at(orm!.image, i, 1)).toBe(255 - at(gloss, i, 0));
      expect(at(orm!.image, i, 2)).toBe(at(metal, i, 0));
    }
  });

  it('Unity URP puts smoothness in A of the metallic map and AO in G; Unreal flips the normal green', () => {
    const urp = runPacker(getPacker('unity-urp')!, inputs, opts);
    const mg = urp.textures.find((t) => t.suffix === 'MetallicGloss')!;
    const occ = urp.textures.find((t) => t.suffix === 'Occlusion')!;
    const unreal = runPacker(getPacker('unreal')!, inputs, opts);
    const nrm = unreal.textures.find((t) => t.suffix === 'Normal')!;
    for (let i = 0; i < 16; i++) {
      expect(at(mg.image, i, 0)).toBe(at(metal, i, 0));
      expect(at(mg.image, i, 3)).toBe(at(gloss, i, 0));
      expect(at(occ.image, i, 1)).toBe(at(ao, i, 0));
      expect(at(nrm.image, i, 1)).toBe(255 - at(normal, i, 1));
      expect(at(nrm.image, i, 0)).toBe(at(normal, i, 0));
    }
  });

  it('ForceTextures: a solid value stays a constant unless forced, then it is a tiny texture', () => {
    const empty = { images: {}, scalars: { ao: 1, gloss: 0.25, metallic: 0 } };
    const def = getPacker('kekenik')!.textures[2]!;
    const plain = packTexture(def, empty, opts);
    expect('constants' in plain).toBe(true);
    if ('constants' in plain) expect(plain.constants).toEqual([1, 0.75, 0, 1]);
    const forced = packTexture(def, empty, { ...opts, forceTextures: true });
    expect('image' in forced).toBe(true);
    if ('image' in forced) {
      expect([forced.image.width, forced.image.height]).toEqual([4, 4]);
      expect(Array.from(forced.image.data.slice(0, 4))).toEqual([255, 191, 0, 255]);
      expect(forced.forced).toBe(true);
    }
    expect(runPacker(getPacker('kekenik')!, empty, opts).textures).toHaveLength(0);
    expect(runPacker(getPacker('kekenik')!, empty, { ...opts, forceTextures: true }).textures.every((t) => t.forced)).toBe(true);
  });

  it('mip flags: RgbIsNormal renormalises, AlphaIsOpacity keeps the coverage', () => {
    const res = runPacker(getPacker('kekenik')!, inputs, opts);
    const nrm = res.textures[1]!;
    expect(nrm.mips).toHaveLength(3);
    for (const m of nrm.mips.slice(1)) {
      const len = Math.hypot((m.data[0]! / 255) * 2 - 1, (m.data[1]! / 255) * 2 - 1, (m.data[2]! / 255) * 2 - 1);
      expect(len).toBeCloseTo(1, 1);
    }
    const cut = pattern(8, 8, (x) => [200, 200, 200, x < 3 ? 255 : 0]);
    const def = getPacker('kekenik')!.textures[0]!;
    const coverage = (img: RGBAImage): number => Array.from({ length: img.width * img.height }, (_, i) => img.data[i * 4 + 3]! >= 128).filter(Boolean).length / (img.width * img.height);
    const chain = buildMips(def, cut, 0.5);
    expect(coverage(chain[0]!)).toBeCloseTo(3 / 8, 5);
    expect(coverage(chain[1]!)).toBeGreaterThan(0.25);
    expect(coverage(chain[1]!)).toBeLessThanOrEqual(0.5);
  });

  it('is deterministic', () => {
    const a = runPacker(getPacker('unreal')!, inputs, opts);
    const b = runPacker(getPacker('unreal')!, inputs, opts);
    expect(a.textures.map((t) => Array.from(t.image.data))).toEqual(b.textures.map((t) => Array.from(t.image.data)));
  });

  it('DDS output holds the whole mip chain and the base level equals the packed image', () => {
    const packed = runPacker(getPacker('kekenik')!, inputs, opts);
    const t = packed.textures[0]!;
    const dds = encodeDds(t.mips);
    const view = new DataView(dds.buffer, dds.byteOffset, dds.byteLength);
    expect(view.getUint32(0, true)).toBe(0x20534444);
    expect(view.getUint32(12, true)).toBe(t.image.height);
    expect(view.getUint32(16, true)).toBe(t.image.width);
    expect(view.getUint32(28, true)).toBe(t.mips.length);
    expect(dds.length).toBe(128 + t.mips.reduce((n, m) => n + m.data.length, 0));
    expect(Array.from(dds.slice(128, 128 + t.image.data.length))).toEqual(Array.from(t.image.data));
    expect(() => encodeDds([])).toThrow();
  });

  it('the export writes packed maps as DDS when asked and reports the mip levels', async () => {
    const mat = createMaterialDef('bark', 'Bark');
    mat.slots.color = { texture: { assetId: 'c' } } as MaterialDef['slots']['color'];
    const scene = sceneOf([entry('Bark', boxes([2, 1], 'bark'))]);
    const settings = defaultExportSettings('Plant');
    const r = await run(env(scene, [mat], { c: color }), { textures: { ...settings.textures, packer: 'kekenik', packedFormat: 'dds' } });
    expect(r.packedTextures.length).toBeGreaterThan(0);
    expect(r.packedTextures.every((f) => f.endsWith('.dds'))).toBe(true);
    const meta = JSON.parse(String(r.files.find((f) => f.name.endsWith('.kekenik.json'))!.data)) as { packing: { materials: { textures: { mipLevels: number }[] }[] } };
    expect(meta.packing.materials[0]!.textures[0]!.mipLevels).toBe(3);
  });

  it('the export writes the packed textures and records them in the metadata', async () => {
    const mat = createMaterialDef('bark', 'Bark');
    mat.slots.color = { texture: { assetId: 'c' } } as MaterialDef['slots']['color'];
    mat.slots.normal = { texture: { assetId: 'n' } } as MaterialDef['slots']['normal'];
    const scene = sceneOf([entry('Bark', boxes([2, 1], 'bark'))]);
    const settings = defaultExportSettings('Plant');
    const r = await run(env(scene, [mat], { c: color, n: normal }), { textures: { ...settings.textures, packer: 'kekenik', forceTextures: true } });
    expect(r.packedTextures).toEqual(['textures/Bark_basecolor.png', 'textures/Bark_normal.png', 'textures/Bark_orm.png']);
    expect(r.files.some((f) => f.name === 'textures/Bark_orm.png')).toBe(true);
  });
});

// ---- 3. V-tiling ---------------------------------------------------------------------------------------------------------

describe('V-tiling', () => {
  const tiled = (): MeshData => {
    const m = boxes([1, 1, 1], 'bark');
    for (let i = 0; i < 12; i++) m.uv0[i * 2 + 1] = [0.3, 0.3, 2.9, 2.9][i % 4]!;
    return m;
  };

  it('stretches a tiled primitive to whole V repeats from 0 and leaves untiled ones alone', () => {
    const g = mergeToPlantGeometry('p', [tiled(), cards(2, 'leaf')]);
    const leafUv = Array.from(g.uv0.slice(12 * 2));
    const entries = applyVTiling([g]);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.applied).toBe(true);
    expect(e.repeats).toBe(3);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 12; i++) {
      min = Math.min(min, g.uv0[i * 2 + 1]!);
      max = Math.max(max, g.uv0[i * 2 + 1]!);
    }
    expect(min).toBeCloseTo(0, 6);
    expect(max).toBeCloseTo(3, 6);
    expect(Array.from(g.uv0.slice(12 * 2))).toEqual(leafUv);
  });

  it('skips Force out materials, reports a fractional U tile count and the resolution loss', () => {
    const g = mergeToPlantGeometry('p', [tiled()]);
    expect(applyVTiling([g], { skipMaterial: () => true })).toHaveLength(0);
    const m = tiled();
    for (let i = 0; i < 12; i++) m.uv0[i * 2] = [0, 2.5, 2.5, 0][i % 4]!;
    for (let i = 0; i < 12; i++) m.uv0[i * 2 + 1] = [0, 0, 2.4, 2.4][i % 4]!;
    const g2 = mergeToPlantGeometry('p', [m]);
    const [e] = applyVTiling([g2]);
    expect(e!.uTilesWhole).toBe(false);
    expect(e!.stretch).toBeCloseTo(2 / 2.4, 6);
    expect(e!.resolutionLossPercent).toBeCloseTo((1 - 2 / 2.4) * 100, 4);
    expect(vTilingWarnings([e!], (id) => id).join(' ')).toMatch(/U tiles/);
  });

  it('the export option changes only tiled UVs and is off by default', async () => {
    const scene = sceneOf([entry('Bark', tiled())]);
    const defs = [createMaterialDef('bark', 'Bark')];
    const off = await run(env(scene, defs));
    expect(off.vTiling).toEqual([]);
    const on = await run(env(sceneOf([entry('Bark', tiled())]), defs), { vTiling: true });
    expect(on.vTiling).toHaveLength(1);
    expect(on.vTiling[0]!.repeats).toBe(3);
    const forced = createMaterialDef('bark', 'Bark');
    forced.atlas.handling = 'forceOut';
    const skipped = await run(env(sceneOf([entry('Bark', tiled())]), [forced]), { vTiling: true });
    expect(skipped.vTiling).toEqual([]);
  });
});

// ---- 4. UV seams ---------------------------------------------------------------------------------------------------------

function line(points: number, length: number, radius: number): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let k = 0; k < points; k++) sb.addPoint(0, 0, (k * length) / (points - 1), radius);
  sb.endBranch();
  return sb.build();
}
const tube = (mapping: Partial<UvMapping>, sides = 8): TubeOptions => ({ maxGeneration: 8, radialSegments: () => sides, color: () => [0.3, 0.2, 0.1], uvMetres: 1, materialId: 'bark', uvMapping: { ...DEFAULT_UV_MAPPING, uAbsolute: 2, uRelative: 0, ...mapping } });

function welded(m: MeshData): { ids: Int32Array; count: number } {
  const keys = new Map<string, number>();
  const n = meshVertexCount(m);
  const ids = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const k = [0, 1, 2].map((c) => Math.round((m.positions[i * 3 + c] as number) * 1e4)).join(',');
    let id = keys.get(k);
    if (id === undefined) {
      id = keys.size;
      keys.set(k, id);
    }
    ids[i] = id;
  }
  return { ids, count: keys.size };
}

function groupsByPosition(m: MeshData): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < meshVertexCount(m); i++) {
    const k = [0, 1, 2].map((c) => Math.round((m.positions[i * 3 + c] as number) * 1e4)).join(',');
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  return groups;
}

function openEdges(m: MeshData): number {
  const { ids } = welded(m);
  const edges = new Map<string, number>();
  for (let t = 0; t + 2 < m.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = ids[m.indices[t + e] as number] as number;
      const b = ids[m.indices[t + ((e + 1) % 3)] as number] as number;
      if (a === b) continue;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  return [...edges.values()].filter((c) => c === 1).length;
}

describe('UV seams (Create seams)', () => {
  const plain = buildTubeMesh(line(5, 2, 0.1), tube({}));
  const seamed = buildTubeMesh(line(5, 2, 0.1), tube({ createSeams: true }));

  it('is off by default and the param exists with a tooltip', () => {
    expect(readUvMapping({}).createSeams).toBe(false);
    const p = getNodeDef('generator.branch')!.params.find((d) => d.id === 'uvCreateSeams');
    expect(p?.default).toBe(false);
    expect(p?.tooltip).toBeTruthy();
    expect(Array.from(buildTubeMesh(line(5, 2, 0.1), tube({ createSeams: false })).positions)).toEqual(Array.from(plain.positions));
  });

  it('duplicates ring vertices exactly at the whole U tile borders (one per ring for 2 tiles)', () => {
    const rings = 5;
    expect(meshVertexCount(seamed) - meshVertexCount(plain)).toBe(rings);
    const before = groupsByPosition(plain);
    const added = [...groupsByPosition(seamed)].filter(([k, g]) => g.length > (before.get(k)?.length ?? 0));
    expect(added.length).toBe(rings);
    for (const [, g] of added) for (const i of g) {
      const u = seamed.uv0[i * 2] as number;
      expect(Math.abs(u - Math.round(u))).toBeLessThan(1e-6);
    }
  });

  it('the welded mesh is identical in position and has no new open edges; normals match across the seam', () => {
    expect(welded(seamed).count).toBe(welded(plain).count);
    expect(openEdges(seamed)).toBe(openEdges(plain));
    const before = groupsByPosition(plain);
    let compared = 0;
    for (const [k, g] of groupsByPosition(seamed)) {
      if (g.length <= (before.get(k)?.length ?? 0)) continue;
      const [i, ...rest] = g as [number, ...number[]];
      for (const j of rest) {
        if (seamed.uv0[i * 2] !== seamed.uv0[j * 2] || seamed.uv0[i * 2 + 1] !== seamed.uv0[j * 2 + 1]) continue;
        compared++;
        const dot = (seamed.normals[i * 3] as number) * (seamed.normals[j * 3] as number) + (seamed.normals[i * 3 + 1] as number) * (seamed.normals[j * 3 + 1] as number) + (seamed.normals[i * 3 + 2] as number) * (seamed.normals[j * 3 + 2] as number);
        expect(dot).toBeGreaterThan(0.999);
      }
    }
    expect(compared).toBeGreaterThanOrEqual(5);
  });
});

// ---- 5. lightmap UVs -----------------------------------------------------------------------------------------------------

describe('lightmap UV packing', () => {
  const inputs = (leaves = 40): LightmapInput[] => [
    { id: 'Bark', mesh: withUv1(boxes([3, 2, 1, 1.5], 'bark')), weight: 1, unwrapScale: 1, forceOut: false },
    { id: 'Branches', mesh: withUv1(boxes([1, 1], 'bark')), weight: 2, unwrapScale: 1, forceOut: false },
    { id: 'Leaves', mesh: withUv1(cards(leaves, 'leaf')), weight: 0, unwrapScale: 1, forceOut: false },
  ];
  const overlap = (a: number[], b: number[]): boolean => a[0]! < b[2]! - 1e-9 && b[0]! < a[2]! - 1e-9 && a[1]! < b[3]! - 1e-9 && b[1]! < a[3]! - 1e-9;

  it('islands do not overlap and every UV fits [0, 1]; leaves take one texel each', () => {
    const res = packLightmap(inputs(), { resolution: 64, layout: 'atlas' });
    const isl = res.report.islands;
    for (let i = 0; i < isl.length; i++) for (let j = i + 1; j < isl.length; j++) expect(overlap(isl[i]!.rect, isl[j]!.rect)).toBe(false);
    res.meshes.forEach((m, k) => {
      const rect = isl[k]!.rect;
      for (const [i, c] of Array.from(m.uv1 ?? []).entries()) {
        expect(c).toBeGreaterThanOrEqual(-1e-6);
        expect(c).toBeLessThanOrEqual(1 + 1e-6);
        expect(c).toBeGreaterThanOrEqual(rect[i % 2]! - 1e-6);
        expect(c).toBeLessThanOrEqual(rect[(i % 2) + 2]! + 1e-6);
      }
    });
    const leaves = res.meshes[2]!;
    const texels = new Set<string>();
    for (let leaf = 0; leaf < 40; leaf++) {
      const u = leaves.uv1![leaf * 8]!;
      const v = leaves.uv1![leaf * 8 + 1]!;
      for (let k = 1; k < 4; k++) expect([leaves.uv1![leaf * 8 + k * 2], leaves.uv1![leaf * 8 + k * 2 + 1]]).toEqual([u, v]);
      texels.add(`${Math.floor(u * 64)},${Math.floor(v * 64)}`);
    }
    expect(texels.size).toBe(40);
    expect(isl[2]!.texelsPerMetre).toBe(0);
  });

  it('fits everything into the resolution by scaling and reports the achieved density', () => {
    const small = packLightmap(inputs(), { resolution: 32, layout: 'atlas' });
    const big = packLightmap(inputs(), { resolution: 256, layout: 'atlas' });
    expect(small.report.texelsPerMetre).toBeGreaterThan(0);
    expect(big.report.texelsPerMetre / small.report.texelsPerMetre).toBeGreaterThan(4);
    expect(big.report.fill).toBeLessThanOrEqual(1);
    const w1 = big.report.islands[0]!;
    const w2 = big.report.islands[1]!;
    expect(w2.texelsPerMetre / w1.texelsPerMetre).toBeCloseTo(2, 6);
  });

  it('weight and unwrap scale multiply the density; Force out pieces are untouched', () => {
    const list = inputs();
    list[1] = { ...list[1]!, weight: 1, unwrapScale: 3 };
    list[0] = { ...list[0]!, forceOut: true };
    const res = packLightmap(list, { resolution: 128, layout: 'atlas' });
    expect(res.meshes[0]).toBe(list[0]!.mesh);
    expect(res.report.islands.map((i) => i.id)).toEqual(['Branches', 'Leaves']);
  });

  it('UDIM gives every piece its own tile inside [0, 1] of that tile', () => {
    const res = packLightmap(inputs(), { resolution: 64, layout: 'udim' });
    expect(res.report.islands.map((i) => i.tile)).toEqual([1001, 1002, 1003]);
    res.meshes.forEach((m, k) => {
      for (let i = 0; i < m.uv1!.length; i += 2) {
        expect(m.uv1![i]! - k).toBeGreaterThanOrEqual(-1e-6);
        expect(m.uv1![i]! - k).toBeLessThanOrEqual(1 + 1e-6);
        expect(m.uv1![i + 1]!).toBeLessThanOrEqual(1 + 1e-6);
      }
    });
  });

  it('is deterministic', () => {
    const a = packLightmap(inputs(), { resolution: 64, layout: 'atlas' });
    const b = packLightmap(inputs(), { resolution: 64, layout: 'atlas' });
    expect(a.meshes.map((m) => Array.from(m.uv1!))).toEqual(b.meshes.map((m) => Array.from(m.uv1!)));
  });

  it('Tree > Lightmap and the generator params have neutral, documented defaults', () => {
    expect(readTreeLightmap({})).toEqual({ enabled: false, resolution: 1024, layout: 'atlas' });
    const tree = getNodeDef('output.tree')!.params;
    for (const id of ['lightmapEnabled', 'lightmapResolution', 'lightmapLayout']) expect(tree.find((p) => p.id === id)?.tooltip).toBeTruthy();
    const weight = (type: string): unknown => getNodeDef(type)!.params.find((p) => p.id === 'lightmapWeight')?.default;
    expect(weight('generator.branch')).toBe(1);
    expect(weight('generator.leaf')).toBe(0);
  });

  it('the export packs UV1 only when Tree > Lightmap is enabled (and reports the density)', async () => {
    const defs = [createMaterialDef('bark', 'Bark'), createMaterialDef('leaf', 'Leaf')];
    const mk = (enabled: boolean): SceneModel => sceneOf([entry('Bark', withUv1(boxes([2, 1], 'bark')), 1), entry('Leaves', withUv1(cards(8, 'leaf')), 0)], { lightmap: { enabled, resolution: 64, layout: 'atlas' } });
    const off = await run(env(mk(false), defs));
    expect(off.lightmap).toBeNull();
    const on = await run(env(mk(true), defs));
    expect(on.lightmap?.islands).toHaveLength(2);
    expect(on.lightmap?.texelsPerMetre).toBeGreaterThan(0);
    const again = await run(env(mk(true), defs));
    expect(Array.from(again.files[0]!.data as Uint8Array)).toEqual(Array.from(on.files[0]!.data as Uint8Array));
  });
});

// ---- 6. atlas handling / back-compat -------------------------------------------------------------------------------------

describe('atlas handling and old settings', () => {
  it('Force out is a material atlas handling value; the other values keep their meaning', () => {
    expect(atlasHandlingOf('force-out')).toBe('forceOut');
    expect(atlasHandlingOf('default')).toBe('default');
    expect(atlasHandlingOf('cutout')).toBe('cutout');
    expect(atlasHandlingOf('mesh')).toBe('mesh');
    const def = getNodeDef('material.material') ?? getNodeDef('material.standard');
    const p = def?.params.find((x) => x.id === 'atlasHandling');
    if (p) expect(p.default).toBe('default');
  });

  it('old export settings load with the new options off and an old export is byte-identical', async () => {
    const old = { format: 'glb', textures: { enabled: true, format: 'png', quality: 0.9, maxSize: 0, packing: 'orm', padding: 4, external: false } };
    const s = sanitizeExportSettings(old, 4);
    expect(s.vTiling).toBe(false);
    expect(s.textures.packer).toBe('legacy');
    expect(s.textures.forceTextures).toBe(false);
    expect(s.textures.packedFormat).toBe('png');
    const defs = [createMaterialDef('bark', 'Bark'), createMaterialDef('leaf', 'Leaf')];
    const scene = (): SceneModel => sceneOf([entry('Bark', boxes([2, 1], 'bark')), entry('Leaves', cards(8, 'leaf'))]);
    const a = await run(env(scene(), defs));
    const b = await run(env(scene(), defs), { vTiling: false });
    expect(a.packedTextures).toEqual([]);
    expect(a.lightmap).toBeNull();
    expect(Array.from(a.files[0]!.data as Uint8Array)).toEqual(Array.from(b.files[0]!.data as Uint8Array));
  });
});

describe('Reset lightmap command', () => {
  it('puts the unwrap scale of library materials back to 1 and counts the changes', () => {
    const lib = getMaterialLibrary();
    const mat = createMaterialDef('bark', 'Bark');
    lib.bind(() => ({ materials: [mat], materialSets: [], masks: [], displacements: [], cutoutMeshes: [], uvAreas: [], assets: [] }), null);
    try {
      lib.edit('test', 'materials', () => {
        mat.atlas.unwrapScale = 3;
      });
      const app = { graph: { model: { nodes: () => [] }, transaction: () => undefined } } as unknown as AppContext;
      expect(resetLightmap(app)).toBe(1);
      expect(mat.atlas.unwrapScale).toBe(1);
      expect(resetLightmap(app)).toBe(0);
    } finally {
      lib.bind(() => undefined, null);
    }
  });
});
