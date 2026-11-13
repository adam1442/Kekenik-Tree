import type { ParamDef } from '@/contracts/params';
import { section } from '../shared/builders';
import { displacementParams, leafMaterialParams, leafWindParams } from './params';

/**
 * Parameter catalogue of the Frond node: a flat ribbon that follows the whole length of every parent spine
 * (grass blades, moss, ferns, palm / banana leaves, reeds). Tabs: Generation, Shape, Skin, UV, LOD, Displacement,
 * Material, Animation. See docs/PARAMETERS.md.
 */
export function frondParams(): ParamDef[] {
  const g = section('Generation', 'Generation');
  const b = section('Generation', 'Boundaries');
  const ln = section('Generation', 'Length');
  const c = section('Generation', 'Common');
  const w = section('Shape', 'Width');
  const cs = section('Shape', 'Cross-section');
  const bd = section('Shape', 'Bend');
  const fc = section('Shape', 'Facing');
  const sg = section('Skin', 'Segments');
  const sf = section('Skin', 'Faces');
  const uv = section('UV', 'Mapping');
  const at = section('UV', 'Atlas');
  const lod = section('LOD', 'LOD');

  const crossShaped = { param: 'frondShape', op: 'ne', value: 'flat' } as const;

  const list: ParamDef[] = [
    c.bool('active', 'Active', true),
    g.int('frondPlanes', 'Planes per spine', 1, { min: 1, max: 8, tooltip: '1 = a single ribbon. 2 = crossed planes, 3 = a star: cheap volume for grass and reeds.' }),
    g.float('frondStartAngle', 'Start angle', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotation of the first plane about the spine.' }),
    b.float('first', 'First', 0, { min: 0, max: 1, tooltip: 'Where along the spine the ribbon starts (0 = base).' }),
    b.float('last', 'Last', 1, { min: 0, max: 1, tooltip: 'Where along the spine the ribbon ends (1 = tip).' }),
    ln.float('frondLengthScale', '% of spine', 1, { min: 0.01, max: 4, variance: 0.1, curve: true, tooltip: 'Ribbon length relative to the (trimmed) spine; above 1 extends along the tip direction.' }),
    ln.float('frondLengthAdd', '+ Absolute', 0, { min: -50, max: 50, softMin: -2, softMax: 2, unit: 'm' }),
    c.seed('seed', 'Seed'),

    w.float('frondWidth', 'Width', 0.25, { min: 0.001, max: 50, softMax: 2, unit: 'm', variance: 0.15, curve: true, tooltip: 'Full width in metres; the curve scales it along the length.' }),
    w.float('frondBaseWidth', 'Base width', 1, { min: 0, max: 2, tooltip: 'Width multiplier at the base (blends to 1 over the first third).' }),
    w.enumOf('frondTipShape', 'Tip', 'Pointed', ['Pointed', 'Rounded', 'Blunt']),
    w.float('frondTipTaper', 'Tip taper', 0.35, { min: 0, max: 1, tooltip: 'Fraction of the length over which the width closes to the tip.' }),
    cs.enumOf('frondShape', 'Shape', 'Flat', ['Flat', 'V fold', 'U curve']),
    cs.float('frondFoldAngle', 'Fold angle', 40, { min: 0, max: 160, unit: '°', curve: true, visibleIf: crossShaped }),
    cs.float('frondCurl', 'Curl', 0, { min: -1, max: 1, tooltip: 'Edges curl up (+) or down (-).' }),
    cs.float('frondCrease', 'Center crease', 0, { min: -80, max: 80, unit: '°', tooltip: 'V-shaped mid rib, typical for grass blades.' }),
    bd.float('frondDroop', 'Droop', 0.3, { min: 0, max: 3, curve: false, variance: 0.2, tooltip: 'Extra gravity bend on top of the spine curve.' }),
    bd.float('frondArch', 'Arch', 0, { min: -180, max: 180, unit: '°', variance: 0.2, tooltip: 'Bend toward (+) or away from the ribbon face.' }),
    bd.float('frondTwist', 'Twist', 0, { min: -720, max: 720, unit: '°', variance: 0.2, tooltip: 'Total twist about the spine along the length.' }),
    fc.enumOf('frondFacing', 'Facing', 'Up', ['Up', 'Outward', 'Parent roll', 'Random'], { tooltip: 'Direction the ribbon face looks toward at its base.' }),
    fc.float('frondRoll', 'Roll', 0, { min: -180, max: 180, unit: '°', variance: 0.1 }),
    fc.float('frondOffset', 'Offset / Sink', 0, { min: -5, max: 5, softMin: -0.2, softMax: 0.2, unit: 'm', tooltip: 'Offset along the face normal; negative values sink the ribbon.' }),

    sg.int('frondLengthSegments', 'Length segments', 6, { min: 1, max: 64 }),
    sg.bool('frondAdaptive', 'Adaptive', true, { tooltip: 'Concentrate rings where the spine curves.' }),
    sg.int('frondWidthSegments', 'Width segments', 1, { min: 1, max: 8, tooltip: 'Cross-section shapes use at least 2.' }),
    sf.enumOf('frondFaces', 'Faces', 'Material', ['Material', 'Duplicate back faces'], { tooltip: 'Material: single layer, two-sidedness from the material. Duplicate: a second flipped layer with correct normals.' }),
    sf.bool('frondInstancing', 'GPU instancing', true, { tooltip: 'Draw identical blades with one instanced mesh (only used when every blade has exactly the same shape).' }),

    uv.enumOf('frondUvMode', 'Match one v tile', 'Stretch', ['Stretch', 'Tile'], { tooltip: 'Stretch: V runs 0..1 over the ribbon. Tile: world-length tiling (needs a full 1x1 atlas).' }),
    uv.float('frondUvTile', 'Tile length', 1, { min: 0.01, max: 100, softMax: 5, unit: 'm', visibleIf: { param: 'frondUvMode', value: 'tile' } }),
    uv.float('frondUvScaleU', 'Scale U', 1, { min: 0.01, max: 20 }),
    uv.float('frondUvScaleV', 'Scale V', 1, { min: 0.01, max: 20 }),
    uv.float('frondUvOffsetU', 'Offset U', 0, { min: -10, max: 10 }),
    uv.float('frondUvOffsetV', 'Offset V', 0, { min: -10, max: 10 }),
    at.int('atlasColumns', 'Columns', 1, { min: 1, max: 16 }),
    at.int('atlasRows', 'Rows', 1, { min: 1, max: 16 }),
    at.enumOf('atlasMode', 'Cell', 'Random', ['Random', 'Sequential', 'Fixed']),
    at.int('atlasCell', 'Fixed cell', 0, { min: 0, max: 255 }),

    lod.float('lodSegments', 'Segment reduction', 0.5, { min: 0, max: 0.9, tooltip: 'Fraction of length segments removed per LOD step.' }),
    lod.float('lodCull', 'Cull amount', 0, { min: 0, max: 1, tooltip: 'Fraction of blades removed at the lowest LOD (the survivors are widened).' }),
    lod.float('lodWidthBoost', 'Width boost', 0.5, { min: 0, max: 2, tooltip: 'How much the remaining blades are widened when blades are culled.' }),
  ];
  const material = leafMaterialParams().filter((d) => d.subgroup === 'Leaves' || d.subgroup === 'Vertex Color');
  const animation = leafWindParams().map((d) => ({ ...d, group: 'Animation' }) as ParamDef);
  const bend = section('Animation', 'Bend weight').float('frondBendPower', 'Bend power', 1.5, { min: 0.1, max: 6, tooltip: 'Wind bend weight along the length: t^power (base stiff, tip free).' });
  return [...list, ...displacementParams(), ...material, ...animation, bend];
}
