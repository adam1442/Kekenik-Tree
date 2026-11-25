import type { ParamDef } from '@/contracts/params';
import { section } from '../shared/builders';
import { dynamicLodGeneratorParams, lightmapGeneratorParams } from './dynamicLodParams';
import { generationParams, leafMaterialParams } from './params';
import { seasonTimingParams } from './seasonParams';

/**
 * Parameters of the Decal generator: flat patches projected onto the skin of a trunk / branch / root to make surface details
 * (knots, lumps, cavities, scars). Tabs: Generation, Mesh, Decal, Height, Material, LOD.
 */
export function decalParams(): ParamDef[] {
  const size = section('Mesh', 'Scale');
  const res = section('Mesh', 'Resolution');
  const dc = section('Decal', 'Decal');
  const ht = section('Height', 'Height');
  const lod = section('LOD', 'LOD');
  const list: ParamDef[] = [
    ...generationParams({ number: 3, first: 0.1, last: 0.9, jumble: 0.35 }),

    size.float('decalSize', 'Size', 0.25, { min: 0.002, max: 20, softMax: 2, unit: 'm', variance: 0.25, curve: true, tooltip: 'Length of the patch along the parent, metres. The curve runs along the parent branch.' }),
    size.float('decalSizeParent', '+ % of parent', 0, { min: 0, max: 1000, softMax: 300, unit: '%', tooltip: 'Added to Size: this percentage of the parent radius at the placement (bigger decals on thicker wood).' }),
    size.float('decalAspect', 'Aspect', 1, { min: 0.1, max: 10, softMax: 3, variance: 0.2, tooltip: 'Width across the parent relative to the length along it.' }),
    res.int('decalResolution', 'Resolution', 12, { min: 2, max: 64, softMax: 32, tooltip: 'Cells per side of the patch grid (12 gives 288 triangles). Lower for distant LODs.' }),
    res.int('decalLodOffset', 'Mesh LOD offset', 0, { min: -3, max: 3, tooltip: 'Shifts the detail level of this mesh: +1 builds it like the next lower LOD, -1 keeps more detail.' }),

    dc.float('decalRotation', 'Rotation', 0, { min: -180, max: 180, unit: '°', variance: 1, tooltip: 'Rolls the patch around its centre on the surface.' }),
    dc.float('decalRandomRotation', 'Random rotation', 1, { min: 0, max: 1, tooltip: 'Fraction of a full turn added at random per decal.' }),
    dc.float('decalOffset', 'Offset', 0.002, { min: -0.5, max: 0.5, softMin: -0.02, softMax: 0.05, unit: 'm', tooltip: 'Lift of the whole patch above the parent surface (avoids z-fighting with the bark).' }),
    dc.float('decalFade', 'Edge fade', 0.25, { min: 0, max: 0.5, tooltip: 'Fraction of the patch over which the relief fades to zero at its border, so the decal blends into the bark.' }),

    ht.float('decalHeight', 'Height', 0.03, { min: -2, max: 2, softMin: -0.2, softMax: 0.2, unit: 'm', variance: 0.25, tooltip: 'Extrusion of the material height map (Height map, or the alpha of the normal map) away from the surface. Negative values dig cavities. Needs a material with a height map; 0 keeps the patch flat.' }),

    lod.float('lodCull', 'Cull amount', 0.5, { min: 0, max: 1, tooltip: 'Fraction of decals removed at the lowest LOD.' }),
    ...dynamicLodGeneratorParams('LOD', 'Dynamic LOD'),
    ...lightmapGeneratorParams(1),
  ];
  const material = [...leafMaterialParams().filter((p) => p.subgroup === 'Leaves' || p.subgroup === 'Vertex Color'), ...seasonTimingParams()];
  return [...list, ...material];
}
