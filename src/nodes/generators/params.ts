import { flatCurve, type Curve } from '@/contracts/curve';
import type { Condition, ListParamDef, ParamDef } from '@/contracts/params';
import { getCurvePreset } from '@/core/curve';
import { section } from '../shared/builders';

/**
 * Parameter catalogues of the generator nodes, grouped by inspector tab (`group`) and section (`subgroup`).
 * Tab order for structure generators follows the Properties panel layout:
 *   Generation, Spine, Forces, Shape, Skin, UV, LOD, Displacement, Material, Animation, Hand drawn
 * Leaf-like generators retain:
 *   Generation, Skin, Forces, Orientation, Material, Lighting, Wind, Post
 */
export interface GenerationDefaults {
  number: number;
  first: number;
  last: number;
  jumble?: number;
  includeBranchExtended?: boolean;
  /** First-generation capable: adds the `Tree placement` section (distribution inside the Tree disc). */
  placement?: boolean;
  /** Adds the `Extend parent` section (Branch, Cap, Leaf, Batched leaf: valid under a Branch or Trunk parent). */
  extend?: boolean;
  /** Hides `Extend parent > Count` (the Cap closes every open end it takes, one cap each). */
  extendNoCount?: boolean;
  /** Adds `Mesh alignment` to the `More` section (Leaf, Batched leaf: used when the parent is a mesh). */
  meshAlignment?: boolean;
}

/** Mode ids that use the shared Absolute-style layout controls. */
const COUNT_MODES = ['absolute', 'proportional', 'density', 'classic', 'flood', 'parent'];

const modeIs = (...modes: string[]): Condition => ({ param: 'mode', op: 'in', value: modes });

/** Phyllotaxy styles: label shown in the inspector -> stored value. */
const PHYLLOTAXY_STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'opposite-distichous', label: 'Opposite (distichous)' },
  { value: 'opposite-decussate', label: 'Opposite (decussate)' },
  { value: 'opposite-random', label: 'Opposite (random orientation)' },
  { value: 'alternating-distichous', label: 'Alternating (distichous)' },
  { value: 'alternating-random', label: 'Alternating (random)' },
  { value: 'whorled', label: 'Whorled' },
];

/** List of picked names (Force containers, Masks): one enum row per name; the options are filled by the inspector. */
function namedList(id: string, label: string, subgroup: string, field: string, fieldLabel: string, tooltip: string): ParamDef {
  return {
    kind: 'list',
    id,
    label,
    group: 'Generation',
    subgroup,
    tooltip,
    default: [],
    minItems: 0,
    maxItems: 8,
    fields: [{ kind: 'enum', id: field, label: fieldLabel, group: 'Generation', subgroup, default: '', options: [{ value: '', label: 'None' }] }],
  };
}

/** Pass and Size scalar only, for generators with their own Generation tab (Frond, Decoration). */
export function passAndSizeParams(): ParamDef[] {
  const c = section('Generation', 'Common');
  const mo = section('Generation', 'More');
  return [
    c.int('pass', 'Pass', 1, { min: 1, max: 99, tooltip: 'Generators compute in pass order. A node cannot have a lower pass than any of its ancestors.' }),
    mo.float('sizeScalar', 'Size scalar', 1, { min: 0.01, max: 100, softMax: 5, tooltip: 'Scales this node and every node below it.' }),
  ];
}

