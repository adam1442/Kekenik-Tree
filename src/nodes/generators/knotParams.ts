import type { ListParamDef, ParamDef } from '@/contracts/params';
import { section } from '../shared/builders';
import { generationParams } from './params';

/**
 * Parameters of the Knot generator (surface details: knots, lumps, gashes). Tabs: Generation, Outer, Inner, Core, Material,
 * Segments, LOD. Outer is the band welded to the parent (parent material, parent UV); Inner is the thin bridge down to
 * the Core, the centre cap. Sizes are metres.
 */

const MATCH_TRUNK = { param: 'coreUvStyle', value: 'match-trunk' } as const;

function knotMaterialList(id: string, label: string, subgroup: string, defaultMaterial: string, tooltip: string): ListParamDef {
  return {
    kind: 'list',
    widget: 'knotMaterials',
    id,
    label,
    group: 'Material',
    subgroup,
    minItems: 1,
    maxItems: 16,
    default: [{ material: defaultMaterial, weight: 1, uvArea: 'whole' }],
    tooltip,
    fields: [
      { kind: 'enum', id: 'material', label: 'Material', group: 'Material', default: defaultMaterial, options: [{ value: '', label: 'None' }] },
      { kind: 'float', id: 'weight', label: 'Weight', group: 'Material', default: 1, min: 0, max: 100, softMax: 10 },
      { kind: 'enum', id: 'uvArea', label: 'UV Area', group: 'Material', default: 'whole', options: [{ value: 'whole', label: 'Whole map' }, { value: 'any', label: 'Any' }] },
    ],
  };
}

