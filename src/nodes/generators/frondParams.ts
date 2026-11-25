import type { ParamDef } from '@/contracts/params';
import { dynamicLodGeneratorParams, lightmapGeneratorParams } from './dynamicLodParams';
import { section } from '../shared/builders';
import { defaultMeshLodCurve } from './leafDeformParams';
import { frondLightingParams } from './frondLightingParams';
import { seasonTimingParams } from './seasonParams';
import { displacementParams, leafMaterialParams, leafWindParams } from './params';

/**
 * Parameter catalogue of the Frond node. A frond is built from ribs that run perpendicular to the parent spine (one pair
 * per length segment of the parent spine); a cutout mesh of the assigned material - or a plain ribbon - is mapped onto them.
 * The length always comes from the parent spine. Tabs: Generation, Shape, Segments, Forces, UV, LOD, Displacement, Material,
 * Animation. See docs/PARAMETERS.md.
 */
export function frondParams(): ParamDef[] {
  const g = section('Generation', 'Generation');
  const c = section('Generation', 'Common');
  const sh = section('Shape');
  const hg = section('Shape', 'Height');
  const bd = section('Shape', 'Boundary');
  const sc = section('Shape', 'Scale');
  const ol = section('Shape', 'Outline');
  const lr = section('Shape', 'Left-Right Variance');
  const sv = section('Shape', 'Section Variance');
  const sg = section('Shape', 'Section Gravity');
  const sf = section('Shape', 'Section Fold');
  const scu = section('Shape', 'Section Curl');
  const sr = section('Shape', 'Section Roll');
  const sa = section('Segments', 'Accuracy');
  const sw = section('Segments', 'Width');
  const fg = section('Forces', 'Gravity');
  const fu = section('Forces', 'Up / Down');
  const fa = section('Forces', 'Ancestor');
  const fl = section('Forces', 'Align');
  const uv = section('UV', 'Mapping');
  const at = section('UV', 'Atlas');
  const lod = section('LOD', 'LOD');
  const fm = section('Material', 'Leaves');
  const mm = section('Material', 'Mesh');

  const list: ParamDef[] = [
    c.bool('active', 'Active', true),
    g.int('frondPlanes', 'Planes per spine', 1, { min: 1, max: 8, tooltip: '1 = a single frond. 2 = crossed planes, 3 = a star: cheap volume for grass and reeds.' }),
    g.float('frondStartAngle', 'Start angle', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotation of the first plane about the spine.' }),
    c.seed('seed', 'Seed'),

    sh.enumOf('frondUnification', 'Unification', 'None', ['Global', 'Deep', 'Intermediate', 'Local', 'None', 'Origin'], {
      tooltip: 'Turns the face of every frond away from an anchor: the global, deep, intermediate or local ancestor of its spine, or the model origin. None keeps the face up.',
    }),
    hg.float('frondHeightAmount', 'Amount', 1, { min: -4, max: 4, softMin: -2, softMax: 2, step: 0.01, variance: 0, tooltip: 'Strength of the relief: scales the height of the mapped mesh and of the Offset displacement.' }),
    hg.float('frondHeightOffset', 'Offset', 0, { min: -1, max: 1, softMin: -0.1, softMax: 0.1, step: 0.001, unit: 'm', tooltip: 'Displaces the surface along the face by the Height map of the material (mid grey = no change).' }),
    hg.float('frondGravity', 'Gravity', 0, { min: -2, max: 2, step: 0.01, variance: 0, curve: true, tooltip: 'Pulls both side edges toward the ground (1 = an edge drops by half the width). Negative values lift them.' }),
    hg.float('frondFold', 'Fold', 0, { min: -90, max: 90, unit: '°', variance: 0, curve: true, tooltip: 'Folds each side toward the other along the length. Positive folds up, negative folds down.' }),
    hg.float('frondCurlAngle', 'Curl', 0, { min: -180, max: 180, unit: '°', variance: 0, curve: true, tooltip: 'Curls the outer edges toward the spine: the angle between the middle and the edge of every rib.' }),
    hg.float('frondRoll', 'Roll', 0, { min: -180, max: 180, unit: '°', variance: 0.1, tooltip: 'Rotates the frond around its parent spine.' }),
    lr.float('frondLRAmount', 'Amount', 0, { min: 0, max: 1, step: 0.01, tooltip: 'Lets the left and right half react independently to Curl, Fold and Gravity: each side gets its own random multiplier (1 = anywhere from none to double).' }),
    lr.seed('frondLRSeed', 'Seed'),
    sv.bool('frondSecOutliers', 'Favor Outliers', false, { tooltip: 'Prefers extreme values over median ones when the sections are randomised. Sections are painted in the cutout editor (Section [2..8]); unpainted areas keep the whole-mesh values.' }),
    sg.float('frondSecGravityAmount', 'Amount', 0, { min: 0, max: 2, step: 0.01, tooltip: 'Random Gravity added per painted section (same units as Gravity).' }),
    sg.float('frondSecGravityOffset', 'Offset', 0, { min: -2, max: 2, step: 0.01, tooltip: 'Shifts the Gravity of every painted section.' }),
    sf.float('frondSecFoldAmount', 'Amount', 0, { min: 0, max: 90, unit: '°', tooltip: 'Random Fold added per painted section.' }),
    sf.float('frondSecFoldOffset', 'Offset', 0, { min: -90, max: 90, unit: '°', tooltip: 'Shifts the Fold of every painted section.' }),
    scu.float('frondSecCurlAmount', 'Amount', 0, { min: 0, max: 180, unit: '°', tooltip: 'Random Curl added per painted section.' }),
    scu.float('frondSecCurlOffset', 'Offset', 0, { min: -180, max: 180, unit: '°', tooltip: 'Shifts the Curl of every painted section.' }),
    sr.float('frondSecRollAmount', 'Amount', 0, { min: 0, max: 180, unit: '°', tooltip: 'Random Roll (rotation about the spine) added per painted section.' }),
    sr.float('frondSecRollOffset', 'Offset', 0, { min: -180, max: 180, unit: '°', tooltip: 'Shifts the Roll of every painted section.' }),
    bd.float('frondBoundaryStart', 'Start', 0, { min: 0, max: 1, step: 0.01, tooltip: 'Where along the parent spine the frond starts (0 = base).' }),
    bd.float('frondBoundaryEnd', 'End', 1, { min: 0, max: 1, step: 0.01, tooltip: 'Where along the parent spine the frond ends (1 = tip).' }),
    sc.float('frondWidth', 'Width', 0.25, { min: 0.001, max: 50, softMax: 2, unit: 'm', variance: 0.15, curve: true, tooltip: 'Scales the mesh across the spine (X): the full width in metres. The curve shapes it along the length. The length is never scaled.' }),
    sc.float('frondScaleHeight', 'Height', 1, { min: 0, max: 10, softMax: 3, step: 0.01, tooltip: 'Scales the mesh out of the plane (Z). It only affects meshes with relief.' }),
    ol.float('frondBaseWidth', 'Base width', 1, { min: 0, max: 2, tooltip: 'Plain ribbon only: width multiplier at the base (blends to 1 over the first third).' }),
    ol.enumOf('frondTipShape', 'Tip', 'Pointed', ['Pointed', 'Rounded', 'Blunt'], { tooltip: 'Plain ribbon only: shape of the tip.' }),
    ol.float('frondTipTaper', 'Tip taper', 0.35, { min: 0, max: 1, tooltip: 'Plain ribbon only: fraction of the length over which the width closes to the tip.' }),

    sa.int('frondAccuracy', 'Accuracy', 4, { min: 1, max: 32, tooltip: 'Segments per rib (each side, at every length segment of the parent spine). Higher values follow Gravity, Fold and Curl more closely and are slower.' }),
    sw.int('frondWidthAbsolute', 'Absolute', 2, { min: 1, max: 32, tooltip: 'Plain ribbon: minimum number of segments across. Odd counts are raised to the next even number so a vertex row stays on the centre line.' }),
    sw.float('frondWidthRelative', '+ Relative', 0, { min: 0, max: 16, softMax: 4, step: 0.1, tooltip: 'Plain ribbon: segments added across per metre of parent spine length.' }),

    fg.bool('frondForceGravityOn', 'Enabled', false, { tooltip: 'Bends the frond toward the ground.' }),
    fg.float('frondForceGravity', 'Strength', 0.5, { min: -4, max: 4, softMin: -2, softMax: 2, step: 0.01, curve: true, tooltip: 'Strength of the pull along the length (the base stays stiff and the pull grows toward the tip). Negative values bend it up.' }),
    fu.bool('frondForceUpOn', 'Enabled', false, { tooltip: 'Bends the frond toward the sky.' }),
    fu.float('frondForceUp', 'Strength', 0.5, { min: -4, max: 4, softMin: -2, softMax: 2, step: 0.01, curve: true, tooltip: 'Strength of the lift along the length. Negative values bend it down.' }),
    fa.bool('frondForceAncestorOn', 'Enabled', false, { tooltip: 'Steers the frond toward the direction of its own base.' }),
    fa.float('frondForceAncestor', 'Strength', 0.5, { min: -4, max: 4, softMin: -2, softMax: 2, step: 0.01, curve: true, tooltip: 'Positive values straighten the frond along its base direction, negative values bend it away.' }),
    fl.float('frondAlign', 'Amount', 0, { min: 0, max: 1, step: 0.01, tooltip: 'Turns the face of the frond away from the net force (toward the sky for Gravity). Without an enabled force gravity is assumed.' }),

    uv.enumOf('frondUvMode', 'Match one v tile', 'Stretch', ['Stretch', 'Tile'], { tooltip: 'Plain ribbon only. Stretch: V runs 0..1 over the frond. Tile: world-length tiling (needs a full 1x1 atlas).' }),
    uv.float('frondUvTile', 'Tile length', 1, { min: 0.01, max: 100, softMax: 5, unit: 'm', visibleIf: { param: 'frondUvMode', value: 'tile' } }),
    uv.float('frondUvScaleU', 'Scale U', 1, { min: 0.01, max: 20 }),
    uv.float('frondUvScaleV', 'Scale V', 1, { min: 0.01, max: 20 }),
    uv.float('frondUvOffsetU', 'Offset U', 0, { min: -10, max: 10 }),
    uv.float('frondUvOffsetV', 'Offset V', 0, { min: -10, max: 10 }),
    at.int('atlasColumns', 'Columns', 1, { min: 1, max: 16 }),
    at.int('atlasRows', 'Rows', 1, { min: 1, max: 16 }),
    at.enumOf('atlasMode', 'Cell', 'Random', ['Random', 'Sequential', 'Fixed']),
    at.int('atlasCell', 'Fixed cell', 0, { min: 0, max: 255 }),

    lod.float('lodSegments', 'Segment reduction', 0.5, { min: 0, max: 0.9, tooltip: 'Fraction of the rib accuracy and ribbon width segments removed per LOD step.' }),
    lod.float('lodCull', 'Cull amount', 0, { min: 0, max: 1, tooltip: 'Fraction of fronds removed at the lowest LOD (the survivors are widened).' }),
    ...dynamicLodGeneratorParams('LOD', 'Dynamic LOD', false, false),
    ...lightmapGeneratorParams(0),
    lod.float('lodWidthBoost', 'Width boost', 0.5, { min: 0, max: 2, tooltip: 'How much the remaining fronds are widened when fronds are culled.' }),
  ];
  const material = [...leafMaterialParams().filter((d) => d.subgroup === 'Leaves' || d.subgroup === 'Vertex Color'), ...seasonTimingParams()];
  const materialExtras: ParamDef[] = [
    fm.bool('frondFlip', 'Flip', false, { tooltip: 'Mirrors a random half of the fronds across the spine (the local Y axis).' }),
    fm.bool('frondTwoSided', 'Two sided', false, { tooltip: 'Duplicates the geometry for the back side. The two layers overlap, which can show under strong wind.' }),
    mm.int('frondMeshIndex', 'Index', 0, { min: -2, max: 2, tooltip: 'Shifts the mesh LOD that is used toward lower (+) or higher (−) detail. Needs at least two mesh LOD slots filled.' }),
    mm.curve('frondMeshLod', 'Resolution', defaultMeshLodCurve(), { tooltip: 'Which mesh LOD to use at each active resolution. X: LOD (0 = highest detail … 3 = lowest), Y: 0 = High, 1 = Medium, 2 = Low.' }),
  ];
  const animation = leafWindParams().map((d) => ({ ...d, group: 'Animation' }) as ParamDef);
  const bend = section('Animation', 'Bend weight').float('frondBendPower', 'Bend power', 1.5, { min: 0.1, max: 6, tooltip: 'Stiffness of the base: the wind weight is scaled by t^power along the length (0 at the base, free tip).' });
  const ww = section('Animation', 'Wind');
  const wr = section('Animation', 'Ribs');
  const wind: ParamDef[] = [
    ww.float('frondWindWeight', 'Weight', 1, { min: 0, max: 1, step: 0.01, curve: true, tooltip: 'Wind weight along the length (left = pivot at the base, right = tip). The base always stays attached: the weight is 0 there.' }),
    ww.float('frondWindCross', 'Cross', 0, { min: 0, max: 1, step: 0.01, tooltip: 'Motion that grows from the spine (none) to the edges (full).' }),
    ww.float('frondWindBoost', 'Boost', 0, { min: 0, max: 1, step: 0.01, curve: true, tooltip: 'Extra absolute wind weight (left = base, right = tip). The very base is kept still.' }),
    wr.bool('frondRibsBranchWind', 'Apply branch wind', false, { tooltip: 'Adds the wind of one level above the parent branch to the ribs, so the blade edges follow the sway of the branch.' }),
    wr.float('frondRibsWeight', 'Weight', 0.5, { min: 0, max: 1, step: 0.01, tooltip: 'How strongly the branch wind reaches the ribs (grows from the spine to the edges).' }),
  ];
  return [...list, ...displacementParams(), ...material, ...materialExtras, ...frondLightingParams(), ...animation, bend, ...wind];
}
