import { getBool, getNumber, getString, type ListItem, type NodeParams } from '@/contracts/params';
import type { Rng } from '@/core/rng';
import type { UvMaterialOptions } from '@/geometry/tubeUv';
import { DEFAULT_UV_MAPPING, MATERIAL_INHERITED, UV_AREA_WHOLE, type ExtensionUvStyle, type PatchRow, type TilingStyle, type UvAreaLike, type UvMapping, type UvStyle, type VAnchor, type VStyle } from '@/generators/uv';
import { getMaterialSource, resolveMaterialRef } from '@/materials/materialSource';


const parseStyle = (v: string): UvStyle => (v.includes('and-v') ? 'uv-locked' : v.startsWith('u-locked') ? 'u-locked' : 'unrestricted');
const parseExtension = (v: string): ExtensionUvStyle => (v.includes('full') ? 'full' : v.includes('u-only') ? 'match-u' : v.includes('match') ? 'match' : 'automatic');
const parseVStyle = (v: string): VStyle => (v.includes('aspect') ? 'aspect' : v.startsWith('relative') ? 'relative' : 'absolute');
const parseTiling = (v: string): TilingStyle => (v.startsWith('0-1') ? (v.includes('use-all') ? 'patch-all' : 'patch-one') : 'tiling');
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * The UV tab of a generator as a `UvMapping`. Projects saved before the UV Mapping update keep their look: `uvScaleU`
 * multiplies Relative, the old `Normalized` mode and Spine > Match one V tile map to V style Relative with a free tile
 * count of `uvScaleU` around the branch. The old ids `uvScaleV`, `uvOffsetU`, `uvOffsetV`, `uvRotate` are still the V Scale,
 * U Offset, V Offset and Rotate 90 degrees.
 */
export function readUvMapping(params: NodeParams): UvMapping {
  const d = DEFAULT_UV_MAPPING;
  const legacyU = Math.max(0.01, getNumber(params, 'uvScaleU', 1));
  const matchOne = getBool(params, 'matchOneVTile', false);
  const legacyNormalized = matchOne || (getString(params, 'uvMode', 'metric') === 'normalized' && params.uvVStyle === undefined);
  const mapping: UvMapping = {
    style: parseStyle(getString(params, 'uvStyle', 'unrestricted')),
    extensionStyle: parseExtension(getString(params, 'extensionUvStyle', 'automatic')),
    rotate: getBool(params, 'uvRotate', d.rotate),
    uAbsolute: Math.max(0, getNumber(params, 'uvUAbsolute', d.uAbsolute)),
    uRelative: Math.max(0, getNumber(params, 'uvURelative', d.uRelative)) * legacyU,
    uOffset: getNumber(params, 'uvOffsetU', d.uOffset),
    uOffsetVariance: clamp(params.uvOffsetU?.variance ?? 0, 0, 1),
    fractional: {
      enabled: getBool(params, 'uvFractional', false),
      auto: getBool(params, 'uvFractionalAuto', false),
      value: Math.max(0.01, getNumber(params, 'uvFractionalValue', 1)),
    },
    twist: getNumber(params, 'uvTwist', d.twist),
    twistRandomFlip: getBool(params, 'uvTwistFlip', false),
    vStyle: parseVStyle(getString(params, 'uvVStyle', 'absolute')),
    vAnchor: (getString(params, 'uvVAnchor', 'start') === 'end' ? 'end' : 'start') satisfies VAnchor,
    vScale: Math.max(0.01, getNumber(params, 'uvScaleV', d.vScale)),
    skew: clamp(getNumber(params, 'uvSkew', d.skew), 0, 1),
    pinch: clamp(getNumber(params, 'uvPinch', d.pinch), 0, 1),
    vOffset: getNumber(params, 'uvOffsetV', d.vOffset),
    vOffsetVariance: clamp(params.uvOffsetV?.variance ?? 0, 0, 1),
    tiling: parseTiling(getString(params, 'uvTilingStyle', 'tiling')),
    optimizeSegments: getBool(params, 'uvOptimize', d.optimizeSegments),
    vTolerance: clamp(getNumber(params, 'uvVTolerance', d.vTolerance), 0, 0.5),
    tilingSeed: Math.round(getNumber(params, 'uvTilingSeed', d.tilingSeed)),
  };
  if (!legacyNormalized) return mapping;
  return { ...mapping, vStyle: 'relative', uAbsolute: 0, uRelative: 0, fractional: { enabled: true, auto: false, value: legacyU } };
}

