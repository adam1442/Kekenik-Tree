import type { SceneEntry, SceneModel } from '@/contracts/engine';
import type { DynamicLodReport } from '@/lod/dynamic';
import type { WindSettings } from '@/contracts/material';
import { CancelledError, type CancellationToken } from '@/contracts/nodes';
import { bakeVertexAo } from './bake/aoBake';
import { applyVertexColorPacking, sceneVertexColor } from './vertexColorExport';
import { buildGeometries, geometryStats, transformGeometry, usedMaterialIds, type PlantGeometry } from './geometry';
import { encodePng, transformNormalImage } from './images/imageOps';
import { billboardQuad, computeLayout, frameTransform, mergeBillboards, nearestFrame, type ImpostorLayout } from './impostor/impostorLayout';
import type { ImpostorMaterial, ImpostorRenderInput, ImpostorRenderResult } from './impostor/impostorRender';
import { buildLods, type BuiltLod, type LodSceneSource } from './lod/lodBuilder';
import { exportMaterials, imageFiles, type MaterialExportContext, type MaterialExportResult } from './materials/materialExport';
import { transformFromSettings, transformPoint, type ExportTransform } from './transform';
import type { ExportFile, ExportProgress, ExportSettings, GeometryStats, LodLevelSettings } from './types';
import { UNIT_SCALE } from './types';
import { compareStats, statsFromJson, verifyGlb, type ModelStats, type VerifyReport } from './verify';
import { writeGltf, type GltfImage, type GltfMaterial, type GltfNodeInput, type GltfScene } from './writers/gltf';
import { writeObj, writePly, writeStl, type ObjMaterial } from './writers/simpleFormats';
import { zipFiles } from './zip';
import { applyVTiling, vTilingWarnings, type VTilingEntry } from './atlas/vTiling';
import { packLightmap, weightedUnwrapScale, type LightmapInput, type LightmapReport } from './lightmap/lightmapPack';
import { auditExportWind, windAuditWarning, type WindExportAudit } from './windAuditReport';

/** Orchestrates one export: LODs -> bake -> materials / textures -> impostor -> writers -> verify -> bundle. */

export interface ExportEnv {
  source: LodSceneSource;
  levels: readonly LodLevelSettings[];
  materials: MaterialExportContext;
  /** Display name of a graph node (falls back to the node type). */
  nodeName(nodeId: string): string | undefined;
  /** Project wind settings (scene wind node overrides it in the metadata). */
  wind: WindSettings | null;
  seed: number;
  /** Impostor renderer (WebGL); omitted in headless runs. */
  renderImpostor?: (input: ImpostorRenderInput, token: CancellationToken, onProgress: (f: number) => void) => Promise<ImpostorRenderResult>;
  /** Run the GLTFLoader pass of the verifier (browser / jsdom). */
  verifyWithLoader?: boolean;
}

export interface LodOutput {
  index: number;
  level: LodLevelSettings;
  stats: GeometryStats;
  file: string;
}

export interface ExportResult {
  /** Everything that was written (before bundling). */
  files: ExportFile[];
  /** What the user downloads: one model file, or the zip. */
  download: ExportFile;
  lods: LodOutput[];
  /** Dynamic LOD levels: LOD value, triangle counts and the share of the removed triangles that were interior (hidden). */
  dynamicLevels: { index: number; report: DynamicLodReport; triangles: number }[];
  warnings: string[];
  verification: VerifyReport[];
  textureBytes: number;
  /** T03 wind-seam audit of the export meshes (null when the plant has no wind data). */
  windAudit: WindExportAudit | null;
  /** The same audit for every exported LOD (index = LOD number), `windAudit` being the first of them. */
  windAuditLods: { lod: number; audit: WindExportAudit }[];
  /** Lightmap UV packing report (null unless Tree > Lightmap is enabled). */
  lightmap: LightmapReport | null;
  /** V-tiling remaps (empty unless the option is on). */
  vTiling: VTilingEntry[];
  /** Files written by the selected packer (empty with `legacy`). */
  packedTextures: string[];
}

