# Commit messages

One entry per task. Take the text of the finished task from here.

## T19

```
feat(presets): six real sample projects, Tree-only new project

- Remove the generated species presets (species.ts, builder.ts, seasons.ts); the Library / Welcome list the six .ktree
  files in public/Sample Projects/ (Oak, Birch, Palm, Fern, Grass, Swamp) through src/presets/samples.ts.
- Samples are copied to dist/Sample Projects/ and fetched on open (not inlined into the single-file bundle).
- defaultGraph() = the Tree node only (startup, File > New, last document closed).
- Tests, QA report, docs and changelog moved to the samples; old starter graph kept as tests/fixtures/starterGraph.ts.
```

## S8

```
feat(split): one spine per split, gap-free junctions, QA report, open-end overlay, docs

- A split counts as ONE spine for every generator below it: Branch, Split, Leaf / Cluster / Mesh / Knot (collectPlacements),
  Frond and Decoration skip the fused halves and use the true tube (fusedParent.ts); halves stay parents only for Extend parent / Cap.
- Split generator: new "Split parents only" parameter.
- Extension / cap first rings snap onto the real end ring of the half (ringSnap.ts): no gap, no open edge.
- meshQuality() report + tests over presets, deep splits, root splits, extension chains, caps.
- "Show open ends" viewport overlay (ring + arrow + index, coloured by kind), off by default.
- Cleanup: unused spineOriginFor / hasSplitVariance / SPLIT_MIN_RADIUS removed, one OpenEnd type shared by Break / Extend / Cap / Root.
- Docs: SPLITS.md, ARCHITECTURE (split engine), PARAMETERS regenerated.
```

## S7

```
fix(root): anchor roots on the ground base only, Extend parent Bottom and root splitting

- Root generator: ordinary roots start only on primary spines without a parent (lineage tag), never on split halves or
  extensions; lateral roots skip split halves of a root parent. Streams and placement phase are keyed by the ordinal of the
  primary spine, so splits above do not change root count, seeds or azimuths (several trunks: independent root sets).
- Extend parent on Root (Bottom = base ring of the ground base, position / radius exact, direction = -tangent); Root is an
  Extend child and parent type, so Cap closes root tips.
- Root splitting: new Split advanced > Down bias (tiltTowardGravity, Root default 0.4), Root Area exponent default 2.3.
- Pure helpers isGroundBase / tiltTowardGravity; tests/rootS7.test.ts (anchors, chance independence, two trunks, Bottom,
  watertight root split, gravity tilt, Cap, old project), updated generationCommon expectations; docs, changelog.
```

## S6

```
feat(split): one shared split engine for Trunk / Branch / Root, presets, LOD and tests

- Remove the legacy polyline fork from spine.ts (Tip behavior Fork, splitChance / Spread / Balance / Start / MaxDepth);
  every node splits through Skin > Splits (planSplit has a single production caller). The Split helper node uses the
  shared radii / lateral-balance functions.
- migrateLegacySplitParams (Trunk v5, Branch v6, Root v5, Spine v5): legacy ids -> splits*, Fork -> Taper + Chance 1;
  Root keeps the old defaults (Chance 0.3, 30 degrees). Fixture: tests/fixtures/legacySplitProject.ktree.json.
- Lineage tag spineOrigin (primary / splitHalf / extension) on the skeleton, copied by mergeSkeletons.
- effectiveSplitSides (even, >= 6) applied after all resolution / LOD scalars; SPLIT_MIN_TRANSITION_RINGS.
- Variance on Chance, Balance, Side 1 / 2, Expand 1 / 2, Smooth Inner / Outer; one forked stream per parameter.
- Presets: natural splits for Oak, Maple, Birch, Willow, Acacia (+ Baobab, Dead Tree, roots); Spruce / Pine none.
- Tests: tests/splitS6.test.ts (single path, even N for 100 random sets, welded split, seed isolation, migration,
  presets at every LOD, export, 500-branch performance); older tests moved to the new ids.
- Docs (ARCHITECTURE, PARAMETERS), changelog.
```

## S5

