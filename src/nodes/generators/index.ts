import type { NodeDef } from '@/contracts/nodes';
import { getNumber, type NodeParams } from '@/contracts/params';
import type { ParamDef } from '@/contracts/params';
import type { PortDef } from '@/contracts/ports';
import { attachIns, childrenOut, parentIn } from '../shared/ports';
import { evaluateBranch } from './branch';
import { evaluateBatchedLeaf, evaluateLeaf } from './foliage';
import { migrateLegacyMaterialParam } from '@/materials/meshSelection';
import { evaluateFrond, migrateFrondParams } from './frond';
import { frondParams } from './frondParams';
import { displacementDependencyKey, warnDisplacement } from './displacement';
import { evaluateCap, evaluateCluster, evaluateMeshInstances } from './instanceNodes';
import { evaluateSpine, evaluateSplit } from './helpers';
import { evaluateKnot } from './knot';
import { knotParams } from './knotParams';
import { migrateKnotParams } from './knotConfig';
import { decalParams } from './decalParams';
import { evaluateDecal } from './decal';
import { finParams } from './finParams';
import { evaluateFin } from './fin';
import { surfaceHeightKey } from './surfaceDetail';
import {
  animationParams,
  capParams,
  clusterParams,
  displacementParams,
  structureDisplacementParams,
  forcesParams,
  generationParams,
  passAndSizeParams,
  handDrawnParams,
  leafMaterialParams,
  leafSkinParams,
  meshGeneratorParams,
  leafWindParams,
  lightingParams,
  lodParams,
  materialTabParams,
  orientationParams,
  postParams,
  leafCollisionParams,
  shapeParams,
  segmentParams,
  skinParams,
  spineParams,
  splitHelperParams,
  uvParams,
  type GenerationDefaults,
  type SpineDefaults,
} from './params';
import { anchorPlacementParams } from './cutoutPlacement';
import { leafPlacementParams } from './leafPlacementParams';
import { leafDeformParams, leafDependencyKey, materialHeightKey } from './leafDeformParams';
import { leafLightingParams } from './leafLightingParams';
import { migrateLeafParams } from './foliage';
import { migrateBranchMaterial, uvDependencyKey } from './uvConfig';
import { withGenerationMigration } from './generationMigration';
import { migrateLegacySplitParams } from '@/generators/split';
import { migrateSpineParams } from '@/generators/spine';
import { vTileDependencyKey } from './vTile';
import { withGenerationCommon } from './generationEnv';
import { seasonStructureParams, seasonTimingParams } from './seasonParams';
import { withLineage } from './lineageHook';
import { evaluateRoot } from './root';
import { evaluateTrunk } from './trunk';

export { evaluateTrunk } from './trunk';
export { evaluateBranch } from './branch';
export { evaluateRoot } from './root';
export { evaluateSplit, evaluateSpine } from './helpers';
export { evaluateKnot } from './knot';
export { evaluateDecal } from './decal';
export { evaluateFin } from './fin';
export {
  registerExternalForceEvaluator,
  getExternalForceEvaluator,
  type ExternalSpineForceEvaluator,
  type SpineForceSampleContext,
} from './forcesHook';
export {
  advanceRMF,
  computePolylineRMF,
  buildChildInitialFrame,
  prepareParentBranch,
  sampleParentBranch,
  findCurvaturePeaks,
  selectAdaptiveSampleIndices,
  type Frame3,
  type PolylineFrames,
  type PreparedParentBranch,
  type ParentSample,
} from './frames';
export { StructureSkeletonBuilder } from './skeletonBuild';

/** Adds the displacement warning badge (missing / unloaded map) to a generator's evaluate function. */
const withDisplacementWarning =
  (fn: NodeDef['evaluate']): NodeDef['evaluate'] =>
  (ctx, inputs, params) => {
    warnDisplacement(ctx, params);
    return fn(ctx, inputs, params);
  };

/** Cache-key hook shared by every node that has a Displacement tab. */
const displacementDeps = (params: NodeParams): string => `${displacementDependencyKey(params)}|${vTileDependencyKey(params)}`;

