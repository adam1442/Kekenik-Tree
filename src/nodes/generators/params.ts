import { flatCurve } from '@/contracts/curve';
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
}

/** "Generation" tab - shared by every generator, with full distribution modes on Branch/Root/Spine. */
export function generationParams(d: GenerationDefaults): ParamDef[] {
  const g = section('Generation', 'Generation');
  const a = section('Generation', 'Absolute');
  const dn = section('Generation', 'Density');
  const pr = section('Generation', 'Proportional');
  const iv = section('Generation', 'Interval');
  const ph = section('Generation', 'Phyllotaxy');
  const wh = section('Generation', 'Whorled');
  const bf = section('Generation', 'Bifurcation');
  const b = section('Generation', 'Boundaries');
  const ex = section('Generation', 'Extend parent');
  const ko = section('Generation', 'Knockout & Limits');
  const c = section('Generation', 'Common');
  const tp = section('Generation', 'Tree placement');

  const countDriven: Condition = {
    param: 'mode',
    op: 'in',
    value: ['absolute', 'phyllotaxy', 'bifurcation', 'flood'],
  };
  const densityDriven = { param: 'mode', value: 'density' } as const;
  const proportionalDriven = { param: 'mode', value: 'proportional' } as const;
  const intervalDriven = { param: 'mode', value: 'interval' } as const;
  const phyllotaxyDriven = { param: 'mode', value: 'phyllotaxy' } as const;
  const whorledDriven = { param: 'mode', value: 'whorled' } as const;
  const bifurcationDriven = { param: 'mode', value: 'bifurcation' } as const;
  const extendActive = { param: 'extendParent', op: 'ne', value: 'none' } as const;

  const modes = d.includeBranchExtended
    ? ['Absolute', 'Density', 'Proportional', 'Interval', 'Phyllotaxy', 'Whorled', 'Bifurcation', 'Flood']
    : ['Absolute', 'Density'];

  const list: ParamDef[] = [
    g.enumOf('mode', 'Mode', 'Absolute', modes),

    // Absolute / count-driven controls
    a.int('number', 'Number', d.number, { min: 0, max: 100000, softMax: 100, warnAbove: 1000, variance: 0, curve: true, visibleIf: countDriven }),
    a.float('jumble', 'Jumble', d.jumble ?? 0, { min: 0, max: 1, curve: true }),
    a.float('sweep', 'Sweep', 1, { min: 0.01, max: 1, softMax: 1, curve: true }),
    a.float('roll', 'Roll', 0, { min: -1, max: 1, curve: true }),
    a.float('favorSplits', 'Favor splits', 0, { min: -1, max: 1, curve: true, visibleIf: countDriven }),
    a.enumOf('alignStyle', 'Align style', 'Group', ['Group', 'Individual', 'Spiral', 'Alternate', 'Opposite']),
    a.bool('align', 'Align', false),

    // Density mode controls
    dn.float('density', 'Density', 1.5, { min: 0, max: 100, softMax: 10, unit: '/m', curve: true, visibleIf: densityDriven }),
    dn.float('densityJitter', 'Jitter', 0.2, { min: 0, max: 1, visibleIf: densityDriven }),
  ];

  if (d.includeBranchExtended) {
    list.push(
      // Proportional mode
      pr.float('proportionalCount', 'Steps per meter', 2.5, { min: 0, max: 50, softMax: 10, visibleIf: proportionalDriven }),

      // Interval mode
      iv.float('intervalStep', 'Interval', 0.6, { min: 0.02, max: 20, softMax: 3, unit: 'm', visibleIf: intervalDriven }),
      iv.int('perStep', 'Per step', 1, { min: 1, max: 16, visibleIf: intervalDriven }),

      // Phyllotaxy (Golden angle) mode
      ph.float('phyllotaxyAngle', 'Divergence angle', 137.508, { min: 0, max: 360, unit: '°', visibleIf: phyllotaxyDriven }),

      // Whorled (conifer steps) mode
      wh.int('whorlCount', 'Whorls', 5, { min: 1, max: 128, visibleIf: whorledDriven }),
      wh.int('whorlPerStep', 'Per whorl', 4, { min: 1, max: 128, softMax: 24, visibleIf: whorledDriven }),
      wh.float('whorlSpread', 'Whorl spread', 0.03, { min: 0, max: 0.5, visibleIf: whorledDriven }),
      wh.float('whorlRoll', 'Step roll', 15, { min: -180, max: 180, unit: '°', visibleIf: whorledDriven }),

      // Bifurcation (bend junction) mode
      bf.float('bifurcationThreshold', 'Bend threshold', 6, { min: 0.5, max: 90, unit: '°', visibleIf: bifurcationDriven }),
      bf.float('bifurcationSpacing', 'Min spacing', 0.12, { min: 0.01, max: 0.9, visibleIf: bifurcationDriven }),
    );
  }

  // Boundaries
  list.push(
    b.float('first', 'First', d.first, { min: 0, max: 1, curve: true }),
    b.float('last', 'Last', d.last, { min: 0, max: 1, curve: true }),
    b.curve('distributionCurve', 'Distribution curve', getCurvePreset('linear'), {
      tooltip: 'Maps normalized spacing [0..1] across [First..Last].',
    }),
    b.float('clip', 'Clip', 0.025, { min: 0, max: 0.49, curve: true }),
    b.bool('clipEnabled', 'Clip enabled', false),
  );

  if (d.includeBranchExtended) {
    list.push(
      ex.enumOf('extendParent', 'Type', 'None', ['None', 'Any', 'Split 1', 'Split 2']),
      ex.int('extendCount', 'Count', 1, { min: 1, max: 8, visibleIf: extendActive }),
      ko.float('knockout', 'Knockout', 0, { min: 0, max: 1, curve: true }),
      ko.float('pruning', 'Pruning', 0, { min: 0, max: 1, curve: true }),
      ko.int('generations', 'Sub-generations', 1, {
        min: 1,
        max: 5,
        tooltip: 'Recursive branching levels evaluated inside this generator (1 = single level).',
      }),
      ko.int('maxGeneration', 'Max generation', 8, {
        min: 1,
        max: 16,
        tooltip: 'Maximum hierarchy generation depth allowed for branches.',
      }),
    );
  }

  // Common
  list.push(
    c.float('rotationOffset', 'Rotation', 0, { min: -180, max: 180, unit: '°', variance: 0 }),
    c.float('positionOffset', 'Position', 0, { min: -0.5, max: 0.5, variance: 0 }),
    c.float('sink', 'Sink', 0, { min: -5, max: 5, softMin: -1, softMax: 1, unit: 'm', variance: 0, tooltip: 'How deep the base is sunk into the ground (+ variance for placed instances).' }),
    c.bool('active', 'Active', true, { curve: true }),
    c.seed('seed', 'Seed'),
  );

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
  const n = section('Spine', 'Noise');
  const tm = section('Spine', 'Splits & Termination');
  const pr = section('Spine', 'Prune');
  const rt = section('Spine', 'Root Growth');
  const cl = section('Spine', 'Clamp');
  const pc = section('Spine', 'Parent Curl');
  const zz = section('Spine', 'Zigzag');
  const crownCurveVisible = { param: 'crownShape', value: 'custom' } as const;

  const out: ParamDef[] = [
    // Length
    l.float('length', 'Absolute', opts.length, { min: 0.02, max: 500, softMax: isTrunk ? 40 : 20, unit: 'm', variance: 0.1, curve: true }),
    l.bool('lengthRelative', 'Relative to parent', false),
    l.float('lengthPercent', '+ % of parent', isTrunk ? 0 : 0.08, { min: 0, max: 2, softMax: 1, curve: true }),
    l.float('lengthPercentRadius', '+ % of radius', 0, { min: 0, max: 500, softMax: 100, tooltip: 'Adds this many parent radii to the length.' }),
    l.enumOf('matchOneVTile', 'Match one v tile', 'Generated', ['Generated', 'Yes', 'No'], { tooltip: 'Yes: the bark texture is stretched so it tiles exactly once along the spine.' }),
    l.float('shapeScale', 'Shape scale', 1, { min: 0, max: 5, softMax: 2, tooltip: 'Multiplies curvature and noise amounts of the spine.' }),
    l.bool('lengthLimit', 'Limit length', false),
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

    // Segments & Adaptive Resampling
    s.int('segments', 'Absolute', opts.segments, { min: 2, max: 512, tooltip: 'Number of segments along the spine.' }),
    s.float('relativeSegments', '+ Relative', 0, { min: 0, max: 20, softMax: 4, unit: '/m' }),
    s.int('accuracy', 'Accuracy', isTrunk ? 36 : 24, { min: 8, max: 128 }),
    s.float('optimization', 'Optimization', 0, {
      min: 0,
      max: 30,
      unit: '°',
      tooltip: 'Curvature-aware adaptive simplification threshold (0 = keep all segments).',
    }),

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
    }),
    d.float('startRoll', 'Start roll', 0, { min: -180, max: 180, unit: '°', variance: 0, curve: true }),
    d.float('pitch', 'Pitch', 0, { min: -90, max: 90, unit: '°', variance: 0.1, curve: true }),
    d.float('spineRoll', 'Roll', 0, { min: -180, max: 180, unit: '°' }),
    d.float('alignment', 'Alignment', isTrunk ? 0 : 0.2, { min: 0, max: 1 }),
    d.float('upDown', 'Up / down', opts.upDown ?? (isTrunk ? 0.05 : isRoot ? -0.25 : 0.06), { min: -2, max: 2, softMin: -1, softMax: 1, curve: true }),
    ...(!isTrunk ? [d.bool('weldStart', 'Weld start', false)] : []),

    // Shape (Curvature, Gravity bend hook, Twist)
    sh.float('gravity', 'Gravity', opts.gravity ?? (isTrunk ? 0 : isRoot ? 0.2 : 0.16), { min: -2, max: 3, softMin: -1, softMax: 1.5, curve: true }),
    ...(!isTrunk ? [sh.float('ancestor', 'Ancestor', 0, { min: -1, max: 1, curve: true })] : []),
    sh.float('curvature', 'Curvature', isTrunk ? 0.03 : isRoot ? -0.12 : 0.06, { min: -2, max: 2, softMin: -1, softMax: 1, variance: 0.15, curve: true }),
    sh.float('straightness', 'Straightness', isTrunk ? 0.35 : 0.2, { min: 0, max: 1 }),
    sh.float('twist', 'Twist', 0, { min: -720, max: 720, softMin: -180, softMax: 180, unit: '°', variance: 0, curve: true }),

    // Parent curl: bends the spine relative to its parent's frame
    pc.float('curlUp', 'Up', 0, { min: -3, max: 3, softMin: -1, softMax: 1, tooltip: 'Curl toward the parent direction (up the parent).' }),
    pc.float('curlRight', 'Right', 0, { min: -3, max: 3, softMin: -1, softMax: 1, tooltip: 'Curl sideways relative to the parent.' }),
    pc.float('curlOut', 'Out', 0, { min: -3, max: 3, softMin: -1, softMax: 1, tooltip: 'Curl away from the parent axis (negative = toward it).' }),
    zz.float('zigzag', 'Intensity', 0, { min: 0, max: 3, softMax: 1, tooltip: 'Alternating bend at every segment (zig-zag stem).' }),

    // Noise / Gnarliness (Early + Late)
    n.float('earlyNoiseAmount', 'Early amount', isTrunk ? 0.05 : isRoot ? 0.16 : 0.08, { min: 0, max: 2, softMax: 0.8, curve: true }),
    n.float('earlyNoiseFrequency', 'Early turbulence', 1.2, { min: 0.05, max: 15, softMax: 5 }),
    n.float('noiseAmount', 'Amount', opts.noiseAmount ?? (isTrunk ? 0.18 : isRoot ? 0.28 : 0.2), { min: 0, max: 5, softMax: 1.5, curve: true }),
    n.float('noiseFrequency', 'Frequency', isRoot ? 1.6 : 1.1, { min: 0, max: 20, softMax: 6 }),
    n.float('noiseTwist', 'Twist', isTrunk ? 0.1 : 0, { min: -2, max: 2, softMin: -1, softMax: 1 }),
    n.float('noiseSmooth', 'Smooth', 0, { min: 0, max: 1 }),
    n.seed('noiseSeed', 'Noise seed'),

    // Splits & Termination / Break
    tm.enumOf('termination', 'Tip behavior', 'Taper', ['Taper', 'Blunt', 'Broken', 'Fork']),
    tm.float('splitChance', 'Split chance', isRoot ? 0.3 : 0, { min: 0, max: 1 }),
    tm.float('splitSpread', 'Split spread', isRoot ? 30 : 25, { min: 2, max: 85, unit: '°' }),
    tm.float('splitBalance', 'Split balance', 0.5, { min: 0.15, max: 0.85 }),
    tm.float('splitStart', 'Split position', 0.58, { min: 0.15, max: 0.9 }),
    tm.int('splitMaxDepth', 'Max split depth', 1, { min: 1, max: 3 }),
    tm.float('breakChance', 'Break chance', 0, { min: 0, max: 1 }),
    tm.float('breakSpot', 'Break spot', 0.68, { min: 0.1, max: 0.98, variance: 0.15 }),
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
      pr.float('pruneGeneral', 'General', 0, { min: 0, max: 1 }),
      pr.float('pruneInterior', 'Interior', 0, { min: 0, max: 1 }),
      pr.float('pruneUp', 'Up', 0, { min: 0, max: 1 }),
      pr.float('pruneDown', 'Down', 0, { min: 0, max: 1 }),
      pr.bool('pruneGround', 'Ground plane', true),
    );
  }

  const rank = (p: ParamDef): number => {
    const i = SPINE_SECTION_ORDER.indexOf(p.subgroup ?? '');
    return i < 0 ? SPINE_SECTION_ORDER.length : i;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Section order of the Spine tab. */
const SPINE_SECTION_ORDER = ['Length', 'Clamp', 'Orientation', 'Shape', 'Parent Curl', 'Zigzag', 'Segment length', 'Radius', 'Noise', 'Splits & Termination', 'Prune', 'Root Growth'];

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

export function skinParams(sides: number, defaultSpineOnly = false): ParamDef[] {
  const g = section('Skin', 'Geometry');
  const n = section('Skin', 'Normals');
  const c = section('Skin', 'Vertex color');
  const j = section('Skin', 'Junction');
  return [
    g.bool('spineOnly', 'Spine only', defaultSpineOnly, {
      tooltip: 'Emit pure skeleton spines without building polygon tube geometry.',
    }),
    g.int('sides', 'Sides', sides, { min: 3, max: 64 }),
    g.int('lengthSegments', 'Length segments', 0, { min: 0, max: 512, tooltip: '0 = use the Spine segments' }),
    g.bool('capEnd', 'Close end', true),
    g.int('tipRings', 'Tip rings', 2, { min: 1, max: 8, tooltip: 'Rings of the rounded tip cap.' }),
    g.enumOf('capBase', 'Close base', 'Auto', ['Auto', 'Yes', 'No'], { tooltip: 'Auto closes branches that do not grow from a parent.' }),
    g.float('skinTwist', 'Twist', 0, { min: -720, max: 720, unit: '°/m' }),
    j.float('collarAmount', 'Collar', 0.3, { min: 0, max: 2, tooltip: 'Radius flare where a branch leaves its parent.' }),
    j.float('collarLength', 'Collar length', 1.5, { min: 0.1, max: 10, tooltip: 'Length of the flare in branch radii.' }),
    n.float('smoothing', 'Smoothing', 1, { min: 0, max: 1, tooltip: 'Below 0.5 the tube is faceted (unwelded quads).' }),
    n.float('flatten', 'Flatten', 0, { min: 0, max: 1 }),
    c.color('tint', 'Tint', [0.36, 0.26, 0.18, 1]),
    c.float('tintVariance', 'Variance', 0.1, { min: 0, max: 1 }),
    c.float('aoStrength', 'AO strength', 0.6, { min: 0, max: 1 }),
  ];
}

export function uvParams(): ParamDef[] {
  const m = section('UV', 'Mapping');
  const t = section('UV', 'Tiling');
  return [
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
    d.float('displaceAmount', 'Amount', 0, { min: -5, max: 5, softMin: 0, softMax: 0.2, unit: 'm', curve: true, visibleIf: active, tooltip: 'Displacement in metres at full height. The curve scales it along the branch length.' }),
    d.float('displaceRadiusAmount', '+ % of radius', 0, { min: -1, max: 2, visibleIf: active, tooltip: 'Extra amount relative to the local radius (thick trunks get deeper bark).' }),
    d.float('displaceOffset', 'Offset', 0, { min: -1, max: 1, visibleIf: active, tooltip: 'Bias added to the height before scaling.' }),
    d.bool('displaceMidGrey', 'Mid-grey is neutral', true, { visibleIf: active, tooltip: 'On: 50% grey does not move the surface (both directions). Off: black = no displacement, white = full amount outward.' }),
    d.enumOf('displaceDirection', 'Direction', 'Normal', ['Normal', 'Radial'], { visibleIf: active }),
    m.enumOf('displaceTiling', 'Tiling', 'World', ['World', 'Normalized'], { visibleIf: active, tooltip: 'World: one image tile covers "Tile size" metres, no stretching on long or thick branches.' }),
    m.float('displaceTileSize', 'Tile size', 0.5, { min: 0.005, max: 50, softMax: 4, unit: 'm', visibleIf: active }),
    m.float('displaceScale', 'Scale', 1, { min: 0.01, max: 50, visibleIf: active }),
    m.float('displaceScaleU', 'Scale U', 1, { min: 0.01, max: 50, visibleIf: active }),
    m.float('displaceScaleV', 'Scale V', 1, { min: 0.01, max: 50, visibleIf: active }),
    m.float('displaceRotation', 'Rotation', 0, { min: -360, max: 360, unit: '°', visibleIf: active, tooltip: 'Snapped to 90° steps while seams are locked.' }),
    m.bool('displaceLockSeams', 'Lock seams', true, { visibleIf: active, tooltip: 'Round the tiling around the trunk to a whole number so the U seam is continuous.' }),
    f.float('displaceFadeBase', 'Fade at junctions', 1.5, { min: 0, max: 10, visibleIf: active, tooltip: 'Fade-in length (in radii) where a branch leaves its parent: prevents cracks at junctions.' }),
    f.float('displaceFadeTip', 'Fade at tips', 1, { min: 0, max: 10, visibleIf: active, tooltip: 'Fade-out length (in radii) toward the tip / cap.' }),
    f.bool('displaceLodFade', 'LOD fade', true, { visibleIf: active, tooltip: 'Fade the amount out between LOD 1 and 3.' }),
    sd.bool('displaceAutoSubdivide', 'Auto-subdivide', true, { visibleIf: active, tooltip: 'Add rings and sides so the mesh has enough vertices to carry the height detail.' }),
    sd.float('displaceDetail', 'Detail size', 0.03, { min: 0.002, max: 1, softMax: 0.2, unit: 'm', visibleIf: active, tooltip: 'Target quad size when auto-subdividing (smaller = more detail, more triangles).' }),
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
    ...skinParams(8, false),
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
    ...skinParams(8, false),
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
    s.float('scale', 'Scale', 1, { min: 0.001, max: 20, softMax: 3, variance: 0.1, curve: true }),
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

/** Reference: Material tab "Leaves > Type" list (Material / Mesh / Weight) + "Season" (+ "Fallen"), "Vertex Color", "Lightmap". */
export function leafMaterialParams(): ParamDef[] {
  const type: ListParamDef = {
    kind: 'list',
    id: 'leafTypes',
    label: 'Type',
    group: 'Material',
    subgroup: 'Leaves',
    minItems: 1,
    maxItems: 32,
    default: [{ material: '', mesh: 'any', weight: 1 }],
    fields: [
      { kind: 'enum', id: 'material', label: 'Material', group: 'Material', default: '', options: [{ value: '', label: 'None' }] },
      { kind: 'enum', id: 'mesh', label: 'Mesh', group: 'Material', default: 'any', options: [{ value: 'any', label: 'Any' }] },
      { kind: 'float', id: 'weight', label: 'Weight', group: 'Material', default: 1, min: 0, max: 10, softMax: 1, curveAllowed: true },
    ],
  };
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

export function lightingParams(): ParamDef[] {
  const n = section('Lighting', 'Normals');
  const a = section('Lighting', 'Ambient occlusion');
  return [
    n.float('normalSpherize', 'Spherize', 0, { min: 0, max: 1, curve: true }),
    n.float('normalBend', 'Bend', 0, { min: -1, max: 1 }),
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
    s.string('meshMaterial', 'Material', 'leaf', { tooltip: 'Material slot id (placeholder until the material library assigns it).' }),
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
