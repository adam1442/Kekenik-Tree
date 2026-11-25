import type { NodeContext, NodeDef, NodeOutputs } from '@/contracts/nodes';
import type { NodeParams, ParamDef } from '@/contracts/params';
import { PORT } from '@/graph/ports';
import { SEASON_LIGHT_FORCE, SEASON_WIND_FORCE } from '@/seasons';
import { section } from '../shared/builders';
import { attachOut } from '../shared/ports';

/** Force nodes evaluate to a `ForceDef` that generators read from their `forces` port (applied by `src/forces`). */
export const forceOutput = (forceType: string) => (ctx: NodeContext, _inputs: unknown, params: NodeParams): NodeOutputs => ({
  [PORT.out]: { kind: 'Force', value: { id: ctx.nodeId, name: ctx.name, type: forceType, enabled: params.active?.value !== false, params } },
});

const common = (): ParamDef[] => {
  const c = section('Force', 'Common');
  const i = section('Force', 'Influence');
  const v = section('Force', 'Volume');
  const a = section('Force', 'Attenuation');
  const hasVolume = { param: 'volumeShape', op: 'ne', value: 'none' } as const;
  const atten = { param: 'attenuationEnabled', value: true } as const;
  return [
    c.bool('active', 'Active', true),
    c.float('strength', 'Strength', 1, { min: -100, max: 100, softMin: -5, softMax: 5, variance: 0, curve: true, tooltip: 'The curve drives the strength along the branch length (0 = base, 1 = tip).' }),
    c.float('influence', 'Influence', 1, { min: 0, max: 1 }),
    c.float('alignStrength', 'Align strength', 1, { min: 0, max: 1, tooltip: 'How much this force influences the initial orientation (the first segment) of the branches. It is combined with the Align scalar of each generator\'s Forces group. 1 = full influence (default), 0 = the initial orientation is untouched.' }),
    c.float('indicatorScale', 'Indicator scale', 1, { min: 0.1, max: 10, softMax: 3, tooltip: 'Size of the force gizmo (arrow / plane / handles) in the viewport. It does not change the effect.' }),
    a.bool('attenuationEnabled', 'Attenuation', false, { tooltip: 'Limits the force to a sphere around the Attenuation centre: full strength at the centre, none at the radius.' }),
    a.vec3('attenuationCenter', 'Attenuation centre', [0, 0, 0], { step: 0.1, visibleIf: atten, tooltip: 'World position the attenuation is measured from.' }),
    a.float('attenuationRadius', 'Attenuation radius', 5, { min: 0.01, max: 1000, softMax: 50, unit: 'm', visibleIf: atten, tooltip: 'Distance from the centre where the force has faded to zero.' }),
    a.float('attenuationFalloff', 'Attenuation falloff', 1, { min: 0.05, max: 8, visibleIf: atten, tooltip: 'Shape of the fade: 1 = linear, larger = the force concentrates near the centre.' }),
    i.float('generationFalloff', 'Generation falloff', 0, { min: 0, max: 1, tooltip: 'Each generation below the attached generator receives (1 - falloff) times less force.' }),
    i.float('stiffness', 'Stiffness', 0.5, { min: 0, max: 1, tooltip: 'Resistance to bending. Thick branches are always stiffer than thin ones.' }),
    i.float('refRadius', 'Stiff radius', 0.05, { min: 0.005, max: 1, softMax: 0.3, unit: 'm', tooltip: 'Branch radius with nominal stiffness. Thinner branches bend more, thicker ones less.' }),
    v.enumOf('volumeShape', 'Shape', 'None', ['None', 'Sphere', 'Box'], {
      tooltip: 'Optional region of space named after this force. Generators can keep (Include) or remove (Exclude) nodes inside it from their Force containers.',
    }),
    v.vec3('volumeCenter', 'Center', [0, 0, 0], { step: 0.1, visibleIf: hasVolume, tooltip: 'World position of the volume centre.' }),
    v.float('volumeRadius', 'Radius', 1, { min: 0, max: 1000, softMax: 20, unit: 'm', visibleIf: { param: 'volumeShape', value: 'sphere' }, tooltip: 'Radius of the spherical volume.' }),
    v.vec3('volumeSize', 'Size', [2, 2, 2], { step: 0.1, visibleIf: { param: 'volumeShape', value: 'box' }, tooltip: 'Edge lengths of the box volume along X, Y and Z.' }),
  ];
};

const def = (type: string, forceType: string, label: string, description: string, extra: ParamDef[]): NodeDef => ({
  type,
  category: 'force',
  label,
  icon: 'nodeForce',
  color: 'var(--kt-node-force)',
  description,
  ports: [attachOut('Force')],
  params: [...common(), ...extra],
  evaluate: forceOutput(forceType),
});