/** "Generation" tab - shared by every generator. `Mode` selects one of the placement algorithms of `generators/modes`. */
export function generationParams(d: GenerationDefaults): ParamDef[] {
  const g = section('Generation', 'Generation');
  const a = section('Generation', 'Absolute');
  const dn = section('Generation', 'Density');
  const pr = section('Generation', 'Proportional');
  const st = section('Generation', 'Steps');
  const ph = section('Generation', 'Phyllotaxy');
  const iv = section('Generation', 'Interval');
  const bf = section('Generation', 'Bifurcation');
  const al = section('Generation', 'Alignment');
  const b = section('Generation', 'Boundaries');
  const ex = section('Generation', 'Extend parent');
  const lm = section('Generation', 'Limits');
  const ko = section('Generation', 'Knockout');
  const mo = section('Generation', 'More');
  const c = section('Generation', 'Common');
  const tp = section('Generation', 'Tree placement');

  const extendActive = { param: 'extendParent', op: 'ne', value: 'none' } as const;
  const stepsMode = modeIs('absolute-steps', 'proportional-steps');
  const whorledStyle: Condition = { all: [{ param: 'mode', value: 'phyllotaxy' }, { param: 'phyllotaxyStyle', value: 'whorled' }] };

  const mode = g.enumOf(
    'mode',
    'Mode',
    'Absolute',
    ['Absolute', 'Proportional', 'Absolute steps', 'Proportional steps', 'Phyllotaxy', 'Interval', 'Bifurcation', 'Flood', 'Parent', 'Density', 'Classic'],
    {
      tooltip:
        'How children are placed on the parent: an exact number, proportional to its length, in steps (whorls), by phyllotaxy, at intervals, at bends, flooded along it or all at its origin.',
    },
  );
  if (mode.kind === 'enum') {
    mode.options = mode.options.map((o) => (o.value === 'classic' ? { ...o, label: 'Classic (legacy)', disabled: true } : o));
  }
  const style = ph.enumOf('phyllotaxyStyle', 'Style', 'Alternating (distichous)', [], {
    tooltip: 'How the nodes of a group are arranged and how consecutive groups are turned against each other.',
    visibleIf: modeIs('phyllotaxy'),
  });
  if (style.kind === 'enum') style.options = PHYLLOTAXY_STYLE_OPTIONS;
  const groupAlign = (sec: typeof ph, id: string, only: string): ParamDef => {
    const def = sec.enumOf(id, 'Align style', 'Group', ['Group', 'Individual'], {
      tooltip: 'Group keeps the nodes of a group in their fixed layout; Individual turns every node on its own within its share of the circle.',
      visibleIf: modeIs(only),
    });
    return def;
  };

  const list: ParamDef[] = [
    mode,

    // Absolute / count-driven controls
    a.int('number', 'Number', d.number, {
      min: 0,
      max: 100000,
      softMax: 100,
      warnAbove: 1000,
      variance: 0,
      curve: true,
      visibleIf: modeIs('absolute', 'classic', 'flood', 'parent'),
      tooltip: 'Exact number of nodes created on each parent.',
    }),
    a.float('jumble', 'Jumble', d.jumble ?? 0, { min: 0, max: 1, curve: true, visibleIf: modeIs('absolute', 'proportional', 'density', 'classic') }),
    a.float('sweep', 'Sweep', 1, { min: 0.01, max: 1, softMax: 1, curve: true, visibleIf: modeIs(...COUNT_MODES) }),
    a.float('roll', 'Roll', 0, { min: -1, max: 1, curve: true, visibleIf: modeIs(...COUNT_MODES) }),
    a.float('favorSplits', 'Favor splits', 0, { min: -1, max: 1, curve: true, visibleIf: modeIs('absolute', 'proportional', 'classic', 'flood') }),
    a.enumOf('alignStyle', 'Align style', 'Group', ['Group', 'Individual', 'Spiral', 'Alternate', 'Opposite'], {
      visibleIf: modeIs('absolute', 'proportional', 'density', 'classic'),
    }),

    // Density (existing)
    dn.float('density', 'Density', 1.5, { min: 0, max: 100, softMax: 10, unit: '/m', curve: true, visibleIf: modeIs('density') }),
    dn.float('densityJitter', 'Jitter', 0.2, { min: 0, max: 1, visibleIf: modeIs('density') }),

    // Proportional
    pr.float('proportionalCount', 'Frequency', 2.5, {
      min: 0,
      max: 50,
      softMax: 10,
      unit: '/m',
      visibleIf: modeIs('proportional'),
      tooltip: 'Nodes per metre of parent length: longer parents get more nodes, spread at random along them.',
    }),

    // Steps (Absolute steps / Proportional steps; ids of the former Whorled mode are kept)
    st.int('whorlCount', 'Steps', 5, { min: 1, max: 128, visibleIf: modeIs('absolute-steps'), tooltip: 'Number of steps (rings of nodes) along the parent.' }),
    st.float('stepsFrequency', 'Steps', 0.5, {
      min: 0,
      max: 20,
      softMax: 5,
      unit: '/m',
      visibleIf: modeIs('proportional-steps'),
      tooltip: 'Steps per metre of parent length.',
    }),
    st.int('whorlPerStep', 'Per step', 4, { min: 1, max: 128, softMax: 24, visibleIf: stepsMode, tooltip: 'Nodes in every step.' }),
    st.float('whorlSpread', 'Spread', 0.03, {
      min: 0,
      max: 1,
      visibleIf: stepsMode,
      tooltip: 'Lengthwise spacing of the nodes inside one step, as a fraction of the First..Last stretch.',
    }),
    st.float('whorlRoll', 'Roll', 15, { min: -180, max: 180, unit: '°', visibleIf: stepsMode, tooltip: 'Rotation of every step relative to the previous one.' }),
    st.float('stepsBalance', 'Balance', 1, {
      min: 0,
      max: 1,
      visibleIf: stepsMode,
      tooltip: 'How evenly the nodes of a step are spaced around the parent (1 = evenly, 0 = random).',
    }),

    // Phyllotaxy
    style,
    ph.float('phyllotaxyInternode', 'Internode length', 0.25, {
      min: 0,
      max: 50,
      softMax: 2,
      unit: 'm',
      visibleIf: modeIs('phyllotaxy'),
      tooltip: 'Distance between groups, measured along the parent from Last towards First. 0 spreads Limit groups evenly instead.',
    }),
    ph.int('phyllotaxyChildren', 'Children per node', 3, { min: 1, max: 32, visibleIf: whorledStyle, tooltip: 'Nodes in each whorled group.' }),
    ph.float('phyllotaxySpread', 'Spread', 0, {
      min: 0,
      max: 1,
      visibleIf: modeIs('phyllotaxy'),
      tooltip: 'Random lengthwise offset of every node inside its group (1 = up to the neighbouring group).',
    }),
    ph.float('phyllotaxySpiral', 'Spiral', 0, { min: -180, max: 180, unit: '°', visibleIf: modeIs('phyllotaxy'), tooltip: 'Extra rotation added for every group.' }),
    ph.int('phyllotaxyLimit', 'Limit', 0, { min: 0, max: 10000, softMax: 100, visibleIf: modeIs('phyllotaxy'), tooltip: 'Maximum number of groups (0 = no limit).' }),
    groupAlign(ph, 'phyllotaxyAlignStyle', 'phyllotaxy'),

    // Interval
    iv.float('intervalStep', 'Frequency', 0.6, {
      min: 0.001,
      max: 50,
      softMax: 3,
      unit: 'm',
      curve: true,
      visibleIf: modeIs('interval'),
      tooltip: 'Distance between groups from Last towards First. The curve scales it along the parent: lower values pack groups tighter.',
    }),
    iv.int('perStep', 'Count', 1, { min: 1, max: 64, softMax: 16, visibleIf: modeIs('interval'), tooltip: 'Nodes in every group.' }),
    iv.float('intervalSpread', 'Spread', 0, {
      min: 0,
      max: 1,
      visibleIf: modeIs('interval'),
      tooltip: 'Random lengthwise offset of every node inside its group (1 = up to the neighbouring group).',
    }),
    iv.float('intervalSpiral', 'Spiral', 0, { min: -180, max: 180, unit: '°', visibleIf: modeIs('interval'), tooltip: 'Extra rotation added for every group.' }),
    iv.int('intervalLimit', 'Limit', 0, { min: 0, max: 10000, softMax: 100, visibleIf: modeIs('interval'), tooltip: 'Maximum number of groups (0 = no limit).' }),
    groupAlign(iv, 'intervalAlignStyle', 'interval'),
    iv.float('intervalBalance', 'Balance', 0, {
      min: 0,
      max: 1,
      visibleIf: modeIs('interval'),
      tooltip: 'Turns every other group so its nodes fill the gaps left by the previous group.',
    }),

    // Bifurcation
    bf.int('bifurcationCount', 'Count', 4, { min: 0, max: 1000, softMax: 32, visibleIf: modeIs('bifurcation'), tooltip: 'Maximum number of nodes; the strongest bends win.' }),
    bf.float('bifurcationThreshold', 'Threshold', 6, { min: 0.5, max: 90, unit: '°', visibleIf: modeIs('bifurcation'), tooltip: 'Smallest bend of the parent that gets a node.' }),
    bf.float('bifurcationSpread', 'Spread', 0, { min: 0, max: 1, visibleIf: modeIs('bifurcation'), tooltip: 'Random shift of every node along the parent (1 = 10 % of its length).' }),
    bf.float('bifurcationSpacing', 'Min spacing', 0.12, { min: 0.01, max: 0.9, visibleIf: modeIs('bifurcation'), tooltip: 'Smallest distance between two bends, as a fraction of the parent.' }),

    // Alignment (skyward roll, read by generators that grow their own branches)
    al.bool('align', 'Align', false, { visibleIf: { param: 'mode', op: 'ne', value: 'parent' }, tooltip: 'Rolls the new nodes so they face the sky.' }),
  ];

  // Boundaries
  list.push(
    b.float('first', 'First', d.first, { min: 0, max: 1, curve: true, tooltip: 'Lowest point on the parent where nodes occur (0 = base, 1 = tip).' }),
    b.float('last', 'Last', d.last, { min: 0, max: 1, curve: true, tooltip: 'Highest point on the parent where nodes occur (0 = base, 1 = tip).' }),
    b.curve('distributionCurve', 'Distribution curve', getCurvePreset('linear'), {
      tooltip: 'Maps normalized spacing [0..1] across [First..Last].',
    }),
    b.float('clip', 'Clip', 0, {
      min: 0,
      max: 0.49,
      tooltip: 'With the checkbox on, nodes that Spread or Position push outside First..Last are removed instead of being held on the boundary. The value insets the range (fraction of First..Last).',
    }),
    b.bool('clipEnabled', 'Clip enabled', false),
  );

  // Common
  list.push(
    c.bool('active', 'Active', true, { curve: true, tooltip: 'Switches the generator on. With a curve over the level of detail (left = highest detail) it is active where the curve is above 0.5.' }),
    c.int('pass', 'Pass', 1, {
      min: 1,
      max: 99,
      tooltip: 'Generators compute in pass order. A node cannot have a lower pass than any of its ancestors.',
    }),
    c.float('rotationOffset', 'Rotation', 0, { min: -180, max: 180, unit: '°', variance: 0, tooltip: 'Rotates all nodes around the parent spine as a group. Variance jumbles the rotation per parent.' }),
    c.float('positionOffset', 'Position', 0, { min: -0.5, max: 0.5, variance: 0, tooltip: 'Shifts all nodes along the parent (fraction of its length). Variance shifts every parent differently.' }),
    c.float('sink', 'Sink', 0, { min: -5, max: 5, softMin: -1, softMax: 1, unit: 'm', variance: 0, tooltip: 'Start offset of the nodes into (+) or out of (-) the parent; sinks trunks under the ground.' }),
    c.curve('pruningCurve', 'Pruning', flatCurve(1), {
      tooltip: 'Runs over the parent from First (left) to Last (right). Nodes are removed where the curve is below 0.5.',
    }),
    c.seed('seed', 'Seed'),
  );

  // Extend parent
  if (d.extend) {
    list.push(
      ex.enumOf('extendParent', 'Type', 'None', ['None', 'Any', 'Split 1', 'Split 2', 'Skinny', 'Fat', 'Breaks only', 'Bottom'], {
        tooltip: 'Continues an open end of the parent instead of starting a new branch. Valid only under a Branch or Trunk parent. Any = every open end (the two sides of a split count, the split branch itself does not), Split 1 / Split 2 = that side, Skinny / Fat = the thinner / thicker side, Breaks only = branches that broke, Bottom = the base of the parent.',
      }),
      ...(d.extendNoCount ? [] : [ex.int('extendCount', 'Count', 1, { min: 1, max: 8, visibleIf: extendActive, tooltip: 'Extensions created per open end (several extensions on one end separate by Extensions > Spread).' })]),
    );
  }

  // Knockout (+ the recursion limits of the structure generators)
  list.push(
    ko.float('knockout', 'Amount', 0, { min: 0, max: 1, curve: true, tooltip: 'Randomly removes this share of the nodes after the mode has placed them. The curve varies it along the parent.' }),
    ko.float('knockoutResolution', '+ Resolution', 0, {
      min: -1,
      max: 1,
      step: 0.01,
      tooltip: 'Added to the amount for every level of detail below the highest: positive removes more nodes at lower detail, negative fewer.',
    }),
  );
  if (d.includeBranchExtended) {
    list.push(
      lm.int('generations', 'Sub-generations', 1, {
        min: 1,
        max: 5,
        tooltip: 'Recursive branching levels evaluated inside this generator (1 = single level).',
      }),
      lm.int('maxGeneration', 'Max generation', 8, {
        min: 1,
        max: 16,
        tooltip: 'Maximum hierarchy generation depth allowed for branches.',
      }),
    );
  }

  // Force containers
  list.push(
    namedList('forceInclude', 'Include', 'Force containers', 'forceName', 'Force', 'Keeps only the nodes inside the volume of the named Force node (set a volume in the Force node).'),
    namedList('forceExclude', 'Exclude', 'Force containers', 'forceName', 'Force', 'Removes the nodes inside the volume of the named Force node.'),
  );

  // More
  list.push(
    mo.enumOf('clickPlace', 'Click place', 'Ready', ['Ready', 'None', 'Any', 'Number'], {
      tooltip: 'What a click in the viewport places. It is stored with the node and takes effect with Freehand mode.',
    }),
  );
  if (d.meshAlignment) {
    list.push(
      mo.enumOf('meshAlignment', 'Mesh alignment', 'None', ['None', 'Tangent', 'Binormal', 'Parent X', 'Parent Y', 'Parent Z', 'World X', 'World Y', 'World Z'], {
        tooltip: 'When the parent is a mesh, turns the growth axis of the leaf to the parent tangent / binormal, one of the parent axes, or a world axis.',
      }),
    );
  }
  list.push(mo.float('sizeScalar', 'Size scalar', 1, { min: 0.01, max: 100, softMax: 5, tooltip: 'Scales this node and every node below it.' }));

  // Masks
  list.push(namedList('genMasks', 'Mask', 'Masks', 'genMaskId', 'Mask', 'Keeps a node only where every assigned mask (Masks panel) evaluates to 0.5 or more.'));

  if (d.placement) {
    const par = { param: 'distMode', value: 'parametric' } as const;
    const poisson = { param: 'distMode', value: 'poisson' } as const;
    const ringOrPar: Condition = { param: 'distMode', op: 'in', value: ['parametric', 'ring'] };
    list.push(
      tp.enumOf('distMode', 'Distribution', 'Uniform', ['Parametric', 'Uniform', 'Poisson disk', 'Ring', 'Grid', 'Spiral'], {
        tooltip: 'How Number instances fill the Tree disc. Uniform = area-correct random (r = R*sqrt(u)); Poisson disk = blue noise with a minimum distance.',
      }),
      tp.float('distPosition', 'Position', 0.5, { min: 0, max: 1, variance: 0, curve: false, visibleIf: ringOrPar, tooltip: 'Normalised distance from the disc centre (0 = centre, 1 = edge), with variance.' }),
      tp.float('distRotation', 'Rotation', 0, { min: 0, max: 1, variance: 0, visibleIf: par, tooltip: 'Normalised angle around the centre (0..1 = 0..360 degrees), with variance.' }),
      tp.float('distMinDistance', 'Min distance', 0.5, { min: 0, max: 1000, softMax: 10, unit: 'm', visibleIf: poisson }),
      tp.float('distSplay', 'Splay', 0, { min: 0, max: 85, unit: '°', tooltip: 'Outward tilt reached at the disc edge (ferns, bushes). Ignored when Unify child orientation is on.' }),
    );
  }

  return list;
}