```
feat(split): Branch > Extensions group (Count > 1) and Cap on open ends

- generators/split/extensionGroup.ts (pure): area rule count^(-1/e), Fermat-spiral bases inside 0.5 x end radius with
  one forked jitter stream per index, fan angle with profile curve, virtual-split constants.
- Count 2 on one end = virtual split: a short fused stub (extension of the end) forks through planSplit (S2 crotch) into
  two real extensions; Count 3+ start on Fermat bases with area-rule radii and fan out by Spread.
- Extensions take the end's radial count; a splitting spine stores the even >= 6 count the mesher uses.
- Params: Length scale 0.1-3, Spread default 0, Radius default 0, Displacement scale 0-2.
- collectOpenEnds also returns frame, U tiling and radial count; Cap (evaluateCap) is an extension of its end: exact end
  radius / ring count / frame, UV continues, no buried ring; Split 1 / Split 2 / Any / Breaks only / Bottom as before.
- Tests (tests/extendS5.test.ts), docs (ARCHITECTURE), changelog.

fix(split): Cap sibling claim list, group normal smooth, relative Manual UV offsets (S5 follow-up)

- generators/split/endClaims.ts (pure) + NodeContext.endClaims: a Cap skips ends that a sibling Branch extends; the first
  of two Caps wins; the claims are part of the Cap's cache key (parameter-derived, order independent).
- Count 3+: extensions flagged EXTENSION_GROUP_VALUE lean first-ring normals towards the shared end cylinder
  (sharedEndNormal) instead of their own radial direction.
- Manual (match) / (match u only): own U / V offsets are relative to the parent's values.
- Tests: extendS5 (claims, group normals), uvR16 (relative offsets); docs, changelog.
```

## S4

```
feat(split): Extend parent open-end selection and seamless continuation

- generators/split/selectOpenEnds.ts (pure): selectOpenEnds rule table (None / Any / Split 1 / Split 2 / Skinny / Fat /
  Breaks only / Bottom, Count 1-8 with stable per-index RNG keys), bottomOpenEnd (-tangent, flipped frame),
  junctionError, checkExtensionDepth (max 32), extendDisabledReason. selectsOpenEnd follows the same table
  (unsplit end = Split 1 / Fat, never Skinny).
- generators/split/continuation.ts (pure): blendExtensionStart (Hermite-style blend over the first 1.5 radii) and
  extensionStartSampleIndex; spine.ts uses them so the first segment follows the open end direction.
- branch.ts: extension frame = the end's own frame (Bottom flipped), depth guard with a node error; spine.ts: no pruning
  of extensions (Bottom is no longer removed underground).
- Inspector: Extend parent Type / Count disabled with a tooltip unless the parent is a Branch generator.
- Tests (tests/extendS4.test.ts), docs (ARCHITECTURE), changelog.
```

## S3

```
feat(split): clean normals, half U mapping and material blend across split junctions

- generators/split/crotchMesh.ts: normals on the logical vertex set (area x angle weighted, pinned Laplacian
  relaxation, analytic open-end normals), per-corner normals + fans so Smooth > Inner = 0 keeps a crisp crease and
  Inner = 1 averages fully; the merged crotch vertex keeps one normal per valley side.
- generators/split/crotchShading.ts (pure): crotch light seam reduction (reuses skin/seam), splitHalfMapping,
  extensionBlendValue (reuses weld/blend).
- geometry: crotch ring 0 shares the parent's last-ring vertices, seam lean on parent + crotch rings, lobes store
  uTiles / uStart / V of the open end (extensions continue them), extension material blend through the weld channels.
- Skin > Extensions: Blend length / Contrast / Noise. Export: _BLEND attribute; LOD cull keeps the weld channels.
- Tests (tests/splitS3.test.ts), docs (ARCHITECTURE, EXPORT_SPEC, PARAMETERS), changelog.
```

## S2

```
feat(split): fused crotch mesh - one pair-of-pants skin from the parent into both halves

- generators/split/crotchMesh.ts (pure): evenSides, buildCrotchMesh (outer arcs of two lobe circles between the
  pinch points A / B, N -> two rings of N / 2 sharing the crotch vertex C, constant U per vertex, Inner crease fill,
  Outer relaxation with a 10 % axial limit, smooth normals, per-corner U codes), creaseFillWeight, crotchPinchTurning.
- geometry/splitCrotch.ts + tubeMesher: the parent is cut at the transition start, phase alignment rolls the last
  rings by < 1 vertex spacing, the crotch rings and the two open-end domes replace the old lobe tubes (lobes only
  plan their UV attributes). Splitting parents use an even radial count >= 6.
- spine / branch: lobes carry Expand and Smooth Inner / Outer as skeleton attributes (copied by mergeSkeletons).
- Tests (tests/crotchMesh.test.ts, tests/crotchMesher.test.ts), docs/ARCHITECTURE.md, changelog.
```