const s = section('Force', 'Shape');
const f = section('Force', 'Falloff');
const g = section('Force', 'Geometry');

export const nodeDefs: NodeDef[] = [
  def('force.gravity', 'gravity', 'Gravity', 'Weight: pulls branches down; thin and long branches droop more.', []),
  def('force.directional', 'directional', 'Directional Force', 'Pushes the structure along a direction (steady wind load).', [s.vec3('direction', 'Direction', [1, 0, 0], { step: 0.05 })]),
  def('force.phototropism', 'phototropism', 'Phototropism', 'Grows towards a light direction.', [s.vec3('lightDirection', 'Light direction', [0.4, 0.2, 1], { step: 0.05 }), s.float('sensitivity', 'Sensitivity', 0.5, { min: 0, max: 1 })]),
  def('force.point', 'point', 'Attractor', 'Attracts (or with negative strength repels) towards a point, an axis or a sphere surface.', [
    s.enumOf('shape', 'Shape', 'Point', ['Point', 'Axis', 'Sphere']),
    s.vec3('position', 'Position', [0, 0, 5], { step: 0.1 }),
    s.vec3('axis', 'Axis', [0, 0, 1], { step: 0.05, visibleIf: { param: 'shape', value: 'axis' } }),
    s.float('shellRadius', 'Sphere radius', 2, { min: 0.01, max: 500, softMax: 20, unit: 'm', visibleIf: { param: 'shape', value: 'sphere' } }),
    f.float('radius', 'Range', 5, { min: 0.01, max: 500, softMax: 50, unit: 'm' }),
    f.float('falloff', 'Falloff', 1, { min: 0, max: 8 }),
  ]),
  def('force.vortex', 'vortex', 'Vortex', 'Twists the structure around an axis.', [
    s.vec3('axis', 'Axis', [0, 0, 1], { step: 0.05 }),
    s.vec3('center', 'Center', [0, 0, 0], { step: 0.1 }),
    s.float('twist', 'Twist', 0.5, { min: -10, max: 10 }),
    f.float('radius', 'Range (0 = infinite)', 0, { min: 0, max: 500, softMax: 50, unit: 'm' }),
    f.float('falloff', 'Falloff', 1, { min: 0, max: 8 }),
  ]),
  def('force.noise', 'turbulence', 'Turbulence', 'Turbulent 3D noise load.', [s.float('frequency', 'Frequency', 1, { min: 0.01, max: 50 }), s.float('octaves', 'Octaves', 2, { min: 1, max: 6, step: 1 }), s.seed('noiseSeed', 'Seed')]),
  def('force.curl', 'curl', 'Curl', 'Coils branches around an axis (use the strength curve to curl only the tips).', [s.vec3('axis', 'Axis', [0, 0, 1], { step: 0.05 })]),
  def('force.pullToAxis', 'pullToAxis', 'Pull to Axis', 'Pulls the structure towards a line.', [
    s.vec3('position', 'Position', [0, 0, 0], { step: 0.1 }),
    s.vec3('axis', 'Axis', [0, 0, 1], { step: 0.05 }),
    f.float('radius', 'Full-pull distance', 3, { min: 0.05, max: 500, softMax: 20, unit: 'm' }),
  ]),
  def('force.gnarl', 'gnarl', 'Gnarl', 'Twists spines around a world-space vector into irregular spirals (gnarled trunks).', [
    s.vec3('axis', 'Axis', [0, 0, 1], { step: 0.05, tooltip: 'World-space vector the spines spiral around (the force rotation).' }),
    s.float('frequency', 'Frequency', 1, { min: 0.01, max: 20, softMax: 5, tooltip: 'Turns per metre along the axis.' }),
    s.float('gnarlIrregularity', 'Irregularity', 0.4, { min: 0, max: 1, tooltip: 'Noise added to the phase and strength of the spiral (0 = regular helix).' }),
    s.seed('noiseSeed', 'Seed'),
  ]),
  def('force.twist', 'twist', 'Twist', 'Twists branches about their local up vector (their own growth direction) into a helix.', [
    s.float('turns', 'Turns', 2, { min: -20, max: 20, softMin: -6, softMax: 6, tooltip: 'Number of turns of the helix over the branch length.' }),
    s.float('phase', 'Phase', 0, { min: -360, max: 360, unit: '°', tooltip: 'Start angle of the helix.' }),
  ]),
  def('force.planar', 'planar', 'Planar', 'Confines growth to a 2D plane (espalier, fan shapes).', [
    s.vec3('position', 'Position', [0, 0, 0], { step: 0.1, tooltip: 'A point of the plane.' }),
    s.vec3('normal', 'Normal', [0, 1, 0], { step: 0.05, tooltip: 'Plane normal. Growth is steered into the plane; Strength is how hard.' }),
    s.float('planeSoftness', 'Softness', 0.25, { min: 0.01, max: 20, unit: 'm', tooltip: 'Distance from the plane over which the pull reaches full strength.' }),
  ]),
  def('force.return', 'return', 'Return', 'Steers branches back to their original growth direction (use with jinked / gnarled branches).', []),
  def('force.knockout', 'knockout', 'Knockout', 'Removes nodes that grow in the arrow direction (it does not bend branches).', [
    s.vec3('direction', 'Direction', [0, 0, -1], { step: 0.05, tooltip: 'Nodes growing towards this direction are removed. Strength is the sensitivity: 0 removes nothing, 0.5 removes everything on this side of the plane, 1 removes all nodes.' }),
  ]),
  def('force.geometry', 'geometry', 'Geometry', 'Avoids, attracts or collides with a mesh (trees growing around a wall, a fence, a roof).', [
    { kind: 'asset', id: 'geometryAsset', label: 'Mesh asset', group: 'Force', subgroup: 'Geometry', assetKind: 'mesh', default: null, tooltip: 'Imported mesh asset used as the geometry (Mesh source).' },
    g.vec3('geometryPosition', 'Position', [0, 0, 0], { step: 0.1, tooltip: 'World position of the mesh.' }),
    g.vec3('geometryRotation', 'Rotation', [0, 0, 0], { step: 1, tooltip: 'Rotation of the mesh in degrees (X, Y, Z).' }),
    g.float('geometryScale', 'Scale', 1, { min: 0.001, max: 1000, softMax: 20, tooltip: 'Uniform scale of the mesh (assets are fitted to a unit size first).' }),
    g.bool('includeInModel', 'Include in model', false, { tooltip: 'Marks the mesh as part of the model for export and display. Stored with the force.' }),
    g.bool('ambientOccluder', 'Ambient occluder', false, { tooltip: 'Marks the mesh as an ambient occluder for leaf lighting. Stored with the force.' }),
    g.enumOf('geometryForce', 'Force', 'Avoid', ['Avoid', 'Attract', 'None'], { tooltip: 'Avoid steers branches away from the mesh, Attract towards it (a negative Strength reverses it), None only collides.' }),
    g.enumOf('geometryCollide', 'Collide', 'None', ['None', 'Obstruct', 'Prune', 'Stop'], { tooltip: 'Obstruct: branches slide along the surface and never enter the mesh. Prune: a branch is cut before its first intersection. Stop: a branch ends exactly on the surface it meets.' }),
    g.float('geometryRange', 'Range', 1, { min: 0.001, max: 100, softMax: 10, unit: 'm', tooltip: 'Distance around the mesh within which Avoid / Attract acts.' }),
    g.float('geometryFalloff', 'Falloff', 1, { min: 0.05, max: 8, tooltip: 'Shape of the fade with distance inside the Range.' }),
    g.float('geometrySkin', 'Skin', 0.02, { min: 0, max: 5, softMax: 0.5, unit: 'm', tooltip: 'Gap kept between Obstruct-ed branches and the surface.' }),
  ]),
  def('force.seasonLight', SEASON_LIGHT_FORCE, 'Season Light', 'Leaves that grow towards the arrow change season sooner (it does not bend branches).', [
    s.vec3('direction', 'Direction', [0, 0, 1], { step: 0.05, tooltip: 'Direction of the light. Leaves whose growth axis points this way change sooner, leaves pointing away change later. Strength is the size of the shift (1 = a quarter of the season).' }),
  ]),
  def('force.seasonWind', SEASON_WIND_FORCE, 'Season Wind', 'Dropped leaves are swept along the arrow on the ground (it does not bend branches).', [
    s.vec3('direction', 'Direction', [1, 0, 0], { step: 0.05, tooltip: 'Direction (in the XY plane) the dropped leaves are blown to.' }),
    s.float('distance', 'Distance', 2, { min: 0, max: 100, softMax: 10, unit: 'm', tooltip: 'How far a dropped leaf is swept at Strength 1 (each leaf travels 30 - 100 % of it).' }),
  ]),
  def('force.groundAvoid', 'groundAvoid', 'Ground Avoidance', 'Turns branches away from the ground plane.', [
    s.float('groundLevel', 'Ground level', 0, { min: -100, max: 100, softMin: -2, softMax: 5, unit: 'm' }),
    s.float('margin', 'Margin', 0.4, { min: 0.01, max: 20, softMax: 3, unit: 'm' }),
    s.float('outward', 'Outward bias', 0.5, { min: 0, max: 2 }),
  ]),
];