export function knotParams(): ParamDef[] {
  const o = section('Outer', 'Outer');
  const on = section('Outer', 'Noise');
  const onShape = section('Outer', 'Noise shape');
  const onOffset = section('Outer', 'Noise offset');
  const i = section('Inner', 'Inner');
  const iuv = section('Inner', 'UV');
  const inShape = section('Inner', 'Noise shape');
  const c = section('Core', 'Core');
  const cuv = section('Core', 'UV');
  const cnShape = section('Core', 'Noise shape');
  const cnOffset = section('Core', 'Noise offset');
  const ring = section('Segments', 'Rings');
  const sl = section('Segments', 'Slices');
  const rs = section('Segments', 'Resolution');
  const lod = section('LOD', 'Dynamic LOD');
  const uvStyles = ['Match trunk', 'Ring'];

  return [
    ...generationParams({ number: 5, first: 0.1, last: 0.9, jumble: 0.35 }),

    // ---- Outer ----------------------------------------------------------------------------------------------------
    o.float('outerSize', 'Size', 0.12, { min: 0.002, max: 20, softMax: 1, unit: 'm', variance: 0.25, tooltip: 'Radius of the whole knot on the parent surface, measured along the branch.' }),
    o.float('outerOffset', 'Offset', 0.02, { min: -2, max: 2, softMin: -0.3, softMax: 0.3, unit: 'm', variance: 0.25, tooltip: 'How far the knot is extruded from the parent surface. Negative values cut into it (gashes).' }),
    o.float('outerRotation', 'Rotation', 0, { min: -180, max: 180, unit: '°', variance: 1, tooltip: 'Rolls the whole knot around its centre; Inner and Core follow.' }),
    o.float('outerScale', 'Scale', 1, { min: 0.1, max: 8, softMax: 3, variance: 0.2, tooltip: 'Width of the knot across the branch relative to its length. Combine with Rotation for non-circular knots.' }),
    o.float('outerLip', 'Lip', 0.01, { min: -1, max: 1, softMin: -0.1, softMax: 0.1, unit: 'm', variance: 0.25, tooltip: 'Raises (or lowers) the edge between Outer and Inner above the Offset.' }),
    on.seed('outerNoiseSeed', 'Seed'),
    onShape.float('outerShapeAmount', 'Amount', 0.15, { min: 0, max: 1, tooltip: 'Deforms the outline of the knot (fraction of its radius).' }),
    onShape.float('outerShapeScale', 'Scale', 2, { min: 0.1, max: 20, softMax: 8, tooltip: 'Frequency of the outline noise: higher gives more, smaller bumps around the knot.' }),
    onOffset.float('outerOffsetAmount', 'Amount', 0.004, { min: 0, max: 1, softMax: 0.05, unit: 'm', tooltip: 'Height noise on the surface of the Outer band.' }),
    onOffset.float('outerOffsetScale', 'Scale', 4, { min: 0.1, max: 40, softMax: 12, tooltip: 'Frequency of the height noise.' }),

    // ---- Inner ----------------------------------------------------------------------------------------------------
    i.float('innerSizePct', 'Size %', 60, { min: 5, max: 98, unit: '%', variance: 0.15, tooltip: 'Size of Inner and Core together as a percentage of the knot size.' }),
    i.float('innerScale', 'Scale', 1, { min: 0.1, max: 4, softMax: 2, variance: 0.15, tooltip: 'Width of Inner and Core relative to Outer.' }),
    i.float('innerCurvature', 'Curvature', 0.5, { min: -2, max: 4, softMin: -1, softMax: 2, variance: 0.2, tooltip: 'Roundness of the Inner section: higher values puff it out, negative values pinch it in.' }),
    i.float('innerOverlap', 'Overlap', 0, { min: 0, max: 0.9, tooltip: 'How far the Inner section reaches under the Core. Hides gaps when the two use different materials.' }),
    iuv.enumOf('innerUvStyle', 'Style', 'Match trunk', uvStyles, { tooltip: 'Match trunk continues the parent texture over the Inner. Ring maps it like a torus: U around the knot, V from outside to inside.' }),
    iuv.float('innerUvScale', 'Scale', 1, { min: 0.01, max: 32, softMax: 8, tooltip: 'Texture scale of the Inner section.' }),
    iuv.float('innerUvOffsetU', 'U offset', 0, { min: -10, max: 10, softMin: -1, softMax: 1, tooltip: 'Shifts the Inner texture around the knot.' }),
    iuv.float('innerUvOffsetV', 'V offset', 0, { min: -10, max: 10, softMin: -1, softMax: 1, tooltip: 'Shifts the Inner texture along the knot.' }),
    inShape.float('innerShapeAmount', 'Amount', 0.1, { min: 0, max: 1, tooltip: 'Deforms the boundary between Inner and Core (fraction of its radius).' }),
    inShape.float('innerShapeScale', 'Scale', 2, { min: 0.1, max: 20, softMax: 8, tooltip: 'Frequency of the Inner outline noise.' }),

    // ---- Core -----------------------------------------------------------------------------------------------------
    c.float('coreSizePct', 'Size %', 50, { min: 5, max: 98, unit: '%', variance: 0.15, tooltip: 'Size of the Core as a percentage of the Inner size.' }),
    c.float('coreOffset', 'Offset', -0.01, { min: -2, max: 2, softMin: -0.2, softMax: 0.2, unit: 'm', variance: 0.25, tooltip: 'Moves the Core towards (negative) or away from (positive) the parent, relative to the knot Offset.' }),
    cuv.enumOf('coreUvStyle', 'Style', 'Match trunk', uvStyles, { tooltip: 'Match trunk continues the parent texture over the Core. Ring maps the texture flat over the Core disc, like the end of a cut branch.' }),
    cuv.float('coreUvScale', 'Scale', 1, { min: 0.01, max: 32, softMax: 8, tooltip: 'Texture scale of the Core.' }),
    cuv.float('coreUvOffsetU', 'U offset', 0, { min: -10, max: 10, softMin: -1, softMax: 1, visibleIf: MATCH_TRUNK, tooltip: 'Shifts the Core texture around the knot. No effect with the Ring style.' }),
    cuv.float('coreUvOffsetV', 'V offset', 0, { min: -10, max: 10, softMin: -1, softMax: 1, visibleIf: MATCH_TRUNK, tooltip: 'Shifts the Core texture along the knot. No effect with the Ring style.' }),
    cnShape.float('coreShapeAmount', 'Amount', 0.1, { min: 0, max: 1, tooltip: 'Deforms the outline of the Core (fraction of its radius).' }),
    cnShape.float('coreShapeScale', 'Scale', 2, { min: 0.1, max: 20, softMax: 8, tooltip: 'Frequency of the Core outline noise.' }),
    cnOffset.float('coreOffsetAmount', 'Amount', 0.003, { min: 0, max: 1, softMax: 0.05, unit: 'm', tooltip: 'Height noise on the Core surface.' }),
    cnOffset.float('coreOffsetScale', 'Scale', 4, { min: 0.1, max: 40, softMax: 12, tooltip: 'Frequency of the Core height noise.' }),

    // ---- Material (Outer always uses the material of the parent branch) --------------------------------------------
    knotMaterialList('innerMaterials', 'Material', 'Inner', 'inherited', 'Materials of the Inner section; each knot picks a row by weight. Inherited uses the parent material. The gear button on a row opens the UV Area.'),
    knotMaterialList('coreMaterials', 'Material', 'Core', '', 'Materials of the Core, usually a cut-branch material; each knot picks a row by weight. None or Inherited uses the parent material.'),

    // ---- Segments -------------------------------------------------------------------------------------------------
    ring.int('ringsOuter', 'Outer', 3, { min: 1, max: 24, tooltip: 'Rings of the Outer band, from the parent surface to the Inner edge.' }),
    ring.int('ringsInner', 'Inner', 3, { min: 1, max: 24, tooltip: 'Rings of the Inner section.' }),
    ring.int('ringsCore', 'Core', 2, { min: 1, max: 24, tooltip: 'Rings of the Core disc.' }),
    sl.int('slices', 'Slices', 16, { min: 4, max: 128, softMax: 48, tooltip: 'Segments around the knot; shared by Outer, Inner and Core.' }),
    rs.float('knotResolution', 'Resolution', 1, { min: 0.1, max: 4, softMax: 2, tooltip: 'Multiplies the rings and slices at once.' }),

    // ---- Dynamic LOD ----------------------------------------------------------------------------------------------
    lod.float('lodWeight', 'Weight', 1, { min: 0, max: 1, tooltip: 'Importance of the knots. Below 1, a share of them is removed as the level of detail drops (all of them at the lowest level for 0).' }),
    lod.float('lodRingSegments', 'Ring segments', 0.5, { min: 0, max: 1, tooltip: 'How strongly the rings are reduced per level of detail.' }),
    lod.float('lodSliceSegments', 'Slice segments', 0.5, { min: 0, max: 1, tooltip: 'How strongly the slices are reduced per level of detail.' }),
  ];
}