## S1

```
feat(split): natural split model - pipe-model radii, lateral balance, shared axis and tangent open ends

- generators/split/splitModel.ts (pure): decideSplit (seeded Chance x profile, even U tiles >= 2 with
  auto-promotion), splitRadiiByArea (r^e sum, >= 0.2 R, fat/skinny), lateralBalanceAngles, divergenceAxis
  (outward from the tree axis, +-15 deg seeded jitter), sampleSpineBack, planSplit (transition length,
  C1 Hermite lobe paths, tangent child circles, adaptive ring count <= 20 deg per ring).
- OpenEnd gets optional kind / frame / uTiles / uStart / parentSpineId; Break / Cap consumers unchanged.
- Skin > Splits: Spread defaults 22 (0-80), Expand 0.5-2, new advanced Area exponent (1.5-3); old
  projects fall back to defaults. spine.ts plans the split from the parent spine; the halves start on
  the shared axis. tubeUv promotes the U tiles of a splitting branch to even, Branch / Trunk / Root
  report the promotion as a node warning.
- Tests (tests/splitModel.test.ts), docs/ARCHITECTURE.md, docs/PARAMETERS.md, changelog.
```

## S0

```
fix(ci): stop WebGL probes in jsdom tests and give the slow DOM tests a realistic time budget

- viewport/rendererFactory: isWebGLAvailable (real WebGL2 probe incl. getShaderPrecisionFormat),
  createWebGLRenderer / createViewportRenderer return null instead of throwing or logging.
  Used by the viewport panel, material preview, preset thumbnails and impostor render.
- Viewport panel shows a neutral "WebGL unavailable" notice (tabs and toolbar stay) when no renderer
  can be created; real browsers behave as before (same renderer options).
- vitest.config.ts: testTimeout / hookTimeout 30 s, maxWorkers 2 on CI, global setup that makes
  canvas.getContext return null. shell.dom evaluate test gets an explicit 30 s timeout.
- Workflows: npm test -- --run --maxWorkers=2, explicit VITE_BASE=/Kekenik-Tree/, job-level
  permissions (build: contents read + pages write; deploy: pages write + id-token write).
- Tests: rendererFactory.dom.test.ts (probe, fake context rejection, panel placeholder).
```

## R17

```
feat(knot): rewrite the Knot generator as welded Outer / Inner / Core surface geometry

- New Outer (Size, Offset, Rotation, Scale, Lip, Noise Shape / Offset / Seed), Inner (Size %,
  Scale, Curvature, Overlap, UV Match trunk / Ring, Noise Shape) and Core (Size %, Offset, UV,
  Noise Shape / Offset) tabs, Material lists for Inner / Core with UV Area, Segments (Rings per
  section, Slices, Resolution) and Dynamic LOD (Weight, Ring segments, Slice segments).
- generators/knot (pure): three ring stacks projected onto the parent cone, smooth normals, exact
  parent normal and UV on the Outer weld, per-section UV styles, LOD segment scaling and weight cull.
- Node: shared Generation placements, one mesh slot per material (Outer = parent material), a short
  skeleton branch per knot, size scalar, decorations statistics group and visibility family.
- knotMaterials list widget (patch options always available, UV Area only); Noise sub-heads in the
  inspector.
- Old Knot nodes (knotRadius, knotLength, knotCoreScale, knotCurvature, material) are migrated
  (node version 2). Tests (knotMesh, knotNode), PARAMETERS / ARCHITECTURE / CHANGELOG.
```

## R16

```
feat(uv): Branch UV Mapping tab, per-branch material list and 0-1 UV patches

- UV Mapping: Style, Extension style, U (Absolute, + Relative, Offset + variance, Fractional
  Enable / Auto / Value, Twist Amount / Random flip), V (Style, Anchor, Scale, Skew correction,
  Pinch, Offset + variance), Tiling (Style, Optimize segments, V tolerance, Seed).
- Branch / Extension Material lists: Material (material / Material Set / Inherited), Weight and a
  patch options button (UV Area, Placement) while Tiling is a patch style.
- generators/uv (pure): U tile count, V styles, skew / pinch, patch layout with doubled seam
  vertices, UV Area remap, weighted patch material choice; tubeMesher writes UV0 from the plan
  (weld parent UV and displacement Use UVs follow it). Old projects keep their look (node v5).
- fix(wind): every wind control now edits the effective source (Wind node on the Tree or project
  settings), so wind can be switched off in examples and projects with a Wind node.
- Tests (tests/uvR16.test.ts, tests/windControl.test.ts), docs (PARAMETERS formulas), changelog.
```

