import type { ParamDef } from '@/contracts/params';
import { section } from '../shared/builders';
import { leafMaterialParams, leafWindParams } from './params';

/** Parameters of the Decoration node (moss, mushrooms, lichen, ivy, bark flaps on trunks / branches / spines). */
export function decorationParams(): ParamDef[] {
  const g = section('Generation', 'Generation');
  const d = section('Generation', 'Distribution');
  const b = section('Generation', 'Boundaries');
  const m = section('Generation', 'Mask');
  const c = section('Generation', 'Common');
  const sz = section('Shape', 'Size');
  const ov = section('Shape', 'Overlap');
  const al = section('Orientation', 'Align');
  const tr = section('Orientation', 'Transform');
  const sk = section('Skin', 'Source');
  const cd = section('Skin', 'Card');
  const at = section('UV', 'Atlas');
  const lod = section('LOD', 'LOD');
  const density = { param: 'decoMode', value: 'density' } as const;
  const number = { param: 'decoMode', value: 'number' } as const;
  const clustered = { param: 'decoSpacing', value: 'clustered' } as const;
  const hasMask = { param: 'decoMask', op: 'ne', value: '' } as const;
  const relative = { param: 'decoSizeMode', value: 'relative-to-radius' } as const;
  const absolute = { param: 'decoSizeMode', value: 'absolute' } as const;

  const list: ParamDef[] = [
    c.bool('active', 'Active', true),
    g.enumOf('decoMode', 'Mode', 'Number', ['Number', 'Density']),
    g.int('number', 'Number', 12, { min: 0, max: 20000, softMax: 100, warnAbove: 2000, variance: 0, visibleIf: number, tooltip: 'Decorations per parent branch.' }),
    g.float('decoDensity', 'Density per meter', 6, { min: 0, max: 2000, softMax: 50, visibleIf: density, tooltip: 'Decorations per metre of parent length.' }),
    d.enumOf('decoSpacing', 'Spacing', 'Random', ['Random', 'Even', 'Clustered']),
    d.int('decoClusterCount', 'Cluster count', 5, { min: 1, max: 200, visibleIf: clustered, tooltip: 'Decorations per cluster.' }),
    d.float('decoClusterSize', 'Cluster size', 0.15, { min: 0.005, max: 10, softMax: 1, unit: 'm', visibleIf: clustered }),
    d.float('jumble', 'Jumble', 0.3, { min: 0, max: 1, tooltip: 'Random displacement of every item (relative to the spacing).' }),
    b.float('first', 'First', 0, { min: 0, max: 1, curve: false }),
    b.float('last', 'Last', 1, { min: 0, max: 1 }),
    b.range('decoAngle', 'Angle range', [-180, 180], -360, 360, { step: 1, tooltip: 'Only place decorations whose angle around the parent lies in this range (degrees).' }),
    b.enumOf('decoAngleRef', 'Angle reference', 'Parent frame', ['Parent frame', 'World'], { tooltip: 'World: 0° = +X, 90° = +Y (counter-clockwise), measured from above: pick a compass side of a trunk.' }),
    {
      kind: 'enum',
      id: 'decoMask',
      label: 'Mask',
      group: 'Generation',
      subgroup: 'Mask',
      default: '',
      options: [{ value: '', label: 'None' }],
      tooltip: 'Mask from the Masks list: slope of the surface and height decide where decorations may grow (e.g. moss only on upward-facing surfaces).',
    },
    m.float('decoMaskStrength', 'Strength', 1, { min: 0, max: 1, visibleIf: hasMask, tooltip: 'Blend between ignoring (0) and obeying (1) the mask.' }),
    c.seed('seed', 'Seed'),

    sz.enumOf('decoSizeMode', 'Size mode', 'Absolute', ['Absolute', 'Relative to radius']),
    sz.float('decoWidth', 'Width', 0.2, { min: 0.001, max: 20, softMax: 2, unit: 'm', variance: 0.25, curve: true, visibleIf: absolute }),
    sz.float('decoHeight', 'Height', 0.2, { min: 0.001, max: 20, softMax: 2, unit: 'm', variance: 0.25, curve: true, visibleIf: absolute }),
    sz.float('decoWidthRel', 'Width (x radius)', 1.5, { min: 0.01, max: 50, softMax: 8, variance: 0.25, curve: true, visibleIf: relative }),
    sz.float('decoHeightRel', 'Height (x radius)', 1.5, { min: 0.01, max: 50, softMax: 8, variance: 0.25, curve: true, visibleIf: relative }),
    sz.float('decoScale', 'Scale', 1, { min: 0.001, max: 20, softMax: 3, variance: 0.1 }),
    ov.float('decoOverlap', 'Overlap', 1, { min: 0, max: 1, tooltip: '1 = items may overlap freely. Lower values reject items whose footprints overlap.' }),

    al.enumOf('decoAlign', 'Align', 'Surface normal', ['Surface normal', 'Up', 'Radial'], { tooltip: 'Surface: hugs the bark. Up: faces the sky. Radial: faces straight away from the parent axis.' }),
    al.enumOf('decoHeightAxis', 'Height axis', 'Along parent', ['Along parent', 'Up', 'Down', 'Random']),
    tr.float('decoOffset', 'Offset / Sink', 0.003, { min: -2, max: 2, softMin: -0.1, softMax: 0.1, unit: 'm', tooltip: 'Distance from the surface (negative sinks into the bark).' }),
    tr.float('decoTilt', 'Tilt', 0, { min: -90, max: 90, unit: '°', variance: 0.3, tooltip: 'Lifts the upper edge away from the surface (peeling bark).' }),
    tr.float('decoRoll', 'Roll', 0, { min: -180, max: 180, unit: '°', variance: 0 }),
    tr.float('decoRandomRotation', 'Random rotation', 1, { min: 0, max: 1, tooltip: 'Fraction of a full turn applied at random.' }),

    sk.enumOf('decoShape', 'Shape', 'Card', ['Card', 'Cutout mesh'], { tooltip: 'Cutout mesh uses the cutout chosen in the Material tab (Meshes panel).' }),
    cd.bool('decoConform', 'Conform to surface', true, { tooltip: 'Bend the card around the parent so it neither floats nor cuts into the bark.' }),
    cd.int('decoSegmentsW', 'Width segments', 3, { min: 1, max: 16 }),
    cd.int('decoSegmentsH', 'Height segments', 2, { min: 1, max: 16 }),
    at.int('atlasColumns', 'Columns', 1, { min: 1, max: 16 }),
    at.int('atlasRows', 'Rows', 1, { min: 1, max: 16 }),
    at.enumOf('atlasMode', 'Cell', 'Random', ['Random', 'Sequential', 'Fixed']),
    at.int('atlasCell', 'Fixed cell', 0, { min: 0, max: 255 }),

    lod.float('lodCull', 'Cull amount', 0.5, { min: 0, max: 1, tooltip: 'Fraction of decorations removed at the lowest LOD.' }),
    lod.float('lodSegments', 'Segment reduction', 0.5, { min: 0, max: 0.9 }),
  ];
  const material = leafMaterialParams().filter((p) => p.subgroup === 'Leaves' || p.subgroup === 'Vertex Color');
  const animation = leafWindParams().map((p) => ({ ...p, group: 'Animation' }) as ParamDef);
  return [...list, ...material, ...animation];
}