const withChildren: PortDef[] = [parentIn, childrenOut, ...attachIns];
const leafOnly: PortDef[] = [parentIn, ...attachIns];

const structureParams = (
  gen: GenerationDefaults,
  spine: SpineDefaults,
  sides: number,
  flareRadius = 0,
  flareHeight = 0.14,
  spineOnly = false,
): ParamDef[] => [
  ...generationParams(gen),
  ...spineParams(spine),
  ...segmentParams(spine.kind, spine.segments, sides),
  ...forcesParams(),
  ...shapeParams(flareRadius, flareHeight),
  ...skinParams(spineOnly, undefined, spine.kind === 'branch' || spine.kind === 'root', spine.kind === 'trunk' ? 'trunk' : 'child', spine.kind === 'branch', spine.kind === 'root'),
  ...uvParams(spine.kind === 'branch'),
  ...lodParams(),
  ...structureDisplacementParams(),
  ...materialTabParams(spine.kind === 'branch'),
  ...seasonStructureParams(spine.kind === 'branch'),
  ...animationParams(),
  ...handDrawnParams(),
];

/** Leaf-only parameters the Batched leaf does not have (no Mesh LOD offset, no vertex-noise Seed). */
const BATCHED_EXCLUDED = new Set(['resMeshLodOffset', 'vertexSeed']);

const leafTabs = (gen: GenerationDefaults, extra: ParamDef[] = [], batched = false): ParamDef[] => {
  const defs = [
    ...generationParams(gen),
    ...anchorPlacementParams(),
    ...leafSkinParams(),
    ...leafPlacementParams(),
    ...leafDeformParams(),
    ...extra,
    ...forcesParams(),
    ...orientationParams(),
    ...leafMaterialParams().filter((d) => d.id !== 'leafTypes'),
    ...leafLightingParams({ batched }),
    ...lightingParams(),
    ...leafWindParams(),
    ...postParams(),
    ...leafCollisionParams(),
  ];
  return batched ? defs.filter((d) => !BATCHED_EXCLUDED.has(d.id)) : defs;
};