## R15

```
feat(displacement): Trunk / Branch / Root Displacement tab with Main, Fine, Shape and Flares

- Main: Source (Noise / Material Height / Displacement asset), Radial amount, Length amount,
  Sharpness curve, Mapping (Use UVs / Fit to geometry), U / V scale, Seed.
- Fine (normal noise with Sharpness and Scale), Shape (creases with Twist), Flares (Radius, Noise
  scale, Height, Pinch, Angle, Seed).
- generators/displace: seeded wrap-around noise, sharpness LUT, flare / crease / fine offsets;
  tubeMesher applies them after welding (weld rings stay, fade past them, seam-safe, normals rebuilt).
- Old asset Amount projects keep working (legacy controls shown while in use); cache key follows the
  material Height map; Extensions > Displacement scale applies.
- Tests (tests/displaceR15.test.ts), docs, changelog.
```

## R14

```
feat(skin): splits, seamless extensions and open-end caps

- Skin > Splits (Chance, Balance, Seed, Spread / Expand Side 1 + 2, Smooth
  Inner + Outer): a branch ends in two fused open ends; radii keep the
  cross-section area (r1^2 + r2^2 = R^2), Balance shifts it, Expand scales.
- Extend parent: Any / Split 1 / Split 2 / Skinny / Fat / Breaks only / Bottom
  now select open ends from the skeleton (splitInfo + openEnd attributes);
  valid under a Branch or Trunk parent.
- Branch > Extensions: Length scale, Spread (+ profile curve), Radius (+ curve),
  Normal smooth, Displacement scale, UV Extension style (list).
- Extensions and split sides start exactly on the parent end (no buried ring,
  collar or base cap in the mesher), same position / direction / radius.
- Cap closes exactly the open ends (collectOpenEnds) and follows Extend parent.
- Tests (tests/splitsR14.test.ts), docs/ARCHITECTURE, PARAMETERS, changelog.
```

## R13

```
feat(skin): weld texture blend, light-seam reduction, squash, radius options

- Skin > Welding > Blend: Enabled, Texture, Texture scale, Contrast, Noise,
  Lighting curve. The mesher writes weldBlend (0 parent .. 1 child, monotonic),
  weldParentUV and weldStyle; the bark shader samples the map twice and mixes
  by smoothstep with contrast and wave noise. Meshes / materials without the
  channels ignore it; depth, shadow and wind passes are untouched.
- Skin > Radius: Absolute, + % of parent, Clamp to parent, Length compensation,
  Length kill ratio, Light seam reduction, Roll, Smooth; Clamp Min / Max.
- Skin > Squash: Amount, Rotate (elliptical section; welded children follow the
  squashed parent profile).
- Skin > Type & Visibility: Polygons / Spine only (SubD entries disabled),
  Visibility curve (> 0.5 has geometry). spineOnly projects are migrated.
- generators/skin (pure), generators/weld/{blend,squashSurface}; one shared
  normal-lean helper (leanNormal) and one Squash reader.
- Tests (tests/skinR13.test.ts), docs/PARAMETERS.md, ARCHITECTURE, changelog.
```

## R12

```
feat(branch): welding geometry (Skin > Welding)

- New Skin > Welding section on Branch and Root: Enabled, Keep (curve), Keep
  failed, Force ray casts, Offset, Spread (Amount, Upper scale, Lower scale);
  ring count from Segments > Length > Weld scalar. Off by default.
- generators/weld: parent skin surfaces (procedural cone / ray cast tube with
  sag compensation), weld solver (base ring on the parent skin, blend to the
  plain child circle, widening, parent -> child normal blend, failure flags),
  Keep helpers.
- Generators run the Keep curve + weld analysis per child and write the
  `weld` / `weldSelf` skeleton attributes; failed welds drop the branch unless
  Keep failed (StructureSkeletonBuilder.truncate / setBranchExtra / branchView).
- Tube mesher splices the weld rings in place of the buried ring + collar;
  falls back to the old junction when the solve fails.
- Tests (tests/weldR12.test.ts), docs/PARAMETERS.md, ARCHITECTURE, changelog.
```

## R11