/** Metadata of the Dynamic LOD levels: the impostor (when exported) is the last level, after the geometry levels. */
function dynamicLevelsMeta(exported: readonly { built: BuiltLod; geometries: PlantGeometry[] }[], impostor: boolean): Record<string, unknown> | null {
  const levels = exported.filter((e) => e.built.dynamic);
  if (levels.length === 0) return null;
  return {
    levels: levels.map((e) => ({ lod: e.built.index, value: e.built.dynamic?.value ?? 0, triangles: geometryStats(e.geometries).triangles, interiorRemovedShare: e.built.dynamic?.interiorRemovedShare ?? 0 })),
    impostorIsLastLevel: impostor,
  };
}

const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'Plant';

interface NamedEntry {
  name: string;
  mesh: SceneEntry['mesh'];
  nodeId: string;
  lightmapWeight: number;
}

function nameEntries(entries: readonly SceneEntry[], env: ExportEnv): NamedEntry[] {
  const used = new Map<string, number>();
  return entries
    .filter((e) => e.mesh.indices.length > 0)
    .map((e) => {
      const base = safeName(env.nodeName(e.nodeId) ?? e.type);
      const n = used.get(base) ?? 0;
      used.set(base, n + 1);
      return { name: n === 0 ? base : `${base}_${n}`, mesh: e.mesh, nodeId: e.nodeId, lightmapWeight: e.lightmapWeight ?? 1 };
    });
}

/** Vertical extent (max z) of a position array. */
function boundsHeight(p: Float32Array): number {
  let z = 0;
  for (let i = 2; i < p.length; i += 3) z = Math.max(z, p[i] as number);
  return z;
}

const throwIfCancelled = (t: CancellationToken): void => t.throwIfCancelled();

function impostorMaterials(res: MaterialExportResult): Map<string, ImpostorMaterial> {
  const out = new Map<string, ImpostorMaterial>();
  for (const [id, index] of res.materialIndex) {
    const m = res.materials[index] as GltfMaterial;
    const record = res.records[index];
    out.set(id, {
      color: [m.baseColorFactor[0], m.baseColorFactor[1], m.baseColorFactor[2]],
      cutoff: m.alphaMode === 'MASK' ? m.alphaCutoff : 0,
      doubleSided: m.doubleSided,
      albedo: record ? (res.albedo.get(record.id) ?? null) : null,
    });
  }
  return out;
}

/** Remap billboard UVs into one atlas frame (for formats without KHR_texture_transform). Bottom-left UV origin. */
function bakeFrameUv(g: PlantGeometry, layout: ImpostorLayout, frameIndex: number): void {
  const f = layout.frames[frameIndex];
  if (!f) return;
  const w = layout.cols * layout.frameSize;
  const h = layout.rows * layout.frameSize;
  const u0 = f.rect[0] / w;
  const su = f.rect[2] / w;
  const v1 = 1 - f.rect[1] / h;
  const sv = f.rect[3] / h;
  for (let i = 0; i + 1 < g.uv0.length; i += 2) {
    g.uv0[i] = u0 + (g.uv0[i] as number) * su;
    g.uv0[i + 1] = v1 - sv + (g.uv0[i + 1] as number) * sv;
  }
}

interface ImpostorOutput {
  files: ExportFile[];
  meta: Record<string, unknown>;
}

