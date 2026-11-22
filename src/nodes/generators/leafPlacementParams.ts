import { getBool, getNumber, getString, type NodeParams, type ParamDef } from '@/contracts/params';
import { deg2rad } from '@/core/math';
import {
  asAnchorStyle,
  type AnchorStyle,
  type FinalAdjustments,
  type InitialOrientation,
  type LocalOrientation,
  type ParentFrameStyle,
  type ParentSensitivity,
} from '@/geometry/leafPlacement';
import { section } from '../shared/builders';
import { materialSlotList } from './params';

const TAB = 'Leaves';
const ANCHORS = ['Global', 'Deep', 'Intermediate', 'Local', 'None'];

/** Leaf "Leaves" tab: Leaves, Type, Local orientation, Sensitivity -> Parent, Final adjustments. */
export function leafPlacementParams(): ParamDef[] {
  const l = section(TAB, 'Leaves');
  const lo = section(TAB, 'Local orientation');
  const sp = section(TAB, 'Sensitivity → Parent');
  const fa = section(TAB, 'Final adjustments');
  return [
    l.bool('leafUseActualSize', 'Use actual size', false, { tooltip: 'Ignore Size and use the mesh at the real size it was authored at (cards keep Width × Height).' }),
    l.float('leafSize', 'Size', 1, {
      min: 0.001,
      max: 20,
      softMax: 3,
      variance: 0.1,
      curve: true,
      tooltip: 'Scale of the leaf (the mesh is treated as a unit mesh of Width × Height). A curve varies it along the parent.',
      visibleIf: { param: 'leafUseActualSize', value: false },
    }),
    l.float('leafSizeParent', '+% of parent', 0, {
      min: 0,
      max: 500,
      softMax: 100,
      unit: '%',
      tooltip: 'Adds this percentage of the parent branch length to Size, so leaves grow with their parent.',
      visibleIf: { param: 'leafUseActualSize', value: false },
    }),
    l.bool('leafWeld', 'Weld', false, { tooltip: 'Place leaves on the skin of the parent tube instead of on its centre line.' }),
    l.bool('leafKeepFailedWelds', 'Keep failed welds', true, {
      tooltip: 'If a weld fails (the parent has no skin), still place the leaf on the centre line. Off drops the leaf.',
      visibleIf: { param: 'leafWeld', value: true },
    }),
    l.bool('leafCross', 'Cross', false, { tooltip: 'Adds a second copy of every leaf turned 90° about its growth axis (crossed planes).' }),
    l.bool('leafFixWinding', 'Fix winding', true, { tooltip: 'After all deformation and mirroring, flips triangles whose order disagrees with the normals.' }),
    l.bool('leafFlip', 'Flip', false, { tooltip: 'Mirrors a random half of the leaves across their local Y axis.' }),
    l.enumOf('leafInitialOrientation', 'Initial orientation', 'Synchronized', ['Classic', 'Synchronized'], {
      tooltip: 'Classic mirrors leaves on the left / right side of the parent (needs Interval or Phyllotaxy placement, else sides are random). Synchronized keeps one orientation.',
      visibleIf: { param: 'leafFlip', value: false },
    }),
    materialSlotList('leafTypes', 'Type', TAB, 'Type', ''),
    lo.enumOf('orientAnchorStyle', '3D anchor style', 'Match parent', ['Legacy', 'Match parent'], {
      tooltip: 'Match parent follows the parent’s orientation and twist. Legacy ignores them: use it when the parent is also a leaf.',
    }),
    lo.enumOf('orientUnification', 'Unification', 'None', ANCHORS, {
      tooltip: 'Turns the leaf to point “out”: away from an anchor through the attachment point (Global = tree base, Deep = base near the root, Intermediate = middle of the ancestors, Local = base of the parent).',
    }),
    lo.float('orientSky', 'Sky influence', 0, { min: 0, max: 1, tooltip: 'Turns the leaf’s face (local Z) toward the sky. 1 = straight up.' }),
    lo.float('orientFold', 'Fold', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotates the leaf up or down around the parent’s growth direction.' }),
    lo.float('orientAlign', 'Align', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotates the leaf tip toward (+) or away from (−) the parent’s growth direction.' }),
    lo.float('orientFace', 'Face', 0, { min: 0, max: 1, tooltip: 'Spins the leaf around its stem so its up vector points along the parent’s growth (leaves face outward). 1 = fully.' }),
    sp.float('parentAmount', 'Amount', 0, { min: 0, max: 1, tooltip: 'Turns the underside of the leaf toward the anchor.' }),
    sp.enumOf('parentAnchor', 'Anchor', 'None', ANCHORS, { tooltip: 'Anchor the leaf bottom turns toward.' }),
    sp.float('parentSky', 'Sky', 0, { min: 0, max: 1, tooltip: 'Spins the leaf around its central axis so its face is as close to up as possible.' }),
    fa.float('finalUp', 'Up', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotation around the leaf’s local X axis. Applied last, together with Right and Out.' }),
    fa.float('finalRight', 'Right', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotation around the leaf’s local Y axis.' }),
    fa.float('finalOut', 'Out', 0, { min: -180, max: 180, unit: '°', tooltip: 'Rotation around the leaf’s local Z axis.' }),
  ];
}

export interface LeafPlacementConfig {
  useActualSize: boolean;
  /** Fraction (0.1 = 10 %) of the parent size added to Size. */
  sizeParent: number;
  weld: boolean;
  keepFailedWelds: boolean;
  cross: boolean;
  fixWinding: boolean;
  flip: boolean;
  initial: InitialOrientation;
  parentStyle: ParentFrameStyle;
  local: LocalOrientation;
  sensitivity: ParentSensitivity;
  final: FinalAdjustments;
}

const unit = (v: number): number => Math.min(1, Math.max(0, v));

/** Read the Leaves tab from node params (every default is neutral: old projects keep their result). */
export function readLeafPlacement(p: NodeParams): LeafPlacementConfig {
  return {
    useActualSize: getBool(p, 'leafUseActualSize', false),
    sizeParent: Math.max(0, getNumber(p, 'leafSizeParent', 0)) / 100,
    weld: getBool(p, 'leafWeld', false),
    keepFailedWelds: getBool(p, 'leafKeepFailedWelds', true),
    cross: getBool(p, 'leafCross', false),
    fixWinding: getBool(p, 'leafFixWinding', true),
    flip: getBool(p, 'leafFlip', false),
    initial: getString(p, 'leafInitialOrientation', 'synchronized') === 'classic' ? 'classic' : 'synchronized',
    parentStyle: getString(p, 'orientAnchorStyle', 'match-parent') === 'legacy' ? 'legacy' : 'match-parent',
    local: {
      unification: asAnchorStyle(getString(p, 'orientUnification', 'none')),
      sky: unit(getNumber(p, 'orientSky', 0)),
      fold: deg2rad(getNumber(p, 'orientFold', 0)),
      align: deg2rad(getNumber(p, 'orientAlign', 0)),
      face: unit(getNumber(p, 'orientFace', 0)),
    },
    sensitivity: {
      amount: unit(getNumber(p, 'parentAmount', 0)),
      anchor: asAnchorStyle(getString(p, 'parentAnchor', 'none')) satisfies AnchorStyle,
      sky: unit(getNumber(p, 'parentSky', 0)),
    },
    final: {
      up: deg2rad(getNumber(p, 'finalUp', 0)),
      right: deg2rad(getNumber(p, 'finalRight', 0)),
      out: deg2rad(getNumber(p, 'finalOut', 0)),
    },
  };
}