```
feat(spine): Noise (Early / Late), Jink, Path and Break on the Spine tab

- generators/spine/{noiseMath,jinkMath,pathMath,breakMath,polyline}: pure, seeded
  logic (early noise Threshold gate, late noise Smooth filter, straight runs with
  Uniformity, tiled path profile with Twist / Offset, break spot and chance).
- Spine tab: Noise > Early (Amount, Turbulence, Threshold + curves) and Late
  (Amount, Turbulence, Smooth, Seed); new Jink, Path and Break sections. The Late
  Seed no longer changes the early noise. Existing ids and defaults are kept, so old
  projects load unchanged.
- Broken branches write an `openEnd` skeleton attribute; Extend parent > Breaks only
  reads it (heuristic kept as fallback for skeletons without the flag).
- tests/spineR11.test.ts, docs (ARCHITECTURE, PARAMETERS), changelog.
```

## R10

```
feat(spine): Segments tab, spine length / orientation / shape, Prune strengths

- generators/spine/*: pure, seeded logic (additive length + clamp + one V tile,
  length / radial segment counts per Relative basis, Influence gain, start angle
  and Alignment / Unify, straightness as noise removal, Parent Curl rotations,
  zigzag spacing, directional and ground prune, weld sample spacing, migration).
- New Segments tab (Accuracy, Influence, Scalar, Length, Radial); Accuracy is the
  exact point count of the high-resolution spine; the radial count is stored per
  branch (radialSides attribute) and used by the tube mesher.
- Spine tab: Match one V tile, Stop shape control, Shape scale, Unify, Weld start,
  Zigzag Segment length, Prune Interior / Up / Down / General / Ground (0..1 + curves).
- Node versions bumped; former lengthRelative / matchOneVTile / pruneGround /
  lengthSegments migrate on load.
- tests/spineR10.test.ts, docs (ARCHITECTURE, PARAMETERS), changelog.
```

## R09

```
feat(generation): shared Generation properties - Clip, Pass, Pruning curve, Knockout, Force containers, Masks, Size scalar

- generators/common/*: pure, seeded logic (clip range, pruning curve,
  knockout chance incl. + Resolution, force volumes box / sphere, mask gate,
  pass validation, extend parent positions, mesh alignment axes, size scalar).
- distribution.ts runs: mode -> boundaries / clip -> position / rotation / sink
  -> pruning -> knockout -> force containers -> masks -> extension.
- Generation tab sections Boundaries / Common / Extend parent / Knockout /
  Force containers / More / Masks on every generator; Force nodes get a
  Volume section; inspector pickers list volume forces and project masks.
- Evaluator: Pass breaks topological ties and adds an error badge when a node
  has a lower pass than an ancestor; forceVolumes / parentType on NodeContext.
- Size scalar is handed down the hierarchy (StructureData.sizeScalar); Tree
  node Size scalar is the start value.
- Node versions bumped; the old scalar Pruning migrates into Knockout.
- tests/generationCommon.test.ts, docs (ARCHITECTURE, PARAMETERS), changelog.
```

## R08

```
feat(generation): Proportional, Steps, Phyllotaxy, Interval, Bifurcation, Flood, Parent modes

- generators/modes/*: pure, seeded placement module returning
  { t, roll, side, groupIndex } records; Absolute / Density keep their
  previous layout, all modes respect First / Last (Parent sits at t = 0).
- distribution.ts is now an adapter: it reads the params, calls the module
  and keeps Clip / Pruning / Knockout / Extend parent.
- Generation > Mode on every generator with per-mode sections (visibleIf),
  new params for Steps, Phyllotaxy (styles, internode length from Last to
  First), Interval (frequency curve, balance), Bifurcation; Classic is a
  disabled legacy option (enum options can now be `disabled`).
- migrateGenerationParams (node versions bumped): whorled -> absolute-steps,
  golden-angle phyllotaxy -> alternating + spiral, bifurcation count.
- Presets / default graph use the new params; docs, changelog,
  tests/generationModes.test.ts.
```

## R07

```
feat(frond): left-right / section variance, lighting normals, wind ribs

- Shape: Left-Right Variance (Amount, Seed) gives each half its own
  Curl / Fold / Gravity multiplier; Section Variance (Favor Outliers,
  Amount / Offset for Gravity, Fold, Curl, Roll) shifts every mesh section
  painted with Section [n] (own rib set per painted section).
- Lighting tab: Style Global / Local, Smooth, Alignment, Spread, Parent
  puffiness (Anchor + Origin, Amount), Up / Right / Out; reuses
  applyLeafLighting with per-vertex spine directions.
- Wind: Weight / Cross / Boost curves and Ribs (Apply branch wind, Weight)
  written into the existing wind weights; base vertices stay static.
- Tests (tests/frondVariance.test.ts), PARAMETERS.md notes, changelog.
```