async function buildImpostor(
  env: ExportEnv,
  settings: ExportSettings,
  token: CancellationToken,
  transform: ExportTransform,
  sourceGeometries: PlantGeometry[],
  mats: MaterialExportResult,
  name: string,
  warnings: string[],
  progress: (f: number) => void,
): Promise<ImpostorOutput | null> {
  const imp = settings.impostor;
  if (imp.mode === 'off') return null;
  if (!env.renderImpostor) {
    warnings.push('Impostor skipped: no WebGL renderer is available in this environment.');
    return null;
  }
  const layout = computeLayout(imp);
  let render: ImpostorRenderResult;
  try {
    render = await env.renderImpostor({ geometries: sourceGeometries, materials: impostorMaterials(mats), settings: imp, layout }, token, progress);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    warnings.push(`Impostor skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (render.normal) transformNormalImage(render.normal, transform.m);
  const files: ExportFile[] = [{ name: `${name}_impostor_albedo.png`, data: encodePng(render.albedo), mime: 'image/png' }];
  if (render.normal) files.push({ name: `${name}_impostor_normal.png`, data: encodePng(render.normal), mime: 'image/png' });
  if (render.depth) files.push({ name: `${name}_impostor_depth.png`, data: encodePng(render.depth), mime: 'image/png' });
  const atlasW = layout.cols * layout.frameSize;
  const atlasH = layout.rows * layout.frameSize;
  const center = transformPoint(transform, render.center);
  const radius = render.radius * transform.scale;
  const upAxis = settings.upAxis;
  const frames = layout.frames.map((f) => ({
    index: f.index,
    azimuthDeg: f.azimuthDeg,
    elevationDeg: f.elevationDeg,
    rectPx: f.rect,
    uvTopLeft: { offset: frameTransform(layout, f).offset, scale: frameTransform(layout, f).scale },
  }));
  const meta: Record<string, unknown> = {
    format: 'kekenik-impostor',
    version: 1,
    mode: imp.mode,
    atlas: { width: atlasW, height: atlasH, cols: layout.cols, rows: layout.rows, frameSize: layout.frameSize, padding: imp.padding },
    files: { albedo: `${name}_impostor_albedo.png`, normal: render.normal ? `${name}_impostor_normal.png` : null, depth: render.depth ? `${name}_impostor_depth.png` : null },
    center,
    radius,
    units: settings.units,
    upAxis,
    handedness: settings.handedness,
    frames,
    encoding: {
      albedo: 'sRGB RGBA, alpha = coverage (dilated colour under transparent texels)',
      normal: 'RGB = normal * 0.5 + 0.5 in EXPORT object space (same axes as the mesh); alpha = coverage',
      depth: 'R = 1 - linearDepth over [center - radius, center + radius] along the view axis (near = bright); alpha = coverage',
      views: 'Orthographic camera at +-2*radius from the centre, azimuth counter-clockwise seen from above in the source (Z-up) frame; the last frame is a top-down view when topView is on',
    },
  };

  // Billboard meshes (source space, transformed with the plant).
  const sourceMeshes: PlantGeometry[] = [];
  const materials: GltfMaterial[] = [];
  const materialIndex = new Map<string, number>();
  const quads: PlantGeometry[] = [];
  const make = (id: string, label: string, azimuth: number, frameIndex: number): void => {
    quads.push(billboardQuad(label, id, render.center, render.radius, azimuth));
    materialIndex.set(id, materials.length);
    materials.push({
      name: id,
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { image: 0, transform: frameTransform(layout, layout.frames[frameIndex] as ImpostorLayout['frames'][number]) },
      metallicFactor: 0,
      roughnessFactor: 1,
      alphaMode: 'MASK',
      alphaCutoff: 0.5,
      doubleSided: true,
      extras: { kekenik: { impostorFrame: frameIndex, azimuthDeg: azimuth } },
    });
  };
  if (imp.mode === 'impostor' || imp.mode === 'both') make('Impostor', `${name}_Impostor`, 0, 0);
  const crossQuads: PlantGeometry[] = [];
  if (imp.mode === 'cross' || imp.mode === 'both') {
    const f0 = nearestFrame(layout, 0);
    const f1 = nearestFrame(layout, 90);
    const before = quads.length;
    make('Cross_A', 'Cross_A', f0.azimuthDeg, f0.index);
    make('Cross_B', 'Cross_B', f1.azimuthDeg, f1.index);
    crossQuads.push(...quads.slice(before));
    if (Math.abs(f1.azimuthDeg - f0.azimuthDeg - 90) > 1e-6) warnings.push(`Cross billboard: the second quad uses the frame at ${f1.azimuthDeg}deg instead of 90deg (views must be a multiple of 4 for a perfect cross).`);
  }
  const impostorQuads = quads.filter((q) => !crossQuads.includes(q));
  if (impostorQuads.length > 0) sourceMeshes.push(mergeBillboards(`${name}_Impostor`, impostorQuads));
  if (crossQuads.length > 0) sourceMeshes.push(mergeBillboards(`${name}_Cross`, crossQuads));
  sourceMeshes.forEach((g) => transformGeometry(g, transform));

  const image: GltfImage = { name: `${name}_impostor_albedo`, mime: 'image/png', data: encodePng(render.albedo), uri: `${name}_impostor_albedo.png` };
  const extras = { name: `${name}_impostor`, impostor: meta };
  if (settings.format === 'glb' || settings.format === 'gltf') {
    const scene: GltfScene = {
      name: `${name}_impostor`,
      images: [image],
      materials,
      materialIndex,
      nodes: sourceMeshes.map((g): GltfNodeInput => ({ name: g.name, geometry: g })),
      extras,
    };
    const out = writeGltf(scene, { binary: settings.format === 'glb', customAttributes: false, vertexColors: false, baseName: `${name}_impostor` });
    files.push(...out.files);
  } else if (settings.format === 'obj') {
    const objMats = new Map<string, ObjMaterial>();
    materials.forEach((m) => objMats.set(m.name, { name: m.name, diffuse: [1, 1, 1], specular: [0, 0, 0], shininess: 0, opacity: 1, mapKd: image.uri, mapD: image.uri }));
    // OBJ has no texture transform: bake the frame rectangle into the UVs.
    for (const g of sourceMeshes) {
      const idx = g.primitives[0] ? materials.findIndex((m) => m.name === g.primitives[0]?.materialId) : 0;
      const frame = (materials[Math.max(0, idx)]?.extras?.kekenik as { impostorFrame: number } | undefined)?.impostorFrame ?? 0;
      bakeFrameUv(g, layout, frame);
    }
    files.push(...writeObj(`${name}_impostor`, sourceMeshes, objMats, false).files);
  } else if (settings.format === 'ply') {
    files.push(writePly(`${name}_impostor`, sourceMeshes));
  } else {
    files.push(writeStl(`${name}_impostor`, sourceMeshes));
  }
  files.push({ name: `${name}_impostor.json`, data: JSON.stringify(meta, null, 2), mime: 'application/json' });
  return { files, meta };
}

/** Scene entries that go into the export: the dropped-leaf ground cards only with Tree > Export dropped leaves. */
export function exportEntries(scene: SceneModel): SceneEntry[] {
  const keep = scene.season?.exportDropped === true;
  return scene.entries.filter((e) => keep || !e.ground);
}

function fileForLod(name: string, index: number, single: boolean, ext: string): string {
  return single ? `${name}.${ext}` : `${name}_LOD${index}.${ext}`;
}

export async function runExport(env: ExportEnv, settings: ExportSettings, token: CancellationToken, onProgress: (p: ExportProgress) => void): Promise<ExportResult> {
  const warnings: string[] = [];
  const name = safeName(settings.name);
  const stage = (label: string, from: number, to: number) => (f: number): void => onProgress({ stage: label, fraction: from + (to - from) * Math.min(1, Math.max(0, f)) });
  const transform = transformFromSettings(settings);

  // 1. LODs ---------------------------------------------------------------------------------------------------------
  const wanted = new Set(settings.lods.filter((i) => i < env.levels.length));
  if (wanted.size === 0) wanted.add(0);
  const impostorOn = settings.impostor.mode !== 'off';
  const impostorSource = Math.min(settings.impostor.sourceLod, env.levels.length - 1);
  const generate = [...new Set([...wanted, ...(impostorOn ? [impostorSource] : [])])].sort((a, b) => a - b);
  onProgress({ stage: 'Generating LODs', fraction: 0 });
  const built: BuiltLod[] = await buildLods(env.source, env.levels, generate, token, stage('Generating LODs', 0, 0.25));
  throwIfCancelled(token);

  const perLod = new Map<number, { built: BuiltLod; geometries: PlantGeometry[] }>();
  const isForceOut = (id: string): boolean => env.materials.material(id)?.atlas.handling === 'forceOut';
  let lightmapReport: LightmapReport | null = null;
  const windAuditLods: { lod: number; audit: WindExportAudit }[] = [];
  for (const b of built) {
    let named = nameEntries(exportEntries(b.scene), env);
    const lm = b.scene.lightmap;
    if (lm?.enabled && wanted.has(b.index)) {
      // Tree > Lightmap: a packed UV1 set (weights per generator, unwrap scale per material, Force out untouched).
      const inputs: LightmapInput[] = named.map((e) => ({
        id: e.name,
        mesh: e.mesh,
        weight: e.lightmapWeight,
        unwrapScale: weightedUnwrapScale(e.mesh, (m) => Math.max(0.01, env.materials.material(m)?.atlas.unwrapScale ?? 1)),
        forceOut: e.mesh.slots.length > 0 && e.mesh.slots.every((s) => isForceOut(s.materialId)),
      }));
      const packed = packLightmap(inputs, { resolution: lm.resolution, layout: lm.layout });
      named = named.map((e, i) => ({ ...e, mesh: packed.meshes[i] as NamedEntry['mesh'] }));
      if (lightmapReport === null) {
        lightmapReport = packed.report;
        warnings.push(...packed.report.warnings);
      }
    }
    if (wanted.has(b.index)) {
      const height = b.scene.entries.reduce((m, e) => Math.max(m, boundsHeight(e.mesh.positions)), 0);
      const audit = auditExportWind(named.map((e) => ({ id: e.name, mesh: e.mesh })), b.scene.wind ?? env.wind, height);
      windAuditLods.push({ lod: b.index, audit });
      const w = windAuditWarning(audit);
      if (w) warnings.push(built.length > 1 ? `LOD${b.index}: ${w}` : w);
    }
    perLod.set(b.index, { built: b, geometries: buildGeometries(named, settings.mergeMode, `${name}_LOD${b.index}`) });
  }

  const windAudit: WindExportAudit | null = windAuditLods[0]?.audit ?? null;

  if ([...perLod.values()].some((e) => e.geometries.length === 0)) throw new Error('The plant has no geometry at one of the selected LODs: nothing to export.');

  // 2. Bake (source space) ----------------------------------------------------------------------------------------------
  if (settings.bake.aoMode !== 'off') {
    let i = 0;
    for (const [, entry] of perLod) {
      await bakeVertexAo(entry.geometries, settings.bake, token, stage(`Baking AO (LOD${entry.built.index})`, 0.25 + (0.15 * i) / perLod.size, 0.25 + (0.15 * (i + 1)) / perLod.size));
      i++;
      throwIfCancelled(token);
    }
  }

  // 2b. Vertex colour packing (Tree > Vertex Color) ----------------------------------------------------------------------
  for (const [, entry] of perLod) applyVertexColorPacking(entry.geometries, sceneVertexColor(entry.built.scene));

  // 3. Materials / textures --------------------------------------------------------------------------------------------
  onProgress({ stage: 'Exporting materials and textures', fraction: 0.4 });
  const allGeos = [...perLod.values()].flatMap((e) => e.geometries);
  const mats = await exportMaterials(usedMaterialIds(allGeos), env.materials, settings, () => token.cancelled);
  warnings.push(...mats.warnings);
  throwIfCancelled(token);

  // 4. Impostor (needs source-space geometry, so it renders before the transform) ------------------------------------
  let impostor: ImpostorOutput | null = null;
  if (impostorOn) {
    const src = perLod.get(impostorSource);
    if (src) impostor = await buildImpostor(env, settings, token, transform, src.geometries, mats, name, warnings, stage('Rendering impostor', 0.55, 0.8));
    throwIfCancelled(token);
  }

  // 5. Transform + write -----------------------------------------------------------------------------------------------
  onProgress({ stage: 'Writing files', fraction: 0.8 });
  const exported = [...perLod.values()].filter((e) => wanted.has(e.built.index));
  // 4b. V-tiling for atlases (UV only; after the impostor so the impostor keeps the authored UVs).
  const vTiling: VTilingEntry[] = [];
  if (settings.vTiling) {
    for (const e of exported) vTiling.push(...applyVTiling(e.geometries, { skipMaterial: isForceOut }));
    warnings.push(...vTilingWarnings(vTiling, (id) => env.materials.material(id)?.name ?? id));
  }
  for (const e of exported) e.geometries.forEach((g) => transformGeometry(g, transform));

  const files: ExportFile[] = [];
  const lods: LodOutput[] = [];
  const expectedByFile = new Map<string, ModelStats>();
  const gltfFormat = settings.format === 'glb' || settings.format === 'gltf';
  const useExternalTextures = settings.format === 'gltf' ? settings.textures.external : false;
  const images: GltfImage[] = mats.images.map((i) => ({ ...i, uri: settings.format === 'glb' || !useExternalTextures ? undefined : i.uri }));
  const singleFile = gltfFormat && settings.lodLayout === 'single';
  const ext = settings.format;

  const lodMeta = (e: (typeof exported)[number], file: string): Record<string, unknown> => ({
    lod: e.built.index,
    file,
    engineLod: e.built.level.engineLod,
    transition: e.built.level.transition,
    foliageKeep: e.built.level.foliageKeep,
    minBranchSize: e.built.level.minBranchSize,
    ...(e.built.dynamic ? { dynamicLodValue: e.built.dynamic.value, interiorRemovedShare: e.built.dynamic.interiorRemovedShare, removedTriangles: e.built.dynamic.removedTriangles } : {}),
    ...geometryStats(e.geometries),
  });

  const sceneExtras = (subset: typeof exported, fileNames: string[]): Record<string, unknown> => ({
    version: 1,
    name,
    units: settings.units,
    metersPerUnit: 1 / (UNIT_SCALE[settings.units] * settings.scale),
    upAxis: settings.upAxis,
    handedness: settings.handedness,
    seed: env.seed,
    lods: subset.map((e, i) => lodMeta(e, fileNames[i] as string)),
    wind: env.wind,
    attributes: settings.customAttributes ? { _WIND_PIVOT: 'VEC3 float, pivot the vertex rotates around', _WIND_WEIGHTS: 'VEC4 float (level0, level1, level2, phase of the level-2 / leaf terms)', _WIND_PHASE1: 'SCALAR float, phase of the level-1 ancestor (branch-level sway)', _AO: 'SCALAR float, 0 = occluded .. 1 = open', _BLEND: 'SCALAR float, junction material blend 0 = parent .. 1 = own material' } : {},
  });

  if (gltfFormat) {
    const groups: (typeof exported)[] = singleFile ? [exported] : exported.map((e) => [e]);
    for (const group of groups) {
      const file = singleFile ? `${name}.${ext}` : fileForLod(name, (group[0] as (typeof exported)[number]).built.index, exported.length === 1, ext);
      const nodes: GltfNodeInput[] = [];
      for (const e of group) {
        for (const g of e.geometries) {
          nodes.push({ name: g.name, geometry: g, extras: { kekenik: { lod: e.built.index, transition: e.built.level.transition, ...geometryStats([g]) } } });
        }
      }
      const base = file.replace(/\.(glb|gltf)$/i, '');
      const scene: GltfScene = { name: base, images, materials: mats.materials, materialIndex: mats.materialIndex, nodes, extras: sceneExtras(group, group.map(() => file)) };
      const out = writeGltf(scene, { binary: settings.format === 'glb', customAttributes: settings.customAttributes, vertexColors: settings.vertexColors, baseName: base });
      files.push(...out.files);
      const geoStats = geometryStats(group.flatMap((e) => e.geometries));
      expectedByFile.set(out.files[0]?.name ?? file, { nodes: nodes.length, meshes: nodes.length, triangles: geoStats.triangles, vertices: nodes.reduce((s, n) => s + n.geometry.positions.length / 3, 0), materials: mats.materials.length, images: images.length, nodeNames: nodes.map((n) => n.name) });
      for (const e of group) lods.push({ index: e.built.index, level: e.built.level, stats: geometryStats(e.geometries), file });
    }
  } else {
    for (const e of exported) {
      const file = fileForLod(name, e.built.index, false, ext);
      const base = file.replace(/\.[a-z]+$/i, '');
      if (settings.format === 'obj') files.push(...writeObj(base, e.geometries, mats.obj, settings.vertexColors).files);
      else if (settings.format === 'ply') files.push(writePly(base, e.geometries));
      else files.push(writeStl(base, e.geometries));
      lods.push({ index: e.built.index, level: e.built.level, stats: geometryStats(e.geometries), file });
    }
    if (settings.format === 'obj') files.push(...imageFiles(mats.images));
    else if (settings.textures.enabled && mats.images.length > 0) files.push(...imageFiles(mats.images));
  }
  if (impostor) files.push(...impostor.files);
  const packedTextures: string[] = [];
  for (const p of mats.packed) {
    for (const f of p.files) {
      files.push({ name: f.file, data: f.data, mime: f.mime });
      packedTextures.push(f.file);
    }
  }
  throwIfCancelled(token);

  // 6. Metadata ------------------------------------------------------------------------------------------------------
  if (settings.metadata) {
    const sceneForMeta: SceneModel | undefined = built[0]?.scene;
    const meta = {
      format: 'kekenik-export',
      version: 1,
      generator: 'Kekenik Tree',
      name,
      exportedAt: new Date().toISOString(),
      seed: env.seed,
      season: sceneForMeta?.season ?? null,
      settings: { format: settings.format, units: settings.units, upAxis: settings.upAxis, handedness: settings.handedness, scale: settings.scale, mergeMode: settings.mergeMode, textures: settings.textures, bake: settings.bake },
      transform: { matrix3x3RowMajor: transform.m, uniformScale: transform.scale, windingFlipped: transform.flipWinding },
      lods: exported.map((e) => lodMeta(e, lods.find((l) => l.index === e.built.index)?.file ?? '')),
      materials: mats.records,
      wind: { project: env.wind, sceneWindNode: sceneForMeta?.wind ?? null, perNode: sceneForMeta?.entries.map((e) => ({ node: env.nodeName(e.nodeId) ?? e.type, type: e.type, group: e.statsGroup, wind: e.wind ?? null })) ?? [] },
      vertexColors: { enabled: settings.vertexColors, ...sceneVertexColor(sceneForMeta ?? undefined), channels: sceneVertexColor(sceneForMeta ?? undefined).packing === 'kekenik' ? { R: 'per-branch random tint', G: 'height 0 base .. 1 top', B: 'ambient occlusion' } : { RGB: 'albedo tint x ambient occlusion' } },
      windAudit,
      windAuditLods,
      lightmap: lightmapReport,
      vTiling: { enabled: settings.vTiling, entries: vTiling },
      packing: { packer: settings.textures.packer, forceTextures: settings.textures.forceTextures, materials: mats.packed.map((p) => ({ material: p.name, textures: p.files.map(({ suffix, label, file, width, height, forced, mipLevels }) => ({ suffix, label, file, width, height, forced, mipLevels })), constants: p.constants })) },
      impostor: impostor?.meta ?? null,
      dynamicLod: dynamicLevelsMeta(exported, impostor !== null),
      warnings,
    };
    files.push({ name: `${name}.kekenik.json`, data: JSON.stringify(meta, null, 2), mime: 'application/json' });
  }

  // 7. Verify (round trip) --------------------------------------------------------------------------------------------
  const verification: VerifyReport[] = [];
  if (settings.verify && gltfFormat) {
    onProgress({ stage: 'Verifying export', fraction: 0.9 });
    for (const f of files) {
      const expected = expectedByFile.get(f.name);
      if (!expected) continue;
      if (typeof f.data !== 'string') {
        verification.push(await verifyGlb(f.name, f.data, expected, env.verifyWithLoader !== false));
      } else if (typeof f.data === 'string') {
        const actual = statsFromJson(JSON.parse(f.data));
        const mismatches = compareStats(expected, actual);
        verification.push({ ok: mismatches.length === 0, file: f.name, expected, actual, mismatches });
      }
    }
    for (const v of verification) if (!v.ok) warnings.push(`Verification of ${v.file} found differences: ${v.mismatches.join('; ')}`);
  }

  // 8. Bundle ---------------------------------------------------------------------------------------------------------
  onProgress({ stage: 'Packing', fraction: 0.95 });
  let download: ExportFile;
  if (settings.zip || files.length > 1) {
    download = { name: `${name}.zip`, data: await zipFiles(files, name), mime: 'application/zip' };
  } else {
    download = files[0] as ExportFile;
  }
  onProgress({ stage: 'Done', fraction: 1 });

  const dynamicLevels = exported.flatMap((e) => (e.built.dynamic ? [{ index: e.built.index, report: e.built.dynamic, triangles: geometryStats(e.geometries).triangles }] : []));
  return { files, download, lods, dynamicLevels, warnings, verification, textureBytes: mats.textureBytes, windAudit, windAuditLods, lightmap: lightmapReport, vTiling, packedTextures };
}