const baseNodeDefs: NodeDef[] = [
  {
    type: 'generator.trunk',
    category: 'generator',
    label: 'Trunk',
    icon: 'nodeBranch',
    color: 'var(--kt-node-branch)',
    description: 'Main stem with crown height, buttress flare, lean, gnarliness, and profile curves.',
    statsGroup: 'branches',
    ports: withChildren,
    version: 5,
    migrate: withGenerationMigration((params) => migrateLegacySplitParams(migrateSpineParams(params))),
    params: structureParams(
      { number: 1, first: 0, last: 1, placement: true },
      { kind: 'trunk', length: 12, radius: 0.32, taper: 0.88, segments: 24, spread: 12, gravity: 0, upDown: 0.04, noiseAmount: 0.16 },
      12,
      0.28,
      0.14,
    ),
    evaluate: withLineage(withDisplacementWarning(evaluateTrunk)),
    dependencyKey: displacementDeps,
  },
  {
    type: 'generator.branch',
    category: 'generator',
    label: 'Branch',
    icon: 'nodeBranch',
    color: 'var(--kt-node-branch)',
    description: 'Procedural branches grown along parent skeletons with phyllotaxis, whorls, bifurcations, and pruning.',
    statsGroup: 'branches',
    ports: withChildren,
    version: 6,
    migrate: withGenerationMigration((params) => migrateBranchMaterial(migrateLegacySplitParams(migrateSpineParams(params)))),
    params: structureParams(
      { number: 12, first: 0.2, last: 0.95, jumble: 0.2, includeBranchExtended: true, placement: true, extend: true },
      { kind: 'branch', length: 3.2, radius: 0.06, taper: 0.88, segments: 10, spread: 48, gravity: 0.16, upDown: 0.06, noiseAmount: 0.2 },
      8,
    ),
    evaluate: withLineage(withDisplacementWarning(evaluateBranch)),
    dependencyKey: (params) => `${displacementDeps(params)}|${uvDependencyKey(params)}`,
  },
  {
    type: 'generator.root',
    category: 'generator',
    label: 'Root',
    icon: 'nodeRoot',
    color: 'var(--kt-node-root)',
    description: 'Subterranean and buttress roots grown below ground or blended into the trunk base.',
    statsGroup: 'roots',
    ports: withChildren,
    version: 5,
    migrate: withGenerationMigration((params) => migrateLegacySplitParams(migrateSpineParams(params))),
    params: structureParams(
      { number: 6, first: 0, last: 0.12, jumble: 0.28, includeBranchExtended: true, extend: true, extendNoCount: true },
      { kind: 'root', length: 3.4, radius: 0.09, taper: 0.92, segments: 12, spread: 68, gravity: 0.2, upDown: -0.25, noiseAmount: 0.28 },
      8,
      0.18,
      0.2,
    ),
    evaluate: withLineage(withDisplacementWarning(evaluateRoot)),
    dependencyKey: displacementDeps,
  },
  {
    type: 'generator.split',
    category: 'generator',
    label: 'Split',
    icon: 'nodeSplit',
    color: 'var(--kt-node-branch)',
    description: 'Bifurcates parent branches into diverging forks with pipe-model radius conservation.',
    statsGroup: 'branches',
    ports: withChildren,
    params: splitHelperParams(),
    evaluate: withLineage(evaluateSplit),
  },
  {
    type: 'generator.knot',
    category: 'generator',
    label: 'Knot',
    icon: 'nodeKnot',
    color: 'var(--kt-node-cap)',
    description: 'Surface details welded onto branches and trunks: knots, lumps and gashes with an Outer band (parent material), an Inner bridge and a Core.',
    statsGroup: 'decorations',
    ports: withChildren,
    version: 2,
    migrate: withGenerationMigration((params) => migrateKnotParams(params)),
    params: [...knotParams(), ...seasonTimingParams()],
    evaluate: withLineage(evaluateKnot),
  },
  {
    type: 'generator.decal',
    category: 'generator',
    label: 'Decal',
    icon: 'nodeDecal',
    color: 'var(--kt-node-cap)',
    description: 'Flat patches projected onto the skin of a trunk, branch or root with their own material and height map: knots, lumps, cavities, scars.',
    statsGroup: 'decorations',
    ports: withChildren,
    params: decalParams(),
    evaluate: withLineage(evaluateDecal),
    dependencyKey: surfaceHeightKey,
  },
  {
    type: 'generator.fin',
    category: 'generator',
    label: 'Fin',
    icon: 'nodeFin',
    color: 'var(--kt-node-fin)',
    description: 'Thin flaps that stand off a trunk or branch: fungus shelves, moss and lichen flaps, bark curls, with fold, curl, noise and soft lighting.',
    statsGroup: 'decorations',
    ports: withChildren,
    params: finParams(),
    evaluate: withLineage(evaluateFin),
  },
  {
    type: 'generator.spine',
    category: 'generator',
    label: 'Spine',
    icon: 'nodeSpine',
    color: 'var(--kt-node-branch)',
    description: 'Lightweight spine-only structural guides for attaching foliage or child branches without tube geometry.',
    statsGroup: 'branches',
    ports: withChildren,
    version: 5,
    migrate: withGenerationMigration((params) => migrateLegacySplitParams(migrateSpineParams(params))),
    params: structureParams(
      { number: 8, first: 0.15, last: 0.95, jumble: 0.2, includeBranchExtended: true, placement: true },
      { kind: 'spine', length: 1.8, radius: 0.02, taper: 0.9, segments: 8, spread: 42, gravity: 0.12, upDown: 0.05, noiseAmount: 0.12 },
      6,
      0,
      0.1,
      true,
    ),
    evaluate: withLineage(withDisplacementWarning(evaluateSpine)),
    dependencyKey: displacementDeps,
  },
  {
    type: 'generator.leaf',
    category: 'generator',
    label: 'Leaf',
    icon: 'nodeLeaf',
    color: 'var(--kt-node-leaf)',
    description: 'Leaf cards or meshes.',
    statsGroup: 'leaf meshes',
    ports: withChildren,
    version: 3,
    migrate: withGenerationMigration(migrateLeafParams),
    params: leafTabs({ number: 6, first: 0.1, last: 1, extend: true, meshAlignment: true }),
    evaluate: withLineage(evaluateLeaf),
    dependencyKey: leafDependencyKey,
  },
  {
    type: 'generator.batchedLeaf',
    category: 'generator',
    label: 'Batched Leaf',
    icon: 'nodeBatchedLeaf',
    color: 'var(--kt-node-leaf)',
    description: 'Leaf cards or meshes merged into one batched mesh per material (fewer draw calls). Always uses the highest detail and has no Mesh LOD offset, vertex-noise seed, Unify or World up.',
    statsGroup: 'leaf meshes',
    ports: withChildren,
    version: 2,
    migrate: withGenerationMigration(),
    params: leafTabs({ number: 6, first: 0.1, last: 1, extend: true, meshAlignment: true }, [], true),
    evaluate: withLineage(evaluateBatchedLeaf),
    dependencyKey: leafDependencyKey,
  },
  {
    type: 'generator.frond',
    category: 'generator',
    label: 'Frond',
    icon: 'nodeFrond',
    color: 'var(--kt-node-frond)',
    description: 'Ribs run across every parent spine and a cutout mesh (or a plain ribbon) is mapped onto them: grass blades, ferns, palm and banana leaves, reeds.',
    statsGroup: 'fronds/fins',
    version: 3,
    migrate: migrateFrondParams,
    ports: leafOnly,
    params: [...frondParams(), ...passAndSizeParams()],
    evaluate: withDisplacementWarning(evaluateFrond),
    dependencyKey: (params: NodeParams): string => `${displacementDeps(params)}#${getNumber(params, 'frondHeightOffset', 0) === 0 ? '' : materialHeightKey()}`,
  },
  {
    type: 'generator.meshes',
    category: 'generator',
    label: 'Mesh Instance',
    icon: 'nodeMesh',
    color: 'var(--kt-node-mesh)',
    description: 'Places primitive or imported meshes (OBJ / GLB) along parents, baked or GPU-instanced.',
    statsGroup: 'meshes',
    ports: withChildren,
    params: [
      ...generationParams({ number: 6, first: 0.2, last: 1, jumble: 0.2, includeBranchExtended: true }),
      ...anchorPlacementParams(),
      ...meshGeneratorParams(),
      ...seasonTimingParams(),
      ...forcesParams(),
      ...leafWindParams(),
      ...postParams(),
    ],
    evaluate: evaluateMeshInstances,
    version: 3,
    migrate: withGenerationMigration((params, fromVersion) =>
      fromVersion >= 2 ? params : migrateLegacyMaterialParam(params, 'meshTypes', 'meshMaterial'),
    ),
  },
  {
    type: 'generator.cap',
    category: 'generator',
    label: 'Cap',
    icon: 'nodeCap',
    color: 'var(--kt-node-cap)',
    description: 'Closes the open ends of branches (breaks and split sides).',
    statsGroup: 'caps',
    ports: leafOnly,
    version: 3,
    migrate: withGenerationMigration(),
    params: [...generationParams({ number: 1, first: 1, last: 1, extend: true, extendNoCount: true }), ...capParams(), ...skinParams(false, 8), ...uvParams(), ...displacementParams(), ...materialTabParams()],
    evaluate: withDisplacementWarning(evaluateCap),
    dependencyKey: displacementDeps,
  },
  {
    type: 'generator.cluster',
    category: 'generator',
    label: 'Cluster',
    icon: 'nodeCluster',
    color: 'var(--kt-node-cluster)',
    description: 'Instances small bodies (berries, cones) at branch ends.',
    statsGroup: 'clusters',
    ports: leafOnly,
    version: 2,
    migrate: withGenerationMigration(),
    params: [...generationParams({ number: 1, first: 0.8, last: 1 }), ...clusterParams(), ...forcesParams(), ...orientationParams(), ...leafMaterialParams(), ...leafWindParams(), ...postParams()],
    evaluate: evaluateCluster,
  },
];

/** Every generator gets the common migration, the Mask cache key and the Size scalar (own value x parent's, handed down). */
export const nodeDefs: NodeDef[] = baseNodeDefs.map((d) => (d.category === 'generator' ? withGenerationCommon(d) : d));
