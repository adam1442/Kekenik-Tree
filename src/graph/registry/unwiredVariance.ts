import type { NodeDef } from '@/contracts/nodes';
import type { ParamDef } from '@/contracts/params';

/**
 * Parameters whose "+/-" variance is NOT consumed by their generator yet (found by `tests/varianceCoverage.test.ts`:
 * switching the variance on leaves the generated scene unchanged). They do not get a variance button, so every button the
 * user sees really drives the result. Wiring one up = read it with `sampleVariance` in the generator, then delete its entry
 * here (the coverage test fails for entries that already work).
 *
 * Map: parameter id -> node types.
 */
export const UNWIRED_VARIANCE: Readonly<Record<string, readonly string[]>> = {
  breakSpot: ['generator.branch', 'generator.root', 'generator.spine', 'generator.trunk'],
  pathOffset: ['generator.branch', 'generator.root', 'generator.spine', 'generator.trunk'],
  angleToParent: ['generator.cluster'],
  clusterCount: ['generator.cluster'],
  decalHeight: ['generator.decal'],
  decalRotation: ['generator.decal'],
  deformCurl: ['generator.batchedLeaf', 'generator.leaf'],
  deformFold: ['generator.batchedLeaf', 'generator.leaf'],
  deformHeight: ['generator.batchedLeaf', 'generator.leaf'],
  deformScaleX: ['generator.batchedLeaf', 'generator.leaf'],
  deformScaleY: ['generator.batchedLeaf', 'generator.leaf'],
  deformScaleZ: ['generator.batchedLeaf', 'generator.leaf'],
  deformTwist: ['generator.batchedLeaf', 'generator.leaf'],
  distPosition: ['generator.branch', 'generator.spine', 'generator.trunk'],
  distRotation: ['generator.branch', 'generator.spine', 'generator.trunk'],
  fallenJumble: ['generator.batchedLeaf', 'generator.cluster', 'generator.leaf'],
  finCurl: ['generator.fin'],
  finFold: ['generator.fin'],
  finRoll: ['generator.fin'],
  frondCurlAngle: ['generator.frond'],
  frondFold: ['generator.frond'],
  frondGravity: ['generator.frond'],
  frondHeightAmount: ['generator.frond'],
  frondLightOut: ['generator.frond'],
  frondLightRight: ['generator.frond'],
  frondLightUp: ['generator.frond'],
  frondRoll: ['generator.frond'],
  leafTwist: ['generator.batchedLeaf', 'generator.leaf'],
  leanAzimuth: ['generator.trunk'],
  lightOut: ['generator.batchedLeaf', 'generator.leaf'],
  lightRight: ['generator.batchedLeaf', 'generator.leaf'],
  lightUp: ['generator.batchedLeaf', 'generator.leaf'],
  materialVariation: ['generator.branch', 'generator.cap', 'generator.root', 'generator.spine', 'generator.split', 'generator.trunk'],
  meshRoll: ['generator.meshes'],
  number: ['generator.cap'],
  pitch: ['generator.batchedLeaf', 'generator.cluster', 'generator.leaf', 'generator.root', 'generator.trunk'],
  positionOffset: ['generator.cap', 'generator.trunk'],
  postScale: ['generator.batchedLeaf', 'generator.cluster', 'generator.leaf', 'generator.meshes'],
  rollAngle: ['generator.batchedLeaf', 'generator.cluster', 'generator.leaf'],
  rotationOffset: ['generator.cap', 'generator.cluster', 'generator.trunk'],
  seasonDescendantOffset: ['generator.branch', 'generator.root', 'generator.spine', 'generator.trunk'],
  seasonDropTime: ['generator.cluster'],
  seasonStartOffset: ['generator.branch', 'generator.cluster', 'generator.decal', 'generator.fin', 'generator.frond', 'generator.knot', 'generator.meshes', 'generator.root', 'generator.spine', 'generator.trunk'],
  seasonTimeScale: ['generator.batchedLeaf', 'generator.branch', 'generator.cluster', 'generator.decal', 'generator.fin', 'generator.frond', 'generator.knot', 'generator.leaf', 'generator.meshes', 'generator.root', 'generator.spine', 'generator.trunk'],
  sink: ['generator.batchedLeaf', 'generator.cap', 'generator.cluster', 'generator.decal', 'generator.fin', 'generator.knot', 'generator.leaf', 'generator.meshes', 'generator.root'],
  spread: ['generator.root', 'generator.trunk'],
  startRoll: ['generator.root', 'generator.trunk'],
  strength: ['force.geometry', 'force.groundAvoid', 'force.knockout', 'force.return', 'force.seasonLight', 'force.seasonWind'],
  uvOffsetU: ['generator.cap', 'generator.spine', 'generator.split'],
  uvOffsetV: ['generator.cap', 'generator.spine', 'generator.split'],
  vertexAmount: ['generator.batchedLeaf', 'generator.leaf'],
  yaw: ['generator.batchedLeaf', 'generator.cluster', 'generator.leaf'],
};

const isUnwired = (def: NodeDef, p: ParamDef): boolean => p.variance !== undefined && UNWIRED_VARIANCE[p.id]?.includes(def.type) === true;

/**
 * Parameters whose variance default is 0 lose the button; those with a non-zero default keep it, because a freshly created
 * node would otherwise start with a different default state than old projects (they may act under conditions the audit
 * graph does not set, e.g. a break chance). The coverage test reports both groups.
 */
export const isHiddenWhenUnwired = (p: ParamDef): boolean => p.variance?.default === 0;

/** The def without the variance button of its unwired parameters. */
export function withoutUnwiredVariance(def: NodeDef): NodeDef {
  if (!def.params.some((p) => isUnwired(def, p) && isHiddenWhenUnwired(p))) return def;
  return {
    ...def,
    params: def.params.map((p) => {
      if (!isUnwired(def, p) || !isHiddenWhenUnwired(p)) return p;
      const { variance: _variance, ...rest } = p;
      return rest as ParamDef;
    }),
  };
}
