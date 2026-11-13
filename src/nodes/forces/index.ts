import type { NodeContext, NodeDef, NodeOutputs } from '@/contracts/nodes';
import type { NodeParams, ParamDef } from '@/contracts/params';
import { PORT } from '@/graph/ports';
import { section } from '../shared/builders';
import { attachOut } from '../shared/ports';

/** Force nodes evaluate to a `ForceDef` that generators read from their `forces` port (applied by `src/forces`). */
export const forceOutput = (forceType: string) => (ctx: NodeContext, _inputs: unknown, params: NodeParams): NodeOutputs => ({
  [PORT.out]: { kind: 'Force', value: { id: ctx.nodeId, name: ctx.name, type: forceType, enabled: params.active?.value !== false, params } },
});

const common = (): ParamDef[] => {
  const c = section('Force', 'Common');
  const i = section('Force', 'Influence');
  return [
    c.bool('active', 'Active', true),
    c.float('strength', 'Strength', 1, { min: -100, max: 100, softMin: -5, softMax: 5, variance: 0, curve: true, tooltip: 'The curve drives the strength along the branch length (0 = base, 1 = tip).' }),
    c.float('influence', 'Influence', 1, { min: 0, max: 1 }),
    i.float('generationFalloff', 'Generation falloff', 0, { min: 0, max: 1, tooltip: 'Each generation below the attached generator receives (1 - falloff) times less force.' }),
    i.float('stiffness', 'Stiffness', 0.5, { min: 0, max: 1, tooltip: 'Resistance to bending. Thick branches are always stiffer than thin ones.' }),
    i.float('refRadius', 'Stiff radius', 0.05, { min: 0.005, max: 1, softMax: 0.3, unit: 'm', tooltip: 'Branch radius with nominal stiffness. Thinner branches bend more, thicker ones less.' }),
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
  def('force.groundAvoid', 'groundAvoid', 'Ground Avoidance', 'Turns branches away from the ground plane.', [
    s.float('groundLevel', 'Ground level', 0, { min: -100, max: 100, softMin: -2, softMax: 5, unit: 'm' }),
    s.float('margin', 'Margin', 0.4, { min: 0.01, max: 20, softMax: 3, unit: 'm' }),
    s.float('outward', 'Outward bias', 0.5, { min: 0, max: 2 }),
  ]),
];