// ---- material lists ------------------------------------------------------------------------------------------------

const DEFAULT_ROW = (material: string): PatchRow => ({ material, weight: 1, uvArea: UV_AREA_WHOLE, placement: 'anywhere' });

function rowsOf(raw: unknown, fallback: PatchRow): PatchRow[] {
  if (!Array.isArray(raw)) return [fallback];
  const rows: PatchRow[] = [];
  for (const it of raw as ListItem[]) {
    if (typeof it !== 'object' || it === null) continue;
    const weight = typeof it.weight === 'number' && Number.isFinite(it.weight) ? Math.max(0, it.weight) : 1;
    rows.push({
      material: typeof it.material === 'string' ? it.material : '',
      weight,
      uvArea: typeof it.uvArea === 'string' && it.uvArea ? it.uvArea : UV_AREA_WHOLE,
      placement: it.placement === 'first-ring' || it.placement === 'first' ? 'first' : 'anywhere',
    });
  }
  return rows.length > 0 ? rows : [fallback];
}

/** Branch material list (`barkMaterials`); old projects without it get one row from the single `material` property. */
export function readBranchMaterialRows(params: NodeParams): PatchRow[] {
  const legacy = getString(params, 'material', '');
  return rowsOf(params.barkMaterials?.value, DEFAULT_ROW(legacy));
}

/** Extension material list (`extensionMaterials`): one `Inherited` row unless the list is stored. */
export function readExtensionMaterialRows(params: NodeParams): PatchRow[] {
  return rowsOf(params.extensionMaterials?.value, DEFAULT_ROW(MATERIAL_INHERITED));
}

/** True for nodes that have the Branch / Extension material lists. */
export const hasMaterialLists = (params: NodeParams): boolean => Array.isArray(params.barkMaterials?.value) || Array.isArray(params.extensionMaterials?.value);

/** Material reference of the first Branch row (the node's own material for children that inherit it, Displacement, V tile aspect). */
export function primaryMaterialRef(params: NodeParams): string {
  return Array.isArray(params.barkMaterials?.value) ? ((readBranchMaterialRows(params)[0] as PatchRow).material) : getString(params, 'material', '');
}

export { MATERIAL_INHERITED };

/** UV Areas of the library in the form the patch generator reads. */
export function libraryUvAreas(): UvAreaLike[] {
  const list = getMaterialSource()?.uvAreas?.() ?? [];
  return list.map((a) => ({ id: a.id, name: a.name, materialId: a.materialId, rect: a.rect, usage: a.usage, weight: a.weight }));
}

/** Mesher material options of a Branch (undefined for nodes without the lists: one material for every branch). */
export function uvMaterialOptions(params: NodeParams): UvMaterialOptions | undefined {
  if (!hasMaterialLists(params)) return undefined;
  return {
    branchRows: readBranchMaterialRows(params),
    extensionRows: readExtensionMaterialRows(params),
    areas: libraryUvAreas(),
    resolve: (ref: string, rng: Rng): string => resolveMaterialRef(ref, rng),
  };
}

/** Cache-key part: the UV Areas matter only while patches are used. */
export function uvDependencyKey(params: NodeParams): string {
  if (parseTiling(getString(params, 'uvTilingStyle', 'tiling')) === 'tiling') return '';
  return `uva${libraryUvAreas().map((a) => `${a.id}:${a.rect.join(',')}:${a.weight}:${a.usage}`).join(';')}`;
}

/**
 * Branch nodes saved before the material list: the single `material` property becomes the first row of `barkMaterials`
 * (the Extension list starts as `Inherited`).
 */
export function migrateBranchMaterial(params: NodeParams): NodeParams {
  if (Array.isArray(params.barkMaterials?.value)) return params;
  const legacy = params.material?.value;
  if (typeof legacy !== 'string') return params;
  const out: NodeParams = { ...params, barkMaterials: { value: [{ material: legacy, weight: 1, uvArea: UV_AREA_WHOLE, placement: 'anywhere' }] } };
  delete out.material;
  return out;
}
