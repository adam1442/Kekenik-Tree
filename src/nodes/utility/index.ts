import type { NodeDef } from '@/contracts/nodes';
import { section } from '../shared/builders';
import { attachOut } from '../shared/ports';
import { forceOutput } from '../forces';

/**
 * Utility attachments act on growth as guides (collision volumes, guide paths). They travel on the `Force` data kind
 * so any generator's `forces` port accepts them; the footer groups them as "Utilities".
 */
const g = section('Utility', 'Common');
const s = section('Utility', 'Shape');
const active = g.bool('active', 'Active', true);

export const nodeDefs: NodeDef[] = [
  {
    type: 'utility.collision',
    category: 'utility',
    label: 'Collision',
    icon: 'nodeUtility',
    color: 'var(--kt-node-utility)',
    description: 'Volume that growing branches avoid.',
    ports: [attachOut('Force')],
    params: [active, s.enumOf('shape', 'Shape', 'Sphere', ['Sphere', 'Box', 'Plane']), s.vec3('position', 'Position', [0, 0, 2], { step: 0.1 }), s.vec3('size', 'Size', [1, 1, 1], { step: 0.1 }), s.float('margin', 'Margin', 0.1, { min: 0, max: 10, unit: 'm' })],
    evaluate: forceOutput('collision'),
  },
  {
    type: 'utility.path',
    category: 'utility',
    label: 'Guide Path',
    icon: 'nodeUtility',
    color: 'var(--kt-node-utility)',
    description: 'Curve that attracts the structure.',
    ports: [attachOut('Force')],
    params: [active, s.float('attraction', 'Attraction', 0.5, { min: 0, max: 1, curve: true }), s.float('radius', 'Radius', 2, { min: 0, max: 100, unit: 'm' }), s.string('points', 'Points', '0,0,0 0,0,5 1,0,10')],
    evaluate: forceOutput('path'),
  },
];