/** Default Path tile: one smooth sine wave (offset from -1 to 1 over the tile). */
export function pathProfileCurve(): Curve {
  const t = { dx: 0.12, dy: 0 };
  const pt = (x: number, y: number): Curve['points'][number] => ({ x, y, inTangent: { dx: -t.dx, dy: t.dy }, outTangent: { dx: t.dx, dy: t.dy }, mode: 'flat' });
  const rising = (x: number, y: number): Curve['points'][number] => ({ x, y, inTangent: { dx: -0.12, dy: -0.9 }, outTangent: { dx: 0.12, dy: 0.9 }, mode: 'free' });
  return {
    points: [rising(0, 0), pt(0.25, 1), rising(0.5, 0), pt(0.75, -1), rising(1, 0)],
    xRange: [0, 1],
    yRange: [-1, 1],
    wrap: 'clamp',
  };
}

export interface SpineDefaults {
  kind: 'trunk' | 'branch' | 'root' | 'spine';
  length: number;
  radius: number;
  taper: number;
  segments: number;
  spread?: number;
  gravity?: number;
  upDown?: number;
  noiseAmount?: number;
}

export function spineParams(
  lenOrOpts: number | SpineDefaults,
  radiusArg = 0.08,
  segmentsArg = 12,
): ParamDef[] {
  const opts: SpineDefaults =
    typeof lenOrOpts === 'number'
      ? { kind: 'branch', length: lenOrOpts, radius: radiusArg, taper: 0.9, segments: segmentsArg }
      : lenOrOpts;

  const isTrunk = opts.kind === 'trunk';
  const isRoot = opts.kind === 'root';

  const l = section('Spine', 'Length');
  const r = section('Spine', 'Radius');
  const s = section('Spine', 'Segment length');
  const d = section('Spine', 'Orientation');
  const sh = section('Spine', 'Shape');
  const ne = section('Spine', 'Early');
  const nl = section('Spine', 'Late');
  const jk = section('Spine', 'Jink');
  const pa = section('Spine', 'Path');
  const bk = section('Spine', 'Break');
  const tm = section('Spine', 'Splits & Termination');
  const pr = section('Spine', 'Prune');
  const rt = section('Spine', 'Root Growth');
  const cl = section('Spine', 'Clamp');
  const pc = section('Spine', 'Parent Curl');
  const zz = section('Spine', 'Zigzag');
  const crownCurveVisible = { param: 'crownShape', value: 'custom' } as const;

  const out: ParamDef[] = [
    // Length: Absolute + (% of parent) + (% of radius) are added
    l.float('length', 'Absolute', opts.length, { min: 0, max: 500, softMax: isTrunk ? 40 : 20, unit: 'm', variance: 0.1, curve: true, tooltip: 'Fixed part of the length in metres. The curve scales the length along the parent.' }),
    l.float('lengthPercent', '+ % of parent', isTrunk ? 0 : 0.08, { min: 0, max: 2, softMax: 1, curve: true, tooltip: 'Adds this fraction of the parent length (1 = as long as the parent).' }),
    l.float('lengthPercentRadius', '+ % of radius', 0, { min: 0, max: 500, softMax: 100, tooltip: 'Adds this many parent radii to the length.' }),
    l.bool('matchOneVTile', 'Match one V tile', false, { tooltip: 'Sets the length to exactly one V tile of the material, from its aspect ratio and the branch radius, and maps V from 0 to 1.' }),
    l.bool('stopShapeControl', 'Stop shape control', false, { tooltip: 'Ignores the crown shape envelope and the generation damping, so this node is not shaped by its ancestors.' }),
    l.float('shapeScale', 'Shape scale', 1, { min: 0, max: 5, softMax: 2, tooltip: 'Strength of the crown shape on the length: 0 = off, 1 = as drawn, above 1 = exaggerated.' }),
    l.bool('lengthLimit', 'Limit length', false, { tooltip: 'Prevents children from becoming longer than the Absolute length.' }),
    ...(!isTrunk
      ? [
          l.enumOf('crownShape', 'Crown envelope', 'Natural', ['Natural', 'Conical', 'Oval', 'Vase', 'Columnar', 'Custom'], {
            tooltip: 'Branch length as a function of the normalised height on the parent: cone (conifer), oval (oak), vase, column or a custom curve.',
          }),
          l.curve('crownCurve', 'Crown curve', flatCurve(1), { visibleIf: crownCurveVisible, tooltip: 'Length multiplier from parent base (0) to tip (1).' }),
        ]
      : []),
    cl.float('lengthMin', 'Min', 0, { min: 0, max: 500, softMax: 20, unit: 'm', tooltip: '0 = no minimum.' }),
    cl.float('lengthMax', 'Max', 0, { min: 0, max: 500, softMax: 20, unit: 'm', tooltip: '0 = no maximum.' }),
    ...(isTrunk
      ? [
          l.float('crownHeight', 'Crown height', 0.22, {
            min: 0,
            max: 0.95,
            tooltip: 'Normalized height where the lower trunk transitions into the crown.',
          }),
        ]
      : []),

    // Radius
    r.float('radius', 'Radius', opts.radius, { min: 0.001, max: 20, softMax: isTrunk ? 2 : 0.5, unit: 'm', variance: 0.08, curve: true }),
    ...(!isTrunk
      ? [
          r.float('parentRadiusInfluence', '% of parent', isRoot ? 0.55 : 0.4, { min: 0, max: 1, curve: true }),
          r.float('parentRadiusMax', 'Max parent ratio', 0.82, { min: 0.05, max: 1.5 }),
        ]
      : []),
    r.curve('radiusProfile', 'Radius profile', flatCurve(1), {
      tooltip: 'Normalized radius multiplier from base (0) to tip (1).',
    }),
    r.float('taper', 'Taper', opts.taper, { min: 0, max: 1, curve: true }),
    r.float('minRadius', 'Min radius', isTrunk ? 0.008 : 0.002, { min: 0.0005, max: 1, softMax: 0.05, unit: 'm' }),

    // Direction / Orientation
    ...(isTrunk
      ? [
          d.float('lean', 'Lean', 2, { min: 0, max: 60, unit: '°', variance: 0.25 }),
          d.float('leanAzimuth', 'Lean direction', 25, { min: -180, max: 180, unit: '°', variance: 0.5 }),
        ]
      : []),
    d.float('spread', isTrunk ? 'Spread' : 'Start angle', opts.spread ?? (isTrunk ? 12 : isRoot ? 68 : 48), {
      min: 0,
      max: 180,
      unit: '°',
      variance: 0.12,
      curve: true,
      tooltip: isTrunk
        ? 'Angle between the trunk and the vertical, in degrees.'
        : 'Angle to the parent in degrees: 0 = parent direction, 90 = perpendicular, 180 = opposite.',
    }),
    d.float('startRoll', 'Start roll', 0, { min: -180, max: 180, unit: '°', variance: 0, curve: true, tooltip: 'Rotates the direction the Start angle is applied in (+ clockwise, - counter-clockwise).' }),
    d.float('pitch', 'Pitch', 0, { min: -90, max: 90, unit: '°', variance: 0.1, curve: true }),
    d.float('spineRoll', 'Roll', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotates the branch around its own axis by a fixed amount, after Alignment.' }),
    d.float('alignment', 'Alignment', isTrunk ? 0 : 0.2, { min: 0, max: 1, tooltip: 'Blends a random up (0) with the world up (1), so the top of the branch points up.' }),
    d.float('upDown', 'Up / down', opts.upDown ?? (isTrunk ? 0.05 : isRoot ? -0.25 : 0.06), { min: -2, max: 2, softMin: -1, softMax: 1, curve: true }),
    ...(!isTrunk
      ? [
          d.bool('unify', 'Unify', false, { tooltip: 'Nodes on opposite sides of the parent share the same orientation (mirrored roll).' }),
          d.bool('weldStart', 'Weld start', false, {
            visibleIf: { param: 'skinType', value: 'spine-only' },
            tooltip: 'For Spine only branches: starts on the skin of the parent instead of on its spine.',
          }),
        ]
      : []),

    // Shape (Curvature, Gravity bend hook, Twist)
    sh.float('gravity', 'Gravity', opts.gravity ?? (isTrunk ? 0 : isRoot ? 0.2 : 0.16), { min: -2, max: 3, softMin: -1, softMax: 1.5, curve: true, tooltip: 'A downward force on the spine (+ bends down, - bends up).' }),
    ...(!isTrunk ? [sh.float('ancestor', 'Ancestor', 0, { min: -1, max: 1, curve: true, tooltip: '+ grows towards the direction of the parent, like a bud; - grows away from it.' })] : []),
    sh.float('curvature', 'Curvature', isTrunk ? 0.03 : isRoot ? -0.12 : 0.06, { min: -2, max: 2, softMin: -1, softMax: 1, variance: 0.15, curve: true }),
    sh.float('straightness', 'Straightness', isTrunk ? 0.35 : 0.2, { min: 0, max: 1, tooltip: 'Removes noise: fully at the base, fading to none at the tip.' }),
    sh.float('twist', 'Twist', 0, { min: -720, max: 720, softMin: -180, softMax: 180, unit: '°', variance: 0, curve: true, tooltip: 'Total twist of the branch around its axis, in degrees.' }),

    // Parent curl: rotates the spine around axes of the parent's frame
    pc.float('curlUp', 'Up', 0, { min: -3, max: 3, softMin: -1, softMax: 1, tooltip: 'Curl around the parent direction (the branch winds around its parent).' }),
    pc.float('curlRight', 'Right', 0, { min: -3, max: 3, softMin: -1, softMax: 1, tooltip: 'Curl around the axis perpendicular to the parent direction and the initial direction.' }),
    pc.float('curlOut', 'Out', 0, { min: -3, max: 3, softMin: -1, softMax: 1, tooltip: 'Curl around the axis pointing straight out of the parent.' }),
    zz.float('zigzag', 'Intensity', 0, { min: 0, max: 3, softMax: 1, tooltip: 'How sharply the spine changes direction at every zigzag corner (0 = off).' }),
    s.float('zigzagLengthAbsolute', 'Absolute', 0, { min: 0, max: 50, softMax: 2, unit: 'm', curve: true, tooltip: 'Fixed part of the distance between two zigzag corners. The curve scales the length along the branch.' }),
    s.float('zigzagLengthRelative', '+ Relative', 0.1, { min: 0, max: 1, tooltip: 'Adds this fraction of the branch length to the distance between two zigzag corners.' }),

    // Noise: Early (while the spine is shaped) and Late (after it is shaped)
    ne.float('earlyNoiseAmount', 'Amount', isTrunk ? 0.05 : isRoot ? 0.16 : 0.08, { min: 0, max: 2, softMax: 0.8, curve: true, tooltip: 'Strength of the noise that bends the spine while it grows (chaotic). The curve changes the strength along the spine.' }),
    ne.float('earlyNoiseFrequency', 'Turbulence', 1.2, { min: 0.05, max: 15, softMax: 5, tooltip: 'How chaotic the early noise wave is: higher values change direction more often.' }),
    ne.float('earlyNoiseThreshold', 'Threshold', 0, { min: 0, max: 1, curve: true, tooltip: 'Point along the spine that must be passed before the early noise starts. The curve changes where it starts and ends.' }),
    nl.float('noiseAmount', 'Amount', opts.noiseAmount ?? (isTrunk ? 0.18 : isRoot ? 0.28 : 0.2), { min: 0, max: 5, softMax: 1.5, curve: true, tooltip: 'Strength of the noise applied after the spine is shaped: organic yet controlled. The curve changes the strength along the spine.' }),
    nl.float('noiseFrequency', 'Turbulence', isRoot ? 1.6 : 1.1, { min: 0, max: 20, softMax: 6, tooltip: 'How chaotic the late noise wave is: higher values change direction more often.' }),
    nl.float('noiseSmooth', 'Smooth', 0, { min: 0, max: 1, tooltip: 'Straightens the applied noise: 1 gives the spine as shaped, with no noise left.' }),
    nl.seed('noiseSeed', 'Seed'),
    nl.float('noiseTwist', 'Twist', isTrunk ? 0.1 : 0, { min: -2, max: 2, softMin: -1, softMax: 1, tooltip: 'Rotates the late noise as it travels along the spine.' }),

    // Jink: straight runs
    jk.float('jinkAmount', 'Amount', 0, { min: 0, max: 1, tooltip: 'Straightens the spine into linear segments: 0 leaves it unchanged, 1 makes it entirely long straight runs.' }),
    jk.int('jinkAbsolute', 'Absolute', 3, { min: 1, max: 64, softMax: 16, tooltip: 'Minimum number of straight segments.' }),
    jk.float('jinkRelative', '+ Relative', 0, { min: 0, max: 20, softMax: 4, tooltip: 'Adds this many straight segments per metre of branch length.' }),
    jk.float('jinkUniformity', 'Uniformity', 0.5, { min: 0, max: 1, tooltip: 'How similar the segment lengths are. At 1 all segments are equally long and the seed has no effect.' }),
    jk.seed('jinkSeed', 'Seed'),

    // Path: a tile profile traced along the spine
    pa.float('pathAmount', 'Amount', 0, { min: 0, max: 20, softMax: 1, unit: 'm', tooltip: 'Size of the path deformation in metres. The Profile curve is the shape of one tile.' }),
    pa.curve('pathProfile', 'Profile', pathProfileCurve(), { tooltip: 'Shape of one tile: sideways offset (vertical) along the tile length (horizontal).' }),
    pa.float('pathTwist', 'Twist', 0, { min: -720, max: 720, softMin: -180, softMax: 180, unit: '°/m', tooltip: 'Turns the direction of the deformation around the spine, in degrees per metre.' }),
    pa.float('pathLength', 'Length', 1, { min: 0.01, max: 100, softMax: 10, unit: 'm', tooltip: 'Length of exactly one tile. When it is shorter than the branch the tile repeats.' }),
    pa.float('pathOffset', 'Offset', 0, { min: 0, max: 1, variance: 1, tooltip: 'Shifts the tiles along the spine (fraction of one tile). Use the variance to avoid visible repetition between branches.' }),

    // Break: the spine snaps and leaves an open end
    bk.float('breakChance', 'Chance', 0, { min: 0, max: 1, tooltip: 'Probability that a node breaks and ends in an open end (a Cap can close it).' }),
    bk.float('breakSpot', 'Spot', 0.68, { min: 0.02, max: 0.99, variance: 0.15, tooltip: 'Where along the spine the break happens (1 = at the tip).' }),
    bk.seed('breakSeed', 'Seed'),

    // Splits & Termination / Break
    tm.enumOf('termination', 'Tip behavior', 'Taper', ['Taper', 'Blunt', 'Broken', 'Fork']),
    tm.float('splitChance', 'Split chance', isRoot ? 0.3 : 0, { min: 0, max: 1 }),
    tm.float('splitSpread', 'Split spread', isRoot ? 30 : 25, { min: 2, max: 85, unit: '°' }),
    tm.float('splitBalance', 'Split balance', 0.5, { min: 0.15, max: 0.85 }),
    tm.float('splitStart', 'Split position', 0.58, { min: 0.15, max: 0.9 }),
    tm.int('splitMaxDepth', 'Max split depth', 1, { min: 1, max: 3 }),
  ];

  if (isRoot) {
    out.push(
      rt.float('rootSpread', 'Horizontal spread', 1.15, { min: 0.1, max: 3, softMax: 2 }),
      rt.float('rootDepth', 'Target depth', 1.5, { min: 0, max: 20, softMax: 5, unit: 'm' }),
      rt.float('rootDiveAngle', 'Dive angle', 42, { min: 0, max: 89, unit: '°' }),
      rt.float('surfaceHug', 'Surface hug', 0.28, { min: 0, max: 0.95 }),
      rt.float('flareBlend', 'Trunk flare blend', 0.65, { min: 0, max: 1 }),
    );
  } else if (!isTrunk) {
    out.push(
      pr.float('pruneInterior', 'Interior', 0, { min: 0, max: 1, curve: true, tooltip: 'Removes branches that grow towards the inside of the model. The curve scales it along the parent.' }),
      pr.float('pruneUp', 'Up', 0, { min: 0, max: 1, curve: true, tooltip: 'Removes branches that grow upwards (the steeper, the more likely).' }),
      pr.float('pruneDown', 'Down', 0, { min: 0, max: 1, curve: true, tooltip: 'Removes branches that grow downwards (the steeper, the more likely).' }),
      pr.float('pruneGeneral', 'General', 0, { min: 0, max: 1, curve: true, tooltip: 'Removes branches at random with this probability.' }),
      pr.float('pruneGround', 'Ground', 1, { min: 0, max: 1, curve: true, tooltip: 'Removes branches that intersect the ground plane (strength = probability).' }),
    );
  }

  if (opts.kind === 'branch') {
    const ex = section('Spine', 'Extensions');
    out.push(
      ex.float('extensionLengthScale', 'Length scale', 1, { min: 0.05, max: 8, softMax: 3, tooltip: 'Scales the spine length of the extensions made by this node (see Generation > Extend parent).' }),
      ex.float('extensionSpread', 'Spread', 15, {
        min: 0,
        max: 90,
        unit: '°',
        curve: true,
        tooltip: 'Separates extensions that share one open end (Count above 1). The curve sets how much of the spread applies along the length.',
      }),
    );
  }

  const rank = (p: ParamDef): number => {
    const i = SPINE_SECTION_ORDER.indexOf(p.subgroup ?? '');
    return i < 0 ? SPINE_SECTION_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Section order of the Spine tab. */
const SPINE_SECTION_ORDER = ['Length', 'Clamp', 'Orientation', 'Shape', 'Parent Curl', 'Zigzag', 'Segment length', 'Radius', 'Noise', 'Early', 'Late', 'Jink', 'Path', 'Break', 'Splits & Termination', 'Extensions', 'Prune', 'Root Growth'];

export function forcesParams(): ParamDef[] {
  const f = section('Forces', 'Forces');
  const i = section('Forces', 'Influence');
  return [
    f.bool('forcesEnabled', 'Enabled', true),
    i.float('forceInfluence', 'Influence', 1, { min: 0, max: 10, softMax: 2, curve: true }),
    i.float('forceStiffness', 'Stiffness', 0.5, { min: 0, max: 1, curve: true }),
    i.float('forceFalloff', 'Falloff', 0, { min: 0, max: 1 }),
  ];
}

export function shapeParams(defaultFlareRadius = 0, defaultFlareHeight = 0.14): ParamDef[] {
  const c = section('Shape', 'Cross section');
  const f = section('Shape', 'Flare');
  const b = section('Shape', 'Bulge');
  return [
    c.float('sectionAspect', 'Aspect', 1, { min: 0.1, max: 4, curve: true }),
    c.float('sectionRoundness', 'Roundness', 1, { min: 0, max: 1 }),
    c.enumOf('sectionShape', 'Profile', 'Round', ['Round', 'Ridged', 'Lobed', 'Noise']),
    c.int('sectionLobes', 'Lobes', 5, { min: 1, max: 32 }),
    c.float('sectionDepth', 'Depth', 0.12, { min: 0, max: 1 }),
    c.float('sectionSpiral', 'Spiral', 0, { min: -6, max: 6, unit: 'rad/m' }),
    c.float('sectionNoiseFrequency', 'Noise frequency', 2, { min: 0.1, max: 20 }),
    f.float('flareRadius', 'Radius', defaultFlareRadius, { min: 0, max: 5, softMax: 1.5, curve: true }),
    f.float('flareHeight', 'Height', defaultFlareHeight, { min: 0.01, max: 1 }),
    f.int('flareLobes', 'Buttress lobes', 5, { min: 0, max: 16 }),
    f.float('flareNoise', 'Noise', 0, { min: 0, max: 1 }),
    b.float('bulgeAmount', 'Amount', 0, { min: 0, max: 2, curve: true }),
    b.float('bulgeFrequency', 'Frequency', 1, { min: 0.1, max: 20 }),
  ];
}

/**
 * "Segments" tab of Trunk / Branch / Root / Spine: the exact resolution of the spine (Accuracy, Influence), the polygon count
 * (Scalar) and the final length / radial segment counts (`Absolute + Relative x basis`). `sides` keeps its id: it is the radial Absolute.
 */
export function segmentParams(kind: SpineDefaults['kind'], segments: number, sides: number): ParamDef[] {
  const g = section('Segments');
  const l = section('Segments', 'Length');
  const r = section('Segments', 'Radial');
  const isDefaultStyle = { param: 'lengthStyle', value: 'default' } as const;
  return [
    g.int('accuracy', 'Accuracy', kind === 'trunk' ? 36 : 24, {
      min: 4,
      max: 256,
      tooltip: 'Exact number of points of the high-resolution spine the branch is built from (higher = smoother, slower).',
    }),
    g.float('segmentInfluence', 'Influence', 1, {
      min: 0,
      max: 4,
      softMax: 2,
      tooltip: 'Scales how strongly forces and spine properties act per accurate segment. 1 keeps the shape when Accuracy changes.',
    }),
    g.float('segmentScalar', 'Scalar', 1, { min: 0.1, max: 4, softMax: 2, tooltip: 'Multiplies the polygon count of the mesh (length and radial segments).' }),
    l.enumOf('lengthStyle', 'Style', 'Default', ['Default', 'Legacy'], {
      tooltip: 'Default builds the accurate layout with the relative basis; Legacy keeps the older layout (relative segments per metre).',
    }),
    l.int('segments', 'Absolute', segments, { min: 1, max: 512, tooltip: 'Minimum number of length segments.' }),
    l.float('relativeSegments', '+ Relative', 0, { min: 0, max: 20, softMax: 2, tooltip: 'Adds more length segments, multiplied by the Relative basis.' }),
    l.enumOf('relativeBasis', 'Relative basis', 'Length/radius ratio', ['Length only', 'Length/radius ratio', "Parent's length segments"], {
      visibleIf: isDefaultStyle,
      tooltip: 'What + Relative is multiplied by: the branch length, its length / radius ratio (recommended) or the length segments of the parent.',
    }),
    l.float('weldScalar', 'Weld scalar', 1, { min: 0, max: 4, softMax: 2, tooltip: 'Scales the number of segments in the weld part, where the branch is fused to its parent.' }),
    l.float('optimization', 'Optimization', 0, {
      min: 0,
      max: 45,
      unit: '°',
      tooltip: 'Drops segments where the spine is nearly straight: the larger the value, the bigger the bend must be to keep a segment (0 = keep all).',
    }),
    r.int('sides', 'Absolute', sides, { min: 0, max: 64, tooltip: 'Minimum number of radial segments (sides).' }),
    r.float('radialRelative', '+ Relative', 0, { min: 0, max: 200, softMax: 40, tooltip: 'Adds radial segments, multiplied by the Relative basis.' }),
    r.enumOf('radialBasis', 'Relative basis', 'Radius', ['Radius', "Parent's radial segments"], {
      tooltip: 'What + Relative is multiplied by: the branch radius in metres or the radial segments of the parent.',
    }),
  ];
}

/**
 * Skin > Welding (Branch, Root): fuses the base of a child into the surface of its parent. Weld scalar (the number of rings
 * of the fused part) lives in Segments > Length.
 */
export function weldingParams(): ParamDef[] {
  const w = section('Skin', 'Welding');
  const sp = section('Skin', 'Spread');
  const bl = section('Skin', 'Blend');
  const on = { param: 'weldEnabled', value: true } as const;
  const blendOn: Condition = { all: [on, { param: 'weldBlendEnabled', value: true }] };
  return [
    w.bool('weldEnabled', 'Enabled', false, {
      tooltip: 'Pushes the base of the branch out of its parent and fuses it to the parent surface, for a seamless union without a visible seam.',
    }),
    w.curve('weldKeep', 'Keep', flatCurve(1), {
      visibleIf: on,
      tooltip: 'Runs over the height of the model (left = bottom, right = top). Welds are dropped where the curve is below 0.5: the branch then starts on the parent spine without fusing.',
    }),
    w.bool('weldKeepFailed', 'Keep failed', false, {
      visibleIf: on,
      tooltip: 'Keeps branches whose weld failed (they are drawn without fusing) instead of removing them. Useful to find the failures.',
    }),
    w.bool('weldForceRays', 'Force ray casts', false, {
      visibleIf: on,
      tooltip: 'Casts rays against the real parent tube (curved and tapered along its whole spine) instead of the procedural cone at the attachment: better on strongly bent parents, but more welds fail.',
    }),
    w.float('weldOffset', 'Offset', 1.5, {
      min: 0,
      max: 10,
      softMax: 4,
      visibleIf: on,
      tooltip: 'How far (in branch radii) the branch is pushed out of the parent surface before it is welded back: the length of the weld part.',
    }),
    sp.float('weldSpreadAmount', 'Amount', 0.3, {
      min: 0,
      max: 2,
      softMax: 1,
      visibleIf: on,
      tooltip: 'How much the base of the branch widens at the weld site (fraction of its radius).',
    }),
    sp.float('weldSpreadUpper', 'Upper scale', 0.2, {
      min: 0,
      max: 2,
      softMax: 1,
      visibleIf: on,
      tooltip: 'Extra widening on the side of the base facing the tip of the parent, which forms a web where the branches meet.',
    }),
    sp.float('weldSpreadLower', 'Lower scale', 0.1, {
      min: 0,
      max: 2,
      softMax: 1,
      visibleIf: on,
      tooltip: 'Extra widening on the side of the base facing the base of the parent.',
    }),
    bl.bool('weldBlendEnabled', 'Enabled', true, {
      visibleIf: on,
      tooltip: 'Fades the bark texture of the child into the texture of the parent around the weld. Needs a bark material with a Color map.',
    }),
    bl.float('weldBlendTexture', 'Texture', 1, {
      min: 0,
      max: 10,
      softMax: 4,
      visibleIf: blendOn,
      tooltip: 'Pulls the blended region further up the child (in branch radii); 0 ends the blend where the weld ends.',
    }),
    bl.float('weldBlendTextureScale', 'Texture scale', 1, {
      min: 0.1,
      max: 10,
      softMax: 4,
      visibleIf: blendOn,
      tooltip: 'Size of the parent map inside the blended region (above 1 = finer pattern).',
    }),
    bl.float('weldBlendContrast', 'Contrast', 0.35, {
      min: 0,
      max: 1,
      visibleIf: blendOn,
      tooltip: 'Harshness of the blend: 0 is a soft fade, 1 a sharp edge between the two textures.',
    }),
    bl.float('weldBlendNoise', 'Noise', 0.3, {
      min: 0,
      max: 1,
      visibleIf: blendOn,
      tooltip: 'Wave noise around the child so the blend line is not a uniform ring.',
    }),
    bl.curve('weldBlendLighting', 'Lighting', flatCurve(0.5), {
      visibleIf: blendOn,
      tooltip: 'Normals in the weld region, from the parent side (left) to the child (right). At the bottom of the curve they follow the spine direction, at the top they point outward from the spine; the middle leaves them unchanged.',
    }),
  ];
}

/** Spine-level Skin > Radius options: `trunk` has no parent, `child` also gets the parent-relative ones. */
export type SkinRadiusKind = 'none' | 'trunk' | 'child';

/** Skin > Radius, Clamp, Squash and Type & Visibility (the generator-level radius options only when `radius` is not `none`). */
function skinShapeParams(radius: SkinRadiusKind, defaultSpineOnly: boolean): ParamDef[] {
  const ty = section('Skin', 'Type & Visibility');
  const r = section('Skin', 'Radius');
  const cl = section('Skin', 'Clamp');
  const sq = section('Skin', 'Squash');
  const squashed = { param: 'squashAmount', op: 'gt', value: 0 } as const;
  const skinType = ty.enumOf('skinType', 'Type', defaultSpineOnly ? 'Spine only' : 'Polygons', ['Polygons', 'Spine only', 'SubD surface (rectangular attachments)', 'SubD surface (arbitrary attachments)'], {
    tooltip: 'Polygons builds the tube mesh. Spine only builds no mesh: the spine stays available for children such as fronds and leaves. The SubD surface types are not available yet.',
  });
  if (skinType.kind === 'enum') skinType.options = skinType.options.map((o) => (o.value.startsWith('subd-') ? { ...o, label: `${o.label} (not yet available)`, disabled: true } : o));
  return [
    skinType,
    // Legacy switch of older projects and scripts (migrated to Type; never shown, still honoured).
    ty.bool('spineOnly', 'Spine only', false, { visibleIf: { param: 'skinType', value: '__legacy' }, tooltip: 'Legacy switch: use Type instead.' }),
    ty.curve('skinVisibility', 'Visibility', flatCurve(1), {
      tooltip: 'Runs along the parent (left = base, right = tip). Branches that grow where the curve is above 0.5 get geometry, the others stay invisible but keep their children.',
    }),
    ...(radius !== 'none'
      ? [
          r.float('skinRadiusAbsolute', 'Absolute', 0, { min: 0, max: 10, softMax: 0.5, unit: 'm', tooltip: 'Radius in metres added to the base radius of every branch.' }),
          ...(radius === 'child'
            ? [
                r.float('skinRadiusPercent', '+ % of parent', 0, { min: 0, max: 2, softMax: 1, tooltip: 'Adds this fraction of the parent radius at the attachment to the base radius.' }),
                r.bool('skinRadiusClampParent', 'Clamp to parent', false, { tooltip: 'A branch never gets thicker than its parent at the attachment.' }),
              ]
            : []),
          r.float('skinLengthCompensation', 'Length compensation', 0, { min: 0, max: 1, tooltip: 'Enlarges the tip radius of branches that thin out to a point too fast: 1 keeps up to half of the base radius at the tip.' }),
          r.float('skinLengthKill', 'Length kill ratio', 0, { min: 0, max: 10000, softMax: 500, tooltip: 'Removes branches whose length divided by radius is above this value (very long, thin whips). 0 = off.' }),
        ]
      : []),
    r.float('seamReduction', 'Light seam reduction', 0, {
      min: 0,
      max: 1,
      tooltip: 'Bends the normals toward the spine direction, strongest at the base of a branch where lighting seams show at the junction.',
    }),
    r.float('skinRoll', 'Roll', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotates the skin around the spine without changing its shape (rotates the section, the squash and the texture).' }),
    r.float('skinSmooth', 'Smooth', 0, { min: 0, max: 1, tooltip: 'Pushes the vertices out on the inner side of bends so the tube does not pinch.' }),
    ...(radius !== 'none'
      ? [
          cl.float('skinRadiusMin', 'Min', 0, { min: 0, max: 10, softMax: 0.05, unit: 'm', tooltip: 'Smallest radius of any point. 0 = off.' }),
          cl.float('skinRadiusMax', 'Max', 0, { min: 0, max: 10, softMax: 1, unit: 'm', tooltip: 'Largest radius of any point. 0 = off.' }),
        ]
      : []),
    sq.float('squashAmount', 'Amount', 0, { min: 0, max: 1, tooltip: 'Reduces the radius on one side: the section becomes an ellipse (1 = flat). Welds follow the squashed profile.' }),
    sq.float('squashRotate', 'Rotate', 0, { min: -180, max: 180, unit: '°', visibleIf: squashed, tooltip: 'Direction of the flattened side around the spine.' }),
  ];
}

/**
 * Skin tab. `sides` adds the `Sides` row for nodes without a Segments tab (Cap); `welding` adds the Welding section;
 * `radius` adds the generator-level Radius / Clamp options.
 */
/** Skin > Splits: the branch ends in two fused open ends (Extend parent / Cap continue them). */
export function splitParams(): ParamDef[] {
  const s = section('Skin', 'Splits');
  const sp = section('Skin', 'Split spread');
  const ex = section('Skin', 'Split expand');
  const sm = section('Skin', 'Split smooth');
  return [
    s.float('splitsChance', 'Chance', 0, {
      min: 0,
      max: 1,
      tooltip: 'Probability that the branch divides into two open ends at its tip. Needs a bark texture with at least two U tiles around the tube.',
    }),
    s.float('splitsBalance', 'Balance', 0.5, { min: 0, max: 1, tooltip: '0.5 gives both sides the same radius; lower or higher moves radius from Side 1 to Side 2 (the cross-section area is kept).' }),
    s.seed('splitsSeed', 'Seed'),
    sp.float('splitsSpread1', 'Side 1', 25, { min: 0, max: 85, unit: '°', tooltip: 'Angle of Side 1 away from the centre of the tree.' }),
    sp.float('splitsSpread2', 'Side 2', 25, { min: 0, max: 85, unit: '°', tooltip: 'Angle of Side 2 toward the centre of the tree.' }),
    ex.float('splitsExpand1', 'Side 1', 1, { min: 0.25, max: 3, tooltip: 'Scales the cross-section of Side 1 from its default (1).' }),
    ex.float('splitsExpand2', 'Side 2', 1, { min: 0.25, max: 3, tooltip: 'Scales the cross-section of Side 2 from its default (1).' }),
    sm.float('splitsSmoothInner', 'Inner', 0.25, { min: 0, max: 1, tooltip: '0 = hard crease between the two sides, 1 = no crease.' }),
    sm.float('splitsSmoothOuter', 'Outer', 0.5, { min: 0, max: 1, tooltip: 'Smoothness of the outer bend where the split occurs (0 = hard corner).' }),
  ];
}

/** Skin > Extensions (Branch only): how the extensions made by this node blend into their parent. */
function extensionSkinParams(): ParamDef[] {
  const ex = section('Skin', 'Extensions');
  return [
    ex.float('extensionRadius', 'Radius', 1, {
      min: 0,
      max: 1,
      curve: true,
      tooltip: 'How much of the profile curve is used. The curve is the radius along the extension relative to the radius the branch would have there (it starts at the parent radius).',
    }),
    ex.float('extensionNormalSmooth', 'Normal smooth', 0.5, { min: 0, max: 1, tooltip: 'Smooths the normals at the base of extensions to hide seams between several extensions.' }),
    ex.float('extensionDisplaceScale', 'Displacement scale', 1, { min: 0, max: 8, softMax: 3, tooltip: 'Scales the displacement on the extensions made by this node.' }),
  ];
}

export function skinParams(defaultSpineOnly = false, sides?: number, welding = false, radius: SkinRadiusKind = 'none', extensions = false): ParamDef[] {
  const g = section('Skin', 'Geometry');
  const n = section('Skin', 'Normals');
  const c = section('Skin', 'Vertex color');
  const j = section('Skin', 'Junction');
  return [
    ...skinShapeParams(radius, defaultSpineOnly),
    ...(radius !== 'none' ? splitParams() : []),
    ...(extensions ? extensionSkinParams() : []),
    ...(sides !== undefined ? [g.int('sides', 'Sides', sides, { min: 3, max: 64 })] : []),
    g.bool('capEnd', 'Close end', true),
    g.int('tipRings', 'Tip rings', 2, { min: 1, max: 8, tooltip: 'Rings of the rounded tip cap.' }),
    g.enumOf('capBase', 'Close base', 'Auto', ['Auto', 'Yes', 'No'], { tooltip: 'Auto closes branches that do not grow from a parent.' }),
    g.float('skinTwist', 'Twist', 0, { min: -720, max: 720, unit: '°/m' }),
    j.float('collarAmount', 'Collar', 0.3, { min: 0, max: 2, tooltip: 'Radius flare where a branch leaves its parent.' }),
    j.float('collarLength', 'Collar length', 1.5, { min: 0.1, max: 10, tooltip: 'Length of the flare in branch radii.' }),
    ...(welding ? weldingParams() : []),
    n.float('smoothing', 'Smoothing', 1, { min: 0, max: 1, tooltip: 'Below 0.5 the tube is faceted (unwelded quads).' }),
    n.float('flatten', 'Flatten', 0, { min: 0, max: 1 }),
    c.color('tint', 'Tint', [0.36, 0.26, 0.18, 1]),
    c.float('tintVariance', 'Variance', 0.1, { min: 0, max: 1 }),
    c.float('aoStrength', 'AO strength', 0.6, { min: 0, max: 1 }),
  ];
}

export function uvParams(extensions = false): ParamDef[] {
  const m = section('UV', 'Mapping');
  const t = section('UV', 'Tiling');
  const ex = section('UV', 'Extensions');
  return [
    ...(extensions
      ? [
          ex.enumOf('extensionUvStyle', 'Extension style', 'Automatic', ['Automatic', 'Manual (match)', 'Manual (match u only)', 'Manual (full control)'], {
            tooltip: 'How the texture coordinates of extensions follow their parent. Extensions always continue the parent mapping; the manual styles arrive with the UV mapping update and map as Automatic for now.',
          }),
        ]
      : []),
    m.enumOf('uvMode', 'Mode', 'Metric', ['Metric', 'Normalized']),
    m.bool('uvRotate', 'Rotate 90°', false),
    t.float('uvScaleU', 'U scale', 1, { min: 0.01, max: 100, softMax: 10 }),
    t.float('uvScaleV', 'V scale', 1, { min: 0.01, max: 100, softMax: 10 }),
    t.float('uvOffsetU', 'U offset', 0, { min: -10, max: 10 }),
    t.float('uvOffsetV', 'V offset', 0, { min: -10, max: 10 }),
  ];
}

export function lodParams(): ParamDef[] {
  const r = section('LOD', 'Reduction');
  const d = section('LOD', 'Distance');
  return [
    r.float('lodSides', 'Side reduction', 0.5, { min: 0, max: 1 }),
    r.float('lodSegments', 'Segment reduction', 0.5, { min: 0, max: 1 }),
    r.float('lodCull', 'Cull amount', 0, { min: 0, max: 1 }),
    d.float('lodFadeStart', 'Fade start', 0.5, { min: 0, max: 1 }),
    d.float('lodFadeEnd', 'Fade end', 1, { min: 0, max: 1 }),
  ];
}

export function displacementParams(): ParamDef[] {
  const d = section('Displacement', 'Displacement');
  const m = section('Displacement', 'Mapping');
  const f = section('Displacement', 'Fade');
  const sd = section('Displacement', 'Subdivision');
  const n = section('Displacement', 'Noise');
  const active = { param: 'displacement', op: 'ne', value: '' } as const;
  return [
    {
      kind: 'enum',
      id: 'displacement',
      label: 'Displacement',
      group: 'Displacement',
      subgroup: 'Displacement',
      default: '',
      options: [{ value: '', label: 'None' }],
      tooltip: 'Height map from the Displacements panel. A warning badge shows on the node when the map is missing or not loaded.',
    },
    d.bool('displaceEnabled', 'Enabled', true, { visibleIf: active }),
    d.float('displaceAmount', 'Amount', 0, { min: -5, max: 5, softMin: 0, softMax: 0.2, unit: 'm', curve: true, tooltip: 'Displacement in metres at full height. The curve scales it along the branch length.' }),
    d.float('displaceRadiusAmount', '+ % of radius', 0, { min: -1, max: 2, tooltip: 'Extra amount relative to the local radius (thick trunks get deeper bark).' }),
    d.float('displaceOffset', 'Offset', 0, { min: -1, max: 1, tooltip: 'Bias added to the height before scaling.' }),
    d.bool('displaceMidGrey', 'Mid-grey is neutral', true, { visibleIf: active, tooltip: 'On: 50% grey does not move the surface (both directions). Off: black = no displacement, white = full amount outward.' }),
    d.enumOf('displaceDirection', 'Direction', 'Normal', ['Normal', 'Radial'], { visibleIf: active }),
    m.enumOf('displaceTiling', 'Tiling', 'World', ['World', 'Normalized'], { visibleIf: active, tooltip: 'World: one image tile covers "Tile size" metres, no stretching on long or thick branches.' }),
    m.float('displaceTileSize', 'Tile size', 0.5, { min: 0.005, max: 50, softMax: 4, unit: 'm', visibleIf: active }),
    m.float('displaceScale', 'Scale', 1, { min: 0.01, max: 50, visibleIf: active }),
    m.float('displaceScaleU', 'Scale U', 1, { min: 0.01, max: 50, visibleIf: active }),
    m.float('displaceScaleV', 'Scale V', 1, { min: 0.01, max: 50, visibleIf: active }),
    m.float('displaceRotation', 'Rotation', 0, { min: -360, max: 360, unit: '°', tooltip: 'Snapped to 90° steps while seams are locked.' }),
    m.bool('displaceLockSeams', 'Lock seams', true, { visibleIf: active, tooltip: 'Round the tiling around the trunk to a whole number so the U seam is continuous.' }),
    f.float('displaceFadeBase', 'Fade at junctions', 1.5, { min: 0, max: 10, tooltip: 'Fade-in length (in radii) where a branch leaves its parent: prevents cracks at junctions.' }),
    f.float('displaceFadeTip', 'Fade at tips', 1, { min: 0, max: 10, tooltip: 'Fade-out length (in radii) toward the tip / cap.' }),
    f.bool('displaceLodFade', 'LOD fade', true, { visibleIf: active, tooltip: 'Fade the amount out between LOD 1 and 3.' }),
    sd.bool('displaceAutoSubdivide', 'Auto-subdivide', true, { visibleIf: active, tooltip: 'Add rings and sides so the mesh has enough vertices to carry the height detail.' }),
    sd.float('displaceDetail', 'Detail size', 0.03, { min: 0.002, max: 1, softMax: 0.2, unit: 'm', tooltip: 'Target quad size when auto-subdividing (smaller = more detail, more triangles).' }),
    sd.int('displaceMinSides', 'Min sides', 16, { min: 3, max: 128, visibleIf: active }),
    n.float('displaceNoise', 'Noise', 0.5, { min: 0, max: 1 }),
    n.seed('displaceSeed', 'Seed'),
  ];
}

export function materialTabParams(): ParamDef[] {
  const m = section('Material', 'Material');
  const b = section('Material', 'Blend');
  return [
    { kind: 'enum', id: 'material', label: 'Material', group: 'Material', subgroup: 'Material', default: '', options: [{ value: '', label: 'None' }] },
    m.color('materialTint', 'Tint', [1, 1, 1, 1]),
    m.float('materialVariation', 'Variation', 0, { min: 0, max: 1, variance: 0 }),
    b.float('blendBase', 'Base blend', 0, { min: 0, max: 1, curve: true }),
    b.float('blendHeight', 'Height blend', 0, { min: 0, max: 1 }),
  ];
}

export function animationParams(): ParamDef[] {
  const h = section('Animation', 'Wind hierarchy');
  const a = section('Animation', 'Amount');
  return [
    h.enumOf('windHierarchy', 'Hierarchy', 'Branch 1', ['Trunk', 'Branch 1', 'Branch 2', 'Leaf']),
    a.float('windAmount', 'Amount', 1, { min: 0, max: 10, softMax: 2, curve: true }),
    a.float('windPhaseVariance', 'Phase variance', 0.5, { min: 0, max: 1 }),
  ];
}

export function handDrawnParams(): ParamDef[] {
  const h = section('Hand drawn', 'Hand drawn');
  return [
    h.bool('handDrawn', 'Enabled', false),
    h.float('handStrength', 'Strength', 1, { min: 0, max: 1 }),
    h.float('handSmoothing', 'Smoothing', 0.5, { min: 0, max: 1 }),
  ];
}

// ---- Hierarchy structure helpers (Split / Knot) ------------------------------------------------------------------

export function splitHelperParams(): ParamDef[] {
  const g = section('Generation', 'Fork');
  const s = section('Spine', 'Split Geometry');
  return [
    g.int('forkCount', 'Fork branches', 2, { min: 2, max: 5 }),
    g.float('splitAt', 'Position along parent', 1, { min: 0.1, max: 1 }),
    g.float('roll', 'Roll', 0, { min: -1, max: 1, variance: 0.2 }),
    g.bool('active', 'Active', true),
    g.seed('seed', 'Seed'),
    s.float('length', 'Length', 2.4, { min: 0.05, max: 100, softMax: 12, unit: 'm', variance: 0.12, curve: true }),
    s.float('lengthPercent', '+ % of parent', 0.35, { min: 0, max: 2, softMax: 1 }),
    s.float('spread', 'Fork angle', 28, { min: 2, max: 110, unit: '°', variance: 0.15 }),
    s.float('splitBalance', 'Balance', 0.5, { min: 0.15, max: 0.85 }),
    s.float('taper', 'Taper', 0.85, { min: 0, max: 1, curve: true }),
    s.int('segments', 'Segments', 10, { min: 2, max: 128 }),
    s.float('gravity', 'Gravity', 0.08, { min: -2, max: 2, curve: true }),
    s.float('noiseAmount', 'Gnarliness', 0.15, { min: 0, max: 3, curve: true }),
    s.float('noiseFrequency', 'Noise frequency', 1.2, { min: 0, max: 20 }),
    ...forcesParams(),
    ...skinParams(false, 8),
    ...uvParams(),
    ...materialTabParams(),
  ];
}

export function knotHelperParams(): ParamDef[] {
  const kn = section('Shape', 'Knot');
  return [
    ...generationParams({ number: 5, first: 0.18, last: 0.82, jumble: 0.35, includeBranchExtended: true }),
    kn.float('knotRadius', 'Outer size', 0.55, {
      min: 0.05,
      max: 2,
      variance: 0.2,
      curve: true,
      tooltip: 'Knot base radius as a fraction of parent branch radius.',
    }),
    kn.float('knotLength', 'Extrusion offset', 0.12, {
      min: 0.01,
      max: 2,
      softMax: 0.5,
      unit: 'm',
      variance: 0.25,
      curve: true,
    }),
    kn.float('knotCoreScale', 'Core scale', 0.65, { min: 0.1, max: 1.2 }),
    kn.float('knotCurvature', 'Curvature', 0.25, { min: -1, max: 1 }),
    kn.float('spread', 'Angle', 82, { min: 15, max: 165, unit: '°', variance: 0.1 }),
    kn.int('segments', 'Segments', 5, { min: 2, max: 32 }),
    ...skinParams(false, 8),
    ...uvParams(),
    ...materialTabParams(),
  ];
}

// ---- leaf-like generators -----------------------------------------------

export function leafSkinParams(): ParamDef[] {
  const g = section('Skin', 'Geometry');
  const s = section('Skin', 'Size');
  const c = section('Skin', 'Card');
  const a = section('Skin', 'Atlas');
  const cl = section('Generation', 'Cluster');
  return [
    cl.int('leavesPerNode', 'Leaves per node', 1, { min: 1, max: 16, tooltip: 'Leaves emitted at every placement (whorl / tuft).' }),
    cl.float('clusterAngle', 'Spread', 25, { min: 0, max: 180, unit: '°' }),
    g.enumOf('geometry', 'Geometry', 'Card', ['Card', 'Mesh']),
    g.bool('twoSided', 'Two-sided', true),
    s.float('width', 'Width', 0.3, { min: 0.001, max: 20, softMax: 2, unit: 'm', variance: 0.1, curve: true }),
    s.float('height', 'Height', 0.5, { min: 0.001, max: 20, softMax: 2, unit: 'm', variance: 0.1, curve: true }),
    c.enumOf('cardType', 'Type', 'Curved', ['Quad', 'Curved', 'Bent']),
    c.enumOf('outline', 'Outline', 'Rect', ['Rect', 'Oval', 'Pointed', 'Heart'], { tooltip: 'Blade outline of Mesh geometry (cards use the texture opacity).' }),
    c.int('cardCount', 'Cards per leaf', 1, { min: 1, max: 6, tooltip: '2 = crossed cards.' }),
    c.int('leafSegments', 'Length segments', 4, { min: 1, max: 24 }),
    c.int('leafWidthSegments', 'Width segments', 1, { min: 1, max: 12 }),
    c.float('leafBend', 'Bend', 0.35, { min: -1, max: 1, variance: 0.2, curve: true }),
    c.float('leafFold', 'Fold', 0, { min: -1, max: 1, curve: true }),
    c.float('leafCurl', 'Curl', 0, { min: -1, max: 1, curve: true }),
    c.float('leafTwist', 'Twist', 0, { min: -1, max: 1, variance: 0.2 }),
    a.int('atlasColumns', 'Columns', 1, { min: 1, max: 16 }),
    a.int('atlasRows', 'Rows', 1, { min: 1, max: 16 }),
    a.enumOf('atlasMode', 'Cell', 'Random', ['Random', 'Sequential', 'Fixed']),
    a.int('atlasCell', 'Fixed cell', 0, { min: 0, max: 255 }),
  ];
}

export function orientationParams(): ParamDef[] {
  const f = section('Orientation', 'Facing');
  const r = section('Orientation', 'Rotation');
  const d = section('Orientation', 'Droop');
  return [
    f.enumOf('facing', 'Facing', 'Parent', ['Parent', 'Up', 'Outward', 'Sun']),
    f.float('facingBlend', 'Blend', 0.5, { min: 0, max: 1, curve: true }),
    f.float('angleToParent', 'Angle to parent', 55, { min: 0, max: 180, unit: '°', variance: 0.15, curve: true }),
    r.float('pitch', 'Pitch', 0, { min: -180, max: 180, unit: '°', variance: 0.1, curve: true }),
    r.float('yaw', 'Yaw', 0, { min: -180, max: 180, unit: '°', variance: 0.1, curve: true }),
    r.float('rollAngle', 'Roll', 0, { min: -180, max: 180, unit: '°', variance: 0.1, curve: true }),
    d.float('droopAmount', 'Amount', 0.2, { min: 0, max: 1, curve: true }),
    d.float('droopStiffness', 'Stiffness', 0.5, { min: 0, max: 1 }),
  ];
}

/**
 * Repeatable Material / Mesh / Weight rows (rendered by the `MaterialSlotList` widget). Generators read it through
 * `readMaterialSlots` + `pickMaterialMesh` (materials/meshSelection.ts).
 */
export function materialSlotList(id: string, label: string, group: string, subgroup: string, defaultMaterial: string): ListParamDef {
  return {
    kind: 'list',
    widget: 'materialSlots',
    id,
    label,
    group,
    subgroup,
    minItems: 1,
    maxItems: 32,
    default: [{ material: defaultMaterial, mesh: 'any', weight: 1 }],
    fields: [
      { kind: 'enum', id: 'material', label: 'Material', group: 'Material', default: defaultMaterial, options: [{ value: '', label: 'None' }] },
      { kind: 'enum', id: 'mesh', label: 'Mesh', group: 'Material', default: 'any', options: [{ value: 'any', label: 'Any' }] },
      { kind: 'float', id: 'weight', label: 'Weight', group: 'Material', default: 1, min: 0, max: 100, softMax: 10 },
    ],
  };
}

/** Reference: Material tab "Leaves > Type" list (Material / Mesh / Weight) + "Season" (+ "Fallen"), "Vertex Color", "Lightmap". */
export function leafMaterialParams(): ParamDef[] {
  const type = materialSlotList('leafTypes', 'Type', 'Material', 'Leaves', '');
  const s = section('Material', 'Season');
  const f = section('Material', 'Fallen');
  const v = section('Material', 'Vertex Color');
  const l = section('Material', 'Lightmap');
  return [
    type,
    s.float('seasonStartOffset', 'Start offset', 0, { min: -1, max: 1, softMin: -1, softMax: 1, curve: true }),
    s.float('seasonTimeScale', 'Time scale', 1, { min: 0, max: 10, softMax: 2, curve: true }),
    s.float('seasonDropTime', 'Drop time', 1, { min: 0, max: 1, variance: 0.1, curve: true }),
    s.float('seasonDroop', 'Droop', 0.1, { min: 0, max: 1, curve: true }),
    s.float('seasonSize', 'Size', 0, { min: -1, max: 1, curve: true }),
    s.float('seasonCurl', 'Curl', 0, { min: -1, max: 1, curve: true }),
    s.float('seasonFold', 'Fold', 0, { min: -1, max: 1, curve: true }),
    f.float('fallenGroundDuration', 'Ground duration', 0.5, { min: 0, max: 1, curve: true }),
    f.float('fallenSpread', 'Spread', 0.2, { min: 0, max: 5, curve: true }),
    f.float('fallenFlatten', 'Flatten', 0.5, { min: 0, max: 1, curve: true }),
    f.float('fallenJumble', 'Jumble', 0.1, { min: 0, max: 1, variance: 0.1, curve: true }),
    f.float('fallenSlopeLimit', 'Slope limit', 0.5, { min: 0, max: 1, curve: true }),
    v.color('vertexColor', 'Color', [1, 1, 1, 1]),
    v.float('vertexColorVariance', 'Variance', 0.1, { min: 0, max: 1 }),
    v.float('vertexColorGradient', 'Gradient', 0, { min: -1, max: 1 }),
    l.bool('lightmap', 'Enabled', false),
    l.int('lightmapResolution', 'Resolution', 64, { min: 4, max: 4096 }),
  ];
}

/** Leaf "Lighting" tab: ambient occlusion. The normal-editing groups live in leafLightingParams.ts. */
export function lightingParams(): ParamDef[] {
  const a = section('Lighting', 'Ambient occlusion');
  return [
    a.float('aoStrength', 'Strength', 0.5, { min: 0, max: 1, curve: true }),
    a.float('aoDepth', 'Depth', 0.5, { min: 0, max: 1 }),
  ];
}

export function leafWindParams(): ParamDef[] {
  const w = section('Wind', 'Wind');
  const f = section('Wind', 'Flutter');
  return [
    w.enumOf('windGroup', 'Hierarchy', 'Leaf', ['Branch 1', 'Branch 2', 'Leaf']),
    w.float('windAmount', 'Amount', 1, { min: 0, max: 10, softMax: 2, curve: true }),
    f.float('flutterAmount', 'Amount', 0.5, { min: 0, max: 5, curve: true }),
    f.float('flutterFrequency', 'Frequency', 1, { min: 0, max: 20 }),
  ];
}

export function postParams(): ParamDef[] {
  const s = section('Post', 'Scale');
  const o = section('Post', 'Offset');
  return [
    s.float('postScale', 'Scale', 1, { min: 0.001, max: 100, softMax: 5, variance: 0, curve: true }),
    o.vec3('postOffset', 'Offset', [0, 0, 0], { step: 0.01 }),
    o.float('postRotate', 'Rotate', 0, { min: -180, max: 180, unit: '°' }),
  ];
}

export function capParams(): ParamDef[] {
  const s = section('Shape', 'Cap');
  return [
    s.float('capRadiusScale', 'Radius scale', 1, { min: 0, max: 4, curve: true }),
    s.float('capThickness', 'Thickness', 0.01, { min: 0, max: 1, unit: 'm' }),
    s.int('capRings', 'Rings', 2, { min: 1, max: 16 }),
  ];
}

export function clusterParams(): ParamDef[] {
  const c = section('Skin', 'Cluster');
  const sh = section('Skin', 'Shape');
  return [
    c.int('clusterCount', 'Count', 5, { min: 1, max: 256, variance: 0.1 }),
    c.float('clusterRadius', 'Radius', 0.1, { min: 0, max: 5, unit: 'm', curve: true }),
    c.float('clusterSize', 'Item size', 0.04, { min: 0.001, max: 2, unit: 'm', variance: 0.2 }),
    sh.enumOf('clusterShape', 'Shape', 'Sphere', ['Sphere', 'Cone', 'Cross', 'Quad', 'Flower card', 'Asset']),
    {
      kind: 'asset',
      id: 'clusterAsset',
      label: 'Mesh asset',
      group: 'Skin',
      subgroup: 'Shape',
      assetKind: 'mesh',
      default: null,
      visibleIf: { param: 'clusterShape', value: 'asset' },
    },
    sh.float('clusterDroop', 'Hang', 0.7, { min: 0, max: 1 }),
  ];
}

/** Parameters of the Mesh (instance) generator. */
export function meshGeneratorParams(): ParamDef[] {
  const s = section('Skin', 'Source');
  const t = section('Skin', 'Transform');
  const i = section('Skin', 'Instancing');
  const c = section('Skin', 'Color');
  return [
    s.enumOf('primitive', 'Mesh', 'Cone', ['Quad', 'Cross', 'Cone', 'Sphere', 'Flower card', 'Asset']),
    {
      kind: 'asset',
      id: 'meshAsset',
      label: 'Asset',
      group: 'Skin',
      subgroup: 'Source',
      assetKind: 'mesh',
      default: null,
      visibleIf: { param: 'primitive', value: 'asset' },
    },
    materialSlotList('meshTypes', 'Material', 'Skin', 'Source', 'leaf'),
    t.float('meshScale', 'Scale', 0.2, { min: 0.001, max: 50, softMax: 2, unit: 'm', variance: 0.2, curve: true }),
    t.enumOf('meshDirection', 'Direction', 'Outward', ['Outward', 'Parent', 'Up', 'Down']),
    t.float('meshAngle', 'Angle to parent', 50, { min: 0, max: 180, unit: '°', variance: 0.1, curve: true }),
    t.float('meshYaw', 'Random yaw', 0, { min: 0, max: 1 }),
    t.float('meshRoll', 'Roll', 0, { min: -180, max: 180, unit: '°', variance: 0.1 }),
    t.float('meshOffset', 'Offset', 0, { min: -2, max: 2, unit: 'm' }),
    i.bool('gpuInstancing', 'GPU instancing', false, { tooltip: 'Draw one geometry copy with instance matrices (viewport); exporters expand it.' }),
    c.color('meshTint', 'Tint', [1, 1, 1, 1]),
    c.float('meshTintVariance', 'Variance', 0.1, { min: 0, max: 1 }),
  ];
}