## R06

```
feat(frond): rib-based frond generator (mesh mapped onto ribs)

- geometry/frondRibs.ts: one left + right rib per length segment of the
  parent spine (Accuracy segments per rib), deformed by Gravity / Fold /
  Curl / Roll and Align; centre line stays on the spine; bendPath applies
  the Forces (length preserving).
- geometry/frondMesher.ts: maps the cutout mesh of the material (u across,
  v along) or a plain ribbon grid (Segments > Absolute / + Relative, even
  counts) onto the ribs; Flip, Two sided, height relief / height map, wind
  bend weight, tangents.
- New Shape (Unification, Height, Boundary, Scale), Segments, Forces
  (Gravity / Up-Down / Ancestor curves, Align) and Material (Flip, Two
  sided, Mesh Index / Resolution) parameters; node version 3 with a
  migration from the ribbon frond; presets updated.
- Tests (tests/frondRibs.test.ts), PARAMETERS.md, architecture, changelog.
```

## R05

```
feat(leaf): lighting normals pass (Global / Local) + Batched Leaf node

- New Lighting tab on Leaf: Style (Global | Local), Smooth, Parent puffiness
  (Amount, Anchor: Global / Deep / Intermediate / Local / None / Height /
  Surface X-Y-Z), Anchor shift (Position, Amount), Puffiness, Unify,
  Up / Right / Out with variance, World up. The Tree node gets a Lighting
  tab with the shared Global group (handed down as StructureData.lighting).
- geometry/leafLighting.ts: applyLeafLighting(meshData, settings, ctx), a
  typed-array normal pass after deformation / mirroring / winding fix that
  also re-orthogonalises tangents (reusable by Frond).
- New generator.batchedLeaf: Leaf evaluator without Mesh LOD offset, vertex
  Seed, Unify and World up, fixed to the highest detail, merged into one slot
  per material by mergeByMaterial with an index table (MeshData.parts) that
  maps triangles to source leaves.
- Removed the dead Spherize / Bend params; tests (tests/leafLighting.test.ts),
  docs/PARAMETERS.md, changelog.
```

## R04

```
feat(leaf): deformation, vertex noise, scale and mesh-LOD resolution

- New Deformation tab: Height (material Height map along normals), Fold,
  Curl, Twist, Vertex (Amount, Noise, Seed) and Scale X / Y / Z, all with
  curve + variance. The pivot stays fixed; anchor frames follow the
  deformed leaf.
- New Resolution tab: Size increase % curve (default = the old 12 % per LOD),
  Mesh LOD curve and Mesh LOD offset (clamped, needs two filled slots,
  nearest-slot fallback) driven by the viewport LOD selector.
- geometry/leafDeform.ts + leafLod.ts (pure), MeshAccumulator subdivision /
  normal recompute, Leaf dependency key + Height image decoding.
- Tests (tests/leafDeform.test.ts), docs/PARAMETERS.md, changelog.
```

## R03

```
feat(leaf): placement & orientation parameters (Leaves tab)

- New Leaves tab: Use actual size, Size (curve + variance), +% of parent, Weld,
  Keep failed welds, Cross, Fix winding, Flip, Initial orientation (Classic /
  Synchronized), Type list, Local orientation (3D anchor style, Unification,
  Sky influence, Fold, Align, Face), Sensitivity -> Parent, Final adjustments.
- geometry/leafPlacement.ts: pure orientation pipeline, anchors with a per-parent
  cache, weld, cross, side / mirror helpers.
- Interval / Phyllotaxy publish a per-branch `side` attribute; generators publish
  ancestor chains (StructureData.lineage) for the Global / Deep / Intermediate /
  Local anchors.
- Mirrored leaves + fixWinding in the leaf mesher; Skin > Size "Scale" migrated to
  Leaves > Size (node version 2); Type list moved to the Leaves tab.
- Tests (tests/leafPlacement.test.ts), docs/PARAMETERS.md Leaves tab, changelog.
```

## R02

Entry text was not part of the received project copy; see AgentProgress/R02.md for the content of the task.

## R01

Entry text was not part of the received project copy; see AgentProgress/R01.md for the content of the task.
