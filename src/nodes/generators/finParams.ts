import type { ParamDef } from '@/contracts/params';
import { section } from '../shared/builders';
import { dynamicLodGeneratorParams, lightmapGeneratorParams } from './dynamicLodParams';
import { generationParams, leafMaterialParams } from './params';
import { seasonTimingParams } from './seasonParams';

/**
 * Parameters of the Fin generator: thin flaps that stand off a trunk or branch (fungus shelves, moss and lichen flaps, bark
 * curls). Tabs: Generation, Fins, Orientation, Deformation, Lighting, Wind, Material, LOD.
 */
export function finParams(): ParamDef[] {
  const f = section('Fins', 'Fins');
  const seg = section('Fins', 'Segments');
  const o = section('Orientation', 'Orientation');
  const d = section('Deformation', 'Deformation');
  const v = section('Deformation', 'Vertex');
  const sc = section('Deformation', 'Scale');
  const l = section('Lighting', 'Lighting');
  const w = section('Wind', 'Ripple');
  const lod = section('LOD', 'LOD');
  const list: ParamDef[] = [
    ...generationParams({ number: 4, first: 0.1, last: 0.9, jumble: 0.35 }),

    f.float('finSize', 'Size', 0.25, { min: 0.002, max: 20, softMax: 2, unit: 'm', variance: 0.25, curve: true, tooltip: 'How far the fin reaches away from its base, metres. The curve runs along the parent branch.' }),
    f.float('finSizeParent', '+ % of parent', 0, { min: 0, max: 1000, softMax: 300, unit: '%', tooltip: 'Added to Size: this percentage of the parent radius at the placement.' }),
    f.float('finWidth', 'Width', 0.2, { min: 0.002, max: 20, softMax: 2, unit: 'm', variance: 0.25, curve: true, tooltip: 'Width of the base ring of the fin along the surface, metres.' }),
    f.enumOf('finFlip', 'Flip', 'Random', ['None', 'Random', 'Always'], { tooltip: 'Mirrors the fin (texture, fold and curl direction): never, at random, or always.' }),
    seg.int('finSegmentsWidth', 'Width segments', 4, { min: 1, max: 32, softMax: 12, tooltip: 'Cells across the fin. The base ring has one more vertex, every one on the parent skin.' }),
    seg.int('finSegmentsLength', 'Length segments', 6, { min: 2, max: 64, softMax: 20, tooltip: 'Cells from the base to the tip; more cells give smoother curl and noise.' }),

    o.enumOf('finStyle', 'Style', 'Perpendicular', ['Perpendicular', 'Along spine', 'Up'], { tooltip: 'Direction in which the fin leaves the surface plane: Perpendicular = around the parent, Along spine = along the parent, Up = towards the sky (shelf fungus).' }),
    o.float('finStartAngle', 'Start angle', 60, { min: 0, max: 180, unit: '°', variance: 0.2, tooltip: 'Angle between the surface and the fin at its base: 0 lies flat on the bark, 90 stands straight out.' }),
    o.float('finRoll', 'Roll', 0, { min: -180, max: 180, unit: '°', variance: 1, tooltip: 'Turns the fin around the surface normal at its attachment.' }),

    d.float('finFold', 'Fold', 0, { min: -180, max: 180, unit: '°', variance: 0.3, tooltip: 'Folds the two halves of the fin along its centre line; the fold grows from the base to the tip.' }),
    d.float('finCurl', 'Curl', 0, { min: -360, max: 360, unit: '°', variance: 0.3, tooltip: 'Bends the fin along its length towards its face (positive) or away from it.' }),
    v.float('finVertexAmount', 'Amount', 0, { min: 0, max: 2, softMax: 0.2, unit: 'm', tooltip: 'Random displacement of the vertices (grows from the base to the tip, so the base stays on the skin).' }),
    v.float('finVertexScale', 'Noise scale', 3, { min: 0.1, max: 40, softMax: 12, tooltip: 'Frequency of the vertex noise: higher gives finer wrinkles.' }),
    v.seed('finVertexSeed', 'Seed'),
    sc.float('finScaleX', 'Scale X', 1, { min: 0.01, max: 10, softMax: 3, tooltip: 'Scale of the fin across its width.' }),
    sc.float('finScaleY', 'Scale Y', 1, { min: 0.01, max: 10, softMax: 3, tooltip: 'Scale of the fin along its length.' }),
    sc.float('finScaleZ', 'Scale Z', 1, { min: 0, max: 10, softMax: 3, tooltip: 'Scale of the fin\'s thickness direction (the amount of fold, curl and noise out of its plane).' }),

    l.float('finPuffiness', 'Puffiness', 0.3, { min: 0, max: 1, tooltip: 'Bends the normals towards the surface normal of the parent: soft, rounded shading instead of a flat card.' }),
    l.float('finMatchSurface', 'Match surface', 0.5, { min: 0, max: 1, tooltip: 'Blends the normals at the base of the fin into the parent surface normal (fading out towards the tip), so the fin merges with the bark shading.' }),

    w.float('finRipple', 'Ripple scale', 1, { min: 0, max: 5, softMax: 2, tooltip: 'Strength of the fin\'s own leaf-level wind motion. The base ring keeps the exact wind of the parent, the weight grows towards the tip, so the fin never tears off.' }),

    lod.float('lodCull', 'Cull amount', 0.5, { min: 0, max: 1, tooltip: 'Fraction of fins removed at the lowest LOD.' }),
    lod.float('lodSegments', 'Segment reduction', 0.5, { min: 0, max: 0.9, tooltip: 'Fraction of the width and length segments removed per LOD step.' }),
    ...dynamicLodGeneratorParams('LOD', 'Dynamic LOD'),
    ...lightmapGeneratorParams(1),
  ];
  const material = [...leafMaterialParams().filter((p) => p.subgroup === 'Leaves' || p.subgroup === 'Vertex Color'), ...seasonTimingParams()];
  return [...list, ...material];
}
